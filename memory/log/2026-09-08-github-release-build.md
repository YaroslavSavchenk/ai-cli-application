---
type: log
created: 2026-09-08
updated: 2026-09-08
tags: [release, ci, github-actions, launcher, docs, dev-flow]
---
# 2026-09-08 (evening) — GitHub release build SHIPPED (v0.1.0)

## What the user asked (Dutch)

"continue werken aan github build, zodat andere mensen dit ook kunnen
downloaden" — the go on the queued idea from
[[2026-09-08-login-and-terminal]]. Decision: [[release-build-and-launcher-derivation]].

## Built (dev-flow, 1 fix cycle)

Two developers in parallel: generalist-dev (`.github/workflows/release.yml`,
`ci.yml`, README Install + Release process) and wsl-launcher
(`launcher/config-common.ps1`, launch.ps1 + make-shortcut.ps1 derive
distro/repo from `$PSScriptRoot`, `-DryRun`, launcher README). Backend was
LIVE the whole time (pid 323357, port 44313) — every agent ran `-Status`
only; nothing restarted.

Review round (scope + security + test-engineer): 12 findings, one HIGH —
README claimed `npm install` compiles nothing, but node-pty 1.1.0 has no
linux-x64 prebuild (`node_modules/node-pty/prebuilds/` = darwin + win32
only), so newcomers need `build-essential python3`. MED: release re-run
left a stale hash in the body (→ `gh release edit --notes-file`), the
"set `AI_SM_REPO_PATH`" hint was a dead end (same allow-list), scope-doc
drift. LOW: `persist-credentials`, `sha256sum -c` without
`--ignore-missing` fails on a 5-line sums file, placeholder conventions,
dispatch-on-tag overclaim. Re-review: clean. Orchestrator took four notes
inline (stale comment, not-installed-distro hint said "character set",
`<distro>\<your clone>` everywhere, `/mnt/c` locator).

test-engineer added `tests/launcher-config.test.ts` (28 tests, real
`powershell.exe` interop, skips without it). Suite 850 → 878.

## Shipped + proven

Commit `7d0d17d`, tag `v0.1.0`. First real run: release workflow green on
all three jobs (check / native host win-x64 / publish), ~2 min. Downloaded
the assets back: `sha256sum -c --ignore-missing` OK, 4 files flat in the
zip, body hash == sums file. CI run: typecheck+build green; `backend test suite` on
ubuntu-latest green in 3.5 min — 850 pass, 0 fail, 28 skipped (the
launcher interop tests, no `powershell.exe` there). node-pty compiled from
source on the runner without trouble.

## Lessons

- `WSLENV=VAR/u` does NOT pass a variable WSL → Win32; `/w` does (the
  brief said `/u`; the agent proved it wrong).
- `Add-Type` in Windows PowerShell 5.1 writes CodeDom temp files — a
  "dry run" that compiles a helper first is not literally dry; order it
  after the early exit.
- `gh release download` needs `-R owner/repo` outside a git checkout.
- Reviewers should verify "ships prebuilds" claims against
  `node_modules/<pkg>/prebuilds/` — the doc author assumed.

## Open

- **Repo is PRIVATE** → nobody outside can download yet. User decision.
- Windows-side checks: re-run `make-shortcut.ps1` (new script), double-click
  launch, `launch.cmd -Status` shows the `Config:` line; download the release
  zip into `launcher/host/build/` on a fresh clone and confirm SmartScreen
  stays quiet (README claims it normally does).
- Consider `npm test` in the release `check` job now that CI is proven;
  Dependabot for the SHA-pinned actions; `npm audit fix` (postcss, dev-only).
