/**
 * `launcher/run-update.ps1` — the Windows half of the in-app update.
 *
 * The backend downloads the release's Setup exe inside WSL, verifies it
 * against the release's own `SHA256SUMS.txt`, copies it plus this script into
 * a Windows staging directory, and starts exactly one command line:
 *
 *   powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass
 *     -File <staging>\run-update.ps1 -SetupPath <staging>\AI-Session-Manager-Setup-<v>.exe
 *     -ExpectedSha <64 lowercase hex> -LogPath <staging>\setup.log
 *
 * So this file pins the two things that make that safe, and nothing else:
 *
 *   1. WHAT IT RUNS. `-DryRun` prints the exact `Start-Process` argv without
 *      hashing, starting or deleting anything, and it is compared element by
 *      element: `/SILENT /SUPPRESSMSGBOXES /NORESTART /LOG="<file>"`. The
 *      quotes around the log path are load-bearing — PowerShell 5.1's
 *      `-ArgumentList` joins with spaces and quotes nothing, and `%TEMP%`
 *      contains a space on any PC whose user name does.
 *   2. WHAT IT REFUSES. The re-hash is done here with a REAL `Get-FileHash`
 *      against a real file: one changed byte must delete the exe and exit 2,
 *      with nothing started. Plus every argument shape that must never reach
 *      `Start-Process`: an exe outside the script's own directory (including
 *      via `..`), a name that is not a release Setup name, a hash that is not
 *      64 lowercase hex, a path that is not a local Windows path.
 *
 * The staging directories live under the real `%TEMP%` because the script
 * only accepts rooted Windows paths (`C:\…`) — that is the point of the
 * charset gate, and a `\\wsl.localhost\…` path is exactly what it must
 * refuse. Every directory this file creates is removed again, and the
 * self-cleanup case is separated from the refusal cases so that "the exe was
 * deleted" is proven independently of "the directory was removed".
 *
 * Skipped cleanly where `powershell.exe` / `wslpath` are absent (CI's ubuntu
 * runner); the static half of the file runs everywhere.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { accessSync, constants, readFileSync } from 'node:fs';
import { copyFile, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { projectRoot } from './helpers.ts';

const scriptPath = join(projectRoot, 'launcher', 'run-update.ps1');
const script = readFileSync(scriptPath, 'utf8');

// --- static pins (no Windows needed) ----------------------------------------

test('run-update.ps1: the argv it builds is the silent, non-blocking one', () => {
  // /SUPPRESSMSGBOXES matters most: nobody is watching this run, and every
  // message box in the .iss is a SuppressibleMsgBox precisely so that flag
  // can be trusted. /NORESTART because a reboot must never be this script's
  // to take.
  assert.match(script, /^\$setupArgs = @\(\n\s*'\/SILENT',\n\s*'\/SUPPRESSMSGBOXES',\n\s*'\/NORESTART',\n\s*\('\/LOG="' \+ \$logFull \+ '"'\)\n\)$/m);
  assert.match(script, /Start-Process -FilePath \$setupFull -ArgumentList \$setupArgs -Wait -PassThru -ErrorAction Stop/);
});

test('run-update.ps1: it is strict, and it never builds a command string', () => {
  assert.match(script, /^Set-StrictMode -Version 2\.0$/m);
  assert.match(script, /^\$ErrorActionPreference = 'Stop'$/m);
  // Nothing here may interpret a string as code, and nothing may hand a
  // string to another shell: every value it touches came off its own command
  // line, but "came from the backend" is not an argument for evaluating it.
  assert.doesNotMatch(script, /Invoke-Expression|\biex\b|cmd\.exe|\/c\b/i);
  assert.doesNotMatch(script, /Start-Process[^\n]*-Verb/i, 'no elevation verb, ever');
});

test('run-update.ps1: the three allow-lists are anchored with \\z, not $', () => {
  // .NET's `$` also matches BEFORE a trailing newline — the lesson
  // config-common.ps1 records. Same rule, same file-level constants.
  // `+` is in the class on purpose: the version shape the server accepts admits
  // build metadata (`v1.2.3+build`), and a name the script refuses after the
  // download is verified would strand the update at the last step.
  assert.match(script, /^\$AiSmSetupNamePattern = '\^AI-Session-Manager-Setup-v\[0-9A-Za-z\.\+\\-\]\+\\\.exe\\z'$/m);
  assert.match(script, /^\$AiSmShaPattern = '\^\[0-9a-f\]\{64\}\\z'$/m);
  // 3 + 256 = 259 = MAX_PATH - 1, byte-identical to the backend's own argv cap
  // (WINDOWS_ARG_SHAPE): the two gates guard the same strings, and a path the
  // backend composed and the script then refuses would strand a verified
  // download at the last step.
  assert.match(script, /^\$AiSmWinPathPattern = '\^\[A-Za-z\]:\\\\\[\^<>\|"\?\*\\r\\n%\]\{1,256\}\\z'$/m);
  // The hash gate and the comparison are case-SENSITIVE operators: -match and
  // -ne are case-insensitive in PowerShell, which would silently accept 64
  // uppercase hex characters this contract does not allow.
  assert.match(script, /\$ExpectedSha -cnotmatch \$AiSmShaPattern/);
  assert.match(script, /\$actual -cne \$ExpectedSha/);
});

test('run-update.ps1: a failed Setup prints its log tail, and refuses with 3 — never Inno\'s 1', () => {
  // The staging directory (setup.log included) is removed moments later in the
  // `finally`, so the only chance to say WHY a silent install failed is here,
  // on stdout, which the backend records in server.log.
  assert.match(script, /if \(\$code -ne 0\) \{ Write-SetupLogTail \$logFull \}/);
  assert.ok(
    script.indexOf('Write-SetupLogTail $logFull') < script.indexOf('} finally {'),
    'the tail must be printed BEFORE Remove-StagingDir deletes the log',
  );
  assert.match(script, /Get-Content -LiteralPath \$Path -Tail 30 -ErrorAction Stop/, 'bounded, never a file dump');
  assert.match(script, /Write-Line \('setup\.log: ' \+ \$line\)/, 'each tail line is prefixed and one line long');
  // Exit codes: 0 ok, 2 hash mismatch, 3 this script's own refusal, anything
  // else the Setup's own. 1 is Inno's, so this script never uses it.
  assert.match(script, /function Fail\(\[string\]\$Message\) \{\n\s*Write-Line "ERROR: \$Message"\n\s*exit 3\n\}/);
  assert.doesNotMatch(script, /^\s*exit 1$/m);
  assert.match(script, /^\s*exit 2$/m, 'the hash-mismatch code is unchanged');
});

test('run-update.ps1: only an update staging directory can ever be deleted', () => {
  // The master copy of this script ships INSIDE the WSL bundle
  // (<version>/launcher/run-update.ps1) and is reachable from Windows over
  // the WSL share. Run from there, the `finally` must delete nothing.
  assert.match(script, /^\$AiSmStagingSegment = 'ai-session-manager-update'$/m);
  assert.match(script, /if \(\$segments -notcontains \$AiSmStagingSegment\) \{/);
  assert.match(script, /^\} finally \{\n\s*Remove-StagingDir \$stagingDir\n\}$/m);
  // And it must leave that directory before deleting it: the backend spawns
  // this script WITH the staging dir as its working directory, and Windows
  // will not delete a directory a running process sits in. Set-Location alone
  // does not move the process-wide one in PowerShell 5.1.
  assert.match(script, /Set-Location -LiteralPath \$away/);
  assert.match(script, /\[System\.Environment\]::CurrentDirectory = \$away/);
});

// --- environment probing ----------------------------------------------------

function onPath(exe: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, exe);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

const powershell = onPath('powershell.exe');
const wslpathBin = onPath('wslpath');
const skip: string | false = powershell
  ? wslpathBin
    ? false
    : 'wslpath not on PATH (not inside WSL)'
  : 'powershell.exe not on PATH (no Windows interop)';

interface RunResult {
  code: number | null;
  /** stdout + stderr, CR stripped. */
  out: string;
}

