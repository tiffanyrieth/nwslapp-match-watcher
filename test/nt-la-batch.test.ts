/**
 * All-NT V2 LA batched start lookup (2026-08-06) — pins the pure grouping tail of
 * startTokensByCompetitionKey: follow_key → uniq'd tokens of LA-enabled followers, the shape the
 * stress-gate's 3-REST-calls-per-tick requirement rides on (docs/stress-testing.md §7).
 *
 * Run with `node --test` (vitest-pool-workers can't boot workerd on Node 26; pure logic).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { groupStartTokensByKey } from "../src/supabase.ts";

const alertRows = [
	{ user_id: "u1", follow_key: "nt:JPN" },
	{ user_id: "u2", follow_key: "nt:JPN" },
	{ user_id: "u2", follow_key: "nt:ZAM" }, // u2 follows both sides of a JPN-ZAM match
	{ user_id: "u3", follow_key: "nt:ZAM" }, // u3 has alerts on but LA OFF
	{ user_id: "u4", follow_key: "nt:BRA" }, // u4 LA on but no registered token
];
const enabledIds = ["u1", "u2", "u4"];
const tokenRows = [
	{ user_id: "u1", token: "tok-1" },
	{ user_id: "u2", token: "tok-2a" },
	{ user_id: "u2", token: "tok-2b" }, // two devices
];

test("groups tokens per follow key; LA-off and token-less users drop out", () => {
	const m = groupStartTokensByKey(alertRows, enabledIds, tokenRows);
	assert.deepEqual(m.get("nt:JPN")?.sort(), ["tok-1", "tok-2a", "tok-2b"]);
	assert.deepEqual(m.get("nt:ZAM")?.sort(), ["tok-2a", "tok-2b"]); // u3 excluded (LA off)
	assert.equal(m.get("nt:BRA"), undefined); // u4 has no token → key absent entirely
});

test("a both-sides follower double-appears across keys but a per-match union de-dupes", () => {
	const m = groupStartTokensByKey(alertRows, enabledIds, tokenRows);
	// The caller's per-match union (home + away keys) must uniq — mirror that contract here.
	const union = [...new Set([...(m.get("nt:JPN") ?? []), ...(m.get("nt:ZAM") ?? [])])];
	assert.deepEqual(union.sort(), ["tok-1", "tok-2a", "tok-2b"]); // u2's devices ONCE each
});

test("empty inputs → empty map (no keys invented)", () => {
	assert.equal(groupStartTokensByKey([], [], []).size, 0);
	assert.equal(groupStartTokensByKey(alertRows, [], tokenRows).size, 0);
});
