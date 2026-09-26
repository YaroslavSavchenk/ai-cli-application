/**
 * The Windows-side instance folder of the native host: which folder under
 * %LOCALAPPDATA% a launch's host owns (the staged exe copy, `host-ready`,
 * `host.log` and the WebView2 profile). The installed app — whatever its data
 * dir — and a clone launch on the default backend data dir use
 * `ai-session-manager\`; a CLONE launch (`launch.ps1` off the
 * `\\wsl.localhost\…` share) on any other data dir — the dev flow,
 * `AI_SM_DATA_DIR=~/.ai-session-manager-dev` beside the installed app
 * (Nocturne C1 fix after release, the live check in DEV) — uses
 * `ai-session-manager-dev\`.
 *
 * How: the rule itself (`Test-AiSmDevInstance` in
 * `launcher/config-common.ps1`) is RUN through `powershell.exe` interop,
 * skipped where there is none (CI). Everything else is a source read, the
 * idiom of `tests/release/host-webmessage.test.ts`: the C# host cannot run
 * here, and `launch.ps1`'s host tier cannot run without starting a window.
 *
 * Why it matters: launch.ps1 waits for `host-ready` in the folder IT computed,
 * and the host writes it in the folder IT computed — two sides that disagree
 * make every launch fall back to Edge after 8 s. And a dev window that lands
 * in the installed app's folder joins the installed app's WebView2 browser
 * process and profile: the user's running app then shares a process with
 * whatever the dev build does. And an INSTALLED launcher that counted as a
 * dev instance would lose the user's saved WebView2 profile once, move
 * `host.log`, and leave a folder its uninstaller does not remove.
 *
 * NOT claimed: that the compiled host or a real launch behaves this way — the
 * live check in DEV does (the dev window's files appear under
 * `%LOCALAPPDATA%\ai-session-manager-dev\`, the installed app's folder is
 * untouched).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { projectRoot, readSource, makeTempDir, removeTempDir } from '../helpers/helpers.ts';
import { powershell, run, skip, toWindowsPath } from '../helpers/launcher-config-fixture.ts';

const cs = readSource('launcher', 'host', 'AiSessionManagerHost.cs');
const common = readSource('launcher', 'config-common.ps1');
const launch = readSource('launcher', 'launch.ps1');

/** The value of a `private const string Name = "…";` in the host. */
function csConst(name: string): string | undefined {
  return new RegExp(`private const string ${name} = "([^"]*)";`).exec(cs)?.[1];
}

/** The value of a top-level `$Name = '…'` in config-common.ps1. */
function psVar(name: string): string | undefined {
  return new RegExp(`^\\$${name}\\s*=\\s*'([^']*)'`, 'm').exec(common)?.[1];
}

test('the host and config-common.ps1 name the same two folders and the same switch', () => {
  const pairs: Array<[string, string, string]> = [
    ['DataFolderName', 'AiSmWindowsDataName', 'ai-session-manager'],
    ['DevDataFolderName', 'AiSmWindowsDevDataName', 'ai-session-manager-dev'],
    ['DevInstanceSwitch', 'AiSmHostDevSwitch', '--dev-instance'],
  ];
  for (const [inCs, inPs, value] of pairs) {
    assert.equal(csConst(inCs), value, `host ${inCs}`);
    assert.equal(psVar(inPs), value, `config-common.ps1 $${inPs}`);
  }
  assert.equal(psVar('AiSmDefaultDataDir'), '~/.ai-session-manager', 'the default backend data dir');
});

test('the host takes its folder from the switch alone, never from a path or the environment', () => {
  // One assignment of _dataDir, and it picks one of the two fixed names.
  const assignments = cs.match(/^\s*_dataDir = /gm) ?? [];
  assert.equal(assignments.length, 1, 'exactly one assignment of _dataDir');
  assert.match(
    cs,
    /_dataDir = Path\.Combine\(localAppData,\s*devInstance \? DevDataFolderName : DataFolderName\);/,
  );
  assert.match(cs, /bool devInstance = IsDevInstance\(args\);/);
  // The switch is compared whole and ordinally: no prefix, no case folding.
  assert.match(
    cs,
    /return args != null && args\.Length >= 2\s*&& string\.Equals\(args\[1\], DevInstanceSwitch, StringComparison\.Ordinal\);/,
  );
  assert.doesNotMatch(cs, /GetEnvironmentVariable/, 'the host reads no environment variable at all');
  // The folder names appear once each, in their const: nothing else hardcodes one.
  assert.equal(cs.split('"ai-session-manager"').length - 1, 1, 'the installed folder name, once');
  assert.equal(cs.split('"ai-session-manager-dev"').length - 1, 1, 'the dev folder name, once');
});

test('the host refuses any word after the URL but the switch, before a window exists', () => {
  const refusal = cs.indexOf('if (args.Length > 2 || (args.Length == 2 && !devInstance))');
  assert.notEqual(refusal, -1, 'the refusal of an unknown argument is gone');
  assert.match(cs.slice(refusal, refusal + 300), /return 2;/, 'an unknown argument exits 2');
  assert.ok(refusal < cs.indexOf('BuildForm(userDataFolder, uri)'), 'refused before the window is built');
});

