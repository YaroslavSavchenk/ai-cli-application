---
type: log
created: 2026-09-26
updated: 2026-09-26
tags: [nocturne, mascot, c1, c2, webview2, launcher, session-state]
---
# 2026-09-26 — Mascot: black box fixed, fullscreen understood, C2 (waits for background work, comes for questions)

**Asked (user, night of 2026-09-25/26):** the mascot does not appear when
something runs fullscreen, and it sometimes has a black background. Later,
C2: it appears while the main session idles but subagents still run, and it
should come for Claude's questions. The state dot should follow the same
rule. All of it in DEV, on a branch, never in the installed app (see
[[native-webview2-host]] § Dev instance).

## Investigation, live on the user's machine (read-only, then probes)

- **Fullscreen.** RDR2 was running: `system.xml` said `windowed=2`
  (borderless), and `SHQueryUserNotificationState` said `QUNS_BUSY`, not D3D
  exclusive. The overlay sat above it in z-order. A probe overlay page stayed
  `visible` with rAF at about 144 fps. The mascot pref had been OFF since
  2026-09-23 15:58. After switching it on (user OK'd a live test) the mascot
  showed over the game, transparent. So the only real gap was fullscreen
  windows that are themselves topmost, and exclusive fullscreen remains
  impossible (decision 15).
- **Black box: cause proven** with a green-backdrop probe:
  [[webview2-colour-key-loses-transparency]]. One resize and the colour-key
  overlay turns opaque for good. The visual-hosting probe stayed transparent
  through every trigger.

## Built (branch `mascot-detection`)

- **C1 fix** (`wsl-launcher`):
  - the overlay moved to visual hosting (DComp interop in C# 5), with host
    mouse forwarding and the cursor;
  - topmost re-asserted on every count message, on
    `EVENT_SYSTEM_FOREGROUND`, and once 500 ms later;
  - the `TopMost` property dropped (it activated the form);
  - the page re-reports on `resize`;
  - the **dev instance** gets its own `%LOCALAPPDATA%\ai-session-manager-dev\`
    through a fixed `--dev-instance` switch, clone launches only.
- **C2** (`backend-pty`): a stateful turn fold in `server/agents-fold.ts`
  (questions → `'asking'`; launches ↔ notifications; SendMessage resume;
  `queued_command`), the workflows liveness scan
  `server/agents-workflows.ts`, and `#sessionTurn` in `server/agents.ts`
  (liveness = < 15 min, B7 row running or finished < 10 s ago, workflow
  files fresh). Decisions: [[c2-mascot-waits-for-background-work]].

## Reviews

- **Host / launcher:** security clean except a README bug. The documented
  dev command lost `$env` to bash, so the "dev" launch would have silently
  run on the LIVE data dir. Scope asked for option A (an installed launcher
  is never a dev instance) plus truthful comments. One fix round.
- **C2:** security clean (info: symlink-swap residual, 1 bit, smaller than
  B7's). Scope: 2 should-fix (a false "cap can't be staged" claim, three
  untrue comments) and 3 nits (one home for the agent-id shape, among
  others).
- **Test gate:** 18 tests added; 77 mutants, 68 killed, 9 equivalent; no
  bug. Small follow-ups: a dead branch removed, a 10 s finish grace against
  a one-poll mascot flash, the cap tests moved by topic.
- One developer was killed by a 429 mid-fix. The tree was checked (no
  mutant, no scratch backend) and it was resumed.

**Suite** 3452 (C1) → 3873, all green; typecheck and build green.

## Next

- DEV Windows check with the user (dev backend on
  `~/.ai-session-manager-dev`, dev window isolated). Then merge to `main`
  and a release (v0.4.1) are the user's call.
- Backlog:
  - `launcher/host/AiSessionManagerHost.cs` is 2385 lines (not under the
    size guard; a `partial` split is suggested);
  - `server/agents.ts` is at 992 of 1000 lines.
