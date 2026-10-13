/**
 * runtime.json belongs to whoever it names — server/runtime-file.ts (Nocturne
 * D2, bug in memory/BACKLOG.md § From Nocturne C1).
 *
 * How: the pure verdict and the I/O wrapper in-process against a temp dir,
 * then real backend children (helpers.ts `startTestServer`, as
 * discovery.test.ts does) whose runtime.json is overwritten with another
 * backend's identity before they shut down — by SIGTERM and by the idle grace,
 * the path the bug was seen on.
 *
 * Why it matters: an old backend's shutdown deleted a NEWER backend's file, so
 * launcher/launch.ps1 (`Read-RuntimeInfo` → `Start-Backend`) found none and
 * started a second backend. Nothing
 * fails loudly when that regresses — two backends just quietly share a data dir.
 *
 * The uncaughtException path runs end to end too: a module preloaded through
 * NODE_OPTIONS throws from a SIGUSR2 listener inside an unmodified child.
 *
 * NOT claimed: the read-then-unlink window (accepted, see the module header;
 * the unlink's own failure is covered with EACCES, not the racy ENOENT), the
 * uncaughtException guard during a restart handoff or a standby
 * (restart-*.test.ts territory), and the Windows launcher's reaction.
 */
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import fs, {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { removeOwnRuntimeFile, runtimeFileVerdict } from '../../server/runtime-file.ts';
import type { LogLevel } from '../../server/config.ts';
import { SKIP_IF_ROOT, makeTempDirSync, sleep, startTestServer, type TestServer } from '../helpers/helpers.ts';

const SELF = { pid: 4242, startedAt: '2026-10-13T10:00:00.000Z' };
const TOKEN = 'f'.repeat(64);

function runtimeText(pid: number, startedAt: string): string {
  return JSON.stringify({ port: 40000, token: TOKEN, pid, startedAt, appDir: '/home/you/app' }, null, 2) + '\n';
}

function withTempFile(body: (file: string, lines: string[], log: (l: LogLevel, m: string) => void) => void): void {
  const dir = makeTempDirSync('ai-sm-rtfile-');
  const lines: string[] = [];
  try {
    body(join(dir, 'runtime.json'), lines, (level, message) => lines.push(`${level} ${message}`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('verdict: own pid + own startedAt removes; anything else keeps, with a fixed reason', () => {
  assert.deepEqual(runtimeFileVerdict(runtimeText(SELF.pid, SELF.startedAt), SELF), { remove: true });
  assert.deepEqual(runtimeFileVerdict(runtimeText(SELF.pid + 1, SELF.startedAt), SELF), {
    remove: false,
    reason: 'it names another process',
  });
  assert.deepEqual(runtimeFileVerdict(runtimeText(SELF.pid, '2026-10-13T10:00:09.000Z'), SELF), {
    remove: false,
    reason: 'it names another start of this pid',
  });
  for (const bad of ['{', '', 'null', '[]', '"x"', '42']) {
    assert.deepEqual(runtimeFileVerdict(bad, SELF), { remove: false, reason: 'unparsable' }, JSON.stringify(bad));
  }
  assert.deepEqual(runtimeFileVerdict(undefined, SELF), { remove: false, reason: 'unreadable' });
  // A pid as a string is not this pid: strict equality, no coercion.
  assert.equal(runtimeFileVerdict(JSON.stringify({ pid: String(SELF.pid), startedAt: SELF.startedAt }), SELF).remove, false);
  // Before listen this process has no startedAt — so even a file naming its pid
  // with an empty startedAt is not one it wrote.
  assert.equal(runtimeFileVerdict(JSON.stringify({ pid: SELF.pid, startedAt: '' }), { pid: SELF.pid, startedAt: '' }).remove, false);
});

test('removeOwnRuntimeFile: deletes its own file, silently', () => {
  withTempFile((file, lines, log) => {
    writeFileSync(file, runtimeText(SELF.pid, SELF.startedAt));
    removeOwnRuntimeFile(file, SELF, log);
    assert.ok(!existsSync(file), 'own file removed');
    assert.deepEqual(lines, [], 'the normal case logs nothing extra');
  });
});

test('removeOwnRuntimeFile: another pid, or this pid with another startedAt, stays byte-identical', () => {
  for (const [text, reason] of [
    [runtimeText(SELF.pid + 1, SELF.startedAt), 'it names another process'],
    [runtimeText(SELF.pid, '2026-10-13T10:00:09.000Z'), 'it names another start of this pid'],
  ] as const) {
    withTempFile((file, lines, log) => {
      writeFileSync(file, text);
      removeOwnRuntimeFile(file, SELF, log);
      assert.equal(readFileSync(file, 'utf8'), text, 'left exactly as it was');
      assert.deepEqual(lines, [`info runtime.json left in place: ${reason}`]);
      assert.ok(!lines.join('\n').includes(TOKEN), 'never the token');
    });
  }
});

test('removeOwnRuntimeFile: unparsable, a symlink, a directory are left; missing does not throw', () => {
  withTempFile((file, lines, log) => {
    writeFileSync(file, '{"pid": 42');
    removeOwnRuntimeFile(file, SELF, log);
    assert.equal(readFileSync(file, 'utf8'), '{"pid": 42');
    assert.deepEqual(lines, ['info runtime.json left in place: unparsable']);
  });
  withTempFile((file, lines, log) => {
    // A link to a file that WOULD pass: O_NOFOLLOW refuses it, so it is not ours.
    const target = `${file}.target`;
    writeFileSync(target, runtimeText(SELF.pid, SELF.startedAt));
    symlinkSync(target, file);
    removeOwnRuntimeFile(file, SELF, log);
    assert.ok(existsSync(file) && existsSync(target), 'neither the link nor its target removed');
    assert.deepEqual(lines, ['info runtime.json left in place: unreadable']);
  });
  withTempFile((file, lines, log) => {
    mkdirSync(file);
    removeOwnRuntimeFile(file, SELF, log);
    assert.ok(existsSync(file));
    assert.deepEqual(lines, ['info runtime.json left in place: unreadable']);
  });
  withTempFile((file, lines, log) => {
    assert.doesNotThrow(() => removeOwnRuntimeFile(file, SELF, log));
    assert.deepEqual(lines, ['info runtime.json already gone; nothing to remove']);
  });
});

test('verdict: startedAt compares strictly — the same text inside an array is not this start', () => {
  // `!=` would coerce ['<iso>'] to '<iso>' and delete a file this process never wrote.
  assert.deepEqual(runtimeFileVerdict(JSON.stringify({ pid: SELF.pid, startedAt: [SELF.startedAt] }), SELF), {
    remove: false,
    reason: 'it names another start of this pid',
  });
});

test('removeOwnRuntimeFile: the 16 KiB cap — at the cap its own file goes, one byte over it stays unread', () => {
  // An own identity padded to an exact size: only the size decides.
  const sized = (bytes: number): string => {
    const head = JSON.stringify({ pid: SELF.pid, startedAt: SELF.startedAt, pad: '' }).slice(0, -2);
    return head + 'x'.repeat(bytes - head.length - 2) + '"}';
  };
  withTempFile((file, lines, log) => {
    const over = sized(16_385);
    assert.equal(Buffer.byteLength(over), 16_385);
    writeFileSync(file, over);
    removeOwnRuntimeFile(file, SELF, log);
    assert.equal(readFileSync(file, 'utf8'), over, 'over the cap: not read, so not ours to delete');
    assert.deepEqual(lines, ['info runtime.json left in place: unreadable']);
  });
  withTempFile((file, lines, log) => {
    const atCap = sized(16_384);
    assert.equal(Buffer.byteLength(atCap), 16_384);
    writeFileSync(file, atCap);
    removeOwnRuntimeFile(file, SELF, log);
    assert.ok(!existsSync(file), 'the cap itself is allowed: own file removed');
    assert.deepEqual(lines, []);
  });
});

test('removeOwnRuntimeFile: an unlink that fails never throws out of the exit path', { skip: SKIP_IF_ROOT }, () => {
  // Readable but not removable: the parent dir is r-x. The real failure the
  // catch is for is ENOENT in the read→unlink window, which a test cannot
  // time; any unlink error takes the same path, and a throw here would escape
  // shutdown() / the uncaughtException handler before process.exit.
  withTempFile((file, lines, log) => {
    writeFileSync(file, runtimeText(SELF.pid, SELF.startedAt));
    const dir = dirname(file);
    chmodSync(dir, 0o500);
    try {
      assert.doesNotThrow(() => removeOwnRuntimeFile(file, SELF, log));
      assert.ok(existsSync(file), 'the unlink really failed (EACCES)');
      assert.deepEqual(lines, []);
    } finally {
      chmodSync(dir, 0o700);
    }
  });
});

test('removeOwnRuntimeFile: closes every descriptor it opens, on each outcome', () => {
  // config.ts readSmallRegularFile closes in `finally`. A leak is silent on
  // one exit — but the same helper serves last-port.ts at every boot. Counted
  // in one synchronous block: nothing else in this process opens an fd between.
  withTempFile((file, lines, log) => {
    const fds = (): number => readdirSync('/proc/self/fd').length;
    const before = fds();
    for (let i = 0; i < 20; i++) {
      writeFileSync(file, runtimeText(SELF.pid, SELF.startedAt)); // own: removed
      removeOwnRuntimeFile(file, SELF, log);
      writeFileSync(file, runtimeText(SELF.pid + 1, SELF.startedAt)); // another: kept
      removeOwnRuntimeFile(file, SELF, log);
      writeFileSync(file, 'x'.repeat(5000)); // oversize: refused after fstat
      removeOwnRuntimeFile(file, SELF, log);
      rmSync(file);
      mkdirSync(file); // a directory: refused after fstat
      removeOwnRuntimeFile(file, SELF, log);
      rmSync(file, { recursive: true });
    }
    assert.equal(fds(), before, 'open descriptors after 80 calls equal those before');
    assert.equal(lines.length, 60, 'three kept outcomes per round');
  });
});

test('removeOwnRuntimeFile: a read that fails after the open is kept as unreadable, never a throw', () => {
  // EIO on read(2) cannot be produced on demand, so node:fs readSync is mocked
  // (tests/README.md § Mocks); syncBuiltinESMExports makes config.ts's named
  // import see the mock, and again the original afterwards.
  withTempFile((file, lines, log) => {
    writeFileSync(file, runtimeText(SELF.pid, SELF.startedAt));
    const eio = mock.method(fs, 'readSync', () => {
      throw Object.assign(new Error('EIO: i/o error, read'), { code: 'EIO' });
    });
    syncBuiltinESMExports();
    try {
      assert.doesNotThrow(() => removeOwnRuntimeFile(file, SELF, log));
      assert.ok(eio.mock.callCount() > 0, 'the mocked read was reached');
    } finally {
      eio.mock.restore();
      syncBuiltinESMExports();
    }
    assert.equal(readFileSync(file, 'utf8'), runtimeText(SELF.pid, SELF.startedAt), 'not read, so not removed');
    assert.deepEqual(lines, ['info runtime.json left in place: unreadable']);
  });
});

/** Overwrite the child's runtime.json as a newer backend B would; return B's text. */
async function impersonateNewerBackend(server: TestServer): Promise<string> {
  const text = JSON.stringify(
    { ...server.runtime, pid: (server.child.pid as number) + 1, startedAt: new Date().toISOString() },
    null,
    2,
  ) + '\n';
  await writeFile(server.runtimeFile, text, { mode: 0o600 });
  return text;
}

async function awaitExit(server: TestServer, ms: number, code = 0): Promise<void> {
  const exit = await Promise.race([server.exit, sleep(ms).then(() => undefined)]);
  assert.ok(exit !== undefined, `server did not exit within ${ms}ms`);
  assert.equal(exit.code, code, `expected exit ${code} (got code=${exit.code} signal=${exit.signal})`);
}

test('real backend, SIGTERM: a runtime.json naming a newer backend survives byte-identical', async () => {
  const server = await startTestServer();
  try {
    const newer = await impersonateNewerBackend(server);
    server.child.kill('SIGTERM');
    await awaitExit(server, 10_000);
    assert.equal(await readFile(server.runtimeFile, 'utf8'), newer, 'the newer backend keeps its discovery file');
    const log = await readFile(join(server.dataDir, 'server.log'), 'utf8');
    assert.ok(log.includes('runtime.json left in place: it names another process'), 'the reason is logged');
    assert.ok(!log.includes(server.token), 'never the token');
  } finally {
    await server.stop();
  }
});

test('real backend, idle grace: the observed bug path leaves a newer backend\'s file alone', async () => {
  // The bug: idle shutdown 9 s after a new backend wrote runtime.json.
  const server = await startTestServer({ env: { AI_SM_STARTUP_GRACE_MS: '3000' } });
  try {
    const newer = await impersonateNewerBackend(server);
    await awaitExit(server, 15_000);
    assert.equal(await readFile(server.runtimeFile, 'utf8'), newer);
  } finally {
    await server.stop();
  }
});

test('real backend, SIGTERM: its own runtime.json is still removed', async () => {
  const server = await startTestServer();
  try {
    server.child.kill('SIGTERM');
    await awaitExit(server, 10_000);
    assert.ok(!existsSync(server.runtimeFile), 'own file removed');
    const log = await readFile(join(server.dataDir, 'server.log'), 'utf8');
    assert.ok(!log.includes('runtime.json left in place'), 'no keep line on the normal path');
  } finally {
    await server.stop();
  }
});

/**
 * A real uncaughtException inside an unmodified backend child: a module
 * preloaded through NODE_OPTIONS turns SIGUSR2 into a throw. A signal listener
 * runs from the event loop, so its throw reaches server/index.ts's
 * process.on('uncaughtException') — no test seam in the server needed.
 */
function throwOnSigusr2Env(): Record<string, string> {
  const preload = `data:text/javascript,${encodeURIComponent(
    "process.on('SIGUSR2', () => { throw new Error('d2 test throw'); });",
  )}`;
  return { NODE_OPTIONS: `${process.env['NODE_OPTIONS'] ?? ''} --import=${preload}`.trim() };
}

test('real backend, uncaughtException: a runtime.json naming a newer backend survives byte-identical', async () => {
  const server = await startTestServer({ env: throwOnSigusr2Env() });
  try {
    const newer = await impersonateNewerBackend(server);
    server.child.kill('SIGUSR2');
    await awaitExit(server, 10_000, 1);
    assert.equal(await readFile(server.runtimeFile, 'utf8'), newer, 'the newer backend keeps its discovery file');
    const log = await readFile(join(server.dataDir, 'server.log'), 'utf8');
    assert.ok(log.includes('uncaught exception: Error: d2 test throw'), 'the crash path really ran');
    assert.ok(log.includes('runtime.json left in place: it names another process'), 'the reason is logged');
    assert.ok(!log.includes(server.token), 'never the token');
  } finally {
    await server.stop();
  }
});

test('real backend, uncaughtException: its own runtime.json is still removed', async () => {
  const server = await startTestServer({ env: throwOnSigusr2Env() });
  try {
    server.child.kill('SIGUSR2');
    await awaitExit(server, 10_000, 1);
    assert.ok(!existsSync(server.runtimeFile), 'own file removed');
    const log = await readFile(join(server.dataDir, 'server.log'), 'utf8');
    assert.ok(log.includes('uncaught exception: Error: d2 test throw'), 'the crash path really ran');
    assert.ok(!log.includes('runtime.json left in place'), 'no keep line on the normal path');
  } finally {
    await server.stop();
  }
});
