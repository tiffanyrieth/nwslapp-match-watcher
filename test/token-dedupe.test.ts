/**
 * Token dedupe regression lock (2026-09-05). Pins the exact production shape found on a beta device:
 * ONE physical phone registered under THREE different device_ids (a Keychain read fails during a
 * pre-first-unlock push-to-start background launch, so DeviceIdentity mints a fresh UUID), all carrying
 * the SAME push token. The fan-out must send ONCE per token, never once per row — otherwise a device
 * gets duplicate START pushes (la-start deliberately omits apns-collapse-id, so they don't collapse
 * on-device) and every duplicate row multiplies APNs sends against the 1k budget.
 *
 * The dedupe already lives in the pure partition tails (`uniq` in partitionEventTokens /
 * groupStartTokensByKey); this test exists so it can never be removed without a failure.
 * Run with `node --test` (vitest-pool-workers can't boot workerd on Node 26; pure logic).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { groupStartTokensByKey, partitionEventTokens } from "../src/supabase.ts";

const TOKEN = "53ac8ed74f39155c84bfb04c8b1332c3a274124439f591480aa32b0f05a50741";

test("V1 club fan-out: one user, three device_id rows, same token → exactly one send", () => {
	const out = partitionEventTokens(
		[{ id: "m1:kickoff", teamIds: ["t-was"], prefColumn: "match_updates_enabled" as never }],
		[{ user_id: "chris", team_id: "t-was" }],
		["chris"],
		// three rows = three device_ids (junk UUIDs minted on locked launches) sharing one APNs token
		[
			{ user_id: "chris", token: TOKEN },
			{ user_id: "chris", token: TOKEN },
			{ user_id: "chris", token: TOKEN },
		],
	);
	assert.deepEqual(out.get("m1:kickoff"), [TOKEN]);
});

test("V2 LA start fan-out (NT batch): duplicate token rows for one user collapse per follow key", () => {
	const out = groupStartTokensByKey(
		[{ user_id: "chris", follow_key: "nt:USA" }],
		["chris"],
		[
			{ user_id: "chris", token: TOKEN },
			{ user_id: "chris", token: TOKEN },
			{ user_id: "chris", token: TOKEN },
		],
	);
	assert.deepEqual(out.get("nt:USA"), [TOKEN]);
});

test("dedupe is by TOKEN, not by user: a real second device (different token) still gets its own send", () => {
	const other = "2287b6f8efa591b762394f20304311a1f1c457d82d232836c95f74b7a66fdaea";
	const out = partitionEventTokens(
		[{ id: "m1:goal", teamIds: ["t-was"], prefColumn: "goals_enabled" as never }],
		[{ user_id: "chris", team_id: "t-was" }],
		["chris"],
		[
			{ user_id: "chris", token: TOKEN },
			{ user_id: "chris", token: TOKEN },
			{ user_id: "chris", token: other },
		],
	);
	assert.deepEqual(out.get("m1:goal"), [TOKEN, other]);
});
