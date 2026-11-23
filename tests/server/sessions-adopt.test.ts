/**
 * SessionManager's D9 P3 rules over a pty-host it does not own the timing of
 * — Nocturne D9 P3 (`.claude/plans/nocturne/PLAN-D9.md` § Phases P3, § Risks
 * (a) (b) (c)): adopting the sessions a pty-host kept, the metadata blob it
 * parks there, a spawn still in flight at shutdown, an exit that beats the
 * spawn's answer, two launches of one conversation at once, a lost host
 * (a crash, never an early exit — also when it beats the spawn's answer), a
 * handover (its agents poll stops), the one log line for a gap bigger than
 * the ring, the blob parked again at an exit, output that follows an exit.
 *
 * How: the real SessionManager and SessionHistory over a fake `PtyHost`
 * (tests/helpers/fake-pty-host.ts) whose spawns can be held unanswered and
 * whose events the test fires; a fake WebSocket to read what attach replays.
 * The same rules end to end, over a real pty-host and backend:
 * `pty-host-crash.test.ts`, `pty-host-lost.test.ts`.
 *
 * Why it matters: each rule closes a way a session goes wrong silently — a PTY
 * alive after shutdown with nobody to end it (and an API key in its env), a
 * history entry that never ends, two Claudes on one transcript, a replay with
 * a doubled stretch, a deleted session coming back.
 *
 * NOT claimed: the wire, the pty-host process, a real PTY.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { WebSocket } from 'ws';
import type { ServerMessage } from '../../shared/protocol.ts';
import { ConversationStarting } from '../../server/sessions.ts';
import { encodeSessionMeta, parseSessionMeta, type SessionMeta } from '../../server/sessions-meta.ts';
import { newOutputScan } from '../../server/sessions-output.ts';
import type { PtyEntrySummary } from '../../server/pty-table.ts';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SessionHistory } from '../../server/history.ts';
import { SessionManager } from '../../server/sessions.ts';
import { SessionSettingsStore } from '../../server/session-settings.ts';
import type { AgentsWatcher } from '../../server/agents.ts';
import type { Logger } from '../../server/config-log.ts';
import { makeTempDir, removeTempDir } from '../helpers/helpers.ts';
import { fakeHostManager, fakePtyHost } from '../helpers/fake-pty-host.ts';
import { infoOf } from '../helpers/history-fixture.ts';

const dirs: string[] = [];
after(async () => {
  for (const d of dirs) await removeTempDir(d);
});

const LAUNCH = { cwd: '/tmp', command: 'bash', args: ['-l'], cols: 80, rows: 24 };
const ID = '0f1e2d3c-4b5a-4968-8776-655443322110';

/** A stand-in for the `ws` socket attach() writes to: it records the frames. */
function fakeSocket(): { ws: WebSocket; frames: ServerMessage[] } {
  const frames: ServerMessage[] = [];
  const ws = { readyState: 1, OPEN: 1, send: (m: string) => frames.push(JSON.parse(m) as ServerMessage), on: () => {} };
  return { ws: ws as unknown as WebSocket, frames };
}

function replayOf(sessions: SessionManager, id: string): string {
  const { ws, frames } = fakeSocket();
  sessions.attach(id, ws);
  const replay = frames.find((f) => f.type === 'replay');
  return replay?.type === 'replay' ? replay.data : '';
}

function blob(over: Partial<SessionMeta> = {}): string {
  const meta = encodeSessionMeta({
    info: { title: 'adopted', command: 'bash', args: ['-l'], cwd: '/tmp', createdAt: '2026-11-21T10:00:00.000Z' },
    scan: newOutputScan(),
    scannedTo: 0,
    attention: false,
    ...over,
  });
  if (meta === undefined) throw new Error('the test blob does not fit');
  return meta;
}

function entry(over: Partial<PtyEntrySummary> = {}): PtyEntrySummary {
  return { id: ID, pid: 777, cols: 100, rows: 30, endOffset: 0, exit: null, meta: blob(), ...over };
}

