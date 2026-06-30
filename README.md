# nwslapp-match-watcher

A scheduled Cloudflare Worker that powers **NWSLApp's live match-event push
notifications** (Tier 2 / server push). It is the sibling of
[`nwslapp-proxy`](../nwslapp-proxy): the proxy is request/response and caches
ESPN; this Worker is a cron job that watches matches and sends APNs pushes.

**Scope: kickoff · goal · halftime · full-time · correction (VAR)** — every live event the
scoreboard's `status`/score exposes. **Substitutions + lineup-posted are not here:** the
scoreboard `details` carry goals and cards but no subs, and lineups aren't on the
scoreboard at all — both need the per-match `/summary` endpoint (a later stage).

**VAR goal correction:** ESPN has no explicit "disallowed" event, so a correction is inferred from a
score *decrease* during an in-progress match. It is NOT fired immediately — a decrease can be a transient
ESPN glitch (stale/cached payload, momentary zeros), so the watcher **debounces**: wait ~12s, then re-poll
a **cache-busted** (fresh) scoreboard; only a persisting decrease fires (a reverted one is discarded,
logged). Guardrails: in-progress on BOTH snapshots (no resets / new 0-0 loads / in→final). The push is a
distinct `correction` event ("Goal Disallowed — VAR Review" + corrected score), same `thread-id` as the
goal, plus a silent Live Activity update rolling the score back. We never detect WHICH goal/why — ESPN
won't say — only that the score dropped.

## How it works

Once a minute (cron), the Worker:

1. Fetches the season scoreboard through the **proxy** (`/scoreboard`), so it
   reuses the proxy's edge cache instead of hitting ESPN directly.
2. For each match in the **live window** (kicked off within the last 4h), diffs
   its current snapshot against the last-known state in **KV** (`match:{eventId}`)
   to detect events: **kickoff** (went live in the 1st minute), **goal** (a side's
   score rose), **halftime** (`STATUS_HALFTIME`, once), **full-time** (live → ended).
3. For each event, it queries **Supabase** with the **service-role key** (bypasses
   RLS) for the device tokens of every user who follows **either** team in the
   fixture and has **that** alert enabled (`kickoff`/`goals`/`halftime`/`full_time`).
4. It signs an **APNs JWT** (ES256, `.p8`) and sends the push to each token.

First sighting of a match only baselines (no push) — except kickoff, which fires
on a live 1st minute (a clock guard avoids a false kickoff if the watcher starts
mid-match). A multi-goal jump between polls collapses to one push with the current
scoreline. A match's KV entry is deleted at full-time (and auto-expires after 6h).

