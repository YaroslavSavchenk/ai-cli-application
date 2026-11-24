# Memory Index

Map of content for the project memory vault. One line per note, newest-first
within sections. Update this file every time a note is added, renamed, or
superseded. Conventions live in `.claude/skills/memory/SKILL.md`.

## Backlog

- [[BACKLOG]] — **the living to-do list**: open items by origin (CI/CD, updater, installer, Windows checks, Nocturne parts, quality, other users, optimisation), done ones in its archive; read first

## Decisions

### Architecture and backend

- [[terminal-sessions-and-host-exit]] — 2026-09-08: `/login` fix via host focus + the one sanctioned origin-lock exit (Ctrl+click links), clipboard-read, paste chords; Claude · Terminal · Other launch
- [[restart-preflight-standby]] — 2026-09-08: restart preflights first (deps check, rebuild `web/dist`, standby child over IPC); `422` = refused and untouched (user: "bulletproof")
- [[backend-restart-same-port]] — 2026-09-06: restart = same-port handoff to a detached child (WebView2 locks the origin); sessions survive only since D9 P4 ([[pty-host-session-survival]])
- [[log-everything]] — 2026-09-06: `server.log` logs everything by default (byte counts, never bytes), browser lines via `POST /api/client-log`, trust-keyed refusal budget
- [[session-history-resume]] — 2026-09-06: cumulative `history.json` + injected `--session-id` → real per-conversation `--resume`; one-directional transcript prune; `--continue` can't be pinned
- [[lifecycle-bound-backend]] — sessions die with the app (presence WS + grace timer); its crash-safe journal superseded 2026-09-06 by [[session-history-resume]]
- [[auto-port-discovery]] — backend picks a free port and publishes runtime.json (port + token); since 2026-09-22 the last port (`last-port.json`) is tried first
- [[vanilla-ts-vite-frontend]] — no UI framework; vanilla TS + Vite around imperative xterm.js
- [[web-app-inside-wsl]] — why the app is a web app served from WSL, not a Windows-native Electron app
- [[detached-backend]] — partially superseded by [[lifecycle-bound-backend]]: setsid detachment from the launcher stands; window-close survival (and the systemd user service plan) reversed
- [[wsl-crash-recovery]] — 2026-11-24 (user): WSL out of memory → Q16 sessions first in the OOM order, Q17 notice with the cause + one Restart (host `relaunch`) + every running session resumed in its pane

### Launcher, installer and release

- [[in-app-update]] — 2026-09-09: one Update button: backend checks GitHub releases, verifies Setup + SHA256SUMS before running it silently; sessions survive since D9 P4
- [[installer-and-self-contained-bundle]] — 2026-09-08: the app becomes a product: self-contained WSL bundle + unsigned per-user Inno Setup, opt-in third-party installs; shipped v0.2.0
- [[release-build-and-launcher-derivation]] — 2026-09-08: tag-driven GitHub release of the host zip, SHA-pinned CI; launcher derives distro + repo path from its own UNC location
- [[native-webview2-host]] — 2026-07-23: a lightweight WebView2 host fixes the Edge-logo taskbar icon (AUMID); +2026-07-24 dark chrome via DWM colours over a frameless window
- [[thin-windows-launcher]] — health-check → start via wsl.exe → Edge --app window; Tauri is the upgrade path

### UI and Nocturne

