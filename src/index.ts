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
	sameStoredState,
	summaryGoalScore,
	toPayload,
	toPredictResultPayload,
	type Match,
	type MatchEvent,
	type ScoreboardDetail,
	type ScoreboardEvent,
	type StoredState,
} from "./events";
// NOTE: the /card PNG renderer (satori + resvg-wasm + fonts, ~3.4MB) is NO LONGER imported
// here. It lives in the sibling `nwslapp-card` worker (src/card-worker.ts + wrangler.card.jsonc)
// so its cold-start module-eval never touches this cron's per-tick CPU budget — the fix for the
// "Exceeded CPU Time Limits" errors. This worker only builds card URLs (CARD_PUBLIC_URL) and
// 302-redirects any /card request that lands here (late-delivered pushes carry the old origin).
import { activityTokensForMatch, allDeviceTokens, allStartTokens, markPredictResultNotified, predictResultRecipients, resolveTokensBatch, resolveTokensForEvent, startTokensByCompetitionKey, startTokensForTeams, tokensForCompetitionEvent, tokensForEvent, type SupabaseConfig } from "./supabase";
import { activeFeeds, buildIndex, CLUB_FEEDS, clubEventLabel, DISCOVERY_INTERVAL_MS, discoveryDue, FEED_LABEL, kickoffMs, liveMissedByIndex, NWSL_FEED, reconcileFeed, type FixtureIndex } from "./fixtures";
import { buildStartAps, endLiveActivity, liveTopic, startLiveActivity, updateLiveActivity, type LiveContentState, type LivePhase } from "./activitykit";
import { attributesFor, contentStateFromMatch, preContentState, upcomingInfo } from "./livestate";
import { buildMessages, collapseIdFor, enqueueFanout, type FanoutMessage } from "./fanout";
import { drainMessage } from "./drain";
import { broadcastEnd, broadcastUpdate, createChannel, createChannelSigned, deleteChannel, listChannels } from "./broadcast";
import { DurableObject } from "cloudflare:workers";
import { isStaleScheduledTick, nextMinuteBoundary, scheduledTimeMs, shouldRearm } from "./metronome";

export interface Env {
	/** The tick metronome (2026-09-12): ONE Durable Object whose alarm drives the per-minute tick. The
	 *  `* * * * *` cron only re-arms it. See src/metronome.ts for the why (CF cron-dispatch stalls). */
	TICK_METRONOME: DurableObjectNamespace<TickMetronome>;

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

	/** Push fan-out queue (producer). The cron enqueues chunked follower tokens; the consumer (queue()
	 *  handler) drains one message per invocation with its own fresh subrequest budget. */
	PUSH_QUEUE: Queue<FanoutMessage>;

	/** Shared secret guarding the manual /test-push route. */
	MANUAL_TRIGGER_SECRET: string;

	/** The proxy's KHG publish key — held so the Monday publish pass can POST /knowher/publish-verified
	 *  (2026-08-12 split). Optional: while unset, the Monday pass is a no-op (not armed). Set at the
	 *  supervised-first-run gate, AFTER the first run is proven by hand. */
	KNOWHER_INGEST_KEY?: string;
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
	// Confederation championships + WC/Olympic qualifying — so a followed NT's COMPETITIVE fixtures
	// alert too, not just friendlies (kept in sync with the proxy allowlist + app NationalTeamFeed.all).
	// Each is one more per-tick scoreboard subrequest, but all are seasonal (empty off-tournament → the
	// live-window gate does zero KV/APNs work), and 15 feeds stays well under the 50-subrequest cap.
	"uefa.w.nations",
	"fifa.wworldq.uefa",
	"afc.w.asian.cup",
	"caf.w.nations",
	"conmebol.america.femenina",
	"fifa.wwcq.ply",
	"fifa.w.concacaf.olympicsq",
	"global.pinatar_cup",
	"global.w.finalissima", // Euro champ vs Copa América champ — one seasonal match (added 2026-08-06)
] as const;

// A national-team match event → the two `competition_alert_preferences` follow keys to fan out to
// ("nt:USA", "nt:CAN"). The FIFA code is ESPN's competitor abbreviation, already on every MatchEvent.
const ntKeys = (ev: MatchEvent): string[] =>
	[ev.homeAbbr, ev.awayAbbr].filter((a) => a).map((a) => `nt:${a}`);
const MATCH_STATE_TTL = 21600; // 6h — auto-expires a match's KV entry after it ends.

// ALL national teams get V2 Live Activities (2026-08-06; was USWNT-only — that gate existed for
// per-match-channel economics, which the stress test then CLEARED: docs/stress-testing.md §6/§7
// all-NT entry). Channels stay nearly free (one channel + flat broadcasts/match at any audience
// size); the guarded axis is the KICKOFF CLUSTER — see NT_STARTS_PER_TICK + the batched lookup.
/** Max NT Live-Activity starts processed per tick (stress-doc stagger lever): a FIFA-window
 *  kickoff cluster rolls its overflow to the NEXT tick (no marker set → retried), which the
 *  20-min start lead absorbs invisibly. Bounds channel-create externals per invocation. */
const NT_STARTS_PER_TICK = 8;

// Fan-out early-warning threshold. Cloudflare's free plan caps a single cron invocation at 50 external
// subrequests; each APNs push is one, plus ~8+ feed fetches per tick — so a single event with more than
// ~40 follower tokens starts dropping the overflow (see docs/push-fanout-scaling.md in the app repo). We
// can't FIX that here (it needs the Queues / Broadcast-Channels redesign) but we log LOUD when we cross the
// line, turning a silent per-tick cap failure into a visible signal that it's time to build that fan-out.
const FANOUT_BUDGET = 40;

// VAR correction debounce: a score decrease isn't fired immediately. We wait, then re-poll a FRESH
// scoreboard; only a persisting decrease fires (a reverted score was a transient ESPN glitch). 12s sits
// in the brief's ~10–15s window and well under the 60s cron, so a debouncing run never overlaps the next.
const CORRECTION_DEBOUNCE_MS = 12_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Run `fn` over `items` with at most `limit` promises in flight — bounded concurrency, results in
 *  input order. The live-match loop uses this so a full slate's per-match I/O (KV read + /summary
 *  cross-check + Live Activity broadcast) runs IN PARALLEL: the tick's wall time is then ~the slowest
 *  single match, not the SUM over matches. That's what keeps a 6–7 game slate under Cloudflare's ~30s
 *  per-invocation ceiling — the old sequential `for…await` grew linearly with the live-match count and
 *  was tipping live ticks into `exceededCpu` kills on multi-game days. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (next < items.length) {
			const i = next++;
			results[i] = await fn(items[i]);
		}
	});
	await Promise.all(runners);
	return results;
}

// Live-match loop concurrency. A full NWSL slate is 6–7 simultaneous matches; 8 covers it with margin,
// and each match's subrequests are INTERNAL (service binding to the proxy + APNs), so parallelism here is
// cheap and nowhere near the subrequest budget. Follower lookups stay batched after the loop (flushClubV1).
const MATCH_CONCURRENCY = 8;

// Second-poll timing budget (see the `scheduled` double-poll). A live tick must finish under Cloudflare's
// ~30s per-invocation ceiling; the in-tick gap before the 2nd poll is CLAMPED (not a fixed 30s sleep) so
// poll1 + gap + poll2 stays under TICK_BUDGET_MS no matter how long poll1 took.
const TICK_BUDGET_MS = 26_000; // whole-tick ceiling we hold ourselves to, safely under the ~30s platform limit
const SECOND_POLL_GAP_MS = 20_000; // normal-case gap before the 2nd poll (was a fixed 30_000 sleep)
const SECOND_POLL_RESERVE_MS = 4_000; // headroom reserved for poll 2 + the daily/KHG/heartbeat passes

// Heartbeat ping bound (2026-09-12 audit): the healthchecks.io ping was a bare `await fetch(hc)` with no
// timeout — the tick's only unbounded external await. A hung ping must never extend a tick; abort at 5s.
const HEARTBEAT_TIMEOUT_MS = 5_000;

// "Lineups posted" push: start polling /summary this far before kickoff. ESPN posts the XI ~1h out;
// 75 min gives margin for an early publish. Cron is per-minute → detection fires within ≤60s of the post.
const LINEUP_LEAD_MS = 75 * 60 * 1000;

// The post-match "your Predict result is in" pass runs as an HOURLY LOCAL-MORNING WAVE: each UTC hour it
// pushes fans whose device timezone puts them at ~10am local now (NWSL is worldwide — a fixed UTC hour is
// midnight for someone). Devices with no stored tz fall back to 14:00 UTC (the old behaviour), so rollout
// is deploy-order-safe. NOT its own cron (account is at the Workers-free 5-cron cap): it rides the
// per-minute tick, gated to one run per UTC hour by a KV hour-marker. Target hour + fallback live in
// `qualifiesForLocalMorning` (./supabase). See `maybeRunPredictResultsPass`.

// The MONDAY Know Her Game publish (2026-08-12 weekend/Monday split). The weekend verify gate stages a
// HUMAN-ONLY pool; this pass calls the proxy's /knowher/publish-verified, which injects FRESH ESPN stats
// (so Sunday-night games count) + Lever 1, and publishes. Fires on UTC MONDAY at this hour — 10:00 UTC
// (= 3am PDT / 6am EDT): after Sunday-night finals settle, and comfortably before the earliest user's
// on-device Monday-10am-LOCAL nudge (10am ET = 14:00/15:00 UTC). Like the Predict pass it rides the
// per-minute tick (5-cron-free cap), gated by a once-per-week KV marker. No-op if KNOWHER_INGEST_KEY unset.
const KNOWHER_PUBLISH_HOUR_UTC = 10;
const KNOWHER_PUBLISH_WEEKDAY_UTC = 1; // getUTCDay(): Sun=0, Mon=1

// V2 Live Activity timing.
const LA_START_LEAD_MS = 20 * 60 * 1000; // remote-start the Activity ≤20 min before kickoff — the token
// registration window (a device can take minutes to observe the Activity + upload its per-Activity token;
// ≤5 min bled past kickoff and missed early goals). Doubles as the pre-match "SOON" glance card.
const LA_RESYNC_MS = 10 * 60 * 1000; // clock-drift resync FLOOR (the widget's local timer ticks between)
// Also resync the moment the widget's anchor (clockStartEpoch) jumps ≥ this many seconds — ESPN flips
// each half "live" several minutes LATE with the clock reset, so the anchor lurches at every kickoff /
// second-half restart (and on mid-game ESPN corrections). Without this the card sat visibly behind for
// up to the 10-min floor at the start of BOTH halves (owner-observed 2026-07-11). During smooth play the
// anchor is stable → zero drift → no extra pushes; it only fires exactly when the card would be wrong.
const LA_DRIFT_RESYNC_SEC = 30;
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

// TEST-ONLY: route a single test call to the SANDBOX APNs host (for a USB/Xcode debug build, whose token
// is a sandbox token the production host 400s). Swaps ONLY this call's host — never the global config —
// so it can't prune real prod tokens or flip the cron. broadcast.ts's manageHostPort keys off the host,
// so a sandbox cfg also targets the sandbox channel-management host automatically.
function testApnsConfig(env: Env, sandbox: boolean): ApnsConfig {
	const cfg = apnsConfig(env);
	return sandbox ? { ...cfg, host: "api.sandbox.push.apple.com" } : cfg;
}

/** Producer: chunk an event's follower tokens into fan-out messages and enqueue (V1 alert — club, NT,
 *  and lineup all share this shape; they only differ in how the tokens were looked up). A binding call
 *  on the internal budget, so it never touches the 50-external APNs cap. Delivery + prune happen in the
 *  queue consumer. Carries a deterministic apns-collapse-id so an at-least-once redelivery de-dupes. */
async function enqueueV1(env: Env, ev: MatchEvent, tokens: string[]): Promise<number> {
	if (tokens.length === 0) return 0;
	const messages = buildMessages(
		{
			kind: "v1",
			payload: toPayload(ev, env.CARD_PUBLIC_URL),
			apnsTopic: env.APNS_BUNDLE_ID,
			apnsPushType: "alert",
			collapseId: collapseIdFor(ev),
			pruneTable: "device_tokens",
			pruneColumn: "token",
			label: `${ev.type} "${ev.title}"`,
		},
		tokens,
	);
	await enqueueFanout(env.PUSH_QUEUE, messages);
	console.log(`[watcher] enqueued ${ev.type} "${ev.title}": ${tokens.length} token(s) → ${messages.length} msg(s)`);
	return messages.length;
}