/** A real settings store whose two directories live in `dir`. */
function settingsIn(dir: string): SessionSettingsStore {
  return new SessionSettingsStore(
    {
      dir: join(dir, 'session-settings'),
      snapshotDir: join(dir, 'statusline-snapshots'),
      scriptPath: '/home/you/app/current/server/statusline.mjs',
      prefsFile: join(dir, 'prefs.json'),
      nodePath: process.execPath,
    },
    () => {},
  );
}

test('a destroyAll during a spawn in flight kills that PTY when its answer arrives, and registers nothing', async () => {
  const host = fakePtyHost({ hold: true });
  const { sessions, history } = await fakeHostManager(host, dirs);
  const created = sessions.create(LAUNCH);
  const id = host.spawned[0]?.id as string;
  sessions.destroyAll();
  host.answer(id);
  await assert.rejects(created, /shutting down/);
  assert.ok(host.calls.includes(`kill ${id} now`), `the late PTY is killed at once: ${host.calls.join(', ')}`);
  assert.ok(host.calls.includes(`forget ${id}`), 'and handed back to the host');
  assert.deepEqual(sessions.list(), [], 'no session is listed');
  assert.equal(history.get(id), undefined, 'no history entry was written');
});

test('after destroyAll no new spawn is even asked for', async () => {
  const host = fakePtyHost();
  const { sessions } = await fakeHostManager(host, dirs);
  sessions.destroyAll();
  await assert.rejects(sessions.create(LAUNCH), /shutting down/);
  assert.deepEqual(host.spawned, []);
});

test('an exit that arrives before the spawn answer still leaves a history entry, stamped exit with its code', async () => {
  const host = fakePtyHost({ hold: true });
  const { sessions, history } = await fakeHostManager(host, dirs);
  const created = sessions.create(LAUNCH);
  const id = host.spawned[0]?.id as string;
  host.events()?.exit(id, { code: 3, signal: null, at: Date.now() });
  host.answer(id);
  const info = await created;
  assert.equal(info.status, 'exited', 'the session is registered already ended');
  const stamped = history.get(id);
  assert.deepEqual([stamped?.ended?.reason, stamped?.exitCode], ['exit', 3]);
});

test('a second launch of a conversation whose spawn is in flight is refused; another conversation is not', async () => {
  const host = fakePtyHost({ hold: true });
  const { sessions } = await fakeHostManager(host, dirs);
  const first = sessions.create({ ...LAUNCH, historyId: 'conv-1' });
  await assert.rejects(sessions.create({ ...LAUNCH, historyId: 'conv-1' }), ConversationStarting);
  assert.equal(host.spawned.length, 1, 'the refused launch spawned nothing');
  const other = sessions.create({ ...LAUNCH, historyId: 'conv-2' });
  assert.equal(host.spawned.length, 2, 'a different conversation is not held up');
  for (const req of host.spawned) host.answer(req.id);
  await Promise.all([first, other]);
  const again = sessions.create({ ...LAUNCH, historyId: 'conv-1' });
  assert.equal(host.spawned.length, 3, "once the first is registered the guard lets go (the route's 409 on a live entry takes over)");
  host.answer(host.spawned[2]?.id as string);
  await again;
});

test('adopt rebuilds a session from its blob, with the size the pty-host holds and the ring it kept', async () => {
  const host = fakePtyHost();
  const { sessions } = await fakeHostManager(host, dirs);
  host.snapshots.set(ID, { ring: Buffer.from('earlier output\r\n'), endOffset: 5016 });
  await sessions.adopt([entry({ endOffset: 5016, meta: blob({ scannedTo: 5016 }) })]);
  const info = sessions.get(ID);
  assert.deepEqual(
    [info?.title, info?.command, info?.args, info?.cwd, info?.createdAt, info?.status, info?.cols, info?.rows],
    ['adopted', 'bash', ['-l'], '/tmp', '2026-11-21T10:00:00.000Z', 'running', 100, 30],
  );
  assert.equal(replayOf(sessions, ID), 'earlier output\r\n', 'attach replays the adopted ring');
});

