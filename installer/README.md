# Windows installer (Inno Setup)

The Setup that makes this a normal Windows app: a wizard, a Start-Menu entry
with the right taskbar icon, an uninstaller — and, inside WSL, a
self-contained bundle that needs no Node, no git and no build tools.

It is **per-user and never elevates** (`PrivilegesRequired=lowest` with an
empty `PrivilegesRequiredOverridesAllowed`), it is **unsigned**, and it
**installs nothing third-party unless the user ticks it**.

## What is in this directory

| Path | Role |
| --- | --- |
| `ai-session-manager.iss` | the Setup script: wizard pages, `[Files]`, `[Icons]`, and Pascal that does nothing but call helpers |
| `helpers/helper-common.ps1` | shared prologue: locating `config-common.ps1`, the key=value result file, the `wsl.exe` runner, the launcher-config writer |
| `helpers/wsl-probe.ps1` | reads: is WSL 2 there, which distros, and per distro the user, home, glibc and whether Claude Code is present |
| `helpers/install-bundle.ps1` | unpacks the bundle inside the distro, swaps `current`, prunes, writes `launcher-config.json` + `install-info.txt` |
| `helpers/install-thirdparty.ps1` | one opt-in third-party install (today: Claude Code) |
| `helpers/uninstall-wsl.ps1` | removes the app directory inside the distro — only after the uninstaller's explicit yes |

Nothing binary is committed. The payload (`payload/`) is git-ignored and is
assembled by the `windows setup` job of `.github/workflows/release.yml`, which
downloads the artifacts of the `linux bundle (x64)` job
(`ai-session-manager-linux-x64.tar.gz`, plus its `.sha256` and a `VERSION.txt`)
and the `native host (win-x64)` job (`AiSessionManagerHost-win-x64.zip`),
verifies the tarball's SHA-256, extracts the zip into `payload\host`, and runs
ISCC. Its own artifact is `AI-Session-Manager-Setup`
(`AI-Session-Manager-Setup-<version>.exe` + `.sha256`) — which is what a
`workflow_dispatch` run hands you when you want to test a Setup before a tag
exists.

**The rule this directory is built on:** the `.iss` holds the wizard, the files
and the icons; every decision, every parse and every `wsl.exe` call lives in a
PowerShell **5.1** helper (`pwsh` is not installed on a normal Windows PC) that
writes a `key=value` result file the Pascal reads back. That keeps the logic
testable from inside WSL — see `tests/installer-helpers.test.ts`, which runs
every helper with `-DryRun` and runs their constant shell scripts under a real
`sh` — and keeps the Pascal small enough to review by eye, which matters
because ISCC only exists on Windows.

## Building it

ISCC (Inno Setup 6) ships on GitHub's `windows-latest` image at
`C:\Program Files (x86)\Inno Setup 6\ISCC.exe`. The `windows setup` job
checks that path first and fails the job loudly if it is gone, rather than
publishing a release without the one asset that IS the app.

    ISCC.exe /DAppVersion=v0.2.0 ^
             /DBundleTar=payload\ai-session-manager-linux-x64.tar.gz ^
             /DHostDir=payload\host ^
             installer\ai-session-manager.iss

| Define | Meaning | Default |
| --- | --- | --- |
| `AppVersion` | the release version; also the directory name inside WSL and the Setup's own filename | `0.0.0-dev` |
| `BundleTar` | the Linux bundle built by `scripts/build-bundle.sh` | `payload\ai-session-manager-linux-x64.tar.gz` |
| `HostDir` | directory holding the four native-host files (unzip `AiSessionManagerHost-win-x64.zip` there) | `payload\host` |
| `LauncherDir` | where the launcher scripts live | `..\launcher` |
| `OutDir` | where the Setup is written | `..\dist-release` |

Output: `dist-release\AI-Session-Manager-Setup-<AppVersion>.exe`.

So the payload a build needs is exactly:

    installer/payload/ai-session-manager-linux-x64.tar.gz    (scripts/build-bundle.sh)
    installer/payload/host/AiSessionManagerHost.exe          (launcher/build-host.ps1, or the release zip)
    installer/payload/host/Microsoft.Web.WebView2.Core.dll
    installer/payload/host/Microsoft.Web.WebView2.WinForms.dll
    installer/payload/host/WebView2Loader.dll

`AppVersion` must be the same string as the bundle's top-level directory and
its `bundle.json` version, or the install refuses with
`the archive does not contain <version>/bundle.json`. In CI that string is
computed once, in the bundle job (the tag name, or `0.0.0-dev+<short sha>` off
a tag), travels to the Setup in `VERSION.txt` beside the tarball, and is
re-checked against the same charset rule before it reaches an ISCC command
line.

## What a user ends up with

