---
type: log
created: 2026-09-08
updated: 2026-09-08
tags: [frontend, launcher, host, keyboard, terminal, launch-dialog, dev-flow]
---
# 2026-09-08 (afternoon) — `/login` field fixed; plain terminal sessions SHIPPED

## What the user asked (Dutch)

"voor dat login, het veld is er wel, maar hij staat op zoeen aparte plek,
dus daar kan ik niks typen of plakken. Via gewone terminal lukt dat wel"
→ "fix de login veld nu en voeg een mogelijkheid om een terminal toe te
voegen, waarin je dingen zelf kan doen".

## Diagnosis

PTY proven fine first (node-pty probe, isolated `CLAUDE_CONFIG_DIR`: typed
and bracketed-pasted input echoes into "Paste code here"). Three gaps on
our side: WebView2 host never restores keyboard focus after an Alt-Tab; the
host dropped xterm's OSC 8 `window.open` as an off-origin popup (and xterm
put a `confirm()` in front of it); no paste chord. Decision:
[[terminal-sessions-and-host-exit]]; learnings:
[[webview2-focus-links-clipboard]].

## Built (dev-flow)

wsl-launcher (C# host: focus on activation, http/https `window.open` →
default browser, clipboard-read grant; compiled through interop, verified
end to end against a scratch page with injected keys — Firefox opened as a
separate process, keys landed after the focus switch, Ctrl+Shift+V read
the clipboard) + terminal-ui (ui/keys.ts pure predicates, xterm
`linkHandler`, paste chords, refocus on window focus; launch dialog kind
switch Claude · Terminal · Other with WSL shell / PowerShell; labels in the
drawer). Headless-chromium run of `/verify-terminal` 1–9 PASS by the UI
developer. Review (scope / security / tests) → fixer → final gate.
Suite 767 → 842 (one fix cycle, +75 tests).

## What review caught

- Plain click opened any CLI-printed OSC 8 link with no second gesture
  (security-relevant, unrecorded) → Ctrl+click.
- Same-origin `window.open` could navigate the app window to a 401 page
  with no Back key (pre-existing branch, now reachable without confirm) →
  dropped; `IsUserInitiated` checked.
- Auto-refocus stole the keyboard from an OPEN drawer when focus rested on
  the topbar button → one `focusOwnerOpen` rule.
- History rows showed no label for shell sessions; `commandLabel` sat
  behind the DOM import graph; the server titled a project-less session
  with the raw command (`/bin/bash`) → cwd basename.
- Test gate: 11 mutants, 2 survived until new tests (`commandLabel`,
  `trapTab` roving-tabindex filter); real bash + PowerShell sessions over
  the backend (echo, resize 100→132).
- The first review round was lost to the session rate limit and re-run.

## Follow-up the same hour

User: "hoezo ctrl+shift+v? kunnen wij dit ergens bij zetten?" — plain
Ctrl+V cannot be the paste (xterm sends Ctrl+letter to the program; Claude
Code uses Ctrl+V itself), so the chord is made discoverable: `?` button in
the top bar beside the gear (opens the shortcuts overlay), a one-line why
under the overlay's paste row, and a KEYS section in Settings (paste
chords, Ctrl+click for links, `all shortcuts`). Suite 842 → 850.

## Open

- Manual (Windows): relaunch from the shortcut (new host exe); `/login`
  round trip — Ctrl+click the link (Firefox), title-bar click back, type,
  Ctrl+Shift+V; Alt-Tab with a drawer / dialog open keeps focus there;
  Terminal → PowerShell in a project (UNC prompt, ~8 s), resize.
- Known limit (scope doc): a program blocking on a terminal query
  (PowerShell `ESC[6n`) replayed into a pane attaching in the few-ms
  replay window would hang — not observed; fix idea: answer queries
  server-side while nobody is attached, or re-feed the trailing query.
- Backlog: GitHub Actions release of the host exe (idea, user's go).
- Side effects of the host smoke test on the user's desktop: 2–3 dead
  Firefox tabs at `127.0.0.1:59531`.
