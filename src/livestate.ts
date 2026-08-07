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
// ⚠️ KEEP IN SYNC BY HAND: the app palette had a "verified 2026" brand-color pass (official club
// colors, dark-canvas legible) that this map missed for months — V2 cards washed 6 clubs in stale
// hues (e.g. Portland's old pink FF4D6D vs the official Vivid Red EF3340). Re-diff against
// DesignTeamColors.swift whenever either side changes a value. (Synced 2026-08-06.)
const TEAM_HEX: Record<string, string> = {
	LA: "E6447B", BAY: "2F80E8", BOS: "26D07C", CHI: "00A3E0", DEN: "239E80", GFC: "9ADBE8",
	HOU: "FF6900", KC: "30C7E8", NC: "E0354B", SEA: "6E7FFF", ORL: "B07CE8", POR: "EF3340",
	LOU: "C7A8FF", SD: "FFA400", UTA: "FFD60A", WAS: "FF4D5E",
};
// National-team brand hex by FIFA code — mirrors NWSLApp Models/NationalTeam (brandHex). So a USWNT V2
// card's team-color wash uses the country's real colors (USA blue vs CAN red) instead of a flat grey.
// No overlap with the NWSL abbreviations above, so the two tables chain cleanly.
const NT_HEX: Record<string, string> = {
	USA: "2E5BE0", MEX: "1FA463", CAN: "E0322B", BRA: "00A24A", COL: "F4C20D", ENG: "E8413A",
	JAM: "F4C20D", JPN: "E0322B", AUS: "F4C20D", FRA: "2E5BE0", GER: "E0322B", HAI: "2E5BE0",
	KOR: "E0322B", NGA: "1FA463", ESP: "E8413A", SWE: "3A7BE0",
};
// Foreign clubs that face NWSL sides in the Concacaf W Champions Cup — mirrors (and extends) the
// app's DesignTeamColors.international. Real brand colors, dark-canvas brightened where the brand
// is a near-black navy (the same treatment the app gives Bay FC): without these a cup card's
// foreign side washes flat grey. Grow per season as the field changes; keep identical to the
// app's map (A1 adds the 5 new ones there).
const INTERNATIONAL_HEX: Record<string, string> = {
	AME: "FFCC00", // Club América (Águilas yellow — matches the app)
	PAC: "1E4FB0", // Pachuca (Tuzos blue — matches the app)
	MON: "4D7DD6", // Monterrey (Rayadas navy, brightened for the dark canvas)
	ALI: "3E63D4", // Alianza FC (SLV — royal blue, brightened)
	ALA: "E03A31", // LD Alajuelense (CRC — La Liga red)
	CFC: "FFC61A", // Chorrillo FC (PAN — crest gold)
	VAN: "17A3A8", // Vancouver Rise FC Academy (CAN — Rise teal, brightened)
};
export const colorHex = (abbr: string): string =>
	TEAM_HEX[abbr.toUpperCase()] ?? NT_HEX[abbr.toUpperCase()] ?? INTERNATIONAL_HEX[abbr.toUpperCase()] ?? "8E8E93";

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

/** Football stoppage-time label from ANCHOR-based elapsed — mirrors Swift MatchClock.minuteLabel
 *  EXACTLY (1-based current minute; fold past the period cap into "{cap}'+{n}'"). Returns undefined
 *  during normal play (before the cap) so the widget keeps its self-ticking clock; only added time
 *  ("45'+2'"/"90'+3'") needs a pushed string because ESPN freezes the numeric clock at the cap and
 *  Apple's timer can't format stoppage. `period`: 1/2 regulation, 3/4 ET. */
const REGULATION_CAP: Record<number, number> = { 1: 45, 2: 90, 3: 105, 4: 120 };
function stoppageLabel(elapsedSec: number, period: number): string | undefined {
	const cap = REGULATION_CAP[period];
	if (cap == null) return undefined;
	const displayMinute = Math.max(0, Math.floor(elapsedSec / 60)) + 1; // 1-based "current minute"
	return displayMinute > cap ? `${cap}'+${displayMinute - cap}'` : undefined;
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
	const clockStartEpoch = running ? (virtualKickoff ?? nowSec - m.clock) : undefined;
	// Stoppage label from the MONOTONIC anchor (not ESPN's frozen clock): while running past the cap,
	// elapsed = now − clockStartEpoch keeps growing → "90'+1'", "+2'"… exactly like the in-app clock.
	const stoppageDisplay = running && clockStartEpoch != null
		? stoppageLabel(nowSec - clockStartEpoch, m.period)
		: undefined;
	return {
		homeScore: m.home.score,
		awayScore: m.away.score,
		phase,
		clockStartEpoch,
		staticLabel,
		lastScorer: lastScorer(m),
		homeScorers: sideScorers(m, m.home.id),
		awayScorers: sideScorers(m, m.away.id),
		homeRedCards: sideReds(m, m.home.id),
		awayRedCards: sideReds(m, m.away.id),
		stoppageDisplay,
	};
}

/** Static attributes for a match (set once at START). competition is NWSL until the watcher polls others.
 *  `isNational` → the widget renders FIFA-code flags instead of club crests (USWNT V2). */
export function attributesFor(
	matchId: string,
	homeAbbr: string,
	awayAbbr: string,
	competition = "NWSL",
	isNational = false,
): LiveAttributes {
	return {
		matchId,
		homeAbbr,
		awayAbbr,
		homeColorHex: colorHex(homeAbbr),
		awayColorHex: colorHex(awayAbbr),
		competition,
		...(isNational ? { isNational: true } : {}),
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