test('a bell after scannedTo raises attention at adopt; one before it does not', async () => {
  const host = fakePtyHost();
  const { sessions } = await fakeHostManager(host, dirs);
  const other = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
  host.snapshots.set(ID, { ring: Buffer.from('seen\x07 new'), endOffset: 9 });
  host.snapshots.set(other, { ring: Buffer.from('seen new\x07'), endOffset: 9 });
  await sessions.adopt([
    entry({ endOffset: 9, meta: blob({ scannedTo: 5 }) }),
    entry({ id: other, endOffset: 9, meta: blob({ scannedTo: 5 }) }),
  ]);
  assert.equal(sessions.get(ID)?.attention, false, 'the bell before scannedTo was already handled');
  assert.equal(sessions.get(other)?.attention, true, 'the bell in the gap is news');
  assert.equal(typeof sessions.get(other)?.pendingSince, 'string');
  assert.equal(parseSessionMeta(host.metas.get(other) ?? null)?.attention, true, 'and the blob says so now');
});

test('live output that overlaps the adopted ring is cut to what the mirror lacks', async () => {
  const host = fakePtyHost();
  const { sessions } = await fakeHostManager(host, dirs);
  host.snapshots.set(ID, { ring: Buffer.from('hello '), endOffset: 1006 });
  await sessions.adopt([entry({ endOffset: 1006, meta: blob({ scannedTo: 1006 }) })]);
  host.output(ID, 'hello ', 1000);
  host.output(ID, 'lo wörld', 1003);
  host.output(ID, '!', 1012);
  assert.equal(replayOf(sessions, ID), 'hello wörld!');
});

test('a session that exited while no backend ran ends as an exit: status, code and history', async () => {
  const host = fakePtyHost();
  const { sessions, history } = await fakeHostManager(host, dirs);
  history.recordCreate(infoOf({ id: ID, command: 'bash' }), { id: ID, conversation: false, baseArgs: [] });
  host.snapshots.set(ID, { ring: Buffer.from('bye\r\n'), endOffset: 5 });
  await sessions.adopt([entry({ endOffset: 5, exit: { code: 9, signal: null, at: Date.now() } })]);
  assert.deepEqual([sessions.get(ID)?.status, sessions.get(ID)?.exitCode], ['exited', 9]);
  assert.deepEqual([history.get(ID)?.ended?.reason, history.get(ID)?.exitCode], ['exit', 9]);
});

test('a blob marked deleted, or unreadable, is not adopted: its PTY is ended, handed back, and its history entry ends', async () => {
  const host = fakePtyHost();
  const { sessions, history } = await fakeHostManager(host, dirs);
  const garbled = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
  history.recordCreate(infoOf({ id: garbled, command: 'bash' }), { id: garbled, conversation: false, baseArgs: [] });
  // Readable output for both: the blob alone is why they are not adopted.
  for (const id of [ID, garbled]) host.snapshots.set(id, { ring: Buffer.from('out'), endOffset: 3 });
  await sessions.adopt([entry({ meta: blob({ deleted: true }) }), entry({ id: garbled, meta: '{"v":99}' })]);
  assert.deepEqual(sessions.list(), []);
  for (const id of [ID, garbled]) {
    assert.ok(host.calls.includes(`kill ${id} now`) && host.calls.includes(`forget ${id}`), `${id}: ${host.calls.join(', ')}`);
  }
  assert.equal(history.get(garbled)?.ended?.reason, 'crash', 'never left live, which would refuse every resume');
});

