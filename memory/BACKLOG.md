---
type: backlog
created: 2026-09-08
updated: 2026-09-08
tags: [backlog, todo, open]
---
# Backlog — still to do (living note)

Single list of what is known to be NOT done. Read it at the start of a
session; tick or delete items when they land; add a log entry when one does.
Decisions that need the user stay marked **(user)**. Ordering = rough
priority.

## CI/CD leftovers (from [[2026-09-08-cicd-gate]], 2026-09-08)

- [ ] **Branch protection / required status checks (user).** Not added: the
  repo is private (branch rules may need a paid plan) and the release gate
  does not depend on it. If added, the check names are
  `verify / typecheck + build` and `verify / backend test suite`.
  Note: a rule requiring checks BEFORE push would block the standing
  "commit+push to main" flow — decide the workflow together with it.
- [ ] **Janitor pass** over the CI/CD change (skipped: workflows + one
  script + tests only, tree verified clean). Cheap; do it with the next
  feature land.
- [ ] **Server-side settle for shutdown**: `SessionManager.destroyAll():
  Promise<void>` resolving after the last pty `onExit`, plus a logger
  `close()`. Tests currently wait for the exit handler's last log line
  instead ([[test-teardown-late-writer-race]]). Would make `shutdown()`
  honest about when the data dir stops being written.
- [ ] **`workflow_dispatch` on Release runs the full suite** now (cost, not
  a defect). If dispatch is used often for host-build experiments, add a
  `skip_verify` input that the publish job refuses to honour on a tag.
- [ ] **Dependabot (or a manual monthly check) for the SHA-pinned actions**
  — checkout v7.0.1, setup-node v7.0.0, upload-artifact v7.0.1,
  download-artifact v8.0.1 will go stale silently.
- [ ] **`npm audit`**: 2 dev-only transitive advisories in the vite chain
  (`nanoid` <3.3.18 GHSA-2v37-7h3g-55p8, `postcss` <=8.5.22
  GHSA-fxqj-rqcc-2cmp). Runtime backend unaffected (`--omit=dev` → 0).
  `npm audit fix` when convenient; re-run the suite after.
- [ ] Untested branches in `scripts/release.sh` (read-fails class, one
  knob each in the git double): `git rev-parse --abbrev-ref HEAD` failing,
  `git rev-parse HEAD` failing, missing `origin/main`, `gh run list`
  non-zero, `gh repo view` empty fallback, empty `conclusion` →
  `result: unknown`.
- [ ] The `bodyThrew` teardown guard has no meta-test (a failing body's
  assertion surviving a settle timeout). Low value; fault-injected harness.
- [ ] **Suite can hang forever**: a failed test in `tests/github-token.test.ts`
  leaves its in-process GitHub stub listening → the event loop never drains
  and `npm test` never returns (`--test-timeout` unset). Fix: unconditional
  `stub.stop()` in teardown and/or `--test-timeout` in the `test` script.
- [ ] `frontend rebuilt` compares `web/dist/index.html` mtime with a later
  non-monotonic `Date.now()` — a WSL2 clock step could false-positive; a
  tolerance or asset-name-only comparison removes the class (unproven, seen
  once, never reproduced).
- [ ] `tests/logging.test.ts` still has fire-and-forget `void rm(dir, …)`
  at 7 pure-logger sites (no PTY, no race) — switch to
  `await removeTempDir(dir)` for uniformity.

## Owed on the Windows side (user, since 2026-09-08 evening)

- [ ] Re-run `launcher/make-shortcut.ps1` (script changed: self-locating
  config), relaunch from the shortcut (new host exe + backend code).
- [ ] Check `launch.cmd -Status` prints the
  `Config: ... (from launcher location)` line.
- [ ] Windows-eye pass of toast / pill / dialog, and a restart from inside
  the WebView2 window.
- [ ] Try the v0.1.0 release zip in a fresh clone; the SmartScreen claim
  in the README is unverified.

## Open decisions (user) — also listed in `.claude/PROJECT-SCOPE.md`

- [ ] **Repo visibility.** Private today: the release download and the
  README Install section only work for collaborators. Going public also
  publishes the `memory/` vault, the author's home path in the launcher
  defaults, and git author emails.
- [~] **One-click installer / real app — DECIDED 2026-09-08, IN PROGRESS**
  (see [[installer-and-self-contained-bundle]]): [x] A backend
  installed-mode + bundle build ([[2026-09-08-installer-phase-a]]), [ ] B
  launcher config + Inno Setup installer, [ ] C release workflow + README +
  UI copy (frontend still lacks `version`/`installed` + the installed reason
  sentence + "Check for updates" link), [ ] D go-public prep (user: vault
  visibility, commit e-mail; publisher text + AppId GUID for the Setup).
- [ ] Register the GitHub OAuth App + set `AI_SM_GITHUB_CLIENT_ID`
  (GitHub integration is dormant until then) — optional.

## Queued ideas (not decided)

- [ ] Drop the "Continue last conversation" checkbox?
- [ ] Should HISTORY list Claude conversations not launched by the app?
- [ ] BitLocker check in the launcher.
- [ ] Dead code noted, not removed: `web/src/api.ts createProject()`.
- Known limit (documented, not planned): PowerShell `ESC[6n` replayed into a
  pane that attaches mid-replay.
