# Memory Index

Map of content for the project memory vault. One line per note, newest-first
within sections. Update this file every time a note is added, renamed, or
superseded. Conventions live in `.claude/skills/memory/SKILL.md`.

## Decisions

- [[github-token-paste-path]] — 2026-07-25: an "add token" path beside the device flow (user's request), persisted with a remember-toggle; design gate ran BEFORE any code — storage ceiling is 0600 + discipline, and the real win is a fine-grained token with an expiry. **Implementation queued**
- [[no-code-in-ui-copy]] — 2026-07-25: no commands/flags/config names in the GUI; modes read "Always ask / Auto-approve edits / Read-only planning / Never ask", argv preview → readable summary; UI stays English; custom-command field exempt
- [[owner-qualified-clone-paths]] — 2026-07-25: GitHub-list clones land at `<home>/projects/<owner>/<repo>` (settles the open decision); kills the same-basename 409 *and* the wrong-project button; rejected adding `remote` to `Project`
- [[native-webview2-host]] — 2026-07-23: fix the Edge-logo taskbar icon by bringing a lightweight WebView2 host forward (not Tauri); cheap AUMID/shortcut fix proven structurally impossible here. **+2026-07-24: dark window chrome via DWM caption/text/border colors — user chose this over a frameless window with a custom title strip (still available later)**
- [[github-integration]] — 2026-07-23: app can create projects + connect to GitHub (OAuth device flow, user's call); v1 = full create-local / clone / create-repo; token stays server-side
- [[launch-dialog-custom-escape-hatch]] — 2026-07-20: launch dialog gains a `custom · any command` chip (user's call over claude-only), preserving configurable command + args in the GUI
- [[handoff-design-primary]] — 2026-07-20 flip: the user's hi-fi handoff is the primary design source; bottom tab strip; modal launch dialog
- [[lifecycle-bound-backend]] — sessions die with the app (presence WS + grace timer); crash-safe session journal with relaunch
- [[auto-port-discovery]] — backend auto-picks its port; runtime.json discovery file carries port + auth token
- [[vanilla-ts-vite-frontend]] — no UI framework; vanilla TS + Vite around imperative xterm.js
- [[web-app-inside-wsl]] — why the app is a web app served from WSL, not a Windows-native Electron app
- [[detached-backend]] — partially superseded by [[lifecycle-bound-backend]]: setsid detachment from the launcher stands; window-close survival (and the systemd user service plan) reversed
- [[thin-windows-launcher]] — health-check → start via wsl.exe → Edge --app window; Tauri is the upgrade path
- [[agent-team-and-dev-flow]] — the subagent roster, strict lanes, and the develop→review→fix loop
- [[anti-slop-design-direction]] — terminal-derived visual identity; hard reject list for generic AI aesthetics

## Knowledge

- [[wsl-0600-not-a-boundary]] — 2026-07-25 VERIFIED: any process running as the WINDOWS user reads every 0600 file in the WSL data dir through `\\wsl.localhost\` (the 9p server runs as root) — read the live app token from PowerShell, no elevation; no keyring exists in this distro either
- [[path-normalization-delete-primitive]] — 2026-07-25: a cleanup that "removes only what we created" wipes a pre-existing directory when the path carries `..` — `resolve()` is lexical, the kernel is not; one normalization is worthless if one consumer still reads the raw string
- [[pty-exit-data-race]] — **FIXED 2026-07-25**: a session's LAST output vanished at exit — libuv fabricates an EOF on POLLHUP and never re-reads, so the kernel's remaining bytes are dropped (NOT node-pty ordering, my first guess was wrong). Tell: stream emits `'end'` instead of `'error' EIO`. Reproduce by stalling the READER, not by CPU load
- [[localstorage-origin-port-churn]] — auto-picked port = new origin per backend run = localStorage resets; durable prefs belong server-side
- [[pty-requirements]] — why every session needs a real PTY and what breaks without resize propagation
- [[wsl-interop]] — localhost forwarding, calling Windows binaries from WSL, cold-boot delay
- [[localhost-security-model]] — the drive-by-web-page threat; token auth, Origin/Host checks, argv spawning
- [[frontend-terminal-quirks]] — AltGr vs Ctrl+Alt chords, xterm detached-mount trap, attention poll latency, token rotation

## Log

- [[2026-07-25-token-path-RESUME-HERE]] — **START HERE**: pasted-token path shipped (`84da3f0`, suite→533) with the security gate published BEFORE the code and audited against itself; caught a strip that lied in the user's own config, two measured log leaks, and two mutually-shadowing tests. Carries the fully-researched statusline phase as the next brief
- [[2026-07-25-ui-copy-and-clone-paths]] — plain-language UI copy pass (no commands/flags in the GUI, user's call) + owner-qualified clone paths; the design-delta turned out to be 2 cosmetic items; gate caught a summary that could drift from the spawn, a proven directory-wipe primitive (+ a pre-existing twin), and a test vacuous for 4 of 6 consumers; suite 396→462
- [[2026-07-25-pty-tail-rescue]] — the lost PTY tail FIXED via dev-flow (suite 391→396); root cause was libuv, not node-pty. Reviewers caught a comment asserting an invariant the code didn't implement, and twice turned an inherited guarantee into a local one. node-pty pinned exactly; `/verify-terminal` live pass still open
- [[2026-07-24-github-hardening]] — test-hardening via full dev-flow, suite 288→391: `github-model.ts` extraction (clock injected), `AI_SM_GITHUB_API_BASE` loopback-only test seam, `redirect: 'error'` on token-bearing calls. Lessons: an in-process seam can't reach an out-of-process server; "unavoidable coverage gap" was refuted by a `git` double on PATH; a runtime-inherited guarantee isn't one. Found (not caused) [[pty-exit-data-race]]
- [[2026-07-24-dark-window-chrome]] — white native title bar FIXED: DWM caption/text/border colors from the CSS tokens on the WebView2 host (user picked this over frameless); verified by compiling on Windows + a `PrintWindow` capture reading `#171D25`; gotcha: use `PrintWindow`, not a screen grab, when the foreground lock blocks activation
- [[2026-07-24-github-build]] — **Phase 2 COMPLETE**: project creation (blank + URL clone + picker) → GitHub OAuth device-flow connection + repo listing → token-auth clone-by-pick + create-repo. Token server-side 0600, never leaked (host-locked clone resisted every exfil bypass); config-driven/dormant until `AI_SM_GITHUB_CLIENT_ID`; security CLEAN every phase; suite→288. **Blocked-on-user: register the OAuth App + set the client_id; live verify-terminal pass**
- [[2026-07-24-status-bar]] — design intake committed; per-pane terminal status bar SHIPPED (real-or-omit telemetry from git + Claude logs; usage% deferred not faked); suite 162→222; 3 user decisions recorded (status-bar-first, git-init toggle, `repo` OAuth scope); **verify-terminal live pass pending; Phase 2 GitHub build started**
- [[2026-07-23-webview2-host-shipped]] — WebView2 host shipped + Edge taskbar icon FIXED (user-confirmed); \\wsl.localhost exe-launch regression found & fixed; **guidelines for tomorrow: design reconciliation → GitHub build**
- [[2026-07-23-settings-panel-and-scope]] — settings panel landed via dev-flow (162/162, 2 LOW fixed); Edge-icon cheap fix proven impossible → WebView2-host decision; GitHub scope added; design handoff refreshed (delta reconciliation queued)
- [[2026-07-20-theme-persistence-launcher]] — prefs.json + /api/prefs fix the theme reset; launcher finished with desktop shortcut; suite 120/120; agents-on-opus policy; settings panel un-gated
- [[2026-07-20-r3-launch-dialog]] — R3 shipped: modal launch dialog + custom chip + honest boot panel, launcher-as-tab retired; 92/92 tests, 9/9 verify-terminal; theme-persistence phase queued
- [[2026-07-20-r2-handoff-reskin]] — precedence flip + R2 shipped: handoff reskin, bottom tab strip, theme system; 9/9 verify-terminal; settings panel queued user-gated
- [[2026-07-19-design-handoff-and-r1]] — user's hi-fi handoff triaged (gap analysis, fiction cuts, 2 open decisions); presence ping/pong + /api/runtime landed
- [[2026-07-19-lifecycle-and-pivots]] — lifecycle reversal implemented; steam-blend direction chosen; caveman + model-assignment process changes
- [[2026-07-18-mvp-build]] — backend + frontend + launcher landed via dev-flow workflows; backlog and manual-pass list
- [[2026-07-18-project-setup]] — scope agreed, agent team + dev-flow built, memory vault created