test('a PTY whose output cannot be read is ended, not left running unowned, and the others are still adopted', async () => {
  const host = fakePtyHost();
  const { sessions, history } = await fakeHostManager(host, dirs);
  const unread = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
  const throws = '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e';
  history.recordCreate(infoOf({ id: unread, command: 'bash' }), { id: unread, conversation: false, baseArgs: [] });
  host.snapshots.set(ID, { ring: Buffer.alloc(0), endOffset: 0 });
  host.snapshots.set(throws, { ring: Buffer.alloc(0), endOffset: 0 });
  const snapshot = host.snapshot;
  host.snapshot = async (id) => {
    if (id === throws) throw new Error('the pty-host connection closed');
    return snapshot(id);
  };
  await sessions.adopt([entry({ id: unread }), entry({ id: throws }), entry()]);
  assert.deepEqual(sessions.list().map((s) => s.id), [ID], 'the readable one is adopted');
  for (const id of [unread, throws]) {
    assert.ok(host.calls.includes(`kill ${id} now`) && host.calls.includes(`forget ${id}`), `${id}: ${host.calls.join(', ')}`);
  }
  assert.equal(history.get(unread)?.ended?.reason, 'crash');
});

test('a session handed over to another backend leaves without an end: no history stamp, sockets closed 1012', async () => {
  const host = fakePtyHost();
  const { sessions, history } = await fakeHostManager(host, dirs);
  const { id } = await sessions.create(LAUNCH);
  const closes: unknown[][] = [];
  const ws = { readyState: 1, OPEN: 1, send: () => {}, on: () => {}, close: (...a: unknown[]) => closes.push(a) };
  sessions.attach(id, ws as unknown as WebSocket);
  host.events()?.handedOver?.(id);
  assert.equal(sessions.get(id), undefined, 'no longer listed here');
  assert.equal(history.get(id)?.ended, null, 'nothing ended: the other backend runs it');
  assert.deepEqual(closes, [[1012, 'session taken over']]);
});

test('the blob rides the spawn and follows a bell and a look', async () => {
  const host = fakePtyHost();
  const { sessions } = await fakeHostManager(host, dirs);
  const { id } = await sessions.create(LAUNCH);
  const first = parseSessionMeta(host.metas.get(id) ?? null);
  assert.deepEqual([first?.info.command, first?.info.args, first?.attention], ['bash', ['-l'], false], 'the spawn carried the first blob');
  host.output(id, 'ding\x07', 0);
  const rung = parseSessionMeta(host.metas.get(id) ?? null);
  assert.deepEqual([rung?.attention, rung?.scannedTo], [true, 5], 'the bell and where the scan stood');
  assert.equal(rung?.pendingSince, sessions.get(id)?.pendingSince, 'and the pending stamp the next backend keeps');
  sessions.markSeen(id);
  assert.equal(parseSessionMeta(host.metas.get(id) ?? null)?.attention, false, 'the look reached the blob');
});

test('a deleted live session marks its blob deleted before the kill', async () => {
  const host = fakePtyHost();
  const { sessions } = await fakeHostManager(host, dirs);
  const { id } = await sessions.create(LAUNCH);
  sessions.destroy(id);
  assert.equal(parseSessionMeta(host.metas.get(id) ?? null)?.deleted, true);
});

test('a lost pty-host ends its sessions as a crash: exit code 137, history crash', async () => {
  const host = fakePtyHost();
  const { sessions, history } = await fakeHostManager(host, dirs);
  const { id } = await sessions.create(LAUNCH);
  host.events()?.lost?.(id, Date.now());
  assert.deepEqual([sessions.get(id)?.status, sessions.get(id)?.exitCode], ['exited', 137]);
  assert.equal(history.get(id)?.ended?.reason, 'crash');
});

