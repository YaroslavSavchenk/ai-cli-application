---
type: knowledge
created: 2026-07-18
updated: 2026-07-18
tags: [terminal, backend]
---
# PTY requirements — what breaks and why

The hosted CLIs (claude, codex, gemini) are full TUIs: raw mode, alt screen,
cursor addressing, truecolor. Consequences that keep resurfacing:

- **Real PTY or nothing.** Capturing stdout gives you a dead, line-buffered
  stream — TUIs detect no tty and break, or emit garbage. Every session is a
  `node-pty` spawn; there is no cheap fake.
- **Resize must propagate end to end**: pane resize → xterm.js fit addon →
  cols/rows over WebSocket → `pty.resize(cols, rows)` (SIGWINCH). Any gap in
  that chain = torn TUI rendering. `echo $COLUMNS` in the session is the
  quick truth test.
- **Alt screen must round-trip** — enter vim/htop, quit, previous scrollback
  restored. Breaks when buffer replay or emulator state handling is sloppy.
- **Keyboard passthrough**: Ctrl+C, Esc, arrows belong to the TUI, not the
  app. App shortcuts must be chosen around TUI keybindings.
- **Scrollback is server-side and bounded** — it's what makes reattach-with-
  history possible ([[detached-backend]]) and what leaks secrets if
  persisted carelessly ([[localhost-security-model]]).
- **Spawn as argv array** (`pty.spawn(cmd, [args])`), never a shell string —
  correctness and injection safety coincide here.

Manual verification checklist lives in `.claude/skills/verify-terminal/SKILL.md`
(nine checks; "text appears" is not a pass).

Related: [[web-app-inside-wsl]], [[anti-slop-design-direction]]
