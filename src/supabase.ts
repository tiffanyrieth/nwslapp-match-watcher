/**
 * Supabase reads with the SERVICE-ROLE key — the cross-user lookup the watcher
 * needs and no single user is allowed to do. RLS scopes each app user to their own
 * rows; the service role bypasses RLS, so the Worker can read "every device token of
 * every user who has match alerts ON for team X" to fan a goal out. The service-role
 * key is a full-access secret — it lives only as a `wrangler secret`, never in the app.
 *
 * Plain PostgREST over fetch (the SDK isn't needed for a few selects).
 */

import type { ApnsResult } from "./apns";

export interface SupabaseConfig {
	url: string; // e.g. https://abcd.supabase.co
	serviceRoleKey: string;
}

async function rest<T>(cfg: SupabaseConfig, pathAndQuery: string): Promise<T[]> {
	const res = await fetch(`${cfg.url}/rest/v1/${pathAndQuery}`, {
		headers: {
			apikey: cfg.serviceRoleKey,
			authorization: `Bearer ${cfg.serviceRoleKey}`,
		},
	});
	if (!res.ok) {
		throw new Error(`Supabase ${res.status}: ${await res.text()}`);
	}
	return (await res.json()) as T[];
}

/** DELETE via PostgREST (service-role bypasses RLS). No return — a 204 No Content has no body. */
async function restDelete(cfg: SupabaseConfig, pathAndQuery: string): Promise<void> {
	const res = await fetch(`${cfg.url}/rest/v1/${pathAndQuery}`, {
		method: "DELETE",
		headers: {
			apikey: cfg.serviceRoleKey,
			authorization: `Bearer ${cfg.serviceRoleKey}`,
		},
	});
	if (!res.ok) {
		throw new Error(`Supabase DELETE ${res.status}: ${await res.text()}`);
	}
}

/** INSERT via PostgREST (service-role). `resolution=ignore-duplicates` makes re-inserting an existing PK a
 *  no-op, so a retried/overlapping wave is idempotent; `return=minimal` asks for no body back. */
async function restInsert(cfg: SupabaseConfig, table: string, rows: unknown[]): Promise<void> {
	if (rows.length === 0) return;
	const res = await fetch(`${cfg.url}/rest/v1/${table}`, {
		method: "POST",
		headers: {
			apikey: cfg.serviceRoleKey,
			authorization: `Bearer ${cfg.serviceRoleKey}`,
			"content-type": "application/json",
			Prefer: "resolution=ignore-duplicates,return=minimal",
		},
		body: JSON.stringify(rows),
	});
	if (!res.ok) {
		throw new Error(`Supabase INSERT ${res.status}: ${await res.text()}`);
	}
}

const uniq = (xs: string[]): string[] => [...new Set(xs)];
const inList = (xs: string[]): string => `(${xs.join(",")})`;
// Quoted variant for string keys that may contain PostgREST-special chars (the national-team
// follow keys are "nt:USA" — the colon is safe quoted). Our own values, so no escaping needed.
const inListQuoted = (xs: string[]): string => `(${xs.map((x) => `"${x}"`).join(",")})`;

/**
 * Delete tokens APNs told us are dead — the feedback loop Apple intends (otherwise dead rows accumulate
 * and the watcher keeps fanning out to zombies). A token is dead when APNs returns 410 Unregistered
 * (app uninstalled) or 400 BadDeviceToken (malformed / wrong environment). NOT status 0 (a transient
 * network error is not a dead token). `column` varies per table: `device_tokens` /
 * `live_activity_start_tokens` key on `token`; `live_activities` on `push_token`. Non-fatal — a prune
 * failure is logged loud and never blocks the send that triggered it.
 */
export async function pruneDeadTokens(
	cfg: SupabaseConfig,
	table: string,
	column: string,
	results: ApnsResult[],
): Promise<void> {
	const dead = uniq(
		results
			.filter((r) => !r.ok && (r.status === 410 || (r.status === 400 && r.reason === "BadDeviceToken")))
			.map((r) => r.token),
	);
	if (dead.length === 0) return;
	try {
		await restDelete(cfg, `${table}?${column}=in.${inListQuoted(dead)}`);
		console.log(`[watcher] pruned ${dead.length} dead token(s) from ${table}`);
	} catch (err) {
		console.log(`[watcher] prune ${table} failed: ${err}`);
	}
}

/** The `notification_preferences` columns the watcher can gate on. */
export type PrefColumn = "kickoff" | "goals" | "halftime" | "full_time" | "lineup_posted";

