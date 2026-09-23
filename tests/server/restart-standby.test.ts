/**
 * Manual restart, preflight step 3 — the STANDBY backend, from both sides.
 *
 *   1. createStandbyStarter (server/restart.ts), the parent side of the IPC
 *      handshake: this glue used to live inline in server/index.ts, where it
 *      could only be exercised by spawning a real backend. It is a factory
 *      with an injected `spawn` now, so a ready timeout, a child dying at the
 *      wrong moment and a `send` on a closed channel are a few lines each
 *      (`fakeChild` in `tests/helpers/restart-fixture.ts`).
 *   2. The standby CHILD, driven directly over IPC (no restart, no vite): a
 *      real `server/index.ts` with AI_SM_STANDBY=1 does the entire boot except
 *      `listen`, answers `standby-ready`, and waits. The safety of the feature
 *      rests on what it does NOT do while it waits: bind the port, write
 *      runtime.json (the file still describes the LIVE parent), touch the
 *      parent's data dir, or outlive the parent that forgot it. Also: a PTY
 *      never inherits the handoff variables, and AI_SM_STANDBY set by hand
 *      without an IPC channel boots normally.
 *
 * SAFETY: every process here is one this file started, on a temp data dir,
 * stopped by its own ChildProcess handle.
 *
 * NOT claimed here: a full restart through the standby —
 * `tests/server/restart-real.test.ts`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createStandbyStarter, type StandbyChild } from '../../server/restart.ts';
import { readWebBuild } from '../../server/buildinfo.ts';
import {
  createSession,
  projectRoot,
  readServerLog,
  startTestServer,
  waitUntil,
} from '../helpers/helpers.ts';
import {
  tempDir,
  webDistCopy,
  within,
  fakeChild,
  readRuntime,
} from '../helpers/restart-fixture.ts';

// ---------------------------------------------------------------------------
// 1d. createStandbyStarter — the parent side of the IPC handshake
// ---------------------------------------------------------------------------
//
// This glue used to live inline in server/index.ts, where it could only be
// exercised by spawning a real backend: a 20 s ready timeout, a child dying at
// the wrong moment and a `send` on a closed channel are all states that are
// expensive or impossible to stage that way. It is a factory with an injected
// `spawn` now, so every one of them is a few lines here.

/** A starter over one fake child, with the spawn arguments captured. */
function standbyHarness(over: { readyTimeoutMs?: number } = {}): {
  start: (env: { portHint: number; restartedFrom: number }) => Promise<StandbyChild>;
  child: ReturnType<typeof fakeChild>;
  spawns: { cmd: string; args: string[]; opts: Record<string, unknown> }[];
  lines: string[];
} {
  const child = fakeChild();
  const spawns: { cmd: string; args: string[]; opts: Record<string, unknown> }[] = [];
  const lines: string[] = [];
  const start = createStandbyStarter({
    entry: '/repo/server/index.ts',
    cwd: '/repo',
    log: (level, message) => lines.push(`[${level}] ${message}`),
    spawnFn: (cmd, args, opts) => {
      spawns.push({ cmd, args, opts: opts as unknown as Record<string, unknown> });
      return child;
    },
    ...(over.readyTimeoutMs !== undefined ? { readyTimeoutMs: over.readyTimeoutMs } : {}),
  });
  return { start, child, spawns, lines };
}

test('standby starter: spawns this node binary with an argv array, an ipc channel and the handoff env', async () => {
  const h = standbyHarness();
  const pending = h.start({ portHint: 41000, restartedFrom: 4242 });
  const spawn0 = h.spawns[0];
  assert.ok(spawn0 !== undefined, 'exactly one spawn');
  assert.equal(spawn0.cmd, process.execPath, 'never a shell, never a PATH lookup');
  assert.deepEqual(spawn0.args, ['/repo/server/index.ts']);
  assert.equal(spawn0.opts['cwd'], '/repo');
  assert.equal(spawn0.opts['detached'], true);
  assert.deepEqual(spawn0.opts['stdio'], ['ignore', 'ignore', 'ignore', 'ipc']);
  const env = spawn0.opts['env'] as Record<string, string>;
  assert.equal(env['AI_SM_PORT_HINT'], '41000');
  assert.equal(env['AI_SM_RESTARTED_FROM'], '4242');
  assert.equal(env['AI_SM_STANDBY'], '1');

  h.child.emit('message', { type: 'standby-ready' });
  const standby = await within(pending, 'standby-ready');
  assert.equal(standby.pid, 31337);
  assert.equal(standby.dead(), false);

  standby.go();
  assert.deepEqual(h.child.sent, [{ type: 'go' }], 'the handoff is one message, nothing else');
  assert.equal(h.child.disconnects, 1, 'and the channel is closed after it is written');
  assert.equal(h.child.unrefs, 1, 'the child is unref\'d: it outlives us');
});

