---
type: log
created: 2026-11-24
updated: 2026-11-24
tags: [quality, q16, q17, wsl, oom, resume, host, relaunch, incident]
---
# 2026-11-24 — Q16 + Q17: WSL out of memory → a notice, one Restart, sessions resumed

Decision: [[wsl-crash-recovery]]. Spec `.claude/plans/quality/PLAN-Q17.md`.

## The incident

"App weer gecrasht" at 12:53. `server.log` and `pty-host.log` both said
SIGTERM at the same millisecond; `uptime -s` showed a fresh VM; the previous
boot's journal had `Out of memory: Killed process 46783 (python)` and `Free
swap = 0kB`, then `The system will power off now!`. Cause: the crypto
project's session (16 agents, 13 python processes, ~14.4 GB) filled the
16 GB VM. The interrupted `unattended-upgrades` also left dpkg half
configured (`dpkg --configure -a` needed before `apt install earlyoom`).

## Done

- **Q16** `server/pty-table.ts` `raiseOomScore`: 500 after every spawn.
- **P1 backend** `server/previous-exit-model.ts` + `server/previous-exit.ts`:
  `last-exit.json` on every shutdown path (history ids live + those ended
  `exit`/`crash` in the 3 s before the signal — review found the pty-host
  can die first on a VM poweroff and the record would list 0); verdict at
  boot (`boot_id` beats `btime` — WSL steps its clock); `journalctl -b -1
  -k -r … -g "Out of memory: Killed process"` only after a reboot; routes
  `GET /api/previous-exit`, `POST …/resume` (`previousSessionId` per item),
  `POST …/dismiss`. One `resumeEntry` for both resume doors.
- **P2 host** `launcher/host/AiSessionManagerHost-relaunch.cs` (fifth
  partial file): message `relaunch`, record `relaunch.txt`, single flight,
  120 s + a 10 s tail watch so a late window still closes the old one, dev
  instance refuses any spelling of the installed data dir.
- **P3 browser**: offline panel after 10 s, `Restart` in the host, boot
  notice per cause, auto-resume behind the `aism.recover` flag, resumed
  sessions back in their old tabs and slots (layout snapshot read before
  `loadUi` prunes it).

## Gate

Reviews: security P1/P2 clean (lows fixed), scope 3 rounds of should-fixes
fixed. Mutation probe: backend 64 (61 killed, 3 equivalent), C# 34 (33/1),
UI 14/14 — 21 survivors killed by 13 new tests. Full suite 4811/4811.
`/verify-terminal` 1–8, 10, 12 + Q16 (`oom_score_adj` 500 in a session, 0
for backend and pty-host) + the remap seam: pass; 9 not run (would use the
user's claude account), 11 handed to the user.

## Lessons

- A "crash" report → read `journalctl -b -1` before the app's logs; a
  simultaneous SIGTERM to backend AND pty-host means the VM went down.
- A test fixture copied from `/proc/sys/kernel/random/boot_id` is this
  machine's live boot id — use a made-up uuid.
- A CDP `Emulation.setDeviceMetricsOverride` lasts only as long as its
  connection: set the size and measure in one connection.
- Flake seen (not ours): `tests/server/statusline-script.test.ts:370` cache
  cap — the crowded entries sit ≤ 395 ms behind `Date.now()`; a WSL clock
  step back evicts the fresh entry. Test-only fix: make them ~30 s older.

## Open — the user, on Windows

PLAN-Q17 § Final gate 1–3 (`wsl --shutdown` with the app open → panel →
Restart → sessions back; shortcut launch → `Resume N sessions`; dev
instance restarts only dev), the P2 checklist (relaunch record contents,
failure path, single flight, timeout tail), verify-terminal check 11.
