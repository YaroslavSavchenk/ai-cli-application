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

- [x] **Branch protection — DONE 2026-09-09 (user: "kun jij dat doen?")**: GitHub
  ruleset `protect-main` (id 22649598, active) on `refs/heads/main` with
  `deletion` + `non_fast_forward` only — force-push and branch deletion are
  blocked, plain pushes still work, so the standing commit+push flow stands.
  Required status checks deliberately NOT added (a ruleset requiring checks
  blocks direct pushes). Check names if ever wanted: `verify / typecheck +
  build`, `verify / backend test suite`, `verify / linux bundle`.
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

## Installer leftovers (from the phase-B review, 2026-09-09)

- [ ] **Live-check TOCTOU in `install-bundle.ps1`**: `$live` (runtime.json
  `appDir` + `kill -0`) is computed in PowerShell BEFORE the tarball streams
  and node-pty is proven (seconds). A backend started from `<app>/<ver>` in
  that window, with `<ver>` = the version being installed, gets its dir
  renamed to `.old` and deleted. Fix: re-check runtime.json inside the const
  script (pass the data dir as `$4`) right before the `.old` rename and
  before `rm -rf .old`. Same class: `$liveDir.StartsWith($AppDir + '/')`
  compares a realpath against the typed app dir — a symlinked component
  silently disables the live-dir protection.
- [ ] Untested install-bundle failure codes 21/22/29/30 (`mkdir_failed`,
  `stage_failed`, `symlink_failed`, `current_swap_failed`) and the atomic
  `mv -T` swap on failure.
- [ ] `.iss` `[Code]` is pinned by source inspection only; no ISCC compile
  check exists in the suite (the CI `installer` job is the gate). Cheap
  next step: opt-in `installer/check-iss.ps1` using the portable-ISCC
  recipe in [[inno-setup-local-compile]], run by a test when ISCC is
  reachable.
- [ ] Consent page sub-caption is ~11 rendered lines; at 125 %/150 % scaling
  the single checkbox may be pushed off the page (user to confirm; shorten
  the text if so).
- [ ] `install-bundle` runs up to 1800 s with a frozen wizard and no progress
  feedback (unpack + node-pty proof). Bounded, but a progress line would help.
- [ ] Publisher text "AI Session Manager" + AppId GUID are orchestrator
  defaults — user may rename.

## Owed on the Windows side (user) — the Setup.exe test, 2026-09-09

Test build: GitHub Actions run 34356714586 (workflow_dispatch on main at
`197bb9f`), artifact **`AI-Session-Manager-Setup`** →
`AI-Session-Manager-Setup-0.0.0-dev+197bb9f.exe`, SHA-256
`7db3ab31013471b1ee926dc471483e90d7823819227c67dce9d4490a739916f9`.
Download from https://github.com/YaroslavSavchenk/ai-cli-application/actions/runs/34356714586
(artifacts expire after 90 days; re-dispatch `Release` on main for a fresh one).
**Important:** your live clone-based install and the Setup install are
two different things — the Setup writes to `%LOCALAPPDATA%\Programs\AI
Session Manager\` and `~/.ai-session-manager/app/`, and both share the
data dir `~/.ai-session-manager/` (history, prefs, runtime.json). Close the
app window first so one backend at a time owns runtime.json.

- [ ] SmartScreen on first run: "More info → Run anyway" (unsigned).
- [ ] Wizard: WSL page lists your WSL 2 distros with the default preselected;
  folder page prefills `<home>/.ai-session-manager/app`; a folder with a
  space is refused with a readable message; the extras (consent) page is
  SKIPPED when `claude` is already installed, else its box is OFF; shortcut
  page shows "Create a desktop shortcut" ticked; Ready page lists it all.
- [ ] Never a UAC prompt anywhere.
- [ ] After install: `%LOCALAPPDATA%\Programs\AI Session Manager\` holds
  `launcher-config.json` (your distro + `<appdir>/current`) and
  `install-info.txt`; `wsl -d <distro> -- ls ~/.ai-session-manager/app`
  shows `0.0.0-dev+197bb9f` + `current`; no bundle tar left in `%TEMP%`.
- [ ] Shortcut launches with no console; taskbar shows `app.ico` and ONE
  button for shortcut + window (AUMID match); no host copy appears under
  `%LOCALAPPDATA%\ai-session-manager\host` (host runs in place).
- [ ] Settings → BACKEND shows `version 0.0.0-dev+197bb9f` and the
  `Check for updates` link opens the Releases page in your browser without
  navigating the app window.
- [ ] Upgrade: re-dispatch → newer exe → run it while the app is open: no
  "close the app" prompt; app toasts "A new version has been installed";
  Restart backend lands on the new `current`; old version dir still present.
  Running the SAME version's Setup again must be refused with the
  "this exact version is running" message.
- [ ] Uninstall, both answers: No → WSL `app/` still there, Windows side
  gone; Yes → backend stopped first, `app/` gone,
  `~/.ai-session-manager/{runtime,history,prefs,projects,github}.json` +
  `server.log` still present.
- [ ] `/SILENT` install picks the WSL default distro and the default app dir.
- [ ] Earlier items still owed from the clone path: re-run
  `launcher/make-shortcut.ps1` in the clone (defaults are now empty — the
  UNC-derived path must still print `(from launcher location)`); Windows-eye
  pass of toast/pill/dialog; a restart inside the WebView2 window.

## Open decisions (user) — also listed in `.claude/PROJECT-SCOPE.md`

- [x] **Repo visibility — decided 2026-09-09: public, vault included**;
  noreply commit e-mail set; history not rewritten (author e-mail + old
  paths remain in old commits by choice). **FLIPPED 2026-09-09 13:05Z** (`gh repo edit --visibility public`), releases page live.
- [~] **One-click installer / real app — DECIDED 2026-09-08, phases A–D
  LANDED 2026-09-09** (see [[installer-and-self-contained-bundle]],
  [[2026-09-08-installer-phase-a]], [[2026-09-09-installer-phase-b]],
  [[2026-09-09-installer-phase-c-d]]). Remaining: [x] `workflow_dispatch`
  green on GitHub (third try: two ISPP/Pascal comment traps, both pinned by
  tests — [[inno-setup-ispp-char-literals]]), [ ] user tests the
  `AI-Session-Manager-Setup` artifact on Windows (checklist in
  `installer/README.md`), [x] visibility flip (2026-09-09), [ ] `npm run release -- v0.2.0` after the Windows test.

## Queued ideas (not decided)

- [ ] Drop the "Continue last conversation" checkbox?
- [ ] Should HISTORY list Claude conversations not launched by the app?
- [ ] BitLocker check in the launcher.
- [ ] Dead code noted, not removed: `web/src/api.ts createProject()`.
- Known limit (documented, not planned): PowerShell `ESC[6n` replayed into a
  pane that attaches mid-replay.
