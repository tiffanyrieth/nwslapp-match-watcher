/**
 * Virtual-kickoff anchor reconciliation (`nextState`) — the V2 widget clock's single input.
 *
 * Locks the monotonic rules AND the 2026-07-05 second-half regression: ESPN advances `period` → 2
 * at the START of the halftime break (state stays "in", clock frozen at 2700), so reconciling the
 * anchor through the break re-based it at the break's start and Math.min pinned it there — the
 * ~15-min interval leaked into the widget clock (1:31 at the 31st minute of the second half).
 * The fix gates reconciliation on `clockRunning` so the period re-base fires at the REAL restart.
 *
 * Run with `node --test test/clock.test.ts` — deliberately NOT vitest (vitest-pool-workers can't
 * boot workerd on Node 26 here); this is pure logic, no Workers runtime needed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { clockRunning, nextState, type Match, type StoredState } from "../src/events.ts";

/** A live match snapshot at a given ESPN clock/period/status. */
const snapshot = (over: Partial<Match> = {}): Match => ({
	eventId: "401853924",
	home: { id: "15365", abbr: "WAS", name: "Washington Spirit", score: 0 },
	away: { id: "15363", abbr: "SEA", name: "Seattle Reign FC", score: 1 },
	state: "in",
	statusName: "STATUS_FIRST_HALF",
	period: 1,
	clock: 600,
	plays: [],
	...over,
});

const KICKOFF = 1_751_750_000; // arbitrary epoch anchor for readable arithmetic

/** Widget-visible elapsed seconds at `nowSec` given the stored anchor. */
const shown = (state: StoredState, nowSec: number): number => nowSec - state.virtualKickoff!;

test("first sighting anchors now − clock", () => {
	const s = nextState(null, snapshot({ clock: 600 }), [], KICKOFF + 600);
	assert.equal(s.virtualKickoff, KICKOFF);
	assert.equal(s.vkPeriod, 1);
});

test("first-half stoppage (clock frozen at 2700) keeps the earliest anchor — clock ticks past 45:00", () => {
	let s = nextState(null, snapshot({ clock: 600 }), [], KICKOFF + 600);
	// 46:40 wall / clock frozen at 2700 → candidate is LATER; Math.min must keep the true anchor.
	s = nextState(s, snapshot({ clock: 2700 }), [], KICKOFF + 2800);
	assert.equal(s.virtualKickoff, KICKOFF);
	assert.equal(shown(s, KICKOFF + 2800), 2800); // 46:40, still ticking through stoppage
});

test("REGRESSION: halftime break (period already 2, state still 'in') must not touch the anchor", () => {
	let s = nextState(null, snapshot({ clock: 600 }), [], KICKOFF + 600);
	// ESPN's halftime shape, as seen live 2026-07-05: state "in", period ALREADY 2, clock frozen 2700.
	const ht = { statusName: "STATUS_HALFTIME", period: 2, clock: 2700 };
	s = nextState(s, snapshot(ht), [], KICKOFF + 2900); // break starts (~48 min wall)
	s = nextState(s, snapshot(ht), [], KICKOFF + 3400); // mid-break
	s = nextState(s, snapshot(ht), [], KICKOFF + 3800); // late break (~63 min wall)
	assert.equal(s.virtualKickoff, KICKOFF, "anchor must survive the break untouched");
	assert.equal(s.vkPeriod, 1, "vkPeriod must NOT advance during the pause");

	// Second half restarts ~15 min after the clock froze: clock resumes 2700 → 2760.
	const restartWall = KICKOFF + 2700 + 900 + 60; // 45:00 played + 15-min break + 1 min of 2nd half
	s = nextState(s, snapshot({ statusName: "STATUS_SECOND_HALF", period: 2, clock: 2760 }), [], restartWall);
	assert.equal(s.vkPeriod, 2);
	// The widget must read 46:00 — NOT 61:00 (the pre-fix pinned anchor kept the 15-min break).
	assert.equal(shown(s, restartWall), 2760);
});

test("second-half stoppage (clock frozen at 5400) keeps the re-based anchor — clock ticks past 90:00", () => {
	let s = nextState(null, snapshot({ clock: 600 }), [], KICKOFF + 600);
	s = nextState(s, snapshot({ statusName: "STATUS_HALFTIME", period: 2, clock: 2700 }), [], KICKOFF + 2900);
	const restartWall = KICKOFF + 3660;
	s = nextState(s, snapshot({ statusName: "STATUS_SECOND_HALF", period: 2, clock: 2760 }), [], restartWall);
	const anchor = s.virtualKickoff!;
	// 90:00 cap: clock freezes at 5400 while wall time runs on — anchor must hold.
	s = nextState(s, snapshot({ statusName: "STATUS_SECOND_HALF", period: 2, clock: 5400 }), [], anchor + 5580);
	assert.equal(s.virtualKickoff, anchor);
	assert.equal(shown(s, anchor + 5580), 5580); // 93:00, ticking through stoppage
});

test("clockRunning: live halves run; halftime/shootout/post do not", () => {
	assert.equal(clockRunning(snapshot()), true);
	assert.equal(clockRunning(snapshot({ statusName: "STATUS_SECOND_HALF", period: 2 })), true);
	assert.equal(clockRunning(snapshot({ statusName: "STATUS_HALFTIME", period: 2 })), false);
	assert.equal(clockRunning(snapshot({ statusName: "STATUS_SHOOTOUT", period: 5 })), false);
	assert.equal(clockRunning(snapshot({ statusName: "STATUS_FULL_TIME", state: "post" })), false);
});
