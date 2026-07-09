/**
 * APNs Broadcast Channels — the V2 Live Activity fan-out (docs/push-fanout-scaling.md in the app repo).
 *
 * A Live Activity UPDATE used to be one APNs POST per running Activity token — same per-follower cost as
 * V1. Broadcast Channels (iOS 18+, Apple's WWDC24 sports blueprint) collapse that to ONE request: the
 * watcher creates a channel per MATCH, the push-to-start payload's `input-push-channel` subscribes each
 * Activity to it, and every in-match update is a single POST to `/4/broadcasts` — Apple fans out to all
 * subscribers, any audience size, one subrequest. Uses the SAME ES256 .p8 JWT as the device-token path.
 *
 * TWO transports, deliberately split:
 *   • SENDS (`broadcastLiveActivity`) go to the STANDARD APNs host on 443 — the exact host+port the
 *     watcher already uses in production for device pushes, so this half is proven.
 *   • MANAGEMENT (create/read/delete) goes to a DEDICATED host on a non-standard port (:2196 / :2195).
 *     Whether a Cloudflare Worker can fetch() that port is the Phase-0 probe's open question, so all
 *     management routes through the single `manageChannelRequest` seam — if the port is blocked, swap
 *     ONLY that function's body to a Supabase Edge Function hop; nothing else changes.
 */

import { apnsJwt, type ApnsConfig } from "./apns";
import { buildEndAps, buildUpdateAps, type LiveContentState } from "./activitykit";

/** Channel-management host+port (Apple-documented). Sandbox for a debug/sandbox APNs host, else prod. */
export function manageHostPort(cfg: ApnsConfig): string {
	return cfg.host.includes("sandbox")
		? "api-manage-broadcast.sandbox.push.apple.com:2195"
		: "api-manage-broadcast.push.apple.com:2196";
}

export interface ChannelResult {
	ok: boolean;
	status: number;
	channelId?: string;
	reason?: string;
}

/**
 * THE TRANSPORT SEAM. Every channel-management call goes through here. Today: a direct Worker fetch() to
 * the dedicated manage host. IF the Phase-0 probe shows Workers can't reach the manage port, replace the
 * BODY of this one function with a call to a Supabase Edge Function that performs the same request (the
 * Edge runtime has a different port policy) — signature unchanged, callers untouched.
 */
async function manageChannelRequest(
	cfg: ApnsConfig,
	jwt: string,
	method: "POST" | "GET" | "DELETE",
	pathSuffix: string,
	extraHeaders: Record<string, string> = {},
	body?: Record<string, unknown>,
): Promise<Response> {
	return fetch(`https://${manageHostPort(cfg)}/1/apps/${cfg.bundleId}${pathSuffix}`, {
		method,
		headers: {
			authorization: `bearer ${jwt}`,
			"apns-topic": cfg.bundleId,
			"content-type": "application/json",
			...extraHeaders,
		},
		body: body ? JSON.stringify(body) : undefined,
	});
}

/** Create a broadcast channel for a match. No-Storage policy (Apple's rec for frequent sports updates:
 *  higher publishing budget; a late subscriber just waits for the next broadcast). Returns the
 *  Apple-generated `apns-channel-id`. Never throws — returns a result so the caller degrades gracefully. */
export async function createChannel(cfg: ApnsConfig, jwt: string): Promise<ChannelResult> {
	try {
		const res = await manageChannelRequest(cfg, jwt, "POST", "/channels", {}, {
			"message-storage-policy": 0,
			"push-type": "LiveActivity",
		});
		const channelId = res.headers.get("apns-channel-id") ?? undefined;
		if (res.ok && channelId) return { ok: true, status: res.status, channelId };
		let reason: string | undefined;
		try {
			reason = ((await res.json()) as { reason?: string }).reason;
		} catch {
			reason = undefined;
		}
		return { ok: false, status: res.status, reason };
	} catch (err) {
		return { ok: false, status: 0, reason: String(err) };
	}
}

/** Delete a channel (post-match cleanup, or an orphan sweep). Irreversible — a channel id never recreates. */
export async function deleteChannel(cfg: ApnsConfig, jwt: string, channelId: string): Promise<boolean> {
	try {
		const res = await manageChannelRequest(cfg, jwt, "DELETE", "/channels", { "apns-channel-id": channelId });
		return res.ok;
	} catch {
		return false;
	}
}

/** List all channel ids for the app (for the orphan sweep). Returns [] on any failure. */
export async function listChannels(cfg: ApnsConfig, jwt: string): Promise<string[]> {
	try {
		const res = await manageChannelRequest(cfg, jwt, "GET", "/all-channels");
		if (!res.ok) return [];
		const body = (await res.json()) as { channels?: string[] };
		return body.channels ?? [];
	} catch {
		return [];
	}
}

/** Broadcast one Live Activity push (update or end) to a channel — ONE request, Apple fans out. Goes to
 *  the STANDARD APNs host (proven from the Worker), path `/4/broadcasts`, `apns-channel-id` header. */
async function broadcast(
	cfg: ApnsConfig,
	jwt: string,
	channelId: string,
	aps: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; reason?: string }> {
	try {
		const res = await fetch(`https://${cfg.host}/4/broadcasts/apps/${cfg.bundleId}`, {
			method: "POST",
			headers: {
				authorization: `bearer ${jwt}`,
				"apns-topic": `${cfg.bundleId}.push-type.liveactivity`,
				"apns-push-type": "liveactivity",
				"apns-priority": "10",
				"apns-channel-id": channelId,
				"content-type": "application/json",
			},
			body: JSON.stringify({ aps }),
		});
		if (res.ok) return { ok: true, status: res.status };
		let reason: string | undefined;
		try {
			reason = ((await res.json()) as { reason?: string }).reason;
		} catch {
			reason = undefined;
		}
		return { ok: false, status: res.status, reason };
	} catch (err) {
		return { ok: false, status: 0, reason: String(err) };
	}
}

/** Broadcast an UPDATE (score/phase change) to every Activity on the channel. */
export function broadcastUpdate(
	cfg: ApnsConfig,
	jwt: string,
	channelId: string,
	state: LiveContentState,
): Promise<{ ok: boolean; status: number; reason?: string }> {
	return broadcast(cfg, jwt, channelId, buildUpdateAps(state));
}

/** Broadcast an END (full time) to every Activity on the channel. Dismissal omitted → ~4h linger. */
export function broadcastEnd(
	cfg: ApnsConfig,
	jwt: string,
	channelId: string,
	finalState: LiveContentState,
): Promise<{ ok: boolean; status: number; reason?: string }> {
	return broadcast(cfg, jwt, channelId, buildEndAps(finalState));
}

/** Convenience: sign (reusing the cached JWT) and create a channel. */
export async function createChannelSigned(cfg: ApnsConfig): Promise<ChannelResult> {
	return createChannel(cfg, await apnsJwt(cfg));
}
