---
type: log
created: 2026-10-13
updated: 2026-10-13
tags: [launcher, d3, runtime-json]
---
# 2026-10-13 — D3: `launch.ps1 -Stop` removes runtime.json only when it still names the stopped pid

**Asked (user's pick from the backlog):** D2's twin on the Windows side.
Before, after a failed `kill -TERM` (the process was already gone), `-Stop`
ran `rm -f "$DataDir/runtime.json"` in a separate `wsl.exe` call. A
backend that wrote its file in between lost it.

**What landed:** a const sh here-string `$AiSmStaleRuntimeScript`, run as
`wsl.exe -d $Distro --exec sh -c $script sh $DataDir "$ServerPid"`.
- Values arrive as `$1`/`$2`, never in the script text.
- `--exec` because plain `--` re-joins the words for the default shell, so
  `$1`/`$2` arrive empty ([[wsl-interop]]).
- The script expands `~/` from `$HOME` itself, and refuses a HOME that is
  unset, relative or outside `[A-Za-z0-9._/-]` (exit 5).
- It refuses a symlink or non-regular file, and treats any test error as
  a refusal (exit 4, fail closed).
- It removes the file only when its single pid line equals the pid that
  was read.

`ConvertTo-AiSmScriptLine` moved from `installer/helpers/helper-common.ps1`
to `launcher/config-common.ps1` (one home; every installer helper already
loads it).

**Review:** scope clean; security: two notes. The HOME fail-closed was
fixed. The check-then-rm window is a few ms, the same residual D2 accepted.
Tests: `tests/release/launcher-stop.test.ts` runs the real script text
under `sh`. The mutation probes (old bare rm back, the pid gate removed,
the HOME guards removed, error fall-through) were each caught.

**Owed (user, Windows, in dev):** `launch.ps1 -Stop` against a dead pid.
Expected: the stale file is removed. Against a file naming another pid:
`left in place`.
