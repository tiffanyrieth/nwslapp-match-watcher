# nwslapp-match-watcher

A scheduled Cloudflare Worker that powers **NWSLApp's live match-event push
notifications** (Tier 2 / server push). It is the sibling of
[`nwslapp-proxy`](../nwslapp-proxy): the proxy is request/response and caches
ESPN; this Worker is a cron job that watches matches and sends APNs pushes.

**Scope: kickoff · goal · halftime · full-time** — every live event the
scoreboard's `status` exposes. **Substitutions + lineup-posted are not here:** the
scoreboard `details` carry goals and cards but no subs, and lineups aren't on the
scoreboard at all — both need the per-match `/summary` endpoint (a later stage).

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