/** Flush the tick's collected club V1 events with ONE batched follower lookup (3 REST per distinct pref
 *  column) instead of 3 REST per event — the fix for the 50-external subrequest breach on an 8-match
 *  Decision-Day kickoff/HT cluster (docs/stress-testing.md §7). Falls back to per-event lookups if the
 *  batch query throws, so a transient Supabase blip degrades gracefully instead of dropping a whole
 *  cluster's pushes. Enqueue only (no APNs here) → never touches the subrequest cap regardless of audience. */
async function flushClubV1(env: Env, sb: SupabaseConfig, pending: MatchEvent[]): Promise<void> {
	if (pending.length === 0) return;
	const tag = (ev: MatchEvent) => `${ev.eventId}:${ev.type}`;
	let tokenMap: Map<string, string[]>;
	try {
		tokenMap = await resolveTokensBatch(sb, pending.map((ev) => ({ id: tag(ev), teamIds: ev.teamIds, prefColumn: ev.prefColumn })));
	} catch (err) {
		console.log(`[watcher] batched follower lookup failed — per-event fallback: ${err}`);
		tokenMap = new Map();
		for (const ev of pending) {
			try {
				tokenMap.set(tag(ev), await tokensForEvent(sb, ev.teamIds, ev.prefColumn));
			} catch (e) {
				console.log(`[watcher] per-event fallback failed (${ev.type} ${ev.eventId}): ${e}`);
			}
		}
	}
	for (const ev of pending) await enqueueV1(env, ev, tokenMap.get(tag(ev)) ?? []);
}

/** Producer: chunk push-to-start tokens into fan-out messages and enqueue. The start push is the ONE
 *  per-device Live Activity send per match; on iOS 18 its `input-push-channel` auto-subscribes the
 *  created Activity to the match's broadcast channel, so every later update is a single broadcast (no
 *  per-device fan-out). No collapse-id (a start isn't a match event). */
async function enqueueLaStart(
	env: Env,
	apns: ApnsConfig,
	attrs: ReturnType<typeof attributesFor>,
	state: LiveContentState,
	alert: { title: string; body: string; sound?: string },
	tokens: string[],
	inputPushChannel?: string,
): Promise<void> {
	if (tokens.length === 0) return;
	const messages = buildMessages(
		{
			kind: "la-start",
			// buildStartAps returns the CONTENTS of `aps`; the wire needs `{ aps: {…} }`. The inline
			// startLiveActivity path (postLiveActivity) and V1's toPayload both wrap it — the 7/9 Queues
			// redesign moved la-start onto the queue and dropped the wrapper, so every queued start went
			// out with NO `aps` envelope → APNs 200s (`1 sent`) but iOS silently drops the malformed
			// Live Activity push. THE root cause of the 7/10 organic no-shows (device-diagnosed 7/11).
			payload: { aps: buildStartAps(attrs, state, undefined, alert, inputPushChannel) },
			apnsTopic: liveTopic(apns),
			apnsPushType: "liveactivity",
			pruneTable: "live_activity_start_tokens",
			pruneColumn: "token",
			label: `LA start ${attrs.homeAbbr} vs ${attrs.awayAbbr}`,
		},
		tokens,
	);
	await enqueueFanout(env.PUSH_QUEUE, messages);
	console.log(`[watcher] enqueued LA start ${attrs.homeAbbr} vs ${attrs.awayAbbr}: ${tokens.length} → ${messages.length} msg(s)`);
}

// V2 broadcast channel KV keys. `la-chan:{matchId}` → the match's Apple channel id (one per match, created
// pre-kickoff, deleted at full time). `la-chan-sweep` → last orphan-sweep timestamp.
const channelKey = (matchId: string): string => `la-chan:${matchId}`;
const CHANNEL_SWEEP_KEY = "la-chan-sweep";
const CHANNEL_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Create-once the broadcast channel for a match (KV-deduped) and return its id. Returns undefined if
 *  creation fails — the LA start still fires WITHOUT a channel (graceful: those Activities just won't get
 *  broadcast updates; logged LOUD so it's never a silent gap). iOS 18 devices put the returned id in the
 *  start payload's `input-push-channel` to auto-subscribe. */
async function ensureMatchChannel(env: Env, apns: ApnsConfig, matchId: string): Promise<string | undefined> {
	const key = channelKey(matchId);
	const existing = await env.MATCH_STATE.get(key);
	if (existing) return existing;
	const result = await createChannelSigned(apns);
	if (!result.ok || !result.channelId) {
		console.log(`[watcher] channel create FAILED (${matchId}): ${result.status} ${result.reason ?? ""} — LA start will fire channel-less`);
		return undefined;
	}
	await env.MATCH_STATE.put(key, result.channelId, { expirationTtl: MATCH_STATE_TTL });
	console.log(`[watcher] channel created ${matchId}: ${result.channelId}`);
	return result.channelId;
}

/** Delete broadcast channels Apple still holds that no live `la-chan:` key references — orphans from a
 *  cron crash between createChannel and the KV write (harmless at ~7/day vs the 10k cap, but shouldn't
 *  silently accumulate). Throttled to ~once/6h via a KV timestamp. All calls route through the manage-host
 *  transport, so if that port is blocked this degrades to a no-op (list returns []). */
async function sweepOrphanChannels(env: Env, apns: ApnsConfig): Promise<void> {
	const last = await env.MATCH_STATE.get(CHANNEL_SWEEP_KEY);
	if (last && Date.now() - Number(last) < CHANNEL_SWEEP_INTERVAL_MS) return;
	await env.MATCH_STATE.put(CHANNEL_SWEEP_KEY, String(Date.now()), { expirationTtl: 7 * 24 * 3600 });
	const jwt = await apnsJwt(apns);
	const channels = await listChannels(apns, jwt);
	if (channels.length === 0) return;
	const live = new Set<string>();
	const list = await env.MATCH_STATE.list({ prefix: "la-chan:" });
	for (const k of list.keys) {
		const id = await env.MATCH_STATE.get(k.name);
		if (id) live.add(id);
	}
	let deleted = 0;
	for (const id of channels) {
		if (!live.has(id) && (await deleteChannel(apns, jwt, id))) deleted++;
	}
	if (deleted > 0) console.log(`[watcher] orphan channel sweep: deleted ${deleted} of ${channels.length}`);
}

/**
 * THE TICK — one full watcher cycle. Extracted VERBATIM (2026-09-12) from the old inline `scheduled()` body so
 * the identical code runs regardless of what triggers it: the TickMetronome alarm (the tick source), or the
 * manual `POST /tick` lever. The cron no longer runs it (see `scheduled` below). Behaviour inside is unchanged.
 *
 * Cloudflare's cron floor is 1 minute, but a live match wants ~30s reactions (goal/HT/FT latency), so we
 * DOUBLE-POLL inside the one invocation: poll once, and IF a match is live/near-kickoff, wait and poll again
 * with a cache-bust (the proxy live TTL is 30s, so an un-busted re-poll would re-read the same cached
 * scoreboard). Gated on the live window, so the 23h/day with no match cost zero extra wall-time / ESPN hits.
 * KV fire-once state chains the two polls naturally (poll 1 sees 0–0, poll 2 sees 1–0 → fires once).
 */
async function runTick(env: Env): Promise<void> {
	const tickStart = Date.now();
	const live = await runWatch(env); // first poll — rides the shared 30s edge cache
	if (live) {
		// Second poll → ~sub-minute goal/HT/FT latency without a sub-minute trigger. The in-tick gap is
		// BUDGETED, not a fixed 30s sleep: a live tick must finish well under Cloudflare's ~30s per-invocation
		// ceiling, and a fixed 30s left ~zero headroom, so live ticks were tipping into exceededCpu kills on
		// multi-game days. Clamp the gap so poll1 + gap + poll2 stays under TICK_BUDGET_MS regardless of how
		// long poll1 ran, capped at SECOND_POLL_GAP_MS for the normal fast case (the match loop is concurrent,
		// so poll1 is fast and flat in the match count — see runWatch / mapLimit).
		const gap = Math.min(SECOND_POLL_GAP_MS, TICK_BUDGET_MS - (Date.now() - tickStart) - SECOND_POLL_RESERVE_MS);
		if (gap > 0) await sleep(gap);
		await runWatch(env, true); // second poll — cache-busted for a fresh ESPN read
	}
	// The once-daily Predict-results pass (Change 8) rides THIS per-minute tick (the account is at the
	// Workers-free 5-cron cap, so it can't have its own cron). Self-gates via a once-per-hour KV marker.
	await maybeRunPredictResultsPass(env);
	// The Monday KHG publish (2026-08-12 split) rides this tick too — self-gates to Monday ~10:00 UTC via a
	// once-per-week KV marker, a no-op time check on every other tick.
	await maybeRunKnowHerPublishPass(env);
	// Dead-tick watchdog (2026-07-16): ping healthchecks.io at the END of every tick — runs even when runWatch
	// failed (it reports "the tick source is ALIVE", not "the tick succeeded"; tick-level failures already
	// log/diag on their own). If the pings STOP, healthchecks emails the owner — the one failure class no
	// self-hosted alert can cover. Unset secret → no-op. BOUNDED (2026-09-12): a hung ping can't stall a tick.
	const hc = (env as unknown as { HEALTHCHECK_URL?: string }).HEALTHCHECK_URL;
	if (hc) {
		try {
			await fetch(hc, { signal: AbortSignal.timeout(HEARTBEAT_TIMEOUT_MS) });
		} catch (err) {
			console.log(`[watcher] heartbeat ping failed: ${err}`);
		}
	}
}

/** Status snapshot of the metronome — returned by `ensure()`/`status()` and `GET /tick/status`. */
export interface MetronomeStatus {
	/** Epoch ms the next alarm is set for, or null if none is armed. */
	alarmAt: number | null;
	/** Epoch ms the last alarm-driven tick STARTED, or null if it has never run. */
	lastRunAt: number | null;
	/** True when this call had to (re-)arm the alarm. */
	rearmed: boolean;
	now: number;
}

/**
 * TickMetronome (2026-09-12) — the watcher's tick source. ONE instance (`idFromName("watcher")`).
 *
 * Its alarm fires at every wall-clock minute. ⚠️ ARM-FIRST: it re-arms itself for the next :00 BEFORE running
 * `runTick` (live-proven 2026-09-12 cutover): Cloudflare CLEARS the pending alarm the moment it starts
 * delivering it, so during the tick's run `getAlarm()` is null — re-arming only afterwards left a 2–21 s hole
 * every minute in which the cron watchdog read "no alarm" as a broken chain and armed a spurious duplicate
 * (which the runtime then Canceled — harmless, but noise and a latent double-tick dependency on runtime
 * semantics). Arming first also means a throwing tick can never break the chain. A throw is logged and
 * NOT re-thrown on purpose: Cloudflare would otherwise retry the alarm with backoff on top of our own
 * next-minute arm and run two ticks close together — exactly the concurrent-tick race this design exists
 * to remove. The Durable Object's input gate serialises alarm invocations, so ticks never overlap, and a
 * tick (≤ ~26 s budget, ≤ ~38 s worst case with the VAR debounce) always finishes before the next :00.
 *
 * `ensure()` is the watchdog entry (called by the cron every minute and by `POST /tick`): it (re-)arms the
 * alarm only when `shouldRearm` says the chain is broken — never on a healthy chain, because `setAlarm`
 * REPLACES the pending alarm and re-arming a healthy metronome would only shift its cadence.
 *
 * Why a DO alarm and not the cron: docs/notifications.md (cron section), src/metronome.ts header.
 */
export class TickMetronome extends DurableObject<Env> {
	async alarm(): Promise<void> {
		const started = Date.now();
		// ARM FIRST (see the class comment): the next :00 is pending for the whole run, so the watchdog's
		// getAlarm() never sees a hole, and a throw below cannot break the chain.
		await this.ctx.storage.setAlarm(nextMinuteBoundary(started));
		try {
			await runTick(this.env);
		} catch (err) {
			console.log(`[watcher] metronome tick threw: ${err}`);
		} finally {
			await this.ctx.storage.put("lastRunAt", started);
		}
	}

	async ensure(): Promise<MetronomeStatus> {
		const now = Date.now();
		const alarmAt = await this.ctx.storage.getAlarm();
		const lastRunAt = (await this.ctx.storage.get<number>("lastRunAt")) ?? null;
		let rearmed = false;
		if (shouldRearm(alarmAt, lastRunAt, now)) {
			await this.ctx.storage.setAlarm(now + 1_000);
			rearmed = true;
			console.log(`[watcher] metronome re-armed (alarmAt=${alarmAt ?? "none"} lastRunAt=${lastRunAt ?? "never"})`);
		}
		return { alarmAt: await this.ctx.storage.getAlarm(), lastRunAt, rearmed, now };
	}

	async status(): Promise<MetronomeStatus> {
		return {
			alarmAt: await this.ctx.storage.getAlarm(),
			lastRunAt: (await this.ctx.storage.get<number>("lastRunAt")) ?? null,
			rearmed: false,
			now: Date.now(),
		};
	}
}

/** The single metronome instance. */
const metronome = (env: Env): DurableObjectStub<TickMetronome> => env.TICK_METRONOME.get(env.TICK_METRONOME.idFromName("watcher"));

export default {
	// Cron entry point (wrangler.jsonc: "* * * * *") — a WATCHDOG since 2026-09-12, NOT the tick source.
	// It makes sure the TickMetronome alarm is armed and does nothing else. It must NEVER call runTick:
	// one tick source ⇒ no concurrent ticks ⇒ no `la-start`-marker races (the duplicate-card bug).
	async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
		// STALE-TICK GUARD: after a Cloudflare cron-dispatch stall, CF REPLAYS the missed ticks in a burst,
		// out of order, with scheduledTime stamps minutes old (observed 2026-09-12: 162–375s late, two ticks
		// 97 ms apart). A replayed watchdog run is harmless but pointless — the fresh tick covers it — and
		// skipping it keeps the burst from doing anything at all. Normal delivery jitter is 25–30s; 90s margin.
		const now = Date.now();
		if (isStaleScheduledTick(event.scheduledTime, now)) {
			const lateS = Math.round((now - scheduledTimeMs(event.scheduledTime)) / 1000);
			console.log(`[watcher] cron watchdog: skipping REPLAYED tick (scheduled ${new Date(scheduledTimeMs(event.scheduledTime)).toISOString()}, ${lateS}s late)`);
			return;
		}
		ctx.waitUntil(
			(async () => {
				try {
					const s = await metronome(env).ensure();
					if (s.rearmed) console.log(`[watcher] cron watchdog: metronome was down — re-armed (lastRunAt=${s.lastRunAt ?? "never"})`);
				} catch (err) {
					// LOUD: the watchdog can't reach the metronome. The heartbeat (inside runTick) will also stop
					// if the alarm is truly dead, so healthchecks.io still pages the owner.
					console.log(`[watcher] cron watchdog: metronome unreachable — ${err}`);
				}
			})(),
		);
	},

	// HTTP entry point: health + match-card render + the manual test-push trigger.
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		// Liveness probe: answer any HEAD with an empty 200, so a HEAD-only uptime monitor
		// (UptimeRobot free tier) reads the Worker as UP instead of 404-ing on the GET routes below.
		if (request.method === "HEAD") return new Response(null, { status: 200 });

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

		// DEBUG: prove a Cloudflare WORKER can reach the broadcast channel-management port (the one
		// Phase-0 risk the LOCAL probe couldn't answer). Creates + deletes a real channel from inside the
		// Worker. Guarded by the trigger secret. If create fails with status 0 the port is likely blocked
		// from Workers → flip broadcast.ts's manageChannelRequest seam to the Supabase Edge Function.
		if (request.method === "POST" && url.pathname === "/probe-channel") {
			return handleProbeChannel(request, env);
		}

		// DEBUG: drive the REAL V2 broadcast path on demand (no live match needed) — create a channel,
		// push-to-start with input-push-channel, then broadcast update/end. `sandbox:true` targets the
		// sandbox host for a USB debug build. See handleTestBroadcast.
		if (request.method === "POST" && url.pathname === "/test-broadcast") {
			return handleTestBroadcast(request, env);
		}

		// DEBUG HARNESS: schedule a SYNTHETIC fixture the cron discovers on its own → exercises the FULL
		// organic LA-start path (kickoff-window gate → startTokensForTeams preference gate → Queue enqueue
		// → consumer drain → APNs → device) WITHOUT a real game. This is the ONLY on-demand way to test the
		// queue path — /test-activity uses the inline send, which can't reproduce a queue-path bug. Brother-
		// safe by the real gate (use teams they don't follow). See runWatch's readFakeMatch. Secret-gated.
		if (request.method === "POST" && url.pathname === "/debug/fake-match") {
			return handleFakeMatch(request, env);
		}

		if (request.method === "POST" && url.pathname === "/predict-results-run") {
			return handlePredictResultsRun(request, url, env);
		}

		// MANUAL TICK / UNSTICK LEVER (2026-09-12). Runs one tick NOW (same runTick the alarm runs) and makes
		// sure the metronome alarm is armed — the one-curl recovery if the tick source ever stalls, and the
		// drop-in hook for an external pinger if one is ever wanted. Same secret as the other admin routes.
		if (request.method === "POST" && url.pathname === "/tick") {
			if (request.headers.get("x-trigger-secret") !== env.MANUAL_TRIGGER_SECRET) return new Response("Forbidden", { status: 403 });
			ctx.waitUntil(
				(async () => {
					try {
						await metronome(env).ensure();
					} catch (err) {
						console.log(`[watcher] /tick: metronome ensure failed — ${err}`);
					}
					await runTick(env);
				})(),
			);
			return new Response("tick started; metronome ensured\n", { status: 202 });
		}

		// Metronome status (alarmAt / lastRunAt) — the quick "is the tick source alive?" read.
		if (request.method === "GET" && url.pathname === "/tick/status") {
			if (request.headers.get("x-trigger-secret") !== env.MANUAL_TRIGGER_SECRET) return new Response("Forbidden", { status: 403 });
			const s = await metronome(env).status();
			return Response.json({
				...s,
				alarmAtISO: s.alarmAt === null ? null : new Date(s.alarmAt).toISOString(),
				lastRunAtISO: s.lastRunAt === null ? null : new Date(s.lastRunAt).toISOString(),
				lastRunAgeS: s.lastRunAt === null ? null : Math.round((s.now - s.lastRunAt) / 1000),
			});
		}

		return new Response("Not found.", { status: 404 });
	},

	// Queue consumer: drain ONE fan-out message per invocation. Each invocation gets its own fresh
	// 50-external-subrequest budget, so ≤40 APNs POSTs always fit — the whole point of the redesign.
	// Per-token dead tokens are pruned; only a SYSTEMIC failure (total outage/auth) throws so the batch
	// retries (max_retries → DLQ). A partial/dead-token batch acks (no re-delivery → no dupes).
	async queue(batch: MessageBatch<FanoutMessage>, env: Env): Promise<void> {
		const apns = apnsConfig(env);
		const sb = supabaseConfig(env);
		let jwt: string;
		try {
			jwt = await apnsJwt(apns);
		} catch (err) {
			// Can't sign → every message this batch is undeliverable; retry them all (transient key/crypto).
			console.log(`[watcher] queue JWT sign failed — retrying batch: ${err}`);
			for (const m of batch.messages) m.retry();
			return;
		}
		for (const m of batch.messages) {
			try {
				const r = await drainMessage(m.body, jwt, apns, sb);
				console.log(`[watcher] drained ${r.label}: ${r.sent} sent, ${r.failed} failed, ${r.pruned} pruned`);
				if (r.systemic) m.retry();
				else m.ack();
			} catch (err) {
				// Unexpected throw (not the per-token path, which never throws) → retry this message.
				console.log(`[watcher] drain threw (${m.body.label}) — retrying: ${err}`);
				m.retry();
			}
		}
	},
} satisfies ExportedHandler<Env, FanoutMessage>;

