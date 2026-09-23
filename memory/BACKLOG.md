---
type: backlog
created: 2026-09-08
updated: 2026-09-23
tags: [backlog, todo, open]
---
# Backlog — still to do (living note)

Single list of what is known to be NOT done. Read it at the start of a
session; when an item lands, tick it and move it to the archive at the end; add a log entry when one does.
Decisions that need the user stay marked **(user)**. Ordering = rough
priority.

## CI/CD leftovers (from [[2026-09-08-cicd-gate]], 2026-09-08)

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
- [ ] **Suite can hang forever**: a failed test in `tests/server/github-token.test.ts`
  leaves its in-process GitHub stub listening → the event loop never drains
  and `npm test` never returns (`--test-timeout` unset). Fix: unconditional
  `stub.stop()` in teardown and/or `--test-timeout` in the `test` script.
- [ ] `frontend rebuilt` compares `web/dist/index.html` mtime with a later
  non-monotonic `Date.now()` — a WSL2 clock step could false-positive; a
  tolerance or asset-name-only comparison removes the class (unproven, seen
  once, never reproduced).
- [ ] `tests/server/logging.test.ts` still has fire-and-forget `void rm(dir, …)`
  at 7 pure-logger sites (no PTY, no race) — switch to
  `await removeTempDir(dir)` for uniformity.

## In-app updater (phase E, 2026-09-09) — what is left

- [ ] Progress is not carried across a restart handoff (status resets to
  idle in the new process); the staged copy in `%TEMP%` survives.
- [ ] `probeWindowsTemp` (real `cmd.exe` → `wslpath`) only ever injected in
  tests; the progress throttle's intermediate percents never asserted.
- [ ] Inno's own exit 3 (prepare-phase failure) is reported as "could not
  be started" — cosmetic.
- [ ] `tests/server/bundle.test.ts` chmod-000 cases fail as root (CI is non-root).

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
- [ ] Edge `--app` fallback: Ctrl+Shift+C without a selection opens DevTools inspect (WebView2 host is immune: accelerator keys off). Accept or swallow there.
- [ ] A7 brief: carry the add-existing intent (v3 tabs New folder / Clone / From GitHub have no slot for it).

## From Nocturne A4 (2026-09-10)

- [ ] **(user)** Two permission vocabularies: the app says `Always ask / Auto edits / Read only / No prompts` (`PERM_SHORT`), Claude Code's in-terminal status line from `server/statusline.mjs` `MODE_LABELS` says `always ask / auto-edits / plan / never ask` (pinned by `tests/server/statusline-script.test.ts`), mirrored by the Settings sample (`web/src/ui/settings.ts:95`) and the New Project select (`never ask (dangerous)`, `web/src/ui/newproject.ts:228`). Align in A7 (Settings + Add a project) or record the terminal line as exempt.
- [ ] B5: per-id "Resume …" entries in the dialog's Start from select (v3); Codex / Gemini CLI / Grok / Zsh / Command Prompt cards go live; API-key notice with "Add key".
- [ ] ~~Windows-side (A6, 2026-09-13):~~ (verified, see above) commit view open/Back with a TUI running (no torn rows, WebGL intact), editor column at 54 % with typing + Save, `Changes` diff tab, Esc out of the view, ligature-free `===` in the editor, `This commit is not available.` never seen (mock only).
- [ ] B3 owes: `syntheticDiff` → `git show <hash> -- <path>` (one diff per PATH today, so two commits sharing a file show identical rows/numbers); `DiffLine.n` → `oldNo/newNo` two-column gutter (`--diff-gut-w` sized for one); a remote datum for `Open on GitHub`.
- [ ] Editor caret/scroll position is lost when a commit view opens over it (text survives) — scope note A6.
- [ ] ~~Windows-side (A5, 2026-09-13):~~ (verified, see above) Files panel drag 200–520 in the real host (pointer capture over WebView2), the amber pulse, the `Example data` line, Sessions panel rows; keyboard: Tab to the grip, arrows, Esc.
- [ ] `prefers-reduced-motion` guard for the two pulses (`--t-pulse` dot, `--t-pulse-edit` file rows) — scope-reviewer note 2026-09-13.
- [ ] B3: delete `placeholderNote()` in `web/src/ui/files.ts` (one function, one call site) when the Commits tab reads real data. (The `buildTree` half is CLOSED by B2, 2026-09-16: the source is `git diff --numstat` plus `git status --porcelain` for untracked, and the revisit landed as the trailing-slash rule — an untracked directory is one `sub/` row, so it becomes a childless folder node with no caret.)
- [ ] Nothing clamps `filesWidth` when the WINDOW shrinks under it (520 + 300 px of chrome in a 1000 px window leaves ~18 cols) — optional clamp on window resize.

