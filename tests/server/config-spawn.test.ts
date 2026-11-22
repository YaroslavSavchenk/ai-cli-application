/**
 * The one bounded child-process runner — server/config-spawn.ts `runChild`
 * (PLAN-QUALITY Q11, which folded four hand-written runners into it) — and
 * the spawn calls of its callers: `runCapture`'s start failure and default
 * timeout, server/git.ts `runGitCapture`'s start failure, and server/scaffold.ts
 * `runGit` (reached through `createLocalDir` and `cloneRepo`) — its argv, its
 * options, its start failure, a missing git and its timeout.
 *
 * How: `runChild` is driven with a FAKE child (an EventEmitter with `kill`)
 * and mocked timers, so every event order is chosen by the test and "no late
 * timeout" is proven by stepping the clock, not by sleeping. `runCapture`'s
 * synchronous spawn throw is a real one: Node refuses an argument holding a
 * NUL byte before any process starts. Scaffold's `spawn` import is replaced
 * with one that throws (`mock.method` on node:child_process plus
 * `syncBuiltinESMExports`) — a synchronous spawn failure (EMFILE) is not
 * something a test can make the machine produce on cue; the same replacement
 * hands scaffold a fake child, so its spawn call is read as made and its
 * 15 s / 5 min timeout is stepped on mocked timers, not waited out. "The timer
 * never holds the process" has no observable but the handle's `hasRef()`
 * (`spyTimeouts` in helpers.ts).
 *
 * Why it matters: a runner that settles twice or leaves its timer armed
 * SIGKILLs a child that already answered, or rejects a request that already
 * succeeded; and before Q11 scaffold's runner read its timer before it was
 * declared when spawn threw, so the request failed with a ReferenceError
 * instead of the plain refusal.
 *
 * NOT claimed: argv-only spawning and PATH resolution of the real callers —
 * tests/server/claude-version.test.ts ("never through a shell") and the git,
 * scaffold and GitHub clone suites.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import childProcess, { type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { killQuietly, runCapture, runChild } from '../../server/config.ts';
import { FsBrowseError } from '../../server/fsbrowse.ts';
import { GIT_READ_FAILED, runGitCapture } from '../../server/git.ts';
import { CLONE_TIMEOUT_MS, ScaffoldError, cloneRepo, createLocalDir } from '../../server/scaffold.ts';
import { drainMicrotasks, exists, makeTempDir, removeTempDir, spyTimeouts } from '../helpers/helpers.ts';

const TIMEOUT_MS = 1000;

interface FakeChild {
  child: ChildProcess;
  emitter: EventEmitter;
  kills: string[];
}

function fakeChild(): FakeChild {
  const emitter = new EventEmitter();
  const kills: string[] = [];
  const child = Object.assign(emitter, {
    kill: (signal: string) => {
      kills.push(signal);
      return true;
    },
  }) as unknown as ChildProcess;
  return { child, emitter, kills };
}

/** Every hook counts its calls; each answer is a distinct value or error. */
function hooks(fake: FakeChild) {
  const calls = { startThrew: 0, timedOut: 0, failed: 0, closed: 0 };
  return {
    calls,
    run: {
      start: () => fake.child,
      timeoutMs: TIMEOUT_MS,
      startThrew: () => {
        calls.startThrew += 1;
        return new Error('start threw');
      },
      timedOut: () => {
        calls.timedOut += 1;
        return new Error('timed out');
      },
      failed: () => {
        calls.failed += 1;
        return new Error('failed');
      },
      closed: (code: number | null) => {
        calls.closed += 1;
        return code === 0 ? 'done' : new Error(`exit ${code}`);
      },
    },
  };
}

test('runChild: a start() that throws rejects with startThrew and arms no timer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fake = fakeChild();
  const { calls, run } = hooks(fake);
  const settled = runChild({
    ...run,
    start: () => {
      throw new Error('EMFILE');
    },
  });
  await assert.rejects(settled, /start threw/);
  t.mock.timers.tick(TIMEOUT_MS * 2);
  assert.deepEqual(calls, { startThrew: 1, timedOut: 0, failed: 0, closed: 0 }, 'only startThrew answered');
  assert.deepEqual(fake.kills, [], 'nothing to kill');
});

