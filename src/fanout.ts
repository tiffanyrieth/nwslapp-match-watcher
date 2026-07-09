/**
 * Queues fan-out — the launch-scale APNs delivery rail (docs/push-fanout-scaling.md in the app repo).
 *
 * The old design sent one APNs POST per follower INLINE inside the single cron invocation, so a team
 * with >~40 alert-followers overflowed the free plan's 50-external-subrequest cap and DROPPED the tail
 * — and a tick dying mid-loop re-fired the goal next tick (KV state persisted AFTER the sends).
 *
 * Now detection and delivery are decoupled: the cron tick (producer) looks up tokens, CHUNKS them into
 * messages (~40 tokens each), and enqueues — a Cloudflare-service binding call on the 1,000-INTERNAL
 * budget, NOT the 50-external cap. A separate consumer invocation drains one message at a time, each with
 * its OWN fresh 50-external budget, so ≤40 APNs POSTs always fit. Delivery failure can no longer block
 * state persistence, which structurally kills the duplicate-refire bug.
 *
 * Two safety properties baked in here:
 *   • sendBatch takes ≤100 messages; enqueueFanout PAGINATES the message array into ≤100 slices so a
 *     large fixture (7k followers = 175 messages) never throws.
 *   • Queues is at-least-once AND a cron crash between enqueue and MATCH_STATE.put re-enqueues → both
 *     cause a double-buzz. Every V1 message carries a deterministic `collapseId` → apns-collapse-id, so
 *     a redelivered/re-enqueued SAME event collapses on-device to one; distinct events keep distinct keys.
 */

import type { MatchEvent } from "./events";

/** One unit of fan-out work: deliver `payload` to each of `tokens` with these APNs headers, then prune
 *  dead tokens from `pruneTable`.`pruneColumn`. Self-contained so the consumer needs no other context. */
export interface FanoutMessage {
	kind: "v1" | "la-start";
	/** ≤ CHUNK device tokens — the invariant tokens/msg × batch_size(1) ≤ ~45 keeps a consumer
	 *  invocation's APNs POSTs under the 50-external cap. */
	tokens: string[];
	/** The fully-built APNs JSON body (`{ aps, … }`) — the consumer POSTs it verbatim. */
	payload: Record<string, unknown>;
	/** apns-topic: bundle id (v1) or `<bundle>.push-type.liveactivity` (la-start). */
	apnsTopic: string;
	/** apns-push-type: "alert" | "liveactivity". */
	apnsPushType: string;
	/** apns-collapse-id for dedupe (v1 events). Omitted for la-start (a start push isn't an event). */
	collapseId?: string;
	/** Supabase table/column to prune 410/BadDeviceToken tokens from. */
	pruneTable: string;
	pruneColumn: string;
	/** Human label for the diag log line. */
	label: string;
}

/** Max device tokens per message. 40 (× batch_size 1) leaves headroom under the 50-external cap after
 *  the consumer's own JWT-reuse (no per-send subrequest beyond the APNs POST itself). */
export const CHUNK = 40;
/** sendBatch hard limit — enqueueFanout slices the message array into runs of this size. */
const SEND_BATCH_MAX = 100;

/** Split a token list into ≤CHUNK-sized arrays. */
export function chunkTokens(tokens: string[], chunk = CHUNK): string[][] {
	const out: string[][] = [];
	for (let i = 0; i < tokens.length; i += chunk) out.push(tokens.slice(i, i + chunk));
	return out;
}

/** Build the fan-out messages for one send: chunk `tokens`, stamp each with the shared header/meta. */
export function buildMessages(base: Omit<FanoutMessage, "tokens">, tokens: string[], chunk = CHUNK): FanoutMessage[] {
	return chunkTokens(tokens, chunk).map((t) => ({ ...base, tokens: t }));
}

/** Enqueue messages, paginating into ≤100-per-sendBatch slices (passing >100 to sendBatch throws).
 *  Producer-side: a binding call on the internal budget, so it never touches the 50-external APNs cap. */
export async function enqueueFanout(queue: Queue<FanoutMessage>, messages: FanoutMessage[]): Promise<void> {
	if (messages.length === 0) return;
	const slices: FanoutMessage[][] = [];
	for (let i = 0; i < messages.length; i += SEND_BATCH_MAX) slices.push(messages.slice(i, i + SEND_BATCH_MAX));
	await Promise.all(slices.map((s) => queue.sendBatch(s.map((body) => ({ body })))));
}

/** Deterministic apns-collapse-id for an event so a redelivered/re-enqueued SAME event collapses to one
 *  on-device notification. Keyed on eventId + type + a discriminator that's stable per distinct event
 *  (running score / minute / side) so DIFFERENT events keep DIFFERENT ids and both still show. ≤64 bytes
 *  (eventId is ~9 digits — ample headroom). */
export function collapseIdFor(ev: MatchEvent): string {
	const s = `${ev.homeScore}-${ev.awayScore}`;
	switch (ev.type) {
		case "goal":
			return `${ev.eventId}:goal:${s}:${ev.minute ?? ""}`;
		case "redcard":
			return `${ev.eventId}:red:${ev.minute ?? ""}:${ev.scoringSide ?? ""}`;
		case "correction":
			return `${ev.eventId}:corr:${s}`;
		case "fulltime":
			return `${ev.eventId}:ft:${s}`;
		case "kickoff":
			return `${ev.eventId}:kickoff`;
		case "halftime":
			return `${ev.eventId}:halftime`;
		case "lineup":
			return `${ev.eventId}:lineup`;
		default:
			return `${ev.eventId}:${ev.type}`;
	}
}
