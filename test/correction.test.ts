/**
 * VAR-correction detection + debounce decision — the part the brief says must be PROVEN, not assumed.
 *
 * These cover the PURE core: detectCorrectionCandidate (the guardrails) and confirmCorrection (the
 * post-debounce fire/discard decision, incl. the transient-glitch rejection that prevents a false
 * "Goal Disallowed"). Run with `node --test test/correction.test.ts` — deliberately NOT vitest, because
 * vitest-pool-workers can't boot the workerd runtime on Node 26 here; these need no Workers runtime.
 * The inline sleep + cache-busted re-poll that wires these together is I/O (index.ts) and is proven live.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	confirmCorrection,
	correctionEvent,
	detectCorrectionCandidate,
	type Match,
	type StoredState,
} from "../src/events.ts";

const withScores = (h: number, a: number, over: Partial<Match> = {}): Match => ({
	eventId: "401853924",
	home: { id: "15365", abbr: "WAS", name: "Washington Spirit", score: h },
	away: { id: "15363", abbr: "SEA", name: "Seattle Reign FC", score: a },
	state: "in",
	statusName: "STATUS_SECOND_HALF",
	period: 2,
	clock: 4860,
	plays: [],
	cards: [],
	...over,
});

const stored = (m: Match): StoredState => ({
	home: { id: m.home.id, score: m.home.score },
	away: { id: m.away.id, score: m.away.score },
	state: m.state,
	halftimeSent: false,
});

// ── detectCorrectionCandidate: the guardrails (brief item 3) ──────────────────
test("candidate: home score decreased while both snapshots in-progress", () => {
	const c = detectCorrectionCandidate(stored(withScores(2, 1)), withScores(1, 1));
	assert.ok(c);
	assert.deepEqual(c!.prev, { home: 2, away: 1 });
});

test("candidate: away score decreased", () => {
	assert.ok(detectCorrectionCandidate(stored(withScores(1, 2)), withScores(1, 1)));
});

test("no candidate: score increased (that's a goal, not a correction)", () => {
	assert.equal(detectCorrectionCandidate(stored(withScores(1, 1)), withScores(2, 1)), null);
});

test("no candidate: score unchanged", () => {
	assert.equal(detectCorrectionCandidate(stored(withScores(1, 1)), withScores(1, 1)), null);
});

test("no candidate: no prior state (first sighting / new match loading at 0-0)", () => {
	assert.equal(detectCorrectionCandidate(null, withScores(0, 0)), null);
});

test("no candidate: prior snapshot not in-progress (reset / pre)", () => {
	const prev: StoredState = { ...stored(withScores(2, 1)), state: "pre" };
	assert.equal(detectCorrectionCandidate(prev, withScores(1, 1)), null);
});

test("no candidate: current snapshot final (in→post transition, not a correction)", () => {
	assert.equal(detectCorrectionCandidate(stored(withScores(2, 1)), withScores(1, 1, { state: "post" })), null);
});

// ── confirmCorrection: the debounce decision (the critical false-positive guard) ──
test("confirm: decrease persists on a fresh re-read → FIRE", () => {
	const c = detectCorrectionCandidate(stored(withScores(2, 1)), withScores(1, 1))!;
	assert.equal(confirmCorrection(c, withScores(1, 1)), true);
});

test("confirm: score reverted on re-read (transient glitch) → DISCARD (no false disallow)", () => {
	const c = detectCorrectionCandidate(stored(withScores(2, 1)), withScores(1, 1))!;
	assert.equal(confirmCorrection(c, withScores(2, 1)), false);
});

test("confirm: re-read now final → discard (never fire across a status transition)", () => {
	const c = detectCorrectionCandidate(stored(withScores(2, 1)), withScores(1, 1))!;
	assert.equal(confirmCorrection(c, withScores(1, 1, { state: "post" })), false);
});

test("confirm: re-read missing (fresh fetch failed) → discard", () => {
	const c = detectCorrectionCandidate(stored(withScores(2, 1)), withScores(1, 1))!;
	assert.equal(confirmCorrection(c, null), false);
});

// ── correctionEvent: copy + the struck-old-score inputs ───────────────────────
test("correctionEvent: subject-first title, corrected scoreline subtitle, prev scores for the struck card", () => {
	const ev = correctionEvent({ home: 2, away: 1 }, withScores(1, 1));
	assert.equal(ev.type, "correction");
	assert.equal(ev.prefColumn, "goals");
	assert.equal(ev.title, "NO GOAL — Washington Spirit"); // v3 copy: subject-first, matches the attached crest
	assert.equal(ev.subtitle, "WAS 1–1 SEA · VAR review"); // abbreviations + en-dash, the app-wide rule
	assert.equal(ev.homeScore, 1);
	assert.equal(ev.awayScore, 1);
	assert.equal(ev.prevHomeScore, 2);
	assert.equal(ev.prevAwayScore, 1);
});
