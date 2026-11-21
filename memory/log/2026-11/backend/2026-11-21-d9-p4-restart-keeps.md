---
type: log
created: 2026-11-21
updated: 2026-11-21
tags: [backend, d9, pty-host, restart, update]
---
# 2026-11-21 — D9 P4: restart and update keep the sessions

Part of [[pty-host-session-survival]] (spec `.claude/plans/nocturne/PLAN-D9.md`).

## Done

- P3 gate finding fixed first: `RingBuffer.restore()` stores the snapshot
  in 1/64-of-the-cap slices, so an append past the cap drops one slice,
  not the whole adopted scrollback (`afc25fa`).
- Restart/update teardown `keep` ⇒ `SessionManager.detachAll()` (pending
  spawns killed + forgotten, every blob flushed, `host.detach()`, no
  history stamp); `end` ⇒ `endAllLive('shutdown')` + `destroyAll()` as
  before. The standby probes the pty-host (role probe, `list-count`, ONE
  5 s budget for hello and answer) and reports `compatible|incompatible|none`.
- Sessions end only with consent: in-process running, `incompatible`, or
  `none` while sessions run ⇒ `409 { code: 'sessions-would-end' }`; the UI
  asks again ("Restart and end the sessions?", "Restart anyway") and only
  then posts `{ endSessions: true }`. The `none` case is the developer's
  extension of decision 27 (fails safe) — confirm with the user.
- Security S1: a detach while a new pty-host is still starting never says
  hello as owner (it would take the seat from the adopting child).

## Lessons

- The mutation gate found a probe that bounded only the hello: a host that
  welcomed and went silent held `standby-ready` until the parent's 20 s
  timeout (422). A timeout must cover the whole exchange, not its first step.
- Two flakes under load, not reproduced alone: `pty-host-backpressure`
  "a stalled owner taken over" (120 s) and `restart-survive` before-hook
  ticks stalling at 10 in the FIRST backend. Watch on CI; possibly a
  pause that never resumes.
