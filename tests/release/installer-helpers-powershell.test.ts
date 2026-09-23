/**
 * `installer/helpers/*.ps1`, the POWERSHELL SIDE — what the Windows Setup
 * decides, parses and would run, driven through `powershell.exe` interop.
 *
 * Every helper runs with `-DryRun`, which prints the exact `wsl.exe` command
 * line and touches nothing, or `-ListFile` (a read of a committed fixture), so
 * no `wsl.exe` is ever spawned. Those command lines are pinned character for
 * character: they are hand-built strings (.NET 4.8 has no ArgumentList), so
 * their shape IS the injection-safety argument — `--exec` (never the default
 * shell, which would expand everything a second time), a script containing no
 * double quote, and values that passed the allow-list. Also here: the
 * `wsl -l -v` UTF-16LE parse, the allow-list gates ending at the string end,
 * and the launcher config the installer writes read back by the launcher.
 *
 * Split out of `installer-helpers.test.ts` (restructure O6), which runs the
 * constant shell scripts under a real `sh`; the scripts' text comes from
 * `tests/helpers/installer-helpers-fixture.ts`.
 *
 * NOT claimed: a real install into a distro, or the Setup's own UI. Skipped
 * where powershell.exe or wslpath is absent (CI's ubuntu runner has no
 * Windows side).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { projectRoot, makeTempDir, removeTempDir, onPath } from '../helpers/helpers.ts';
import {
  helpersDir,
  probeScript,
  readHelper,
  removeScript,
  unpackScript,
} from '../helpers/installer-helpers-fixture.ts';

// --- the PowerShell side ----------------------------------------------------

const powershell = onPath('powershell.exe');
const wslpathBin = onPath('wslpath');
const skip: string | false = powershell
  ? wslpathBin
    ? false
    : 'wslpath not on PATH (not inside WSL)'
  : 'powershell.exe not on PATH (no Windows interop)';

interface RunResult {
  code: number | null;
  out: string;
}

function run(exe: string, args: string[], timeoutMs = 60_000): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`timed out: ${exe} ${args.join(' ')}`));
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c: string) => (out += c));
    child.stderr.on('data', (c: string) => (out += c));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out: out.replaceAll('\r', '') });
    });
  });
}

async function toWin(linuxPath: string): Promise<string> {
  const res = await run(wslpathBin!, ['-w', linuxPath]);
  const win = res.out.trim();
  assert.ok(win, `wslpath -w produced nothing for ${linuxPath}`);
  return win;
}

/** Runs a helper and returns its stdout plus the parsed result file. */
async function helper(name: string, args: string[]): Promise<{ res: RunResult; keys: Map<string, string> }> {
  const dir = await makeTempDir('ai-sm-helper-');
  try {
    const resultFile = join(dir, 'result.txt');
    const res = await run(powershell!, [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      await toWin(join(helpersDir, name)),
      '-ResultFile',
      await toWin(resultFile),
      ...args,
    ]);
    const keys = new Map<string, string>();
    if (existsSync(resultFile)) {
      for (const line of readFileSync(resultFile, 'utf8').replaceAll('\r', '').split('\n')) {
        const eq = line.indexOf('=');
        if (eq > 0) keys.set(line.slice(0, eq), line.slice(eq + 1));
      }
    }
    return { res, keys };
  } finally {
    await removeTempDir(dir);
  }
}

/** The exact command line a -DryRun printed between its markers. */
function dryRunCommandLine(out: string): string {
  const start = out.indexOf('DRYRUN-CMDLINE-BEGIN\n');
  const end = out.indexOf('\nDRYRUN-CMDLINE-END');
  assert.ok(start >= 0 && end > start, `no dry-run command line in:\n${out}`);
  return out.slice(start + 'DRYRUN-CMDLINE-BEGIN\n'.length, end);
}

