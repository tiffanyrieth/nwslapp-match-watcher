/**
 * NT parity (2026-10-10): national-team matches run the club pipeline. Covers the pure / fetch-stubbed
 * pieces — the competition fan-out resolvers (gate counts for the NT lineup diag, the batched per-tick
 * lookup, the follower footprint gate) and the NT push thumbnail URL. Run with `node --test`
 * (vitest-pool-workers can't boot workerd on Node 26).
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
	followedCompetitionKeys,
	resolveCompetitionTokensBatch,
	resolveCompetitionTokensForEvent,
	type SupabaseConfig,
} from "../src/supabase.ts";
import { thumbUrl, toPayload, type MatchEvent } from "../src/events.ts";

const cfg: SupabaseConfig = { url: "https://example.supabase.co", serviceRoleKey: "svc" } as SupabaseConfig;
const TABLES = ["competition_alert_preferences", "notification_preferences", "device_tokens"];

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

function stubFetch(byTable: Record<string, unknown[]>, calls: string[]): void {
	globalThis.fetch = (async (url: string) => {
		const table = TABLES.find((t) => String(url).includes(`/rest/v1/${t}`));
		calls.push(decodeURIComponent(String(url)));
		return { ok: true, status: 200, async json() { return byTable[table ?? ""] ?? []; }, async text() { return ""; } };
	}) as unknown as typeof fetch;
}

test("NT lineup resolver: gate counts + tokens, keyed by nt: follow keys", async () => {
	const calls: string[] = [];
	stubFetch(
		{
			competition_alert_preferences: [{ user_id: "u1" }, { user_id: "u2" }],
			notification_preferences: [{ user_id: "u1" }],
			device_tokens: [{ token: "tokA" }],
		},
		calls,
	);
	const r = await resolveCompetitionTokensForEvent(cfg, ["nt:USA", "nt:ESP"], "lineup_posted");
	assert.deepEqual(r, { tokens: ["tokA"], teamOptIns: 2, prefEligible: 1 });
	assert.match(calls[0], /competition_alert_preferences\?follow_key=in\.\("nt:USA","nt:ESP"\)&alerts_enabled=eq\.true/);
	assert.match(calls[1], /lineup_posted=eq\.true/);
});

test("NT lineup resolver: SUSPICIOUS zero (followers, no pref) skips the token query", async () => {
	const calls: string[] = [];
	stubFetch({ competition_alert_preferences: [{ user_id: "u1" }], notification_preferences: [] }, calls);
	const r = await resolveCompetitionTokensForEvent(cfg, ["nt:USA"], "lineup_posted");
	assert.deepEqual(r, { tokens: [], teamOptIns: 1, prefEligible: 0 });
	assert.equal(calls.length, 2);
});

test("NT batch: 3 REST per pref column for a whole cluster; each match gets only its countries' fans", async () => {
	const calls: string[] = [];
	stubFetch(
		{
			competition_alert_preferences: [
				{ user_id: "usaFan", follow_key: "nt:USA" },
				{ user_id: "braFan", follow_key: "nt:BRA" },
				{ user_id: "both", follow_key: "nt:USA" },
				{ user_id: "both", follow_key: "nt:ESP" },
			],
			notification_preferences: [{ user_id: "usaFan" }, { user_id: "braFan" }, { user_id: "both" }],
			device_tokens: [
				{ user_id: "usaFan", token: "t-usa" },
				{ user_id: "braFan", token: "t-bra" },
				{ user_id: "both", token: "t-both" },
			],
		},
		calls,
	);
	const out = await resolveCompetitionTokensBatch(cfg, [
		{ id: "m1:goal", followKeys: ["nt:USA", "nt:ESP"], prefColumn: "goals" },
		{ id: "m2:goal", followKeys: ["nt:ARG", "nt:BRA"], prefColumn: "goals" },
		{ id: "m3:goal", followKeys: ["nt:FRA", "nt:LVA"], prefColumn: "goals" },
	]);
	assert.equal(calls.length, 3, "one batch, not 3 per event");
	assert.deepEqual([...(out.get("m1:goal") ?? [])].sort(), ["t-both", "t-usa"]); // follow-both counted once
	assert.deepEqual(out.get("m2:goal"), ["t-bra"]);
	assert.deepEqual(out.get("m3:goal"), []);
});

test("NT batch: no followers → every request resolves empty after ONE query", async () => {
	const calls: string[] = [];
	stubFetch({ competition_alert_preferences: [] }, calls);
	const out = await resolveCompetitionTokensBatch(cfg, [{ id: "m1:kickoff", followKeys: ["nt:USA"], prefColumn: "kickoff" }]);
	assert.deepEqual(out.get("m1:kickoff"), []);
	assert.equal(calls.length, 1);
});

test("footprint gate: returns the followed keys from ONE query; empty input makes no call", async () => {
	const calls: string[] = [];
	stubFetch({ competition_alert_preferences: [{ follow_key: "nt:USA" }, { follow_key: "nt:USA" }] }, calls);
	assert.deepEqual([...(await followedCompetitionKeys(cfg, ["nt:USA", "nt:ESP", "nt:USA"]))], ["nt:USA"]);
	assert.equal(calls.length, 1);
	assert.equal((await followedCompetitionKeys(cfg, [])).size, 0);
	assert.equal(calls.length, 1);
});

const goal = (national?: boolean): MatchEvent => ({
	type: "goal", eventId: "401890785", teamIds: ["2765", "2722"], prefColumn: "goals",
	title: "GOAL: United States", homeAbbr: "USA", awayAbbr: "CHI", homeScore: 1, awayScore: 0,
	scoringSide: "away", national,
});

test("thumb: NT event asks the card worker for the FLAG tile; club event unchanged", () => {
	assert.equal(thumbUrl("https://card.example/", goal(true)), "https://card.example/thumb/CHI?s=3&nt=1");
	assert.equal(thumbUrl("https://card.example/", goal()), "https://card.example/thumb/CHI?s=3");
	assert.equal(toPayload(goal(true), "https://card.example").imageUrl, "https://card.example/thumb/CHI?s=3&nt=1");
});