test('runChild: settles once on close, and the cleared timer never fires a late timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fake = fakeChild();
  const { calls, run } = hooks(fake);
  const settled = runChild(run);
  fake.emitter.emit('close', 0);
  fake.emitter.emit('error', new Error('late'));
  fake.emitter.emit('close', 1);
  assert.equal(await settled, 'done', 'the first close wins');
  t.mock.timers.tick(TIMEOUT_MS * 2);
  assert.equal(calls.timedOut, 0, 'no timeout after the settle');
  assert.deepEqual(fake.kills, [], 'a child that answered is never SIGKILLed');
});

test('runChild: an early fail from watch wins over a later clean close, and clears the timer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fake = fakeChild();
  const { calls, run } = hooks(fake);
  const settled = runChild({
    ...run,
    watch: (_child, fail) => {
      fake.emitter.once('cap', () => fail(new Error('capped')));
    },
  });
  fake.emitter.emit('cap');
  fake.emitter.emit('close', 0);
  await assert.rejects(settled, /capped/, 'the early fail is the answer');
  assert.equal(calls.closed, 1, 'the close hook still ran (it may trace), its answer ignored');
  t.mock.timers.tick(TIMEOUT_MS * 2);
  assert.equal(calls.timedOut, 0, 'no timeout after the early fail');
});

test('runChild: an error event settles with failed and clears the timer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fake = fakeChild();
  const { calls, run } = hooks(fake);
  const settled = runChild(run);
  fake.emitter.emit('error', new Error('ENOENT'));
  await assert.rejects(settled, /^Error: failed$/);
  t.mock.timers.tick(TIMEOUT_MS * 2);
  assert.equal(calls.timedOut, 0, 'no timeout after the error');
  assert.deepEqual(fake.kills, []);
});

test('runChild: the timeout SIGKILLs the child and rejects with timedOut; a later close changes nothing', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fake = fakeChild();
  const { calls, run } = hooks(fake);
  const settled = runChild(run);
  t.mock.timers.tick(TIMEOUT_MS);
  fake.emitter.emit('close', 0);
  await assert.rejects(settled, /timed out/);
  assert.deepEqual(fake.kills, ['SIGKILL'], 'killed once, with SIGKILL');
  assert.equal(calls.timedOut, 1);
});

test('runCapture: a spawn that throws synchronously rejects with `could not be started`', async () => {
  // A NUL byte in an argument is refused by Node inside spawn(), synchronously.
  await assert.rejects(runCapture(process.execPath, ['nul\u0000byte']), (err: unknown) => {
    assert.ok(err instanceof Error, 'an Error');
    assert.equal(err.message, 'could not be started', 'the plain sentence, not Node\'s argument error');
    return true;
  });
});

