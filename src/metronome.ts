/**
 * Tick metronome helpers (2026-09-12) — the PURE arithmetic behind the Durable Object alarm that now drives
 * the per-minute watcher tick, and the stale-tick guard on the (demoted) cron watchdog. Deliberately free of
 * Workers APIs so `node --test` can pin every decision (the DO class itself lives in index.ts next to
 * `runTick`, which it calls — keeping it there avoids a circular import).
 *
 * WHY THIS EXISTS (full record: docs/notifications.md, cron section; docs/decisions.md). Cloudflare Cron
 * Triggers dispatch stalled 5× in 9 days (2026-09-03 → 09-12; CF status incident sjs8s0q2x4hw "Workers Cron
 * Triggers degraded"): scheduled invocations stop arriving for minutes–hours on EVERY worker in the account
 * while fetch keeps working, then CF REPLAYS the missed ticks in an out-of-order burst (two ticks executed
 * 97 ms apart with scheduledTime stamps 3–5 min stale). Consequences on a live game night: the pre-start
 * Live Activity + Starting XI landed ~3.5 min late, and the replayed pair raced the `la-start` KV marker →
 * a DUPLICATED Live Activity card. Nothing in our code caused the stalls (change-by-change audit + platform
 * research, 2026-09-11); the watcher simply had ONE heartbeat and no tolerance for it skipping.
 *
 * Design: Durable Object alarms are documented at-least-once, auto-retried, with no single point of failure
 * and a DIFFERENT dispatch path than cron (per-DO at the edge vs the central cron scheduler). So the alarm is
 * the ONLY tick source; the `* * * * *` cron survives purely as a WATCHDOG that re-arms the alarm if the chain
 * ever breaks — it never runs the tick itself. One trigger ⇒ no concurrent ticks ⇒ no replay races.
 */

/** Cadence of the alarm-driven tick — mirrors the old `* * * * *` cron. */
export const TICK_PERIOD_MS = 60_000;

/** A cron tick executing this long after its scheduled slot is a CF backlog REPLAY, not a live tick.
 *  Normal delivery jitter measured 25–30 s (Observability export, 2026-09-12); 90 s leaves margin. */
export const STALE_TICK_MS = 90_000;

/** If the alarm's last completed run is older than this, the watchdog treats the chain as broken. */
export const ALARM_STALL_MS = 3 * TICK_PERIOD_MS;

/** Next wall-clock :00 minute boundary strictly after `nowMs` — the alarm fires at each minute, like cron. */
export function nextMinuteBoundary(nowMs: number): number {
	return (Math.floor(nowMs / TICK_PERIOD_MS) + 1) * TICK_PERIOD_MS;
}

/** `ScheduledController.scheduledTime` is documented in MILLISECONDS, but Cloudflare's Observability export
 *  renders the same field in SECONDS (seen 2026-09-12: `scheduledTime: 1789177807`). Accept either so the
 *  guard can never misfire on a unit mismatch: anything below 1e12 can only be seconds (1e12 ms = 2001). */
export function scheduledTimeMs(raw: number): number {
	return raw < 1e12 ? raw * 1000 : raw;
}

/** True when a cron tick is a replayed backlog delivery (executing > `thresholdMs` after its slot).
 *  An unknown/invalid scheduledTime is treated as LIVE (fail-open: never drop a real watchdog run). */
export function isStaleScheduledTick(rawScheduledTime: number, nowMs: number, thresholdMs = STALE_TICK_MS): boolean {
	if (!Number.isFinite(rawScheduledTime) || rawScheduledTime <= 0) return false;
	return nowMs - scheduledTimeMs(rawScheduledTime) > thresholdMs;
}

/** Watchdog decision — re-arm the alarm when:
 *  - there is no alarm at all (fresh DO, or the chain broke: a `setAlarm` that never happened);
 *  - the alarm is in the PAST by more than a period (set, but never fired);
 *  - the alarm is absurdly far in the future (> 2 periods — a `setAlarm` bug; ours is always ≤ 1 period out);
 *  - the last completed run is older than ALARM_STALL_MS while an alarm claims to be pending.
 *  Otherwise leave it alone — a healthy metronome must never be double-armed (setAlarm REPLACES the alarm,
 *  so re-arming a healthy chain would only shift its cadence). */
export function shouldRearm(alarmAt: number | null, lastRunAt: number | null, nowMs: number): boolean {
	if (alarmAt === null) return true;
	if (nowMs - alarmAt > TICK_PERIOD_MS) return true;
	if (alarmAt - nowMs > 2 * TICK_PERIOD_MS) return true;
	if (lastRunAt !== null && nowMs - lastRunAt > ALARM_STALL_MS) return true;
	return false;
}
