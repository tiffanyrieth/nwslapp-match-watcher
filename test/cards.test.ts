/**
 * Red-card detection + per-side V2 content-state — batch-2 notifications work.
 *
 * Fixtures use the REAL ESPN scoreboard `details` card shape (live-captured 2026-07-05:
 * explicit `redCard`/`yellowCard` booleans + `type:{id,text}`). Detection keys on the
 * BOOLEANS only — never text (`contains("red")` matched "scoRED", the build-25 lesson).
 *
 * Run with `node --test test/cards.test.ts` — deliberately NOT vitest (vitest-pool-workers
 * can't boot workerd on Node 26 here); pure logic, no Workers runtime.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectEvents, nextState, parseMatch, type Match, type ScoreboardEvent, type StoredState } from "../src/events.ts";
import { contentStateFromMatch } from "../src/livestate.ts";

// ── real-shape detail builders ────────────────────────────────────────────────

const goalDetail = (teamId: string, name: string, minute: string) => ({
	type: { id: "70", text: "Goal" },
	clock: { displayValue: minute },
	team: { id: teamId },
	scoringPlay: true,
	redCard: false,
	yellowCard: false,
	penaltyKick: false,
	ownGoal: false,
	athletesInvolved: [{ displayName: name, shortName: name }],
});

const yellowDetail = (teamId: string, name: string, minute: string) => ({
	type: { id: "94", text: "Yellow Card" },
	clock: { displayValue: minute },
	team: { id: teamId },
	scoringPlay: false,
	redCard: false,
	yellowCard: true,
	penaltyKick: false,
	ownGoal: false,
	athletesInvolved: [{ displayName: name, shortName: name }],
});

const redDetail = (teamId: string, name: string, minute: string) => ({
	type: { id: "93", text: "Red Card" },
	clock: { displayValue: minute },
	team: { id: teamId },
	scoringPlay: false,
	redCard: true,
	yellowCard: false,
	penaltyKick: false,
	ownGoal: false,
	athletesInvolved: [{ displayName: name, shortName: name }],
});

/** A live scoreboard event with the given details, WAS (home) vs SEA (away). */
const scoreboardEvent = (details: unknown[], homeScore = "0", awayScore = "0"): ScoreboardEvent =>
	({
		id: "401853924",
		status: { period: 2, clock: 3000, type: { state: "in", name: "STATUS_SECOND_HALF" } },
		competitions: [
			{
				competitors: [
					{ homeAway: "home", score: homeScore, team: { id: "15365", abbreviation: "WAS", displayName: "Washington Spirit" } },
					{ homeAway: "away", score: awayScore, team: { id: "15363", abbreviation: "SEA", displayName: "Seattle Reign FC" } },
				],
				details,
			},
		],
	}) as ScoreboardEvent;

const storedFor = (m: Match, over: Partial<StoredState> = {}): StoredState => ({
	home: { id: m.home.id, score: m.home.score },
	away: { id: m.away.id, score: m.away.score },
	state: "in",
	halftimeSent: true,
	redCards: { home: 0, away: 0 },
	...over,
});

// ── parseCards (via parseMatch) ───────────────────────────────────────────────

test("parseMatch: reds parsed with attribution; yellows and goals excluded from cards", () => {
	const m = parseMatch(scoreboardEvent([
		goalDetail("15365", "T. Rodman", "12'"),
		yellowDetail("15363", "J. Bugg", "30'"),
		redDetail("15363", "S. Menti", "55'"),
	], "1", "0"))!;
	assert.equal(m.cards.length, 1);
	assert.deepEqual(m.cards[0], { teamId: "15363", scorer: "S. Menti", minute: 55 });
	assert.equal(m.plays.length, 1); // the goal — cards never leak into plays
});

// ── red-card event detection ──────────────────────────────────────────────────

