<#
helper-common.ps1 - the bits every installer helper needs.

Dot-sourced FIRST by wsl-probe.ps1, install-bundle.ps1,
install-thirdparty.ps1 and uninstall-wsl.ps1, which then dot-source
config-common.ps1 through Get-AiSmCommonPath. Everything the Setup decides,
parses or runs lives in those four helpers (PowerShell 5.1 - no `??`, no
ternary, no `ForEach-Object -Parallel`); the .iss holds the wizard, the
files and the icons and nothing else.

Contract with the .iss: every helper writes a plain `key=value` result file
(one pair per line, no quoting, values never contain a newline) that the
Pascal side reads with LoadStringsFromFile. `ok=yes|no` is always present;
`reason=<one line>` explains every `ok=no`. A helper that cannot even get
that far exits non-zero, and the Pascal side treats that as a hard failure.

The result file is written UTF-8 WITHOUT a BOM on purpose: Inno reads it as
plain lines, and a BOM would end up glued to the first key.
#>

function Get-AiSmCommonPath {
    <#
    Locates launcher\config-common.ps1 - the ONE definition of the allow-list
    patterns every helper gates its arguments on. Three layouts, in order:

      1. beside this file        - what Inno's ExtractTemporaryFile produces
                                   during the wizard (everything lands in {tmp})
      2. ..\config-common.ps1    - installed: {app}\helpers\ next to {app}\
      3. ..\..\launcher\...      - the repo (installer\helpers\ and launcher\)

    Throws when none exists: a helper that cannot validate its arguments must
    not run at all.
    #>
    param([string]$ScriptDir)

    if (-not $ScriptDir) { throw 'Get-AiSmCommonPath needs the helper directory.' }
    $candidates = @(
        (Join-Path $ScriptDir 'config-common.ps1'),
        (Join-Path (Split-Path -Parent $ScriptDir) 'config-common.ps1'),
        (Join-Path (Split-Path -Parent (Split-Path -Parent $ScriptDir)) 'launcher\config-common.ps1')
    )
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
    throw "config-common.ps1 not found (looked in: $($candidates -join '; '))."
}

# A bundle version, exactly as scripts/build-bundle.sh accepts it (and as
# server/bundle.ts re-validates it): it is a directory name inside the app dir
# and a `tar` member argument, so `.`, `..` and a leading `-` must be
# impossible. Anchored with \z, not `$` (which in .NET matches before a
# trailing newline as well - see config-common.ps1).
$AiSmVersionPattern = '^v?[0-9][A-Za-z0-9._+-]{0,63}\z'

function Test-AiSmBundleVersion {
    param([string]$Version)
    if (-not $Version) { return $false }
    return [bool]($Version -match $AiSmVersionPattern)
}

function Write-AiSmResult {
    <#
    Writes the key=value result file. $Pairs is an ordered list of
    'key=value' strings; callers build it with Add-AiSmPair so a stray
    newline in a value can never split one pair into two lines.
    #>
    param(
        [string]$Path,
        [string[]]$Pairs
    )
    if (-not $Path) { return }
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllLines($Path, [string[]]$Pairs, $utf8NoBom)
}

function Add-AiSmPair {
    # Appends 'key=value' to $List with the value flattened to one line.
    param(
        [System.Collections.ArrayList]$List,
        [string]$Key,
        $Value
    )
    $text = [string]$Value
    $text = $text -replace "`r", ''
    $text = $text -replace "`n", ' '
    [void]$List.Add("$Key=$text")
}

function New-AiSmPairList {
    New-Object System.Collections.ArrayList
}

