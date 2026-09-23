/**
 * PUT /api/fs/upload — the real file write behind drop / paste / `Copy files
 * here…` (Nocturne B10 phase 1, `.claude/plans/nocturne/PLAN-B10.md` §2): the
 * route over fetch and over a raw socket, and its two pure helpers.
 *
 * One real server child on a fixture `home` (AI_SM_HOME_OVERRIDE, the seam
 * tests/server/fs-create.test.ts and tests/server/fs-entries.test.ts use;
 * `tests/helpers/fs-server-fixture.ts`), so the boundary, the post-mkdir
 * realpath re-check, O_NOFOLLOW, the rename/link publish and the "refuse
 * before reading a byte" header rules are exercised against a real kernel, a
 * real socket and a real server.log.
 *
 * The hostile shapes (no content-length, chunked, an over-cap length whose body
 * is never sent, a body that stops short) are driven over a RAW SOCKET
 * (`exchange` in `tests/helpers/fs-upload-fixture.ts`): the fetch/undici client
 * refuses to send a body that disagrees with its own content-length, which is
 * exactly what those cases need.
 *
 * Topic piece: a live upload the test streams, and the route's remaining
 * edges, in `fs-upload-edges.test.ts`.
 *
 * NOT claimed: a browser's drop or paste (the UI tests drive a fake gateway);
 * a drvfs mount or Windows.
 *
 * Example paths in comments are `/home/you/...`, never anyone's real one.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { lstat, mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseContentLength, splitRel } from '../../server/fsupload.ts';
import type { FsUploadResponse, Project } from '../../shared/protocol.ts';
import { MAX_UPLOAD_BYTES } from '../../shared/protocol.ts';
import { api, readServerLog, waitForLog, waitUntil } from '../helpers/helpers.ts';
import {
  bootFsServer,
  dataDir,
  evil,
  home,
  outside,
  root,
  server,
  stopFsServer,
  work,
} from '../helpers/fs-server-fixture.ts';
import { exchange, head, parts, put, q } from '../helpers/fs-upload-fixture.ts';

/** A file name the user "dropped": it must NEVER reach server.log. */
const NAME_CANARY = 'UPLOADNAMECANARY_qz.bin';
/** Bytes of a dropped file: they must never reach server.log either. */
const BYTES_CANARY = 'UPLOADBYTESCANARY_7f3d';

const sha = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

before(() => bootFsServer('ai-sm-fsup-'));

after(() => stopFsServer());

/** The handler's own line for an incomplete upload (400). */
const INCOMPLETE_LINE = '[fs] PUT /api/fs/upload -> 400';

// ---------------------------------------------------------------------------

test('a file lands byte-identical and answers 201 { bytes }', async () => {
  const body = Buffer.concat([
    Buffer.from('héllo — unicode, and a NUL:\0 plus binary: '),
    Buffer.from([0x00, 0xff, 0x7f, 0x80, 0x0a, 0x0d]),
    Buffer.from('é'.repeat(1000)),
  ]);
  const res = await put(work(), 'landed.bin', 'new', body);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.deepEqual(res.body, { bytes: body.byteLength } satisfies FsUploadResponse);

  const landed = await readFile(join(work(), 'landed.bin'));
  assert.equal(sha(landed), sha(body), 'byte-identical on disk');
  assert.equal(landed.byteLength, body.byteLength);
  assert.deepEqual(parts(work()), [], 'and no .part file survives a success');
});

test('a 0-byte file is a file — 201 { bytes: 0 }', async () => {
  const res = await put(work(), 'empty.bin', 'new', new Uint8Array(0));
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.deepEqual(res.body, { bytes: 0 });
  assert.equal((await stat(join(work(), 'empty.bin'))).size, 0);
});

