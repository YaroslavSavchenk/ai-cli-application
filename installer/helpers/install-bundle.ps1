<#
install-bundle.ps1 - unpack the Linux bundle inside the chosen distro and
point `current` at it. The one helper that WRITES inside WSL.

  install-bundle.ps1 -Distro Ubuntu-24.04 -AppDir /home/you/.ai-session-manager/app
                     -Version v0.2.0 -Tarball C:\...\bundle.tar.gz
                     [-DataDir /home/you/.ai-session-manager]
                     [-ConfigDir C:\...\AI Session Manager]
                     [-ResultFile C:\...\res.txt] [-DryRun]

What it does, in order:
  1. validates every argument against the shared allow-list FIRST
     (config-common.ps1) - nothing else may reach a WSL command line;
  2. finds out whether a backend is RUNNING out of one of the version
     directories (runtime.json -> appDir + pid), so that directory is never
     pruned or overwritten;
  3. runs ONE constant shell script inside the distro with the tarball on
     STDIN, which unpacks into a staging dir, proves the bundle actually
     works on this machine (the bundled node imports the compiled node-pty),
     moves it into place, swaps `current` atomically and prunes old versions;
  4. writes launcher-config.json (what the launcher reads) and
     install-info.txt (what the uninstaller reads) beside the Windows
     launcher scripts.

What it never touches: the data directory. runtime.json, history.json,
prefs.json, github.json, projects.json and server.log all live in
<home>/.ai-session-manager/ - the app directory is the `app/` subdirectory,
and only that subtree is ever written or removed.

Result keys: ok, reason, distro, appDir, version, liveVersionDir,
installedDir, current, pruned, configFile, infoFile, errorCode, dryRun.
Exit code 1 on failure (the .iss aborts the installation on that).

Retention: `current`, the directory a live backend runs from, and ONE
previous version. Everything else under the app dir that carries a
bundle.json is removed. Reinstalling the EXACT version a live backend runs
from is refused (AI_SM_ERR=same_version_live, exit 31) rather than renamed
out from under the running process.

Quoting rules that make this safe (see helper-common.ps1 for the why):
wsl.exe is called with --exec, the constant script contains NO double quote,
and every interpolated value passed the allow-list, so nothing needs
escaping. The tarball travels on stdin because a Windows path (%TEMP%
usually has a space in it) must never appear on a Linux command line.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Distro,
    [Parameter(Mandatory)][string]$AppDir,
    [Parameter(Mandatory)][string]$Version,
    [Parameter(Mandatory)][string]$Tarball,
    [string]$DataDir,
    [string]$ConfigDir,
    [string]$ResultFile,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'helper-common.ps1')
. (Get-AiSmCommonPath -ScriptDir $PSScriptRoot)

$pairs = New-AiSmPairList

function Complete-Install {
    param([string]$Ok, [string]$Reason)
    $all = New-AiSmPairList
    Add-AiSmPair $all 'ok' $Ok
    Add-AiSmPair $all 'reason' $Reason
    foreach ($pair in $pairs) { [void]$all.Add($pair) }
    Write-AiSmResult -Path $ResultFile -Pairs $all.ToArray()
    foreach ($pair in $all) { Write-Host $pair }
    if ($Ok -eq 'yes') { exit 0 }
    exit 1
}

