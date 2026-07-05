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
import {
	confirmCorrection,
	correctionEvent,
	detectCorrectionCandidate,
	detectEvents,
	lineupsPublished,
	nextState,
	parseMatch,
	toPayload,
	type Match,
	type MatchEvent,
	type ScoreboardEvent,
	type StoredState,
} from "./events";
// NOTE: the /card PNG renderer (satori + resvg-wasm + fonts, ~3.4MB) is NO LONGER imported
// here. It lives in the sibling `nwslapp-card` worker (src/card-worker.ts + wrangler.card.jsonc)
// so its cold-start module-eval never touches this cron's per-tick CPU budget — the fix for the
// "Exceeded CPU Time Limits" errors. This worker only builds card URLs (CARD_PUBLIC_URL) and
// 302-redirects any /card request that lands here (late-delivered pushes carry the old origin).
import { activityTokensForMatch, allDeviceTokens, allStartTokens, pruneDeadTokens, startTokensForTeams, tokensForCompetitionEvent, tokensForEvent, type SupabaseConfig } from "./supabase";
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

	/** The sibling `nwslapp-card` worker's origin — V1 pushes attach its /thumb/{ABBR} crest tile
	 *  (public URL: the NSE downloads over the internet), and /card/* 302s there for late pushes. */
	CARD_PUBLIC_URL: string;

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
const PROXY_SUMMARY = "https://proxy/summary";

// The watcher only cares about matches in the LIVE WINDOW (kickoff-5min → kickoff+4h), so it fetches
// a 3-day scoreboard slice (yesterday→tomorrow, UTC — the ±1 days cover any ET/UTC date-boundary game)
// instead of the whole season. Parsing ~240 season events every minute was needless CPU that pushed
// live ticks past the free plan's per-invocation limit (Exceeded CPU blips during a live game,
// 2026-07-05). The app's schedule fetches the full season separately — this is watcher-only. ZERO
// user-facing change: same per-minute check, same live detection, same alerts — just a smaller payload.
function scoreboardWindow(): string {
	const d = (offsetDays: number): string => {
		const t = new Date(Date.now() + offsetDays * 86_400_000);
		return `${t.getUTCFullYear()}${String(t.getUTCMonth() + 1).padStart(2, "0")}${String(t.getUTCDate()).padStart(2, "0")}`;
	};
	return `${d(-1)}-${d(1)}`; // yesterday → tomorrow, UTC
}

// The women's national-team ESPN scoreboard slugs — the SAME set the app polls for the schedule
// (NationalTeamFeed.all in the app's Models/Competition.swift). Reached through the proxy's
// `/scoreboard?league=<slug>` (all allowlisted there), so no new route/auth. Most are seasonal
// (empty off-tournament) → the live-window gate means they create KV state only during real matches.
const NT_LEAGUES = [
	"fifa.friendly.w",
	"fifa.shebelieves",
	"concacaf.w.gold",
	"concacaf.womens.championship",
	"uefa.weuro",
	"fifa.wwc",
	"fifa.w.olympics",
] as const;

// A national-team match event → the two `competition_alert_preferences` follow keys to fan out to
// ("nt:USA", "nt:CAN"). The FIFA code is ESPN's competitor abbreviation, already on every MatchEvent.
const ntKeys = (ev: MatchEvent): string[] =>
	[ev.homeAbbr, ev.awayAbbr].filter((a) => a).map((a) => `nt:${a}`);
const MATCH_STATE_TTL = 21600; // 6h — auto-expires a match's KV entry after it ends.

// VAR correction debounce: a score decrease isn't fired immediately. We wait, then re-poll a FRESH
// scoreboard; only a persisting decrease fires (a reverted score was a transient ESPN glitch). 12s sits
// in the brief's ~10–15s window and well under the 60s cron, so a debouncing run never overlaps the next.
const CORRECTION_DEBOUNCE_MS = 12_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// "Lineups posted" push: start polling /summary this far before kickoff. ESPN posts the XI ~1h out;
// 75 min gives margin for an early publish. Cron is per-minute → detection fires within ≤60s of the post.
const LINEUP_LEAD_MS = 75 * 60 * 1000;

