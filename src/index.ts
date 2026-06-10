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
import { detectEvents, nextState, parseMatch, toPayload, type ScoreboardEvent, type StoredState } from "./events";
import { tokensForEvent, type SupabaseConfig } from "./supabase";

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

	/** Shared secret guarding the manual /test-push route. */
	MANUAL_TRIGGER_SECRET: string;
}

// The sibling proxy's scoreboard route — shared edge cache, transparent ESPN bytes.
const PROXY_SCOREBOARD = "https://nwslapp-proxy.tiffany-rieth.workers.dev/scoreboard";
const MATCH_STATE_TTL = 21600; // 6h — auto-expires a match's KV entry after it ends.

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

	// HTTP entry point: health + the manual test-push trigger.
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		if (request.method === "GET" && url.pathname === "/") {
			return new Response(
				"nwslapp-match-watcher — cron live-event watcher (kickoff/goal/halftime/full-time). POST /test-push (x-trigger-secret) to send a synthetic push.",
				{ status: 200 },
			);
		}

		if (request.method === "POST" && url.pathname === "/test-push") {
			return handleTestPush(request, env);
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
		const res = await fetch(`${PROXY_SCOREBOARD}?dates=${year}0101-${year}1231&limit=500`, {
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
			const payload = toPayload(ev);
			const results = await Promise.all(tokens.map((t) => sendApns(t, payload, jwt!, apns)));
			const sent = results.filter((r) => r.ok).length;
			console.log(`[watcher] ${ev.type} "${ev.title}": ${sent}/${tokens.length} pushed`);
		}

		// Persist the new state while live; clean up once the match has ended (so a
		// later "post" tick is skipped by the no-prev guard above — no duplicate FT).
		if (match.state === "post") {
			await env.MATCH_STATE.delete(key);
		} else {
			await env.MATCH_STATE.put(key, JSON.stringify(nextState(prev, match, detected)), {
				expirationTtl: MATCH_STATE_TTL,
			});
		}
	}
}

/**
 * Manual trigger: send a synthetic push to one device token, so live delivery can
 * be verified on a real device before matches resume. Guarded by a shared secret.
 * Body: { token, title?, body?, eventID? }.
 */
async function handleTestPush(request: Request, env: Env): Promise<Response> {
	if (request.headers.get("x-trigger-secret") !== env.MANUAL_TRIGGER_SECRET) {
		return new Response("Forbidden.", { status: 403 });
	}

	let payload: { token?: string; title?: string; body?: string; eventID?: string };
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
	const result = await sendApns(
		payload.token,
		{
			aps: {
				alert: {
					title: payload.title ?? "GOAL — WAS 1–0 ORL",
					body: payload.body ?? "Washington Spirit scored",
				},
				sound: "default",
				"thread-id": eventID,
			},
			eventID,
		},
		jwt,
		apns,
	);

	return new Response(JSON.stringify(result, null, 2), {
		status: result.ok ? 200 : 502,
		headers: { "Content-Type": "application/json" },
	});
}
