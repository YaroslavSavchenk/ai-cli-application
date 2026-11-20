/**
 * Who may talk to the pty-host, and what it refuses — Nocturne D9 P2
 * (`.claude/plans/nocturne/PLAN-D9.md` § Defaults): the hello (token,
 * protocol, deadline), the frame cap, the exclusive owner seat, the probe
 * role's two verbs, the file modes, and the data-dir and socket-path refusals
 * at start.
 *
 * How: a real pty-host child (`server/pty-host-main.ts`) on a temp data dir,
 * driven over a hand-made wire connection (`RawConn` in
 * `tests/helpers/pty-host-fixture.ts`) so a test can send what the client
 * never would. One host serves the file; the start refusals start their own.
 *
 * Why it matters: the pty-host holds every session — a shell in each, and an
 * API key in the CLI's environment. Anything that connects past the hello can
 * type into those shells. The socket's 0600 is the first wall, the token the
 * second, and a peer that skips the hello must not hold a connection open.
 *
 * Also (D9 P2 fix round): a refused hello is the last frame read; at most 16
 * connections wait for a hello; a replaced or detached owner keeps no right
 * (owner rights are the seat, not a role) — nor any probe right; input
 * from anyone but the owner never reaches a pty; a pty gets the host's own
 * umask, not the socket's 0177; the client checks the data dir, the socket
 * and the state file before it reads the token.
 *
 * NOT claimed: re-attaching and takeover (`pty-host-reattach.test.ts`); the
 * process's lifetime (`pty-host-lifetime.test.ts`).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { chmod, mkdir, rename, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
  PTY_HOST_EXIT,
  MAX_SOCKET_PATH_BYTES,
  encodeControl,
  encodeInput,
  ownedRefusal,
  ptyHostPaths,
} from '../../server/pty-host-wire.ts';
import { PtyHostRefusal, connectPtyHost, probePtyHost, startPtyHost } from '../../server/pty-host-client.ts';
import { SKIP_IF_ROOT, projectRoot, waitUntil } from '../helpers/helpers.ts';
import { alive } from '../helpers/sessions-kill-fixture.ts';
import {
  ENV,
  RawConn,
  hostLog,
  hostReady,
  makeHostDir,
  spawnHost,
  startHost,
  teardownHosts,
  trackPty,
  type HostProc,
} from '../helpers/pty-host-fixture.ts';
import type { PtyHostFile } from '../../server/pty-host-wire.ts';

let host: HostProc & { file: PtyHostFile };
const conns: RawConn[] = [];

function raw(): RawConn {
  const c = new RawConn(host.dataDir);
  conns.push(c);
  return c;
}

before(async () => {
  host = await startHost();
});

after(async () => {
  for (const c of conns) c.close();
  await teardownHosts();
});

test('a wrong token is refused with `token` and the connection closed', async () => {
  const c = raw();
  c.hello('0'.repeat(64));
  const refuse = await c.message('refuse');
  assert.equal(refuse.reason, 'token');
  await c.closedSoon();
  assert.ok(!c.messages().some((m) => m.t === 'welcome'), 'no welcome after a wrong token');
  assert.ok(!hostLog(host.dataDir).includes(host.file.token), 'the token never reaches pty-host.log');
});

test('another protocol number is refused with `proto` and the host names its own', async () => {
  const c = raw();
  c.hello(host.file.token, 'owner', false, 2);
  const refuse = await c.message('refuse');
  assert.deepEqual(refuse, { t: 'refuse', reason: 'proto', proto: 1 });
  await c.closedSoon();
});

test('a connection that says no hello within 2 s is closed', async () => {
  const c = raw();
  const started = performance.now();
  await c.closedSoon(10_000);
  const ms = performance.now() - started;
  assert.ok(ms >= 1500, `closed after ${Math.round(ms)}ms, not before the 2 s deadline`);
  assert.equal(c.frames.length, 0, 'nothing was said to it');
});

test('a first frame that is not a hello is refused with `bad-hello`', async () => {
  const c = raw();
  c.send({ t: 'list', req: 1 });
  assert.equal((await c.message('refuse')).reason, 'bad-hello');
  await c.closedSoon();
});

test('a frame header over the cap closes the connection, before or after the hello', async () => {
  const oversize = Buffer.alloc(5);
  oversize.writeUInt32BE(2 * 1024 * 1024, 0);
  oversize.writeUInt8(1, 4);

  const before = raw();
  before.sock.write(oversize);
  await before.closedSoon();

  const after = raw();
  after.hello(host.file.token, 'probe');
  await after.message('welcome');
  after.sock.write(oversize);
  await after.closedSoon();
  assert.match(hostLog(host.dataDir), /connection closed: a frame of 2097152 bytes is over the \d+-byte cap/);

  // The host itself is unharmed.
  const probe = await probePtyHost({ dataDir: host.dataDir });
  assert.deepEqual(await probe.listCount(), { total: 0, running: 0 });
  probe.close();
});

test('the owner seat is exclusive: a second owner without takeover is refused `owner-busy`', async () => {
  const owner = await connectPtyHost({ dataDir: host.dataDir, takeover: false });
  try {
    await assert.rejects(
      connectPtyHost({ dataDir: host.dataDir, takeover: false }),
      (err: unknown) => err instanceof PtyHostRefusal && err.reason === 'owner-busy',
    );
    assert.deepEqual(await owner.list(), [], 'the first owner is still served');
  } finally {
    owner.detach();
  }
});

test('a probe may count and nothing else: an owner verb closes it and spawns nothing', async () => {
  const c = raw();
  c.hello(host.file.token, 'probe');
  await c.message('welcome');
  c.send({ t: 'list-count', req: 7 });
  assert.deepEqual(await c.message('count'), { t: 'count', req: 7, total: 0, running: 0 });
  c.send({ t: 'spawn', id: randomUUID(), file: 'bash', argv: [], cwd: '/', env: ENV, cols: 80, rows: 24 });
  await c.closedSoon();
  assert.match(hostLog(host.dataDir), /probe connection closed: 'spawn' is not a probe verb/);
  const probe = await probePtyHost({ dataDir: host.dataDir });
  assert.deepEqual(await probe.listCount(), { total: 0, running: 0 }, 'nothing was spawned');
  probe.close();
});

test('pty-host.json and the socket are 0600, and the state file says who runs where', () => {
  const paths = ptyHostPaths(host.dataDir);
  assert.equal(statSync(paths.stateFile).mode & 0o777, 0o600, 'pty-host.json');
  assert.equal(statSync(paths.socket).mode & 0o777, 0o600, 'pty-host.sock');
  assert.equal(statSync(paths.log).mode & 0o777, 0o600, 'pty-host.log');
  assert.equal(host.file.pid, host.pid);
  assert.equal(host.file.proto, 1);
  assert.equal(host.file.appDir, projectRoot.replace(/\/$/, ''));
  assert.match(host.file.token, /^[0-9a-f]{64}$/);
  assert.ok(!Number.isNaN(Date.parse(host.file.startedAt)), 'startedAt is a date');
});

test('a data dir that is not mode 0700 refuses the start and nothing is written into it', { skip: SKIP_IF_ROOT }, async () => {
  const dir = await makeHostDir();
  await chmod(dir, 0o755);
  const h = spawnHost(dir);
  assert.equal(await h.exited, PTY_HOST_EXIT.refused);
  assert.match(h.stderr(), /refusing to start: The data directory has mode 755, not 700\./);
  assert.deepEqual(readdirSync(dir), [], 'no socket, no state file, no log');
  await assert.rejects(startPtyHost({ dataDir: dir, build: 'test' }), /mode 755, not 700/);
});

test('a socket path of 107 bytes binds; one byte more refuses the start with the reason', async () => {
  const base = await makeHostDir();
  const room = MAX_SOCKET_PATH_BYTES - Buffer.byteLength(ptyHostPaths(base).socket) - 1;
  const fits = join(base, 'f'.repeat(room));
  await mkdir(fits, { mode: 0o700 });
  assert.equal(Buffer.byteLength(ptyHostPaths(fits).socket), 107, 'measured: the longest bindable path');
  const ok = spawnHost(fits);
  assert.equal((await hostReady(ok)).pid, ok.pid);
  const probe = await probePtyHost({ dataDir: fits });
  assert.deepEqual(await probe.listCount(), { total: 0, running: 0 });
  probe.close();

  const tooLong = join(base, 'g'.repeat(room + 1));
  await mkdir(tooLong, { mode: 0o700 });
  const refused = spawnHost(tooLong);
  assert.equal(await refused.exited, PTY_HOST_EXIT.refused);
  assert.match(refused.stderr(), /socket path is 108 bytes, over the 107-byte limit/);
  assert.equal(existsSync(ptyHostPaths(tooLong).socket), false);
  await assert.rejects(startPtyHost({ dataDir: tooLong, build: 'test' }), /over the 107-byte limit/);
});

test('a refused hello is the last frame read: a correct hello right behind it gets no welcome', async () => {
  const c = raw();
  c.sock.write(
    Buffer.concat([
      encodeControl({ t: 'hello', proto: 1, token: '0'.repeat(64), role: 'owner', takeover: false }),
      encodeControl({ t: 'hello', proto: 1, token: host.file.token, role: 'owner', takeover: false }),
    ]),
  );
  assert.equal((await c.message('refuse')).reason, 'token');
  await c.closedSoon();
  assert.ok(!c.messages().some((m) => m.t === 'welcome'), 'the second hello was never processed');
});

test('at most 16 connections may wait for their hello; more are closed at once', async () => {
  const started = performance.now();
  const silent = Array.from({ length: 20 }, () => raw());
  await waitUntil(
    () => (silent.filter((c) => c.closed).length >= 4 ? true : undefined),
    'the 4 connections over the cap to be closed',
    5000,
  );
  assert.ok(performance.now() - started < 1500, 'closed at once, not at the 2 s hello deadline');
  assert.match(hostLog(host.dataDir), /over 16 connections without a hello: closing new ones at once/);
  for (const c of silent) c.close();
});

/** The text of every output frame for `id` this connection received. */
function outputOf(c: RawConn, id: string): string {
  return c.frames.map((f) => (f.kind === 'output' && f.id === id ? f.text : '')).join('');
}

