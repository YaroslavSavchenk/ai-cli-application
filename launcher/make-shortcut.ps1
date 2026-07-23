<#
make-shortcut.ps1 - create the "AI Session Manager" shortcuts (user scope).

Creates/overwrites (idempotent, re-run any time, no admin needed):
  - Desktop\AI Session Manager.lnk
  - Start Menu\Programs\AI Session Manager.lnk   (user Start Menu -> the app
    shows up in Start search; right-click -> Pin to Start / taskbar)

Each shortcut targets:  wscript.exe "<launcher>\launch-silent.vbs"
so a double-click launches with no console window at all (see
launch-silent.vbs / launch.ps1 -Silent). Icon: launcher\app.ico, copied to
%LOCALAPPDATA%\ai-session-manager\app.ico so Explorer can render it even
while WSL is down (\\wsl.localhost is unreachable until the VM boots, which
otherwise leaves the shortcut icon blank after every Windows reboot).
Re-run this script to refresh the copy after regenerating the icon.

The launcher directory is resolved to its \\wsl.localhost UNC form
automatically:
  - normally from this script's own location ($PSScriptRoot is already the
    UNC path both when run from the share and when run via powershell.exe
    interop from inside WSL - Windows maps the WSL cwd to UNC);
  - otherwise built from the configured distro + Linux repo path below.

Run it once, from either side:
  Windows:  powershell -NoProfile -ExecutionPolicy Bypass -File "\\wsl.localhost\Ubuntu-24.04\home\sava\projects\ai-cli-application\launcher\make-shortcut.ps1"
  WSL:      powershell.exe -NoProfile -ExecutionPolicy Bypass -File launcher/make-shortcut.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

# Same config surface as launch.ps1 (only used for the UNC fallback).
$Distro   = if ($env:AI_SM_DISTRO)    { $env:AI_SM_DISTRO }    else { 'Ubuntu-24.04' }
$RepoPath = if ($env:AI_SM_REPO_PATH) { $env:AI_SM_REPO_PATH } else { '/home/sava/projects/ai-cli-application' }
$ShortcutName = 'AI Session Manager'

# Must be byte-identical to the AppUserModelId the native host sets via
# SetCurrentProcessExplicitAppUserModelID (launcher\host\AiSessionManagerHost.cs).
# That match is the entire taskbar-identity mechanism: window AUMID == shortcut
# AUMID => Windows draws app.ico for the group. No vendor prefix.
$AppUserModelId = 'AiSessionManager'

function Fail([string]$Message) {
    Write-Host "ERROR: $Message" -ForegroundColor Red
    exit 1
}

# WScript.Shell cannot set a shortcut's System.AppUserModel.ID. Stamp it via
# the shell link's IPropertyStore (PKEY_AppUserModel_ID). This inline helper is
# the only way to reach that property key from PowerShell.
$aumidHelper = @'
using System;
using System.Runtime.InteropServices;

namespace AiSm {
    [StructLayout(LayoutKind.Sequential)]
    public struct PropertyKey {
        public Guid fmtid;
        public uint pid;
    }

    // Minimal PROPVARIANT: for VT_LPWSTR only vt + the pointer field matter.
    // Sized with IntPtr so the layout is correct on x86 and x64.
    [StructLayout(LayoutKind.Sequential)]
    public struct PropVariant {
        public ushort vt;
        public ushort r1;
        public ushort r2;
        public ushort r3;
        public IntPtr p;
        public IntPtr p2;
    }