test('scaffold git init: a spawn that throws synchronously rejects 500 `git is not available` and leaves no directory', async () => {
  const work = await makeTempDir('ai-sm-config-spawn-');
  const target = join(work, 'new-project');
  const spawnMock = mock.method(childProcess, 'spawn', () => {
    throw new Error('EMFILE');
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(createLocalDir(target, true), (err: unknown) => {
      assert.ok(err instanceof ScaffoldError, `a ScaffoldError, got ${String(err)}`);
      assert.equal(err.status, 500);
      assert.equal(err.message, 'git is not available');
      return true;
    });
    assert.equal(spawnMock.mock.callCount(), 1, 'the mocked spawn was the one called');
    assert.equal(await exists(target), false, 'the directory this call created is removed');
  } finally {
    spawnMock.mock.restore();
    syncBuiltinESMExports();
    await removeTempDir(work);
  }
});

test('runChild: the timeout timer is unref\'d, so a run still pending never holds the process open', async () => {
  const fake = fakeChild();
  const { run } = hooks(fake);
  const spy = spyTimeouts();
  let settled: Promise<unknown>;
  try {
    settled = runChild(run);
    assert.deepEqual(spy.armed.map((a) => a.ms), [TIMEOUT_MS], 'one timer, the run\'s timeout');
    assert.equal(spy.armed[0]?.handle.hasRef(), false, 'the timeout timer is unref\'d');
  } finally {
    spy.restore();
  }
  fake.emitter.emit('close', 0);
  assert.equal(await settled, 'done');
});

test('runChild: a child whose kill throws (already gone) still answers timedOut at the timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fake = fakeChild();
  (fake.child as unknown as { kill: () => never }).kill = () => {
    throw new Error('ESRCH');
  };
  const { calls, run } = hooks(fake);
  const settled = runChild(run);
  assert.doesNotThrow(() => t.mock.timers.tick(TIMEOUT_MS), 'the kill failure never escapes the timer');
  await assert.rejects(settled, /timed out/);
  assert.equal(calls.timedOut, 1);
  assert.doesNotThrow(() => killQuietly(fake.child), 'killQuietly itself swallows the throw');
});

test('runCapture: with no timeoutMs a child still running at 14 999 ms is left alone and SIGKILLed at 15 s', async (t) => {
  // The default is the Windows interop probes' budget (server/update-install.ts
  // calls runCapture with no timeoutMs): a cold powershell.exe takes seconds.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const outcome: { error?: unknown } = {};
  let done = false;
  const settled = runCapture(process.execPath, ['-e', 'setInterval(() => {}, 1000)']).then(
    () => {
      done = true;
    },
    (err: unknown) => {
      outcome.error = err;
      done = true;
    },
  );
  try {
    t.mock.timers.tick(14_999);
    await drainMicrotasks(10);
    assert.equal(done, false, 'not settled one millisecond before the default timeout');
    t.mock.timers.tick(1);
    await drainMicrotasks(10);
    assert.equal(done, true, 'settled at the default timeout');
    assert.ok(outcome.error instanceof Error && outcome.error.message === 'timed out', `rejects \`timed out\`, got ${String(outcome.error)}`);
  } finally {
    // A mutant with a longer default must not leave the child running.
    t.mock.timers.tick(10 * 60_000);
    await settled;
  }
});

test('runGitCapture: a spawn that throws synchronously rejects 500 with the read sentence and traces `did not spawn`', async () => {
  const spawnMock = mock.method(childProcess, 'spawn', () => {
    throw new Error('EMFILE');
  });
  syncBuiltinESMExports();
  const trace: string[] = [];
  try {
    await assert.rejects(runGitCapture(['rev-parse', '--show-toplevel'], '/', () => undefined, trace), (err: unknown) => {
      assert.ok(err instanceof FsBrowseError, `an FsBrowseError, got ${String(err)}`);
      assert.equal(err.status, 500);
      assert.equal(err.message, GIT_READ_FAILED);
      return true;
    });
    assert.deepEqual(trace, ['rev-parse did not spawn']);
  } finally {
    spawnMock.mock.restore();
    syncBuiltinESMExports();
  }
});

/** Replace node:child_process `spawn` with one that records its call and hands back `fake`. */
function mockSpawn(fake: FakeChild): { calls: () => unknown[][]; restore: () => void } {
  const spawnMock = mock.method(childProcess, 'spawn', () => fake.child);
  syncBuiltinESMExports();
  return {
    calls: () => spawnMock.mock.calls.map((c) => c.arguments as unknown[]),
    restore: () => {
      spawnMock.mock.restore();
      syncBuiltinESMExports();
    },
  };
}

