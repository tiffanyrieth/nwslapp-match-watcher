/**
 * Supabase reads with the SERVICE-ROLE key — the cross-user lookup the watcher
 * needs and no single user is allowed to do. RLS scopes each app user to their own
 * rows; the service role bypasses RLS, so the Worker can read "every device token of
 * every user who has match alerts ON for team X" to fan a goal out. The service-role
 * key is a full-access secret — it lives only as a `wrangler secret`, never in the app.
 *
 * Plain PostgREST over fetch (the SDK isn't needed for a few selects).
 */

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

const uniq = (xs: string[]): string[] => [...new Set(xs)];
const inList = (xs: string[]): string => `(${xs.join(",")})`;

/** The `notification_preferences` columns the watcher can gate on. */
export type PrefColumn = "kickoff" | "goals" | "halftime" | "full_time";

// Whitelist so the column (interpolated into the PostgREST query) can never be
// anything but a known internal value — these come from our own event types, not
// user input, but the guard keeps it that way.
const PREF_COLUMNS: readonly PrefColumn[] = ["kickoff", "goals", "halftime", "full_time"];

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
	const optedInIds = uniq(alertRows.map((r) => r.user_id));
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
