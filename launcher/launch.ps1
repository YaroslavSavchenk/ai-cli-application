<#
launch.ps1 - Windows-side launcher for the AI CLI Session Manager
(backend lives inside WSL2; see .claude/PROJECT-SCOPE.md in the repo).

Usage:
  launch.ps1              attach-or-start the backend, then open the UI
                          (native WebView2 host if built + runtime present;
                          Edge --app window, then default browser, as fallbacks)
  launch.ps1 -NoBrowser   attach-or-start, but do not open any UI
  launch.ps1 -Status      report backend state (runtime.json + health)
  launch.ps1 -Stop        immediate stop, skipping the presence grace
                          (SIGTERM to the pid in runtime.json)
  launch.ps1 -Silent      windowless mode (used by launch-silent.vbs): on any
                          failure, surface the error as a native message box
                          instead of relying on a console nobody can see.
                          Success shows nothing until the app window opens.

How it works:
  - The backend auto-picks its port (never hardcode one) and publishes a
    discovery file inside WSL: ~/.ai-session-manager/runtime.json with
    { port, token, pid, startedAt, appDir }. This script reads it via
    `wsl.exe cat` and health-checks http://127.0.0.1:<port>/health.
    ALWAYS 127.0.0.1, never `localhost`: the server binds IPv4 only and
    `localhost` may resolve to ::1 and fail.
  - Healthy -> open the UI. File absent or stale (dead pid / failed health)
    -> start fresh. The backend is started DETACHED (setsid, see
    start-backend.sh) so it never dies with this launcher or its wsl.exe
    calls. Its lifetime is bound to UI presence, not to any process here:
    ~30 s after the last app window closes (or ~120 s if no window ever
    connects) the backend ends all sessions, removes runtime.json, and
    exits on its own. See memory/decisions/lifecycle-bound-backend.md.
  - Cold WSL boot adds seconds; after starting we poll file + health for up
    to $StartTimeoutSec seconds with progress output.
  - runtime.json remains on SIGKILL/crash by design - the health check, not
    the file, decides the truth. Stale file means start fresh, not error.

Config: the distro and the app/repo path come from (highest first) the
AI_SM_DISTRO / AI_SM_REPO_PATH environment variables, launcher-config.json
next to this script (written by the Windows Setup), or derivation from this
script's own location under the WSL share
(\\wsl.localhost\<distro>\<path>\launcher). There are no built-in defaults:
when none of the three states a value, the launcher says so and stops - it
never guesses a distro or someone else's clone. See config-common.ps1.

Injection safety: no client/runtime string is ever interpolated into a
shell or PowerShell command. The only strings that reach WSL command lines
are the config values below - whatever their source, including derivation
from the script's location, they pass the same strict allow-list patterns
before first use - and the pid from runtime.json (validated as an integer).

This script never runs `wsl.exe --shutdown`, `wsl.exe -t`, or anything else
that terminates the distro or WSL processes it did not start.
#>
[CmdletBinding()]
param(
    [switch]$Status,
    [switch]$Stop,
    [switch]$NoBrowser,
    [switch]$Silent
)

# =============================== Config ====================================
# Distro and app path normally need no editing. Precedence, highest first:
# AI_SM_DISTRO / AI_SM_REPO_PATH env vars -> launcher-config.json next to
# this script (written by the Windows Setup: the distro it installed into
# and <app>/current) -> derived from $PSScriptRoot, which under the WSL
# share states both (\\wsl.localhost\<distro>\<linux path>\launcher) ->
# the defaults below. See config-common.ps1.
# The defaults are EMPTY on purpose. A launcher that can resolve nothing
# (folder copied onto a plain Windows path, no config file, no env vars)
# must say so - a built-in default would start a backend for a repo that is
# not yours, in a distro you did not pick.
# These are the ONLY strings that ever reach a WSL command line, and they
# are validated below before first use, whatever their source.
# A configured distro that is not installed still auto-resolves by unique
# prefix (e.g. 'Ubuntu' finds a lone 'Ubuntu-22.04'), and a wrong/ambiguous
# name still gets the guided error listing what is installed.
$DefaultDistro   = ''
$DefaultRepoPath = ''
$DataDir = if ($env:AI_SM_DATA_DIR) { $env:AI_SM_DATA_DIR } else { '~/.ai-session-manager' }
# Seconds to wait for runtime.json + health after starting the backend
# (must absorb a cold WSL boot).
$StartTimeoutSec = 90
# ===========================================================================

