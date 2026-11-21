/**
 * One `PtyHost` contract, two implementations — Nocturne D9 P2
 * (`.claude/plans/nocturne/PLAN-D9.md` § Phases): the same behaviour checks
 * run against the in-process host (`server/pty-host-api.ts`
 * `createInProcessPtyHost`) and the socket host (`server/pty-host-client.ts`
 * `SocketPtyHost` over a real pty-host child).
 *
 * How: each check is a function of a `PtyHost` plus its recorded events;
 * a test per (implementation × check). Real bash PTYs both ways.
 *
 * Why it matters: P3 swaps the socket host in under SessionManager, whose
 * tests run against the in-process one. A difference in what `list`,
 * `snapshot`, `forget` or the events report would pass every existing test
 * and break sessions only in the real app.
 *
 * NOT claimed: the socket-only rules — re-attach, takeover, lifetime,
 * backpressure (`pty-host-*.test.ts`); the kill ladder's timing
 * (`pty-table-kill.test.ts`).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createInProcessPtyHost, type PtyHost } from '../../server/pty-host-api.ts';
import { connectPtyHost } from '../../server/pty-host-client.ts';
import type { PtyExitRecord } from '../../server/pty-table.ts';
import { waitUntil } from '../helpers/helpers.ts';
import { ENV, startHost, teardownHosts, trackPty } from '../helpers/pty-host-fixture.ts';

interface Rig {
  host: PtyHost;
  chunks: { id: string; data: string; offset: number }[];
  exits: Map<string, PtyExitRecord>;
}

function rig(host: PtyHost): Rig {
  const r: Rig = { host, chunks: [], exits: new Map() };
  host.listen({
    output: (id, data, offset) => r.chunks.push({ id, data, offset }),
    exit: (id, record) => r.exits.set(id, record),
  });
  return r;
}

const rigs = new Map<string, Rig>();

before(async () => {
  rigs.set('in-process', rig(createInProcessPtyHost(() => {})));
  const h = await startHost();
  rigs.set('socket', rig(await connectPtyHost({ dataDir: h.dataDir, takeover: false })));
});

after(async () => {
  rigs.get('socket')?.host.shutdownAll();
  await teardownHosts();
});

async function spawn(r: Rig, script: string, meta?: string): Promise<{ id: string; pid: number }> {
  const id = randomUUID();
  const req = { id, file: 'bash', argv: ['-c', script], cwd: '/', env: ENV, cols: 80, rows: 24 };
  const { pid } = await r.host.spawn(meta === undefined ? req : { ...req, meta });
  trackPty(pid);
  return { id, pid };
}

function textOf(r: Rig, id: string): string {
  return r.chunks
    .filter((c) => c.id === id)
    .map((c) => c.data)
    .join('');
}

const exitOf = (r: Rig, id: string): Promise<PtyExitRecord> => waitUntil(() => r.exits.get(id), `${id} to exit`);

const checks: [string, (r: Rig) => Promise<void>][] = [
  [
    'output offsets are continuous UTF-8 byte counts and the snapshot is the same stream',
    async (r) => {
      const { id } = await spawn(r, 'for i in 1 2 3; do printf "é€😀 line %s\\n" $i; done');
      await exitOf(r, id);
      let expected = 0;
      for (const c of r.chunks.filter((x) => x.id === id)) {
        assert.equal(c.offset, expected);
        expected += Buffer.byteLength(c.data);
      }
      const snap = await r.host.snapshot(id);
      assert.equal(snap?.endOffset, expected, 'endOffset = every byte reported');
      assert.equal(snap?.ring.toString('utf8'), textOf(r, id), 'the ring holds exactly what was reported');
    },
  ],
  [
    'input reaches the pty and a resize shows in the pty and in list()',
    async (r) => {
      const { id } = await spawn(r, 'read a; stty size; read b; stty size');
      r.host.write(id, 'x\r');
      await waitUntil(() => (textOf(r, id).includes('24 80') ? true : undefined), 'the first size');
      r.host.resize(id, 132, 50);
      r.host.write(id, 'y\r');
      await waitUntil(() => (textOf(r, id).includes('50 132') ? true : undefined), 'the new size');
      await exitOf(r, id);
      const entry = (await r.host.list()).find((e) => e.id === id);
      assert.deepEqual([entry?.cols, entry?.rows], [132, 50]);
    },
  ],
  [
    'list() reports pid, meta and the exit record; forget drops an exited entry',
    async (r) => {
      const { id, pid } = await spawn(r, 'exit 3', '{"v":1}');
      const exit = await exitOf(r, id);
      assert.equal(exit.code, 3);
      r.host.setMeta(id, '{"v":2}');
      const entry = (await r.host.list()).find((e) => e.id === id);
      assert.equal(entry?.pid, pid);
      assert.equal(entry?.meta, '{"v":2}');
      assert.deepEqual(entry?.exit, exit);
      r.host.forget(id);
      await waitUntil(async () => ((await r.host.list()).some((e) => e.id === id) ? undefined : true), 'the entry to go');
      assert.equal(await r.host.snapshot(id), undefined, 'a forgotten id has no snapshot');
    },
  ],
  [
    'kill now ends a running pty with SIGHUP and reports the exit',
    async (r) => {
      const { id } = await spawn(r, 'sleep 300');
      r.host.kill(id, 'now');
      const exit = await exitOf(r, id);
      assert.notEqual(exit.signal, null, 'ended by a signal');
    },
  ],
  [
    'a spawn that cannot start rejects and leaves nothing behind',
    async (r) => {
      const id = randomUUID();
      await assert.rejects(
        r.host.spawn({ id, file: 'bash', argv: [], cwd: '/', env: ENV, cols: 80, rows: 24, meta: 'x'.repeat(16 * 1024 + 1) }),
        RangeError,
      );
      assert.equal((await r.host.list()).some((e) => e.id === id), false);
    },
  ],
];

for (const impl of ['in-process', 'socket']) {
  for (const [name, check] of checks) {
    test(`${impl}: ${name}`, async () => {
      const r = rigs.get(impl);
      assert.ok(r !== undefined, `${impl} rig`);
      await check(r);
    });
  }
}
