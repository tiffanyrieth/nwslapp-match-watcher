/**
 * nwslapp-match-watcher — NWSLApp's live-event push watcher (Tier 2 / server push).
 *
 * A scheduled (cron) Worker, separate from the request/response `nwslapp-proxy`
 * but reusing its cached ESPN data. Once a minute it:
 *   1. fetches the season scoreboard via the proxy (so it shares the edge cache,
 *      never hammering ESPN directly),
 *   2. for each match in the live window, diffs its snapshot against the
 *      last-known state in KV to detect events (kickoff / goal / halftime /
 *      full-time),
 *   3. for each event, looks up (service-role) the device tokens of users who
 *      follow either team and have THAT alert enabled, and
 *   4. sends an APNs push to each.
 *
 * Stages C adds kickoff/halftime/full-time to the original goals (Stage B), all
 * from the scoreboard's status. Substitutions + lineup-posted need the per-match
 * `/summary` endpoint (the scoreboard carries no subs and no lineups) → Stage D.
 * A manual `POST /test-push` route sends a synthetic push to one device so
 * on-device delivery can be verified during the NWSL World Cup break.
 *
 * Cloudflare's cron floor is 1 minute; with the proxy's 30s live TTL, end-to-end
 * latency is ≈ up to 90s. Sub-minute polling (a Durable Object alarm) is a
 * scale-only future optimization, not this stage.
 */

import { apnsJwt, sendApns, type ApnsConfig } from "./apns";
import { detectEvents, nextState, parseMatch, toPayload, type Match, type ScoreboardEvent, type StoredState } from "./events";
import { handleCard } from "./card";
import { activityTokensForMatch, allStartTokens, startTokensForTeams, tokensForEvent, type SupabaseConfig } from "./supabase";
import { endLiveActivity, startLiveActivity, updateLiveActivity, type LiveContentState, type LivePhase } from "./activitykit";
import { attributesFor, contentStateFromMatch, preContentState, upcomingInfo } from "./livestate";

export interface Env {
	/** KV namespace holding per-match last-known scores (key `match:{eventId}`). */
	MATCH_STATE: KVNamespace;

	// Supabase (service role — bypasses RLS for the cross-user follower lookup).
	SUPABASE_URL: string;
	SUPABASE_SERVICE_ROLE_KEY: string;

	// APNs token auth.
	APNS_KEY_P8: string;
	APNS_KEY_ID: string;
	APNS_TEAM_ID: string;
	APNS_BUNDLE_ID: string;
	/** APNs host — api.sandbox.push.apple.com (dev) or api.push.apple.com (TestFlight). */
	APNS_HOST: string;

	/** This worker's own public origin (where GET /card lives) — goes in `imageUrl`. */
	WATCHER_PUBLIC_URL: string;

	/** Service binding to the sibling proxy (its /scoreboard + /crest routes). A binding,
	 *  not a workers.dev fetch: same-account Worker→Worker over the public URL fails with
	 *  Cloudflare error 1042. The URL host is ignored by the binding; only the path matters. */
	PROXY: Fetcher;

	/** Shared secret guarding the manual /test-push route. */
	MANUAL_TRIGGER_SECRET: string;
}

// The sibling proxy's scoreboard route, reached via the PROXY service binding (host is
// ignored by the binding — only the path matters). Shared edge cache, transparent ESPN bytes.
const PROXY_SCOREBOARD = "https://proxy/scoreboard";
const MATCH_STATE_TTL = 21600; // 6h — auto-expires a match's KV entry after it ends.

// V2 Live Activity timing.
const LA_START_LEAD_MS = 5 * 60 * 1000; // remote-start the Activity ≤5 min before kickoff
const LA_RESYNC_MS = 10 * 60 * 1000; // clock-drift resync cadence (the widget's local timer ticks between)
const LA_DISMISS_AFTER_S = 15 * 60; // keep the FT card on the lock screen ~15 min, then dismiss

