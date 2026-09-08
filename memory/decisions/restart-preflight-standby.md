---
type: decision
created: 2026-09-08
updated: 2026-09-08
tags: [lifecycle, backend, frontend, restart, update, build, ipc]
---
# Restart preflight: build + standby child before anything is torn down

**Status:** decided (2026-09-08, user's call — "de update moet echt
bulletproof zijn. Kijk wat er mist. Hij moet echt flowless werken").
Supersedes two paragraphs of [[backend-restart-same-port]]: the rejected
"rebuilding `web/dist` as part of update" and the reasoning that IPC to a
detached child is untestable from WSL. The same-port handoff, the
sessions-die contract and the auto-pick fallback in that note all stand.

## Trigger

The first real use of the 2026-09-06 restart button (2026-09-08 morning)
came back to a page hung on the boot panel's `token check`: the bundle it
served had been built with `vite build` run from inside `web/`, where vite
finds no config, so the `__BUILD_ID__` define never ran and the bare
identifier threw inside the runtime handler — see
[[vite-config-cwd-trap]]. Beyond the hotfix, the flow had five gaps:

1. **No preflight.** teardown → spawn → wait: broken new code meant the
   sessions were already dead, the old process gone, the window stranded.
2. **`web/dist` never rebuilt** by an update (the 2026-09-06 open
   decision) — a `git pull` restarted the server and served the old UI.
3. **Dependency changes undetected** — the child would crash after teardown.
4. **A second window** got the panic panel on the token rotation instead of
   a reload on the same origin.
5. **`emptyOutDir`** during a build served a half-empty dist.

## Decision

`POST /api/restart` = preflight while the old backend is fully intact →
swap → teardown → go → handoff.

- **Preflight, in order, refusing with `422 { error }` and touching
  NOTHING** (old process serving, sessions alive, token valid, `web/dist`
  unchanged): (1) dependencies: `package-lock.json` newer than
  `node_modules/.package-lock.json`, or `node_modules` missing → refuse;
  the app never runs `npm install` itself (native `node-pty` rebuild +
  lifecycle scripts; the user installs by hand — the pill and the confirm
  say so). A missing stamp with `node_modules` present is no signal.
  (2) Frontend build, ALWAYS (≈ 250-400 ms here; deterministic beats
  mtime heuristics): vite via `process.execPath` +
  `node_modules/vite/bin/vite.js` argv array, cwd repo root, into
  `web/dist-next`, 120 s timeout, bounded output tail to server.log,
  verified (`index.html`, entry bundle, `build-id.json`). (3) Standby
  child: spawned detached with a messages-only IPC channel and
  `AI_SM_STANDBY=1`; it boots completely (imports, config, READ-ONLY
  history load) but binds nothing, writes nothing, wipes nothing, and
  its signal/uncaught handlers exit without unlinking; reports
  `standby-ready`; exits by itself on parent disconnect or a timeout
  measured from ready. Never ready / dead / timed out → refuse + SIGTERM.
- **Then, still before teardown:** rename-swap `dist` → `dist-prev`,
  `dist-next` → `dist` (restore on failure → 422). The child reads its
  web-build identity at `go`, so a step-3 refusal can never leave new
  screens on an old backend.
- **Handoff:** end sessions like `shutdown()` (history `shutdown` →
  resumable), close the listener, `go` over IPC, disconnect, wait for the
  child's `runtime.json` + `/health`, `202`, exit without unlinking.
  Post-teardown failure is still `500` + exit — now only "the proven
  child could not bind".
- **Identity file:** vite emits `web/dist/build-id.json` (`{ id }`) next
  to the bundle; the server reads it for the boot banner and the update
  checker; new reasons `dependencies changed`, `frontend build missing`,
  `frontend source changed`.
- **UI:** `422` → `refused` outcome ("Nothing was restarted", Close / Try
  again), `restarting` un-armed, polls and reconnects resume; phase copy
  "Preparing the new version…" → "Reconnecting…"; a REST 401 after boot
  that this page did not ask for probes `/health` for 5 s and reloads
  once on the same origin (index.html injects the new token); the boot
  panel settles every step even on a throw.
- **Test seam:** `AI_SM_WEB_DIST_DIR` (absolute) sets the SERVED dist dir
  so a real restart in the suite builds beside a scratch copy instead of
  swapping the repo's `web/dist` under a parallel test.

## Rejected alternatives

- **Build only when sources are newer than the build** — mtime heuristics
  (clock skew, checkouts) are exactly what produced today's unstamped
  bundle; a 300 ms build every restart is cheaper than one wrong guess.
- **Auto `npm install` on a lock change** — runs lifecycle scripts and a
  native rebuild inside a detached process; refusing with a clear sentence
  is honest and rare.
- **Validate the child by typecheck/parse only** — a full standby boot
  catches missing modules, bad config and data-dir problems that a parse
  cannot.
- **Swap dist before the standby is proven** (first cut) — review showed a
  step-3 refusal would serve new screens from old code, the exact stale
  pair the feature exists to remove.
- **Passing the listening socket over IPC** stays rejected; messages-only
  IPC is a different, simpler thing and is now proven end to end from WSL
  in `tests/restart.test.ts` (real child, real channel, same port).

Related: [[backend-restart-same-port]], [[log-everything]],
[[session-history-resume]], [[vite-config-cwd-trap]],
[[2026-09-08-bulletproof-update]]