test('`rel` with subfolders creates every intermediate folder', async () => {
  const body = Buffer.from('deep\n');
  const res = await put(work(), 'a/b/c/deep.txt', 'new', body);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(await readFile(join(work(), 'a', 'b', 'c', 'deep.txt'), 'utf8'), 'deep\n');
  assert.ok((await stat(join(work(), 'a', 'b'))).isDirectory());

  // A second file merges into the folders that are already there (D2).
  assert.equal((await put(work(), 'a/b/c/second.txt', 'new', Buffer.from('2'))).status, 201);

  // Depth: 64 segments is the last accepted shape, 65 is a refusal.
  const ok = [...Array.from({ length: 63 }, (_, i) => `d${i}`), 'leaf.txt'].join('/');
  assert.equal((await put(work(), ok, 'new', body)).status, 201, '64 segments');
  const tooDeep = [...Array.from({ length: 64 }, (_, i) => `e${i}`), 'leaf.txt'].join('/');
  const deep = await put(work(), tooDeep, 'new', body);
  assert.equal(deep.status, 400, '65 segments');
  assert.deepEqual(deep.body, { error: 'That name is not allowed.' });
  assert.equal(existsSync(join(work(), 'e0')), false, 'and not one folder of it was created');
});

test('`replace` overwrites, `new` answers 409 — and never truncates what is there', async () => {
  await writeFile(join(work(), 'clash.txt'), 'ORIGINAL\n');
  const refused = await put(work(), 'clash.txt', 'new', Buffer.from('REPLACEMENT\n'));
  assert.equal(refused.status, 409);
  assert.deepEqual(refused.body, { error: 'Something with that name already exists here.' });
  assert.equal(await readFile(join(work(), 'clash.txt'), 'utf8'), 'ORIGINAL\n', 'untouched');
  assert.deepEqual(parts(work()), [], 'and the part file is gone');

  const replaced = await put(work(), 'clash.txt', 'replace', Buffer.from('REPLACEMENT\n'));
  assert.equal(replaced.status, 201, JSON.stringify(replaced.body));
  assert.equal(await readFile(join(work(), 'clash.txt'), 'utf8'), 'REPLACEMENT\n');

  // `new` over a FOLDER of that name is the same refusal.
  await mkdir(join(work(), 'folder-clash'));
  assert.equal((await put(work(), 'folder-clash', 'new', Buffer.from('x'))).status, 409);
});

test('a symlinked TARGET is REPLACED, never written through', async () => {
  // `/home/you/work/notes.txt -> /etc/passwd` in the real world; here the
  // victim is a file outside the fixture home that must survive untouched.
  const victim = join(evil, 'victim.txt');
  await writeFile(victim, 'VICTIM\n');
  const link = join(work(), 'planted.txt');
  await symlink(victim, link);

  const res = await put(work(), 'planted.txt', 'replace', Buffer.from('FROM THE BROWSER\n'));
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(await readFile(victim, 'utf8'), 'VICTIM\n', 'the victim file is untouched');
  assert.equal((await lstat(link)).isSymbolicLink(), false, 'the LINK itself was replaced');
  assert.equal(await readFile(link, 'utf8'), 'FROM THE BROWSER\n');

  // `new` meets a link — including a DANGLING one — as a taken name.
  await symlink(join(evil, 'nothing-here.txt'), join(work(), 'dangling.txt'));
  const nw = await put(work(), 'dangling.txt', 'new', Buffer.from('x'));
  assert.equal(nw.status, 409, JSON.stringify(nw.body));
  assert.equal(existsSync(join(evil, 'nothing-here.txt')), false, 'nothing created through it');
});

test('a symlinked INTERMEDIATE folder pointing outside is refused by the re-check', async () => {
  // mkdir on an existing symlink answers EEXIST, so without the post-mkdir
  // realpath re-check the write would land wherever the link points.
  await symlink(evil, join(work(), 'escape'));
  const res = await put(work(), 'escape/out.bin', 'new', Buffer.from('ESCAPED\n'));
  assert.equal(res.status, 403, JSON.stringify(res.body));
  assert.deepEqual(res.body, { error: 'This folder is outside your home folder.' });
  assert.equal(existsSync(join(evil, 'out.bin')), false, 'nothing landed out there');
  assert.deepEqual(parts(evil), [], 'and no part file either');

  // Two levels down is the same answer.
  assert.equal((await put(work(), 'escape/deeper/out.bin', 'new', Buffer.from('x'))).status, 403);
  assert.equal(existsSync(join(evil, 'deeper')), false);
});