# ============================ the constant script ==========================
# Runs as: sh -c <this> sh <appdir> <version> <live-or-dash>
#
# NO DOUBLE QUOTE may appear below - this text is delimited by double quotes
# on the Windows command line, and .NET 4.8 has no argument-array API. Single
# quotes are fine: they reach sh untouched and mean what they mean there.
# Unquoted $appdir / $ver expansions are safe for the same reason the command
# line is: both passed the allow-list, so neither can contain a space, a
# quote or a metacharacter.
#
# `fail` is what keeps a failed install from leaving a half-unpacked staging
# directory (tens of megabytes) behind: every step that can fail routes
# through it, and it removes the staging dir before reporting the reason.
#
# `ls -1dtc` sorts by CTIME, not mtime: extraction restores the mtime the
# directory had on the build machine, while the `mv` into place stamps the
# ctime with the moment it was installed here - which is the order retention
# actually means. Known limit: ctime granularity is a clock tick (~4 ms), so
# two installs landing inside one tick TIE, and GNU ls then breaks the tie by
# NAME, ascending - retention can drop the wrong one of those two. Harmless in
# practice (a human runs Setup), never a data-dir risk. `current` and every
# other symlink is skipped (-L), or the link would count as one of the kept
# directories and push a real one out.
#
# The node-pty import is the acceptance test of the whole bundle: it is a
# native module compiled against a specific glibc and a specific Node ABI, so
# if it loads here, the app runs on this machine. It is spelled
# `node -e 'require(process.argv[1])' node-pty` because the module name then
# travels as an ARGUMENT - no double quote (banned) and no nested single
# quote (impossible inside a single-quoted sh word) is needed to name it.
$AiSmUnpackScript = @'
set -e
appdir=$1
ver=$2
live=$3
umask 022
stage=$appdir/.incoming.$$
fail() { cd /; rm -rf $stage; echo AI_SM_ERR=$1; exit $2; }
mkdir -p $appdir || fail mkdir_failed 21
rm -rf $appdir/.incoming.* $appdir/.current.new.*
mkdir $stage || fail stage_failed 22
tar -xzf - -C $stage || fail untar_failed 23
test -f $stage/$ver/bundle.json || fail no_bundle_json 24
test -x $stage/$ver/node/bin/node || fail no_node 25
cd $stage/$ver || fail no_version_dir 26
./node/bin/node -e 'require(process.argv[1])' node-pty || fail node_pty_failed 27
cd $appdir
if [ $live = $ver ]; then fail same_version_live 31; fi
if [ -d $appdir/$ver ]; then rm -rf $appdir/$ver.old; mv $appdir/$ver $appdir/$ver.old; fi
mv $stage/$ver $appdir/$ver || fail move_failed 28
rm -rf $stage
ln -s $ver $appdir/.current.new.$$ || fail symlink_failed 29
mv -T $appdir/.current.new.$$ $appdir/current || fail current_swap_failed 30
n=0
ls -1dtc -- */ 2>/dev/null | while IFS= read -r d; do
  b=${d%/}
  case $b in *[!A-Za-z0-9._+-]*) continue;; esac
  case $b in .|..|-*) continue;; esac
  if [ -L $b ]; then continue; fi
  if [ $b = $ver ]; then continue; fi
  if [ $b = $ver.old ]; then continue; fi
  if [ $b = $live ]; then continue; fi
  test -f $b/bundle.json || continue
  n=$((n+1))
  if [ $n -le 1 ]; then continue; fi
  rm -rf ./$b
  echo AI_SM_PRUNED=$b
done
if [ $live != $ver ]; then rm -rf $appdir/$ver.old; fi
echo AI_SM_INSTALLED=$appdir/$ver
echo AI_SM_OK
'@
# ===========================================================================

# --- 1. validate every argument before anything runs -----------------------

Add-AiSmPair $pairs 'distro' $Distro
Add-AiSmPair $pairs 'appDir' $AppDir
Add-AiSmPair $pairs 'version' $Version

if (-not (Test-AiSmDistroName $Distro)) {
    Complete-Install 'no' "The distro name '$Distro' is not usable (letters, digits, '.', '_' and '-' only)."
}
if (-not (Test-AiSmLinuxPath $AppDir)) {
    Complete-Install 'no' "The app directory must be an absolute Linux path built from letters, digits, '.', '_', '-' and '/', got: $AppDir"
}
$segments = @($AppDir.Split('/') | Where-Object { $_ -ne '' })
foreach ($segment in $segments) {
    if ($segment -eq '.' -or $segment -eq '..') {
        Complete-Install 'no' "The app directory may not contain a '.' or '..' path segment, got: $AppDir"
    }
}
# Ends in /app, with at least TWO segments above it - EXACTLY the rule the
# uninstaller enforces (uninstall-wsl.ps1: ends in /app, >= 3 segments), which
# is what makes an opt-in removal of the app directory checkable at all
# ("does this path look like ours?"); a looser rule here would install into a
# path the uninstaller must then refuse to remove.
if ($segments.Count -lt 3 -or $segments[$segments.Count - 1] -ne 'app') {
    Complete-Install 'no' "The app directory must end in /app, with at least two segments above it, for example /home/you/.ai-session-manager/app - got: $AppDir"
}
if (-not (Test-AiSmBundleVersion $Version)) {
    Complete-Install 'no' "'$Version' is not a usable bundle version (it must start with a digit or v<digit>)."
}
if ($DataDir -and -not (Test-AiSmLinuxPath $DataDir)) {
    Complete-Install 'no' "The data directory must be an absolute Linux path without spaces, got: $DataDir"
}
if (-not $DryRun -and -not (Test-Path -LiteralPath $Tarball)) {
    Complete-Install 'no' "The bundle archive was not found at $Tarball."
}

# --- 2. which version directory is a RUNNING backend using? ----------------
# runtime.json names the app root the live process was loaded from (a
# realpath, so never `current`). That directory must survive this install
# even when it is the oldest one on disk.

