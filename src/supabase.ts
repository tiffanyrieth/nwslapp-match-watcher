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
