---
type: log
created: 2026-09-09
updated: 2026-09-09
tags: [log, installer, release, ci, github-actions, go-public]
---
# 2026-09-09 — installer phases C (CI/release + README) and D (go-public scrub) SHIPPED

Follows [[2026-09-09-installer-phase-b]] under [[installer-and-self-contained-bundle]];
extends [[release-build-and-launcher-derivation]].

## What landed

- **`release.yml`** now has five jobs: `verify` (reusable), `host` (windows,
  host zip), `bundle` (ubuntu-22.04; computes the version ONCE into
  `VERSION.txt` — the tag, or `0.0.0-dev+<sha>` off-tag — and builds the
  tarball with the smoke test), `installer` (windows, `needs: [host,
  bundle]`; lays out `installer/payload/`, refuses loudly when `ISCC.exe` is
  missing, compiles `AI-Session-Manager-Setup-<v>.exe`), `release` (`needs:
  [verify, host, bundle, installer]`; re-hashes every download into ONE
  `SHA256SUMS.txt`, `sha256sum -c`, `gh release create --verify-tag` with four
  assets, notes lead with the Setup). `workflow_dispatch` builds everything
  and publishes nothing off-tag — that is how the user gets a Setup.exe to
  test on Windows before v0.2.0 is tagged.
- **`verify.yml`** gains `verify / linux bundle` (same build as the release,
  `actions/cache` SHA-pinned on `build/node-cache`); `check`/`test` now run
  on the exact `NODE_VERSION` that gets bundled (one definition per file,
  equal across files, pinned by test).
- **README** rewritten: Install = download the Setup → wizard; the old five
  steps live under "From source (developers)"; Updating / Uninstalling /
  SmartScreen for both exes; Release process section.
- **Go-public scrub**: 94 author-path lines in 18 files → 0 (`/home/you`,
  UNC forms, mock labels); `tests/no-author-paths.test.ts` guards tracked
  files (both separators, escaped forms, Windows user dir, surname); secrets
  sweep clean (only synthetic `ghp_…` fixtures); `.gitignore` verified for
  every scratch/config file.
- Suite 1026 → ~1051+.

## Review

Doctrine PASS (SHA-pinned GitHub-owned actions, `permissions: {}`,
`contents: write` only on `release`, `persist-credentials: false`, no
`${{ }}` in `run:`, `--verify-tag`, idempotent re-run, dispatch never
publishes off-tag, cache poisoning impossible because the sums file is
re-fetched every run and release.yml has no cache step). Fixes: cache
bumped to v6.1.0; guard regex widened to backslash/escaped forms; `\z` in
the PowerShell version gate; full version regex in the release job;
`--verify-tag`/`--clobber`/notes-refresh pinned by test and the publish
`if:` assertion scoped to the release job; README wizard list (desktop
shortcut task page, distro page always shown, `/app` rule, glibc floor is
the bundle's only). Test-engineer measured the YAML tests' brittleness (6
harmless reformats → red) — accepted as the file's stated design.

## Facts worth keeping

- Git history still carries the author's e-mail (140 commits) and, in 13
  commits, the old home path; the user chose not to rewrite (`v0.1.0`
  stays valid). The guard covers HEAD only.
- `actions/cache` v4.3.0 = `0057852b…`, v6.1.0 = `55cc8345…` (both verified
  via `gh api …/git/ref/tags/`).

## CI reality check (same day)

The first two `workflow_dispatch` runs died in ISCC, both in `[Code]`
comments/literals the suite could not see: a continuation line opening
with `#13#10` (ISPP directive) and `({tmp}, {app})` inside a `{ … }`
comment (closed it early → `'BEGIN' expected`). Both fixed in minutes,
both pinned by tests ([[inno-setup-ispp-char-literals]]). Third run: all
jobs green, publish correctly skipped off-tag, artifact
`AI-Session-Manager-Setup-0.0.0-dev+08709f5.exe` (62 MB, SHA
`f9594e12…`) — the user's Windows test build (run 34354085724). Repo
flipped to PUBLIC at 13:05Z; releases page live.

## Next

User tests the artifact on Windows (checklist in `memory/BACKLOG.md`,
"Owed on the Windows side") → fixes if any → `npm run release -- v0.2.0`.
