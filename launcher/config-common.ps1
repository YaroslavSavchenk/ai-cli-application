<#
config-common.ps1 - shared distro / repo-path resolution for the launcher.

Dot-sourced by launch.ps1 and make-shortcut.ps1 so the two can never
disagree about which distro and which clone they are talking about.

Why this exists: both scripts used to hardcode one machine's distro name and
clone path, so a downloaded copy started the wrong repo in the wrong distro
until the user edited the scripts. Both scripts live INSIDE the repo, and Windows sees
them through the WSL share, so their own location already states both
values:

  \\wsl.localhost\<distro>\<linux path>\launcher   (also \\wsl$\<distro>\...)

$PSScriptRoot has that UNC form both when a script is started from the
share in Windows and when it is started via powershell.exe interop from
inside WSL (Windows maps the WSL cwd to its UNC form).

Precedence, highest first:
  1. AI_SM_DISTRO / AI_SM_REPO_PATH environment variables (used by tests)
  2. launcher-config.json next to the scripts (written by the Windows
     Setup, which knows the distro and the WSL app path it just installed
     into; a corrupt one is an ERROR, never a silent fall-through)
  3. derived from $PSScriptRoot (the normal case for any clone)
  4. the defaults each script passes in - EMPTY since the installer exists,
     so a launcher that can resolve nothing says so instead of starting
     someone else's repo (Get-AiSmNoConfigMessage)

Safety: no value resolved here is trusted - not the derived one, not the
one the installer wrote. They are returned as plain strings and must pass
the allow-list validation below (Test-AiSmLinuxPath / Test-AiSmDistroName)
BEFORE first use - those two regexes are the injection-safety gate, since
config values are the only strings that ever reach a WSL command line.
They live HERE and nowhere else: launch.ps1, make-shortcut.ps1 and every
installer helper call the same two functions, so no second copy can drift.
Nothing here decodes, unescapes or normalizes a UNC segment; segments are
taken literally exactly as Windows reports them, so no decoding step can
smuggle a character past that gate.

Deliberate: once the location IS a WSL UNC path, derivation always wins
over the built-in defaults, even when what it derives is unusable (a path
with a space, say). Falling back to the defaults there would start a
backend for a repo the user does not have.
#>

# =========================== allow-list patterns ===========================
# The ONE definition of what may reach a WSL command line. launch.ps1,
# make-shortcut.ps1 and installer\helpers\*.ps1 all gate on these through the
# Test-* functions below - never on a copy of the regex. Deliberately narrow:
# no spaces, no quotes, no shell metacharacters, so a value that passes needs
# no escaping wherever it is used.
#
# They end in \z, never in $: in .NET, `$` also matches BEFORE a trailing
# newline, so '/home/you/app' + LF would pass a `$`-anchored gate and reach a
# command line with the newline still on it. \z is the end of the string and
# nothing else.

$AiSmRepoPathPattern = '^/[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*\z'
$AiSmDistroPattern   = '^[A-Za-z0-9._-]+\z'
# Same as the repo path, but a leading '~' is allowed (the distro's own shell
# expands it) - used for the backend data dir only.
$AiSmDataDirPattern  = '^(~)?(/[A-Za-z0-9._-]+)+\z'
# Written by the Windows Setup beside the launcher scripts.
$AiSmConfigFileName  = 'launcher-config.json'

function Test-AiSmLinuxPath {
    # $true for an absolute Linux path made only of letters, digits, '.', '_',
    # '-' and '/'. Empty/absent is $false: "nothing configured" is not a path.
    param([string]$Path)
    if (-not $Path) { return $false }
    return [bool]($Path -match $AiSmRepoPathPattern)
}

function Test-AiSmDistroName {
    param([string]$Name)
    if (-not $Name) { return $false }
    return [bool]($Name -match $AiSmDistroPattern)
}

function Test-AiSmDataDir {
    param([string]$Path)
    if (-not $Path) { return $false }
    return [bool]($Path -match $AiSmDataDirPattern)
}