// A match is "in the live window" if it kicked off within the last 4h (covers
// in-progress + just-finished) and not more than 5min in the future. This bounds
// the per-match KV reads to today's handful of games instead of the whole season.
// (`kickoffMs` moved to fixtures.ts — the fixture index shares the same parser.)
const WINDOW_PAST_MS = 4 * 60 * 60 * 1000;
const WINDOW_FUTURE_MS = 5 * 60 * 1000;

// The fixture index (fixture-window polling — see src/fixtures.ts for the doctrine): one KV key,
// rebuilt by the ~6h discovery sweep, read every tick to decide WHICH feeds to poll at all.
// TTL is a garbage guard only — discovery refreshes it 4×/day; if KV ever loses it,
// discoveryDue(null) self-heals with an immediate sweep.
const FIXTURE_INDEX_KEY = "fixture-index";
const FIXTURE_INDEX_TTL_S = 48 * 3600;
const DISCOVERY_HOURS = DISCOVERY_INTERVAL_MS / 3_600_000;

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
		// DEBUG: the VAR-correction re-poll must also see the synthetic fixture (it's injected client-side,
		// not in the real proxy scoreboard) — else a fake disallow could never confirm.
		const fake = await readFakeMatch(env);
		const found = fake && fake.event.id === eventId ? fake.event : evs.find((e) => e.id === eventId);
		return found ? parseMatch(found) : null;
	} catch (err) {
		console.log(`[watcher] correction re-poll threw: ${err}`);
		return null;
	}
}

/**
 * One poll: scoreboard → per-match diff → event pushes. Returns whether a match is currently in the
 * live window (in-progress or within the ±kickoff window) — the caller uses it to decide whether to
 * fire a second 30s poll this minute. `cacheBust` forces a fresh ESPN read (see `scheduled`): it adds
 * a `_cb` param that misses the proxy's 30s live cache, the same trick the VAR re-poll uses.
 */
