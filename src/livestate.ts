/**
 * V2 Live Activity state derivation — maps a parsed Match (or a raw upcoming event) to the
 * ActivityKit `content-state` / `attributes` the widget renders. Kept SEPARATE from events.ts so V1's
 * event detection (`detectEvents`) is untouched — this only reads the same scoreboard shapes.
 *
 * Team colors mirror the app's DesignTeamColors palette (the widget also has them, but the START push
 * carries them in `attributes` so the widget needn't look anything up).
 */

import type { LiveAttributes, LiveContentState, LivePhase } from "./activitykit";
import type { Match, ScoreboardEvent } from "./events";

// NWSL brand hex by abbreviation (no '#') — mirrors NWSLApp DesignTeamColors.palette.
const TEAM_HEX: Record<string, string> = {
	LA: "E6447B", BAY: "2F80E8", BOS: "2FA85A", CHI: "6BA4FF", DEN: "239E80", GFC: "7FD4C1",
	HOU: "FF8A3D", KC: "30C7E8", NC: "E0354B", SEA: "6E7FFF", ORL: "B07CE8", POR: "FF4D6D",
	LOU: "C7A8FF", SD: "FFB340", UTA: "FFD60A", WAS: "FF4D5E",
};
export const colorHex = (abbr: string): string => TEAM_HEX[abbr.toUpperCase()] ?? "8E8E93";

function phaseFromMatch(m: Match): LivePhase {
	if (m.state === "post") return "fulltime";
	const n = m.statusName.toUpperCase();
	if (n.includes("HALFTIME")) return "halftime";
	if (n.includes("SHOOTOUT") || n.includes("PENALT")) return "penalties";
	if (m.period >= 3) return "extraTime"; // league rarely uses it, but handle gracefully
	return "live";
}

function lastScorer(m: Match): string | undefined {
	for (let i = m.plays.length - 1; i >= 0; i--) {
		const p = m.plays[i];
		if (p.scorer) return p.minute ? `${p.scorer} ${p.minute}'` : p.scorer;
	}
	return undefined;
}

/** Cap for per-side scorer lists in content-state — keeps the APNs 4KB envelope safe and the
 *  lock-screen card bounded. NWSL sides rarely exceed 4 goals; when one does, the 4th line
 *  becomes an overflow marker ("+2 more"). */
const SCORERS_PER_SIDE_CAP = 4;

/** One side's scorer lines ("C. Hutton 5'"), chronological, capped. Unattributed goals (ESPN
 *  gave no scorer) are skipped — never fabricated. Undefined when empty (compact() omits). */
function sideScorers(m: Match, teamId: string): string[] | undefined {
	const lines: string[] = [];
	for (const p of m.plays) {
		if (p.teamId !== teamId || !p.scorer) continue;
		lines.push(p.minute != null ? `${p.scorer} ${p.minute}'` : p.scorer);
	}
	if (lines.length === 0) return undefined;
	if (lines.length > SCORERS_PER_SIDE_CAP) {
		const overflow = lines.length - (SCORERS_PER_SIDE_CAP - 1);
		return [...lines.slice(0, SCORERS_PER_SIDE_CAP - 1), `+${overflow} more`];
	}
	return lines;
}

/** One side's red-card count; undefined when 0 (compact() omits). */
function sideReds(m: Match, teamId: string): number | undefined {
	const n = m.cards.filter((c) => c.teamId === teamId).length;
	return n > 0 ? n : undefined;
}

/** The current Live Activity content-state for a live/finished match (used for UPDATE / END).
 *  `virtualKickoff` (from StoredState) is the MONOTONIC anchor: ESPN freezes `status.clock` during
 *  stoppage, so re-basing `now − clock` per push snapped the widget clock back to 45:00 on every
 *  resync. When provided, it wins; the naive re-base remains the fallback (tests, first sighting). */
export function contentStateFromMatch(m: Match, virtualKickoff?: number): LiveContentState {
	const phase = phaseFromMatch(m);
	const nowSec = Math.floor(Date.now() / 1000);
	const running = phase === "live" || phase === "extraTime";
	const staticLabel = phase === "halftime" ? "HT" : phase === "fulltime" ? "FT" : phase === "penalties" ? "PENS" : undefined;
	return {
		homeScore: m.home.score,
		awayScore: m.away.score,
		phase,
		clockStartEpoch: running ? (virtualKickoff ?? nowSec - m.clock) : undefined,
		staticLabel,
		lastScorer: lastScorer(m),
		homeScorers: sideScorers(m, m.home.id),
		awayScorers: sideScorers(m, m.away.id),
		homeRedCards: sideReds(m, m.home.id),
		awayRedCards: sideReds(m, m.away.id),
	};
}

/** Static attributes for a match (set once at START). competition is NWSL until the watcher polls others. */
export function attributesFor(matchId: string, homeAbbr: string, awayAbbr: string, competition = "NWSL"): LiveAttributes {
	return {
		matchId,
		homeAbbr,
		awayAbbr,
		homeColorHex: colorHex(homeAbbr),
		awayColorHex: colorHex(awayAbbr),
		competition,
	};
}

/** Lightweight info for an UPCOMING (pre) match — `parseMatch` rejects "pre", so the start trigger reads
 *  the raw event directly. Returns null if the shape isn't usable. */
export interface UpcomingInfo {
	matchId: string;
	homeAbbr: string;
	awayAbbr: string;
	homeId: string;
	awayId: string;
}
export function upcomingInfo(event: ScoreboardEvent): UpcomingInfo | null {
	const comp = event.competitions?.[0];
	const competitors = comp?.competitors ?? [];
	const home = competitors.find((c) => c.homeAway === "home");
	const away = competitors.find((c) => c.homeAway === "away");
	if (!home?.team?.id || !away?.team?.id) return null;
	if (!home.team.abbreviation || !away.team.abbreviation) return null;
	return {
		matchId: event.id,
		homeAbbr: home.team.abbreviation,
		awayAbbr: away.team.abbreviation,
		homeId: home.team.id,
		awayId: away.team.id,
	};
}

/** Pre-match content-state (no score yet) — shows the scheduled kickoff time. */
export function preContentState(kickoffLabel: string): LiveContentState {
	return { homeScore: 0, awayScore: 0, phase: "pre", staticLabel: kickoffLabel };
}