function run(exe: string, args: string[], cwd?: string, timeoutMs = 60_000): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'], ...(cwd === undefined ? {} : { cwd }) });
    let out = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`timed out after ${timeoutMs}ms: ${exe} ${args.join(' ')}`));
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

/** A staging directory on a real Windows drive, in both spellings. */
interface Staging {
  /** The directory holding run-update.ps1 + the fake Setup, Windows spelling. */
  win: string;
  /** The same directory, seen from WSL. */
  linux: string;
  /** The temp root to remove afterwards (one level above `win`). */
  rootLinux: string;
  /** `<win>\AI-Session-Manager-Setup-v9.9.9-test.exe`. */
  setupWin: string;
  setupLinux: string;
  /** The exe's real SHA-256, computed here — never by the script. */
  sha: string;
}

const SETUP_NAME = 'AI-Session-Manager-Setup-v9.9.9-test.exe';

/**
 * Builds a staging directory under the real `%TEMP%`: a copy of
 * run-update.ps1 and a fake "Setup" whose bytes we know.
 *
 * `stagingSegment` decides whether the path holds an `ai-session-manager-update`
 * segment, i.e. whether the script's own cleanup is allowed to remove it.
 */
async function makeStaging(opts: { stagingSegment: boolean }): Promise<Staging> {
  const tempWin = (await run(powershell!, ['-NoProfile', '-Command', '[Console]::Out.Write($env:TEMP)'])).out.trim();
  assert.match(tempWin, /^[A-Za-z]:\\/, `%TEMP% is not a local Windows path: ${tempWin}`);
  const tempLinux = (await run(wslpathBin!, ['-u', tempWin])).out.trim();
  assert.ok(tempLinux.startsWith('/'), `wslpath -u produced nothing for ${tempWin}`);

  const rootName = `aism-runupdate-${randomBytes(6).toString('hex')}`;
  const tail = opts.stagingSegment ? ['ai-session-manager-update', 'v9.9.9-test'] : ['v9.9.9-test'];
  const rootLinux = join(tempLinux, rootName);
  const linux = join(rootLinux, ...tail);
  const win = [tempWin, rootName, ...tail].join('\\');

  await mkdir(linux, { recursive: true });
  await copyFile(scriptPath, join(linux, 'run-update.ps1'));
  const body = `not really a Setup — ${randomBytes(8).toString('hex')}\n`;
  await writeFile(join(linux, SETUP_NAME), body);

  return {
    win,
    linux,
    rootLinux,
    setupWin: `${win}\\${SETUP_NAME}`,
    setupLinux: join(linux, SETUP_NAME),
    sha: createHash('sha256').update(body).digest('hex'),
  };
}