function Get-AiSmFileConfig {
    <#
    Reads launcher-config.json from $Dir - the file the Windows Setup writes
    beside the installed launcher scripts:

        { "distro": "Ubuntu-24.04", "appPath": "/home/you/.ai-session-manager/app/current" }

    Returns $null when the directory is not given or the file is absent (the
    developer-clone case: nothing to read, carry on deriving).

    THROWS when the file exists but cannot be believed - unreadable, not JSON,
    not a JSON object, a key that is not a non-empty string. A corrupt config
    must never fall through to a derived value or a default: the installed
    launcher would then quietly talk to a different distro or a different app
    directory than the one it was installed for. Extra keys are ignored, and
    an object stating NEITHER key resolves to nothing at all (both members
    $null), which the caller treats as "not stated" rather than as an error.

    Values are returned VERBATIM and are NOT validated here - the caller runs
    them through Test-AiSmLinuxPath / Test-AiSmDistroName exactly like every
    other source, so a hand-edited config file is no way around the allow-list.
    #>
    param([string]$Dir)

    if (-not $Dir) { return $null }
    $file = Join-Path $Dir $AiSmConfigFileName
    if (-not (Test-Path -LiteralPath $file)) { return $null }

    try {
        $raw = Get-Content -LiteralPath $file -Raw -ErrorAction Stop
    } catch {
        throw "Could not read $file ($($_.Exception.Message)). $(Get-AiSmConfigFileAdvice)"
    }
    if ($null -eq $raw -or $raw.Trim() -eq '') {
        throw "$file is empty. $(Get-AiSmConfigFileAdvice)"
    }
    try {
        $json = $raw | ConvertFrom-Json
    } catch {
        throw "$file is not valid JSON ($($_.Exception.Message)). $(Get-AiSmConfigFileAdvice)"
    }
    # ConvertFrom-Json hands back a String/Int32/Boolean/Object[] for a JSON
    # scalar or array; only an object can be a config.
    if ($json -isnot [System.Management.Automation.PSCustomObject]) {
        throw "$file must contain a JSON object. $(Get-AiSmConfigFileAdvice)"
    }

    $distro   = $null
    $appPath  = $null
    $names    = @($json.PSObject.Properties.Name)
    foreach ($pair in @(@('distro', 'Distro'), @('appPath', 'RepoPath'))) {
        $key = $pair[0]
        if ($names -notcontains $key) { continue }
        $value = $json.$key
        if ($null -eq $value -or $value -isnot [string] -or $value.Trim() -eq '') {
            throw "${file}: `"$key`" must be a non-empty string. $(Get-AiSmConfigFileAdvice)"
        }
        if ($pair[1] -eq 'Distro') { $distro = $value } else { $appPath = $value }
    }

    [pscustomobject]@{
        Distro   = $distro
        RepoPath = $appPath
        File     = $file
    }
}

function Get-AiSmConfigFileAdvice {
    # One sentence, used by every launcher-config.json failure.
    "The Windows Setup wrote this file; re-run the Setup (or reinstall) to restore it, or delete it and set AI_SM_DISTRO / AI_SM_REPO_PATH instead."
}

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
    'AI_SM_DISTRO' / 'AI_SM_REPO_PATH', 'config file', 'launcher location',
    or 'built-in default'. Values are unvalidated by design - the caller
    gates them with Test-AiSmDistroName / Test-AiSmLinuxPath.

    -ConfigDir is where launcher-config.json is looked for (the installed
    launcher passes its own $PSScriptRoot). Omit it and no file is read.
    A corrupt file THROWS out of here; the caller turns that into one clear
    error rather than starting the wrong backend.
    #>
    param(
        [string]$ScriptRoot,
        [string]$ConfigDir,
        # AllowEmptyString: the built-in defaults ARE empty now (an installed
        # or downloaded launcher must resolve its config, never inherit the
        # author's), and Mandatory alone rejects ''.
        [Parameter(Mandatory)][AllowEmptyString()][string]$DefaultDistro,
        [Parameter(Mandatory)][AllowEmptyString()][string]$DefaultRepoPath
    )

    $derived = Get-AiSmLocationConfig -ScriptRoot $ScriptRoot
    $file = $null
    if ($ConfigDir) { $file = Get-AiSmFileConfig -Dir $ConfigDir }

    if ($env:AI_SM_DISTRO) {
        $distro = $env:AI_SM_DISTRO
        $distroSource = 'AI_SM_DISTRO'
    } elseif ($file -and $file.Distro) {
        $distro = $file.Distro
        $distroSource = 'config file'
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
    } elseif ($file -and $file.RepoPath) {
        $repoPath = $file.RepoPath
        $repoPathSource = 'config file'
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
    if ($Source -eq 'config file') {
        # An installed launcher: the value came from launcher-config.json, so
        # neither re-cloning nor editing a script default means anything here.
        if ($NotInstalled) {
            return ("The distro name comes from $AiSmConfigFileName next to the launcher. " +
                "$(Get-AiSmConfigFileAdvice)")
        }
        if ($Kind -eq 'RepoPath') {
            return ("This path comes from `"appPath`" in $AiSmConfigFileName next to the launcher. " +
                "$(Get-AiSmConfigFileAdvice)")
        }
        return ("This distro name comes from `"distro`" in $AiSmConfigFileName next to the launcher. " +
            "$(Get-AiSmConfigFileAdvice)")
    }
    if ($NotInstalled) {
        if ($Source -eq 'launcher location') {
            return ('The distro name was derived from where the launcher itself lives ' +
                '(\\wsl.localhost\<distro>\...). Run the launcher from inside the distro that ' +
                "holds the repo, or set $envVar to one of the installed names.")
        }
        if ($Source -eq $envVar) { return "Set $envVar to one of the installed names, or unset it." }
        return "Set $envVar to one of the installed names, or re-run the Setup so it writes the right one into $AiSmConfigFileName."
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
            return "Set $envVar, or run the launcher from inside its own installation (the Setup writes $AiSmConfigFileName next to these scripts)."
        }
    }
}

function Get-AiSmNoConfigMessage {
    <#
    What to say when NOTHING resolved: no environment variable, no
    launcher-config.json, no derivable \\wsl.localhost location, and empty
    built-in defaults. This is the shape a launcher folder copied onto a
    plain Windows path has - it used to silently start the author's clone.
    #>
    param([string]$ConfigDir)

    $where = if ($ConfigDir) { Join-Path $ConfigDir $AiSmConfigFileName } else { $AiSmConfigFileName }
    ("No launcher configuration found: this launcher does not know which WSL distro or which app " +
        "directory to use.`n" +
        "Fix it in one of these ways:`n" +
        "  - install the app with the Setup, which writes $where;`n" +
        "  - run these scripts from inside the repo through the WSL share " +
        "(\\wsl.localhost\<distro>\<path>\launcher), which states both;`n" +
        "  - set the AI_SM_DISTRO and AI_SM_REPO_PATH environment variables.")
}