function Show-ErrorBox([string]$Message) {
    # -Silent runs with no visible console (wscript.exe > hidden powershell),
    # so failures must surface as a native message box. Primary: the
    # WScript.Shell COM Popup - one call, no assembly load, and the
    # system-modal flag (0x1000) keeps the box on top even though our hidden
    # process has no foreground rights. Fallback: WinForms MessageBox.
    $text = "$Message`n`nFor console details, run launcher\launch.cmd from the repo."
    if ($env:AI_SM_MSGBOX_TEST -eq '1') {
        # Test hook for WSL-side verification: prove this code path runs
        # without popping a blocking dialog no automation can dismiss.
        Write-Host "MSGBOX-SUPPRESSED: $text"
        return
    }
    try {
        $sh = New-Object -ComObject WScript.Shell
        # 0 = wait forever, 16 = vbCritical, 4096 = vbSystemModal (topmost).
        [void]$sh.Popup($text, 0, 'AI Session Manager - launch failed', 16 + 4096)
    } catch {
        try {
            Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
            [void][System.Windows.Forms.MessageBox]::Show(
                $text, 'AI Session Manager - launch failed',
                [System.Windows.Forms.MessageBoxButtons]::OK,
                [System.Windows.Forms.MessageBoxIcon]::Error)
        } catch { }
    }
}

function Fail([string]$Message) {
    Write-Host "ERROR: $Message" -ForegroundColor Red
    if ($Silent) { Show-ErrorBox $Message }
    exit 1
}

function Show-WarningBox([string]$Message) {
    # Non-fatal counterpart of Show-ErrorBox for the silent path: the launch
    # continues, so the popup auto-dismisses after 15 s instead of waiting
    # forever. Same test hook as Show-ErrorBox.
    if ($env:AI_SM_MSGBOX_TEST -eq '1') {
        Write-Host "MSGBOX-SUPPRESSED-WARN: $Message"
        return
    }
    try {
        $sh = New-Object -ComObject WScript.Shell
        # 15 = auto-dismiss seconds, 48 = vbExclamation, 4096 = vbSystemModal.
        [void]$sh.Popup($Message, 15, 'AI Session Manager', 48 + 4096)
    } catch { }
}

# --- Resolve distro + app path (env -> config file -> location -> defaults) --

$commonPs1 = Join-Path $PSScriptRoot 'config-common.ps1'
if (-not (Test-Path -LiteralPath $commonPs1)) {
    Fail "config-common.ps1 not found next to this script ($commonPs1) - copy the whole launcher folder, not just launch.ps1."
}
. $commonPs1

# -ConfigDir: the installed launcher reads launcher-config.json from its own
# folder. A corrupt one THROWS out of Resolve-AiSmConfig rather than falling
# through to a guess; catch it here so -Silent still gets a message box.
try {
    $smConfig = Resolve-AiSmConfig -ScriptRoot $PSScriptRoot -ConfigDir $PSScriptRoot `
        -DefaultDistro $DefaultDistro -DefaultRepoPath $DefaultRepoPath
} catch {
    Fail $_.Exception.Message
}
$Distro   = $smConfig.Distro
$RepoPath = $smConfig.RepoPath
if (-not $Distro -or -not $RepoPath) { Fail (Get-AiSmNoConfigMessage -ConfigDir $PSScriptRoot) }
if (-not $Silent) { Write-Host (Format-AiSmConfigLine $smConfig) }

# --- Config validation (allow-lists; also the injection-safety gate) -------
# Applies to every source equally - a derived value is no more trusted than
# a typed one, and a derived value that fails here is NEVER swapped for the
# built-in default (that would start a backend for someone else's repo).

if (-not (Test-AiSmLinuxPath $RepoPath)) {
    Fail ("RepoPath must be an absolute Linux path without spaces or shell metacharacters, got: $RepoPath`n" +
        (Get-AiSmConfigHint -Source $smConfig.RepoPathSource -Kind 'RepoPath'))
}
if (-not (Test-AiSmDataDir $DataDir)) {
    Fail "DataDir must be '~/...' or an absolute Linux path without spaces or shell metacharacters, got: $DataDir"
}
if (-not (Test-AiSmDistroName $Distro)) {
    Fail ("Distro contains invalid characters: $Distro`n" +
        (Get-AiSmConfigHint -Source $smConfig.DistroSource -Kind 'Distro'))
}

