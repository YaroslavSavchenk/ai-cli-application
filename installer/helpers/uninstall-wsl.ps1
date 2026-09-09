<#
uninstall-wsl.ps1 - remove the app directory INSIDE the distro. Only ever
run when the user explicitly answered yes to the uninstaller's question,
which defaults to no.

  uninstall-wsl.ps1 -Distro Ubuntu-24.04 -AppDir /home/you/.ai-session-manager/app
                    [-ResultFile C:\...\res.txt] [-DryRun]

This is the one destructive operation in the whole installer, so the path is
gated four times before anything is deleted, twice on each side:

  1. it must pass the shared allow-list (absolute, no spaces, no quotes, no
     metacharacters) - config-common.ps1;
  2. no path segment may be '.' or '..' (the allow-list permits '.' as a
     character, so this is a separate check - see
     memory/knowledge/path-normalization-delete-primitive.md: the kernel
     resolves '..' even where a lexical check does not);
  3. it must end in /app and have at least TWO segments above it (a shell
     `case` pattern cannot express that - `*` matches slashes too - so the
     check strips /app and one more segment and refuses when nothing is
     left) - the data
     directory itself (/home/you/.ai-session-manager) can therefore never be
     named, and neither can /, /home, or /home/you;
  4. it must actually LOOK like ours: at least one <version>/bundle.json
     directly inside it. An empty or foreign directory is refused, not
     emptied.

Checks 2-4 are repeated inside the distro by the constant script, so a
disagreement between the two sides refuses rather than deletes. Only
<appdir> itself is removed - never its parent, and never the data directory
beside it (runtime.json, history.json, prefs.json, github.json,
projects.json, server.log all stay).

Result keys: ok, reason, distro, appDir, removed=yes|no, errorCode, dryRun.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Distro,
    [Parameter(Mandatory)][string]$AppDir,
    [string]$ResultFile,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'helper-common.ps1')
. (Get-AiSmCommonPath -ScriptDir $PSScriptRoot)

$pairs = New-AiSmPairList

function Complete-Uninstall {
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

# NO DOUBLE QUOTE. $1 is the app dir; the guards here mirror the PowerShell
# ones on purpose - this script is what actually runs `rm -rf`, so it re-earns
# the right to do so instead of trusting its caller.
$AiSmRemoveScript = @'
set -e
appdir=$1
case $appdir in
  /*) ;;
  *) echo AI_SM_ERR=not_absolute; exit 41;;
esac
case $appdir in
  */app) ;;
  *) echo AI_SM_ERR=not_app_dir; exit 42;;
esac
case $appdir in
  */../*|*/..|../*) echo AI_SM_ERR=dotdot; exit 43;;
esac
parent=${appdir%/app}
grand=${parent%/*}
case $grand in
  ''|/) echo AI_SM_ERR=too_shallow; exit 44;;
esac
if [ ! -d $appdir ]; then echo AI_SM_GONE=1; echo AI_SM_OK; exit 0; fi
found=0
for f in $appdir/*/bundle.json; do
  if [ -f $f ]; then found=1; fi
done
if [ $found = 0 ]; then echo AI_SM_ERR=no_bundle; exit 45; fi
rm -rf $appdir
if [ -d $appdir ]; then echo AI_SM_ERR=remove_failed; exit 46; fi
echo AI_SM_REMOVED=$appdir
echo AI_SM_OK
'@

Add-AiSmPair $pairs 'distro' $Distro
Add-AiSmPair $pairs 'appDir' $AppDir

if (-not (Test-AiSmDistroName $Distro)) {
    Complete-Uninstall 'no' "The distro name '$Distro' is not usable (letters, digits, '.', '_' and '-' only); nothing was removed."
}
if (-not (Test-AiSmLinuxPath $AppDir)) {
    Complete-Uninstall 'no' "Refusing to remove '$AppDir': it is not an absolute Linux path built from letters, digits, '.', '_', '-' and '/'."
}
$segments = @($AppDir.Split('/') | Where-Object { $_ -ne '' })
foreach ($segment in $segments) {
    if ($segment -eq '.' -or $segment -eq '..') {
        Complete-Uninstall 'no' "Refusing to remove '$AppDir': it contains a '.' or '..' path segment."
    }
}
if ($segments[$segments.Count - 1] -ne 'app') {
    Complete-Uninstall 'no' "Refusing to remove '$AppDir': the app directory must end in /app."
}
if ($segments.Count -lt 3) {
    Complete-Uninstall 'no' "Refusing to remove '$AppDir': it is too close to the root of the file system."
}

$cmdline = '-d ' + $Distro + ' --exec sh -c "' + (ConvertTo-AiSmScriptLine -Script $AiSmRemoveScript) + '" sh ' + $AppDir

if ($DryRun) {
    Write-Host 'DRYRUN-CMDLINE-BEGIN'
    Write-Host ('wsl.exe ' + $cmdline)
    Write-Host 'DRYRUN-CMDLINE-END'
    Add-AiSmPair $pairs 'dryRun' 'yes'
    Add-AiSmPair $pairs 'removed' 'no'
    Complete-Uninstall 'yes' ''
}

$res = Invoke-AiSmWsl -CommandLine $cmdline -TimeoutSec 600
if ($res.ExitCode -ne 0 -or ($res.StdOut -notmatch 'AI_SM_OK')) {
    $code = ''
    if ($res.StdOut -match 'AI_SM_ERR=([A-Za-z0-9_]+)') { $code = $matches[1] }
    $why = "the app directory inside '$Distro' could not be removed (exit $($res.ExitCode))"
    switch ($code) {
        'no_bundle' { $why = "'$AppDir' does not look like an installation of this app (no <version>/bundle.json inside it), so nothing was removed" }
        'not_app_dir' { $why = "'$AppDir' does not end in /app, so nothing was removed" }
        'too_shallow' { $why = "'$AppDir' is too close to the root of the file system, so nothing was removed" }
        'dotdot' { $why = "'$AppDir' contains a '..' segment, so nothing was removed" }
    }
    Add-AiSmPair $pairs 'errorCode' $code
    Add-AiSmPair $pairs 'removed' 'no'
    Complete-Uninstall 'no' $why
}

if ($res.StdOut -match 'AI_SM_GONE=1') {
    Add-AiSmPair $pairs 'removed' 'no'
    Complete-Uninstall 'yes' "'$AppDir' was already gone."
}
Add-AiSmPair $pairs 'removed' 'yes'
Complete-Uninstall 'yes' ''
