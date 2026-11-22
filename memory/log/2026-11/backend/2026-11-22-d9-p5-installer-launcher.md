---
type: log
created: 2026-11-22
updated: 2026-11-22
tags: [backend, d9, pty-host, installer, launcher, incident]
---
# 2026-11-22 — D9 P5: installer, launcher, status line

Part of [[pty-host-session-survival]] (spec `.claude/plans/nocturne/PLAN-D9.md`).

## Done

- Installer retention keeps the version dir a live pty-host runs from
  (`pty-host.json` read inside the distro; only an allow-listed direct child
  of the app dir comes out, never the token).
- `launch.ps1 -Stop` ends a lone pty-host (no runtime.json, or its pid
  already gone) after a `/proc/<pid>/cmdline` identity check (exact data
  dir line + `pty-host-main.ts`); exits 6/7/8/9; it leaves the pty-host
  alone when runtime.json now names ANOTHER backend (restart handoff).
  Both -Stop sh scripts share one preamble.
- Installed status line runs through `<app>/current`; `installerCurrent`
  in `server/bundle.ts` is the one rule (symlink, containment, marker) for
  the update probe, the restart preflight and the status line. The
  cross-version contract (statusline.mjs argv only grows) lives in its header.
- verify-terminal checks 10–12 (restart mid-output, Claude mid-turn through
  Update = Windows step, resize after re-attach).
- Reviewed (scope + security, all fixed); mutation gate 52 mutants, 9 gaps
  closed with tests, no bug. Suite 4577+ pass.

## Lessons

- INCIDENT: the first P5 developer ran the REAL `launch.ps1 -Stop` from WSL
  with `WSLENV=AI_SM_DATA_DIR/u`. `/u` = Win32 → WSL only, so PowerShell
  fell back to the default data dir and SIGTERMed the user's INSTALLED
  backend — twice (2026-11-21 19:34, 2026-11-22 18:40), every session gone.
  The user read it as "crashes since v0.4.4". Safe form: set the variable
  inside PowerShell (`\$env:` escaped in bash), `-Status` must name the
  scratch dir before any `-Stop` (template in the verify-terminal skill).
- Security review caught the first "safe" template still broken: in a bash
  double-quoted string `$env` expands to nothing.
