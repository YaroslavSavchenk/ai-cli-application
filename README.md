# AI CLI Session Manager

A web app for running and managing multiple AI CLI sessions (Claude Code
first; the launched agent is a configurable command + args, so other CLIs
work too) side by side. A Node.js backend inside WSL2 spawns each session in
a real pseudo-terminal (node-pty), streams I/O over WebSocket, and serves a
vanilla-TypeScript frontend (xterm.js) with projects, launch presets, and
multi-pane tab layouts. Sessions are server-side objects: closing the
browser window never kills them; reattaching replays the full scrollback.

## Run it (Windows + WSL2)

Run `launcher/launch.cmd` from Windows. It attaches to a running backend (or
starts one detached inside WSL), waits for it to become healthy, and opens
the UI in an Edge app window. Configuration, switches (`-Status`, `-Stop`,
`-NoBrowser`), pinning, and troubleshooting: see
[launcher/README.md](launcher/README.md).

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
- `runtime.json` — runtime discovery (port, auth token, pid, startedAt);
  removed on clean shutdown
- `server.log` — backend log (rotated to `server.log.1` at 5 MiB)

## More

- Architecture, decisions, hard constraints: `.claude/PROJECT-SCOPE.md`
- Frontend design system: `web/DESIGN.md`
- Wire contract (REST, WebSocket, discovery file): `shared/protocol.ts`