// Whitelist so the column (interpolated into the PostgREST query) can never be
// anything but a known internal value — these come from our own event types, not
// user input, but the guard keeps it that way.
const PREF_COLUMNS: readonly PrefColumn[] = ["kickoff", "goals", "halftime", "full_time", "lineup_posted"];

/**
 * Device tokens to push an event to: users who have match alerts turned ON for EITHER
 * team in the match (the per-team bell) AND have the alert for this event type
 * (`prefColumn`) enabled (the global type toggle). Two gates, three small selects
 * joined in JS:
 *   team_alert_preferences(team_id ∈ teamIds, alerts_enabled = true) → opted-in users
 *   notification_preferences(user ∈ set, {prefColumn} = true)        → eligible
 *   device_tokens(user ∈ eligible)                                   → tokens
 * Per-team is the precise signal (the app only sets alerts_enabled for a followed team
 * and clears it on unfollow), so this targets exactly who asked for THIS team's alerts
 * — not every follower. A user with no row in either table (never signed in / synced)
 * is correctly excluded; the app upserts both on sign-in, and Tier 2 requires sign-in.
 */
export async function tokensForEvent(
	cfg: SupabaseConfig,
	teamIds: string[],
	prefColumn: PrefColumn,
): Promise<string[]> {
	return (await resolveTokensForEvent(cfg, teamIds, prefColumn)).tokens;
}

/** The gate-by-gate result of the per-event fan-out lookup: the final `tokens`, plus the intermediate
 *  opt-in counts. The counts exist ONLY for diagnostics (NO SILENT FAILURES): when `tokens` is empty,
 *  they say WHY — `teamOptIns === 0` is the benign "nobody follows either team", whereas
 *  `teamOptIns > 0 && tokens.length === 0` is the SUSPICIOUS zero (followers exist but the pref/token
 *  gate emptied them — a pref toggled off, a missing device token, or a transient read). */
export interface FanoutResolution {
	tokens: string[];
	/** Users with alerts ON for either team (team_alert_preferences gate). */
	teamOptIns: number;
	/** …of those, users with THIS event type's pref column ON (notification_preferences gate). */
	prefEligible: number;
}

export async function resolveTokensForEvent(
	cfg: SupabaseConfig,
	teamIds: string[],
	prefColumn: PrefColumn,
): Promise<FanoutResolution> {
	if (teamIds.length === 0) return { tokens: [], teamOptIns: 0, prefEligible: 0 };
	if (!PREF_COLUMNS.includes(prefColumn)) throw new Error(`Unknown pref column: ${prefColumn}`);

	const alertRows = await rest<{ user_id: string }>(
		cfg,
		`team_alert_preferences?team_id=in.${inList(teamIds)}&alerts_enabled=eq.true&select=user_id`,
	);
	const optedInIds = uniq(alertRows.map((r) => r.user_id));
	if (optedInIds.length === 0) return { tokens: [], teamOptIns: 0, prefEligible: 0 };

	const prefRows = await rest<{ user_id: string }>(
		cfg,
		`notification_preferences?user_id=in.${inList(optedInIds)}&${prefColumn}=eq.true&select=user_id`,
	);
	const eligibleIds = uniq(prefRows.map((r) => r.user_id));
	if (eligibleIds.length === 0) return { tokens: [], teamOptIns: optedInIds.length, prefEligible: 0 };

	const tokenRows = await rest<{ token: string }>(
		cfg,
		`device_tokens?user_id=in.${inList(eligibleIds)}&select=token`,
	);
	return { tokens: uniq(tokenRows.map((r) => r.token)), teamOptIns: optedInIds.length, prefEligible: eligibleIds.length };
}

/** One detected event's fan-out request for the BATCHED club lookup. `id` is the caller's unique tag
 *  (e.g. `${eventId}:${type}`) used to read the tokens back out of the returned map. */
export interface EventTokenRequest {
	id: string;
	teamIds: string[];
	prefColumn: PrefColumn;
}

/** BATCHED club per-event V1 fan-out: exactly 3 external REST calls per DISTINCT pref column per tick,
 *  regardless of how many matches fire that event type together — replacing the old per-event
 *  `tokensForEvent` (3 REST × E events), whose unbatched shape breaches the 50-external subrequest
 *  budget on an 8-match Decision-Day kickoff/HT cluster (docs/stress-testing.md §7, subrequest row).
 *  Mirrors startTokensByCompetitionKey; the pure partition tail (partitionEventTokens) is node-tested.
 *  Returns each request's `id` → its uniq'd device tokens — SEMANTICALLY IDENTICAL to calling
 *  resolveTokensForEvent per event (either-team OR, then the pref + token gates). */
