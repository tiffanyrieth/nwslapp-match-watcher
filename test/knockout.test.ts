/**
 * Knockout readiness — extra time + penalty shootouts (2026-09-13). Locks the VERIFIED ESPN shapes from two
 * real matches (captured via the proxy into test/fixtures/):
 *   • 712961 — 2024 NWSL semifinal GFC @ WAS, 1–1 after 120', WAS 3–0 on pens (STATUS_FINAL_PEN, period 5).
 *     Three scored kicks sit in the scoreboard `details` as `scoringPlay:true, shootout:true, clock "120'"`.
 *   • 725224 — 2025 Euro ITA @ ENG, 2–1 after extra time, no pens (STATUS_FINAL_AET, period 4).
 * What must hold: a kick is never a goal (no scorer line, no goal push, no play-pool padding); a level scoreline
 * decided on pens is never reported as a draw; the clock never ticks past 120' during a shootout.
 *
 * Run with `node --test test/knockout.test.ts` (pure logic; vitest-pool-workers can't boot on Node 26).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
	clockRunning,
	detectEvents,
	fulltimeSubtitle,
	mergePlays,
	parseMatch,
	summaryGoalScore,
	summaryScoringPlays,
	winnerSideOf,
	type Match,
	type ScoreboardEvent,
	type StoredState,
} from "../src/events.ts";
import { contentStateFromMatch } from "../src/livestate.ts";

const load = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const PENS = load("knockout-pens-712961.json") as { scoreboardEvent: ScoreboardEvent; summary: { keyEvents: unknown[] } };
const AET = load("knockout-aet-725224.json") as { scoreboardEvent: ScoreboardEvent };

const must = <T>(v: T | null | undefined, what: string): T => {
	assert.ok(v, `expected ${what}`);
	return v as T;
};

// The stored state one tick before full time: both sides level, match live (so the FT transition fires).
const liveBefore = (m: Match): StoredState => ({
	home: { id: m.home.id, score: m.home.score },
	away: { id: m.away.id, score: m.away.score },
	state: "in",
	halftimeSent: true,
	// The real 712961 details carry a red card — the ledger must already hold it or a card push fires here.
	redCards: {
		home: m.cards.filter((c) => c.teamId === m.home.id).length,
		away: m.cards.filter((c) => c.teamId === m.away.id).length,
	},
});

// ── parseMatch on the real pens final ────────────────────────────────────────

test("pens final: period 5, FT-Pens detail, score stays 1–1, pens 3–0 + winner parsed onto the sides", () => {
	const m = must(parseMatch(PENS.scoreboardEvent), "a parsed match");
	assert.equal(m.state, "post");
	assert.equal(m.statusName, "STATUS_FINAL_PEN");
	assert.equal(m.statusDetail, "FT-Pens");
	assert.equal(m.period, 5);
	assert.equal(m.unfinishedPost, false); // completed:true → a real final (fail-open denylist untouched)
	assert.deepEqual([m.home.abbr, m.home.score, m.home.pens, m.home.winner], ["WAS", 1, 3, true]);
	assert.deepEqual([m.away.abbr, m.away.score, m.away.pens, m.away.winner], ["GFC", 1, 0, undefined]);
});

test("pens final: the three scored kicks are NOT goals — plays holds exactly the two 120' goals", () => {
	const m = must(parseMatch(PENS.scoreboardEvent), "a parsed match");
	assert.equal(m.plays.length, 2);
	assert.deepEqual(
		m.plays.map((p) => [p.scorer, p.minute]),
		[
			["E. González", 56],
			["H. Hershfelt", 90],
		],
	);
	assert.ok(m.plays.every((p) => p.minute !== 120), "no 120' kick leaked into the scorer list");
});

test("AET final: period 4, AET detail, no pens on either side, winner by score", () => {
	const m = must(parseMatch(AET.scoreboardEvent), "a parsed match");
	assert.equal(m.statusName, "STATUS_FINAL_AET");
	assert.equal(m.statusDetail, "AET");
	assert.equal(m.period, 4);
	assert.equal(m.home.pens, undefined);
	assert.equal(m.away.pens, undefined);
	assert.equal(winnerSideOf(m), "home");
});

// ── full-time copy ──────────────────────────────────────────────────────────

test("full time after pens: never 'a draw' — scoreline · winner-first tally on pens; winner's crest attaches", () => {
	const m = must(parseMatch(PENS.scoreboardEvent), "a parsed match");
	const ft = must(detectEvents(liveBefore(m), m).find((e) => e.type === "fulltime"), "a fulltime event");
	assert.equal(ft.title, "Full time");
	assert.equal(ft.subtitle, "WAS 1–1 GFC · WAS win 3–0 on pens");
	assert.equal(ft.scoringSide, "home");
	assert.deepEqual([ft.homeScore, ft.awayScore], [1, 1]); // the card renders the 120' score, as ESPN does
});

test("full time after pens: an away winner reads with ITS tally first", () => {
	const m = must(parseMatch(PENS.scoreboardEvent), "a parsed match");
	const flipped: Match = {
		...m,
		home: { ...m.home, pens: 4, winner: undefined },
		away: { ...m.away, pens: 5, winner: true },
	};
	assert.equal(fulltimeSubtitle(flipped), "WAS 1–1 GFC · GFC win 5–4 on pens");
	assert.equal(winnerSideOf(flipped), "away");
});

test("full time after pens with no winner flag: the tally decides; level/absent tally → '· pens', never a name", () => {
	const m = must(parseMatch(PENS.scoreboardEvent), "a parsed match");
	const noFlag: Match = { ...m, home: { ...m.home, winner: undefined }, away: { ...m.away, winner: undefined } };
	assert.equal(fulltimeSubtitle(noFlag), "WAS 1–1 GFC · WAS win 3–0 on pens");
	const level: Match = { ...noFlag, home: { ...noFlag.home, pens: 3 }, away: { ...noFlag.away, pens: 3 } };
	assert.equal(fulltimeSubtitle(level), "WAS 1–1 GFC · pens");
	assert.equal(winnerSideOf(level), undefined);
});

test("full time after extra time (no pens): scoreline + (AET); regular-season FT copy is byte-identical", () => {
	const m = must(parseMatch(AET.scoreboardEvent), "a parsed match");
	const ft = must(detectEvents(liveBefore(m), m).find((e) => e.type === "fulltime"), "a fulltime event");
	assert.equal(ft.subtitle, "ENG 2–1 ITA (AET)");
	assert.equal(ft.scoringSide, "home");
	// The v4 regular-season line must not change: period 2, plain FT.
	const regular: Match = { ...m, period: 2, statusName: "STATUS_FULL_TIME", statusDetail: "FT" };
	assert.equal(fulltimeSubtitle(regular), "ENG 2–1 ITA");
});

// ── the shootout in progress (period 5, score frozen) ─────────────────────────

/** What the LIVE feed most plausibly looks like mid-shootout (the end state with `state` flipped back to "in":
 *  period 5, clock frozen at 7200, score 1–1, kicks accumulating in `details`). The live status NAME is
 *  unverified — deliberately a name that matches NOTHING, so the period alone must carry the decision. */
