---
type: knowledge
created: 2026-09-08
updated: 2026-09-08
tags: [launcher, host, webview2, xterm, keyboard, clipboard, powershell]
---
# WebView2 focus, OSC 8 links, clipboard, PowerShell in a Linux PTY

Learned while fixing the `/login` field (2026-09-08).

- **WebView2 does not take keyboard focus back by itself.** After the
  Windows browser (opened by Claude Code) steals focus and the user clicks
  the host's title bar or Alt-Tabs back, the WinForms form is active but
  the WebView2 control is not focused: keys go nowhere until a click inside
  the page. The WinForms wrapper exposes no controller; the reliable path
  is `form.ActiveControl = null; webView.Focus();` from `Activated`
  (deferred with `BeginInvoke`) and after `NavigationCompleted`. Verified
  by injecting keys into the host window from WSL (SendKeys, only after
  `GetForegroundWindow()` matched the host).
- **Origin lock vs links:** `NewWindowRequested` with `e.Handled = true`
  kills every popup, so xterm's default OSC 8 activation (`confirm()` then
  `window.open`) silently did nothing. Route off-origin `http`/`https`
  `window.open` to `ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute }`
  — the default browser, separate process. Check the scheme on the HOST
  side, never trust the page. `Uri.Host` excludes userinfo/port/path/
  query — log only that; OAuth links carry codes.
- **Clipboard:** the page's `navigator.clipboard.readText()` needs
  `PermissionRequested` → `Allow` for `ClipboardRead` on the app origin
  (WebView2 shows no prompt UI otherwise). Chromium's paste-event path
  (Ctrl+V into a textarea) does not go through it. `Ctrl+Shift+V` is not
  swallowed by `AreBrowserAcceleratorKeysEnabled = false`.
- **xterm 6:** `linkHandler.activate(event, uri)` receives the MouseEvent
  — Ctrl+click is decidable there; `allowNonHttpProtocols` stays off so
  `file:`/`javascript:` never become links. `term.paste(text)` applies
  bracketed paste when the app enabled it.
- **PowerShell through WSL interop in a Linux PTY works**: ANSI colours,
  PSReadLine, `WindowSize` follows `resize`, ~8 s cold start, prompt in the
  `Microsoft.PowerShell.Core\FileSystem::\\wsl.localhost\...` provider
  form. It sends `ESC[6n` at start and BLOCKS until answered — a bare
  node-pty harness must reply `ESC[1;1R` itself; xterm answers for free.
  Linux env does not cross into the interop child (`WSLENV` empty).
  `cmd.exe` refuses a UNC cwd and starts in `C:\Windows`.
- **Reproducing Claude Code's login screen safely:** run `claude` with
  `CLAUDE_CONFIG_DIR=<scratch>` — a fresh onboarding shows theme choice →
  login method → the OAuth URL + "Paste code here if prompted >" without
  touching the user's real credentials.