    [ComImport, Guid("0000010b-0000-0000-C000-000000000046"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IPersistFile {
        void GetClassID(out Guid pClassID);
        [PreserveSig] int IsDirty();
        void Load([MarshalAs(UnmanagedType.LPWStr)] string pszFileName, int dwMode);
        void Save([MarshalAs(UnmanagedType.LPWStr)] string pszFileName,
                  [MarshalAs(UnmanagedType.Bool)] bool fRemember);
        void SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string pszFileName);
        void GetCurFile([MarshalAs(UnmanagedType.LPWStr)] out string ppszFileName);
    }

    [ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IPropertyStore {
        void GetCount(out uint cProps);
        void GetAt(uint iProp, out PropertyKey pkey);
        void GetValue(ref PropertyKey key, out PropVariant pv);
        void SetValue(ref PropertyKey key, ref PropVariant pv);
        void Commit();
    }

    [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
    public class CShellLink { }

    public static class ShortcutAumid {
        private const ushort VT_LPWSTR = 31;

        // ole32 export is reliable; propsys's InitPropVariantFromString is an
        // inline SDK helper that is not exported everywhere, so build the
        // VT_LPWSTR PROPVARIANT by hand instead.
        [DllImport("ole32.dll")]
        private static extern int PropVariantClear(ref PropVariant pvar);

        public static void Set(string lnkPath, string aumid, string relaunchIcon) {
            IPersistFile file = (IPersistFile)new CShellLink();
            file.Load(lnkPath, 2); // STGM_READWRITE
            IPropertyStore store = (IPropertyStore)file;

            PropertyKey idKey = new PropertyKey();
            idKey.fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"); // PKEY_AppUserModel_ID
            idKey.pid = 5;
            SetString(store, idKey, aumid);

            // PKEY_AppUserModel_RelaunchIconResource: same fmtid, pid 3. The
            // "<icon>,0" resource string makes a taskbar-pinned relaunch keep
            // app.ico (native-webview2-host.md:57-58).
            PropertyKey iconKey = new PropertyKey();
            iconKey.fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");
            iconKey.pid = 3;
            SetString(store, iconKey, relaunchIcon);

            store.Commit();
            file.Save(lnkPath, true);
        }

        private static void SetString(IPropertyStore store, PropertyKey key, string value) {
            PropVariant pv = new PropVariant();
            pv.vt = VT_LPWSTR;
            // CoTaskMemAlloc'd copy; PropVariantClear (CoTaskMemFree) frees it.
            pv.p = Marshal.StringToCoTaskMemUni(value);
            try {
                store.SetValue(ref key, ref pv);
            } finally {
                PropVariantClear(ref pv);
            }
        }
    }
}
'@
try {
    Add-Type -TypeDefinition $aumidHelper -ErrorAction Stop
    $canStampAumid = $true
} catch {
    Write-Host ("Warning: could not compile the AppUserModelID helper " +
        "($($_.Exception.Message)) - shortcuts will be created without a " +
        'System.AppUserModel.ID (the native host taskbar icon needs it).')
    $canStampAumid = $false
}

# --- Resolve the launcher directory as a \\wsl.localhost UNC path ----------

$launcherUnc = $null
if ($PSScriptRoot -and ($PSScriptRoot -like '\\wsl.localhost\*' -or $PSScriptRoot -like '\\wsl$\*')) {
    $launcherUnc = $PSScriptRoot
} else {
    if ($RepoPath -notmatch '^/[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$') {
        Fail "RepoPath must be an absolute Linux path without spaces or shell metacharacters, got: $RepoPath"
    }
    if ($Distro -notmatch '^[A-Za-z0-9._-]+$') {
        Fail "Distro contains invalid characters: $Distro"
    }
    $launcherUnc = '\\wsl.localhost\' + $Distro + ($RepoPath -replace '/', '\') + '\launcher'
}

$vbsPath  = Join-Path $launcherUnc 'launch-silent.vbs'
$icoPath  = Join-Path $launcherUnc 'app.ico'
foreach ($required in @($vbsPath, $icoPath)) {
    if (-not (Test-Path -LiteralPath $required)) {
        Fail ("required file not reachable: $required`n" +
            'Check that the distro name / repo path at the top of this script match ' +
            'your setup (wsl.exe -l -q lists installed distros), and that the WSL ' +
            'distro is reachable via \\wsl.localhost.')
    }
}

$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
if (-not (Test-Path -LiteralPath $wscript)) { Fail "wscript.exe not found at $wscript" }

# --- Copy the icon to a Windows-local path ---------------------------------
# The shortcut itself must keep pointing at the WSL share (that is where the
# launcher lives), but the ICON can and should be local: Explorer draws it
# long before WSL is running.

$iconDir   = Join-Path $env:LocalAppData 'ai-session-manager'
$iconLocal = Join-Path $iconDir 'app.ico'
try {
    if (-not (Test-Path -LiteralPath $iconDir)) {
        [void](New-Item -ItemType Directory -Path $iconDir -Force)
    }
    Copy-Item -LiteralPath $icoPath -Destination $iconLocal -Force
    Write-Host "Icon copied to $iconLocal (renders even while WSL is down)."
} catch {
    Write-Host ("Warning: could not copy app.ico to '$iconLocal' " +
        "($($_.Exception.Message)) - using the WSL share path instead " +
        '(the icon may render blank until WSL has booted).')
    $iconLocal = $icoPath
}

# --- Create/overwrite the shortcuts ----------------------------------------

# 'Programs' = the per-user Start Menu\Programs folder: no admin, and Start
# search picks the entry up. Desktop honors OneDrive redirection.
$destinations = @(
    [Environment]::GetFolderPath('Desktop'),
    [Environment]::GetFolderPath('Programs')
)

$shell = New-Object -ComObject WScript.Shell
foreach ($dir in $destinations) {
    if (-not $dir -or -not (Test-Path -LiteralPath $dir)) {
        Write-Host "Skipping unavailable destination: '$dir'"
        continue
    }
    $lnkPath = Join-Path $dir "$ShortcutName.lnk"
    $lnk = $shell.CreateShortcut($lnkPath)   # opens existing or creates new
    $lnk.TargetPath       = $wscript
    $lnk.Arguments        = '"' + $vbsPath + '"'
    $lnk.WorkingDirectory = $launcherUnc
    $lnk.IconLocation     = "$iconLocal,0"
    $lnk.Description      = 'AI CLI Session Manager - launch (silent)'
    $lnk.Save()

    # Stamp System.AppUserModel.ID so a taskbar-pinned shortcut shares the
    # native host window's AUMID (== app.ico on the taskbar group). Done after
    # the WScript.Shell Save, which writes the target/icon/args but cannot set
    # this property.
    if ($canStampAumid) {
        try {
            [AiSm.ShortcutAumid]::Set($lnkPath, $AppUserModelId, "$iconLocal,0")
            Write-Host "Shortcut written: $lnkPath  (AppUserModelID: $AppUserModelId)"
        } catch {
            Write-Host ("Shortcut written: $lnkPath  (WARNING: could not set " +
                "AppUserModelID: $($_.Exception.Message))")
        }
    } else {
        Write-Host "Shortcut written: $lnkPath  (no AppUserModelID - helper unavailable)"
    }
}

Write-Host ''
Write-Host 'Done. Double-click the desktop icon, or find "AI Session Manager" in'
Write-Host 'Start search (right-click it there to Pin to Start / taskbar).'
exit 0
