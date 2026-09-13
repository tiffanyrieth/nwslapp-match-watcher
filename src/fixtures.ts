/**
 * Fixture-window polling — the "check the schedule first, patrol only near game time" engine.
 *
 * BEFORE (2026-07-16 stress finding): every cron minute fetched the NWSL scoreboard + ALL 15
 * national-team competition feeds unconditionally — 16 × 1440 ≈ 23,000 proxy invocations/day at
 * zero users (~23% of the Workers-free 100k/day request cap), overwhelmingly polling feeds with
 * no fixture anywhere near. Only the KV/APNs work was live-gated; the FETCHES never were.
 *
 * AFTER: a compact KV **fixture index** (id / feed / kickoff / ended) is rebuilt by a DISCOVERY
 * pass every ~6h (one 16-feed sweep, ~64 fetches/day). The per-minute tick reads the index (one
 * KV read, zero proxy calls) and polls ONLY feeds with a fixture in its ACTIVE window:
 *
 *     [kickoff − ACTIVE_LEAD_MS (75m) … kickoff + ACTIVE_TAIL_MS (4h)],  minus ended fixtures
 *
 * 75 min = LINEUP_LEAD_MS, the widest pre-kickoff consumer (lineup polling ⊃ the 20-min LA-start
 * window); 4h matches the existing WINDOW_PAST_MS live-window backstop. A fixture observed at
 * state "post" is marked `ended` so its feed goes quiet on the next tick instead of coasting to
 * the 4h cap. No active fixtures and no discovery due ⇒ the tick makes ZERO proxy fetches.
 *
 * Everything downstream (event diffing, lineup /summary window, 30s double-poll, LA broadcast,
 * stoppage pushes) is untouched — it just runs on the polls that still happen. Trade-off
 * (accepted, owner 2026-07-16): a fixture announced <6h before kickoff waits for the next
 * discovery pass; real fixtures are announced weeks out, and `liveMissedByIndex` logs LOUD if
 * discovery ever finds an already-live match the index never knew (the self-check that the
 * trade-off stays theoretical).
 *
 * Pure logic — no KV/fetch here (index.ts owns I/O), so `node --test test/fixtures.test.ts`
 * covers every window edge without a Workers runtime.
 */

import type { ScoreboardEvent } from "./events";

/** One scheduled match the watcher may need to poll for. `feed` is "nwsl" or an NT_LEAGUES slug. */
export interface Fixture {
	id: string;
	feed: string;
	kickoffMs: number;
	/** Set once the match has been observed at state "post" — its window closes immediately. */
	ended?: boolean;
}

export interface FixtureIndex {
	builtAt: number;
	fixtures: Fixture[];
}

/** The club scoreboard's feed key in the index (NT feeds use their ESPN league slug). */
export const NWSL_FEED = "nwsl";

/** CLUB feeds: the NWSL league feed + the two cup competitions NWSL clubs play in. All flow
 *  through the SAME club detect loop in index.ts (per-team fan-out by ESPN team id, V2 LA start +
 *  broadcast sync, lineup pass) — a followed club alerts identically whether the fixture is
 *  league, Challenge Cup, or Champions Cup (the 2026-08 gap fix: the cups were in the app's
 *  calendar but never polled here). Both cups are seasonal (Challenge Cup ≈ one match/yr) → the
 *  fixture-window gate makes them free at rest; a foreign Champions Cup opponent simply matches
 *  zero follower rows, so fan-out stays correct for free. */
export const CLUB_FEEDS = [NWSL_FEED, "usa.nwsl.cup", "concacaf.w.champions_cup"] as const;

/** Feed slug → the SHORT competition label shown on the V2 card's bottom-left + the V1 kickoff
 *  subtitle. Deliberately terse (owner 2026-08-06): the card's label slot is small, and long names
 *  add payload bytes for no glanceable value. The label is a VALUE in the existing `competition`
 *  attribute — never a structure change (START-PAYLOAD LAW, docs/live-activity-v2.md §0). */
