# Project Scope — AI CLI Session Manager

Single source of truth for what this project is and the decisions already made.
Skills and agents reference this file instead of duplicating it. Update it when
a decision changes; never let it silently drift from reality.

## What we are building

A GUI to run and manage multiple AI CLI sessions (Claude Code first; Codex CLI,
Gemini CLI and others later) side by side. Each session is a real interactive
terminal running inside WSL; the GUI adds project management, launch presets,
and multi-pane layouts on top.

## Architecture (decided)

- **Web app running inside WSL.** A Node.js backend runs in WSL2 (Ubuntu). It
  spawns each session in a real pseudo-terminal via **node-pty**, streams I/O
  over **WebSocket**, and serves the frontend over HTTP.
- **Frontend: vanilla TypeScript + Vite** — no UI framework (decided
  2026-07-18). Terminal rendering via **xterm.js**, one instance per visible
  pane. WebGL renderer, fit addon for sizing, bounded scrollback.
- **Sessions are first-class server-side objects.** The PTY and its state live
  in the backend; the browser is only a view. Sessions keep running when their
  pane is hidden; reopening a window reattaches with scrollback replayed.
- **Backend starts detached** from the launcher process (setsid), started on
  demand — it must never die with the launcher console. **Lifetime: bound to
  UI presence** (decided 2026-07-19, user's call, reversing the earlier
  indefinite-survival promise; rationale in
  `memory/decisions/lifecycle-bound-backend.md`): a presence WebSocket counts
  open windows; when the last closes, a grace timer (~30 s) lets reloads
  reattach harmlessly, then the backend ends all sessions, removes
  runtime.json, and exits — plus a crash-safe session journal for one-click
  relaunch (`--continue`) after unclean shutdown. **Not yet implemented** —
  backend work deferred to a later phase; until it lands, the implemented
  (and tested) behavior remains indefinite survival after window close, with
  manual `-Stop` as the shutdown path.
- **Port: auto-picked** (decided 2026-07-18). The backend binds `127.0.0.1`
  on an OS-assigned free port and publishes a runtime discovery file
  (`~/.ai-session-manager/runtime.json`: port, auth token, pid, startedAt;
  user-only readable) that the launcher and tools read — from Windows via
  `wsl.exe cat`. No fixed port anywhere.
- **Windows-side launcher** (thin): reads the discovery file and
  health-checks the discovered port; if the file is absent or stale, starts
  the backend via `wsl.exe -d <distro> -- ...` (distro configurable with
  unique-prefix auto-resolution, default `Ubuntu-24.04`), waits for file +
  health,
  then opens the UI. MVP launcher is a script + Edge `--app` chromeless window; a
  Tauri shell (icon, tray, native folder picker) is the later upgrade.
- WSL2 localhost forwarding is how Windows reaches the backend.

## Features (decided)

- **Projects**: stored in a `projects.json` — `{ id, name, path,
  defaultModel, defaultMode, createdAt }` (full schema: `shared/protocol.ts`). UI shows the project *name* everywhere; the raw path
  appears only as secondary metadata inside the manage-projects view (needed
  to disambiguate add/delete). "Add project" = browse to a directory + give
  it a name.
- **Launch presets per session**: permission mode (standard vs
  `--dangerously-skip-permissions`), model selection, resume
  (`claude --resume` / `-c`). The launched "agent" is a configurable
  command + args, which is what makes multi-CLI support free.
- **Tabs and layouts**: interaction model redesigned (decided 2026-07-19,
  user request; recorded in
  `memory/decisions/anti-slop-design-direction.md`): **sessions are tabs**,
  and dragging one tab onto another forms a split view. **Not yet
  implemented** — the shipped UI still uses the previous model (each tab is
  a grid of 1–4 panes; a layout maps sessions to pane slots). Either way,
  sessions exist independently of tabs/panes/splits.
- **Attention badges**: surface when a hidden session is waiting for input.
  Implemented: BEL (0x07) detection in output. Possible later: OSC
  sequences, Claude Code hooks.

## Hard technical constraints

- Every session needs a **real PTY** — the hosted CLIs are full TUIs (raw
  mode, alt screen, cursor control). Capturing stdout is not an option.
- **Resize must propagate**: pane resize → xterm.js fit addon → `pty.resize()`,
  or TUIs render garbage.
- Keyboard input goes **to the terminal** (Ctrl+C etc. must reach the PTY);
  app-level shortcuts must not collide with TUI keybindings.
- Focused pane must be clearly indicated when multiple panes are visible.

## Environment

- Development happens inside WSL2 Ubuntu at `/home/sava/projects/ai-cli-application`.
- The user runs Windows + WSL2; the app must work in that setup first.

## Process

Nontrivial changes follow the development loop in
`.claude/skills/dev-flow/SKILL.md`: a developer agent implements, reviewers
(`scope-reviewer`, `security-auditor`, `test-engineer`) gate the change, the
`fixer` resolves findings, and the loop repeats until clean, then a final
verification gate. Reviewers never edit code; the fixer never adds features;
the `janitor` keeps the repo tidy between features.

Project memory is an Obsidian-style vault at `memory/` (conventions in
`.claude/skills/memory/SKILL.md`): this file holds the current truth; the
vault holds the *why*, rejected alternatives, learnings, and the work log.
Recall from it before nontrivial work; write back after decisions and
landed features.

## Open decisions (do not treat as settled)

- None currently.

(Settled 2026-07-18: port auto-pick + discovery file; vanilla TS + Vite
frontend; app data — projects.json, runtime.json, server.log — lives in
`~/.ai-session-manager/` (override: `AI_SM_DATA_DIR`), schema in
`shared/protocol.ts`. Rationale in `memory/decisions/`.)

(Settled 2026-07-19: backend lifetime bound to UI presence — see the
Architecture bullet; decided but not yet implemented, backend work deferred
to a later phase.)

(Settled 2026-07-19: full GUI redesign, user's call after real use — the
anti-slop rule stands unchanged, but the phosphor skin is being replaced by
the **"steam blend"** direction chosen from rendered mockups committed under
`design-mocks/`; and the interaction model becomes sessions-as-tabs with
drag-to-split — see the Tabs-and-layouts bullet. Both decided, not yet
implemented; blend definition and rationale in
`memory/decisions/anti-slop-design-direction.md`.)