test('the `rel` vocabulary is isSafeSegment plus the 255-BYTE limit, and nothing else', async () => {
  const refused: [string, string][] = [
    ['../escape.txt', 'a .. segment'],
    ['a/../../escape.txt', 'a .. in the middle'],
    ['./here.txt', 'a . segment'],
    ['/abs/path.txt', 'an absolute rel (leading empty segment)'],
    ['a//b.txt', 'an empty segment'],
    ['', 'an empty rel'],
    ['trailing/', 'a trailing slash'],
    ['back\\slash.txt', 'a backslash'],
    ['nul\0name.txt', 'a NUL'],
    ['line\nname.txt', 'a newline'],
    ['x'.repeat(256), '256 characters'],
    ['é'.repeat(150), '300 bytes'],
    ['sub/' + 'é'.repeat(150), '300 bytes in a subfolder'],
    // Percent-decoding bytes that are not valid UTF-8 (`%C0%AF`, the overlong
    // `/`) yields U+FFFD — a name nobody dropped.
    ['\uFFFD\uFFFD', 'a replacement character'],
    ['ok/na\uFFFDme.txt', 'a replacement character in a segment'],
  ];
  for (const [rel, why] of refused) {
    const res = await put(work(), rel, 'new', Buffer.from('NOPE'));
    assert.equal(res.status, 400, `${why} must be 400, got ${res.status}`);
    assert.deepEqual(res.body, { error: 'That name is not allowed.' }, `${why}: the sentence`);
  }
  // The same rule against the RAW query: `%C0%AF` is an overlong `/` that
  // percent-decoding turns into U+FFFD, and a file called `??` is nobody's drop.
  const overlong = await fetch(
    `${server.baseUrl}/api/fs/upload?dir=${encodeURIComponent(work())}&rel=%C0%AFx.bin&mode=new`,
    {
      method: 'PUT',
      headers: { 'x-auth-token': server.token, 'content-type': 'application/octet-stream' },
      body: new Blob([new Uint8Array(Buffer.from('x'))]),
    },
  );
  assert.equal(overlong.status, 400, 'an overlong UTF-8 sequence is not a name');
  assert.equal(
    readdirSync(work()).some((name) => name.includes('\uFFFD')),
    false,
    'and no file with a replacement character was created',
  );

  assert.equal(existsSync(join(root, 'escape.txt')), false, 'no traversal ever landed');
  assert.equal(existsSync(join(home, 'escape.txt')), false);
  assert.deepEqual(parts(work()), [], 'and no part file was created for any of them');

  // The boundary in BYTES from both sides: 127 × 2 = 254 is a name, 128 × 2 = 256 is not.
  assert.equal((await put(work(), 'é'.repeat(127), 'new', Buffer.from('ok'))).status, 201);
  assert.equal((await put(work(), 'é'.repeat(128), 'new', Buffer.from('no'))).status, 400);
  assert.equal((await put(work(), 'y'.repeat(255), 'new', Buffer.from('ok'))).status, 201);
});