function Get-DistroList {
    # wsl.exe emits UTF-16 by default; WSL_UTF8=1 fixes that on any recent
    # WSL. Strip stray NULs anyway in case the flag is unsupported.
    $prev = $env:WSL_UTF8
    $env:WSL_UTF8 = '1'
    try {
        $list = & wsl.exe -l -q
    } catch {
        Fail 'wsl.exe not found - is WSL installed?'
    } finally {
        if ($null -ne $prev) { $env:WSL_UTF8 = $prev }
        else { Remove-Item Env:WSL_UTF8 -ErrorAction SilentlyContinue }
    }
    @($list | ForEach-Object { ($_ -replace "`0", '').Trim() } | Where-Object { $_ })
}

$installedDistros = Get-DistroList
if ($installedDistros -notcontains $Distro) {
    # An exact match is silent (the derived distro names an installed one
    # exactly, so day-to-day launches print nothing here). A generic name
    # ('Ubuntu') that is not installed as such still auto-resolves: if
    # exactly ONE installed distro starts with the configured name, use it
    # (with a notice). No match or an ambiguous match (e.g. Ubuntu-22.04 +
    # Ubuntu-24.04) is still a hard error.
    $candidates = @($installedDistros | Where-Object { $_ -like "$Distro*" -and (Test-AiSmDistroName $_) })
    if ($candidates.Count -eq 1) {
        Write-Host "Distro '$Distro' is not installed; using the unique match '$($candidates[0])'."
        $Distro = $candidates[0]
    } else {
        Fail ("WSL distro '$Distro' not found. Installed distros: " +
            ($installedDistros -join ', ') + ". " +
            (Get-AiSmConfigHint -Source $smConfig.DistroSource -Kind 'Distro' -NotInstalled))
    }
}

# --- WSL helpers -----------------------------------------------------------

function Invoke-InDistro {
    # Runs a command line via the distro's default shell (which is what
    # expands the leading ~ in $DataDir). The trailing '2>/dev/null' is a
    # literal argument here; it becomes a shell redirection INSIDE the
    # distro, keeping Linux-side stderr out of the PowerShell stream.
    param([Parameter(Mandatory)][string[]]$CommandArgs)
    & wsl.exe -d $Distro -- @CommandArgs '2>/dev/null'
}

function Read-RuntimeInfo {
    # Returns $null when the file is absent or unparseable. Port and pid are
    # strictly validated integers - the only runtime values reused in
    # commands/URLs.
    $raw = Invoke-InDistro @('cat', "$DataDir/runtime.json")
    if ($LASTEXITCODE -ne 0 -or -not $raw) { return $null }
    $text = ($raw -join "`n")
    try { $json = $text | ConvertFrom-Json } catch { return $null }
    $port = 0
    $serverPid = 0
    if (-not [int]::TryParse([string]$json.port, [ref]$port)) { return $null }
    if (-not [int]::TryParse([string]$json.pid, [ref]$serverPid)) { return $null }
    if ($port -lt 1 -or $port -gt 65535 -or $serverPid -lt 1) { return $null }
    [pscustomobject]@{
        Port      = $port
        ServerPid = $serverPid
        StartedAt = [string]$json.startedAt
    }
}

function Test-Health([int]$Port) {
    try {
        $resp = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 3 -ErrorAction Stop
        return ($resp.ok -eq $true)
    } catch {
        return $false
    }
}

function Start-Backend {
    # start-backend.sh (in the repo, Linux side) resolves a Node >= 24
    # (loading nvm explicitly - invisible to non-interactive login shells),
    # then runs `setsid --fork nohup node server/index.ts` (foreground, all
    # stdio on /dev/null) so the server is reparented into its own session
    # before wsl.exe exits - `&`-backgrounded children get killed with the
    # interop session on current WSL2. The server does its own logging to
    # $DataDir/server.log.
    Write-Host "Starting backend in '$Distro' (repo: $RepoPath)..."
    & wsl.exe -d $Distro -- bash -lc "$RepoPath/launcher/start-backend.sh $DataDir"
    # Every failure goes through Fail so -Silent surfaces it as a message
    # box instead of dying invisibly.
    switch ($LASTEXITCODE) {
        0 { return }
        10 { Fail "repo not found / cd failed at $RepoPath inside $Distro." }
        11 { Fail "no usable node found inside $Distro (login PATH and nvm both checked). If you installed with the Setup, its bundled runtime is missing - reinstall." }
        12 { Fail "Node >= 24 required inside $Distro (an older version was found; try 'nvm install 24'). If you installed with the Setup, its bundled runtime is missing - reinstall." }
        13 { Fail "data dir did not expand to an absolute path inside ${Distro}: $DataDir" }
        default { Fail "start-backend.sh failed (exit $LASTEXITCODE)." }
    }
}

