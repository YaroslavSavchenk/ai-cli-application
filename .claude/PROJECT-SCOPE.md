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
  relaunch (`--continue`) after unclean shutdown. **Implemented 2026-07-19**:
  presence channel `/ws/presence`; grace 30 s (env `AI_SM_GRACE_MS`) plus a
  120 s startup grace until the first-ever presence (env
  `AI_SM_STARTUP_GRACE_MS`); the journal lives in `journal.json`, rotated to
  `previous.json` on boot (open entries stamped 'crash'), served as relaunch
  offers via `GET/DELETE /api/previous` and surfaced in the sessions drawer.
  Manual `-Stop` remains as an override. Added 2026-07-19: the presence
  channel answers `ping`/`pong` (latency; inbound frames capped 1 KiB,
  zero lifecycle effect) and authed `GET /api/runtime` exposes
  `startedAt` (uptime) — both feeding the statusline.
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
  then opens the UI. MVP launcher is a script + Edge `--app` chromeless window.
  **Native host brought forward (decided 2026-07-23):** a lightweight
  **WebView2** host window (uses the Evergreen runtime already present with
  Edge; no Rust toolchain) replaces the Edge `--app` window so the app owns
  its process → its own AppUserModelID + `app.ico` on the Windows taskbar
  (the Edge `--app` window cannot — see the icon note under Open decisions).
  It navigates only to `127.0.0.1:<port>`, navigation locked to that origin,
  and falls back to the Edge `--app` window if the WebView2 runtime is
  absent. Its **window chrome is dark** (added 2026-07-24): DWM caption /
  text / border colors + immersive dark mode, matching the `--bg-app`,
  `--text-hd` and `--edge` tokens, because the DWM-drawn caption is outside
  the page and showed a white bar above the dark UI when maximized. The
  user chose this **DWM-coloring route over a frameless window with a
  custom in-page title strip**; frameless stays available as a later
  upgrade if the separate bar starts to grate. A full **Tauri** shell (tray,
  native folder picker) remains the later upgrade; this host is the minimum
  that fixes the taskbar identity.
- WSL2 localhost forwarding is how Windows reaches the backend.

## Features (decided)

- **Projects**: stored in a `projects.json` — `{ id, name, path,
  defaultModel, defaultMode, createdAt }` (full schema: `shared/protocol.ts`). UI shows the project *name* everywhere; the raw path
  appears only as secondary metadata inside the manage-projects view (needed
  to disambiguate add/delete). "Add project" = browse to a directory + give
  it a name.
- **Launch presets per session**: permission mode (the four
  `--permission-mode` values; bypass rendered as danger), model selection,
  resume (`--continue`; per-id `--resume` is a fiction cut — journal ids
  aren't conversation ids). The launched "agent" is a configurable
  command + args, which is what makes multi-CLI support free — in the GUI
  via the launch dialog's `custom · any command` chip (R3, user decision
  2026-07-20).
- **Tabs and layouts**: interaction model redesigned (decided 2026-07-19,
  user request; recorded in
  `memory/decisions/anti-slop-design-direction.md`): **sessions are tabs**,
  and dragging one tab onto another forms a split view. **Implemented
  2026-07-19**: every session lives in exactly one view (= tab) holding 1–4
  panes; drag a tab onto a tab/pane to merge into a split, drag a pane
  header to the strip to extract, drag along the strip to reorder — every
  drag has a keyboard/button equivalent (see the shortcuts overlay). The
  arrangement is client-local, persisted as localStorage schema v2 with
  migration from v1. Either way, sessions exist independently of
  tabs/panes/splits.
- **Attention badges**: surface when a hidden session is waiting for input.
  Implemented: BEL (0x07) detection in output. Possible later: OSC
  sequences, Claude Code hooks.
- **App settings panel — GO given 2026-07-20, shape decided with the user.**
  A checklist-style settings surface in the UI; set once, survives app
  relaunch (persisted server-side in `prefs.json` via `/api/prefs`).
  Decided option list (each an explicit user answer, 2026-07-20):
  **default model** and **default permission mode** (all four modes incl.
  `plan`; pre-select the launch dialog, per-launch override stays);
  **auto-run startup command** (a configurable line, e.g. a skill/slash
  command, typed into every new claude session once it is ready);
  **usage display, read-only** (approximate Claude Code usage from its
  local session logs — informational only; the app cannot change
  account-side limits). Not in v1: enforcing usage limits, subscription
  plan display.
