---
type: decision
created: 2026-09-08
updated: 2026-09-08
tags: [frontend, launcher, host, keyboard, clipboard, terminal, launch-dialog]
---
# Plain terminal sessions + the host's one sanctioned exit (login fix)

**Status:** decided (2026-09-08, user's call — "fix de login veld nu en
voeg een mogelijkheid om een terminal toe te voegen, waarin je dingen zelf
kan doen"; earlier the same day: "alles moet mogelijk").

## Trigger

`/login` inside a Claude pane: the OAuth link opens, the user returns to the
app and can neither type nor paste into "Paste code here"; a plain terminal
works. The PTY side was proven fine (typed + bracketed-pasted input echoes
in a node-pty probe with an isolated `CLAUDE_CONFIG_DIR`). Three real gaps
on our side, see [[webview2-focus-links-clipboard]]: the WebView2 host
never restored keyboard focus after an Alt-Tab; xterm's default OSC 8
activation did `confirm()` + `window.open`, which the host dropped as an
off-origin popup; no paste path beyond the browser default.

## Decision

- **Host (C#):** focus the WebView2 control on form `Activated` and after
  navigation; `NewWindowRequested` = the ONE sanctioned, one-way exit from
  the origin lock: user-initiated (`IsUserInitiated`), exact `http`/`https`
  scheme, parsed `AbsoluteUri` → `ProcessStartInfo` + `UseShellExecute`
  (default browser, separate process); every other scheme, every popup and
  every same-origin new-window request is dropped; top-level navigation
  stays locked; `host.log` records scheme+host only (OAuth links carry
  codes). `PermissionRequested`: clipboard-read for the launch origin,
  everything else denied silently.
- **UI:** window `focus`/`visibilitychange` → terminal focus unless a
  dialog, drawer, overlay or editable owns it (pure `shouldRefocusTerminal`
  + `focusOwnerOpen` in ui/keys.ts); OSC 8 links open via `window.open(...,
  'noopener,noreferrer')` on **Ctrl+click**, `http`/`https` only, no
  confirm dialog (the modifier is the second gesture — Windows Terminal /
  VS Code convention; scheme filter runs in JS AND in C#); `Ctrl+Shift+V`
  and `Shift+Insert` paste via `navigator.clipboard.readText()` →
  `term.paste()` (bracketed paste honoured); plain Ctrl+V stays a PTY key.
- **Launch dialog:** first row `Session` = `Claude · Terminal · Other`
  (segmented radiogroup, Mode's idiom). Terminal = `WSL shell`
  (`/bin/bash -l`) or `PowerShell` (`powershell.exe -NoLogo` through WSL
  interop) in the project folder or the home folder. `Other` = the
  2026-07-20 custom-command hatch, its footer toggle gone. Claude-only
  controls hidden AND disabled for the other kinds (hidden, not dimmed:
  dimmed + the Shell row overflowed the dialog). `composeSpawn()` is the
  one composition path. Sessions drawer + history rows label shells
  `WSL shell` / `PowerShell`, the agent `Claude Code`, custom commands
  verbatim; a project-less session is titled by the server after its
  cwd's last segment, never the command.

## Rejected alternatives

- **Keep xterm's `confirm()`** — a modal in front of every link, and the
  host dropped the resulting popup anyway; Ctrl+click is the terminal
  convention and keeps a deliberate gesture without a dialog.
- **Plain click opens links** (first cut) — review: a CLI can print any
  OSC 8 URI (from a repo, a web page); one accidental click → attacker-
  chosen page in the browser. Ctrl+click instead.
- **Intercept plain Ctrl+V as paste** — violates the keyboard hard
  constraint (Ctrl+V is a PTY key in a Linux terminal).
- **`@xterm/addon-web-links`** (bare URLs clickable) — new dependency and a
  wider click surface; OSC 8 is what Claude Code emits.
- **Same-origin `window.open` navigating the app window** (pre-existing
  branch) — dropped: a printed same-origin link could send the window to a
  401 JSON page with no Back key.
- **cmd.exe as a third shell** — interop refuses a `\\wsl.localhost` cwd
  and starts in `C:\Windows`; PowerShell handles the UNC provider path.

Related: [[native-webview2-host]], [[launch-dialog-custom-escape-hatch]],
[[webview2-focus-links-clipboard]], [[frontend-terminal-quirks]],
[[2026-09-08-login-and-terminal]]
