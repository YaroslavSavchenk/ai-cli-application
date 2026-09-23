/**
 * PUT /api/fs/upload — a LIVE upload and the route's edges (Nocturne B10
 * phase 1, `.claude/plans/nocturne/PLAN-B10.md` §2): the content-type matched
 * case-insensitively, a duplicated query parameter, an unwritable destination,
 * a path past PATH_MAX, a `dir` that is a file, the in-flight
 * `.upload-<32 hex>.part` name, the landed file's mode, a refusal that reaches
 * the client while the body is still going out, an unauthenticated chunked
 * upload, the log levels, and a 5xx's log line.
 *
 * One real server child on a fixture `home` (AI_SM_HOME_OVERRIDE,
 * `tests/helpers/fs-server-fixture.ts`). A live upload writes its request head
 * and its body in pieces the test controls over a raw socket, so the response
 * and the socket's end are two separate observations; the 5xx case calls
 * `handleUpload` in-process with injected deps (no fixture 5xx exists). Split
 * out of `fs-upload.test.ts` (restructure O6).
 *
 * NOT claimed: a browser's drop or paste; a drvfs mount or Windows.
 *
 * Example paths in comments are `/home/you/...`, never anyone's real one.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { connect, type Socket } from 'node:net';
import { join } from 'node:path';
import { handleUpload } from '../../server/fsupload.ts';
import { readServerLog, waitForLog, waitUntil, SKIP_IF_ROOT } from '../helpers/helpers.ts';
import {
  bootFsServer,
  evil,
  home,
  server,
  stopFsServer,
  work,
} from '../helpers/fs-server-fixture.ts';
import { exchange, head, parts, put, q } from '../helpers/fs-upload-fixture.ts';

before(() => bootFsServer('ai-sm-fsup-'));

after(() => stopFsServer());

// ---------------------------------------------------------------------------
// A LIVE upload: the request head goes out, the body is written in pieces the
// test controls, and the response and the socket's end are two separate
// observations. Needed for the cases the all-in-one `exchange()` cannot see:
// the in-flight `.part` file, and what a refusal does to a connection that is
// still streaming a body into it.
// ---------------------------------------------------------------------------

interface LiveUpload {
  socket: Socket;
  /** Queue body bytes behind the request head. Never throws on a dead socket. */
  write: (chunk: Buffer) => void;
  /** The complete response (head + its content-length body). */
  response: Promise<{ status: number; head: string; body: string }>;
  /** Resolves when the server closed or destroyed the connection. */
  closed: Promise<void>;
}

function startUpload(requestHead: string): LiveUpload {
  const socket = connect(server.port, '127.0.0.1');
  // An RST from the server's hard destroy is an expected outcome here, not a
  // test failure: it is what one of these cases measures.
  socket.on('error', () => {});
  let raw = Buffer.alloc(0);
  let settle: (value: { status: number; head: string; body: string }) => void = () => {};
  let fail: (err: Error) => void = () => {};
  const response = new Promise<{ status: number; head: string; body: string }>(
    (resolve, reject) => {
      settle = resolve;
      fail = reject;
    },
  );
  const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
  let queue = new Promise<void>((resolve) => socket.once('connect', () => resolve())).then(() => {
    socket.write(requestHead);
  });

  socket.on('data', (chunk: Buffer) => {
    raw = Buffer.concat([raw, chunk]);
    const text = raw.toString('utf8');
    const split = text.indexOf('\r\n\r\n');
    if (split === -1) return;
    const headText = text.slice(0, split).toLowerCase();
    const body = text.slice(split + 4);
    const length = /content-length: *(\d+)/i.exec(headText)?.[1];
    if (length !== undefined && Buffer.byteLength(body) < Number(length)) return;
    settle({ status: Number(headText.split(' ')[1] ?? '0'), head: headText, body });
  });
  socket.on('close', () => {
    // A no-op once the response has resolved; the message is what a LOST
    // response looks like (an instant destroy RSTs the unread 413 away).
    fail(new Error(`the connection closed with no complete response: ${JSON.stringify(raw.toString('utf8'))}`));
  });

  return {
    socket,
    write: (chunk: Buffer): void => {
      queue = queue.then(
        () =>
          new Promise<void>((resolve) => {
            if (socket.destroyed || socket.writableEnded) {
              resolve();
              return;
            }
            socket.write(chunk, () => resolve());
          }),
      );
    },
    response,
    closed,
  };
}

