/**
 * The STICKY PORT (decision D5, 2026-09-22, `.claude/plans/nocturne/PLAN-B6.md`
 * § Phase 3): the backend remembers the port it bound in
 * `<dataDir>/last-port.json` and tries it first on the next start, so the
 * frontend's localStorage — scoped to the origin INCLUDING the port — still
 * holds the saved tab layout. Auto-pick became the fallback.
 *
 * Two layers:
 *   1. the pure module (server/last-port.ts) — the read gate table, the
 *      write/read round trip on disk (0600, atomic, never throws), and the
 *      precedence of the port tried first;
 *   2. four REAL boots of `server/index.ts` on one scratch data dir — the
 *      file is written with the port actually bound, the next boot takes it
 *      back, a boot whose remembered port is occupied says so and auto-picks
 *      WITHOUT forgetting the remembered port, and the boot after that (the
 *      squatter gone) lands on it again.
 *
 * SAFETY: every process here is one this file started, on a temp data dir.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import {
  closeSync,
  constants as fsConstants,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Logger } from '../server/config.ts';
import {
  choosePortHint,
  isUserPort,
  readLastPort,
  writeLastPort,
} from '../server/last-port.ts';
import { readServerLog, startTestServer } from './helpers.ts';

/** A logger that keeps every line, so a test can assert what was said — once. */
function capture(): { log: Logger; lines: string[] } {
  const lines: string[] = [];
  return { log: (level, message) => lines.push(`${level}: ${message}`), lines };
}

function scratchDir(): string {
  return mkdtempSync(join(tmpdir(), 'ai-sm-lastport-'));
}

/** What a child process answered — or that it had to be killed for blocking. */
type ChildRead = {
  blocked: boolean;
  result: { value: number | null; lines: string[] } | null;
  output: string;
};

/**
 * readLastPort in a CHILD process, with a hard 10 s kill. A synchronous open
 * that blocks (a FIFO without O_NONBLOCK) cannot be interrupted from inside the
 * process doing it — not by a timer, not by node:test's --test-timeout — so the
 * only bounded way to assert "this never blocks" is to make it someone else's
 * thread and kill it.
 */
function readLastPortInChild(dir: string, file: string): ChildRead {
  const helper = join(dir, 'read-in-child.mjs');
  const moduleUrl = pathToFileURL(
    join(import.meta.dirname, '..', 'server', 'last-port.ts'),
  ).href;
  writeFileSync(
    helper,
    `import { readLastPort } from ${JSON.stringify(moduleUrl)};\n` +
      'const lines = [];\n' +
      'const value = readLastPort(process.argv[2], (level, message) =>\n' +
      "  lines.push(level + ': ' + message),\n" +
      ');\n' +
      'process.stdout.write(JSON.stringify({ value, lines }));\n',
  );
  const res = spawnSync(process.execPath, [helper, file], { timeout: 10_000, encoding: 'utf8' });
  const output = `status=${String(res.status)} signal=${String(res.signal)} ${res.stdout ?? ''}${res.stderr ?? ''}`;
  if (res.signal !== null || res.status !== 0) return { blocked: true, result: null, output };
  return {
    blocked: false,
    result: JSON.parse(res.stdout) as { value: number | null; lines: string[] },
    output,
  };
}

/** MAX_LAST_PORT_BYTES in server/last-port.ts — the read gate's byte cap. */
const MAX = 1024;

// ---------------------------------------------------------------------------
// 1. The pure module
// ---------------------------------------------------------------------------

test('isUserPort: integers 1024-65535 only — not 0, not 80, not 70000, not 3000.5', () => {
  assert.equal(isUserPort(1024), true);
  assert.equal(isUserPort(65_535), true);
  assert.equal(isUserPort(41_000), true);
  assert.equal(isUserPort(1023), false);
  assert.equal(isUserPort(80), false);
  assert.equal(isUserPort(0), false, '0 is the ABSENCE of a hint, never a port');
  assert.equal(isUserPort(-1), false);
  assert.equal(isUserPort(65_536), false);
  assert.equal(isUserPort(70_000), false);
  assert.equal(isUserPort(3000.5), false);
  assert.equal(isUserPort(Number.NaN), false);
  assert.equal(isUserPort('3000'), false);
  assert.equal(isUserPort(null), false);
  assert.equal(isUserPort(undefined), false);
});

