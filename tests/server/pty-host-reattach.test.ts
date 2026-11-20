/**
 * Sessions outlive their owner's connection — Nocturne D9 P2
 * (`.claude/plans/nocturne/PLAN-D9.md` § Defaults, § Risks): an owner that
 * drops and a new one that connects find the same PTY (same pid) with every
 * byte written meanwhile, at continuous offsets; takeover; detach versus a
 * lost connection; the client's ordering promise (`exit` never before the
 * spawn's continuation), `pendingSpawns`, the local 16 KiB meta cap and
 * `onLost` when the host dies; a `list` bigger than one frame, sent in parts.
 *
 * How: a real pty-host child (`tests/helpers/pty-host-fixture.ts`) and the
 * backend's own client (`server/pty-host-client.ts`), over real bash PTYs.
 *
 * Why it matters: this is what P3's crash survival and P4's restart stand
 * on. A snapshot that misses the bytes of the gap, or an offset that restarts,
 * makes the re-attached pane lose or repeat output silently.
 *
 * NOT claimed: SessionManager adopting the sessions (P3); the process's own
 * lifetime (`pty-host-lifetime.test.ts`).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { connectPtyHost, type SocketPtyHost } from '../../server/pty-host-client.ts';
import { encodeInput } from '../../server/pty-host-wire.ts';
import type { PtyHostLostReason } from '../../server/pty-host-api.ts';
import type { PtyExitRecord } from '../../server/pty-table.ts';
import { waitUntil } from '../helpers/helpers.ts';
import { ENV, RawConn, hostLog, startHost, teardownHosts, trackPty } from '../helpers/pty-host-fixture.ts';
import { alive } from '../helpers/sessions-kill-fixture.ts';

interface Owner {
  host: SocketPtyHost;
  chunks: { id: string; text: string; offset: number }[];
  exits: Map<string, PtyExitRecord>;
  lost: PtyHostLostReason[];
}

async function owner(dataDir: string, takeover = false): Promise<Owner> {
  const host = await connectPtyHost({ dataDir, takeover });
  const o: Owner = { host, chunks: [], exits: new Map(), lost: [] };
  host.listen({
    output: (id, text, offset) => o.chunks.push({ id, text, offset }),
    exit: (id, record) => o.exits.set(id, record),
  });
  host.onLost((reason) => o.lost.push(reason));
  return o;
}

function textOf(o: Owner, id: string): string {
  return o.chunks
    .filter((c) => c.id === id)
    .map((c) => c.text)
    .join('');
}

async function spawnBash(o: Owner, argv: string[] = ['--norc', '--noprofile', '-i']): Promise<{ id: string; pid: number }> {
  const id = randomUUID();
  const { pid } = await o.host.spawn({ id, file: 'bash', argv, cwd: '/', env: { ...ENV, PS1: '$ ' }, cols: 80, rows: 24 });
  trackPty(pid);
  return { id, pid };
}

after(async () => {
  await teardownHosts();
});

/**
 * How long the ordering test blocks its own thread: long enough for 20 `true`
 * PTYs to spawn, exit and be reported (measured ~40 ms on WSL), so their
 * frames queue up unread. Not a wait the verdict depends on.
 */
const HOLD_THREAD_MS = 1500;