## From Nocturne A8 (2026-09-14)

- [ ] **To finish A8 (2026-09-14, session ended mid-check):** (1) the user checks the Windows dev window (build `web/dist` is current): boot card, `?` shortcuts overlay (Esc returns typing to the terminal), update toast + Settings → Background service → Restart service confirmation over Settings (Cancel), projects drawer `Add project` / `Session` rows, New session dialog with NO sub-line; (2) the user's "al good" then closes A8 in the plan status line and the state memory. (The CDP re-check on the final build already passed: overlay focus on all three routes, smoke 1/2/4/7, drawer, dialog.)
- [ ] Flake (1 in 30 full-suite runs during the A8 gate): `tests/server/lifecycle.test.ts` "history: every end reason is listed …" — `the newest entry sorts first` failed once; not the A6 ms-tie (insertion-index tie-break exists), the only mechanism constructed is a backwards clock step between processes under load. The assertion now dumps every entry's stamps; next occurrence says whether it was a tie or a backwards stamp. Not reproduced in 25 isolated runs.
- [ ] Boot overlay / takeover panels are source-scan only: `createBootPanel()` in `web/src/main.ts` is module-private, so rows, marks and the Reload takeovers cannot be driven through `tests/helpers/fake-dom.ts`; exporting it (source change) would let a DOM test pin them.
- [ ] `ui/update.ts` update half (`downloading/verifying/installing`, real `%`, `Download it yourself` on a refused update) has no DOM test: needs a timer pump in `tests/helpers/fake-dom.ts` (the double records timers, never fires them).
- [ ] `data-*`-keyed styling (`.grid[data-layout]`, `.pane-drop[data-zone]`, `.files-badge[data-kind]`, `[data-armed]`) has no guard that the value set the modules write matches the value set app.css styles — same class of bug as "a rule nothing sets".
- [ ] Shortcuts overlay row cells stay lowercase fragments (byte-pinned by `ui-shortcuts-table`; since B6 the overlay and Settings → Keyboard both draw `web/src/ui/shortcuts-rows.ts`, so capitalising them is ONE data change + the pins).
- [ ] B9 may replace the invented-but-unwired `initTheme(serverPrefs?) → { apply, current }` shape in `web/src/ui/theme.ts`; `--z-popover` was deleted (its only user was the popover) — re-add a rung if a popover returns.
- [ ] The `<body>` focus guard landed in `shortcuts.ts` only: `launch.ts`, `newproject.ts` and `picker.ts` restore focus with `isConnected` alone, so opening one of them with nothing focused (click empty chrome, Ctrl+Alt+N, Esc) leaves focus on `<body>` and typed keys reach no PTY; `update.ts` is already immune (`offsetParent !== null`). Same one-line guard each.
- [ ] C# constant NAMES `TokenBgApp` / `TokenTextHd` / `TokenEdge` in `launcher/host/AiSessionManagerHost.cs` echo dead alias names (values correct, pinned by `nocturne-tokens` A1 (f)); rename when the host is next rebuilt.

## From Nocturne B6 (2026-09-22)

