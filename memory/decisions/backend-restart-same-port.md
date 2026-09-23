---
type: decision
created: 2026-09-06
updated: 2026-09-23
tags: [lifecycle, backend, frontend, launcher, restart, update]
---
# Manual backend restart + "new version" notice — same-port handoff

**Status:** decided (2026-09-06); the handoff sequence is EXTENDED by
[[restart-preflight-standby]] (2026-09-08): a preflight (dependency check,
always-rebuild of `web/dist`, standby child proven over messages-only IPC)
now runs before anything is torn down, `422` = refused/untouched. The
"rebuilding web/dist is out of scope" paragraph below and the IPC
"untestable from WSL" reasoning are superseded there. (2026-09-06, user's call — "voeg ergens een knop toe voor
handmatige herstart van de backend … een popupmelding als er een nieuwe
versie van app is … de popup kun je wegklikken maar die blijft ergens hangen
… een bevestiging zoals 'weet u zeker', als er nog open sessies zijn").

## Trigger

Same incident as [[log-everything]]: the UI was rebuilt, the backend was not
restarted, HISTORY stayed empty, and the only remedy was "close the window,
wait 30 s for the grace timer, relaunch from the shortcut". The user wants
the app to notice newer code and offer the restart itself.

## Decision

- **"New version available" = code on disk newer than the running process.**
  Live check on authed `GET /api/runtime` (`update: { available, reason }`,
  cached ≤ 5 s): git HEAD changed since boot, `web/dist` rebuilt after
  `startedAt`, or any `server/*.ts|mjs` / `shared/*.ts` mtime past
  `startedAt`. The UI polls it every 30 s while visible — never on the 3 s
  session poll.
- **Restart = same-port handoff to a fresh process.** `POST /api/restart`
  (authed like every route): the old process ends sessions exactly as
  `shutdown()` does (history stamped `shutdown` → those entries carry the
  `resume` button), closes its listener, spawns a detached child
  (`process.execPath` + argv, `AI_SM_PORT_HINT=<old port>`,
  `AI_SM_RESTARTED_FROM=<pid>`), waits for the child's `runtime.json` +
  `/health`, answers `202 { port, startedAt, samePort }`, exits without
  unlinking `runtime.json` (the child owns it). The child tries the hinted
  port and falls back ONCE to auto-pick.
- **Why the same port is a HARD constraint:** the WebView2 host
  (`launcher/host/AiSessionManagerHost.cs`) locks navigation to the exact
  launch origin — scheme + host + PORT. A restart landing elsewhere strands
  the window. A port HINT on a handoff does not reverse
  [[auto-port-discovery]]: nothing is fixed, the launcher still discovers
  through `runtime.json`, and the fallback is auto-pick.
- **UI:** Settings → `BACKEND` section with a `Restart backend` button; a
  dismissible `New version available` toast; after dismissal a persistent
  amber `update` pill (attention semantics, no new colour) that reopens the
  confirmation; the confirmation states how many sessions are running, that
  they close, and that they stay in HISTORY for resume — the honest answer
  to "sla de sessies op": [[session-history-resume]] already keeps them, so
  no new "save" mechanism is invented. During the gap the UI pauses its
  polls/reconnects and suppresses the fatal-on-401 path, then reloads the
  same origin (new token arrives with `index.html`; localStorage layout
  survives — same origin).

## Rejected alternatives

- **Restart on a new auto-picked port + navigate** — blocked by the host's
  exact-origin lock; also a new origin wipes localStorage layouts
  ([[localstorage-origin-port-churn]]).
- **Passing the listening socket to the child over IPC** (zero-downtime,
  guaranteed same port) — Node supports it, but IPC + `detached` +
  `unref`/`disconnect` ordering inside a setsid'd process is fragile and
  untestable from WSL against the real host; close-then-rebind with a
  fallback covers the realistic case.
- **Sessions surviving a restart** — impossible without the socket handoff
  AND PTY fd inheritance; the scope doc's "sessions die with the server" holds.
  The dialog says so instead of pretending.
- **A new history end reason `restart`** — would change the protocol and
  the HISTORY row labels for no user-visible gain; `shutdown` already yields
  the resume button.
- **Rebuilding `web/dist` as part of "update"** — out of scope; the dev-flow
  builds before committing. Recorded as open: a pulled checkout without
  `web/dist` still needs `npm run build`.

Related: [[lifecycle-bound-backend]], [[detached-backend]],
[[native-webview2-host]], [[2026-09-06-restart-and-update]]

## From the scope doc (moved 2026-09-23)

Verbatim wording of the `.claude/PROJECT-SCOPE.md` bullet before part O1 condensed it; the scope doc holds the current rule.

### Architecture (decided) — Manual backend restart + "new version" notice

- **Manual backend restart + "new version" notice — decided 2026-09-06,
  user's call; preflight-first ("bulletproof update") decided 2026-09-08,
  user's call** (rationale in `memory/decisions/backend-restart-same-port.md`
  and `memory/decisions/restart-preflight-standby.md`).
  Authed `GET /api/runtime` carries `update: { available, reason }` — true
  when the code on disk is newer than the running process. Reasons, in
  precedence order: `dependencies changed` (package-lock.json newer than
  node_modules/.package-lock.json, or node_modules missing), `server code
  changed (a → b)` (git HEAD moved since boot), `frontend build missing`
  (no `web/dist`, no entry bundle, or no `build-id.json`), `frontend
  rebuilt` (dist newer than `startedAt` / entry bundle renamed), `frontend
  source changed` (web/src, web/index.html, web/mascot.html, web/public, vite.config.ts or
  shared/ newer than `web/dist/build-id.json`), `server files edited`.
  **Installed mode (2026-09-08) emits exactly one reason instead of these
  six: `a new version is installed`** — `<app>/current` resolves to a
  sibling version dir with a valid `bundle.json` other than the one this
  process runs from (a half-finished or out-of-tree `current` never lights
  the pill).
  Cached ≤ 5 s; the UI polls every 30 s while visible; the raw reason never
  reaches the UI copy (mapped to plain sentences).
  `POST /api/restart` (authed) runs a **preflight while the old backend is
  fully intact** — sessions alive, listener open, data dir untouched:
  (1) dependency check → refuse; the app NEVER runs `npm install` (native
  `node-pty`, lifecycle scripts) — the user installs by hand; (2) frontend
  build, always: vite via `process.execPath` + argv array from the repo
  root into `web/dist-next`, verified (index.html, entry bundle,
  `build-id.json`), old dist served meanwhile — **in installed mode
  (2026-09-08) steps 1–2 become "verify the target bundle"**: `current`
  must resolve to a direct child of `<app>/` holding a valid `bundle.json`,
  `server/index.ts`, an executable `node/bin/node` and a built `web/dist`;
  nothing is built, staged or swapped, and the standby is spawned from the
  TARGET's own runtime (`<target>/node/bin/node <target>/server/index.ts`);
  (3) a **standby child**
  spawned detached with a messages-only IPC channel and `AI_SM_STANDBY=1`
  that boots completely (imports, config, read-only history load) but
  binds nothing and touches nothing in the data dir, then reports
  `standby-ready`; a child that never reports, dies, or times out is
  refused. Any refusal answers **`422 { error }` with the old backend
  untouched and `web/dist` unchanged** (dist-next removed). Only after all
  three: swap dist-next into `web/dist` (restore on failure → 422; only a
  directory that looks like a frontend build — `index.html` + an entry
  bundle — is ever moved aside; `dist-prev` is kept until the handoff and
  reverted if the standby dies before teardown — including restoring an
  ABSENT `web/dist` — so every 422 leaves `web/dist` as it was — the two logged exceptions are a restore whose own rename fails, and a `dist-prev` that vanished under the app), end sessions exactly like `shutdown()` (history stamped `shutdown` →
  resumable from the session history), close the listener, send `go`, wait for the
  child's `runtime.json` + `/health`, answer `202 { port, startedAt,
  samePort }` (Connection: close) and exit WITHOUT unlinking
  `runtime.json`. The child on `go` runs the crash-stamp history load,
  resets session-settings, reads the swapped web build, and listens on the
  hinted port, falling back once to auto-pick (`samePort: false` → the UI
  says relaunch from the shortcut). Before `go` the child exits by itself
  on parent disconnect or a timeout measured from `standby-ready`, and its
  signal/uncaught handlers never unlink or write anything. **Same port is
  a hard constraint**: the WebView2 host locks navigation to the exact
  launch origin including the port. The hint is a handoff detail, not a
  fixed port — auto-pick stands. Sessions do NOT survive a restart
  (decided; no fiction). **A failed handoff after teardown is still not a
  rollback** (`500` + exit; the UI says relaunch) — that window is now only
  "the proven child could not bind". `409` for a second request while a
  preflight or handoff is in flight; `503` when no restart runner is wired
  (test harnesses). Env seams that belong to this handoff only:
  `AI_SM_PORT_HINT`, `AI_SM_RESTARTED_FROM`, `AI_SM_STANDBY`; and
  `AI_SM_WEB_DIST_DIR` (absolute and normalized, never root; the SERVED dist
  dir, so tests can drive a real restart without rebuilding the repo's
  `web/dist`; a bad value is refused with a `server.log` line). The
  restart dialog can be hidden during the preflight (sessions are still
  alive); the pill then reads `Restarting` and re-opens it; every outcome
  re-opens it; it locks only during the reconnect gap; closing it hands
  focus back to the element it was opened from when that is still visible
  (the Settings button, the toast), else to the terminal. PTY sessions
  inherit none of the `AI_SM_*` handoff/seam vars (the four here plus
  `AI_SM_HOME_OVERRIDE`, B2). `web/dist-next/` and `web/dist-prev/` are
  gitignored. UI: Settings → Background service (`Restart service`, since Nocturne A7 2026-09-13), a dismissible
  `New version available` toast, a persistent amber `Update` pill after
  dismissal, a confirmation that names the running sessions and says they
  stay in History (plus a note when dependencies must be installed first);
  the dialog says "Preparing the new version…" while the preflight runs,
  "Reconnecting…" during the health wait, and on `422` "Nothing was
  restarted" with Close/Try again and the polls resumed. During the
  preflight the dialog can be put away (`Hide`, Esc, ×) WITHOUT aborting
  anything — every session is still alive and reachable, the flow runs on
  and the outcome re-opens it; during "Reconnecting…" it stays locked.
  A page whose token is rejected after boot WITHOUT having asked for a
  restart (another window restarted the backend) probes `/health` for 5 s
  and reloads once on the same origin; only silence shows the reload
  panel. The boot panel settles every step even when a handler throws
  (2026-09-08 incident: a bundle built from inside `web/` shipped a bare
  `__BUILD_ID__`; now
  `web/vite.config.ts` re-exports the root config and main.ts reads the id
  through `typeof`).
