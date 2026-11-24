# App data

Lives in `~/.ai-session-manager/` (override with `AI_SM_DATA_DIR`, absolute
path):

- `projects.json` — saved projects
- `prefs.json` — server-side UI preferences (the settings panel), kept on the
  server so they survive a port change and a cleared browser profile; the tab
  layout does live in localStorage, and survives a restart because the port is
  sticky
- `github.json` — the GitHub credential, user-only readable (mode 0600);
  written after a successful connection (device flow, or a pasted token stored
  with "remember"), deleted on disconnect. Never sent to the browser. It is
  **not encrypted** — see the honesty note in [github.md](github.md#how-the-credential-is-stored-stated-plainly)
- `keys.json` — the stored API keys, one optional value per keyed tool (Claude
  Code, Gemini CLI, Grok — Codex signs in inside its own terminal), user-only
  readable (mode 0600), written atomically when a key is saved in Settings and
  deleted per tool when it is cleared. A stored key only ever reaches the
  environment of a session spawned for that tool, never its argv, never
  `server.log`, never a response: `GET /api/keys` answers saved / not saved
  only. Like `github.json` it is **not encrypted** — same honesty note
- `runtime.json` — runtime discovery (port, auth token, pid, startedAt, and
  `appDir`, the directory the running backend was started from);
  removed on clean shutdown, with one deliberate exception: a restart handoff
  leaves the file in place, because by then it describes the replacement
  process the launcher has to find
- `last-port.json` — the port the backend last bound, tried first on the next
  start (mode 0600)
- `history.json` — every session the app launched, across runs (atomically
  rewritten on every session create/exit/delete and at shutdown; entries left
  open by a crash are stamped `crash` at the next boot — unless the pty-host
  still holds that session, which the boot then adopts; a session whose
  pty-host dies under a running backend is stamped `crash` at once). Feeds `GET
  /api/history` and `POST /api/history/:id/resume`; bounded at 200 entries,
  where the oldest ended one drops first
- `last-exit.json` — how the previous run ended (mode 0600, atomic): why
  (`signal`, `presence-grace`, `restart`, `other`), the open windows, the
  kernel boot id and the history ids of the sessions running then — ids
  only. The next boot judges it (and, after a VM reboot, the previous boot's
  kernel log for an `Out of memory` kill) for `GET /api/previous-exit`;
  resumed or dismissed, it is marked `seen`, never deleted
- `update-check.json` — the in-app update check's cache (installed app only;
  mode 0600, atomic): the ETag and the release descriptor GitHub last
  answered, never the verdict, so an unchanged release costs no quota
- `session-settings/` — one Claude Code settings file per session (directory
  mode 0700), holding only the status-line command the session is launched
  with; emptied at boot except the files of the sessions a pty-host still holds
  (they survive a backend crash and are adopted)
- `statusline-snapshots/` — one file per session (directory mode 0700, files
  0600) holding what Claude Code last reported for it: model, git branch, cost,
  lines changed, context used, account usage, and the path of Claude Code's own
  transcript for the session. Written by the status-line script the sessions
  run, read back by the backend, and drawn in the bar under each terminal — the
  transcript path is not drawn: it is where the backend finds the session's
  subagents for the Background agents table; emptied at boot with the settings
  above, with the same exception
- `statusline-cache.json` — the status line's git-branch cache, user-only
  readable (mode 0600), written by the script Claude Code runs and keyed by its
  session id; deleted at boot, unless the boot adopts any session (the script
  drops its stale entries itself)
- `pty-host.json`, `pty-host.sock`, `pty-host.lockname`, `pty-host.log` — the
  session holder (Nocturne D9): a separate process the backend starts with the
  first session, which owns the terminals so a backend crash does not end them
  (relaunch within 10 minutes and they re-attach), and a restart or an update
  hands them to the new backend instead of ending them. Its state file (pid, build, the
  version dir it runs from — `appDir`, which the installer's retention keeps —
  and the connection token; 0600), its socket (0600), the secret its single-instance
  lock is named after (0600), and its own log (lifecycle and counts only —
  never terminal bytes, environment, arguments or the token; rotated like
  `server.log`). The backend sets an existing data directory it owns to mode
  0700, which the session holder requires; with a directory it may not use
  (another owner, other modes, or a path too long for a Unix socket) the
  sessions run inside the backend as before, and `server.log` says why once
- `server.log` — backend log: one line per event, `<ISO> [level] [component]
  message`, at `debug`/`info`/`warn`/`error`. **Everything is logged by
  default** — boot banner (node version, pid, data dir, effective log level,
  every `AI_SM_*` override, the server commit and the frontend bundle being
  served), every HTTP request, every WebSocket upgrade/attach/resize, session
  lifecycle, history decisions, and the browser's own lines shipped through
  `POST /api/client-log` (tagged `[client]`). Minimum level: `AI_SM_LOG_LEVEL`
  (`debug|info|warn|error`, default `debug`). Rotated at 10 MiB through two
  generations (`server.log.1`, `server.log.2`), so at most ~30 MiB on disk; if
  the rename cannot happen (something is in the way of `server.log.1`) the live
  file is truncated instead, so logging never stops. Two anti-flood limits, since
  any web page on the machine can send unauthenticated requests to the port: a
  logged request path is cut at 256 characters, and **unauthenticated requests
  and rejected upgrades share a budget of 60 log lines per minute**, after which
  the file says how many it suppressed. The budget keys on the auth token, not
  on the status code, so `/health` and the page itself are metered too — and a
  request that carried the token is never metered, whatever it answered.
  Terminal input and PTY output are summarized once a second as byte counts. Secrets are never written to it: not the auth
  token, the GitHub token, request bodies, `Authorization` headers,
  query-string values, or PTY input/output


How the files behave across a restart and after WSL stops:
[restart-and-recovery.md](restart-and-recovery.md).
