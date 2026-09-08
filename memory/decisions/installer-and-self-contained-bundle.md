---
type: decision
created: 2026-09-08
updated: 2026-09-08
tags: [distribution, installer, release, launcher, packaging]
---
# One installer, one self-contained bundle: the app becomes a product

**Status:** decided 2026-09-08 (user), IN PROGRESS. Supersedes the "the app
itself is never packaged" clause of [[release-build-and-launcher-derivation]]
(the host-zip release and the CI gate from [[2026-09-08-cicd-gate]] stand
and are reused). Builds on [[thin-windows-launcher]] and
[[native-webview2-host]]; changes nothing about [[web-app-inside-wsl]],
[[auto-port-discovery]], [[lifecycle-bound-backend]] or
[[restart-preflight-standby]] except the installed-mode branches listed
below.

## What the user asked

2026-09-08: "het is tijd om hiervan een app te maken, met een frontend en
backend, zodat andere mensen dit app makkelijk kunnen gebruiken." The
2026-09-08-morning wish (explicitly FUTURE then) is now the work. Four
choices were put to the user, all answered the same day:

1. **WSL side = self-contained bundle.** CI builds
   `ai-session-manager-linux-x64.tar.gz`: pinned official Node 24 linux-x64
   runtime (SHA256-verified against nodejs.org `SHASUMS256.txt`), `server/`,
   `shared/`, `package.json`, production `node_modules` with node-pty
   compiled on **ubuntu-22.04** (older glibc → runs on 22.04 and 24.04),
   built `web/dist`, `launcher/start-backend.sh`, a version marker. End users
   need **no Node, no git, no build tools** in WSL. The user added a rider:
   **"bij het downloaden moeten mensen toestemming geven om andere benodigde
   apps te installeren"** → every third-party install the installer offers
   (Claude Code inside the distro, anything else later) sits behind an
   explicit opt-in on a consent page; nothing third-party is ever installed
   silently. (Rejected: installer that clones + runs `npm install` — still
   needs Node 24 + build-essential + sudo at the user's side; half a product.)
2. **Repo goes public.** Phase D lists what becomes visible (the `memory/`
   vault, the author's home path in the launcher defaults, git author
   emails); the user flips the switch. (Rejected: a second public
   releases-only repo — extra CI plumbing to keep source private for no
   stated reason.)
3. **Inno Setup, unsigned, per-user.** Wizard, no admin, uninstaller; built
   on the windows runner (ISCC ships on GitHub's images). SmartScreen shows
   "Run anyway" once — accepted. (Rejected for now: code signing — Azure
   Trusted Signing or an OV certificate cost money and identity checks;
   revisit when there are users. Rejected: `irm | iex` bootstrap — no
   wizard, no uninstaller, does not read as an app.)
4. **No WSL2 / no distro → explain and stop.** The installer prints the
   `wsl --install` instruction and why it needs admin + a reboot, and asks to
   be re-run. (Rejected: running `wsl --install` ourselves — elevation,
   reboot orchestration, Hyper-V/BIOS failure paths we cannot test.)

## Working layout (orchestrator's defaults, adjustable by the phases)

- WSL: `~/.ai-session-manager/app/<version>/` + `current` symlink; the data
  dir `~/.ai-session-manager/` (runtime.json, history, prefs, server.log) is
  never written by install or uninstall.
- Windows: `%LOCALAPPDATA%\Programs\AI Session Manager\` — launcher scripts,
  `app.ico`, host exe + its three sibling files, and an installer-written
  launcher config naming distro + WSL app path. `config-common.ps1`
  precedence: env → config file beside the scripts → UNC-derived → defaults;
  every value still passes the allow-list gate.
- Backend **installed mode** (version marker present): banner shows the
  bundle version instead of a commit; `dependencies changed` skipped (no
  lockfile stamp in a packaged tree); the restart preflight serves the
  bundled `web/dist` instead of rebuilding (no vite in the bundle);
  `update.available` = `current` resolves to a different dir than the
  running process; the handoff starts the new `current`.
- `start-backend.sh` prefers `<app>/node/bin/node`, falls back to PATH/nvm
  for developer clones.
- v1 updates: run the newer Setup.exe (upgrade in place, keep data) → the
  in-app toast offers the restart. In-app update *checking* (outbound
  network from a localhost app) is out of scope; a "Check for updates" link
  to the Releases page through the sanctioned browser exit suffices.
- Uninstall: Windows side always; the WSL `app/` dir only via opt-in;
  never the data dir.
- Release assets: `AiSessionManager-Setup-<version>.exe`, the bundle
  tar.gz, the host zip, `SHA256SUMS.txt`. Version = tag, as before.

## Phases

A backend installed-mode + `scripts/build-bundle.sh` + start script ·
B launcher config + Inno Setup installer + helpers · C release workflow +
README (Install = Setup.exe; "From source" = today's steps) + UI copy ·
D go-public prep. Each phase = one dev-flow round, committed on land.