function Wait-ForHealthy([int]$TimeoutSec) {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    while ($sw.Elapsed.TotalSeconds -lt $TimeoutSec) {
        $info = Read-RuntimeInfo
        if ($info -and (Test-Health -Port $info.Port)) {
            Write-Host ''
            return $info
        }
        Write-Host -NoNewline '.'
        Start-Sleep -Seconds 1
    }
    Write-Host ''
    return $null
}

function Test-WebView2Runtime {
    # True when the WebView2 Evergreen runtime is installed. Its EdgeUpdate
    # client GUID is {F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}; the runtime writes
    # a version string 'pv' under the machine (system-wide) or per-user hive.
    # A pv of 0.0.0.0 means "registered but not actually installed" - reject it.
    $guid = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
    $keys = @(
        "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\$guid",
        "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\$guid",
        "HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\$guid"
    )
    foreach ($key in $keys) {
        try {
            $pv = (Get-ItemProperty -LiteralPath $key -Name pv -ErrorAction Stop).pv
        } catch {
            continue
        }
        if ($pv -and $pv -match '^[0-9]+(\.[0-9]+)+$' -and $pv -ne '0.0.0.0') {
            return $true
        }
    }
    return $false
}

function Open-NativeHost([string]$Url) {
    # Tier 1: the native WebView2 host (host\AiSessionManagerHost.exe when
    # installed, launcher\host\build\AiSessionManagerHost.exe in a clone built
    # by build-host.ps1). It owns its window's AppUserModelID
    # ('AiSessionManager', matched by make-shortcut.ps1) so the taskbar button
    # shows app.ico instead of the Edge logo. Returns $true on a confirmed-ready
    # window; $false means "unavailable or failed - fall through to Edge".
    # Two layouts hold the same exe: 'host\' beside the scripts (what the
    # Windows Setup installs) and 'host\build\' (what build-host.ps1 produces
    # in a developer clone). First one that exists wins.
    $srcDir = $null
    foreach ($candidate in @((Join-Path $PSScriptRoot 'host'), (Join-Path $PSScriptRoot 'host\build'))) {
        if (Test-Path -LiteralPath (Join-Path $candidate 'AiSessionManagerHost.exe')) {
            $srcDir = $candidate
            break
        }
    }
    if (-not $srcDir) { return $false }
    if (-not (Test-WebView2Runtime)) {
        Write-Host 'WebView2 runtime not detected - using the Edge --app fallback.'
        return $false
    }

    $localAppData  = [Environment]::GetFolderPath('LocalApplicationData')
    $readySentinel = Join-Path $localAppData 'ai-session-manager\host-ready'

    if ($PSScriptRoot -and -not $PSScriptRoot.StartsWith('\\')) {
        # Installed (or otherwise copied onto a real drive): run the exe where
        # it lies. The staging dance below exists only for UNC paths, and doing
        # it here would be actively wrong - an update replaces {app}\host, and a
        # stale %LOCALAPPDATA% copy could shadow it.
        $hostExe = Join-Path $srcDir 'AiSessionManagerHost.exe'
    } else {
        # Run from a LOCAL copy, never the \\wsl.localhost source. Launching an exe
        # off that UNC path puts it in the network zone: ShellExecute pops a modal
        # "Open File - Security Warning" that blocks invisibly under the silent
        # launcher (so nothing ever opens), and .NET's ExtractAssociatedIcon
        # rejects UNC paths. Stage exe + DLLs into %LOCALAPPDATA% and run there.
        $localDir = Join-Path $localAppData 'ai-session-manager\host'
        $hostExe  = Join-Path $localDir 'AiSessionManagerHost.exe'
        try {
            if (-not (Test-Path -LiteralPath $localDir)) {
                New-Item -ItemType Directory -Force -Path $localDir -ErrorAction Stop | Out-Null
            }
            # Copy each build artifact when missing or older than the source, then
            # Unblock-File to strip any network Mark-of-the-Web that would re-warn.
            Get-ChildItem -LiteralPath $srcDir -File -ErrorAction Stop | ForEach-Object {
                $target = Join-Path $localDir $_.Name
                if (-not (Test-Path -LiteralPath $target) -or
                    $_.LastWriteTimeUtc -gt (Get-Item -LiteralPath $target).LastWriteTimeUtc) {
                    Copy-Item -LiteralPath $_.FullName -Destination $target -Force -ErrorAction Stop
                }
                Unblock-File -LiteralPath $target -ErrorAction SilentlyContinue
            }
        } catch {
            Write-Host "Native host: could not stage a local copy ($($_.Exception.Message)) - using the Edge --app fallback."
            return $false
        }
    }
    if (-not (Test-Path -LiteralPath $hostExe)) { return $false }

    # Delete any stale sentinel so we only ever trust one written by THIS launch.
    Remove-Item -LiteralPath $readySentinel -Force -ErrorAction SilentlyContinue

    try {
        # $Url is the only string on the command line (validated by the caller
        # as http://127.0.0.1:<port>/), passed as a single argument.
        $p = Start-Process -FilePath $hostExe -ArgumentList $Url -PassThru -ErrorAction Stop
    } catch {
        Write-Host "Native host failed to start ($($_.Exception.Message)) - using the Edge --app fallback."
        return $false
    }

    # Probe up to ~8 s for the fresh ready-sentinel (pid must match), the host
    # exiting (init failure -> non-zero), or timeout.
    $ready = $false
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    while ($sw.Elapsed.TotalSeconds -lt 8) {
        if (Test-Path -LiteralPath $readySentinel) {
            $raw = (Get-Content -LiteralPath $readySentinel -ErrorAction SilentlyContinue | Select-Object -First 1)
            $sentPid = 0
            if ([int]::TryParse(([string]$raw).Trim(), [ref]$sentPid) -and $sentPid -eq $p.Id) {
                $ready = $true
                break
            }
        }
        if ($p.HasExited) { break }
        Start-Sleep -Milliseconds 200
    }

    if ($ready) {
        Write-Host "Native host window ready (pid $($p.Id))."
        return $true
    }
    if ($p.HasExited) {
        Write-Host "Native host exited (code $($p.ExitCode)) without signaling ready - using the Edge --app fallback."
    } else {
        Write-Host 'Native host did not signal ready within 8 s - stopping it and using the Edge --app fallback.'
        try { Stop-Process -Id $p.Id -Force -ErrorAction Stop } catch { }
    }
    return $false
}

