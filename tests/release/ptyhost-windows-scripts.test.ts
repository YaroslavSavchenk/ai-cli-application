/**
 * The Windows side meets a live pty-host (Nocturne D9 P5,
 * `.claude/plans/nocturne/PLAN-D9.md` § Defaults): the two constant `sh`
 * scripts that read `<data dir>/pty-host.json` INSIDE the distro.
 *
 *   - `$AiSmPtyHostDirScript` (installer/helpers/install-bundle.ps1): which
 *     version dir a LIVE pty-host runs from, so retention never prunes it.
 *     Prints `AI_SM_PTYHOST_APPDIR=<dir>` and nothing else — the state file
 *     also holds the token that owns every session, and that must never
 *     cross to Windows.
 *   - `$AiSmPtyHostStopScript` (launcher/launch.ps1 `-Stop` with no backend):
 *     SIGTERMs the pty-host, but only once /proc proves the pid is THIS data
 *     dir's pty-host, then waits for it to go.
 *
 * How: each script's EXACT here-string text, extracted from its .ps1, run
 * under a real `sh` against a REAL pty-host child (`server/pty-host-main.ts`
 * via tests/helpers/pty-host-fixture.ts) and its real state file, plus
 * hand-written state files naming processes that are not one. Async spawns
 * only: the scripts poll `kill -0`, and a child this process never reaps (a
 * blocked event loop) would read as alive.
 *
 * SAFETY: every process signalled here is one this file started; hand-written
 * state files live in plain temp dirs the pty-host fixture's teardown never
 * reads (it SIGKILLs the pid a state file in ITS dirs names).
 *
 * NOT claimed: PowerShell 5.1 + wsl.exe delivering the scripts and their
 * arguments intact (the user's Windows check: `launch.ps1 -Stop` with only a
 * pty-host left; an install over a version a pty-host still runs from).
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { makeTempDir, projectRoot, readSource, removeTempDir } from '../helpers/helpers.ts';
import { launchStateScript, ptyHostDirScript, readHelper, runSh, type ShResult } from '../helpers/installer-helpers-fixture.ts';
import { pidAlive } from '../helpers/pty-host-backend-fixture.ts';
import { hostReady, makeHostDir, spawnHost, startHost, teardownHosts } from '../helpers/pty-host-fixture.ts';

after(async () => {
  await teardownHosts();
});

const launch = readSource('launcher', 'launch.ps1');
const stopScript = launchStateScript(launch, 'AiSmPtyHostStop', 'pty-host.json');
const installBundle = readHelper('install-bundle.ps1');

/** A script under a real `sh` with a bare environment, as `wsl.exe --exec` gives it. */
function runBare(script: string, args: string[], home = '/nonexistent-home'): Promise<ShResult> {
  return runSh(script, args, { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home } });
}

/** A state file shaped exactly like server/pty-host-main.ts writes it. */
function stateText(pid: number, appDir = '/home/you/.ai-session-manager/app/v0.4.4'): string {
  const file = { pid, startedAt: '2026-11-21T08:00:00.000Z', proto: 1, build: 'v0.4.4', appDir, token: 'secret-token' };
  return JSON.stringify(file, null, 2) + '\n';
}

/** A process that is alive and certainly not a pty-host; SIGKILLed by the caller. */
function bystander(): { pid: number; kill: () => void } {
  const child = spawn('sleep', ['300'], { stdio: 'ignore' });
  const pid = child.pid;
  if (pid === undefined) throw new Error('sleep has no pid');
  return { pid, kill: () => child.kill('SIGKILL') };
}

/**
 * A stand-in pty-host: `<node> <code>/<entryName> <dataDirArg>` — the argv
 * shape the stop script proves identity on — without being one. Resolves once
 * it runs; SIGKILLed by the caller. `ignoreTerm`: it survives a SIGTERM.
 */
