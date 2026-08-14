/**
 * Predict-results LOCAL-MORNING wave — the `qualifiesForLocalMorning` predicate that lands each fan's
 * "your Predict result is in" push at ~10am THEIR time instead of a single 14:00-UTC blast (which was
 * midnight in Sydney). NWSL is worldwide, so this timezone math is load-bearing.
 *
 * Run with `node --test test/predict-local-time.test.ts` (deliberately NOT vitest — vitest-pool-workers
 * can't boot workerd on Node 26 here; this needs no Workers runtime, only native Intl).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { qualifiesForLocalMorning, PREDICT_RESULTS_LOCAL_HOUR, LEGACY_PREDICT_HOUR_UTC } from "../src/supabase.ts";

// A UTC instant at hour H on a fixed date, so DST is pinned per case.
const jul = (h: number) => new Date(`2026-07-01T${String(h).padStart(2, "0")}:00:00Z`); // DST: US/EU summer
const jan = (h: number) => new Date(`2026-01-15T${String(h).padStart(2, "0")}:00:00Z`); // standard: US/EU winter

test("US zones fire at their local 10am, DST-aware", () => {
	// EDT (summer, UTC−4): 10:00 local = 14:00 UTC.
	assert.equal(qualifiesForLocalMorning("America/New_York", jul(14)), true);
	assert.equal(qualifiesForLocalMorning("America/New_York", jul(13)), false); // 9am
	// EST (winter, UTC−5): 10:00 local = 15:00 UTC — a DIFFERENT UTC hour, proving DST is applied.
	assert.equal(qualifiesForLocalMorning("America/New_York", jan(15)), true);
	assert.equal(qualifiesForLocalMorning("America/New_York", jan(14)), false); // 9am in winter (was 10am in summer)
	// PDT (summer, UTC−7): 10:00 local = 17:00 UTC.
	assert.equal(qualifiesForLocalMorning("America/Los_Angeles", jul(17)), true);
});

test("Europe fires at local 10am across GMT/BST", () => {
	assert.equal(qualifiesForLocalMorning("Europe/London", jan(10)), true); // GMT = UTC+0
	assert.equal(qualifiesForLocalMorning("Europe/London", jul(9)), true); // BST = UTC+1 → 10:00 local
});

test("Sydney fires at local 10am (00:00 UTC) and NOT at its midnight", () => {
	assert.equal(qualifiesForLocalMorning("Australia/Sydney", jul(0)), true); // AEST UTC+10 → 10:00 local
	// 14:00 UTC = 00:00 AEST. hourCycle h23 must give 0, never a bugged "24" that could mis-match — so false.
	assert.equal(qualifiesForLocalMorning("Australia/Sydney", jul(14)), false);
});

test("spring-forward day: 10am local still resolves to exactly one UTC wave", () => {
	// US spring-forward 2026-03-08 (jump at 07:00 UTC). 14:00 UTC is after the jump → EDT → 10:00 local.
	assert.equal(qualifiesForLocalMorning("America/New_York", new Date("2026-03-08T14:00:00Z")), true);
});

test("null / blank / garbage timezone falls back to the legacy 14:00-UTC send, never throws", () => {
	assert.equal(qualifiesForLocalMorning(null, jul(LEGACY_PREDICT_HOUR_UTC)), true);
	assert.equal(qualifiesForLocalMorning(null, jul(10)), false);
	assert.equal(qualifiesForLocalMorning("", jan(14)), true);
	// A malformed IANA id must degrade to the fallback, not throw and sink the whole wave.
	assert.equal(qualifiesForLocalMorning("Mars/Phobos", jul(14)), true);
	assert.equal(qualifiesForLocalMorning("Mars/Phobos", jul(10)), false);
});

test("custom target hour", () => {
	assert.equal(PREDICT_RESULTS_LOCAL_HOUR, 10);
	// 11am AEST = 01:00 UTC.
	assert.equal(qualifiesForLocalMorning("Australia/Sydney", jul(1), 11), true);
	assert.equal(qualifiesForLocalMorning("Australia/Sydney", jul(0), 11), false);
});