function Find-Edge {
    $bases = @(${env:ProgramFiles(x86)}, $env:ProgramFiles, $env:LocalAppData) | Where-Object { $_ }
    # Classic layout.
    foreach ($base in $bases) {
        $classic = Join-Path $base 'Microsoft\Edge\Application\msedge.exe'
        if (Test-Path -LiteralPath $classic) { return $classic }
    }
    # Newer Edge installs moved the browser binary to
    # Microsoft\EdgeCore\<version>\msedge.exe (Edge\Application may still
    # exist but hold no msedge.exe). Pick the highest version present.
    foreach ($base in $bases) {
        $core = Join-Path $base 'Microsoft\EdgeCore'
        if (-not (Test-Path -LiteralPath $core)) { continue }
        $best = Get-ChildItem -LiteralPath $core -Directory -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -match '^[0-9]+(\.[0-9]+)+$' } |
            Sort-Object { [version]$_.Name } -Descending |
            ForEach-Object { Join-Path $_.FullName 'msedge.exe' } |
            Where-Object { Test-Path -LiteralPath $_ } |
            Select-Object -First 1
        if ($best) { return $best }
    }
    return $null
}

function Open-UI([string]$Url) {
    # An in-app update runs the Setup while the OLD host window is still open,
    # so the Setup writes the new host into {app}\host\next and leaves the
    # running exe alone. This launch is the first moment that window is gone:
    # promote next\ before anything looks for the exe. Installed layout only -
    # a clone builds into host\build\, and a launcher on a \\wsl.localhost
    # path was never written to by a Setup. Never fails a launch (see
    # Move-AiSmHostNext); a file still in use just stays in next\.
    $installedHostDir = Join-Path $PSScriptRoot 'host'
    if ($PSScriptRoot -and -not $PSScriptRoot.StartsWith('\\') -and
        (Test-Path -LiteralPath $installedHostDir)) {
        [void](Move-AiSmHostNext -HostDir $installedHostDir)
    }

    # Tier 1: the native WebView2 host (owns its taskbar identity). Only used
    # when the built exe + the WebView2 runtime are both present, with real
    # failure detection; any failure falls through to the Edge tiers below.
    if (Open-NativeHost $Url) { return }

    # Tier 2: Edge --app = chromeless app window (MVP shell; Tauri comes later).
    $edge = Find-Edge
    if ($edge) {
        Start-Process -FilePath $edge -ArgumentList "--app=$Url"
        return
    }
    try {
        # Last Edge attempt via the App Paths registration, if any.
        # -ErrorAction Stop: Start-Process failures are non-terminating on
        # some PowerShell builds, which would silently skip this catch.
        Start-Process -FilePath 'msedge.exe' -ArgumentList "--app=$Url" -ErrorAction Stop
        return
    } catch {
        Write-Host 'Edge not found - opening in the default browser instead.'
        Start-Process $Url
        if ($Silent) {
            # Browser first, then the (auto-dismissing) explanation - the
            # popup must never delay the actual launch.
            Show-WarningBox ('Microsoft Edge was not found, so the app opened as a ' +
                'regular tab in your default browser instead of its own window. ' +
                'Everything works; install Edge to get the dedicated app window back.')
        }
    }
}