export async function resolveTokensBatch(
	cfg: SupabaseConfig,
	requests: EventTokenRequest[],
): Promise<Map<string, string[]>> {
	const out = new Map<string, string[]>();
	if (requests.length === 0) return out;
	// One 3-REST batch per distinct pref column (each column needs its own notification_preferences gate);
	// ≤5 columns ⇒ ≤15 REST worst case vs 3×E unbatched.
	const byPref = new Map<PrefColumn, EventTokenRequest[]>();
	for (const r of requests) {
		if (!PREF_COLUMNS.includes(r.prefColumn)) throw new Error(`Unknown pref column: ${r.prefColumn}`);
		const g = byPref.get(r.prefColumn);
		if (g) g.push(r);
		else byPref.set(r.prefColumn, [r]);
	}
	for (const [prefColumn, group] of byPref) {
		const teamIds = uniq(group.flatMap((r) => r.teamIds));
		if (teamIds.length === 0) {
			for (const r of group) out.set(r.id, []);
			continue;
		}
		const alertRows = await rest<{ user_id: string; team_id: string }>(
			cfg,
			`team_alert_preferences?team_id=in.${inList(teamIds)}&alerts_enabled=eq.true&select=user_id,team_id`,
		);
		const optedIds = uniq(alertRows.map((r) => r.user_id));
		if (optedIds.length === 0) {
			for (const r of group) out.set(r.id, []);
			continue;
		}
		const prefRows = await rest<{ user_id: string }>(
			cfg,
			`notification_preferences?user_id=in.${inList(optedIds)}&${prefColumn}=eq.true&select=user_id`,
		);
		const eligibleIds = uniq(prefRows.map((r) => r.user_id));
		if (eligibleIds.length === 0) {
			for (const r of group) out.set(r.id, []);
			continue;
		}
		const tokenRows = await rest<{ user_id: string; token: string }>(
			cfg,
			`device_tokens?user_id=in.${inList(eligibleIds)}&select=user_id,token`,
		);
		partitionEventTokens(group, alertRows, eligibleIds, tokenRows, out);
	}
	return out;
}

/** Pure partition tail of resolveTokensBatch (split out for node --test): for each request, the uniq'd
 *  device tokens of ELIGIBLE users (pref column ON) who opted into ANY of its teamIds. A user following
 *  both teams of a match is counted once (Set). Mutates + returns `out`. */
export function partitionEventTokens(
	requests: EventTokenRequest[],
	alertRows: Array<{ user_id: string; team_id: string }>,
	eligibleIds: string[],
	tokenRows: Array<{ user_id: string; token: string }>,
	out: Map<string, string[]> = new Map(),
): Map<string, string[]> {
	const eligible = new Set(eligibleIds);
	const tokensByUser = new Map<string, string[]>();
	for (const t of tokenRows) {
		const arr = tokensByUser.get(t.user_id);
		if (arr) arr.push(t.token);
		else tokensByUser.set(t.user_id, [t.token]);
	}
	const usersByTeam = new Map<string, Set<string>>();
	for (const a of alertRows) {
		if (!eligible.has(a.user_id)) continue;
		const s = usersByTeam.get(a.team_id);
		if (s) s.add(a.user_id);
		else usersByTeam.set(a.team_id, new Set([a.user_id]));
	}
	for (const req of requests) {
		const users = new Set<string>();
		for (const tid of req.teamIds) for (const u of usersByTeam.get(tid) ?? []) users.add(u);
		const toks: string[] = [];
		for (const u of users) for (const t of tokensByUser.get(u) ?? []) toks.push(t);
		out.set(req.id, uniq(toks));
	}
	return out;
}

// The Predict-results push lands at each fan's LOCAL morning, not a single UTC instant — NWSL is
// worldwide, so a fixed hour is midnight for someone. Target = 10:00 local (matches the KHG anchor and
// this push's original "≈10am ET" intent). ⚠️ Keep the target clear of 01:00–03:00 local: DST
// spring-forward skips that wall-clock hour, so a target inside it would give affected zones ZERO
// qualifying waves that day. 10:00 is safe.
export const PREDICT_RESULTS_LOCAL_HOUR = 10;
// Devices with no stored timezone (an un-migrated app build, or a bad id) fall back to this fixed UTC
// hour — byte-for-byte the old behaviour, so the rollout is deploy-order-safe and converges as apps update.
export const LEGACY_PREDICT_HOUR_UTC = 14;

