/**
 * `launcher/launch.ps1 -Stop` — the stale-runtime.json removal (Nocturne D3,
 * the launcher half of D2's `server/runtime-file.ts` rule).
 *
 * What: when `kill -TERM` finds the pid from runtime.json already gone, -Stop
 * used to run `rm -f <data dir>/runtime.json` in a SEPARATE wsl.exe call — a
 * backend that wrote a NEW file between `Read-RuntimeInfo` and that `rm` lost
 * it, and the next launch started a second backend (the D2 bug class). Now
 * one constant `sh -c` script (`$AiSmStaleRuntimeScript`) re-reads the pid
 * and removes the file only on a match, in one in-distro step.
 *
 * How: two seams. (1) Source pins on launch.ps1: no bare `rm` of runtime.json
 * is left, the script travels through `wsl.exe --exec sh -c` with the data dir
 * and pid as POSITIONAL arguments (never interpolated into the text), and it
 * holds no double quote. (2) The EXACT here-string text, extracted from
 * launch.ps1, run under a real `sh` against a temp dir: a file naming the pid
 * goes, a file naming another pid (or no readable pid) stays byte-identical,
 * an absent file is no error.
 *
 * Why it matters: nothing fails loudly when this regresses — two backends
 * just quietly share a data dir.
 *
 * NOT claimed: PowerShell 5.1 + wsl.exe delivering the multi-line script and
 * its arguments intact, and HOME being set under `--exec` (the user's
 * Windows check: `launch.ps1 -Stop` against a dead pid); the tiny
 * check-then-rm window against an atomic rename (accepted, as in D2).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempDir, readSource, removeTempDir } from '../helpers/helpers.ts';
import { constScript } from '../helpers/installer-helpers-fixture.ts';

const launch = readSource('launcher', 'launch.ps1');
const staleScript = constScript(launch, 'AiSmStaleRuntimeScript');

/** The `if ($Stop) { … }` block, up to the default flow's banner. */
const stopBlock = (() => {
  const start = launch.indexOf('if ($Stop) {');
  const end = launch.indexOf('# --- Default flow', start);
  assert.ok(start > 0 && end > start, 'no -Stop block in launch.ps1');
  return launch.slice(start, end);
})();

/** `function Remove-StaleRuntimeFile … }` — the one caller of the script. */
const removeFn = /function Remove-StaleRuntimeFile\b[\s\S]*?\n\}\n/.exec(launch)?.[0] ?? '';

/** runtime.json as server/index.ts writes it: pretty-printed, one key a line. */
function runtimeText(pid: number): string {
  const runtime = { port: 41234, token: 'abc', pid, startedAt: '2026-10-13T08:00:00.000Z', appDir: '/home/you/app' };
  return JSON.stringify(runtime, null, 2) + '\n';
}

/**
 * Run the extracted script as launch.ps1 does: `sh -c <script> sh <dataDir> <pid>`.
 * `home: null` runs it with HOME unset; `cwd` is where a relative path would land.
 */
function runStale(dataDir: string, pid: string, home: string | null = '/nonexistent-home', cwd?: string): number | null {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin' };
  if (home !== null) env.HOME = home;
  const res = spawnSync('sh', ['-c', staleScript, 'sh', dataDir, pid], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 30_000,
  });
  return res.status;
}

// --- source pins ------------------------------------------------------------

test('-Stop no longer removes runtime.json with a bare rm', () => {
  assert.doesNotMatch(stopBlock, /'rm'/, stopBlock);
  assert.doesNotMatch(stopBlock, /rm\s+-f/, stopBlock);
  assert.doesNotMatch(launch, /Invoke-InDistro @\('rm'/, 'an rm through the default shell is back');
  assert.match(stopBlock, /Remove-StaleRuntimeFile -ServerPid \$info\.ServerPid/, stopBlock);
});

test('the stale-file script runs via --exec with the data dir and pid as positional arguments', () => {
  assert.match(removeFn, /ConvertTo-AiSmScriptLine -Script \$AiSmStaleRuntimeScript/, removeFn);
  assert.match(removeFn, /& wsl\.exe -d \$Distro --exec sh -c \$script sh \$DataDir "\$ServerPid"/, removeFn);
  // Values reach the script only as $1/$2 — never spelled into its text.
  assert.doesNotMatch(staleScript, /\$DataDir|\$ServerPid|\$info/, staleScript);
  assert.match(staleScript, /\$1/, staleScript);
  assert.match(removeFn, /5 \{ Write-Host 'Process was already gone\. Could not check runtime\.json \(WSL HOME is not a plain absolute path\) - left in place\.' \}/, removeFn);
  assert.match(staleScript, /case \$p in\n\s*\$2\) rm -f \$f ;;/, 'the removal is not gated on the pid in $2');
});

test('the stale-file script holds no double quote', () => {
  // A double quote delimits the script on the Windows command line
  // (ConvertTo-AiSmScriptLine refuses one at run time).
  assert.ok(!staleScript.includes('"'), staleScript);
});

// --- the real script under sh -----------------------------------------------

test('stale-file script: a runtime.json that still names the pid is removed', async () => {
  const dir = await makeTempDir('ai-sm-stop-');
  try {
    writeFileSync(join(dir, 'runtime.json'), runtimeText(4242));
    assert.equal(runStale(dir, '4242'), 0);
    assert.ok(!existsSync(join(dir, 'runtime.json')), 'runtime.json naming the pid was kept');
  } finally {
    await removeTempDir(dir);
  }
});

