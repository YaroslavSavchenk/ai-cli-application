<#
wsl-probe.ps1 - everything the Setup wizard needs to KNOW about WSL, in one
place. It reads; it never installs, starts, stops or writes anything.

Two modes:

  -ResultFile <file>
      List mode. Runs `wsl.exe -l -v` and reports what is installed.
  -ResultFile <file> -Distro <name> [-GlibcMin <x.y>]
      Distro mode. Runs one read-only probe INSIDE that distro and reports
      its default user, home directory, glibc version and whether Claude
      Code is already there.

Result keys (list mode):
    ok=yes|no            reason=<one line>        (why ok=no)
    wslPresent=yes|no    distroCount=N            wsl2Count=N
    default=<name>
    distro1=<name>       distro1.version=2        distro1.state=Running
    distro1.default=yes|no                        distro1.usable=yes|no
    ... one block per distro

Result keys (distro mode):
    ok=yes|no            reason=<one line>
    distro=<name>        user=<name>              home=</abs/path>
    glibc=<x.y>          glibcMin=<x.y>           glibcOk=yes|no
    claude=yes|no
    dataDir=<home>/.ai-session-manager
    defaultAppDir=<home>/.ai-session-manager/app

-DryRun (either mode) prints the wsl.exe command line it would run, answers
ok=yes with dryRun=yes, and reads nothing.

`ok=no` is a normal answer here (no WSL, no distro, glibc too old): the
wizard turns it into a page that explains and refuses to continue. A
non-zero EXIT means the helper itself could not run.

Never elevates, and never runs `wsl --install`: that needs admin and a
reboot, so the wizard only prints the command for the user to run.

-ListFile is a TEST SEAM: it replaces the `wsl.exe -l -v` call with the
bytes of a file, so the committed UTF-16LE fixture can drive the parser
without a WSL installation. It cannot make the helper do anything it would
not otherwise do (it only ever reads), and it is never passed by the .iss.
#>
[CmdletBinding()]
param(
    [string]$ResultFile,
    [string]$Distro,
    [string]$GlibcMin,
    [string]$ListFile,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'helper-common.ps1')
. (Get-AiSmCommonPath -ScriptDir $PSScriptRoot)

$pairs = New-AiSmPairList

function Complete-Probe {
    param([string]$Ok, [string]$Reason)
    # 'ok' and 'reason' go FIRST so a truncated file still says what happened.
    $all = New-AiSmPairList
    Add-AiSmPair $all 'ok' $Ok
    Add-AiSmPair $all 'reason' $Reason
    foreach ($pair in $pairs) { [void]$all.Add($pair) }
    Write-AiSmResult -Path $ResultFile -Pairs $all.ToArray()
    foreach ($pair in $all) { Write-Host $pair }
    exit 0
}

# --- the distro table ------------------------------------------------------

function ConvertFrom-AiSmDistroTable {
    <#
    Parses `wsl -l -v` output. Columns are separated by two or more spaces
    and a leading '*' marks the default distro:

          NAME            STATE           VERSION
        * Ubuntu-24.04    Running         2

    A name containing a space parses correctly and is simply reported as
    unusable (it cannot pass the allow-list that gates a WSL command line).
    #>
    param([string]$Text)

    $rows = @()
    foreach ($rawLine in ($Text -split "`n")) {
        # NUL strip: without WSL_UTF8=1 the output is UTF-16LE, which read as
        # UTF-8 puts a NUL after every ASCII character.
        $line = ($rawLine -replace "`0", '') -replace "`r", ''
        if (-not $line.Trim()) { continue }
        if ($line -match '^\s*NAME\s+STATE\s+VERSION\s*$') { continue }
        if ($line -match '^(\*?)\s*(\S.*?)\s{2,}(\S+)\s+([0-9]+)\s*$') {
            $rows += [pscustomobject]@{
                Name      = $matches[2]
                State     = $matches[3]
                Version   = [int]$matches[4]
                IsDefault = ($matches[1] -eq '*')
                Usable    = (Test-AiSmDistroName $matches[2])
            }
        }
    }
    # Plain output, not `, $rows`: the caller wraps the result in @(), and a
    # comma-wrapped array would arrive as ONE element holding all the rows.
    return $rows
}