function Invoke-AiSmWsl {
    <#
    Runs wsl.exe with a HAND-BUILT command line and returns
    @{ ExitCode; StdOut; StdErr; CommandLine }.

    Why hand-built: .NET Framework 4.8 (what PowerShell 5.1 uses) has no
    ProcessStartInfo.ArgumentList, and PowerShell's own native-argument
    re-quoting mangles anything with spaces or quotes. That is safe here ONLY
    because every value the caller interpolates has passed the allow-list in
    config-common.ps1 first - no spaces, no quotes, no metacharacters - and
    because the constant script itself contains no double quote, which is what
    delimits it on the Windows command line.

    --exec is mandatory. Without it, `wsl.exe -- <words>` re-joins the words
    into ONE line and hands it to the distro's DEFAULT SHELL, which expands it
    a second time: `$1`/`$2` arrive empty and `$(...)` in the script runs in
    the wrong shell (verified 2026-09-08 on WSL2 / Ubuntu-24.04). With --exec
    the argv is passed straight to execvp, so positional arguments and stdin
    behave exactly as written.

    $StdInFile streams a file into the child's stdin (the bundle tarball), so
    no Windows path - which may contain spaces, and %TEMP% usually does - ever
    appears on a Linux command line. stdout/stderr are read asynchronously
    while stdin is written, or a big tarball would deadlock on a full pipe.
    #>
    param(
        [Parameter(Mandatory)][string]$CommandLine,
        [string]$StdInFile,
        [int]$TimeoutSec = 900
    )

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = 'wsl.exe'
    $psi.Arguments = $CommandLine
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.RedirectStandardInput = $true
    # wsl.exe emits UTF-16 for its own messages unless told otherwise; the
    # distro's own output is UTF-8 either way. With this set, both are UTF-8 -
    # callers still strip NULs, in case a WSL build ignores the variable.
    $psi.EnvironmentVariables['WSL_UTF8'] = '1'
    $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
    $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8

    $proc = [System.Diagnostics.Process]::Start($psi)
    $outTask = $proc.StandardOutput.ReadToEndAsync()
    $errTask = $proc.StandardError.ReadToEndAsync()
    try {
        if ($StdInFile) {
            $stream = [System.IO.File]::OpenRead($StdInFile)
            try {
                $stream.CopyTo($proc.StandardInput.BaseStream)
                $proc.StandardInput.BaseStream.Flush()
            } finally {
                $stream.Dispose()
            }
        }
    } finally {
        $proc.StandardInput.Close()
    }
    if (-not $proc.WaitForExit($TimeoutSec * 1000)) {
        try { $proc.Kill() } catch { }
        throw "wsl.exe did not finish within $TimeoutSec s."
    }

    [pscustomobject]@{
        ExitCode    = $proc.ExitCode
        StdOut      = (($outTask.Result) -replace "`0", '')
        StdErr      = (($errTask.Result) -replace "`0", '')
        CommandLine = $CommandLine
    }
}

function ConvertTo-AiSmScriptLine {
    # A constant script is written as a here-string in the helper, so it picks
    # up whatever line endings the file was checked out with. sh would take a
    # trailing CR as part of the last token, so normalize to LF and refuse a
    # script that somehow contains a double quote (that character is what
    # delimits the script on the Windows command line).
    param([Parameter(Mandatory)][string]$Script)

    $normalized = $Script -replace "`r`n", "`n"
    $normalized = $normalized -replace "`r", "`n"
    if ($normalized.Contains('"')) {
        throw 'Internal error: the constant shell script contains a double quote.'
    }
    $normalized
}

function Write-AiSmLauncherConfig {
    <#
    Writes the two small files the installed Windows side needs, beside the
    launcher scripts, and returns @{ ConfigFile; InfoFile }:

      launcher-config.json  { "distro": ..., "appPath": "<appdir>/current" }
          read by launch.ps1 / make-shortcut.ps1 through
          Get-AiSmFileConfig. An installed launcher sits on a plain Windows
          path, so it can derive nothing from its own location - this file is
          the only thing that tells it which distro and which app directory
          it belongs to.

      install-info.txt      distro=... appDir=... version=...
          read by the UNINSTALLER, in the same key=value shape every helper
          result uses, so no Pascal has to parse JSON.

    Both values must already have passed the allow-list (the caller does
    that first), which is why the JSON needs no escaping - and the launcher
    re-validates them on every start anyway. Written UTF-8 without a BOM.
    #>
    param(
        [Parameter(Mandatory)][string]$ConfigDir,
        [Parameter(Mandatory)][string]$Distro,
        [Parameter(Mandatory)][string]$AppDir,
        [string]$Version
    )

    if (-not (Test-AiSmDistroName $Distro)) { throw "Refusing to write a launcher config for the distro name '$Distro'." }
    if (-not (Test-AiSmLinuxPath $AppDir)) { throw "Refusing to write a launcher config for the app directory '$AppDir'." }

    if (-not (Test-Path -LiteralPath $ConfigDir)) {
        New-Item -ItemType Directory -Force -Path $ConfigDir -ErrorAction Stop | Out-Null
    }
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)

    $configFile = Join-Path $ConfigDir 'launcher-config.json'
    $json = @(
        '{',
        ('  "distro": "' + $Distro + '",'),
        ('  "appPath": "' + $AppDir + '/current"'),
        '}'
    )
    [System.IO.File]::WriteAllLines($configFile, [string[]]$json, $utf8NoBom)

    $infoFile = Join-Path $ConfigDir 'install-info.txt'
    $info = @(
        ('distro=' + $Distro),
        ('appDir=' + $AppDir),
        ('version=' + $Version)
    )
    [System.IO.File]::WriteAllLines($infoFile, [string[]]$info, $utf8NoBom)

    [pscustomobject]@{
        ConfigFile = $configFile
        InfoFile   = $infoFile
    }
}