function apnsConfig(env: Env): ApnsConfig {
	return {
		keyP8: env.APNS_KEY_P8,
		keyId: env.APNS_KEY_ID,
		teamId: env.APNS_TEAM_ID,
		bundleId: env.APNS_BUNDLE_ID,
		host: env.APNS_HOST,
	};
}

function supabaseConfig(env: Env): SupabaseConfig {
	return { url: env.SUPABASE_URL, serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY };
}

export default {
	// Cron entry point (configured in wrangler.jsonc: "* * * * *").
	async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
		ctx.waitUntil(runWatch(env));
	},

	// HTTP entry point: health + match-card render + the manual test-push trigger.
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		if (request.method === "GET" && url.pathname === "/") {
			return new Response(
				"nwslapp-match-watcher — cron live-event watcher (kickoff/goal/halftime/full-time). POST /test-push (x-trigger-secret) to send a synthetic push. GET /card/<matchId>?e&h&a&hs&as&min&sc renders the match card.",
				{ status: 200 },
			);
		}

		// Server-rendered match-card PNG attached to rich pushes (downloaded by the NSE).
		if (request.method === "GET" && url.pathname.startsWith("/card/")) {
			return handleCard(request, env, ctx);
		}

		if (request.method === "POST" && url.pathname === "/test-push") {
			return handleTestPush(request, env);
		}

		if (request.method === "POST" && url.pathname === "/test-activity") {
			return handleTestActivity(request, env);
		}

		return new Response("Not found.", { status: 404 });
	},
} satisfies ExportedHandler<Env>;

// A match is "in the live window" if it kicked off within the last 4h (covers
// in-progress + just-finished) and not more than 5min in the future. This bounds
// the per-match KV reads to today's handful of games instead of the whole season.
const WINDOW_PAST_MS = 4 * 60 * 60 * 1000;
const WINDOW_FUTURE_MS = 5 * 60 * 1000;

/** Kickoff time in ms, tolerating ESPN's seconds-less timestamps ("…T17:00Z"). */
function kickoffMs(event: ScoreboardEvent): number | null {
	if (!event.date) return null;
	const normalized = /T\d{2}:\d{2}Z$/.test(event.date) ? event.date.replace("Z", ":00Z") : event.date;
	const ms = Date.parse(normalized);
	return Number.isFinite(ms) ? ms : null;
}

/** One poll: scoreboard → per-match diff → event pushes. */
async function runWatch(env: Env): Promise<void> {
	const year = new Date().getUTCFullYear();
	const now = Date.now();
	let events: ScoreboardEvent[];
	try {
		const res = await env.PROXY.fetch(`${PROXY_SCOREBOARD}?dates=${year}0101-${year}1231&limit=500`, {
			headers: { Accept: "application/json" },
		});
		if (!res.ok) {
			console.log(`[watcher] scoreboard fetch failed: ${res.status}`);
			return;
		}
		events = ((await res.json()) as { events?: ScoreboardEvent[] }).events ?? [];
	} catch (err) {
		console.log(`[watcher] scoreboard fetch threw: ${err}`);
		return;
	}

	const sb = supabaseConfig(env);
	const apns = apnsConfig(env);
	let jwt: string | undefined; // signed lazily — only if an event actually fires.

	for (const event of events) {
		// Live-window gate (cheap, no I/O) before any KV read.
		const ko = kickoffMs(event);
		if (ko === null || now - ko > WINDOW_PAST_MS || ko - now > WINDOW_FUTURE_MS) continue;

		const match = parseMatch(event); // null unless "in" or "post" with both team ids
		if (!match) continue;

		const key = `match:${match.eventId}`;
		const prev = await env.MATCH_STATE.get<StoredState>(key, "json");

		// A "post" match we were never tracking (no prior live state) → already
		// finished before we started; skip so we don't fire a late full-time.
		if (match.state === "post" && !prev) continue;

		const detected = detectEvents(prev, match);

		for (const ev of detected) {
			let tokens: string[];
			try {
				tokens = await tokensForEvent(sb, ev.teamIds, ev.prefColumn);
			} catch (err) {
				console.log(`[watcher] follower lookup failed (${ev.type} ${ev.eventId}): ${err}`);
				continue;
			}
			if (tokens.length === 0) continue;

			jwt ??= await apnsJwt(apns);
			const payload = toPayload(ev, env.WATCHER_PUBLIC_URL);
			const results = await Promise.all(tokens.map((t) => sendApns(t, payload, jwt!, apns)));
			const sent = results.filter((r) => r.ok).length;
			console.log(`[watcher] ${ev.type} "${ev.title}": ${sent}/${tokens.length} pushed`);
		}

		// Persist the new state while live; clean up once the match has ended (so a
		// later "post" tick is skipped by the no-prev guard above — no duplicate FT).
		// V2 Live Activity (ADDITIVE — the V1 push path above is untouched). Pushes the current
		// state to this match's running Activities on an event / full-time / periodic resync.
		try {
			await syncLiveActivity(env, sb, apns, match, detected.length > 0);
		} catch (err) {
			console.log(`[watcher] LA sync failed (${match.eventId}): ${err}`);
		}

		if (match.state === "post") {
			await env.MATCH_STATE.delete(key);
		} else {
			await env.MATCH_STATE.put(key, JSON.stringify(nextState(prev, match, detected)), {
				expirationTtl: MATCH_STATE_TTL,
			});
		}
	}

	// SEPARATE pass (not tangled into detectEvents): remote-start a Live Activity for any match
	// kicking off within the next ~5 min that a signed-in user has alerts ON for. KV-deduped.
	try {
		await startUpcomingActivities(env, events, sb, apns);
	} catch (err) {
		console.log(`[watcher] LA start pass failed: ${err}`);
	}
}

