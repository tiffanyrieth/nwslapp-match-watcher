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
		// Venue + broadcast ride the SAME scoreboard payload (mirrors the app's Scoreboard.swift):
		// venue.fullName ("Audi Field"), broadcasts[].names ["Victory+"]. Used for the kickoff body.
		venue?: { fullName?: string };
		broadcasts?: Array<{ names?: string[] }>;
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
	/** Venue name ("Audi Field") + broadcast label ("Victory+") — for the kickoff body. Best-effort. */
	venue?: string;
	broadcast?: string;
}

/** What we persist per match in KV between polls. */
export interface StoredState {
	home: { id: string; score: number };
	away: { id: string; score: number };
	state: string;
	halftimeSent: boolean;
}

export type MatchEventType = "kickoff" | "goal" | "halftime" | "fulltime" | "correction" | "lineup";

/** A detected event, carrying everything to find followers + compose the push. */
export interface MatchEvent {
	type: MatchEventType;
	eventId: string;
	/** Both teams' ids — a live event in your team's match matters either way. */
	teamIds: string[];
	/** The `notification_preferences` column that gates delivery. */
	prefColumn: "kickoff" | "goals" | "halftime" | "full_time" | "lineup_posted";
	/** Title = `Event: scoreline/matchup` — caps only on the two peaks (GOAL / NO GOAL). */
	title: string;
	/** Subtitle = the ONE detail line (scorer/venue·broadcast/winner). The 2026-07-05 redesign is
	 *  title+subtitle only — no body (too wordy for a push; we lack assist/tactical data anyway). */
	subtitle?: string;
	/** Legacy third line — no longer set by the builders; kept optional so old tests type-check. */
	body?: string;
	/** Crest/attachment inputs — both abbreviations + the running score at this event. */
	homeAbbr: string;
	awayAbbr: string;
	homeScore: number;
	awayScore: number;
	/** Match minute for the subtitle (goals + live), best-effort. */
	minute?: number;
	/** Short scorer name for the subtitle (goals only), best-effort. */
	scorer?: string;
	/** Which side the event belongs to — picks the attached crest: goals = the scoring club;
	 *  corrections = the club whose goal was disallowed. */
	scoringSide?: "home" | "away";
	/** Pre-correction score — set ONLY for "correction" events, to render the struck-through old score.
	 *  (We never know WHICH goal/scorer was reversed — ESPN doesn't say — only that the score dropped.) */
	prevHomeScore?: number;
	prevAwayScore?: number;
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

	const competition = event.competitions?.[0];
	const competitors = competition?.competitors ?? [];
	const home = competitors.find((c) => c.homeAway === "home");
	const away = competitors.find((c) => c.homeAway === "away");
	if (!home?.team?.id || !away?.team?.id) return null;