/** Reject after `ms` — every wait in these tests has an explicit deadline. */
function deadline<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) =>
      setTimeout(() => reject(new Error(`timed out after ${ms}ms waiting for ${what}`)), ms).unref(),
    ),
  ]);
}

test('the content-type is matched case-insensitively, parameters and spacing included', async () => {
  // `application/octet-stream` is what a browser's Blob sends, but the header
  // is a case-insensitive token with optional whitespace around its parameters
  // — a client that upper-cases it is sending the very same type.
  for (const contentType of [
    'APPLICATION/OCTET-STREAM',
    'Application/Octet-Stream',
    'application/octet-stream ; charset=binary',
    'application/octet-stream;charset=binary',
  ]) {
    const res = await put(work(), 'casing.bin', 'replace', Buffer.from('x'), { contentType });
    assert.equal(res.status, 201, `content-type ${contentType} -> ${JSON.stringify(res.body)}`);
  }
});

test('a duplicated query parameter resolves to the FIRST value', async () => {
  // `.get()`'s documented behaviour, and the reason a second `?dir=` cannot
  // smuggle a destination past the one that was checked.
  const query =
    `dir=${encodeURIComponent(work())}&rel=first.bin&mode=new` +
    `&dir=${encodeURIComponent(evil)}&rel=second.bin&mode=replace`;
  const res = await fetch(`${server.baseUrl}/api/fs/upload?${query}`, {
    method: 'PUT',
    headers: { 'x-auth-token': server.token, 'content-type': 'application/octet-stream' },
    body: new Blob([new Uint8Array(Buffer.from('FIRST\n'))]),
  });
  assert.equal(res.status, 201, await res.text());
  assert.equal(await readFile(join(work(), 'first.bin'), 'utf8'), 'FIRST\n');
  assert.equal(existsSync(join(evil, 'first.bin')), false, 'the second `dir` was never used');
  assert.equal(existsSync(join(evil, 'second.bin')), false);
  assert.equal(existsSync(join(work(), 'second.bin')), false, 'nor the second `rel`');
});

test('an unwritable destination is a 403, never a 500', {
  skip: SKIP_IF_ROOT,
}, async () => {
  const readonly = join(home, 'readonly-upload');
  await mkdir(readonly);
  await chmod(readonly, 0o500);
  try {
    const res = await put(readonly, 'denied.bin', 'new', Buffer.from('x'));
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.deepEqual(res.body, { error: 'You do not have permission to create it here.' });
    assert.deepEqual(parts(readonly), [], 'and no part file was left behind');
    // A refusal, not a server fault: nothing on the error channel.
    assert.ok(!(await readServerLog(server)).includes('fs upload failed'));
  } finally {
    await chmod(readonly, 0o700);
  }
});

test('a path longer than PATH_MAX is a 400 with the NAME sentence, not a 500', async () => {
  // Every segment is inside the 255-BYTE name limit, so splitRel accepts the
  // shape and the kernel is the one that refuses it: 30 × 250 characters is
  // past PATH_MAX, and mkdir answers ENAMETOOLONG around level 16. That is a
  // name the client sent, so it must read as a 400 — not as this server
  // failing.
  const deep = 'deep-path';
  const rel = [deep, ...Array.from({ length: 30 }, () => 'x'.repeat(250)), 'leaf.bin'].join('/');
  const res = await put(work(), rel, 'new', Buffer.from('x'));
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.deepEqual(res.body, { error: 'That name is not allowed.' });
  assert.ok(!(await readServerLog(server)).includes('fs upload failed'), 'not a 5xx either');
  await rm(join(work(), deep), { recursive: true, force: true });
});