test('an adopted Claude session with our status line gets its --settings file written again', async () => {
  const dir = await makeTempDir('ai-sm-adopt-settings-');
  dirs.push(dir);
  const noop = (): void => {};
  const settings = settingsIn(dir);
  const host = fakePtyHost();
  const sessions = new SessionManager(noop, new SessionHistory(join(dir, 'history.json'), noop), settings, undefined, undefined, undefined, host);
  host.snapshots.set(ID, { ring: Buffer.alloc(0), endOffset: 0 });
  const info = { title: 'c', command: 'claude', args: ['--permission-mode', 'plan'], cwd: '/tmp', createdAt: '2026-11-21T10:00:00.000Z', statusline: true as const };
  await sessions.adopt([entry({ meta: blob({ info }) })]);
  const file = settings.fileFor(ID);
  assert.equal(existsSync(file), true, 'the file its argv names exists again');
  assert.match(readFileSync(file, 'utf8'), /statusline\.mjs plan /, 'with the mode from its args and the current script path');
});

test('an adopted bypass session whose blob was over the cap keeps its permission args and its status-line mode', async () => {
  const dir = await makeTempDir('ai-sm-adopt-bypass-');
  dirs.push(dir);
  const noop = (): void => {};
  const settings = settingsIn(dir);
  const host = fakePtyHost();
  const sessions = new SessionManager(noop, new SessionHistory(join(dir, 'history.json'), noop), settings, undefined, undefined, undefined, host);
  host.snapshots.set(ID, { ring: Buffer.alloc(0), endOffset: 0 });
  const many = Array.from({ length: 400 }, (_, i) => `--add-dir=/home/you/projects/${'p'.repeat(40)}${i}`);
  const info = {
    title: 'c',
    command: 'claude',
    args: [...many, '--permission-mode', 'bypassPermissions'],
    cwd: '/tmp',
    createdAt: '2026-11-21T10:00:00.000Z',
    statusline: true as const,
  };
  await sessions.adopt([entry({ meta: blob({ info }) })]);
  assert.deepEqual(sessions.get(ID)?.args, ['--permission-mode', 'bypassPermissions'], 'the badge reads these');
  assert.match(readFileSync(settings.fileFor(ID), 'utf8'), /statusline\.mjs bypassPermissions /, 'the status line says bypass');
});

test('adopt keeps what the blob carried: attention, its pendingSince, an ended turn and the idle-title stamp', async () => {
  const host = fakePtyHost();
  const { sessions } = await fakeHostManager(host, dirs);
  host.snapshots.set(ID, { ring: Buffer.from('quiet'), endOffset: 5 });
  const pendingSince = '2026-11-21T10:05:00.000Z';
  await sessions.adopt([
    entry({ endOffset: 5, meta: blob({ scannedTo: 5, attention: true, pendingSince, turnEnded: true, titleIdleSince: 1_700_000_000_000 }) }),
  ]);
  const info = sessions.get(ID);
  assert.deepEqual(
    [info?.attention, info?.pendingSince, info?.turnEnded],
    [true, pendingSince, true],
    'the same pending stamp, not a new one: the mascots are ordered oldest-first',
  );
  assert.equal(sessions.titleIdleSince(ID), 1_700_000_000_000, 'the idle clock keeps running from when it started');
});

test('the scan state rides the blob: a title still open at scannedTo ends in live output, its BEL a terminator, not a bell', async () => {
  const host = fakePtyHost();
  const { sessions } = await fakeHostManager(host, dirs);
  host.snapshots.set(ID, { ring: Buffer.from('\x1b]0;ti'), endOffset: 6 });
  const inTitle = { ...newOutputScan(), inOsc: true, osc: 'title' as const, titleLen: 2, titleIdle: false };
  await sessions.adopt([entry({ endOffset: 6, meta: blob({ scannedTo: 6, scan: inTitle }) })]);
  host.output(ID, 'tle\x07', 6);
  assert.equal(sessions.get(ID)?.attention, false, 'the title ended; nothing rang');
});

