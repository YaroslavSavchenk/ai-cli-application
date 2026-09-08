---
type: decision
created: 2026-09-06
updated: 2026-09-08
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
