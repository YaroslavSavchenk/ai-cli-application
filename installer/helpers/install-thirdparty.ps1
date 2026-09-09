<#
install-thirdparty.ps1 - install ONE third-party tool inside the distro,
only ever because the user ticked it on the consent page.

  install-thirdparty.ps1 -Distro Ubuntu-24.04 -Item claude
                         [-ResultFile C:\...\res.txt] [-DryRun]

Rules this helper exists to enforce:
  - one item per invocation, and -Item is a fixed list (ValidateSet), so
    nothing arbitrary can ever be run through it;
  - the EXACT command is printed before it runs, together with the host it
    downloads from, and both appear in the result file;
  - the Setup calls this only for boxes the user ticked - every box is off
    by default, and an untouched consent page installs nothing.

Items:
  claude  Claude Code, with Anthropic's own official installer:
          curl -fsSL https://claude.ai/install.sh | bash   (host claude.ai)
          Nothing is downloaded unless this runs.

Result keys: ok, reason, item, distro, command, host, claude=yes|no
(re-probed afterwards), dryRun. Exit code 1 on failure - a failed
third-party install is reported, but the .iss does NOT abort the app
installation for it.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Distro,
    [Parameter(Mandatory)][ValidateSet('claude')][string]$Item,
    [string]$ResultFile,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'helper-common.ps1')
. (Get-AiSmCommonPath -ScriptDir $PSScriptRoot)

$pairs = New-AiSmPairList

function Complete-ThirdParty {
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

# The command, verbatim, exactly as Anthropic documents it. NO DOUBLE QUOTE
# (it is delimited by one on the Windows command line); it is shown to the
# user before it runs and never assembled from anything the user typed.
$AiSmClaudeCommand = 'curl -fsSL https://claude.ai/install.sh | bash'
$AiSmClaudeHost = 'claude.ai'

# Re-probe afterwards so the result says what actually happened rather than
# what the installer script claimed.
$AiSmClaudeCheckScript = @'
if command -v claude >/dev/null 2>&1; then echo AISM_CLAUDE=yes; elif [ -x $HOME/.local/bin/claude ]; then echo AISM_CLAUDE=yes; else echo AISM_CLAUDE=no; fi
'@

Add-AiSmPair $pairs 'item' $Item
Add-AiSmPair $pairs 'distro' $Distro
Add-AiSmPair $pairs 'command' $AiSmClaudeCommand
Add-AiSmPair $pairs 'host' $AiSmClaudeHost

if (-not (Test-AiSmDistroName $Distro)) {
    Complete-ThirdParty 'no' "The distro name '$Distro' is not usable (letters, digits, '.', '_' and '-' only)."
}

# bash -lc: the official installer expects a login-shell environment and puts
# the binary in ~/.local/bin, which Ubuntu's ~/.profile adds to PATH.
$cmdline = '-d ' + $Distro + ' --exec bash -lc "' + (ConvertTo-AiSmScriptLine -Script $AiSmClaudeCommand) + '"'

Write-Host "Installing Claude Code inside '$Distro' with Anthropic's official installer."
Write-Host "  command: $AiSmClaudeCommand"
Write-Host "  source:  https://$AiSmClaudeHost"

if ($DryRun) {
    Write-Host 'DRYRUN-CMDLINE-BEGIN'
    Write-Host ('wsl.exe ' + $cmdline)
    Write-Host 'DRYRUN-CMDLINE-END'
    Add-AiSmPair $pairs 'dryRun' 'yes'
    Complete-ThirdParty 'yes' ''
}

$res = Invoke-AiSmWsl -CommandLine $cmdline -TimeoutSec 900
$check = Invoke-AiSmWsl -CommandLine ('-d ' + $Distro + ' --exec bash -lc "' + (ConvertTo-AiSmScriptLine -Script $AiSmClaudeCheckScript) + '"') -TimeoutSec 180
$present = 'no'
if ($check.StdOut -match 'AISM_CLAUDE=yes') { $present = 'yes' }
Add-AiSmPair $pairs 'claude' $present

if ($present -eq 'yes') { Complete-ThirdParty 'yes' '' }

$detail = $res.StdErr.Trim()
if (-not $detail) { $detail = $res.StdOut.Trim() }
if ($detail.Length -gt 400) { $detail = $detail.Substring(0, 400) }
Complete-ThirdParty 'no' "Claude Code was not installed (exit $($res.ExitCode)). $detail You can install it yourself later: $AiSmClaudeCommand"