function Get-AiSmLiveVersionDir {
    if (-not $DataDir) { return '' }
    $read = Invoke-AiSmWsl -CommandLine ('-d ' + $Distro + ' --exec cat ' + $DataDir + '/runtime.json') -TimeoutSec 120
    if ($read.ExitCode -ne 0 -or -not $read.StdOut.Trim()) { return '' }
    try {
        $runtime = $read.StdOut | ConvertFrom-Json
    } catch {
        return ''
    }
    $livePid = 0
    if (-not [int]::TryParse([string]$runtime.pid, [ref]$livePid)) { return '' }
    if ($livePid -lt 1) { return '' }
    $liveDir = [string]$runtime.appDir
    if (-not (Test-AiSmLinuxPath $liveDir)) { return '' }
    if (-not $liveDir.StartsWith($AppDir + '/')) { return '' }
    $tail = $liveDir.Substring($AppDir.Length + 1)
    if ($tail.Contains('/')) { return '' }
    # A stale runtime.json (crash, SIGKILL) must not protect anything, so the
    # pid has to still exist.
    $alive = Invoke-AiSmWsl -CommandLine ('-d ' + $Distro + ' --exec kill -0 ' + $livePid) -TimeoutSec 120
    if ($alive.ExitCode -ne 0) { return '' }
    return $tail
}

$live = ''
if (-not $DryRun) {
    try {
        $live = Get-AiSmLiveVersionDir
    } catch {
        $live = ''
    }
}
if (-not $live) { $live = '-' }
Add-AiSmPair $pairs 'liveVersionDir' $live

# --- 3. run it -------------------------------------------------------------

$script = ConvertTo-AiSmScriptLine -Script $AiSmUnpackScript
$cmdline = '-d ' + $Distro + ' --exec sh -c "' + $script + '" sh ' + $AppDir + ' ' + $Version + ' ' + $live

if ($DryRun) {
    Write-Host 'DRYRUN-CMDLINE-BEGIN'
    Write-Host ('wsl.exe ' + $cmdline)
    Write-Host 'DRYRUN-CMDLINE-END'
    Write-Host ('DRYRUN-STDIN=' + $Tarball)
    Add-AiSmPair $pairs 'dryRun' 'yes'
    Add-AiSmPair $pairs 'installedDir' "$AppDir/$Version"
    Add-AiSmPair $pairs 'current' "$AppDir/current"
    if ($ConfigDir) {
        Add-AiSmPair $pairs 'configFile' (Join-Path $ConfigDir 'launcher-config.json')
        Add-AiSmPair $pairs 'infoFile' (Join-Path $ConfigDir 'install-info.txt')
    }
    Complete-Install 'yes' ''
}

$res = Invoke-AiSmWsl -CommandLine $cmdline -StdInFile $Tarball -TimeoutSec 1800
$stdout = $res.StdOut
if ($res.ExitCode -ne 0 -or ($stdout -notmatch 'AI_SM_OK')) {
    $code = ''
    if ($stdout -match 'AI_SM_ERR=([A-Za-z0-9_]+)') { $code = $matches[1] }
    $detail = $res.StdErr.Trim()
    if ($detail.Length -gt 400) { $detail = $detail.Substring(0, 400) }
    $why = "the install step inside '$Distro' failed (exit $($res.ExitCode))"
    switch ($code) {
        'untar_failed' { $why = "the bundle archive could not be unpacked inside '$Distro'" }
        'no_bundle_json' { $why = "the archive does not contain $Version/bundle.json" }
        'no_node' { $why = 'the archive contains no runnable node binary' }
        'node_pty_failed' { $why = "this bundle does not run in '$Distro' (its terminal library failed to load - the distribution may be too old)" }
        'same_version_live' { $why = 'this exact version is running - close the app window (or use Restart backend in its settings), then run Setup again' }
        'current_swap_failed' { $why = "the 'current' link could not be updated" }
    }
    Add-AiSmPair $pairs 'errorCode' $code
    Complete-Install 'no' "$why. $detail"
}

$pruned = @()
foreach ($line in ($stdout -split "`n")) {
    if ($line -match 'AI_SM_PRUNED=([^\s]+)') { $pruned += $matches[1] }
}
Add-AiSmPair $pairs 'installedDir' "$AppDir/$Version"
Add-AiSmPair $pairs 'current' "$AppDir/current"
Add-AiSmPair $pairs 'pruned' ($pruned -join ',')

# --- 4. launcher-config.json ----------------------------------------------
# The installed launcher scripts are on a plain Windows path, so they can
# derive nothing from their own location: this file is the only thing that
# tells them which distro and which app directory they belong to. Both values
# passed the allow-list above, so the JSON needs no escaping - and the
# launcher re-validates them anyway.

if ($ConfigDir) {
    try {
        $written = Write-AiSmLauncherConfig -ConfigDir $ConfigDir -Distro $Distro -AppDir $AppDir -Version $Version
    } catch {
        Complete-Install 'no' "The app was installed inside '$Distro', but the launcher configuration could not be written to $ConfigDir ($($_.Exception.Message))."
    }
    Add-AiSmPair $pairs 'configFile' $written.ConfigFile
    Add-AiSmPair $pairs 'infoFile' $written.InfoFile
}

Complete-Install 'yes' ''