test('`dir` is bounded exactly like /api/fs/create — outside home, the data dir, gone, bad', async () => {
  const cases: [string, number, string][] = [
    [evil, 403, 'outside home and every project'],
    ['/etc', 403, 'a system folder'],
    [`${home}/../homeevil`, 403, 'a lexical .. out of home'],
    [dataDir, 403, "the app's own data dir"],
    [join(dataDir, 'session-settings'), 403, 'under the data dir'],
    [join(work(), 'no-such-folder'), 404, 'a destination that is not there'],
    [join(work(), 'clash.txt'), 404, 'a destination that is a FILE'],
    ['relative/path', 400, 'a relative destination'],
    ['', 400, 'an empty destination'],
    [`${home}\0/work`, 400, 'a NUL in the destination'],
  ];
  await mkdir(join(dataDir, 'session-settings'), { recursive: true });
  for (const [dir, status, why] of cases) {
    const res = await put(dir, 'x.bin', 'new', Buffer.from('NOPE'));
    assert.equal(res.status, status, `${why} -> ${res.status} ${JSON.stringify(res.body)}`);
  }
  assert.deepEqual((await put(evil, 'x.bin', 'new', Buffer.from('x'))).body, {
    error: 'This folder is outside your home folder.',
  });
  assert.deepEqual((await put(dataDir, 'x.bin', 'new', Buffer.from('x'))).body, {
    error: "The app's own folder is not a place to create files.",
  });
  assert.equal(existsSync(join(evil, 'x.bin')), false, 'and nothing was written out there');
  assert.equal(existsSync(join(dataDir, 'x.bin')), false);
  assert.deepEqual(parts(dataDir), []);
});

test('no folder is ever CREATED in the data dir on the way to the 403', async () => {
  // The refusal is applied before the first mkdir and after every level, so
  // none of these three routes into the app's own folder can leave a directory
  // behind (2026-09-20 review: with the check on the finished parent only, all
  // three created their folders and only then answered 403).
  const viaDir = await put(dataDir, 'a/b/x.bin', 'new', Buffer.from('NOPE'));
  assert.equal(viaDir.status, 403, JSON.stringify(viaDir.body));
  assert.deepEqual(viaDir.body, { error: "The app's own folder is not a place to create files." });
  assert.equal(existsSync(join(dataDir, 'a')), false, 'nothing was created in the data dir');

  const viaHome = await put(home, '.ai-session-manager/via-home/deeper/x.bin', 'new', Buffer.from('NOPE'));
  assert.equal(viaHome.status, 403, JSON.stringify(viaHome.body));
  assert.equal(existsSync(join(dataDir, 'via-home')), false, 'not through home either');

  // A planted symlink into the data dir: mkdir answers EEXIST on the link, and
  // the per-level re-check judges where it really lands.
  const link = join(work(), 'todata');
  if (!existsSync(link)) await symlink(dataDir, link);
  const viaLink = await put(work(), 'todata/via-link/x.bin', 'new', Buffer.from('NOPE'));
  assert.equal(viaLink.status, 403, JSON.stringify(viaLink.body));
  assert.equal(existsSync(join(dataDir, 'via-link')), false, 'and not through a link');
  assert.deepEqual(parts(dataDir), []);
});

test('a registered project OUTSIDE home accepts an upload; unregistering takes it back', async () => {
  assert.equal((await put(outside, 'before.bin', 'new', Buffer.from('x'))).status, 403);
  assert.equal(existsSync(join(outside, 'before.bin')), false);

  const created = await api(server, 'POST', '/api/projects', { name: 'Outside', path: outside });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const project = created.body as Project;
  try {
    const res = await put(outside, 'sub/in-project.bin', 'new', Buffer.from('INSIDE\n'));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(await readFile(join(outside, 'sub', 'in-project.bin'), 'utf8'), 'INSIDE\n');
  } finally {
    assert.equal((await api(server, 'DELETE', `/api/projects/${project.id}`)).status, 200);
  }

  const after_ = await put(outside, 'after.bin', 'new', Buffer.from('x'));
  assert.equal(after_.status, 403, 'removing the project takes the anchor with it');
  assert.equal(existsSync(join(outside, 'after.bin')), false);
});

test('a FILE where a folder must go is 409, not a 500', async () => {
  await writeFile(join(work(), 'afile.txt'), 'A FILE\n');
  const under = await put(work(), 'afile.txt/x.bin', 'new', Buffer.from('x'));
  assert.equal(under.status, 409, JSON.stringify(under.body));
  assert.deepEqual(under.body, { error: 'Something with that name already exists here.' });

  const deeper = await put(work(), 'afile.txt/deeper/x.bin', 'new', Buffer.from('x'));
  assert.equal(deeper.status, 409, JSON.stringify(deeper.body));
  assert.equal(await readFile(join(work(), 'afile.txt'), 'utf8'), 'A FILE\n', 'untouched');
});

