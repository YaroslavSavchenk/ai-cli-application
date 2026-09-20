---
type: knowledge
created: 2026-09-20
updated: 2026-09-20
tags: [tests, wsl, flake, time]
---
# The WSL clock steps backwards — time-ordered tests flake with it

Measured 2026-09-20 during restructure batch 2: two full-suite runs each
failed ONE test, a different one each time, on a diff that was proven to be
comment-only; both pass alone and the third full run was 2915 / 0.

- `tests/restart.test.ts` "REAL restart…": `update` came back `frontend
  rebuilt` — `web/dist` looked newer than the child's `startedAt`.
- `tests/lifecycle.test.ts` "history: every end reason…": the newest entry
  did not sort first; the dump showed an entry whose `ended`
  (`…21:37:45.790Z`) lies BEFORE its own `createdAt` (`…21:37:48.115Z`).

Cause: WSL2 re-syncs its clock to the Windows host and STEPS it, also
backwards. `dmesg | grep -i 'time jumped'` shows it
(`systemd-journald: Time jumped backwards, rotating.`, three times that
evening). Anything that compares wall-clock timestamps taken seconds apart
(`Date.now()`, file mtimes against `startedAt`) can invert.

What to do with a lone red test of this kind: read the timestamps in the
failure, check `dmesg`, re-run the file alone, then the suite once more. It is
not a reason to weaken the assertion. A real fix would be monotonic ordering
(a sequence number beside `lastUsedAt`) — not built, recorded in case the
flake becomes frequent. Seen in: [[2026-09-20-repo-restructure-batch2]].
