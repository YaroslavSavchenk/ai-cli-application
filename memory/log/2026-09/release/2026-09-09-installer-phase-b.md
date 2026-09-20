---
type: log
created: 2026-09-09
updated: 2026-09-09
tags: [log, installer, launcher, inno-setup, wsl, ui]
---
# 2026-09-09 — installer phase B (launcher config + Inno Setup) and the UI slice of phase C SHIPPED

Continues [[2026-09-08-installer-phase-a]] under [[installer-and-self-contained-bundle]].
Session hit the API limit mid-re-review (three agents died); resumed after
the reset with the same briefs.

## User answers of the day (before leaving)

Vault goes public with the repo; future commits via a GitHub noreply
address (set repo-locally, history untouched); the orchestrator flips
visibility right after the phase-D scrub lands and CI is green; **v0.2.0
is tagged only after the user has tested the Setup.exe on Windows** —
phase C's `workflow_dispatch` build produces it as a CI artifact first.

## What landed

- **Launcher config file.** `launcher-config.json` beside the scripts
  (installer-written; corrupt = error, never a fall-through); precedence env
  → config file → UNC-derived → **empty** defaults (the author's home path is
  gone from the launcher); the two allow-list regexes live ONCE in
  `config-common.ps1` (`Test-AiSmLinuxPath` / `Test-AiSmDistroName` /
  `Test-AiSmDataDir`, anchored with `\z` — `$` admits a trailing newline in
  .NET) and are shared by every installer helper. Host runs in place from
  `host\` when the scripts are not on a UNC path; UNC staging kept for
  clones.
- **Inno Setup installer** (`installer/ai-session-manager.iss`, GUID
  `D6B61737-0EA3-4035-85CC-00BCDC60CE05`): per-user, `PrivilegesRequired=
  lowest`, never elevates, six wizard pages (welcome, WSL check → refuse
  with the `wsl --install` instruction, distro pick from `wsl -l -v`, WSL
  app dir ending in `/app` ≥ 3 segments, third-party consent default OFF
  with the exact `curl … | bash` shown, ready), uninstaller with an opt-in
  WSL-side removal that never touches the data dir. All logic in PowerShell
  5.1 helpers writing key=value result files; the `.iss` holds wizard, files,
  icons and a `WslArg` guard (refuses quotes/whitespace on every WSL-bound
  value); `powershell.exe` by `{sys}` full path.
- **Helpers**: `wsl-probe.ps1` (UTF-16LE `wsl -l -v`, per-distro home /
  glibc / `claude` presence), `install-bundle.ps1` (constant `sh -c` unpack
  script with no double quotes, tarball over STDIN, `mv -T` atomic `current`
  swap, node-pty proof on the user's machine before the swap, retention
  current + 1 by ctime with the live dir protected via `runtime.json.appDir`
  + `kill -0`, same-version-live refused), `install-thirdparty.ps1`,
  `uninstall-wsl.ps1` (path guard: allow-listed, ends in `/app`, ≥ 3
  segments, holds a `<v>/bundle.json`).
- **UI slice**: `version` + `installed` in state; "A new version has been
  installed."; `Check for updates` link (installed mode only) → Releases page
  through the one sanctioned `window.open` exit.
- Suite 964 → 1026 (PowerShell driven from WSL via `powershell.exe`
  interop; `pwsh` absent).

## Measured facts worth keeping ([[wsl-interop]] material)

- **`wsl.exe -d X -- sh -c '<script>' sh a b` is double-expanded**: wsl.exe
  re-joins argv and hands it to the DEFAULT shell, which expands `$1`/`$(…)`
  before `sh -c` sees them (`A1= A2= ZERO=/bin/bash`). `--exec` fixes it and
  is now mandatory on every call.
- `wsl -l -v` is UTF-16LE without BOM; `WSL_UTF8=1` must be set on the
  PowerShell child process (an env var set inside WSL does not cross).
- Directory ctime granularity ≈ 4 ms and GNU `ls -t` breaks ties by name
  ascending; tar restores mtimes, so retention orders by ctime.
- `ls -1dtc */` with a `-x` directory present parses it as options and
  fails; `--` plus line-wise `while read` is the safe loop.
- .NET regex `$` matches before a trailing `\n`; gates use `\z`.

## What review caught (2 fix cycles)

MED: same-version reinstall renamed the LIVE dir; ctime tie made two
retention tests flaky; `/SILENT` could pick a WSL 1 distro; the wizard
re-probed and re-added the distro list on every page entry. LOW: `$` vs
`\z`; Pascal interpolated user text into the `powershell.exe` line; prune
loop word-split (`x\n..`, `-x`, `v0 v2`); uninstall left the host's
`%LOCALAPPDATA%` dir; install accepted 2 segments where uninstall demanded
3; bare `powershell.exe` in `Exec`. Test-engineer killed an EPIPE flake in
the harness and bounded child waits (60 s) so a wedged `sh` cannot hang
`npm test`; hostile tarballs (`..`, absolute, symlink members) proven
contained by GNU tar defaults.

## Open

Backlog "Installer leftovers": live-check TOCTOU (re-check runtime.json
inside the const script), symlinked app dir disables the live guard,
untested failure codes 21/22/29/30, `.iss` never compiled outside CI.
Windows-only verification list lives in the phase-B developer report and
`installer/README.md`. Next: phase C (release workflow with `bundle` +
`installer` jobs, README) → phase D scrub → flip.