export const FEED_LABEL: Record<string, string> = {
	[NWSL_FEED]: "NWSL",
	"usa.nwsl.cup": "Challenge Cup",
	"concacaf.w.champions_cup": "CONCACAF",
	"fifa.friendly.w": "Friendly",
	"fifa.shebelieves": "SheBelieves",
	"concacaf.w.gold": "Gold Cup",
	"concacaf.womens.championship": "W Championship",
	"uefa.weuro": "Euro",
	"fifa.wwc": "World Cup",
	"fifa.w.olympics": "Olympics",
	"uefa.w.nations": "Nations League",
	"fifa.wworldq.uefa": "WC Qualifying",
	"afc.w.asian.cup": "Asian Cup",
	"caf.w.nations": "WAFCON",
	"conmebol.america.femenina": "Copa América",
	"fifa.wwcq.ply": "WC Qualifying",
	"fifa.w.concacaf.olympicsq": "Olympic Qualifying",
	"global.pinatar_cup": "Pinatar Cup",
	"global.w.finalissima": "Finalissima",
};

/** Competition label for a club-feed event: the feed's label, except NWSL postseason fixtures —
 *  ESPN serves playoffs on the same feed with `season.slug = "playoffs---…"` (live-verified
 *  2026-08-06) → "NWSL Playoffs". HARD FALLBACK to the plain feed label on any unknown slug shape. */
export const clubEventLabel = (feed: string, event: ScoreboardEvent): string => {
	const base = FEED_LABEL[feed] ?? "NWSL";
	if (feed === NWSL_FEED && event.season?.slug?.startsWith("playoffs")) return "NWSL Playoffs";
	return base;
};

/** Rebuild the index this often. 6h keeps schedule changes ≤6h stale (fixtures are announced
 *  weeks out) at ~4 sweeps × 16 feeds = ~64 proxy fetches/day. */
export const DISCOVERY_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Poll a feed this far BEFORE its fixture's kickoff — must cover the widest pre-kickoff
 *  consumer, the 75-min lineup window (which itself covers the 20-min LA-start window). */
export const ACTIVE_LEAD_MS = 75 * 60 * 1000;

/** Poll a feed this far AFTER kickoff as the backstop (matches the pre-existing live-window
 *  WINDOW_PAST_MS — keep them equal); the `ended` mark usually closes the window hours earlier at real
 *  full-time. 4h → 4.5h (2026-09-13): a knockout that goes to extra time + a shootout ends ~2h50–3h after
 *  kickoff, and 4h left little headroom for a weather delay on top. Cost: ≤30 extra proxy calls per match
 *  that never reaches `post`. */
export const ACTIVE_TAIL_MS = 4.5 * 60 * 60 * 1000;

/** Kickoff time in ms, tolerating ESPN's seconds-less timestamps ("…T17:00Z").
 *  (Moved here from index.ts so the index builder and the tick share one parser.) */
export function kickoffMs(event: ScoreboardEvent): number | null {
	if (!event.date) return null;
	const normalized = /T\d{2}:\d{2}Z$/.test(event.date) ? event.date.replace("Z", ":00Z") : event.date;
	const ms = Date.parse(normalized);
	return Number.isFinite(ms) ? ms : null;
}

const eventState = (event: ScoreboardEvent): string | undefined =>
	event.status?.type?.state ?? event.competitions?.[0]?.status?.type?.state;

/** ⚠️ Has this fixture's window genuinely closed? NOT the same as `state === "post"` — ESPN reports a
 *  SUSPENDED match as `post`, and marking it `ended` drops it from `isActive`, which STOPS POLLING the
 *  fixture. On 2026-07-29 that cost a real full-time push: the Spirit match was marked ended at the
 *  27' wind hold, kept getting diffed only as a side effect of another live match on the same feed,
 *  and went unobserved the moment that match finished.
 *
 *  ⚠️ The status set below MIRRORS `NON_FINAL_POST_STATUSES` in events.ts and must stay in sync. It is
 *  duplicated deliberately: importing the predicate would make this a VALUE import of "./events", and
 *  src/ uses extensionless imports that wrangler resolves at build time but `node --test` cannot — so
 *  it would break `test/fixtures.test.ts` at runtime. Eight lines beats changing the import convention.
 *
 *  FAIL-OPEN, same as events.ts: only positive evidence of non-completion counts, so a payload missing
 *  the flag still closes the window exactly as before. */
const NON_FINAL_POST_STATUSES = new Set([
	"STATUS_SUSPENDED",
	"STATUS_POSTPONED",
	"STATUS_DELAYED",
	"STATUS_CANCELED",
	"STATUS_CANCELLED",
	"STATUS_ABANDONED",
]);