async function runWatch(env: Env, cacheBust = false): Promise<boolean> {
	const now = Date.now();
	const cb = cacheBust ? `&_cb=${Date.now()}` : "";

	/** Fetch one feed's scoreboard window through the proxy binding (null on failure). */
	const fetchFeed = async (feed: string): Promise<ScoreboardEvent[] | null> => {
		const league = feed === NWSL_FEED ? "" : `league=${feed}&`;
		try {
			const res = await env.PROXY.fetch(`${PROXY_SCOREBOARD}?${league}dates=${scoreboardWindow()}&limit=500${cb}`, {
				headers: { Accept: "application/json" },
			});
			if (!res.ok) {
				console.log(`[watcher] scoreboard fetch failed (${feed}): ${res.status}`);
				return null;
			}
			return ((await res.json()) as { events?: ScoreboardEvent[] }).events ?? [];
		} catch (err) {
			console.log(`[watcher] scoreboard fetch threw (${feed}): ${err}`);
			return null;
		}
	};

	// FIXTURE-WINDOW POLLING (src/fixtures.ts): decide WHICH feeds to fetch at all this tick.
	//  - Discovery due (~6h, or index missing) → sweep ALL 16 feeds once + rebuild the index.
	//    The rebuild is accepted ONLY on a complete sweep — a partial sweep (proxy blip) keeps
	//    the previous index (or stays null) so discovery retries NEXT TICK instead of a bad
	//    index silencing polling for 6h.
	//  - Otherwise → fetch only feeds with a fixture inside [KO−75m … KO+4h] (minus ended).
	//    No active fixtures ⇒ this tick makes ZERO proxy fetches (was: 16 every minute, 24/7).
	let index = await env.MATCH_STATE.get<FixtureIndex>(FIXTURE_INDEX_KEY, "json");
	const feedEvents = new Map<string, ScoreboardEvent[]>();
	let indexDirty = false;
	if (discoveryDue(index, now)) {
		const allFeeds = [...CLUB_FEEDS, ...NT_LEAGUES];
		for (const feed of allFeeds) {
			const evs = await fetchFeed(feed);
			if (evs) feedEvents.set(feed, evs);
		}
		if (feedEvents.size === allFeeds.length) {
			// DIAG (NO SILENT FAILURES): a live match the old index never listed = a fixture that
			// appeared inside the discovery gap and MISSED its alert window. Expected never; loud if ever.
			for (const miss of liveMissedByIndex(index, feedEvents)) {
				console.log(`[watcher] DIAG missed-window LIVE match at discovery: ${miss.feed}/${miss.id} — announced <${DISCOVERY_HOURS}h pre-kickoff?`);
			}
			index = buildIndex(feedEvents, now);
			indexDirty = true;
			console.log(`[watcher] discovery: rebuilt fixture index — ${index.fixtures.length} fixture(s) across ${feedEvents.size} feeds`);
		} else {
			console.log(`[watcher] discovery INCOMPLETE (${feedEvents.size}/${allFeeds.length} feeds) — keeping previous index, retrying next tick`);
			// Still fold what we DID fetch into the existing index so this tick's data isn't wasted.
			if (index) {
				for (const [feed, evs] of feedEvents) {
					if (reconcileFeed(index, feed, evs)) indexDirty = true;
				}
			}
		}
	} else if (index) {
		for (const feed of activeFeeds(index, now)) {
			const evs = await fetchFeed(feed);
			if (evs) {
				feedEvents.set(feed, evs);
				// Mark newly-finished fixtures ended (feed goes quiet at real FT, not the 4h backstop)
				// + absorb same-day additions/reschedules ESPN applied while the feed was active.
				if (reconcileFeed(index, feed, evs)) indexDirty = true;
			}
		}
	}

	// Merge ALL club feeds (league + cups) into the ONE event list the club detect loop, LA-start
	// pass, and lineup pass consume — this line WAS `feedEvents.get(NWSL_FEED)` only, which is why a
	// followed club's cup matches never alerted. `eventFeed` remembers each event's source feed:
	// it drives the competition label + the lineup pass's `/summary?league=`. Dedupe by event id in
	// case ESPN ever lists one fixture on two feeds (first feed wins — CLUB_FEEDS order puts NWSL first).
	const eventFeed = new Map<string, string>();
	const events: ScoreboardEvent[] = [];
	for (const feed of CLUB_FEEDS) {
		for (const ev of feedEvents.get(feed) ?? []) {
			if (eventFeed.has(ev.id)) continue;
			eventFeed.set(ev.id, feed);
			events.push(ev);
		}
	}

	// DEBUG HARNESS: inject the KV-flagged synthetic fixture into the FULL event list, so the cron's real
	// club detect loop (kickoff/goal/FT + V2 broadcast), LA-start pass, and lineup pass all process it —
	// exercising the whole organic V2 lifecycle. No-op unless POST /debug/fake-match set the flag.
	// Deliberately OUTSIDE the fixture-window gate: the harness works even on a quiet day with zero
	// real fixtures (its KV read is the only per-tick cost besides the index read). Injected AFTER the
	// feed merge, with its own (spec-chosen) feed slug, so a fake cup match exercises the label path —
	// and a fake NT-slug match routes through the NT loop (flags + nt: fan-out + batched LA start).
	const fake = await readFakeMatch(env);
	if (fake) {
		if ((NT_LEAGUES as readonly string[]).includes(fake.feed)) {
			feedEvents.set(fake.feed, [...(feedEvents.get(fake.feed) ?? []), fake.event]);
		} else {
			events.push(fake.event);
			eventFeed.set(fake.event.id, fake.feed);
		}
	}

	/** The competition label for any event in the merged club list (fake match included). */
	const labelFor = (event: ScoreboardEvent): string =>
		clubEventLabel(eventFeed.get(event.id) ?? NWSL_FEED, event);

	// Is any match in the live window (in-progress or near kickoff, excluding finished)? This is the
	// signal `scheduled` uses to fire a second 30s poll this minute. Computed over the club scoreboard;
	// the NT loop below ORs in any live NT match so an international window also gets the fast cadence.
	let liveInWindow = events.some((event) => {
		const ko = kickoffMs(event);
		if (ko === null || now - ko > WINDOW_PAST_MS || ko - now > WINDOW_FUTURE_MS) return false;
		const state = event.status?.type?.state ?? event.competitions?.[0]?.status?.type?.state;
		return state === "in" || state === "pre";
	});

	const sb = supabaseConfig(env);
	const apns = apnsConfig(env);

	// Collect club V1 events across ALL matches this tick, then do ONE batched follower lookup after the
	// loop (flushClubV1) — an inline per-event lookup (3 REST each) breaches the 50-external subrequest cap
	// on a Decision-Day kickoff/HT cluster. Same collect-then-batch shape the NT LA-start pass uses below.
	const pendingV1: MatchEvent[] = [];

	// Process the live matches CONCURRENTLY (was a sequential for…await). Each match is independent — its
	// own `match:<id>` KV key and LA channel — so running them in parallel is safe and makes the tick's
	// wall time ~the slowest single match instead of the SUM. That's what holds a full 6–7 game slate
	// under the ~30s per-invocation ceiling. Detected events are RETURNED and collected for the one
	// batched follower lookup below (flushClubV1), so concurrency never changes what fires or its order.
	const processClubMatch = async (event: ScoreboardEvent): Promise<MatchEvent[]> => {
		// Live-window gate (cheap, no I/O) before any KV read.
		const ko = kickoffMs(event);
		if (ko === null || now - ko > WINDOW_PAST_MS || ko - now > WINDOW_FUTURE_MS) return [];

		const match = parseMatch(event); // null unless "in" or "post" with both team ids
		if (!match) return [];
		// Competition label (from the source feed) — read only by the kickoff subtitle, so a cup
		// kickoff push says which competition it is. parseMatch can't know the feed; set it here.
		match.competition = labelFor(event);

		const key = `match:${match.eventId}`;
		const prev = await env.MATCH_STATE.get<StoredState>(key, "json");

		// A "post" match we were never tracking (no prior live state) → already
		// finished before we started; skip so we don't fire a late full-time.
		if (match.state === "post" && !prev) return [];

		// SUMMARY GOAL CROSS-CHECK (2026-09-05). ESPN's /scoreboard competitor score can TRAIL its own
		// /summary keyEvents for a goal, which delayed the goal push + V2-LA while the app's play-by-play
		// (summary) already showed it (device-observed twice, both away goals). For a LIVE match, RAISE the
		// effective score to the summary's stated goals so detection/persist/LA-sync fire on time. This is
		// best-effort: any fetch/parse failure keeps the scoreboard score (today's behavior, no regression).
		// It only RAISES — the scoreboard stays authoritative for VAR DECREASES, which still flow through the
		// correction path below (the "NO GOAL · VAR review" push is kept intentionally — VAR is part of the
		// game, owner 2026-09-05).
		if (match.state === "in") {
			try {
				const feed = eventFeed.get(event.id) ?? NWSL_FEED;
				const leagueParam = feed === NWSL_FEED ? "" : `&league=${encodeURIComponent(feed)}`;
				// Cache-bust ONLY on the 2nd poll — mirroring /scoreboard's own `_cb` pattern (2026-09-12 audit).
				// The proxy caches /summary on the FULL URL and never strips `_lc`, so a per-poll `_lc=${now}` gave
				// every call a UNIQUE cache key. ⚠️ CORRECTED SAME NIGHT: this does NOT reduce ESPN fetches — the
				// proxy's live TTL is 30 s and poll 1 re-reads this key only every 60 s, so poll 1 misses and hits
				// ESPN regardless (both polls stay FRESH — good for goal latency). What the stable poll-1 URL DOES
				// buy: the proxy's stale/snapshot recovery ladder is keyed on the un-busted URL, so an ESPN blip on
				// poll 1 can now serve last-known-good instead of failing; and poll 1 no longer writes dead cache
				// entries. #44's real cost stands: 2 forced ESPN /summary recomputes per live match per minute
				// (16/min on an 8-match day) — the number to watch for ESPN 429s. Detection logic is untouched.
				const lc = cacheBust ? `&_lc=${now}` : "";
				const res = await env.PROXY.fetch(`${PROXY_SUMMARY}?event=${match.eventId}${leagueParam}${lc}`, {
					headers: { Accept: "application/json" },
				});
				if (res.ok) {
					const sum = (await res.json()) as { keyEvents?: unknown };
					const sg = summaryGoalScore(sum.keyEvents, match.home.name, match.away.name);
					if (sg) {
						if (sg.home > match.home.score) match.home.score = sg.home;
						if (sg.away > match.away.score) match.away.score = sg.away;
					}
				}
			} catch (err) {
				console.log(`[watcher] summary goal cross-check failed (${match.eventId}): ${err}`);
			}
		}

		const detected = detectEvents(prev, match);

		// One V1 fan-out (follower lookup → enqueue) — shared by normal events and the VAR correction.
		// Delivery + prune happen in the queue consumer; here we only look up tokens and enqueue, so the
		// cron tick never touches the 50-external subrequest cap regardless of follower count.
		const fireV1 = async (ev: MatchEvent): Promise<void> => {
			let tokens: string[];
			try {
				tokens = await tokensForEvent(sb, ev.teamIds, ev.prefColumn);
			} catch (err) {
				console.log(`[watcher] follower lookup failed (${ev.type} ${ev.eventId}): ${err}`);
				return;
			}
			await enqueueV1(env, ev, tokens);
		};

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
			} else if (!recheck) {
				// Re-poll FAILED (the same proxy/ESPN flakiness that produced the dip). We can neither
				// confirm nor deny the decrease, so DON'T baseline the glitched-LOW score — persisting it
				// would make ESPN's recovery next tick look like a fresh GOAL and fire a false push to every
				// follower. Hold the PRIOR scores this tick (keeping match's other fields: clock/status);
				// the next tick re-evaluates, since the debounce acts only on a PERSISTING dip.
				effectiveMatch = {
					...match,
					home: { ...match.home, score: candidate.prev.home },
					away: { ...match.away, score: candidate.prev.away },
				};
				console.log(`[watcher] correction ${match.eventId} re-poll FAILED — holding prior ${candidate.prev.home}-${candidate.prev.away} baseline (no false goal)`);
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
			await syncLiveActivity(env, apns, effectiveMatch, detected.length > 0 || correctionFired, newState.virtualKickoff);
		} catch (err) {
			console.log(`[watcher] LA sync failed (${match.eventId}): ${err}`);
		}

		if (effectiveMatch.state === "post") {
			await env.MATCH_STATE.delete(key);
		} else if (!prev || !sameStoredState(prev, newState)) {
			// Write ONLY when something actually changed (goal/HT/FT/red/period/anchor). A quiet minute of
			// play produces an identical state — skipping it cuts a live match from ~120 writes to ~10,
			// which is the free-tier KV-write headroom that matters on busy match days / international windows.
			await env.MATCH_STATE.put(key, JSON.stringify(newState), {
				expirationTtl: MATCH_STATE_TTL,
			});
		}

		return detected;
	};

	// Fan the matches out with bounded concurrency, then collect every detected event for the ONE batched
	// follower lookup below. Order-independent: concurrency changes only the WALL TIME, not what fires.
	const detectedPerMatch = await mapLimit(events, MATCH_CONCURRENCY, processClubMatch);
	for (const list of detectedPerMatch) for (const ev of list) pendingV1.push(ev);

	// One batched follower lookup for every club V1 event detected across the loop above (see flushClubV1) —
	// keeps the tick's external-subrequest count flat regardless of how many matches fire together.
	await flushClubV1(env, sb, pendingV1);

	// NATIONAL-TEAM pass: the same event detection (kickoff/goal/HT/FT), but fanned out by FIFA code to
	// `competition_alert_preferences` instead of the club table. V1 push only — NT Live Activities (V2)
	// and the VAR-correction debounce are deferred (kept the club-only path). Reuses `jwt`/`sb`/`apns`.
	// FIXTURE-WINDOW: a feed appears in `feedEvents` only when it was actually polled this tick
	// (a fixture in window, or the discovery sweep) — an off-tournament feed costs ZERO fetches now,
	// not just zero KV work.
	// NT V2 LA start candidates — COLLECTED here, batched into ONE token lookup after the loop
	// (startNationalActivities). Never call the per-match lookup inside this loop: a FIFA-window
	// kickoff cluster × 3 REST calls each is the exact 50-external breach the stress test flagged.
	const ntStartCandidates: Array<{ event: ScoreboardEvent; ko: number; label: string }> = [];
	for (const slug of NT_LEAGUES) {
		const ntEvents = feedEvents.get(slug);
		if (!ntEvents) continue;
		for (const event of ntEvents) {
			const ko = kickoffMs(event);
			if (ko === null) continue;

			// NT V2 push-to-start — its OWN ≤20-min pre-kickoff window (wider than the live gate below,
			// which excludes future matches). All NTs (2026-08-06); audience-gated by follow keys.
			if (ko >= now && ko - now <= LA_START_LEAD_MS) {
				ntStartCandidates.push({ event, ko, label: FEED_LABEL[slug] ?? "International" });
			}

			// Live-window gate for V1 detection + V2 broadcast sync.
			if (now - ko > WINDOW_PAST_MS || ko - now > WINDOW_FUTURE_MS) continue;
			liveInWindow = true; // an in-window NT match → give the international window the 30s cadence too
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
				await enqueueV1(env, ev, tokens); // same V1 message shape; tokens are device_tokens, pruned there
			}

			// State (with the monotonic clock anchor, like the club pass) for the KV write + NT V2 sync.
			const ntNext = nextState(prev, match, detected, Math.floor(Date.now() / 1000));

			// NT V2 broadcast sync — mirrors the club syncLiveActivity, for EVERY NT match (2026-08-06;
			// was USWNT-gated). syncLiveActivity SELF-GATES on channel existence (its first KV read
			// returns undefined unless push-to-start created `la-chan:{id}`) — so a match nobody
			// LA-follows costs one KV read and zero APNs work. That check is the correct predicate;
			// an abbr gate here would just duplicate it.
			try {
				await syncLiveActivity(env, apns, match, detected.length > 0, ntNext.virtualKickoff);
			} catch (err) {
				console.log(`[watcher] NT LA sync failed (${match.eventId}): ${err}`);
			}

			if (match.state === "post") await env.MATCH_STATE.delete(key);
			// Same change-guard as the club pass — skip re-writing an identical NT state every tick.
			else if (!prev || !sameStoredState(prev, ntNext)) await env.MATCH_STATE.put(key, JSON.stringify(ntNext), { expirationTtl: MATCH_STATE_TTL });
		}
	}

	// NT LA-start pass — the collected candidates, ONE batched token lookup, ≤NT_STARTS_PER_TICK
	// channel creates (overflow rolls to the next tick inside the 20-min lead). Isolated try/catch
	// so an NT start hiccup can't affect club processing.
	try {
		await startNationalActivities(env, ntStartCandidates, sb, apns);
	} catch (err) {
		console.log(`[watcher] NT LA start pass failed: ${err}`);
	}

	// SEPARATE pass (not tangled into detectEvents): remote-start a Live Activity for any match
	// kicking off within the next ~5 min that a signed-in user has alerts ON for. KV-deduped.
	try {
		await startUpcomingActivities(env, events, sb, apns, labelFor);
	} catch (err) {
		console.log(`[watcher] LA start pass failed: ${err}`);
	}

	// SEPARATE pass: poll /summary for matches in the pre-kickoff window and push "Lineups in" once
	// both starting XIs are posted. KV-deduped; isolated so a /summary hiccup can't break score alerts.
	try {
		await checkUpcomingLineups(env, events, sb, apns, (ev) => eventFeed.get(ev.id) ?? NWSL_FEED);
	} catch (err) {
		console.log(`[watcher] lineup pass failed: ${err}`);
	}

	// SEPARATE pass: sweep orphan broadcast channels (throttled ~6h internally). Isolated so a manage-host
	// hiccup can't affect scores/pushes.
	try {
		await sweepOrphanChannels(env, apns);
	} catch (err) {
		console.log(`[watcher] channel sweep failed: ${err}`);
	}

	// Persist the fixture index only when something changed (a discovery rebuild, a fixture ending,
	// a same-day addition/reschedule) — a quiet tick writes nothing.
	if (indexDirty && index) {
		await env.MATCH_STATE.put(FIXTURE_INDEX_KEY, JSON.stringify(index), { expirationTtl: FIXTURE_INDEX_TTL_S });
	}

	return liveInWindow;
}

