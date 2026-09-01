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
// National-team brand hex by FIFA code — ALL ~106 codes the proxy /national-teams directory served
// on 2026-08-06 (all-NT V2 LA). Sources, in precedence order: the app's NationalTeam.brandHex (16) +
// DesignTeamColors.nationalOpponents (16) verbatim, then 74 curated from kit/flag colors normalized
// into the same dark-canvas families (kit-truth picks: ITA Azzurre blue, NED Oranje, WAL dragon red).
// A code ESPN adds later just falls to grey until this map grows — never a failure.
// ⚠️ CHI/DEN/POR here are Chile/Denmark/Portugal — they COLLIDE with NWSL club abbreviations, which
// is why NATIONAL lookups use ntColorHex (NT map FIRST) instead of the club-first colorHex chain.
const NT_HEX: Record<string, string> = {
	ALB: "DA251C", ALG: "1E9E57", AND: "E0322B", ARG: "5BA8E0", ARM: "E0322B", AUS: "F4C20D", AUT: "D72B2C",
	AZE: "00A3D6", BAN: "1E9E57", BEL: "E0322B", BIH: "3A6BD6", BKA: "E0322B", BLR: "E0322B", BOL: "E0322B",
	BRA: "00A24A", BUL: "00D69D", CAN: "E0322B", CHI: "D42E12", CHN: "E0322B", CIV: "E89000", CMR: "1E9E57",
	COL: "F4C20D", CPV: "2424B2", CRC: "D62B34", CRO: "E0322B", CYP: "F7991D", CZE: "D7141A", DEN: "D02A3E",
	DOM: "0062D6", ECU: "FFDD00", EGY: "CE1126", ENG: "E8413A", ESP: "E8413A", EST: "2274B9", FIN: "3A6BD6",
	FRA: "2E5BE0", FRO: "0076D6", GEO: "E72E3F", GER: "E0322B", GHA: "CE2931", GIB: "E0322B", GRE: "2A5FAC",
	GUA: "4997D0", HAI: "2E5BE0", HUN: "E0322B", IND: "F89939", IRL: "1E9E57", IRN: "E0322B", ISL: "3A6BD6",
	ISR: "2E50A8", ITA: "3D7CE0", JAM: "F4C20D", JPN: "E0322B", KAZ: "00BDD6", KEN: "1E9E57", KOR: "E0322B",
	KOS: "264FB0", LIE: "CE1127", LTU: "FEE000", LUX: "0099FF", LVA: "E0322B", MAR: "C1272D", MDA: "3A6BD6",
	MEX: "1FA463", MKD: "E0322B", MLI: "FCD116", MLT: "CF142B", MNE: "E0322B", MWI: "D32F2F", NED: "FF7A1A",
	NGA: "1FA463", NIR: "E0322B", NOR: "E0322B", NZL: "5C6F8A", PAN: "E0322B", PAR: "D52B1E", PER: "E0322B",
	PHI: "CE2931", PNG: "E0322B", POL: "DC143C", POR: "DA291C", PRK: "E0322B", PUR: "E0322B", ROU: "E0322B",
	RSA: "1E9E57", RUS: "2E5BE0", SCO: "3A6BD6", SEN: "1E9E57", SLV: "2E5BE0", SRB: "C6363C", SUI: "D72B2C",
	SVK: "CE1126", SVN: "E0322B", SWE: "3A7BE0", TAN: "00A3DD", THA: "DD2C33", TPE: "E0322B", TUR: "E22D34",
	UKR: "FFD500", URU: "3A6BD6", USA: "2E5BE0", UZB: "3BA9D6", VEN: "9E1B32", VIE: "DA251D", WAL: "E0322B",
	ZAM: "1E9E57",
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

/** Color for a NATIONAL-team side: the NT map first (never the club chain). Three FIFA codes
 *  collide with NWSL club abbreviations — CHI (Chile/Chicago), DEN (Denmark/Denver), POR
 *  (Portugal/Portland) — so a national match resolved through club-first `colorHex` would wash
 *  Denmark in Denver green. `attributesFor` picks the resolver by `isNational`. */
export const ntColorHex = (abbr: string): string => NT_HEX[abbr.toUpperCase()] ?? "8E8E93";

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

/** Cap for per-side scorer lists in content-state. Raised 4 → 7 (2026-08-31) so a high-scoring side
 *  (DEN 6-1, BOS 2-5) shows its scorers instead of collapsing early into "+N more". Payload is NOT the
 *  constraint — 7/side is ~120 bytes over 4, the whole push stays well under the APNs 4KB envelope; the
 *  real limit is the iOS lock-screen card HEIGHT, which clips beyond its ceiling. The overflow marker is
 *  retained deliberately as the graceful fallback if iOS clips before 7. Beyond the cap the last line
 *  becomes "+N more". */
const SCORERS_PER_SIDE_CAP = 7;

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
	const hex = isNational ? ntColorHex : colorHex; // NT map first for national sides (CHI/DEN/POR collide)
	return {
		matchId,
		homeAbbr,
		awayAbbr,
		homeColorHex: hex(homeAbbr),
		awayColorHex: hex(awayAbbr),
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
