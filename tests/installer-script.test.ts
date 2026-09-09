/**
 * `installer/ai-session-manager.iss` — the Windows Setup script.
 *
 * ISCC only exists on Windows, so this file cannot be compiled here. What
 * CAN be pinned from WSL is its text, and the properties that matter are all
 * textual:
 *
 *   - it never elevates (PrivilegesRequired=lowest AND an EMPTY
 *     PrivilegesRequiredOverridesAllowed, so `/ALLUSERS` cannot re-open that
 *     door; no `runas`, no admin verb anywhere);
 *   - the AppUserModelID on both shortcuts is byte-identical to the one the
 *     native host sets on its window and the one make-shortcut.ps1 stamps —
 *     that equality IS the taskbar identity mechanism, and nothing at build
 *     time would notice a typo;
 *   - the .iss stays a wizard: every decision, parse and `wsl.exe` call sits
 *     in a PowerShell helper, so the only thing Pascal may Exec is
 *     powershell.exe;
 *   - the bundle tarball is deleted from the Windows disk after the install;
 *   - the consent page exists, its box is off, and it names the exact
 *     third-party command.
 *
 * Everything here is a string comparison against committed files. It runs
 * everywhere (no Windows needed).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectRoot } from './helpers.ts';

const issPath = join(projectRoot, 'installer', 'ai-session-manager.iss');
const iss = readFileSync(issPath, 'utf8');

/** The `[Setup]` section, so a directive is not matched inside a comment. */
function setupSection(): string {
  const start = iss.indexOf('\n[Setup]\n');
  assert.ok(start >= 0, 'no [Setup] section');
  const rest = iss.slice(start + '\n[Setup]\n'.length);
  const end = rest.search(/\n\[[A-Za-z]+\]\n/);
  return end >= 0 ? rest.slice(0, end) : rest;
}

const setup = setupSection();

