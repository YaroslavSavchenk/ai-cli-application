/**
 * The PTY layer of Nocturne D9 P1 (`.claude/plans/nocturne/PLAN-D9.md`
 * § Phases): `server/pty-table.ts` behind `server/pty-host-api.ts`'s
 * in-process `PtyHost` — the ring's ABSOLUTE byte offsets (a wrap changes what
 * the ring holds, never where the stream stands), the snapshot after a wrap,
 * the output events' offsets, the exit record, the metadata blob's 16 KiB cap
 * and `forget`.
 *
 * How: `RingBuffer` called directly for the pure offset rules (and D9 P3's
 * `restore`); the in-process
 * host over a real PTY (`bash -c …`) for the events and the snapshot — the
 * offsets are only worth something if they agree with what node-pty really
 * delivered.
 *
 * Why it matters: P3 re-attaches a restarted backend by comparing its mirror's
 * `endOffset` with the pty-host's. An offset that restarts at the wrap, or a
 * chunk counted in characters instead of UTF-8 bytes, would replay output
 * twice or drop it — silently.
 *
 * Also pinned (added by the D9 P1 mutation probe): the ring's inclusive cap and
 * its trim count, the spawn's cwd, size and terminal type, a taken id refused,
 * and what `list()` reports (pid, size after a resize, exit record).
 * PLAN-QUALITY Q12: the ring's head index and its compaction against a
 * plain-array model, and a trimmed chunk released at once (a forced GC).
 *
 * NOT claimed: the kill ladder and `shutdownAll` (`pty-table-kill.test.ts`,
 * and through SessionManager `sessions-kill*.test.ts`); the final-output
 * rescue (`pty-table-rescue.test.ts`, `sessions-tail.test.ts`); a pty-host
 * process and its wire (P2).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RingBuffer, SCROLLBACK_MAX_BYTES, type PtyExitRecord } from '../../server/pty-table.ts';
import { createInProcessPtyHost, type PtyHost } from '../../server/pty-host-api.ts';
import { realpath } from 'node:fs/promises';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { waitUntil, makeTempDir, removeTempDir, nextImmediate } from '../helpers/helpers.ts';

// The released-chunk test forces a full GC; `gc` exists in a context created
// after this flag is set (node:test runs each file in its own process).
setFlagsFromString('--expose-gc');

/** The metadata cap of server/pty-table.ts (D9 § Defaults: ≤ 16 KiB). */
const META_CAP = 16 * 1024;

interface Recorder {
  host: PtyHost;
  chunks: { id: string; data: string; offset: number }[];
  exits: Map<string, PtyExitRecord>;
}

function recorder(): Recorder {
  const host = createInProcessPtyHost(() => {});
  const chunks: Recorder['chunks'] = [];
  const exits = new Map<string, PtyExitRecord>();
  host.listen({
    output: (id, data, offset) => chunks.push({ id, data, offset }),
    exit: (id, record) => exits.set(id, record),
  });
  return { host, chunks, exits };
}

/** This process's environment with the unset entries dropped — what a PTY takes. */
const ENV: Record<string, string> = Object.fromEntries(
  Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
);

let nextId = 0;
async function spawnBash(r: Recorder, script: string): Promise<string> {
  nextId += 1;
  const id = `pty-table-test-${process.pid}-${nextId}`;
  await r.host.spawn({
    id,
    file: 'bash',
    argv: ['-c', script],
    cwd: process.cwd(),
    env: ENV,
    cols: 80,
    rows: 24,
  });
  return id;
}

function exitOf(r: Recorder, id: string): Promise<PtyExitRecord> {
  return waitUntil(() => r.exits.get(id), `pty ${id} to exit`, 15_000, 20);
}

test('a ring that wraps keeps endOffset absolute: every byte ever appended, trimmed ones included', () => {
  const trims: number[] = [];
  const ring = new RingBuffer(10, (n) => trims.push(n));
  ring.append(Buffer.from('abcd'));
  ring.append(Buffer.from('efgh'));
  assert.equal(ring.endOffset, 8, 'no wrap yet');
  ring.append(Buffer.from('ijkl'));
  assert.equal(ring.byteLength, 8, 'the oldest chunk went');
  assert.deepEqual(trims, [4]);
  assert.equal(ring.endOffset, 12, 'the end does not move back at the wrap');
  assert.equal(ring.toBuffer().toString(), 'efghijkl');
});

