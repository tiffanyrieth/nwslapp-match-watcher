/**
 * Summary goal cross-check — the part that fixes a lagging ESPN /scoreboard delaying the goal push +
 * V2-LA while the app's play-by-play (/summary) already shows it (device-observed twice, 2026-09-05).
 *
 * PURE core: summaryGoalScore parses the running score from /summary keyEvents goal narratives, and
 * detectEvents fires off the effective (max) score. Run with `node --test test/summary-goal.test.ts`
 * (NOT vitest — vitest-pool-workers can't boot workerd on Node 26; these need no Workers runtime).
 * The max-overlay + the per-tick /summary fetch that wires these together is I/O (index.ts), proven live.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { summaryGoalScore, detectEvents, type Match, type StoredState } from "../src/events.ts";

const HOME = "Racing Louisville FC";
const AWAY = "Angel City FC";

// A goal keyEvent whose `text` states the running score (the real ESPN shape, verified 2026-09-05).
const goalEvent = (text: string, over: Record<string, unknown> = {}) => ({
	type: { id: "70", text: "Goal", type: "goal" },
	scoringPlay: true,
	team: { id: "21422" },
	text,
	...over,
});

test("summaryGoalScore: normal goal narrative → per-side score, de-suffixing the club name", () => {
	const ke = [goalEvent("Goal! Racing Louisville 0, Angel City 1. Evelyn Shores (Angel City) scores.")];
	assert.deepEqual(summaryGoalScore(ke, HOME, AWAY), { home: 0, away: 1 });
});

test("summaryGoalScore: multiple goals → MAX per side (order-independent, current score)", () => {
	const ke = [
		goalEvent("Goal! Racing Louisville 0, Angel City 1. Evelyn Shores."),
		goalEvent("Goal! Racing Louisville 0, Angel City 2. Evelyn Shores."),
	];
	assert.deepEqual(summaryGoalScore(ke, HOME, AWAY), { home: 0, away: 2 });
	// Reversed array order must give the same answer (we take the max, not the last).
	assert.deepEqual(summaryGoalScore([...ke].reverse(), HOME, AWAY), { home: 0, away: 2 });
});

test("summaryGoalScore: OWN GOAL is attributed by the stated score, not by team.id", () => {
	// An Angel City own goal credits Racing Louisville. The narrative states the score, so we get it
	// right even though the keyEvent's team.id might point at the other side.
	const ke = [goalEvent("Own Goal! Racing Louisville 1, Angel City 0. Player (Angel City) turns it in.", {
		type: { id: "97", text: "Own Goal", type: "own-goal" },
	})];
	assert.deepEqual(summaryGoalScore(ke, HOME, AWAY), { home: 1, away: 0 });
});

test("summaryGoalScore: penalty goal still parses", () => {
	const ke = [goalEvent("Goal! Racing Louisville 0, Angel City 1. Scorer converts the penalty.", {
		type: { id: "98", text: "Goal - Penalty", type: "goal" },
	})];
	assert.deepEqual(summaryGoalScore(ke, HOME, AWAY), { home: 0, away: 1 });
});

test("summaryGoalScore: ignores non-goal + non-scoringPlay entries", () => {
	const ke = [
		{ type: { text: "Yellow Card", type: "yellow-card" }, scoringPlay: false, text: "Racing Louisville 9, Angel City 9 (noise)" },
		{ type: { text: "Substitution", type: "substitution" }, scoringPlay: false, text: "sub" },
		goalEvent("Goal! Racing Louisville 0, Angel City 1. Scorer."),
	];
	assert.deepEqual(summaryGoalScore(ke, HOME, AWAY), { home: 0, away: 1 });
});

test("summaryGoalScore: unparseable / missing name → null (caller falls back to scoreboard)", () => {
	assert.equal(summaryGoalScore([goalEvent("Goal! Some Other Team 0, Nobody 1.")], HOME, AWAY), null);
	assert.equal(summaryGoalScore([goalEvent("Goal! no scores here")], HOME, AWAY), null);
	assert.equal(summaryGoalScore([goalEvent("Goal! Racing Louisville 0. (away missing)")], HOME, AWAY), null);
});

test("summaryGoalScore: non-array / empty / missing names → null", () => {
	assert.equal(summaryGoalScore(undefined, HOME, AWAY), null);
	assert.equal(summaryGoalScore([], HOME, AWAY), null);
	assert.equal(summaryGoalScore([goalEvent("Goal! Racing Louisville 0, Angel City 1.")], "", AWAY), null);
});

// --- effective-score detection: the overlay in index.ts sets match.score = max(scoreboard, summary) ---

const match = (h: number, a: number): Match => ({
	eventId: "401853991",
	home: { id: "20905", abbr: "LOU", name: HOME, score: h },
	away: { id: "21422", abbr: "LA", name: AWAY, score: a },
	state: "in",
	statusName: "STATUS_SECOND_HALF",
	period: 2,
	clock: 4120,
	plays: [],
	cards: [],
	unfinishedPost: false,
});
const stored = (h: number, a: number): StoredState => ({
	home: { id: "20905", score: h },
	away: { id: "21422", score: a },
	state: "in",
	halftimeSent: false,
	redCards: { home: 0, away: 0 },
});

test("detectEvents: summary-led effective score fires the goal (the bug this fixes)", () => {
	// Scoreboard still says 0-0, but summary showed 0-1 → overlay makes effective away=1.
	const events = detectEvents(stored(0, 0), match(0, 1));
	const goals = events.filter((e) => e.type === "goal");
	assert.equal(goals.length, 1);
	assert.equal(goals[0].scoringSide, "away");
});

test("detectEvents: no double-fire once the baseline already reflects the goal", () => {
	// Prev already 0-1 (fired last tick); scoreboard catches up to 0-1 → nothing new.
	const goals = detectEvents(stored(0, 1), match(0, 1)).filter((e) => e.type === "goal");
	assert.equal(goals.length, 0);
});