test('install-bundle -DryRun prints the exact wsl.exe command line and runs nothing', { skip }, async () => {
  const { res, keys } = await helper('install-bundle.ps1', [
    '-DryRun',
    '-Distro', 'Ubuntu-24.04',
    '-AppDir', '/home/you/.ai-session-manager/app',
    '-Version', 'v0.2.0',
    '-Tarball', 'C:\\Users\\me\\AppData\\Local\\Temp\\a dir\\bundle.tar.gz',
    '-ConfigDir', 'C:\\Programs\\AI Session Manager',
  ]);
  assert.equal(res.code, 0, res.out);
  const cmd = dryRunCommandLine(res.out);

  // --exec, or wsl.exe hands the whole line to the distro's default shell,
  // which expands it a SECOND time ($1/$2 arrive empty, $(...) runs there).
  assert.ok(cmd.startsWith('wsl.exe -d Ubuntu-24.04 --exec sh -c "'), cmd.slice(0, 80));
  // Positional arguments after the script: $0=sh, $1=appdir, $2=version,
  // $3=the live version dir ('-' = none).
  assert.ok(cmd.endsWith('" sh /home/you/.ai-session-manager/app v0.2.0 -'), cmd.slice(-80));
  // The script between the quotes is exactly the committed constant.
  const inner = cmd.slice('wsl.exe -d Ubuntu-24.04 --exec sh -c "'.length, cmd.lastIndexOf('" sh '));
  assert.equal(inner, unpackScript);
  assert.equal((cmd.match(/"/g) ?? []).length, 2, 'only the two script delimiters may be double quotes');

  // The tarball never appears on the Linux command line - it goes on stdin.
  assert.ok(!cmd.includes('bundle.tar.gz'), cmd);
  assert.ok(res.out.includes('DRYRUN-STDIN=C:\\Users\\me\\AppData\\Local\\Temp\\a dir\\bundle.tar.gz'), res.out);

  assert.equal(keys.get('ok'), 'yes');
  assert.equal(keys.get('dryRun'), 'yes');
  assert.equal(keys.get('installedDir'), '/home/you/.ai-session-manager/app/v0.2.0');
  assert.equal(keys.get('current'), '/home/you/.ai-session-manager/app/current');
  assert.equal(keys.get('configFile'), 'C:\\Programs\\AI Session Manager\\launcher-config.json');
  assert.equal(keys.get('infoFile'), 'C:\\Programs\\AI Session Manager\\install-info.txt');
});

test('install-bundle refuses a bad distro, a bad app dir and a bad version before anything runs', { skip }, async () => {
  const base = ['-DryRun', '-Tarball', 'none'];
  const cases: [string[], RegExp][] = [
    [['-Distro', 'Ubuntu 24', '-AppDir', '/home/you/.ai-session-manager/app', '-Version', 'v0.2.0'], /is not usable/],
    [['-Distro', 'Ubuntu-24.04', '-AppDir', '/home/a b/app', '-Version', 'v0.2.0'], /absolute Linux path/],
    [['-Distro', 'Ubuntu-24.04', '-AppDir', '/home/you/.ai-session-manager', '-Version', 'v0.2.0'], /must end in \/app/],
    [['-Distro', 'Ubuntu-24.04', '-AppDir', '/app', '-Version', 'v0.2.0'], /must end in \/app/],
    // Two segments is what the UNINSTALLER refuses (>= 3, ends in /app), so
    // accepting it here would install into a path that can never be removed.
    [['-Distro', 'Ubuntu-24.04', '-AppDir', '/home/app', '-Version', 'v0.2.0'], /at least two segments above it/],
    [['-Distro', 'Ubuntu-24.04', '-AppDir', '/home/you/../x/app', '-Version', 'v0.2.0'], /'\.' or '\.\.' path segment/],
    [['-Distro', 'Ubuntu-24.04', '-AppDir', '/home/you/.ai-session-manager/app', '-Version', '../evil'], /usable bundle version/],
  ];
  for (const [args, reason] of cases) {
    const { res, keys } = await helper('install-bundle.ps1', [...base, ...args]);
    assert.equal(res.code, 1, `${args.join(' ')}\n${res.out}`);
    assert.equal(keys.get('ok'), 'no', args.join(' '));
    assert.match(keys.get('reason') ?? '', reason, args.join(' '));
    assert.ok(!res.out.includes('DRYRUN-CMDLINE-BEGIN'), 'a refused call must not print a command line');
  }
});

test('uninstall-wsl -DryRun prints the exact command line; every unsafe path is refused', { skip }, async () => {
  const ok = await helper('uninstall-wsl.ps1', [
    '-DryRun', '-Distro', 'Ubuntu-24.04', '-AppDir', '/home/you/.ai-session-manager/app',
  ]);
  assert.equal(ok.res.code, 0, ok.res.out);
  const cmd = dryRunCommandLine(ok.res.out);
  assert.ok(cmd.startsWith('wsl.exe -d Ubuntu-24.04 --exec sh -c "'), cmd.slice(0, 80));
  assert.ok(cmd.endsWith('" sh /home/you/.ai-session-manager/app'), cmd.slice(-60));
  assert.equal(cmd.slice('wsl.exe -d Ubuntu-24.04 --exec sh -c "'.length, cmd.lastIndexOf('" sh ')), removeScript);
  assert.equal(ok.keys.get('removed'), 'no', 'a dry run removes nothing');

  const refusals: [string, RegExp][] = [
    ['/home/you/.ai-session-manager', /must end in \/app/],
    ['/', /absolute Linux path/],
    ['/app', /too close to the root/],
    ['/home/you', /must end in \/app/],
    ['/home/a b/app', /absolute Linux path/],
    ['/home/you/../x/app', /'\.' or '\.\.' path segment/],
    ['home/you/app', /absolute Linux path/],
  ];
  for (const [appDir, reason] of refusals) {
    const { res, keys } = await helper('uninstall-wsl.ps1', ['-DryRun', '-Distro', 'Ubuntu-24.04', '-AppDir', appDir]);
    assert.equal(res.code, 1, `${appDir}\n${res.out}`);
    assert.equal(keys.get('ok'), 'no', appDir);
    assert.match(keys.get('reason') ?? '', reason, appDir);
    assert.ok(!res.out.includes('DRYRUN-CMDLINE-BEGIN'), `${appDir}: refused paths never reach a command line`);
  }
});

test('install-thirdparty -DryRun shows the exact command and its source host', { skip }, async () => {
  const { res, keys } = await helper('install-thirdparty.ps1', ['-DryRun', '-Distro', 'Ubuntu-24.04', '-Item', 'claude']);
  assert.equal(res.code, 0, res.out);
  assert.equal(
    dryRunCommandLine(res.out),
    'wsl.exe -d Ubuntu-24.04 --exec bash -lc "curl -fsSL https://claude.ai/install.sh | bash"',
  );
  assert.equal(keys.get('command'), 'curl -fsSL https://claude.ai/install.sh | bash');
  assert.equal(keys.get('host'), 'claude.ai');
  assert.ok(res.out.includes('command: curl -fsSL https://claude.ai/install.sh | bash'), res.out);
  assert.ok(res.out.includes('source:  https://claude.ai'), res.out);
});

test('install-thirdparty accepts no item but the allow-listed one', { skip }, async () => {
  const { res } = await helper('install-thirdparty.ps1', ['-DryRun', '-Distro', 'Ubuntu-24.04', '-Item', 'anything-else']);
  assert.notEqual(res.code, 0, res.out);
  assert.match(res.out, /ValidateSet|does not belong to the set/i, res.out);
});

test('wsl-probe parses the UTF-16LE `wsl -l -v` table, marking WSL 1 and odd names unusable', { skip }, async () => {
  // The committed fixture is the real thing: UTF-16LE, no BOM, CRLF - which
  // is what wsl.exe emits when WSL_UTF8 is not honoured, and it read as UTF-8
  // puts a NUL between every character.
  const fixture = join(projectRoot, 'tests', 'fixtures', 'wsl-list-verbose-utf16le.txt');
  const bytes = readFileSync(fixture);
  assert.equal(bytes[0], 0x20);
  assert.equal(bytes[1], 0x00, 'the fixture must stay UTF-16LE');

  const { res, keys } = await helper('wsl-probe.ps1', ['-ListFile', await toWin(fixture)]);
  assert.equal(res.code, 0, res.out);
  assert.equal(keys.get('ok'), 'yes');
  assert.equal(keys.get('wslPresent'), 'yes');
  assert.equal(keys.get('distroCount'), '4');
  assert.equal(keys.get('wsl2Count'), '2');
  assert.equal(keys.get('default'), 'Ubuntu-24.04', 'the * marks the default distro');
  assert.equal(keys.get('distro1'), 'Ubuntu-24.04');
  assert.equal(keys.get('distro1.version'), '2');
  assert.equal(keys.get('distro1.state'), 'Running');
  assert.equal(keys.get('distro1.default'), 'yes');
  assert.equal(keys.get('distro1.usable'), 'yes');
  assert.equal(keys.get('distro2'), 'Debian');
  assert.equal(keys.get('distro2.default'), 'no');
  assert.equal(keys.get('distro3'), 'Legacy-1');
  assert.equal(keys.get('distro3.version'), '1', 'a WSL 1 distro is listed but not counted');
  assert.equal(keys.get('distro4'), 'My Distro');
  assert.equal(keys.get('distro4.usable'), 'no', 'a name with a space can never reach a WSL command line');
});

test('wsl-probe -Distro -DryRun uses a login shell and the constant probe script', { skip }, async () => {
  const { res, keys } = await helper('wsl-probe.ps1', ['-DryRun', '-Distro', 'Ubuntu-24.04', '-GlibcMin', '2.35']);
  assert.equal(res.code, 0, res.out);
  const cmd = dryRunCommandLine(res.out);
  // bash -lc, not sh -c: the PATH a login shell builds is the one the
  // launcher will see later (~/.local/bin, where Claude Code installs).
  assert.equal(cmd, `wsl.exe -d Ubuntu-24.04 --exec bash -lc "${probeScript}"`);
  assert.equal(keys.get('ok'), 'yes');
  assert.equal(keys.get('dryRun'), 'yes');
});

test('wsl-probe refuses a distro name that could not be put on a command line', { skip }, async () => {
  const { res, keys } = await helper('wsl-probe.ps1', ['-DryRun', '-Distro', 'My Distro']);
  assert.equal(res.code, 0, res.out); // a probe answers, it does not crash
  assert.equal(keys.get('ok'), 'no');
  assert.match(keys.get('reason') ?? '', /refuses to put on a WSL command line/);
  assert.ok(!res.out.includes('DRYRUN-CMDLINE-BEGIN'), res.out);
});

test('wsl-probe reads the in-distro probe answer through the same UTF-16LE NULs', { skip }, async () => {
  // The distro-mode answer arrives on the SAME redirected stdout as `wsl -l -v`
  // and is just as likely to be UTF-16LE (WSL_UTF8 is set on the child, but a
  // wsl.exe that ignores it is exactly the case this strip exists for). Read as
  // UTF-8 that text carries a NUL after every ASCII character, so a key lookup
  // that does not strip them silently answers '' for EVERY key — and '' is a
  // legitimate answer here, so nothing would crash: the wizard would report
  // "could not read <distro>" for a perfectly good distro, or worse accept an
  // empty home. Distro mode itself needs a real WSL call, so the lookup is
  // extracted and run on its own, the same idiom as the constant scripts above.
  const fnText = /function Get-AiSmProbeValue \{[\s\S]*?\n\}/.exec(readHelper('wsl-probe.ps1'))?.[0];
  assert.ok(fnText, 'wsl-probe.ps1 must still define Get-AiSmProbeValue');
  assert.ok(fnText.includes('$Key'), fnText);

  const dir = await makeTempDir('ai-sm-probe-');
  try {
    const answer =
      'AISM_USER=you\r\n' +
      'AISM_HOME=/home/you\r\n' +
      'AISM_GLIBC=glibc 2.39\r\n' +
      'AISM_CLAUDE=yes\r\n' +
      'AISM_PROBE=ok\r\n';
    const answerFile = join(dir, 'probe-out.bin');
    await writeFile(answerFile, Buffer.from(answer, 'utf16le')); // UTF-16LE, no BOM
    const script = join(dir, 'run.ps1');
    await writeFile(
      script,
      "$ErrorActionPreference = 'Stop'\n" +
        fnText +
        '\n' +
        '$bytes = [System.IO.File]::ReadAllBytes($args[0])\n' +
        '$text = [System.Text.Encoding]::UTF8.GetString($bytes)\n' +
        "[Console]::Out.Write('home=[' + (Get-AiSmProbeValue $text 'AISM_HOME') + '] glibc=[' +" +
        " (Get-AiSmProbeValue $text 'AISM_GLIBC') + '] claude=[' + (Get-AiSmProbeValue $text 'AISM_CLAUDE') +" +
        " '] probe=[' + (Get-AiSmProbeValue $text 'AISM_PROBE') + '] absent=[' +" +
        " (Get-AiSmProbeValue $text 'AISM_NOPE') + ']')\n",
      'ascii',
    );
    const res = await run(powershell!, [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', await toWin(script), await toWin(answerFile),
    ]);
    assert.equal(res.code, 0, res.out);
    assert.equal(
      res.out,
      'home=[/home/you] glibc=[glibc 2.39] claude=[yes] probe=[ok] absent=[]',
      'every key must read back verbatim out of UTF-16LE bytes',
    );
  } finally {
    await removeTempDir(dir);
  }
});

test('the allow-list gates end at the STRING end: a trailing newline never passes', { skip }, async () => {
  // .NET's `$` also matches BEFORE a final newline, so a `$`-anchored gate
  // accepted "/home/you/app\n" — a value that would then reach a wsl.exe
  // command line with the newline still on it. Every pattern therefore ends
  // in \z. All four gates are checked here because they share one rule.
  const dir = await makeTempDir('ai-sm-anchor-');
  try {
    const script = join(dir, 'anchor.ps1');
    await writeFile(
      script,
      String.raw`
$ErrorActionPreference = 'Stop'
. $args[0]
. (Get-AiSmCommonPath -ScriptDir (Split-Path -Parent $args[0]))
$lf = [string][char]10
$out = ''
$out += 'path=[' + [bool](Test-AiSmLinuxPath '/home/you/app') + '/' + [bool](Test-AiSmLinuxPath ('/home/you/app' + $lf)) + '] '
$out += 'distro=[' + [bool](Test-AiSmDistroName 'Ubuntu-24.04') + '/' + [bool](Test-AiSmDistroName ('Ubuntu-24.04' + $lf)) + '] '
$out += 'dataDir=[' + [bool](Test-AiSmDataDir '~/.ai-session-manager') + '/' + [bool](Test-AiSmDataDir ('~/.ai-session-manager' + $lf)) + '] '
$out += 'version=[' + [bool](Test-AiSmBundleVersion 'v0.2.0') + '/' + [bool](Test-AiSmBundleVersion ('v0.2.0' + $lf)) + ']'
[Console]::Out.Write($out)
`,
      'ascii',
    );
    const res = await run(powershell!, [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      await toWin(script),
      await toWin(join(helpersDir, 'helper-common.ps1')),
    ]);
    assert.equal(res.code, 0, res.out);
    assert.equal(
      res.out.trim(),
      'path=[True/False] distro=[True/False] dataDir=[True/False] version=[True/False]',
      'every gate must accept the value and reject the same value plus a newline',
    );
  } finally {
    await removeTempDir(dir);
  }
});

test('the launcher config the installer writes is exactly what the launcher reads back', { skip }, async () => {
  const dir = await makeTempDir('ai-sm-cfg-');
  try {
    const script = join(dir, 'probe.ps1');
    await writeFile(
      script,
      String.raw`
$ErrorActionPreference = 'Stop'
. $args[0]
. (Get-AiSmCommonPath -ScriptDir (Split-Path -Parent $args[0]))
$written = Write-AiSmLauncherConfig -ConfigDir $args[1] -Distro 'Ubuntu-22.04' -AppDir '/home/them/.ai-session-manager/app' -Version 'v0.2.0'
$back = Get-AiSmFileConfig -Dir $args[1]
$resolved = Resolve-AiSmConfig -ScriptRoot 'C:\Programs\AI Session Manager' -ConfigDir $args[1] -DefaultDistro '' -DefaultRepoPath ''
[Console]::Out.Write("distro=[$($back.Distro)] repo=[$($back.RepoPath)] src=[$($resolved.DistroSource)/$($resolved.RepoPathSource)] resolved=[$($resolved.Distro)|$($resolved.RepoPath)]")
`,
      'ascii',
    );
    const res = await run(powershell!, [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      await toWin(script),
      await toWin(join(helpersDir, 'helper-common.ps1')),
      await toWin(dir),
    ]);
    assert.equal(res.code, 0, res.out);
    assert.match(
      res.out,
      /distro=\[Ubuntu-22\.04\] repo=\[\/home\/them\/\.ai-session-manager\/app\/current\] src=\[config file\/config file\] resolved=\[Ubuntu-22\.04\|\/home\/them\/\.ai-session-manager\/app\/current\]/,
      res.out,
    );
    // install-info.txt is the uninstaller's input: plain key=value, no JSON.
    const info = readFileSync(join(dir, 'install-info.txt'), 'utf8').replaceAll('\r', '');
    assert.equal(info.trim(), 'distro=Ubuntu-22.04\nappDir=/home/them/.ai-session-manager/app\nversion=v0.2.0');
    // No BOM: Inno reads these files line by line.
    assert.notEqual(readFileSync(join(dir, 'launcher-config.json'))[0], 0xef);
  } finally {
    await removeTempDir(dir);
  }
});