test('standby starter: a message that is not exactly `standby-ready` is ignored, not obeyed', async () => {
  const h = standbyHarness({ readyTimeoutMs: 60 });
  const pending = h.start({ portHint: 41000, restartedFrom: 4242 });
  for (const junk of [null, 'standby-ready', 42, { type: 'standby-readyish' }, { type: 42 }, {}]) {
    h.child.emit('message', junk);
  }
  await assert.rejects(
    within(pending, 'the starter'),
    /did not report ready within 60ms/,
    'none of that counted as a report',
  );
  assert.deepEqual(h.child.killed, ['SIGTERM'], 'and the timed-out standby is killed, not left running');
});

test('standby starter: a child that exits BEFORE ready rejects with the exit status', async () => {
  const h = standbyHarness();
  const pending = h.start({ portHint: 41000, restartedFrom: 4242 });
  h.child.emit('exit', 1, null);
  await assert.rejects(within(pending, 'the starter'), /exited early \(code=1 signal=null\)/);
  assert.deepEqual(h.child.killed, ['SIGTERM'], 'the kill is unconditional: a half-dead child must not linger');
});

test('standby starter: a spawn error before ready rejects, and never resolves later', async () => {
  const h = standbyHarness();
  const pending = h.start({ portHint: 41000, restartedFrom: 4242 });
  h.child.emit('error', new Error('EACCES'));
  await assert.rejects(within(pending, 'the starter'), /could not be spawned/);
  // A late report must not resurrect a settled promise.
  h.child.emit('message', { type: 'standby-ready' });
});

test('standby starter: a death AFTER ready sets dead() and makes go() throw SYNCHRONOUSLY', async () => {
  // The 2026-09-08 finding: `go` reported its failure only in the async send
  // callback, so the caller waited out the full takeover timeout for a backend
  // that no longer existed.
  for (const die of [
    (c: ReturnType<typeof fakeChild>): void => void c.emit('exit', 0, null),
    (c: ReturnType<typeof fakeChild>): void => void c.emit('disconnect'),
    (c: ReturnType<typeof fakeChild>): void => void c.emit('error', new Error('EPIPE')),
  ]) {
    const h = standbyHarness();
    const pending = h.start({ portHint: 41000, restartedFrom: 4242 });
    h.child.emit('message', { type: 'standby-ready' });
    const standby = await within(pending, 'standby-ready');
    assert.equal(standby.dead(), false, 'alive until it is not');

    die(h.child);
    assert.equal(standby.dead(), true, 'the death is visible BEFORE the teardown');
    assert.throws(() => standby.go(), /died before the handoff/, 'and go() refuses at once');
    assert.deepEqual(h.child.sent, [], 'nothing was written into a dead channel');
    assert.ok(
      h.lines.some((l) => l.startsWith('[warn]') && l.includes('gone before the handoff')),
      `the log names it: ${h.lines.join(' | ')}`,
    );
  }
});

test('standby starter: a closed channel makes go() throw instead of failing in a callback', async () => {
  const h = standbyHarness();
  const pending = h.start({ portHint: 41000, restartedFrom: 4242 });
  h.child.emit('message', { type: 'standby-ready' });
  const standby = await within(pending, 'standby-ready');

  h.child.connectedFlag = false; // Closed, but no event fired yet.
  assert.equal(standby.dead(), false, 'nothing has told us it died');
  assert.throws(() => standby.go(), /closed the ipc channel/);
  assert.deepEqual(h.child.sent, []);
});

test('standby starter: stop() kills a standby a later refusal decided not to use', async () => {
  const h = standbyHarness();
  const pending = h.start({ portHint: 41000, restartedFrom: 4242 });
  h.child.emit('message', { type: 'standby-ready' });
  const standby = await within(pending, 'standby-ready');

  standby.stop();
  assert.deepEqual(h.child.killed, ['SIGTERM']);
  // Our own kill must not be reported as a surprise death.
  h.child.emit('exit', null, 'SIGTERM');
  assert.ok(
    !h.lines.some((l) => l.includes('gone before the handoff')),
    `a kill we asked for is not a death to warn about: ${h.lines.join(' | ')}`,
  );
});