- [ ] B6 follow-ups (reviewers' notes, no defect): a manual `Check for updates` inside a failure BACKOFF still makes one outbound GET (the 403/429 `notBeforeMs` window IS honoured; a floor of a few seconds between sequential manual checks would mirror `/api/runtime`'s cache); a manual check re-arms the periodic timer to +6 h from the press (benign); `note=` is printed on an `aborted` access line too (`status 0 < 400`); no installed-bundle end-to-end test for `POST /api/update/check` (fixture: `tests/server/restart.test.ts` unpacked-bundle boot); `clearToolsFloor` re-entry (a second refusal while the first 3 s timer runs) and two Tools clicks within one write's flight are untested; the hidden-card fallback can select an inert card for one `/api/tools` round trip (spec-true, `applyAvailability` moves on); `update.ts` → `st.setRunStamp` seam has no test of its own; `api.updatePrefs` is GET-merge-PUT so two toggles within one round trip can lose the first (pre-existing shape, shared with `statusLine`).
- [ ] The older data-dir readers (`prefs.json`, `projects.json`, `history.json`, `keys.json`, `update-check.json`, `github.json`) still `readFileSync` a path another process can create — apply the FIFO rule ([[fifo-open-blocks-main-thread]]: `O_NOFOLLOW|O_NONBLOCK` + `fstat().isFile()` + a cap before the read) to all of them in one pass, with a `mkfifo` test each (found a third time in B6 phase 3, `last-port.json`).
- [ ] C1 phase 4: the `Notifications when a session needs you` row was dropped in B6 (decision 2) — the mascot toggle takes its place on Preferences → Defaults.

## From Nocturne C1 (2026-09-22)

- [ ] **A backend that shuts down deletes a NEWER backend's `runtime.json`.** Seen on the dev data dir 2026-09-22 21:32Z: the old backend (port 38757) hit its idle grace and shut down 9 s after a new one (port 37323) had written `runtime.json`; the file was gone afterwards while the new backend ran on. The shutdown path should delete the file only when it still names its own pid. Pre-existing lifecycle bug, not C1. HIT AGAIN the same night on a dev relaunch: `start-backend.sh` found no `runtime.json`, started a SECOND backend, and the old one entered its idle grace (sessions would have died with it). Priority: first thing after the release.
- [ ] The edited-file pulse (`app.css`, Files panel) has no `prefers-reduced-motion` opt-out (the state dots got theirs in B11/B8).
- [ ] The restart dialog says `History` where the Sessions panel says `Earlier` — user's call.

## From the repo optimisation (2026-09-23, [[2026-09-23-repo-optimisation]])

## From the quality track (2026-09-23, [[2026-09-23-quality-p1-p4]])

- [ ] **Replay of very long lines**: `replayTail` counts `\n`, so output of
  2000-char lines still replays the whole 1 MiB ring. A wrap-aware cut
  needs the pane's cols and escape-aware widths.
- [ ] **First text without key events after a focus move**: in the verify
  gate, CDP `Input.insertText` into a pane right after Ctrl+Alt+Arrow moved
  focus away was dropped once (real keystrokes fine). Probably the chord's
  keyup landing in the other pane's textarea. Matters for IME/dictation as
  the very first input after such a move. Not re-run on the old code.
- [ ] **A deleted session's pane header** shows the id prefix with a
  "Working" pill and "Lost" together — cosmetic, predates P1–P4.

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

## For other users (from the 2026-09-15 honest score, 5/10)

What stands between "works on the author's machine" and "someone else
installs it and stays". Already planned elsewhere and NOT repeated here:
live Files/Commits/Editor (B2/B3/B4), real copy from Explorer (A9b), the
CLI compatibility guard (section above), the second-machine smoke and the
replay cost (section below).

- [ ] **(user) Code signing for Setup.exe and the host exe.** Every new
  version trips SmartScreen ("More info → Run anyway") and some AV
  quarantines unsigned installers outright. Options, cheapest first:
  SignPath.io (free for open source, signing in CI via their GitHub
  integration), Azure Trusted Signing (~$10/month, needs an Azure
  account + identity validation), a classic OV/EV certificate (hundreds
  per year, EV needs a hardware token). Decision = which one, and whether
  the user wants their legal name on the certificate (it becomes public).
  Implementation after the decision: a signing step in `release.yml`
  between build and package, `signtool verify` in the verify step,
  SHA256SUMS stays.
