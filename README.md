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

**4. For TestFlight (production APNs):** change `vars.APNS_HOST` in `wrangler.jsonc`
to `api.push.apple.com` and re-deploy. (Sandbox `api.sandbox.push.apple.com` is for
a build run directly from Xcode; the device-token environment must match the host.)

## Verifying delivery (during the World Cup break, no live matches)

On a **physical device** (TestFlight build, so the token is a production-APNs
token → set `APNS_HOST` to `api.push.apple.com`):

1. Sign in, enable **Goals** in Profile, grant notifications. The app uploads the
   device token to `device_tokens`. Read it there (or from the device log).
2. Fire a synthetic goal:
   ```sh
   curl -X POST https://nwslapp-match-watcher.tiffany-rieth.workers.dev/test-push \
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