test('an ended turn and an idle window title reach the blob', async () => {
  const host = fakePtyHost();
  const { sessions } = await fakeHostManager(host, dirs);
  const { id } = await sessions.create(LAUNCH);
  const report = (turn: 'working' | 'waiting') => ({ agents: [], counts: { running: 0, finished: 0 }, turn });
  // A bell first: the session is pending already, so the ended turn moves
  // no pending stamp — it must reach the blob by itself.
  host.output(id, '\x07', 0);
  sessions.setReport(id, report('working'));
  sessions.setReport(id, report('waiting'));
  assert.equal(parseSessionMeta(host.metas.get(id) ?? null)?.turnEnded, true, 'the ended turn');
  host.output(id, '\x1b]0;✳ Claude Code\x07', 1);
  assert.equal(typeof parseSessionMeta(host.metas.get(id) ?? null)?.titleIdleSince, 'number', 'the idle-title stamp');
});

test('a window title completed in the gap sets or clears the idle-title stamp at adopt', async () => {
  const host = fakePtyHost();
  const { sessions } = await fakeHostManager(host, dirs);
  const other = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
  const idle = Buffer.from('\x1b]0;✳ Claude Code\x07');
  const busy = Buffer.from('\x1b]0;⠐ Claude Code\x07');
  host.snapshots.set(ID, { ring: idle, endOffset: idle.byteLength });
  host.snapshots.set(other, { ring: busy, endOffset: busy.byteLength });
  await sessions.adopt([
    entry({ endOffset: idle.byteLength, meta: blob({ scannedTo: 0 }) }),
    entry({ id: other, endOffset: busy.byteLength, meta: blob({ scannedTo: 0, titleIdleSince: 1_700_000_000_000 }) }),
  ]);
  assert.equal(typeof sessions.titleIdleSince(ID), 'number', 'an idle title in the gap starts the stamp');
  assert.equal(sessions.titleIdleSince(other), undefined, 'a working title in the gap clears the stored one');
});

test('a Claude spawn answered after destroyAll leaves no settings file behind', async () => {
  const dir = await makeTempDir('ai-sm-adopt-latesettings-');
  dirs.push(dir);
  const noop = (): void => {};
  const settings = settingsIn(dir);
  const host = fakePtyHost({ hold: true });
  const sessions = new SessionManager(noop, new SessionHistory(join(dir, 'history.json'), noop), settings, undefined, undefined, undefined, host);
  const created = sessions.create({ ...LAUNCH, command: 'claude', args: [] });
  const id = host.spawned[0]?.id as string;
  assert.equal(existsSync(settings.fileFor(id)), true, 'the spawn carried a settings file');
  sessions.destroyAll();
  host.answer(id);
  await assert.rejects(created, /shutting down/);
  assert.equal(existsSync(settings.fileFor(id)), false, 'removed with the PTY nobody registered');
});

test('the blob carries what the row is rebuilt from: project, title, argv, cwd, start and the status line', async () => {
  const dir = await makeTempDir('ai-sm-adopt-row-');
  dirs.push(dir);
  const noop = (): void => {};
  const settings = settingsIn(dir);
  const host = fakePtyHost();
  const sessions = new SessionManager(noop, new SessionHistory(join(dir, 'history.json'), noop), settings, undefined, undefined, undefined, host);
  const info = await sessions.create({ ...LAUNCH, projectId: 'p1', title: 'Web UI', command: 'claude', args: ['--permission-mode', 'plan'] });
  const meta = parseSessionMeta(host.metas.get(info.id) ?? null);
  assert.deepEqual(meta?.info, {
    projectId: 'p1',
    title: 'Web UI',
    command: 'claude',
    args: ['--permission-mode', 'plan'],
    cwd: '/tmp',
    createdAt: info.createdAt,
    statusline: true,
  });
});