test('a `dir` that is a FILE is 404 even when `rel` has folders in it', async () => {
  // The destination is checked as a DIRECTORY before the mkdir loop starts, so
  // this is a vanished destination (404), never a name clash (409) reported
  // per level and never an ENOTDIR that reaches the generic 500.
  const file = join(work(), 'dir-is-a-file.txt');
  await writeFile(file, 'A FILE\n');
  for (const rel of ['x.bin', 'a/x.bin', 'a/b/x.bin']) {
    const res = await put(file, rel, 'new', Buffer.from('x'));
    assert.equal(res.status, 404, `rel ${rel} -> ${JSON.stringify(res.body)}`);
    assert.deepEqual(res.body, { error: 'That folder is no longer there.' });
  }
  assert.equal(await readFile(file, 'utf8'), 'A FILE\n', 'untouched');
});

test('the in-flight temp file is `.upload-<32 hex>.part` — unguessable, never a fixed name', async () => {
  // O_EXCL and O_NOFOLLOW on that file only buy anything because nobody can
  // guess the name to pre-plant it, so the SHAPE of the name is the property
  // worth pinning. Two uploads are held open at once: both part files exist at
  // the same instant, and they must differ.
  const total = 4096;
  const body = Buffer.alloc(total, 0x42);
  const live = [0, 1].map((i) =>
    startUpload(
      head(q(work(), `slow${i}.bin`), [
        'content-type: application/octet-stream',
        `content-length: ${total}`,
      ]),
    ),
  );
  try {
    for (const upload of live) upload.write(body.subarray(0, 16));
    const names = await waitUntil(
      async () => {
        const found = parts(work());
        return found.length === 2 ? found : undefined;
      },
      'two in-flight .part files',
      5_000,
      10,
    );
    for (const name of names) {
      assert.match(name, /^\.upload-[0-9a-f]{32}\.part$/, `${name} is a random temp name`);
    }
    assert.notEqual(names[0], names[1], 'two uploads never share a temp name');

    for (const upload of live) upload.write(body.subarray(16));
    for (const [i, upload] of live.entries()) {
      const res = await deadline(upload.response, 10_000, `upload ${i} to answer`);
      assert.equal(res.status, 201, res.body);
    }
    assert.deepEqual(parts(work()), [], 'and both part files are gone afterwards');
    assert.equal((await stat(join(work(), 'slow0.bin'))).size, total);
  } finally {
    for (const upload of live) upload.socket.destroy();
  }
});

test('a landed file has ordinary user permissions — 0666 minus the umask, not 0600', async () => {
  // Plan §2 step 7: these are the user's files, not secrets. The reference is a
  // file this test creates with the same 0666 request, so the assertion holds
  // whatever umask the suite runs under.
  const reference = join(work(), 'reference-mode.bin');
  await writeFile(reference, 'x', { mode: 0o666 });
  assert.equal((await put(work(), 'modes.bin', 'new', Buffer.from('x'))).status, 201);
  assert.equal(
    (await stat(join(work(), 'modes.bin'))).mode & 0o777,
    (await stat(reference)).mode & 0o777,
    'the uploaded file is as readable as any file the user creates',
  );
});

test('a refusal reaches the client while the body is still going out', async () => {
  // Every refusal of this route is decided before a byte of the body is read,
  // and an 8 MiB body is far past what the socket buffers hold — so this is the
  // case the `connection: close` + explicit content-length framing exists for:
  // the client must read the SENTENCE, not a broken pipe, and the upload must
  // stop there instead of pushing the rest into a server that said no.
  await writeFile(join(work(), 'big-clash.bin'), 'ORIGINAL\n');
  const res = await put(work(), 'big-clash.bin', 'new', Buffer.alloc(8 * 1024 * 1024, 0x43));
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.deepEqual(res.body, { error: 'Something with that name already exists here.' });
  assert.equal(await readFile(join(work(), 'big-clash.bin'), 'utf8'), 'ORIGINAL\n', 'untouched');
  assert.deepEqual(parts(work()), [], 'and the refusal never made a part file');
});

