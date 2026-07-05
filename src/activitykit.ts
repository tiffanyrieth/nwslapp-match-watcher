/**
 * ActivityKit (V2 Live Activity) push — start / update / end.
 *
 * ADDITIVE to V1: this reuses the SAME ES256 signer (`apnsJwt`) and `ApnsConfig` as the rich-push path
 * in apns.ts, but sends to the Live Activity channel — `apns-topic: <bundle>.push-type.liveactivity`,
 * `apns-push-type: liveactivity`, and the `aps:{event,content-state,…}` shape ActivityKit expects.
 * The V1 `sendApns` is untouched; on a goal the watcher calls BOTH (two sends, one event).
 *
 * The content-state keys MUST match Swift `MatchActivityAttributes.ContentState` exactly (the widget
 * decodes them). `clockStartEpoch` is a plain Unix-seconds number (the "virtual kickoff") so the widget
 * renders an auto-advancing minute locally — no per-minute push needed.
 */

import { ApnsConfig, ApnsResult, apnsJwt } from "./apns";

export type LivePhase = "pre" | "live" | "halftime" | "extraTime" | "penalties" | "fulltime";

/** Mirrors Swift MatchActivityAttributes.ContentState. */
export interface LiveContentState {
	homeScore: number;
	awayScore: number;
	phase: LivePhase;
	clockStartEpoch?: number; // unix seconds = now − elapsedSeconds; omit when the clock is paused
	staticLabel?: string; // "3:00 PM" | "HT" | "FT" — shown when not ticking
	lastScorer?: string;
	broadcast?: string;
}

/** Mirrors Swift MatchActivityAttributes (the static, set-once fields). */
export interface LiveAttributes {
	matchId: string;
	homeAbbr: string;
	awayAbbr: string;
	homeColorHex: string;
	awayColorHex: string;
	competition: string;
}

const ATTRIBUTES_TYPE = "MatchActivityAttributes"; // must equal the Swift type name

function liveTopic(cfg: ApnsConfig): string {
	return `${cfg.bundleId}.push-type.liveactivity`;
}

/** Drop undefined/null so we never push a null clockStartEpoch / staticLabel into content-state. */
function compact<T extends object>(o: T): Record<string, unknown> {
	return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null));
}

/** Low-level send to the Live Activity channel. Never throws — returns the per-token result. */
async function postLiveActivity(
	token: string,
	aps: Record<string, unknown>,
	jwt: string,
	cfg: ApnsConfig,
	priority: string,
): Promise<ApnsResult> {
	try {
		const res = await fetch(`https://${cfg.host}/3/device/${token}`, {
			method: "POST",
			headers: {
				authorization: `bearer ${jwt}`,
				"apns-topic": liveTopic(cfg),
				"apns-push-type": "liveactivity",
				"apns-priority": priority,
				"content-type": "application/json",
			},
			body: JSON.stringify({ aps }),
		});
		if (res.ok) return { token, ok: true, status: res.status };
		let reason: string | undefined;
		try {
			reason = ((await res.json()) as { reason?: string }).reason;
		} catch {
			reason = undefined;
		}
		return { token, ok: false, status: res.status, reason };
	} catch (err) {
		return { token, ok: false, status: 0, reason: String(err) };
	}
}

/** START a Live Activity remotely (push-to-start token). Carries the static attributes + initial state.
 *  INTENTIONALLY SILENT — no `alert` key, so the pre-match card just appears on the lock screen with no
 *  buzz or banner (the `alert` is OPTIONAL for push-to-start per Apple; it's only a "grab attention"
 *  extra). V1 owns the interrupt: the V1 kickoff push is the single buzz at minute 0. Do NOT add an
 *  `alert` here — that would double-notify against V1. Fired ≤20 min pre-kickoff (see LA_START_LEAD_MS)
 *  so every device has time to register its per-Activity token before the whistle. */
export async function startLiveActivity(
	pushToStartToken: string,
	attributes: LiveAttributes,
	state: LiveContentState,
	jwt: string,
	cfg: ApnsConfig,
	staleSeconds = 8 * 3600,
	// DIAGNOSTIC-ONLY (2026-07-04): optional alert so /test-activity can A/B whether the SILENT
	// start actually presents on current iOS. The 7/1 device finding was "no alert → APNs 200s but
	// iOS never renders the card"; the alert was later removed per Apple docs ("optional") and the
	// silent variant was never device-verified (the token bug masked every no-show since). The cron
	// path passes nothing here, so real-match behavior is unchanged.
	alert?: { title: string; body: string },
): Promise<ApnsResult> {
	const now = Math.floor(Date.now() / 1000);
	const aps = compact({
		timestamp: now,
		event: "start",
		"attributes-type": ATTRIBUTES_TYPE,
		attributes,
		"content-state": compact(state),
		"stale-date": now + staleSeconds,
		"relevance-score": 100,
		...(alert ? { alert } : {}),
	});
	return postLiveActivity(pushToStartToken, aps, jwt, cfg, "10");
}

/** UPDATE a running Activity (per-Activity token). Silent — no `alert`, so the phone never buzzes. */
export async function updateLiveActivity(
	activityToken: string,
	state: LiveContentState,
	jwt: string,
	cfg: ApnsConfig,
	opts: { staleSeconds?: number; priority?: string } = {},
): Promise<ApnsResult> {
	const now = Math.floor(Date.now() / 1000);
	const aps = compact({
		timestamp: now,
		event: "update",
		"content-state": compact(state),
		"stale-date": now + (opts.staleSeconds ?? 3600),
	});
	return postLiveActivity(activityToken, aps, jwt, cfg, opts.priority ?? "10");
}

/** END a running Activity. `dismissEpoch` keeps the final card on the lock screen until then (FT+~15m). */
export async function endLiveActivity(
	activityToken: string,
	finalState: LiveContentState,
	jwt: string,
	cfg: ApnsConfig,
	dismissEpoch: number,
): Promise<ApnsResult> {
	const now = Math.floor(Date.now() / 1000);
	const aps = compact({
		timestamp: now,
		event: "end",
		"content-state": compact(finalState),
		"dismissal-date": dismissEpoch,
	});
	return postLiveActivity(activityToken, aps, jwt, cfg, "10");
}
