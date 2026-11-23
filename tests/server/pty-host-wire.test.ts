/**
 * The pty-host's wire — Nocturne D9 P2 (`.claude/plans/nocturne/PLAN-D9.md`
 * § Defaults): `server/pty-host-wire.ts` (frame layout, the reader's cap,
 * UTF-8 cutting, message validation, the data-dir, state-file and lock-secret
 * refusals) and the seams around it (`resolveHostTimers`, `resolveHostBuild`,
 * `resolvePtyHostMode`), and where its lowercase-only session id parts from
 * server/conversation.ts `isUuid` (PLAN-QUALITY Q11). A uid that is not ours is made by mocking
 * `process.getuid` — no test can chown.
 *
 * How: the functions called directly — they are the rules both processes
 * share, so a frame that round-trips here is one both sides read alike.
 *
 * Why it matters: a frame cut mid-character turns into U+FFFD on the
 * backend's screen; an offset that does not continue across pieces makes P3's
 * mirror see a gap that is not there; a header the reader trusts lets a peer
 * make the pty-host allocate gigabytes.
 *
 * NOT claimed: a real socket and process — `pty-host-auth.test.ts`,
 * `pty-host-reattach.test.ts`, `pty-host-lifetime.test.ts`,
 * `pty-host-backpressure.test.ts`.
 */
