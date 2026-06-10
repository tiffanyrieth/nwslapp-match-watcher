# nwslapp-match-watcher

A scheduled Cloudflare Worker that powers **NWSLApp's live match-event push
notifications** (Tier 2 / server push). It is the sibling of
[`nwslapp-proxy`](../nwslapp-proxy): the proxy is request/response and caches
ESPN; this Worker is a cron job that watches matches and sends APNs pushes.

**Stage B scope: GOALS.** Kickoff / halftime / full-time / substitutions are
added later as more detection cases on the same pipeline.

## How it works

Once a minute (cron), the Worker:

1. Fetches the season scoreboard through the **proxy** (`/scoreboard`), so it
   reuses the proxy's edge cache instead of hitting ESPN directly.
2. For each **live** match (`status.type.state === "in"`), diffs the current
   score against the last-known score stored in **KV** (`match:{eventId}`).
3. When a side's score has risen, it's a goal. The Worker queries **Supabase**
   with the **service-role key** (bypasses RLS) for the device tokens of every
   user who follows **either** team in the fixture and has the `goals` alert on.
4. It signs an **APNs JWT** (ES256, `.p8`) and sends the push to each token.

First sighting of a match only sets a baseline (no push). A multi-goal jump
between polls collapses to one push carrying the current scoreline. KV entries
auto-expire 6h after last write.

Goal latency ≈ up to 90s (1-min cron + the proxy's 30s live cache). Sub-minute
polling would need a Durable Object alarm — a scale-only future optimization.

## Routes

- `GET /` — health/info string.
- `POST /test-push` — send a **synthetic** push to one device, to verify on-device
  delivery before real matches resume. Guarded by the `x-trigger-secret` header.
  Body: `{ "token": "<apns-device-token>", "title?": "...", "body?": "...", "eventID?": "..." }`.

## One-time setup

> Replace every `REPLACE_…` placeholder in `wrangler.jsonc` as you go.

### 1. Apple — APNs auth key
- Apple Developer portal → **Certificates, Identifiers & Profiles → Keys** → **+**.
- Enable **Apple Push Notifications service (APNs)**, download the **`.p8`** (you
  can only download it once). Note the **Key ID** (10 chars) and your **Team ID**.
- Confirm the App ID `com.tiffanyrieth.nwslapp.NWSLApp` has the **Push
  Notifications** capability enabled.

### 2. Supabase — schema + service-role key
- Run the `device_tokens` + `notification_preferences` block from
  `../NWSLApp/supabase/schema.sql` in the Supabase SQL editor.
- Copy the **service-role** key (Project Settings → API). It is full-access —
  treat it like a password; it lives only as a Worker secret.
- Put the project URL in `wrangler.jsonc` `vars.SUPABASE_URL`.

### 3. Cloudflare — KV + config
```sh
npm install
wrangler kv namespace create MATCH_STATE      # paste the id into wrangler.jsonc
```
Fill `wrangler.jsonc` `vars`: `APNS_TEAM_ID`, `APNS_KEY_ID`, `SUPABASE_URL`.
Leave `APNS_HOST` as `api.sandbox.push.apple.com` while testing with a build run
from Xcode; switch to `api.push.apple.com` for TestFlight/App Store builds.

### 4. Secrets
```sh
wrangler secret put APNS_KEY_P8                # paste the full .p8 PEM text
wrangler secret put SUPABASE_SERVICE_ROLE_KEY
wrangler secret put MANUAL_TRIGGER_SECRET      # any long random string
```

### 5. Deploy
```sh
npm test          # unit-tests the goal-diff logic
npm run typecheck
npm run deploy
```

## Verifying delivery (during the World Cup break, no live matches)

On a **physical device** (TestFlight build, so the token is a production-APNs
token → set `APNS_HOST` to `api.push.apple.com`):

1. Sign in, enable **Goals** in Profile, grant notifications. The app uploads the
   device token to `device_tokens`. Read it there (or from the device log).
2. Fire a synthetic goal:
   ```sh
   curl -X POST https://nwslapp-match-watcher.<subdomain>.workers.dev/test-push \
     -H "x-trigger-secret: $MANUAL_TRIGGER_SECRET" \
     -H "content-type: application/json" \
     -d '{"token":"<device-token>"}'
   ```
   A `GOAL — WAS 1–0 ORL` push should arrive; tapping it deep-links into the match.

When real matches resume, the cron path takes over automatically.

## Notes
- APNs requires HTTP/2; Cloudflare Workers `fetch` speaks it to Apple.
- A token that APNs reports `Unregistered`/`BadDeviceToken` should eventually be
  pruned from `device_tokens` (a future cleanup pass; logged for now).
