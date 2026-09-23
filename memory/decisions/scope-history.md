---
type: decision
created: 2026-09-23
updated: 2026-09-23
tags: [scope, history]
---
# Scope history — passages moved out of PROJECT-SCOPE.md

What this is: the verbatim pre-2026-09-23 wording of every `.claude/PROJECT-SCOPE.md`
bullet that was condensed in part O1 of `.claude/plans/PLAN-RESTRUCTURE.md` and cites no
other decision note — dated narrative, rejected alternatives, superseded states and
per-part detail. The scope doc holds the current rule; this note is history, not truth.

## Architecture (decided)

### Architecture — Logging

- **Logging: everything, by default — decided and shipped 2026-09-06,
  user's call** ("log everything"; trigger: the new UI ran against a stale
  backend, `/api/history` 404'd silently and nothing in the log said so).
  `server.log` in the data dir is the backend's ONLY diagnostic channel
  (detached process, stdio on /dev/null). One line per event,
  `<ISO> [level] [component] message`, levels `debug|info|warn|error`,
  minimum from env `AI_SM_LOG_LEVEL` (**default `debug`**). Logged: boot
  banner (node, pid, data dir, level, every set `AI_SM_*` override —
  redacted by name pattern and when a URL carries userinfo — server commit,
  frontend build), every HTTP request (method, pathname cut at 256 chars,
  `?…` for a query — never its values — status, ms, bytes), every WS
  upgrade/attach/detach/resize, session lifecycle, history load/list/prune
  decisions, lifecycle count transitions, store load/save, errors with
  stacks. Terminal input and PTY output are byte COUNTS summarized at most
  once per second per session — never content. Never written: the app
  token, the GitHub token, request/response bodies, `Authorization`,
  query-string values, PTY bytes; the generic request-failure line prints
  the error class and stack frames only, never the message (Node quotes ~10
  chars of a request body in `JSON.parse` errors — measured leak lesson of
  2026-07-25). The browser ships its own lines (errors, unhandled
  rejections, every API call as `path ?…` + status, WS open/close/reconnect,
  UI actions as SHAPE — never raw custom command text) through
  **`POST /api/client-log`** (token + Origin/Host like every route; body
  ≤ 64 KiB → 413, ≤ 50 entries, message ≤ 2048 chars truncated, C0/C1/U+2028/9
  stripped so one entry = one line, global 200 entries/min then dropped with
  one warn per window; tagged `[client]`). Anti-flood, because any web page
  can hit the port unauthenticated (a no-cors GET carries no Origin):
  lines for requests that did not carry a valid token — `/health`, the page
  and its assets, 401/403, a 404 on a mistyped route, rejected upgrades —
  share ONE budget of 60 log lines/min (one limiter instance for HTTP and
  WS), then one suppression count per window; a request that carried the
  token is never metered, whatever it answered (a token-bearing 404 on
  `/api/history` — the stale-backend symptom — is always written). Known
  limit: a page load spends ~6 unauthenticated slots, so ~10 reloads in a
  minute exhaust the window for that minute.
  Metering on STATUS (4xx only) was the first cut — review showed an
  unauthenticated `/health` flood still wiped the log in minutes.
  Rotation 10 MiB → `server.log.1` → `.2` (≤ 30 MiB, all 0600); if the
  rename fails the live file is truncated so logging never stops. 0600 is
  hygiene only — the Windows user reads every WSL file — so "never write the
  secret" is the actual control.
  Since phase E (2026-09-09) one more source: `launcher/run-update.ps1`'s
  stdout, piped by the backend (bounded 64 KiB, `debug` on exit 0, `warn`
  otherwise, every line through `oneLine()`), which on failure includes the
  last 30 lines of the Setup's own `setup.log`.

### Architecture — Port