test('an owner that drops and comes back finds the same pty, every byte of the gap and continuous offsets', async () => {
  const h = await startHost();
  // The first owner is a raw connection so it can drop the way a crashed
  // backend does: the socket closes, no `detach`.
  const first = new RawConn(h.dataDir);
  first.hello(h.file.token, 'owner');
  await first.message('welcome');
  const id = randomUUID();
  first.send({ t: 'spawn', id, file: 'bash', argv: ['--norc', '--noprofile', '-i'], cwd: '/', env: { ...ENV, PS1: '$ ' }, cols: 80, rows: 24 });
  const { pid } = await first.message('spawned');
  trackPty(pid);
  const seenText = (): string =>
    first.frames.map((f) => (f.kind === 'output' && f.id === id ? f.text : '')).join('');
  const input = (text: string): void => {
    for (const f of encodeInput(id, text)) first.sock.write(f);
  };
  input('echo BEFORE-$((1+1))\r');
  await waitUntil(() => (seenText().includes('BEFORE-2') ? true : undefined), 'BEFORE-2');
  // Output keeps coming while nobody is connected.
  input('sleep 0.4; for i in 1 2 3; do echo GAP-$i; done\r');
  const seen = first.frames.flatMap((f) => (f.kind === 'output' && f.id === id ? [f] : []));
  let expected = 0;
  for (const c of seen) {
    assert.equal(c.offset, expected, 'offsets are continuous while attached');
    expected += Buffer.byteLength(c.text);
  }
  const seenEnd = expected;
  first.close();

  await waitUntil(() => (/owner connection lost without detach/.test(hostLog(h.dataDir)) ? true : undefined), 'the lost line');
  // Let the gap's output land in the ring while no owner is attached.
  const second = await waitUntil(async () => {
    const o = await owner(h.dataDir);
    const snap = await o.host.snapshot(id);
    if (snap?.ring.toString('utf8').includes('GAP-3')) return { o, snap };
    o.host.detach();
    return undefined;
  }, 'GAP-3 in the snapshot');
  const { o, snap } = second;

  const [entry] = await o.host.list();
  assert.equal(entry?.pid, pid, 'the same process, not a new one');
  assert.equal(entry?.exit, null, 'still running');
  assert.equal(snap.ring.byteLength, snap.endOffset, 'under 1 MiB the ring holds the whole stream from offset 0');
  const before = Buffer.from(seen.map((c) => c.text).join(''), 'utf8');
  assert.equal(before.byteLength, seenEnd);
  assert.ok(seenEnd <= snap.endOffset, 'the snapshot reaches at least as far as the first owner saw');
  assert.deepEqual(snap.ring.subarray(0, before.byteLength), before, 'what the first owner saw is the start of the ring');

  o.host.write(id, 'echo AFTER\r');
  await waitUntil(() => (textOf(o, id).includes('AFTER') ? true : undefined), 'AFTER from the new owner');
  const firstNew = o.chunks.find((c) => c.id === id);
  assert.equal(firstNew?.offset, snap.endOffset, 'the new owner\'s first chunk starts where the snapshot ended');
  o.host.kill(id, 'now');
  await waitUntil(() => o.exits.get(id), 'the exit');
  o.host.detach();
});

test('takeover: the new owner gets the events and the old one is told `taken-over`', async () => {
  const h = await startHost();
  const a = await owner(h.dataDir);
  const { id } = await spawnBash(a);
  const b = await owner(h.dataDir, true);
  await waitUntil(() => (a.lost.length > 0 ? true : undefined), 'the old owner to learn it lost the seat');
  assert.deepEqual(a.lost, ['taken-over']);
  b.host.write(id, 'echo FROM-B\r');
  await waitUntil(() => (textOf(b, id).includes('FROM-B') ? true : undefined), 'output to the new owner');
  assert.ok(!textOf(a, id).includes('FROM-B'), 'the old owner receives nothing any more');
  assert.match(hostLog(h.dataDir), /owner taken over by a new connection/);
  assert.doesNotMatch(hostLog(h.dataDir), /owner connection lost/, 'a takeover is no crash');
  b.host.kill(id, 'now');
  await waitUntil(() => b.exits.get(id), 'the exit');
  b.host.detach();
});

test('a clean detach writes no crash line and fires no onLost; a dropped connection writes it', async () => {
  const h = await startHost();
  const a = await owner(h.dataDir);
  a.host.detach();
  await waitUntil(() => (/owner detached; orphan grace 120000ms/.test(hostLog(h.dataDir)) ? true : undefined), 'detach line');
  assert.deepEqual(a.lost, [], 'onLost never fires after detach');
  assert.doesNotMatch(hostLog(h.dataDir), /without detach/);

  // What a crashed backend leaves: an owner whose socket closes with no goodbye.
  const crashed = new RawConn(h.dataDir);
  crashed.hello(h.file.token, 'owner');
  await crashed.message('welcome');
  crashed.close();
  await waitUntil(
    () => (/owner connection lost without detach \(backend crash\?\)/.test(hostLog(h.dataDir)) ? true : undefined),
    'the crash line',
  );
});

test('an exit never reaches the owner before its spawn\'s continuation ran', async () => {
  const h = await startHost();
  const o = await owner(h.dataDir);
  const known = new Set<string>();
  const exitsBeforeKnown: string[] = [];
  o.host.listen({
    output: () => {},
    exit: (id) => {
      if (!known.has(id)) exitsBeforeKnown.push(id);
      o.exits.set(id, { code: 0, signal: null, at: 0 });
    },
  });
  // `true` exits at once. Holding this thread while the host answers puts
  // `spawned`, the exit and everything between into ONE read on this side —
  // the case where an exit could otherwise be handled before the continuation.
  const spawns = Array.from({ length: 20 }, async () => {
    const id = randomUUID();
    const { pid } = await o.host.spawn({ id, file: 'true', argv: [], cwd: '/', env: ENV, cols: 80, rows: 24 });
    known.add(id);
    trackPty(pid);
    return id;
  });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, HOLD_THREAD_MS);
  const ids = await Promise.all(spawns);
  await waitUntil(() => (ids.every((id) => o.exits.has(id)) ? true : undefined), 'all 20 exits');
  assert.deepEqual(exitsBeforeKnown, [], 'every exit came after the awaiting code registered its id');
  o.host.detach();
});