test('an adoption that throws midway ends that PTY and still adopts the others', async () => {
  const host = fakePtyHost();
  const { sessions, history } = await fakeHostManager(host, dirs);
  const breaks = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
  history.recordCreate(infoOf({ id: breaks, command: 'bash' }), { id: breaks, conversation: false, baseArgs: [] });
  for (const id of [breaks, ID]) host.snapshots.set(id, { ring: Buffer.alloc(0), endOffset: 0 });
  const setMeta = host.setMeta;
  host.setMeta = (id, meta) => {
    if (id === breaks) throw new Error('the pty-host connection closed');
    setMeta(id, meta);
  };
  await sessions.adopt([entry({ id: breaks }), entry()]);
  assert.deepEqual(sessions.list().map((s) => s.id), [ID], 'the next one is adopted; the broken one is not listed');
  assert.ok(host.calls.includes(`kill ${breaks} now`) && host.calls.includes(`forget ${breaks}`), host.calls.join(', '));
  assert.equal(history.get(breaks)?.ended?.reason, 'crash');
});

test('a pty-host lost right after a Claude launch ends it as a crash, never as "Claude Code stopped right after it started"', async () => {
  const lines: string[] = [];
  const log: Logger = (level, msg) => void lines.push(`${level} ${msg}`);
  const host = fakePtyHost();
  const { sessions } = await fakeHostManager(host, dirs, log);
  const { id } = await sessions.create({ ...LAUNCH, command: 'claude', args: [] });
  host.output(id, 'Claude Code starting\r\n', 0);
  const { ws, frames } = fakeSocket();
  sessions.attach(id, ws);
  host.events()?.lost?.(id, Date.now());
  assert.deepEqual(frames.filter((f) => f.type === 'exit'), [{ type: 'exit', exitCode: 137 }], 'the exit frame carries no early-exit line');
  assert.equal(sessions.get(id)?.earlyExit, undefined, 'the row shows no early exit: Claude did not refuse anything');
  assert.ok(!lines.some((l) => l.includes('stopped right after it started')), lines.join(' | '));
});

test('a bell and a look on a session an ended turn keeps pending still reach the blob', async () => {
  const host = fakePtyHost();
  const { sessions } = await fakeHostManager(host, dirs);
  const { id } = await sessions.create(LAUNCH);
  const report = (turn: 'working' | 'waiting') => ({ agents: [], counts: { running: 0, finished: 0 }, turn });
  // The ended turn makes it pending first: the bell and the look then move
  // no pending stamp, only `attention` — which the next backend must read.
  sessions.setReport(id, report('working'));
  sessions.setReport(id, report('waiting'));
  host.output(id, '\x07', 0);
  assert.equal(parseSessionMeta(host.metas.get(id) ?? null)?.attention, true, 'the bell');
  sessions.markSeen(id);
  assert.equal(parseSessionMeta(host.metas.get(id) ?? null)?.attention, false, 'the look');
});

test('a gap bigger than the ring is logged once for the run, however many sessions overran', async () => {
  const lines: string[] = [];
  const log: Logger = (level, msg) => void lines.push(`${level} ${msg}`);
  const host = fakePtyHost();
  const { sessions } = await fakeHostManager(host, dirs, log);
  const other = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
  // Both blobs say the scan stood at 0; the rings hold only the last 4 of 5 MB.
  for (const id of [ID, other]) host.snapshots.set(id, { ring: Buffer.from('tail'), endOffset: 5_000_000 });
  await sessions.adopt([entry({ endOffset: 5_000_000 }), entry({ id: other, endOffset: 5_000_000 })]);
  assert.deepEqual(sessions.list().map((s) => s.id).sort(), [ID, other].sort(), 'both adopted');
  const said = lines.filter((l) => l.includes('bells before it are lost'));
  assert.equal(said.length, 1, `one line, not one per session: ${lines.join(' | ')}`);
});

test('a session handed over to another backend stops its agents poll here', async () => {
  const dir = await makeTempDir('ai-sm-adopt-handover-');
  dirs.push(dir);
  const noop = (): void => {};
  const untracked: string[] = [];
  const agents = { untrack: (id: string) => void untracked.push(id) } as unknown as AgentsWatcher;
  const host = fakePtyHost();
  const sessions = new SessionManager(noop, new SessionHistory(join(dir, 'history.json'), noop), undefined, undefined, agents, undefined, host);
  const { id } = await sessions.create(LAUNCH);
  host.events()?.handedOver?.(id);
  assert.deepEqual(untracked, [id], 'the other backend polls its transcript now; this one must not keep a watch nobody reads');
});

