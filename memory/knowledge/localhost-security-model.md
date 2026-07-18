---
type: knowledge
created: 2026-07-18
updated: 2026-07-18
tags: [security]
---
# Localhost security model — the drive-by threat

The backend is a localhost service whose core feature is **spawning shells**.
The attacker is not on the network — it is any web page open in the user's
browser, which can silently fire `fetch()` and WebSocket connections at
`localhost:<port>`. An unauthenticated endpoint here = drive-by remote code
execution. This threat model drives the `security-auditor` agent's checklist.

Non-negotiables derived from it:

1. Bind `127.0.0.1` only (localhost forwarding still works — [[wsl-interop]]).
2. Token auth on every state-changing endpoint AND every WS upgrade; CORS
   does not protect WebSockets or simple requests. Token generated at
   backend start, user-only-readable file, injected into the served UI.
3. Validate `Origin` (reject foreign pages) and `Host` (DNS rebinding:
   attacker's domain resolving to 127.0.0.1 sidesteps same-origin logic).
4. Spawn via argv arrays; client-supplied values (path, model, mode, args)
   never enter a shell string.
5. The add-project directory browser returns names only, no traversal
   (`..`, symlinks) into arbitrary reads.
6. Scrollback may contain typed secrets — mind persistence, permissions,
   retention ([[pty-requirements]]).

Product judgment call: `--dangerously-skip-permissions` as a launch mode is
in scope — the requirement is that the mode is explicit and visible in the
UI, not forbidden.

Related: [[agent-team-and-dev-flow]], [[detached-backend]]
