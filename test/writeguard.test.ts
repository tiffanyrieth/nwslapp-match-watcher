/**
 * Write-guard: sameStoredState decides whether the per-tick KV write is skipped. The clock is device-side
 * (StoredState carries no ticking minute), so a quiet minute of play yields an identical state → no write.
 *
 * Run with `node --test test/writeguard.test.ts` (pure logic; vitest-pool-workers can't boot workerd on
 * Node 26 here).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { sameStoredState, type StoredState } from "../src/events.ts";

const base = (): StoredState => ({
	home: { id: "H", score: 0 },
	away: { id: "A", score: 1 },
	state: "in",
	halftimeSent: false,
	redCards: { home: 0, away: 0 },
	virtualKickoff: 1_700_000_000,
	vkPeriod: 1,
});

test("identical state → same (the skip case: a quiet minute of play)", () => {
	assert.equal(sameStoredState(base(), base()), true);
});

test("a real change → NOT same (a write must happen)", () => {
	for (const mutate of [
		(s: StoredState) => (s.home.score = 1),
		(s: StoredState) => (s.away.score = 2),
		(s: StoredState) => (s.state = "post"),
		(s: StoredState) => (s.halftimeSent = true),
		(s: StoredState) => (s.redCards = { home: 1, away: 0 }),
		(s: StoredState) => (s.virtualKickoff = 1_700_000_600),
		(s: StoredState) => (s.vkPeriod = 2),
	]) {
		const b = base();
		mutate(b);
		assert.equal(sameStoredState(base(), b), false);
	}
});

test("legacy row (undefined optionals) upgrading to defined counts as a CHANGE → write", () => {
	const legacy = base();
	delete legacy.redCards;
	delete legacy.virtualKickoff;
	delete legacy.vkPeriod;
	assert.equal(sameStoredState(legacy, base()), false); // undefined !== 0/number → write the upgrade
});

test("both sides undefined on the optionals, same core → same (skip)", () => {
	const a = base();
	const b = base();
	for (const s of [a, b]) {
		delete s.redCards;
		delete s.virtualKickoff;
		delete s.vkPeriod;
	}
	assert.equal(sameStoredState(a, b), true);
});
