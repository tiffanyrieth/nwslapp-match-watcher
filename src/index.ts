/**
 * nwslapp-match-watcher — NWSLApp's live-event push watcher (Tier 2 / server push).
 *
 * A scheduled (cron) Worker, separate from the request/response `nwslapp-proxy`
 * but reusing its cached ESPN data. Once a minute it:
 *   1. fetches the season scoreboard via the proxy (so it shares the edge cache,
 *      never hammering ESPN directly),
 *   2. for each LIVE match, diffs the score against the last-known state in KV,
 *   3. on a goal, looks up (service-role) the device tokens of users who follow
 *      either team and have goal alerts on, and
 *   4. sends an APNs push to each.
 *
 * Stage B scope is GOALS only; kickoff / halftime / full-time / subs are added as
 * more detection cases on this same pipeline in Stage C. A manual `POST /test-push`
 * route sends a synthetic push to one device so on-device delivery can be verified
 * during the NWSL World Cup break, before real matches resume.
 *
 * Cloudflare's cron floor is 1 minute; with the proxy's 30s live TTL, end-to-end
 * goal latency is ≈ up to 90s. Sub-minute polling (a Durable Object alarm) is a
 * scale-only future optimization, not this stage.
 */

import { apnsJwt, sendApns, type ApnsConfig } from "./apns";
import { detectGoals, goalPayload, parseLiveMatch, stateOf, type ScoreboardEvent } from "./goals";
import { tokensForGoal, type SupabaseConfig } from "./supabase";

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
				"nwslapp-match-watcher — cron goal watcher. POST /test-push (x-trigger-secret) to send a synthetic push.",
				{ status: 200 },
			);
		}

		if (request.method === "POST" && url.pathname === "/test-push") {
			return handleTestPush(request, env);
		}

		return new Response("Not found.", { status: 404 });
	},
} satisfies ExportedHandler<Env>;

/** One poll: scoreboard → per-live-match diff → goal pushes. */
async function runWatch(env: Env): Promise<void> {
	const year = new Date().getUTCFullYear();
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

	const liveMatches = events.map(parseLiveMatch).filter((m) => m !== null);
	if (liveMatches.length === 0) return; // nothing live — cheapest path, no KV/APNs.

	const sb = supabaseConfig(env);
	const apns = apnsConfig(env);
	let jwt: string | undefined; // signed lazily — only if a goal actually fires.

	for (const match of liveMatches) {
		const key = `match:${match.eventId}`;
		const prev = await env.MATCH_STATE.get<{ home: { id: string; score: number }; away: { id: string; score: number } }>(
			key,
			"json",
		);
		const goals = detectGoals(prev, match);

		// Persist the new baseline regardless of whether a goal fired.
		await env.MATCH_STATE.put(key, JSON.stringify(stateOf(match)), { expirationTtl: MATCH_STATE_TTL });

		for (const goal of goals) {
			let tokens: string[];
			try {
				tokens = await tokensForGoal(sb, goal.teamIds);
			} catch (err) {
				console.log(`[watcher] follower lookup failed for ${goal.eventId}: ${err}`);
				continue;
			}
			if (tokens.length === 0) continue;

			jwt ??= await apnsJwt(apns);
			const payload = goalPayload(goal);
			const results = await Promise.all(tokens.map((t) => sendApns(t, payload, jwt!, apns)));
			const sent = results.filter((r) => r.ok).length;
			console.log(
				`[watcher] goal ${goal.homeAbbr} ${goal.homeScore}-${goal.awayScore} ${goal.awayAbbr}: ${sent}/${tokens.length} pushed`,
			);
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