/** V2: push the current match state to its running Activities (UPDATE), END them at full time, or skip
 *  when only the local clock needs to tick. Resync is throttled (LA_RESYNC_MS) so we don't push per poll. */
async function syncLiveActivity(
	env: Env,
	sb: SupabaseConfig,
	apns: ApnsConfig,
	match: Match,
	hadEvent: boolean,
): Promise<void> {
	const ended = match.state === "post";
	const rsKey = `la-rs:${match.eventId}`;
	if (!ended && !hadEvent) {
		const last = await env.MATCH_STATE.get(rsKey);
		if (last && Date.now() - Number(last) < LA_RESYNC_MS) return; // the widget's local timer covers it
	}
	const tokens = await activityTokensForMatch(sb, match.eventId);
	if (tokens.length === 0) return;
	const jwt = await apnsJwt(apns);
	const state: LiveContentState = contentStateFromMatch(match);
	if (ended) {
		const dismissAt = Math.floor(Date.now() / 1000) + LA_DISMISS_AFTER_S;
		await Promise.all(tokens.map((t) => endLiveActivity(t, state, jwt, apns, dismissAt)));
		await env.MATCH_STATE.delete(rsKey);
		console.log(`[watcher] LA end ${match.eventId}: ${tokens.length} activities`);
	} else {
		await Promise.all(tokens.map((t) => updateLiveActivity(t, state, jwt, apns)));
		await env.MATCH_STATE.put(rsKey, String(Date.now()), { expirationTtl: MATCH_STATE_TTL });
	}
}

/** SEPARATE start trigger (NOT detectEvents): for matches ≤5 min pre-kickoff, remote-start a Live
 *  Activity for everyone with alerts ON for a participating team + a push-to-start token. KV-deduped. */