- [ ] **(user) Worktree-per-task and a diff / PR flow.** The reason people
  pick Conductor or Claude Squad: each agent in its own git worktree,
  review the diff in-app, open the PR from there. Not in the Nocturne
  plan at all. Decide whether this app wants to be that (a new track
  after C1: "New session → in a worktree" option, worktree list per
  project, diff view reusing B4's diff tabs, "Open PR" via the existing
  GitHub connection) or stays a session manager on top of the user's own
  branches. Big enough that it needs its own plan document.
- [ ] **Contributor surface**: `CONTRIBUTING.md` (how to run, test,
  `/dev-flow` in one paragraph, what a PR must pass), `.github/
  ISSUE_TEMPLATE/` bug + feature (bug asks for the app version, Claude
  Code version, WSL distro, `server.log` excerpt), a
  `PULL_REQUEST_TEMPLATE.md` that points at the checks. Cheap, and the
  security policy already points people at the repo.
- [ ] **README for someone who is not the author**: the current one is
  internal in tone (decision dates, memory paths). Split: a short public
  top (what it is, screenshot, install in three steps, requirements,
  known limits, where to report) and move the operator detail below a
  fold or into `docs/`. Add one real screenshot of the Nocturne UI.
- [ ] **Portability inputs, not assumptions**: the launcher derives distro
  and path from its own location; the bundle pins Node. What is still
  assumed: `bash` as the login shell, `git` on PATH inside WSL, `claude`
  on PATH for the WSL user, systemd absent or present. Each becomes a
  boot-card check with a one-line fix hint instead of a late failure
  (the second-machine smoke below is where these surface first).
- [ ] **First-run experience**: after Setup, the first window shows an
  empty project list and nothing else. Add-a-project is the only door;
  a first-run card ("add a folder, pick Claude Code, start") with the
  Claude Code login state visible (the CLI's own `claude` login is a
  prerequisite nobody is told about).

## Optimisation round — AFTER feature-complete (user's call 2026-09-15)

The user's rule: finish the functionality first (Track B, C1, the guards
above), then one dedicated optimisation pass over the whole app. Nothing
here is a defect and nothing here blocks a part; do not pick these up
piecemeal unless a part makes one trivial. Measured 2026-09-15 where a
number exists.

- [ ] **Scrollback replay on a pane-count change**: a split or close
  re-attaches every terminal in the view and replays its scrollback
  (server ring = `SCROLLBACK_MAX_BYTES` 1 MiB per session, seen at
  1,048,052 bytes in the A10b verify). Re-attach only the slots whose
  geometry changed, or replay the viewport plus a bounded tail and fetch
  the rest on scroll.
- [ ] **Frontend bundle**: `index-*.js` is 660 kB (Vite warns above
  500 kB). xterm.js + the WebGL addon are the bulk; split the GitHub /
  Settings / update surfaces into lazy chunks, keep the terminal path in
  the entry. Measure boot time on the WebView2 host before and after.
- [ ] **Polling → push**: the UI polls `/api/sessions` (`POLL_MS`) and
  `/api/runtime` (`RUNTIME_POLL_MS`) on timers; C1 phase 2 adds a second
  poller in the mascot overlay. One backend events channel (a WS beside
  presence, or SSE) that pushes session/attention/runtime changes; the
  pollers become a fallback. Cuts idle CPU and makes the attention badge
  and the mascot instant.
- [ ] **Server log volume**: 10 MiB per rotated generation, three
  generations on the author's machine after a week, ~15k lines in the
  live file. "Log everything" stays the rule (decision 2026-09-06), but
  audit which `debug` lines fire per keystroke/frame (WS data, presence
  pings) and move those behind a level or a sampling counter so the log
  keeps its diagnostic value without a scroll of noise.
- [ ] **Terminal render path**: profile xterm.js with the WebGL renderer
  on the WebView2 host during `find / | head -5000` (verify check 8) and
  during a 4-pane layout with all four streaming; confirm the fit/resize
  path does not run more than once per layout change (A10 rebuild key);
  check `SCROLLBACK_LINES` 5000 × 4 panes memory on the client.