test('scaffold git init: argv only, no shell, stdio ignored, no prompt — and SIGKILLed with `git operation timed out` at 15 s', async (t) => {
  const work = await makeTempDir('ai-sm-config-spawn-');
  const target = join(work, 'new-project');
  const fake = fakeChild();
  const spawned = mockSpawn(fake);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let error: unknown;
  let done = false;
  const settled = createLocalDir(target, true).catch((err: unknown) => {
    error = err;
    done = true;
  });
  try {
    const [cmd, args, opts] = spawned.calls()[0] ?? [];
    assert.equal(cmd, 'git');
    assert.deepEqual(args, ['init'], 'the argv, element for element');
    const o = opts as { shell?: unknown; stdio?: unknown; cwd?: unknown; env?: Record<string, string> };
    assert.equal(o.shell, false, 'never a shell');
    assert.equal(o.stdio, 'ignore', 'no output is buffered or inherited');
    assert.equal(o.cwd, target, 'git runs in the new directory');
    assert.equal(o.env?.['GIT_TERMINAL_PROMPT'], '0', 'git can never park on a prompt');
    t.mock.timers.tick(15_000 - 1);
    await drainMicrotasks(10);
    assert.equal(done, false, 'not settled before the 15 s init timeout');
    assert.deepEqual(fake.kills, [], 'not killed before it');
    t.mock.timers.tick(1);
    await settled;
    assert.ok(error instanceof ScaffoldError, `a ScaffoldError, got ${String(error)}`);
    assert.equal(error.status, 500);
    assert.equal(error.message, 'git operation timed out');
    assert.deepEqual(fake.kills, ['SIGKILL'], 'the hung git is SIGKILLed');
    assert.equal(await exists(target), false, 'the directory this call created is removed');
  } finally {
    spawned.restore();
    t.mock.timers.tick(10 * 60_000);
    await settled;
    await removeTempDir(work);
  }
});

test('scaffold git clone: `--` stands before the url and the dest, and the clone timeout is CLONE_TIMEOUT_MS', async (t) => {
  const work = await makeTempDir('ai-sm-config-spawn-');
  const dest = join(work, 'cloned');
  const url = 'https://example.com/o/r.git';
  const fake = fakeChild();
  const spawned = mockSpawn(fake);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let error: unknown;
  let done = false;
  const settled = cloneRepo(url, dest).catch((err: unknown) => {
    error = err;
    done = true;
  });
  try {
    const [cmd, args, opts] = spawned.calls()[0] ?? [];
    assert.equal(cmd, 'git');
    assert.deepEqual(args, ['clone', '--', url, dest], 'the argv, element for element');
    assert.equal((opts as { shell?: unknown }).shell, false, 'never a shell');
    t.mock.timers.tick(CLONE_TIMEOUT_MS - 1);
    await drainMicrotasks(10);
    assert.equal(done, false, 'not settled before the clone timeout');
    t.mock.timers.tick(1);
    await settled;
    assert.ok(error instanceof ScaffoldError && error.message === 'git operation timed out', `timed out, got ${String(error)}`);
    assert.deepEqual(fake.kills, ['SIGKILL']);
  } finally {
    spawned.restore();
    t.mock.timers.tick(60 * 60_000);
    await settled;
    await removeTempDir(work);
  }
});

test('scaffold git init: no git on the PATH rejects 500 `git is not installed` and leaves no directory', async () => {
  const work = await makeTempDir('ai-sm-config-spawn-');
  const emptyBin = join(work, 'bin');
  await mkdir(emptyBin);
  const target = join(work, 'new-project');
  const savedPath = process.env['PATH'];
  // The child's env is a copy of process.env taken at spawn: an empty PATH
  // makes the lookup of `git` fail with ENOENT, for real.
  process.env['PATH'] = emptyBin;
  try {
    await assert.rejects(createLocalDir(target, true), (err: unknown) => {
      assert.ok(err instanceof ScaffoldError, `a ScaffoldError, got ${String(err)}`);
      assert.equal(err.status, 500);
      assert.equal(err.message, 'git is not installed', 'ENOENT is named as a missing git');
      return true;
    });
    assert.equal(await exists(target), false, 'the directory this call created is removed');
  } finally {
    process.env['PATH'] = savedPath;
    await removeTempDir(work);
  }
});