import { test, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { chmod, mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
  FrameReader,
  MAX_FRAME_PAYLOAD,
  MAX_SOCKET_PATH_BYTES,
  WireError,
  connectRefusal,
  dataDirRefusal,
  encodeControl,
  encodeInput,
  encodeOutput,
  encodeSnapshot,
  isSessionUuid,
  lockSecret,
  ownedRefusal,
  parseClientMessage,
  parseHostMessage,
  ptyHostPaths,
  readPtyHostFile,
  utf8Pieces,
  type Frame,
} from '../../server/pty-host-wire.ts';
import { resolveHostBuild, resolveHostTimers } from '../../server/pty-host-server.ts';
import { resolvePtyHostMode } from '../../server/pty-host-client.ts';
import { SCROLLBACK_MAX_BYTES } from '../../server/pty-table.ts';
import { isUuid } from '../../server/conversation.ts';
import { SKIP_IF_ROOT, makeTempDir, removeTempDir } from '../helpers/helpers.ts';

const dirs: string[] = [];
after(async () => {
  for (const d of dirs) await removeTempDir(d);
});

/** Feed the reader one byte at a time: every split point of the stream is exercised. */
function byteByByte(bytes: Buffer): Frame[] {
  const reader = new FrameReader();
  const out: Frame[] = [];
  for (let i = 0; i < bytes.byteLength; i++) out.push(...reader.push(bytes.subarray(i, i + 1)));
  return out;
}

test('every frame kind round-trips through the reader, whatever the chunking', () => {
  const id = randomUUID();
  const ring = Buffer.from('ring ✓ bytes', 'utf8');
  const stream = Buffer.concat([
    encodeControl({ t: 'spawned', id, pid: 4242 }),
    ...encodeOutput(id, 7, Buffer.from('héllo')),
    ...encodeInput(id, 'ls\r'),
    encodeSnapshot(3, { ring, endOffset: 99 }),
    encodeSnapshot(4, undefined),
  ]);
  const frames = byteByByte(stream);
  assert.deepEqual(frames, [
    { kind: 'control', message: { t: 'spawned', id, pid: 4242 } },
    { kind: 'output', id, offset: 7, text: 'héllo', bytes: Buffer.from('héllo') },
    { kind: 'input', id, text: 'ls\r' },
    { kind: 'snapshot', req: 3, snapshot: { ring, endOffset: 99 } },
    { kind: 'snapshot', req: 4, snapshot: undefined },
  ]);
});

test('a full 1 MiB ring fits one binary snapshot frame', () => {
  const ring = Buffer.alloc(SCROLLBACK_MAX_BYTES, 0x41);
  const frame = encodeSnapshot(1, { ring, endOffset: 5 * SCROLLBACK_MAX_BYTES });
  const [decoded] = new FrameReader().push(frame);
  assert.equal(decoded?.kind, 'snapshot');
  assert.equal(decoded.kind === 'snapshot' && decoded.snapshot?.ring.byteLength, SCROLLBACK_MAX_BYTES);
  assert.equal(decoded.kind === 'snapshot' && decoded.snapshot?.endOffset, 5 * SCROLLBACK_MAX_BYTES);
});

test('a header announcing more than the cap is refused before its payload is buffered', () => {
  const header = Buffer.alloc(5);
  header.writeUInt32BE(MAX_FRAME_PAYLOAD + 1, 0);
  header.writeUInt8(1, 4);
  assert.throws(() => new FrameReader().push(header), WireError);
  assert.throws(() => encodeControl({ t: 'set-meta', id: randomUUID(), meta: 'x'.repeat(MAX_FRAME_PAYLOAD) }), RangeError);
});

test('an unknown kind, a control frame that is not JSON and a short data frame are wire errors', () => {
  const frame = (kind: number, payload: Buffer): Buffer => {
    const h = Buffer.alloc(5);
    h.writeUInt32BE(payload.byteLength, 0);
    h.writeUInt8(kind, 4);
    return Buffer.concat([h, payload]);
  };
  for (const [name, bytes] of [
    ['kind 9', frame(9, Buffer.from('{}'))],
    ['not JSON', frame(1, Buffer.from('{nope'))],
    ['short output', frame(2, Buffer.alloc(10))],
    ['short snapshot', frame(4, Buffer.alloc(12))],
  ] as const) {
    assert.throws(() => new FrameReader().push(bytes), WireError, name);
  }
});

test('text is cut only at a character boundary and output offsets continue across the pieces', () => {
  // 3-byte and 4-byte characters around every cut of a 10-byte piece.
  const text = 'a€😀b€€😀😀c'.repeat(40);
  const pieces = utf8Pieces(Buffer.from(text), 10);
  assert.ok(pieces.length > 10, 'the text is really cut');
  assert.equal(pieces.map((p) => p.toString('utf8')).join(''), text, 'no character is split or lost');
  for (const p of pieces) assert.ok(!p.toString('utf8').includes('�'), 'each piece decodes on its own');

  const id = randomUUID();
  const big = '€'.repeat(200_000); // 600 000 bytes: three output frames
  const frames = encodeOutput(id, 1000, Buffer.from(big)).flatMap((f) => new FrameReader().push(f));
  assert.ok(frames.length > 1, 'a chunk over the piece size becomes several frames');
  let expected = 1000;
  for (const f of frames) {
    assert.equal(f.kind, 'output');
    if (f.kind !== 'output') continue;
    assert.equal(f.offset, expected, 'each piece starts where the previous one ended');
    expected += Buffer.byteLength(f.text);
  }
  assert.equal(expected, 1000 + Buffer.byteLength(big));
});

test('a session id that is not a uuid cannot be put on the wire', () => {
  assert.throws(() => encodeInput('not-a-uuid', 'x'), RangeError);
  assert.throws(() => encodeOutput('ABCDEF00-0000-0000-0000-000000000000', 0, Buffer.from('x')), RangeError);
});

test('a client message with a field of the wrong shape is unknown, never guessed', () => {
  const id = randomUUID();
  const spawn = { t: 'spawn', id, file: 'bash', argv: [], cwd: '/', env: {}, cols: 80, rows: 24 };
  assert.deepEqual(parseClientMessage(spawn), spawn, 'the well-formed spawn is accepted');
  const bad: [string, unknown][] = [
    ['unknown verb', { t: 'exec', id }],
    ['spawn id not a uuid', { ...spawn, id: 'x' }],
    ['spawn cols 0', { ...spawn, cols: 0 }],
    ['spawn rows 70000', { ...spawn, rows: 70_000 }],
    ['spawn env value a number', { ...spawn, env: { A: 1 } }],
    ['spawn argv not strings', { ...spawn, argv: [1] }],
    ['spawn meta a number', { ...spawn, meta: 5 }],
    ['hello role admin', { t: 'hello', proto: 1, token: 't', role: 'admin', takeover: false }],
    ['hello takeover missing', { t: 'hello', proto: 1, token: 't', role: 'owner' }],
    ['kill mode soft', { t: 'kill', id, mode: 'soft' }],
    ['list req negative', { t: 'list', req: -1 }],
    ['an array', [spawn]],
  ];
  for (const [name, v] of bad) assert.equal(parseClientMessage(v), undefined, name);
  assert.equal(parseHostMessage({ t: 'bye', reason: 'whim' }), undefined, 'an unknown bye reason');
  assert.equal(parseHostMessage({ t: 'exit', id, code: 0, signal: 'HUP', at: 1 }), undefined, 'a signal name');
});

test('a data dir is refused unless it is a real 0700 directory of ours with a bindable socket path', { skip: SKIP_IF_ROOT }, async () => {
  const root = await makeTempDir('pty-host-dir-');
  dirs.push(root);
  const ok = join(root, 'ok');
  await mkdir(ok, { mode: 0o700 });
  assert.equal(dataDirRefusal(ok), undefined, 'a 0700 dir of ours');

  const open = join(root, 'open');
  await mkdir(open);
  await chmod(open, 0o755);
  assert.match(dataDirRefusal(open) ?? '', /mode 755, not 700/);

  const link = join(root, 'link');
  await symlink(ok, link);
  assert.match(dataDirRefusal(link) ?? '', /not a plain directory/);

  assert.match(dataDirRefusal(join(root, 'missing')) ?? '', /cannot be read \(ENOENT\)/);

  const long = join(ok, 'x'.repeat(MAX_SOCKET_PATH_BYTES));
  assert.match(dataDirRefusal(long) ?? '', /over the 107-byte limit/);
  const fits = join(root, 'y'.repeat(MAX_SOCKET_PATH_BYTES - Buffer.byteLength(ptyHostPaths(root).socket) - 1));
  await mkdir(fits, { mode: 0o700 });
  assert.equal(Buffer.byteLength(ptyHostPaths(fits).socket), MAX_SOCKET_PATH_BYTES);
  assert.equal(dataDirRefusal(fits), undefined, 'exactly 107 bytes of socket path is accepted');
});

test('the lifetime seams default to 60 s idle and 10 min orphan grace; the grace is floored and bad values are said', () => {
  const lines: string[] = [];
  const log = (_level: string, message: string): void => {
    lines.push(message);
  };
  assert.deepEqual(resolveHostTimers(log, {}), { idleMs: 60_000, orphanMs: 600_000 });
  assert.deepEqual(resolveHostTimers(log, { AI_SM_PTY_HOST_IDLE_MS: '500', AI_SM_PTY_HOST_ORPHAN_MS: '10' }), {
    idleMs: 500,
    orphanMs: 1000,
  });
  assert.ok(lines.includes('AI_SM_PTY_HOST_ORPHAN_MS=10 is below the 1000ms floor; using 1000'), lines.join('\n'));
  assert.equal(resolveHostTimers(log, { AI_SM_PTY_HOST_IDLE_MS: 'soon' }).idleMs, 60_000, 'garbage → default');
  assert.ok(
    lines.includes('AI_SM_PTY_HOST_IDLE_MS must be a non-negative integer (ms), got "soon"; using 60000'),
    'the fallback is loud',
  );
});

test('AI_SM_PTY_HOST=inproc is a test seam: honoured in a clone, refused in the installed app', () => {
  assert.equal(resolvePtyHostMode(false, {}), 'socket');
  assert.equal(resolvePtyHostMode(false, { AI_SM_PTY_HOST: 'inproc' }), 'inproc');
  assert.throws(() => resolvePtyHostMode(true, { AI_SM_PTY_HOST: 'inproc' }), /refused in the installed app/);
  assert.equal(resolvePtyHostMode(true, {}), 'socket');
  assert.throws(() => resolvePtyHostMode(false, { AI_SM_PTY_HOST: 'tmux' }), /must be 'inproc' or unset/);
});

test('a frame of exactly the cap is read whole; the cap is the payload, not the payload plus one', () => {
  const id = randomUUID();
  const head = Buffer.alloc(5);
  head.writeUInt32BE(MAX_FRAME_PAYLOAD, 0);
  head.writeUInt8(3, 4); // input: 16-byte id, then text
  const idBytes = Buffer.from(id.replaceAll('-', ''), 'hex');
  const text = 'a'.repeat(MAX_FRAME_PAYLOAD - idBytes.byteLength);
  const frames = new FrameReader().push(Buffer.concat([head, idBytes, Buffer.from(text)]));
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0], { kind: 'input', id, text });
});