- [ ] **Backend startup**: the first start after a Windows boot is the
  slowest (launcher waits up to 90 s). Measure where the time goes (WSL
  VM boot vs `node` vs node-pty load vs history load) and report it in
  the boot card rather than a spinner; anything the app itself owns
  (history.json parse, git probes per project) goes lazy.
- [ ] **Test suite wall time** (2026-09-23: 3712 tests in 56.6 s, down from
  76.5 s after the O6 split let `node --test` spread the files): ~36 s for 2093 tests, most in
  `restart.test.ts` and `lifecycle.test.ts` spawning real backends. Share
  a backend per file where the test does not mutate lifecycle; keep the
  spawning tests but run them last so a failure elsewhere reports early.
- [ ] **Memory per idle session**: measure RSS of the backend with 0, 4,
  12 sessions idle for an hour (ring buffers, history, node-pty handles);
  set a documented expectation in the README's requirements.

## Engineering-quality debt (from the 2026-09-15 honest score, 7/10)

Named by the orchestrator when the user asked for a critical score; the
user asked for them on the list. None is urgent; each is a janitor-sized
pass or a test-engineer brief, not a feature.

- [ ] **Split the colossi**: `tests/server/restart.test.ts` (3993 lines) into
  preflight / standby handoff / installed-mode / env files;
  `web/src/state.ts` (1810) into views+slots, tabs, persistence (v2 bag),
  editor tabs; `tests/ui/ui-state.test.ts` (1740) follows the split. Behaviour
  identical, suite count identical, one commit per split.
- [ ] **Text pins → behaviour pins**: an inventory of tests that assert on
  prose or config text (regexes over workflow YAML in
  `release-workflow.test.ts`, "sentence X is in the scope doc", copy
  strings in `ui-copy-separators`) and, per case, either keep it as a
  deliberate contract test (documented why) or replace it with a test of
  the behaviour the text describes. Goal: a refactor of wording never
  needs a test edit unless the promise changed.
- [ ] **Control-byte guard before commit**: raw NUL bytes reached
  `editor-pane.ts` twice (A10, A10b); the suite catches them but only at
  test time. Add a `pre-commit` hook (or a `npm run check:bytes` step in
  `verify.yml`'s check job) that greps staged text files for bytes < 0x20
  outside tab/LF/CR, so the blob never enters a WIP branch at all.
- [ ] **Mock data out of production code**: `files-mock.ts` and the
  mock markers across `state.ts`, `files.ts`, `commit-*.ts`,
  `drop-*.ts`, `settings.ts` exist because B4 is not live yet (B2 landed
  2026-09-16: the FILES half of `files-mock.ts` and the Files-tab markers
  are gone; the drop dialog's conflicts are real. B3 landed 2026-09-21: the
  COMMITS half, `syntheticDiff` and both commit honesty lines are gone —
  what is left is `mockFileContent` / `saveMockFile` and the editor's one
  line). B4 landed 2026-09-22: `files-mock.ts` deleted with its last two
  readers and the editor's honesty line — nothing in the app is mock.
  (Ticked; kept for the history of the three halves.)
- [ ] **Persist the agents' scratch tooling as repo scripts** (2026-09-16,
  from the session analysis): every test-gate rebuilds a mutation harness
  (`scratchpad/mut/run.py`: apply one string mutant, run a test subset,
  restore, byte-compare) and every browser check rebuilds a CDP driver
  (`drive.py`/`dbg.mjs`: launch headless Chromium with staged NSS libs,
  open the app on a scratch backend, dispatch events, screenshot). Land
  both under `scripts/` with a README so a gate is `scripts/mutate.py
  <file> <mutants.json> <tests…>` and a check is `scripts/drive.py …` —
  minutes saved per agent, and fewer reads.
- [ ] **Second-machine smoke**: the app has only ever run on the author's
  machine. One run of Setup.exe + launch + a claude session on a clean
  Windows VM (fresh WSL distro, default Node absent), documented as a
  release-checklist step.