# --- Modes -----------------------------------------------------------------

if ($Status -and $Stop) { Fail 'Use either -Status or -Stop, not both.' }

if ($Status) {
    $info = Read-RuntimeInfo
    if (-not $info) {
        Write-Host "Backend: not running (no readable runtime.json at $DataDir/runtime.json in '$Distro')."
        exit 1
    }
    Write-Host "runtime.json ($DataDir/runtime.json in '$Distro'):"
    # Never print the raw file: it contains the auth token, and that token is
    # the only credential gating the command-spawning API for the lifetime of
    # the backend. Users paste -Status output into issues and chats.
    Write-Host "  port: $($info.Port)  pid: $($info.ServerPid)  startedAt: $($info.StartedAt)  (auth token redacted)"
    if (Test-Health -Port $info.Port) {
        Write-Host "Health: OK - http://127.0.0.1:$($info.Port)/health (pid $($info.ServerPid))"
        exit 0
    }
    Write-Host 'Health: FAILED - runtime.json is stale (backend dead or hung). The next launch will start fresh.'
    exit 1
}

if ($Stop) {
    $info = Read-RuntimeInfo
    if (-not $info) {
        Write-Host "Backend is not running (no runtime.json at $DataDir/runtime.json in '$Distro')."
        exit 0
    }
    Write-Host "Stopping backend pid $($info.ServerPid) (port $($info.Port))..."
    Invoke-InDistro @('kill', '-TERM', "$($info.ServerPid)")
    if ($LASTEXITCODE -ne 0) {
        Write-Host 'Process was already gone - removing stale runtime.json.'
        Invoke-InDistro @('rm', '-f', "$DataDir/runtime.json")
        exit 0
    }
    # The server removes runtime.json on clean SIGTERM; wait for that.
    for ($i = 0; $i -lt 20; $i++) {
        Start-Sleep -Milliseconds 500
        Invoke-InDistro @('test', '-e', "$DataDir/runtime.json")
        if ($LASTEXITCODE -ne 0) {
            Invoke-InDistro @('kill', '-0', "$($info.ServerPid)")
            if ($LASTEXITCODE -ne 0) {
                Write-Host 'Backend stopped: runtime.json removed, process gone.'
            } else {
                Write-Host 'runtime.json removed; process still exiting.'
            }
            exit 0
        }
    }
    Fail 'Backend did not remove runtime.json within 10s - it may be hung. Check server.log in the data dir.'
}

# --- Default flow: attach-or-start, then open the UI -----------------------

$info = Read-RuntimeInfo
if ($info -and (Test-Health -Port $info.Port)) {
    Write-Host "Backend already running and healthy (pid $($info.ServerPid), port $($info.Port))."
} else {
    if ($info) {
        Write-Host "Stale runtime.json (pid $($info.ServerPid), port $($info.Port) failed health check) - starting fresh."
    } else {
        Write-Host 'Backend is not running - starting it.'
    }
    Start-Backend
    Write-Host -NoNewline "Waiting for backend (up to $StartTimeoutSec s; the first start after a Windows boot is the slowest)"
    $info = Wait-ForHealthy -TimeoutSec $StartTimeoutSec
    if (-not $info) {
        Fail "Backend did not become healthy within $StartTimeoutSec s. Check the log inside '$Distro': $DataDir/server.log"
    }
    Write-Host "Backend healthy (pid $($info.ServerPid), port $($info.Port))."
}

$url = "http://127.0.0.1:$($info.Port)/"
if ($NoBrowser) {
    Write-Host "-NoBrowser: UI not opened. URL: $url"
} else {
    Write-Host "Opening $url"
    Open-UI $url
}
exit 0
