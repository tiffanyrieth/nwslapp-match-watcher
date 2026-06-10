import { describe, expect, it } from "vitest";
import {
	detectEvents,
	nextState,
	parseMatch,
	toPayload,
	type Match,
	type MatchEvent,
	type ScoreboardEvent,
	type StoredState,
} from "../src/events";

// A WAS–ORL match (the canonical example pairing) at a given scoreline + status.
const match = (over: Partial<Match> = {}): Match => ({
	eventId: "401853925",
	home: { id: "15365", abbr: "WAS", name: "Washington Spirit", score: 0 },
	away: { id: "20905", abbr: "ORL", name: "Orlando Pride", score: 0 },
	state: "in",
	statusName: "STATUS_FIRST_HALF",
	period: 1,
	clock: 600,
	...over,
});

// The StoredState a previous poll would have left for `m`.
const stored = (m: Match, halftimeSent = false): StoredState => ({
	home: { id: m.home.id, score: m.home.score },
	away: { id: m.away.id, score: m.away.score },
	state: m.state,
	halftimeSent,
});

const withScores = (h: number, a: number, over: Partial<Match> = {}): Match =>
	match({ home: { id: "15365", abbr: "WAS", name: "Washington Spirit", score: h }, away: { id: "20905", abbr: "ORL", name: "Orlando Pride", score: a }, ...over });

const types = (events: MatchEvent[]) => events.map((e) => e.type);

describe("parseMatch", () => {
	it("returns null for a scheduled (pre) match", () => {
		expect(parseMatch({ id: "1", status: { type: { state: "pre" } } })).toBeNull();
	});

	it("parses a live match, reading status off the event", () => {
		const event: ScoreboardEvent = {
			id: "401853925",
			status: { period: 1, clock: 60, type: { state: "in", name: "STATUS_FIRST_HALF" } },
			competitions: [
				{
					competitors: [
						{ homeAway: "home", score: "1", team: { id: "15365", abbreviation: "WAS", displayName: "Washington Spirit" } },
						{ homeAway: "away", score: "0", team: { id: "20905", abbreviation: "ORL", displayName: "Orlando Pride" } },
					],
				},
			],
		};
		const m = parseMatch(event);
		expect(m?.state).toBe("in");
		expect(m?.statusName).toBe("STATUS_FIRST_HALF");
		expect(m?.home.score).toBe(1);
	});

	it("parses a just-ended (post) match too (needed for full-time)", () => {
		const m = parseMatch({
			id: "1",
			status: { type: { state: "post", name: "STATUS_FULL_TIME" } },
			competitions: [
				{
					competitors: [
						{ homeAway: "home", score: "2", team: { id: "15365", abbreviation: "WAS", displayName: "Washington Spirit" } },
						{ homeAway: "away", score: "1", team: { id: "20905", abbreviation: "ORL", displayName: "Orlando Pride" } },
					],
				},
			],
		});
		expect(m?.state).toBe("post");
	});

	it("falls back to competition.status when event.status is absent", () => {
		const m = parseMatch({
			id: "1",
			competitions: [
				{
					status: { type: { state: "in", name: "STATUS_SECOND_HALF" } },
					competitors: [
						{ homeAway: "home", score: "0", team: { id: "15365" } },
						{ homeAway: "away", score: "0", team: { id: "20905" } },
					],
				},
			],
		});
		expect(m?.statusName).toBe("STATUS_SECOND_HALF");
	});

	it("returns null when a team id is missing (can't key followers)", () => {
		const m = parseMatch({
			id: "1",
			status: { type: { state: "in" } },
			competitions: [{ competitors: [{ homeAway: "home", team: { abbreviation: "WAS" } }, { homeAway: "away", team: { id: "20905" } }] }],
		});
		expect(m).toBeNull();
	});
});

describe("detectEvents - kickoff", () => {
	it("fires on first sighting in the 1st minute", () => {
		const events = detectEvents(null, match({ period: 1, clock: 30 }));
		expect(types(events)).toEqual(["kickoff"]);
		expect(events[0].prefColumn).toBe("kickoff");
		expect(events[0].title).toBe("KICKOFF — WAS vs ORL");
	});

	it("does NOT fire when first seen mid-match (clock already high)", () => {
		expect(detectEvents(null, match({ period: 1, clock: 1800 }))).toHaveLength(0);
	});

	it("does NOT re-fire once we're already tracking it live", () => {
		const prev = stored(match({ clock: 30 }));
		expect(detectEvents(prev, match({ clock: 90 }))).toHaveLength(0);
	});
});

