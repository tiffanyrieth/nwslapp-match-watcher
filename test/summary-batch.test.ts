/**
 * Batched /summary (2026-10-13): the watcher spends ONE proxy call per poll for every summary it needs,
 * because service-binding calls count toward the 50-subrequests-per-run cap (live-tested 2026-10-13). Covers
 * the batch URL builder (exact cache-bust flags, NWSL league mapping, dedupe, 40-chunking), the envelope parse,
 * whole-batch failure semantics, and the batched lineup gate counts. Run with `node --test`.
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { absorbSummaryEnvelope, fetchSummaries, SUMMARY_BATCH_MAX, summaryBatchUrls, type SummaryResult } from "../src/summary-batch.ts";
import {
	countEventGates,
	resolveCompetitionTokensBatch,
	resolveCompetitionTokensForEvent,
	resolveTokensBatch,
	resolveTokensForEvent,
	type EventGateCounts,
	type SupabaseConfig,
} from "../src/supabase.ts";

test("batch URL: bust flag only when asked, ids deduped (first wins)", () => {
	const urls = summaryBatchUrls([
		{ id: "1", league: "usa.nwsl", bust: false },
		{ id: "2", league: "fifa.friendly.w", bust: true },
		{ id: "1", league: "usa.nwsl", bust: true },
	]);
	assert.deepEqual(urls, ["https://proxy/watch/summaries?e=1:usa.nwsl,2:fifa.friendly.w:1"]);
});

test("batch URL: fake-match / non-numeric ids are never sent (no call at all if nothing real is wanted)", () => {
	assert.deepEqual(summaryBatchUrls([{ id: "fakematch-1791929352530", league: "usa.nwsl", bust: false }]), []);
	assert.deepEqual(
		summaryBatchUrls([{ id: "fakematch-1", league: "usa.nwsl", bust: false }, { id: "5", league: "usa.nwsl", bust: false }]),
		["https://proxy/watch/summaries?e=5:usa.nwsl"],
	);
});

test("batch URL: chunks at SUMMARY_BATCH_MAX (= the proxy's cap), none for an empty list", () => {
	assert.deepEqual(summaryBatchUrls([]), []);
	const wants = Array.from({ length: SUMMARY_BATCH_MAX + 3 }, (_, i) => ({ id: String(i + 1), league: "fifa.wworldq.uefa", bust: false }));
	const urls = summaryBatchUrls(wants);
	assert.equal(urls.length, 2);
	assert.equal(urls[0].split("e=")[1].split(",").length, SUMMARY_BATCH_MAX);
	assert.equal(urls[1].split("e=")[1].split(",").length, 3);
});

test("envelope: 200+body kept, failures status-only, junk entries ignored", () => {
	const out = new Map<string, SummaryResult>();
	absorbSummaryEnvelope(
		[
			{ id: "1", status: 200, body: { keyEvents: [] } },
			{ id: "2", status: 404 },
			{ id: "3", status: 200 }, // 200 without a body = not usable
			null,
			{ status: 200 },
			"x",
		],
		out,
	);
	assert.deepEqual([...out], [
		["1", { status: 200, body: { keyEvents: [] } }],
		["2", { status: 404 }],
		["3", { status: 200 }],
	]);
	absorbSummaryEnvelope({ not: "an array" }, out); // ignored, no throw
	assert.equal(out.size, 3);
});

test("fetchSummaries: one proxy call per chunk; a failed batch leaves its entries absent", async () => {
	const seen: string[] = [];
	const ok = { fetch: async (url: string) => { seen.push(url); return new Response(JSON.stringify([{ id: "9", status: 200, body: { a: 1 } }])); } };
	const got = await fetchSummaries(ok, [{ id: "9", league: "usa.nwsl", bust: true }]);
	assert.equal(seen.length, 1);
	assert.deepEqual(got.get("9"), { status: 200, body: { a: 1 } });

	assert.equal((await fetchSummaries(ok, [])).size, 0);
	assert.equal(seen.length, 1, "no call when nothing is wanted");

	const down = { fetch: async () => new Response("nope", { status: 503 }) };
	assert.equal((await fetchSummaries(down, [{ id: "9", league: "usa.nwsl", bust: false }])).size, 0);
	const throws = { fetch: async () => { throw new Error("binding gone"); } };
	assert.equal((await fetchSummaries(throws, [{ id: "9", league: "usa.nwsl", bust: false }])).size, 0);
});

test("countEventGates: distinct users across both teams; prefEligible ⊆ teamOptIns", () => {
	const counts = countEventGates(
		[{ id: "m1", teamIds: ["A", "B"] }, { id: "m2", teamIds: ["C", "D"] }],
		[
			{ user_id: "u1", team_id: "A" },
			{ user_id: "u1", team_id: "B" }, // follows both sides → counted once
			{ user_id: "u2", team_id: "B" },
			{ user_id: "u3", team_id: "Z" },
		],
		["u2", "u3"],
	);
	assert.deepEqual(counts.get("m1"), { teamOptIns: 2, prefEligible: 1 });
	assert.deepEqual(counts.get("m2"), { teamOptIns: 0, prefEligible: 0 });
});

// --- batched resolvers report the SAME gate counts as the per-event ones ---
const cfg: SupabaseConfig = { url: "https://example.supabase.co", serviceRoleKey: "svc" } as SupabaseConfig;
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function stub(tables: Record<string, unknown[]>): void {
	globalThis.fetch = (async (url: string) => {
		const t = Object.keys(tables).find((k) => String(url).includes(`/rest/v1/${k}`));
		return { ok: true, status: 200, async json() { return tables[t ?? ""] ?? []; }, async text() { return ""; } };
	}) as unknown as typeof fetch;
}

test("club batch counts === resolveTokensForEvent counts", async () => {
	stub({
		team_alert_preferences: [{ user_id: "u1", team_id: "10" }, { user_id: "u2", team_id: "11" }],
		notification_preferences: [{ user_id: "u1" }],
		device_tokens: [{ user_id: "u1", token: "t1" }],
	});
	const single = await resolveTokensForEvent(cfg, ["10", "11"], "lineup_posted");
	const counts = new Map<string, EventGateCounts>();
	const toks = await resolveTokensBatch(cfg, [{ id: "m", teamIds: ["10", "11"], prefColumn: "lineup_posted" }], counts);
	assert.deepEqual(counts.get("m"), { teamOptIns: single.teamOptIns, prefEligible: single.prefEligible });
	assert.deepEqual(toks.get("m"), single.tokens);
});

test("NT batch counts === resolveCompetitionTokensForEvent counts, incl. the 0-eligible SUSPICIOUS case", async () => {
	stub({
		competition_alert_preferences: [{ user_id: "u1", follow_key: "nt:USA" }, { user_id: "u2", follow_key: "nt:ESP" }],
		notification_preferences: [],
		device_tokens: [],
	});
	const single = await resolveCompetitionTokensForEvent(cfg, ["nt:USA", "nt:ESP"], "lineup_posted");
	const counts = new Map<string, EventGateCounts>();
	const toks = await resolveCompetitionTokensBatch(cfg, [{ id: "m", followKeys: ["nt:USA", "nt:ESP"], prefColumn: "lineup_posted" }], counts);
	assert.deepEqual(counts.get("m"), { teamOptIns: single.teamOptIns, prefEligible: single.prefEligible });
	assert.equal(single.teamOptIns, 2);
	assert.deepEqual(toks.get("m"), []);
});

test("batch with no followers at all → zero counts, no tokens", async () => {
	stub({ competition_alert_preferences: [] });
	const counts = new Map<string, EventGateCounts>();
	const toks = await resolveCompetitionTokensBatch(cfg, [{ id: "m", followKeys: ["nt:ZAM"], prefColumn: "lineup_posted" }], counts);
	assert.deepEqual(counts.get("m"), { teamOptIns: 0, prefEligible: 0 });
	assert.deepEqual(toks.get("m"), []);
});