test('every Windows-side file the host keeps derives from _dataDir', () => {
  for (const [what, re] of [
    ['host-ready', /_readySentinel = Path\.Combine\(_dataDir, "host-ready"\);/],
    ['host.log', /_logFile = Path\.Combine\(_dataDir, "host\.log"\);/],
    ['the WebView2 profile', /string userDataFolder = Path\.Combine\(_dataDir, "webview2"\);/],
    ['the local app.ico', /string ico = Path\.Combine\(_dataDir, "app\.ico"\);/],
  ] as const) {
    assert.match(cs, re, what);
  }
  // The overlay has no profile of its own: it runs on the main window's
  // environment, so it follows the same folder.
  assert.match(cs, /mainView\.CoreWebView2\.Environment/);
  assert.match(cs, /props\.UserDataFolder = userDataFolder;/);
});

test('launch.ps1 stages, waits and passes the switch from the one dev-instance rule', () => {
  assert.match(launch, /^\$DataDir = if \(\$env:AI_SM_DATA_DIR\) \{ \$env:AI_SM_DATA_DIR \} else \{ \$AiSmDefaultDataDir \}$/m);
  // One call of the rule, and both the folder and the switch come from it.
  assert.equal(launch.split('Test-AiSmDevInstance -DataDir').length - 1, 1, 'the rule, asked once');
  assert.match(launch, /\$devInstance\s*= Test-AiSmDevInstance -DataDir \$DataDir -ScriptRoot \$PSScriptRoot/);
  assert.match(launch, /\$instanceName\s*= if \(\$devInstance\) \{ \$AiSmWindowsDevDataName \} else \{ \$AiSmWindowsDataName \}/);
  assert.match(launch, /if \(\$devInstance\) \{ \$hostArgs \+= \$AiSmHostDevSwitch \}/);
  // The rule's clone test is the one launch.ps1 stages the exe on: a script
  // root on the \\wsl.localhost share. Installed = run in place, never dev.
  assert.match(launch, /if \(\$PSScriptRoot -and -not \$PSScriptRoot\.StartsWith\('\\\\'\)\) \{\s*# Installed/);
  assert.match(common, /return \(\$ScriptRoot\.StartsWith\('\\\\'\) -and \$DataDir -cne \$AiSmDefaultDataDir\)/);
  assert.match(launch, /\$readySentinel = Join-Path \(Join-Path \$localAppData \$instanceName\) 'host-ready'/);
  assert.match(launch, /\$localDir = Join-Path \(Join-Path \$localAppData \$instanceName\) 'host'/);
  assert.match(launch, /Start-Process -FilePath \$hostExe -ArgumentList \$hostArgs /);
  // No second, fixed copy of the folder name left to disagree with the rule.
  assert.doesNotMatch(launch, /'ai-session-manager\\/, 'a hardcoded Windows folder in launch.ps1');
});

test('a clone launch on any data dir but the default is a dev instance; an installed launch never is', { skip }, async () => {
  const dir = await makeTempDir('ai-sm-instance-');
  try {
    const script = join(dir, 'instance.ps1');
    await writeFile(
      script,
      String.raw`
$ErrorActionPreference = 'Stop'
. $args[0]
$roots = [ordered]@{
    clone     = '\\wsl.localhost\Ubuntu\home\you\projects\ai-cli-application\launcher'
    installed = 'C:\Users\you\AppData\Local\Programs\AI Session Manager'
}
$cases = @('~/.ai-session-manager', '~/.ai-session-manager-dev', '/home/you/.ai-session-manager', '~/.AI-session-manager', '~/.ai-session-manager/')
$out = foreach ($r in $roots.Keys) {
    foreach ($c in $cases) { $r + ' ' + $c + '=' + (Test-AiSmDevInstance -DataDir $c -ScriptRoot $roots[$r]) }
}
[Console]::Out.Write(($out -join "|"))
`,
      'ascii',
    );
    const res = await run(powershell!, [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      await toWindowsPath(script),
      await toWindowsPath(join(projectRoot, 'launcher', 'config-common.ps1')),
    ]);
    assert.equal(res.code, 0, res.out);
    const seen = new Map(res.stdout.trim().split('|').map((row) => row.split('=') as [string, string]));
    const expected: Array<[string, string]> = [
      ['clone ~/.ai-session-manager', 'False'],
      ['clone ~/.ai-session-manager-dev', 'True'],
      // Another spelling of the default's folder is a second instance too: it
      // only costs a fresh profile, never a shared one.
      ['clone /home/you/.ai-session-manager', 'True'],
      ['clone ~/.AI-session-manager', 'True'],
      ['clone ~/.ai-session-manager/', 'True'],
      // The installed app stays untouched, whatever AI_SM_DATA_DIR says.
      ['installed ~/.ai-session-manager', 'False'],
      ['installed ~/.ai-session-manager-dev', 'False'],
      ['installed /home/you/.ai-session-manager', 'False'],
      ['installed ~/.AI-session-manager', 'False'],
      ['installed ~/.ai-session-manager/', 'False'],
    ];
    assert.equal(seen.size, expected.length, `every row answered: ${res.stdout}`);
    for (const [row, want] of expected) {
      assert.equal(seen.get(row), want, `launch ${row}`);
    }
  } finally {
    await removeTempDir(dir);
  }
});