test('one chunk bigger than the whole ring still counts in full toward endOffset', () => {
  const ring = new RingBuffer(4);
  ring.append(Buffer.from('ab'));
  ring.append(Buffer.from('0123456789'));
  assert.equal(ring.toBuffer().toString(), '6789', 'only the tail is kept');
  assert.equal(ring.endOffset, 12);
});

test('a ring trimming thousands of tiny chunks keeps exactly the newest ones, across its compactions (Q12)', () => {
  // PLAN-QUALITY Q12: trimming advances a head index and cuts the dead prefix
  // off once it is the larger half (1024+ chunks), instead of shift() per
  // drop. A plain array model is the oracle at every step, so a compaction
  // that lost, kept or reordered a chunk shows up where it happened.
  const cap = 100;
  const trims: number[] = [];
  const ring = new RingBuffer(cap, (n) => trims.push(n));
  const model: Buffer[] = [];
  let dropped = 0;
  for (let i = 0; i < 20_000; i++) {
    const chunk = Buffer.from(`${i % 10}${i % 7 === 0 ? 'é' : ''}`, 'utf8');
    ring.append(chunk);
    model.push(chunk);
    let bytes = model.reduce((n, c) => n + c.byteLength, 0);
    while (bytes > cap && model.length > 1) {
      const gone = model.shift() as Buffer;
      bytes -= gone.byteLength;
      dropped += gone.byteLength;
    }
    if (i % 997 === 0 || i > 19_990) {
      const want = Buffer.concat(model);
      assert.deepEqual(ring.toBuffer(), want, `after append ${i}: the newest bytes, in order`);
      assert.equal(ring.byteLength, want.byteLength, `after append ${i}: the count`);
      assert.deepEqual(ring.head(5), want.subarray(0, 5), `after append ${i}: head reads the oldest live chunk`);
      assert.deepEqual([...ring.chunksNewestFirst()], [...model].reverse(), `after append ${i}: the live chunks, newest first`);
    }
  }
  assert.equal(trims.reduce((n, t) => n + t, 0), dropped, 'every dropped byte was reported, once');
  assert.equal(ring.endOffset, dropped + ring.byteLength, 'the end stays absolute through every compaction');
});

test('a chunk the ring trimmed is released at once, not held until a compaction (Q12 review)', async () => {
  // The head index leaves dead slots behind until #compact (1024+ of them):
  // a slot still pointing at its trimmed chunk keeps up to ~4 MiB per 1 MiB
  // ring alive. A WeakRef per chunk and a forced full GC show what the ring
  // still holds — only the live chunks may survive. 100 trims stay under the
  // compaction threshold, so nothing but the trim itself can release them.
  const gc = runInNewContext('gc') as () => void;
  const ring = new RingBuffer(64);
  const refs: WeakRef<Buffer>[] = [];
  for (let i = 0; i < 100; i++) {
    const chunk = Buffer.alloc(16, i);
    refs.push(new WeakRef(chunk));
    ring.append(chunk);
  }
  await nextImmediate(); // a WeakRef keeps its target alive until the job ends
  gc();
  const alive = refs.filter((r) => r.deref() !== undefined).length;
  assert.equal(ring.byteLength, 64, 'the ring holds its four newest 16-byte chunks');
  assert.ok(alive <= 4, `only the four live chunks may survive a GC, ${alive} did`);
});

test('an oversized chunk after many trims empties the ring and keeps only its own tail (Q12)', () => {
  const trims: number[] = [];
  const ring = new RingBuffer(8, (n) => trims.push(n));
  for (let i = 0; i < 3000; i++) ring.append(Buffer.from(String(i % 10)));
  trims.length = 0;
  ring.append(Buffer.from('0123456789AB'));
  assert.equal(ring.toBuffer().toString(), '456789AB');
  assert.deepEqual([...ring.chunksNewestFirst()].map((c) => c.toString()), ['456789AB'], 'one chunk left, the dead ones gone');
  assert.deepEqual(trims, [8 + 4], 'the 8 held bytes plus the 4 the chunk lost');
  ring.append(Buffer.from('C'));
  assert.equal(ring.toBuffer().toString(), 'C', 'the next append drops the big chunk whole, as ever');
});

