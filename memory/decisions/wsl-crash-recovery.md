---
type: decision
created: 2026-11-24
updated: 2026-11-24
tags: [quality, q16, q17, wsl, oom, resume, host, relaunch]
---
# When WSL goes down: tell why, one Restart, resume everything (Q16 + Q17)

**Status:** decided 2026-11-24 (user, after the 12:53 WSL out-of-memory
stop: "doe 1, 2, 3, 4 … als de wsl crasht krijg je een melding met wat er
gebeurd is en … restart de wsl met een knop"). Spec
`.claude/plans/quality/PLAN-Q17.md`; rows Q16/Q17 of
`.claude/plans/PLAN-QUALITY.md`.

- **The incident:** another project's session ran 16 agents with python
  backtests (~14.4 GB RSS, swap full) → global OOM in the 16 GB WSL VM →
  WSL powered off 31 s later → backend + pty-host got SIGTERM together. Not
  an app bug; `server.log` alone could not say why — the previous boot's
  journal (`journalctl -b -1 -k`) could.
- **Outside the app (done by the user the same day):** `.wslconfig`
  `memory=24GB` (was 16; host has 64 GB; active after the next WSL
  restart — the user postponed `wsl --shutdown` for running sessions) and
  `earlyoom` (`-m 5 -s 10`, prefers python, avoids node/`MainThread`/
  claude/system).
- **Q16:** every PTY child gets `oom_score_adj` 500; backend and pty-host
  stay 0 (raising needs no privilege, lowering would).
- **Q17, the user's calls:** (1) planned in PLAN-QUALITY, not Nocturne;
  (2) the button restarts WSL + backend, reloads the window and resumes
  EVERY session that was running, automatically — the user picked this
  over "resume yourself from History"; (3) the notice names the cause.
- **Orchestrator defaults (not asked):** a shortcut launch after such a stop
  OFFERS `Resume N sessions` instead of resuming by itself (a Windows reboot
  also stops WSL); outside the WebView2 host there is no button; only a stop
  while a window was open counts (presence > 0), never the presence grace or
  a restart/update.
- **Resume vs survival:** [[pty-host-session-survival]] rejected resume as
  the way through a RESTART — that stands. A dead VM cannot be survived, so
  resume is the only way back there; the two do not conflict.
- **The host learns the launcher path from `relaunch.txt`** (written by
  `launch.ps1` beside `host.log`), not a new command-line argument — the
  host still takes only the URL and `--dev-instance`. Accepted under the
  threat model: only the same Windows user can write it, and that user can
  already swap the exe ([[native-webview2-host]], [[wsl-0600-not-a-boundary]]).
