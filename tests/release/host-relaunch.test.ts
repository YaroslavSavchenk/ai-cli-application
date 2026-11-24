/**
 * The in-window Restart of the native host (Q17 P2,
 * `.claude/plans/quality/PLAN-Q17.md` § P2): the page posts the bare word
 * `relaunch`, the host runs the SAME launcher that opened it (from the
 * relaunch record `launch.ps1` wrote into the instance folder) on the same
 * backend data dir, closes itself when the launcher reports success, and
 * answers `relaunch-failed` otherwise.
 *
 * WHAT THIS TEST IS. Two halves.
 *
 *  1. Source pins over `launcher/host/AiSessionManagerHost-relaunch.cs`, the
 *     handler in `-clipboard.cs`, `Main` and `launch.ps1` — the idiom of
 *     `tests/release/host-webmessage.test.ts`: the order of the checks, the
 *     single flight, the timeout, the window close, the log rule, and the
 *     constants the host shares with `config-common.ps1`.
 *  2. Behaviour, through `powershell.exe` interop (skipped where there is
 *     none, i.e. CI): the host's pure parts — `IsRelaunchMessage`,
 *     `TryParseRelaunchRecord` and the copy-files shape check it reuses —
 *     are CUT from the C# source and compiled by `Add-Type` (the Framework
 *     compiler, the same C# 5 dialect as `build-host.ps1`'s csc), then run
 *     against a table of records; and `launch.ps1`'s `Write-RelaunchRecord`
 *     is cut out and run, and its file is fed to that same compiled parser
 *     (the two sides agree on the format by behaviour, not by text).
 *
 * WHAT IT CANNOT PROVE: that the compiled host starts powershell, waits,
 * closes, or that a real relaunch boots WSL — no window, no WSL restart and
 * no real `launch.ps1` run may happen from here (the 2026-11-21/22 incident:
 * a launcher run from WSL stopped the user's installed app). That is the
 * user's Windows checklist (§ Final gate items 1 and 3).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { projectRoot, readSource, readSources, makeTempDir, removeTempDir } from '../helpers/helpers.ts';
import { HOST_SOURCES, csConst, csharpCode, csharpMember, logArguments, psVar, rawMember } from '../helpers/host-sources.ts';
import { powershell, run, skip, toWindowsPath } from '../helpers/launcher-config-fixture.ts';

const RELAUNCH_CS = 'launcher/host/AiSessionManagerHost-relaunch.cs';
const cs = readSource(RELAUNCH_CS);
const clipboardCs = readSource('launcher/host/AiSessionManagerHost-clipboard.cs');
const mainCs = readSource('launcher/host/AiSessionManagerHost.cs');
const host = readSources(...HOST_SOURCES);
const common = readSource('launcher', 'config-common.ps1');
const launch = readSource('launcher', 'launch.ps1');

const member = (signature: string, text: string = cs) => csharpMember(text, signature, RELAUNCH_CS);

// --- the message -------------------------------------------------------------

test('relaunch: the two message strings, and the kind is compared whole and ordinally', () => {
  assert.equal(csConst(cs, 'RelaunchKind'), 'relaunch');
  assert.equal(csConst(cs, 'RelaunchFailed'), 'relaunch-failed');
  assert.match(
    member('private static bool IsRelaunchMessage('),
    /return string\.Equals\(text, RelaunchKind, StringComparison\.Ordinal\);/,
  );
});

test('relaunch: the handler hands it off after the origin and length checks, before any copy-files parsing', () => {
  const handler = csharpMember(clipboardCs, 'private static void WebView_WebMessageReceived(', 'clipboard');
  const origin = handler.indexOf('IsLaunchOrigin(');
  const cap = handler.indexOf('webMessageText.Length > MaxWebMessageLength');
  const kind = handler.indexOf('if (IsRelaunchMessage(webMessageText)) { StartRelaunch(wv); return; }');
  const split = handler.indexOf("webMessageText.Split('\\n')");
  assert.ok(origin !== -1 && cap !== -1 && kind !== -1 && split !== -1, 'a step of the handler is missing');
  assert.ok(origin < cap && cap < kind && kind < split, 'origin, then the cap, then relaunch, then copy-files');
  // One call site: no other path into a relaunch.
  assert.equal(host.split('StartRelaunch(').length - 1, 2, 'declared once, called once');
});

// --- what is run --------------------------------------------------------------

test('relaunch: the record name, the default data dir and the allow-list are byte-equal to config-common.ps1', () => {
  assert.equal(csConst(cs, 'RelaunchRecordName'), psVar(common, 'AiSmRelaunchRecordName'));
  assert.equal(csConst(cs, 'RelaunchRecordName'), 'relaunch.txt');
  assert.equal(csConst(cs, 'DefaultBackendDataDir'), psVar(common, 'AiSmDefaultDataDir'));
  const csPattern = /private static readonly Regex BackendDataDirPattern = new Regex\(\s*@"([^"]*)"/.exec(cs)?.[1];
  assert.equal(csPattern, psVar(common, 'AiSmDataDirPattern'));
  assert.equal(csConst(cs, 'LauncherFileName'), 'launch.ps1');
  // csConst reads a verbatim @"…" constant too.
  assert.equal(csConst(cs, 'WslSharePrefix'), '\\\\wsl.localhost\\');
});

test('relaunch: the record is read once, in Main, after the argument checks and before the window', () => {
  assert.equal(host.split('LoadRelaunchRecord(').length - 1, 2, 'declared once, called once');
  const call = mainCs.indexOf('LoadRelaunchRecord(devInstance);');
  assert.notEqual(call, -1);
  assert.ok(mainCs.indexOf('_launchOrigin = uri;') < call, 'after the URL is accepted');
  assert.ok(call < mainCs.indexOf('BuildForm(userDataFolder, uri)'), 'before the window exists');
  // From the instance folder the switch picked, and nowhere else.
  assert.match(cs, /new FileInfo\(Path\.Combine\(_dataDir, RelaunchRecordName\)\)/);
  // The two values are only ever set from a record that parsed.
  const load = member('private static void LoadRelaunchRecord(');
  assert.ok(
    load.indexOf('TryParseRelaunchRecord(text, devInstance, out launcher, out dataDir)') <
      load.indexOf('_relaunchLauncher = launcher;'),
  );
  // Test gate 2026-11-24: the data dir the launcher runs on is the PARSED one
  // (a mutant setting the default data dir here — a dev window relaunching
  // the installed app — passed), and the file is size-checked before it is read.
  assert.match(load, /_relaunchLauncher = launcher; _relaunchDataDir = dataDir;/);
  const cap = load.indexOf('if (record.Length > MaxRelaunchRecordLength)');
  assert.notEqual(cap, -1, 'no size check before the read');
  assert.ok(cap < load.indexOf('File.ReadAllText(record.FullName)'), 'the size is checked before the read');
  assert.equal(host.split('_relaunchLauncher = ').length - 1, 1, 'one assignment');
  assert.equal(host.split('_relaunchDataDir = ').length - 1, 1, 'one assignment');
});

test('relaunch: the launcher runs in-box powershell, hidden, without -Silent, on the record data dir', () => {
  const start = member('private static void StartRelaunch(');
  assert.match(
    start,
    /new ProcessStartInfo\( InBoxPowerShell\(\), "-NoProfile -ExecutionPolicy Bypass -File \\"" \+ _relaunchLauncher \+ "\\""\);/,
  );
  assert.doesNotMatch(start, /-Silent/);
  assert.match(start, /psi\.UseShellExecute = false;/);
  assert.match(start, /psi\.CreateNoWindow = true;/);
  assert.match(start, /psi\.EnvironmentVariables\[BackendDataDirVariable\] = _relaunchDataDir;/);
  assert.equal(csConst(cs, 'BackendDataDirVariable'), 'AI_SM_DATA_DIR');
  assert.match(
    member('private static string InBoxPowerShell('),
    /Environment\.GetFolderPath\(Environment\.SpecialFolder\.System\), "WindowsPowerShell", "v1\.0", "powershell\.exe"\)/,
  );
  // Every relaunch event runs on the UI thread.
  assert.match(start, /launcher\.SynchronizingObject = _form;/);
  assert.match(start, /launcher\.EnableRaisingEvents = true;/);
});

test('relaunch: single flight, and no record means relaunch-failed', () => {
  const start = member('private static void StartRelaunch(');
  const busy = start.indexOf('if (_relaunchBusy) {');
  assert.notEqual(busy, -1, 'no single-flight check');
  const busyBranch = start.slice(busy, start.indexOf('}', busy));
  assert.match(busyBranch, /return;/);
  assert.doesNotMatch(busyBranch, /PostRelaunchFailed/, 'a duplicate is ignored, not answered');
  assert.ok(busy < start.indexOf('launcher.Start()'), 'checked before anything starts');
  assert.match(start, /if \(_relaunchLauncher == null \|\| _relaunchDataDir == null\) \{[^}]*PostRelaunchFailed\(wv\); return; \}/);
  assert.match(start, /_relaunchBusy = true; _relaunchProcess = launcher; _relaunchTimedOut = false; _relaunchSentinelBefore = ReadSentinelPid\(\);/);
  // The flight is freed in ONE place, and only EndRelaunch sets it false.
  assert.equal(cs.split('_relaunchBusy = false;').length - 1, 1);
  assert.match(member('private static void EndRelaunch('), /_relaunchBusy = false;/);
});

test('relaunch: success closes this window, a non-zero exit answers relaunch-failed, every exit disposes', () => {
  const exited = member('private static void RelaunchLauncher_Exited(');
  // A process that is not the running one is disposed and ignored.
  assert.match(exited, /if \(!ReferenceEquals\(launcher, _relaunchProcess\)\) \{ launcher\.Dispose\(\); return; \}/);
  // The running one: exit code read, then disposed, before any branch.
  const disposed = exited.indexOf('_relaunchProcess = null; launcher.Dispose();');
  assert.notEqual(disposed, -1, 'the running launcher is not disposed on exit');
  assert.ok(exited.indexOf('code = launcher.ExitCode;') < disposed);
  assert.ok(disposed < exited.indexOf('if (_relaunchTimedOut)'));
  assert.equal(exited.split('.Dispose();').length - 1, 2, 'both Exited paths dispose');
  assert.match(exited, /if \(code != 0\) \{[^}]*PostRelaunchFailed\(_webView\); return; \}/);
  assert.ok(exited.indexOf('if (code != 0)') < exited.indexOf('CloseThisWindow();'));
  assert.match(member('private static void CloseThisWindow('), /form\.Close\(\);/);
});

test('relaunch: the 120 s timeout kills the launcher, answers relaunch-failed and HOLDS the flight', () => {
  assert.match(cs, /private const int RelaunchTimeoutMs = 120000;/);
  const tick = member('private static void RelaunchTimer_Tick(');
  assert.match(tick, /_relaunchTimedOut = true;/);
  // The whole guard, not only the call (test gate 2026-11-24: `if (false)` passed).
  assert.match(tick, /if \(!launcher\.HasExited\) \{ launcher\.Kill\(\); \}/);
  assert.match(tick, /PostRelaunchFailed\(_webView\);/);
  assert.doesNotMatch(tick, /CloseThisWindow|EndRelaunch|_relaunchBusy|_relaunchProcess = null|Dispose\(\)/,
    'the tick must not free the flight or drop the launcher: its Exited does');
});

test('relaunch: after a timeout, a window the killed launcher started still closes this one', () => {
  const exited = member('private static void RelaunchLauncher_Exited(');
  const timedOut = exited.slice(exited.indexOf('if (_relaunchTimedOut)'), exited.indexOf('EndRelaunch();'));
  // Checked at the exit, then a 1 s tail watch for RelaunchTailTicks ticks.
  assert.match(timedOut, /if \(CloseIfNewHostWindowIsUp\(\)\) \{ return; \}/);
  assert.match(timedOut, /_relaunchTailLeft = RelaunchTailTicks;/);
  assert.match(timedOut, /_relaunchTimer\.Interval = RelaunchTailTickMs;/);
  assert.match(timedOut, /_relaunchTimer\.Tick \+= RelaunchTail_Tick;/);
  assert.doesNotMatch(timedOut, /EndRelaunch|PostRelaunchFailed/, 'no second answer, the flight still held');
  assert.match(cs, /private const int RelaunchTailTicks = 10;/);
  assert.match(cs, /private const int RelaunchTailTickMs = 1000;/);
  const tail = member('private static void RelaunchTail_Tick(');
  assert.match(tail, /if \(CloseIfNewHostWindowIsUp\(\)\) \{ return; \}/);
  assert.match(tail, /if \(_relaunchTailLeft <= 0\) \{ EndRelaunch\(\);/);
  const closeIf = member('private static bool CloseIfNewHostWindowIsUp(');
  assert.ok(closeIf.indexOf('EndRelaunch();') < closeIf.indexOf('CloseThisWindow();'));
  // The new window is the one in host-ready that is neither this process nor
  // the pid host-ready named when the relaunch started.
  const up = member('private static bool NewHostWindowIsUp(');
  assert.match(up, /pid == 0 \|\| pid == _relaunchSentinelBefore \|\| pid == Process\.GetCurrentProcess\(\)\.Id/);
});

test('relaunch: host.log gets fixed words, a pid, an exit code and exception CLASSES - no URL, token or path', () => {
  const args = logArguments(csharpCode(cs));
  assert.ok(args.length >= 8, `expected the relaunch Log calls, found ${args.length}`);
  for (const arg of args) {
    const code = arg.replace(/"(?:[^"\\]|\\.)*"/g, '""');
    assert.doesNotMatch(code, /\.Message\b/, `an exception message: ${arg}`);
    for (const name of ['_relaunchLauncher', '_relaunchDataDir', 'text', 'first', 'second', 'shape', '_launchOrigin', 'uri', 'record']) {
      assert.ok(!new RegExp(`\\b${name}\\b`).test(code), `a Log call names ${name}: ${arg}`);
    }
  }
  assert.match(cs, /Log\("relaunch started: launcher pid "/);
});

// --- launch.ps1 writes the record ---------------------------------------------

test('launch.ps1 writes the relaunch record into the instance folder before it starts the host', () => {
  const open = launch.slice(launch.indexOf('function Open-NativeHost('), launch.indexOf('function Find-Edge'));
  const write = open.indexOf('Write-RelaunchRecord -InstanceDir (Join-Path $localAppData $instanceName)');
  assert.notEqual(write, -1);
  assert.ok(write < open.indexOf('Start-Process -FilePath $hostExe'), 'before the host starts');
  assert.match(launch, /\$record = Join-Path \$InstanceDir \$AiSmRelaunchRecordName/);
  assert.match(launch, /\$text = \(Join-Path \$PSScriptRoot 'launch\.ps1'\) \+ "`n" \+ \$DataDir \+ "`n"/);
  // Removed first, so a failed write cannot leave an older record behind.
  // (Test gate 2026-11-24: without the -1 check a DELETED Remove-Item passed.)
  const removed = launch.indexOf('Remove-Item -LiteralPath $record');
  assert.notEqual(removed, -1, 'the old record is not removed first');
  assert.ok(removed < launch.indexOf('WriteAllText($record'));
});

// --- behaviour, through powershell.exe ------------------------------------------

/** A `private const …` / `private static readonly …` field statement of `text`. */
function rawField(text: string, name: string): string {
  const m = new RegExp(`private (?:const|static readonly) [^=\\n]*\\b${name} =[\\s\\S]*?;\\r?\\n`).exec(text);
  assert.ok(m, `field ${name} not found`);
  return m[0];
}

