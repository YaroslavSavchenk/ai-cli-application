<#
launch.ps1 - Windows-side launcher for the AI CLI Session Manager
(backend lives inside WSL2; see .claude/PROJECT-SCOPE.md in the repo).

Usage:
  launch.ps1              attach-or-start the backend, then open the UI
                          (Edge --app window; default browser as fallback)
  launch.ps1 -NoBrowser   attach-or-start, but do not open any UI
  launch.ps1 -Status      report backend state (runtime.json + health)
  launch.ps1 -Stop        graceful stop (SIGTERM to the pid in runtime.json)

How it works:
  - The backend auto-picks its port (never hardcode one) and publishes a
    discovery file inside WSL: ~/.ai-session-manager/runtime.json with
    { port, token, pid, startedAt }. This script reads it via `wsl.exe cat`
    and health-checks http://127.0.0.1:<port>/health.
    ALWAYS 127.0.0.1, never `localhost`: the server binds IPv4 only and
    `localhost` may resolve to ::1 and fail.
  - Healthy -> open the UI. File absent or stale (dead pid / failed health)
    -> start fresh. The backend is started DETACHED (setsid, see
    start-backend.sh) so it survives this launcher, its wsl.exe calls, and
    the browser window: closing the window never kills sessions.
  - Cold WSL boot adds seconds; after starting we poll file + health for up
    to $StartTimeoutSec seconds with progress output.
  - runtime.json remains on SIGKILL/crash by design - the health check, not
    the file, decides the truth. Stale file means start fresh, not error.

Injection safety: no client/runtime string is ever interpolated into a
shell or PowerShell command. The only strings that reach WSL command lines
are the config values below (validated against strict allow-list patterns
before first use) and the pid from runtime.json (validated as an integer).

This script never runs `wsl.exe --shutdown`, `wsl.exe -t`, or anything else
that terminates the distro or WSL processes it did not start.
#>
[CmdletBinding()]
param(
    [switch]$Status,
    [switch]$Stop,
    [switch]$NoBrowser
)

# =============================== Config ====================================
# Edit the defaults here, or override per-invocation via environment
# variables (handy for testing). These are the ONLY strings that ever reach
# a WSL command line, and they are validated below before first use.
$Distro   = if ($env:AI_SM_DISTRO)    { $env:AI_SM_DISTRO }    else { 'Ubuntu' }
$RepoPath = if ($env:AI_SM_REPO_PATH) { $env:AI_SM_REPO_PATH } else { '/home/sava/projects/ai-cli-application' }
$DataDir  = if ($env:AI_SM_DATA_DIR)  { $env:AI_SM_DATA_DIR }  else { '~/.ai-session-manager' }
# Seconds to wait for runtime.json + health after starting the backend
# (must absorb a cold WSL boot).
$StartTimeoutSec = 90
# ===========================================================================

function Fail([string]$Message) {
    Write-Host "ERROR: $Message" -ForegroundColor Red
    exit 1
}

# --- Config validation (allow-lists; also the injection-safety gate) -------

if ($RepoPath -notmatch '^/[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$') {
    Fail "RepoPath must be an absolute Linux path without spaces or shell metacharacters, got: $RepoPath"
}
if ($DataDir -notmatch '^(~)?(/[A-Za-z0-9._-]+)+$') {
    Fail "DataDir must be '~/...' or an absolute Linux path without spaces or shell metacharacters, got: $DataDir"
}
if ($Distro -notmatch '^[A-Za-z0-9._-]+$') {
    Fail "Distro contains invalid characters: $Distro"
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
    # The generic default ('Ubuntu') rarely matches a real install
    # ('Ubuntu-24.04'). If exactly ONE installed distro starts with the
    # configured name, use it (with a notice). No match or an ambiguous
    # match (e.g. Ubuntu-22.04 + Ubuntu-24.04) is still a hard error.
    $candidates = @($installedDistros | Where-Object { $_ -like "$Distro*" -and $_ -match '^[A-Za-z0-9._-]+$' })
    if ($candidates.Count -eq 1) {
        Write-Host "Distro '$Distro' is not installed; using the unique match '$($candidates[0])'."
        $Distro = $candidates[0]
    } else {
        Fail ("WSL distro '$Distro' not found. Installed distros: " +
            ($installedDistros -join ', ') +
            ". Edit the config block at the top of launch.ps1 (or set AI_SM_DISTRO).")
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
    switch ($LASTEXITCODE) {
        0 { return $true }
        10 { Write-Host "ERROR: repo not found / cd failed at $RepoPath inside $Distro." -ForegroundColor Red }
        11 { Write-Host "ERROR: no usable node found inside $Distro (login PATH and nvm both checked)." -ForegroundColor Red }
        12 { Write-Host "ERROR: Node >= 24 required inside $Distro (an older version was found; try 'nvm install 24')." -ForegroundColor Red }
        13 { Write-Host "ERROR: data dir did not expand to an absolute path inside ${Distro}: $DataDir" -ForegroundColor Red }
        default { Write-Host "ERROR: start-backend.sh failed (exit $LASTEXITCODE)." -ForegroundColor Red }
    }
    return $false
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
    # Edge --app = chromeless app window (MVP shell; Tauri comes later).
    $edge = Find-Edge
    if ($edge) {
        Start-Process -FilePath $edge -ArgumentList "--app=$Url"
        return
    }
    try {
        # Last Edge attempt via the App Paths registration, if any.
        Start-Process -FilePath 'msedge.exe' -ArgumentList "--app=$Url"
        return
    } catch {
        Write-Host 'Edge not found - opening in the default browser instead.'
        Start-Process $Url
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
    if (-not (Start-Backend)) { exit 1 }
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
