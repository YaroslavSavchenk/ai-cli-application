---
type: decision
created: 2026-09-06
updated: 2026-09-06
tags: [logging, observability, security, backend, frontend]
---
# Log everything — server.log as the single diagnostic channel

**Status:** decided (2026-09-06, user's call: "ik wil dat jij ook logging
toevoegt, dat alles gelogd wordt").

## Trigger

The user launched the freshly built UI (`web/dist` 12:14) against a backend
started at 10:49 — before the history commit ([[session-history-resume]]).
`/api/history` answered 404, the HISTORY section stayed empty, and nothing
anywhere said why: the backend is detached (stdio on /dev/null), the browser
console is invisible from the app window, and `server.log` only recorded
spawns, exits and errors. The user read it as "history still does not work".
Diagnosis took process-tree archaeology (`ps lstart` vs commit time). That
must be readable from the log's first lines next time.

## Decision

- `server.log` gets a `debug` level and **defaults to it** (`AI_SM_LOG_LEVEL`
  to quiet it). One line per event, `<ISO> [level] [component] message`.
- Boot banner prints what is running: node, pid, data dir, level, every set
  `AI_SM_*` override, the server's git commit (read from `.git` directly, no
  git spawn) and the frontend bundle being served. `GET /api/runtime`
  exposes `serverCommit` + `webBuild`; the UI's boot line prints them next to
  its own `__BUILD_ID__` — the stale-backend mismatch is now one grep away.
- Everything else at info/debug: every HTTP request, every WS
  upgrade/attach/detach/resize, session lifecycle, history load/list/prune,
  lifecycle count transitions, store load/save, errors with stacks.
- The browser ships its own lines (`POST /api/client-log`, tagged
  `[client]`): errors, unhandled rejections, every API call + status, WS
  open/close/reconnect, UI actions as SHAPE.
- Bytes are never logged: terminal input and PTY output become byte counts
  aggregated at most once per second per session.

## Redaction rules (the real control — 0600 is not, see [[wsl-0600-not-a-boundary]])

Never written: the app token, the GitHub token, request/response bodies,
`Authorization`, query-string values (`?…` only — both server AND client
side; the client half shipped raw `?path=/mnt/c/...` in the first version
and review caught it), PTY bytes, the raw custom command text (word count
only), env values whose NAME matches `TOKEN|SECRET|PASSWORD|PASSWD|KEY|CRED|AUTH`
or whose VALUE is a URL with userinfo (the first banner leaked
`user:password@` from `AI_SM_GITHUB_API_BASE`; an existing test caught it).
The generic request-failure line prints error class + stack frames only,
never the message — and strips the `name: message` header BY LENGTH before
filtering frames, because V8 does not escape newlines inside the ~10 chars
of input it quotes in a `JSON.parse` SyntaxError, so a body of
`\n    at ghp_…` would otherwise pass a `/^\s+at\s/` filter.

## Anti-flood (the log is an attack surface)

Any web page can hit the port unauthenticated (no-cors GET carries no
Origin). Logging every request therefore let a hostile page rotate all
three generations away in seconds (15 KB paths × 640 requests). Controls:
logged pathname cut at 256 chars; lines for requests the token check did
NOT pass (unauthenticated 2xx like `/health` and `/`, all 4xx, rejected
upgrades) share one window budget of 60 lines/min, then a single
suppression count; authenticated lines are never metered. Metering on
STATUS (4xx) was the first version — the auditor showed unmetered
unauthenticated 2xx still allowed a wipe in minutes, hence metering on
trust. Client-log entries: 200/min global, dropped with one warn per window.
Rotation 10 MiB × 3 generations (≤ 30 MiB); a failed rename truncates the
live file rather than wedging the logger silently forever (the first
version did exactly that: rotate threw, `bytes` never reset, every later
line dropped).

## Rejected alternatives

- **`navigator.sendBeacon` for the unload flush** — cannot carry the auth
  header; putting the token in a URL is forbidden. `fetch` with
  `keepalive: true` does the same job.
- **Logging PTY input/output content** ("everything") — scrollback holds
  typed secrets; counts only. The user's "alles" was read as "every event",
  not "every byte".
- **Per-frame / per-entry debug lines** (one line per keystroke, one prune
  line per kept history entry, one line per presence ping, the client-log
  POST itself at info) — volume math: ~10 MB/day idle per window, retention
  ~3 days; all folded into once-per-second or once-per-call summaries.
- **A UI banner "backend outdated, restart"** — would have prevented the
  incident outright, but is a new UI surface; left as an open decision for
  the user rather than settled silently.
- **Client-side omission of noisy calls** — the level filter and server-side
  budgets are the right place; the client ships everything it sees.

Related: [[localhost-security-model]], [[lifecycle-bound-backend]],
[[2026-09-06-log-everything]]