/** The host's pure relaunch parts, cut from the source as one compilable class. */
function probeClass(): string {
  const fields = [
    [cs, 'RelaunchKind'],
    [cs, 'LauncherFileName'],
    [cs, 'MaxRelaunchRecordLength'],
    [cs, 'WslSharePrefix'],
    [cs, 'LegacyWslSharePrefix'],
    [cs, 'DefaultBackendDataDir'],
    [cs, 'InstalledDataFolderName'],
    [cs, 'BackendDataDirPattern'],
    [clipboardCs, 'MaxWindowsPathLength'],
    [clipboardCs, 'UncPathPrefix'],
    [clipboardCs, 'DrivePathPrefix'],
    [clipboardCs, 'ReservedPathChars'],
  ].map(([text, name]) => rawField(text!, name!));
  const members = [
    rawMember(cs, 'private static bool IsRelaunchMessage('),
    rawMember(cs, 'private static bool TryParseRelaunchRecord('),
    rawMember(cs, 'private static bool IsInstalledAppDataDir('),
    rawMember(clipboardCs, 'private static bool IsAcceptableWindowsPath('),
    rawMember(clipboardCs, 'private static bool IsAcceptableSegment('),
  ];
  return [
    'using System;',
    'using System.IO;',
    'using System.Text.RegularExpressions;',
    'public static class RelaunchProbe',
    '{',
    ...fields,
    ...members,
    '    public static string Parse(string text, bool dev)',
    '    {',
    '        string l; string d;',
    '        return TryParseRelaunchRecord(text, dev, out l, out d) ? ("ok|" + l + "|" + d) : "refused";',
    '    }',
    '    public static bool IsRelaunch(string text) { return IsRelaunchMessage(text); }',
    '}',
  ].join('\n');
}