test('stale-file script: a runtime.json naming another backend is left byte-identical', async () => {
  const dir = await makeTempDir('ai-sm-stop-');
  try {
    const file = join(dir, 'runtime.json');
    // 4242 vs 424 / 42420: a prefix or an extension of the pid is someone else.
    for (const [onDisk, asked] of [[5151, '4242'], [4242, '424'], [424, '4242'], [42420, '4242']] as const) {
      writeFileSync(file, runtimeText(onDisk));
      assert.equal(runStale(dir, asked), 4, `file names ${onDisk}, asked ${asked}`);
      assert.equal(readFileSync(file, 'utf8'), runtimeText(onDisk), `file names ${onDisk}, asked ${asked}`);
    }
  } finally {
    await removeTempDir(dir);
  }
});

test('stale-file script: a file with no readable pid line, or not a plain file, is left alone', async () => {
  const dir = await makeTempDir('ai-sm-stop-');
  try {
    const file = join(dir, 'runtime.json');
    const cases: [string, string][] = [
      ['one-line JSON', JSON.stringify({ port: 1, pid: 4242 })],
      ['garbage', 'not json at all\n'],
      ['empty', ''],
      ['pid twice', '{\n  "pid": 4242,\n  "pid": 4242\n}\n'],
    ];
    for (const [name, text] of cases) {
      writeFileSync(file, text);
      assert.equal(runStale(dir, '4242'), 4, name);
      assert.equal(readFileSync(file, 'utf8'), text, name);
    }
    // A symlink at the path — even to a file naming the pid — is not ours.
    const target = join(dir, 'elsewhere.json');
    writeFileSync(target, runtimeText(4242));
    unlinkSync(file);
    symlinkSync(target, file);
    assert.equal(runStale(dir, '4242'), 4, 'symlink');
    assert.ok(existsSync(file) && existsSync(target), 'symlink or its target removed');
  } finally {
    await removeTempDir(dir);
  }
});

test('stale-file script: an absent runtime.json is no error and creates nothing', async () => {
  const dir = await makeTempDir('ai-sm-stop-');
  try {
    assert.equal(runStale(dir, '4242'), 3);
    assert.ok(!existsSync(join(dir, 'runtime.json')));
    assert.equal(runStale(join(dir, 'missing-data-dir'), '4242'), 3, 'absent data dir');
  } finally {
    await removeTempDir(dir);
  }
});

test('stale-file script: a ~/ data dir is expanded against HOME (--exec skips the default shell)', async () => {
  const home = await makeTempDir('ai-sm-stop-home-');
  try {
    mkdirSync(join(home, '.ai-session-manager'));
    const file = join(home, '.ai-session-manager', 'runtime.json');
    writeFileSync(file, runtimeText(5151));
    assert.equal(runStale('~/.ai-session-manager', '4242', home), 4);
    assert.ok(existsSync(file), 'another backend’s file removed through ~/');
    writeFileSync(file, runtimeText(4242));
    assert.equal(runStale('~/.ai-session-manager', '4242', home), 0);
    assert.ok(!existsSync(file), 'own file kept through ~/');
  } finally {
    await removeTempDir(home);
  }
});

test('stale-file script: a HOME with a space, a relative HOME or no HOME refuses with exit 5 and removes nothing', async () => {
  const root = await makeTempDir('ai-sm-stop-home-');
  try {
    // A home with a space would word-split the unquoted $f: `[ … ]` errors,
    // and sed / rm would run on two words, one of them relative.
    const spaced = join(root, 'my home');
    mkdirSync(join(spaced, '.ai-session-manager'), { recursive: true });
    const file = join(spaced, '.ai-session-manager', 'runtime.json');
    writeFileSync(file, runtimeText(4242));
    // A relative HOME resolves against the cwd, so give it a file to hit too.
    mkdirSync(join(root, 'rel', '.ai-session-manager'), { recursive: true });
    const relFile = join(root, 'rel', '.ai-session-manager', 'runtime.json');
    writeFileSync(relFile, runtimeText(4242));
    const cases: [string, string | null][] = [
      ['HOME with a space', spaced],
      ['HOME unset', null],
      ['HOME empty', ''],
      ['HOME relative', 'rel'],
      ['HOME with a glob character', join(root, 'h*')],
    ];
    for (const [name, home] of cases) {
      assert.equal(runStale('~/.ai-session-manager', '4242', home, root), 5, name);
      assert.equal(readFileSync(file, 'utf8'), runtimeText(4242), `${name}: the spaced home's file changed`);
      assert.equal(readFileSync(relFile, 'utf8'), runtimeText(4242), `${name}: the relative home's file changed`);
    }
    // Without a leading ~/ HOME is never consulted: an absolute data dir works with HOME unset.
    assert.equal(runStale(join(root, 'plain'), '4242', null), 3, 'absolute dir, HOME unset');
  } finally {
    await removeTempDir(root);
  }
});

test('stale-file script: a file test that errors counts as "not ours", never as a pass', async () => {
  // launch.ps1 only ever passes an allow-listed data dir; this one has a space
  // ON PURPOSE so every unquoted `[ … $f ]` gets two words and errors (status
  // 2). A guard that let the error fall through would run sed and rm on the
  // relative second word — here `home/data/runtime.json` under the cwd.
  const root = await makeTempDir('ai-sm-stop-split-');
  try {
    mkdirSync(join(root, 'home', 'data'), { recursive: true });
    const relFile = join(root, 'home', 'data', 'runtime.json');
    writeFileSync(relFile, runtimeText(4242));
    assert.equal(runStale(join(root, 'my home', 'data'), '4242', '/nonexistent-home', root), 4);
    assert.equal(readFileSync(relFile, 'utf8'), runtimeText(4242), 'the relative word’s file was touched');
  } finally {
    await removeTempDir(root);
  }
});
