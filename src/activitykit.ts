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
 *  ⚠️ THE ALERT IS REQUIRED TO RENDER (device-proven 2026-07-04, contradicting Apple's "optional" docs):
 *  a start push WITHOUT an `alert` gets APNs 200 but iOS NEVER presents the card — the original
 *  no-alert "silent" design shipped invisible Activities on every real game. The buzz-free design is
 *  `alert` + `sound: ""` (renders card + quiet banner, NO sound/vibration; omitting the sound key
 *  entirely still BUZZES). V1 keeps the interrupt: its kickoff push at minute 0 is the single buzz.
 *  Fired ≤20 min pre-kickoff (see LA_START_LEAD_MS) so devices can register per-Activity tokens. */
export async function startLiveActivity(
	pushToStartToken: string,
	attributes: LiveAttributes,
	state: LiveContentState,
	jwt: string,
	cfg: ApnsConfig,
	staleSeconds = 8 * 3600,
	// DIAGNOSTIC-ONLY (2026-07-04): optional alert so /test-activity can A/B start-push presentation.
	// PROVEN on device 7/4: NO alert → APNs 200s but iOS NEVER renders the card; alert → renders.
	// (The 7/1 finding was right; "alert is optional per docs" was wrong on hardware.) `sound` is the
	// second A/B axis: omitting it STILL buzzed on device, so `sound: ""` tests whether a buzz-free
	// banner is possible at all. The cron path passes nothing here (until the design call lands).
	alert?: { title: string; body: string; sound?: string },
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

/** UPDATE a running Activity (per-Activity token). Silent by default — no `alert`, no buzz.
 *  `opts.alert` (DEVICE-TEST ONLY, 2026-07-05): Apple docs support an alert on updates (sound +
 *  lit screen + expanded Dynamic Island pop). Plumbed for /test-activity + replay --la-alerts to
 *  verify on hardware; the CRON passes no alert — a design decision gates any real use. */
export async function updateLiveActivity(
	activityToken: string,
	state: LiveContentState,
	jwt: string,
	cfg: ApnsConfig,
	opts: { staleSeconds?: number; priority?: string; alert?: { title: string; body: string; sound?: string } } = {},
): Promise<ApnsResult> {
	const now = Math.floor(Date.now() / 1000);
	const aps = compact({
		timestamp: now,
		event: "update",
		"content-state": compact(state),
		"stale-date": now + (opts.staleSeconds ?? 3600),
		...(opts.alert ? { alert: opts.alert } : {}),
	});
	return postLiveActivity(activityToken, aps, jwt, cfg, opts.priority ?? "10");
}

/** END a running Activity. `dismissEpoch` OMITTED → system default: the final card lingers on the
 *  lock screen up to Apple's ~4h cap (dates further out are ignored), user-dismissable anytime —
 *  the real cron's behavior (owner request 2026-07-05). Tests pass a short epoch so their cards
 *  self-clean. `alert` — same DEVICE-TEST ONLY knob as updateLiveActivity (end alerts appear to be
 *  IGNORED by iOS per the 7/5 device test — kept for re-testing on future iOS versions). */
export async function endLiveActivity(
	activityToken: string,
	finalState: LiveContentState,
	jwt: string,
	cfg: ApnsConfig,
	dismissEpoch?: number,
	alert?: { title: string; body: string; sound?: string },
): Promise<ApnsResult> {
	const now = Math.floor(Date.now() / 1000);
	const aps = compact({
		timestamp: now,
		event: "end",
		"content-state": compact(finalState),
		"dismissal-date": dismissEpoch,
		...(alert ? { alert } : {}),
	});
	return postLiveActivity(activityToken, aps, jwt, cfg, "10");
}