const INSTALLED = 'C:\\Users\\you\\AppData\\Local\\Programs\\AI Session Manager\\launch.ps1';
const CLONE = '\\\\wsl.localhost\\Ubuntu\\home\\you\\projects\\ai-cli-application\\launcher\\launch.ps1';
const CLONE_OLD_SHARE = '\\\\wsl$\\Ubuntu\\home\\you\\projects\\ai-cli-application\\launcher\\launch.ps1';
const DEV = '~/.ai-session-manager-dev';
const DEFAULT = '~/.ai-session-manager';

/** [record text, dev instance?, expected answer]. */
const RECORDS: Array<[string, boolean, string]> = [
  [`${INSTALLED}\n${DEFAULT}\n`, false, `ok|${INSTALLED}|${DEFAULT}`],
  [`${CLONE}\n${DEV}\n`, true, `ok|${CLONE}|${DEV}`],
  [`${CLONE}\r\n${DEV}\r\n`, true, `ok|${CLONE}|${DEV}`],
  [`${CLONE}\n${DEV}`, true, `ok|${CLONE}|${DEV}`],
  [`${CLONE_OLD_SHARE}\n${DEV}\n`, true, `ok|${CLONE_OLD_SHARE}|${DEV}`],
  [`${CLONE}\n/home/you/.ai-sm-dev\n`, true, `ok|${CLONE}|/home/you/.ai-sm-dev`],
  [`${CLONE.replace('launch.ps1', 'LAUNCH.PS1')}\n${DEV}\n`, true, `ok|${CLONE.replace('launch.ps1', 'LAUNCH.PS1')}|${DEV}`],
  // A clone launch on the default data dir is NOT a dev instance: allowed.
  [`${CLONE}\n${DEFAULT}\n`, false, `ok|${CLONE}|${DEFAULT}`],
  // A dev instance never relaunches on the installed app's data dir, however
  // it is spelled, nor through a `.` / `..` segment.
  [`${CLONE}\n${DEFAULT}\n`, true, 'refused'],
  [`${CLONE}\n/home/you/.ai-session-manager\n`, true, 'refused'],
  [`${CLONE}\n~/./.ai-session-manager\n`, true, 'refused'],
  [`${CLONE}\n~/x/../.ai-session-manager\n`, true, 'refused'],
  [`${CLONE}\n~/.ai-session-manager-dev/..\n`, true, 'refused'],
  [`${CLONE}\n~/./dev\n`, true, 'refused'],
  [`${CLONE}\n/home/you/apps/.ai-session-manager\n`, true, 'refused'],
  // ... while a name that only starts or ends alike is a different folder.
  [`${CLONE}\n~/.ai-session-manager.dev\n`, true, `ok|${CLONE}|~/.ai-session-manager.dev`],
  [`${CLONE}\n~/x.ai-session-manager\n`, true, `ok|${CLONE}|~/x.ai-session-manager`],
  // The installed app (not dev) keeps whatever its launcher used.
  [`${INSTALLED}\n/home/you/.ai-session-manager\n`, false, `ok|${INSTALLED}|/home/you/.ai-session-manager`],
  // Shape of the record.
  ['', false, 'refused'],
  [`${INSTALLED}\n`, false, 'refused'],
  [`${INSTALLED}\n${DEFAULT}\nextra\n`, false, 'refused'],
  [`${INSTALLED}\n${DEFAULT}\n\n`, false, 'refused'],
  [`${INSTALLED}\n${DEFAULT}${'/x'.repeat(5000)}\n`, false, 'refused'],
  // The launcher line.
  [`C:\\Users\\you\\evil.ps1\n${DEFAULT}\n`, false, 'refused'],
  [`C:\\Users\\you\\launch.ps1.txt\n${DEFAULT}\n`, false, 'refused'],
  [`C:\\Users\\you\\launch.ps1:hidden\n${DEFAULT}\n`, false, 'refused'],
  [`launcher\\launch.ps1\n${DEFAULT}\n`, false, 'refused'],
  [`\\\\attacker\\share\\launch.ps1\n${DEFAULT}\n`, false, 'refused'],
  [`C:\\Users\\you\\..\\launch.ps1\n${DEFAULT}\n`, false, 'refused'],
  [`C:/Users/you/launch.ps1\n${DEFAULT}\n`, false, 'refused'],
  [`C:\\Users\\you" -Command evil "\\launch.ps1\n${DEFAULT}\n`, false, 'refused'],
  [`C:\\Users\\you\tx\\launch.ps1\n${DEFAULT}\n`, false, 'refused'],
  // The data dir line: launch.ps1's own allow-list.
  [`${INSTALLED}\n~/my data\n`, false, 'refused'],
  [`${INSTALLED}\n~/x;rm -rf ~\n`, false, 'refused'],
  [`${INSTALLED}\n~/$(evil)\n`, false, 'refused'],
  [`${INSTALLED}\nrelative/dir\n`, false, 'refused'],
  [`${INSTALLED}\n~\n`, false, 'refused'],
  [`${INSTALLED}\n~user/x\n`, false, 'refused'],
];

