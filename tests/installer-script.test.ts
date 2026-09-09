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
  // The in-app update runs this Setup UNDER the running app, so both of these
  // are load-bearing: `yes` would make the wizard ask (and the silent run
  // kill) the very window that started the update, and the host has no
  // close handler.
  assert.match(setup, /^CloseApplications=no$/m);
  assert.match(setup, /^RestartApplications=no$/m);
  // Two Setups of this app may never run at once: the in-app updater starts
  // this Setup detached and stops WAITING for it after 15 minutes, so a
  // manually started Setup (or a second press after that timeout) must be
  // refused by Windows itself rather than unpack the bundle a second time.
  assert.match(setup, /^SetupMutex=AiSessionManagerSetup$/m);
});

test('installer: there is no [Run] section - Setup starts nothing at the end', () => {
  // The in-app update drives its own restart (POST /api/restart) once the
  // Setup exits; a [Run] entry would start a SECOND launcher behind it, on
  // the old backend, with the old host still open.
  assert.doesNotMatch(iss, /^\[Run\]$/m);
  assert.doesNotMatch(iss, /^\[UninstallRun\]$/m);
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

test('installer: the four native-host files are staged in {app}\\host\\next, never written over a running host', () => {
  // The in-app update runs this Setup while the old host window is open and
  // CloseApplications is no, so those four files are LOCKED. Writing them
  // straight to {app}\host would fail the update it has to survive; the
  // launcher promotes next\ at the following start (Move-AiSmHostNext).
  for (const name of [
    'AiSessionManagerHost.exe',
    'Microsoft.Web.WebView2.Core.dll',
    'Microsoft.Web.WebView2.WinForms.dll',
    'WebView2Loader.dll',
  ]) {
    const line = iss.split('\n').find((l) => l.includes(`{#HostDir}\\${name}`));
    assert.ok(line, `no [Files] entry for ${name}`);
    assert.ok(line.includes('DestDir: "{app}\\host\\next"'), line);
    assert.ok(!/DestDir: "\{app\}\\host"/.test(line), line);
  }
  // And the promoted copies, which Inno never logged, still go on uninstall.
  assert.match(iss, /^Type: filesandordirs; Name: "\{app\}\\host"$/m);
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

test('installer: no line in the .iss starts with a Pascal char literal (ISPP reads a leading # as a directive)', () => {
  // Measured on the windows runner (Inno Setup 6.7.1, run 34353061285): a line
  // beginning with "#13#10" inside [Code] aborts the compile with
  // "Unknown preprocessor directive". Char literals must follow something on
  // the same line.
  const offenders = iss
    .split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => /^\s*#(?!(define|ifdef|ifndef|endif|else|if|error|include|pragma)\b)/.test(line));
  assert.deepEqual(offenders, [], `lines that would be read as preprocessor directives: ${offenders.map((o) => o.n).join(', ')}`);
});

test('installer: no Pascal block comment in [Code] contains a nested brace (it would end the comment early)', () => {
  // Measured on the windows runner (run 34353560564): "({tmp}, {app})" inside a
  // { ... } comment closed the comment at the first "}", and the rest of the
  // sentence was compiled as code -> "'BEGIN' expected".
  const code = iss.slice(iss.indexOf('[Code]'));
  const base = iss.slice(0, iss.indexOf('[Code]')).split('\n').length;
  const issues: string[] = [];
  let i = 0;
  let line = base;
  while (i < code.length) {
    const c = code[i];
    if (c === '\n') { line += 1; i += 1; continue; }
    if (c === "'") { let j = i + 1; while (j < code.length && code[j] !== "'" && code[j] !== '\n') j += 1; i = j + 1; continue; }
    if (code.startsWith('//', i)) { const j = code.indexOf('\n', i); i = j < 0 ? code.length : j; continue; }
    if (c === '{') {
      const j = code.indexOf('}', i + 1);
      const inner = code.slice(i + 1, j);
      if (inner.includes('{')) issues.push(`line ${line}: ${code.slice(i, i + 60).replace(/\n/g, ' ')}`);
      line += inner.split('\n').length - 1;
      i = j + 1;
      continue;
    }
    i += 1;
  }
  assert.deepEqual(issues, []);
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

/* -------------------------------------------------------------------------
 * Runtime findings from the ISCC audit (compiled locally against Inno Setup
 * 6.7.1). Each of these pins one behaviour that the text alone would happily
 * regress back into.
 * ---------------------------------------------------------------------- */

const code = iss.slice(iss.indexOf('\n[Code]\n'));

test('installer: R1 - every message box in [Code] is suppressible (/VERYSILENT must never hang on a modal)', () => {
  // A plain MsgBox() ignores /SUPPRESSMSGBOXES, so a silent install stops on
  // an invisible window that nobody can click.
  const bare = code
    .split('\n')
    .map((line, i) => ({ line: line.trim(), n: i + 1 }))
    .filter(({ line }) => /(^|[^a-zA-Z])MsgBox\(/.test(line) && !/SuppressibleMsgBox\(/.test(line));
  assert.deepEqual(bare, [], `bare MsgBox( in [Code]: ${bare.map((b) => b.line).join(' | ')}`);
  assert.ok((code.match(/SuppressibleMsgBox\(/g) ?? []).length >= 8, 'every former MsgBox site must still show its message');
  // The uninstall confirmation keeps NO as the default answer, and its
  // suppressed answer is NO too - a silent uninstall removes nothing in WSL.
  assert.match(code, /mbConfirmation, MB_YESNO or MB_DEFBUTTON2, IDNO\) <> IDYES then/);
});

test('installer: R2 - the Welcome page is shown, so the WSL probe does not run on the first painted frame', () => {
  // Inno 6 defaults DisableWelcomePage to yes; the probe is a synchronous
  // wsl.exe call that takes seconds on a cold WSL.
  assert.match(setup, /^DisableWelcomePage=no$/m);
  assert.ok(iss.includes('seven pages the flow needs'), 'the page count comment must stay at seven');
});

test('installer: R3 - the helper powershell.exe can never sit waiting for a prompt', () => {
  // SW_HIDE + a prompt = an invisible hang.
  assert.match(code, /Cmd := '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' \+ HelperPath/);
});

test('installer: R4 - Back-then-Next out of the distribution page keeps the typed Linux folder', () => {
  // NextButtonClick runs on EVERY Next, so an unconditional assignment would
  // overwrite what the user typed on the next page.
  assert.match(
    code,
    /if \(AppDirPage\.Values\[0\] = ''\) or \(SelectedDistro <> LastProbedDistro\) then\s*\n\s*AppDirPage\.Values\[0\] := DefaultedAppDir;\s*\n\s*LastProbedDistro := SelectedDistro;/,
  );
  assert.match(code, /^\s{2}LastProbedDistro: String;$/m, 'the remembered distro needs its own var');
});

test('installer: R5 - a failed WSL probe stays retryable', () => {
  const probe = code.slice(code.indexOf('procedure ProbeWsl'), code.indexOf('function SelectedDistroName'));
  // Latching WslProbed before the probe made a transient failure (cold WSL
  // past the timeout) permanent for the whole wizard.
  assert.match(probe, /WslOk := RunHelper\(TempHelper\('wsl-probe\.ps1'\), ''\);\s*\n\s*WslProbed := WslOk;/);
  assert.doesNotMatch(probe, /WslProbed := True;/);
});

test('installer: R6 - the no-reason fallback names no path an end user does not have', () => {
  assert.ok(
    iss.includes("'The step could not be completed and gave no reason. Run this Setup again; if it keeps failing, report the text above.'"),
    'the fallback reason must be the pathless one',
  );
  assert.doesNotMatch(code, /installer\\helpers/, 'an installed copy has no installer\\helpers directory');
});

test('installer: R7 - the WSL page does not repeat its own paragraph in a message box', () => {
  // WslPage.MsgLabel.Caption already shows Reason.
  assert.ok(
    code.includes("SuppressibleMsgBox('WSL 2 is not ready on this PC. Follow the steps shown on this page, then run this Setup again.', mbCriticalError, MB_OK, IDOK);"),
    'the WSL page box must be the one-liner',
  );
});

test('installer: R9 - the EnsureDefaults comment says what is actually measured', () => {
  const comment = iss.slice(iss.indexOf('{ Belt and braces'), iss.indexOf('procedure EnsureDefaults'));
  assert.ok(comment.includes('Inno simulates a Next click on every'), comment);
  assert.ok(comment.includes('normally unreachable'), comment);
  assert.doesNotMatch(iss, /A silent install \(\/SILENT, \/VERYSILENT\) never shows a page/);
});

test('installer: R10 - an empty WSL folder or data dir stops the install instead of being quoted through', () => {
  // IsWslSafe('') is True, so WslArg('') would hand the helper a quoted nothing.
  const step = code.slice(code.indexOf('procedure CurStepChanged'), code.indexOf('{ ---------------------------- uninstall'));
  assert.match(
    step,
    /if \(SelectedDataDir = ''\) or \(AppDirPage\.Values\[0\] = ''\) then\s*\n\s*RaiseException\('Setup lost the WSL folder answers; run this Setup again\.'\);/,
  );
  assert.ok(step.indexOf('RaiseException(\'Setup lost') < step.indexOf("Params := '-Distro '"), 'the guard must run before the Params are built');
});

/* -------------------------------------------------------------------------
 * Phase E: the Setup is also run SILENTLY, by the app itself, under a
 * running install. Everything below is about that run being an upgrade of
 * THIS install rather than a second copy somewhere else.
 * ---------------------------------------------------------------------- */

test('installer: an upgrade reads the previous install with the same reader the uninstaller uses', () => {
  const fn = code.slice(code.indexOf('procedure LoadPreviousInstall'), code.indexOf('function DefaultedAppDir'));
  assert.ok(fn.length > 0, 'LoadPreviousInstall must exist');
  // install-info.txt is the record of where the last install went: the same
  // key=value file, the same LoadStringsFromFile + GetVal pair, as
  // CurUninstallStepChanged reads.
  // WizardDirValue, never ExpandConstant('{app}') here: measured on Inno
  // 6.7.1, the app constant is not initialized yet in InitializeWizard and
  // expanding it raises. WizardDirValue is already the destination — and
  // already the PREVIOUS install's directory, restored by UsePreviousAppDir.
  assert.match(fn, /InfoFile := AddBackslash\(WizardDirValue\) \+ 'install-info\.txt';/);
  assert.doesNotMatch(fn, /ExpandConstant\('\{app\}/);
  assert.match(fn, /LoadStringsFromFile\(InfoFile, LastResult\);/);
  assert.match(fn, /Distro := GetVal\('distro'\);/);
  assert.match(fn, /AppDir := GetVal\('appDir'\);/);
  // Both values pass the one command-line guard before they are remembered,
  // and it is all-or-nothing: a remembered distro with a guessed folder is a
  // second copy inside the right distribution.
  assert.match(fn, /if IsWslSafe\(Distro\) and IsWslSafe\(AppDir\) then/);
  assert.match(fn, /if \(Distro = ''\) or \(AppDir = ''\) then\s*\n\s*Exit;/);
  // It runs before any page can be shown.
  assert.match(code, /procedure InitializeWizard;[\s\S]*?LoadPreviousInstall;/);
});

test('installer: /SILENT prefers the previous install BEFORE it picks a distribution', () => {
  const ensure = code.slice(code.indexOf('procedure EnsureDefaults'), code.indexOf('procedure CurStepChanged'));
  // The in-app update runs `/SILENT`, where no page is shown at all. Picking
  // this PC's default distribution there would install a SECOND copy beside
  // the running one, in a distro the user never chose.
  assert.match(
    ensure,
    /if \(PrevDistro <> ''\) and \(PrevAppDir <> ''\) then\s*\n\s*begin\s*\n\s*SelectedDistro := PrevDistro;\s*\n\s*if not ProbeDistro\(SelectedDistro\) then\s*\n\s*RaiseException\(Reason\);\s*\n\s*AppDirPage\.Values\[0\] := PrevAppDir;\s*\n\s*Exit;\s*\n\s*end;/,
  );
  // …before the probe pick, not after it.
  assert.ok(
    ensure.indexOf('PrevDistro <> ') < ensure.indexOf("RunHelper(TempHelper('wsl-probe.ps1'), '')"),
    'the remembered install must be preferred before the probe runs',
  );
});

test('installer: the wizard pages default to the previous install too', () => {
  // The distribution page pre-selects it (after the PC-default loop, so it
  // wins), and the Linux folder page defaults to the folder already in use —
  // but only while the same distribution is selected, since that path is a
  // path inside its home.
  const probe = code.slice(code.indexOf('procedure ProbeWsl'), code.indexOf('function SelectedDistroName'));
  assert.match(
    probe,
    /if DistroNames\[I\] = GetVal\('default'\) then\s*\n\s*DistroPage\.SelectedValueIndex := I;[\s\S]*?if DistroNames\[I\] = PrevDistro then\s*\n\s*DistroPage\.SelectedValueIndex := I;/,
  );
  const fn = code.slice(code.indexOf('function DefaultedAppDir'), code.indexOf('procedure InitializeWizard'));
  assert.match(fn, /Result := DefaultAppDir;/);
  assert.match(fn, /if \(PrevAppDir <> ''\) and \(PrevDistro = SelectedDistro\) then\s*\n\s*Result := PrevAppDir;/);
  // Every place that fills the folder answer goes through it — a leftover
  // `:= DefaultAppDir` would silently move an upgrade to a new folder.
  assert.equal((code.match(/AppDirPage\.Values\[0\] := DefaultedAppDir;/g) ?? []).length, 3);
  assert.equal((code.match(/AppDirPage\.Values\[0\] := DefaultAppDir;/g) ?? []).length, 0);
});
