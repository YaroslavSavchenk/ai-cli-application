---
type: log
created: 2026-09-06
updated: 2026-09-06
tags: [logging, security, backend, frontend, dev-flow]
---
# 2026-09-06 — "log everything" phase SHIPPED

## What the user reported

Dutch, 2026-09-06: "Ik zie nog steeds geen history als ik een sessie start
… Start vanuit last werkt, maar ik wil handmatig kunnen starten vanuit
oudere sessies. Verder wil ik dat jij ook logging toevoegt, dat alles gelogd
wordt."

## Diagnosis of the history complaint: not a bug

Backend pid 1160 started 10:49 CEST; the history commit landed 12:14; `web/dist`
was rebuilt 12:14. The NEW UI called `/api/history` on the OLD backend → 404
→ HISTORY section empty. The running backend's log still said `journal
rotated` (old code). This orchestrator session itself runs INSIDE pid 1160
(`bash → claude → 1160`), so the backend could not be restarted from here.
Remedy given to the user: close the window, wait ~30 s (grace), relaunch.
Lesson: a stale backend was invisible — nothing logged the 404, nothing said
which code was running. That became the trigger for the logging phase and
for the restart/update phase that follows ([[2026-09-06-restart-and-update]]).

## What was built (decision: [[log-everything]])

Two developers in parallel (backend-pty, terminal-ui), then scope-reviewer +
security-auditor + test-engineer, two fix cycles, re-reviews clean.
- `debug` level, `AI_SM_LOG_LEVEL` (default debug), `[component]` tags,
  stacks via `describeError`/`errorStackOnly`/`errorFrames`, boot banner
  (node, pid, data dir, level, redacted `AI_SM_*`, git commit via
  `server/buildinfo.ts`, web build), `GET /api/runtime` + `serverCommit`/
  `webBuild`, access log, WS/session/history/lifecycle/store lines, byte
  counts ≤1/s for input AND output, `POST /api/client-log` with caps,
  `createWindowLimiter` backing both the client-log budget and the shared
  refusal budget (trust-keyed), rotation 10 MiB × 3 with truncate fallback.
- Web: `log-core.ts` (DOM-free engine) + `log.ts` (glue), global error
  capture, `api.ts`/`ws.ts`/UI-action instrumentation, `__BUILD_ID__`.
- Suite 546 → 612. Typecheck clean. Live restart of scratch backends only.

## What review caught (worth remembering)

- **Banner leaked `user:password@`** from `AI_SM_GITHUB_API_BASE` — caught by
  an existing test; redaction by name pattern AND URL-userinfo shape.
- **Client shipped raw query values** (`?path=/mnt/c/...`) into the same file
  the server redacted them from — the merge seam between two parallel
  developers is where redaction rules die. Fixed to `?…` on both ends.
- **`serverCommit`/`webBuild` were dead fields** — the UI never printed them;
  the phase's own trigger incident would have stayed invisible.
- **Unauthenticated access log = log-wipe primitive**: 15 KB paths × 640
  no-cors requests rotated everything in seconds. Cycle 1 capped paths +
  metered 4xx; cycle 2 (auditor residual) showed unauthenticated 2xx
  (`/health`, `/`) still wiped it in minutes → meter on trust (a `WeakSet`
  of responses that passed the token check), one shared limiter for HTTP+WS.
- **`errorFrames` defeated by a body containing `\n    at `** — V8 quotes
  ~10 chars of `JSON.parse` input unescaped; strip the `name: message` header
  by LENGTH, and return `''` on mismatch.
- **Rotate failure wedged the logger forever** (`bytes` never reset).
- **Volume**: per-keystroke, per-kept-history-entry, per-ping and the
  client-log POST itself at info ≈ 10 MB/day idle → all aggregated.
- **Vacuous tests, twice**: a `warn`-level end-to-end test that passed on an
  EMPTY log; a prune-summary test on an EMPTY history (200-line regression
  stayed green). Test-engineer's mutation table is the real gate.
- **10-char canary rule**: Node quotes exactly 10 chars of a bad JSON body;
  a body-leak canary longer than that never appears in the message.
- Trap: seeding `ended: null` history entries does not create non-candidates
  — boot crash-stamps them.

## Open

- Janitor pass deferred until after the restart/update phase (same files).
- Coverage gaps (LOW): `log.ts` timer unref, real 10 MiB rotation, UI
  call-site pinning, `__BUILD_ID__`.
- User-side: backend restart still required to get any of this (this
  session's backend predates it).