const MESSAGES: Array<[string, boolean]> = [
  ['relaunch', true],
  ['Relaunch', false],
  ['RELAUNCH', false],
  [' relaunch', false],
  ['relaunch ', false],
  ['relaunch\n', false],
  ['relaunch\nC:\\x\\launch.ps1', false],
  ['relaunch-failed', false],
  ['', false],
];

test('relaunch: the cut-out C# answers every record and message as specified', { skip }, async () => {
  const dir = await makeTempDir('ai-sm-relaunch-');
  try {
    await writeFile(join(dir, 'probe.cs'), probeClass(), 'utf8');
    await writeFile(
      join(dir, 'cases.json'),
      JSON.stringify({
        records: RECORDS.map(([text, dev]) => ({ text, dev })),
        messages: MESSAGES.map(([text]) => text),
      }),
      'utf8',
    );
    await writeFile(
      join(dir, 'probe.ps1'),
      String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition ([IO.File]::ReadAllText($args[0])) -Language CSharp
$cases = [IO.File]::ReadAllText($args[1]) | ConvertFrom-Json
$records = @($cases.records | ForEach-Object { [RelaunchProbe]::Parse([string]$_.text, [bool]$_.dev) })
$messages = @($cases.messages | ForEach-Object { [RelaunchProbe]::IsRelaunch([string]$_) })
[Console]::Out.Write((ConvertTo-Json -Compress @{ records = $records; messages = $messages }))
`,
      'utf8',
    );
    const res = await run(powershell!, [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      await toWindowsPath(join(dir, 'probe.ps1')),
      await toWindowsPath(join(dir, 'probe.cs')),
      await toWindowsPath(join(dir, 'cases.json')),
    ]);
    assert.equal(res.code, 0, res.out);
    const got = JSON.parse(res.stdout) as { records: string[]; messages: boolean[] };
    assert.equal(got.records.length, RECORDS.length);
    RECORDS.forEach(([text, dev, want], i) => {
      assert.equal(got.records[i], want, `record ${i} (dev ${dev}): ${JSON.stringify(text.slice(0, 120))}`);
    });
    MESSAGES.forEach(([text, want], i) => {
      assert.equal(got.messages[i], want, `message ${JSON.stringify(text)}`);
    });
  } finally {
    await removeTempDir(dir);
  }
});

test("relaunch: launch.ps1's record is read back by the host's parser", { skip }, async () => {
  const dir = await makeTempDir('ai-sm-relaunch-record-');
  try {
    const writer = rawMember(launch, 'function Write-RelaunchRecord(');
    await writeFile(join(dir, 'probe.cs'), probeClass(), 'utf8');
    await writeFile(
      join(dir, 'writer.ps1'),
      [
        "$ErrorActionPreference = 'Stop'",
        '. $args[0]',
        "$DataDir = '~/.ai-session-manager-dev'",
        writer,
        'Write-RelaunchRecord -InstanceDir (Join-Path $PSScriptRoot ' + "'instance')",
        "Add-Type -TypeDefinition ([IO.File]::ReadAllText($args[1])) -Language CSharp",
        "$text = [IO.File]::ReadAllText((Join-Path (Join-Path $PSScriptRoot 'instance') $AiSmRelaunchRecordName))",
        '[Console]::Out.Write([RelaunchProbe]::Parse($text, $true))',
      ].join('\n'),
      'utf8',
    );
    const res = await run(powershell!, [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      await toWindowsPath(join(dir, 'writer.ps1')),
      await toWindowsPath(join(projectRoot, 'launcher', 'config-common.ps1')),
      await toWindowsPath(join(dir, 'probe.cs')),
    ]);
    assert.equal(res.code, 0, res.out);
    const launcher = `${await toWindowsPath(dir)}\\launch.ps1`;
    assert.equal(res.stdout, `ok|${launcher}|~/.ai-session-manager-dev`);
    // UTF-8 without a BOM, LF, exactly two lines.
    const bytes = await readFile(join(dir, 'instance', 'relaunch.txt'));
    assert.notEqual(bytes[0], 0xef, 'no BOM');
    assert.equal(bytes.toString('utf8'), `${launcher}\n~/.ai-session-manager-dev\n`);
  } finally {
    await removeTempDir(dir);
  }
});