function liveShootout(): Match {
	const m = must(parseMatch(PENS.scoreboardEvent), "a parsed match");
	return { ...m, state: "in", statusName: "STATUS_UNKNOWN_LIVE_NAME", unfinishedPost: false, home: { ...m.home, winner: undefined } };
}

test("mid-shootout: no goal push fires while kicks land (score frozen), and the clock is not running", () => {
	const m = liveShootout();
	assert.equal(clockRunning(m), false);
	const prev = liveBefore(m);
	assert.deepEqual(detectEvents(prev, m).map((e) => e.type), []);
});

test("mid-shootout Live Activity: phase penalties, static PENS, no ticking clock, scorer columns hold goals only", () => {
	const m = liveShootout();
	const cs = contentStateFromMatch(m, 1_700_000_000);
	assert.equal(cs.phase, "penalties");
	assert.equal(cs.staticLabel, "PENS");
	assert.equal(cs.clockStartEpoch, undefined);
	assert.equal(cs.stoppageDisplay, undefined);
	assert.deepEqual([cs.homeScore, cs.awayScore], [1, 1]);
	assert.deepEqual(cs.homeScorers, ["H. Hershfelt 90'"]); // Hatch / Silano / Rudd's kicks are NOT listed
	assert.deepEqual(cs.awayScorers, ["E. González 56'"]);
	assert.equal(cs.lastScorer, "H. Hershfelt 90'");
});

test("extra time Live Activity: period 3/4 → extraTime, clock running from the anchor", () => {
	const m = { ...liveShootout(), period: 3, clock: 5500, statusName: "STATUS_IN_PROGRESS" };
	const cs = contentStateFromMatch(m, 1_700_000_000);
	assert.equal(cs.phase, "extraTime");
	assert.equal(cs.staticLabel, undefined);
	assert.equal(cs.clockStartEpoch, 1_700_000_000);
	assert.equal(clockRunning(m), true);
});

// ── the /summary side of a pens match ────────────────────────────────────────

test("summary keyEvents on the pens final: goal score stays 1–1 (the 'Penalty Shootout ends … 1(3)' marker is not a goal)", () => {
	const m = must(parseMatch(PENS.scoreboardEvent), "a parsed match");
	const sg = summaryGoalScore(PENS.summary.keyEvents, m.home.name, m.away.name);
	assert.deepEqual(sg, { home: 1, away: 1 });
});

test("summary keyEvents on the pens final: two scoring plays, and merging can't re-admit a kick", () => {
	const m = must(parseMatch(PENS.scoreboardEvent), "a parsed match");
	const fromSummary = summaryScoringPlays(PENS.summary.keyEvents, m.home, m.away);
	assert.equal(fromSummary.length, 2);
	const merged = mergePlays(m.plays, fromSummary);
	assert.equal(merged.length, 2);
	assert.deepEqual(merged.map((p) => p.minute), [56, 90]);
});
