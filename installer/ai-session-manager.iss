; ai-session-manager.iss - Windows Setup for the AI CLI Session Manager.
;
; Built by CI on the windows runner:
;
;   ISCC.exe /DAppVersion=v0.2.0 ^
;            /DBundleTar=payload\ai-session-manager-linux-x64.tar.gz ^
;            /DHostDir=payload\host ^
;            installer\ai-session-manager.iss
;
; What this file is allowed to contain: the wizard, the files and the icons.
; EVERY decision, every parse and every wsl.exe call lives in a PowerShell 5.1
; helper under installer\helpers\ that writes a key=value result file read
; back here (RunHelper/GetVal below). Pascal that grew logic would be Pascal
; nobody can test from WSL, and PowerShell 5.1 is the only scripting runtime
; guaranteed to exist on the target machine (pwsh usually is not installed).
;
; Per-user by construction: PrivilegesRequired=lowest and
; PrivilegesRequiredOverridesAllowed is EMPTY, so Setup can neither ask for
; nor accept elevation. It writes to %LOCALAPPDATA%\Programs\..., to the
; user's own Start Menu / Desktop, and - through the helpers - to the app
; directory the user chose inside WSL. Nothing else.
;
; It never runs `wsl --install` (that needs admin and a reboot); when WSL or a
; distribution is missing it prints the command and stops.
;
; This is unsigned. SmartScreen will show "Windows protected your PC" on the
; first run; the README explains it.

#ifndef AppVersion
  #define AppVersion "0.0.0-dev"
#endif
#ifndef BundleTar
  #define BundleTar "payload\ai-session-manager-linux-x64.tar.gz"
#endif
#ifndef HostDir
  #define HostDir "payload\host"
#endif
#ifndef LauncherDir
  #define LauncherDir "..\launcher"
#endif
#ifndef OutDir
  #define OutDir "..\dist-release"
#endif

#define AppName "AI Session Manager"
#define AppPublisher "AI Session Manager"
#define AppUrl "https://github.com/YaroslavSavchenk/ai-cli-application"
; Byte-identical to the AppUserModelId in launcher\host\AiSessionManagerHost.cs
; and in launcher\make-shortcut.ps1. Window AUMID == shortcut AUMID is the
; entire taskbar-identity mechanism; a typo here silently costs the icon.
#define AumId "AiSessionManager"
; The bundled Linux runtime is built on ubuntu-22.04, so this is the oldest
; glibc it can run on (bundle.json records the same number).
#define GlibcMin "2.35"
#define BundleTarName "ai-session-manager-bundle.tar.gz"

