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
	if (teamIds.length === 0) return [];
	if (!PREF_COLUMNS.includes(prefColumn)) throw new Error(`Unknown pref column: ${prefColumn}`);

	const alertRows = await rest<{ user_id: string }>(
		cfg,
		`team_alert_preferences?team_id=in.${inList(teamIds)}&alerts_enabled=eq.true&select=user_id`,
	);
	return tokensForUsers(cfg, uniq(alertRows.map((r) => r.user_id)), prefColumn);
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

/** The NATIONAL-TEAM twin of startTokensForTeams (USWNT V2): push-to-start tokens for users who follow
 *  this competition (`competition_alert_preferences.follow_key` = "nt:USA") with alerts ON, have opted IN
 *  to Live Activities, and registered a push-to-start token. Same two-gate + token-resolve tail. */
export async function startTokensForCompetition(cfg: SupabaseConfig, followKey: string): Promise<string[]> {
	const alertRows = await rest<{ user_id: string }>(
		cfg,
		`competition_alert_preferences?follow_key=in.${inListQuoted([followKey])}&alerts_enabled=eq.true&select=user_id`,
	);
	const ids = uniq(alertRows.map((r) => r.user_id));
	if (ids.length === 0) return [];
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
