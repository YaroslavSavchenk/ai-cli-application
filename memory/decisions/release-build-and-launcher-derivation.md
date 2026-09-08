---
type: decision
created: 2026-09-08
updated: 2026-09-08
tags: [release, ci, github-actions, launcher, distribution, docs]
---
# Release build on GitHub Actions; launcher derives its config from its own location

**Status:** decided (2026-09-08, user's go — "continue werken aan github
build, zodat andere mensen dit ook kunnen downloaden"). Extends
[[native-webview2-host]] and [[thin-windows-launcher]]; changes nothing about
how the app runs ([[web-app-inside-wsl]], [[detached-backend]],
[[auto-port-discovery]] all stand).

## What was decided

- **The app is never packaged.** Installing = `git clone` inside WSL +
  `npm install` + `npm run build` (README → Install). The ONLY published
  artifact is the Windows-side native host window: `AiSessionManagerHost-win-x64.zip`
  (the exe + the three WebView2 DLLs, flat at the zip root) beside a
  `sha256sum`-compatible `SHA256SUMS.txt`, both attached to a GitHub Release.
  Extract into `launcher/host/build/` — the launcher stages a local copy and
  `Unblock-File`s it, so the download path equals the build-it-yourself path.
- **`release.yml`** runs on a `v*` tag push: ubuntu `check` (`npm ci`,
  typecheck, vite build, `make-icon.mjs --check`), windows `host` (the
  existing `build-host.ps1`, unchanged — in-box csc, hash-pinned WebView2
  SDK), then `release` publishes with the preinstalled `gh` CLI
  (`--verify-tag`, `--generate-notes` under a fixed install blurb carrying
  the zip hash). Idempotent: a re-run `--clobber`s the assets AND rewrites
  the notes, because csc + Compress-Archive are not deterministic and a
  stale hash in the body would look like tampering. `workflow_dispatch`
  builds the same artifact; it publishes only when dispatched on a `v*` tag.
- **`ci.yml`** runs typecheck + build + icon check + `npm test` on push to
  `main` and every PR. First run proved the suite passes on ubuntu-latest.
- **Workflow hygiene:** third-party actions pinned to full commit SHAs
  (checkout v7.0.1, setup-node v7.0.0, upload-artifact v7.0.1,
  download-artifact v8.0.1), top-level `permissions: {}`, `contents: write`
  only on the publish job, `persist-credentials: false` on every checkout
  (`npm ci` runs node-pty's install script), no `${{ }}` inside `run:`.
- **Version = the tag.** `package.json` has no version field. First release:
  `v0.1.0` (2026-09-08).
- **Launcher self-locates.** `launcher/config-common.ps1` (dot-sourced by
  `launch.ps1` and `make-shortcut.ps1`) derives distro + repo path from
  `$PSScriptRoot` = `\\wsl.localhost\<distro>\<linux path>\launcher`
  (`\\wsl$` too). Precedence: `AI_SM_DISTRO`/`AI_SM_REPO_PATH` → location →
  built-in defaults (only reachable when the folder is copied out of the
  repo). Every value still passes the same allow-list before any WSL command
  line; a derived-but-invalid value FAILS with a source-aware hint — never
  a fallback to the author's repo. `make-shortcut.ps1 -DryRun` prints the
  resolution without touching anything.
- **Docs:** README Install section for newcomers; node-pty ships NO
  linux-x64 prebuild, so `build-essential python3` is a prerequisite (the
  first draft claimed the opposite — caught by scope review).

## Rejected alternatives

- **Full app bundle zip (source + prebuilt `web/dist`)** — saves one
  `npm run build`; loses `.git`, which the update watch and boot banner
  read; a developer audience clones anyway.
- **Third-party release action** (`softprops/action-gh-release`) — `gh` is
  preinstalled and keeps the supply chain to GitHub-owned actions.
- **Gating the release on `npm test`** — the suite's CI behaviour was
  unproven at the time; `ci.yml` carries it. Revisit: add `npm test` to the
  release `check` job now that CI is green.
- **Code signing** — no certificate; the exe stays unsigned, SmartScreen
  note in both READMEs.
- **Launcher in the release zip** — the launcher must live in the repo to
  derive its config; the zip holds only the host build.

## Open (user's decision)

- **Repo visibility.** Private today: the release and the Install docs only
  work for collaborators. Going public also publishes the `memory/` vault,
  the author's home path in the launcher defaults, and git author emails.
- **One-click installer ("a real app, frontend + backend").** User's wish,
  2026-09-08, explicitly future — "right now it's good enough". Would
  bundle: WSL2 check, clone/unpack into the distro, `npm install`, host
  build, shortcut. Not scoped.