test('endOffset counts UTF-8 bytes, not characters', () => {
  const ring = new RingBuffer(64);
  ring.append(Buffer.from('✳ é'));
  assert.equal(ring.endOffset, Buffer.byteLength('✳ é'), '3 + 1 + 2 bytes');
  assert.equal(ring.endOffset, 6);
});

/** Five short lines with a multi-byte glyph each, to the exit; what the recorder saw of them. */
async function fiveLines(r: Recorder): Promise<{ id: string; record: PtyExitRecord; mine: Recorder['chunks'] }> {
  const id = await spawnBash(r, "for i in 1 2 3 4 5; do printf 'line %s ✳\\n' $i; done");
  const record = await exitOf(r, id);
  const mine = r.chunks.filter((c) => c.id === id);
  assert.ok(mine.length > 0, 'output arrived');
  return { id, record, mine };
}

test('restore seeds an empty ring with the newest bytes up to its cap, at the given end; a used ring refuses (D9 P3)', () => {
  const ring = new RingBuffer(4);
  ring.restore(Buffer.from('abcdef'), 1006);
  assert.deepEqual([ring.toBuffer().toString(), ring.byteLength, ring.endOffset], ['cdef', 4, 1006]);
  ring.append(Buffer.from('g'));
  assert.deepEqual([ring.toBuffer().toString(), ring.endOffset], ['defg', 1007], 'later chunks continue the same offsets');
  assert.throws(() => ring.restore(Buffer.from('x'), 1), /restore needs an empty ring/);
});

test('an append past the cap after a restore drops one slice of the restored scrollback, not all of it (D9 P3 gate)', () => {
  const trims: number[] = [];
  const ring = new RingBuffer(6400, (n) => trims.push(n));
  ring.restore(Buffer.alloc(6400, 'a'), 6400);
  ring.append(Buffer.from('b'));
  assert.deepEqual(trims, [100], 'one 1/64 slice of the cap went');
  assert.equal(ring.byteLength, 6301);
  assert.equal(ring.toBuffer().toString(), 'a'.repeat(6300) + 'b');
});

test('a PTY that ends cleanly reports an exit record with code 0, no signal and a time', async () => {
  const r = recorder();
  const { id, record } = await fiveLines(r);
  assert.equal(record.code, 0, 'bash exited cleanly');
  // node-pty reports signal 0 (or none) for a plain exit; the record passes it on as is.
  assert.ok(record.signal === 0 || record.signal === null, `no signal on a clean exit (got ${record.signal})`);
  assert.ok(Number.isFinite(record.at) && record.at > 0, 'the exit is stamped with a time');
  r.host.forget(id);
});

test('output events carry contiguous absolute offsets counted in UTF-8 bytes', async () => {
  const r = recorder();
  const { id, mine } = await fiveLines(r);
  let expected = 0;
  for (const [i, c] of mine.entries()) {
    assert.equal(c.offset, expected, `chunk ${i} starts where the previous one ended`);
    expected += Buffer.byteLength(c.data, 'utf8');
  }
  r.host.forget(id);
});

test('the snapshot of an exited PTY holds exactly what was delivered and ends where the last event did', async () => {
  const r = recorder();
  const { id, mine } = await fiveLines(r);
  const last = mine[mine.length - 1];
  assert.ok(last !== undefined);
  const snap = await r.host.snapshot(id);
  assert.ok(snap !== undefined, 'an exited entry still has its ring');
  assert.equal(snap.endOffset, last.offset + Buffer.byteLength(last.data, 'utf8'), 'the snapshot ends at the last event');
  assert.equal(snap.ring.toString('utf8'), mine.map((c) => c.data).join(''), 'the ring holds what was delivered');
  assert.match(snap.ring.toString('utf8'), /line 5 ✳/);
  r.host.forget(id);
});

