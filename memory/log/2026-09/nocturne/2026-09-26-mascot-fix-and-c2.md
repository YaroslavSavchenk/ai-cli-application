---
type: log
created: 2026-09-26
updated: 2026-09-27
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

## 2026-09-27 — the DEV check found the question gap

- **User:** "Hij zegt dat die actief is, terwijl hij wacht op input … de
  enige issue is met die vragen". The workflows worked.
- **Measured:** Claude Code 2.1.283 writes an open `AskUserQuestion`
  `tool_use` line only AFTER the answer (a monitor saw it land 50 min
  late, together with the answer). The transcript can't show an open
  question.
- **Signal found:** in real PTY captures, Claude Code's OSC 0 title is
  `✳ ` whenever Claude is idle — for a question, a plan approval, a
  permission prompt, and a turn end. It is a spinner while the model
  streams AND while a foreground tool runs.
- **User's call:** all three kinds of waiting count. This settles B11's
  permission-prompt limit.
- **Built** (`backend-pty`):
  - `scanOutput` replaces `scanForBell`: one OSC machine, and it fixes two
    split-escape BEL misreads;
  - `titleIdleSince` in SessionManager (title text never kept);
  - the pure `server/agents-verdict.ts`;
  - the rule: transcript working + idle title for 3 s or more, counted from
    the later of the idle stamp and the turn start → waiting.
- **Reviews:**
  - security clean;
  - scope: a turn-start flash fixed with `max(titleIdleSince,
    workingSince)`, a discarded title now reads not idle, and comments fixed;
  - test gate: 16 tests (one is a differential BEL-parity model against the
    old scanner), 97 mutants / 11 equivalent, no bug;
  - `/verify-terminal` scoped: 1, 7 (BEL, title-BEL, split title) and 9 all
    PASS. The question read Waiting after 4.9 s and the permission prompt
    after 4.75 s.
- **Suite** 3917 green.

## Verified

2026-09-27, the user in DEV: "vragen werken nu, mascotte is goed. Alles
klopt". Fast-forwarded `mascot-detection` into `main`; CI + CodeQL watched.

## Next

- A release (v0.4.1) is the user's call.
- Backlog:
  - `launcher/host/AiSessionManagerHost.cs` is 2385 lines (not under the
    size guard; a `partial` split is suggested);
  - `server/agents.ts` is at 992 of 1000 lines.