function Move-AiSmHostNext {
    <#
    Promotes an updated native host from <HostDir>\next\ into <HostDir>\.

    Why it exists: the Windows Setup writes the host exe and its three
    WebView2 DLLs to {app}\host\next instead of {app}\host, because an
    in-app update runs that Setup while the OLD host window is still open
    and holding those files. The next launch - by which time the old window
    is gone - moves them into place, before the host is started.

    Contract, in order of importance:

      1. It NEVER fails a launch. Every failure mode ends in one printed
         line and a return value; the caller starts the host it has.
      2. A file that cannot be copied (the old host still running, a
         virus scanner holding it open) leaves next\ COMPLETELY intact, so
         the next launch tries the whole set again. Half a promoted host -
         a new exe beside old DLLs - would be worse than an old one.
      3. Nothing is deleted before every file has been copied.

    Returns 'none' (no next\ to promote), 'promoted' (every file copied,
    next\ removed) or 'kept' (something was in use; next\ left for the next
    launch).
    #>
    param([Parameter(Mandatory)][string]$HostDir)

    $next = Join-Path $HostDir 'next'
    if (-not (Test-Path -LiteralPath $next)) { return 'none' }

    try {
        # Top-level files only: the host is four flat files beside each other,
        # and a directory inside next\ is not something this ever produced.
        $files = @(Get-ChildItem -LiteralPath $next -File -ErrorAction Stop)
    } catch {
        Write-Host "Native host: could not read $next ($($_.Exception.Message)) - starting the host that is installed."
        return 'kept'
    }

    foreach ($file in $files) {
        $target = Join-Path $HostDir $file.Name
        # Three tries, 200 ms apart: a sharing violation right after the old
        # window closed is usually over in well under a second, and a launch
        # may not wait longer than that for a cosmetic upgrade.
        $copied = $false
        $lastError = ''
        for ($attempt = 1; $attempt -le 3; $attempt++) {
            try {
                Copy-Item -LiteralPath $file.FullName -Destination $target -Force -ErrorAction Stop
                $copied = $true
                break
            } catch {
                $lastError = $_.Exception.Message
                if ($attempt -lt 3) { Start-Sleep -Milliseconds 200 }
            }
        }
        if (-not $copied) {
            Write-Host "Native host: $($file.Name) is in use ($lastError) - keeping the updated files in $next and starting the host that is installed."
            return 'kept'
        }
    }

    try {
        Remove-Item -LiteralPath $next -Recurse -Force -ErrorAction Stop
    } catch {
        # The files are already in place, so this is bookkeeping: the next
        # launch copies the same bytes over themselves and tries again.
        Write-Host "Native host: updated files are in place, but $next could not be removed ($($_.Exception.Message))."
    }
    Write-Host "Native host: updated to the version installed in $next."
    return 'promoted'
}