/** A host with one owner holding a session (`sleep 300` unless said): what the rights tests start from. */
async function heldSession(
  file = 'sleep',
  argv = ['300'],
): Promise<{ h: HostProc & { file: PtyHostFile }; a: RawConn; id: string; pid: number }> {
  const h = await startHost();
  const a = new RawConn(h.dataDir, true);
  conns.push(a);
  a.hello(h.file.token);
  await a.message('welcome');
  const id = randomUUID();
  a.send({ t: 'spawn', id, file, argv, cwd: '/', env: ENV, cols: 80, rows: 24 });
  const { pid } = await a.message('spawned');
  trackPty(pid);
  return { h, a, id, pid };
}

/** Every owner verb a demoted connection might still try, and the two probe verbs, in one write. */
function ownerVerbs(id: string): Buffer {
  return Buffer.concat([
    encodeControl({ t: 'list-count', req: 1 }),
    encodeControl({ t: 'shutdown-if-empty', req: 2 }),
    encodeControl({ t: 'spawn', id: randomUUID(), file: 'sleep', argv: ['300'], cwd: '/', env: ENV, cols: 80, rows: 24 }),
    ...encodeInput(id, 'x'),
    encodeControl({ t: 'kill', id, mode: 'now' }),
    encodeControl({ t: 'shutdown-all' }),
  ]);
}

