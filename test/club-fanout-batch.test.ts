/**
 * Batched club per-event V1 fan-out (2026-08-31) — pins the pure partition tail of resolveTokensBatch:
 * each event's uniq'd device tokens of eligible users who opted into ANY of its teamIds. This must be
 * SEMANTICALLY IDENTICAL to the old per-event resolveTokensForEvent; the batch just fans it from one set
 * of REST calls to hold the 50-external subrequest budget on a Decision-Day cluster (docs/stress-testing.md §7).
 *
 * Run with `node --test` (vitest-pool-workers can't boot workerd on Node 26; pure logic).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { partitionEventTokens } from "../src/supabase.ts";

// Two club matches firing "goal" in the same tick: match A = teams A vs B, match B = teams C vs D.
const requests = [
	{ id: "mA:goal", teamIds: ["A", "B"], prefColumn: "goals" as const },
	{ id: "mB:goal", teamIds: ["C", "D"], prefColumn: "goals" as const },
];
const alertRows = [
	{ user_id: "u1", team_id: "A" }, // follows A (match A)
	{ user_id: "u2", team_id: "B" }, // follows B (match A) — two devices
	{ user_id: "u2", team_id: "C" }, // u2 ALSO follows C (match B) → appears in both matches
	{ user_id: "u3", team_id: "C" }, // follows C (match B) but goals pref OFF → excluded
	{ user_id: "u4", team_id: "D" }, // follows D (match B), eligible but NO token
];
const eligibleIds = ["u1", "u2", "u4"]; // u3 absent (goals pref off)
const tokenRows = [
	{ user_id: "u1", token: "t1" },
	{ user_id: "u2", token: "t2a" },
	{ user_id: "u2", token: "t2b" },
	// u4 has no token row
];

test("partitions per event by team; pref + token gates applied", () => {
	const m = partitionEventTokens(requests, alertRows, eligibleIds, tokenRows);
	assert.deepEqual(m.get("mA:goal")?.sort(), ["t1", "t2a", "t2b"]); // u1 (A) + u2 (B)
	assert.deepEqual(m.get("mB:goal")?.sort(), ["t2a", "t2b"]); // u2 (C); u3 pref-off + u4 token-less drop
});

test("a user following BOTH teams of one match is counted ONCE per device", () => {
	const reqs = [{ id: "x", teamIds: ["A", "B"], prefColumn: "goals" as const }];
	const alerts = [
		{ user_id: "u2", team_id: "A" },
		{ user_id: "u2", team_id: "B" },
	];
	const m = partitionEventTokens(reqs, alerts, ["u2"], [
		{ user_id: "u2", token: "t2a" },
		{ user_id: "u2", token: "t2b" },
	]);
	assert.deepEqual(m.get("x")?.sort(), ["t2a", "t2b"]); // not doubled by the two follow rows
});

test("empty requests → empty map; every request always gets a key", () => {
	assert.equal(partitionEventTokens([], alertRows, eligibleIds, tokenRows).size, 0);
	const m = partitionEventTokens(requests, [], [], []);
	assert.deepEqual(m.get("mA:goal"), []);
	assert.deepEqual(m.get("mB:goal"), []);
});
