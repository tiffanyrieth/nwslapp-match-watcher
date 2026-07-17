/**
 * Fixture-window polling (src/fixtures.ts) — the engine that replaced 16-feeds-every-minute
 * (23k proxy invocations/day at zero users) with poll-only-near-fixtures.
 *
 * Locks the window math (75m lead / 4h tail / ended-closes-early), discovery staleness +
 * self-heal, the complete-sweep rebuild contract, mid-window reconcile (FT-ends / additions /
 * reschedules), and the missed-window DIAG.
 *
 * Run with `node --test test/fixtures.test.ts` — deliberately NOT vitest (vitest-pool-workers
 * can't boot workerd on Node 26 here); this is pure logic, no Workers runtime needed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	ACTIVE_LEAD_MS,
	ACTIVE_TAIL_MS,
	activeFeeds,
	buildIndex,
	DISCOVERY_INTERVAL_MS,
	discoveryDue,
	fixtureActive,
	kickoffMs,
	liveMissedByIndex,
	NWSL_FEED,
	reconcileFeed,
	type Fixture,
	type FixtureIndex,
} from "../src/fixtures.ts";
import type { ScoreboardEvent } from "../src/events.ts";

const NOW = Date.parse("2026-07-16T20:00:00Z");
const MIN = 60_000;

const event = (id: string, koMs: number, state = "pre"): ScoreboardEvent =>
	({
		id,
		date: new Date(koMs).toISOString(),
		status: { type: { state, name: "STATUS" }, period: 0, clock: 0 },
		competitions: [{ status: { type: { state, name: "STATUS" }, period: 0, clock: 0 }, competitors: [] }],
	}) as unknown as ScoreboardEvent;

const fixture = (over: Partial<Fixture> = {}): Fixture => ({
	id: "401",
	feed: NWSL_FEED,
	kickoffMs: NOW + 2 * 60 * MIN,
	...over,
});

const index = (fixtures: Fixture[], builtAt = NOW): FixtureIndex => ({ builtAt, fixtures });

// ── kickoffMs ────────────────────────────────────────────────────────────────

test("kickoffMs parses ISO and ESPN's seconds-less form", () => {
	assert.equal(kickoffMs(event("1", NOW)), NOW);
	const secondsless = { id: "1", date: "2026-07-16T20:00Z" } as unknown as ScoreboardEvent;
	assert.equal(kickoffMs(secondsless), NOW);
	assert.equal(kickoffMs({ id: "1" } as unknown as ScoreboardEvent), null);
	assert.equal(kickoffMs({ id: "1", date: "garbage" } as unknown as ScoreboardEvent), null);
});

// ── window math ──────────────────────────────────────────────────────────────

test("fixture is INACTIVE before the 75-min lead", () => {
	const f = fixture({ kickoffMs: NOW + ACTIVE_LEAD_MS + MIN });
	assert.equal(fixtureActive(f, NOW), false);
});

test("fixture becomes ACTIVE exactly at the lead boundary (lineup window opens)", () => {
	const f = fixture({ kickoffMs: NOW + ACTIVE_LEAD_MS });
	assert.equal(fixtureActive(f, NOW), true);
});

test("fixture is ACTIVE while live and through the 4h tail", () => {
	assert.equal(fixtureActive(fixture({ kickoffMs: NOW - 60 * MIN }), NOW), true); // mid-match
	assert.equal(fixtureActive(fixture({ kickoffMs: NOW - ACTIVE_TAIL_MS }), NOW), true); // tail edge
});

test("fixture is INACTIVE past the 4h backstop", () => {
	const f = fixture({ kickoffMs: NOW - ACTIVE_TAIL_MS - MIN });
	assert.equal(fixtureActive(f, NOW), false);
});

test("an ended fixture closes its window immediately (real FT beats the 4h backstop)", () => {
	const f = fixture({ kickoffMs: NOW - 2 * 60 * MIN, ended: true });
	assert.equal(fixtureActive(f, NOW), false);
});

test("activeFeeds returns exactly the feeds with an in-window fixture", () => {
	const idx = index([
		fixture({ id: "a", feed: NWSL_FEED, kickoffMs: NOW + 30 * MIN }), // active (30m out)
		fixture({ id: "b", feed: "caf.w.nations", kickoffMs: NOW + 20 * 60 * MIN }), // tomorrow → inactive
		fixture({ id: "c", feed: "uefa.weuro", kickoffMs: NOW - 60 * MIN }), // live → active
		fixture({ id: "d", feed: "fifa.friendly.w", kickoffMs: NOW - 60 * MIN, ended: true }), // done
	]);
	assert.deepEqual([...activeFeeds(idx, NOW)].sort(), [NWSL_FEED, "uefa.weuro"]);
});

test("no fixtures near ⇒ zero active feeds (the zero-fetch idle tick)", () => {
	const idx = index([fixture({ kickoffMs: NOW + 26 * 60 * MIN })]);
	assert.equal(activeFeeds(idx, NOW).size, 0);
});

// ── discovery staleness + self-heal ─────────────────────────────────────────

test("discovery is due when the index is missing or malformed (self-heal)", () => {
	assert.equal(discoveryDue(null, NOW), true);
	assert.equal(discoveryDue({} as FixtureIndex, NOW), true);
	assert.equal(discoveryDue({ builtAt: Number.NaN, fixtures: [] } as FixtureIndex, NOW), true);
});

test("discovery is due after the interval, not before", () => {
	assert.equal(discoveryDue(index([], NOW - DISCOVERY_INTERVAL_MS + MIN), NOW), false);
	assert.equal(discoveryDue(index([], NOW - DISCOVERY_INTERVAL_MS), NOW), true);
});

// ── buildIndex ───────────────────────────────────────────────────────────────

test("buildIndex records every feed's fixtures; post arrives pre-ended; dateless skipped", () => {
	const feeds = new Map<string, ScoreboardEvent[]>([
		[NWSL_FEED, [event("a", NOW + 60 * MIN), event("b", NOW - 3 * 60 * MIN, "post")]],
		["caf.w.nations", [{ id: "no-date" } as unknown as ScoreboardEvent, event("c", NOW + 5 * 60 * MIN)]],
	]);
	const idx = buildIndex(feeds, NOW);
	assert.equal(idx.builtAt, NOW);
	assert.equal(idx.fixtures.length, 3); // dateless skipped
	const b = idx.fixtures.find((f) => f.id === "b");
	assert.equal(b?.ended, true);
	assert.equal(idx.fixtures.find((f) => f.id === "c")?.feed, "caf.w.nations");
});

// ── reconcileFeed (mid-window updates) ──────────────────────────────────────

test("reconcileFeed marks a newly-post fixture ended (and reports the change)", () => {
	const idx = index([fixture({ id: "a", kickoffMs: NOW - 2 * 60 * MIN })]);
	const changed = reconcileFeed(idx, NWSL_FEED, [event("a", NOW - 2 * 60 * MIN, "post")]);
	assert.equal(changed, true);
	assert.equal(idx.fixtures[0].ended, true);
	// Second pass with the same data: no further change (no KV write).
	assert.equal(reconcileFeed(idx, NWSL_FEED, [event("a", NOW - 2 * 60 * MIN, "post")]), false);
});

test("reconcileFeed absorbs a same-day addition on an active feed", () => {
	const idx = index([fixture({ id: "a" })]);
	const changed = reconcileFeed(idx, NWSL_FEED, [event("a", NOW + 2 * 60 * MIN), event("new", NOW + 3 * 60 * MIN)]);
	assert.equal(changed, true);
	assert.equal(idx.fixtures.length, 2);
	assert.equal(idx.fixtures[1].id, "new");
});

test("reconcileFeed re-anchors a rescheduled kickoff", () => {
	const idx = index([fixture({ id: "a", kickoffMs: NOW + 2 * 60 * MIN })]);
	const changed = reconcileFeed(idx, NWSL_FEED, [event("a", NOW + 4 * 60 * MIN)]);
	assert.equal(changed, true);
	assert.equal(idx.fixtures[0].kickoffMs, NOW + 4 * 60 * MIN);
});

test("reconcileFeed leaves other feeds' fixtures alone (same id on another feed)", () => {
	const idx = index([fixture({ id: "a", feed: "uefa.weuro", kickoffMs: NOW + 2 * 60 * MIN })]);
	const changed = reconcileFeed(idx, NWSL_FEED, [event("a", NOW + 2 * 60 * MIN)]);
	assert.equal(changed, true); // added as an NWSL fixture…
	assert.equal(idx.fixtures.length, 2); // …without touching the uefa one
	assert.equal(idx.fixtures[0].ended, undefined);
});

// ── missed-window DIAG ───────────────────────────────────────────────────────

test("liveMissedByIndex flags a live match the old index never listed", () => {
	const old = index([fixture({ id: "known" })]);
	const feeds = new Map<string, ScoreboardEvent[]>([
		[NWSL_FEED, [event("known", NOW, "in"), event("surprise", NOW - 30 * MIN, "in"), event("future", NOW + 5 * 60 * MIN)]],
	]);
	assert.deepEqual(liveMissedByIndex(old, feeds), [{ id: "surprise", feed: NWSL_FEED }]);
});

test("liveMissedByIndex is silent on the first-ever build (nothing to have missed)", () => {
	const feeds = new Map<string, ScoreboardEvent[]>([[NWSL_FEED, [event("x", NOW, "in")]]]);
	assert.deepEqual(liveMissedByIndex(null, feeds), []);
});