test('a snapshot after the ring wrapped holds the stream tail and an endOffset past the cap', async () => {
  const r = recorder();
  // 1.25 MiB of x, then a marker: more than the 1 MiB ring holds.
  const total = SCROLLBACK_MAX_BYTES + 256 * 1024;
  const id = await spawnBash(r, `head -c ${total} /dev/zero | tr '\\0' x; printf 'END_MARK'`);
  await exitOf(r, id);
  const delivered = r.chunks.filter((c) => c.id === id);
  const stream = Buffer.from(delivered.map((c) => c.data).join(''), 'utf8');
  assert.ok(stream.byteLength > SCROLLBACK_MAX_BYTES, `the stream outgrew the ring (${stream.byteLength} bytes)`);
  const snap = await r.host.snapshot(id);
  assert.ok(snap !== undefined);
  assert.equal(snap.endOffset, stream.byteLength, 'endOffset counts the whole stream, not what the ring kept');
  assert.ok(snap.ring.byteLength <= SCROLLBACK_MAX_BYTES, 'the ring stayed within its cap');
  assert.ok(snap.ring.byteLength > 0);
  assert.ok(
    stream.subarray(stream.byteLength - snap.ring.byteLength).equals(snap.ring),
    'the ring is exactly the stream tail ending at endOffset',
  );
  assert.ok(snap.ring.toString('utf8').endsWith('END_MARK'), 'the newest bytes are kept');
  const listed = (await r.host.list()).find((e) => e.id === id);
  assert.equal(listed?.endOffset, snap.endOffset, 'list reports the same absolute end');
  r.host.forget(id);
});

test('the metadata blob takes exactly 16 KiB, refuses one byte more and keeps the previous blob', async () => {
  const r = recorder();
  const id = await spawnBash(r, 'read -r _');
  try {
    const atCap = 'm'.repeat(META_CAP);
    r.host.setMeta(id, atCap);
    assert.equal((await r.host.list()).find((e) => e.id === id)?.meta, atCap, 'a blob at the cap is stored');
    assert.throws(() => r.host.setMeta(id, 'm'.repeat(META_CAP + 1)), RangeError, 'one byte over is refused');
    // The cap is in UTF-8 bytes: 5462 three-byte glyphs are 16 386 bytes, under 16 384 characters.
    assert.throws(() => r.host.setMeta(id, '✳'.repeat(5462)), RangeError, 'multi-byte text is counted in bytes');
    assert.equal(
      (await r.host.list()).find((e) => e.id === id)?.meta,
      atCap,
      'a refused blob leaves the stored one untouched',
    );
    r.host.setMeta('no-such-pty', '{}');
    assert.equal((await r.host.list()).some((e) => e.id === 'no-such-pty'), false, 'an unknown id creates nothing');
  } finally {
    r.host.kill(id, 'now');
    r.host.forget(id);
  }
  await exitOf(r, id);
});

test('forget drops an exited entry at once', async () => {
  const r = recorder();
  const done = await spawnBash(r, 'exit 3');
  assert.equal((await exitOf(r, done)).code, 3);
  r.host.forget(done);
  assert.equal(await r.host.snapshot(done), undefined, 'an exited entry goes on forget');
});

test('forget keeps a running entry until its exit was reported, then drops it', async () => {
  const r = recorder();
  const running = await spawnBash(r, 'read -r _');
  try {
    r.host.forget(running);
    assert.notEqual(await r.host.snapshot(running), undefined, 'a running entry stays while its PTY runs');
  } finally {
    // Ends the PTY whatever the assertion said; a no-op when it already ended.
    r.host.kill(running, 'now');
  }
  await exitOf(r, running);
  assert.equal(await r.host.snapshot(running), undefined, 'gone once its exit was reported');
});

test('a ring filled exactly to its cap keeps every byte and reports no trim', () => {
  const trims: number[] = [];
  const ring = new RingBuffer(8, (n) => trims.push(n));
  ring.append(Buffer.from('abcd'));
  ring.append(Buffer.from('efgh'));
  assert.equal(ring.toBuffer().toString(), 'abcdefgh', 'the cap is inclusive: 8 bytes fit a ring of 8');
  assert.equal(ring.byteLength, 8);
  assert.deepEqual(trims, [], 'nothing was dropped, so nothing is reported');
});

test('an oversized chunk reports every byte it cost: the old content and its own cut-off head', () => {
  const trims: number[] = [];
  const ring = new RingBuffer(4, (n) => trims.push(n));
  ring.append(Buffer.from('ab'));
  ring.append(Buffer.from('0123456789'));
  assert.deepEqual(trims, [2 + 6], 'the 2 bytes held before plus the 6 the chunk lost');
});

