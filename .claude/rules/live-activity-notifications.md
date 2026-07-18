---
paths:
  - "src/**/*.ts"
---

# ⚠️ This watcher IS the fragile notification pipeline — MANDATORY docs before editing

**STOP. This entire Worker is the server half of a specialized, real-device-proven sports-app
notification system that is NOT reconstructable from general training.** It diffs the ESPN scoreboard
each minute to detect goals / HT / FT / red-cards / VAR corrections / lineups, fans out **V1 push** via
Cloudflare Queues, drives the **V2 Live Activity** lock-screen game card via **APNs Broadcast Channels**,
and owns the **monotonic widget-clock anchor**. It has ONE specific way it must be wired or it silently
fails (APNs returns 200, nothing renders). **Do NOT reason from first principles — reason from the docs**,
and verify on a real device (the fake-match harness `POST /debug/fake-match`, or a real game).

## Source-of-truth docs (in the sibling APP repo — read the relevant one(s) IN FULL before editing):

- **`~/Projects/NWSLApp/docs/live-activity-v2.md`** — THE V2 MANUAL. §0 = the START-PAYLOAD LAW. Read
  before touching/testing/troubleshooting ANY Live Activity payload or the broadcast layer.
- **`~/Projects/NWSLApp/docs/notifications.md`** — the WHOLE pipeline end-to-end (V1 + V2): match event →
  proxy → THIS watcher's cron → detect → APNs (Queues / Broadcast Channels) → device → render.
- **`~/Projects/NWSLApp/docs/push-fanout-scaling.md`** — the fan-out architecture (CF Queues for V1 +
  LA-start; APNs Broadcast Channels for V2). Read before any push-scale / delivery change.

## The laws that bite (device-proven — never change on theory):

- **START-PAYLOAD LAW:** a Live Activity START renders only with BOTH an `alert` object AND the payload
  wrapped in `{ aps: {…} }` on the wire (`buildStartAps` returns the CONTENTS — the sender MUST wrap).
  Omit either → APNs 200s, iOS silently drops it. `1 sent` ≠ rendered. Only a REAL-DEVICE test counts.
- **Clock anchor (`StoredState.virtualKickoff` in events.ts):** ESPN FREEZES `status.clock` at 2700/5400
  through stoppage, so re-basing `now − clock` every push snaps the widget to 45:00 — keep the EARLIEST
  virtual kickoff per period (min). Reconcile ONLY while `clockRunning` (ESPN advances `period`→2 at the
  START of the halftime break, clock frozen — reconciling through the break leaks ~15 min into the clock).
- **Widget clock = Apple mm:ss** in regular play (deliberate); the football `90'+2'` shows in added time via
  the per-minute `stoppageDisplay` broadcast (the ONLY per-minute exception). The `45'+2'` clock is IN-APP.
- **Detection keys on ESPN BOOLEANS, never text** (`redCard` boolean, not `contains("red")` — "scoRED" bug).
- **Worker→Worker needs a SERVICE BINDING** — same-account `*.workers.dev` 404s with CF **error 1042** (the
  watcher reaches the proxy via a binding, not a public fetch).
- **KV writes are on-CHANGE only** (`sameStoredState`) — a quiet minute must not write (free-tier budget).
- **Tokens = per-device, replace-not-accumulate**; zombie tokens were the V2 "delivered-but-never-renders" bug.

When you touch this Worker, **state which doc you read** and confirm the change respects its laws.
