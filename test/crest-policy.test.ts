import { test } from "node:test";
import assert from "node:assert/strict";
import { toPayload, eventCarriesCrest, type MatchEvent } from "../src/events.ts";

const base = (type: MatchEvent["type"], extra: Partial<MatchEvent> = {}): MatchEvent => ({
  type, eventId: "401", title: "T", subtitle: "S",
  prefColumn: "kickoff", homeAbbr: "LOU", awayAbbr: "BAY", ...extra,
}) as MatchEvent;

const CARD = "https://card.example.com";

test("crest ONLY for goal and red card", () => {
  assert.equal(eventCarriesCrest("goal"), true);
  assert.equal(eventCarriesCrest("redcard"), true);
  for (const t of ["kickoff","lineup","halftime","fulltime","correction"] as const)
    assert.equal(eventCarriesCrest(t), false, `${t} should be neutral`);
});

test("goal → imageUrl = scorer crest + mutable-content", () => {
  const p = toPayload(base("goal", { scoringSide: "away", prefColumn: "goals" }), CARD) as any;
  assert.ok(p.imageUrl.includes("/thumb/BAY"), "away goal shows away crest");
  assert.equal(p.aps["mutable-content"], 1);
});

test("red card → imageUrl = carded crest", () => {
  const p = toPayload(base("redcard", { scoringSide: "home", prefColumn: "goals" }), CARD) as any;
  assert.ok(p.imageUrl.includes("/thumb/LOU"));
  assert.equal(p.aps["mutable-content"], 1);
});

test("lineup/kickoff/HT/FT/correction → NO image, NO mutable-content", () => {
  for (const t of ["kickoff","lineup","halftime","fulltime","correction"] as const) {
    const p = toPayload(base(t, { scoringSide: t==="fulltime"?"home":undefined }), CARD) as any;
    assert.equal(p.imageUrl, undefined, `${t} must not attach a crest`);
    assert.equal(p.aps["mutable-content"], undefined, `${t} must not wake the NSE`);
    assert.equal(p.aps.alert.title, "T");            // text still present
    assert.equal(p.eventID, "401");                  // deep-link intact
    assert.equal(p.aps.sound, "default");            // still buzzes
  }
});
