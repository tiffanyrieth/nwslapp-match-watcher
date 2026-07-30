/**
 * ⛈️ SUSPENDED ≠ FULL TIME — regression guard for a live-match failure on 2026-07-29.
 *
 * ESPN reports a suspended / abandoned / postponed match as `state: "post"` with `completed: false`
 * and `name: "STATUS_SUSPENDED"`. The watcher read bare `post` and did three harmful things when
 * UTA v WAS was held for wind at 27':
 *   1. fired a FALSE "Full time" push (0–0, first half),
 *   2. tore down the Live Activity — `broadcastEnd` + `deleteChannel` + KV deletes, and since
 *      push-to-start is gated on `ko >= now`, an already-kicked-off match can NEVER restart it,
 *   3. marked the fixture `ended`, which stopped polling (covered in fixtures.test.ts).
 *
 * The app-side twin of this file is NWSLAppTests/SuspendedMatchTests.swift.
 *
 * Run with `node --test test/suspension.test.ts` — pure logic, no Workers runtime needed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectEvents, isUnfinishedPost, parseMatch, type Match, type ScoreboardEvent, type StoredState } from "../src/events.ts";

/** A scoreboard event with an arbitrary status type — the shape the predicate reads. */
const ev = (state: string, name?: string, completed?: boolean): ScoreboardEvent => ({
	id: "401853954",
	date: "2026-07-30T01:00Z",
	status: { type: { state, name, completed }, period: 1, clock: 1620 },
	competitions: [{
		status: { type: { state, name, completed }, period: 1, clock: 1620 },
		competitors: [
			{ homeAway: "home", score: "0", team: { id: "19141", abbreviation: "UTA", displayName: "Utah Royals" } },
			{ homeAway: "away", score: "0", team: { id: "15365", abbreviation: "WAS", displayName: "Washington Spirit" } },
		],
	}],
});

function match(over: Partial<Match> = {}): Match {
	return {
		eventId: "401853954",
		home: { id: "19141", abbr: "UTA", name: "Utah Royals", score: 0 },
		away: { id: "15365", abbr: "WAS", name: "Washington Spirit", score: 0 },
		state: "in",
		statusName: "STATUS_FIRST_HALF",
		period: 1,
		clock: 1620,
		unfinishedPost: false,
		plays: [],
		cards: [],
		...over,
	};
}

const stored = (over: Partial<StoredState> = {}): StoredState => ({
	home: { id: "19141", score: 0 },
	away: { id: "15365", score: 0 },
	state: "in",
	halftimeSent: false,
	...over,
});

// ── the predicate ────────────────────────────────────────────────────────────

test("the exact payload that caused it: post + completed:false + STATUS_SUSPENDED", () => {
	assert.equal(isUnfinishedPost(ev("post", "STATUS_SUSPENDED", false)), true);
});

test("a genuine full time is NOT unfinished", () => {
	assert.equal(isUnfinishedPost(ev("post", "STATUS_FULL_TIME", true)), false);
});

test("live and scheduled are never 'unfinished post' — it is a post-only concept", () => {
	assert.equal(isUnfinishedPost(ev("in", "STATUS_SECOND_HALF", false)), false);
	assert.equal(isUnfinishedPost(ev("pre", "STATUS_SCHEDULED", false)), false);
});

test("the other abandonment statuses also count", () => {
	for (const name of ["STATUS_POSTPONED", "STATUS_DELAYED", "STATUS_CANCELED", "STATUS_CANCELLED", "STATUS_ABANDONED"]) {
		assert.equal(isUnfinishedPost(ev("post", name, false)), true, `${name} must not read as final`);
	}
});

test("FAIL-OPEN: a sparse post payload still reads as final", () => {
	// ⚠️ POLARITY. Only POSITIVE evidence of non-completion counts. If ESPN ever stops sending
	// `completed`, matches must still finish exactly as before — a watcher that never fires full time
	// again would be a far worse bug than the one being fixed.
	assert.equal(isUnfinishedPost(ev("post")), false);
	assert.equal(isUnfinishedPost(ev("post", "STATUS_SOMETHING_NEW")), false);
});

test("completed:false alone is enough, even with an unrecognised status name", () => {
	assert.equal(isUnfinishedPost(ev("post", "STATUS_WEATHER_HOLD", false)), true);
});

test("parseMatch carries the flag onto the Match", () => {
	assert.equal(parseMatch(ev("post", "STATUS_SUSPENDED", false))?.unfinishedPost, true);
	assert.equal(parseMatch(ev("post", "STATUS_FULL_TIME", true))?.unfinishedPost, false);
});

// ── full-time detection ──────────────────────────────────────────────────────

test("REGRESSION: a suspension must NOT fire full time", () => {
	const events = detectEvents(stored({ state: "in" }), match({ state: "post", statusName: "STATUS_SUSPENDED", unfinishedPost: true }));
	assert.equal(events.find((e) => e.type === "fulltime"), undefined, "the 27' wind hold sent a false Full time");
});

test("a real full time still fires", () => {
	const events = detectEvents(
		stored({ state: "in" }),
		match({ state: "post", statusName: "STATUS_FULL_TIME", away: { id: "15365", abbr: "WAS", name: "Washington Spirit", score: 1 } }),
	);
	const ft = events.find((e) => e.type === "fulltime");
	assert.ok(ft, "expected a fulltime event");
	assert.equal(ft!.title, "Full time");
});

test("full time fires when play RESUMES and then genuinely ends", () => {
	// The real sequence: suspended (state stays "in" in KV, no FT) → resumes → ends for real.
	const held = detectEvents(stored({ state: "in" }), match({ state: "post", unfinishedPost: true }));
	assert.equal(held.find((e) => e.type === "fulltime"), undefined);

	const ended = detectEvents(
		stored({ state: "in" }),
		match({ state: "post", statusName: "STATUS_FULL_TIME", away: { id: "15365", abbr: "WAS", name: "Washington Spirit", score: 1 } }),
	);
	assert.ok(ended.find((e) => e.type === "fulltime"), "the REAL full time must still be sent");
});
