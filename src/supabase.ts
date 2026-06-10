/**
 * Supabase reads with the SERVICE-ROLE key — the cross-user lookup the watcher
 * needs and no single user is allowed to do. RLS scopes each app user to their own
 * rows; the service role bypasses RLS, so the Worker can read "every device token
 * of every user who follows team X" to fan a goal out. The service-role key is a
 * full-access secret — it lives only as a `wrangler secret`, never in the app.
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
 * Device tokens to push an event to: users who follow EITHER team in the match and
 * have the alert for this event type (`prefColumn`) enabled. Three small selects,
 * joined in JS:
 *   follows(team_id ∈ teamIds) → user set
 *   notification_preferences(user ∈ set, {prefColumn} = true) → eligible
 *   device_tokens(user ∈ eligible) → tokens
 * A user with no prefs row (never signed in / synced) is correctly excluded — the
 * app upserts the row on sign-in, and Tier 2 requires sign-in anyway.
 */
export async function tokensForEvent(
	cfg: SupabaseConfig,
	teamIds: string[],
	prefColumn: PrefColumn,
): Promise<string[]> {
	if (teamIds.length === 0) return [];
	if (!PREF_COLUMNS.includes(prefColumn)) throw new Error(`Unknown pref column: ${prefColumn}`);

	const follows = await rest<{ user_id: string }>(
		cfg,
		`follows?team_id=in.${inList(teamIds)}&select=user_id`,
	);
	const followerIds = uniq(follows.map((r) => r.user_id));
	if (followerIds.length === 0) return [];

	const prefs = await rest<{ user_id: string }>(
		cfg,
		`notification_preferences?user_id=in.${inList(followerIds)}&${prefColumn}=eq.true&select=user_id`,
	);
	const eligibleIds = uniq(prefs.map((r) => r.user_id));
	if (eligibleIds.length === 0) return [];

	const tokens = await rest<{ token: string }>(
		cfg,
		`device_tokens?user_id=in.${inList(eligibleIds)}&select=token`,
	);
	return uniq(tokens.map((r) => r.token));
}