// ---------------------------------------------------------------------------
// 3b. The STANDBY child, driven directly over IPC (no restart, no vite)
// ---------------------------------------------------------------------------
//
// Preflight step 3 spawns `server/index.ts` with AI_SM_STANDBY=1 and an IPC
// channel; the child does the ENTIRE boot except `listen`, answers
// `standby-ready`, and then waits. The whole safety of the feature rests on
// what that child does NOT do while it waits: it must not bind the port, must
// not write runtime.json (the file still describes the LIVE parent), and must
// never outlive the parent that forgot it. Driving it straight over IPC pins
// exactly that, in a second, without a build.

/** A free loopback port, released again before it is handed on as a hint. */
async function freePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

/** Spawn a standby child exactly the way server/index.ts's startStandby does. */
function spawnStandby(dataDir: string, portHint: number, extraEnv: Record<string, string> = {}): ChildProcess {
  return spawn(process.execPath, [join(projectRoot, 'server', 'index.ts')], {
    cwd: projectRoot,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: {
      ...process.env,
      AI_SM_DATA_DIR: dataDir,
      AI_SM_STARTUP_GRACE_MS: '600000',
      AI_SM_GRACE_MS: '600000',
      AI_SM_PORT_HINT: String(portHint),
      AI_SM_RESTARTED_FROM: '4242',
      AI_SM_STANDBY: '1',
      ...extraEnv,
    },
  });
}

/** Resolve on the child's first `{type:'standby-ready'}`; reject if it dies first. */
function standbyReady(child: ChildProcess): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    child.on('message', (message) => {
      if (typeof message === 'object' && message !== null && (message as { type?: unknown }).type === 'standby-ready') {
        resolve();
      }
    });
    child.on('exit', (code, signal) => reject(new Error(`standby exited early (code=${code} signal=${signal})`)));
    child.on('error', (err) => reject(err));
  });
}

