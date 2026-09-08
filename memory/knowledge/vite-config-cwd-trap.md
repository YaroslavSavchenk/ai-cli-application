---
type: knowledge
created: 2026-09-08
updated: 2026-09-08
tags: [frontend, build, vite, boot, incident]
---
# Vite reads its config from the cwd, not from `root` — an unstamped bundle hangs the boot

**Incident (2026-09-08):** the first real backend restart came back to a
page stuck on the boot panel's `token check`. server.log had the cause in
one line: `[client] unhandled rejection: ReferenceError: __BUILD_ID__ is
not defined`. The bundle had been built with `vite build` run from inside
`web/`; vite only looks for `vite.config.ts` in the directory it is run
FROM, so the repo-root config (with `define: { __BUILD_ID__ }`) never
loaded, the bare identifier shipped, and the GET /api/runtime success
handler threw while composing the boot log line.

**Why it hung instead of failing:** the handler used the two-argument
`.then(ok, err)` form. A throw INSIDE `ok` is not caught by `err`; it
became an unhandled rejection and the boot step it should have settled
stayed pending forever.

**Fixes that stay:**
- `web/vite.config.ts` re-exports the root config, and the root config
  resolves `root` absolutely, so a build from either directory is the
  same build.
- main.ts reads the id once through `typeof __BUILD_ID__` (a correct
  build rewrites it to `typeof "<id>"`; an unstamped one yields
  `'unstamped'` in the boot line — the tell) and settles the boot step in
  a `.catch` BEFORE logging.
- vite emits `web/dist/build-id.json`; a dist without it reads as
  `frontend build missing` and the restart preflight rebuilds anyway
  ([[restart-preflight-standby]]).

**Rule:** a boot step must settle in a path that cannot throw — settle
first, log second; never `.then(ok, err)` when `ok` does real work.
