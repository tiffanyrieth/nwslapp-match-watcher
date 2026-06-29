# Git hooks

Local guardrails for the workflow in `CLAUDE.md` ("never work on `main` —
branch first, merge via PR"). These are committed here (not in the un-tracked
`.git/hooks/`) so they survive and are visible.

## Hooks

- **`pre-commit`** — blocks committing directly onto `main`.
- **`pre-push`** — blocks deleting or force-pushing `main`; warns on a direct
  (fast-forward) push to `main`.

## Activation

Hooks are not auto-enabled by a clone — git only runs them once you point it at
this folder (a one-time, per-clone command):

```sh
git config core.hooksPath hooks
```

(Already set on the machine where these were created.)

## Important caveats

- **Local only.** They run on *this* clone/machine — not on GitHub, not on a
  fresh clone until `core.hooksPath` is set, not in the web UI.
- **A guardrail, not a lock.** Bypass intentionally with `git commit
  --no-verify` / `git push --no-verify`. They catch accidents; they don't
  enforce policy. Server-side enforcement needs GitHub branch protection /
  rulesets (Pro on private repos, free on public).
