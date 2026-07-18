---
type: decision
created: 2026-07-18
updated: 2026-07-18
tags: [architecture, lifecycle]
---
# Detached backend — sessions survive the window

**Status:** decided (2026-07-18)

The backend process is never a child of the launcher or any window. It starts
detached (setsid for MVP; systemd *user* service inside WSL as the polished
version) and keeps running when the GUI closes. Reopening the app reattaches
to live sessions with scrollback replayed.

**Why:** session survival is a core promise of the product. If the backend
died with the window, closing a tab would kill running Claude sessions —
tmux-like resilience is what makes this app trustworthy for long tasks. The
user explicitly confirmed this on 2026-07-18 ("yes good idea").

Consequences that follow from this decision:

- Sessions are first-class **server-side** objects; the browser is only a
  view (see [[pty-requirements]]).
- The launcher must health-check before starting anything — a second launch
  attaches to the existing backend, never spawns a duplicate
  ([[thin-windows-launcher]]).
- Scrollback buffers live (bounded) in the backend so reattach can replay.

## Rejected alternatives

- **Backend as launcher child** — simplest, but killing the `wsl.exe` parent
  kills every PTY inside. Directly contradicts the product promise.
- **tmux under the hood for persistence** — redundant once the backend itself
  is detached; revisit only if backend-restart-without-losing-sessions ever
  becomes a requirement.

Related: [[web-app-inside-wsl]], [[wsl-interop]]