// V2 Live Activity timing.
const LA_START_LEAD_MS = 20 * 60 * 1000; // remote-start the Activity ≤20 min before kickoff — the token
// registration window (a device can take minutes to observe the Activity + upload its per-Activity token;
// ≤5 min bled past kickoff and missed early goals). Doubles as the pre-match "SOON" glance card.
const LA_RESYNC_MS = 10 * 60 * 1000; // clock-drift resync cadence (the widget's local timer ticks between)
const LA_DISMISS_AFTER_S = 15 * 60; // TEST-ONLY (/test-activity end): quick self-clean for test cards. The real cron omits dismissal-date → FT card lingers up to Apple's ~4h cap, user-dismissable.

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
				"nwslapp-match-watcher — cron live-event watcher (kickoff/goal/halftime/full-time). POST /test-push (x-trigger-secret) to send a synthetic push. GET /card/* 302-redirects to the nwslapp-card worker.",
				{ status: 200 },
			);
		}

		// The card renderer moved to the nwslapp-card worker. Any /card request here is a push
		// APNs stored and delivered late (its imageUrl carries this old origin) — 302 it onward so
		// the NSE (which follows redirects) still gets the PNG. Permanent, not a transition shim.
		if (request.method === "GET" && url.pathname.startsWith("/card/")) {
			return Response.redirect(`${env.CARD_PUBLIC_URL.replace(/\/$/, "")}${url.pathname}${url.search}`, 302);
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

/**
 * Re-read ONE match from a FRESH scoreboard (the debounce re-poll). The `_cb` param changes the proxy
 * cache key → guaranteed cache MISS → the proxy fetches ESPN fresh. Without this the re-poll would hit
 * the proxy's ~30s live cache and just re-read the same (possibly glitched) payload — making the
 * debounce a no-op. Returns null on fetch failure or if the event is no longer present.
 */
async function refetchMatch(env: Env, eventId: string): Promise<Match | null> {
	try {
		const url = `${PROXY_SCOREBOARD}?dates=${scoreboardWindow()}&limit=500&_cb=${Date.now()}`;
		const res = await env.PROXY.fetch(url, { headers: { Accept: "application/json" } });
		if (!res.ok) {
			console.log(`[watcher] correction re-poll failed: ${res.status}`);
			return null;
		}
		const evs = ((await res.json()) as { events?: ScoreboardEvent[] }).events ?? [];
		const found = evs.find((e) => e.id === eventId);
		return found ? parseMatch(found) : null;
	} catch (err) {
		console.log(`[watcher] correction re-poll threw: ${err}`);
		return null;
	}
}

/** One poll: scoreboard → per-match diff → event pushes. */
async function runWatch(env: Env): Promise<void> {
	const now = Date.now();
	let events: ScoreboardEvent[];
	try {
		const res = await env.PROXY.fetch(`${PROXY_SCOREBOARD}?dates=${scoreboardWindow()}&limit=500`, {
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

		// One V1 fan-out (follower lookup → APNs) — shared by normal events and the VAR correction.
		const fireV1 = async (ev: MatchEvent): Promise<void> => {
			let tokens: string[];
			try {
				tokens = await tokensForEvent(sb, ev.teamIds, ev.prefColumn);
			} catch (err) {
				console.log(`[watcher] follower lookup failed (${ev.type} ${ev.eventId}): ${err}`);
				return;
			}
			if (tokens.length === 0) return;

			jwt ??= await apnsJwt(apns);
			const payload = toPayload(ev, env.CARD_PUBLIC_URL);
			const results = await Promise.all(tokens.map((t) => sendApns(t, payload, jwt!, apns)));
			console.log(`[watcher] ${ev.type} "${ev.title}": ${results.filter((r) => r.ok).length}/${tokens.length} pushed`);
			await pruneDeadTokens(sb, "device_tokens", "token", results);
		};

		for (const ev of detected) await fireV1(ev);

		// VAR correction: a score decrease during an in-progress match. NOT fired immediately — first
		// debounce against a transient ESPN glitch (stale/cached payload, momentary zeros) by waiting,
		// then re-polling a FRESH scoreboard. Only a persisting decrease fires (brief items 2–3).
		let effectiveMatch = match; // the snapshot we persist + sync the Live Activity from
		let correctionFired = false;
		const candidate = detectCorrectionCandidate(prev, match);
		if (candidate) {
			console.log(
				`[watcher] correction candidate ${match.eventId}: ${candidate.prev.home}-${candidate.prev.away} → ${match.home.score}-${match.away.score}; debouncing ${CORRECTION_DEBOUNCE_MS}ms`,
			);
			await sleep(CORRECTION_DEBOUNCE_MS);
			const recheck = await refetchMatch(env, match.eventId);
			if (recheck) effectiveMatch = recheck; // freshest truth → baseline + LA from it, fired or not
			if (confirmCorrection(candidate, recheck)) {
				await fireV1(correctionEvent(candidate.prev, recheck!));
				correctionFired = true;
				console.log(`[watcher] correction ${match.eventId} CONFIRMED → ${recheck!.home.score}-${recheck!.away.score}`);
			} else {
				console.log(`[watcher] correction ${match.eventId} discarded — decrease did not persist (glitch)`);
			}
		}

		// Persist the new state while live; clean up once the match has ended (so a
		// later "post" tick is skipped by the no-prev guard above — no duplicate FT).
		// V2 Live Activity (ADDITIVE — the V1 push path above is untouched). Pushes the current
		// state to this match's running Activities on an event / correction / full-time / periodic resync.
		// Reconcile the monotonic widget-clock anchor BEFORE the LA sync so stoppage-time pushes
		// carry a stable clockStartEpoch (see StoredState.virtualKickoff).
		const newState = nextState(prev, effectiveMatch, detected, Math.floor(Date.now() / 1000));
		try {
			await syncLiveActivity(env, sb, apns, effectiveMatch, detected.length > 0 || correctionFired, newState.virtualKickoff);
		} catch (err) {
			console.log(`[watcher] LA sync failed (${match.eventId}): ${err}`);
		}

		if (effectiveMatch.state === "post") {
			await env.MATCH_STATE.delete(key);
		} else {
			await env.MATCH_STATE.put(key, JSON.stringify(newState), {
				expirationTtl: MATCH_STATE_TTL,
			});
		}
	}

	// NATIONAL-TEAM pass: the same event detection (kickoff/goal/HT/FT), but fanned out by FIFA code to
	// `competition_alert_preferences` instead of the club table. V1 push only — NT Live Activities (V2)
	// and the VAR-correction debounce are deferred (kept the club-only path). Feeds share the proxy edge
	// cache; the live-window gate means an off-tournament feed does zero KV work. Reuses `jwt`/`sb`/`apns`.
	for (const slug of NT_LEAGUES) {
		let ntEvents: ScoreboardEvent[];
		try {
			const res = await env.PROXY.fetch(`${PROXY_SCOREBOARD}?league=${slug}&dates=${scoreboardWindow()}&limit=500`, {
				headers: { Accept: "application/json" },
			});
			if (!res.ok) continue;
			ntEvents = ((await res.json()) as { events?: ScoreboardEvent[] }).events ?? [];
		} catch (err) {
			console.log(`[watcher] NT scoreboard ${slug} failed: ${err}`);
			continue;
		}
		for (const event of ntEvents) {
			const ko = kickoffMs(event);
			if (ko === null || now - ko > WINDOW_PAST_MS || ko - now > WINDOW_FUTURE_MS) continue;
			const match = parseMatch(event);
			if (!match) continue;
			const key = `match:${match.eventId}`;
			const prev = await env.MATCH_STATE.get<StoredState>(key, "json");
			if (match.state === "post" && !prev) continue;

			const detected = detectEvents(prev, match);
			for (const ev of detected) {
				let tokens: string[];
				try {
					tokens = await tokensForCompetitionEvent(sb, ntKeys(ev), ev.prefColumn);
				} catch (err) {
					console.log(`[watcher] NT follower lookup failed (${ev.type} ${ev.eventId}): ${err}`);
					continue;
				}
				if (tokens.length === 0) continue;
				jwt ??= await apnsJwt(apns);
				const payload = toPayload(ev, env.CARD_PUBLIC_URL);
				const results = await Promise.all(tokens.map((t) => sendApns(t, payload, jwt!, apns)));
				console.log(`[watcher] NT ${ev.type} "${ev.title}": ${results.filter((r) => r.ok).length}/${tokens.length} pushed`);
				await pruneDeadTokens(sb, "device_tokens", "token", results);
			}

			if (match.state === "post") await env.MATCH_STATE.delete(key);
			else await env.MATCH_STATE.put(key, JSON.stringify(nextState(prev, match, detected)), { expirationTtl: MATCH_STATE_TTL });
		}
	}

	// SEPARATE pass (not tangled into detectEvents): remote-start a Live Activity for any match
	// kicking off within the next ~5 min that a signed-in user has alerts ON for. KV-deduped.
	try {
		await startUpcomingActivities(env, events, sb, apns);
	} catch (err) {
		console.log(`[watcher] LA start pass failed: ${err}`);
	}

	// SEPARATE pass: poll /summary for matches in the pre-kickoff window and push "Lineups in" once
	// both starting XIs are posted. KV-deduped; isolated so a /summary hiccup can't break score alerts.
	try {
		await checkUpcomingLineups(env, events, sb, apns);
	} catch (err) {
		console.log(`[watcher] lineup pass failed: ${err}`);
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
	virtualKickoff?: number,
): Promise<void> {
	const ended = match.state === "post";
	const rsKey = `la-rs:${match.eventId}`;
	const seenKey = `la-seen:${match.eventId}`;

	const tokens = await activityTokensForMatch(sb, match.eventId);
	if (tokens.length === 0) return;
	const jwt = await apnsJwt(apns);
	const state: LiveContentState = contentStateFromMatch(match, virtualKickoff);

	if (ended) {
		// No dismissal-date → system default: the FT card lingers on the lock screen up to Apple's
		// ~4h cap (dates further out are ignored), dismissable by the user anytime (owner request,
		// 2026-07-05). The 15-min quick dismiss lives on only in /test-activity (test cards self-clean).
		const endResults = await Promise.all(tokens.map((t) => endLiveActivity(t, state, jwt, apns)));
		await pruneDeadTokens(sb, "live_activities", "push_token", endResults);
		await env.MATCH_STATE.delete(rsKey);
		await env.MATCH_STATE.delete(seenKey);
		console.log(`[watcher] LA end ${match.eventId}: ${tokens.length} activities`);
		return;
	}

	// Per-Activity tokens seen for the FIRST time — a phone that registered its token late (iOS can take
	// minutes to wake the app after push-to-start). Those MUST get the current state now, even on a quiet
	// throttled poll, or they sit on the stale pre-match card until the next event (the "brother missed
	// the early updates" gap).
	const seenJson = await env.MATCH_STATE.get(seenKey);
	const seen = new Set<string>(seenJson ? (JSON.parse(seenJson) as string[]) : []);
	const fresh = tokens.filter((t) => !seen.has(t));

	// Full resync on an event or once the drift cadence elapses; between those the widget's local clock ticks.
	let resyncAll = hadEvent;
	if (!resyncAll) {
		const last = await env.MATCH_STATE.get(rsKey);
		resyncAll = !last || Date.now() - Number(last) >= LA_RESYNC_MS;
	}

	// Push to the full set (resync) OR — on a quiet poll — just the freshly-registered tokens (catch-up).
	const targets = resyncAll ? tokens : fresh;
	if (targets.length > 0) {
		const updateResults = await Promise.all(targets.map((t) => updateLiveActivity(t, state, jwt, apns)));
		await pruneDeadTokens(sb, "live_activities", "push_token", updateResults);
		if (resyncAll) await env.MATCH_STATE.put(rsKey, String(Date.now()), { expirationTtl: MATCH_STATE_TTL });
		if (fresh.length > 0) console.log(`[watcher] LA catch-up ${match.eventId}: ${fresh.length} new`);
	}
	if (fresh.length > 0) await env.MATCH_STATE.put(seenKey, JSON.stringify(tokens), { expirationTtl: MATCH_STATE_TTL });
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
		// QUIET BANNER (device-proven 7/4): the start push MUST carry an `alert` or iOS silently never
		// renders the card (APNs 200s regardless — the old no-alert "silent" design shipped invisible
		// Activities). `sound: ""` keeps it buzz-free: card + banner appear with NO sound/vibration, so
		// V1's kickoff push at minute 0 remains the single audible interrupt. All three axes A/B'd on
		// device 2026-07-04: no alert → never renders; alert w/o sound key → renders but BUZZES;
		// alert + sound:"" → renders, no buzz.
		const startAlert = {
			title: `${info.homeAbbr} vs ${info.awayAbbr}`,
			body: "Live match card is on your lock screen.",
			sound: "",
		};
		const results = await Promise.all(tokens.map((t) => startLiveActivity(t, attrs, state, jwt, apns, undefined, startAlert)));
		const ok = results.filter((r) => r.ok).length;
		console.log(`[watcher] LA start ${info.homeAbbr} vs ${info.awayAbbr}: ${ok}/${tokens.length}`);
		await pruneDeadTokens(sb, "live_activity_start_tokens", "token", results);
		await env.MATCH_STATE.put(startedKey, String(now), { expirationTtl: MATCH_STATE_TTL });
	}
}

/** SEPARATE pre-kickoff trigger (NOT detectEvents — lineups aren't on the scoreboard): for matches in
 *  the pre-kickoff window, poll the per-match `/summary` and, the tick BOTH starting XIs are posted, push
 *  a one-shot "Lineups in" alert to everyone with `lineup_posted` on for a participating team. KV-deduped.
 *  `/summary` is fetched CACHE-BUSTED so detection sees ESPN's live state each tick (independent of the
 *  proxy's pre-kickoff TTL), firing within ≤60s of the post. NWSL only for now (NT feeds would multiply
 *  the per-minute /summary fetches). */
async function checkUpcomingLineups(
	env: Env,
	events: ScoreboardEvent[],
	sb: SupabaseConfig,
	apns: ApnsConfig,
): Promise<void> {
	const now = Date.now();
	for (const event of events) {
		const ko = kickoffMs(event);
		if (ko === null || ko < now || ko - now > LINEUP_LEAD_MS) continue;
		const info = upcomingInfo(event);
		if (!info) continue;
		const key = `lineup:${info.matchId}`;
		if (await env.MATCH_STATE.get(key)) continue; // already fired

		// Cache-busted so we see ESPN's live state, not a cached pre-lineup shell.
		let summary: unknown;
		try {
			const res = await env.PROXY.fetch(`${PROXY_SUMMARY}?event=${info.matchId}&_lc=${now}`, {
				headers: { Accept: "application/json" },
			});
			if (!res.ok) continue;
			summary = await res.json();
		} catch (err) {
			console.log(`[watcher] lineup summary fetch failed (${info.matchId}): ${err}`);
			continue;
		}
		if (!lineupsPublished(summary as Parameters<typeof lineupsPublished>[0])) continue; // not posted yet — retry next tick

		const lineupEvent: MatchEvent = {
			type: "lineup",
			eventId: info.matchId,
			teamIds: [info.homeId, info.awayId],
			prefColumn: "lineup_posted",
			title: `Lineups in — ${info.homeAbbr} vs ${info.awayAbbr}`,
			subtitle: "Starting XIs are posted",
			homeAbbr: info.homeAbbr,
			awayAbbr: info.awayAbbr,
			homeScore: 0,
			awayScore: 0,
		};

		let tokens: string[];
		try {
			tokens = await tokensForEvent(sb, [info.homeId, info.awayId], "lineup_posted");
		} catch (err) {
			console.log(`[watcher] lineup follower lookup failed (${info.matchId}): ${err}`);
			continue; // don't mark KV — retry next tick so a transient lookup failure doesn't drop the alert
		}
		if (tokens.length > 0) {
			const jwt = await apnsJwt(apns);
			const payload = toPayload(lineupEvent, env.CARD_PUBLIC_URL);
			const results = await Promise.all(tokens.map((t) => sendApns(t, payload, jwt, apns)));
			console.log(`[watcher] lineup ${info.homeAbbr} vs ${info.awayAbbr}: ${results.filter((r) => r.ok).length}/${tokens.length} pushed`);
			await pruneDeadTokens(sb, "device_tokens", "token", results);
		} else {
			console.log(`[watcher] lineup ${info.homeAbbr} vs ${info.awayAbbr}: published, 0 opt-ins`);
		}
		// Published ⇒ mark fired (the "lineups are in" moment is one-shot), even at 0 opt-ins, so we stop
		// re-polling /summary every minute for the rest of the window.
		await env.MATCH_STATE.put(key, String(now), { expirationTtl: MATCH_STATE_TTL });
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
	const apns = apnsConfig(env);
	const jwt = await apnsJwt(apns);
	const eventID = payload.eventID ?? "401853925";
	const event = payload.event ?? "goal";
	// Default to the redesign's shape: square crest attachment (2026-07-05 — no more wide-card
	// attachments; a square crest IS a clean collapsed thumbnail).
	const imageUrl = payload.imageUrl ?? `${env.CARD_PUBLIC_URL.replace(/\/$/, "")}/thumb/WAS?s=3`;

	// Title + subtitle only (the redesign's two-line contract); body honored if a caller passes one.
	const alert: Record<string, string> = { title: payload.title ?? "GOAL — Washington Spirit" };
	alert.subtitle = payload.subtitle ?? "WAS 1–0 ORL · T. Rieth 67'";
	if (payload.body) alert.body = payload.body;

	const aps = {
		aps: {
			alert,
			"mutable-content": 1,
			sound: "default",
			"thread-id": `match-${eventID}`, // same eventID across goal + correction → they stack
			"interruption-level": event === "halftime" || event === "lineup" ? "active" : "time-sensitive",
		},
		eventID,
		matchId: eventID,
		event,
		imageUrl,
	};

	// `token` present → that one device (back-compat). Omitted → fan out to ALL registered V1 device
	// tokens (the replay/correction test, mirroring /test-activity). Service-role read stays server-side.
	let tokens: string[];
	try {
		tokens = payload.token ? [payload.token] : await allDeviceTokens(supabaseConfig(env));
	} catch (err) {
		return new Response(JSON.stringify({ error: `token resolution failed: ${String(err)}` }, null, 2), {
			status: 502,
			headers: { "Content-Type": "application/json" },
		});
	}
	if (tokens.length === 0) {
		return new Response(JSON.stringify({ tokenCount: 0, okCount: 0, results: [], note: "No registered device tokens." }, null, 2), {
			status: 502,
			headers: { "Content-Type": "application/json" },
		});
	}

	const results = await Promise.all(tokens.map((t) => sendApns(t, aps, jwt, apns)));
	const okCount = results.filter((r) => r.ok).length;
	return new Response(JSON.stringify({ event, tokenCount: tokens.length, okCount, results }, null, 2), {
		status: okCount > 0 ? 200 : 502,
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
		/** DIAGNOSTIC: `alert: true` (or {title,body,sound?}) adds an alert to a START push. Proven
		 *  7/4: no alert → iOS never renders. `sound: ""` A/Bs a buzz-free banner. Test-only. */
		alert?: boolean | { title: string; body: string; sound?: string };
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

	// Diagnostic alert (see the `alert` field doc above), applied to ANY mode — start renders the
	// card (REQUIRED there), update/end A/B the "V2 buzzes on status changes" capability. `true` → a
	// generic pair.
	const testAlert =
		p.alert === true
			? { title: `${p.h ?? "ORL"} vs ${p.a ?? "POR"}`, body: "Match card is live on your lock screen." }
			: p.alert && typeof p.alert === "object"
				? p.alert
				: undefined;

	const send = (token: string) => {
		if (mode === "start") {
			const attrs = attributesFor(matchId, p.h ?? "ORL", p.a ?? "POR", p.comp ?? "NWSL");
			return startLiveActivity(token, attrs, state, jwt, apns, undefined, testAlert);
		}
		if (mode === "end") return endLiveActivity(token, state, jwt, apns, nowSec + LA_DISMISS_AFTER_S, testAlert);
		return updateLiveActivity(token, state, jwt, apns, { alert: testAlert });
	};
	const results = await Promise.all(tokens.map(send));
	const okCount = results.filter((r) => r.ok).length;
	return new Response(JSON.stringify({ mode, matchId, tokenCount: tokens.length, okCount, results }, null, 2), {
		status: okCount > 0 ? 200 : 502,
		headers: { "Content-Type": "application/json" },
	});
}