test('no text piece is longer than its limit, the last one included', () => {
  for (const len of [10, 11, 19, 20, 21]) {
    const pieces = utf8Pieces(Buffer.from('a'.repeat(len)), 10);
    for (const p of pieces) assert.ok(p.byteLength <= 10, `${len} bytes: a piece of ${p.byteLength}`);
    assert.equal(pieces.reduce((n, p) => n + p.byteLength, 0), len, `${len} bytes: nothing lost`);
  }
});

test('only a lowercase dashed uuid is a session id', () => {
  const ok = randomUUID();
  assert.equal(isSessionUuid(ok), true, ok);
  for (const bad of [
    ok.toUpperCase(),
    ok.replaceAll('-', ''),
    '0'.repeat(36),
    `${ok.slice(0, 8)}${ok.slice(9, 10)}-${ok.slice(10)}`, // a dash moved by one
    `{${ok}}`,
    `${ok}\n`,
    42,
    undefined,
  ]) {
    assert.equal(isSessionUuid(bad), false, JSON.stringify(bad));
  }
});

test('an upper-case uuid is a claude conversation id but never a pty-host session id', () => {
  const lower = randomUUID();
  const upper = lower.toUpperCase();
  assert.equal(isUuid(upper), true, 'conversation.ts isUuid takes any case');
  assert.equal(isUuid(lower), true, 'conversation.ts isUuid takes lower case');
  assert.equal(isSessionUuid(upper), false, 'the wire id does not round-trip upper case');
  assert.equal(isSessionUuid(lower), true, 'the wire id is lower case');
});

