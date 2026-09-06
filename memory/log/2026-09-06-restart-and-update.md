---
type: log
created: 2026-09-06
updated: 2026-09-06
tags: [lifecycle, restart, update, frontend, backend, dev-flow]
---
# 2026-09-06 — restart button + "new version" notice SHIPPED

## What the user asked (Dutch, same afternoon as [[2026-09-06-log-everything]])

A button for a manual backend restart; a popup when a new version of the
app exists ("dan moet jij deze updaten"), dismissible but lingering
somewhere; clicking it asks "weet u zeker", and with open sessions
something like "sla de sessies op voordat je gaat updaten".

## Decision: [[backend-restart-same-port]]

Same-port handoff (`POST /api/restart`), because the WebView2 host locks
navigation to the exact origin incl. port; `update.available` on
`GET /api/runtime` = disk newer than process; sessions end (history
`shutdown` → resumable), the dialog says so instead of inventing a save.

## Built

backend-pty + terminal-ui in parallel (~18 min each), review round
(scope / security / test-engineer), one fix cycle, re-review. Suite
612 → 682. Real restarts proven against scratch backends: same port, new
pid, old pid gone, `runtime.json` never absent during the handoff, history
stamped `shutdown` (read back through the CHILD's API after its own
crash-stamp pass), old token 401 on the child, SIGTERM during the handoff
exits without the unlink.

## What review caught

- **Teardown throw = neither process serving**: `teardown()` was bare while
  `spawnChild()` was wrapped; a throwing PTY kill would leave a live pid
  with a closed listener and `runtime.json` naming it. Now a failure → 500
  + exit like every other failed handoff.
- **Raw `update.reason` (git hashes, "server files") rendered as toast
  copy** — the brief said tooltip/log; the no-code-in-UI rule mapped it to
  plain sentences.
- **Continue-note fired for non-claude commands** (`ssh -c`).
- **Busy phase left the modal with no focusable element** (keyboard user
  loose behind an aria-modal scrim).
- **Client-log flush during the gap could 401 on the child** and
  permanently switch that page's log transport off → held while
  `restarting`.
- Security notes: env/runtime.json values printed unsanitized (same-user
  forgery only), port not range-checked on either side, keep-alive reuse
  after the 202 could hit the exiting parent → `Connection: close`.
- **Test flake**: a 20 ms sleep racing a `setImmediate` exit (1 in 4 under
  full-suite load) → replaced by a queued `setImmediate` (ordering, not
  waiting). **Two vacuous e2e assertions**: "runtime.json exists after the
  handoff" (the child recreates it — a parent unlink survived the test) and
  a SIGTERM-race test that fired before the child had written anything.
  Fixed with a continuous presence sampler and a direct guard-log assertion.
  Mutation table: 11 mutants, all killed after the fixes.
- Refuted: the UI's `/health` probes flooding the child's 60/min budget —
  the 202 is only sent after the parent's own probe saw the child alive, so
  the first UI probe already succeeds (~8 slots spent, not 81).
- Doc drift caught by review: failed handoff ≠ rollback (added to the scope
  doc); `git pull` without `npm run build` leaves the pill lit after a
  successful restart → recorded as an OPEN decision (user's call).

## Open

- Open decision: build `web/dist` as part of "update"? (scope doc).
- Untested from WSL: the real WebView2 window across a restart (same-origin
  reload; the host must not show a blank/error page during the ~1 s gap),
  toast/pill/dialog visuals, `verify-terminal` live pass.
- The orchestrator session runs INSIDE the backend — the user performs the
  first restart by hand (close window, 30 s, relaunch); from then on the
  button works.