[Setup]
AppId={{D6B61737-0EA3-4035-85CC-00BCDC60CE05}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppUrl}
AppSupportURL={#AppUrl}
AppUpdatesURL={#AppUrl}/releases
DefaultDirName={localappdata}\Programs\AI Session Manager
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
; The Windows side is a fixed per-user location, so the wizard is exactly the
; seven pages the flow needs: welcome, WSL check, distribution, folder inside
; Linux, optional extras, shortcuts (the [Tasks] desktop icon), ready -- six
; when Claude Code is already there and the consent page is skipped.
; `/DIR=...` on the command line still moves it for the unusual case.
DisableDirPage=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
Uninstallable=yes
UninstallDisplayName={#AppName}
UninstallDisplayIcon={app}\app.ico
OutputDir={#OutDir}
OutputBaseFilename=AI-Session-Manager-Setup-{#AppVersion}
SetupIconFile={#LauncherDir}\app.ico
WizardStyle=modern
Compression=lzma2/max
SolidCompression=yes
; An upgrade must not ask to close a running app: the backend lives inside
; WSL, the window is only a view, and the in-app restart is what moves a
; running install onto the new version.
CloseApplications=no
RestartApplications=no
AllowNoIcons=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Shortcuts:"

[Files]
; --- Windows launcher -----------------------------------------------------
Source: "{#LauncherDir}\launch.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#LauncherDir}\launch.cmd"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#LauncherDir}\launch-silent.vbs"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#LauncherDir}\config-common.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#LauncherDir}\make-shortcut.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#LauncherDir}\app.ico"; DestDir: "{app}"; Flags: ignoreversion
; --- installer helpers (also used by the uninstaller) ---------------------
Source: "helpers\*.ps1"; DestDir: "{app}\helpers"; Flags: ignoreversion
; --- native WebView2 host (run in place from {app}\host) ------------------
Source: "{#HostDir}\AiSessionManagerHost.exe"; DestDir: "{app}\host"; Flags: ignoreversion
Source: "{#HostDir}\Microsoft.Web.WebView2.Core.dll"; DestDir: "{app}\host"; Flags: ignoreversion
Source: "{#HostDir}\Microsoft.Web.WebView2.WinForms.dll"; DestDir: "{app}\host"; Flags: ignoreversion
Source: "{#HostDir}\WebView2Loader.dll"; DestDir: "{app}\host"; Flags: ignoreversion
; --- the Linux bundle: unpacked into WSL, then deleted from Windows -------
Source: "{#BundleTar}"; DestDir: "{tmp}"; DestName: "{#BundleTarName}"; Flags: deleteafterinstall
; --- wizard-time copies: extracted to {tmp} before {app} exists -----------
Source: "helpers\helper-common.ps1"; Flags: dontcopy
Source: "helpers\wsl-probe.ps1"; Flags: dontcopy
Source: "helpers\install-bundle.ps1"; Flags: dontcopy
Source: "{#LauncherDir}\config-common.ps1"; Flags: dontcopy

[Icons]
; AppUserModelID must match the native host window's AUMID byte for byte.
Name: "{autoprograms}\{#AppName}"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\launch-silent.vbs"""; WorkingDir: "{app}"; IconFilename: "{app}\app.ico"; Comment: "AI CLI Session Manager"; AppUserModelID: "{#AumId}"
Name: "{autodesktop}\{#AppName}"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\launch-silent.vbs"""; WorkingDir: "{app}"; IconFilename: "{app}\app.ico"; Comment: "AI CLI Session Manager"; AppUserModelID: "{#AumId}"; Tasks: desktopicon

[UninstallDelete]
; Written after installation by install-bundle.ps1, so Inno does not know them.
Type: files; Name: "{app}\launcher-config.json"
Type: files; Name: "{app}\install-info.txt"
; The native host's own Windows-side folder: WebView2 user-data profile, the
; host-ready marker and the local icon copy. Written at RUN time, not by
; Setup, so Inno does not know it. (The app's DATA - projects, history,
; settings - lives inside WSL and is never touched by an uninstall.)
Type: filesandordirs; Name: "{localappdata}\ai-session-manager"

[Code]
var
  WslPage: TOutputMsgWizardPage;
  DistroPage: TInputOptionWizardPage;
  AppDirPage: TInputQueryWizardPage;
  ConsentPage: TInputOptionWizardPage;
  LastResult: TArrayOfString;
  DistroNames: TStringList;
  WslOk: Boolean;
  WslProbed: Boolean;
  SelectedDistro: String;
  SelectedDataDir: String;
  DefaultAppDir: String;
  ClaudePresent: Boolean;

function GetVal(const Key: String): String;
var
  I: Integer;
  Line, Prefix: String;
begin
  Result := '';
  Prefix := Key + '=';
  for I := 0 to GetArrayLength(LastResult) - 1 do
  begin
    Line := LastResult[I];
    if Copy(Line, 1, Length(Prefix)) = Prefix then
    begin
      Result := Copy(Line, Length(Prefix) + 1, Length(Line));
      Exit;
    end;
  end;
end;

{ Runs one helper and loads its key=value result file. True = the helper ran
  AND reported ok=yes; the caller shows Reason otherwise. }
function RunHelper(const HelperPath, Params: String): Boolean;
var
  ResultFile, Cmd: String;
  Code: Integer;
begin
  ResultFile := ExpandConstant('{tmp}\aism-result.txt');
  DeleteFile(ResultFile);
  SetArrayLength(LastResult, 0);
  Cmd := '-NoProfile -ExecutionPolicy Bypass -File "' + HelperPath + '"' +
    ' -ResultFile "' + ResultFile + '" ' + Params;
  { Full path, never the bare name: Exec resolves a bare name through the
    CreateProcess search order, which starts at the inherited directory. }
  Result := Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
    Cmd, '', SW_HIDE, ewWaitUntilTerminated, Code);
  if FileExists(ResultFile) then
    LoadStringsFromFile(ResultFile, LastResult);
  if Result then
    Result := (Code = 0) and (GetVal('ok') = 'yes');
end;

{ Quotes ONE value that ends up inside WSL - a distribution name, a Linux
  path - onto the powershell.exe command line RunHelper builds, and refuses
  it outright when it carries a double quote (which would end the quoting) or
  whitespace (which would split one argument into several). The helpers gate
  every value again against the shared allow-list in config-common.ps1; this
  is the same gate one step earlier, before a command line exists at all.
  Windows paths Setup itself produces ({tmp}, {app}) do NOT go through here:
  they legitimately contain spaces and are quoted verbatim. }
function IsWslSafe(const Value: String): Boolean;
begin
  Result := (Pos('"', Value) = 0) and (Pos(' ', Value) = 0) and
    (Pos(#9, Value) = 0) and (Pos(#13, Value) = 0) and (Pos(#10, Value) = 0);
end;

function WslArg(const Value: String): String;
begin
  if not IsWslSafe(Value) then
    RaiseException('Setup refused a value containing quotes or spaces: ' + Value);
  Result := '"' + Value + '"';
end;

{ Never show an empty message box: a helper that died before writing its
  result file leaves no reason behind. }
function Reason: String;
begin
  Result := GetVal('reason');
  if Result = '' then
    Result := 'The step could not be completed. Run the same command from installer\helpers\ in PowerShell to see why.';
end;

function TempHelper(const FileName: String): String;
begin
  ExtractTemporaryFile('helper-common.ps1');
  ExtractTemporaryFile('config-common.ps1');
  ExtractTemporaryFile(FileName);
  Result := ExpandConstant('{tmp}\') + FileName;
end;

procedure InitializeWizard;
begin
  DistroNames := TStringList.Create;
  WslOk := False;
  WslProbed := False;
  ClaudePresent := False;

  WslPage := CreateOutputMsgPage(wpWelcome,
    'Windows Subsystem for Linux',
    'This app runs its backend inside WSL 2.',
    'Checking your WSL setup...');

  DistroPage := CreateInputOptionPage(WslPage.ID,
    'Linux distribution',
    'Choose where the app is installed inside WSL.',
    'The app and its own Node runtime are installed inside one WSL 2 distribution.',
    True, False);

  AppDirPage := CreateInputQueryPage(DistroPage.ID,
    'Folder inside Linux',
    'Where the app files go inside the distribution.',
    'This folder holds the app itself. Your projects, sessions history and settings live next to it and are never touched by this installer or by the uninstaller.');
  AppDirPage.Add('Folder:', False);

  ConsentPage := CreateInputOptionPage(AppDirPage.ID,
    'Optional extras',
    'Nothing below is installed unless you tick it.',
    'This Setup installs no third-party software unless you tick it here.' + #13#10 + #13#10 +
    'Claude Code is the AI CLI this app runs by default. Ticking the box installs it inside the' + #13#10 +
    'distribution you chose, with Anthropic''s own official installer:' + #13#10 + #13#10 +
    '    curl -fsSL https://claude.ai/install.sh | bash' + #13#10 + #13#10 +
    'downloaded from claude.ai. Leave it unticked and nothing is downloaded; you can' + #13#10 +
    'always install it yourself later.',
    False, False);
  ConsentPage.Add('Install Claude Code inside the distribution');
  ConsentPage.Values[0] := False;
end;

procedure ProbeWsl;
var
  I, Count: Integer;
  Name, Version, Usable, Text: String;
begin
  { Once only: the check-list entries are ADDED here, so a second run (Back,
    then Next again) would list every distribution twice. }
  if WslProbed then
    Exit;
  WslProbed := True;
  WslOk := RunHelper(TempHelper('wsl-probe.ps1'), '');
  if not WslOk then
  begin
    WslPage.MsgLabel.Caption := Reason;
    Exit;
  end;

  Count := StrToIntDef(GetVal('distroCount'), 0);
  Text := '';
  for I := 1 to Count do
  begin
    Name := GetVal('distro' + IntToStr(I));
    Version := GetVal('distro' + IntToStr(I) + '.version');
    Usable := GetVal('distro' + IntToStr(I) + '.usable');
    if (Version = '2') and (Usable = 'yes') then
    begin
      DistroNames.Add(Name);
      DistroPage.Add(Name);
      Text := Text + '  ' + Name + '  (WSL 2, ' + GetVal('distro' + IntToStr(I) + '.state') + ')' + #13#10;
    end;
  end;
  WslPage.MsgLabel.Caption :=
    'WSL 2 is available on this PC.' + #13#10 + #13#10 +
    'Usable distributions:' + #13#10 + Text + #13#10 +
    'Setup will install the app inside the one you pick on the next page. It needs no admin rights and installs nothing outside your own user account.';
  if DistroNames.Count > 0 then
  begin
    DistroPage.SelectedValueIndex := 0;
    for I := 0 to DistroNames.Count - 1 do
      if DistroNames[I] = GetVal('default') then
        DistroPage.SelectedValueIndex := I;
  end;
end;

function SelectedDistroName: String;
var
  I: Integer;
begin
  Result := '';
  for I := 0 to DistroNames.Count - 1 do
    if DistroPage.Values[I] then
    begin
      Result := DistroNames[I];
      Exit;
    end;
  if DistroNames.Count > 0 then
    Result := DistroNames[0];
end;

{ The per-distro probe: default user, home, glibc, and whether Claude Code is
  already installed. Returns False with a message when the distro cannot host
  this app (glibc too old, unreadable home). }
function ProbeDistro(const Distro: String): Boolean;
begin
  Result := RunHelper(TempHelper('wsl-probe.ps1'),
    '-Distro ' + WslArg(Distro) + ' -GlibcMin "{#GlibcMin}"');
  if Result then
  begin
    SelectedDataDir := GetVal('dataDir');
    DefaultAppDir := GetVal('defaultAppDir');
    ClaudePresent := GetVal('claude') = 'yes';
  end;
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if CurPageID = WslPage.ID then
    ProbeWsl;
  if CurPageID = AppDirPage.ID then
    if AppDirPage.Values[0] = '' then
      AppDirPage.Values[0] := DefaultAppDir;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;

  if CurPageID = WslPage.ID then
  begin
    if not WslOk then
    begin
      MsgBox(Reason, mbCriticalError, MB_OK);
      Result := False;
    end
    else if DistroNames.Count = 0 then
    begin
      MsgBox('No usable WSL 2 distribution was found.', mbCriticalError, MB_OK);
      Result := False;
    end;
  end

  else if CurPageID = DistroPage.ID then
  begin
    SelectedDistro := SelectedDistroName;
    if SelectedDistro = '' then
    begin
      MsgBox('Choose a distribution first.', mbError, MB_OK);
      Result := False;
    end
    else if not ProbeDistro(SelectedDistro) then
    begin
      MsgBox(Reason, mbCriticalError, MB_OK);
      Result := False;
    end
    else
      AppDirPage.Values[0] := DefaultAppDir;
  end

  else if CurPageID = AppDirPage.ID then
  begin
    AppDirPage.Values[0] := Trim(AppDirPage.Values[0]);
    { The one value a user types by hand: answered with a message here, so it
      never has to reach WslArg's refusal. }
    if not IsWslSafe(AppDirPage.Values[0]) then
    begin
      MsgBox('The folder name cannot contain spaces or quotation marks.' + #13#10#13#10 +
        'Use something like /home/you/.ai-session-manager/app.', mbError, MB_OK);
      Result := False;
      Exit;
    end;
    { Validated by the very helper that will do the install, so the wizard
      and the installation can never disagree about what a usable path is. }
    if not RunHelper(TempHelper('install-bundle.ps1'),
      '-DryRun -Distro ' + WslArg(SelectedDistro) +
      ' -AppDir ' + WslArg(AppDirPage.Values[0]) +
      ' -Version "{#AppVersion}" -Tarball "none"') then
    begin
      MsgBox(Reason, mbError, MB_OK);
      Result := False;
    end;
  end;
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := False;
  { Only ever offer what is MISSING. }
  if PageID = ConsentPage.ID then
    Result := ClaudePresent;
end;

function UpdateReadyMemo(const Space, NewLine, MemoUserInfoInfo, MemoDirInfo,
  MemoTypeInfo, MemoComponentsInfo, MemoGroupInfo, MemoTasksInfo: String): String;
begin
  Result :=
    'Windows:' + NewLine + Space + ExpandConstant('{app}') + NewLine + NewLine +
    'Inside ' + SelectedDistro + ':' + NewLine + Space + AppDirPage.Values[0] + NewLine + NewLine;
  if (not ClaudePresent) and ConsentPage.Values[0] then
    Result := Result + 'Also installing Claude Code inside ' + SelectedDistro +
      ' with:' + NewLine + Space + 'curl -fsSL https://claude.ai/install.sh | bash' + NewLine + NewLine
  else
    Result := Result + 'No third-party software will be installed.' + NewLine + NewLine;
  Result := Result +
    'Your projects, session history and settings are not touched.' + NewLine +
    'The app can stay open while this runs; use "Restart backend" in its' + NewLine +
    'settings afterwards to switch to the new version.' + NewLine;
  if MemoTasksInfo <> '' then
    Result := Result + NewLine + MemoTasksInfo + NewLine;
end;

{ A silent install (/SILENT, /VERYSILENT) never shows a page, so fill in the
  same answers the wizard would have defaulted to. }
procedure EnsureDefaults;
var
  I, Count: Integer;
  Name, Pick: String;
begin
  if SelectedDistro <> '' then
    Exit;
  if not RunHelper(TempHelper('wsl-probe.ps1'), '') then
    RaiseException(Reason);
  { Exactly the rule the wizard page uses: only a WSL 2 distribution this
    Setup can name on a command line, preferring this PC's default one. Taking
    'default' or 'distro1' unchecked would silently install into a WSL 1
    distribution - or into a name with a space, which every helper refuses. }
  Pick := '';
  Count := StrToIntDef(GetVal('distroCount'), 0);
  for I := 1 to Count do
  begin
    Name := GetVal('distro' + IntToStr(I));
    if (GetVal('distro' + IntToStr(I) + '.version') = '2') and
       (GetVal('distro' + IntToStr(I) + '.usable') = 'yes') then
    begin
      if Pick = '' then
        Pick := Name;
      if Name = GetVal('default') then
        Pick := Name;
    end;
  end;
  { Reason is EMPTY here when the probe itself succeeded and merely found no
    WSL 2 distribution (a WSL-1-only PC in /SILENT), so this states it. }
  if Pick = '' then
    RaiseException('No usable WSL 2 distribution was found. Convert one with: ' +
      'wsl --set-version <name> 2, then run this Setup again.');
  SelectedDistro := Pick;
  if not ProbeDistro(SelectedDistro) then
    RaiseException(Reason);
  AppDirPage.Values[0] := DefaultAppDir;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Params: String;
begin
  if CurStep <> ssPostInstall then
    Exit;

  EnsureDefaults;

  Params := '-Distro ' + WslArg(SelectedDistro) +
    ' -AppDir ' + WslArg(AppDirPage.Values[0]) +
    ' -Version "{#AppVersion}"' +
    ' -Tarball "' + ExpandConstant('{tmp}\{#BundleTarName}') + '"' +
    ' -DataDir ' + WslArg(SelectedDataDir) +
    ' -ConfigDir "' + ExpandConstant('{app}') + '"';
  if not RunHelper(ExpandConstant('{app}\helpers\install-bundle.ps1'), Params) then
    RaiseException('The app could not be installed inside ' + SelectedDistro + '.' + #13#10#13#10 +
      Reason + #13#10#13#10 +
      'The Windows part of this app is left installed but incomplete: it cannot ' +
      'start until this step succeeds. Fix the reason above and run this Setup again.');

  if (not ClaudePresent) and ConsentPage.Values[0] then
    if not RunHelper(ExpandConstant('{app}\helpers\install-thirdparty.ps1'),
      '-Distro ' + WslArg(SelectedDistro) + ' -Item claude') then
      MsgBox('The app is installed, but Claude Code was not:' + #13#10#13#10 +
        Reason, mbInformation, MB_OK);
end;

{ ---------------------------- uninstall --------------------------------- }

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  InfoFile, Distro, AppDir: String;
  Code: Integer;
begin
  if CurUninstallStep <> usUninstall then
    Exit;

  { install-info.txt is written by install-bundle.ps1 in the same key=value
    shape every helper uses, so nothing here has to parse anything. }
  InfoFile := ExpandConstant('{app}\install-info.txt');
  if not FileExists(InfoFile) then
    Exit;
  SetArrayLength(LastResult, 0);
  LoadStringsFromFile(InfoFile, LastResult);
  Distro := GetVal('distro');
  AppDir := GetVal('appDir');
  if (Distro = '') or (AppDir = '') then
    Exit;

  if MsgBox('Also remove the app files inside ' + Distro + ' at ' + AppDir + '?' + #13#10#13#10 +
    'Your projects, session history and settings are NOT touched either way.' + #13#10#13#10 +
    'If the app is running it will be closed first, which ends any sessions ' +
    'you have open (they stay in the history).',
    mbConfirmation, MB_YESNO or MB_DEFBUTTON2) <> IDYES then
    Exit;

  { Stop a running backend first - removing the files under it would leave a
    process running out of a deleted directory. Failure is not fatal. }
  Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
    '-NoProfile -ExecutionPolicy Bypass -File "' +
    ExpandConstant('{app}\launch.ps1') + '" -Stop', '', SW_HIDE,
    ewWaitUntilTerminated, Code);

  if not RunHelper(ExpandConstant('{app}\helpers\uninstall-wsl.ps1'),
    '-Distro ' + WslArg(Distro) + ' -AppDir ' + WslArg(AppDir)) then
    MsgBox('The app files inside ' + Distro + ' were not removed:' + #13#10#13#10 +
      Reason, mbInformation, MB_OK);
end;
