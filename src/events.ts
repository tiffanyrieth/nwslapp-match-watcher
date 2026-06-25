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
		// Scoring plays + cards live here (no subs — those need /summary, Stage D).
		details?: Array<ScoreboardDetail>;
	}>;
}

/** A `competitions[].details` entry — we read only the scoring plays. */
interface ScoreboardDetail {
	scoringPlay?: boolean;
	clock?: { displayValue?: string }; // e.g. "67'"
	team?: { id?: string };
	athletesInvolved?: Array<{ displayName?: string; shortName?: string }>;
}

interface EventStatus {
	period?: number;
	clock?: number; // seconds elapsed
	type?: { state?: string; name?: string }; // state: pre|in|post; name: STATUS_*
}

/** A scoring play reduced to what the card/copy need (best-effort — ESPN may omit). */
export interface ScoringPlay {
	teamId: string;
	/** Short scorer name, e.g. "S. Smith" — undefined if ESPN didn't attribute it. */
	scorer?: string;
	/** Match minute, e.g. 67 — undefined if no clock on the play. */
	minute?: number;
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
	/** Scoring plays from the scoreboard details, in document order. */
	plays: ScoringPlay[];
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
	/** Second alert line (running score + minute). Omitted for events without one. */
	subtitle?: string;
	body: string;
	/** Card inputs — both abbreviations + the running score at this event. */
	homeAbbr: string;
	awayAbbr: string;
	homeScore: number;
	awayScore: number;
	/** Match minute for the card/subtitle (goals + live), best-effort. */
	minute?: number;
	/** Short scorer name for the card footer/body (goals only), best-effort. */
	scorer?: string;
}

function toScore(raw?: string): number {
	const n = parseInt(raw ?? "0", 10);
	return Number.isFinite(n) ? n : 0;
}

/** Parse a minute out of an ESPN play clock displayValue ("67'", "45'+2'" → 45). */
function parseMinute(displayValue?: string): number | undefined {
	const m = /(\d{1,3})/.exec(displayValue ?? "");
	if (!m) return undefined;
	const n = parseInt(m[1], 10);
	return Number.isFinite(n) ? n : undefined;
}

/** The scoreboard's scoring plays, reduced + defensively parsed (may be empty). */
function parsePlays(details?: ScoreboardDetail[]): ScoringPlay[] {
	const plays: ScoringPlay[] = [];
	for (const d of details ?? []) {
		if (!d.scoringPlay || !d.team?.id) continue;
		const athlete = d.athletesInvolved?.[0];
		plays.push({
			teamId: d.team.id,
			scorer: athlete?.shortName ?? athlete?.displayName,
			minute: parseMinute(d.clock?.displayValue),
		});
	}
	return plays;
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
		plays: parsePlays(event.competitions?.[0]?.details),
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

/** The most recent scoring play attributed to `teamId`, if any. */
function latestPlayFor(match: Match, teamId: string): ScoringPlay | undefined {
	let found: ScoringPlay | undefined;
	for (const p of match.plays) if (p.teamId === teamId) found = p;
	return found;
}

/** Goal body: name the scorer when ESPN attributed one, else the club (no fabrication). */
function goalBody(scoringSide: Side, play?: ScoringPlay): string {
	return play?.scorer ? `${play.scorer} scored.` : `${scoringSide.name} scored.`;
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
	// Card inputs every event carries: both abbreviations + the running score.
	const base = {
		eventId: match.eventId,
		teamIds,
		homeAbbr: match.home.abbr,
		awayAbbr: match.away.abbr,
		homeScore: match.home.score,
		awayScore: match.away.score,
	};

	// Kickoff — transition into a live 1st minute.
	if ((!prev || prev.state !== "in") && match.state === "in" && match.period === 1 && match.clock < 120) {
		events.push({
			...base,
			type: "kickoff",
			prefColumn: "kickoff",
			title: `KICKOFF — ${match.home.abbr} vs ${match.away.abbr}`,
			body: "The match is underway. Follow live.",
		});
	}

	// Goals — a side's score rose (needs a prior baseline). Attribute the scorer +
	// minute best-effort from the scoreboard's scoring plays for that side.
	if (prev) {
		if (match.home.score > prev.home.score) {
			const play = latestPlayFor(match, match.home.id);
			events.push({
				...base,
				type: "goal",
				prefColumn: "goals",
				title: `GOAL — ${scoreline(match)}`,
				subtitle: play?.minute != null ? `${scoreline(match)} · ${play.minute}'` : scoreline(match),
				body: goalBody(match.home, play),
				minute: play?.minute,
				scorer: play?.scorer,
			});
		}
		if (match.away.score > prev.away.score) {
			const play = latestPlayFor(match, match.away.id);
			events.push({
				...base,
				type: "goal",
				prefColumn: "goals",
				title: `GOAL — ${scoreline(match)}`,
				subtitle: play?.minute != null ? `${scoreline(match)} · ${play.minute}'` : scoreline(match),
				body: goalBody(match.away, play),
				minute: play?.minute,
				scorer: play?.scorer,
			});
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

/** The server-rendered match-card URL for an event (crests + score + status pill). */
export function cardUrl(base: string, event: MatchEvent): string {
	const params = new URLSearchParams({
		e: event.type,
		h: event.homeAbbr,
		a: event.awayAbbr,
		hs: String(event.homeScore),
		as: String(event.awayScore),
	});
	if (event.minute != null) params.set("min", String(event.minute));
	if (event.scorer) params.set("sc", event.scorer);
	// ESPN team ids enable the card's middle crest fallback (proxy → ESPN CDN → ring).
	if (event.teamIds[0]) params.set("hid", event.teamIds[0]);
	if (event.teamIds[1]) params.set("aid", event.teamIds[1]);
	return `${base.replace(/\/$/, "")}/card/${event.eventId}?${params.toString()}`;
}

/**
 * The APNs payload for a detected event. Rich-notification contract:
 *   - `mutable-content: 1` wakes the Notification Service Extension (required, or
 *     the NSE never runs and the image is never attached).
 *   - `imageUrl` (custom) points at the server-rendered match card the NSE downloads.
 *   - `thread-id: match-<id>` stacks a match's kickoff/goal/HT/FT together.
 *   - `interruption-level: time-sensitive` — a live-match alert only has value while
 *     the match is live, so it should surface promptly (day-before stays default,
 *     but that's a Tier-1 LOCAL notification scheduled on-device, not this path).
 *   - `eventID` is kept verbatim — the iOS tap handler deep-links off it.
 *
 * `cardBase` is the watcher's own public origin (where GET /card lives).
 */
export function toPayload(event: MatchEvent, cardBase: string): Record<string, unknown> {
	const alert: Record<string, string> = { title: event.title, body: event.body };
	if (event.subtitle) alert.subtitle = event.subtitle;
	return {
		aps: {
			alert,
			"mutable-content": 1,
			sound: "default",
			"thread-id": `match-${event.eventId}`,
			"interruption-level": "time-sensitive",
		},
		eventID: event.eventId,
		matchId: event.eventId,
		event: event.type,
		imageUrl: cardUrl(cardBase, event),
	};
}
