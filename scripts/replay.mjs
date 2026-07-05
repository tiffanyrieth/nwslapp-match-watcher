#!/usr/bin/env node
/**
 * replay.mjs — compressed real-match Live Activity replay (V2 on-device E2E test tool).
 *
 * Replays a REAL past Spirit match — real goals, real minutes, real scorers — compressed from ~90'
 * into ~10 minutes of wall clock, walking the full Live Activity lifecycle on every registered device:
 *   pre-match → kickoff → goals → halftime → 2nd half → full-time → auto-dismiss.
 *
 * It drives the watcher's POST /test-activity endpoint with NO `token` in the body, so the watcher
 * fans each push out to ALL registered devices (you + your brother): `start` → every push-to-start
 * token, `update`/`end` → every per-Activity token for this synthetic matchId. The service-role read
 * stays in the Worker; this script needs only the trigger secret.
 *
 * DATA: real events come from ESPN via the proxy's /summary?event=<id> `keyEvents[]`. Each scoring play
 * is attributed by ESPN to the BENEFITING team (own goals included — verified), so the running score is
 * just "increment the team whose team.id matches home/away". We assert the computed final == ESPN's.
 *
 * CLOCK (expected, not a bug): each step carries the event's REAL match minute; the widget renders that
 * minute and ticks in real time until the next push. Because pushes are now seconds apart, the displayed
 * clock advances a little, then JUMPS forward to the next event's real minute — reads like a fast-forward.
 *
 * USAGE:
 *   MANUAL_TRIGGER_SECRET=<secret> node scripts/replay.mjs            # live: Spirit's latest finished match
 *   node scripts/replay.mjs --dry-run                                 # print timeline + schedule, send nothing
 *   ... --event=401853924    pin a specific ESPN event id
 *   ... --fixture            use the committed fixture (NWSLAppTests/Fixtures/summary.json) instead of live
 *   ... --minutes=10         total wall-clock duration (default 10)
 *   ... --team=WAS           which team's latest match to pick (default WAS)
 *   ... --match-id=replay-test   synthetic matchId isolating test rows from real matches (default)
 *   ... --start-hold=30      seconds after start before the first update (token-registration window)
 *   ... --start-only         fire only the start (register the per-Activity token), then stop
 *   ... --updates-only       skip start; drive kickoff→end against an ALREADY-running Activity
 *   ... --correction         VAR test: fire the last goal as a V1 push, then DISALLOW it — a V1
 *                            correction push (red card, struck score, stacks via thread-id) + a silent
 *                            V2 Live Activity score rollback. Mirrors the brief's goal-then-correction.
 *   ... --with-v1            ALSO fire the matching V1 rich push at each moment (kickoff/goal/HT/FT,
 *                            card image attached) — the full "every toggle on" experience. Set
 *                            MY_DEVICE_TOKEN to scope the V1 pushes to one phone.
 *   ... --la-alerts          DEVICE TEST: audible alerts ON THE V2 UPDATE/END pushes themselves
 *                            (kickoff/goals/HT/FT buzz via the Live Activity channel, no V1).
 *   ... --ht-hold=<sec>      dwell at halftime this long before the second half.
 *
 * NOTE (6/30 findings — the two traps that waste a whole session if forgotten):
 *   1. The per-Activity update token takes MINUTES to check in after the start (device must receive the
 *      push, create the Activity, upload the token — and ONLY while the app is RUNNING to observe it).
 *      This is why LA_START_LEAD_MS is 20 min. A short --start-hold → every update hits 0 tokens.
 *   2. `start → 1/1 ok` means APNs ACCEPTED the push-to-start — NOT that the card rendered or the token
 *      checked in. Those are separate; verify the card on-screen and a live_activities row separately.
 *   RELIABLE recipe: --start-only (app OPEN + foregrounded) → wait, confirm a live_activities row for the
 *   matchId → --updates-only. Don't gamble on a fixed inline hold.
 *   (The compressed clock "jumping" between real minutes is EXPECTED, not a bug.)
 *
 * ENV: MANUAL_TRIGGER_SECRET (required unless --dry-run), WATCHER_URL, PROXY_URL (sensible defaults below).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Config ───────────────────────────────────────────────────────────────────
const WATCHER_URL = (process.env.WATCHER_URL ?? "https://nwslapp-match-watcher.tiffany-rieth.workers.dev").replace(/\/$/, "");
const PROXY_URL = (process.env.PROXY_URL ?? "https://nwslapp-proxy.tiffany-rieth.workers.dev").replace(/\/$/, "");
// V1 push thumbnails come from the nwslapp-card worker's /thumb/{ABBR} crest tiles.
const CARD_URL = (process.env.CARD_URL ?? "https://nwslapp-card.tiffany-rieth.workers.dev").replace(/\/$/, "");
const SECRET = process.env.MANUAL_TRIGGER_SECRET ?? process.env.TRIGGER_SECRET ?? "";
const FIXTURE_PATH = resolve(__dirname, "../../NWSLApp/NWSLAppTests/Fixtures/summary.json");

// SINGLE-DEVICE TARGETING — set these to send ONLY to your own phone instead of fanning out to every
// registered device. MY_START_TOKEN = your push-to-start token (scopes the /test-activity START; every
// update/end then follows only your Activity because it's keyed by this synthetic matchId). MY_DEVICE_TOKEN
// = your APNs device token (scopes the V1 /test-push cards used by --correction). Pull both from Supabase:
//   select t.token as start_token, d.token as device_token
//   from live_activity_start_tokens t
//   join device_tokens d on d.user_id = t.user_id and d.device_id = t.device_id
//   where t.user_id = '<your uuid>';
// Unset → original behavior (fan out to ALL devices). Tip: use a fresh --match-id per run so a prior
// test's per-Activity token on another phone can't catch an update.
const MY_START_TOKEN = process.env.MY_START_TOKEN ?? "";
const MY_DEVICE_TOKEN = process.env.MY_DEVICE_TOKEN ?? "";
const SINGLE_DEVICE = Boolean(MY_START_TOKEN || MY_DEVICE_TOKEN);

// Scheduling constants.
const END_HOLD_S = 12; //   keep the FT card visible before the end/dismiss push
const MIN_GAP_S = 10; //    floor between any two consecutive sends
const MATCH_SPAN_MIN = 95; // map real minutes 0..95 onto the wall-clock budget

// ── Args ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (k, d) => {
	const a = args.find((x) => x.startsWith(`--${k}=`));
	return a ? a.slice(k.length + 3) : d;
};
if (has("--help") || has("-h")) {
	console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 49).join("\n").replace(/^ \*?/gm, ""));
	process.exit(0);
}
const DRY = has("--dry-run");
const USE_FIXTURE = has("--fixture");
const PINNED_EVENT = val("event", null);
const TOTAL_MIN = Number(val("minutes", "10"));
const TEAM = val("team", "WAS").toUpperCase();
const MATCH_ID = val("match-id", "replay-test");
// start → first update: time for the device to receive the start push, create the Activity, and upload
// its per-Activity token. LEARNED 6/30 (do not re-discover): this takes MINUTES, not seconds — the exact
// reason the watcher's LA_START_LEAD_MS is 20 min (a 1-min-before-kickoff start is too late for the token
// to check in). The token uploads ONLY while the app is RUNNING to observe it, so keep it foregrounded.
// 180s is the single-shot default; a too-short hold makes every update fire to 0 per-Activity tokens. The
// RELIABLE path is two-phase: --start-only (app open) → confirm a live_activities row → --updates-only.
const START_HOLD_S = Number(val("start-hold", "180"));
// Two-phase helpers: --start-only fires just the start (register the per-Activity token, then stop);
// --updates-only skips the start and drives kickoff→end against an ALREADY-running Activity.
const START_ONLY = has("--start-only");
const UPDATES_ONLY = has("--updates-only");
const CORRECTION = has("--correction");
// --with-v1: mirror each match moment with its V1 rich push too (lineup/kickoff/goal/HT/FT, card
// image attached) — the full "every toggle on" experience: V1 banner buzzes, V2 card updates silently.
// Also inserts a "Lineups in" V1 push 60s after the pre-start (mirrors the real Stage-D push).
// Single-device scoping: set MY_DEVICE_TOKEN so the V1 pushes hit only your phone.
const WITH_V1 = has("--with-v1");
// --ht-hold=<sec>: dwell at halftime this long before the second half (default: the normal 10s gap).
const HT_HOLD_S = Number(val("ht-hold", "0"));
// --la-alerts (DEVICE TEST): put an audible alert on the V2 UPDATE/END pushes themselves (kickoff /
// goals / HT / FT buzz via the Live Activity channel — no V1 involved). Tests whether V2-only could
// carry the interrupts. Docs say yes; tonight's rule is verify on hardware.
const LA_ALERTS = has("--la-alerts");

// ── Helpers ──────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmtClock = (s) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

async function fetchJson(url, init) {
	const res = await fetch(url, init);
	const body = await res.text();
	if (!res.ok) throw new Error(`GET ${url} → ${res.status}: ${body.slice(0, 200)}`);
	try {
		return JSON.parse(body);
	} catch {
		throw new Error(`GET ${url} → non-JSON: ${body.slice(0, 200)}`);
	}
}

/** Leading minute of an ESPN displayClock like "18'", "45'+4'", "90'+7'" → integer (base + stoppage). */
function parseMinute(displayValue) {
	const m = /(\d+)'(?:\+(\d+))?/.exec(displayValue ?? "");
	if (!m) return 1;
	return Number(m[1]) + (m[2] ? Number(m[2]) : 0);
}