function Get-AiSmDistroTableText {
    if ($ListFile) {
        if (-not (Test-Path -LiteralPath $ListFile)) { throw "-ListFile not found: $ListFile" }
        # Read the raw bytes and decode as UTF-8, exactly like the redirected
        # stdout of wsl.exe: UTF-16LE input then shows up as text with NULs,
        # which the parser strips.
        $bytes = [System.IO.File]::ReadAllBytes($ListFile)
        return [System.Text.Encoding]::UTF8.GetString($bytes)
    }
    $res = Invoke-AiSmWsl -CommandLine '-l -v' -TimeoutSec 120
    if ($res.ExitCode -ne 0 -and -not $res.StdOut.Trim()) {
        $why = $res.StdErr.Trim()
        if (-not $why) { $why = "wsl.exe -l -v exited $($res.ExitCode)." }
        throw $why
    }
    $res.StdOut
}

# --- distro mode: one read-only probe inside the distro --------------------

# NO DOUBLE QUOTES: this text is delimited by double quotes on the Windows
# command line. Values are only ever echoed, so an unquoted expansion that
# word-splits still prints the same characters.
$AiSmDistroProbeScript = @'
echo AISM_USER=$(id -un 2>/dev/null)
echo AISM_HOME=$HOME
echo AISM_GLIBC=$(getconf GNU_LIBC_VERSION 2>/dev/null || ldd --version 2>/dev/null | head -n 1)
if command -v claude >/dev/null 2>&1; then echo AISM_CLAUDE=yes; elif [ -x $HOME/.local/bin/claude ]; then echo AISM_CLAUDE=yes; else echo AISM_CLAUDE=no; fi
echo AISM_PROBE=ok
'@

function Get-AiSmProbeValue {
    param([string]$Text, [string]$Key)
    foreach ($rawLine in ($Text -split "`n")) {
        $line = ($rawLine -replace "`0", '') -replace "`r", ''
        if ($line.StartsWith("$Key=")) { return $line.Substring($Key.Length + 1).Trim() }
    }
    return ''
}

# ===========================================================================

if ($Distro) {
    if (-not (Test-AiSmDistroName $Distro)) {
        Add-AiSmPair $pairs 'distro' $Distro
        Complete-Probe 'no' "The distro name '$Distro' contains characters this installer refuses to put on a WSL command line (letters, digits, '.', '_' and '-' only)."
    }
    Add-AiSmPair $pairs 'distro' $Distro

    # bash -lc, not sh -c: a login shell has the PATH the launcher will see
    # later (Ubuntu's ~/.profile adds ~/.local/bin, where Claude Code installs).
    $script = ConvertTo-AiSmScriptLine -Script $AiSmDistroProbeScript
    $cmdline = '-d ' + $Distro + ' --exec bash -lc "' + $script + '"'
    if ($DryRun) {
        Write-Host 'DRYRUN-CMDLINE-BEGIN'
        Write-Host ('wsl.exe ' + $cmdline)
        Write-Host 'DRYRUN-CMDLINE-END'
        Add-AiSmPair $pairs 'dryRun' 'yes'
        Complete-Probe 'yes' ''
    }

    $res = Invoke-AiSmWsl -CommandLine $cmdline -TimeoutSec 180
    if ($res.ExitCode -ne 0 -or (Get-AiSmProbeValue $res.StdOut 'AISM_PROBE') -ne 'ok') {
        $why = $res.StdErr.Trim()
        if (-not $why) { $why = "the probe exited $($res.ExitCode)" }
        Complete-Probe 'no' "Could not read '$Distro' ($why). Start it once (wsl -d $Distro) and try again."
    }

    $user = Get-AiSmProbeValue $res.StdOut 'AISM_USER'
    $linuxHome = Get-AiSmProbeValue $res.StdOut 'AISM_HOME'
    $glibcRaw = Get-AiSmProbeValue $res.StdOut 'AISM_GLIBC'
    $claude = Get-AiSmProbeValue $res.StdOut 'AISM_CLAUDE'
    if ($claude -ne 'yes') { $claude = 'no' }

    Add-AiSmPair $pairs 'user' $user
    Add-AiSmPair $pairs 'home' $linuxHome
    Add-AiSmPair $pairs 'claude' $claude

    $glibc = ''
    if ($glibcRaw -match '([0-9]+\.[0-9]+)') { $glibc = $matches[1] }
    Add-AiSmPair $pairs 'glibc' $glibc
    Add-AiSmPair $pairs 'glibcMin' $GlibcMin

    if (-not (Test-AiSmLinuxPath $linuxHome)) {
        Complete-Probe 'no' "The home directory of '$Distro' is '$linuxHome'. This installer only handles paths built from letters, digits, '.', '_', '-' and '/'."
    }
    Add-AiSmPair $pairs 'dataDir' "$linuxHome/.ai-session-manager"
    Add-AiSmPair $pairs 'defaultAppDir' "$linuxHome/.ai-session-manager/app"

    if ($GlibcMin) {
        if (-not $glibc) {
            Add-AiSmPair $pairs 'glibcOk' 'no'
            Complete-Probe 'no' "Could not read the C library version of '$Distro'; this app needs glibc $GlibcMin or newer."
        }
        if ([version]$glibc -lt [version]$GlibcMin) {
            Add-AiSmPair $pairs 'glibcOk' 'no'
            Complete-Probe 'no' "'$Distro' has glibc $glibc; this app needs $GlibcMin or newer (Ubuntu 22.04+ or Debian 12+). Install a newer distribution and run this Setup again."
        }
        Add-AiSmPair $pairs 'glibcOk' 'yes'
    } else {
        Add-AiSmPair $pairs 'glibcOk' 'yes'
    }

    Complete-Probe 'yes' ''
}