async function startUpcomingActivities(
	env: Env,
	events: ScoreboardEvent[],
	sb: SupabaseConfig,
	apns: ApnsConfig,
): Promise<void> {
	const now = Date.now();
	for (const event of events) {
		const ko = kickoffMs(event);
		if (ko === null || ko < now || ko - now > LA_START_LEAD_MS) continue;
		const info = upcomingInfo(event);
		if (!info) continue;
		const startedKey = `la-start:${info.matchId}`;
		if (await env.MATCH_STATE.get(startedKey)) continue;
		let tokens: string[];
		try {
			tokens = await startTokensForTeams(sb, [info.homeId, info.awayId]);
		} catch (err) {
			console.log(`[watcher] LA start lookup failed (${info.matchId}): ${err}`);
			continue;
		}
		if (tokens.length === 0) continue; // no opt-ins yet — retry next poll, still inside the window
		const jwt = await apnsJwt(apns);
		const attrs = attributesFor(info.matchId, info.homeAbbr, info.awayAbbr);
		const state = preContentState(kickoffLabel(ko));
		const results = await Promise.all(tokens.map((t) => startLiveActivity(t, attrs, state, jwt, apns)));
		const ok = results.filter((r) => r.ok).length;
		console.log(`[watcher] LA start ${info.homeAbbr} vs ${info.awayAbbr}: ${ok}/${tokens.length}`);
		await env.MATCH_STATE.put(startedKey, String(now), { expirationTtl: MATCH_STATE_TTL });
	}
}

/** Scheduled kickoff time as a short US-Eastern label ("3:00 PM") for the pre-match Activity. */
function kickoffLabel(ko: number): string {
	try {
		return new Date(ko).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
	} catch {
		return "Kickoff soon";
	}
}

/**
 * Manual trigger: send a synthetic push to one device token, so the full RICH look
 * (NSE wakes → downloads the match card → attaches it) can be verified on a real
 * device before matches resume. A notification's appearance is purely a function of
 * its payload, so this renders byte-identical to a live goal. Guarded by a secret.
 *
 * Body: { token, title?, subtitle?, body?, eventID?, event?, imageUrl? }. When
 * `imageUrl` is omitted it defaults to this worker's own /card render for the given
 * event, so the simplest call still produces the composited card.
 */
async function handleTestPush(request: Request, env: Env): Promise<Response> {
	if (request.headers.get("x-trigger-secret") !== env.MANUAL_TRIGGER_SECRET) {
		return new Response("Forbidden.", { status: 403 });
	}

	let payload: {
		token?: string;
		title?: string;
		subtitle?: string;
		body?: string;
		eventID?: string;
		event?: string;
		imageUrl?: string;
	};
	try {
		payload = (await request.json()) as typeof payload;
	} catch {
		return new Response("Bad JSON.", { status: 400 });
	}
	if (!payload.token) {
		return new Response("Missing 'token'.", { status: 400 });
	}

	const apns = apnsConfig(env);
	const jwt = await apnsJwt(apns);
	const eventID = payload.eventID ?? "401853925";
	const event = payload.event ?? "goal";
	// Default to a real-looking goal card on this worker if the caller didn't pass one.
	const imageUrl =
		payload.imageUrl ??
		`${env.WATCHER_PUBLIC_URL.replace(/\/$/, "")}/card/${eventID}?e=${event}&h=WAS&a=ORL&hs=1&as=0&min=67&sc=${encodeURIComponent("T. Rieth")}`;

	const alert: Record<string, string> = {
		title: payload.title ?? "GOAL — WAS 1–0 ORL",
		body: payload.body ?? "Washington Spirit scored.",
	};
	if (payload.subtitle) alert.subtitle = payload.subtitle;

	const result = await sendApns(
		payload.token,
		{
			aps: {
				alert,
				"mutable-content": 1,
				sound: "default",
				"thread-id": `match-${eventID}`,
				"interruption-level": "time-sensitive",
			},
			eventID,
			matchId: eventID,
			event,
			imageUrl,
		},
		jwt,
		apns,
	);

	return new Response(JSON.stringify(result, null, 2), {
		status: result.ok ? 200 : 502,
		headers: { "Content-Type": "application/json" },
	});
}