/** Resolve with the child's exit, whatever it is. */
function exitOf(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

test('standby child: reports ready, binds NOTHING, writes NO runtime.json, and leaves when the parent goes away', async () => {
  const dataDir = tempDir();
  const runtimeFile = join(dataDir, 'runtime.json');
  const hint = await freePort();
  const child = spawnStandby(dataDir, hint);
  const exited = exitOf(child);
  try {
    await within(standbyReady(child), 'standby-ready', 30_000);

    // The three things a waiting standby must NOT have done. runtime.json still
    // belongs to the live parent — a child that wrote it here would point the
    // launcher at a process that is listening on nothing.
    assert.ok(!existsSync(runtimeFile), 'runtime.json is the PARENT\'s until the handoff');
    await assert.rejects(
      fetch(`http://127.0.0.1:${hint}/health`),
      'the hinted port is still free: the standby has not bound it',
    );

    // A message that is not the one word it obeys changes nothing. Proven by
    // what follows rather than by a sleep: a child that had taken this as `go`
    // would be listening and would IGNORE the disconnect below instead of
    // exiting on it.
    child.send({ type: 'go-ahead-then' });
    child.send('go');

    child.disconnect();
    const exit = await within(exited, 'the standby to exit on the parent going away', 30_000);
    assert.deepEqual(exit, { code: 0, signal: null }, 'an orphaned standby leaves quietly, code 0');
    assert.ok(!existsSync(runtimeFile), 'and it never wrote a discovery file at all');

    const log = readFileSync(join(dataDir, 'server.log'), 'utf8');
    assert.match(log, /\[boot\] standby: ready, waiting for the handoff from pid 4242/);
    assert.match(log, /\[boot\] standby: the parent went away before the handoff; exiting/);
    assert.ok(!/listening on 127\.0\.0\.1:/.test(log), 'it never listened, and never said it did');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited.catch(() => undefined);
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('standby child: `go` is what makes it take the hinted port and publish runtime.json', async () => {
  const dataDir = tempDir();
  const runtimeFile = join(dataDir, 'runtime.json');
  const hint = await freePort();
  const child = spawnStandby(dataDir, hint);
  const exited = exitOf(child);
  try {
    await within(standbyReady(child), 'standby-ready', 30_000);
    assert.ok(!existsSync(runtimeFile));

    child.send({ type: 'go' });
    const rt = await waitUntil(
      () => {
        const parsed = readRuntime(runtimeFile);
        return parsed !== undefined && typeof parsed.port === 'number' ? parsed : undefined;
      },
      'the standby to publish runtime.json after `go`',
      30_000,
    );
    assert.equal(rt.port, hint, 'it took the hinted port — the host window is locked to it');
    assert.equal(rt.pid, child.pid, 'and the file names this very child');

    const health = await fetch(`http://127.0.0.1:${rt.port}/health`);
    assert.equal(health.status, 200);
    assert.equal(await health.text(), '{"ok":true}');

    const log = readFileSync(join(dataDir, 'server.log'), 'utf8');
    assert.match(log, /\[boot\] standby: handoff received from pid 4242, taking the port/);
    assert.match(log, new RegExp(`\\[boot\\] port hint ${hint} taken`));
    assert.ok(!log.includes(rt.token), 'the token is never logged');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await within(exited, 'the standby to stop', 15_000).catch(() => child.kill('SIGKILL'));
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('standby child: `go` drops a leftover dist-prev, and waiting NEVER touches it', async () => {
  // The parent drops the swap's backup the moment `go` is out (restart.ts), but
  // a parent that dies in that instant leaves `<dist>-prev` behind forever — a
  // second copy of the whole UI in the tree, and bait for the next restart. So
  // the child commits the swap too (server/index.ts, on `go`).
  //
  // The other half is the one that must NOT happen: while the standby waits,
  // the parent is still whole and can still REFUSE — `revertFrontend` needs
  // that backup to keep the "every 422 leaves web/dist unchanged" promise. A
  // child that tidied up early would destroy the only copy of the old build.
  const web = webDistCopy();
  const prevDir = join(web.dir, 'dist-prev');
  // What a parent's swap leaves behind: the OLD build, moved aside.
  mkdirSync(prevDir, { recursive: true });
  writeFileSync(join(prevDir, 'index.html'), '<!doctype html><title>old</title>\n');
  writeFileSync(join(prevDir, 'build-id.json'), '{"id":"20260908-0000-old0000"}\n');
  const servedBefore = readWebBuild(web.served);

  const dataDir = tempDir();
  const runtimeFile = join(dataDir, 'runtime.json');
  const hint = await freePort();
  const child = spawnStandby(dataDir, hint, { AI_SM_WEB_DIST_DIR: web.served });
  const exited = exitOf(child);
  try {
    await within(standbyReady(child), 'standby-ready', 30_000);
    assert.ok(
      existsSync(prevDir),
      'a WAITING standby leaves the backup alone: the parent can still revert onto it',
    );

    child.send({ type: 'go' });
    // runtime.json is published by beginListening(), which runs AFTER the
    // commit — so this wait is the commit's own happens-before, not a sleep.
    const rt = await waitUntil(
      () => {
        const parsed = readRuntime(runtimeFile);
        return parsed !== undefined && typeof parsed.port === 'number' ? parsed : undefined;
      },
      'the standby to publish runtime.json after `go`',
      30_000,
    );
    assert.equal(rt.port, hint);
    assert.ok(!existsSync(prevDir), 'the handoff commits the swap: no dist-prev survives it');
    assert.deepEqual(
      readWebBuild(web.served),
      servedBefore,
      'and the build it now serves is the swapped-in one, untouched by the cleanup',
    );
    assert.ok(!existsSync(join(web.dir, 'dist-next')), 'nothing staged is invented either');
    assert.ok(
      !existsSync(join(projectRoot, 'web', 'dist-prev')) &&
        !existsSync(join(projectRoot, 'web', 'dist-next')),
      "and the repo's own web/dist keeps no staging dirs",
    );
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await within(exited, 'the standby to stop', 15_000).catch(() => child.kill('SIGKILL'));
    rmSync(dataDir, { recursive: true, force: true });
    web.remove();
  }
});

/**
 * A data dir that looks like a LIVE parent's: its discovery file, a history
 * with a session still running, the settings file that session was launched
 * with, and the status line's cache.
 */
function liveParentDataDir(): { dir: string; snapshot: () => string } {
  const dir = tempDir();
  writeFileSync(
    join(dir, 'runtime.json'),
    JSON.stringify({ port: 41234, token: 'p'.repeat(64), pid: 4242, startedAt: '2026-09-08T10:00:00.000Z' }) + '\n',
  );
  writeFileSync(
    join(dir, 'history.json'),
    JSON.stringify([
      {
        id: '11111111-2222-3333-4444-555555555555',
        sessionId: '11111111-2222-3333-4444-555555555555',
        conversation: true,
        cwd: '/tmp',
        command: 'claude',
        args: [],
        title: 'a session the PARENT is still running',
        createdAt: '2026-09-08T10:00:01.000Z',
        lastUsedAt: '2026-09-08T10:00:01.000Z',
        ended: null,
      },
    ]) + '\n',
  );
  mkdirSync(join(dir, 'session-settings'), { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, 'session-settings', '11111111-2222-3333-4444-555555555555.json'), '{"statusLine":{}}\n');
  writeFileSync(join(dir, 'statusline-cache.json'), '{"11111111":{"branch":"main"}}\n');

  /** Everything the parent owns, as one comparable string (content + mtime). */
  const snapshot = (): string => {
    const parts: string[] = [];
    for (const rel of [
      'runtime.json',
      'history.json',
      'statusline-cache.json',
      join('session-settings', '11111111-2222-3333-4444-555555555555.json'),
    ]) {
      const path = join(dir, rel);
      if (!existsSync(path)) {
        parts.push(`${rel}: GONE`);
        continue;
      }
      parts.push(`${rel}: ${statSync(path).mtimeMs} ${readFileSync(path, 'utf8')}`);
    }
    return parts.join('\n');
  };
  return { dir, snapshot };
}

test('standby child: booting touches NOTHING in the parent\'s data dir — history is read, never stamped', async () => {
  // The child boots inside a data dir whose owner is still SERVING. The boot
  // that an ordinary start does — stamp every live history entry 'crash' and
  // rewrite the file, wipe session-settings/, unlink the statusline cache —
  // would rewrite a live process's history and delete the --settings files its
  // running claude sessions are using.
  const parent = liveParentDataDir();
  const before = parent.snapshot();
  const child = spawnStandby(parent.dir, await freePort());
  const exited = exitOf(child);
  try {
    await within(standbyReady(child), 'standby-ready', 30_000);
    assert.equal(parent.snapshot(), before, 'a standby that reported ready has written nothing');

    const log = readFileSync(join(parent.dir, 'server.log'), 'utf8');
    assert.match(
      log,
      /history loaded read-only: 1 entries \(nothing stamped, nothing written\)/,
      `the read-only load is what the log says it is: ${log}`,
    );
    assert.ok(!/stamped 'crash'/.test(log), "and nothing was stamped 'crash'");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited.catch(() => undefined);
    rmSync(parent.dir, { recursive: true, force: true });
  }
});

test('standby child: a SIGTERM before `go` leaves the LIVE parent\'s files exactly as they were', async () => {
  // The parent's own ready-timeout path SIGTERMs the standby. The ordinary
  // shutdown that signal normally runs would unlink runtime.json — the file
  // that describes the parent, which is still serving — and stamp its live
  // sessions 'shutdown'. The launcher would then start a SECOND backend.
  const parent = liveParentDataDir();
  const before = parent.snapshot();
  const child = spawnStandby(parent.dir, await freePort());
  const exited = exitOf(child);
  try {
    await within(standbyReady(child), 'standby-ready', 30_000);
    child.kill('SIGTERM');
    const exit = await within(exited, 'the standby to exit on SIGTERM', 30_000);
    assert.deepEqual(exit, { code: 0, signal: null }, 'it leaves quietly, code 0');

    assert.equal(
      parent.snapshot(),
      before,
      'runtime.json, history.json and session-settings/ are byte-identical, mtimes included',
    );
    const log = readFileSync(join(parent.dir, 'server.log'), 'utf8');
    assert.match(
      log,
      /standby: received SIGTERM before the handoff; exiting without touching the data dir/,
      `the guarded path is the one that ran: ${log}`,
    );
    assert.ok(
      !log.includes('received SIGTERM, shutting down'),
      'never the ordinary shutdown, which unlinks runtime.json',
    );
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited.catch(() => undefined);
    rmSync(parent.dir, { recursive: true, force: true });
  }
});

test('a PTY session never inherits the handoff variables — they describe the BACKEND, not the terminal', async () => {
  // server/sessions.ts spawns with `...process.env`. A session started by a
  // backend that came from a handoff would otherwise carry AI_SM_STANDBY,
  // AI_SM_PORT_HINT, AI_SM_RESTARTED_FROM and AI_SM_WEB_DIST_DIR into the
  // user's shell — where a
  // backend launched from inside that terminal would read them and try to boot
  // as somebody's standby on somebody's port.
  const outDir = tempDir();
  const envFile = join(outDir, 'env.txt');
  const web = webDistCopy();
  const server = await startTestServer({
    env: {
      AI_SM_STANDBY: '1', // No IPC channel here, so this boots normally (warned).
      AI_SM_PORT_HINT: '41000',
      AI_SM_RESTARTED_FROM: '4242',
      AI_SM_WEB_DIST_DIR: web.served,
      // The markers a Claude Code session hands its children (a backend
      // started from inside one inherits them): a claude the app launches
      // would otherwise believe it is a nested child and stop saving its
      // transcript. The user's own CLAUDE_CODE_* configuration is NOT a marker
      // and must survive.
      CLAUDECODE: '1',
      CLAUDE_CODE_CHILD_SESSION: '1',
      CLAUDE_CODE_SESSION_ID: '00000000-0000-4000-8000-000000000000',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_CODE_MESSAGING_TOKEN: 'deadbeef',
      CLAUDE_PID: '4242',
      CLAUDE_CODE_USE_BEDROCK: '1',
    },
  });
  try {
    await createSession(server, {
      cwd: '/tmp',
      command: 'bash',
      // Written under a temporary name and renamed: the redirection creates
      // the file before `env` has written a byte, and the poll below would
      // otherwise read an empty file on a loaded runner (CI run 61).
      args: ['-lc', `env > ${envFile}.tmp && mv ${envFile}.tmp ${envFile}; sleep 30`],
      title: 'env-probe',
      cols: 80,
      rows: 24,
    });
    const env = await waitUntil(
      () => (existsSync(envFile) ? readFileSync(envFile, 'utf8') : undefined),
      'the session to dump its environment',
      15_000,
    );
    const names = env
      .split('\n')
      .map((line) => line.split('=')[0])
      .filter((name): name is string => name !== undefined);
    assert.ok(
      names.includes('AI_SM_DATA_DIR'),
      `the environment really is the backend's (non-vacuity): ${names.filter((n) => n.startsWith('AI_SM_')).join(', ')}`,
    );
    for (const banned of [
      'AI_SM_STANDBY',
      'AI_SM_PORT_HINT',
      'AI_SM_RESTARTED_FROM',
      // Same family: it names the directory a restart renames and deletes the
      // backup of, so a backend launched from inside a session must not inherit
      // the parent's served path.
      'AI_SM_WEB_DIST_DIR',
      'CLAUDECODE',
      'CLAUDE_CODE_CHILD_SESSION',
      'CLAUDE_CODE_SESSION_ID',
      'CLAUDE_CODE_ENTRYPOINT',
      'CLAUDE_CODE_MESSAGING_TOKEN',
      'CLAUDE_PID',
    ]) {
      assert.ok(!names.includes(banned), `${banned} must not reach a session`);
    }
    assert.ok(
      names.includes('CLAUDE_CODE_USE_BEDROCK'),
      'the user\'s own CLAUDE_CODE_* configuration is not a marker and reaches the session',
    );
  } finally {
    await server.stop();
    rmSync(outDir, { recursive: true, force: true });
    web.remove();
  }
});

test('AI_SM_STANDBY set by hand, with no IPC channel, boots NORMALLY instead of waiting forever', async () => {
  // The variable is ours, but it lives in the environment, and an environment
  // is a thing users copy. Without a channel there is nobody to say `go`, so
  // hanging on it would be a backend that never serves and never explains.
  const server = await startTestServer({ env: { AI_SM_STANDBY: '1' } });
  try {
    const health = await fetch(`${server.baseUrl}/health`);
    assert.equal(health.status, 200, 'it is serving');
    const log = await readServerLog(server);
    assert.ok(
      log.includes('AI_SM_STANDBY is set but this process has no IPC channel; starting normally'),
      `and it says exactly why: ${log.split('\n').filter((l) => l.includes('STANDBY')).join(' | ')}`,
    );
  } finally {
    await server.stop();
  }
});