test('`mode` must be replace or new; a wrong content-type is 415; GET and POST are 405', async () => {
  for (const mode of ['bogus', '', 'REPLACE', 'merge']) {
    const res = await put(work(), 'mode.bin', mode, Buffer.from('x'));
    assert.equal(res.status, 400, `mode ${JSON.stringify(mode)} must be 400`);
    assert.deepEqual(res.body, { error: 'The app cannot open that folder.' });
  }
  // A missing mode parameter at all.
  const noMode = await fetch(
    `${server.baseUrl}/api/fs/upload?dir=${encodeURIComponent(work())}&rel=m.bin`,
    {
      method: 'PUT',
      headers: { 'x-auth-token': server.token, 'content-type': 'application/octet-stream' },
      body: new Blob([new Uint8Array(Buffer.from('x'))]),
    },
  );
  assert.equal(noMode.status, 400);

  for (const contentType of ['text/plain', 'application/json', 'multipart/form-data', null]) {
    const res = await put(work(), 'type.bin', 'new', Buffer.from('x'), { contentType });
    assert.equal(res.status, 415, `content-type ${String(contentType)} must be 415`);
    assert.deepEqual(res.body, { error: 'The app could not copy that file.' });
  }
  // The parameterised form IS the type.
  assert.equal(
    (await put(work(), 'type-ok.bin', 'new', Buffer.from('x'), {
      contentType: 'application/octet-stream; charset=binary',
    })).status,
    201,
  );

  for (const method of ['GET', 'POST', 'DELETE']) {
    const res = await fetch(`${server.baseUrl}/api/fs/upload?${q(work(), 'x.bin')}`, {
      method,
      headers: { 'x-auth-token': server.token },
    });
    assert.equal(res.status, 405, `${method} must be 405`);
  }
  assert.equal(existsSync(join(work(), 'mode.bin')), false);
  assert.equal(existsSync(join(work(), 'type.bin')), false);
  assert.deepEqual(parts(work()), []);
});