test('every field of every client message is checked: one wrong field makes the message unknown', () => {
  const id = randomUUID();
  const good: Record<string, Record<string, unknown>> = {
    hello: { t: 'hello', proto: 1, token: 't', role: 'probe', takeover: true },
    spawn: { t: 'spawn', id, file: 'bash', argv: ['-l'], cwd: '/', env: { A: 'b' }, cols: 80, rows: 24, meta: 'm' },
    snapshot: { t: 'snapshot', req: 0xffffffff, id },
    resize: { t: 'resize', id, cols: 0xffff, rows: 1 },
    kill: { t: 'kill', id, mode: 'ladder' },
    'set-meta': { t: 'set-meta', id, meta: '' },
    forget: { t: 'forget', id },
    list: { t: 'list', req: 0 },
    'list-count': { t: 'list-count', req: 1 },
    'shutdown-if-empty': { t: 'shutdown-if-empty', req: 2 },
    'shutdown-all': { t: 'shutdown-all' },
    detach: { t: 'detach' },
  };
  for (const [name, msg] of Object.entries(good)) assert.deepEqual(parseClientMessage(msg), msg, `well-formed ${name}`);
  const bad: [string, string, unknown][] = [
    ['hello', 'proto', '1'],
    ['hello', 'token', 7],
    ['spawn', 'file', 7],
    ['spawn', 'cwd', null],
    ['spawn', 'env', ['A=b']],
    ['spawn', 'env', null],
    ['spawn', 'cols', 1.5],
    ['snapshot', 'req', 2 ** 32],
    ['snapshot', 'req', undefined],
    ['snapshot', 'id', 'x'],
    ['resize', 'cols', 0x10000],
    ['resize', 'rows', 0],
    ['resize', 'id', 'x'],
    ['kill', 'id', 'x'],
    ['set-meta', 'meta', 5],
    ['set-meta', 'id', 'x'],
    ['forget', 'id', 'x'],
    ['forget', 'id', undefined],
    ['list', 'req', 1.5],
    ['list', 'req', 2 ** 53],
    ['list-count', 'req', '1'],
    ['shutdown-if-empty', 'req', undefined],
  ];
  for (const [name, field, value] of bad) {
    assert.equal(parseClientMessage({ ...good[name], [field]: value }), undefined, `${name} with ${field} = ${JSON.stringify(value)}`);
  }
});

