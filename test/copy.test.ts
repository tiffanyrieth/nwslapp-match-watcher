/**
 * V1 push COPY (v4, 2026-07-07 spec, landed 2026-07-24) — pins every title/subtitle string so a
 * future edit can't silently drift the wording. Pure: builds `Match`/`StoredState` in code and calls
 * `detectEvents`/`correctionEvent` directly (no ESPN parse, no Workers runtime).
 *
 * Run with `node --test test/copy.test.ts` (deliberately NOT vitest — vitest-pool-workers can't boot
 * workerd on Node 26 here; this needs no Workers runtime).
 *
 * v4 rules pinned here: titles use a COLON, never an em-dash; caps only on GOAL / NO GOAL; goal
 * subtitle is SCORER-first ("S. Menti 19' · WAS 1–0 ORL"); red card is minute-first player with NO
 * scoreline ("23' E. Wheeler"); halftime + full time are the scoreline ONLY.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectEvents, correctionEvent, type Match, type ScoringPlay, type StoredState } from "../src/events.ts";

// ── minimal builders ──────────────────────────────────────────────────────────

function match(over: Partial<Match> = {}): Match {
	return {
		eventId: "401",
		home: { id: "H", abbr: "WAS", name: "Washington Spirit", score: 0 },
		away: { id: "A", abbr: "ORL", name: "Orlando Pride", score: 0 },
		state: "in",
		statusName: "STATUS_IN_PROGRESS",
		period: 1,
		clock: 300,
		plays: [],
		cards: [],
		...over,
	};
}

function stored(over: Partial<StoredState> = {}): StoredState {
	return { home: { id: "H", score: 0 }, away: { id: "A", score: 0 }, state: "in", halftimeSent: false, ...over };
}

const goal = (teamId: string, scorer: string, minute: number): ScoringPlay => ({ teamId, scorer, minute });

function firstOf(type: string, prev: StoredState, m: Match) {
	const ev = detectEvents(prev, m).find((e) => e.type === type);
	assert.ok(ev, `expected a ${type} event`);
	return ev!;
}

// ── kickoff ───────────────────────────────────────────────────────────────────

test("kickoff: colon title, venue · broadcast subtitle", () => {
	const m = match({ clock: 60, venue: "Audi Field", broadcast: "ESPN" });
	const ev = firstOf("kickoff", stored({ state: "pre" }), m);
	assert.equal(ev.title, "Kickoff: WAS vs ORL");
	assert.equal(ev.subtitle, "Audi Field · ESPN");
});

test("kickoff: cup competition leads the subtitle; plain NWSL stays omitted", () => {
	// A cup match says which competition it is — the one push that sets context (2026-08-06).
	const cup = match({ clock: 60, venue: "Estadio Hidalgo", broadcast: "Paramount+", competition: "CONCACAF" });
	assert.equal(firstOf("kickoff", stored({ state: "pre" }), cup).subtitle, "CONCACAF · Estadio Hidalgo · Paramount+");
	// "NWSL" adds nothing on a league match — the proven regular-season copy is byte-identical.
	const league = match({ clock: 60, venue: "Audi Field", broadcast: "ESPN", competition: "NWSL" });
	assert.equal(firstOf("kickoff", stored({ state: "pre" }), league).subtitle, "Audi Field · ESPN");
	// No venue/broadcast → the label still leads over the generic fallback.
	const bare = match({ clock: 60, competition: "Challenge Cup" });
	assert.equal(firstOf("kickoff", stored({ state: "pre" }), bare).subtitle, "Challenge Cup");
});

// ── goal ────────────────────────────────────────────────────────────────────

test("goal: colon title (scoring club), SCORER-first subtitle", () => {
	const m = match({ home: { id: "H", abbr: "WAS", name: "Washington Spirit", score: 1 }, plays: [goal("H", "S. Menti", 19)] });
	const ev = firstOf("goal", stored(), m);
	assert.equal(ev.title, "GOAL: Washington Spirit");
	assert.equal(ev.subtitle, "S. Menti 19' · WAS 1–0 ORL");
});

test("goal: bare scoreline when no scorer attributed (never fabricated)", () => {
	const m = match({ away: { id: "A", abbr: "ORL", name: "Orlando Pride", score: 1 } });
	const ev = firstOf("goal", stored(), m);
	assert.equal(ev.title, "GOAL: Orlando Pride");
	assert.equal(ev.subtitle, "WAS 0–1 ORL");
});

// ── red card ────────────────────────────────────────────────────────────────

test("red card: colon title, minute-first player, NO scoreline", () => {
	const m = match({ cards: [{ teamId: "A", scorer: "E. Wheeler", minute: 23 }] });
	const ev = firstOf("redcard", stored({ redCards: { home: 0, away: 0 } }), m);
	assert.equal(ev.title, "Red card: Orlando Pride");
	assert.equal(ev.subtitle, "23' E. Wheeler");
});

test("red card: falls back to the scoreline when the player is unattributed", () => {
	const m = match({ cards: [{ teamId: "A", minute: 23 } as ScoringPlay] });
	const ev = firstOf("redcard", stored({ redCards: { home: 0, away: 0 } }), m);
	assert.equal(ev.subtitle, "WAS 0–0 ORL");
});

// ── halftime + full time (scoreline ONLY) ─────────────────────────────────────

test("halftime: scoreline ONLY, even with a first-half scorer on record", () => {
	const m = match({
		statusName: "STATUS_HALFTIME",
		home: { id: "H", abbr: "WAS", name: "Washington Spirit", score: 1 },
		plays: [goal("H", "S. Menti", 45)], // present — must NOT leak into the HT subtitle
	});
	const ev = firstOf("halftime", stored({ home: { id: "H", score: 1 } }), m);
	assert.equal(ev.title, "Halftime");
	assert.equal(ev.subtitle, "WAS 1–0 ORL");
});

test("full time: scoreline ONLY (no win/draw tail)", () => {
	const win = match({ state: "post", statusName: "STATUS_FULL_TIME", home: { id: "H", abbr: "WAS", name: "Washington Spirit", score: 2 }, away: { id: "A", abbr: "ORL", name: "Orlando Pride", score: 1 } });
	const ftWin = firstOf("fulltime", stored({ home: { id: "H", score: 2 }, away: { id: "A", score: 1 } }), win);
	assert.equal(ftWin.title, "Full time");
	assert.equal(ftWin.subtitle, "WAS 2–1 ORL");

	const draw = match({ state: "post", home: { id: "H", abbr: "WAS", name: "Washington Spirit", score: 1 }, away: { id: "A", abbr: "ORL", name: "Orlando Pride", score: 1 } });
	const ftDraw = firstOf("fulltime", stored({ home: { id: "H", score: 1 }, away: { id: "A", score: 1 } }), draw);
	assert.equal(ftDraw.subtitle, "WAS 1–1 ORL");
});

// ── VAR correction ────────────────────────────────────────────────────────────

test("VAR: colon 'NO GOAL' title (disallowed club), corrected scoreline · VAR review", () => {
	const m = match({ home: { id: "H", abbr: "WAS", name: "Washington Spirit", score: 1 }, away: { id: "A", abbr: "ORL", name: "Orlando Pride", score: 1 } });
	const ev = correctionEvent({ home: 2, away: 1 }, m);
	assert.equal(ev.title, "NO GOAL: Washington Spirit");
	assert.equal(ev.subtitle, "WAS 1–1 ORL · VAR review");
});

test("VAR: neutral title when no side is isolated", () => {
	const m = match();
	const ev = correctionEvent({ home: 0, away: 0 }, m);
	assert.equal(ev.title, "NO GOAL: VAR review");
});
