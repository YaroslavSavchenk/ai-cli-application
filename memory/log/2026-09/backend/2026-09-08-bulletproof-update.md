---
type: log
created: 2026-09-08
updated: 2026-09-08
tags: [lifecycle, restart, update, build, frontend, backend, dev-flow, incident]
---
# 2026-09-08 — restart hang diagnosed; "bulletproof update" SHIPPED

## What the user asked (Dutch)

"er was dus een update knop toegevoegd … Ik klikte daarop en nu blijft hij
hangen bij token check. Kijk wat de issue is" — then, mid-flight: "de
update moet echt bulletproof zijn. Kijk wat er mist. Hij moet echt
flowless werken". Plus three backlog items (see Open).

## The hang (hotfix, `fe8823f`)

server.log had it in one line: `ReferenceError: __BUILD_ID__ is not
defined` from the freshly served bundle. Cause + rule in
[[vite-config-cwd-trap]]: `vite build` run from inside `web/` finds no
config → no `define` → bare identifier → throw inside a `.then(ok, err)`
success handler → the boot step never settled. Fix: `typeof` read +
settle-before-log in main.ts, absolute vite root + `web/vite.config.ts`
re-export shim, dist rebuilt properly.

## Decision: [[restart-preflight-standby]]

Settles the 2026-09-06 open decision (rebuild on update?) the user's way:
the restart prepares everything itself and never kills the running
backend unless the replacement is proven — deps check (never auto
`npm install`), always-rebuild into `dist-next`, standby child over
messages-only IPC, `422` = refused/untouched, swap only after
`standby-ready`, revert if the standby dies before teardown. UI: refused
outcome, "Preparing the new version…", second-window auto-reload on a 401
with a live `/health`, boot panel that cannot hang.

## Built (dev-flow)

backend-pty + terminal-ui in parallel; review round (scope / security /
test-engineer); fixer; re-review ×3; fixer 2; final re-gate. Suite
684 → 767 (three fix cycles, +83 tests). Real restarts proven against scratch data dirs +
`AI_SM_WEB_DIST_DIR` copies: preflight 0.4 s build → standby ready →
swap → teardown → go → handoff in ≈ 0.6 s, same port, new pid, new
bundle served, `update: { available: false }` on the child.

## What review caught (the reason the loop exists)

- **HIGH ×3 (scope + security, independently):** the standby child
  installed the normal SIGTERM/uncaught handlers — the parent's own
  20 s-timeout SIGTERM would have made the child unlink the LIVE parent's
  `runtime.json` and rewrite `history.json`; the standby boot also wrote
  crash stamps for the parent's RUNNING sessions and wiped
  `session-settings/`. Fix: `standbyWaiting` decided at module load,
  read-only history load, every data-dir mutation deferred to `go`,
  signal handlers exit without touching anything.
- **MED:** dist swapped before the standby was proven (a step-3 refusal
  = new screens on old code — the incident this feature exists to
  remove); `npm test` rebuilt and swapped the REPO's real `web/dist`
  twice per run (→ `AI_SM_WEB_DIST_DIR` seam); a standby dying between
  ready and `go` went undetected (15 s → 500); `dist-next`/`dist-prev`
  not gitignored and vite surviving a shutdown; then in cycle 2: the
  dead-after-swap window (→ keep `dist-prev`, revert), the env seam as a
  same-user footgun (swap only a real build dir; normalized path), a bad
  env value dying on stderr only, the dialog unclosable for up to 120 s.
- **LOW:** missing `.package-lock.json` stamp = eternal refusal; "The
  server log has the details." in UI copy (server constants now scanned
  by the copy-rule test); raw readdir names in log lines; PTY sessions
  inheriting the handoff env vars; two 409 tests that HUNG instead of
  failing under a mutant (`within()` guard).
- Test gate: 35 hand mutants across both cycles, all killed after the
  added tests; the seam test itself, when mutated, rebuilt the repo's
  `web/dist` once (gitignored, rebuilt — a lesson: mutate a
  protect-the-real-directory seam only against a copied root).

## Open

- **User backlog (2026-09-08), in order:** (1) `/login` in a Claude pane:
  the code field renders "op zo'n aparte plek" and takes neither typing
  nor paste — works in a plain terminal → our pane (PTY size vs xterm
  grid? no paste handling in terminal.ts? focus after the browser
  switch?); (2) a first-class plain-terminal session (WSL bash /
  PowerShell) beside Claude — "alles moet mogelijk"; (3) idea, not
  decided: GitHub Actions release of the WebView2 host exe + launcher.
- Manual: Windows-eye pass of the refused dialog, the "Preparing…" phase,
  the second-window reconnect takeover, and a real restart inside the
  WebView2 window; `/verify-terminal` live pass.
- Accepted: parent + standby both append to `server.log` during the
  standby window (rotation accuracy only); `npm audit` dev-only findings
  (nanoid, postcss) — `npm audit fix` when convenient.
