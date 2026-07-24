---
type: log
created: 2026-07-24
updated: 2026-07-24
tags: [launcher, windows, webview2, native-host, chrome]
---
# 2026-07-24 — dark window chrome for the native host

Short session after Phase 2 closed. Picked the top user-reported backlog item:
the **white native title bar** the WebView2 host shows when maximized.

## Decided

User picked the **quick DWM-coloring route** over the frameless-plus-custom-
title-strip route they had earlier leaned toward. Rationale and the rejected
alternative live in [[native-webview2-host]]; scope doc updated.

## Shipped (`launcher/host/AiSessionManagerHost.cs`, one file)

`DwmSetWindowAttribute` on `HandleCreated`: immersive dark mode (`20`, legacy
fallback `19`) + caption `35` / text `36` / border `34` colors from the CSS
tokens. `ToColorRef` converts `0xRRGGBB` (as written in `tokens.css`) to the
Win32 `0x00BBGGRR` COLORREF — the byte-order flip is the one easy bug here.

Two judgment calls worth keeping:

- **Subscribe to `HandleCreated`, don't call once after `Show()`.** Adding the
  WebView2 child can force handle creation early, and WinForms can recreate a
  handle later; the event covers both. Subscribing on the line after
  `new Form()` makes it impossible to miss.
- **Every call is failure-tolerant**: `int` HRESULT return (never
  `PreserveSig=false`), whole block in try/catch that logs and continues. This
  is cosmetic; it must never break the window. Same reasoning the file already
  used for `SetCurrentProcessExplicitAppUserModelID`.

## Verified for real, not assumed

- `build-host.ps1` run from WSL via `powershell.exe` → compiles clean with the
  in-box csc. **This is the only syntax check available** — there is no C#
  toolchain in WSL and no C# in the test suite.
- Windows build on this box is **26200** (Win11 24H2+), so the 22000+ color
  attributes really are supported here.
- Launched the app and captured the maximized host with **`PrintWindow`
  (`PW_RENDERFULLCONTENT`)**: caption pixels read `#171D25` exactly.
- Suite 288/288, unchanged (it cannot cover this).

**Gotcha worth remembering:** `SetForegroundWindow` is refused while the user
is active in another app (foreground lock), and a screen-region grab then
captures *whatever else is on screen*. `PrintWindow` renders the target window
only — no focus stolen, nothing else in the image. Use it for any future
host-window verification. Also: a minimized window reports rect
`-32000,-32000 160x28`; restore with `SW_SHOWNOACTIVATE` (4) to avoid grabbing
focus.

## Known limits (not bugs)

- The Edge `--app` **fallback** window still has a light caption — not ours to
  color.
- Windows 10 gets dark mode only, no token colors.
- Nothing enforces token sync between `tokens.css` and the C# constants.

## Next

Queue is unchanged otherwise: (1) user registers the GitHub OAuth App + sets
`AI_SM_GITHUB_CLIENT_ID`, then the first live device-flow smoke test;
(2) live `/verify-terminal` pass on the Windows UI; (3) batched test-hardening
(`web/src/ui/github-model.ts` extraction, `GithubConnection` DI seam,
`AI_SM_GITHUB_API_BASE`). See [[2026-07-24-github-build]].

Related: [[native-webview2-host]], [[2026-07-24-github-build]],
[[thin-windows-launcher]], [[anti-slop-design-direction]]