// ── 1. Resolve which match to replay ───────────────────────────────────────────
async function resolveSummary() {
	if (USE_FIXTURE) {
		console.log(`▶ Source: committed fixture ${FIXTURE_PATH}`);
		return { summary: JSON.parse(readFileSync(FIXTURE_PATH, "utf8")), eventId: "(fixture)" };
	}
	let eventId = PINNED_EVENT;
	if (!eventId) {
		console.log(`▶ Finding ${TEAM}'s most recent finished match via proxy…`);
		const year = 2026;
		const sb = await fetchJson(`${PROXY_URL}/scoreboard?dates=${year}0101-${year}1231&limit=500`);
		const matches = (sb.events ?? [])
			.filter((e) => e.status?.type?.state === "post")
			.filter((e) => (e.competitions?.[0]?.competitors ?? []).some((c) => c.team?.abbreviation === TEAM))
			.sort((a, b) => String(b.date).localeCompare(String(a.date)));
		if (matches.length === 0) throw new Error(`No finished ${TEAM} matches found in ${year}.`);
		eventId = matches[0].id;
		console.log(`  → ${matches[0].name} (${matches[0].date})  event=${eventId}`);
	}
	const summary = await fetchJson(`${PROXY_URL}/summary?event=${encodeURIComponent(eventId)}`);
	return { summary, eventId };
}