test('pendingSpawns names a spawn until its answer is read', async () => {
  const h = await startHost();
  const o = await owner(h.dataDir);
  const id = randomUUID();
  const pending = o.host.spawn({ id, file: 'bash', argv: ['-c', 'sleep 30'], cwd: '/', env: ENV, cols: 80, rows: 24 });
  assert.deepEqual([...o.host.pendingSpawns()], [id], 'in flight');
  const { pid } = await pending;
  trackPty(pid);
  assert.equal(o.host.pendingSpawns().size, 0, 'answered');
  o.host.kill(id, 'now');
  await waitUntil(() => o.exits.get(id), 'the exit');
  o.host.detach();
});

test('a meta blob over 16 KiB throws at the caller and the host keeps the old one', async () => {
  const h = await startHost();
  const o = await owner(h.dataDir);
  const id = randomUUID();
  const { pid } = await o.host.spawn({ id, file: 'bash', argv: ['-c', 'sleep 30'], cwd: '/', env: ENV, cols: 80, rows: 24, meta: 'm0' });
  trackPty(pid);
  assert.equal((await o.host.list())[0]?.meta, 'm0', 'the spawn carried its meta');
  o.host.setMeta(id, 'é'.repeat(8 * 1024)); // exactly 16 KiB of UTF-8
  assert.throws(() => o.host.setMeta(id, `${'é'.repeat(8 * 1024)}x`), RangeError);
  assert.equal((await o.host.list())[0]?.meta, 'é'.repeat(8 * 1024), 'the over-cap blob never reached the host');
  o.host.kill(id, 'now');
  await waitUntil(() => o.exits.get(id), 'the exit');
  o.host.detach();
});

test('a host that dies fires onLost(closed) and rejects what was in flight', async () => {
  const h = await startHost();
  const o = await owner(h.dataDir);
  const { id, pid } = await spawnBash(o);
  process.kill(h.pid, 'SIGKILL');
  await waitUntil(() => (o.lost.length > 0 ? true : undefined), 'onLost');
  assert.deepEqual(o.lost, ['closed']);
  await assert.rejects(o.host.list(), /connection is closed/);
  await assert.rejects(o.host.snapshot(id), /connection is closed/);
  // The PTY outlived its holder's SIGKILL only until the kernel hung it up.
  await waitUntil(() => (alive(pid) ? undefined : true), 'bash to end with its hung-up terminal');
});

/** Sessions whose 16 KiB meta blobs together pass one frame's cap: `list` must come in parts. */
const LIST_SESSIONS = 70;

test('a list bigger than one frame comes in parts and arrives whole', async () => {
  const h = await startHost();
  const raw = new RawConn(h.dataDir);
  raw.hello(h.file.token);
  await raw.message('welcome');
  const ids = Array.from({ length: LIST_SESSIONS }, () => randomUUID());
  ids.forEach((id, i) => {
    const meta = `${String(i).padStart(4, '0')}${'m'.repeat(16 * 1024 - 4)}`; // exactly the 16 KiB cap
    raw.send({ t: 'spawn', id, file: 'sleep', argv: ['300'], cwd: '/', env: ENV, cols: 80, rows: 24, meta });
  });
  await waitUntil(() => {
    const spawned = raw.messages().filter((m) => m.t === 'spawned');
    return spawned.length === LIST_SESSIONS ? spawned : undefined;
  }, `${LIST_SESSIONS} spawned`).then((all) => all.forEach((m) => m.t === 'spawned' && trackPty(m.pid)));
  try {
    raw.send({ t: 'list', req: 9 });
    await waitUntil(() => raw.messages().find((m) => m.t === 'list-part' && m.done), 'the last part');
    const parts = raw.messages().flatMap((m) => (m.t === 'list-part' && m.req === 9 ? [m] : []));
    assert.ok(parts.length >= 2, `${parts.length} part(s): more than one frame's worth`);
    const entries = parts.flatMap((p) => p.entries);
    assert.deepEqual(entries.map((e) => e.id).sort(), [...ids].sort(), 'every session once');
    for (const e of entries) assert.equal(Buffer.byteLength(e.meta ?? ''), 16 * 1024, `${e.id}: its whole meta`);
  } finally {
    raw.send({ t: 'shutdown-all' });
    assert.equal(await h.exited, 0);
  }
});