/** True iff a scheduled push for a device in `timezone` should fire in the wave for `now` — i.e. its LOCAL
 *  hour equals `targetHour`. A missing/blank/garbage tz falls back to the legacy fixed 14:00-UTC send.
 *  Never throws: a malformed IANA id degrades to the fallback rather than sinking the whole wave. Pure +
 *  injectable, so it's unit-tested with `node --test` (the watcher's vitest-pool-workers is broken on Node 26). */
export function qualifiesForLocalMorning(
	timezone: string | null | undefined,
	now: Date,
	targetHour: number = PREDICT_RESULTS_LOCAL_HOUR,
): boolean {
	if (!timezone) return now.getUTCHours() === LEGACY_PREDICT_HOUR_UTC;
	try {
		// hourCycle "h23" → "00".."23" (avoids en-US's "24" for midnight); parse to a number to compare.
		const localHour = Number(
			new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "2-digit", hourCycle: "h23" }).format(now),
		);
		return localHour === targetHour;
	} catch {
		return now.getUTCHours() === LEGACY_PREDICT_HOUR_UTC;
	}
}

/** Recipients for the post-match "your Predict result is in" push, for the wave at `now`. UNLIKE the
 *  live-event fan-out, there is NO team-alert gate — PREDICTING the match is itself the opt-in. Gates:
 *    predict_submission_marks(event_id = eventId)            → who predicted this match
 *    MINUS predict_result_seen(event_id = eventId)           → drop anyone who already viewed their result
 *    MINUS predict_result_notified(event_id = eventId)       → drop anyone we already PUSHED (across-wave dedupe)
 *    notification_preferences(user ∈ set, predict_results)   → …who opted into this push
 *    device_tokens(user ∈ eligible), filtered to devices at their LOCAL 10am now → tokens
 *  `predictors` drives the caller's 0-predictors short-circuit; `userIdsToMark` is who to write to the
 *  notified ledger after a send. All service_role reads (RLS-bypassing + explicit grants). */
export async function predictResultRecipients(
	cfg: SupabaseConfig,
	eventId: string,
	now: Date,
): Promise<{ tokens: string[]; predictors: number; userIdsToMark: string[] }> {
	const empty = (predictors: number) => ({ tokens: [], predictors, userIdsToMark: [] });

	const predictorRows = await rest<{ user_id: string }>(
		cfg,
		`predict_submission_marks?event_id=eq.${eventId}&select=user_id`,
	);
	const predictorIds = uniq(predictorRows.map((r) => r.user_id));
	if (predictorIds.length === 0) return empty(0);

	// Drop anyone who already opened their result in-app (the push exists to catch people who DIDN'T look)
	// AND anyone we've already pushed for this fixture. The notified subtraction is what makes the hourly
	// wave safe: without it a user would be re-pushed at every day's local-10am wave within the window.
	const [seenRows, notifiedRows] = await Promise.all([
		rest<{ user_id: string }>(cfg, `predict_result_seen?event_id=eq.${eventId}&select=user_id`),
		rest<{ user_id: string }>(cfg, `predict_result_notified?event_id=eq.${eventId}&select=user_id`),
	]);
	const done = new Set([...seenRows, ...notifiedRows].map((r) => r.user_id));
	const remainingIds = predictorIds.filter((id) => !done.has(id));
	if (remainingIds.length === 0) return empty(predictorIds.length);

	const prefRows = await rest<{ user_id: string }>(
		cfg,
		`notification_preferences?user_id=in.${inList(remainingIds)}&predict_results=eq.true&select=user_id`,
	);
	const eligibleIds = uniq(prefRows.map((r) => r.user_id));
	if (eligibleIds.length === 0) return empty(predictorIds.length);

	const deviceRows = await rest<{ user_id: string; token: string; timezone: string | null }>(
		cfg,
		`device_tokens?user_id=in.${inList(eligibleIds)}&select=user_id,token,timezone`,
	);
	// Keep only devices whose LOCAL time is the target morning hour in THIS wave. A user is marked notified
	// once any of their devices qualifies, so a multi-timezone user gets one push at their earliest 10am.
	const qualifying = deviceRows.filter((r) => qualifiesForLocalMorning(r.timezone, now));
	return {
		tokens: uniq(qualifying.map((r) => r.token)),
		predictors: predictorIds.length,
		userIdsToMark: uniq(qualifying.map((r) => r.user_id)),
	};
}

