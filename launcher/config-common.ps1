<#
config-common.ps1 - shared distro / repo-path resolution for the launcher.

Dot-sourced by launch.ps1 and make-shortcut.ps1 so the two can never
disagree about which distro and which clone they are talking about.

Why this exists: both scripts used to hardcode the author's distro
('Ubuntu-24.04') and clone ('/home/sava/projects/ai-cli-application'), so a
downloaded copy started the wrong repo in the wrong distro until the user
edited the scripts. Both scripts live INSIDE the repo, and Windows sees
them through the WSL share, so their own location already states both
values:

  \\wsl.localhost\<distro>\<linux path>\launcher   (also \\wsl$\<distro>\...)

$PSScriptRoot has that UNC form both when a script is started from the
share in Windows and when it is started via powershell.exe interop from
inside WSL (Windows maps the WSL cwd to its UNC form).

Precedence, highest first:
  1. AI_SM_DISTRO / AI_SM_REPO_PATH environment variables (used by tests)
  2. derived from $PSScriptRoot (the normal case for any clone)
  3. the hardcoded defaults each script passes in (last resort: only
     reachable when the launcher folder was copied OUT of the repo onto a
     normal drive path, where nothing can be derived)

Safety: the derived values are NOT trusted here. They are returned as
plain strings and must pass the caller's allow-list validation
(`^/[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$` for the path,
`^[A-Za-z0-9._-]+$` for the distro) BEFORE first use - that regex is the
injection-safety gate, since config values are the only strings that ever
reach a WSL command line. Nothing here decodes, unescapes or normalizes a
UNC segment; segments are taken literally exactly as Windows reports them,
so no decoding step can smuggle a character past that gate.

Deliberate: once the location IS a WSL UNC path, derivation always wins
over the built-in defaults, even when what it derives is unusable (a path
with a space, say). Falling back to the defaults there would start a
backend for a repo the user does not have.
#>

