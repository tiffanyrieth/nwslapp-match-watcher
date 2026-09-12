/**
 * Tick metronome arithmetic (2026-09-12) — pins the pure decisions behind the Durable Object alarm that
 * drives the per-minute tick and the stale-tick guard on the cron watchdog (src/metronome.ts). These are the
 * rules that decide (a) when the next tick fires, (b) whether a cron delivery is a Cloudflare backlog REPLAY
 * to be skipped, and (c) whether the watchdog must re-arm a broken alarm chain. Regressions here would
 * either double-run ticks (the duplicate-Live-Activity bug) or silently stop them.
 *
 * Run with `node --test` (vitest-pool-workers can't boot workerd on Node 26; pure logic).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	ALARM_STALL_MS,
	STALE_TICK_MS,
	TICK_PERIOD_MS,
	isStaleScheduledTick,
	nextMinuteBoundary,
	scheduledTimeMs,
	shouldRearm,
} from "../src/metronome.ts";

const T0 = Date.UTC(2026, 8, 12, 1, 36, 7, 250); // 2026-09-12T01:36:07.250Z — mid-minute

test("nextMinuteBoundary: strictly the next :00, even from an exact boundary", () => {
	assert.equal(nextMinuteBoundary(T0), Date.UTC(2026, 8, 12, 1, 37, 0, 0));
	const exact = Date.UTC(2026, 8, 12, 1, 37, 0, 0);
	assert.equal(nextMinuteBoundary(exact), exact + TICK_PERIOD_MS, "an exact boundary schedules the FOLLOWING minute, never itself");
	assert.equal(nextMinuteBoundary(exact - 1), exact);
});

test("nextMinuteBoundary: a 21s tick still lands on the next minute (cadence holds under real tick length)", () => {
	// Alarm fires at :00 + ~jitter, tick runs ~21 s (median live tick), re-arm computed AFTER the run.
	const fired = Date.UTC(2026, 8, 12, 1, 36, 0, 420);
	const rearmedAt = fired + 21_545;
	assert.equal(nextMinuteBoundary(rearmedAt), Date.UTC(2026, 8, 12, 1, 37, 0, 0));
});

test("scheduledTimeMs: accepts seconds (Observability rendering) or milliseconds (runtime contract)", () => {
	assert.equal(scheduledTimeMs(1789176967), 1789176967_000, "a seconds value is scaled");
	assert.equal(scheduledTimeMs(1789176967_000), 1789176967_000, "a ms value passes through");
});

test("isStaleScheduledTick: normal jitter (25–30s) is LIVE; the 2026-09-12 replays (162–375s) are STALE", () => {
	const slot = Date.UTC(2026, 8, 12, 1, 39, 7);
	assert.equal(isStaleScheduledTick(slot, slot + 25_000), false, "25s late = normal delivery");
	assert.equal(isStaleScheduledTick(slot, slot + 30_000), false, "30s late = normal delivery");
	assert.equal(isStaleScheduledTick(slot, slot + STALE_TICK_MS), false, "exactly the threshold is still live");
	assert.equal(isStaleScheduledTick(slot, slot + STALE_TICK_MS + 1), true, "just past the threshold is stale");
	// The observed replay burst: exec 01:41:48.973 for the 01:39:07 slot (162s), and 01:42:21 for 01:36:07 (375s).
	assert.equal(isStaleScheduledTick(slot, slot + 162_000), true);
	assert.equal(isStaleScheduledTick(Date.UTC(2026, 8, 12, 1, 36, 7), Date.UTC(2026, 8, 12, 1, 42, 21, 616)), true);
	// Same decision when the runtime hands us seconds.
	assert.equal(isStaleScheduledTick(Math.floor(slot / 1000), slot + 162_000), true);
	assert.equal(isStaleScheduledTick(Math.floor(slot / 1000), slot + 25_000), false);
});

test("isStaleScheduledTick: an unknown/invalid scheduledTime is treated as LIVE (fail-open, never drop the watchdog)", () => {
	assert.equal(isStaleScheduledTick(NaN, T0), false);
	assert.equal(isStaleScheduledTick(0, T0), false);
	assert.equal(isStaleScheduledTick(-5, T0), false);
});

test("shouldRearm: a healthy chain (alarm pending within a period, recent run) is left alone", () => {
	const alarmAt = T0 + 52_750; // next :00
	assert.equal(shouldRearm(alarmAt, T0 - 20_000, T0), false);
	assert.equal(shouldRearm(alarmAt, null, T0), false, "fresh DO with an alarm armed but no run yet — let it fire");
});

test("shouldRearm: the cron watchdog landing MID-TICK (arm-first alarm) must NOT re-arm — the live-proven 2026-09-12 case", () => {
	// Alarm fired at :00 and, ARM-FIRST, set the next :00 before running the ~21 s tick. The cron watchdog
	// fires ~7–11 s later, while the tick is still running: it must see the pending next-:00 alarm and the
	// PREVIOUS minute's lastRunAt (~67 s ago) and leave the chain alone. (Re-arming in a `finally` instead
	// left getAlarm() null for the whole run → spurious "metronome was down" + a Canceled duplicate alarm.)
	const minute = Date.UTC(2026, 8, 12, 3, 13, 0, 0);
	const alarmAt = minute + TICK_PERIOD_MS; // armed first, for the next :00
	const lastRunAt = minute - TICK_PERIOD_MS + 400; // previous minute's tick start (written in its finally)
	const watchdogAt = minute + 10_500; // cron delivery jitter, tick still in flight
	assert.equal(shouldRearm(alarmAt, lastRunAt, watchdogAt), false);
	// …and at the END of a long live tick (26 s budget), still healthy.
	assert.equal(shouldRearm(alarmAt, lastRunAt, minute + 26_000), false);
});

test("shouldRearm: no alarm at all → re-arm (fresh DO, or a setAlarm that never happened)", () => {
	assert.equal(shouldRearm(null, null, T0), true);
	assert.equal(shouldRearm(null, T0 - 10_000, T0), true);
});

test("shouldRearm: an alarm stuck in the past by more than a period → re-arm", () => {
	assert.equal(shouldRearm(T0 - TICK_PERIOD_MS, T0 - 5_000, T0), false, "up to one period in the past is tolerated (about to fire / in flight)");
	assert.equal(shouldRearm(T0 - TICK_PERIOD_MS - 1, T0 - 5_000, T0), true);
});

test("shouldRearm: an alarm absurdly far in the future (> 2 periods) → re-arm (ours is always ≤ 1 period out)", () => {
	assert.equal(shouldRearm(T0 + 2 * TICK_PERIOD_MS, T0 - 5_000, T0), false);
	assert.equal(shouldRearm(T0 + 2 * TICK_PERIOD_MS + 1, T0 - 5_000, T0), true);
});

test("shouldRearm: a pending alarm but the last run is older than ALARM_STALL_MS → re-arm (chain looks wedged)", () => {
	const alarmAt = T0 + 30_000;
	assert.equal(shouldRearm(alarmAt, T0 - ALARM_STALL_MS, T0), false, "exactly the stall window is still tolerated");
	assert.equal(shouldRearm(alarmAt, T0 - ALARM_STALL_MS - 1, T0), true);
});
