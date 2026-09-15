---
type: backlog
created: 2026-09-08
updated: 2026-09-15
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
- [x] **Janitor pass** over the CI/CD change — done 2026-09-13 with the A5 land: no dead steps, no unused inputs, `release.sh` every variable consumed.
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

## In-app updater (phase E, 2026-09-09) — what is left

- [x] **User's Windows test of the one-button update — PASSED 2026-09-10
  ("yes alles werkt nice")**: on v0.3.0 the toast offered v0.3.2 → Update →
  the Setup ran silently (exit 0 in 6 s, staging removed) → restart handed
  the port → running `app/v0.3.2`; retention kept v0.3.0; `host\next`
  awaits the next launcher start. First test had shown no button
  ([[etag-cache-verdict-not-payload]], fixed `1cdb766`).
- [ ] Progress is not carried across a restart handoff (status resets to
  idle in the new process); the staged copy in `%TEMP%` survives.
- [ ] `probeWindowsTemp` (real `cmd.exe` → `wslpath`) only ever injected in
  tests; the progress throttle's intermediate percents never asserted.
- [ ] Inno's own exit 3 (prepare-phase failure) is reported as "could not
  be started" — cosmetic.
- [ ] `tests/bundle.test.ts` chmod-000 cases fail as root (CI is non-root).

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

**Nocturne A1 (2026-09-10) — owed on Windows:** rebuild the host
(`launcher/build-host.ps1`) so the exe embeds the new `app.ico` and the
Nocturne DWM caption/text/border colours; re-run `make-shortcut.ps1` so
`%LOCALAPPDATA%\ai-session-manager\app.ico` is refreshed; if the taskbar
still shows the old phosphor icon, clear the icon cache (`ie4uinit -show`
or delete `%LOCALAPPDATA%\Microsoft\Windows\Explorer\iconcache_*.db`,
restart Explorer). Also: does the WebView2 window's Inter rendering look
right on Windows (ClearType)? — see [[2026-09-10-nocturne-a1]].

**2026-09-09 17:30: user tested `0.0.0-dev+197bb9f` on Windows — "alles okey"**
(install, wizard, shortcut, taskbar, Settings version + Check for updates,
sessions, HISTORY, in-place restart; this Claude session itself ran inside
the installed app). v0.2.0 tagged on `fc59d81` right after. Left: the
upgrade test with the real v0.2.0 Setup, uninstall both answers, /SILENT.

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

- [x] SmartScreen on first run: "More info → Run anyway" (unsigned).
- [x] Wizard: WSL page lists your WSL 2 distros with the default preselected;
  folder page prefills `<home>/.ai-session-manager/app`; a folder with a
  space is refused with a readable message; the extras (consent) page is
  SKIPPED when `claude` is already installed, else its box is OFF; shortcut
  page shows "Create a desktop shortcut" ticked; Ready page lists it all.