/** Mark users as pushed for a fixture — the per-(event,user) idempotency ledger the hourly wave relies on
 *  to not re-push across days within the scoreboard window. Idempotent (PK + ignore-duplicates). */
export async function markPredictResultNotified(
	cfg: SupabaseConfig,
	eventId: string,
	userIds: string[],
): Promise<void> {
	await restInsert(
		cfg,
		"predict_result_notified",
		uniq(userIds).map((user_id) => ({ event_id: eventId, user_id })),
	);
}

/** The NATIONAL-TEAM twin of tokensForEvent: same two gates, but the per-team opt-in comes from
 *  `competition_alert_preferences` (keyed by follow_key "nt:USA"), which the app writes when a user
 *  turns on a national team's bell. The watcher passes the match's two FIFA codes as follow keys. */
export async function tokensForCompetitionEvent(
	cfg: SupabaseConfig,
	followKeys: string[],
	prefColumn: PrefColumn,
): Promise<string[]> {
	if (followKeys.length === 0) return [];
	if (!PREF_COLUMNS.includes(prefColumn)) throw new Error(`Unknown pref column: ${prefColumn}`);

	const alertRows = await rest<{ user_id: string }>(
		cfg,
		`competition_alert_preferences?follow_key=in.${inListQuoted(followKeys)}&alerts_enabled=eq.true&select=user_id`,
	);
	return tokensForUsers(cfg, uniq(alertRows.map((r) => r.user_id)), prefColumn);
}

/** Shared tail of the fan-out: given the per-team opted-in user ids, gate by the per-event pref
 *  column (the global type toggle) and resolve device tokens. */
async function tokensForUsers(cfg: SupabaseConfig, optedInIds: string[], prefColumn: PrefColumn): Promise<string[]> {
	if (optedInIds.length === 0) return [];

	const prefs = await rest<{ user_id: string }>(
		cfg,
		`notification_preferences?user_id=in.${inList(optedInIds)}&${prefColumn}=eq.true&select=user_id`,
	);
	const eligibleIds = uniq(prefs.map((r) => r.user_id));
	if (eligibleIds.length === 0) return [];

	const tokens = await rest<{ token: string }>(
		cfg,
		`device_tokens?user_id=in.${inList(eligibleIds)}&select=token`,
	);
	return uniq(tokens.map((r) => r.token));
}

// ── V2 Live Activity tokens ──────────────────────────────────────────────────
// The Live Activity is the persistent "glance" surface for the WHOLE match, so it's gated only on the
// per-team bell (team_alert_preferences.alerts_enabled) — NOT the per-event notification_preferences
// columns (those gate individual V1 pushes). One opt-in (notifications ON) drives both layers (spec §00b).

/** Per-Activity UPDATE tokens for a match (live_activities) — the running Activities to update/end. */
export async function activityTokensForMatch(cfg: SupabaseConfig, matchId: string): Promise<string[]> {
	const rows = await rest<{ push_token: string }>(
		cfg,
		`live_activities?match_id=eq.${encodeURIComponent(matchId)}&select=push_token`,
	);
	return uniq(rows.map((r) => r.push_token));
}

/** EVERY registered V1 device token, unfiltered. Used ONLY by the manual /test-push fan-out (a synthetic
 *  test match has no team_alert_preferences rows, so the normal tokensForEvent gate can't apply). */
export async function allDeviceTokens(cfg: SupabaseConfig): Promise<string[]> {
	const rows = await rest<{ token: string }>(cfg, `device_tokens?select=token`);
	return uniq(rows.map((r) => r.token));
}

/** EVERY registered push-to-start token, unfiltered by team. Used ONLY by the manual replay/test path:
 *  a synthetic match has no team_alert_preferences rows, so the per-team gate `startTokensForTeams`
 *  uses can't apply — the test tool deliberately fans out to all devices. Not used by the cron. */
export async function allStartTokens(cfg: SupabaseConfig): Promise<string[]> {
	const rows = await rest<{ token: string }>(cfg, `live_activity_start_tokens?select=token`);
	return uniq(rows.map((r) => r.token));
}

/** Push-to-START tokens to remote-create a Live Activity: users with match alerts ON for EITHER team
 *  who have explicitly opted IN to Live Activities (notification_preferences.live_activities_enabled = true)
 *  and who have registered an ActivityKit push-to-start token (live_activity_start_tokens). */
