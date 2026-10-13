---
type: log
created: 2026-10-13
updated: 2026-10-13
tags: [backend, lifecycle, runtime-json, d2]
---
# 2026-10-13 — D2: runtime.json belongs to whoever it names

**Asked (user):** "begin aan de runtime.json bug" (backlog § From Nocturne
C1, seen twice on the dev data dir 2026-09-22).

## Cause

`server/index.ts` `shutdown()` and the `uncaughtException` handler unlinked
`runtime.json` unconditionally. An old backend that hit its idle grace
9 s after a NEW backend had written the file deleted the new one's discovery
file; `launcher/launch.ps1` (`Read-RuntimeInfo` → `Start-Backend`) then found
nothing and started a second backend.

## Fix (branch `runtime-json-owner`)

- `server/runtime-file.ts`: pure `runtimeFileVerdict` + `removeOwnRuntimeFile`
  — delete only when the file's `pid` AND `startedAt` are this process's;
  missing / unreadable / unparsable / another owner → kept, one info line
  with a fixed reason (never the token). `startedAt === ''` (before listen,
  or a standby before `go`) → never deletes: also closes an older hole where
  a pre-listen SIGTERM deleted the live backend's file.
- Shared `readSmallRegularFile` in `server/config.ts` (O_NOFOLLOW |
  O_NONBLOCK, regular file, size cap, cap+1 read, close in finally), now also
  used by `server/last-port.ts` (scope review: one home per helper).
- Read → unlink window accepted (needs write access to the user's own 0700
  data dir; worst case = the old bug for microseconds).

## Review

Security clean; scope 1 should-fix + 4 notes, one fix round. Mutation gate:
57 mutants, 10 survivors → 7 tests → 0 (1 equivalent). The uncaughtException
path got a real end-to-end test through a `NODE_OPTIONS --import` data-URL
seam that throws on SIGUSR2 — no app change needed. Suite 4008 green.
Follow-up in the backlog: `launch.ps1 -Stop`'s `rm -f` after a failed kill is
the same class.