- **Per-pane terminal status bar — added 2026-07-24 (user's design intake).**
  A thin status strip at the bottom of each terminal pane showing configurable
  per-session telemetry, toggled in a "Terminal status bar" section of the
  settings panel (config persisted server-side in `prefs.json`, NOT
  localStorage — the prototype's localStorage is overridden by our
  port-churn lesson). Items and honest data sources: **model** and
  **permission mode** (launch config); **git branch** and **lines changed**
  (git probe / `--numstat` in the session cwd); **session time** (per-session
  `createdAt`); **cost** and **context window** (derived from the session's
  own Claude Code JSONL log, mapped by cwd-slug + newest-after-spawn →
  `sessionId`, latest assistant `usage` block × model pricing); **active
  skill** (best-effort: the most-recent `Skill` tool_use in that log;
  default off). Defaults on: model, mode, branch, cost, context; off: time,
  diff, skill. **Deferred / not faked: `usage %`** — that is an account
  rate-limit percentage that
  lives in live API response headers, not the local logs; shown only if a
  real source appears. An item renders only when its real value exists.
- **Project creation + GitHub integration — GO given 2026-07-23, user's
  call; shape decided the same day.** The app stops being a passive
  registrar of existing directories and can *create* projects itself, and
  it grows a first-class GitHub connection. Decided pieces:
  - **GitHub auth = OAuth device flow** (user's choice 2026-07-23 over a
    pasted PAT or reusing the local `gh` CLI): the app registers as a
    GitHub OAuth app, the user approves a device code, and a scoped,
    revocable token is stored **server-side** in the data dir beside
    `prefs.json` (never in localStorage, never returned to the browser).
  - **A pasted token is a SECOND credential path — decided and LANDED
    2026-07-25, user's request.** Extends (does not replace) the
    device-flow decision: an "add token" affordance stores a user-pasted
    GitHub token server-side and uses it wherever the device-flow token is
    used. It needs no OAuth App, so it makes the feature usable before the
    client id exists — hence `configured` becomes `deviceFlowAvailable` and
    must never hide the paste affordance. **Persisted by default with a
    "remember this token" toggle** (off = process-memory only, gone when the
    backend exits). A security design gate ran *before* any code: storage
    ceiling is 0600 + discipline (no keyring exists here, verified; same-disk
    encryption is theatre), the UI must claim nothing stronger than "stored on
    this machine, readable by your own user account", it must recommend a
    fine-grained token limited to selected repositories with an expiry (which
    is strictly safer than our own `repo`-scoped device flow), show the
    resolved account before accepting, warn against pasting a token someone
    else supplied, and branch the revocation copy on the credential source.
    Full constraint list and refusals in
    `memory/decisions/github-token-paste-path.md`.
  - **v1 is the full shape** (user's call over a local-only first slice):
    (1) **create a local project** — new directory + register in
    `projects.json`, with an **"Initialize git repo" toggle (default on)**
    controlling the `git init` (decided 2026-07-24, reconciling the
    prototype's "no git init" caption with the earlier always-init: user
    chose a per-create toggle); (2) **clone** — from a pasted git URL
    (the Phase 2a foundation, no GitHub account needed) and, once connected,
    by picking from the user's in-app repo list (Phase 2c); (3) **create a
    new GitHub repo** from the app (local + create/push the remote).
    Phasing (implementation, 2026-07-24): **2a** = local create + URL clone +
    folder picker (landed); **2b** = GitHub OAuth device-flow connection +
    repo listing; **2c** = clone-by-picking + create-repo.
  - **OAuth scope = `repo` (write) up front** (decided 2026-07-24, over a
    read-only-then-escalate flow): a single device-flow grant covers list +
    clone + create-repo + push with no re-auth, matching the full v1 shape.
    The prototype's "read-only by default" caption is superseded.
  - **Security gate (non-negotiable):** the OAuth token is a new stored
    credential on a localhost service that already spawns shells. Every
    GitHub-touching endpoint stays behind the same token-auth +
    Origin/Host parity as the rest of `/api`; the GitHub token itself is
    never exposed to the page. `git clone`/`git init`/repo-create run via
    argv spawning (no shell string interpolation), into user-chosen paths
    validated the same way project paths already are. Token-bearing
    requests set `redirect: 'error'` (added 2026-07-24) so the guarantee
    that a credential never follows a redirect is enforced here rather
    than inherited from the runtime's fetch implementation. Threat-model
    detail in `memory/decisions/github-integration.md`.
  - **`AI_SM_GITHUB_API_BASE` is a test-only seam** (decided 2026-07-24,
    user's call, over gating it behind a build/run mode). It overrides the
    `api.github.com` REST base so the *connected* HTTP paths can be tested
    offline — the server spawns as a child process in tests, so no
    in-process seam can reach it. It is **loopback-only** (`127.0.0.1`,
    `localhost`, `[::1]`, no userinfo, no path/query/fragment) and any
    other value makes the server **refuse to start** (exit 1 before
    `listen`, no `runtime.json`), so it can never be a legitimate
    production or GHES setting. It moves neither the device-flow URLs nor
    the clone host-lock to `github.com`. Unlike the other `AI_SM_*` knobs
    this one has no production use by construction; that is deliberate and
    recorded rather than hidden.

- **No commands, flags, or code in the UI — decided 2026-07-25, user's call.**
  The GUI speaks plain human language; CLI syntax belongs in the terminal, not
  in the chrome around it. Concretely: permission modes render as **Always
  ask** / **Auto-approve edits** / **Read-only planning** / **Never ask ·
  dangerous** (never `acceptEdits`, `plan`, `bypassPermissions`), resume reads
  **Continue last conversation** (never `--continue`), and the launch dialog's
  argv **command preview is replaced by a readable summary** (agent · model ·
  what the mode does · target folder) — the honest "what will run" statement
  now reads as a sentence instead of a shell line. Also out of the UI: the
  `git init` sample, the `/caveman` placeholder, `relaunch resumes claude with
  --continue`, `AI_SM_GITHUB_CLIENT_ID` in the GitHub setup card (that card
  says the server is missing a GitHub setting; the variable name lives in the
  README/docs, where acting on it belongs), the clone tab's `$ git clone <url>
  <dest>` preview (same treatment: `copies` / the pasted URL / `into folder:
  <dest>` — the URL stays, it is the user's own input), and the literal command
  name `claude` in the sessions drawer (the known agent renders as its product
  name; any other command still echoes verbatim). The new-project dialog's
  **`standard` default-permission option was dropped** rather than renamed —
  it behaved identically to "no default", so a plain-language label would have
  promised enforcement it never delivered; a `standard` already stored in
  `projects.json` is still accepted. **UI language stays English** with
  plain words (user's call over a Dutch or mixed-language UI). Exempt by
  construction: the **custom-command field** (its content IS a command the user
  types — user's call to leave it unchanged) and terminal content itself.
  Docs, code, commit messages and agent briefs are unaffected — this is a UI
  copy rule.

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

(none open right now)

(Settled 2026-07-25, user's call: **how a cloned project ties back to its
remote — option (b), owner-qualified clone paths.** App clones from the
GitHub repo list land at **`<home>/projects/<owner>/<repo>`** instead of
`<home>/projects/<repo>`, so `acme/api` and `myorg/api` can both exist
locally — which removes the 409 *and* the mis-identification underneath it:
`clonedProject()` matches on the `<owner>/<repo>` path tail first and only
falls back to the bare basename for projects registered before this change.
Rejected: (a) adding an optional `remote`/`fullName` to `Project` — more
explicit, but it leaves the two-repos-one-folder 409 in place and changes
the `projects.json` schema; (c) accepting the limit. The URL-clone tab keeps
its user-chosen destination (default unchanged) — the owner is only known
for sure on the GitHub-list path. The `KNOWN LIMIT` test that pinned this
becomes a real behavioral test.)

(Settled 2026-07-25: **lost final PTY output after session exit — FIXED.**
Root cause was not node-pty event ordering but **libuv**: on POLLHUP
`uv__stream_io` short-circuits to a synthetic EOF without re-reading, so
bytes still held by the kernel are discarded. `server/sessions.ts` now
wraps `destroy` on node-pty's internal master read stream and
synchronously drains the fd there, feeding bytes into the same handler
`onData` uses — one ingress, no clock, loop ends on EIO/EAGAIN/0. This
depends on two undeclared node-pty internals (`fd`, `_socket`) and on
node-pty's own `pty_nonblock(master)` for the non-blocking guarantee that
makes a synchronous read safe, so **`node-pty` is pinned exactly to
1.1.0** (user's decision) and a version bump means re-running
`tests/sessions-tail.test.ts`. Accepted limit: a multi-byte character
split across the fabricated-EOF boundary can render as one replacement
character — rare, bounded, pinned by a test (user's decision not to close
it). Detail in `memory/knowledge/pty-exit-data-race.md`.)

(Settled 2026-07-23, user's call: project creation + GitHub integration
added to scope — see the Features bullet. GitHub auth = OAuth device flow;
v1 = the full clone + create shape. Rationale in
`memory/decisions/github-integration.md`.)

(Settled 2026-07-23: the Edge `--app` taskbar showing the Edge logo instead
of `app.ico` is fixed by bringing the native host forward as a lightweight
WebView2 window — see the launcher Architecture bullet. Root cause: Chromium
(Edge 150 here) stamps a non-installed `--app` window with its own per-URL
AppUserModelID that includes the churning auto-picked port, and our launch
chain runs Edge as a grandchild of the shortcut (wscript→powershell→edge),
so a shortcut's AUMID never reaches the window. The lightweight
profile+shortcut attempt was proven structurally impossible for this
architecture (no code shipped); PWA-install stays closed (non-installable
manifest + churning port). Only a process that owns BOTH its window and its
shortcut can make the two AUMIDs match — hence the WebView2 host. The
favicon itself is valid and already correct for the in-window icon.
Rationale in `memory/decisions/native-webview2-host.md`.)

(Settled 2026-07-20, user's call — reversing the 2026-07-19 triage
recommendations: the hi-fi handoff in `design/` is now the **primary design
source**; `web/DESIGN.md` is rewritten to transcribe it rather than override
it. Both structural conflicts went the handoff's way: the **tab strip moves
to a dedicated bottom strip** above the statusline, and the **launch UI
becomes a modal dialog** (replaced launcher-as-tab; landed with R3,
2026-07-20, including a user-decided `custom · any command` escape-hatch
chip preserving arbitrary command + args launches).
Unaffected by the flip: architecture (vanilla TS + Vite stands — the handoff
prompt itself defers to the existing stack; no new npm dependencies, fonts
self-hosted), and the three fiction cuts stay cut — they are lifecycle
impossibilities, not looks. Rationale, and the cuts themselves (formerly
enumerated in the now-removed `design/GAP-ANALYSIS.md`), in
`memory/decisions/handoff-design-primary.md`.)

(Settled 2026-07-18: port auto-pick + discovery file; vanilla TS + Vite
frontend; app data — projects.json, runtime.json, journal.json,
previous.json, prefs.json (added 2026-07-20: server-side UI prefs, since
localStorage dies with every auto-picked-port origin change), server.log —
lives in `~/.ai-session-manager/` (override: `AI_SM_DATA_DIR`), schema in
`shared/protocol.ts`. Rationale in `memory/decisions/`.)

(Settled 2026-07-19: backend lifetime bound to UI presence — see the
Architecture bullet; implemented the same day: presence WS + grace timers,
session journal with boot rotation, previous-sessions relaunch API and
drawer UI.)

(Settled 2026-07-19: full GUI redesign, user's call after real use — the
anti-slop rule stands unchanged, but the phosphor skin is being replaced by
the **"steam blend"** direction chosen from rendered mockups committed under
`design-mocks/`; and the interaction model becomes sessions-as-tabs with
drag-to-split — see the Tabs-and-layouts bullet. Both shipped 2026-07-19:
the tab model, then the steam-blend skin (brief + slop-filter pass in
`web/DESIGN.md`; tokens in `web/src/styles/tokens.css`; chrome typeface is
self-hosted Barlow, OFL license committed beside the woff2 assets). Blend
definition and rationale in
`memory/decisions/anti-slop-design-direction.md`.)