async function fakePtyHost(
  code: string,
  dataDirArg: string,
  opts: { ignoreTerm?: boolean; entryName?: string } = {},
): Promise<ChildProcess> {
  const entry = join(code, opts.entryName ?? 'pty-host-main.ts');
  const onTerm = opts.ignoreTerm ? "process.on('SIGTERM', () => {});\n" : '';
  writeFileSync(entry, `${onTerm}setInterval(() => {}, 1000);\nprocess.stdout.write('up\\n');\n`);
  const child = spawn(process.execPath, [entry, dataDirArg], { stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise((resolve) => child.stdout?.once('data', resolve));
  return child;
}

/** The pid of a process that has exited (the number is free, or someone else's). */
async function deadPid(): Promise<number> {
  const child = spawn('true', [], { stdio: 'ignore' });
  const pid = child.pid;
  if (pid === undefined) throw new Error('true has no pid');
  await new Promise((resolve) => child.once('exit', resolve));
  return pid;
}

// --- source pins ------------------------------------------------------------

test('both scripts hold no double quote (it delimits a script on the Windows command line)', () => {
  assert.ok(!stopScript.includes('"'), stopScript);
  assert.ok(!ptyHostDirScript.includes('"'), ptyHostDirScript);
});

test('-Stop stops the pty-host on exactly the two no-backend paths, through --exec with the data dir as $1', () => {
  const start = launch.indexOf('if ($Stop) {');
  const end = launch.indexOf('# --- Default flow', start);
  const stopBlock = launch.slice(start, end);
  // No runtime.json, and a runtime.json whose pid was already gone. A backend
  // that was alive ends its own sessions on SIGTERM (shutdown-all).
  assert.equal(stopBlock.split('Stop-PtyHost').length - 1, 2, stopBlock);
  assert.match(stopBlock, /Write-Host "Backend is not running[^\n]*\n\s*Stop-PtyHost\n\s*exit 0/, stopBlock);
  // The pid was gone: only when the stale-file step found no other backend
  // (0 removed, 3 no file). 4 = runtime.json now names ANOTHER backend (a
  // restart/update handoff in between) whose pty-host must live; 5 = nothing
  // was checked.
  assert.match(
    stopBlock,
    /\$stale = Remove-StaleRuntimeFile -ServerPid \$info\.ServerPid\n(\s*#[^\n]*\n)*\s*if \(\$stale -eq 0 -or \$stale -eq 3\) \{\n\s*Stop-PtyHost\n\s*\} else \{\n\s*Write-Host 'The session holder \(pty-host\), if any, is left alone\.'\n\s*\}\n\s*exit 0/,
    stopBlock,
  );
  const removeFn = /function Remove-StaleRuntimeFile\b[\s\S]*?\n\}\n/.exec(launch)?.[0] ?? '';
  assert.match(removeFn, /\$code = \$LASTEXITCODE\n/, removeFn);
  assert.match(removeFn, /\n\s*return \$code\n\}\n$/, removeFn);
  const fn = /function Stop-PtyHost\b[\s\S]*?\n\}\n/.exec(launch)?.[0] ?? '';
  assert.match(fn, /ConvertTo-AiSmScriptLine -Script \$AiSmPtyHostStopScript/, fn);
  assert.match(fn, /& wsl\.exe -d \$Distro --exec sh -c \$script sh \$DataDir\n/, fn);
  assert.doesNotMatch(stopScript, /\$DataDir|\$Distro/, stopScript);
});

test('the installer reads the pty-host dir through --exec with the data dir as $1, and passes it as $4', () => {
  const fn = /function Get-AiSmHostVersionDir\b[\s\S]*?\n\}\n/.exec(installBundle)?.[0] ?? '';
  assert.match(fn, /ConvertTo-AiSmScriptLine -Script \$AiSmPtyHostDirScript/, fn);
  assert.match(fn, /'-d ' \+ \$Distro \+ ' --exec sh -c "' \+ \$script \+ '" sh ' \+ \$DataDir\)/, fn);
  // Only what the allow-list let through reaches the unpack script.
  assert.match(fn, /return \(Get-AiSmVersionTail \$matches\[1\]\)/, fn);
  assert.match(installBundle, /'" sh ' \+ \$AppDir \+ ' ' \+ \$Version \+ ' ' \+ \$live \+ ' ' \+ \$hostDir$/m);
  assert.doesNotMatch(ptyHostDirScript, /token/i, 'the script must not even name the token');
});

// --- the installer's read, under sh ----------------------------------------

test('dir script: a live pty-host names the dir it runs from, and nothing of the token crosses', async () => {
  const h = await startHost();
  const res = await runBare(ptyHostDirScript, [h.dataDir]);
  assert.equal(res.code, 0, res.out);
  // The real pty-host-main.ts runs from this checkout: appDir = its root.
  assert.equal(res.out, `AI_SM_PTYHOST_APPDIR=${projectRoot}\n`);
  assert.ok(!res.out.includes(h.file.token), 'the token left the distro');
});

