/**
 * resolveTokensForEvent gate-count tests — the NO-SILENT-FAILURES breakdown behind the lineup pass's
 * "0 recipients" diagnostic. Stubs global fetch (each of the three PostgREST gate queries) so the pure
 * resolution logic is covered without a Workers runtime — run with `node --test`.
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { resolveTokensForEvent, type SupabaseConfig } from "../src/supabase.ts";

const cfg: SupabaseConfig = { url: "https://example.supabase.co", serviceRoleKey: "svc" } as SupabaseConfig;

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

/** Route each gate query to a canned JSON array by the table name in the URL. Records call order. */
function stubFetch(byTable: Record<string, unknown[]>, calls: string[]): void {
	globalThis.fetch = (async (url: string) => {
		const table = ["team_alert_preferences", "notification_preferences", "device_tokens"].find((t) =>
			String(url).includes(`/rest/v1/${t}`),
		);
		calls.push(table ?? String(url));
		return { ok: true, status: 200, async json() { return byTable[table ?? ""] ?? []; }, async text() { return ""; } };
	}) as unknown as typeof fetch;
}

test("full chain: reports team + pref counts and the resolved tokens", async () => {
	const calls: string[] = [];
	stubFetch(
		{
			team_alert_preferences: [{ user_id: "u1" }, { user_id: "u2" }],
			notification_preferences: [{ user_id: "u1" }], // only u1 has lineup_posted on
			device_tokens: [{ token: "tokA" }],
		},
		calls,
	);
	const r = await resolveTokensForEvent(cfg, ["15360", "21422"], "lineup_posted");
	assert.deepEqual(r.tokens, ["tokA"]);
	assert.equal(r.teamOptIns, 2);
	assert.equal(r.prefEligible, 1);
	assert.deepEqual(calls, ["team_alert_preferences", "notification_preferences", "device_tokens"]);
});

test("SUSPICIOUS zero: followers exist but the pref gate empties them → teamOptIns>0, tokens empty, token query SKIPPED", async () => {
	const calls: string[] = [];
	stubFetch(
		{ team_alert_preferences: [{ user_id: "u1" }], notification_preferences: [] },
		calls,
	);
	const r = await resolveTokensForEvent(cfg, ["21422"], "lineup_posted");
	assert.deepEqual(r.tokens, []);
	assert.equal(r.teamOptIns, 1); // the diagnostic that makes the drop visible
	assert.equal(r.prefEligible, 0);
	assert.deepEqual(calls, ["team_alert_preferences", "notification_preferences"]); // no wasted device_tokens query
});

test("benign zero: nobody follows either team → single query, all zero", async () => {
	const calls: string[] = [];
	stubFetch({ team_alert_preferences: [] }, calls);
	const r = await resolveTokensForEvent(cfg, ["15360", "21422"], "lineup_posted");
	assert.deepEqual(r.tokens, []);
	assert.equal(r.teamOptIns, 0);
	assert.equal(r.prefEligible, 0);
	assert.deepEqual(calls, ["team_alert_preferences"]); // short-circuits before the later gates
});

test("empty teamIds: no network, all zero", async () => {
	const calls: string[] = [];
	stubFetch({}, calls);
	const r = await resolveTokensForEvent(cfg, [], "lineup_posted");
	assert.deepEqual(r.tokens, []);
	assert.equal(r.teamOptIns, 0);
	assert.equal(calls.length, 0);
});