/**
 * Runs the staged copy of run-update.ps1 exactly as the backend does —
 * including `cwd: <staging dir>` (server/update-install.ts spawns it there),
 * which is what makes deleting that directory afterwards non-trivial.
 */
function runUpdate(staging: Staging, args: string[]): Promise<RunResult> {
  return run(
    powershell!,
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      `${staging.win}\\run-update.ps1`,
      ...args,
    ],
    staging.linux,
  );
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// --- -DryRun: the exact argv ------------------------------------------------

test('run-update.ps1 -DryRun prints the exact Start-Process argv and touches nothing', { skip }, async () => {
  const s = await makeStaging({ stagingSegment: true });
  try {
    const res = await runUpdate(s, [
      '-SetupPath', s.setupWin,
      '-ExpectedSha', s.sha,
      '-LogPath', `${s.win}\\setup.log`,
      '-DryRun',
    ]);
    assert.equal(res.code, 0, res.out);

    const start = res.out.indexOf('DRYRUN-ARGV-BEGIN\n');
    const end = res.out.indexOf('\nDRYRUN-ARGV-END');
    assert.ok(start >= 0 && end > start, `no argv block in:\n${res.out}`);
    const argv = res.out.slice(start + 'DRYRUN-ARGV-BEGIN\n'.length, end).split('\n');
    assert.deepEqual(argv, [
      `FilePath=${s.setupWin}`,
      'Arg=/SILENT',
      'Arg=/SUPPRESSMSGBOXES',
      'Arg=/NORESTART',
      `Arg=/LOG="${s.win}\\setup.log"`,
    ]);
    assert.ok(res.out.includes('-DryRun: nothing was hashed, started or removed.'), res.out);

    // A dry run is a dry run: no hash, no deletion, no self-cleanup — even
    // though this staging path WOULD be removable.
    assert.equal(await exists(s.setupLinux), true, 'the Setup file was removed by a dry run');
    assert.equal(await exists(join(s.linux, 'run-update.ps1')), true, 'the staging directory was removed by a dry run');
    assert.ok(!res.out.includes('Staging directory removed'), res.out);
  } finally {
    await rm(s.rootLinux, { recursive: true, force: true });
  }
});

