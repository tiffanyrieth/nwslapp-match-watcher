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
const SECRET = process.env.MANUAL_TRIGGER_SECRET ?? process.env.TRIGGER_SECRET ?? "";
const FIXTURE_PATH = resolve(__dirname, "../../NWSLApp/NWSLAppTests/Fixtures/summary.json");

// Scheduling constants.
const START_HOLD_S = 12; // start → first update: time for devices to receive the start push and register
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
	console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 38).join("\n").replace(/^ \*?/gm, ""));
	process.exit(0);
}
const DRY = has("--dry-run");
const USE_FIXTURE = has("--fixture");
const PINNED_EVENT = val("event", null);
const TOTAL_MIN = Number(val("minutes", "10"));
const TEAM = val("team", "WAS").toUpperCase();
const MATCH_ID = val("match-id", "replay-test");

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
			steps.push({ kind: "goal", label: `Goal ${ev.clock?.displayValue} ${who}${og}`, matchMin: min, phase: "live", hs, as, sc: `${who} ${ev.clock?.displayValue ?? `${min}'`}${og}` });
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
	if (mode === "start") Object.assign(body, { h, a, comp: "NWSL" });
	if (step.matchMin > 0 && step.phase === "live") body.min = step.matchMin;
	if (step.sc) body.sc = step.sc;

	const res = await fetch(`${WATCHER_URL}/test-activity`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-trigger-secret": SECRET },
		body: JSON.stringify(body),
	});
	const out = await res.json().catch(() => ({}));
	const fails = (out.results ?? []).filter((r) => !r.ok).map((r) => `${r.status}:${r.reason ?? "?"}`);
	const tag = `${out.okCount ?? 0}/${out.tokenCount ?? 0} ok`;
	console.log(`  [${fmtClock(step.offsetSec)}] ${mode.padEnd(6)} ${step.label.padEnd(34)} → HTTP ${res.status} (${tag})${fails.length ? "  fails: " + fails.join(", ") : ""}`);
	return { httpOk: res.ok, tokenCount: out.tokenCount ?? 0 };
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
	console.log(`\n🟢 Live Activity replay — ${DRY ? "DRY RUN" : "LIVE"}  (matchId=${MATCH_ID}, ~${TOTAL_MIN} min)\n`);
	if (!DRY && !SECRET) {
		console.error("✗ MANUAL_TRIGGER_SECRET not set. Run with the watcher's trigger secret, or use --dry-run.");
		process.exit(1);
	}

	const { summary, eventId } = await resolveSummary();
	const { steps, h, a } = buildTimeline(summary);
	schedule(steps);

	console.log(`\n▶ Schedule (${steps.length} steps, ${h} home / ${a} away, event ${eventId}):`);
	for (const s of steps) console.log(`  [${fmtClock(s.offsetSec)}] ${s.label.padEnd(34)} ${s.phase.padEnd(9)} ${s.hs}-${s.as}${s.sc ? "  · " + s.sc : ""}`);

	if (DRY) {
		console.log("\n(dry run — nothing sent)\n");
		return;
	}

	console.log(`\n▶ Driving the lifecycle (watch both phones)…\n`);
	let t0 = Date.now();
	for (let i = 0; i < steps.length; i++) {
		const wait = steps[i].offsetSec * 1000 - (Date.now() - t0);
		if (wait > 0) await sleep(wait);
		const r = await send(steps[i], h, a);
		if (i === 0 && (!r.httpOk || r.tokenCount === 0)) {
			console.error("\n✗ Start fan-out reached 0 devices (no push-to-start tokens registered). Aborting.\n   → Confirm the TestFlight build is installed, signed in, and notifications are enabled on at least one device.");
			process.exit(1);
		}
	}
	console.log(`\n✅ Replay complete — FT card will auto-dismiss shortly.\n`);
}

main().catch((e) => {
	console.error(`\n✗ ${e.message}\n`);
	process.exit(1);
});