Latency ≈ up to 90s (1-min cron + the proxy's 30s live cache). Sub-minute polling
would need a Durable Object alarm — a scale-only future optimization.

## Routes

- `GET /` — health/info string.
- `POST /test-push` — send a **synthetic** push to one device, to verify on-device
  delivery before real matches resume. Guarded by the `x-trigger-secret` header.
  Body: `{ "token", "title?", "subtitle?", "body?", "eventID?", "event?", "imageUrl?" }`.
  When `imageUrl` is omitted it defaults to this worker's own `/card` render, so the
  simplest call still produces the full rich (image-attached) notification.
- `POST /test-activity` — manual **V2 Live Activity** trigger (the on-device verification
  path). Guarded by `x-trigger-secret`. Body:
  `{ "mode": "start"|"update"|"end", "token?", "matchId?", "h?", "a?", "hs?", "as?", "phase?", "min?", "sc?", "comp?" }`.
  **Token targeting:** with `token` it pushes to that one device (push-to-start token for
  `start`, per-Activity token for `update`/`end`). **Omit `token` to fan out to ALL
  registered devices** — `start` → every push-to-start token (`allStartTokens`),
  `update`/`end` → every per-Activity token for `matchId` (`activityTokensForMatch`). The
  service-role read stays server-side. Returns `{ mode, matchId, tokenCount, okCount, results[] }`.
  Use a synthetic `matchId` (e.g. `replay-test`) so test rows never collide with a real
  match (the cron only ever queries matchIds in the live scoreboard). Drives `scripts/replay.mjs`.
- `GET /card/<matchId>?e&h&a&hs&as&min&sc&hid&aid&oh&oa` — the server-rendered **match-card
  PNG** (both crests + score + status pill) that rich pushes attach. See below.

## Compressed match replay (`scripts/replay.mjs`)

A zero-dep Node tool that replays a **real past match** — real goals/minutes/scorers, pulled
from the proxy's `/summary` `keyEvents` — compressed from ~90′ into ~10 min, walking the full
Live Activity lifecycle on **every** registered device (pre → kickoff → goals → HT → 2nd half →
FT → auto-dismiss) via the `/test-activity` fan-out above. Each scoring play is credited to the
team ESPN attributes it to (own goals included), and the computed final is asserted against
ESPN's. The widget shows each event's real match minute and jumps forward at each push.

```sh
node scripts/replay.mjs --dry-run                       # print timeline + schedule, send nothing
MANUAL_TRIGGER_SECRET=<secret> node scripts/replay.mjs  # live: the team's latest finished match
# flags: --event=<id> --fixture --minutes=10 --team=WAS --match-id=replay-test
#        --start-hold=30 --start-only --updates-only
```

**Per-Activity token timing (gotcha):** push-to-start creates the lock-screen Activity even with the
app closed, but the app uploads that Activity's *per-Activity update token* to `live_activities` only
while it is RUNNING to observe it. So `update`/`end` fan-out finds 0 tokens unless the test phone's app
was open around the start. Keep it foregrounded, or do it in two phases: `--start-only` (then open the
app, confirm a `live_activities` row), then `--updates-only` to drive kickoff→end.

## Rich notifications (match card + NSE)

A real match alert isn't bare text — it carries the two crests + the live score + the
moment. On iOS that needs two pieces working together:

1. **`GET /card`** renders a single PNG with **satori → SVG → resvg-wasm → PNG** (no
   headless browser; fits a Worker). Crest resolution, so a crest is **never** missing:
   self-hosted proxy `/crest?team=ABBR` (primary) → ESPN CDN by team id (`hid`/`aid`
   fallback) → a colored ring + abbreviation drawn in the card (last resort only). A
   real crest is drawn as-is, no ring. Cached at the edge by the full URL (which
   encodes score), so one render serves every recipient. Inter faces are bundled as
   Data modules; `nodejs_compat` is on (a satori dep references `process`).
2. The app's **Notification Service Extension** (in `../NWSLApp/NotificationServiceExtension`)
   wakes on `mutable-content: 1`, downloads `imageUrl`, and attaches it before display.

**Payload contract** (`toPayload` in `src/events.ts`): `aps.alert.{title,subtitle?,body}`
+ `aps."mutable-content": 1` (REQUIRED — wakes the NSE) + `aps."thread-id": "match-<id>"`
(stacks a match's events) + `aps."interruption-level": "time-sensitive"` (live events) +
top-level `eventID` (kept for the iOS deep-link) + `matchId` + `event` + `imageUrl`.

## Deployment status

**Deployed** to `https://nwslapp-match-watcher.tiffany-rieth.workers.dev` (cron
`* * * * *`, KV `MATCH_STATE` bound). Already set: `SUPABASE_URL`,
`MANUAL_TRIGGER_SECRET`. The cron runs harmlessly with the remaining secrets
unset — during the World Cup break there are no live matches, so each poll fetches
the scoreboard, finds nothing live, and returns before touching Supabase/APNs.

### Remaining to make it fire (from your accounts)

**1. Apple — APNs auth key.** Developer portal → **Keys** → **+** → enable **APNs**,
download the **`.p8`** (once only); note the **Key ID** (10 chars) + **Team ID**.
Confirm the App ID `com.tiffanyrieth.nwslapp.NWSLApp` has **Push Notifications** on.

**2. Supabase.** Run the `device_tokens` + `notification_preferences` block from
`../NWSLApp/supabase/schema.sql` in the SQL editor. Copy the **service-role** key
(Project Settings → API — full-access, treat as a password).

**3. Set the four remaining secrets + re-deploy:**
```sh
wrangler secret put APNS_KEY_P8                # paste the full .p8 PEM text
wrangler secret put APNS_KEY_ID                # the 10-char Key ID
wrangler secret put APNS_TEAM_ID               # Apple Team ID
wrangler secret put SUPABASE_SERVICE_ROLE_KEY  # full-access; bypasses RLS
npm run deploy
```

**4. APNs host — now PRODUCTION.** `vars.APNS_HOST` in `wrangler.jsonc` is set to
`api.push.apple.com` (TestFlight/App Store builds mint production tokens). A device
token registered by an Xcode **debug** build is a *sandbox* token and will silently
fail with `BadDeviceToken` against this host — re-register from the TestFlight build
(delete the old `device_tokens` row, open the app, let it re-register) before testing.
Flip back to `api.sandbox.push.apple.com` only to test against an Xcode debug build.

## Verifying delivery (during the World Cup break, no live matches)

On a **physical device** (TestFlight build, so the token is a production-APNs
token → set `APNS_HOST` to `api.push.apple.com`):

1. Sign in, enable **Goals** in Profile, grant notifications. The app uploads the
   device token to `device_tokens`. Read it there (or from the device log).
2. Fire a synthetic RICH goal (renders byte-identical to a live goal — appearance is
   purely a function of the payload):
   ```sh
   curl -X POST https://nwslapp-match-watcher.tiffany-rieth.workers.dev/test-push \
     -H "x-trigger-secret: $MANUAL_TRIGGER_SECRET" \
     -H "content-type: application/json" \
     -d '{
       "token": "<device-token>",
       "event": "goal",
       "title": "GOAL — WAS 1–0 ORL",
       "subtitle": "WAS 1–0 ORL · 67'\''",
       "body": "Washington Spirit scored.",
       "eventID": "401853925",
       "imageUrl": "https://nwslapp-match-watcher.tiffany-rieth.workers.dev/card/401853925?e=goal&h=WAS&a=ORL&hs=1&as=0&min=67&sc=S.%20Smith&hid=15365&aid=20905"
     }'
   ```
   The collapsed banner shows the crest thumbnail; expanding shows the composited
   match-card (both crests + score + Live pill). Tapping deep-links into the match.

When real matches resume, the cron path takes over automatically.

## Notes
- APNs requires HTTP/2; Cloudflare Workers `fetch` speaks it to Apple.
- A token that APNs reports `Unregistered`/`BadDeviceToken` should eventually be
  pruned from `device_tokens` (a future cleanup pass; logged for now).