/** V2: BROADCAST the current match state to the match's channel — ONE request, Apple fans out to every
 *  subscribed Activity (any audience size). END + delete the channel at full time, or skip when only the
 *  local clock needs to tick. Broadcast replaces the old per-Activity-token loop: no per-token fan-out and
 *  no catch-up pass (the start payload carried current state, and the No-Storage policy means a late
 *  subscriber just waits for the next broadcast). Resync throttled by LA_RESYNC_MS. */
// Per-match widget-clock bookkeeping, MERGED into one KV key (was three: la-rs / la-epoch / la-stop) so a
// resync costs 1 KV write, not 3 — the dominant write path on a busy match day (docs/notifications.md).
// `rs` = last resync time (the 10-min floor); `epoch` = last-broadcast anchor (null while paused, but the
// last non-null value is retained so drift detection survives HT); `stop` = last stoppage label.
interface AnchorState { rs: number; epoch: number | null; stop: string }

async function syncLiveActivity(
	env: Env,
	apns: ApnsConfig,
	match: Match,
	hadEvent: boolean,
	virtualKickoff?: number,
): Promise<void> {
	const chanId = await env.MATCH_STATE.get(channelKey(match.eventId));
	if (!chanId) return; // no channel ⇒ no Activities were started for this match (or create failed)

	// ⚠️ A SUSPENDED match reports `state === "post"` while play is halted (2026-07-29, UTA v WAS).
	// Skip entirely: no update, no teardown. The teardown below is IRREVERSIBLE — it deletes the
	// channel at APNs and both KV keys, and push-to-start is gated on `ko >= now`, so an already-
	// kicked-off match can NEVER restart its Activity. Freezing the card on its last state until play
	// resumes is the only recoverable option. (Broadcasting an update instead would be wrong too: the
	// content state derives its phase from `state`, so it would render a full-time card mid-match.)
	if (match.unfinishedPost) {
		console.log(`[watcher] LA hold ${match.eventId}: ${match.statusName} — not ended, skipping`);
		return;
	}

	const ended = match.state === "post";
	const anchorKey = `la-anchor:${match.eventId}`; // merged {rs, epoch, stop} — 1 KV write/resync, not 3
	const state: LiveContentState = contentStateFromMatch(match, virtualKickoff);
	const jwt = await apnsJwt(apns);

	if (ended) {
		// No dismissal-date → the FT card lingers to Apple's ~4h cap, user-dismissable (owner request
		// 2026-07-05). Then delete the channel + clean KV so nothing leaks past the match.
		const r = await broadcastEnd(apns, jwt, chanId, state);
		console.log(`[watcher] LA broadcast END ${match.eventId}: ${r.ok ? "ok" : `${r.status} ${r.reason ?? ""}`}`);
		await deleteChannel(apns, jwt, chanId);
		await env.MATCH_STATE.delete(channelKey(match.eventId));
		await env.MATCH_STATE.delete(anchorKey);
		return;
	}

	// Broadcast on an event, when the anchor drifts (see below), or once the 10-min floor elapses;
	// between those the widget's local timer ticks on its own (no push). ONE broadcast reaches every
	// subscriber regardless of how many.
	const epoch = state.clockStartEpoch; // the exact anchor the widget renders; undefined while paused
	const prev = await env.MATCH_STATE.get<AnchorState>(anchorKey, "json"); // last broadcast — read ONCE
	let resync = hadEvent;
	// Drift-triggered resync: the anchor is stable during smooth play (the on-device timer tracks ESPN
	// 1:1), but jumps ≥30s at each half's late live-flip / a mid-game correction — resync then so the
	// card snaps within one tick instead of coasting behind for up to the 10-min floor.
	if (!resync && epoch != null && prev?.epoch != null && Math.abs(epoch - prev.epoch) >= LA_DRIFT_RESYNC_SEC) {
		resync = true;
	}
	// Stoppage rollover: in added time the anchor is FROZEN (no drift), but stoppageDisplay ticks
	// "90'+1'"→"+2'"… each minute — the only way the widget's static +N advances is a fresh broadcast,
	// so resync whenever the label changes (entering, each minute, and leaving stoppage). Bounded: a
	// handful of pushes per stoppage window, one broadcast reaching all subscribers.
	// device-proven: this per-minute stoppage-cadence broadcast has run correctly in production for ~6
	// weeks (owner, 2026-08-31) — the widget's static +N advances live on real devices as expected.
	const stoppage = state.stoppageDisplay ?? "";
	if (!resync && (prev?.stop ?? "") !== stoppage) resync = true;
	// 10-min floor: re-broadcast even during smooth play so the widget can't coast too far behind.
	if (!resync) resync = prev?.rs == null || Date.now() - prev.rs >= LA_RESYNC_MS;
	if (resync) {
		const r = await broadcastUpdate(apns, jwt, chanId, state);
		console.log(`[watcher] LA broadcast update ${match.eventId}: ${r.ok ? "ok" : `${r.status} ${r.reason ?? ""}`}`);
		// ONE write for all three fields. Keep the last non-null epoch while paused (HT) so the drift
		// baseline survives the break — matches the old "only write epoch when running" behavior.
		const next: AnchorState = { rs: Date.now(), epoch: epoch ?? prev?.epoch ?? null, stop: stoppage };
		await env.MATCH_STATE.put(anchorKey, JSON.stringify(next), { expirationTtl: MATCH_STATE_TTL });
	}
}

/** DEBUG HARNESS: the synthetic fixture the cron injects (into the WHOLE event list — club detect loop,
 *  LA-start pass, and lineup pass), or null when `debug:fake-match` isn't set. It EVOLVES over a timeline
 *  in the spec so the cron's REAL code drives the full V2 lifecycle: pre (LA-start fires → card + channel)
 *  → kickoff at `kickoffMs` (state "in", clock ticking → detectEvents kickoff + syncLiveActivity broadcast)
 *  → goal at `goalMs` (home score 0→1 → detectEvents goal + broadcast UPDATE — the leg we're proving) →
 *  FT at `ftMs` (state "post" → broadcastEnd). Real ESPN team ids so `startTokensForTeams` + `tokensForEvent`
 *  gate on a real `team_alert_preferences` row. `date` = kickoffMs so `kickoffMs(event)` drives the
 *  LA-start 20-min window. Shapes match what parseMatch/detectEvents read (status.type.state/name,
 *  status.period, status.clock[sec], competitors[].score). */
interface FakeGoal { at: number; side: "home" | "away"; scorer: string; minute: number; disallowedAt?: number }
interface FakeRed { at: number; side: "home" | "away"; player: string; minute: number }
interface FakeMatchSpec {
	id: string; homeId: string; homeAbbr: string; awayId: string; awayAbbr: string;
	kickoffMs: number; ftMs: number;
	goals: FakeGoal[]; reds: FakeRed[];
	/** Source feed the synthetic fixture pretends to come from (default NWSL) — lets a fake CUP
	 *  match exercise the competition-label path organically ("Challenge Cup" on the device card). */
	feed?: string;
	/** Seconds ADDED to the real elapsed (now − kickoffMs) so a scenario can OPEN mid-match — e.g. 83'
	 *  — while the LA-start still fires organically off a near-future `kickoffMs`. The ONLY way to compress
	 *  a late-game / stoppage test without waiting 90 real minutes. Default 0 = normal from-kickoff.
	 *  Once elapsed crosses 45', readFakeMatch reports period 2 so the REAL stoppageLabel (livestate.ts,
	 *  cap 90 for the 2nd half) emits "90'+n'" as wall-clock carries the anchor past 90'. */
	clockOffsetSec?: number;
}
async function readFakeMatch(env: Env): Promise<{ event: ScoreboardEvent; feed: string } | null> {
	const spec = (await env.MATCH_STATE.get("debug:fake-match", "json")) as FakeMatchSpec | null;
	if (!spec) return null;
	const now = Date.now();
	let state = "pre", name = "STATUS_SCHEDULED", period = 0, clock = 0;
	if (now >= spec.ftMs) {
		state = "post"; name = "STATUS_FULL_TIME"; period = 2;
	} else if (now >= spec.kickoffMs) {
		state = "in";
		// Elapsed match seconds (+ optional clockOffsetSec so a scenario can OPEN mid-match — see the
		// FakeMatchSpec doc). Default offset 0 → plain from-kickoff, unchanged for the default script.
		clock = Math.floor((now - spec.kickoffMs) / 1000) + (spec.clockOffsetSec ?? 0);
		// Period/name from the elapsed minute so the REAL clock path treats a late scenario as the 2nd
		// half: contentStateFromMatch's stoppageLabel uses cap=90 for period 2 and emits "90'+n'" once the
		// monotonic anchor carries elapsed past 90'. The default script stays under 45' → 1st half.
		if (clock >= 45 * 60) { period = 2; name = "STATUS_SECOND_HALF"; }
		else { period = 1; name = "STATUS_FIRST_HALF"; }
	}
	// Build the scoreboard `details` (scoring plays + red cards) + running score AS OF `now` from the
	// timeline. A goal with `disallowedAt` in the past is REMOVED (score decrements + its play drops) → a
	// clean score DECREASE the watcher reads as a VAR correction. parsePlays/parseCards read these exact fields.
	const sideId = (s: "home" | "away") => (s === "home" ? spec.homeId : spec.awayId);
	const details: ScoreboardDetail[] = [];
	let homeScore = 0, awayScore = 0;
	for (const g of spec.goals ?? []) {
		if (now < g.at) continue;                               // not scored yet
		if (g.disallowedAt && now >= g.disallowedAt) continue;  // VAR-disallowed → gone from score + card
		if (g.side === "home") homeScore++; else awayScore++;
		details.push({ scoringPlay: true, team: { id: sideId(g.side) }, clock: { displayValue: `${g.minute}'` }, athletesInvolved: [{ shortName: g.scorer, displayName: g.scorer }] });
	}
	for (const r of spec.reds ?? []) {
		if (now < r.at) continue;
		details.push({ redCard: true, type: { text: "Red Card" }, team: { id: sideId(r.side) }, clock: { displayValue: `${r.minute}'` }, athletesInvolved: [{ shortName: r.player, displayName: r.player }] });
	}
	const status = { type: { state, name }, period, clock };
	const event: ScoreboardEvent = {
		id: spec.id,
		date: new Date(spec.kickoffMs).toISOString(),
		status,
		competitions: [
			{
				status,
				competitors: [
					{ homeAway: "home", score: String(homeScore), team: { id: spec.homeId, abbreviation: spec.homeAbbr, displayName: spec.homeAbbr } },
					{ homeAway: "away", score: String(awayScore), team: { id: spec.awayId, abbreviation: spec.awayAbbr, displayName: spec.awayAbbr } },
				],
				details,
				venue: { fullName: "Fake Match (debug harness)" },
			},
		],
	};
	return { event, feed: spec.feed ?? NWSL_FEED };
}