test('an adopted Claude session that exited in the gap right after its start gets the early-exit verdict, as a live one would', async () => {
  const host = fakePtyHost();
  const { sessions } = await fakeHostManager(host, dirs);
  const at = Date.now();
  const ring = Buffer.from('Error: unknown option --frobnicate\r\n');
  host.snapshots.set(ID, { ring, endOffset: ring.byteLength });
  const info = { title: 'c', command: 'claude', args: ['--frobnicate'], cwd: '/tmp', createdAt: new Date(at - 1000).toISOString() };
  await sessions.adopt([entry({ endOffset: ring.byteLength, exit: { code: 1, signal: null, at }, meta: blob({ info }) })]);
  assert.match(sessions.get(ID)?.earlyExit?.line ?? '', /unknown option --frobnicate/, 'the line Claude printed before it stopped');
});

test('a session whose blob cannot fit even cut runs without one: no blob rides the spawn, no set-meta is ever sent', async () => {
  const host = fakePtyHost();
  const { sessions } = await fakeHostManager(host, dirs);
  const { id } = await sessions.create({ ...LAUNCH, cwd: `/tmp/${'d'.repeat(20_000)}` });
  assert.equal(host.spawned[0]?.meta, undefined, 'the spawn carried no blob');
  host.output(id, 'ding\x07', 0);
  sessions.markSeen(id);
  assert.deepEqual(host.calls.filter((c) => c.startsWith('set-meta')), [], 'nothing a pty-host would have to refuse');
  assert.equal(sessions.get(id)?.status, 'running', 'the session itself runs');
});

test('a pty-host lost before the spawn answer still leaves a history entry, stamped crash, not exit', async () => {
  const host = fakePtyHost({ hold: true });
  const { sessions, history } = await fakeHostManager(host, dirs);
  const created = sessions.create(LAUNCH);
  const id = host.spawned[0]?.id as string;
  host.events()?.lost?.(id, Date.now());
  host.answer(id);
  const info = await created;
  assert.deepEqual([info.status, info.exitCode], ['exited', 137], 'registered already ended, as the lost host left it');
  const stamped = history.get(id);
  assert.deepEqual([stamped?.ended?.reason, stamped?.exitCode], ['crash', 137], 'History says the host crashed, not that the program exited');
});

test('an exit parks the blob at the exit offset: the next backend re-scans nothing this one already saw', async () => {
  const host = fakePtyHost();
  const { sessions } = await fakeHostManager(host, dirs);
  const { id } = await sessions.create(LAUNCH);
  // Plain output changes no field of the blob, so nothing is parked for it…
  host.output(id, 'build ok\r\n', 0);
  assert.equal(parseSessionMeta(host.metas.get(id) ?? null)?.scannedTo, 0, 'still the spawn blob');
  // …until the exit, which parks it where the mirror ends.
  host.events()?.exit(id, { code: 0, signal: null, at: Date.now() });
  assert.equal(parseSessionMeta(host.metas.get(id) ?? null)?.scannedTo, 'build ok\r\n'.length);
});

test('output that arrives after the exit reaches neither the mirror nor the clients', async () => {
  const host = fakePtyHost();
  const { sessions } = await fakeHostManager(host, dirs);
  const { id } = await sessions.create(LAUNCH);
  host.output(id, 'last words\r\n', 0);
  const { ws, frames } = fakeSocket();
  sessions.attach(id, ws);
  host.events()?.exit(id, { code: 0, signal: null, at: Date.now() });
  host.output(id, 'stray\r\n', 'last words\r\n'.length);
  const after = frames.slice(frames.findIndex((f) => f.type === 'exit') + 1);
  assert.deepEqual(after, [], 'no frame follows the exit');
  assert.equal(replayOf(sessions, id), 'last words\r\n', 'the scrollback ends where the session did');
});
