/**
 * The backend's side of the pty-host wire, on its own — Nocturne D9 P2
 * (`.claude/plans/nocturne/PLAN-D9.md` § Defaults, § Risks):
 * `server/pty-host-client.ts` `connectPtyHost` / `SocketPtyHost`. The hello
 * deadline, the frames that arrive with the welcome, the ordering promise
 * (an `exit` after its spawn's continuation, `onLost` after that exit), a
 * reply the owner cannot use, the ids the wire cannot carry, a spawn already
 * in flight, a list answered in parts, and what a closed connection rejects.
 *
 * How: a stand-in host (`startFakeHost` in `tests/helpers/pty-host-fixture.ts`)
 * — a real socket and state file, but every answer scripted — because these
 * are the cases a well-behaved pty-host never (or only by timing) produces.
 *
 * Why it matters: P3 builds the session manager's mirror and history on these
 * events. A frame dropped at the handshake is a hole in a re-attached pane;
 * an exit before the spawn's continuation is a history entry that never ends;
 * a hello that never times out stalls the backend's boot.
 *
 * NOT claimed: the real host's behaviour behind the same verbs
 * (`pty-host-conformance.test.ts`, `pty-host-reattach.test.ts`).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Socket } from 'node:net';
import { connectPtyHost } from '../../server/pty-host-client.ts';
import type { PtyHostLostReason } from '../../server/pty-host-api.ts';
import { encodeControl, encodeOutput, type Frame } from '../../server/pty-host-wire.ts';
import { waitUntil } from '../helpers/helpers.ts';
import { ENV, fakeWelcome, startFakeHost, teardownHosts, type FakeHost } from '../helpers/pty-host-fixture.ts';

/** The connect deadline (`CONNECT_TIMEOUT_MS`, D9: 2 s), and how far past it a failure may land. */
const CONNECT_DEADLINE_MS = 2000;
const DEADLINE_SLACK_MS = 3000;

const fakes: FakeHost[] = [];

async function fake(onFrame: (sock: Socket, frame: Frame) => void): Promise<FakeHost> {
  const f = await startFakeHost(onFrame);
  fakes.push(f);
  return f;
}

/** Answer the hello with a welcome; hand every later frame to `rest`. */
function welcoming(rest: (sock: Socket, frame: Frame) => void = () => {}): (sock: Socket, frame: Frame) => void {
  return (sock, frame) => {
    if (frame.kind === 'control' && (frame.message as { t?: unknown }).t === 'hello') sock.write(fakeWelcome());
    else rest(sock, frame);
  };
}

function controlOf(frame: Frame): Record<string, unknown> | undefined {
  return frame.kind === 'control' ? (frame.message as Record<string, unknown>) : undefined;
}

after(async () => {
  for (const f of fakes) await f.stop();
  await teardownHosts();
});

test('a host that never answers the hello fails the connect at the 2 s deadline', async () => {
  const f = await fake(() => {});
  const started = performance.now();
  await assert.rejects(connectPtyHost({ dataDir: f.dataDir, takeover: false }), /did not answer in time/);
  const ms = performance.now() - started;
  assert.ok(ms >= CONNECT_DEADLINE_MS - 500, `not before the deadline (${Math.round(ms)}ms)`);
  assert.ok(ms < CONNECT_DEADLINE_MS + DEADLINE_SLACK_MS, `at the deadline, not later (${Math.round(ms)}ms)`);
  assert.deepEqual(f.received, ['hello'], 'it said hello and nothing else');
});

test('output sent in the same write as the welcome reaches the listener registered right after connect', async () => {
  const id = randomUUID();
  const f = await fake((sock, frame) => {
    if (controlOf(frame)?.['t'] === 'hello') sock.write(Buffer.concat([fakeWelcome(), ...encodeOutput(id, 0, 'EARLY')]));
  });
  const owner = await connectPtyHost({ dataDir: f.dataDir, takeover: false });
  const seen: string[] = [];
  owner.listen({ output: (_id, data, offset) => seen.push(`${offset}:${data}`), exit: () => {} });
  owner.write(id, 'x'); // a later frame: by the time the fake has it, anything early was dispatched
  await waitUntil(() => (f.received.includes('input') ? true : undefined), 'the input to reach the fake');
  assert.deepEqual(seen, ['0:EARLY'], 'the first bytes of a re-attached session are not lost');
});