test('a missing token is 401 — the gate is in front of the route', async () => {
  const res = await fetch(`${server.baseUrl}/api/fs/upload?${q(work(), 'noauth.bin')}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream' },
    body: new Blob([new Uint8Array(Buffer.from('x'))]),
  });
  assert.equal(res.status, 401);
  assert.equal(existsSync(join(work(), 'noauth.bin')), false);
});

test('an UNAUTHENTICATED over-cap PUT is 401 and the socket closes before the body is sent', async () => {
  // The token gate answers before the route exists; without the close, Node
  // would drain the 50 MiB the caller declared just to keep the connection
  // alive for a caller it has already refused.
  const result = await exchange(
    `PUT /api/fs/upload?${q(work(), 'noauth-big.bin')} HTTP/1.1\r\n` +
      `host: 127.0.0.1:${server.port}\r\n` +
      'content-type: application/octet-stream\r\n' +
      `content-length: ${MAX_UPLOAD_BYTES}\r\n\r\n`,
    { body: Buffer.alloc(1024), sendBody: false },
  );
  assert.equal(result.status, 401, result.body);
  assert.deepEqual(JSON.parse(result.body), { error: 'unauthorized' });
  assert.equal(result.answeredBeforeBody, true, 'answered without one body byte being sent');
  assert.equal(result.closed, true, 'and the server ended the connection');
  assert.ok(result.head.includes('connection: close'));
  assert.equal(existsSync(join(work(), 'noauth-big.bin')), false);
});

test('no content-length is 411, and so is a chunked body', async () => {
  const noLength = await exchange(
    head(q(work(), 'nolength.bin'), ['content-type: application/octet-stream']),
  );
  assert.equal(noLength.status, 411, noLength.body);
  assert.deepEqual(JSON.parse(noLength.body), { error: 'That file did not arrive completely.' });
  assert.ok(noLength.head.includes('connection: close'), 'the connection is ended');
  assert.equal(existsSync(join(work(), 'nolength.bin')), false);

  const chunked = await exchange(
    head(q(work(), 'chunked.bin'), [
      'content-type: application/octet-stream',
      'transfer-encoding: chunked',
    ]),
    { body: Buffer.from('5\r\nhello\r\n0\r\n\r\n'), sendBody: false },
  );
  assert.equal(chunked.status, 411, chunked.body);
  assert.ok(chunked.head.includes('connection: close'));
  assert.equal(existsSync(join(work(), 'chunked.bin')), false);
  assert.deepEqual(parts(work()), []);
});

test('a content-length over the cap is 413 BEFORE the body is read, and the socket is closed', async () => {
  const declared = MAX_UPLOAD_BYTES + 1;
  const result = await exchange(
    head(q(work(), 'huge.bin'), [
      'content-type: application/octet-stream',
      `content-length: ${declared}`,
    ]),
    { body: Buffer.alloc(1024), sendBody: false }, // the body is NEVER written
  );
  assert.equal(result.status, 413, result.body);
  assert.deepEqual(JSON.parse(result.body), { error: 'That file is larger than the copy limit.' });
  assert.equal(result.answeredBeforeBody, true, 'answered without one body byte being sent');
  assert.equal(result.closed, true, 'and the server ended the connection');
  assert.ok(result.head.includes('connection: close'));
  assert.equal(existsSync(join(work(), 'huge.bin')), false);
  assert.deepEqual(parts(work()), []);

  // Exactly the cap is NOT refused by the header check (the body stops short
  // here, so it dies as an incomplete upload, not as an oversized one).
  const atCap = await exchange(
    head(q(work(), 'atcap.bin'), [
      'content-type: application/octet-stream',
      `content-length: ${MAX_UPLOAD_BYTES}`,
    ]),
    { body: Buffer.alloc(8), halfCloseAfter: 8 },
  );
  assert.equal(atCap.status, 400, atCap.body);
  assert.equal(existsSync(join(work(), 'atcap.bin')), false);
});

test('a malformed content-length is 411 — no sign, no spaces, no hex', async () => {
  // NOT ' 12': HTTP allows optional whitespace around a header value and Node
  // trims it, so that one is a legal 12 and the server would wait for a body.
  for (const value of ['-1', '1.5', '0x10', 'abc', '99999999999999999999']) {
    const result = await exchange(
      head(q(work(), 'badlen.bin'), [
        'content-type: application/octet-stream',
        `content-length: ${value}`,
      ]),
      { body: Buffer.from('x'), sendBody: false },
    );
    assert.ok(
      result.status === 411 || result.status === 400,
      `content-length ${JSON.stringify(value)} -> ${result.status}`,
    );
  }
  assert.equal(existsSync(join(work(), 'badlen.bin')), false);
});

test('a body that stops short is refused and leaves NO .part file behind', async () => {
  const before = (await readServerLog(server)).split(INCOMPLETE_LINE).length - 1;
  const body = Buffer.alloc(4096, 0x41);
  const result = await exchange(
    head(q(work(), 'short.bin'), [
      'content-type: application/octet-stream',
      `content-length: ${body.byteLength}`,
    ]),
    { body, halfCloseAfter: 64 },
  );
  // 400 either way, but WHOSE 400 is not this route's choice: a client that
  // half-closes mid-body makes Node's own parser answer a bare
  // `400 Bad Request` before the handler's JSON reaches the wire (measured,
  // 2026-09-20). The sentence is asserted through the server's own log line
  // below — the handler ran, and the unlink is the point.
  assert.equal(result.status, 400, result.body);
  assert.ok(
    result.body === '' || JSON.parse(result.body).error === 'That file did not arrive completely.',
    `an empty body or the sentence, got ${JSON.stringify(result.body)}`,
  );
  await waitForLog(server, INCOMPLETE_LINE, { count: before + 1 });
  assert.equal(existsSync(join(work(), 'short.bin')), false, 'nothing was published');
  await waitUntil(
    async () => (parts(work()).length === 0 ? true : undefined),
    'the .part file to be unlinked',
    5_000,
    25,
  );
  assert.deepEqual(parts(work()), []);
});

test('server.log carries counts and statuses only — never the NAME, never the BYTES', async () => {
  const body = Buffer.from(`${BYTES_CANARY} inside the file body\n`);
  assert.equal((await put(work(), NAME_CANARY, 'new', body)).status, 201);
  assert.equal((await put(work(), NAME_CANARY, 'new', body)).status, 409);
  assert.equal((await put(work(), `${NAME_CANARY}/deeper.bin`, 'new', body)).status, 409);
  await waitForLog(server, '[fs] PUT /api/fs/upload -> 409', { count: 2 });
  const log = await readServerLog(server);

  assert.ok(log.includes('[fs] PUT /api/fs/upload -> 201'), 'the route and the outcome');
  assert.ok(log.includes('[fs] PUT /api/fs/upload -> 409'), 'a refusal too');
  assert.ok(log.includes('[http] PUT /api/fs/upload ?… -> 201'), 'the access line, query elided');
  assert.ok(!log.includes('UPLOADNAMECANARY'), 'NO dropped file name reaches the log');
  assert.ok(!log.includes('UPLOADBYTESCANARY'), 'NO byte of the content reaches the log');
  assert.ok(!log.includes(server.token), 'and never the token');
  assert.ok(!log.includes(work()), 'and no destination path');
});

// ---------------------------------------------------------------------------
// The two pure helpers, directly — the route's refusals come from these, and a
// table here is cheaper to read than a hundred HTTP round trips.
// ---------------------------------------------------------------------------

test('splitRel is the whole `rel` vocabulary', () => {
  assert.deepEqual(splitRel('a.txt'), ['a.txt']);
  assert.deepEqual(splitRel('a/b/c.txt'), ['a', 'b', 'c.txt']);
  assert.deepEqual(splitRel('.hidden/.env'), ['.hidden', '.env'], 'hidden names are names');
  assert.deepEqual(splitRel('é'.repeat(127)), ['é'.repeat(127)], '254 bytes is a name');
  assert.deepEqual(
    splitRel(Array.from({ length: 64 }, (_, i) => `s${i}`).join('/'))?.length,
    64,
    'the depth cap is inclusive',
  );
  for (const rel of [
    '',
    '/abs',
    'trailing/',
    'a//b',
    '../up',
    'a/../b',
    './here',
    'a/./b',
    '...',
    'back\\slash',
    'nul\0name',
    'line\nname',
    'x'.repeat(256),
    'é'.repeat(128),
    '\uFFFD', // what percent-decoding makes of invalid UTF-8 (`%C0%AF`)
    'na\uFFFDme.txt',
    Array.from({ length: 65 }, (_, i) => `s${i}`).join('/'),
  ]) {
    assert.equal(splitRel(rel), null, `${JSON.stringify(rel)} must be refused`);
  }
});

test('parseContentLength refuses an absent, malformed, duplicated or chunked length', () => {
  assert.equal(parseContentLength({ 'content-length': '0' }), 0);
  assert.equal(parseContentLength({ 'content-length': '52428800' }), 52428800);
  for (const headers of [
    {},
    { 'content-length': '-1' },
    { 'content-length': '1.5' },
    { 'content-length': '' },
    { 'content-length': '1e3' },
    { 'content-length': '0x10' },
    { 'content-length': ' 12' },
    { 'content-length': '12 ' },
    { 'content-length': '9999999999999999999999' },
    // A duplicated header: node types it as a string, the runtime hands an
    // array — the cast is the only way to state the case the code guards.
    { 'content-length': ['1', '2'] as unknown as string },
    { 'content-length': '10', 'transfer-encoding': 'chunked' },
    { 'transfer-encoding': 'chunked' },
    { 'transfer-encoding': 'identity' },
  ]) {
    assert.equal(parseContentLength(headers), null, `${JSON.stringify(headers)} must be refused`);
  }
});