- [x] Never a UAC prompt anywhere.
- [x] After install: `%LOCALAPPDATA%\Programs\AI Session Manager\` holds
  `launcher-config.json` (your distro + `<appdir>/current`) and
  `install-info.txt`; `wsl -d <distro> -- ls ~/.ai-session-manager/app`
  shows `0.0.0-dev+197bb9f` + `current`; no bundle tar left in `%TEMP%`.
- [x] Shortcut launches with no console; taskbar shows `app.ico` and ONE
  button for shortcut + window (AUMID match); no host copy appears under
  `%LOCALAPPDATA%\ai-session-manager\host` (host runs in place).
- [x] Settings → BACKEND shows `version 0.0.0-dev+197bb9f` and the
  `Check for updates` link opens the Releases page in your browser without
  navigating the app window.
- [ ] Upgrade (test = the real v0.2.0 Setup over the 0.0.0-dev+197bb9f install): re-dispatch → newer exe → run it while the app is open: no
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
  `installer/README.md`), [x] visibility flip (2026-09-09), [x] `npm run release -- v0.2.0` — RELEASED 2026-09-09 (run 34370652699, four assets).

## From the copy/add-folder fix (2026-09-10)

- [ ] Server-side dedupe for `POST /api/projects` register mode (today only the dialog's `isRegistered()` guard stops duplicates).
- [x] Windows-side: Ctrl+Shift+C / Ctrl+Insert copy in the real WebView2 host — user tested the dev window 2026-09-10: "Alles werkt".
- [ ] Edge `--app` fallback: Ctrl+Shift+C without a selection opens DevTools inspect (WebView2 host is immune: accelerator keys off). Accept or swallow there.
- [ ] A7 brief: carry the add-existing intent (v3 tabs New folder / Clone / From GitHub have no slot for it).

## From Nocturne A4 (2026-09-10)

- [ ] **(user)** Two permission vocabularies: the app says `Always ask / Auto edits / Read only / No prompts` (`PERM_SHORT`), Claude Code's in-terminal status line from `server/statusline.mjs` `MODE_LABELS` says `always ask / auto-edits / plan / never ask` (pinned by `tests/statusline-script.test.ts`), mirrored by the Settings sample (`web/src/ui/settings.ts:95`) and the New Project select (`never ask (dangerous)`, `web/src/ui/newproject.ts:228`). Align in A7 (Settings + Add a project) or record the terminal line as exempt.
- [x] A8: the `ns-` dialog block and the A3 pane block use `--line`, `--tick`, `--font-sans`, `--font-mono`, which sat below the `LEGACY ALIAS LAYER` marker — done 2026-09-14 (A8 phase 0 re-homed them; the alias block is deleted, see [[2026-09-14-nocturne-a8]]).
- [ ] B5: per-id "Resume …" entries in the dialog's Start from select (v3); Codex / Gemini CLI / Grok / Zsh / Command Prompt cards go live; API-key notice with "Add key".
- [x] Windows-side: the A4 dialog in the real WebView2 host — user-checked 2026-09-10 ("ziet er goed uit") and again 2026-09-13 with A4b.
- [x] Windows-side (A6) — user tested the dev window 2026-09-13: "alles goed".
- [ ] ~~Windows-side (A6, 2026-09-13):~~ (verified, see above) commit view open/Back with a TUI running (no torn rows, WebGL intact), editor column at 54 % with typing + Save, `Changes` diff tab, Esc out of the view, ligature-free `===` in the editor, `This commit is not available.` never seen (mock only).
- [ ] B3 owes: `syntheticDiff` → `git show <hash> -- <path>` (one diff per PATH today, so two commits sharing a file show identical rows/numbers); `DiffLine.n` → `oldNo/newNo` two-column gutter (`--diff-gut-w` sized for one); a remote datum for `Open on GitHub`.
- [ ] B4 owes: unsaved-text confirm on all four doors (tab close, reload, window close, backend grace) + disk write; `lastGoodDims` in `panes.ts` is global not per-slot (self-corrects at attach).
- [ ] Editor caret/scroll position is lost when a commit view opens over it (text survives) — scope note A6.
- [ ] `MOCK_FILES` is an exported const mutated at module init (`files-mock.ts`); a future import cycle would hand an importer `[]` silently — `buildMockFiles()` returning the array removes the hazard (or B2 deletes the mock).
- [x] Windows-side (A5) — user tested the dev window 2026-09-13: "file systeem ziet er goed uit", then "alles goed" with A6.
- [ ] ~~Windows-side (A5, 2026-09-13):~~ (verified, see above) Files panel drag 200–520 in the real host (pointer capture over WebView2), the amber pulse, the `Example data` line, Sessions panel rows; keyboard: Tab to the grip, arrows, Esc.
- [ ] `prefers-reduced-motion` guard for the two pulses (`--t-pulse` dot, `--t-pulse-edit` file rows) — scope-reviewer note 2026-09-13.
- [ ] B2/B3: delete `placeholderNote()` in `web/src/ui/files.ts` (one function, one call site) when real data lands; B2 must revisit `buildTree` limits (path as file AND folder; duplicate path) if the source is not numstat.
- [ ] Nothing clamps `filesWidth` when the WINDOW shrinks under it (520 + 300 px of chrome in a 1000 px window leaves ~18 cols) — optional clamp on window resize.
- [x] Windows-side (A4b) — user tested the dev window 2026-09-13: "alles werkt keurig" (no black frame, JetBrains Mono on the first pane, TUIs fine after resize).

## From Nocturne A8 (2026-09-14)

- [ ] **To finish A8 (2026-09-14, session ended mid-check):** (1) the user checks the Windows dev window (build `web/dist` is current): boot card, `?` shortcuts overlay (Esc returns typing to the terminal), update toast + Settings → Background service → Restart service confirmation over Settings (Cancel), projects drawer `Add project` / `Session` rows, New session dialog with NO sub-line; (2) the user's "al good" then closes A8 in the plan status line and the state memory. (The CDP re-check on the final build already passed: overlay focus on all three routes, smoke 1/2/4/7, drawer, dialog.)
- [ ] Flake (1 in 30 full-suite runs during the A8 gate): `tests/lifecycle.test.ts` "history: every end reason is listed …" — `the newest entry sorts first` failed once; not the A6 ms-tie (insertion-index tie-break exists), the only mechanism constructed is a backwards clock step between processes under load. The assertion now dumps every entry's stamps; next occurrence says whether it was a tie or a backwards stamp. Not reproduced in 25 isolated runs.
- [ ] Boot overlay / takeover panels are source-scan only: `createBootPanel()` in `web/src/main.ts` is module-private, so rows, marks and the Reload takeovers cannot be driven through `tests/fake-dom.ts`; exporting it (source change) would let a DOM test pin them.
- [ ] `ui/update.ts` update half (`downloading/verifying/installing`, real `%`, `Download it yourself` on a refused update) has no DOM test: needs a timer pump in `tests/fake-dom.ts` (the double records timers, never fires them).
- [ ] `data-*`-keyed styling (`.grid[data-layout]`, `.pane-drop[data-zone]`, `.files-badge[data-kind]`, `[data-armed]`) has no guard that the value set the modules write matches the value set app.css styles — same class of bug as "a rule nothing sets".
- [ ] Shortcuts overlay row cells stay lowercase fragments (byte-pinned by `ui-shortcuts-table` + mirrored in `settings.ts` `KEY_ROWS`); capitalising them is one change across both + 2 tests.
- [ ] B9 may replace the invented-but-unwired `initTheme(serverPrefs?) → { apply, current }` shape in `web/src/ui/theme.ts`; `--z-popover` was deleted (its only user was the popover) — re-add a rung if a popover returns.
- [ ] The `<body>` focus guard landed in `shortcuts.ts` only: `launch.ts`, `newproject.ts` and `picker.ts` restore focus with `isConnected` alone, so opening one of them with nothing focused (click empty chrome, Ctrl+Alt+N, Esc) leaves focus on `<body>` and typed keys reach no PTY; `update.ts` is already immune (`offsetParent !== null`). Same one-line guard each.
- [ ] C# constant NAMES `TokenBgApp` / `TokenTextHd` / `TokenEdge` in `launcher/host/AiSessionManagerHost.cs` echo dead alias names (values correct, pinned by `nocturne-tokens` A1 (f)); rename when the host is next rebuilt.

## Claude Code CLI compatibility guard (user's ask 2026-09-15, not started)

The app depends on documented `claude` CLI flags and behaviour
(`--session-id`, `--resume <id>`, `--settings`, `--effort`, the transcript
location under `~/.claude/projects/`; scope doc: **≥ 2.1.263**, "no version
probe exists"). Anthropic changing any of that breaks the integration
silently: a launch that exits at once, a history entry that never resumes,
a statusline that stays empty. The user wants this VISIBLE in the app, not
buried in `server.log`.

- [ ] **Version probe at boot**: run `claude --version` once (argv, no
  shell), cache it in `GET /api/runtime` (`claudeVersion`, null when the
  binary is missing), compare against a `SUPPORTED_CLAUDE` range baked
  into the build (minimum = the verified floor; maximum = the newest
  version this app version was tested with).
- [ ] **Show it**: boot card row + Settings → Background service fact
  "Claude Code X.Y.Z (tested up to A.B.C)"; outside the range a persistent
  notice in the Nocturne idiom — older than the floor: "update Claude
  Code"; newer than tested: "this app was tested up to A.B.C; if launches
  fail, check for an app update or wait for a patch" with the existing
  updater's "Check for updates" as the action. Never block launching; the
  user decides.
- [ ] **Runtime breakage detection**, since a version number alone proves
  nothing: a claude-kind session that exits within ~2 s with a non-zero
  code (or whose first output matches the CLI's own usage/unknown-option
  error) is flagged on the pane and the notice above appears with the
  captured first line. Same for a `--resume` that the CLI refuses.
- [ ] **Release discipline**: every app release records the Claude Code
  version it was verified against (release notes + the baked maximum);
  bump the floor only when a flag the app relies on changes.
- [ ] **(user)** whether the notice may also point at the GitHub releases
  page / open the updater directly, and whether a "hide until the next
  Claude Code version" dismissal is wanted.

## Queued ideas (not decided)

- Persist the verify-terminal CDP driver (Playwright's bare Chromium `~/.cache/ms-playwright/chromium-1228` + `ws`, `libnspr4`/`libnss3` unpacked locally, force a tiny `Page.captureScreenshot` before reading `.xterm-rows` because headless throttles rAF, clear `DevToolsActivePort`/`SingletonLock` before relaunch, `top` for `htop`) under `scripts/` so each part's gate stops rebuilding it from scratch — three sessions have now written it into a throwaway scratch dir (A3, A4b, A8).


- [x] Drop the "Continue last conversation" checkbox? — done in Nocturne A4 (2026-09-10): Start from select.
- [ ] Should HISTORY list Claude conversations not launched by the app?
- [ ] BitLocker check in the launcher.
- [ ] Dead code noted, not removed: `web/src/api.ts createProject()`.
- Known limit (documented, not planned): PowerShell `ESC[6n` replayed into a
  pane that attaches mid-replay.
