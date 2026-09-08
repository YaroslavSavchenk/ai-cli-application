<#
build-host.ps1 - one-time (re-runnable) build of the native WebView2 host
(launcher\host\AiSessionManagerHost.cs) into launcher\host\build\.

What it does:
  1. Resolves the in-box Framework C# compiler (NO .NET SDK required).
  2. Downloads the pinned Microsoft.Web.WebView2 NuGet package (a .nupkg = a
     zip) over HTTPS to a temp dir and verifies its size + SHA-256 against the
     pinned values below. Nothing from it is vendored/committed.
  3. Extracts the managed assemblies (Core + WinForms) and the native
     WebView2Loader.dll.
  4. Compiles a tiny framework-dependent x64 winexe with the app icon embedded
     as a Win32 resource (/win32icon), and copies the three WebView2 DLLs
     beside it.

Idempotent: re-run any time. First run needs network (to fetch the .nupkg);
later runs reuse the cached download if it is already present and verified.

Run from Windows:
  powershell -NoProfile -ExecutionPolicy Bypass -File "\\wsl.localhost\<distro>\<your clone>\launcher\build-host.ps1"
or from inside WSL:
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File launcher/build-host.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

function Fail([string]$Message) {
    Write-Host "ERROR: $Message" -ForegroundColor Red
    exit 1
}

# --- Pinned toolchain + package -------------------------------------------
# In-box Framework compiler (v4.8.9221, "for C# 5"); NO SDK needed.
$Csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'

# Pinned WebView2 SDK. 1.0.3405.78 ships its managed assemblies under
# lib\net462\ (older SDKs used lib\net45\); net462 is compatible with the
# .NET Framework 4.7.2 target. The Evergreen runtime on this box is
# 150.0.4078.83, comfortably newer than this SDK, which is the required
# direction (runtime version >= SDK version).
$PkgId      = 'microsoft.web.webview2'
$PkgVersion = '1.0.3405.78'
$PkgSha256  = 'D035807B2AABA871E8C014759626F566E96934E6CE6F0587056EE81D5228C373'
$PkgSize    = 8913598

# --- Paths -----------------------------------------------------------------
$LauncherDir = $PSScriptRoot
$HostDir  = Join-Path $LauncherDir 'host'
$SrcFile  = Join-Path $HostDir 'AiSessionManagerHost.cs'
$BuildDir = Join-Path $HostDir 'build'
$IconPath = Join-Path $LauncherDir 'app.ico'
$OutExe   = Join-Path $BuildDir 'AiSessionManagerHost.exe'

if (-not (Test-Path -LiteralPath $Csc))      { Fail "csc.exe not found at $Csc" }
if (-not (Test-Path -LiteralPath $SrcFile))  { Fail "host source not found at $SrcFile" }
if (-not (Test-Path -LiteralPath $IconPath)) { Fail "app.ico not found at $IconPath (run: node launcher/make-icon.mjs)" }

# --- Download + verify the .nupkg ------------------------------------------
$cacheDir = Join-Path $env:TEMP 'ai-session-manager-buildhost'
if (-not (Test-Path -LiteralPath $cacheDir)) {
    [void](New-Item -ItemType Directory -Path $cacheDir -Force)
}
$nupkg = Join-Path $cacheDir ("$PkgId.$PkgVersion.nupkg")

function Test-Nupkg([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return $false }
    if ((Get-Item -LiteralPath $Path).Length -ne $PkgSize) { return $false }
    $h = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
    return ($h -eq $PkgSha256)
}