	const venue = competition?.venue?.fullName || undefined;
	const broadcast = competition?.broadcasts?.find((b) => b.names?.length)?.names?.[0] || undefined;

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
		plays: parsePlays(competition?.details),
		venue,
		broadcast,
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

/** The slice of an ESPN `/summary` payload we read to detect a posted lineup. */
interface SummaryLike {
	rosters?: Array<{ roster?: Array<{ starter?: boolean }> }>;
}

/** True once BOTH teams' starting XIs are posted — each roster has ≥11 players marked `starter`.
 *  Before publish ESPN returns roster "shells" (0 players); a partial (one side only) stays false,
 *  so the "lineups are in" push fires exactly once, when both XIs are confirmed. ESPN publishes ~1h
 *  before kickoff; the watcher polls `/summary` cache-busted in the pre-kickoff window (see index.ts). */
export function lineupsPublished(summary: SummaryLike | null | undefined): boolean {
	const rosters = summary?.rosters;
	if (!Array.isArray(rosters) || rosters.length < 2) return false;
	const starters = (r: { roster?: Array<{ starter?: boolean }> }) =>
		Array.isArray(r.roster) ? r.roster.filter((p) => p?.starter === true).length : 0;
	return rosters.every((r) => starters(r) >= 11);
}

// ── Copy system (2026-07-05 redesign) ─────────────────────────────────────────
// Title = `Event: scoreline/matchup` (caps only on GOAL / NO GOAL — the two peaks);
// Subtitle = the one detail line; NO body. Two teams together → abbreviations + en-dash
// (the app-wide naming rule); one team as subject (FT winner) → full club name.

// "WAS 1–0 ORL"
function scoreline(match: Match): string {
	return `${match.home.abbr} ${match.home.score}–${match.away.score} ${match.away.abbr}`;
}

// "WAS vs ORL" — the pre-score matchup form (kickoff/lineups).
function matchup(match: Match): string {
	return `${match.home.abbr} vs ${match.away.abbr}`;
}

/** FT subtitle: "Washington Spirit win" (one-team subject → full club name) / "It's a draw". */
function fullTimeSubtitle(match: Match): string {
	if (match.home.score > match.away.score) return `${match.home.name} win`;
	if (match.away.score > match.home.score) return `${match.away.name} win`;
	return "It's a draw";
}

/** The most recent scoring play attributed to `teamId`, if any. */
function latestPlayFor(match: Match, teamId: string): ScoringPlay | undefined {
	let found: ScoringPlay | undefined;
	for (const p of match.plays) if (p.teamId === teamId) found = p;
	return found;
}

/** Goal subtitle: "S. Menti 19'" — scorer + minute, degrading gracefully to whichever is
 *  attributed; falls back to the club name when ESPN attributed nothing (no fabrication). */
function goalSubtitle(scoringSide: Side, play?: ScoringPlay): string {
	if (play?.scorer) return play.minute != null ? `${play.scorer} ${play.minute}'` : play.scorer;
	return scoringSide.name;
}

/** Kickoff subtitle: "Audi Field · Victory+" — where + how to watch (the old body's info,
 *  preserved). Falls back to venue-only, then a generic line, when ESPN omits a field. */
function kickoffSubtitle(match: Match): string {
	const parts = [match.venue, match.broadcast].filter((s): s is string => !!s);
	return parts.length ? parts.join(" · ") : "The match is underway";
}

/** The last scoring play's "Scorer 45'" line, if a scorer is attributed — the halftime
 *  subtitle when someone scored in the first half (else "It's the break"). */
function lastScorerLine(match: Match): string | undefined {
	let last: ScoringPlay | undefined;
	for (const p of match.plays) if (p.scorer) last = p;
	if (!last?.scorer) return undefined;
	return last.minute != null ? `${last.scorer} ${last.minute}'` : last.scorer;
}

/**
 * Diff the previous stored state against the current match and emit live events.
 *
 * First sighting (prev === null) only baselines — except kickoff, which fires when
 * a match is seen live early in the 1st half (period 1, clock < 600s). The 600s window
 * (widened from 120s) tolerates the proxy scoreboard's cache lag — the watcher's first
 * "in" sighting is often a few minutes after real kickoff — while still not firing a
 * false kickoff if a watcher only starts tracking a match long after it began. A
 * multi-goal jump between polls collapses to one goal with the current scoreline.
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

	// Kickoff — first time we see the match live in the first half. The `(!prev || prev.state !== "in")`
	// guard + persistent MATCH_STATE mean this fires exactly ONCE (later ticks have prev.state === "in").
	// Window widened 120s → 600s (2026-07-03): the proxy scoreboard cache can lag real kickoff by up to
	// ~5 min, so the watcher's FIRST "in" sighting often had clock > 120 and silently skipped kickoff.
	// 600s tolerates that lag while staying in the early first half (avoids a false kickoff if the watcher
	// only starts tracking a game long after it began, e.g. after downtime).
	if ((!prev || prev.state !== "in") && match.state === "in" && match.period === 1 && match.clock < 600) {
		events.push({
			...base,
			type: "kickoff",
			prefColumn: "kickoff",
			title: `Kickoff: ${matchup(match)}`,
			subtitle: kickoffSubtitle(match),
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
				title: `GOAL: ${scoreline(match)}`,
				subtitle: goalSubtitle(match.home, play),
				scoringSide: "home",
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
				title: `GOAL: ${scoreline(match)}`,
				subtitle: goalSubtitle(match.away, play),
				scoringSide: "away",
				minute: play?.minute,
				scorer: play?.scorer,
			});
		}
	}

	// Halftime — fired once while STATUS_HALFTIME holds.
	if (match.state === "in" && match.statusName === "STATUS_HALFTIME" && !prev?.halftimeSent) {
		events.push({ ...base, type: "halftime", prefColumn: "halftime", title: `Halftime: ${scoreline(match)}`, subtitle: lastScorerLine(match) ?? "It's the break" });
	}

	// Full time — transition from live to ended. Winner's crest attaches (draw → home).
	if (prev && prev.state === "in" && match.state === "post") {
		const winnerSide = match.home.score > match.away.score ? "home" : match.away.score > match.home.score ? "away" : undefined;
		events.push({ ...base, type: "fulltime", prefColumn: "full_time", title: `Full time: ${scoreline(match)}`, subtitle: fullTimeSubtitle(match), scoringSide: winnerSide });
	}

	return events;
}

/**
 * VAR correction detection. Split from detectEvents because a correction is NOT fired immediately: a
 * score decrease can be a transient ESPN glitch (stale/cached payload, momentary zeros), so the caller
 * must DEBOUNCE — re-poll a FRESH scoreboard and confirm the decrease persisted — before firing.
 * detectCorrectionCandidate is the pure guardrail; confirmCorrection is the pure post-debounce decision;
 * correctionEvent builds the push. All pure (no I/O) so the debounce logic is unit-testable.
 */
export interface CorrectionCandidate {
	eventId: string;
	/** The pre-correction (higher) baseline — for the struck old score + the confirm comparison. */
	prev: { home: number; away: number };
}

/**
 * A VAR-correction CANDIDATE: a side's score decreased while the match is in-progress on BOTH the prior
 * and current snapshots (brief guardrail #3 — blocks new-match 0-0 loads, resets, and in→final
 * transitions). Null otherwise. The decision to fire is deferred to confirmCorrection after a debounce.
 */
export function detectCorrectionCandidate(prev: StoredState | null, match: Match): CorrectionCandidate | null {
	if (!prev || prev.state !== "in" || match.state !== "in") return null;
	const decreased = match.home.score < prev.home.score || match.away.score < prev.away.score;
	if (!decreased) return null;
	return { eventId: match.eventId, prev: { home: prev.home.score, away: prev.away.score } };
}

/**
 * Confirm a candidate against a FRESH re-read (the debounce result). Real only if the match is still
 * in-progress AND the score is still below the prior baseline (the decrease persisted). A reverted score
 * (back to/above baseline), a vanished match, or a now-final re-read → false (glitch, or a status
 * transition we must not fire across).
 */
export function confirmCorrection(candidate: CorrectionCandidate, recheck: Match | null): boolean {
	if (!recheck || recheck.state !== "in") return false;
	return recheck.home.score < candidate.prev.home || recheck.away.score < candidate.prev.away;
}

/** Build the "NO GOAL" VAR event from the confirmed (corrected) match reading. */
export function correctionEvent(prev: { home: number; away: number }, match: Match): MatchEvent {
	// Which side's goal was disallowed (their score dropped) — picks the attached crest.
	const disallowedSide = match.home.score < prev.home ? "home" : match.away.score < prev.away ? "away" : undefined;
	return {
		type: "correction",
		eventId: match.eventId,
		teamIds: [match.home.id, match.away.id],
		prefColumn: "goals", // whoever opted into goal alerts wants to know one was reversed
		title: `NO GOAL: ${scoreline(match)}`, // corrected score; the title IS the reversal
		subtitle: "VAR review — goal disallowed",
		homeAbbr: match.home.abbr,
		awayAbbr: match.away.abbr,
		homeScore: match.home.score,
		awayScore: match.away.score,
		scoringSide: disallowedSide,
		prevHomeScore: prev.home,
		prevAwayScore: prev.away,
	};
}

/** Which club's crest attaches to an event: goals → the scoring club; corrections → the club
 *  whose goal was disallowed; full time → the winner (draw falls through to home); everything
 *  else → home. A square transparent crest IS a clean collapsed thumbnail — the old wide-card
 *  attachment crushed into an unreadable 1:1 blob, which this redesign kills structurally. */
function crestAbbr(event: MatchEvent): string {
	if (event.scoringSide === "away") return event.awayAbbr;
	if (event.scoringSide === "home") return event.homeAbbr;
	return event.homeAbbr;
}

/** The nwslapp-card worker's 512×512 crest-tile PNG for an event (public origin — the NSE
 *  downloads it). A TILE, not the bare crest: full-bleed team-color wash + crest at ~86%, so
 *  iOS's fixed thumbnail slot renders edge-to-edge instead of a tiny floating transparent crest. */
export function thumbUrl(cardBase: string, event: MatchEvent): string {
	// ?s= is a STYLE VERSION cache-buster: /thumb responses edge-cache 24h keyed by full URL, so a
	// tile-design change must bump this or devices keep pulling the old look until the cache expires.
	return `${cardBase.replace(/\/$/, "")}/thumb/${encodeURIComponent(crestAbbr(event))}?s=3`;
}

/** Per-event interruption level: goals/VAR/kickoff/full-time punch through Focus modes
 *  (time-sensitive — only valuable in the moment); lineups + halftime stay polite. */
function interruptionLevel(type: MatchEventType): "time-sensitive" | "active" {
	return type === "halftime" || type === "lineup" ? "active" : "time-sensitive";
}

/**
 * The APNs payload for a detected event (2026-07-05 redesign: title+subtitle, crest attachment).
 *   - `alert` = title + subtitle ONLY (no body — the copy system's two-line contract).
 *   - `mutable-content: 1` wakes the Notification Service Extension (required, or
 *     the NSE never runs and the image is never attached).
 *   - `imageUrl` (custom) points at the card worker's /thumb crest TILE (scoring club / winner /
 *     home — see crestAbbr). Full-bleed square ⇒ the collapsed thumbnail renders at max size.
 *   - `thread-id: match-<id>` stacks a match's lineup/kickoff/goal/HT/FT together.
 *   - `interruption-level` is per-event (see interruptionLevel).
 *   - `eventID` is kept verbatim — the iOS tap handler deep-links off it.
 *
 * `cardBase` is the nwslapp-card worker's public origin (where GET /thumb/{ABBR} lives).
 */
export function toPayload(event: MatchEvent, cardBase: string): Record<string, unknown> {
	const alert: Record<string, string> = { title: event.title };
	if (event.subtitle) alert.subtitle = event.subtitle;
	if (event.body) alert.body = event.body; // legacy field — the builders no longer set it
	return {
		aps: {
			alert,
			"mutable-content": 1,
			sound: "default",
			"thread-id": `match-${event.eventId}`,
			"interruption-level": interruptionLevel(event.type),
		},
		eventID: event.eventId,
		matchId: event.eventId,
		event: event.type,
		imageUrl: thumbUrl(cardBase, event),
	};
}