test('dir script: a dead pid, no file, a symlinked file or an appDir outside the allow-list protect nothing', async () => {
  const dir = await makeTempDir('ai-sm-hostdir-');
  const by = bystander();
  try {
    const file = join(dir, 'pty-host.json');
    assert.equal((await runBare(ptyHostDirScript, [dir])).code, 3, 'no file');
    writeFileSync(file, stateText(await deadPid()));
    const dead = await runBare(ptyHostDirScript, [dir]);
    assert.deepEqual([dead.code, dead.out], [4, ''], 'dead pid');
    // An appDir the allow-list refuses is no line at all, not a truncated one.
    for (const appDir of ['/home/you/my app/v1', "/home/you/a'b", '/home/you/$(x)']) {
      writeFileSync(file, stateText(by.pid, appDir));
      const bad = await runBare(ptyHostDirScript, [dir]);
      assert.deepEqual([bad.code, bad.out], [4, ''], appDir);
    }
    writeFileSync(file, JSON.stringify({ pid: by.pid, appDir: '/a/b' }));
    assert.equal((await runBare(ptyHostDirScript, [dir])).code, 4, 'one-line JSON: no key line');
    // The control: the same live pid with a clean appDir is read.
    writeFileSync(file, stateText(by.pid));
    const ok = await runBare(ptyHostDirScript, [dir]);
    assert.deepEqual([ok.code, ok.out], [0, 'AI_SM_PTYHOST_APPDIR=/home/you/.ai-session-manager/app/v0.4.4\n']);
    const elsewhere = join(dir, 'elsewhere.json');
    writeFileSync(elsewhere, stateText(by.pid));
    const linkDir = join(dir, 'linked');
    mkdirSync(linkDir);
    symlinkSync(elsewhere, join(linkDir, 'pty-host.json'));
    assert.equal((await runBare(ptyHostDirScript, [linkDir])).code, 3, 'symlink');
  } finally {
    by.kill();
    await removeTempDir(dir);
  }
});

// --- launch.ps1 -Stop's script, under sh ------------------------------------

test('stop script: a live pty-host of this data dir is SIGTERMed and gone before the script returns', async () => {
  const h = await startHost();
  const res = await runBare(stopScript, [h.dataDir]);
  assert.equal(res.code, 0, res.out);
  assert.equal(res.out, `AI_SM_PTYHOST_PID=${h.pid}\n`);
  assert.equal(await h.exited, 0, 'the SIGTERM handler exits 0 after shutdown-all');
  assert.ok(!existsSync(join(h.dataDir, 'pty-host.json')), 'the pty-host removes its own state file');
});

test('stop script: a ~/ data dir is expanded against HOME and still matches the pty-host argv', async () => {
  const h = spawnHost(await makeHostDir());
  await hostReady(h);
  const res = await runBare(stopScript, [`~/${basename(h.dataDir)}`], dirname(h.dataDir));
  assert.equal(res.code, 0, res.out);
  assert.equal(await h.exited, 0);
});

test('stop script: a pid that is not THIS data dir’s pty-host is never signalled', async () => {
  const dir = await makeTempDir('ai-sm-hoststop-');
  const by = bystander();
  // A real pty-host, but of ANOTHER data dir.
  const other = await startHost();
  // A node process naming THIS data dir in its argv, but not a pty-host.
  const impostor = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', dir], { stdio: 'ignore' });
  try {
    const file = join(dir, 'pty-host.json');
    const cases = [
      ['a bystander', by.pid],
      ['another data dir’s pty-host', other.pid],
      ['a non-pty-host naming this data dir', impostor.pid as number],
    ] as const;
    // Alive but not ours: its own exit code, never signalled.
    for (const [name, pid] of cases) {
      writeFileSync(file, stateText(pid));
      const res = await runBare(stopScript, [dir]);
      assert.deepEqual([res.code, res.out], [8, `AI_SM_PTYHOST_PID=${pid}\n`], name);
    }
    // Gone: "already gone".
    const dead = await deadPid();
    writeFileSync(file, stateText(dead));
    const gone = await runBare(stopScript, [dir]);
    assert.deepEqual([gone.code, gone.out], [6, `AI_SM_PTYHOST_PID=${dead}\n`], 'a dead pid');
    assert.ok(pidAlive(by.pid), 'the bystander was signalled');
    assert.ok(pidAlive(other.pid), 'the other data dir’s pty-host was signalled');
    assert.ok(pidAlive(impostor.pid as number), 'the impostor was signalled');
    for (const [name, text] of [['garbage', 'not json\n'], ['one-line JSON', JSON.stringify({ pid: by.pid })], ['empty', '']]) {
      writeFileSync(file, text);
      assert.equal((await runBare(stopScript, [dir])).code, 4, name);
    }
    const empty = join(dir, 'none');
    mkdirSync(empty);
    assert.equal((await runBare(stopScript, [empty])).code, 3, 'no file');
    assert.equal((await runBare(stopScript, ['~/x'], 'relative')).code, 5, 'relative HOME');
  } finally {
    by.kill();
    impostor.kill('SIGKILL');
    await removeTempDir(dir);
  }
});