// ── 2. Build the replay timeline from real keyEvents ───────────────────────────
function buildTimeline(summary) {
	const teams = summary.boxscore?.teams ?? [];
	const home = teams.find((t) => t.homeAway === "home");
	const away = teams.find((t) => t.homeAway === "away");
	if (!home?.team?.id || !away?.team?.id) throw new Error("Could not resolve home/away from boxscore.teams.");
	const homeId = home.team.id,
		awayId = away.team.id;
	const h = home.team.abbreviation,
		a = away.team.abbreviation;

	// ESPN's authoritative final (header.competitions, live only) — used to assert our running tally.
	const headerComp = summary.header?.competitions?.[0]?.competitors ?? [];
	const finalH = headerComp.find((c) => c.homeAway === "home")?.score;
	const finalA = headerComp.find((c) => c.homeAway === "away")?.score;

	// Chronological order: period, then clock seconds within the period.
	const evs = [...(summary.keyEvents ?? [])].sort(
		(x, y) => (x.period?.number ?? 0) - (y.period?.number ?? 0) || (x.clock?.value ?? 0) - (y.clock?.value ?? 0),
	);

	let hs = 0,
		as = 0;
	const steps = [{ kind: "pre", label: "Pre-match", matchMin: -1, phase: "pre", hs: 0, as: 0 }];

	for (const ev of evs) {
		const type = ev.type?.type ?? "";
		const min = parseMinute(ev.clock?.displayValue);
		if (ev.scoringPlay) {
			// Beneficiary = ev.team.id (ESPN attributes own goals to the team that benefits — verified).
			const tid = ev.team?.id;
			if (tid === homeId) hs++;
			else if (tid === awayId) as++;
			else continue; // unknown team — skip rather than mis-score
			const who = ev.participants?.[0]?.athlete?.displayName ?? "Goal";
			const og = type.includes("own-goal") ? " (OG)" : "";
			steps.push({ kind: "goal", label: `Goal ${ev.clock?.displayValue} ${who}${og}`, matchMin: min, phase: "live", hs, as, sc: `${who} ${ev.clock?.displayValue ?? `${min}'`}${og}`, scoringAbbr: tid === homeId ? h : a });
		} else if (type.includes("kickoff")) {
			steps.push({ kind: "kickoff", label: "Kickoff", matchMin: 1, phase: "live", hs, as });
		} else if (type.includes("halftime")) {
			steps.push({ kind: "ht", label: "Halftime", matchMin: 45, phase: "halftime", hs, as });
		} else if (type.includes("start-2nd-half")) {
			steps.push({ kind: "2h", label: "Second half", matchMin: 46, phase: "live", hs, as });
		} else if (type.includes("end-regular-time") || type.includes("fulltime") || type.includes("end-of-game")) {
			steps.push({ kind: "ft", label: "Full-time", matchMin: MATCH_SPAN_MIN, phase: "fulltime", hs, as });
		}
	}

	// Ensure a kickoff and a full-time even if ESPN omitted them.
	if (!steps.some((s) => s.kind === "kickoff")) steps.splice(1, 0, { kind: "kickoff", label: "Kickoff", matchMin: 1, phase: "live", hs: 0, as: 0 });
	if (!steps.some((s) => s.kind === "ft")) steps.push({ kind: "ft", label: "Full-time", matchMin: MATCH_SPAN_MIN, phase: "fulltime", hs, as });
	steps.push({ kind: "end", label: "Dismiss", matchMin: MATCH_SPAN_MIN + 3, phase: "fulltime", hs, as });

	// Loud final-score assertion (prove-live, never silent).
	if (finalH != null && finalA != null) {
		const ok = String(hs) === String(finalH) && String(as) === String(finalA);
		console.log(`▶ Computed final ${h} ${hs}–${as} ${a} vs ESPN ${h} ${finalH}–${finalA} ${a}  ${ok ? "✓ match" : "✗ MISMATCH"}`);
		if (!ok) console.warn("  ⚠ score mismatch — keyEvents may be incomplete; replay will still run with the computed score.");
	} else {
		console.log(`▶ Computed final ${h} ${hs}–${as} ${a}  (no header score to verify against — fixture mode)`);
	}

	return { steps, h, a };
}

// ── 3. Compress onto the wall clock ────────────────────────────────────────────
function schedule(steps) {
	const totalSec = Math.max(60, Math.round(TOTAL_MIN * 60));
	const budget = totalSec - START_HOLD_S - END_HOLD_S;
	let prev = -Infinity;
	for (const s of steps) {
		let off;
		if (s.kind === "pre") off = 0;
		else if (s.kind === "end") off = totalSec;
		else off = START_HOLD_S + (Math.max(0, s.matchMin) / MATCH_SPAN_MIN) * budget;
		if (s.kind !== "pre") off = Math.max(off, prev + MIN_GAP_S); // enforce a floor between sends
		s.offsetSec = Math.round(off);
		prev = s.offsetSec;
	}
	return steps;
}

// ── 4. Send one step ───────────────────────────────────────────────────────────
async function send(step, h, a) {
	const mode = step.kind === "pre" ? "start" : step.kind === "end" ? "end" : "update";
	const body = { mode, matchId: MATCH_ID, phase: step.phase, hs: step.hs, as: step.as };
	// PROVEN 7/4: a start push WITHOUT an alert never renders (iOS silently drops it). The alert is
	// REQUIRED for the card to appear; updates/end stay silent (they modify the existing Activity)
	// unless --la-alerts puts an audible alert on the status changes (the V2-buzz device test).
	if (mode === "start") Object.assign(body, { h, a, comp: "NWSL", alert: true });
	if (LA_ALERTS && mode !== "start") {
		const score = `${h} ${step.hs}–${step.as} ${a}`;
		const alert =
			step.kind === "kickoff" ? { title: `Kickoff — ${h} vs ${a}`, body: "We're underway.", sound: "default" }
			: step.kind === "goal" ? { title: `GOAL — ${score}`, body: step.sc ?? "Goal.", sound: "default" }
			: step.kind === "ht" ? { title: `Halftime — ${score}`, body: "It's the break.", sound: "default" }
			: step.kind === "ft" || step.kind === "end" ? { title: `Full time — ${score}`, body: "That's the match.", sound: "default" }
			: undefined; // 2nd-half resume stays silent
		if (alert) body.alert = alert;
	}
	// Scope the START to one device (its push-to-start token). Updates/end omit token and target every
	// per-Activity token for this matchId — only YOUR Activity exists for it, so they reach only you too.
	if (mode === "start" && MY_START_TOKEN) body.token = MY_START_TOKEN;
	if (step.matchMin > 0 && step.phase === "live") body.min = step.matchMin;
	if (step.sc) body.sc = step.sc;

	const res = await fetch(`${WATCHER_URL}/test-activity`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-trigger-secret": SECRET },
		body: JSON.stringify(body),
	});
	const out = await res.json().catch(() => ({}));
	const fails = (out.results ?? []).filter((r) => !r.ok).map((r) => `${r.status}:${r.reason ?? "?"}(…${String(r.token ?? "").slice(-8)})`);
	const tag = out.error ? `ERROR: ${out.error}` : `${out.okCount ?? 0}/${out.tokenCount ?? 0} ok`;
	console.log(`  [${fmtClock(step.offsetSec)}] ${mode.padEnd(6)} ${step.label.padEnd(34)} → HTTP ${res.status} (${tag})${fails.length ? "  fails: " + fails.join(", ") : ""}`);
	return { httpOk: res.ok, tokenCount: out.tokenCount ?? 0, error: out.error };
}

// ── VAR correction test (V1 push + V2 LA rollback) ─────────────────────────────

/** --with-v1: fire the V1 push matching a replay step (mirrors the watcher's real event pushes —
 *  2026-07-05 redesign: title + subtitle only, square crest attachment; abbreviation copy per the
 *  team-naming rule). Pre/2nd-half/dismiss have no V1 equivalent in a real game, so they're skipped. */
async function sendV1ForStep(step, h, a) {
	const score = `${h} ${step.hs}–${step.as} ${a}`;
	// Crest per the production rule: goal → scoring club; FT → winner (draw → home); else home.
	let crestAbbr = h;
	let event, title, subtitle;
	if (step.kind === "kickoff") {
		event = "kickoff"; title = `Kickoff: ${h} vs ${a}`; subtitle = "The match is underway";
	} else if (step.kind === "goal") {
		event = "goal"; title = `GOAL: ${score}`; subtitle = step.sc ?? "Goal";
		crestAbbr = step.scoringAbbr ?? h;
	} else if (step.kind === "ht") {
		event = "halftime"; title = `Halftime: ${score}`; subtitle = "It's the break";
	} else if (step.kind === "ft") {
		event = "fulltime"; title = `Full time: ${score}`;
		subtitle = step.hs === step.as ? "It's a draw" : "Winners take the points";
		crestAbbr = step.hs > step.as ? h : step.as > step.hs ? a : h;
	} else return;
	await pushV1({ label: `${event} ${score}`, title, subtitle, event, imageUrl: `${CARD_URL}/thumb/${crestAbbr}?s=3` });
}

/** The "Lineups in" V1 push (--with-v1 inserts it 60s after the pre-start, like the real Stage-D push). */
async function sendV1Lineup(h, a) {
	await pushV1({
		label: `lineup ${h} vs ${a}`,
		title: `Lineups in: ${h} vs ${a}`,
		subtitle: "Starting XIs are posted",
		event: "lineup",
		imageUrl: `${CARD_URL}/thumb/${h}?s=3`,
	});
}

async function pushV1({ label, title, subtitle, body, event, imageUrl }) {
	const res = await fetch(`${WATCHER_URL}/test-push`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-trigger-secret": SECRET },
		// token present → only your phone; omitted → fans out to ALL device tokens. Same eventID across the
		// goal and the correction → both carry thread-id match-<MATCH_ID> → they stack on the lock screen.
		body: JSON.stringify({ eventID: MATCH_ID, event, title, subtitle, body, imageUrl, ...(MY_DEVICE_TOKEN ? { token: MY_DEVICE_TOKEN } : {}) }),
	});
	const out = await res.json().catch(() => ({}));
	const fails = (out.results ?? []).filter((r) => !r.ok).map((r) => `${r.status}:${r.reason ?? "?"}`);
	const tag = out.error ? `ERROR: ${out.error}` : `${out.okCount ?? 0}/${out.tokenCount ?? 0} ok`;
	console.log(`  V1 push  ${label.padEnd(32)} → HTTP ${res.status} (${tag})${fails.length ? "  fails: " + fails.join(", ") : ""}`);
	return { httpOk: res.ok, tokenCount: out.tokenCount ?? 0, error: out.error };
}