test('an exit read with its `spawned` waits for the spawn\'s continuation, and onLost waits for that exit', async () => {
  const f = await fake(
    welcoming((sock, frame) => {
      const msg = controlOf(frame);
      if (msg?.['t'] !== 'spawn') return;
      const id = msg['id'] as string;
      // One write, then the end: the client reads all three in one go.
      sock.end(
        Buffer.concat([
          encodeControl({ t: 'spawned', id, pid: 4242 }),
          encodeControl({ t: 'exit', id, code: 0, signal: null, at: 1 }),
        ]),
      );
    }),
  );
  const owner = await connectPtyHost({ dataDir: f.dataDir, takeover: false });
  const order: string[] = [];
  owner.listen({ output: () => {}, exit: () => order.push('exit') });
  owner.onLost((reason: PtyHostLostReason) => order.push(`lost ${reason}`));
  // The continuation sits a few awaits deep, as it will behind SessionManager.create.
  const create = async (): Promise<void> => {
    await owner.spawn({ id: randomUUID(), file: 'true', argv: [], cwd: '/', env: ENV, cols: 80, rows: 24 });
    await Promise.resolve();
  };
  await create();
  await Promise.resolve();
  order.push('continuation');
  await waitUntil(() => (order.some((e) => e.startsWith('lost')) ? true : undefined), 'onLost');
  assert.deepEqual(order, ['continuation', 'exit', 'lost closed']);
});

test('a reply the owner cannot use closes the connection and reports the host lost', async () => {
  const id = randomUUID();
  const replies: [string, Buffer][] = [
    ['an unknown message', encodeControl({ t: 'nope' } as never)],
    ['a probe\'s answer', encodeControl({ t: 'count', req: 1, total: 0, running: 0 })],
    ['a second welcome', fakeWelcome()],
    ['a malformed exit', encodeControl({ t: 'exit', id, code: 'x' } as never)],
  ];
  for (const [name, reply] of replies) {
    const f = await fake(welcoming((sock, frame) => {
      if (controlOf(frame)?.['t'] === 'list') sock.write(reply);
    }));
    const owner = await connectPtyHost({ dataDir: f.dataDir, takeover: false });
    const lost: PtyHostLostReason[] = [];
    owner.onLost((r) => lost.push(r));
    await assert.rejects(owner.list(), /connection closed/, name);
    await waitUntil(() => (lost.length > 0 ? true : undefined), `${name}: onLost`);
    assert.deepEqual(lost, ['closed'], name);
  }
});

test('a command naming an id the wire cannot carry is dropped at the client and the connection stays', async () => {
  const f = await fake(welcoming((sock, frame) => {
    const msg = controlOf(frame);
    if (msg?.['t'] === 'list') sock.write(encodeControl({ t: 'list-part', req: msg['req'] as number, entries: [], done: true }));
  }));
  const owner = await connectPtyHost({ dataDir: f.dataDir, takeover: false });
  const lost: PtyHostLostReason[] = [];
  owner.onLost((r) => lost.push(r));
  for (const bad of ['not-a-uuid', randomUUID().toUpperCase()]) {
    assert.doesNotThrow(() => {
      owner.write(bad, 'x');
      owner.resize(bad, 80, 24);
      owner.kill(bad, 'now');
      owner.setMeta(bad, 'm');
      owner.forget(bad);
    }, bad);
  }
  assert.deepEqual(await owner.list(), [], 'the connection still answers');
  assert.deepEqual(f.received, ['hello', 'list'], 'nothing else went out');
  assert.deepEqual(lost, []);
  owner.detach();
});

test('a second spawn of an id still in flight is refused at the caller and never sent', async () => {
  const f = await fake(welcoming());
  const owner = await connectPtyHost({ dataDir: f.dataDir, takeover: false });
  const id = randomUUID();
  const first = owner.spawn({ id, file: 'true', argv: [], cwd: '/', env: ENV, cols: 80, rows: 24 });
  first.catch(() => {}); // rejected by the detach below
  await assert.rejects(owner.spawn({ id, file: 'true', argv: [], cwd: '/', env: ENV, cols: 80, rows: 24 }), /already being spawned/);
  await waitUntil(() => (f.received.includes('spawn') ? true : undefined), 'the first spawn');
  owner.detach();
  await waitUntil(() => (f.received.includes('detach') ? true : undefined), 'the detach');
  assert.deepEqual(f.received, ['hello', 'spawn', 'detach'], 'one spawn on the wire');
});

test('a list answered in parts is put back together, in order', async () => {
  const entry = (n: number) => ({ id: randomUUID(), pid: 100 + n, cols: 80, rows: 24, endOffset: n, exit: null, meta: `m${n}` });
  const parts = [[entry(1), entry(2)], [entry(3)], [entry(4)]];
  const f = await fake(welcoming((sock, frame) => {
    const msg = controlOf(frame);
    if (msg?.['t'] !== 'list') return;
    parts.forEach((entries, i) => {
      sock.write(encodeControl({ t: 'list-part', req: msg['req'] as number, entries, done: i === parts.length - 1 }));
    });
  }));
  const owner = await connectPtyHost({ dataDir: f.dataDir, takeover: false });
  assert.deepEqual(await owner.list(), parts.flat());
  owner.detach();
});