describe("detectEvents - goals", () => {
	it("no goal on first sighting (baseline only)", () => {
		// clock high so kickoff doesn't fire either
		expect(detectEvents(null, withScores(1, 0, { clock: 1800 }))).toHaveLength(0);
	});

	it("detects the home team scoring, carrying both team ids", () => {
		const events = detectEvents(stored(withScores(0, 0)), withScores(1, 0));
		expect(types(events)).toEqual(["goal"]);
		expect(events[0].title).toBe("GOAL — WAS 1–0 ORL");
		expect(events[0].body).toBe("Washington Spirit scored.");
		expect(events[0].teamIds).toEqual(["15365", "20905"]);
	});

	it("detects the away team scoring", () => {
		const events = detectEvents(stored(withScores(1, 0)), withScores(1, 1));
		expect(events[0].body).toBe("Orlando Pride scored.");
	});

	it("collapses a multi-goal jump into one goal with the current scoreline", () => {
		const events = detectEvents(stored(withScores(0, 0)), withScores(2, 0));
		expect(types(events)).toEqual(["goal"]);
		expect(events[0].title).toBe("GOAL — WAS 2–0 ORL");
	});

	it("two goals when both teams score in one tick", () => {
		expect(types(detectEvents(stored(withScores(0, 0)), withScores(1, 1)))).toEqual(["goal", "goal"]);
	});
});

describe("detectEvents - halftime", () => {
	it("fires once at STATUS_HALFTIME", () => {
		const prev = stored(withScores(1, 0));
		const half = withScores(1, 0, { statusName: "STATUS_HALFTIME" });
		const events = detectEvents(prev, half);
		expect(types(events)).toEqual(["halftime"]);
		expect(events[0].title).toBe("Halftime — WAS 1–0 ORL");
	});

	it("does NOT re-fire once halftimeSent is set", () => {
		const prev = stored(withScores(1, 0), true);
		const half = withScores(1, 0, { statusName: "STATUS_HALFTIME" });
		expect(detectEvents(prev, half)).toHaveLength(0);
	});
});

describe("detectEvents - full time", () => {
	it("fires on the in -> post transition with a result body", () => {
		const prev = stored(withScores(2, 1)); // state "in"
		const ended = withScores(2, 1, { state: "post", statusName: "STATUS_FULL_TIME" });
		const events = detectEvents(prev, ended);
		expect(types(events)).toEqual(["fulltime"]);
		expect(events[0].title).toBe("Full Time — WAS 2–1 ORL");
		expect(events[0].body).toBe("Washington Spirit win.");
	});

	it("reports a draw", () => {
		const prev = stored(withScores(1, 1));
		const ended = withScores(1, 1, { state: "post" });
		expect(detectEvents(prev, ended)[0].body).toBe("It's a draw.");
	});

	it("fires a final-tick goal AND full time together", () => {
		const prev = stored(withScores(1, 1));
		const ended = withScores(2, 1, { state: "post" });
		expect(types(detectEvents(prev, ended))).toEqual(["goal", "fulltime"]);
	});
});

describe("nextState", () => {
	it("carries halftimeSent forward once a halftime has fired", () => {
		const m = withScores(1, 0, { statusName: "STATUS_HALFTIME" });
		const fired: MatchEvent[] = detectEvents(stored(withScores(1, 0)), m);
		expect(nextState(stored(withScores(1, 0)), m, fired).halftimeSent).toBe(true);
	});

	it("keeps a previously-set halftimeSent even with no new events", () => {
		const m = withScores(1, 0, { statusName: "STATUS_SECOND_HALF" });
		expect(nextState(stored(withScores(1, 0), true), m, []).halftimeSent).toBe(true);
	});
});

describe("toPayload", () => {
	it("wraps title/body + the deep-link eventID", () => {
		const [goal] = detectEvents(stored(withScores(0, 0)), withScores(1, 0));
		const payload = toPayload(goal) as { aps: { alert: { title: string }; "thread-id": string }; eventID: string };
		expect(payload.aps.alert.title).toBe("GOAL — WAS 1–0 ORL");
		expect(payload.eventID).toBe("401853925");
		expect(payload.aps["thread-id"]).toBe("401853925");
	});
});