test('an unauthenticated CHUNKED upload is 401 and the connection is ended', async () => {
  // A chunked body has no declared length, so "how much would this server
  // drain?" has no answer at all — the gate must close on it exactly as it
  // closes on a declared 50 MiB.
  const result = await exchange(
    `PUT /api/fs/upload?${q(work(), 'noauth-chunked.bin')} HTTP/1.1\r\n` +
      `host: 127.0.0.1:${server.port}\r\n` +
      'content-type: application/octet-stream\r\n' +
      'transfer-encoding: chunked\r\n\r\n',
    { body: Buffer.from('5\r\nhello\r\n0\r\n\r\n'), sendBody: false },
  );
  assert.equal(result.status, 401, result.body);
  assert.deepEqual(JSON.parse(result.body), { error: 'unauthorized' });
  assert.ok(result.head.includes('connection: close'), 'the connection is ended');
  assert.equal(result.closed, true);
  assert.equal(existsSync(join(work(), 'noauth-chunked.bin')), false);
});

test('the log LEVELS are the 2026-09-20 decision: a 2xx is quiet, a refusal is not', async () => {
  // A 2000-file drop writes one line per file on each channel. The [fs] line is
  // debug for EVERY status (the access log already carries the refusal at info,
  // and a 2000-row 409 storm at info would bury the file); the access line is
  // debug for a 2xx only, because a refusal there is the diagnostic.
  assert.equal((await put(work(), 'levels.bin', 'new', Buffer.from('x'))).status, 201);
  assert.equal((await put(work(), 'levels.bin', 'new', Buffer.from('x'))).status, 409);
  await waitForLog(server, '[http] PUT /api/fs/upload ?… -> 409');
  const log = await readServerLog(server);

  assert.ok(log.includes('[debug] [fs] PUT /api/fs/upload -> 201'), 'the [fs] 2xx line is debug');
  assert.ok(log.includes('[debug] [fs] PUT /api/fs/upload -> 409'), 'and so is the [fs] 4xx line');
  assert.ok(!log.includes('[info] [fs] PUT /api/fs/upload ->'), 'never info on the [fs] channel');
  assert.ok(
    log.includes('[debug] [http] PUT /api/fs/upload ?… -> 201'),
    'a successful upload is quiet in the access log',
  );
  assert.ok(
    log.includes('[info] [http] PUT /api/fs/upload ?… -> 409'),
    'a refused one is not — that line is the diagnostic',
  );
});

test('a 5xx logs the error CLASS and its FRAMES — never the message, which quotes paths', async () => {
  // The only 5xx this route can be MADE to take in a test is an injected one:
  // every errno the filesystem hands it maps to a 4xx. handleUpload takes its
  // world as `deps` precisely so that seam is reachable — no HTTP, no fixture.
  const secret = '/home/you/Documents/PATHLEAKCANARY_9x/notes.txt';
  const lines: string[] = [];
  const answers: { status: number; message: string }[] = [];
  await handleUpload(
    {
      method: 'PUT',
      headers: { 'content-length': '4', 'content-type': 'application/octet-stream' },
    } as unknown as IncomingMessage,
    {} as unknown as ServerResponse,
    new URL(
      `http://127.0.0.1/api/fs/upload?dir=${encodeURIComponent(work())}&rel=x.bin&mode=new`,
    ),
    {
      projects: (): string[] => {
        throw new Error(secret);
      },
      log: (level, message) => lines.push(`[${level}] ${message}`),
      sendJson: () => assert.fail('a failure must not answer 2xx'),
      sendErrorAndClose: (_res, status, message) => answers.push({ status, message }),
    },
  );

  assert.deepEqual(answers, [{ status: 500, message: 'The app could not copy that file.' }]);
  const errors = lines.filter((line) => line.startsWith('[error]'));
  assert.equal(errors.length, 1, `exactly one error line per 5xx, got ${JSON.stringify(lines)}`);
  assert.ok(errors[0]?.includes('(Error)'), 'the error CLASS is in it');
  assert.match(errors[0] ?? '', / at /, 'and its stack FRAMES');
  assert.ok(
    !lines.join('\n').includes('PATHLEAKCANARY'),
    `the error MESSAGE never reaches a log line: ${JSON.stringify(lines)}`,
  );
});