/** POST /debug/fake-match — schedule (or clear) a FULL synthetic match. Default script (both teams 2
 *  goals + an away red card + one away goal DISALLOWED by VAR): kickoff +2m, then an event every `gapSec`
 *  (default 90s so each lands on its own cron tick): HOME goal, AWAY goal, AWAY red, AWAY goal→disallowed a
 *  gap later (VAR correction), HOME goal, AWAY goal, then FT. ~14 min total; final HOME 2–2 AWAY.
 *  Body: { gapSec?=90, homeId?="18206"(ORL), homeAbbr?, awayId?="15360"(CHI), awayAbbr? } | { clear:true }.
 *  Secret-gated. Brother-safe by team choice. Fresh matchId per call so re-tests aren't KV-deduped. */
async function handleFakeMatch(request: Request, env: Env): Promise<Response> {
	if (request.headers.get("x-trigger-secret") !== env.MANUAL_TRIGGER_SECRET) {
		return new Response("forbidden", { status: 403 });
	}
	let p: { gapSec?: number; homeId?: string; homeAbbr?: string; awayId?: string; awayAbbr?: string; feed?: string; clear?: boolean; scenario?: string; scorer?: string } = {};
	try {
		p = (await request.json()) as typeof p;
	} catch {
		/* empty body → defaults */
	}
	// Optional source feed — lets a fake CUP match exercise the competition-label path end-to-end
	// ({"feed":"usa.nwsl.cup"} → "Challenge Cup" card), and a fake NT match the NT loop
	// ({"feed":"fifa.friendly.w", homeAbbr:"JPN", …} → flag card + nt: fan-out; use REAL FIFA codes
	// the tester LA-follows, since NT fan-out keys on abbreviations, not team ids).
	const knownFeeds = [...CLUB_FEEDS, ...NT_LEAGUES] as readonly string[];
	if (p.feed && !knownFeeds.includes(p.feed)) {
		return new Response(`unknown feed "${p.feed}" (use one of: ${knownFeeds.join(", ")})`, { status: 400 });
	}
	const j = (body: unknown, status = 200) => new Response(JSON.stringify(body, null, 2), { status, headers: { "Content-Type": "application/json" } });
	if (p.clear) {
		await env.MATCH_STATE.delete("debug:fake-match");
		return j({ cleared: true });
	}
	const now = Date.now();

	// ── "late-drama": a COMPRESSED late-game test through the ORGANIC path ────────────────────────
	// LA-start fires now (kickoff 2m out → the pre card + the watch crest render — the headline check),
	// the match OPENS at 83' (clockOffsetSec), a HOME goal lands at 85', then the clock self-ticks past
	// the hour into real stoppage (period 2 → livestate stoppageLabel "90'+n'") and FT at 90'+5'. ~12 min
	// wall-clock. Defaults WAS 1–0 ORL (owner's "the way it should have been"). The real detectEvents /
	// syncLiveActivity / broadcast path drives every push — NOT the inline /test-activity send.
	if (p.scenario === "late-drama") {
		const homeId = p.homeId ?? "15365", homeAbbr = p.homeAbbr ?? "WAS";
		const awayId = p.awayId ?? "18206", awayAbbr = p.awayAbbr ?? "ORL";
		const kickoffMs = now + 2 * 60_000;
		const clockOffsetSec = 83 * 60;           // clock opens at 83:00 when state flips to "in"
		const goalAt = kickoffMs + 2 * 60_000;    // ~2 min after kickoff → clock ~85'
		const ftMs = kickoffMs + 12 * 60_000;     // elapsed at FT = 83' + 12' = 95' = 90'+5'
		const scorer = p.scorer ?? "T. Rodman";
		const spec: FakeMatchSpec = {
			id: `fakematch-${now}`, homeId, homeAbbr, awayId, awayAbbr,
			kickoffMs, ftMs, clockOffsetSec,
			goals: [{ at: goalAt, side: "home", scorer, minute: 85 }],
			reds: [],
			...(p.feed ? { feed: p.feed } : {}),
		};
		await env.MATCH_STATE.put("debug:fake-match", JSON.stringify(spec), { expirationTtl: Math.ceil((ftMs - now) / 1000) + 600 });
		const rel = (ms: number) => `+${Math.round((ms - now) / 60_000)}m`;
		return j({
			scheduled: { id: spec.id, teams: `${homeAbbr} v ${awayAbbr}`, scenario: "late-drama" },
			timeline: [
				`LA-start ~now (pre card + buzz) — ⌚ CHECK THE CREST on the watch here`,
				`kickoff ${rel(kickoffMs)} (clock opens ~83')`,
				`${homeAbbr} goal ${scorer} 85' ${rel(goalAt)} → ${homeAbbr} 1–0`,
				`clock self-ticks 85'→90' (mm:ss past the hour)`,
				`stoppage 90'+1'…+5' ${rel(kickoffMs + 7 * 60_000)}–${rel(ftMs)}`,
				`FT ${rel(ftMs)} (final ${homeAbbr} 1–0 ${awayAbbr})`,
			],
			note: `Needs a build-37 TestFlight install with alerts ON for ${homeAbbr} + Live Activities ON + app opened once (fresh start token). Watch for: crest render on the ⌚, the goal buzz, the >60' clock, the "90'+n'" stoppage label, FT ${homeAbbr} 1–0.`,
		});
	}

	const gap = (p.gapSec ?? 90) * 1000;
	const kickoffMs = now + 2 * 60_000; // kickoff 2 min out (LA-start fires now, inside the 20-min window)
	const cm = (t: number) => Math.max(1, Math.round((t - kickoffMs) / 60_000)); // cosmetic match-clock minute
	const goals: FakeGoal[] = [];
	const reds: FakeRed[] = [];
	let t = kickoffMs + gap;
	goals.push({ at: t, side: "home", scorer: "A. Rodman", minute: cm(t) }); t += gap;
	goals.push({ at: t, side: "away", scorer: "B. Hatch", minute: cm(t) }); t += gap;
	reds.push({ at: t, side: "away", player: "C. Sonnett", minute: cm(t) }); t += gap;
	const varAt = t; // away goal that VAR disallows a gap later (a clean score decrease to fire the correction)
	goals.push({ at: varAt, side: "away", scorer: "D. Smith (VAR)", minute: cm(varAt), disallowedAt: varAt + gap }); t += 2 * gap;
	goals.push({ at: t, side: "home", scorer: "E. Shaw", minute: cm(t) }); t += gap;
	goals.push({ at: t, side: "away", scorer: "F. Lavelle", minute: cm(t) }); t += gap;
	const ftMs = t + gap;
	const spec: FakeMatchSpec = {
		id: `fakematch-${now}`,
		homeId: p.homeId ?? "18206", homeAbbr: p.homeAbbr ?? "ORL",
		awayId: p.awayId ?? "15360", awayAbbr: p.awayAbbr ?? "CHI",
		kickoffMs, ftMs, goals, reds,
		...(p.feed ? { feed: p.feed } : {}),
	};
	await env.MATCH_STATE.put("debug:fake-match", JSON.stringify(spec), { expirationTtl: Math.ceil((ftMs - now) / 1000) + 600 });
	const rel = (ms: number) => `+${Math.round((ms - now) / 60_000)}m`;
	return j({
		scheduled: { id: spec.id, teams: `${spec.homeAbbr} v ${spec.awayAbbr}`, gapSec: gap / 1000 },
		timeline: [
			`LA-start ~now (card + buzz)`,
			`kickoff ${rel(kickoffMs)}`,
			...goals.map((g) => `${g.side === "home" ? spec.homeAbbr : spec.awayAbbr} goal ${g.scorer} ${rel(g.at)}${g.disallowedAt ? ` → VAR DISALLOW ${rel(g.disallowedAt)}` : ""}`),
			...reds.map((r) => `${r.side === "home" ? spec.homeAbbr : spec.awayAbbr} RED ${r.player} ${rel(r.at)}`),
			`FT ${rel(ftMs)} (final ${spec.homeAbbr} 2–2 ${spec.awayAbbr})`,
		],
		note: `Needs alerts ON for ${spec.homeAbbr} or ${spec.awayAbbr} + Live Activities + a start token. Watch the card for scorers under each side, a red-card mark on ${spec.awayAbbr}, the VAR score roll-back, and FT.`,
	});
}

/** SEPARATE start trigger (NOT detectEvents): for matches ≤5 min pre-kickoff, remote-start a Live
 *  Activity for everyone with alerts ON for a participating team + a push-to-start token. KV-deduped. */
async function startUpcomingActivities(
	env: Env,
	events: ScoreboardEvent[],
	sb: SupabaseConfig,
	apns: ApnsConfig,
	// Competition label per event ("NWSL" / "NWSL Playoffs" / "Challenge Cup" / "CONCACAF") — a VALUE
	// for the existing `competition` attribute only; the payload structure is untouched (§0 law).
	labelFor: (event: ScoreboardEvent) => string = () => "NWSL",
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
		const attrs = attributesFor(info.matchId, info.homeAbbr, info.awayAbbr, labelFor(event));
		const state = preContentState(kickoffLabel(ko), info.broadcast);
		// ARRIVAL-BUZZ LAW (corrected 2026-07-09 against the 7/5 A/B logs — see docs/live-activity-v2.md §3):
		// TWO INDEPENDENT requirements — proven separately 7/11, do NOT conflate them (this is what
		// wasted days): (1) RENDER needs both an `alert` object [render law, 7/4] AND a correct `{ aps }`
		// envelope [enqueueLaStart — the 7/10 no-show was the missing wrapper, NOT the sound]. (2) BUZZ:
		// `sound: "default"` = one arrival buzz; `sound: ""` renders but is SILENT. With the envelope
		// fixed, "default" renders AND buzzes (device-verified 7/11, fake-match harness). Updates/end
		// stay alert-less (silent) — the Athletic pattern.
		const startAlert = {
			title: `${info.homeAbbr} vs ${info.awayAbbr}`,
			body: "Live match card is on your lock screen.",
			sound: "default", // one arrival buzz; "" renders but is SILENT (device-verified 7/11)
		};
		// The start push is the ONE per-device Live Activity fan-out per match → it rides the Queues rail
		// like V1. `channelId` (iOS 18 broadcast, added in the broadcast phase) goes in the start payload so
		// the created Activity auto-subscribes to the match channel for every later update.
		const channelId = await ensureMatchChannel(env, apns, info.matchId);
		await enqueueLaStart(env, apns, attrs, state, startAlert, tokens, channelId);
		await env.MATCH_STATE.put(startedKey, String(now), { expirationTtl: MATCH_STATE_TTL });
	}
}

/** NT V2 push-to-start, ALL national teams (2026-08-06; was USWNT-only): for the UPCOMING NT matches
 *  in the ≤20-min window, ONE batched follow-key token lookup (3 REST calls per tick TOTAL — the
 *  stress-gate requirement; per-match lookups breach the 50-external budget on a kickoff cluster),
 *  then per match: channel + Live Activity start to everyone following EITHER country with Live
 *  Activities on. `isNational` attributes → the widget renders FIFA-code flags. KV-deduped via the
 *  shared la-start key; ≤NT_STARTS_PER_TICK starts per tick, overflow retried next tick (unmarked). */
