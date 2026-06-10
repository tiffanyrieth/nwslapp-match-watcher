/**
 * Match-event detection — the pure, testable core of the watcher.
 *
 * Each minute the watcher polls the season scoreboard and, for every match in the
 * live window, diffs its current snapshot against the last-known state in KV. From
 * that diff it emits the live events we push:
 *
 *   - kickoff   — match just went live (state → "in", 1st minute)
 *   - goal      — a side's score rose
 *   - halftime  — status is STATUS_HALFTIME (fired once)
 *   - fulltime  — match just ended (state "in" → "post")
 *
 * Substitutions + lineup-posted are NOT here: the scoreboard `details` array
 * carries goals and cards but no subs, and lineups aren't on the scoreboard at all
 * — both need the per-match `/summary` endpoint (Stage D).
 *
 * Keeping this pure (no network, no KV, no wall clock) makes it unit-testable;
 * index.ts owns the I/O and decides which matches are in the live window.
 */

/** The slice of an ESPN scoreboard event we read (all optional — ESPN is unofficial). */
export interface ScoreboardEvent {
	id: string;
	date?: string;
	status?: EventStatus;
	competitions?: Array<{
		status?: EventStatus;
		competitors?: Array<{
			homeAway?: string;
			score?: string; // ESPN sends the score as a String ("0"), not a number.
			team?: { id?: string; abbreviation?: string; displayName?: string };
		}>;
	}>;
}

interface EventStatus {
	period?: number;
	clock?: number; // seconds elapsed
	type?: { state?: string; name?: string }; // state: pre|in|post; name: STATUS_*
}

/** One side of a parsed match. */
export interface Side {
	id: string;
	abbr: string;
	name: string;
	score: number;
}

/** A match reduced to what we need to detect + describe events. */
export interface Match {
	eventId: string;
	home: Side;
	away: Side;
	state: string; // "in" | "post"
	statusName: string; // STATUS_*
	period: number;
	clock: number;
}

/** What we persist per match in KV between polls. */
export interface StoredState {
	home: { id: string; score: number };
	away: { id: string; score: number };
	state: string;
	halftimeSent: boolean;
}

export type MatchEventType = "kickoff" | "goal" | "halftime" | "fulltime";

/** A detected event, carrying everything to find followers + compose the push. */
export interface MatchEvent {
	type: MatchEventType;
	eventId: string;
	/** Both teams' ids — a live event in your team's match matters either way. */
	teamIds: string[];
	/** The `notification_preferences` column that gates delivery. */
	prefColumn: "kickoff" | "goals" | "halftime" | "full_time";
	title: string;
	body: string;
}

function toScore(raw?: string): number {
	const n = parseInt(raw ?? "0", 10);
	return Number.isFinite(n) ? n : 0;
}

/**
 * Reduce an event to a Match, or null if it isn't usable. Returns matches that are
 * live ("in") or just-ended ("post") and have both team ids (we key followers by
 * team id). "pre" and other states → null (nothing to track yet).
 */
export function parseMatch(event: ScoreboardEvent): Match | null {
	const status = event.status ?? event.competitions?.[0]?.status;
	const state = status?.type?.state;
	if (state !== "in" && state !== "post") return null;

	const competitors = event.competitions?.[0]?.competitors ?? [];
	const home = competitors.find((c) => c.homeAway === "home");
	const away = competitors.find((c) => c.homeAway === "away");
	if (!home?.team?.id || !away?.team?.id) return null;

	const side = (c: NonNullable<typeof home>): Side => ({
		id: c.team!.id!,
		abbr: c.team!.abbreviation ?? "",
		name: c.team!.displayName ?? c.team!.abbreviation ?? "",
		score: toScore(c.score),
	});

	return {
		eventId: event.id,
		home: side(home),
		away: side(away),
		state,
		statusName: status?.type?.name ?? "",
		period: status?.period ?? 0,
		clock: status?.clock ?? 0,
	};
}

/** The KV state to persist for `match` after this poll (carrying the halftime flag). */
export function nextState(prev: StoredState | null, match: Match, fired: MatchEvent[]): StoredState {
	return {
		home: { id: match.home.id, score: match.home.score },
		away: { id: match.away.id, score: match.away.score },
		state: match.state,
		halftimeSent: (prev?.halftimeSent ?? false) || fired.some((e) => e.type === "halftime"),
	};
}

// "WAS 1–0 ORL" — two teams together → abbreviations + en-dash (the app-wide rule).
function scoreline(match: Match): string {
	return `${match.home.abbr} ${match.home.score}–${match.away.score} ${match.away.abbr}`;
}

function fullTimeBody(match: Match): string {
	if (match.home.score > match.away.score) return `${match.home.name} win.`;
	if (match.away.score > match.home.score) return `${match.away.name} win.`;
	return "It's a draw.";
}

/**
 * Diff the previous stored state against the current match and emit live events.
 *
 * First sighting (prev === null) only baselines — except kickoff, which fires when
 * a match is seen live in its 1st minute (period 1, clock < 120s). That clock guard
 * means a watcher starting mid-match (clock already high) won't fire a false
 * kickoff. A multi-goal jump between polls collapses to one goal with the current
 * scoreline.
 */
export function detectEvents(prev: StoredState | null, match: Match): MatchEvent[] {
	const events: MatchEvent[] = [];
	const teamIds = [match.home.id, match.away.id];
	const base = { eventId: match.eventId, teamIds };

	// Kickoff — transition into a live 1st minute.
	if ((!prev || prev.state !== "in") && match.state === "in" && match.period === 1 && match.clock < 120) {
		events.push({
			...base,
			type: "kickoff",
			prefColumn: "kickoff",
			title: `KICKOFF — ${match.home.abbr} vs ${match.away.abbr}`,
			body: "The match is underway.",
		});
	}

	// Goals — a side's score rose (needs a prior baseline).
	if (prev) {
		if (match.home.score > prev.home.score) {
			events.push({ ...base, type: "goal", prefColumn: "goals", title: `GOAL — ${scoreline(match)}`, body: `${match.home.name} scored.` });
		}
		if (match.away.score > prev.away.score) {
			events.push({ ...base, type: "goal", prefColumn: "goals", title: `GOAL — ${scoreline(match)}`, body: `${match.away.name} scored.` });
		}
	}

	// Halftime — fired once while STATUS_HALFTIME holds.
	if (match.state === "in" && match.statusName === "STATUS_HALFTIME" && !prev?.halftimeSent) {
		events.push({ ...base, type: "halftime", prefColumn: "halftime", title: `Halftime — ${scoreline(match)}`, body: "It's the break." });
	}

	// Full time — transition from live to ended.
	if (prev && prev.state === "in" && match.state === "post") {
		events.push({ ...base, type: "fulltime", prefColumn: "full_time", title: `Full Time — ${scoreline(match)}`, body: fullTimeBody(match) });
	}

	return events;
}

/** The APNs payload for a detected event. `eventID` is the iOS deep-link key. */
export function toPayload(event: MatchEvent): Record<string, unknown> {
	return {
		aps: {
			alert: { title: event.title, body: event.body },
			sound: "default",
			"thread-id": event.eventId,
		},
		eventID: event.eventId,
	};
}