- [[pty-host-session-survival]] — 2026-11-20 (user): D9 — a pty-host per data dir owns the PTYs so restart, update and crash keep sessions (decisions 25–27); resume-restore and tmux rejected
- [[d7-media-viewer]] — 2026-10-21 (user): images, video, PDF open as a viewer tab; SVG also as text; src via a path-bound ticket (`GET /api/fs/media`), never the token in a URL
- [[d6-claude-code-compat-guard]] — 2026-10-13 (user): out-of-range notice with Check for updates only, hidden per Claude Code version; Always ask → `--permission-mode manual`
- [[d1-project-prefs-and-model-pool]] — 2026-10-13: per-project Edit (name, model, permission, effort); Claude models pinned by version, newest 4 on top, the rest under Older models
- [[c2-mascot-waits-for-background-work]] — 2026-09-26: one turn verdict for dot, pill and mascot — Working while background agents/workflows live, Waiting for you on questions
- [[b6-settings-live]] — 2026-09-22: Settings live — hideable tool cards, Reopen tabs on start, Check for updates on the page, the sticky last port, one shared Keyboard rows module
- [[b4-editor-live]] — 2026-09-22: the editor reads, saves (409 on a changed file), follows its file on disk and never drops unsaved text without asking; tabs survive a reload
- [[b3-commits-live]] — 2026-09-21: Commits tab = last 10 + `Show more`, `Open on GitHub` for github.com only; known limit: the object store is readable through `commit-diff`
- [[b10a-multi-select-and-delete]] — 2026-09-20: Explorer-style multi-select + permanent delete with one confirmation; no trash, anchors never deletable
- [[b10-file-copy-and-clipboard]] — 2026-09-20: real upload (drop, paste, Copy files here…) and copy-to-clipboard via the host; one folder-conflict choice per drop; size limits up front
- [[b5-tools-keys-and-shells]] — 2026-09-18: API keys in `keys.json` into the tool's env only, Command Prompt via interop, `Not installed` cards; § 5: end = signal ladder on the process group
- [[b7-background-agents-source]] — 2026-09-22: the Background agents table reads Claude Code's own subagent transcripts via `transcript_path`; hooks rejected; B11 follow-ups the same evening
- [[b11-session-turn-readout]] — 2026-09-22: Working (green pulse) vs Waiting for you (amber) from the transcript; agents table behind a switch, default off; ≤ 4 running rows + counts
- [[c1-peek-mascot]] — 2026-09-22: decisions 12–16: a mascot per session whose turn ended or rang, until looked at, max 3, on the app's monitor, click brings the app forward; default on
- [[b12-icons-everywhere]] — 2026-09-22: a real icon per file type and the real tool logos in one style everywhere; inline SVG, no package (open decision 5)
- [[b13-rename-in-files-panel]] — 2026-09-22: rename in the Files panel (F2 + menu), taken names refused, anchors protected by `dev:ino` identity (`server/fsprotect.ts`, delete too)
- [[pane-status-bar-data-source]] — 2026-09-16: open decision 2: B1's pane status bar reads the payload Claude Code hands `server/statusline.mjs`; bar on, Claude's line off by default
- [[terminal-colours-shape]] — 2026-09-13: open decision 10: presets + custom ground/text, terminal only, status colours never themed, on the Settings page
- [[nocturne-full-switch]] — 2026-09-10: full switch to the v3 Nocturne handoff, Legacy UI = tag `legacy-ui`, no toggle; A1 and A4 decisions recorded
- [[no-code-in-ui-copy]] — 2026-07-25: no commands, flags or config names in the GUI; modes in plain words; UI stays English; the custom-command field is exempt
- [[launch-dialog-custom-escape-hatch]] — 2026-07-20: launch dialog gains a `custom · any command` chip (user's call over claude-only), preserving configurable command + args in the GUI
- [[handoff-design-primary]] — 2026-07-20 flip: the user's hi-fi handoff is the primary design source; bottom tab strip; modal launch dialog
- [[anti-slop-design-direction]] — terminal-derived visual identity; hard reject list for generic AI aesthetics

### GitHub

- [[github-token-paste-path]] — 2026-07-25: an "add token" path beside the device flow, design gate before code: 0600 is the ceiling, a fine-grained expiring token is the real win
- [[owner-qualified-clone-paths]] — 2026-07-25: GitHub-list clones land at `<home>/projects/<owner>/<repo>`, killing the same-basename 409; `remote` on `Project` rejected
- [[github-integration]] — 2026-07-23: app can create projects + connect to GitHub (OAuth device flow, user's call); v1 = full create-local / clone / create-repo; token stays server-side

### Process

- [[scope-history]] — 2026-09-23 (O1): verbatim pre-condense wording of scope-doc bullets; since 2026-11-22 also the settled records of the scope doc's § Open decisions; history, not truth
- [[repo-layout]] — 2026-09-20: where things live and how they move — `/restructure-repo`, log by month/area, one plan shape, both enforced by tests; move maps of batches 1–2
- [[agent-team-and-dev-flow]] — the subagent roster, strict lanes, and the develop→review→fix loop

## Knowledge

### Backend and PTY

- [[claude-code-title-is-the-idle-signal]] — 2026-09-27: an open `AskUserQuestion` reaches the transcript only after the answer; the OSC 0 title (`✳ ` idle vs spinner) is the live signal
- [[backend-from-claude-code-taints-pty-env]] — 2026-09-17: a backend started from Claude Code leaked `CLAUDECODE` markers into PTYs (no transcript); `ptyEnv()` strips them by name
- [[fifo-open-blocks-main-thread]] — 2026-09-17: a planted FIFO hangs a synchronous `openSync` before `isFile()`; open with `O_NONBLOCK` too, test with a real `mkfifo`
- [[etag-cache-verdict-not-payload]] — 2026-09-10 incident: caching the "not newer" verdict beside the ETag hid the Update button after a downgrade; cache only what the validator covers
- [[path-normalization-delete-primitive]] — 2026-07-25: `resolve()` is lexical, the kernel is not — a `..` path made "remove what we created" wipe a pre-existing directory
- [[pty-exit-data-race]] — **FIXED 2026-07-25**: a session's last output vanished at exit because libuv fakes EOF on POLLHUP without re-reading; reproduce by stalling the reader
- [[pty-requirements]] — why every session needs a real PTY and what breaks without resize propagation

### Security

- [[git-read-calls-run-repo-config]] — 2026-09-21: "read-only" git runs repo-configured programs (lazy fetch, gpg, textconv) → `GIT_NO_LAZY_FETCH=1`; `log -1 -- <path>` needs `--no-walk`
- [[wsl-0600-not-a-boundary]] — 2026-07-25 VERIFIED: any Windows-user process reads every 0600 file in the WSL data dir through `\\wsl.localhost\`; no keyring either
- [[localhost-security-model]] — the drive-by-web-page threat; token auth, Origin/Host checks, argv spawning

### Frontend and terminal

- [[alias-layer-migration-guards]] — 2026-09-14: deleting a token alias layer: survivors first, regions in parallel, guard last; resolved-value diff per selector proves no visual change
- [[slots-migration-lessons]] — 2026-09-15: the sessions→slots rename: tsc as checklist, rebuild key = layout not contents, dims ladder order, prune shared text at the slot
- [[v3-parity-vs-user-decisions]] — 2026-09-14: a handoff-parity finding never outranks a recorded user decision; ban paraphrases too; reviewers can be wrong on arithmetic
- [[parallel-halves-one-stylesheet]] — 2026-09-13: two developers on one app.css by block region works; the seams are shared rules, unowned child dialogs and copied mocks
- [[hidden-grid-and-mock-coherence]] — 2026-09-13: a covered pane grid = `grid.hidden` + no `render()` work + replay on return; mock numbers counted from drawn rows
- [[files-panel-focus-owner-trap]] — 2026-09-13: an always-open panel must never match `OPEN_FOCUS_OWNER_SELECTOR` (a shared `drawer` class killed terminal refocus)
- [[xterm6-ground-and-font-race]] — 2026-09-13: xterm 6's viewport paints `#000` (repaint with the ground token); load the mono face before the first draw or cells use the fallback width
- [[google-fonts-subset-trap]] — 2026-09-10 incident: Google's latin-ext woff2 has no ASCII — prove glyphs, pin font assets by size + sha256; xterm colours hex/rgb only
- [[localstorage-origin-port-churn]] — an auto-picked port = a new origin = reset localStorage, so durable prefs live server-side; since 2026-09-22 the port is sticky
- [[frontend-terminal-quirks]] — AltGr vs Ctrl+Alt chords, xterm detached-mount trap, attention poll latency, token rotation

### Windows, WSL and installer

- [[webview2-colour-key-loses-transparency]] — 2026-09-26: a `TransparencyKey` form around WebView2 turns opaque after one resize; visual hosting (DComp) stays transparent
- [[inno-setup-local-compile]] — 2026-09-09: compile the `.iss` from WSL with a portable Inno Setup (`/CURRENTUSER /PORTABLE=1`) instead of a CI loop; measured Inno 6.7.1 facts
- [[inno-setup-ispp-char-literals]] — 2026-09-09: ISPP reads any `[Code]` line starting with `#` as a directive — `#13#10` may never open a line (first ISCC compile on CI failed on it); pinned by test
- [[webview2-focus-links-clipboard]] — 2026-09-08: WebView2 focus after Alt-Tab, OSC 8 links via a checked ShellExecute exit, clipboard-read permission, PowerShell's `ESC[6n` block
- [[wsl-interop]] — localhost forwarding, Windows binaries from WSL, cold boot; 2026-09-09: `wsl.exe --` double-expands argv (use `--exec`), `wsl -l -v` is UTF-16LE

### Build, tests and repo

- [[node-test-force-exit-loses-results]] — 2026-10-13: `--test-force-exit` drops report tails and `--test-timeout` cancels only the test; the repo uses `tests/helpers/exit-guard.ts`
- [[wsl-clock-steps-backwards]] — 2026-09-20: WSL2 steps its clock back on host re-sync; a lone red wall-clock test = check dmesg and re-run, never weaken the assertion
- [[author-path-guard-tracked-only]] — 2026-09-16: `tests/repo/no-author-paths.test.ts` scans tracked files only, so untracked author paths pass locally and fail CI; `git add -N` first
- [[dev-machine-setup]] — 2026-09-15: a fresh WSL clone needs Node 24 via nvm, `npm run build`, user-level Playwright Chromium; dev runs on `AI_SM_DATA_DIR=~/.ai-session-manager-dev`
- [[vite-config-cwd-trap]] — 2026-09-08 incident: `vite build` from inside `web/` found no config, so a bare `__BUILD_ID__` hung boot; fixed by a `web/vite.config.ts` shim
- [[test-teardown-late-writer-race]] — **FIXED 2026-09-08 (tests only)**: CI-only ENOTEMPTY — the pty exit handler rewrote `server.log` mid-`rm`; `destroyAllAndSettle` + `removeTempDir`

## Log

Entries live at `memory/log/<YYYY-MM>/<area>/` (areas: nocturne, backend, ui,
launcher, github, release, project); the link target is still the filename.

### 2026-11

- [[2026-11-24-q16-q17-wsl-crash-recovery]] — Q16 + Q17: the 12:53 WSL OOM stop; exit record + cause verdict, `/api/previous-exit`, host `relaunch`, offline panel, resume into old panes; gate 4811/4811
- [[2026-11-21-d9-p3-adopt]] — D9 P3: the broker owns only what it adopts — boot adopt, host lost ⇒ group kill + crash; gate finished 2026-11-22 (34 tests, no bug)
- [[2026-11-22-d9-p5-installer-launcher]] — D9 P5: installer keeps a live pty-host's version, `-Stop` ends a lone pty-host; INCIDENT: an agent's real `-Stop` stopped the installed app twice
- [[2026-11-21-d9-p4-restart-keeps]] — D9 P4: restart and update detach, the new backend adopts; standby probe verdict, 409 `sessions-would-end` + "Restart anyway"
- [[2026-11-21-d9-p2-pty-host]] — D9 P2: the pty-host process + wire (owner seat, token, 0600 socket, orphan 10 min, idle 60 s); data dir 0700; WSL2 distros share a netns
- [[2026-11-20-d9-p1-pty-table]] — D9 P1: the PTY layer moved to `server/pty-table.ts` behind `PtyHost`, absolute ring offsets, meta blob; WSL clock steps back ~1 s per 30 s
- [[2026-11-20-d8-mascot-steps-back]] — D8: the host posts app-active, the page slides the mascot behind the screen edge (250 ms) and back when you leave
- [[2026-11-20-dependabot-security-updates]] — Dependabot ("github bot"): vite, source-map-js and ws bumped in one go, 6 alerts closed, audit 0; released as v0.4.4
- [[2026-11-22-big-cleanup]] — the big cleanup: audits → Q9–Q15 + O9; stale worktree and merged branches gone; design archive + unused `_ds` files removed (`_ds_bundle.js` stays, the v3 HTML loads it)

### 2026-10

- [[2026-10-21-d7-media-viewer]] — D7: media tickets + Range route (server), viewer body by kind, `:text` tab for SVG, image follow; 71 mutants, 17 tests added
- [[2026-10-13-d6-claude-code-compat-guard]] — D6: `claude --version` probe, Settings fact, out-of-range notice, early-exit banner with Claude Code's first line; v0.4.3 notes pinned
- [[2026-10-13-q8-fifo-safe-readers]] — Q8: every data-dir reader + statusline.mjs on `readSmallRegularFile` (O_NOFOLLOW|O_NONBLOCK, fstat, cap); a refused file is set aside
- [[2026-10-13-d4-d5-focus-always-ask]] — D4: one `restoreFocus` helper falling back to the terminal at every dialog close; D5: Always ask → `--permission-mode manual`
- [[2026-10-13-q5-index-split]] — Q5: `server/index.ts` 994 → 663 lines; banner, stores and update wiring moved to `server/index-{banner,stores,update}.ts`
- [[2026-10-13-q6-host-split]] — Q6: `AiSessionManagerHost.cs` 2 550 lines → four `partial` files; the size guard covers `launcher/`; identical csc build
- [[2026-10-13-q7-suite-never-hangs]] — Q7: a leftover listener kept `node --test` alive forever; the `--import` exit guard ends a file 60 s after its last hook, results kept
- [[2026-10-13-d3-launch-stop-owner]] — D3: `launch.ps1 -Stop` removes a stale runtime.json only when it still names the stopped pid, in one `wsl.exe --exec sh -c` step
- [[2026-10-13-plan-d3-d6-q5-q8]] — planning: the user picked 8 backlog items → D3–D6 and Q5–Q8; decisions 17–19
- [[2026-10-13-d2-runtime-json-owner]] — D2: shutdown deleted a newer backend's runtime.json; now removed only when pid + startedAt are its own (`server/runtime-file.ts`)
- [[2026-10-13-d1-project-prefs-models]] — D1: per-project Edit (`PATCH /api/projects/:id`), defaults re-resolved on switch, versioned model pool; shipped in v0.4.1

### 2026-09

- [[2026-09-26-mascot-fix-and-c2]] — mascot black box fixed by visual hosting, dev instance isolated, C2 (Working while background work runs, Waiting for you on questions); +2026-09-27 the idle title
- [[2026-09-23-quality-p5]] — P5 landed: inactive tabs stay alive (≤ 12 terminals, LRU evicted), a tab return costs 0 B / ~35 ms; WebGL contexts released on dispose
- [[2026-09-23-quality-p1-p4]] — P1–P4 landed: replay = last 5200 lines, split/close keep unmoved panes, one boot resize, immutable assets, poll summary line
- [[2026-09-23-quality-p0-measurements]] — P0: the app's cost measured — the real cost is scrollback replay (3.8–5.1 MB per split or tab switch); ten ranked proposals
- [[2026-09-23-quality-q0]] — **Q0–Q4 landed**: quality track opened; `CONTRIBUTING.md` + `tests/repo/no-duplicate-code.test.ts` (4 pairs found)
- [[2026-09-23-repo-optimisation]] — **batch 4 + O4–O8 landed**: `tests/` by area, `tests/README.md` + size guard, big files split by topic (suite 76.5 s → 56.6 s), dead code folded
- [[2026-09-21-repo-restructure-batch3]] — restructure batch 3: one `design/` home, `design-mocks/` deleted; a peer session mid-batch → stage by pathspec
- [[2026-09-23-nocturne-b13]] — **Nocturne B13 LANDED** (rename in the Files panel, anchors protected by `dev:ino`), user-verified; v0.4.0 released the same day
- [[2026-09-22-nocturne-c1]] — **Nocturne C1 LANDED + user-verified** (peek mascot: feed, host overlay, Preferences toggle); paused halfway for a second session's B12
- [[2026-09-22-nocturne-b8]] — **Nocturne B8 LANDED + user-verified** (End session button in every pane header, DESIGN.md for Nocturne, v0.4.0 notes final)
- [[2026-09-22-nocturne-b11]] — **Nocturne B11 LANDED + user-verified** (Working vs Waiting for you from the transcript, agents table behind a switch); all subagents on opus from now on
- [[2026-09-22-nocturne-b12]] — **Nocturne B12 LANDED + user-verified** (real file-type icons and tool marks everywhere); committed alone beside another session's C1
- [[2026-09-22-nocturne-b7]] — **Nocturne B7 LANDED + user-verified** (Background agents table on Claude Code's subagent transcripts); lesson: realpath the directory opened, not the input
- [[2026-09-22-nocturne-b9]] — **Nocturne B9 LANDED + user-verified** (terminal colours live: Settings paints every terminal, `prefs.theme` as a hex pair)
- [[2026-09-22-nocturne-b6]] — **Nocturne B6 LANDED + user-verified** (Settings live, the sticky port `last-port.json`); three developers + gates in parallel
- [[2026-09-22-nocturne-b4]] — **Nocturne B4 LANDED + user-verified** (the editor reads, saves, follows its file, keeps unsaved text and its tabs); `files-mock.ts` gone
- [[2026-09-21-nocturne-b3]] — **Nocturne B3 LANDED** (Commits on the real repository); review found code execution via partial-clone lazy fetch → `GIT_NO_LAZY_FETCH=1`; user-verified
- [[2026-09-20-repo-restructure-batch2]] — restructure batch 2: plans into `.claude/plans/` with part specs, a status table, `.claude/plans/README.md` and `tests/repo/plans-layout.test.ts`
- [[2026-09-20-nocturne-b10a]] — **Nocturne B10a LANDED** (multi-select + permanent delete via `POST /api/fs/delete`, anchors refused, async `rm`); user-verified the same evening
- [[2026-09-20-nocturne-b10]] — **Nocturne B10 LANDED** (the drop dialog copies for real via `PUT /api/fs/upload`; Copy to the Windows clipboard via the host); user-verified ("alles werkt")
- [[2026-09-20-repo-restructure-batch1]] — `/restructure-repo` skill + batch 1: 48 log entries into month/area folders with zero link edits, INDEX regrouped, README layout map
- [[2026-09-20-nocturne-b5]] — **Nocturne B5 LANDED** (the New session dialog live for every tool; kill ladder on the process group after Gemini ignored HUP/TERM); user-verified
- [[2026-09-17-nocturne-b1]] — **Nocturne B1 LANDED** (pane status bar on the statusline snapshot via `server/telemetry.ts`); PTY env strip of Claude Code markers; user-verified
- [[2026-09-16-nocturne-b2-a9c]] — **B2 + A9c LANDED** (real file browser under a home+projects realpath boundary, Changes tab, New file/folder); lean dev-flow rules
- [[2026-09-16-nocturne-a9b]] — **Nocturne A9b LANDED** (paste files into a selected folder from anywhere, row context menu `ui/context-menu.ts`); 123 mutants
- [[2026-09-15-repo-security-and-backlog]] — 2026-09-15 night: CI red ×2 fixed, security tab complete (SECURITY.md, CodeQL, Dependabot), backlog +4 sections, honest score
- [[2026-09-15-nocturne-a10b]] — **Nocturne A10b LANDED** (editor pane with a file-tab strip, stable `e:<n>` slot key); verify-terminal 19/19 PASS
- [[2026-09-15-peek-mascot-phase1]] — **Peek mascot phase 1 LANDED** (the user's design as a standalone `web/mascot.html`, not wired); C1 feasibility; CI red ×2 after the merge
- [[2026-09-15-nocturne-a9]] — **Nocturne A9 LANDED** (drop files and folders from Explorer, visual + mock dialog); verify via CDP drag events with real files
- [[2026-09-15-nocturne-a10]] — **Nocturne A10 LANDED** (editor column → file/diff panes in the tab strip, slots model, fixed `Home` tab)
- [[2026-09-14-nocturne-a8]] — **Nocturne A8 LANDED, Track A complete** (Legacy alias layer deleted, 558 refs → 0; boot card, overlays and Projects drawer in the Nocturne idiom)
- [[2026-09-13-nocturne-a7]] — **Nocturne A7 LANDED** (Settings v3 left-nav with the Terminal colours page, Add-a-project + folder picker on Nocturne); user-verified 2026-09-14
- [[2026-09-13-nocturne-a6]] — **Nocturne A6 LANDED** (commit view replacing the pane area + editor column at 54 %, mock content; grid hidden, not disposed)
- [[2026-09-13-nocturne-a5]] — **Nocturne A5 LANDED** (resizable Files panel + Commits list mocked, Sessions panel v3); a `.drawer` panel disabled terminal refocus
- [[2026-09-13-nocturne-a4b]] — **Nocturne A4b LANDED** (terminal ground + font load fix: xterm 6 viewport div, `font-ready.ts` boot row)
- [[2026-09-10-nocturne-a4]] — **Nocturne A4 LANDED** (New session dialog: no command preview, one permissions popover, "Other" card, top-anchored modal)
- [[2026-09-10-copy-chord-add-folder]] — **copy + add-existing-folder FIXED**: Ctrl+Shift+C / Ctrl+Insert copy only with a selection; a non-empty folder = "Add this folder"
- [[2026-09-10-nocturne-a3]] — **Nocturne A3 LANDED** (pane card, header 38, status bar Model-Mode-Time, empty state); verify-terminal 1–9 PASS
- [[2026-09-10-nocturne-a2]] — **Nocturne A2 LANDED** (top bar 48, tab strip 32, statusline 26, app-wide copy rules); Theme and `?` buttons gone
- [[2026-09-10-nocturne-a1]] — **Nocturne A1 LANDED** (tokens, Inter, icon, host colours); the latin-ext Inter had no ASCII; the handoff dir is local-only
- [[2026-09-10-update-check-cache-fix]] — **"no Update button" FIXED** (`1cdb766`): the cache holds the release descriptor, `offer()` is derived per call
- [[2026-09-09-in-app-update]] — **phase E in-app updater SHIPPED**: release check, verified download, `%TEMP%` staging + `run-update.ps1`, one-dialog UI
- [[2026-09-09-installer-phase-c-d]] — **installer phases C + D SHIPPED, v0.2.0 RELEASED** (first installable release, user: "alles okey"); go-public scrub + `no-author-paths` guard
- [[2026-09-09-installer-phase-b]] — **installer phase B SHIPPED**: `launcher-config.json`, the Inno Setup wizard (never elevates), stdin unpack with `mv -T` swap; `wsl.exe --exec` mandatory
- [[2026-09-08-installer-phase-a]] — **installer phase A SHIPPED**: backend installed mode (`bundle.json`, `current` symlink), `scripts/build-bundle.sh` with SHA-verified pinned Node
- [[2026-09-08-cicd-gate]] — **CI/CD gate SHIPPED**: reusable `verify.yml`, a red suite blocks a release, `npm run release` waits for green CI; flake → [[test-teardown-late-writer-race]]
- [[2026-09-08-github-release-build]] — **v0.1.0 RELEASED**: first green release workflow; the launcher self-locates; lessons: `WSLENV /w` not `/u`, `Add-Type` is not dry
- [[2026-09-08-login-and-terminal]] — **`/login` field FIXED + plain terminal sessions SHIPPED**: three host/UI gaps closed, links on Ctrl+click; PowerShell replay limit recorded
- [[2026-09-08-bulletproof-update]] — **"bulletproof update" SHIPPED**: preflight (deps → rebuild → standby child) before any teardown, `422` untouched; restart hang was an unstamped bundle
- [[2026-09-06-restart-and-update]] — **restart button + "new version" toast/pill/confirm SHIPPED** (same-port handoff; suite 612→682)
- [[2026-09-06-log-everything]] — **log-everything phase SHIPPED** (suite 546→612); review caught a banner credential leak and an unauthenticated log-wipe primitive
- [[2026-09-06-history-and-lean-launch]] — **history + real resume + lean launch dialog SHIPPED**: `history.json`, `--session-id`/`--resume`; a raw-cwd prune that deleted conversations fixed

### 2026-07

- [[2026-07-26-statusline-phase]] — **statusline phase SHIPPED**: the per-pane strip replaced by Claude Code's native status line (per-session `--settings`, live toggles); suite→508
- [[2026-07-25-token-path-RESUME-HERE]] — pasted-token path shipped (`84da3f0`) with the security gate published before the code; two measured log leaks caught
- [[2026-07-25-ui-copy-and-clone-paths]] — plain-language UI copy pass + owner-qualified clone paths; the gate caught a proven directory-wipe primitive; suite 396→462
- [[2026-07-25-pty-tail-rescue]] — the lost PTY tail FIXED via dev-flow (root cause libuv, not node-pty); node-pty pinned exactly
- [[2026-07-24-github-hardening]] — test-hardening, suite 288→391: `github-model.ts`, loopback-only API seam, `redirect: 'error'`; found [[pty-exit-data-race]]
- [[2026-07-24-dark-window-chrome]] — white native title bar FIXED: DWM caption/text/border colours from the CSS tokens on the WebView2 host; verify with `PrintWindow`
- [[2026-07-24-github-build]] — **Phase 2 COMPLETE**: project creation + GitHub OAuth device flow, repo listing, token-auth clone and create-repo; token server-side 0600
- [[2026-07-24-status-bar]] — *(strip superseded by [[2026-07-26-statusline-phase]])* per-pane terminal status bar shipped on real-or-omit telemetry; suite 162→222
- [[2026-07-23-webview2-host-shipped]] — WebView2 host shipped + Edge taskbar icon FIXED (user-confirmed); a `\\wsl.localhost` exe-launch regression fixed
- [[2026-07-23-settings-panel-and-scope]] — settings panel landed via dev-flow; Edge-icon cheap fix proven impossible → WebView2 host; GitHub scope added
- [[2026-07-20-theme-persistence-launcher]] — prefs.json + /api/prefs fix the theme reset; launcher finished with desktop shortcut; suite 120/120; agents-on-opus policy; settings panel un-gated
- [[2026-07-20-r3-launch-dialog]] — R3 shipped: modal launch dialog + custom chip + honest boot panel, launcher-as-tab retired; 92/92 tests, 9/9 verify-terminal; theme-persistence phase queued
- [[2026-07-20-r2-handoff-reskin]] — precedence flip + R2 shipped: handoff reskin, bottom tab strip, theme system; 9/9 verify-terminal; settings panel queued user-gated
- [[2026-07-19-design-handoff-and-r1]] — user's hi-fi handoff triaged (gap analysis, fiction cuts, 2 open decisions); presence ping/pong + /api/runtime landed
- [[2026-07-19-lifecycle-and-pivots]] — lifecycle reversal implemented; steam-blend direction chosen; caveman + model-assignment process changes
- [[2026-07-18-mvp-build]] — backend + frontend + launcher landed via dev-flow workflows; backlog and manual-pass list
- [[2026-07-18-project-setup]] — scope agreed, agent team + dev-flow built, memory vault created