export async function startTokensForTeams(cfg: SupabaseConfig, teamIds: string[]): Promise<string[]> {
	if (teamIds.length === 0) return [];
	const alertRows = await rest<{ user_id: string }>(
		cfg,
		`team_alert_preferences?team_id=in.${inList(teamIds)}&alerts_enabled=eq.true&select=user_id`,
	);
	const ids = uniq(alertRows.map((r) => r.user_id));
	if (ids.length === 0) return [];
	// Keep only users who EXPLICITLY opted IN to the V2 Live Activity. It's a Tier-2 opt-in (default off),
	// so require an explicit `live_activities_enabled = true` — a user with no row counts as OFF (same
	// pattern as tokensForEvent's per-event gate). Server-side gate: the app keeps its push-to-start token
	// registered regardless, so re-enabling is instant.
	const prefRows = await rest<{ user_id: string }>(
		cfg,
		`notification_preferences?user_id=in.${inList(ids)}&live_activities_enabled=eq.true&select=user_id`,
	);
	const enabledIds = uniq(prefRows.map((r) => r.user_id));
	if (enabledIds.length === 0) return [];
	const rows = await rest<{ token: string }>(
		cfg,
		`live_activity_start_tokens?user_id=in.${inList(enabledIds)}&select=token`,
	);
	return uniq(rows.map((r) => r.token));
}

/** The NATIONAL-TEAM twin of startTokensForTeams, BATCHED across every match starting this tick
 *  (all-NT V2 LA, 2026-08-06): push-to-start tokens for users following ANY of `followKeys`
 *  ("nt:JPN", "nt:ZAM", …) with alerts ON, Live Activities opted IN, and a registered token —
 *  grouped per follow key so the caller can target each match's audience.
 *  ⚠️ STRESS-GATE REQUIREMENT (docs/stress-testing.md §7, all-NT entry): exactly 3 external REST
 *  calls PER TICK regardless of how many NT matches share a kickoff cluster — the old unbatched
 *  per-match shape (3 × N) breaches the 50-external budget at an 8-match FIFA-window cluster. */
export async function startTokensByCompetitionKey(cfg: SupabaseConfig, followKeys: string[]): Promise<Map<string, string[]>> {
	if (followKeys.length === 0) return new Map();
	const alertRows = await rest<{ user_id: string; follow_key: string }>(
		cfg,
		`competition_alert_preferences?follow_key=in.${inListQuoted(followKeys)}&alerts_enabled=eq.true&select=user_id,follow_key`,
	);
	const ids = uniq(alertRows.map((r) => r.user_id));
	if (ids.length === 0) return new Map();
	const prefRows = await rest<{ user_id: string }>(
		cfg,
		`notification_preferences?user_id=in.${inList(ids)}&live_activities_enabled=eq.true&select=user_id`,
	);
	const enabledIds = uniq(prefRows.map((r) => r.user_id));
	if (enabledIds.length === 0) return new Map();
	const tokenRows = await rest<{ user_id: string; token: string }>(
		cfg,
		`live_activity_start_tokens?user_id=in.${inList(enabledIds)}&select=user_id,token`,
	);
	return groupStartTokensByKey(alertRows, enabledIds, tokenRows);
}

/** Pure grouping tail of startTokensByCompetitionKey (split out for node --test): follow_key →
 *  uniq'd tokens of its LA-enabled followers. A user following both sides of one match appears
 *  under both keys — the CALLER unions + uniqs per match so nobody is double-pushed. */
export function groupStartTokensByKey(
	alertRows: Array<{ user_id: string; follow_key: string }>,
	enabledIds: string[],
	tokenRows: Array<{ user_id: string; token: string }>,
): Map<string, string[]> {
	const enabled = new Set(enabledIds);
	const tokensByUser = new Map<string, string[]>();
	for (const t of tokenRows) {
		if (!tokensByUser.has(t.user_id)) tokensByUser.set(t.user_id, []);
		tokensByUser.get(t.user_id)!.push(t.token);
	}
	const out = new Map<string, string[]>();
	for (const a of alertRows) {
		if (!enabled.has(a.user_id)) continue;
		const toks = tokensByUser.get(a.user_id);
		if (!toks) continue;
		if (!out.has(a.follow_key)) out.set(a.follow_key, []);
		out.get(a.follow_key)!.push(...toks);
	}
	for (const [k, v] of out) out.set(k, uniq(v));
	return out;
}