test('every field of every host message is checked: one wrong field makes the message unknown', () => {
  const id = randomUUID();
  const entry = { id, pid: 10, cols: 80, rows: 24, endOffset: 5, exit: { code: 0, signal: 1, at: 2 }, meta: 'm' };
  const good: Record<string, Record<string, unknown>> = {
    welcome: { t: 'welcome', proto: 1, build: 'b', pid: 3, startedAt: 'now' },
    refuse: { t: 'refuse', reason: 'owner-busy', proto: 1 },
    spawned: { t: 'spawned', id, pid: 4 },
    'spawn-error': { t: 'spawn-error', id, cls: 'Error' },
    exit: { t: 'exit', id, code: -1, signal: null, at: 0 },
    'list-part': { t: 'list-part', req: 1, entries: [entry, { ...entry, exit: null, meta: null }], done: false },
    count: { t: 'count', req: 1, total: 2, running: 1 },
    emptied: { t: 'emptied', req: 1, done: true },
    bye: { t: 'bye', reason: 'orphan' },
  };
  for (const [name, msg] of Object.entries(good)) assert.deepEqual(parseHostMessage(msg), msg, `well-formed ${name}`);
  const bad: [string, string, unknown][] = [
    ['welcome', 'proto', '1'],
    ['welcome', 'build', 1],
    ['welcome', 'pid', -1],
    ['welcome', 'startedAt', 0],
    ['refuse', 'reason', 'whim'],
    ['refuse', 'proto', undefined],
    ['spawned', 'pid', -1],
    ['spawned', 'id', 'x'],
    ['spawn-error', 'cls', 1],
    ['exit', 'code', 1.5],
    ['exit', 'code', '0'],
    ['exit', 'at', -1],
    ['exit', 'id', 'x'],
    ['list-part', 'req', -1],
    ['list-part', 'done', 'yes'],
    ['list-part', 'entries', 'none'],
    ['list-part', 'entries', [{ ...entry, meta: 5 }]],
    ['list-part', 'entries', [{ ...entry, pid: -1 }]],
    ['list-part', 'entries', [{ ...entry, cols: 0 }]],
    ['list-part', 'entries', [{ ...entry, endOffset: -1 }]],
    ['list-part', 'entries', [{ ...entry, exit: { code: 'x', signal: null, at: 0 } }]],
    ['list-part', 'entries', [entry, null]],
    ['count', 'total', -1],
    ['count', 'running', '1'],
    ['emptied', 'done', 'yes'],
  ];
  for (const [name, field, value] of bad) {
    assert.equal(parseHostMessage({ ...good[name], [field]: value }), undefined, `${name} with ${field} = ${JSON.stringify(value)}`);
  }
});

test('a data dir of another uid, or with any mode but 0700, is refused', { skip: SKIP_IF_ROOT }, async () => {
  const root = await makeTempDir('pty-host-dir-');
  dirs.push(root);
  const ok = join(root, 'ok');
  await mkdir(ok, { mode: 0o700 });
  // No test can chown: the uid this process reports is moved instead.
  const uid = process.getuid?.() ?? 0;
  const getuid = mock.method(process as { getuid: () => number }, 'getuid', () => uid + 1) // getuid is optional in the types (absent on Windows); present on Linux;
  try {
    assert.match(dataDirRefusal(ok) ?? '', /The data directory belongs to another user\./);
  } finally {
    getuid.mock.restore();
  }
  for (const mode of [0o500, 0o600, 0o711, 0o701]) {
    const dir = join(root, `m${mode.toString(8)}`);
    await mkdir(dir);
    await chmod(dir, mode);
    assert.match(dataDirRefusal(dir) ?? '', new RegExp(`mode ${mode.toString(8)}, not 700`), mode.toString(8));
  }
});

test('a private file is refused for any mode but 0600, an owner-only 0400 included', () => {
  const st = (mode: number) => ({ uid: 7, mode, isFile: () => true, isSocket: () => false });
  for (const mode of [0o400, 0o700, 0o640]) {
    for (const kind of ['state file', 'lock name file'] as const) {
      assert.match(ownedRefusal(kind, st(0o100000 | mode), 7) ?? '', new RegExp(`mode ${mode.toString(8)}, not 600`), `${kind} ${mode.toString(8)}`);
    }
  }
});

test('the client finds nothing to connect to without a state file or a socket, and refuses a socket path that is no socket', async () => {
  const dir = await makeTempDir('pty-host-conn-');
  dirs.push(dir);
  await chmod(dir, 0o700);
  const paths = ptyHostPaths(dir);
  assert.equal(connectRefusal(dir), 'No pty-host state file in the data directory.');
  writeFileSync(paths.stateFile, '{}', { mode: 0o600 });
  assert.equal(connectRefusal(dir), 'No pty-host socket in the data directory.');
  writeFileSync(paths.socket, '', { mode: 0o600 });
  assert.equal(connectRefusal(dir), 'The pty-host socket is not a socket.');
});

