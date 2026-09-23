/**
 * PUT /api/fs/upload — the real file write behind drop / paste / `Copy files
 * here…` (Nocturne B10 phase 1, `.claude/plans/nocturne/PLAN-B10.md` §2).
 *
 * One real server child on a fixture `home` (AI_SM_HOME_OVERRIDE, the seam
 * tests/server/fs-create.test.ts and tests/server/fs-entries.test.ts use), so the boundary,
 * the post-mkdir realpath re-check, O_NOFOLLOW, the rename/link publish and the
 * "refuse before reading a byte" header rules are exercised against a real
 * kernel, a real socket and a real server.log.
 *
 * The hostile shapes (no content-length, chunked, an over-cap length whose body
 * is never sent, a body that stops short) are driven over a RAW SOCKET: the
 * fetch/undici client refuses to send a body that disagrees with its own
 * content-length, which is exactly what those cases need.
 *
 * Example paths in comments are `/home/you/...`, never anyone's real one.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { chmod, lstat, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { connect, type Socket } from 'node:net';
import { join } from 'node:path';
import { handleUpload, parseContentLength, splitRel } from '../../server/fsupload.ts';
import type { FsUploadResponse, Project } from '../../shared/protocol.ts';
import { MAX_UPLOAD_BYTES } from '../../shared/protocol.ts';
import {
  api,
  readServerLog,
  startTestServer,
  waitForLog,
  waitUntil,
  type TestServer,
  SKIP_IF_ROOT,
  makeTempDir,
  removeTempDir,
} from '../helpers/helpers.ts';

let server: TestServer;
let root: string;
let home: string;
/** A folder OUTSIDE the fixture home — never an anchor unless registered. */
let evil: string;
/** A folder outside home, registered as a project in the anchor test. */
let outside: string;
let dataDir: string;

/** A file name the user "dropped": it must NEVER reach server.log. */
const NAME_CANARY = 'UPLOADNAMECANARY_qz.bin';
/** Bytes of a dropped file: they must never reach server.log either. */
const BYTES_CANARY = 'UPLOADBYTESCANARY_7f3d';

const work = (): string => join(home, 'work');
const sha = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

before(async () => {
  root = await realpath(await makeTempDir('ai-sm-fsup-'));
  home = join(root, 'home');
  evil = join(root, 'homeevil');
  outside = join(root, 'outside');
  dataDir = join(home, '.ai-session-manager');
  await mkdir(home);
  await mkdir(evil);
  await mkdir(outside);
  await mkdir(join(home, 'work'));
  server = await startTestServer({ dataDir, env: { AI_SM_HOME_OVERRIDE: home } });
});

after(async () => {
  if (server !== undefined) await server.stop();
  if (root !== undefined) await removeTempDir(root);
});

// ---------------------------------------------------------------------------
// The ordinary client: fetch, which sets content-length for a byte body itself.
// ---------------------------------------------------------------------------

interface UploadResult {
  status: number;
  body: unknown;
  headers: Headers;
}

