/**
 * Queue consumer delivery — draining ONE fan-out message (kept separate from fanout.ts, the producer-side
 * pure logic, so fanout.ts stays a runtime leaf that `node --test` can import without the apns/supabase
 * import chain). Called only by the queue() handler in index.ts.
 */

import { sendPush, type ApnsConfig } from "./apns";
import { pruneDeadTokens, type SupabaseConfig } from "./supabase";
import type { FanoutMessage } from "./fanout";

/** The result of draining one message — for the diag log + the retry decision. */
export interface DrainResult {
	label: string;
	sent: number;
	failed: number;
	pruned: number;
	/** True when the whole batch failed transiently/auth → the consumer retries it (max_retries → DLQ). */
	systemic: boolean;
}

/** Deliver ONE fan-out message: send to every token (own fresh 50-external budget), prune dead ones.
 *  Retry policy: a per-token 4xx (410/BadDeviceToken) is pruned, never retried — no duplicate buzz. Only
 *  a SYSTEMIC failure (every token failed on a transient/auth error: status 0, 403, 429, or ≥500) signals
 *  the caller to retry the whole batch; apns-collapse-id makes that redelivery safe. */
export async function drainMessage(
	msg: FanoutMessage,
	jwt: string,
	apns: ApnsConfig,
	sb: SupabaseConfig,
): Promise<DrainResult> {
	const results = await Promise.all(
		msg.tokens.map((t) =>
			sendPush(t, msg.payload, { topic: msg.apnsTopic, pushType: msg.apnsPushType, collapseId: msg.collapseId }, jwt, apns),
		),
	);
	await pruneDeadTokens(sb, msg.pruneTable, msg.pruneColumn, results);
	const sent = results.filter((r) => r.ok).length;
	const failed = results.length - sent;
	const pruned = results.filter((r) => !r.ok && (r.status === 410 || (r.status === 400 && r.reason === "BadDeviceToken"))).length;
	// Systemic = nothing delivered AND every failure is transient/auth (not a dead token). Dead-token-only
	// batches ack (already pruned); a genuine outage retries.
	const systemic =
		results.length > 0 &&
		sent === 0 &&
		results.every((r) => r.status === 0 || r.status === 403 || r.status === 429 || r.status >= 500);
	return { label: msg.label, sent, failed, pruned, systemic };
}