## Queued ideas (not decided)

- Persist the verify-terminal CDP driver (Playwright's bare Chromium `~/.cache/ms-playwright/chromium-1228` + `ws`, `libnspr4`/`libnss3` unpacked locally, force a tiny `Page.captureScreenshot` before reading `.xterm-rows` because headless throttles rAF, clear `DevToolsActivePort`/`SingletonLock` before relaunch, `top` for `htop`) under `scripts/` so each part's gate stops rebuilding it from scratch — five sessions have now written it into a throwaway scratch dir (A3, A4b, A8, B5, B10 — B10's `<scratchpad>/gate/lib.mjs` was a working candidate).
- B10 follow-ups (2026-09-20): a folder merge logs one expected `409` per existing subfolder at WARN in the browser log (`POST /api/fs/create` treated as success by the runner) — mark expected 409s debug; a server-side unit test that upload traffic never touches a session WS (gate-only evidence today); Grok `-s <uuid>` / Gemini `--session-id` pinning (B5 follow-up).
- B13 follow-ups (2026-09-22): `commitCreate` in `web/src/ui/files.ts` keys the created row by the server's `res.path` (the REALPATH'd parent) — inside a symlinked folder the focus/selection misses the row; build the path client-side like rename does. Rename keeps no caret/scroll position in a followed editor tab, and a save in flight at the old path lands on the 404 choice. A rename answer that fails after the user cancelled the row is reported nowhere (create behaves the same). On drvfs, a case variant of a stale project's name is not caught by the rename dst check (text compare).
- B10a follow-ups (2026-09-20): `tests/ui/ui-files-panel.test.ts` ~1204 sleeps 90 ms real time over `web/src/ui/dnd.ts`'s 80 ms wall-clock click suppression — a clock seam in `dnd.ts` would make it deterministic (25 unrelated failures seen once under load); cut/move in the Files panel (rename landed in B13, 2026-09-22 — a move would reuse `server/fsrename.ts` + `server/fsprotect.ts` with a destination folder check); a batch `GET /api/fs/winpath`; `copiedFlash(0, 1, name)` would read `Copied … to the clipboard.` if it ever became reachable.

- [ ] Should HISTORY list Claude conversations not launched by the app?
- [ ] BitLocker check in the launcher.
- [ ] Dead code noted, not removed: `web/src/api.ts createProject()`.
- Known limit (documented, not planned): PowerShell `ESC[6n` replayed into a
  pane that attaches mid-replay.

## Done — archive (moved out of the list above on 2026-09-23)

Ticked items, grouped under the heading they sat under. History, not work:
nothing here needs doing. New ticks move here when their item lands.

### CI/CD leftovers (from [[2026-09-08-cicd-gate]], 2026-09-08)

- [x] **Branch protection — DONE 2026-09-09 (user: "kun jij dat doen?")**: GitHub
  ruleset `protect-main` (id 22649598, active) on `refs/heads/main` with
  `deletion` + `non_fast_forward` only — force-push and branch deletion are
  blocked, plain pushes still work, so the standing commit+push flow stands.
  Required status checks deliberately NOT added (a ruleset requiring checks
  blocks direct pushes). Check names if ever wanted: `verify / typecheck +
  build`, `verify / backend test suite`, `verify / linux bundle`.
- [x] **Janitor pass** over the CI/CD change — done 2026-09-13 with the A5 land: no dead steps, no unused inputs, `release.sh` every variable consumed.

### In-app updater (phase E, 2026-09-09) — what is left

- [x] **User's Windows test of the one-button update — PASSED 2026-09-10
  ("yes alles werkt nice")**: on v0.3.0 the toast offered v0.3.2 → Update →
  the Setup ran silently (exit 0 in 6 s, staging removed) → restart handed
  the port → running `app/v0.3.2`; retention kept v0.3.0; `host\next`
  awaits the next launcher start. First test had shown no button
  ([[etag-cache-verdict-not-payload]], fixed `1cdb766`).

### Owed on the Windows side (user) — the Setup.exe test, 2026-09-09

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

### Open decisions (user) — also listed in `.claude/PROJECT-SCOPE.md`

- [x] **Repo visibility — decided 2026-09-09: public, vault included**;
  noreply commit e-mail set; history not rewritten (author e-mail + old
  paths remain in old commits by choice). **FLIPPED 2026-09-09 13:05Z** (`gh repo edit --visibility public`), releases page live.

### From the copy/add-folder fix (2026-09-10)

- [x] Windows-side: Ctrl+Shift+C / Ctrl+Insert copy in the real WebView2 host — user tested the dev window 2026-09-10: "Alles werkt".

### From Nocturne A4 (2026-09-10)

- [x] A8: the `ns-` dialog block and the A3 pane block use `--line`, `--tick`, `--font-sans`, `--font-mono`, which sat below the `LEGACY ALIAS LAYER` marker — done 2026-09-14 (A8 phase 0 re-homed them; the alias block is deleted, see [[2026-09-14-nocturne-a8]]).
- [x] Windows-side: the A4 dialog in the real WebView2 host — user-checked 2026-09-10 ("ziet er goed uit") and again 2026-09-13 with A4b.
- [x] Windows-side (A6) — user tested the dev window 2026-09-13: "alles goed".
- [x] ~~B4 owes: unsaved-text confirm on all four doors + disk write~~ — landed 2026-09-22 ([[2026-09-22-nocturne-b4]]; backend grace stays the one silent door, known limit). Still open: `lastGoodDims` in `panes.ts` is global not per-slot (self-corrects at attach).
- [x] ~~`MOCK_FILES` is an exported const mutated at module init~~ — B2 Brief B (2026-09-16) deleted the FILES half of `files-mock.ts`; the contents half (B4) and commits half (B3) remain, with a header comment naming their owners.
- [x] Windows-side (A5) — user tested the dev window 2026-09-13: "file systeem ziet er goed uit", then "alles goed" with A6.
- [x] Windows-side (A4b) — user tested the dev window 2026-09-13: "alles werkt keurig" (no black frame, JetBrains Mono on the first pane, TUIs fine after resize).

### Optimisation round — AFTER feature-complete (user's call 2026-09-15)

- [x] ~~**Editor panes across a reload**~~ — B4 (2026-09-22, user decision D2): file + diff tabs persist, 16 per strip; unsaved text does not.

### Queued ideas (not decided)

- [x] Drop the "Continue last conversation" checkbox? — done in Nocturne A4 (2026-09-10): Start from select.

### From the repo optimisation (2026-09-23)

- [x] **Five functions only tests call** — removed 2026-09-23 on the user's
  "doe het": `closeActiveTab`, `aliveSessionCount`, `isFolderView`,
  `itemsText`, `sourceTag`, with their own tests; the non-vacuity counts that
  used `aliveSessionCount` now count in the test fixture.

(Both fixed 2026-09-23 in PLAN-QUALITY Q3 and Q2.)

- [x] **Agent meta read before it is written** (app track, a behaviour
  change): `AgentsWatcher` re-reads `agent-<id>.meta.json` only when its
  mtime changes. A poll that lands between the file's creation (empty) and
  its write sees "not JSON", records the mtime, and — with the kernel's
  coarse timestamps the write often keeps the same mtime — never re-reads:
  the row keeps the default name `agent`. Seen as a one-off red of
  `tests/server/agents-manager.test.ts` "watcher: the refusal is logged
  once…" under full-suite load (5 s wait for `honest`). Fix in
  `server/agents.ts`: key the re-read on mtime AND size, or re-read while
  the last parse failed. Real-world odds depend on how Claude Code writes
  the file.
- [x] **Sleeps that stand in for a condition** (tests only): the O5 list in
  the log entry above — `update-check-route`, `ui-dnd-a10` (`sleep(90)` ×6),
  `ui-files-panel-*`, `git-commits-*`/`git-changes` (`sleep(500)`), polling
  loops in `agents-*` and `telemetry` that `waitUntil` could replace.

