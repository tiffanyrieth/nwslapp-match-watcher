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

/**
 * Device tokens to push a goal to: users who follow EITHER team in the match and
 * have the `goals` alert enabled. Three small selects, joined in JS:
 *   follows(team_id ∈ teamIds) → user set
 *   notification_preferences(user ∈ set, goals = true) → eligible
 *   device_tokens(user ∈ eligible) → tokens
 * A user with no prefs row (never signed in / synced) is correctly excluded — the
 * app upserts the row on sign-in, and Tier 2 requires sign-in anyway.
 */
export async function tokensForGoal(cfg: SupabaseConfig, teamIds: string[]): Promise<string[]> {
	if (teamIds.length === 0) return [];

	const follows = await rest<{ user_id: string }>(
		cfg,
		`follows?team_id=in.${inList(teamIds)}&select=user_id`,
	);
	const followerIds = uniq(follows.map((r) => r.user_id));
	if (followerIds.length === 0) return [];

	const prefs = await rest<{ user_id: string }>(
		cfg,
		`notification_preferences?user_id=in.${inList(followerIds)}&goals=eq.true&select=user_id`,
	);
	const eligibleIds = uniq(prefs.map((r) => r.user_id));
	if (eligibleIds.length === 0) return [];

	const tokens = await rest<{ token: string }>(
		cfg,
		`device_tokens?user_id=in.${inList(eligibleIds)}&select=token`,
	);
	return uniq(tokens.map((r) => r.token));
}