async function put(
  dir: string,
  rel: string,
  mode: string,
  body: Uint8Array,
  opts: { contentType?: string | null; method?: string } = {},
): Promise<UploadResult> {
  const query =
    `dir=${encodeURIComponent(dir)}&rel=${encodeURIComponent(rel)}&mode=${encodeURIComponent(mode)}`;
  const headers: Record<string, string> = { 'x-auth-token': server.token };
  if (opts.contentType !== null) {
    headers['content-type'] = opts.contentType ?? 'application/octet-stream';
  }
  const res = await fetch(`${server.baseUrl}/api/fs/upload?${query}`, {
    method: opts.method ?? 'PUT',
    headers,
    // A Blob, not the bare bytes: undici sets content-length from it, and the
    // `Uint8Array<ArrayBufferLike>` a Buffer is does not satisfy BodyInit under
    // this TypeScript. The copy into a plain Uint8Array is the same bytes.
    body: new Blob([new Uint8Array(body)]),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    // Non-JSON body — keep the raw text.
  }
  return { status: res.status, body: parsed, headers: res.headers };
}

// ---------------------------------------------------------------------------
// The hostile client: a raw socket, so the request head and the body are two
// separate decisions.
// ---------------------------------------------------------------------------

interface Exchange {
  status: number;
  /** Lower-cased response header lines, joined — enough to assert `connection: close`. */
  head: string;
  body: string;
  /** The first response byte arrived BEFORE this client wrote any body byte. */
  answeredBeforeBody: boolean;
  /** The server ended the connection. */
  closed: boolean;
}

/**
 * Send a hand-built request head, optionally followed by body bytes, and read
 * whatever comes back until the server closes (every refusal of this route
 * closes) or a complete content-length-delimited response has arrived.
 */
function exchange(
  head: string,
  opts: { body?: Buffer; sendBody?: boolean; halfCloseAfter?: number } = {},
): Promise<Exchange> {
  return new Promise((resolve, reject) => {
    const socket = connect(server.port, '127.0.0.1');
    let raw = Buffer.alloc(0);
    let wroteBody = false;
    let answeredBeforeBody = false;
    let settled = false;
    const timer = setTimeout(() => {
      finish(true);
    }, 10_000);

    const finish = (timedOut = false): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      const text = raw.toString('utf8');
      const split = text.indexOf('\r\n\r\n');
      if (split === -1) {
        reject(new Error(timedOut ? 'timed out with no response' : `no response head: ${text}`));
        return;
      }
      const headText = text.slice(0, split).toLowerCase();
      const status = Number(headText.split(' ')[1] ?? '0');
      resolve({
        status,
        head: headText,
        body: text.slice(split + 4),
        answeredBeforeBody,
        closed: socket.readableEnded,
      });
    };

    socket.on('connect', () => {
      socket.write(head);
      if (opts.body !== undefined && opts.sendBody !== false) {
        const slice =
          opts.halfCloseAfter === undefined ? opts.body : opts.body.subarray(0, opts.halfCloseAfter);
        socket.write(slice);
        wroteBody = true;
        if (opts.halfCloseAfter !== undefined) socket.end(); // FIN: the body stops short
      }
    });
    socket.on('data', (chunk: Buffer) => {
      if (!wroteBody) answeredBeforeBody = true;
      raw = Buffer.concat([raw, chunk]);
      const text = raw.toString('utf8');
      const split = text.indexOf('\r\n\r\n');
      if (split === -1) return;
      // A response that says `connection: close` is only complete once the
      // server really closes — that closure is what these cases measure.
      if (/connection: *close/i.test(text.slice(0, split))) return;
      const length = /content-length: *(\d+)/i.exec(text.slice(0, split))?.[1];
      if (length !== undefined && Buffer.byteLength(text.slice(split + 4)) >= Number(length)) {
        finish();
      }
    });
    socket.on('end', () => finish());
    socket.on('close', () => finish());
    socket.on('error', () => finish());
  });
}

/** A request head for /api/fs/upload with exactly the header lines given. */
function head(query: string, lines: readonly string[]): string {
  return (
    `PUT /api/fs/upload?${query} HTTP/1.1\r\n` +
    `host: 127.0.0.1:${server.port}\r\n` +
    `x-auth-token: ${server.token}\r\n` +
    `${lines.join('\r\n')}\r\n\r\n`
  );
}

const q = (dir: string, rel: string, mode = 'new'): string =>
  `dir=${encodeURIComponent(dir)}&rel=${encodeURIComponent(rel)}&mode=${mode}`;

/** The handler's own line for an incomplete upload (400). */
const INCOMPLETE_LINE = '[fs] PUT /api/fs/upload -> 400';

/** `.upload-<32 hex>.part` files left behind in a folder. */
const parts = (dir: string): string[] =>
  readdirSync(dir).filter((name) => name.startsWith('.upload-') && name.endsWith('.part'));

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
