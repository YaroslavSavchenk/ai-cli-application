<#
run-update.ps1 - run a downloaded Setup.exe silently, on the Windows side of
an in-app update.

  powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass ^
    -File <staging>\run-update.ps1 ^
    -SetupPath <staging>\AI-Session-Manager-Setup-v0.3.0.exe ^
    -ExpectedSha <64 lowercase hex> ^
    -LogPath <staging>\setup.log

Who calls it: the BACKEND, from inside WSL, after it has downloaded the
release's Setup exe and SHA256SUMS.txt, verified the exe against that sums
file, and copied both the exe and THIS SCRIPT into a Windows-side staging
directory (`<%TEMP%>\ai-session-manager-update\<version>\`). Every argument
above is built by the backend from values it constructed itself; nothing a
remote server said ever reaches this command line.

Why re-hash something the backend already verified: this script is the last
thing that touches the file before Windows executes it. Between the
backend's check and here the file crossed the WSL/Windows filesystem bridge
and sat in a world-writable %TEMP% directory. Hashing it again costs one
second and turns "verified when it was written" into "verified as the bytes
that ran". A mismatch DELETES the file and stops - nothing unverified is
ever executed.

Exit codes (the backend's contract):

  0        the Setup ran and finished successfully
  2        the file on disk does not match -ExpectedSha; it has been deleted
           and nothing was started
  3        this script refused (bad arguments, missing file, could not start)
  other    the Setup's own exit code, passed through unchanged

  These codes are NOT unique to this script: Inno Setup uses 1, 2, 3, 4, 5 and
  6 for its own failures too, so the NUMBER alone never says which side
  refused. The OUTPUT does, and the backend pipes this stdout into server.log:
  every refusal of this script's own prints an `ERROR: ...` marker line (that
  is what Fail does) and a hash mismatch prints the two checksum lines, while
  a Setup that ran and failed is preceded by "Starting ... (silent)." and
  followed by the tail of Inno's own setup.log. So the log always distinguishes
  them, and the codes only have to stay ACTIONABLE for the user: 2 is "the
  downloaded file was rejected", 3 is "the Setup could not be started". An Inno
  exit 3 (it aborted in its prepare phase, before changing anything) is
  therefore reported as "could not be started" - which is what happened, and
  the right thing to tell the user either way.

-DryRun prints the exact Start-Process argv it would use and exits 0 without
hashing, unblocking, starting or deleting anything - that is how the test
suite pins this interface from WSL, where no Setup exists to run.

Housekeeping: on a real run the staging directory ($PSScriptRoot - the exe,
this script and the Setup log all live there) is removed in a `finally`, so
an unsigned installer never lingers in %TEMP%. That removal only happens for
a copy running from a path with an `ai-session-manager-update` segment: the
MASTER copy of this script ships inside the WSL bundle
(<version>/launcher/run-update.ps1) and is reachable over the WSL share, and
that copy must never be able to delete the app it belongs to.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$SetupPath,
    [Parameter(Mandatory)][string]$ExpectedSha,
    [Parameter(Mandatory)][string]$LogPath,
    [switch]$DryRun
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

# The Setup's own file name, as release.yml builds it
# (OutputBaseFilename=AI-Session-Manager-Setup-{#AppVersion}). Anchored with
# \z, never `$`: in .NET `$` also matches BEFORE a trailing newline.
$AiSmSetupNamePattern = '^AI-Session-Manager-Setup-v[0-9A-Za-z.+\-]+\.exe\z'
# Lowercase hex only - the shape sha256sum writes and the backend parses.
# Gated with -cnotmatch and compared with -cne further down: PowerShell's
# -match/-ne are case-INSENSITIVE, so a plain -notmatch would accept
# 64 uppercase hex characters this contract does not allow.
$AiSmShaPattern = '^[0-9a-f]{64}\z'
# A rooted Windows path, no character that would end or re-open quoting on a
# command line, no `%` (which a shell would expand), and bounded. Spaces ARE
# allowed: %TEMP% legitimately contains them. The bound is 3 + 256 = 259 =
# MAX_PATH - 1, the SAME ceiling the backend's own argv gate applies
# (WINDOWS_ARG_SHAPE in server/update-install.ts): a path this script refuses
# after the download has been made and verified is the worst possible place to
# discover a disagreement about lengths.
$AiSmWinPathPattern = '^[A-Za-z]:\\[^<>|"?*\r\n%]{1,256}\z'
# The one directory segment that marks a path as an update staging directory,
# i.e. the only kind of directory this script may delete.
$AiSmStagingSegment = 'ai-session-manager-update'

function Write-Line([string]$Message) {
    # stdout is a pipe held by the backend, which reads it (bounded at 64 KiB),
    # and writes every non-empty line to server.log when this process exits -
    # at debug after exit 0, at warn otherwise. So: no secrets, no unbounded
    # remote text, and one thought per line.
    Write-Host $Message
}

function Fail([string]$Message) {
    Write-Line "ERROR: $Message"
    exit 3
}

function Get-FullPath([string]$Path) {
    # Normalizes `.` / `..` without touching the disk. Wrapped so a malformed
    # path is a refusal with a sentence, not a .NET stack trace.
    try {
        return [System.IO.Path]::GetFullPath($Path)
    } catch {
        Fail "'$Path' is not a usable Windows path ($($_.Exception.Message))."
    }
}

function Write-SetupLogTail([string]$Path) {
    <#
    The Setup's own log is the only explanation of a failed silent install,
    and the staging directory (log included) is removed moments later - so the
    tail is printed HERE, on stdout, which the backend records in server.log.
    Bounded to the last 30 lines: enough for the failing step, never a file
    dump. Best effort by construction: this runs while an update has already
    failed, and must never change the exit code.
    #>
    try {
        if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
            Write-Line 'setup.log: (the Setup wrote no log)'
            return
        }
        $tail = @(Get-Content -LiteralPath $Path -Tail 30 -ErrorAction Stop)
        if ($tail.Count -eq 0) {
            Write-Line 'setup.log: (empty)'
            return
        }
        foreach ($line in $tail) { Write-Line ('setup.log: ' + $line) }
    } catch {
        Write-Line "setup.log: could not be read ($($_.Exception.Message))."
    }
}

function Remove-StagingDir([string]$Dir) {
    <#
    Removes the staging directory this script is running from - the Setup
    exe, the Setup log and this script itself. Best effort by construction:
    the update has already happened (or already failed) by the time this
    runs, so a locked file here must never change the exit code.

    The guard is the point: only a directory whose path holds an
    `ai-session-manager-update` segment is ever removed. Run from anywhere
    else - the bundle's own launcher directory over the WSL share, the
    installed program folder - this deletes nothing and says so.
    #>
    if (-not $Dir) { return }
    $segments = @(($Dir -split '[\\/]+') | Where-Object { $_ -ne '' })
    if ($segments -notcontains $AiSmStagingSegment) {
        Write-Line "Staging directory not removed: '$Dir' is not an update staging directory."
        return
    }
    # Windows refuses to delete a directory that is a running process's own
    # working directory, and the backend starts this script WITH the staging
    # directory as its cwd - so step out of it first. Both have to move:
    # Set-Location does not change the process-wide current directory in
    # PowerShell 5.1, and that is the one the OS holds.
    try {
        $away = [System.IO.Path]::GetTempPath()
        Set-Location -LiteralPath $away
        [System.Environment]::CurrentDirectory = $away
    } catch { }

    $lastError = ''
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        try {
            Remove-Item -LiteralPath $Dir -Recurse -Force -ErrorAction Stop
            Write-Line "Staging directory removed: $Dir"
            return
        } catch {
            $lastError = $_.Exception.Message
            if ($attempt -lt 3) { Start-Sleep -Milliseconds 300 }
        }
    }
    Write-Line "Staging directory could not be removed ($lastError) - it is in %TEMP% and Windows will clean it up."
}

# --- validate every argument before anything happens ------------------------

if (-not $PSScriptRoot) {
    Fail 'run-update.ps1 must be started with -File so it knows its own directory.'
}
$stagingDir = (Get-FullPath $PSScriptRoot).TrimEnd([char]'\')

if ($SetupPath -notmatch $AiSmWinPathPattern) {
    Fail "-SetupPath is not a usable Windows path: $SetupPath"
}
if ($LogPath -notmatch $AiSmWinPathPattern) {
    Fail "-LogPath is not a usable Windows path: $LogPath"
}
if ($ExpectedSha -cnotmatch $AiSmShaPattern) {
    Fail '-ExpectedSha must be 64 lowercase hex characters.'
}

$setupFull = Get-FullPath $SetupPath
$logFull   = Get-FullPath $LogPath

# The exe must sit DIRECTLY in this script's own directory. The backend put
# both there; anything else means this script was pointed at a file it did
# not stage, so it refuses rather than running it.
$setupDir  = ''
try {
    $setupDir = [System.IO.Path]::GetDirectoryName($setupFull)
} catch {
    Fail "-SetupPath has no directory: $SetupPath"
}
if (-not $setupDir) { Fail "-SetupPath has no directory: $SetupPath" }
if ($setupDir.TrimEnd([char]'\') -ne $stagingDir) {
    Fail "-SetupPath must be a file in this script's own directory ($stagingDir), got: $setupFull"
}

$setupName = [System.IO.Path]::GetFileName($setupFull)
if ($setupName -notmatch $AiSmSetupNamePattern) {
    Fail "-SetupPath is not a release Setup file name: $setupName"
}

if (-not (Test-Path -LiteralPath $setupFull -PathType Leaf)) {
    Fail "-SetupPath does not exist: $setupFull"
}

# --- the exact argv ---------------------------------------------------------
#
# /SILENT           no wizard, only the progress window
# /SUPPRESSMSGBOXES no modal can block a run nobody is watching (every message
#                   box in the .iss is a SuppressibleMsgBox for this reason)
# /NORESTART        this Setup never needs one, and must never take one
# /LOG=<file>       the Setup's own log, which the backend tails on failure
#
# /LOG's value is quoted here because PowerShell 5.1's -ArgumentList joins
# its elements with spaces and quotes nothing: an unquoted %TEMP% path with a
# space in it would reach Inno as two arguments.
$setupArgs = @(
    '/SILENT',
    '/SUPPRESSMSGBOXES',
    '/NORESTART',
    ('/LOG="' + $logFull + '"')
)

if ($DryRun) {
    # Deliberately before the try/finally below: a dry run hashes nothing,
    # starts nothing and - above all - deletes nothing.
    Write-Line 'DRYRUN-ARGV-BEGIN'
    Write-Line "FilePath=$setupFull"
    foreach ($arg in $setupArgs) { Write-Line "Arg=$arg" }
    Write-Line 'DRYRUN-ARGV-END'
    Write-Line '-DryRun: nothing was hashed, started or removed.'
    exit 0
}

# --- verify, then run -------------------------------------------------------

try {
    $actual = ''
    try {
        $actual = (Get-FileHash -LiteralPath $setupFull -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
    } catch {
        Write-Line "ERROR: could not read $setupFull ($($_.Exception.Message))."
        exit 3
    }
    if ($actual -cne $ExpectedSha) {
        # Nothing unverified may survive as a runnable file, so the deletion
        # comes before the message and before any other work.
        try {
            Remove-Item -LiteralPath $setupFull -Force -ErrorAction Stop
            Write-Line 'The downloaded file did not match the expected checksum; it has been deleted.'
        } catch {
            Write-Line "The downloaded file did not match the expected checksum and could NOT be deleted ($($_.Exception.Message))."
        }
        Write-Line "  expected: $ExpectedSha"
        Write-Line "  actual:   $actual"
        exit 2
    }

    # The backend downloaded this file inside WSL, so it carries no
    # Mark-of-the-Web - but a file that arrived any other way would, and a
    # zone-marked exe pops the SmartScreen dialog no one can click here.
    try {
        Unblock-File -LiteralPath $setupFull -ErrorAction Stop
    } catch {
        Write-Line "Unblock-File did not run ($($_.Exception.Message)) - continuing."
    }

    Write-Line "Starting $setupName (silent)."
    $proc = $null
    try {
        $proc = Start-Process -FilePath $setupFull -ArgumentList $setupArgs -Wait -PassThru -ErrorAction Stop
    } catch {
        Write-Line "ERROR: the Setup could not be started ($($_.Exception.Message))."
        exit 3
    }
    if ($null -eq $proc) {
        Write-Line 'ERROR: the Setup could not be started (no process).'
        exit 3
    }

    $code = $proc.ExitCode
    Write-Line "Setup exited with code $code."
    # The log dies with the staging directory in the `finally` below, so a
    # failure says why while it still can.
    if ($code -ne 0) { Write-SetupLogTail $logFull }
    exit $code
} finally {
    Remove-StagingDir $stagingDir
}