Windows, `%LOCALAPPDATA%\Programs\AI Session Manager\`:

    launch.ps1  launch.cmd  launch-silent.vbs  config-common.ps1
    make-shortcut.ps1  app.ico
    helpers\*.ps1
    host\AiSessionManagerHost.exe + 3 WebView2 DLLs
    launcher-config.json      written after the install: distro + <appdir>/current
    install-info.txt          written after the install: distro, appDir, version

Inside the chosen distro, `<appdir>` (default `~/.ai-session-manager/app`):

    <version>/…      the bundle (own Node runtime, backend, node_modules, web/dist)
    current -> <version>

The data directory beside it (`~/.ai-session-manager/`: `runtime.json`,
`history.json`, `prefs.json`, `projects.json`, `github.json`, `server.log`) is
**never** written or removed by the installer or the uninstaller.

The shortcuts run `wscript.exe "{app}\launch-silent.vbs"` and carry
`AppUserModelID = AiSessionManager` — byte-identical to what the native host
window sets, which is what makes the taskbar show `app.ico` instead of a
generic icon. `tests/installer-script.test.ts` pins that the three places
agree.

## The wizard

The Windows destination is fixed (`DisableDirPage=yes`) so the wizard is
exactly these six pages; `/DIR="D:\somewhere"` on the command line still moves
it.

1. **Welcome.**
2. **WSL check** (`wsl-probe.ps1`): no WSL, no distribution, or nothing on
   WSL 2 → the page explains and Next stays refused, with the exact
   `wsl --install` line to run in an **admin** PowerShell plus a reboot.
   Setup never runs it itself: that needs elevation.
3. **Distribution** — the WSL 2 distros whose names are usable, default
   preselected.
4. **Folder inside Linux** — default `<home>/.ai-session-manager/app`,
   validated by `install-bundle.ps1 -DryRun`, i.e. by the very code that will
   do the install (absolute, no spaces or metacharacters, no `.`/`..`
   segment, must end in `/app`, at least three segments deep - the same rule
   the uninstaller enforces, so anything installed can also be removed).
5. **Optional extras** — shown only when something is actually missing; every
   box is off; the exact command and the host it downloads from are on the
   page. Today that is Claude Code via Anthropic's official
   `curl -fsSL https://claude.ai/install.sh | bash` from `claude.ai`. The
   WebView2 bootstrapper is deliberately **not** offered (the Edge `--app`
   fallback covers a missing runtime).
6. **Ready** — names both destinations, says whether anything third-party
   will be installed, and that the app may stay open.

Then: unpack, `current` swap, prune, config files, optional extras.

### Upgrades

Same `AppId`, so a newer Setup upgrades in place. `CloseApplications=no`: the
app may keep running, because the backend lives inside WSL and the running
process keeps using its own version directory (`runtime.json.appDir`), which
the installer refuses to prune. Afterwards the app reports
`a new version is installed` and its **Restart backend** button moves onto the
new `current`. Retention is `current` + one previous version + whatever a live
backend is using.

### Uninstall

Windows side always. Then one question, **defaulting to No**: "Also remove the
app files inside `<distro>` at `<appdir>`?" — a yes first stops a running
backend (`launch.ps1 -Stop`, which ends open sessions; they stay in the
history) and then runs `uninstall-wsl.ps1`, which refuses anything that is not
an absolute, allow-listed path ending in `/app`, at least three segments deep,
containing at least one `<version>/bundle.json`. Your projects, history and
settings are untouched either way.

## Testing the helpers from WSL

Every helper is safe to run by hand with `-DryRun`: it prints the exact
`wsl.exe` command line it would run and touches nothing.

    powershell.exe -NoProfile -ExecutionPolicy Bypass \
      -File installer/helpers/wsl-probe.ps1 -ResultFile /tmp/r.txt \
      -ListFile tests/fixtures/wsl-list-verbose-utf16le.txt

    powershell.exe -NoProfile -ExecutionPolicy Bypass \
      -File installer/helpers/install-bundle.ps1 -DryRun \
      -Distro Ubuntu-24.04 -AppDir /home/you/.ai-session-manager/app \
      -Version v0.2.0 -Tarball none -ResultFile /tmp/r.txt

    powershell.exe -NoProfile -ExecutionPolicy Bypass \
      -File installer/helpers/uninstall-wsl.ps1 -DryRun \
      -Distro Ubuntu-24.04 -AppDir /home/you/.ai-session-manager/app \
      -ResultFile /tmp/r.txt

The automated versions live in `tests/installer-helpers.test.ts` (helper
behaviour, including the constant shell scripts under a real `sh`) and
`tests/installer-script.test.ts` (the `.iss` text: the GUID, no elevation, the
AUMID equality, the tarball's `deleteafterinstall`, the consent copy).
`npm test` runs both; the PowerShell half skips itself where there is no
Windows side.

## Two things that bite, written down

**`wsl.exe -- <words>` is not `execvp`.** Without `--exec`, wsl.exe re-joins
its arguments into one line and hands it to the distro's **default shell**,
which expands it a second time: `$1`/`$2` arrive empty and `$(...)` runs in
the wrong shell. Every helper uses `wsl.exe -d <distro> --exec …`, which
passes the argv straight through (verified 2026-09-08 on WSL 2 / Ubuntu
24.04).

**No double quote may appear in a constant shell script.** PowerShell 5.1 runs
on .NET Framework 4.8, which has no `ProcessStartInfo.ArgumentList`, so the
command line is built by hand and the script is delimited by `"`. Single
quotes are fine (they reach `sh` untouched). That is why the bundle's
self-test is spelled `node -e 'require(process.argv[1])' node-pty` — the
module name travels as an argument instead of needing quotes around it. The
whole safety argument rests on that plus the allow-list in
`launcher/config-common.ps1`: every value that reaches a command line has no
space, quote or metacharacter in it, so nothing needs escaping.

## SmartScreen

The Setup is not code-signed (a certificate costs money and an identity
check). Windows will show "Windows protected your PC" on first run: **More
info → Run anyway**. Do that only for a Setup downloaded from this project's
own releases page, ideally after checking its SHA-256 against
`SHA256SUMS.txt`.
