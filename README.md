# AI CLI Session Manager

A web app for running and managing multiple AI CLI sessions (Claude Code
first; the launched agent is a configurable command + args, so other CLIs
work too) side by side. A Node.js backend inside WSL2 spawns each session in
a real pseudo-terminal (node-pty), streams I/O over WebSocket, and serves a
vanilla-TypeScript frontend (xterm.js) with projects, launch presets, and
multi-pane tab layouts. Sessions are server-side objects: hiding a pane,
switching tabs, or reloading the page never ends them, and reattaching
replays the full scrollback. The backend's lifetime is bound to UI presence
(decided and implemented 2026-07-19; see
`memory/decisions/lifecycle-bound-backend.md`): closing the last app window
starts a ~30 s grace timer, after which the backend ends all sessions and
exits — nothing keeps running in the background. A crash-safe session
journal means the next start offers the previous run's sessions for
one-click relaunch (Claude sessions resume via `--continue`).

## Run it (Windows + WSL2)

Once: run `launcher/make-shortcut.ps1` — it creates an "AI Session Manager"
icon on the Desktop and in the Start Menu. From then on, double-click the
icon: no console appears; the launcher attaches to a running backend (or
starts one detached inside WSL), waits for it to become healthy, and opens
the UI in the native WebView2 host window when that host is built
(`launcher/build-host.ps1`) and the WebView2 runtime is present — otherwise an
Edge `--app` window, then the default browser. `launcher/launch.cmd` is the
visible/debug path with the same logic. Configuration, switches (`-Silent`,
`-Status`, `-Stop`, `-NoBrowser`), pinning, cold-boot expectations, and
troubleshooting: see [launcher/README.md](launcher/README.md).

## Develop (inside WSL)

Requires Node >= 24 (the server runs its TypeScript directly via native type
stripping).

    npm install
    npm run build       # bundle the frontend into web/dist
    npm start           # start the backend (serves web/dist, auto-picks a port)
    npm test            # backend test suite (spawns real servers and PTYs)
    npm run typecheck   # tsc over server/shared/tests and web

The backend binds `127.0.0.1` on an OS-assigned port and writes
`runtime.json` to its data dir; open `http://127.0.0.1:<port>/` with the
port from that file. The server logs to `server.log` in the data dir, never
stdout.

## App data

Lives in `~/.ai-session-manager/` (override with `AI_SM_DATA_DIR`, absolute
path):

- `projects.json` — saved projects
- `prefs.json` — server-side UI preferences (the settings panel; localStorage
  cannot be used because the auto-picked port changes the origin)
- `github.json` — the GitHub OAuth token, user-only readable (mode 0600);
  written only after a successful device-flow connection, deleted on
  disconnect. Never sent to the browser
- `runtime.json` — runtime discovery (port, auth token, pid, startedAt);
  removed on clean shutdown
- `journal.json` — crash-safe journal of the current run's sessions
  (atomically rewritten on every session create/exit/delete and at shutdown)
- `previous.json` — the previous run's journal, rotated here on boot
  (entries left open by a crash are stamped `crash`); feeds the "previous
  run" relaunch offers (`GET /api/previous`)
- `server.log` — backend log (rotated to `server.log.1` at 5 MiB)

## GitHub connection (optional server setup)

The app can list your GitHub repositories, clone one into a new project, and
create a new repository — but only once the *server* knows which GitHub OAuth
App to authenticate as. That is a one-time setup by whoever runs the manager;
there is nothing to do in the browser, and the UI stays dormant (it shows a
"GitHub isn't set up on this server" card) until it is done:

1. Register an **OAuth App** on GitHub (Settings → Developer settings → OAuth
   Apps → New OAuth App) and **enable Device Flow** for it. No client secret
   is needed or stored — the device flow of a public app does not use one.
2. Start the backend with the App's client id in the environment:

       AI_SM_GITHUB_CLIENT_ID=Iv1.your_client_id npm start

   (For the Windows launcher, set it in the environment the WSL command
   inherits.) Absent or empty ⇒ the feature stays dormant; nothing else
   changes.
3. In the app, open **New Project → GitHub → Connect with GitHub**, then enter
   the shown code at `github.com/login/device`. The granted token is stored
   server-side in `github.json` (mode 0600) and is never returned to the page.
   The requested scope is `repo` (list + clone + create + push, no re-auth).
   "Disconnect" deletes the local token; to revoke the grant itself, remove the
   app in GitHub Settings → Applications.

Clones started from the GitHub repo list land in
`<home>/projects/<owner>/<repo>`, so two repositories with the same name from
different owners can both exist locally. The URL-clone tab keeps its
user-chosen destination.

`AI_SM_GITHUB_API_BASE` exists **only for offline tests** — it re-points the
REST base and is refused unless it is a loopback origin (the server exits 1
rather than start), so it can never be a production or GitHub-Enterprise
setting.

## More

- Architecture, decisions, hard constraints: `.claude/PROJECT-SCOPE.md`
- Frontend design system: `web/DESIGN.md`
- Wire contract (REST, WebSocket, discovery file): `shared/protocol.ts`