# --- list mode -------------------------------------------------------------

if ($DryRun -and -not $ListFile) {
    Write-Host 'DRYRUN-CMDLINE-BEGIN'
    Write-Host 'wsl.exe -l -v'
    Write-Host 'DRYRUN-CMDLINE-END'
    Add-AiSmPair $pairs 'dryRun' 'yes'
    Complete-Probe 'yes' ''
}

try {
    $text = Get-AiSmDistroTableText
} catch {
    Add-AiSmPair $pairs 'wslPresent' 'no'
    Complete-Probe 'no' ("WSL does not answer on this PC ($($_.Exception.Message)). Open PowerShell AS ADMINISTRATOR, run:  wsl --install  then restart Windows and run this Setup again.")
}

Add-AiSmPair $pairs 'wslPresent' 'yes'
$rows = @(ConvertFrom-AiSmDistroTable -Text $text)
$wsl2 = @($rows | Where-Object { $_.Version -eq 2 -and $_.Usable })
Add-AiSmPair $pairs 'distroCount' $rows.Count
Add-AiSmPair $pairs 'wsl2Count' $wsl2.Count

$defaultRow = @($rows | Where-Object { $_.IsDefault }) | Select-Object -First 1
if ($defaultRow) { Add-AiSmPair $pairs 'default' $defaultRow.Name } else { Add-AiSmPair $pairs 'default' '' }

$index = 0
foreach ($row in $rows) {
    $index = $index + 1
    Add-AiSmPair $pairs "distro$index" $row.Name
    Add-AiSmPair $pairs "distro$index.version" $row.Version
    Add-AiSmPair $pairs "distro$index.state" $row.State
    if ($row.IsDefault) { Add-AiSmPair $pairs "distro$index.default" 'yes' } else { Add-AiSmPair $pairs "distro$index.default" 'no' }
    if ($row.Usable) { Add-AiSmPair $pairs "distro$index.usable" 'yes' } else { Add-AiSmPair $pairs "distro$index.usable" 'no' }
}

if ($rows.Count -eq 0) {
    Complete-Probe 'no' 'WSL is present but no Linux distribution is installed. Open PowerShell AS ADMINISTRATOR, run:  wsl --install -d Ubuntu  then restart Windows and run this Setup again.'
}
if ($wsl2.Count -eq 0) {
    Complete-Probe 'no' 'No usable WSL 2 distribution found (this app cannot run on WSL 1). Convert one with:  wsl --set-version <name> 2  then run this Setup again.'
}

Complete-Probe 'yes' ''