async function startNationalActivities(
	env: Env,
	candidates: Array<{ event: ScoreboardEvent; ko: number; label: string }>,
	sb: SupabaseConfig,
	apns: ApnsConfig,
): Promise<void> {
	if (candidates.length === 0) return;
	// Resolve + drop already-started (KV markers are internal-budget reads, cheap).
	const pending: Array<{ info: NonNullable<ReturnType<typeof upcomingInfo>>; ko: number; label: string }> = [];
	for (const c of candidates) {
		const info = upcomingInfo(c.event);
		if (!info) continue;
		if (await env.MATCH_STATE.get(`la-start:${info.matchId}`)) continue;
		pending.push({ info, ko: c.ko, label: c.label });
	}
	if (pending.length === 0) return;
	const keys = [...new Set(pending.flatMap((p) => [`nt:${p.info.homeAbbr}`, `nt:${p.info.awayAbbr}`]))];
	let tokensByKey: Map<string, string[]>;
	try {
		tokensByKey = await startTokensByCompetitionKey(sb, keys);
	} catch (err) {
		console.log(`[watcher] NT LA start lookup failed (${pending.length} candidate(s)): ${err}`);
		return; // no markers set — retried next tick inside the 20-min window
	}
	if (tokensByKey.size === 0) return; // nobody LA-follows any of these countries — cheap no-op
	let started = 0;
	for (const p of pending) {
		if (started >= NT_STARTS_PER_TICK) {
			console.log(`[watcher] NT LA start stagger: ${pending.length - started} deferred to next tick`);
			break;
		}
		// Union both countries' audiences; uniq so a follow-both-sides user isn't double-pushed.
		const tokens = [...new Set([...(tokensByKey.get(`nt:${p.info.homeAbbr}`) ?? []), ...(tokensByKey.get(`nt:${p.info.awayAbbr}`) ?? [])])];
		if (tokens.length === 0) continue; // no opt-ins for this match — retry next poll, still inside the window
		const attrs = attributesFor(p.info.matchId, p.info.homeAbbr, p.info.awayAbbr, p.label, true);
		const state = preContentState(kickoffLabel(p.ko), p.info.broadcast);
		// Buzz-once arrival, then silent (see the club start above + docs/live-activity-v2.md §3).
		const startAlert = {
			title: `${p.info.homeAbbr} vs ${p.info.awayAbbr}`,
			body: "Live match card is on your lock screen.",
			sound: "default", // one arrival buzz; matches the club start (see startUpcomingActivities)
		};
		const channelId = await ensureMatchChannel(env, apns, p.info.matchId);
		await enqueueLaStart(env, apns, attrs, state, startAlert, tokens, channelId);
		await env.MATCH_STATE.put(`la-start:${p.info.matchId}`, String(Date.now()), { expirationTtl: MATCH_STATE_TTL });
		started++;
	}
}

/** The once-daily post-match "your Predict result is in" pass (Change 8) — its own cron, NOT the live
 *  tick. Reads the same yesterday→tomorrow NWSL scoreboard window, keeps SETTLED finals (state "post" &&
 *  !unfinishedPost), and for each pushes the unseen predictors who opted into `predict_results`. Modeled
 *  on `checkUpcomingLineups`: a hand-built payload, KV one-shot dedup, retry-until-sent (don't burn the
 *  marker on a 0-recipient tick, so a late pref-enable within the ~2-day window still lands). Generic copy
 *  (no score) — the push is the hook; the in-app reveal is the payoff. */
/** Run the Predict-results pass AT MOST ONCE per UTC HOUR — called every per-minute tick. A KV hour-marker
 *  makes it fire once per hour (the first tick of the hour) and skip the rest; the ≤5-min window bounds the
 *  KV reads while tolerating a dropped :00 tick. Set the marker BEFORE running so a slow/overlapping tick
 *  can't double-fire; a run failure is harmless — the per-user notified ledger + the 2-day scoreboard
 *  window mean a later wave re-checks anything missed. `now` flows down so the local-morning filter and the
 *  dry-run route share one clock. */
async function maybeRunPredictResultsPass(env: Env, at?: Date): Promise<void> {
	const now = at ?? new Date();
	if (now.getUTCMinutes() >= 5) return; // one wave per UTC hour; first-5-min window survives a dropped :00 tick
	const hourKey = `predict-pass:${now.getUTCFullYear()}-${now.getUTCMonth() + 1}-${now.getUTCDate()}-${now.getUTCHours()}`;
	if (await env.MATCH_STATE.get(hourKey)) return; // already ran this UTC hour
	await env.MATCH_STATE.put(hourKey, String(now.getTime()), { expirationTtl: 2 * 3600 });
	await runPredictResultsPass(env, now);
}

/** One local-morning wave. `dryRun` runs the full funnel + tz filter and RETURNS what it would send, but
 *  skips the enqueue + the notified-ledger write — the owner's supervised-verify path (mirrors KHG's
 *  publish-verified?dryRun=1). */
async function runPredictResultsPass(
	env: Env,
	now: Date,
	dryRun = false,
): Promise<Array<{ home: string; away: string; predictors: number; qualifyingTokens: number; userIdsWouldMark: string[] }>> {
	const sb = supabaseConfig(env);
	const report: Array<{ home: string; away: string; predictors: number; qualifyingTokens: number; userIdsWouldMark: string[] }> = [];
	let events: ScoreboardEvent[];
	try {
		const res = await env.PROXY.fetch(`${PROXY_SCOREBOARD}?dates=${scoreboardWindow()}&limit=500`, {
			headers: { Accept: "application/json" },
		});
		if (!res.ok) {
			console.log(`[watcher] predict-results scoreboard fetch failed: ${res.status}`);
			return report;
		}
		events = ((await res.json()) as { events?: ScoreboardEvent[] }).events ?? [];
	} catch (err) {
		console.log(`[watcher] predict-results scoreboard threw: ${err}`);
		return report;
	}

	for (const event of events) {
		const match = parseMatch(event);
		if (!match || match.state !== "post" || match.unfinishedPost) continue; // settled finals only
		const eventId = match.eventId;
		// Cheap short-circuit: a fixture nobody predicted never gains predictors after settling, so once we
		// see 0 predictors we skip it for the rest of its window instead of re-funnelling it every wave.
		if (!dryRun && (await env.MATCH_STATE.get(`predict-nopredictors:${eventId}`))) continue;

		let recipients: { tokens: string[]; predictors: number; userIdsToMark: string[] };
		try {
			recipients = await predictResultRecipients(sb, eventId, now);
		} catch (err) {
			// Don't mark anything — a transient Supabase read retries on a later wave (within the window).
			console.log(`[watcher] predict-results lookup failed (${eventId}): ${err}`);
			continue;
		}

		if (dryRun) {
			report.push({ home: match.home.abbr, away: match.away.abbr, predictors: recipients.predictors, qualifyingTokens: recipients.tokens.length, userIdsWouldMark: recipients.userIdsToMark });
			continue;
		}

		if (recipients.predictors === 0) {
			// Nobody predicted this match — mark so we don't re-scan it every wave it's in the window.
			await env.MATCH_STATE.put(`predict-nopredictors:${eventId}`, String(Date.now()), { expirationTtl: 2 * 86400 });
			continue;
		}

		if (recipients.tokens.length > 0) {
			const messages = buildMessages(
				{
					kind: "v1",
					payload: toPredictResultPayload(eventId, match.home.abbr, match.away.abbr),
					apnsTopic: env.APNS_BUNDLE_ID,
					apnsPushType: "alert",
					collapseId: `predict:${eventId}`,
					pruneTable: "device_tokens",
					pruneColumn: "token",
					label: `predict_result ${match.home.abbr} vs ${match.away.abbr}`,
				},
				recipients.tokens,
			);
			await enqueueFanout(env.PUSH_QUEUE, messages);
			// Mark these users notified so later waves (and later days within the window) don't re-push them.
			// Per-(event,user) idempotency; the local-hour gate handles same-day at-most-once.
			await markPredictResultNotified(sb, eventId, recipients.userIdsToMark);
			console.log(
				`[watcher] predict-results ${match.home.abbr} vs ${match.away.abbr}: ` +
					`${recipients.tokens.length} token(s) → ${messages.length} msg(s)`,
			);
		}
		// predictors > 0 but 0 tokens (nobody at their local 10am this wave, or all seen/notified/pref-off):
		// do nothing — a future wave catches users whose local 10am hasn't come yet, bounded by the notified
		// ledger + the ~2-day scoreboard window.
	}
	return report;
}

/** POST /predict-results-run?dryRun=1&atHourUTC=<0-23> — supervised verify for the localized Predict-
 *  results wave. Secret-gated. `dryRun=1` returns the per-fixture cohort (tokens/users it WOULD push) with
 *  NO send + NO ledger write; `atHourUTC` overrides the wave's clock so the owner can simulate any
 *  timezone's 10am wave without waiting for the live tick (e.g. atHourUTC=0 = Sydney's wave). Without
 *  dryRun it runs a REAL wave at the given time — use dryRun for verification. */
async function handlePredictResultsRun(request: Request, url: URL, env: Env): Promise<Response> {
	if (request.headers.get("x-trigger-secret") !== env.MANUAL_TRIGGER_SECRET) {
		return new Response("forbidden", { status: 403 });
	}
	const j = (body: unknown, status = 200) =>
		new Response(JSON.stringify(body, null, 2), { status, headers: { "Content-Type": "application/json" } });

	const now = new Date();
	const atHour = url.searchParams.get("atHourUTC");
	if (atHour !== null) {
		const h = Number(atHour);
		if (!Number.isInteger(h) || h < 0 || h > 23) return j({ error: "atHourUTC must be an integer 0–23" }, 400);
		now.setUTCHours(h, 0, 0, 0);
	}
	const dryRun = url.searchParams.get("dryRun") === "1";
	const fixtures = await runPredictResultsPass(env, now, dryRun);
	return j({ atUTC: now.toISOString(), dryRun, fixtures });
}

/** Run the MONDAY Know Her Game publish AT MOST ONCE per week, at ~10:00 UTC Monday — called every tick.
 *  A cheap weekday+hour check short-circuits all but ~60 ticks/week; a KV week-marker makes it fire once
 *  (the first tick of Monday hour 10) and skip the rest. Set the marker BEFORE running so an overlapping
 *  tick can't double-publish. Calls the proxy's /knowher/publish-verified (via the service binding, with
 *  the publish key); the proxy holds all the logic (stat injection, Lever 1, hold) and diags every outcome,
 *  so a failure here is safe — the last KHG edition simply stays live. No-op if KNOWHER_INGEST_KEY is unset
 *  (the pass isn't armed yet) or if no verified candidate is staged (an off/biweekly week → proxy 404). */
async function maybeRunKnowHerPublishPass(env: Env): Promise<void> {
	const key = env.KNOWHER_INGEST_KEY;
	if (!key) return; // not armed yet (owner sets the secret at the supervised-first-run gate)
	const now = new Date();
	if (now.getUTCDay() !== KNOWHER_PUBLISH_WEEKDAY_UTC || now.getUTCHours() !== KNOWHER_PUBLISH_HOUR_UTC) return;
	const weekMarker = `knowher-publish:${now.getUTCFullYear()}-${now.getUTCMonth() + 1}-${now.getUTCDate()}`;
	if (await env.MATCH_STATE.get(weekMarker)) return; // already ran this Monday
	await env.MATCH_STATE.put(weekMarker, String(now.getTime()), { expirationTtl: 2 * 86400 });
	try {
		const res = await env.PROXY.fetch("https://proxy/knowher/publish-verified", {
			method: "POST",
			headers: { "x-ingest-key": key, "Content-Type": "application/json" },
		});
		const bodyText = await res.text();
		// 200 = published (maybe with Lever-1 flags); 404 = no verified candidate (off week — normal); 409 =
		// held (a player below the floor). All are recorded proxy-side (sdiag); log the status here too so a
		// `wrangler tail` on the watcher shows the Monday outcome at a glance.
		console.log(`[watcher] knowher-publish (${weekMarker}): ${res.status} ${bodyText.slice(0, 160)}`);
	} catch (err) {
		// Binding/network blip — the last edition stays live; next Monday re-tries. (A same-day retry would
		// need re-clearing the marker; a missed Monday is acceptable since the content is biweekly anyway.)
		console.log(`[watcher] knowher-publish threw (${weekMarker}): ${err}`);
	}
}

/** SEPARATE pre-kickoff trigger (NOT detectEvents — lineups aren't on the scoreboard): for matches in
 *  the pre-kickoff window, poll the per-match `/summary` and, the tick BOTH starting XIs are posted, push
 *  a one-shot "Lineups in" alert to everyone with `lineup_posted` on for a participating team. KV-deduped.
 *  `/summary` is fetched CACHE-BUSTED so detection sees ESPN's live state each tick (independent of the
 *  proxy's pre-kickoff TTL), firing within ≤60s of the post. CLUB feeds only (league + cups, via the
 *  merged event list — cup fixtures pass their league slug to /summary); NT feeds stay excluded
 *  (they'd multiply the per-minute /summary fetches). */
