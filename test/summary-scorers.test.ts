/**
 * Scorer attribution from /summary keyEvents + the N-th-goal rule (2026-09-12) — the fix for a goal push that
 * named the PREVIOUS goal's scorer ("G. Corley 23' · SD 2–0 NC" on Melanie Barcenas's 72' goal) and a nameless
 * NC goal (Ashley Sanchez 82'), live on SD vs NC, event 401853999. Root cause: the scoreboard's `details`
 * scoring-play list lags its own score by minutes, and goals were attributed with "the last play for that
 * team, whatever it is". Fixtures are the REAL payloads captured at 89' that night (test/fixtures/).
 *
 * Run with `node --test test/summary-scorers.test.ts` (pure logic; vitest-pool-workers can't boot on Node 26).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
	detectEvents,
	mergePlays,
	playForGoalNumber,
	playLabel,
	shortForm,
	summaryScoringPlays,
	type Match,
	type ScoringPlay,
	type StoredState,
} from "../src/events.ts";
import { contentStateFromMatch } from "../src/livestate.ts";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/sd-nc-401853999.json", import.meta.url), "utf8")) as {
	details: Array<Record<string, unknown>>;
	keyEvents: unknown[];
};

const SD = { id: "21423", abbr: "SD", name: "San Diego Wave FC" };
const NC = { id: "15366", abbr: "NC", name: "North Carolina Courage" };

const match = (h: number, a: number, plays: ScoringPlay[]): Match => ({
	eventId: "401853999",
	home: { ...SD, score: h },
	away: { ...NC, score: a },
	state: "in",
	statusName: "STATUS_SECOND_HALF",
	period: 2,
	clock: 4400,
	plays,
	cards: [],
	unfinishedPost: false,
});
const stored = (h: number, a: number): StoredState => ({
	home: { id: SD.id, score: h },
	away: { id: NC.id, score: a },
	state: "in",
	halftimeSent: true,
	redCards: { home: 0, away: 0 },
});

// The scoreboard `details` as the watcher would have seen them at 72'+: score already 2–0, play list still
// only the 23' goal (this lag is the whole bug). Built from the real Corley entry.
const CORLEY_DETAIL: ScoringPlay = { teamId: SD.id, scorer: "G. Corley", minute: 23, athleteId: "306037" };

// ── summaryScoringPlays on the REAL keyEvents ────────────────────────────────

test("summaryScoringPlays: the real SD–NC keyEvents → 3 goals, scorer = participants[0], credited side via the narrative", () => {
	const plays = summaryScoringPlays(fixture.keyEvents, { ...SD, score: 2 }, { ...NC, score: 1 });
	assert.deepEqual(
		plays.map((p) => ({ teamId: p.teamId, scorer: p.scorer, minute: p.minute, athleteId: p.athleteId })),
		[
			{ teamId: SD.id, scorer: "G. Corley", minute: 23, athleteId: "306037" },
			{ teamId: SD.id, scorer: "M. Barcenas", minute: 72, athleteId: "360902" },
			{ teamId: NC.id, scorer: "A. Sanchez", minute: 82, athleteId: "279297" }, // NOT the assist (S. Koyama)
		],
	);
	assert.ok(plays.every((p) => !p.isOwnGoal && !p.isPenalty));
});

test("summaryScoringPlays: garbage / empty / missing names → [] (caller keeps the scoreboard plays)", () => {
	assert.deepEqual(summaryScoringPlays(undefined, { ...SD, score: 0 }, { ...NC, score: 0 }), []);
	assert.deepEqual(summaryScoringPlays("nope", { ...SD, score: 0 }, { ...NC, score: 0 }), []);
	assert.deepEqual(summaryScoringPlays([{ scoringPlay: true }], { ...SD, score: 0 }, { ...NC, score: 0 }), []);
});

test("summaryScoringPlays: ignores non-goal, non-scoringPlay and shootout entries", () => {
	const ke = [
		{ type: { text: "Yellow Card", type: "yellow-card" }, scoringPlay: false, text: "San Diego Wave 9, North Carolina Courage 9" },
		{ type: { text: "Goal", type: "goal" }, scoringPlay: true, shootout: true, text: "Goal! San Diego Wave 1, North Carolina Courage 0.", clock: { value: 6000, displayValue: "PEN" } },
	];
	assert.deepEqual(summaryScoringPlays(ke, { ...SD, score: 0 }, { ...NC, score: 0 }), []);
});

// ── own goals + penalties (shape from test/summary-goal.test.ts, live-verified type ids) ──

const LOU = { id: "20905", abbr: "LOU", name: "Racing Louisville FC" };
const LA = { id: "21422", abbr: "LA", name: "Angel City FC" };

test("summaryScoringPlays: OWN GOAL is credited to the BENEFITING side by the narrative, flagged, and labelled (OG)", () => {
	const ke = [
		{
			type: { id: "97", text: "Own Goal", type: "own-goal" },
			scoringPlay: true,
			team: { id: LA.id }, // ESPN's team on an own goal is ambiguous — the narrative decides
			clock: { value: 3300, displayValue: "55'" },
			participants: [{ athlete: { id: "1", displayName: "Kenza Dali", shortName: null } }],
			text: "Own Goal! Racing Louisville 1, Angel City 0. Kenza Dali (Angel City) turns it into her own net.",
		},
	];
	const [p] = summaryScoringPlays(ke, { ...LOU, score: 1 }, { ...LA, score: 0 });
	assert.equal(p.teamId, LOU.id, "credited to Louisville, who benefited");
	assert.equal(p.isOwnGoal, true);
	assert.equal(playLabel(p), "K. Dali (OG) 55'");
});

test("summaryScoringPlays: penalty goal → flagged, plain label (no suffix)", () => {
	const ke = [
		{
			type: { id: "98", text: "Goal - Penalty", type: "goal" },
			scoringPlay: true,
			team: { id: LA.id },
			clock: { value: 4000, displayValue: "67'" },
			participants: [{ athlete: { id: "2", displayName: "Evelyn Shores", shortName: null } }],
			text: "Goal! Racing Louisville 0, Angel City 1. Evelyn Shores converts the penalty.",
		},
	];
	const [p] = summaryScoringPlays(ke, { ...LOU, score: 0 }, { ...LA, score: 1 });
	assert.equal(p.teamId, LA.id);
	assert.equal(p.isPenalty, true);
	assert.equal(playLabel(p), "E. Shores 67'");
});

test("summaryScoringPlays: narrative unparseable → falls back to team.id (flipped for an own goal)", () => {
	const ke = [
		{ type: { text: "Goal", type: "goal" }, scoringPlay: true, team: { id: LA.id }, clock: { displayValue: "10'" }, text: "no score here", participants: [{ athlete: { displayName: "Some One" } }] },
		{ type: { text: "Own Goal", type: "own-goal" }, scoringPlay: true, team: { id: LA.id }, clock: { displayValue: "20'" }, text: "no score here either", participants: [{ athlete: { displayName: "Other Two" } }] },
	];
	const plays = summaryScoringPlays(ke, { ...LOU, score: 0 }, { ...LA, score: 0 });
	assert.deepEqual(plays.map((p) => p.teamId), [LA.id, LOU.id]);
});

// ── shortForm ────────────────────────────────────────────────────────────────

test("shortForm: ESPN's initial + surname convention; single-token names pass through", () => {
	assert.equal(shortForm("Melanie Barcenas"), "M. Barcenas");
	assert.equal(shortForm("Ashley Sanchez"), "A. Sanchez");
	assert.equal(shortForm("Ana Beatriz Gomes Lopes"), "A. Beatriz Gomes Lopes");
	assert.equal(shortForm("  Marta  "), "Marta");
});

// ── mergePlays ───────────────────────────────────────────────────────────────

test("mergePlays: summary ahead of the scoreboard → union carries the new goal; the scoreboard's shortName is kept on a match", () => {
	const summary = summaryScoringPlays(fixture.keyEvents, { ...SD, score: 2 }, { ...NC, score: 1 });
	const merged = mergePlays([CORLEY_DETAIL], summary);
	assert.deepEqual(
		merged.map((p) => `${p.teamId}:${p.scorer}:${p.minute}`),
		[`${SD.id}:G. Corley:23`, `${SD.id}:M. Barcenas:72`, `${NC.id}:A. Sanchez:82`],
	);
	assert.equal(merged.length, 3, "Corley is matched (same side, minute, athlete id), not duplicated");
});

test("mergePlays: scoreboard ahead of the summary (reverse lag) → nothing is lost; ordering is by minute", () => {
	const details: ScoringPlay[] = [
		{ teamId: NC.id, scorer: "A. Sanchez", minute: 82, athleteId: "279297" },
		CORLEY_DETAIL,
	];
	const merged = mergePlays(details, [{ teamId: SD.id, scorer: "M. Barcenas", minute: 72, athleteId: "360902" }]);
	assert.deepEqual(merged.map((p) => p.minute), [23, 72, 82]);
});

test("mergePlays: empty summary → the scoreboard list unchanged (fake-match harness has no /summary)", () => {
	assert.deepEqual(mergePlays([CORLEY_DETAIL], []), [CORLEY_DETAIL]);
});

test("mergePlays: athlete ids that DISAGREE for the same side+minute are two goals (never silently collapsed)", () => {
	const merged = mergePlays(
		[{ teamId: SD.id, scorer: "A. One", minute: 40, athleteId: "1" }],
		[{ teamId: SD.id, scorer: "B. Two", minute: 40, athleteId: "2" }],
	);
	assert.equal(merged.length, 2);
});

// ── playForGoalNumber — THE rule ─────────────────────────────────────────────

test("playForGoalNumber: N-th attributed play for the side, or undefined when the list is short", () => {
	const m = match(2, 1, mergePlays([CORLEY_DETAIL], summaryScoringPlays(fixture.keyEvents, { ...SD, score: 2 }, { ...NC, score: 1 })));
	assert.equal(playForGoalNumber(m, SD.id, 1)?.scorer, "G. Corley");
	assert.equal(playForGoalNumber(m, SD.id, 2)?.scorer, "M. Barcenas");
	assert.equal(playForGoalNumber(m, SD.id, 3), undefined, "no 3rd SD play → nothing to name");
	assert.equal(playForGoalNumber(m, NC.id, 1)?.scorer, "A. Sanchez");
	assert.equal(playForGoalNumber(m, NC.id, 0), undefined);
});

// ── REGRESSION LOCK: the exact 2026-09-12 failures, through detectEvents ─────

test("goal 2 with a LAGGING scoreboard list and NO summary → bare scoreline, NEVER the previous scorer", () => {
	// prev 1–0; effective score now 2–0; the only attributed SD play is still Corley 23'.
	const goals = detectEvents(stored(1, 0), match(2, 0, [CORLEY_DETAIL])).filter((e) => e.type === "goal");
	assert.equal(goals.length, 1);
	assert.equal(goals[0].subtitle, "SD 2–0 NC");
	assert.equal(goals[0].scorer, undefined);
	assert.equal(goals[0].minute, undefined);
	assert.ok(!goals[0].subtitle.includes("Corley"), "the old rule produced 'G. Corley 23' · SD 2–0 NC' here");
});

test("goal 2 with the summary merged in → 'M. Barcenas 72' · SD 2–0 NC' (the intended push)", () => {
	const plays = mergePlays([CORLEY_DETAIL], summaryScoringPlays(fixture.keyEvents, { ...SD, score: 2 }, { ...NC, score: 0 }).filter((p) => p.teamId === SD.id));
	const goals = detectEvents(stored(1, 0), match(2, 0, plays)).filter((e) => e.type === "goal");
	assert.equal(goals.length, 1);
	assert.equal(goals[0].subtitle, "M. Barcenas 72' · SD 2–0 NC");
	assert.equal(goals[0].scorer, "M. Barcenas");
	assert.equal(goals[0].minute, 72);
});

test("NC's FIRST goal with the scorer only in the summary → 'A. Sanchez 82' · SD 2–1 NC' (was nameless)", () => {
	const plays = mergePlays(
		[CORLEY_DETAIL, { teamId: SD.id, scorer: "M. Barcenas", minute: 72, athleteId: "360902" }],
		summaryScoringPlays(fixture.keyEvents, { ...SD, score: 2 }, { ...NC, score: 1 }),
	);
	const goals = detectEvents(stored(2, 0), match(2, 1, plays)).filter((e) => e.type === "goal");
	assert.equal(goals.length, 1);
	assert.equal(goals[0].scoringSide, "away");
	assert.equal(goals[0].subtitle, "A. Sanchez 82' · SD 2–1 NC");
});

test("goal 1 still names its scorer when the list has exactly one play (no regression on the common case)", () => {
	const goals = detectEvents(stored(0, 0), match(1, 0, [CORLEY_DETAIL])).filter((e) => e.type === "goal");
	assert.equal(goals[0].subtitle, "G. Corley 23' · SD 1–0 NC");
});

// ── Live Activity scorer lists read the same merged plays + the same labels ──

test("content-state: merged plays → both SD scorers and the NC scorer at detection time; OG renders with (OG)", () => {
	const plays = mergePlays([CORLEY_DETAIL], summaryScoringPlays(fixture.keyEvents, { ...SD, score: 2 }, { ...NC, score: 1 }));
	const cs = contentStateFromMatch(match(2, 1, plays));
	assert.deepEqual(cs.homeScorers, ["G. Corley 23'", "M. Barcenas 72'"]);
	assert.deepEqual(cs.awayScorers, ["A. Sanchez 82'"]);
	const og = contentStateFromMatch(match(1, 0, [{ teamId: SD.id, scorer: "K. Dali", minute: 81, isOwnGoal: true }]));
	assert.deepEqual(og.homeScorers, ["K. Dali (OG) 81'"]);
});

test("content-state: a play with no scorer is skipped (never fabricated) even when the score says it exists", () => {
	const cs = contentStateFromMatch(match(2, 0, [CORLEY_DETAIL, { teamId: SD.id, minute: 72 }]));
	assert.deepEqual(cs.homeScorers, ["G. Corley 23'"]);
});