function Get-AiSmLocationConfig {
    <#
    Derives @{ Distro; RepoPath } from a launcher directory path, or $null
    when that path is not a WSL UNC path (e.g. C:\tools\launcher - someone
    copied the folder out of the repo).
    #>
    param([string]$ScriptRoot)

    if (-not $ScriptRoot) { return $null }

    # A provider-qualified location (PowerShell sometimes reports
    # 'Microsoft.PowerShell.Core\FileSystem::\\wsl.localhost\...') is the
    # same path with a prefix; strip it before matching.
    $path = $ScriptRoot
    $providerPrefix = 'Microsoft.PowerShell.Core\FileSystem::'
    if ($path.StartsWith($providerPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        $path = $path.Substring($providerPrefix.Length)
    }

    $prefix = $null
    foreach ($candidate in @('\\wsl.localhost\', '\\wsl$\')) {
        if ($path.StartsWith($candidate, [System.StringComparison]::OrdinalIgnoreCase)) {
            $prefix = $candidate
            break
        }
    }
    if (-not $prefix) { return $null }

    # Everything after the prefix: <distro>\<linux path segments...>\launcher
    $segments = @(($path.Substring($prefix.Length) -split '\\') | Where-Object { $_ -ne '' })
    # Need at least a distro plus one path segment; a bare \\wsl.localhost\<distro>
    # states no repo at all, so let the caller keep its defaults.
    if ($segments.Count -lt 2) { return $null }

    $distro   = $segments[0]
    $pathSegs = @($segments[1..($segments.Count - 1)])

    # Drop the trailing 'launcher' folder: the repo is its parent. Compared
    # case-insensitively because Windows may hand back the casing the user
    # typed; a folder that is not named 'launcher' is kept as-is (whatever
    # it is, it is what the caller is running from).
    if ($pathSegs[-1] -ieq 'launcher') {
        if ($pathSegs.Count -eq 1) { $pathSegs = @() }
        else { $pathSegs = @($pathSegs[0..($pathSegs.Count - 2)]) }
    }

    # No normalization, no decoding - segments verbatim. An empty result
    # ('/' - a launcher folder sitting at the distro root) is returned as
    # such and dies on the caller's allow-list, which is the point.
    [pscustomobject]@{
        Distro   = $distro
        RepoPath = '/' + ($pathSegs -join '/')
    }
}

function Resolve-AiSmConfig {
    <#
    Applies the precedence and reports where each value came from.
    Returns @{ Distro; DistroSource; RepoPath; RepoPathSource } with sources
    'AI_SM_DISTRO' / 'AI_SM_REPO_PATH', 'launcher location', or 'built-in
    default'. Values are unvalidated by design - the caller gates them.
    #>
    param(
        [string]$ScriptRoot,
        [Parameter(Mandatory)][string]$DefaultDistro,
        [Parameter(Mandatory)][string]$DefaultRepoPath
    )

    $derived = Get-AiSmLocationConfig -ScriptRoot $ScriptRoot

    if ($env:AI_SM_DISTRO) {
        $distro = $env:AI_SM_DISTRO
        $distroSource = 'AI_SM_DISTRO'
    } elseif ($derived) {
        $distro = $derived.Distro
        $distroSource = 'launcher location'
    } else {
        $distro = $DefaultDistro
        $distroSource = 'built-in default'
    }

    if ($env:AI_SM_REPO_PATH) {
        $repoPath = $env:AI_SM_REPO_PATH
        $repoPathSource = 'AI_SM_REPO_PATH'
    } elseif ($derived) {
        $repoPath = $derived.RepoPath
        $repoPathSource = 'launcher location'
    } else {
        $repoPath = $DefaultRepoPath
        $repoPathSource = 'built-in default'
    }

    [pscustomobject]@{
        Distro         = $distro
        DistroSource   = $distroSource
        RepoPath       = $repoPath
        RepoPathSource = $repoPathSource
    }
}

function Format-AiSmConfigLine {
    # One line naming both values and where they came from.
    param([Parameter(Mandatory)][psobject]$Config)

    if ($Config.DistroSource -eq $Config.RepoPathSource) {
        return "Config: distro '$($Config.Distro)', repo '$($Config.RepoPath)' (from $($Config.DistroSource))"
    }
    "Config: distro '$($Config.Distro)' (from $($Config.DistroSource)), repo '$($Config.RepoPath)' (from $($Config.RepoPathSource))"
}

function Get-AiSmConfigHint {
    # What to do about a config value the allow-list rejected, phrased for
    # where that value actually came from.
    param(
        [Parameter(Mandatory)][string]$Source,
        [Parameter(Mandatory)][ValidateSet('Distro', 'RepoPath')][string]$Kind,
        # The distro name passed the allow-list but wsl.exe does not know it:
        # the character-set advice would be wrong, the name itself is the issue.
        [switch]$NotInstalled
    )

    $envVar = if ($Kind -eq 'Distro') { 'AI_SM_DISTRO' } else { 'AI_SM_REPO_PATH' }
    if ($NotInstalled) {
        if ($Source -eq 'launcher location') {
            return ('The distro name was derived from where the launcher itself lives ' +
                '(\\wsl.localhost\<distro>\...). Run the launcher from inside the distro that ' +
                "holds the repo, or set $envVar to one of the installed names.")
        }
        if ($Source -eq $envVar) { return "Set $envVar to one of the installed names, or unset it." }
        return "Edit the default in the config block at the top of this script, or set $envVar to one of the installed names."
    }
    switch ($Source) {
        'launcher location' {
            if ($Kind -eq 'RepoPath') {
                return ("This path was derived from where the launcher itself lives. Clone the repo " +
                    "into a path built only from letters, digits, '.', '_', '-' and '/' (no spaces). " +
                    "Setting $envVar is no way around this: an override is checked against exactly " +
                    'the same character set.')
            }
            return ("The distro name was derived from where the launcher itself lives. $envVar is " +
                "checked against exactly the same character set (letters, digits, '.', '_' and " +
                "'-'), so it only helps for a name that passes it (wsl.exe -l -q lists them); a " +
                'distro whose name holds other characters has to be re-imported under a plain one ' +
                '(wsl --export, then wsl --import).')
        }
        default {
            if ($Source -eq $envVar) { return "Fix or unset the $envVar environment variable." }
            return "Edit the defaults in the config block at the top of this script, or set $envVar."
        }
    }
}