- **Port: the last one first, auto-pick as the fallback** (decided
  2026-07-18 as auto-pick only; amended 2026-09-22, Nocturne B6 decision 5,
  user's call: the tab layout lives in localStorage, which is tied to the
  origin INCLUDING the port, so a new port on every start threw the layout
  away). The backend remembers the port it bound in
  `<dataDir>/last-port.json` (0600, atomic, gated on read to an integer
  1024–65535 — a missing file is the silent first run, anything else is
  ignored with one debug line; opened `O_NOFOLLOW|O_NONBLOCK` and judged by
  `fstat` first, so a planted FIFO or link cannot hang the boot) and tries it first
  on every start through the same hint path a restart handoff uses
  (`AI_SM_PORT_HINT` beats the file; a busy port falls back to an
  OS-assigned one — `last port N busy, auto-picked M, keeping N for next
  time`: the remembered port is NOT overwritten by a fallback, so a
  transient squatter — typically another process's outgoing connection
  holding that number as its ephemeral source port for a moment — cannot
  move the origin for good). It binds `127.0.0.1`
  and publishes a runtime discovery file
  (`~/.ai-session-manager/runtime.json`: port, auth token, pid, startedAt,
  and since 2026-09-08 `appDir` — the app root the process was loaded from
  (a realpath under Node's default symlink resolution), so an installer never
  prunes a live version dir; user-only readable) that the launcher and tools read — from Windows via
  `wsl.exe cat`. No fixed port anywhere.

### Architecture — Release build

- **Release build / distribution — added 2026-09-08 (user's go; CI/CD
  gate the same day: "before every deployment everything is tested
  automatically", "cicd moet in github staan"); extended 2026-09-09 for the
  installable product.** One reusable workflow, `.github/workflows/verify.yml`
  (`on: workflow_call`), is the single definition of "verified": a `check`
  job (`npm ci`, `npm run typecheck`, `npm run build`, `node
  launcher/make-icon.mjs --check`), a `test` job (`npm ci`, `npm run build`,
  `npm test` — the full suite, real servers and PTYs, on ubuntu-latest) and,
  since 2026-09-09, a `bundle` job on **ubuntu-22.04** (glibc 2.35 floor)
  that runs `scripts/build-bundle.sh` with its smoke test and uploads
  nothing — CI proves the same build the release ships. Status-check names:
  `verify / typecheck + build`, `verify / backend test suite`, `verify /
  linux bundle`. `.github/workflows/ci.yml` calls it on push to `main` and
  every PR. A `v*` tag push runs `.github/workflows/release.yml` with five
  jobs: `verify` (the reusable workflow on the tagged commit), `host`
  (windows: `launcher/build-host.ps1` → `AiSessionManagerHost-win-x64.zip`),
  `bundle` (ubuntu-22.04: computes the version ONCE — the tag, or
  `0.0.0-dev+<sha>` off-tag — into `VERSION.txt` and builds
  `ai-session-manager-linux-x64.tar.gz`), `installer` (windows, `needs:
  [host, bundle]`: lays out `installer/payload/`, refuses loudly when
  `ISCC.exe` is absent, compiles `AI-Session-Manager-Setup-<version>.exe`),
  and `release` (`needs: [verify, host, bundle, installer]`: re-hashes every
  downloaded asset into ONE `SHA256SUMS.txt`, `sha256sum -c`, then `gh
  release create --verify-tag` with the four assets — Setup exe first in the
  notes, bundle tarball, host zip, checksums, the unsigned-binary paragraph).
  A red suite or a failed bundle/installer blocks the publish; a re-run is
  idempotent (`--clobber`, notes refreshed). `workflow_dispatch` builds all
  artifacts and publishes nothing unless dispatched on a `v*` tag — **this
  is how the Setup.exe reaches the user for a Windows test before a version
  is tagged (user's call 2026-09-09: v0.2.0 only after that test)**. One
  `NODE_VERSION` per workflow file (equal in both, pinned by test) feeds
  setup-node AND `build-bundle.sh --node`, so the suite runs on the exact
  runtime that gets bundled. Actions are GitHub-owned and SHA-pinned;
  `permissions: {}` at the top, `contents: read` on build jobs, `contents:
  write` only on `release`; `persist-credentials: false`; no `${{ }}` inside
  `run:`. Tagging is done with `npm run release -- vX.Y.Z [--dry-run]`
  (`scripts/release.sh`): it refuses unless the tree is clean, the branch is
  `main`, `HEAD` equals `origin/main`, the tag is unused locally and on
  origin, and the `CI` run for exactly that commit concluded success; only
  then `git tag -a` + `git push origin refs/tags/<tag>`. Binaries are never
  committed (`dist-release/`, `build/`, `installer/payload/` gitignored);
  both exes are unsigned (SmartScreen note in the READMEs); the version lives
  only in the tag. Branch protection: ruleset `protect-main` (force-push +
  deletion blocked, no required checks) since 2026-09-09.
  **Go-public decisions (user, 2026-09-09):** the `memory/` vault goes public
  with the repo; commits use `182082793+YaroslavSavchenk@users.noreply.github.com`
  (set repo-locally; history is not rewritten, so older commits keep the
  author's e-mail and 13 of them still contain the old home path);
  `tests/repo/no-author-paths.test.ts` is the standing guard against the author's
  paths re-entering tracked files; the repo was flipped to PUBLIC on 2026-09-09 right after phase D
  landed and CI was green; **v0.2.0 is tagged only after the user has tested the Setup.exe on
  Windows** (a `workflow_dispatch` run produces it as the
  `AI-Session-Manager-Setup` artifact).

## Features (decided)

### Features — Launch dialog

- **Launch dialog = a short form (reshaped 2026-09-06, user's call: "far
  too many unnecessary things, no effort choice, too much code-ish text —
  plain short words, no explanation"); kind switch added 2026-09-08, user's
  call; Nocturne layout (part A4) 2026-09-10, user's calls on the three v3
  conflicts.** Header `New session`, no subtitle; the modal is anchored at a
  stable top so switching Tool never moves the grid under the pointer.
  First group `Tool` = a 2-per-row card radiogroup (roving tabindex, arrow
  keys): **Claude Code · Codex · Gemini CLI · Grok · Terminal · Other**.
  **Since Nocturne B5 (2026-09-18, spec `.claude/plans/nocturne/PLAN-B5.md`) all four AI
  tools are live**; a card whose executable the backend cannot find on the
  PATH of the very environment it spawns sessions with (`GET /api/tools`,
  a stat-only probe cached 5 s, fetched on every dialog open) is inert
  (`aria-disabled`, never selectable, skipped by the arrows, sub-line
  `Not installed`), and until the first answer every non-composable card is
  inert with no sub-line at all — the dialog never flashes a row of enabled
  cards that then go dark. `Other` is the 2026-07-20 custom-command escape
  hatch as the sixth card (user's call 2026-09-10, v3 has none) and reveals
  the mono Command field. `Terminal` reveals `Shell` cards **Bash**
  (`/bin/bash -l`) · **Zsh** (`zsh -l`, B5) · **PowerShell** (`powershell.exe
  -NoLogo` through WSL interop, ~8 s cold start, UNC-form prompt; v3's
  `pwsh.exe` NOT adopted — not installed, plan decision 6) · **Command
  Prompt** (B5, plan decision 6: `cmd.exe` through interop; the client sends
  NO args and the SERVER appends `/k pushd <windows path of the cwd>` — cmd
  refuses a UNC working directory and would land in `C:\Windows` — computed
  by a pure function (`/mnt/<d>/…` → `D:\…`, else
  `\\wsl.localhost\<WSL_DISTRO_NAME>\…`) and appended ONLY when the cwd
  matches the launcher's allow-list shape without dot segments and the distro
  name is well-formed, since cmd parses its own command line; otherwise plain
  `cmd.exe` plus one warn line — the user is not told in the UI, recorded),
  in the project folder or, with no project, the home folder. The
  tool-specific controls are hidden AND disabled for the other kinds (hidden,
  not dimmed). Shared by all kinds: Name (optional; placeholder = the
  selected project's name) and Project on one row, Cancel and **Start
  session** (was Launch). The Claude Code set is exactly Model · **Effort**
  (`default`, `low`, `medium`, `high`, `xhigh` shown as "Extra high", `max`
  → `--effort <v>`, default emits nothing) · **Permissions** as a 2×2 card
  radiogroup `Always ask` · `Auto edits` · `Read only` · `No prompts`
  (danger red) · **Start from** `A fresh conversation` / `The last
  conversation in this project` (`--continue`; replaced the checkbox) / one
  entry per ENDED conversation of the selected project (B5: the Earlier
  section's entries, newest first, `<title>, <relative time>`; with no
  project, home-folder conversations; choosing one presets Name and emits
  `--resume <id>` in place of `--continue`; the server answers `409 That
  conversation is already running.` when that entry is live and the dialog
  shows it). The other tools reuse the same controls with their own
  vocabularies — the mapping lives in `web/src/ui/launch-args.ts` ONLY, argv
  order fixed model → permission → effort → start tail, pinned byte-exact:
  **Codex** (models `Default` + the documented GPT ids; Effort `Default`,
  `minimal`…`xhigh` → `-c model_reasoning_effort=<v>`; Always ask `-a
  on-request -s read-only`, Auto edits `-a on-request -s workspace-write`,
  Read only `-a never -s read-only`, No prompts
  `--dangerously-bypass-approvals-and-sandbox`; Start from `A fresh session`
  / `The last session` (`resume --last`) / `Pick an earlier session`
  (`resume`, Codex's own picker), options before the subcommand);
  **Gemini CLI** (models `Auto` (emits nothing), `Pro`, `Flash`, `Flash
  Lite` → `-m`; NO effort control (no flag exists); `--approval-mode
  auto_edit|plan|yolo`, Always ask emits nothing; Start from fresh / `The
  last session` = `-r latest`); **Grok** (Grok Build, xAI's own CLI — built
  from its docs, not installed here: models `Default`, `Grok 4.6`; Effort
  `Default`, low, medium, high → `--effort`; only Always ask (nothing) and No
  prompts (`--always-approve`) — `Auto edits` and `Read only` are inert
  cards with the hint `Grok switches this inside the session`; Start from
  fresh / `The last session` = `--continue`). `modelLabel()` names every id
  the dialog can emit the way the dialog showed it (ids unique across the
  four tables); an unknown id (a custom command) is echoed verbatim. **One
  info button** beside the Permissions label opens a short plain explanation
  of the four modes (`PERM_HELP`, the same four generic lines for every tool
  — an accepted approximation of Codex's sandbox semantics) — with the B5
  key notice and the Grok hint the only explanatory copy in the dialog
  (user's call 2026-09-10: labels only on the cards, one on-demand
  explanation); Esc closes that popover first. v3's command preview is left
  out (user's call 2026-09-10; the no-code rule stands). **API keys (B5,
  plan decision 4, user 2026-09-18):** Gemini CLI and Grok show a quiet
  notice `Needs an API key, or sign in inside the terminal the first time.`
  + `Add key` (→ Settings → Preferences, that tool's field focused) when no
  key is saved AND the backend's own environment lacks the variable; Claude
  Code (login is the norm) and Codex (a key alone does not sign it in — it
  signs in inside the terminal, no field) show none. `composeSpawn()` is
  the ONE composition path for all kinds, and every pre-A4 dialog state
  emits byte-identical argv (pinned through the real dialog by
  `tests/ui/ui-launch-dialog.test.ts`). GONE since 2026-09-06: the
  subtitle, the preset chips, the readable launch summary / ink well, the
  footer note, per-card permission descriptions, hint text and
  mechanic-explaining tooltips. The launched "agent" is still a
  configurable command + args (multi-CLI support stays free).

### Features — The upload route

- **The upload route (Nocturne B10, 2026-09-20; spec `.claude/plans/nocturne/PLAN-B10.md`
  §2).** `PUT /api/fs/upload?dir=<abs>&rel=<relative>&mode=replace|new`,
  body `application/octet-stream`, ONE file per request, `content-length`
  required (411 otherwise; 413 over 50 MiB BEFORE a byte is read), `201
  { bytes }`. Every refusal answers with `connection: close` + an explicit
  `content-length` (Node then RSTs the unread body within milliseconds;
  measured, no timer). Boundary: `resolveUnderAllowed` on `dir` (the same
  call as `/api/fs/create`), `rel` split on `/` with every segment
  `isSafeSegment` + ≤ 255 bytes, depth ≤ 64, no `..`/empty/absolute/U+FFFD;
  every intermediate folder the route builds is realpathed and re-checked
  against the anchors AND the data-dir refusal right after its `mkdir` (an
  end-only check created folders outside the boundary before the 403 —
  measured); the bytes land in `.upload-<32 hex>.part` opened
  `O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW` in the destination and are published
  by `rename` (replace) or `link`+`unlink` (new; EEXIST → 409, a dangling
  symlink included) — neither follows the final component, so `Replace`
  over a symlink replaces the LINK. Stateless: no drop id, no server-side
  per-drop counters, no boot sweep, the server never scans the home;
  `.part` files are not hidden from listings and `.git` is not
  special-cased. Logging: counts and statuses only (a 2xx and a 4xx `[fs]`
  line at debug, one `error` line with class + frames for a 5xx, never a
  name, a query value or a byte). `GET /api/fs/winpath?path=<abs>` maps a
  boundary-checked path to its Windows form for the host's clipboard
  (`server/winpath.ts` `windowsPathForClipboard`: wider than the cmd.exe
  allow-list on purpose — spaces, Unicode, `&`, parentheses pass; `\ / : *
  ? " < > |`, control chars, `.`/`..`, a trailing dot or space do not; 422
  when unmappable). Known limits, recorded: a `.part` orphan survives only
  a `kill -9`; the drvfs `link()` fallback is untested here; Windows
  reserved device names (`CON`, `NUL`) pass on Linux and are Explorer's
  problem on paste.

### Features — Peek mascot

- **Peek mascot — Nocturne C1 (user's ask 2026-09-15; decisions 12–16
  settled by the user 2026-09-22; spec `.claude/plans/nocturne/PLAN-C1.md`).**
  The user's own pixel-art Claude (`design/peek-mascot/`, 1:1) peeks around
  the right edge of the monitor the APP WINDOW is on — outside the app
  window, over other programs, borderless fullscreen and video (a true
  exclusive-fullscreen game cannot be drawn over: accepted limit). One
  mascot per session that is PENDING; max 3, oldest `pendingSince` first.
  A Claude session whose turn ENDED (`SessionInfo.turnEnded`, set by the
  server only on a working → waiting move of the B11 turn readout) shows
  one even with the app in front and keeps it until Claude works again or
  the session ends — looking does not send it away (user, 2026-09-22, on
  the Windows check). A BEL (`attention`) shows one until the pane is
  looked at (the `seen` ack clears `attention` only). The statusline, Sessions badge and
  `Needs you` pill stay BEL-only (B11). The page `/mascot.html` now carries
  the auth token like `index.html` (same no-store and frame protection),
  polls `/api/sessions` + `/api/prefs` every 2 s, shows a rise only after it
  held 1.5 s (no flash for a turn ending in the pane the user watches), and
  reports `mascot-count` (+ click-through rects) and, after a click's laugh
  or wave, `mascot-open` to the Windows host, which keeps a TopMost,
  no-activate, taskbar-less transparent WebView2 window whose window REGION
  is the union of the reported rects — empty (draws nothing, takes no
  clicks) while the count is 0; the window is never hidden, because a hidden
  WebView2 is throttled by Chromium after 5 min and a mascot would arrive up
  to a minute late. The host declares no DPI awareness (like the main
  window), so on a >100 % monitor Windows scales the art. It reloads a
  crashed mascot page (capped) and re-places on display changes; and, on `mascot-open`, brings the app to the front and posts
  `focus-session` to the main page. `prefs.mascot = { enabled }` (Settings →
  Preferences, `Peek mascot`, default ON) is the one prefs key the server
  validates. Under the OS reduced-motion setting the art stands still.

### Features — Terminal status line

- **Terminal status line — decided 2026-07-25, shipped 2026-07-26,
  replacing the 2026-07-24 per-pane status strip (removed).** Claude Code
  draws its OWN status line inside each app-launched claude session; the
  app no longer renders a telemetry strip. Mechanism: the backend writes a
  per-session settings file (`<dataDir>/session-settings/<id>.json`) and
  appends `--settings <file>` to the spawned argv — key-level merge, that
  session only; the user's `~/.claude/settings.json` is NEVER read or
  written, and `CLAUDE_CONFIG_DIR` stays untouched. The file points Claude
  Code at `server/statusline.mjs`, which re-reads `prefs.json` on every
  invocation, so panel toggles reach RUNNING sessions live (~2 s), no
  restart. Items (each rendered only when toggled on AND an honest value
  exists): model, permission mode, git branch, cost, lines changed,
  context %, account usage % — the formerly-deferred `usage %` is now REAL
  via the payload's rate-limit data (Claude Pro/Max accounts, present
  after the first response). Known limit, documented in the UI: the
  permission-mode item shows the LAUNCH mode — Claude Code's payload
  carries no live mode, so a mid-session change (shift+tab) is not
  reflected. A blank line is normal for: sessions started before this
  feature (the panel names them and says to end + start them again), a
  not-yet-trusted workspace, and the moments before the first reply.
  Sessions whose client args already carry `--settings`, and non-claude
  commands, are left alone. Data-dir artifacts: `session-settings/`
  (0700, wiped at boot), `statusline-cache.json` (0600, a ~5 s
  git-branch cache, wiped at boot) and, since Nocturne B1,
  `statusline-snapshots/` (0700, wiped at boot; one 0600 file per app
  session id, written by the script, see the next bullet).

### Features — Pane status bar

- **Pane status bar — Nocturne B1, 2026-09-17 (decision 2 of
  `.claude/plans/PLAN-NOCTURNE.md`, user 2026-09-16; spec `.claude/plans/nocturne/PLAN-B1.md`).**
  The strip under each terminal (back since A3 with Model / Mode / Time
  from argv) renders the SAME checklist as Settings → Status bar, fed by
  the payload Claude Code hands `server/statusline.mjs`: the server passes
  the script a fourth argument, the absolute path of a per-session
  snapshot (`<dataDir>/statusline-snapshots/<appSessionId>.json`, keyed by
  the APP id — a resumed conversation's `session_id` is the old one, and
  the app never guesses a mapping); the script writes it atomically, only
  when the drawable values changed, regardless of whether Claude's own
  line is on; `server/telemetry.ts` watches the directory (filename gate,
  `O_NOFOLLOW`, regular file only, 8 KiB cap, every string
  control-stripped and capped, every number finite and clamped — the data
  dir is not a boundary) and hands the result to the session manager,
  which sets `SessionInfo.telemetry` and re-sends the existing `info`
  frame when it changed. Items, in the v3 order: Model (what Claude
  reports beats the argv guess), Mode (argv, launch mode), Branch, Cost
  (> 0 only), Context, Usage (amber at ≥ 80 %), Time (running sessions
  only), Changed (`+a -r` when either > 0). The checklist has TWO
  switches — `Inside the terminal` (`enabled`, Claude's own line) and
  `Under the terminal` (`paneBar`) — the bar ON and Claude's line OFF by
  default (user's call 2026-09-17 after seeing both: "het staat nu
  dubbel"); both on shows the same values twice; `Session time` is a checklist row the pane bar alone
  honours. Active skill has no source and is dropped, no placeholder. An
  exited session keeps its last values; Time drops. The script reads
  `paneBar` for one thing only: skipping the git probe when nobody would
  show the branch.

### Features — Background agents table

- **Background agents table — Nocturne B7, 2026-09-22 (the B7 row's open
  decision, user 2026-09-22; spec `.claude/plans/nocturne/PLAN-B7.md`).**
  The table under the pane status bar (name, task, time, tokens; A3 built
  it empty) is fed by Claude Code's OWN transcripts: per session Claude
  Code writes `<CLAUDE_CONFIG_DIR|~/.claude>/projects/<slug>/<session-id>/subagents/agent-<hex>.meta.json`
  (agent type, task) and `agent-<hex>.jsonl` (timestamps, `message.id`,
  `stop_reason`, `usage`). The status-line script adds the payload's
  `transcript_path` to the B1 snapshot; the backend derives the subagents
  directory from it and, because the snapshot is untrusted, refuses the
  path unless it is absolute, normalised, `<uuid>.jsonl`, and its parent
  realpath sits inside the real projects root (`DataPaths.claudeProjectsDir`,
  the first directory outside the data dir this app reads for live data);
  the directory actually opened is realpath-checked again on every poll.
  `server/agents.ts` polls it every 2 s (no inotify: the directory does not
  exist before the first subagent), reads meta files ≤ 8 KiB and transcripts
  incrementally (offset + carry, ≤ 4 MiB per file and ≤ 16 MiB per tick
  across everything, lines ≤ 1 MiB, `O_NOFOLLOW`, regular files only),
  and hands `SessionInfo.agents` to the session manager, which re-sends
  `info` on a real change only. A row: name = agent type, task =
  description (control-stripped, 64/120), started = the first line's
  timestamp (the meta's mtime before there is one), tokens = the billed
  total across unique `message.id`s (input + cache creation + cache read +
  output — a 15-minute agent reads `12.5M`), finished when the last
  user/assistant line is an assistant `end_turn` or the file has not grown
  for 15 min (a killed agent leaves no marker). Wire list (B11, replacing
  B7's 3 finished / 8 rows): at most 4 running rows (oldest first), then —
  only when fewer than 4 run — the one most recently finished;
  `SessionInfo.agentCounts` carries the totals so the table ends in
  `+N working` / `+N finished` and nothing is silently hidden; 64 agents
  tracked per session. Since B11 the table shows only when Settings →
  Status bar → "Background agents under the terminal" (`paneAgents`,
  default OFF) is on: Claude Code draws its own task list inside the
  terminal and cannot hide it. The table is never rendered empty, never
  for a non-claude session, keeps its rows after exit, and its ink and
  both hairlines under the terminal take the terminal theme's steps (the
  B9 constraint). Tracking stops at exit and removal, and at exit every row still
  `running` becomes `finished` with the exit's own time (Claude Code runs
  its subagents in-process, so none outlived it) in one extra `info`
  frame before `exit`; a snapshot for a dead or unknown session is
  ignored. No hooks, no env var, nothing
  written under `~/.claude`.

### Features — Session state

- **Session state: Working vs. Waiting for you — Nocturne B11 (decided
  2026-09-22, user's call).** A PTY does not say whether the program is
  generating or idle, so a Claude session's readout comes from its OWN
  transcript (`<uuid>.jsonl`, derived from the tracked subagents dir, the
  same boundary and budgets as B7, first sight reads the last 1 MiB only):
  the last line that counts decides — an assistant `end_turn` /
  `stop_sequence` / `refusal` / `max_tokens`, a synthetic API error, or a
  user interrupt → `waiting`; a prompt, a tool result, a task
  notification, an assistant `tool_use` → `working`; local slash commands
  and meta lines do not count. A transcript that does not exist yet (the
  first prompt) reads `waiting`. `SessionInfo.turn` carries it, dropped at
  exit. Readout order: Needs your answer (BEL, amber pulsing) > Finished
  (grey) > Waiting for you (amber still) > Working (green pulsing, turn
  known) > Working (green still, no turn readout — every non-claude
  session). Waiting shows on the session's own pane, drawer row and tab dot
  only: the statusline's `N waiting for you`, the top bar's Sessions badge,
  the tab's `Needs you` pill, `attention`, `seen` and every notification
  stay BEL-only (user, 2026-09-22, on the B11 check — B11 first counted
  waiting sessions there too). Known limit:
  Claude Code's permission prompt writes nothing to the transcript, so it
  reads Working unless the BEL fires.

### Features — Session pane header

- **Session pane header — Nocturne A3, End session button since B8
  (user's decision 2026-09-22; spec `.claude/plans/nocturne/PLAN-B8.md`).**
  A session pane's 38 px header holds, left to right: the state dot, the
  session name, the project NAME (never a path), a spacer, the state pill
  (the B11 word), the connection chip only while degraded (`Reconnecting` /
  `Lost`), `Own tab` only when the tab holds more than one pane, and — top
  right, on EVERY session pane, a one-pane tab included — an **End session**
  button (a quiet `X` icon, `aria-label` / `title` `End session`). It ENDS
  the session exactly like the tab `×` and the Sessions panel's end control
  do (`killSession`) — not "close the pane, keep it running" — and follows
  Settings → Preferences → `Confirm before ending a session`: on, the first
  click arms (`Sure?`) and the second ends; off, one click ends. A3 had kept
  ending off the pane header as a one-click destructive control; the confirm
  setting answers that. A press on the button never starts the header's
  pane drag. No keyboard chord (the tab `×` and the Sessions panel are
  keyboard-reachable). Editor panes keep their own `×`, which closes files
  and ends nothing.

### Features — No commands, flags, or code in the UI

- **No commands, flags, or code in the UI — decided 2026-07-25, user's call.**
  Carve-out (2026-09-08, user decision 2 of the installer): the Setup
  wizard's WSL and consent pages MUST show the exact `wsl …` fix commands
  (`wsl --install`, `wsl --install -d Ubuntu`, `wsl --set-version <name>
  2`) and the exact third-party command (`curl -fsSL
  https://claude.ai/install.sh | bash`) verbatim — informed consent and an
  actionable fix are the point there. The app's own chrome stays clean.
  The GUI speaks plain human language; CLI syntax belongs in the terminal, not
  in the chrome around it. Concretely: permission modes render as the short
  forms `Always ask` / `Auto edits` / `Read only` / `No prompts` (sentence
  case since Nocturne A4, 2026-09-10; one label table, `PERM_SHORT`; since
  2026-09-06 the long forms are gone; never `acceptEdits`, `plan`,
  `bypassPermissions`) — known exception: Claude Code's own in-terminal
  status line (`server/statusline.mjs` `MODE_LABELS`) still prints its
  older words incl. `plan`, and so does its Settings preview sample; the
  Add a project dialog's default-mode option still reads `never ask (dangerous)`;
  aligning all three is open (backlog) — resume reads
  **The last conversation in this project** (never `--continue`), and the launch dialog's
  argv command preview was replaced by a readable summary, itself **removed
  2026-09-06** and not brought back by the v3 design (user's call
  2026-09-10) (the fields are the statement of what will run; nothing
  explains itself, except the one on-demand permissions info popover
  decided 2026-09-10). Also out of the UI: the
  `git init` sample, the `/caveman` placeholder, `relaunch resumes claude with
  --continue`, `AI_SM_GITHUB_CLIENT_ID` in the GitHub setup card (that card
  says the server is missing a GitHub setting; the variable name lives in the
  README/docs, where acting on it belongs), the clone tab's `$ git clone <url>
  <dest>` preview (same treatment: `copies` / the pasted URL / `into folder:
  <dest>` — the URL stays, it is the user's own input), and the literal command
  name `claude` in the sessions drawer (the known agent renders as its product
  name `Claude Code`, the two built-in shells as `Bash` / `PowerShell` —
  `Bash` since 2026-09-10, formerly `WSL shell` — a no-project history
  entry titled before that keeps its stored `WSL shell` title until it ages
  out, no rewrite of `history.json`,
  in the active list AND the history rows; a user-typed custom command
  still echoes verbatim). The new-project dialog's
  **`standard` default-permission option was dropped** rather than renamed —
  it behaved identically to "no default", so a plain-language label would have
  promised enforcement it never delivered; a `standard` already stored in
  `projects.json` is still accepted. **UI language stays English** with
  plain words (user's call over a Dutch or mixed-language UI). Exempt by
  construction: the **custom-command field** (its content IS a command the user
  types — user's call to leave it unchanged) and terminal content itself.
  Docs, code, commit messages and agent briefs are unaffected — this is a UI
  copy rule.
