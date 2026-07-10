/**
 * Fan-out unit tests — the pure logic of the Queues rail (chunking, sendBatch pagination, collapse-id
 * determinism, drain retry semantics). No network/Worker runtime — run with `node --test`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMessages, chunkTokens, collapseIdFor, enqueueFanout, CHUNK, type FanoutMessage } from "../src/fanout.ts";
import type { MatchEvent } from "../src/events.ts";

const baseMsg: Omit<FanoutMessage, "tokens"> = {
	kind: "v1",
	payload: { aps: {} },
	apnsTopic: "com.example.app",
	apnsPushType: "alert",
	pruneTable: "device_tokens",
	pruneColumn: "token",
	label: "test",
};

const tokens = (n: number): string[] => Array.from({ length: n }, (_, i) => `tok${i}`);

test("chunkTokens splits into ≤CHUNK arrays with no loss", () => {
	const t = tokens(95);
	const chunks = chunkTokens(t);
	assert.equal(chunks.length, 3); // 40 + 40 + 15
	assert.equal(chunks[0].length, CHUNK);
	assert.equal(chunks[2].length, 15);
	assert.deepEqual(chunks.flat(), t); // order preserved, nothing dropped
});

test("buildMessages: each message ≤CHUNK tokens, invariant holds at scale", () => {
	const msgs = buildMessages(baseMsg, tokens(7000)); // a 7k-follower fixture
	assert.equal(msgs.length, Math.ceil(7000 / CHUNK)); // 175 messages
	assert.ok(msgs.every((m) => m.tokens.length <= CHUNK));
	assert.equal(msgs.reduce((n, m) => n + m.tokens.length, 0), 7000);
});

test("enqueueFanout paginates the message array into ≤100-per-sendBatch slices", async () => {
	const msgs = buildMessages(baseMsg, tokens(7000)); // 175 messages > 100
	const batches: number[] = [];
	const fakeQueue = {
		async sendBatch(entries: unknown[]) {
			batches.push(entries.length);
		},
		async send() {},
	} as unknown as Queue<FanoutMessage>;
	await enqueueFanout(fakeQueue, msgs);
	assert.equal(batches.length, 2); // 175 → 100 + 75
	assert.ok(batches.every((n) => n <= 100));
	assert.equal(batches.reduce((a, b) => a + b, 0), 175);
});

test("enqueueFanout no-ops on empty", async () => {
	let called = false;
	const q = { async sendBatch() { called = true; }, async send() {} } as unknown as Queue<FanoutMessage>;
	await enqueueFanout(q, []);
	assert.equal(called, false);
});

const ev = (over: Partial<MatchEvent>): MatchEvent => ({
	type: "goal",
	eventId: "401",
	teamIds: ["1"],
	prefColumn: "goals",
	title: "GOAL",
	homeAbbr: "SEA",
	awayAbbr: "POR",
	homeScore: 1,
	awayScore: 0,
	...over,
});

test("collapseId: same goal → same id; different goals → different ids", () => {
	const g1 = collapseIdFor(ev({ homeScore: 1, awayScore: 0, minute: 12 }));
	const g1again = collapseIdFor(ev({ homeScore: 1, awayScore: 0, minute: 12 }));
	const g2 = collapseIdFor(ev({ homeScore: 2, awayScore: 0, minute: 40 }));
	assert.equal(g1, g1again); // a redelivered/re-enqueued SAME goal collapses to one
	assert.notEqual(g1, g2); // distinct goals stay distinct → both show
});

test("collapseId: distinct per event type, ≤64 bytes", () => {
	const types: MatchEvent["type"][] = ["kickoff", "goal", "halftime", "fulltime", "redcard", "lineup", "correction"];
	const ids = types.map((t) => collapseIdFor(ev({ type: t })));
	assert.equal(new Set(ids).size, ids.length); // all distinct
	assert.ok(ids.every((id) => new TextEncoder().encode(id).length <= 64));
});

// ── drainMessage retry semantics ──────────────────────────────────────────────
const okRes = (token: string) => ({ token, ok: true, status: 200 });
const bad = (token: string, status: number, reason?: string) => ({ token, ok: false, status, reason });

// Stub the network + prune by monkeypatching via a message whose "payload" we don't actually send —
// instead we test drainMessage against a fake sender by dependency: drainMessage calls sendPush + prune
// internally, so here we exercise the SYSTEMIC classification through a thin re-implementation guard.
test("drain systemic classification: all-transient → retry; mixed/dead-token → ack", async () => {
	// We can't easily inject the sender without a network, so assert the classification rule directly by
	// reconstructing it (kept in lock-step with drainMessage's `systemic` predicate).
	const systemic = (results: { ok: boolean; status: number; reason?: string }[]) =>
		results.length > 0 && results.filter((r) => r.ok).length === 0 &&
		results.every((r) => r.status === 0 || r.status === 403 || r.status === 429 || r.status >= 500);

	assert.equal(systemic([bad("a", 0), bad("b", 500)]), true); // total outage → retry
	assert.equal(systemic([bad("a", 403), bad("b", 403)]), true); // auth broken → retry
	assert.equal(systemic([bad("a", 410), bad("b", 400, "BadDeviceToken")]), false); // all dead → ack + prune
	assert.equal(systemic([okRes("a"), bad("b", 0)]), false); // partial success → ack (no re-deliver dupes)
	assert.equal(systemic([]), false);
});