test('installer: the AppId is the one fixed GUID (an upgrade must replace, not duplicate)', () => {
  // Generated once with uuidgen and hardcoded. Changing it turns every future
  // Setup into a SECOND installed program beside the first one.
  assert.match(setup, /^AppId=\{\{D6B61737-0EA3-4035-85CC-00BCDC60CE05\}$/m);
  assert.equal((iss.match(/^AppId=/gm) ?? []).length, 1);
});

test('installer: per-user, never elevating', () => {
  assert.match(setup, /^PrivilegesRequired=lowest$/m);
  // EMPTY on purpose: any value here would let a command-line switch
  // (/ALLUSERS) ask for elevation.
  assert.match(setup, /^PrivilegesRequiredOverridesAllowed=[ \t]*$/m);
  assert.doesNotMatch(setup, /^PrivilegesRequired=(admin|poweruser)$/m);
  assert.doesNotMatch(iss, /runas/i, 'nothing may request the elevation verb');
  assert.doesNotMatch(iss, /ShellExec/i, 'ShellExec can carry a verb; use Exec');
});

test('installer: installs into the per-user Programs folder', () => {
  assert.match(setup, /^DefaultDirName=\{localappdata\}\\Programs\\AI Session Manager$/m);
  assert.doesNotMatch(setup, /\{pf|\{commonpf|\{sd\\/, 'no machine-wide destination');
});

test('installer: the wizard directives the release depends on', () => {
  assert.match(setup, /^DisableProgramGroupPage=yes$/m);
  // Fixed per-user location: the wizard is the six pages of the real flow.
  assert.match(setup, /^DisableDirPage=yes$/m);
  assert.match(setup, /^ArchitecturesAllowed=x64compatible$/m);
  assert.match(setup, /^Uninstallable=yes$/m);
  assert.match(setup, /^WizardStyle=modern$/m);
  assert.match(setup, /^SolidCompression=yes$/m);
  assert.match(setup, /^OutputBaseFilename=AI-Session-Manager-Setup-\{#AppVersion\}$/m);
  // An upgrade must never ask to close the app: the backend lives in WSL and
  // the in-app restart is what moves a running install to the new version.
  assert.match(setup, /^CloseApplications=no$/m);
});

test('installer: AppUserModelID is byte-identical in the .iss, the host source and make-shortcut.ps1', () => {
  const fromIss = /^#define AumId "([^"]+)"$/m.exec(iss)?.[1];
  const cs = readFileSync(join(projectRoot, 'launcher', 'host', 'AiSessionManagerHost.cs'), 'utf8');
  const fromCs = /private const string AppUserModelId = "([^"]+)";/.exec(cs)?.[1];
  const ps1 = readFileSync(join(projectRoot, 'launcher', 'make-shortcut.ps1'), 'utf8');
  const fromPs1 = /^\$AppUserModelId = '([^']+)'$/m.exec(ps1)?.[1];

  assert.equal(fromIss, 'AiSessionManager');
  assert.equal(fromCs, fromIss, 'the host window and the Setup shortcut must share one AUMID');
  assert.equal(fromPs1, fromIss, 'make-shortcut.ps1 must stamp the same AUMID');

  // Both shortcuts carry it.
  const icons = iss.slice(iss.indexOf('\n[Icons]\n'));
  const lines = icons.split('\n').filter((l) => l.startsWith('Name: '));
  assert.equal(lines.length, 2, 'expected exactly the Start Menu and Desktop shortcuts');
  for (const line of lines) {
    assert.ok(line.includes('AppUserModelID: "{#AumId}"'), line);
    assert.ok(line.includes('Filename: "{sys}\\wscript.exe"'), line);
    assert.ok(line.includes('Parameters: """{app}\\launch-silent.vbs"""'), line);
    assert.ok(line.includes('IconFilename: "{app}\\app.ico"'), line);
  }
});

test('installer: the Linux bundle is deleted from Windows after the install', () => {
  const line = iss.split('\n').find((l) => l.startsWith('Source: "{#BundleTar}"'));
  assert.ok(line, 'no [Files] entry for the bundle tarball');
  assert.ok(line.includes('DestDir: "{tmp}"'), line);
  assert.ok(line.includes('Flags: deleteafterinstall'), line);
  assert.ok(line.includes('DestName: "{#BundleTarName}"'), line);
});

test('installer: every file it ships exists in this repo', () => {
  const sources = [...iss.matchAll(/^Source: "([^"]+)"/gm)].map((m) => m[1]!);
  assert.ok(sources.length >= 10, `only found ${sources.length} [Files] entries`);
  for (const source of sources) {
    // The payload (bundle tarball + built host) is produced by CI, not committed.
    if (source.includes('{#BundleTar}') || source.includes('{#HostDir}')) continue;
    const resolved = join(projectRoot, 'installer', source.replace('{#LauncherDir}', '..\\launcher').replaceAll('\\', '/'));
    if (resolved.includes('*')) {
      assert.ok(existsSync(resolved.slice(0, resolved.lastIndexOf('/'))), resolved);
      continue;
    }
    assert.ok(existsSync(resolved), `[Files] names a file that is not in the repo: ${source}`);
  }
});

test('installer: the four native-host files are installed beside the launcher, not staged elsewhere', () => {
  for (const name of [
    'AiSessionManagerHost.exe',
    'Microsoft.Web.WebView2.Core.dll',
    'Microsoft.Web.WebView2.WinForms.dll',
    'WebView2Loader.dll',
  ]) {
    const line = iss.split('\n').find((l) => l.includes(`{#HostDir}\\${name}`));
    assert.ok(line, `no [Files] entry for ${name}`);
    assert.ok(line.includes('DestDir: "{app}\\host"'), line);
  }
});

test('installer: all logic is in PowerShell helpers - Pascal only ever runs powershell.exe', () => {
  const code = iss.slice(iss.indexOf('\n[Code]\n'));
  const execs = [...code.matchAll(/\bExec\(\s*([^,]+),/g)].map((m) => m[1]!.trim());
  assert.ok(execs.length > 0, 'expected at least one Exec');
  for (const exe of execs) {
    // Never the bare name: Exec hands it to CreateProcess, whose search order
    // starts at the inherited working directory, so a `powershell.exe`
    // sitting there would run instead of Windows'.
    assert.equal(
      exe,
      "ExpandConstant('{sys}\\WindowsPowerShell\\v1.0\\powershell.exe')",
      `the .iss may only run the system powershell.exe by full path, found: ${exe}`,
    );
  }
  assert.doesNotMatch(code, /\bExec\(\s*'powershell\.exe'/, 'no Exec may name powershell.exe bare');
  assert.doesNotMatch(code, /\bExec\(\s*'wsl/i, 'wsl.exe calls belong in the helpers');
  assert.doesNotMatch(code, /wsl\.exe/i, 'the .iss must not name wsl.exe at all');
  // It must never try to install WSL itself: that needs admin and a reboot,
  // so `wsl --install` may appear in a comment but never in the Pascal.
  assert.ok(!/wsl\s+--install/.test(code), 'the `wsl --install` instruction is a helper message, not an action');
});

test('installer: helper scripts named by the Pascal code exist', () => {
  const code = iss.slice(iss.indexOf('\n[Code]\n'));
  const named = new Set([...code.matchAll(/([a-z-]+\.ps1)/g)].map((m) => m[1]!));
  assert.ok(named.size >= 3, `expected several helpers, got ${[...named].join(', ')}`);
  for (const name of named) {
    const where = name.startsWith('launch') || name === 'config-common.ps1' || name === 'make-shortcut.ps1'
      ? 'launcher'
      : 'installer/helpers';
    assert.ok(
      existsSync(join(projectRoot, where, name)),
      `the .iss calls ${name}, which does not exist in ${where}/`,
    );
  }
});

test('installer: the consent page offers only opt-in third-party software, with the exact command', () => {
  assert.ok(
    iss.includes('This Setup installs no third-party software unless you tick it here.'),
    'the consent sentence must be on the page',
  );
  assert.ok(
    iss.includes('curl -fsSL https://claude.ai/install.sh | bash'),
    'the exact third-party command must be shown',
  );
  assert.ok(iss.includes('downloaded from claude.ai'), 'the source host must be named');
  // Default OFF, and only ever run when ticked.
  assert.match(iss, /ConsentPage\.Values\[0\] := False;/);
  assert.match(iss, /if \(not ClaudePresent\) and ConsentPage\.Values\[0\] then/);
  // One item only, and it is the allow-listed one.
  assert.equal((iss.match(/-Item claude/g) ?? []).length, 1);
});

test('installer: /SILENT picks a distribution by the same rule as the wizard page', () => {
  // No page is shown, so EnsureDefaults fills in the answers. Taking
  // `default` (or `distro1`) unchecked would install into a WSL 1
  // distribution, or into a name with a space that every helper then refuses.
  const code = iss.slice(iss.indexOf('procedure EnsureDefaults'), iss.indexOf('procedure CurStepChanged'));
  assert.ok(code.includes("'.version') = '2'"), `EnsureDefaults must require WSL 2:\n${code}`);
  assert.ok(code.includes("'.usable') = 'yes'"), `EnsureDefaults must require a usable name:\n${code}`);
  assert.match(code, /StrToIntDef\(GetVal\('distroCount'\), 0\)/, 'it must walk the whole list');
  // Reason is EMPTY when the probe answered ok=yes and simply listed no WSL 2
  // distro, so the /SILENT abort must state its own reason.
  assert.match(
    code,
    /if Pick = '' then\s*\n\s*RaiseException\('No usable WSL 2 distribution was found\. Convert one with: ' \+\s*\n\s*'wsl --set-version <name> 2, then run this Setup again\.'\);/,
    'no usable distro must stop the install with a message of its own',
  );
  assert.doesNotMatch(code, /if Pick = '' then\s*\n\s*RaiseException\(Reason\);/);
});

test('installer: every value that ends up inside WSL is quoted through the one guard', () => {
  const code = iss.slice(iss.indexOf('\n[Code]\n'));
  // The guard itself: a double quote would end the quoting, whitespace would
  // split one argument into several.
  assert.match(code, /function WslArg\(const Value: String\): String;/);
  assert.match(code, /RaiseException\('Setup refused a value containing quotes or spaces: ' \+ Value\);/);
  assert.ok(
    code.includes("Result := (Pos('\"', Value) = 0) and (Pos(' ', Value) = 0)"),
    'the rule must reject quotes and spaces',
  );
  // And no call site may hand-quote one of those values any more.
  for (const param of ['-Distro', '-AppDir', '-DataDir']) {
    assert.ok(
      !code.includes(`${param} "' +`),
      `${param} must be quoted by WslArg, not by hand`,
    );
  }
  // The declaration plus its nine call sites: the distro in ProbeDistro, the
  // distro + app dir on the folder page, the distro + app dir + data dir at
  // install time, the distro for the opt-in extra, and the distro + app dir
  // the uninstaller reads back out of install-info.txt.
  assert.equal((code.match(/WslArg\(/g) ?? []).length, 10, 'every WSL-bound value goes through the guard');
});

test('installer: the uninstaller asks before touching WSL, defaulting to NO', () => {
  const code = iss.slice(iss.indexOf('procedure CurUninstallStepChanged'));
  assert.match(code, /MB_YESNO or MB_DEFBUTTON2/, 'the removal prompt must default to No');
  assert.ok(
    code.includes('Your projects, session history and settings are NOT touched either way.'),
    'the prompt must say the data is safe',
  );
  assert.match(code, /uninstall-wsl\.ps1/);
  // The Windows-side files it wrote itself are removed by [UninstallDelete].
  assert.match(iss, /^Type: files; Name: "\{app\}\\launcher-config\.json"$/m);
  assert.match(iss, /^Type: files; Name: "\{app\}\\install-info\.txt"$/m);
  // Including the host's OWN Windows-side folder (WebView2 profile, the
  // host-ready marker, the icon copy) — written at run time, so Inno does not
  // know it. The app's data lives inside WSL and is never touched here.
  assert.match(iss, /^Type: filesandordirs; Name: "\{localappdata\}\\ai-session-manager"$/m);
});