test("redcard fires once when a side's count rises, rides the goals pref, crests the carded club", () => {
	const m = parseMatch(scoreboardEvent([redDetail("15363", "S. Menti", "55'")]))!;
	const events = detectEvents(storedFor(m), m);
	const red = events.find((e) => e.type === "redcard");
	assert.ok(red, "redcard event must fire");
	assert.equal(red!.prefColumn, "goals");
	assert.equal(red!.title, "Red card — Seattle Reign FC");
	assert.equal(red!.subtitle, "WAS 0–0 SEA · S. Menti 55'");
	assert.equal(red!.scoringSide, "away"); // carded club's crest attaches
});

test("no re-fire: stored ledger already counts the red", () => {
	const m = parseMatch(scoreboardEvent([redDetail("15363", "S. Menti", "55'")]))!;
	const events = detectEvents(storedFor(m, { redCards: { home: 0, away: 1 } }), m);
	assert.equal(events.some((e) => e.type === "redcard"), false);
});

test("second red for the same side fires again", () => {
	const m = parseMatch(scoreboardEvent([
		redDetail("15363", "S. Menti", "55'"),
		redDetail("15363", "C. Dickey", "80'"),
	]))!;
	const events = detectEvents(storedFor(m, { redCards: { home: 0, away: 1 } }), m);
	const red = events.find((e) => e.type === "redcard");
	assert.ok(red);
	assert.equal(red!.subtitle, "WAS 0–0 SEA · C. Dickey 80'"); // newest red attributed
});

test("MIGRATION GUARD: a pre-existing KV row without redCards only baselines — no late fire", () => {
	const m = parseMatch(scoreboardEvent([redDetail("15363", "S. Menti", "55'")]))!;
	// prev has NO redCards key (row written before this shipped) → must not fire...
	const events = detectEvents(storedFor(m, { redCards: undefined }), m);
	assert.equal(events.some((e) => e.type === "redcard"), false);
	// ...but nextState records the current count, so detection starts clean next tick.
	const s = nextState(storedFor(m, { redCards: undefined }), m, events);
	assert.deepEqual(s.redCards, { home: 0, away: 1 });
});

// ── V2 content-state: per-side scorers + red counts ───────────────────────────

test("content-state: scorers partitioned per side; red counts present only where non-zero", () => {
	const m = parseMatch(scoreboardEvent([
		goalDetail("15365", "T. Rodman", "12'"),
		goalDetail("15363", "S. Wilson", "34'"),
		goalDetail("15365", "H. Hershfelt", "60'"),
		redDetail("15363", "S. Menti", "55'"),
	], "2", "1"))!;
	const cs = contentStateFromMatch(m);
	assert.deepEqual(cs.homeScorers, ["T. Rodman 12'", "H. Hershfelt 60'"]);
	assert.deepEqual(cs.awayScorers, ["S. Wilson 34'"]);
	assert.equal(cs.homeRedCards, undefined); // omitted at 0 → compact() drops it
	assert.equal(cs.awayRedCards, 1);
});

test("content-state: scorer list caps at 4 with an overflow marker", () => {
	const goals = ["5'", "20'", "33'", "47'", "61'", "78'"].map((min, i) =>
		goalDetail("15365", `Scorer${i + 1}`, min),
	);
	const m = parseMatch(scoreboardEvent(goals, "6", "0"))!;
	const cs = contentStateFromMatch(m);
	assert.equal(cs.homeScorers!.length, 4);
	assert.deepEqual(cs.homeScorers!.slice(0, 3), ["Scorer1 5'", "Scorer2 20'", "Scorer3 33'"]);
	assert.equal(cs.homeScorers![3], "+3 more");
});

test("content-state: 0-0 with no cards omits all per-side keys (old payload shape preserved)", () => {
	const m = parseMatch(scoreboardEvent([]))!;
	const cs = contentStateFromMatch(m);
	assert.equal(cs.homeScorers, undefined);
	assert.equal(cs.awayScorers, undefined);
	assert.equal(cs.homeRedCards, undefined);
	assert.equal(cs.awayRedCards, undefined);
});