test('a replaced owner loses every right at once: its spawn, input, kill and shutdown-all do nothing', async () => {
  const { h, a, id, pid } = await heldSession();
  const b = new RawConn(h.dataDir);
  conns.push(b);
  b.hello(h.file.token, 'owner', true);
  await b.message('welcome');
  a.sock.write(ownerVerbs(id));
  await a.closedSoon();
  assert.deepEqual(a.messages().at(-1), { t: 'bye', reason: 'taken-over' });
  assert.ok(!a.messages().some((m) => m.t === 'count' || m.t === 'emptied'), 'no probe verb was answered either');
  const probe = await probePtyHost({ dataDir: h.dataDir });
  assert.deepEqual(await probe.listCount(), { total: 1, running: 1 }, 'nothing spawned, nothing killed');
  probe.close();
  assert.ok(alive(pid), 'the session runs on');
  assert.ok(alive(h.pid), 'the host was not shut down');
});

test('a detached owner gives the seat up in the same breath: verbs behind its detach do nothing', async () => {
  const { h, a, id, pid } = await heldSession();
  a.sock.write(Buffer.concat([encodeControl({ t: 'detach' }), ownerVerbs(id)]));
  await a.closedSoon();
  await waitUntil(() => (/owner detached/.test(hostLog(h.dataDir)) ? true : undefined), 'the detach line');
  assert.ok(!a.messages().some((m) => m.t === 'count' || m.t === 'emptied'), 'no probe verb was answered either');
  const probe = await probePtyHost({ dataDir: h.dataDir });
  assert.deepEqual(await probe.listCount(), { total: 1, running: 1 }, 'nothing spawned, nothing killed');
  probe.close();
  assert.ok(alive(pid), 'the session runs on');
  assert.ok(alive(h.pid), 'the host was not shut down');
});

