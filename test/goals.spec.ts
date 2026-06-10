import { describe, expect, it } from "vitest";
import { detectGoals, goalPayload, parseLiveMatch, stateOf, type LiveMatch } from "../src/goals";

// A WAS–ORL fixture at a given scoreline (the canonical example pairing).
const live = (homeScore: number, awayScore: number): LiveMatch => ({
	eventId: "401853925",
	home: { id: "15365", abbr: "WAS", name: "Washington Spirit", score: homeScore },
	away: { id: "20905", abbr: "ORL", name: "Orlando Pride", score: awayScore },
});

describe("parseLiveMatch", () => {
	it("returns null for a non-live match", () => {
		expect(parseLiveMatch({ id: "1", status: { type: { state: "pre" } } })).toBeNull();
	});

	it("parses a live match with both team ids and numeric scores", () => {
		const m = parseLiveMatch({
			id: "401853925",
			status: { type: { state: "in" } },
			competitions: [
				{
					competitors: [
						{ homeAway: "home", score: "1", team: { id: "15365", abbreviation: "WAS", displayName: "Washington Spirit" } },
						{ homeAway: "away", score: "0", team: { id: "20905", abbreviation: "ORL", displayName: "Orlando Pride" } },
					],
				},
			],
		});
		expect(m?.home.id).toBe("15365");
		expect(m?.home.score).toBe(1);
		expect(m?.away.abbr).toBe("ORL");
	});

	it("returns null when a team id is missing (can't key followers)", () => {
		const m = parseLiveMatch({
			id: "1",
			status: { type: { state: "in" } },
			competitions: [
				{
					competitors: [
						{ homeAway: "home", score: "0", team: { abbreviation: "WAS" } },
						{ homeAway: "away", score: "0", team: { id: "20905" } },
					],
				},
			],
		});
		expect(m).toBeNull();
	});
});

describe("detectGoals", () => {
	it("emits no goal on first sighting (baseline only)", () => {
		expect(detectGoals(null, live(1, 0))).toHaveLength(0);
	});

	it("detects the home team scoring and carries both team ids", () => {
		const goals = detectGoals(stateOf(live(0, 0)), live(1, 0));
		expect(goals).toHaveLength(1);
		expect(goals[0].scoringTeamId).toBe("15365");
		expect(goals[0].teamIds).toEqual(["15365", "20905"]);
	});

	it("detects the away team scoring", () => {
		const goals = detectGoals(stateOf(live(1, 0)), live(1, 1));
		expect(goals).toHaveLength(1);
		expect(goals[0].scoringTeamId).toBe("20905");
	});

	it("emits nothing when the score is unchanged", () => {
		expect(detectGoals(stateOf(live(2, 1)), live(2, 1))).toHaveLength(0);
	});

	it("collapses a multi-goal jump into one event with the current scoreline", () => {
		const goals = detectGoals(stateOf(live(0, 0)), live(2, 0));
		expect(goals).toHaveLength(1);
		expect(goals[0].homeScore).toBe(2);
	});

	it("yields two goals when both teams score in one tick", () => {
		expect(detectGoals(stateOf(live(0, 0)), live(1, 1))).toHaveLength(2);
	});
});

describe("goalPayload", () => {
	it("formats the title with abbreviations + an en-dash, and a deep-link eventID", () => {
		const [goal] = detectGoals(stateOf(live(0, 0)), live(1, 0));
		const payload = goalPayload(goal) as {
			aps: { alert: { title: string; body: string } };
			eventID: string;
		};
		expect(payload.aps.alert.title).toBe("GOAL — WAS 1–0 ORL");
		expect(payload.aps.alert.body).toBe("Washington Spirit scored");
		expect(payload.eventID).toBe("401853925");
	});
});