test('run-update.ps1 -DryRun quotes a log path that contains spaces', { skip }, async () => {
  // %TEMP% is C:\Users\First Last\… on any PC whose user name has a space.
  // -ArgumentList would hand Inno two arguments; Inno would write its log to
  // "C:\Users\First" and the update would look fine while logging nowhere.
  const s = await makeStaging({ stagingSegment: true });
  try {
    const res = await runUpdate(s, [
      '-SetupPath', s.setupWin,
      '-ExpectedSha', s.sha,
      '-LogPath', 'C:\\Users\\First Last\\App Data\\setup.log',
      '-DryRun',
    ]);
    assert.equal(res.code, 0, res.out);
    assert.ok(res.out.includes('Arg=/LOG="C:\\Users\\First Last\\App Data\\setup.log"'), res.out);
  } finally {
    await rm(s.rootLinux, { recursive: true, force: true });
  }
});

test('run-update.ps1 -DryRun accepts a +build Setup name', { skip }, async () => {
  // The server's VERSION_SHAPE admits build metadata (`v1.2.3+build.5`), so a
  // release tagged that way produces `AI-Session-Manager-Setup-v1.2.3+build.5.exe`.
  // A name class without `+` here would download and verify the whole thing and
  // then refuse it at the very last step.
  const s = await makeStaging({ stagingSegment: true });
  try {
    const name = 'AI-Session-Manager-Setup-v1.2.3+build.5.exe';
    await writeFile(join(s.linux, name), 'x');
    const res = await runUpdate(s, [
      '-SetupPath', `${s.win}\\${name}`,
      '-ExpectedSha', s.sha,
      '-LogPath', `${s.win}\\setup.log`,
      '-DryRun',
    ]);
    assert.equal(res.code, 0, res.out);
    assert.ok(res.out.includes(`FilePath=${s.win}\\${name}`), res.out);
  } finally {
    await rm(s.rootLinux, { recursive: true, force: true });
  }
});

// --- the re-hash ------------------------------------------------------------

test('run-update.ps1: one changed byte deletes the file and exits 2, having run nothing', { skip }, async () => {
  // The staging path deliberately has NO `ai-session-manager-update` segment,
  // so the script's own cleanup refuses to remove the directory: what is left
  // proves the EXE was deleted by the mismatch branch, not swept away with
  // everything else.
  const s = await makeStaging({ stagingSegment: false });
  try {
    const wrong = `${'0'.repeat(63)}1`;
    const res = await runUpdate(s, [
      '-SetupPath', s.setupWin,
      '-ExpectedSha', wrong,
      '-LogPath', `${s.win}\\setup.log`,
    ]);
    assert.equal(res.code, 2, `expected exit 2, got ${res.code}:\n${res.out}`);
    assert.ok(
      res.out.includes('The downloaded file did not match the expected checksum; it has been deleted.'),
      res.out,
    );
    // Get-FileHash and node:crypto must agree on the same bytes — the whole
    // contract rests on the backend and this script hashing identically.
    assert.ok(res.out.includes(`  expected: ${wrong}`), res.out);
    assert.ok(res.out.includes(`  actual:   ${s.sha}`), res.out);
    assert.ok(!res.out.includes('Starting '), `nothing may be started:\n${res.out}`);

    assert.equal(await exists(s.setupLinux), false, 'the unverified exe survived');
    assert.equal(await exists(join(s.linux, 'run-update.ps1')), true, 'this directory is not a staging dir; it must survive');
    assert.ok(res.out.includes('is not an update staging directory'), res.out);
  } finally {
    await rm(s.rootLinux, { recursive: true, force: true });
  }
});

test('run-update.ps1: a real staging directory removes itself afterwards', { skip }, async () => {
  const s = await makeStaging({ stagingSegment: true });
  try {
    const res = await runUpdate(s, [
      '-SetupPath', s.setupWin,
      '-ExpectedSha', `${'0'.repeat(63)}1`,
      '-LogPath', `${s.win}\\setup.log`,
    ]);
    assert.equal(res.code, 2, res.out);
    assert.ok(res.out.includes(`Staging directory removed: ${s.win}`), res.out);
    // The exe, the script and the directory itself: an unsigned installer may
    // not linger in %TEMP%.
    assert.equal(await exists(s.linux), false, 'the staging directory survived');
  } finally {
    await rm(s.rootLinux, { recursive: true, force: true });
  }
});