test('readLastPort gate: only a JSON object with an integer port 1024-65535 is believed', () => {
  const dir = scratchDir();
  try {
    const file = join(dir, 'last-port.json');

    // A MISSING file is the normal first run: null, and NOTHING is logged.
    const first = capture();
    assert.equal(readLastPort(file, first.log), null);
    assert.deepEqual(first.lines, [], 'a first run must not complain about a file it never wrote');

    const refused: [string, string][] = [
      ['not json at all {{{', 'garbage'],
      ['[41000]', 'an array'],
      ['null', 'JSON null'],
      ['41000', 'a bare number'],
      ['"41000"', 'a bare string'],
      ['{}', 'no port key'],
      ['{"port":"41000"}', 'a string port'],
      ['{"port":3000.5}', 'a non-integer port'],
      ['{"port":80}', 'a privileged port'],
      ['{"port":1023}', 'one below the floor'],
      ['{"port":70000}', 'above 65535'],
      ['{"port":0}', 'zero'],
      ['{"port":null}', 'a null port'],
      [`{"port":41000,"pad":"${'x'.repeat(2000)}"}`, 'an oversized file'],
    ];
    for (const [contents, what] of refused) {
      writeFileSync(file, contents);
      const cap = capture();
      assert.equal(readLastPort(file, cap.log), null, `${what} must be ignored`);
      assert.deepEqual(
        cap.lines,
        ['debug: last port file unreadable, auto-picking'],
        `${what}: exactly one debug line, never a throw`,
      );
    }

    for (const ok of [1024, 41_000, 65_535]) {
      writeFileSync(file, JSON.stringify({ port: ok }));
      const cap = capture();
      assert.equal(readLastPort(file, cap.log), ok);
      assert.deepEqual(cap.lines, [], `${ok} is a good port: nothing to say`);
    }

    // Extra fields alongside a good port do not spoil it (forward compatible).
    writeFileSync(file, JSON.stringify({ port: 41_001, note: 'hello' }));
    assert.equal(readLastPort(file, capture().log), 41_001);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The file lives in the data dir, which any process running as this user can
 * write — so the READ is gated on the fd (O_NOFOLLOW | O_NONBLOCK + fstat),
 * not on the path. A plain readFileSync here HUNG THE BOOT before `listen`
 * (measured, 2026-09-22): memory/knowledge/fifo-open-blocks-main-thread.md.
 */
test('readLastPort refuses a FIFO, a symlink, a directory and an oversize file', () => {
  const dir = scratchDir();
  const refusal = ['debug: last port file unreadable, auto-picking'];
  try {
    const file = join(dir, 'last-port.json');

    // A NAMED PIPE: without O_NONBLOCK this open blocks until some process
    // opens the write end — forever, on the boot's main thread, before the
    // listener exists.
    //
    // THE CHECK RUNS IN A CHILD PROCESS on purpose. readLastPort is
    // SYNCHRONOUS, so a blocking open freezes this process's event loop as
    // well: an in-process `Promise.race` timer can never fire, and node:test's
    // own --test-timeout cannot cut it either (measured 2026-09-22 against an
    // O_NONBLOCK-less build: `node --test --test-timeout=15000` ran until an
    // external `timeout 180` killed it — `npm test` would hang CI). spawnSync's
    // timeout CAN kill a blocked child, so a regression fails here in bounded
    // time instead of hanging the suite.
    execFileSync('mkfifo', [file]);
    const fifo = readLastPortInChild(dir, file);
    assert.equal(
      fifo.blocked,
      false,
      `a FIFO must be refused at once, never block the open: ${fifo.output}`,
    );
    assert.deepEqual(fifo.result, { value: null, lines: refusal }, 'one debug line, no hang');
    rmSync(file);

    // A FIFO THAT ALREADY HOLDS A PERFECTLY GOOD PAYLOAD: a writer fd keeps the
    // bytes buffered, so nothing here can block — and the answer is still "no
    // last port". Today fstat refuses the pipe before any read; this pins the
    // OUTCOME, so a later rewrite of the read cannot start believing a pipe
    // someone planted in the data dir.
    execFileSync('mkfifo', [file]);
    const writer = openSync(file, fsConstants.O_RDWR | fsConstants.O_NONBLOCK);
    try {
      writeSync(writer, JSON.stringify({ port: 41_000 }) + '\n');
      const planted = capture();
      assert.equal(readLastPort(file, planted.log), null, 'a planted pipe is never a port file');
      assert.deepEqual(planted.lines, refusal);
    } finally {
      closeSync(writer);
    }
    rmSync(file);

    // A SYMLINK, even one pointing at a perfectly good port file: this process
    // wrote last-port.json itself, so a link standing there is not ours
    // (O_NOFOLLOW answers ELOOP).
    const real = join(dir, 'planted.json');
    writeFileSync(real, JSON.stringify({ port: 41_000 }) + '\n');
    symlinkSync(real, file);
    const link = capture();
    assert.equal(readLastPort(file, link.log), null, 'a link is never followed');
    assert.deepEqual(link.lines, refusal);
    rmSync(file);

    // A DIRECTORY opens fine under O_RDONLY|O_NOFOLLOW|O_NONBLOCK on Linux;
    // fstat is what refuses it, before the first read.
    mkdirSync(file);
    const asDir = capture();
    assert.equal(readLastPort(file, asDir.log), null);
    assert.deepEqual(asDir.lines, refusal);
    rmSync(file, { recursive: true });

    // ONE BYTE over the cap, refused on fstat().size — nothing is read at all.
    const head = '{"port":41000,"pad":"';
    const oversize = head + 'x'.repeat(MAX + 1 - head.length - 2) + '"}';
    assert.equal(Buffer.byteLength(oversize), MAX + 1);
    writeFileSync(file, oversize);
    const big = capture();
    assert.equal(readLastPort(file, big.log), null, '1025 bytes is over the 1024 cap');
    assert.deepEqual(big.lines, refusal);
    assert.equal(statSync(file).size, MAX + 1, 'the size is what refused it');

    // Exactly the cap, and still a good port: read normally.
    const atCap = head + 'x'.repeat(MAX - head.length - 2) + '"}';
    assert.equal(Buffer.byteLength(atCap), MAX);
    writeFileSync(file, atCap);
    const edge = capture();
    assert.equal(readLastPort(file, edge.log), 41_000, 'the cap itself is allowed');
    assert.deepEqual(edge.lines, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeLastPort: round trip, mode 0600, atomic (no .tmp left), never throws', () => {
  const dir = scratchDir();
  try {
    const file = join(dir, 'last-port.json');
    const cap = capture();
    writeLastPort(file, 41_234, cap.log);
    assert.deepEqual(cap.lines, [], 'a good write says nothing');
    assert.equal(readFileSync(file, 'utf8'), '{"port":41234}\n');
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(
      readdirSync(dir).filter((n) => n.endsWith('.tmp')),
      [],
      'the atomic write leaves no temp file behind',
    );
    assert.equal(readLastPort(file, capture().log), 41_234);

    // Rewritten by the next run, in place.
    writeLastPort(file, 41_235, capture().log);
    assert.equal(readLastPort(file, capture().log), 41_235);

    // A port the read gate would refuse is not remembered at all.
    const bad = capture();
    writeLastPort(file, 80, bad.log);
    assert.deepEqual(bad.lines, [
      'debug: port 80 is outside 1024-65535, not remembered as the last port',
    ]);
    assert.equal(readLastPort(file, capture().log), 41_235, 'the old value survives');

    // An impossible destination is ONE warn line, never a thrown boot.
    const failed = capture();
    writeLastPort(join(dir, 'no-such-dir', 'last-port.json'), 41_236, failed.log);
    assert.equal(failed.lines.length, 1, `expected one line, got ${failed.lines.join(' | ')}`);
    assert.match(failed.lines[0] as string, /^warn: failed to write .*last-port\.json: /);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('choosePortHint: a handoff hint wins over the file, the file wins over auto-pick', () => {
  assert.deepEqual(choosePortHint(41_000, 42_000), { port: 41_000, source: 'handoff' });
  assert.deepEqual(choosePortHint(41_000, null), { port: 41_000, source: 'handoff' });
  assert.deepEqual(choosePortHint(0, 42_000), { port: 42_000, source: 'last' });
  assert.deepEqual(choosePortHint(0, null), { port: 0, source: 'none' });
});

test('server/index.ts really consults the module (source-shape pin)', () => {
  const src = readFileSync(join(import.meta.dirname, '..', 'server', 'index.ts'), 'utf8');
  assert.match(src, /from '\.\/last-port\.ts'/);
  assert.match(src, /readLastPort\(paths\.lastPortFile, boot\)/);
  assert.match(src, /writeLastPort\(paths\.lastPortFile, port, boot\)/);
  assert.match(src, /choosePortHint\(envPortHint, lastPort\)/);
  assert.match(src, /server\.listen\(portHint, '127\.0\.0\.1'\)/);
});

/**
 * A SHAPE PIN, deliberately, for the two things disk behaviour cannot show:
 *
 *   - the read has TWO caps (fstat before the read, and the read itself
 *     bounded). On a regular file whichever runs first hides the other, so a
 *     black-box test cannot tell a missing cap from a redundant one — and the
 *     fstat one is the only cap that protects the cases that never reach a
 *     read (a pipe, a directory, a device: file-read hygiene, boot code,
 *     memory/knowledge/fifo-open-blocks-main-thread.md);
 *   - the write is ATOMIC. A direct writeFileSync leaves the exact same bytes
 *     with the exact same mode, and only a reader catching the half-written
 *     file ever notices the difference.
 *
 * Measured 2026-09-22: mutants that dropped `!stat.isFile()`, the size gate,
 * the post-read cap or `atomicWriteFile` all left tests/last-port.test.ts
 * green until this pin existed.
 */
test('server/last-port.ts keeps both read caps and the atomic write (shape pin)', () => {
  const src = readFileSync(join(import.meta.dirname, '..', 'server', 'last-port.ts'), 'utf8');
  assert.match(src, /fsConstants\.O_RDONLY \| fsConstants\.O_NOFOLLOW \| fsConstants\.O_NONBLOCK/);
  assert.match(src, /if \(!stat\.isFile\(\) \|\| stat\.size > MAX_LAST_PORT_BYTES\)/);
  assert.match(src, /if \(read > MAX_LAST_PORT_BYTES\)/);
  assert.match(src, /atomicWriteFile\(file, JSON\.stringify\(\{ port \}\)/);
  assert.doesNotMatch(src, /\bwriteFileSync\(/, 'the write goes through atomicWriteFile only');
});

// ---------------------------------------------------------------------------
// 2. Real boots on one scratch data dir
// ---------------------------------------------------------------------------

test('a real backend writes the bound port, takes it back, and keeps it when busy', async () => {
  const root = scratchDir();
  const dataDir = join(root, 'data');
  const lastPortFile = join(dataDir, 'last-port.json');
  try {
    // Boot 1: nothing remembered yet, so the OS picks — and that port is
    // written with mode 0600.
    // Every boot below stops in a `finally`: a backend this file spawned and
    // never stopped keeps the test process's event loop alive, so a failing
    // assertion would hang the whole file until --test-timeout instead of
    // failing in milliseconds (measured 2026-09-22 on a mode-mutant).
    const first = await startTestServer({ dataDir });
    const firstPort = first.port;
    try {
      const firstLog = await readServerLog(first);
      assert.deepEqual(JSON.parse(readFileSync(lastPortFile, 'utf8')), { port: firstPort });
      assert.equal(statSync(lastPortFile).mode & 0o777, 0o600);
      assert.ok(
        !firstLog.includes('listening on the last port'),
        'a first run has no last port to name',
      );
    } finally {
      await first.stop();
    }

    // Boot 2: the remembered port is free, so the origin survives a restart of
    // the whole app — which is the entire point of D5.
    const second = await startTestServer({ dataDir });
    try {
      const secondLog = await readServerLog(second);
      assert.equal(second.port, firstPort, 'the same data dir must come back on the same port');
      assert.ok(
        secondLog.includes(`listening on the last port ${firstPort}`),
        `the sticky port is one explicit line: ${secondLog}`,
      );
      assert.deepEqual(JSON.parse(readFileSync(lastPortFile, 'utf8')), { port: firstPort });
    } finally {
      await second.stop();
    }

    // Boot 3: someone else holds that port now — fall back, say so, and KEEP
    // the remembered port. The squatter is typically another process's
    // outgoing connection borrowing the number as its ephemeral source port
    // for a few seconds; overwriting the file would move the origin for good
    // and orphan the layout the sticky port exists to keep.
    const squatter = createNetServer();
    await new Promise<void>((resolve) => squatter.listen(firstPort, '127.0.0.1', resolve));
    let third: Awaited<ReturnType<typeof startTestServer>> | undefined;
    try {
      third = await startTestServer({ dataDir });
      assert.notEqual(third.port, firstPort, 'it must not have stolen the busy port');
      const thirdLog = await readServerLog(third);
      assert.ok(
        thirdLog.includes(
          `last port ${firstPort} busy, auto-picked ${third.port}, keeping ${firstPort} for next time`,
        ),
        `the fallback names both ports and what it keeps: ${thirdLog.split('\n').filter((l) => l.includes('port')).join(' | ')}`,
      );
      assert.equal((await fetch(`${third.baseUrl}/health`)).status, 200);
      assert.deepEqual(
        JSON.parse(readFileSync(lastPortFile, 'utf8')),
        { port: firstPort },
        'a fallback is for this run only: the remembered port stays',
      );
    } finally {
      if (third !== undefined) await third.stop();
      await new Promise<void>((resolve) => squatter.close(() => resolve()));
    }

    // Boot 4: the squatter is gone, so the original origin comes back — which
    // is what the write-back skip above buys.
    const fourth = await startTestServer({ dataDir });
    try {
      assert.equal(fourth.port, firstPort, 'the remembered port survived the busy run');
      assert.ok(
        (await readServerLog(fourth)).includes(`listening on the last port ${firstPort}`),
        'and it is taken as the last port again',
      );
    } finally {
      await fourth.stop();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AI_SM_PORT_HINT still wins over the remembered port, and keeps its own wording', async () => {
  const root = scratchDir();
  const dataDir = join(root, 'data');
  try {
    // Two free ports: one remembered in the file, one handed over as the hint.
    const ports: number[] = [];
    for (let i = 0; i < 2; i++) {
      const probe = createNetServer();
      await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
      ports.push((probe.address() as { port: number }).port);
      await new Promise<void>((resolve) => probe.close(() => resolve()));
    }
    const [hintPort, stale] = ports as [number, number];
    assert.notEqual(hintPort, stale);
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dataDir, 'last-port.json'), JSON.stringify({ port: stale }) + '\n');

    const server = await startTestServer({
      dataDir,
      env: { AI_SM_PORT_HINT: String(hintPort) },
    });
    try {
      assert.equal(server.port, hintPort, 'the handoff hint outranks the remembered port');
      assert.notEqual(server.port, stale);
      const log = await readServerLog(server);
      assert.ok(
        log.includes(
          `port hint ${hintPort} taken (a hint on a restart handoff — the port is auto-picked otherwise)`,
        ),
        `the handoff keeps its own sentence: ${log}`,
      );
      assert.ok(!log.includes('last port'), 'and never calls itself the last port');
      // The child of a handoff remembers the port too: the next plain start
      // lands on the same origin.
      assert.deepEqual(JSON.parse(readFileSync(join(dataDir, 'last-port.json'), 'utf8')), {
        port: hintPort,
      });
    } finally {
      await server.stop();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * A BUSY HANDOFF HINT is the other half of the fallback rule: that window's
 * origin is lost the moment the port is taken, so — unlike a busy REMEMBERED
 * port — the auto-picked port IS written back, and the next plain start lands
 * on it. Its warn line is the handoff wording, with nothing about "keeping".
 */
test('a busy handoff hint auto-picks and REMEMBERS the auto-picked port', async () => {
  const root = scratchDir();
  const dataDir = join(root, 'data');
  const squatter = createNetServer();
  await new Promise<void>((resolve) => squatter.listen(0, '127.0.0.1', resolve));
  const busy = (squatter.address() as { port: number }).port;
  try {
    const server = await startTestServer({ dataDir, env: { AI_SM_PORT_HINT: String(busy) } });
    try {
      assert.notEqual(server.port, busy, 'the hinted port is taken, so it must auto-pick');
      const log = await readServerLog(server);
      assert.ok(
        log.includes(`port hint ${busy} busy, auto-picked ${server.port}`),
        `the handoff fallback keeps its own sentence: ${log}`,
      );
      assert.ok(!log.includes('keeping'), 'nothing is kept: the handoff origin is gone either way');
      assert.deepEqual(
        JSON.parse(readFileSync(join(dataDir, 'last-port.json'), 'utf8')),
        { port: server.port },
        'the port really bound is remembered, so the next plain start reuses it',
      );
    } finally {
      await server.stop();
    }
  } finally {
    await new Promise<void>((resolve) => squatter.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * With a handoff hint the last-port file is not read AT ALL — a restart must
 * never complain about a file it would ignore. A corrupt file is the only way
 * to see the difference: reading one costs exactly one debug line, so the
 * absence of that line is the proof that no read happened.
 */
test('a handoff hint does not read the last-port file: a corrupt one stays silent', async () => {
  const root = scratchDir();
  const dataDir = join(root, 'data');
  const probe = createNetServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const hintPort = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  try {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dataDir, 'last-port.json'), 'not json at all {{{');

    const server = await startTestServer({ dataDir, env: { AI_SM_PORT_HINT: String(hintPort) } });
    try {
      assert.equal(server.port, hintPort);
      const log = await readServerLog(server);
      assert.ok(
        !log.includes('last port file unreadable'),
        `the file must not be read behind a handoff hint: ${log}`,
      );
      // And the boot still leaves a usable file behind for the next start.
      assert.deepEqual(JSON.parse(readFileSync(join(dataDir, 'last-port.json'), 'utf8')), {
        port: hintPort,
      });
    } finally {
      await server.stop();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