test('the state file is read only when it is a 0600 regular file of ours with a well-formed body', { skip: SKIP_IF_ROOT }, async () => {
  const dir = await makeTempDir('pty-host-state-');
  dirs.push(dir);
  await chmod(dir, 0o700);
  const path = ptyHostPaths(dir).stateFile;
  const body = { pid: 4242, startedAt: 'x', proto: 1, build: 'b', appDir: '/', token: 'tok' };
  const put = (v: unknown): void => {
    rmSync(path, { force: true });
    writeFileSync(path, JSON.stringify(v), { mode: 0o600 });
  };
  put(body);
  assert.deepEqual(readPtyHostFile(dir), body, 'the well-formed file');
  for (const [name, v] of [
    ['pid 1 (init is never ours)', { ...body, pid: 1 }],
    ['pid 1.5', { ...body, pid: 1.5 }],
    ['an empty token', { ...body, token: '' }],
    ['no appDir', { ...body, appDir: undefined }],
  ] as const) {
    put(v);
    assert.equal(readPtyHostFile(dir), undefined, name);
  }
  put(body);
  await chmod(path, 0o644);
  assert.equal(readPtyHostFile(dir), undefined, 'mode 0644');
  await chmod(path, 0o600);
  const uid = process.getuid?.() ?? 0;
  const getuid = mock.method(process as { getuid: () => number }, 'getuid', () => uid + 1) // getuid is optional in the types (absent on Windows); present on Linux;
  try {
    assert.equal(readPtyHostFile(dir), undefined, 'another uid');
  } finally {
    getuid.mock.restore();
  }
  const real = `${path}.real`;
  renameSync(path, real);
  symlinkSync(real, path);
  assert.equal(readPtyHostFile(dir), undefined, 'a link to a good file');
});

test('the lock secret: 0600 under any umask, ours only, exactly 32 hex digits', { skip: SKIP_IF_ROOT }, async () => {
  const dir = await makeTempDir('pty-host-lock-');
  dirs.push(dir);
  await chmod(dir, 0o700);
  const path = ptyHostPaths(dir).lockName;
  const old = process.umask(0o277); // would leave a fresh 0600 file at 0400
  let secret: string;
  try {
    secret = lockSecret(dir);
  } finally {
    process.umask(old);
  }
  assert.equal(statSync(path).mode & 0o777, 0o600, 'the file the reader accepts');
  assert.equal(lockSecret(dir), secret, 'and it reads it back');

  const uid = process.getuid?.() ?? 0;
  const getuid = mock.method(process as { getuid: () => number }, 'getuid', () => uid + 1) // getuid is optional in the types (absent on Windows); present on Linux;
  try {
    assert.throws(() => lockSecret(dir), /lock name file belongs to another user/);
  } finally {
    getuid.mock.restore();
  }
  for (const body of [`${'a'.repeat(32)}0`, `x${'a'.repeat(32)}`, 'A'.repeat(32)]) {
    rmSync(path);
    writeFileSync(path, `${body}\n`, { mode: 0o600 });
    assert.throws(() => lockSecret(dir), /lock name file is malformed/, body);
  }
});

test('the build a host reports is the starter\'s when it is a plain short name, else `unknown`', () => {
  assert.equal(resolveHostBuild({ AI_SM_PTY_HOST_BUILD: 'v0.4.3+abc_1-rc.2' }), 'v0.4.3+abc_1-rc.2');
  assert.equal(resolveHostBuild({}), 'unknown');
  for (const raw of ['', 'a b', 'x'.repeat(65), 'v1\nforged line', '../etc']) {
    assert.equal(resolveHostBuild({ AI_SM_PTY_HOST_BUILD: raw }), 'unknown', JSON.stringify(raw));
  }
});

test('a bad frame after good ones in one chunk: the error carries the good frames, in order', () => {
  const id = randomUUID();
  const bad = Buffer.alloc(5 + 2);
  bad.writeUInt32BE(2, 0);
  bad.writeUInt8(9, 4); // unknown kind
  const chunk = Buffer.concat([encodeControl({ t: 'bye', reason: 'idle' }), ...encodeOutput(id, 3, Buffer.from('ok')), bad]);
  let caught: unknown;
  try {
    new FrameReader().push(chunk);
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof WireError, 'still a wire error');
  assert.deepEqual(caught.frames, [
    { kind: 'control', message: { t: 'bye', reason: 'idle' } },
    { kind: 'output', id, offset: 3, text: 'ok', bytes: Buffer.from('ok') },
  ]);
});