test('spawn refuses an id that is taken and leaves the PTY under it running', async () => {
  const r = recorder();
  const id = await spawnBash(r, 'read -r _; echo SURVIVOR');
  try {
    const first = (await r.host.list()).find((e) => e.id === id);
    await assert.rejects(
      r.host.spawn({ id, file: 'bash', argv: ['-c', 'echo SECOND'], cwd: process.cwd(), env: ENV, cols: 80, rows: 24 }),
      /already exists/,
      'a second spawn under one id is refused',
    );
    const listed = (await r.host.list()).filter((e) => e.id === id);
    assert.equal(listed.length, 1, 'still one entry');
    assert.equal(listed[0]?.pid, first?.pid, 'the entry is still the first PTY');
    r.host.write(id, '\n');
    const record = await exitOf(r, id);
    assert.equal(record.code, 0, 'the first PTY took the input and ended cleanly');
    const said = r.chunks.filter((c) => c.id === id).map((c) => c.data).join('');
    assert.match(said, /SURVIVOR/, 'the first PTY ran to its end');
    assert.doesNotMatch(said, /SECOND/, 'the refused spawn never ran');
  } finally {
    r.host.kill(id, 'now');
    r.host.forget(id);
  }
});

test('list reports the pid node-pty started, the size it was spawned and resized to, and the exit record', async () => {
  const r = recorder();
  nextId += 1;
  const id = `pty-table-test-${process.pid}-${nextId}`;
  const { pid } = await r.host.spawn({
    id,
    file: 'bash',
    argv: ['-c', 'read -r _; exit 7'],
    cwd: process.cwd(),
    env: ENV,
    cols: 101,
    rows: 31,
  });
  try {
    assert.ok(Number.isInteger(pid) && pid > 1, `spawn answers a real child pid (got ${pid})`);
    assert.doesNotThrow(() => process.kill(pid, 0), 'the pid spawn answered is a running process');
    const spawned = (await r.host.list()).find((e) => e.id === id);
    assert.equal(spawned?.pid, pid, 'list reports the same pid');
    assert.deepEqual([spawned?.cols, spawned?.rows], [101, 31], 'the spawn size');
    assert.equal(spawned?.exit, null, 'a running PTY has no exit record');
    r.host.resize(id, 120, 40);
    const resized = (await r.host.list()).find((e) => e.id === id);
    assert.deepEqual([resized?.cols, resized?.rows], [120, 40], 'the size after a resize');
    r.host.write(id, '\n');
    const record = await exitOf(r, id);
    const exited = (await r.host.list()).find((e) => e.id === id);
    assert.deepEqual(exited?.exit, record, 'list carries the exit record the event reported');
    assert.equal(exited?.exit?.code, 7);
  } finally {
    r.host.kill(id, 'now');
    r.host.forget(id);
  }
});

test('a PTY runs as an xterm-256color terminal', async () => {
  const r = recorder();
  // No TERM in the environment handed over: the terminal type is the table's to set.
  const env = Object.fromEntries(Object.entries(ENV).filter(([k]) => k !== 'TERM'));
  nextId += 1;
  const id = `pty-table-test-${process.pid}-${nextId}`;
  await r.host.spawn({
    id,
    file: 'bash',
    argv: ['-c', 'printf "TERM=%s;" "$TERM"'],
    cwd: process.cwd(),
    env,
    cols: 80,
    rows: 24,
  });
  await exitOf(r, id);
  const said = r.chunks.filter((c) => c.id === id).map((c) => c.data).join('');
  assert.match(said, /TERM=xterm-256color;/);
  r.host.forget(id);
});

test('a PTY starts in the directory and at the size it was spawned with', async () => {
  const r = recorder();
  const dir = await realpath(await makeTempDir('pty-table-cwd-'));
  try {
    nextId += 1;
    const id = `pty-table-test-${process.pid}-${nextId}`;
    await r.host.spawn({
      id,
      file: 'bash',
      argv: ['-c', 'printf "CWD=%s;SIZE=%s;" "$(pwd -P)" "$(stty size)"'],
      cwd: dir,
      env: ENV,
      cols: 101,
      rows: 31,
    });
    await exitOf(r, id);
    const said = r.chunks.filter((c) => c.id === id).map((c) => c.data).join('');
    assert.match(said, new RegExp(`CWD=${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')};`), 'the working directory asked for');
    assert.match(said, /SIZE=31 101;/, 'rows and columns as asked for, not swapped');
    r.host.forget(id);
  } finally {
    await removeTempDir(dir);
  }
});