if (Test-Nupkg $nupkg) {
    Write-Host "Using cached, verified package: $nupkg"
} else {
    $url = "https://api.nuget.org/v3-flatcontainer/$PkgId/$PkgVersion/$PkgId.$PkgVersion.nupkg"
    Write-Host "Downloading $PkgId $PkgVersion ..."
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    } catch { }
    try {
        Invoke-WebRequest -Uri $url -OutFile $nupkg -UseBasicParsing
    } catch {
        Fail "download failed ($($_.Exception.Message)). This first build needs network access to api.nuget.org."
    }
    $size = (Get-Item -LiteralPath $nupkg).Length
    if ($size -ne $PkgSize) {
        Fail "downloaded size $size != pinned $PkgSize bytes - refusing to use it."
    }
    $hash = (Get-FileHash -LiteralPath $nupkg -Algorithm SHA256).Hash
    if ($hash -ne $PkgSha256) {
        Fail "SHA-256 mismatch: got $hash, pinned $PkgSha256 - refusing to use it."
    }
    Write-Host "Verified: $size bytes, SHA-256 $hash"
}

# --- Extract the DLLs we need ----------------------------------------------
$extractDir = Join-Path $cacheDir "extract-$PkgVersion"
if (Test-Path -LiteralPath $extractDir) {
    Remove-Item -LiteralPath $extractDir -Recurse -Force
}
[void](New-Item -ItemType Directory -Path $extractDir -Force)
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::ExtractToDirectory($nupkg, $extractDir)

function Find-First([string[]]$Candidates) {
    foreach ($c in $Candidates) {
        if (Test-Path -LiteralPath $c) { return (Get-Item -LiteralPath $c).FullName }
    }
    return $null
}

$CoreDll = Find-First @(
    (Join-Path $extractDir 'lib\net462\Microsoft.Web.WebView2.Core.dll'),
    (Join-Path $extractDir 'lib\net45\Microsoft.Web.WebView2.Core.dll')
)
$WinFormsDll = Find-First @(
    (Join-Path $extractDir 'lib\net462\Microsoft.Web.WebView2.WinForms.dll'),
    (Join-Path $extractDir 'lib\net45\Microsoft.Web.WebView2.WinForms.dll')
)
$LoaderDll = Find-First @(
    (Join-Path $extractDir 'runtimes\win-x64\native\WebView2Loader.dll'),
    (Join-Path $extractDir 'build\native\x64\WebView2Loader.dll')
)
if (-not $CoreDll)    { Fail "Core.dll not found in the package (looked under lib\net462, lib\net45)." }
if (-not $WinFormsDll){ Fail "WinForms.dll not found in the package (looked under lib\net462, lib\net45)." }
if (-not $LoaderDll)  { Fail "WebView2Loader.dll (x64) not found in the package." }

# --- Compile ---------------------------------------------------------------
if (-not (Test-Path -LiteralPath $BuildDir)) {
    [void](New-Item -ItemType Directory -Path $BuildDir -Force)
}

$cscArgs = @(
    '/nologo',
    '/target:winexe',
    '/platform:x64',
    ('/win32icon:' + $IconPath),
    ('/reference:' + $CoreDll),
    ('/reference:' + $WinFormsDll),
    '/reference:System.Windows.Forms.dll',
    '/reference:System.Drawing.dll',
    ('/out:' + $OutExe),
    $SrcFile
)
Write-Host "Compiling with $Csc ..."
& $Csc @cscArgs
if ($LASTEXITCODE -ne 0) {
    Fail "csc failed (exit $LASTEXITCODE)."
}

# --- Stage the WebView2 DLLs beside the exe --------------------------------
Copy-Item -LiteralPath $CoreDll     -Destination (Join-Path $BuildDir 'Microsoft.Web.WebView2.Core.dll')     -Force
Copy-Item -LiteralPath $WinFormsDll -Destination (Join-Path $BuildDir 'Microsoft.Web.WebView2.WinForms.dll') -Force
Copy-Item -LiteralPath $LoaderDll   -Destination (Join-Path $BuildDir 'WebView2Loader.dll')                  -Force

Write-Host ''
Write-Host "Built: $OutExe"
Get-ChildItem -LiteralPath $BuildDir | ForEach-Object {
    Write-Host ("  {0,10}  {1}" -f $_.Length, $_.Name)
}
Write-Host ''
Write-Host 'Done. launch.ps1 Tier 1 will use this host when the WebView2 runtime is present.'
exit 0
