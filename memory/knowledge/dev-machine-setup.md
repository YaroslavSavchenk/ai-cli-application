---
type: knowledge
created: 2026-09-15
updated: 2026-09-15
tags: [environment, wsl, node, tooling, launcher]
---
# Dev machine setup — what a fresh WSL clone of this repo needs (2026-09-15)

**Situation (2026-09-15):** the user opened a fresh WSL (`Ubuntu-24.04`)
where the repo had been cloned minutes earlier (`~/projects/ai-cli-application`,
no `node_modules`, no `web/dist`), with the *installed* app v0.3.2 running
from `~/.ai-session-manager/app/current` (its own bundled node 24.20.0) and
the Claude session itself running inside that app. PATH node was v18,
nvm's default v20 — `package.json` engines demand `>=24`, and `node --test`
on `.ts` files needs 22.6+.

## What was needed / done

- **Node 24 via nvm**: `nvm install 24 && nvm alias default 24`
  (v24.21.0). The launcher's `start-backend.sh` sources nvm itself when the
  PATH node is < 24, so a dev window works without touching `/usr/bin/node`.
  `npm ci` must run under 24 — node-pty 1.1.0 has no linux prebuild and is
  compiled against the running node's ABI (an install under 18 loads only
  under 18). npm 11 prints an `install-scripts` warning for node-pty; the
  script still ran (`build/Release/pty.node` present, `require` OK).
- **`npm run build`** — `web/dist` is gitignored; without it
  `tests/buildinfo.test.ts` skips one test and the served UI is 404.
- **Playwright Chromium** (user-level, no sudo):
  `npx --yes playwright@1.58.2 install chromium` →
  `~/.cache/ms-playwright/chromium-1208` — the verify-terminal CDP driver
  (see [[BACKLOG]], persist-the-driver item). Its runtime libs
  `libnss3 libnspr4 libatk-bridge2.0-0` are NOT installed here (earlier
  sessions unpacked them into a scratch dir; with sudo, `apt install`).
- **Needs sudo (the user runs it):** `jq` (`scripts/build-bundle.sh`,
  `scripts/release.sh`, `release.yml`), `shellcheck`, `htop`
  (verify-terminal checks 3/4; `top` is the fallback), `unzip`, and the
  three Chromium libs above. Present already: git, gh (logged in), curl,
  python3, make/gcc/g++, tmux, vim, lsof, `powershell.exe` interop.
- Verified on this machine: typecheck clean, suite 1745 (1744 pass,
  1 skipped in the full run = the buildinfo dist check, which passes alone
  — dist was built; treat a repeat as a race to look at), scratch backend
  boots at HEAD and serves `web/dist` (200), clean SIGTERM exit.

## Dev window vs the installed app — same data dir

`launch.ps1` and `start-backend.sh` default to `~/.ai-session-manager`,
the same data dir the installed v0.3.2 uses. Starting the repo launcher
while the installed backend is healthy just **reattaches to the installed
backend** (health check wins) — the dev build never starts. For a dev
window beside the installed app: set `AI_SM_DATA_DIR` to another dir that
matches the launcher pattern (`~/.ai-session-manager-dev`), then run
`\\wsl.localhost\<distro>\home\you\projects\ai-cli-application\launcher\launch.cmd`.
The repo has no built native host (`launcher/host/build/` needs
`build-host.ps1` on Windows), so the dev window opens as the Edge `--app`
fallback — fine for a look check, DWM caption colours excepted.
