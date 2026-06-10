/**
 * Goal detection — the pure, testable core of the match-watcher.
 *
 * The watcher polls the season scoreboard once a minute and diffs each LIVE
 * match's score against the last-known state in KV. A side whose score went up
 * since the previous poll scored a goal. Keeping this logic pure (no network, no
 * KV, no clock) makes it unit-testable in isolation — index.ts handles the I/O.
 */

/** The slice of an ESPN scoreboard event we read (everything optional — ESPN is unofficial). */
export interface ScoreboardEvent {
	id: string;
	status?: { type?: { state?: string } };
	competitions?: Array<{
		competitors?: Array<{
			homeAway?: string;
			score?: string; // ESPN sends the score as a String ("0"), not a number.
			team?: { id?: string; abbreviation?: string; displayName?: string };
		}>;
	}>;
}

/** One side of a parsed live match. */
export interface Side {
	id: string;
	abbr: string;
	name: string;
	score: number;
}

/** A live match reduced to what we need to detect + describe goals. */
export interface LiveMatch {
	eventId: string;
	home: Side;
	away: Side;
}

/** The shape we persist per match in KV between polls. */
export interface StoredState {
	home: { id: string; score: number };
	away: { id: string; score: number };
}

/** A detected goal, carrying everything needed to compose the push + find followers. */
export interface GoalEvent {
	eventId: string;
	/** Team id of the side that scored — for the "{Team} scored" body. */
	scoringTeamId: string;
	scoringTeamName: string;
	/** Both teams' ids — a goal in your team's match matters whether they scored or conceded. */
	teamIds: string[];
	homeAbbr: string;
	awayAbbr: string;
	homeScore: number;
	awayScore: number;
}

function toScore(raw?: string): number {
	const n = parseInt(raw ?? "0", 10);
	return Number.isFinite(n) ? n : 0;
}

/**
 * Reduce an event to a LiveMatch, or null if it isn't a usable live match.
 * Requires state === "in" and both teams' ids (we key followers by team id).
 */
export function parseLiveMatch(event: ScoreboardEvent): LiveMatch | null {
	if (event.status?.type?.state !== "in") return null;
	const competitors = event.competitions?.[0]?.competitors ?? [];
	const home = competitors.find((c) => c.homeAway === "home");
	const away = competitors.find((c) => c.homeAway === "away");
	if (!home?.team?.id || !away?.team?.id) return null;
	return {
		eventId: event.id,
		home: {
			id: home.team.id,
			abbr: home.team.abbreviation ?? "",
			name: home.team.displayName ?? home.team.abbreviation ?? "",
			score: toScore(home.score),
		},
		away: {
			id: away.team.id,
			abbr: away.team.abbreviation ?? "",
			name: away.team.displayName ?? away.team.abbreviation ?? "",
			score: toScore(away.score),
		},
	};
}

/** The state to persist for `match` after this poll. */
export function stateOf(match: LiveMatch): StoredState {
	return {
		home: { id: match.home.id, score: match.home.score },
		away: { id: match.away.id, score: match.away.score },
	};
}

/**
 * Compare the previous stored state to the current live match and emit a goal for
 * each side whose score rose. First sighting (prev === null) only establishes a
 * baseline — no goal — so a match already in progress when the watcher first sees
 * it doesn't fire for the existing score. A multi-goal jump between polls (we
 * missed a tick) yields one goal carrying the current scoreline, not N pushes.
 */
export function detectGoals(prev: StoredState | null, match: LiveMatch): GoalEvent[] {
	if (!prev) return [];
	const goals: GoalEvent[] = [];
	const both = [match.home.id, match.away.id];

	const base = {
		eventId: match.eventId,
		teamIds: both,
		homeAbbr: match.home.abbr,
		awayAbbr: match.away.abbr,
		homeScore: match.home.score,
		awayScore: match.away.score,
	};

	if (match.home.score > prev.home.score) {
		goals.push({ ...base, scoringTeamId: match.home.id, scoringTeamName: match.home.name });
	}
	if (match.away.score > prev.away.score) {
		goals.push({ ...base, scoringTeamId: match.away.id, scoringTeamName: match.away.name });
	}
	return goals;
}

/** The APNs payload for a goal. Two teams together → abbreviations (the app-wide naming rule). */
export function goalPayload(goal: GoalEvent): Record<string, unknown> {
	return {
		aps: {
			alert: {
				title: `GOAL — ${goal.homeAbbr} ${goal.homeScore}–${goal.awayScore} ${goal.awayAbbr}`,
				body: `${goal.scoringTeamName} scored`,
			},
			sound: "default",
			"thread-id": goal.eventId,
		},
		// Custom key the iOS AppDelegate reads to deep-link into the match on tap.
		eventID: goal.eventId,
	};
}