test('the client refuses a data dir, state file or socket that is not plainly ours, before reading the token', { skip: SKIP_IF_ROOT }, async () => {
  const h = await startHost();
  const paths = ptyHostPaths(h.dataDir);
  try {
    await chmod(h.dataDir, 0o770);
    await assert.rejects(connectPtyHost({ dataDir: h.dataDir, takeover: false }), /mode 770, not 700/);
    await assert.rejects(probePtyHost({ dataDir: h.dataDir }), /mode 770, not 700/);
  } finally {
    await chmod(h.dataDir, 0o700);
  }
  try {
    await chmod(paths.stateFile, 0o644);
    await assert.rejects(probePtyHost({ dataDir: h.dataDir }), /state file has mode 644, not 600/);
  } finally {
    await chmod(paths.stateFile, 0o600);
  }
  // A link in place of the state file: lstat sees the link, never its target.
  await rename(paths.stateFile, `${paths.stateFile}.real`);
  await symlink(`${paths.stateFile}.real`, paths.stateFile);
  await assert.rejects(probePtyHost({ dataDir: h.dataDir }), /state file is not a regular file/);
  await rm(paths.stateFile);
  await rename(`${paths.stateFile}.real`, paths.stateFile);
  const probe = await probePtyHost({ dataDir: h.dataDir });
  assert.equal(probe.welcome.pid, h.pid, 'with everything ours again, it connects');
  probe.close();
});

test('ownership: a socket or state file of another uid is refused (stat seam: no test can chown)', () => {
  const st = (o: { uid: number; mode: number; file?: boolean; socket?: boolean }) => ({
    uid: o.uid,
    mode: o.mode,
    isFile: () => o.file === true,
    isSocket: () => o.socket === true,
  });
  const me = 1000;
  assert.equal(ownedRefusal('socket', st({ uid: me, mode: 0o140600, socket: true }), me), undefined);
  assert.equal(ownedRefusal('state file', st({ uid: me, mode: 0o100600, file: true }), me), undefined);
  assert.match(ownedRefusal('socket', st({ uid: 0, mode: 0o140600, socket: true }), me) ?? '', /socket belongs to another user/);
  assert.match(ownedRefusal('state file', st({ uid: 0, mode: 0o100600, file: true }), me) ?? '', /state file belongs to another user/);
  assert.match(ownedRefusal('socket', st({ uid: me, mode: 0o100600, file: true }), me) ?? '', /socket is not a socket/);
  assert.match(ownedRefusal('state file', st({ uid: me, mode: 0o100640, file: true }), me) ?? '', /mode 640, not 600/);
});

test('an answered hello frees its place: twenty probes one after another are all served', async () => {
  // More than the 16 pending places: a place that is never given back would
  // close the 17th at once.
  for (let i = 0; i < 20; i++) {
    const probe = await probePtyHost({ dataDir: host.dataDir });
    assert.deepEqual(await probe.listCount(), { total: 0, running: 0 }, `probe ${i + 1}`);
    probe.close();
  }
});

test('input from a probe or from a connection still owing its hello never reaches a pty', async () => {
  const { h, a, id } = await heldSession('bash', ['-c', 'read line; echo "GOT:$line"']);
  const probe = new RawConn(h.dataDir);
  conns.push(probe);
  probe.hello(h.file.token, 'probe');
  await probe.message('welcome');
  probe.sock.write(Buffer.concat(encodeInput(id, 'EVIL-PROBE\r')));
  await probe.closedSoon();
  const pending = new RawConn(h.dataDir);
  conns.push(pending);
  pending.sock.write(Buffer.concat(encodeInput(id, 'EVIL-PENDING\r')));
  assert.equal((await pending.message('refuse')).reason, 'bad-hello');
  for (const f of encodeInput(id, 'owner\r')) a.sock.write(f);
  const text = (): string => outputOf(a, id);
  await waitUntil(() => (text().includes('GOT:') ? true : undefined), 'the line the pty read');
  assert.match(text(), /GOT:owner/, 'the owner\'s line was the first one read');
  assert.doesNotMatch(text(), /EVIL/, 'nothing else was typed');
});

test('a pty runs under the host\'s own umask, not the 0177 the socket was bound with', async () => {
  const { a, id } = await heldSession('bash', ['-c', 'echo "UMASK=$(umask)"']);
  const want = /^Umask:\s+(\d+)$/m.exec(readFileSync('/proc/self/status', 'utf8'))?.[1] ?? 'unknown';
  const text = (): string => outputOf(a, id);
  await waitUntil(() => (/UMASK=\d+/.test(text()) ? true : undefined), 'the umask line');
  assert.match(text(), new RegExp(`UMASK=${want}\\b`), `the umask this test started the host with (${want})`);
});