test('once the connection is closed, spawn, snapshot and list reject at once', async () => {
  const f = await fake(welcoming());
  const owner = await connectPtyHost({ dataDir: f.dataDir, takeover: false });
  const lost: PtyHostLostReason[] = [];
  owner.onLost((r) => lost.push(r));
  await f.stop();
  await waitUntil(() => (lost.length > 0 ? true : undefined), 'onLost');
  const id = randomUUID();
  await assert.rejects(owner.spawn({ id, file: 'true', argv: [], cwd: '/', env: ENV, cols: 80, rows: 24 }), /connection is closed/);
  await assert.rejects(owner.snapshot(id), /connection is closed/);
  await assert.rejects(owner.list(), /connection is closed/);
  assert.equal(owner.pendingSpawns().size, 0, 'nothing left pending');
});

test('a hello answered by anything but a well-formed welcome fails the connect', async () => {
  for (const [name, answer] of [
    ['a goodbye', encodeControl({ t: 'bye', reason: 'shutdown' })],
    ['a welcome with a string protocol', encodeControl({ t: 'welcome', proto: '1', build: 'b', pid: 1, startedAt: 'x' } as never)],
    ['an output frame', Buffer.concat(encodeOutput(randomUUID(), 0, 'x'))],
  ] as const) {
    const f = await fake((sock, frame) => {
      if (controlOf(frame)?.['t'] === 'hello') sock.write(answer);
    });
    await assert.rejects(connectPtyHost({ dataDir: f.dataDir, takeover: false }), /answered the hello with something else/, name);
  }
});

test('what is in flight when the connection closes is rejected, and nothing stays pending', async () => {
  const f = await fake(welcoming()); // answers nothing after the welcome
  const owner = await connectPtyHost({ dataDir: f.dataDir, takeover: false });
  const id = randomUUID();
  const spawn = owner.spawn({ id, file: 'true', argv: [], cwd: '/', env: ENV, cols: 80, rows: 24 });
  const snapshot = owner.snapshot(id);
  const list = owner.list();
  await waitUntil(() => (f.received.length === 4 ? true : undefined), 'the three requests to reach the fake');
  assert.deepEqual([...owner.pendingSpawns()], [id]);
  await f.stop();
  await assert.rejects(spawn, /connection closed/, 'spawn');
  await assert.rejects(snapshot, /connection closed/, 'snapshot');
  await assert.rejects(list, /connection closed/, 'list');
  assert.equal(owner.pendingSpawns().size, 0);
});

test('a snapshot of an id the wire cannot carry rejects at once instead of hanging', async () => {
  const f = await fake(welcoming());
  const owner = await connectPtyHost({ dataDir: f.dataDir, takeover: false });
  owner.listen({ output: () => {}, exit: () => {} });
  await assert.rejects(owner.snapshot('not-a-uuid'), RangeError);
  owner.write(randomUUID(), 'x'); // a later frame: the snapshot was never sent before it
  await waitUntil(() => (f.received.includes('input') ? true : undefined), 'the input to reach the fake');
  assert.ok(!f.received.includes('snapshot'), 'nothing was sent for it');
  owner.detach();
});

test('frames read before a bad one in the same chunk are delivered, then the connection closes', async () => {
  const id = randomUUID();
  const oversize = Buffer.alloc(5);
  oversize.writeUInt32BE(2 * 1024 * 1024, 0);
  oversize.writeUInt8(1, 4);
  const f = await fake(
    welcoming((sock, frame) => {
      if (controlOf(frame)?.['t'] !== 'list') return;
      sock.write(Buffer.concat([...encodeOutput(id, 0, 'LAST'), encodeControl({ t: 'exit', id, code: 0, signal: null, at: 1 }), oversize]));
    }),
  );
  const owner = await connectPtyHost({ dataDir: f.dataDir, takeover: false });
  const order: string[] = [];
  owner.listen({ output: (_id, data) => order.push(`output ${data}`), exit: () => order.push('exit') });
  owner.onLost((reason: PtyHostLostReason) => order.push(`lost ${reason}`));
  await assert.rejects(owner.list(), /connection closed/);
  await waitUntil(() => (order.some((o) => o.startsWith('lost')) ? true : undefined), 'onLost');
  assert.deepEqual(order, ['output LAST', 'exit', 'lost closed'], 'the good frames first, then the loss');
});