test('stop script: this data dir’s pty-host under ANOTHER spelling of the dir is not signalled (exit 8)', async () => {
  // The argv holds the dir exactly as the backend passed it; a trailing slash
  // or a `..` detour is not proof, so -Stop fails closed and says so.
  const h = await startHost();
  const res = await runBare(stopScript, [`${h.dataDir}/`]);
  assert.deepEqual([res.code, res.out], [8, `AI_SM_PTYHOST_PID=${h.pid}\n`]);
  assert.ok(pidAlive(h.pid), 'the pty-host was signalled');
});

test('stop script: a pty-host that ignores SIGTERM is reported after 10 s (exit 7), not waited on forever', async () => {
  const dataDir = await makeTempDir('ai-sm-hoststop-');
  const code = await makeTempDir('ai-sm-fakehost-');
  // Same argv shape as the real one: `<node> <…>/pty-host-main.ts <data dir>`.
  const child = await fakePtyHost(code, dataDir, { ignoreTerm: true });
  try {
    writeFileSync(join(dataDir, 'pty-host.json'), stateText(child.pid as number));
    const started = performance.now(); // monotonic: WSL steps the wall clock back ~1 s at times
    const res = await runBare(stopScript, [dataDir]);
    const waited = Math.round(performance.now() - started);
    assert.equal(res.code, 7, res.out);
    assert.equal(res.out, `AI_SM_PTYHOST_PID=${child.pid}\n`);
    // The full 10 s (50 polls of `sleep 0.2`, a hard minimum) before giving
    // up: a shorter wait would report a pty-host that is still ending its
    // sessions as hung. No upper bound here — a slow runner only stretches it.
    assert.ok(waited >= 9_500, `gave up after ${waited} ms, before the 10 s wait`);
  } finally {
    child.kill('SIGKILL');
    await removeTempDir(dataDir);
    await removeTempDir(code);
  }
});

test('stop script: a pty-host whose argv names a NEAR-MISS of this data dir is not signalled (exit 8)', async () => {
  // The dev data dir `~/.ai-session-manager-dev` starts with the installed
  // app's `~/.ai-session-manager`: the dir must be a WHOLE argv word (grep -x),
  // taken literally (-F: a `.` in it is no wildcard), and the entry must END
  // in pty-host-main.ts.
  const root = await makeTempDir('ai-sm-hoststop-');
  const code = await makeTempDir('ai-sm-fakehost-');
  const dir = join(root, '.ai-session-manager');
  mkdirSync(dir);
  const children: ChildProcess[] = [];
  try {
    const cases = [
      ['a data dir this one is a prefix of', { arg: `${dir}-dev` }],
      ['a data dir differing only where this one has a `.`', { arg: join(root, 'Xai-session-manager') }],
      ['an entry that only starts with pty-host-main.ts', { arg: dir, entryName: 'pty-host-main.ts.orig' }],
    ] as const;
    for (const [name, c] of cases) {
      const child = await fakePtyHost(code, c.arg, { entryName: 'entryName' in c ? c.entryName : undefined });
      children.push(child);
      writeFileSync(join(dir, 'pty-host.json'), stateText(child.pid as number));
      const res = await runBare(stopScript, [dir]);
      assert.deepEqual([res.code, res.out], [8, `AI_SM_PTYHOST_PID=${child.pid}\n`], name);
      assert.ok(pidAlive(child.pid as number), `${name}: it was signalled`);
    }
  } finally {
    for (const child of children) child.kill('SIGKILL');
    await removeTempDir(root);
    await removeTempDir(code);
  }
});