async function laRollback({ label, hs, as, min }) {
	const res = await fetch(`${WATCHER_URL}/test-activity`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-trigger-secret": SECRET },
		body: JSON.stringify({ mode: "update", matchId: MATCH_ID, phase: "live", hs, as, min }),
	});
	const out = await res.json().catch(() => ({}));
	const tag = out.error ? `ERROR: ${out.error}` : `${out.okCount ?? 0}/${out.tokenCount ?? 0} ok`;
	console.log(`  V2 LA    ${label.padEnd(32)} → HTTP ${res.status} (${tag})`);
}

/**
 * Replay a VAR goal correction on the real match: re-fire the last real goal as a V1 push, then DISALLOW
 * it — a V1 correction push (red "GOAL DISALLOWED" card, struck old score, stacks under the goal via
 * thread-id) + a silent V2 Live Activity score rollback. This exercises the OUTPUT side (copy, card,
 * stacking, LA backward); the detection→debounce path is proven separately by `node --test`.
 */
async function runCorrection(summary) {
	const { steps, h, a } = buildTimeline(summary);
	const goals = steps.filter((s) => s.kind === "goal");
	if (!goals.length) throw new Error("No goal in this match to disallow.");
	const lastGoal = goals[goals.length - 1];
	const before = steps[steps.indexOf(lastGoal) - 1] ?? { hs: 0, as: 0 }; // score the goal rolls back to
	const old = { hs: lastGoal.hs, as: lastGoal.as };
	const corrected = { hs: before.hs, as: before.as };
	const scorer = (lastGoal.sc ?? "").replace(/\s+\d+'.*$/, "").trim();

	console.log(`\n▶ Correction plan (${h} home / ${a} away, event ${MATCH_ID}):`);
	console.log(`  goal      ${h} ${old.hs}–${old.as} ${a}${scorer ? "  · " + scorer : ""}`);
	console.log(`  disallow  → ${h} ${corrected.hs}–${corrected.as} ${a}  (VAR)`);
	if (DRY) {
		console.log("\n(dry run — nothing sent)\n");
		return;
	}

	console.log(`\n▶ Firing goal → correction (watch your phone)…\n`);
	// 2026-07-05 redesign: title+subtitle, square crest attachment (scoring club's crest).
	const g = await pushV1({
		label: `GOAL ${h} ${old.hs}–${old.as} ${a}`,
		title: `GOAL: ${h} ${old.hs}–${old.as} ${a}`,
		subtitle: scorer ? `${scorer} ${lastGoal.matchMin}'` : "Goal",
		event: "goal",
		imageUrl: `${CARD_URL}/thumb/${lastGoal.scoringAbbr ?? h}?s=3`,
	});
	if (!g.httpOk) {
		console.error(g.error ? `\n✗ Goal push errored: ${g.error}` : "\n✗ Goal push reached 0 devices — no registered V1 device tokens. Aborting.");
		process.exit(1);
	}

	await sleep(6000);
	await pushV1({
		label: `DISALLOWED ${h} ${corrected.hs}–${corrected.as} ${a}`,
		title: `NO GOAL: ${h} ${corrected.hs}–${corrected.as} ${a}`,
		subtitle: "VAR review — goal disallowed",
		event: "correction",
		imageUrl: `${CARD_URL}/thumb/${lastGoal.scoringAbbr ?? h}?s=3`,
	});

	await sleep(2000);
	await laRollback({ label: `roll back to ${corrected.hs}–${corrected.as}`, hs: corrected.hs, as: corrected.as, min: lastGoal.matchMin + 2 });

	console.log(`\n✅ Correction sent. Expect the "Goal Disallowed" card stacked under the goal, and the Live Activity rolled back to ${corrected.hs}–${corrected.as} (if one was active).\n`);
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
	console.log(`\n🟢 Live Activity replay — ${DRY ? "DRY RUN" : "LIVE"}  (matchId=${MATCH_ID}, ~${TOTAL_MIN} min)`);
	console.log(SINGLE_DEVICE ? `🎯 Single-device mode — sending ONLY to your phone (start${MY_DEVICE_TOKEN ? " + V1" : ""} token set).\n` : `📡 Fan-out mode — sending to ALL registered devices.\n`);
	if (!DRY && !SECRET) {
		console.error("✗ MANUAL_TRIGGER_SECRET not set. Run with the watcher's trigger secret, or use --dry-run.");
		process.exit(1);
	}

	const { summary, eventId } = await resolveSummary();

	if (CORRECTION) {
		await runCorrection(summary);
		return;
	}

	let { steps, h, a } = buildTimeline(summary);
	if (START_ONLY) steps = steps.filter((s) => s.kind === "pre");
	else if (UPDATES_ONLY) steps = steps.filter((s) => s.kind !== "pre");
	schedule(steps);

	// --with-v1: the "Lineups in" V1 moment, 60s after the pre-start (pre-kickoff, like the real push).
	if (WITH_V1 && !START_ONLY && !UPDATES_ONLY) {
		steps.splice(1, 0, { kind: "lineup", label: "Lineups posted (V1)", phase: "pre", hs: 0, as: 0, matchMin: -1, offsetSec: 60 });
	}
	// --ht-hold: dwell at halftime before the second half; everything after shifts by the same delta.
	const hi = steps.findIndex((s) => s.kind === "ht");
	if (HT_HOLD_S > 0 && hi >= 0 && hi + 1 < steps.length) {
		const delta = steps[hi].offsetSec + HT_HOLD_S - steps[hi + 1].offsetSec;
		if (delta > 0) for (let j = hi + 1; j < steps.length; j++) steps[j].offsetSec += delta;
	}

	// Live run: DON'T dump the whole schedule up front (it reads like the replay already happened in
	// one shot). Print only a one-line summary; each step's line then appears LIVE as it actually fires,
	// paced across the wall-clock window. The full per-step schedule prints only in --dry-run (a preview).
	const lastOff = steps.length ? steps[steps.length - 1].offsetSec : 0;
	if (DRY) {
		console.log(`\n▶ Schedule (${steps.length} steps, ${h} home / ${a} away, event ${eventId}):`);
		for (const s of steps) console.log(`  [${fmtClock(s.offsetSec)}] ${s.label.padEnd(34)} ${s.phase.padEnd(9)} ${s.hs}-${s.as}${s.sc ? "  · " + s.sc : ""}`);
	} else {
		console.log(`\n▶ ${steps.length} steps, ${h} ${DRY ? "" : "home"} vs ${a}, event ${eventId} — playing out live over ~${fmtClock(lastOff)} (lines appear as each event fires).`);
	}

	if (DRY) {
		console.log("\n(dry run — nothing sent)\n");
		return;
	}

	console.log(`\n▶ Driving the lifecycle (watch your phone)…\n`);
	let t0 = Date.now();
	let warnedNoActivity = false;
	for (let i = 0; i < steps.length; i++) {
		const step = steps[i];
		const wait = step.offsetSec * 1000 - (Date.now() - t0);
		if (wait > 0) await sleep(wait);
		if (step.kind === "lineup") {
			// V1-only moment — no V2 state change pre-kickoff.
			console.log(`  [${fmtClock(step.offsetSec)}] v1     ${step.label}`);
			await sendV1Lineup(h, a);
			continue;
		}
		const r = await send(step, h, a);
		if (WITH_V1) await sendV1ForStep(step, h, a); // mirror the moment as a V1 rich push too

		if (step.kind === "pre" && !r.httpOk) {
			if (r.error) console.error(`\n✗ Start fan-out errored server-side. Aborting.\n   ${r.error}`);
			else console.error("\n✗ Start fan-out reached 0 devices (no push-to-start tokens registered). Aborting.\n   → Confirm the TestFlight build is installed, signed in, and notifications are enabled on at least one device.");
			process.exit(1);
		}
		// Updates target the per-Activity tokens in live_activities. 0 here means no device has uploaded
		// one for this matchId — the push-started Activity needs the app RUNNING to register its token.
		if (step.kind !== "pre" && step.kind !== "end" && r.tokenCount === 0) {
			if (UPDATES_ONLY && i === 0) {
				console.error(`\n✗ No per-Activity token registered for matchId='${MATCH_ID}'. Aborting.\n   → Fire a start with the app OPEN first (e.g. --start-only), confirm a live_activities row, then retry --updates-only.`);
				process.exit(1);
			}
			if (!warnedNoActivity) {
				warnedNoActivity = true;
				console.warn(`   ⚠ 0 per-Activity tokens for matchId='${MATCH_ID}' yet — the started Activity hasn't uploaded its token.\n     Keep the app OPEN on the test phone; later steps pick it up once it registers. (Ctrl-C to stop.)`);
			}
		}
	}
	if (START_ONLY) console.log(`\n✅ Start sent. Open the app on the test phone, confirm a live_activities row for '${MATCH_ID}', then run with --updates-only.\n`);
	else console.log(`\n✅ Replay complete — FT card will auto-dismiss shortly.\n`);
}

main().catch((e) => {
	console.error(`\n✗ ${e.message}\n`);
	process.exit(1);
});