/**
 * Manual trigger for V2 Live Activities — the on-device verification path (mirrors /test-push).
 * Body: { mode: "start"|"update"|"end", token?, matchId?, h?, a?, hs?, as?, phase?, min?, sc?, comp? }.
 *   - mode "start": creates the Activity with the given attributes + initial state.
 *   - mode "update"/"end": pushes a new content-state / ends it.
 * Token targeting:
 *   - `token` PRESENT  → push to that one device (single-device test; back-compat). For "start" it's the
 *     device's push-to-start token; for "update"/"end" it's the per-Activity token.
 *   - `token` OMITTED  → FAN OUT to all registered devices (the replay tool): "start" → every
 *     push-to-start token (allStartTokens); "update"/"end" → every per-Activity token for `matchId`
 *     (activityTokensForMatch). The service-role read stays in the Worker, so the caller needs only the
 *     trigger secret. Use a synthetic `matchId` (e.g. "replay-test") so test rows never collide with a
 *     real match (the cron only ever queries matchIds in the live scoreboard).
 * Fire a sequence (start → update goal → update HT → … → end) to walk the full lifecycle on device.
 * Returns { mode, matchId, tokenCount, okCount, results[] } — every per-token APNs result (no silent fail).
 */
async function handleTestActivity(request: Request, env: Env): Promise<Response> {
	if (request.headers.get("x-trigger-secret") !== env.MANUAL_TRIGGER_SECRET) {
		return new Response("Forbidden.", { status: 403 });
	}
	let p: {
		mode?: "start" | "update" | "end";
		token?: string;
		matchId?: string;
		h?: string;
		a?: string;
		hs?: number;
		as?: number;
		phase?: LivePhase;
		min?: number;
		sc?: string;
		comp?: string;
	};
	try {
		p = (await request.json()) as typeof p;
	} catch {
		return new Response("Bad JSON.", { status: 400 });
	}
	const apns = apnsConfig(env);
	const jwt = await apnsJwt(apns);
	const nowSec = Math.floor(Date.now() / 1000);
	const phase: LivePhase = p.phase ?? "live";
	const running = phase === "live" || phase === "extraTime";
	const state: LiveContentState = {
		homeScore: p.hs ?? 0,
		awayScore: p.as ?? 0,
		phase,
		clockStartEpoch: running ? nowSec - (p.min ?? 1) * 60 : undefined,
		staticLabel:
			phase === "pre" ? "3:00 PM" : phase === "halftime" ? "HT" : phase === "fulltime" ? "FT" : undefined,
		lastScorer: p.sc,
		broadcast: "Paramount+",
	};

	const mode = p.mode ?? "start";
	const matchId = p.matchId ?? "test-match";

	// Resolve the target tokens. Explicit `token` → that one device (single-device test, back-compat).
	// Omitted → fan out to ALL registered devices: start → every push-to-start token; update/end →
	// every per-Activity token for this matchId. The service-role read stays server-side. A Supabase
	// error here must fail LOUD with the reason (the bare-500 it'd otherwise be is a silent failure).
	const sb = supabaseConfig(env);
	let tokens: string[];
	try {
		tokens = p.token
			? [p.token]
			: mode === "start"
				? await allStartTokens(sb)
				: await activityTokensForMatch(sb, matchId);
	} catch (err) {
		return new Response(
			JSON.stringify({ mode, matchId, error: `token resolution failed: ${String(err)}` }, null, 2),
			{ status: 502, headers: { "Content-Type": "application/json" } },
		);
	}
	if (tokens.length === 0) {
		return new Response(
			JSON.stringify(
				{ mode, matchId, tokenCount: 0, okCount: 0, results: [], note: "No registered tokens for this fan-out." },
				null,
				2,
			),
			{ status: 502, headers: { "Content-Type": "application/json" } },
		);
	}

	const send = (token: string) => {
		if (mode === "start") {
			const attrs = attributesFor(matchId, p.h ?? "ORL", p.a ?? "POR", p.comp ?? "NWSL");
			return startLiveActivity(token, attrs, state, jwt, apns);
		}
		if (mode === "end") return endLiveActivity(token, state, jwt, apns, nowSec + LA_DISMISS_AFTER_S);
		return updateLiveActivity(token, state, jwt, apns);
	};
	const results = await Promise.all(tokens.map(send));
	const okCount = results.filter((r) => r.ok).length;
	return new Response(JSON.stringify({ mode, matchId, tokenCount: tokens.length, okCount, results }, null, 2), {
		status: okCount > 0 ? 200 : 502,
		headers: { "Content-Type": "application/json" },
	});
}