// --- refusals ---------------------------------------------------------------

test('run-update.ps1: every argument shape it must refuse, before anything runs', { skip }, async () => {
  const s = await makeStaging({ stagingSegment: true });
  try {
    // A file with the right name one level down, and one level up: both are
    // real files, so only the containment rule can refuse them.
    await mkdir(join(s.linux, 'sub'), { recursive: true });
    await writeFile(join(s.linux, 'sub', SETUP_NAME), 'x');
    await writeFile(join(s.rootLinux, 'ai-session-manager-update', SETUP_NAME), 'x');
    await writeFile(join(s.linux, 'evil.exe'), 'x');
    await writeFile(join(s.linux, 'AI-Session-Manager-Setup-0.9.exe'), 'x');

    const log = `${s.win}\\setup.log`;
    const cases: [string, string[], RegExp][] = [
      [
        'a subdirectory of the staging dir',
        ['-SetupPath', `${s.win}\\sub\\${SETUP_NAME}`, '-ExpectedSha', s.sha, '-LogPath', log],
        /must be a file in this script's own directory/,
      ],
      [
        'the parent, reached with ..',
        ['-SetupPath', `${s.win}\\..\\${SETUP_NAME}`, '-ExpectedSha', s.sha, '-LogPath', log],
        /must be a file in this script's own directory/,
      ],
      [
        'a name that is not a release Setup',
        ['-SetupPath', `${s.win}\\evil.exe`, '-ExpectedSha', s.sha, '-LogPath', log],
        /is not a release Setup file name: evil\.exe/,
      ],
      [
        'a Setup name without the v prefix',
        ['-SetupPath', `${s.win}\\AI-Session-Manager-Setup-0.9.exe`, '-ExpectedSha', s.sha, '-LogPath', log],
        /is not a release Setup file name/,
      ],
      [
        'a file that is not there',
        ['-SetupPath', `${s.win}\\AI-Session-Manager-Setup-v0.0.0-absent.exe`, '-ExpectedSha', s.sha, '-LogPath', log],
        /does not exist/,
      ],
      [
        'a hash that is too short',
        ['-SetupPath', s.setupWin, '-ExpectedSha', 'abc123', '-LogPath', log],
        /64 lowercase hex characters/,
      ],
      [
        'a hash in UPPERCASE (-match would have accepted it)',
        ['-SetupPath', s.setupWin, '-ExpectedSha', s.sha.toUpperCase(), '-LogPath', log],
        /64 lowercase hex characters/,
      ],
      [
        'a UNC SetupPath (the WSL share is not a place to run an exe from)',
        ['-SetupPath', `\\\\wsl.localhost\\Ubuntu\\tmp\\${SETUP_NAME}`, '-ExpectedSha', s.sha, '-LogPath', log],
        /-SetupPath is not a usable Windows path/,
      ],
      [
        'a log path carrying a quote',
        ['-SetupPath', s.setupWin, '-ExpectedSha', s.sha, '-LogPath', 'C:\\tmp\\a"b.log'],
        /-LogPath is not a usable Windows path/,
      ],
      [
        'a log path carrying a percent sign',
        ['-SetupPath', s.setupWin, '-ExpectedSha', s.sha, '-LogPath', 'C:\\tmp\\%TEMP%.log'],
        /-LogPath is not a usable Windows path/,
      ],
    ];

    for (const [name, args, reason] of cases) {
      // -DryRun on top: even the refusals are proven on the path that could
      // not possibly start anything, and a case that slipped through would
      // print an argv block instead of a reason.
      const res = await runUpdate(s, [...args, '-DryRun']);
      // 3, not 1: this script's own refusals must be distinguishable from
      // Inno's exit 1, so the backend can say "could not be started on
      // Windows" instead of "did not finish".
      assert.equal(res.code, 3, `${name}: expected exit 3, got ${res.code}:\n${res.out}`);
      assert.match(res.out, reason, name);
      assert.ok(!res.out.includes('DRYRUN-ARGV-BEGIN'), `${name}: a refused call printed an argv`);
    }

    // Nothing was deleted along the way.
    assert.equal(await exists(s.setupLinux), true);
    assert.equal(await exists(join(s.linux, 'run-update.ps1')), true);
  } finally {
    await rm(s.rootLinux, { recursive: true, force: true });
  }
});