async function checkUpcomingLineups(
	env: Env,
	events: ScoreboardEvent[],
	sb: SupabaseConfig,
	apns: ApnsConfig,
	// Source feed per event: cup fixtures need `/summary?league=<slug>` (the proxy's summary is
	// NWSL by default; league param added 2026-08-06). NWSL omits the param — old behavior exactly.
	feedFor: (event: ScoreboardEvent) => string = () => NWSL_FEED,
): Promise<void> {
	const now = Date.now();
	for (const event of events) {
		const ko = kickoffMs(event);
		if (ko === null || ko < now || ko - now > LINEUP_LEAD_MS) continue;
		const info = upcomingInfo(event);
		if (!info) continue;
		const sentKey = `lineup:${info.matchId}`;
		if (await env.MATCH_STATE.get(sentKey)) continue; // already SENT to ≥1 recipient — one-shot, done

		// TWO markers, two concerns (was one, which conflated them): `lineup-pub` = "both XIs are posted"
		// (stops the /summary re-poll once we know it's published); `lineup` (sentKey) = "we actually sent
		// to ≥1 recipient" (the one-shot dedup). Splitting them lets us KEEP retrying the follower lookup
		// after publish — so a 0-recipient tick (a transient Supabase read, or a follower who enabled the
		// alert a beat late) SELF-HEALS next tick instead of being permanently dropped. This mirrors the
		// V2 LA-start's retry-until-sent semantics (startUpcomingActivities); the old mark-fired-even-at-0
		// gave up after ONE empty read, which silently dropped the alert (device-diagnosed 2026-07-18).
		const pubKey = `lineup-pub:${info.matchId}`;
		let published = (await env.MATCH_STATE.get(pubKey)) !== null;
		if (!published) {
			// Cache-busted so we see ESPN's live state, not a cached pre-lineup shell. Cup fixtures
			// carry their league slug; NWSL omits it (proxy default — unchanged old behavior).
			const feed = feedFor(event);
			const leagueParam = feed === NWSL_FEED ? "" : `&league=${encodeURIComponent(feed)}`;
			let summary: unknown;
			try {
				const res = await env.PROXY.fetch(`${PROXY_SUMMARY}?event=${info.matchId}${leagueParam}&_lc=${now}`, {
					headers: { Accept: "application/json" },
				});
				if (!res.ok) {
					// NO SILENT FAILURES: a cup summary that 400s/404s (ESPN may not serve rosters for
					// every competition) must be observable, not a quiet no-lineups-push.
					if (feed !== NWSL_FEED) console.log(`[watcher] DIAG cup lineup summary ${res.status} (${feed}/${info.matchId}) — no lineup push for this match`);
					continue;
				}
				summary = await res.json();
			} catch (err) {
				console.log(`[watcher] lineup summary fetch failed (${info.matchId}): ${err}`);
				continue;
			}
			if (!lineupsPublished(summary as Parameters<typeof lineupsPublished>[0])) continue; // not posted yet — retry next tick
			published = true;
			// Remember publish so later ticks skip the /summary fetch entirely (no new polling load).
			await env.MATCH_STATE.put(pubKey, String(now), { expirationTtl: MATCH_STATE_TTL });
		}

		const lineupEvent: MatchEvent = {
			type: "lineup",
			eventId: info.matchId,
			teamIds: [info.homeId, info.awayId],
			prefColumn: "lineup_posted",
			title: `Lineups in: ${info.homeAbbr} vs ${info.awayAbbr}`,
			subtitle: "Starting XIs are posted",
			homeAbbr: info.homeAbbr,
			awayAbbr: info.awayAbbr,
			homeScore: 0,
			awayScore: 0,
		};

		let recipients;
		try {
			recipients = await resolveTokensForEvent(sb, [info.homeId, info.awayId], "lineup_posted");
		} catch (err) {
			console.log(`[watcher] lineup follower lookup failed (${info.matchId}): ${err}`);
			continue; // don't mark KV — retry next tick so a transient lookup failure doesn't drop the alert
		}
		if (recipients.tokens.length > 0) {
			await enqueueV1(env, lineupEvent, recipients.tokens);
			// SENT ⇒ mark the one-shot dedup so we don't re-alert anyone this match.
			await env.MATCH_STATE.put(sentKey, String(now), { expirationTtl: MATCH_STATE_TTL });
		} else {
			// NO SILENT FAILURES: a 0-recipient publish is only benign when NOBODY follows either team.
			// teamOptIns > 0 with 0 tokens is SUSPICIOUS (a pref off for all, a missing device token, or a
			// transient read) — log the gate breakdown so it's diagnosable, and DON'T mark sentKey: retry
			// next tick (bounded by the pre-kickoff window guard above) so the alert can still land.
			const suspicious = recipients.teamOptIns > 0;
			console.log(
				`[watcher] lineup ${info.homeAbbr} vs ${info.awayAbbr}: published, 0 recipients ` +
					`(teamOptIns=${recipients.teamOptIns}, prefEligible=${recipients.prefEligible})` +
					`${suspicious ? " — SUSPICIOUS (followers exist), retrying within window" : " — no followers, retrying"}`,
			);
		}
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

/** DEBUG: create + delete a broadcast channel FROM THE WORKER to confirm the Worker runtime can reach
 *  the channel-management host/port (production `…:2196`). Returns the create status so a blocked port
 *  (status 0 / network error) is distinguishable from an auth/feature problem. Guarded by the secret. */
async function handleProbeChannel(request: Request, env: Env): Promise<Response> {
	if (request.headers.get("x-trigger-secret") !== env.MANUAL_TRIGGER_SECRET) {
		return new Response("Forbidden.", { status: 403 });
	}
	const apns = apnsConfig(env);
	const created = await createChannelSigned(apns);
	let deleted = false;
	if (created.ok && created.channelId) {
		deleted = await deleteChannel(apns, await apnsJwt(apns), created.channelId);
	}
	const reachable = created.ok || (created.status > 0); // any HTTP reply (even 4xx) means the port was reached
	return new Response(
		JSON.stringify(
			{
				host: apns.host,
				create: { ok: created.ok, status: created.status, channelId: created.channelId, reason: created.reason },
				deleted,
				portReachableFromWorker: reachable,
				note: reachable
					? "Worker reached the manage port ✅ (channel management works from the Worker)"
					: "Worker could NOT reach the manage port (status 0) → flip broadcast.ts seam to the Supabase Edge fallback",
			},
			null,
			2,
		),
		{ status: created.ok ? 200 : 502, headers: { "Content-Type": "application/json" } },
	);
}

/**
 * DEBUG: drive the REAL V2 Broadcast Channel path on demand (no live match needed) — the on-device
 * verification for the broadcast architecture. Guarded by the trigger secret.
 * Body: { mode:"start"|"update"|"end", sandbox?, token?, matchId?, h?, a?, hs?, as?, phase?, min?, sc?, isNational? }.
 *   start  → create a channel, store it under la-chan:{matchId}, push-to-start to the device's start
 *            token(s) carrying input-push-channel (iOS 18 auto-subscribes the Activity to the channel).
 *   update → broadcast a content-state to the channel (Apple fans out to every subscribed Activity).
 *   end    → broadcast an end + delete the channel + clean KV.
 * Token targeting mirrors /test-activity: `token` present → that device's push-to-start token; omitted →
 * all registered start tokens. `sandbox:true` targets the sandbox host + sandbox channel (USB debug build).
 * Defaults to a NATIONAL match (USA vs CAN → flag render); pass isNational:false + h/a club abbrs for a club.
 * On-device sequence: start → wait for the card to appear → update (score) → update (HT) → end.
 */
async function handleTestBroadcast(request: Request, env: Env): Promise<Response> {
	if (request.headers.get("x-trigger-secret") !== env.MANUAL_TRIGGER_SECRET) {
		return new Response("Forbidden.", { status: 403 });
	}
	let p: {
		mode?: "start" | "update" | "end";
		sandbox?: boolean;
		token?: string;
		matchId?: string;
		h?: string;
		a?: string;
		hs?: number;
		as?: number;
		phase?: LivePhase;
		min?: number;
		sc?: string;
		hsc?: string[]; // per-side scorer lines (home) — what the real watcher populates
		asc?: string[]; // per-side scorer lines (away)
		hr?: number; // home red cards
		ar?: number; // away red cards
		isNational?: boolean;
	};
	try {
		p = (await request.json()) as typeof p;
	} catch {
		return new Response("Bad JSON.", { status: 400 });
	}
	const apns = testApnsConfig(env, p.sandbox === true);
	const jwt = await apnsJwt(apns);
	const sb = supabaseConfig(env);
	const nowSec = Math.floor(Date.now() / 1000);
	const mode = p.mode ?? "start";
	const matchId = p.matchId ?? "test-broadcast";
	const chanKey = channelKey(matchId);
	const phase: LivePhase = p.phase ?? "live";
	const running = phase === "live" || phase === "extraTime";
	const state: LiveContentState = {
		homeScore: p.hs ?? 0,
		awayScore: p.as ?? 0,
		phase,
		clockStartEpoch: running ? nowSec - (p.min ?? 1) * 60 : undefined,
		staticLabel: phase === "pre" ? "3:00 PM" : phase === "halftime" ? "HT" : phase === "fulltime" ? "FT" : undefined,
		lastScorer: p.sc,
		broadcast: "Paramount+",
		homeScorers: p.hsc,
		awayScorers: p.asc,
		homeRedCards: p.hr,
		awayRedCards: p.ar,
	};
	const json = (body: unknown, status: number): Response =>
		new Response(JSON.stringify(body, null, 2), { status, headers: { "Content-Type": "application/json" } });

	if (mode === "start") {
		const created = await createChannel(apns, jwt);
		if (!created.ok || !created.channelId) {
			return json({ mode, matchId, host: apns.host, error: `channel create failed: ${created.status} ${created.reason ?? ""}` }, 502);
		}
		await env.MATCH_STATE.put(chanKey, created.channelId, { expirationTtl: MATCH_STATE_TTL });
		const national = p.isNational !== false; // default true — this route is primarily the flag test
		const attrs = attributesFor(matchId, p.h ?? "USA", p.a ?? "CAN", national ? "International" : "NWSL", national);
		// Mirrors the REAL cron start payload (test what you fly): sound "default" = the shipped arrival-buzz value.
		const startAlert = { title: `${p.h ?? "USA"} vs ${p.a ?? "CAN"}`, body: "Live match card is on your lock screen.", sound: "default" };
		let tokens: string[];
		try {
			tokens = p.token ? [p.token] : await allStartTokens(sb);
		} catch (err) {
			return json({ mode, matchId, error: `start-token resolution failed: ${String(err)}` }, 502);
		}
		if (tokens.length === 0) return json({ mode, matchId, channelId: created.channelId, note: "No push-to-start tokens registered." }, 502);
		const results = await Promise.all(tokens.map((t) => startLiveActivity(t, attrs, state, jwt, apns, undefined, startAlert, created.channelId)));
		return json({ mode, matchId, host: apns.host, channelId: created.channelId, tokenCount: tokens.length, okCount: results.filter((r) => r.ok).length, results }, results.some((r) => r.ok) ? 200 : 502);
	}

	const channelId = await env.MATCH_STATE.get(chanKey);
	if (!channelId) return json({ mode, matchId, error: "no channel for this matchId — run mode=start first" }, 409);

	if (mode === "update") {
		const r = await broadcastUpdate(apns, jwt, channelId, state);
		return json({ mode, matchId, host: apns.host, channelId, broadcast: r }, r.ok ? 200 : 502);
	}
	// end
	const r = await broadcastEnd(apns, jwt, channelId, state);
	await deleteChannel(apns, jwt, channelId);
	await env.MATCH_STATE.delete(chanKey);
	return json({ mode, matchId, host: apns.host, channelId, broadcast: r, channelDeleted: true }, r.ok ? 200 : 502);
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
		/** Route to the SANDBOX APNs host for a USB/Xcode debug build (its token is a sandbox token). */
		sandbox?: boolean;
	};
	try {
		payload = (await request.json()) as typeof payload;
	} catch {
		return new Response("Bad JSON.", { status: 400 });
	}
	const apns = testApnsConfig(env, payload.sandbox === true);
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
