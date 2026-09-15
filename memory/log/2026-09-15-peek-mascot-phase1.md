---
type: log
created: 2026-09-15
updated: 2026-09-15
tags: [mascot, frontend, nocturne, overlay]
---
# 2026-09-15 — Peek mascot, phase 1 (standalone page, branch `mascot`)

**Ask (user, 2026-09-15, while another session worked A10b in the main
checkout):** a small Claude mascot at the middle-right of the screen when a
session is finished and waits for input, half visible, peeking around the
edge. Same evening the user built the design in Claude Design
(`design_handoff_claude_peek_mascot/`, high-fidelity, 1:1: three poses, click
= laugh / wave, count 3 = strain) and extended the ask: the mascot lives
OUTSIDE the app at the MONITOR edge, over fullscreen games/video too, with a
Settings toggle. "Test it now, real implementation only in C1" — C1 is the
LAST step of the Nocturne redesign (`.claude/PLAN-NOCTURNE.md` Track C).

**Landed (this phase only):** `web/mascot.html` (second Vite entry, transparent
ground) + `web/src/mascot/{model,view,main}.ts` + `mascot.css`; driven by
`window.aiSmMascot.setCount(n)` (0..3), `?demo&count=N` preview strip; no
session wiring, no host window, no prefs. Rect-by-rect and keyframe-for-
keyframe identical to the handoff (tests pin it). Fix round: `web/mascot.html`
joins the update checker's frontend-source set; `/mascot.html` served from the
no-store entry branch WITHOUT the token; `DEMO_BG` pinned as the fifth
`--color-bg` copy. Suite 1973 → 2022 (+27 model, +19 view, buildinfo, auth,
tokens); 12 mutants killed, 1 gap closed (face group rebuilt on neighbour
render). 3 suite failures are worktree-environmental only (worktree `.git`
file → "commit unknown"; `node_modules` symlink → restart 422).

**Feasibility findings for C1 (not yet decided by the user):**
- Signal exists already: `attention` = BEL in PTY output, acked only when the
  user focuses that pane with the window in front → count = "answers not
  seen yet". On the focused visible pane attention is acked at once, so an
  in-app mascot would have to hook the EVENT, not the state; the OS overlay
  has no such problem (the app is not in front).
- Overlay = second borderless WinForms window in the same WebView2 host:
  TopMost + WS_EX_TOOLWINDOW + WS_EX_NOACTIVATE, transparent WebView2
  navigating to `/mascot.html` (no query string; the host must navigate, an
  iframe is blocked by the frame-protection headers). Hidden at count 0 so it
  never eats clicks. True exclusive-fullscreen games cannot be drawn over by
  any topmost window; borderless / "fullscreen optimizations" / video work.
- Open decisions 12–16 in the plan: monitor, click behaviour, count
  semantics, exclusive-fullscreen limit, reduced motion.

**Process lessons:** a parallel session in the main checkout → own worktree on
a branch off `main`, new files only, `node_modules` symlinked (add to
`.git/info/exclude`: a symlink is not matched by `node_modules/`). Handoff
folders stay untracked like `design_handoff_session_manager/` (public repo;
the prototype runtime `support.js` is third-party, no licence header).
`--virtual-time-budget` screenshots of CSS entrance animations are flaky —
real-time CDP after a wait is reliable. Chromium 1228 lives in
`chrome-linux64/`, needs `LD_LIBRARY_PATH` for libnss3/libnspr4.

Related: [[nocturne-full-switch]], [[native-webview2-host]],
[[frontend-terminal-quirks]], [[localhost-security-model]],
[[dev-machine-setup]]