const eventEnded = (event: ScoreboardEvent): boolean => {
	const type = (event.status ?? event.competitions?.[0]?.status)?.type;
	if (type?.state !== "post") return false;
	if (type.completed === false) return false;
	return type.name ? !NON_FINAL_POST_STATUSES.has(type.name) : true;
};

/** Is a discovery sweep due? (Missing/unreadable index ⇒ yes — the self-heal on deploy/KV loss.) */
export function discoveryDue(index: FixtureIndex | null, now: number): boolean {
	if (!index || !Array.isArray(index.fixtures) || !Number.isFinite(index.builtAt)) return true;
	return now - index.builtAt >= DISCOVERY_INTERVAL_MS;
}

/** Is this fixture inside its polling window right now? */
export function fixtureActive(fixture: Fixture, now: number): boolean {
	if (fixture.ended) return false;
	return now >= fixture.kickoffMs - ACTIVE_LEAD_MS && now <= fixture.kickoffMs + ACTIVE_TAIL_MS;
}

/** The feeds the per-minute tick must poll: every feed with ≥1 fixture in its active window. */
export function activeFeeds(index: FixtureIndex, now: number): Set<string> {
	const feeds = new Set<string>();
	for (const f of index.fixtures) {
		if (fixtureActive(f, now)) feeds.add(f.feed);
	}
	return feeds;
}

/** Build a fresh index from a full discovery sweep (feed → its scoreboard events). Events with
 *  no parseable kickoff are skipped; a match already at "post" is recorded ended (its window
 *  never opens). Kept compact: only matches within the scoreboard window arrive here anyway. */
export function buildIndex(feedEvents: ReadonlyMap<string, ScoreboardEvent[]>, now: number): FixtureIndex {
	const fixtures: Fixture[] = [];
	for (const [feed, events] of feedEvents) {
		for (const event of events) {
			const ko = kickoffMs(event);
			if (ko === null || !event.id) continue;
			const fixture: Fixture = { id: event.id, feed, kickoffMs: ko };
			if (eventEnded(event)) fixture.ended = true;
			fixtures.push(fixture);
		}
	}
	return { builtAt: now, fixtures };
}

/** Fold a polled feed's events back into the index between discoveries: add fixtures the index
 *  didn't know (a same-day addition on an already-active feed) and mark newly-"post" ones ended
 *  (closes the window at real full-time instead of the 4h backstop). Returns whether anything
 *  changed, so the caller writes KV only when it did. */
export function reconcileFeed(index: FixtureIndex, feed: string, events: ScoreboardEvent[]): boolean {
	let changed = false;
	const byId = new Map(index.fixtures.filter((f) => f.feed === feed).map((f) => [f.id, f]));
	for (const event of events) {
		const ko = kickoffMs(event);
		if (ko === null || !event.id) continue;
		const known = byId.get(event.id);
		const post = eventEnded(event);
		if (!known) {
			const fixture: Fixture = { id: event.id, feed, kickoffMs: ko };
			if (post) fixture.ended = true;
			index.fixtures.push(fixture);
			changed = true;
		} else if (post && !known.ended) {
			known.ended = true;
			changed = true;
		} else if (!post && known.kickoffMs !== ko) {
			// A reschedule ESPN applied mid-window — keep the window anchored to the real kickoff.
			known.kickoffMs = ko;
			changed = true;
		}
	}
	return changed;
}

/** DIAG (NO SILENT FAILURES): live matches a discovery sweep found that the OLD index never
 *  listed — i.e. matches whose alert window the watcher missed because the fixture appeared
 *  between sweeps. Expected to stay empty forever (fixtures are announced weeks out); the caller
 *  logs each LOUD so the accepted <6h-announcement trade-off is observable, never silent. */
export function liveMissedByIndex(
	oldIndex: FixtureIndex | null,
	feedEvents: ReadonlyMap<string, ScoreboardEvent[]>,
): { id: string; feed: string }[] {
	if (!oldIndex) return []; // first-ever build (deploy/KV loss): nothing to have missed against
	const known = new Set(oldIndex.fixtures.map((f) => `${f.feed}:${f.id}`));
	const missed: { id: string; feed: string }[] = [];
	for (const [feed, events] of feedEvents) {
		for (const event of events) {
			if (event.id && eventState(event) === "in" && !known.has(`${feed}:${event.id}`)) {
				missed.push({ id: event.id, feed });
			}
		}
	}
	return missed;
}
