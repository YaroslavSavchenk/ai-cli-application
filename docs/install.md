# Install, update, uninstall

Download **`AI-Session-Manager-Setup-<version>.exe`** from the
[Releases page](https://github.com/YaroslavSavchenk/ai-cli-application/releases)
and run it. That is the install. The Setup carries the whole app — backend,
frontend and its own Node runtime — puts it inside your WSL2 Linux
distribution, and leaves an **AI Session Manager** shortcut on the Desktop and
in the Start Menu. It installs for your user only, it never asks for
administrator rights, and it installs nothing else unless you tick it.

Running from a clone instead: [development.md](development.md).

## Before you start

- **Windows 10 or 11 with WSL2, and a Linux distribution.** If either is
  missing, the Setup says so, shows the one command that fixes it —
  `wsl --install`, in a PowerShell started as administrator — and stops. It
  never elevates itself and never installs a distribution behind your back.
- **A distribution with glibc 2.35 or newer**: Ubuntu 22.04 and later, Debian
  12 and later. An older one is refused by name, with the version it has and
  the version it needs.
- **Claude Code inside that distribution**, if you want Claude sessions. The
  Setup offers to install it for you — switched off by default, on a page that
  shows the exact command and the site it comes from. Resuming a specific past
  conversation needs Claude Code 2.1.263 or newer.
- **The other agents, if you want them**: Codex, Gemini CLI and Grok, each
  installed by you inside the distribution. The Setup never installs these, and
  the New session dialog shows a card as "Not installed" until the backend
  finds its executable.
- Plain terminal sessions need nothing extra: Bash comes with the
  distribution, PowerShell and Command Prompt come through WSL interop. The Zsh
  card needs `zsh` installed in the distribution. A Command Prompt session
  opens in the project folder — on a Linux path the prompt shows a temporary
  mapped drive; a project path with characters outside `A-Za-z0-9._-` opens in
  the Windows default directory instead.

Nothing else: no Node, no git and no build tools inside the distribution — the
Setup brings the runtime the app runs on. On the Windows side the app window
uses the WebView2 runtime that comes with Microsoft Edge, so a current Windows
already has it; without it the launcher quietly falls back to an Edge window.

## Running the Setup

The exe is not code-signed, so Windows may greet it with "Windows protected
your PC": choose **More info → Run anyway** (the reasoning is under
[Worth knowing](#worth-knowing)).

The wizard then asks, in order:

1. **the WSL check** — is WSL 2 there, is there a distribution, is its glibc
   new enough. This is where it stops if something is missing, with the exact
   command that fixes it;
2. **which distribution** to install into — always asked, also when there is
   only one, so you can see which one it picked;
3. **which folder inside Linux** — the default is `.ai-session-manager/app` in
   your Linux home directory. Whatever you type must end in `/app` with at
   least two folders above it (`/home/you/.ai-session-manager/app`), and may
   use only letters, digits, `.`, `_`, `-` and `/` — no spaces, no quotes. The
   uninstaller relies on that shape, so the wizard refuses anything else;
4. **optional extras** — the consent page. It appears only when something is
   actually missing, every box starts off, and each entry names the exact
   command and the site it downloads from. Today the only entry is Claude Code.
   Nothing third-party is ever installed silently;
5. **shortcuts** — one tick box, "Create a desktop shortcut", on by default.
   The Start Menu entry is always made;
6. **ready** — it names both destinations, the Windows one and the Linux one,
   and says whether anything extra will be installed.

Then it unpacks and is done. Double-click **AI Session Manager**. The first
launch after a Windows reboot has to start the WSL virtual machine first:
expect **10–30 seconds where nothing visible happens**. Later launches take a
second or two. No console window ever appears; if a launch fails you get an
error box telling you what went wrong.

Your projects, session history and settings live inside Linux in
`~/.ai-session-manager/`, next to the app but separate from it, and no install,
upgrade or uninstall ever touches them. What is in there: [app-data.md](app-data.md).

## Running it

Double-click the "AI Session Manager" icon. No console appears; the launcher
attaches to a running backend (or starts one detached inside WSL), waits for
it to become healthy, and opens the UI in the native WebView2 host window when
that host is present and the WebView2 runtime is installed — otherwise an Edge
`--app` window, then the default browser. `launcher/launch.cmd` is the
visible/debug path with the same logic. Configuration, switches (`-Silent`,
`-Status`, `-Stop`, `-NoBrowser`), pinning, cold-boot expectations, and
troubleshooting: see [launcher/README.md](../launcher/README.md).

## Updating

An installed app checks the Releases page for a newer version by itself
(shortly after it starts, then every hour; one anonymous request to GitHub)
and, when there is one, shows a notice and an `Update` mark in the top bar.
`Update` downloads the new Setup, checks it against the release's
`SHA256SUMS.txt`, runs it silently and restarts the app on the new version.
**Settings → Background service** has `Check for updates` for asking right
away, and `Download it yourself` opens the Releases page when the app's own
route failed. A clone never checks for updates.

By hand: download the newer `AI-Session-Manager-Setup-<version>.exe` and run
it. It upgrades in place, keeps everything, and you may leave the app open
while it runs. Afterwards the app notices the new version by itself and offers
the restart that moves it there — through the notice in the window, or under
**Settings → Background service → Restart service**.

Either way, sessions that are open at that moment keep running: the same tabs,
panes and scrollback come back, and a Claude that was mid-turn keeps working.
In the rare case they cannot be kept (the part of the app that holds them
changed in a way the new version cannot take over), the confirmation says so
first and offers **Restart anyway**; the sessions then end and keep their
place in the Sessions panel's **Earlier** list, where they can be resumed.

The first release that brings this cannot do it for its own install: the
version you update FROM runs that update, so that one time the open sessions
end as before. From the next update on they stay open.

How the restart itself works: [restart-and-recovery.md](restart-and-recovery.md).

## Uninstalling

Windows Settings → **Apps** → "AI Session Manager" → Uninstall, like any other
app. It asks one question — whether to also remove the app files inside your
Linux distribution — and that one defaults to No. Either way your projects,
session history and settings stay: nothing in `~/.ai-session-manager/` is
removed.

## Worth knowing

- **Neither downloadable exe is code-signed.** Both the Setup and the native
  window inside it are built by GitHub Actions from the source of the tag they
  are published under — the WebView2 SDK verified by SHA-256, the bundled Node
  runtime verified against nodejs.org's own checksums during that build — but
  there is no certificate on either file. The first time you run one, Windows
  SmartScreen may say "Windows protected your PC": choose **More info → Run
  anyway**. Every release lists the SHA-256 of every download, so you can check
  what you got before you run it (`Get-FileHash <file> -Algorithm SHA256` in
  PowerShell prints it in uppercase, the published list is lowercase — a
  difference in case is not a mismatch).
- **Everything runs locally.** The backend binds `127.0.0.1` on a port it picks
  itself and is reachable only from your own machine; the window is locked to
  that address. Nothing about your sessions leaves the machine through this
  app.
- **The app never installs anything behind your back.** The Setup asks before
  it installs anything third-party, and it is the only part that installs
  anything at all: the app itself launches the CLIs you already have, and it
  will refuse to restart rather than run `npm install` for you.
- **Files you drop into the app land in WSL.** Drag files or folders from
  Explorer onto a folder in the Files panel or onto a terminal pane, or paste
  them with files on the clipboard: they are copied under that folder, up to
  200 dropped items, 50 MB per file, 2000 files and 1 GB per drop, with one
  question per drop when names clash. If the app dies in the middle of a copy,
  an in-flight `.upload-….part` file may be left behind — it is safe to
  delete. `Copy` in a row's menu puts that file or folder on the Windows
  clipboard (native window only), ready to paste in Explorer. Several rows can
  be selected at once (ctrl-click, shift-click) and deleted for good — the app
  asks once, and nothing goes to a recycle bin.
- **When WSL itself stops** (out of memory, `wsl --shutdown`), the sessions
  cannot survive it; the app says why and brings them back by resuming them —
  see [restart-and-recovery.md](restart-and-recovery.md#after-wsl-stops).
