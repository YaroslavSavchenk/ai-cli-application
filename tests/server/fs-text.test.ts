/**
 * GET /api/fs/read + PUT /api/fs/write — the editor's file read and write
 * (Nocturne B4 phase 1, `.claude/plans/nocturne/PLAN-B4.md` §7 of phase 1).
 *
 * One real server child on a fixture `home` (AI_SM_HOME_OVERRIDE, the seam
 * tests/server/fs-create.test.ts and tests/server/fs-upload.test.ts use), so the boundary, the
 * O_NOFOLLOW/O_NONBLOCK opens, the fstat rule, the stamp compare, the in-place
 * write (inode, mode and hard links) and the real server.log are exercised
 * against a real kernel, a real socket and a real process — never a mock.
 *
 * THE FIFO TEST RUNS UNDER ITS OWN TIMEOUT. A named pipe planted at a path this
 * server opens synchronously is the one failure mode that hangs the WHOLE
 * backend (memory/knowledge/fifo-open-blocks-main-thread.md), and a test that
 * plants a symlink proves nothing about it: `mkfifo` is called for real, and a
 * regression shows up as a timeout instead of a suite that never ends.
 *
 * Example paths in comments are `/home/you/...`, never anyone's real one.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  chmod,
  link,
  lstat,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { errorClass } from '../../server/config.ts';
import { decodeText, encodeText, errnoTag, stampOf, textErrorFor } from '../../server/fstext.ts';
import { FS_TEXT_MAX_BYTES } from '../../shared/protocol.ts';
import type { FsReadResponse, FsWriteResponse, Project } from '../../shared/protocol.ts';
import {
  api,
  rawRequest,
  readServerLog,
  startTestServer,
  waitForLog,
  type ApiResult,
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

/** A file name the user "opened": it must NEVER reach server.log. */
const NAME_CANARY = 'TEXTNAMECANARY_qz.txt';
/** Bytes of the file's text: they must never reach server.log either. */
const TEXT_CANARY = 'TEXTBYTESCANARY_7f3d';

const work = (): string => join(home, 'work');

before(async () => {
  root = await realpath(await makeTempDir('ai-sm-fstxt-'));
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
  if (root !== undefined) {
    // A 0444 file and a 0500 folder must not be able to defeat the teardown.
    await chmod(join(work(), 'readonly.txt'), 0o600).catch(() => undefined);
    await removeTempDir(root);
  }
});

// ---------------------------------------------------------------------------
// The two routes, as the pane calls them.
// ---------------------------------------------------------------------------

function read(path: string, ifStamp?: string): Promise<ApiResult> {
  const query =
    `path=${encodeURIComponent(path)}` +
    (ifStamp === undefined ? '' : `&if=${encodeURIComponent(ifStamp)}`);
  return api(server, 'GET', `/api/fs/read?${query}`);
}

function write(body: unknown): Promise<ApiResult> {
  return api(server, 'PUT', '/api/fs/write', body);
}

/** The read answer as the union it is, with a readable failure on a refusal. */
function readBody(res: ApiResult): FsReadResponse {
  assert.equal(res.status, 200, `expected a 200: ${JSON.stringify(res.body)}`);
  return res.body as FsReadResponse;
}

/** A text file written straight to disk, and the read answer for it. */
async function plant(name: string, bytes: string | Buffer): Promise<string> {
  const path = join(work(), name);
  await writeFile(path, bytes);
  return path;
}

// ---------------------------------------------------------------------------
// The pure helpers (§3) — no server, no filesystem.
// ---------------------------------------------------------------------------

test('decodeText reads the ending of the FIRST line break, the BOM, and nothing else', () => {
  assert.deepEqual(decodeText(Buffer.from('a\nb\n')), { text: 'a\nb\n', eol: 'lf', bom: false });
  assert.deepEqual(decodeText(Buffer.from('a\r\nb\r\n')), { text: 'a\nb\n', eol: 'crlf', bom: false });
  assert.deepEqual(decodeText(Buffer.from('')), { text: '', eol: 'lf', bom: false });
  assert.deepEqual(decodeText(Buffer.from('no break')), { text: 'no break', eol: 'lf', bom: false });
  assert.deepEqual(decodeText(Buffer.from('\uFEFFa\n')), { text: 'a\n', eol: 'lf', bom: true });
  assert.deepEqual(decodeText(Buffer.from('\uFEFFa\r\n')), { text: 'a\n', eol: 'crlf', bom: true });
  // A file that STARTS with a line break: `indexOf('\n') === 0` has no
  // preceding byte to look at, so it is LF, not a crash.
  assert.deepEqual(decodeText(Buffer.from('\nx')), { text: '\nx', eol: 'lf', bom: false });
  // MIXED: the first break decides, and every CRLF in the text is normalised —
  // which is what makes the next save uniform (the decided behaviour).
  assert.deepEqual(decodeText(Buffer.from('a\r\nb\nc\r\n')), {
    text: 'a\nb\nc\n',
    eol: 'crlf',
    bom: false,
  });
  // A LONE `\r` is not a line break here: it travels through untouched.
  assert.deepEqual(decodeText(Buffer.from('a\rb\n')), { text: 'a\rb\n', eol: 'lf', bom: false });
  // The FIRST break, never the LAST: a file that opens LF and ends CRLF is an
  // LF file (`indexOf`, and the mixed fixture above cannot tell the two apart).
  assert.deepEqual(decodeText(Buffer.from('a\nb\r\n')), { text: 'a\nb\n', eol: 'lf', bom: false });
  assert.deepEqual(decodeText(Buffer.from('\uFEFFa\nb\r\n')), { text: 'a\nb\n', eol: 'lf', bom: true });
});

test('decodeText answers null for a NUL byte and for anything that is not UTF-8', () => {
  assert.equal(decodeText(Buffer.from('text\0more')), null, 'a NUL anywhere');
  assert.equal(decodeText(Buffer.from([0x00])), null, 'a NUL alone');
  assert.equal(decodeText(Buffer.from([0xff, 0xfe, 0x41])), null, 'not valid UTF-8');
  assert.equal(decodeText(Buffer.from([0xc3])), null, 'a truncated 2-byte sequence');
  assert.equal(decodeText(Buffer.from([0xc0, 0xaf])), null, 'an overlong encoding');
  // A NUL is LEGAL UTF-8, so only the byte test catches it: proof that the
  // decoder alone would have said yes.
  assert.equal(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from([0x00])), '\0');
});

test('encodeText is the exact inverse of decodeText for every uniform-ending file', () => {
  const fixtures = [
    '',
    'hello\n',
    'no trailing newline',
    'a\nb\nc\n',
    'a\r\nb\r\nc\r\n',
    '\uFEFFhello\nworld\n',
    '\uFEFFa\r\nb\r\n',
    'ünïcode ✓ — ok\n',
    'a\rb\n',
    '\n',
    '\r\n',
  ];
  for (const fixture of fixtures) {
    const buf = Buffer.from(fixture, 'utf8');
    const decoded = decodeText(buf);
    assert.notEqual(decoded, null, JSON.stringify(fixture));
    const back = encodeText((decoded as NonNullable<typeof decoded>).text, decoded!.eol, decoded!.bom);
    assert.ok(back.equals(buf), `round trip must be byte-exact for ${JSON.stringify(fixture)}`);
  }
  // The two shapes no round trip can show, because the client chooses them:
  // `crlf` on a text with NO break touches nothing, and `bom: true` on a text
  // that had none PREPENDS one (the pane's BOM toggle).
  assert.ok(encodeText('abc', 'crlf', false).equals(Buffer.from('abc')), 'crlf without a break');
  assert.ok(encodeText('a\nb', 'lf', true).equals(Buffer.from('\uFEFFa\nb', 'utf8')), 'a BOM added');
  assert.ok(
    encodeText('a\nb', 'crlf', true).equals(Buffer.from('\uFEFFa\r\nb', 'utf8')),
    'both at once, and the BOM comes FIRST',
  );
});

test('stampOf is the sha256 of the bytes, and nothing about the path', () => {
  assert.equal(
    stampOf(Buffer.from('abc')),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
  assert.match(stampOf(Buffer.from('')), /^[0-9a-f]{64}$/);
  assert.notEqual(stampOf(Buffer.from('a')), stampOf(Buffer.from('b')));
});

test('textErrorFor is the WHOLE errno table, read side and write side', () => {
  // errno, status, the READ sentence, the WRITE sentence.
  const table: [string | undefined, number, string, string][] = [
    ['ENOENT', 404, 'This file is no longer there.', 'This file is no longer there.'],
    ['ENOTDIR', 404, 'This file is no longer there.', 'This file is no longer there.'],
    [
      'EACCES',
      403,
      'You do not have permission to read this file.',
      'You do not have permission to change this file.',
    ],
    [
      'EPERM',
      403,
      'You do not have permission to read this file.',
      'You do not have permission to change this file.',
    ],
    [
      'EROFS',
      403,
      'You do not have permission to read this file.',
      'You do not have permission to change this file.',
    ],
    [
      'ETXTBSY',
      403,
      'You do not have permission to read this file.',
      'You do not have permission to change this file.',
    ],
    ['EISDIR', 400, 'The app cannot open that folder.', 'The app cannot open that folder.'],
    [
      'ELOOP',
      415,
      'This file is not text, so the editor cannot show it.',
      'This file is not text, so the editor cannot show it.',
    ],
    [
      'ENXIO',
      415,
      'This file is not text, so the editor cannot show it.',
      'This file is not text, so the editor cannot show it.',
    ],
    ['ENAMETOOLONG', 400, 'The app cannot open that folder.', 'The app cannot open that folder.'],
    ['ENOSPC', 507, 'There is no room left on the disk.', 'There is no room left on the disk.'],
    ['EDQUOT', 507, 'There is no room left on the disk.', 'There is no room left on the disk.'],
    ['EBADMSG', 500, 'The app could not read this file.', 'The app could not save this file.'],
    [undefined, 500, 'The app could not read this file.', 'The app could not save this file.'],
  ];
  for (const [code, status, readMessage, writeMessage] of table) {
    const onRead = textErrorFor(code, true);
    assert.equal(onRead.status, status, `${code}: the read status`);
    assert.equal(onRead.message, readMessage, `${code}: the read sentence`);
    const onWrite = textErrorFor(code, false);
    assert.equal(onWrite.status, status, `${code}: the write status`);
    assert.equal(onWrite.message, writeMessage, `${code}: the write sentence`);
    // Not one sentence may carry the errno itself — they are the copy the pane
    // renders.
    if (code !== undefined) {
      assert.ok(!onRead.message.includes(code), `${code}: not in the read sentence`);
      assert.ok(!onWrite.message.includes(code), `${code}: not in the write sentence`);
    }
    // And the raw code rides ON the mapped error, for the 5xx log line.
    assert.equal(errnoTag(onRead), code === undefined ? '' : ` code=${code}`, `${code}: carried`);
  }
});

test('errnoTag prints the errno CODE alone — a constant, never a message, never a path', () => {
  assert.equal(errnoTag(Object.assign(new Error('boom'), { code: 'ENXIO' })), ' code=ENXIO');
  assert.equal(errnoTag(textErrorFor('EBADMSG', true)), ' code=EBADMSG', 'through the mapping too');
  assert.equal(errnoTag(new Error('no errno')), '');
  assert.equal(errnoTag(undefined), '');
  assert.equal(errnoTag(null), '');
  assert.equal(errnoTag('ENOENT'), '', 'a bare string is not an errno carrier');
  assert.equal(errnoTag({ code: 42 }), '');
  // Anything that is not a kernel identifier is dropped: a path, a sentence, a
  // lower-case word, one letter, a 64-character blob.
  assert.equal(errnoTag({ code: '/home/you/work/secret.txt' }), '');
  assert.equal(errnoTag({ code: 'ENOENT: no such file, open /home/you/x.txt' }), '');
  assert.equal(errnoTag({ code: 'enxio' }), '');
  assert.equal(errnoTag({ code: 'E' }), '');
  assert.equal(errnoTag({ code: `E${'X'.repeat(64)}` }), '');
});

test('a 5xx line is class + code + frames — the exact composition the routes log', () => {
  // The one shape that can be pinned without an unmappable errno from a real
  // kernel: `fs read failed (FsBrowseError) code=EBADMSG <frames>`.
  const mapped = textErrorFor('EBADMSG', true);
  assert.equal(mapped.status, 500, 'an errno not in the table');
  const line = `fs read failed (${errorClass(mapped)})${errnoTag(mapped)} <frames>`;
  assert.equal(line, 'fs read failed (FsBrowseError) code=EBADMSG <frames>');
  assert.ok(line.includes('code='), 'a 5xx line can say WHICH errno it was');
  assert.ok(!line.includes(mapped.message), 'and never the sentence or an errno message');
});

// ---------------------------------------------------------------------------
// The round trip (§7)
// ---------------------------------------------------------------------------

test('a file reads as LF text with its own ending, and writes back byte-exact', async () => {
  const cases: [string, string, 'lf' | 'crlf', boolean][] = [
    ['lf.txt', 'one\ntwo\n', 'lf', false],
    ['crlf.txt', 'one\r\ntwo\r\n', 'crlf', false],
    ['bom.txt', '\uFEFFone\ntwo\n', 'lf', true],
    ['bomcrlf.txt', '\uFEFFone\r\ntwo\r\n', 'crlf', true],
    ['empty.txt', '', 'lf', false],
    ['tail.txt', 'no trailing newline', 'lf', false],
  ];
  for (const [name, content, eol, bom] of cases) {
    const path = await plant(name, content);
    const body = readBody(await read(path));
    assert.equal(body.changed, true, name);
    assert.ok(body.changed);
    assert.equal(body.eol, eol, `${name}: eol`);
    assert.equal(body.bom, bom, `${name}: bom`);
    assert.equal(body.text, content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n'), `${name}: text`);
    assert.equal(body.stamp, stampOf(Buffer.from(content, 'utf8')), `${name}: stamp`);

    // Saved back unchanged: the bytes on disk must be the bytes that were there.
    const saved = await write({ path, text: body.text, eol: body.eol, bom: body.bom, expect: body.stamp });
    assert.equal(saved.status, 200, `${name}: ${JSON.stringify(saved.body)}`);
    const answer = saved.body as FsWriteResponse;
    assert.equal(answer.bytes, Buffer.byteLength(content, 'utf8'), `${name}: bytes`);
    assert.equal(answer.stamp, body.stamp, `${name}: the stamp did not move`);
    assert.equal(await readFile(path, 'utf8'), content, `${name}: byte-exact on disk`);
  }
});

test('a MIXED file comes back uniform on the next save — the decided behaviour', async () => {
  const path = await plant('mixed.txt', 'a\r\nb\nc\r\n');
  const body = readBody(await read(path));
  assert.ok(body.changed);
  assert.equal(body.eol, 'crlf', 'the FIRST break decides');
  assert.equal(body.text, 'a\nb\nc\n');

  const saved = await write({ path, text: body.text, eol: 'crlf', bom: false, expect: body.stamp });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(await readFile(path, 'utf8'), 'a\r\nb\r\nc\r\n', 'uniform CRLF');
});

test('an edit is written where the text says, and the new stamp is the file itself', async () => {
  const path = await plant('edit.txt', 'first\n');
  const first = readBody(await read(path));
  assert.ok(first.changed);

  const saved = await write({ path, text: 'second\nthird\n', eol: 'lf', bom: false, expect: first.stamp });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const answer = saved.body as FsWriteResponse;
  assert.equal(await readFile(path, 'utf8'), 'second\nthird\n');
  assert.equal(answer.bytes, 13);
  assert.equal(answer.stamp, stampOf(Buffer.from('second\nthird\n')));

  // The next read agrees with the write's own answer.
  const again = readBody(await read(path));
  assert.ok(again.changed);
  assert.equal(again.stamp, answer.stamp);
  assert.equal(again.text, 'second\nthird\n');
});

test('`if` equal to the current stamp answers changed:false and NO text', async () => {
  const path = await plant('follow.txt', 'watch me\n');
  const first = readBody(await read(path));
  assert.ok(first.changed);

  const unchanged = readBody(await read(path, first.stamp));
  assert.deepEqual(unchanged, { changed: false, stamp: first.stamp }, 'exactly two fields');

  await writeFile(path, 'changed under it\n');
  const moved = readBody(await read(path, first.stamp));
  assert.ok(moved.changed, 'a file that moved answers with the new text');
  assert.equal(moved.text, 'changed under it\n');
  assert.notEqual(moved.stamp, first.stamp);

  // A stamp of the right SHAPE that is simply not this file's: the text comes.
  const other = readBody(await read(path, 'a'.repeat(64)));
  assert.ok(other.changed);
});

// ---------------------------------------------------------------------------
// The caps (§2, §4)
// ---------------------------------------------------------------------------

test('the size cap is exactly 1 MiB: one byte more is a 413, on the read and on the write', async () => {
  assert.equal(FS_TEXT_MAX_BYTES, 1024 * 1024, 'the cap this test is written against');
  const big = 'x'.repeat(FS_TEXT_MAX_BYTES);
  const atCap = await plant('atcap.txt', big);
  const overCap = await plant('overcap.txt', `${big}x`);

  const ok = readBody(await read(atCap));
  assert.ok(ok.changed);
  assert.equal(ok.text.length, FS_TEXT_MAX_BYTES, 'exactly at the cap is allowed');

  const refused = await read(overCap);
  assert.equal(refused.status, 413);
  assert.deepEqual(refused.body, { error: 'This file is too large to open here.' });

  const write1 = await write({ path: atCap, text: big, eol: 'lf', bom: false, expect: ok.stamp });
  assert.equal(write1.status, 200, JSON.stringify(write1.body));
  const write2 = await write({ path: atCap, text: `${big}x`, eol: 'lf', bom: false });
  assert.equal(write2.status, 413, 'the TEXT is capped after encoding');
  assert.deepEqual(write2.body, { error: 'This file is too large to open here.' });
  assert.equal((await stat(atCap)).size, FS_TEXT_MAX_BYTES, 'and nothing was written');

  // A text at the cap in CHARACTERS but over it in BYTES: the cap is on the
  // bytes that land on disk, so CRLF and a BOM count.
  const half = 'y\n'.repeat(FS_TEXT_MAX_BYTES / 4); // 512 KiB of LF text
  const crlf = await write({ path: atCap, text: half, eol: 'crlf', bom: false });
  assert.equal(crlf.status, 200, `768 KiB as CRLF still fits: ${JSON.stringify(crlf.body)}`);
  // 349_526 lines of `z\n` = 699_052 bytes as LF (legal) and 1_048_578 as CRLF
  // (one byte over the cap): the SAME text, refused only because of its ending.
  const justOver = 'z\n'.repeat(349_526);
  const tooBig = await write({ path: atCap, text: justOver, eol: 'crlf', bom: false });
  assert.equal(tooBig.status, 413, 'the same text refused once CRLF makes it bigger');
});

test('a write WITH `expect` on a file over the cap is a 413, never a compare', async () => {
  // The compare has to READ the current bytes to hash them, so the cap is the
  // read cap here too: a file over 1 MiB is never pulled into memory to be told
  // it changed. MEASURED without that check: a 409 (the hash of 1 MiB + 1 bytes
  // can never match the stamp), which is the wrong sentence for the situation.
  const path = await plant('overcap-expect.txt', 'x'.repeat(FS_TEXT_MAX_BYTES + 1));
  const res = await write({ path, text: 'small\n', eol: 'lf', bom: false, expect: '4'.repeat(64) });
  assert.equal(res.status, 413, JSON.stringify(res.body));
  assert.deepEqual(res.body, { error: 'This file is too large to open here.' });
  assert.equal((await stat(path)).size, FS_TEXT_MAX_BYTES + 1, 'and nothing was written');
});

test('a write body past the route cap is refused before it is parsed, and the connection closes', async () => {
  // The route's own cap is FS_TEXT_MAX_BYTES * 6 + 4096: JSON escaping of ONE
  // C0 control byte is SIX bytes (`\u001b`), which the ESC test below pins.
  // The generic MAX_BODY_BYTES (1 MiB) is untouched, which is the whole reason
  // this route passes its own number.
  const path = await plant('cap-body.txt', 'small\n');
  const huge = 'q'.repeat(FS_TEXT_MAX_BYTES * 6 + 8192);
  const res = await write({ path, text: huge, eol: 'lf', bom: false });
  assert.equal(res.status, 413);
  assert.deepEqual(res.body, { error: 'This file is too large to open here.' });
  assert.equal(res.headers.get('connection'), 'close', 'a body still streaming is cut off');
  assert.equal(await readFile(path, 'utf8'), 'small\n', 'and nothing was written');

  // A body just UNDER the route cap still parses — proof the cap is the
  // route's and not the generic 1 MiB one (a 2 MiB JSON body would be a 413
  // if this route had not raised its own).
  const two = 'w'.repeat(2 * 1024 * 1024);
  const parsed = await write({ path, text: two, eol: 'lf', bom: false });
  assert.equal(parsed.status, 413, 'the TEXT is over 1 MiB, so this is the TEXT 413…');
  assert.notEqual(
    parsed.headers.get('connection'),
    'close',
    '…decided AFTER the body was read, so the connection stays reusable',
  );
});

test('a 1 MiB file of ESC bytes reads 200 and SAVES 200 — the escaping factor is 6, not 4', async () => {
  // A file the READ route serves must be a file the WRITE route can take back.
  // Every ESC byte costs `\u001b` — SIX characters — in the JSON body, so at a
  // body cap of FS_TEXT_MAX_BYTES * 4 + 4096 this exact file read 200 and saved
  // 413 (MEASURED): unsavable by construction.
  const esc = '\u001b'.repeat(FS_TEXT_MAX_BYTES);
  assert.equal(JSON.stringify(esc).length, FS_TEXT_MAX_BYTES * 6 + 2, 'six per byte, plus the quotes');
  const path = await plant('esc-1mib.txt', esc);

  const body = readBody(await read(path));
  assert.ok(body.changed);
  assert.equal(body.text.length, FS_TEXT_MAX_BYTES, 'a control byte is text, and it is at the cap');

  const saved = await write({ path, text: body.text, eol: 'lf', bom: false, expect: body.stamp });
  assert.equal(saved.status, 200, `the 6 MiB JSON body must fit: ${JSON.stringify(saved.body)}`);
  assert.equal((saved.body as FsWriteResponse).stamp, body.stamp, 'the stamp did not move');
  assert.equal((await stat(path)).size, FS_TEXT_MAX_BYTES, 'and the bytes are still there');
});

// ---------------------------------------------------------------------------
// Not text, not a file (§2, §3)
// ---------------------------------------------------------------------------

test('a NUL byte and invalid UTF-8 are 415, never bytes on the wire', async () => {
  const nul = await plant('nul.bin', Buffer.from('text\0more'));
  const bad = await plant('latin1.bin', Buffer.from([0x68, 0x69, 0xff, 0xfe]));
  for (const path of [nul, bad]) {
    const res = await read(path);
    assert.equal(res.status, 415, `${path}: ${JSON.stringify(res.body)}`);
    assert.deepEqual(res.body, { error: 'This file is not text, so the editor cannot show it.' });
  }
});

test('a directory is a 400 on both routes — a path mistake, not an encoding one', async () => {
  const dir = join(home, 'work');
  const res = await read(dir);
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'The app cannot open that folder.' });

  // MEASURED: O_RDONLY on a directory SUCCEEDS (the fstat rule answers the
  // read), while O_RDWR answers EISDIR (the errno table answers the write).
  // Both end at 400.
  const saved = await write({ path: dir, text: 'x\n', eol: 'lf', bom: false });
  assert.equal(saved.status, 400, JSON.stringify(saved.body));
  assert.deepEqual(saved.body, { error: 'The app cannot open that folder.' });
});

test('a FIFO answers 415 and never hangs the server', { timeout: 20_000 }, async () => {
  // THE point of this test: `openSync(fifo, O_RDONLY)` blocks until a writer
  // appears, and it would block the whole backend — every session, every
  // WebSocket (memory/knowledge/fifo-open-blocks-main-thread.md). O_NONBLOCK +
  // fstat is what makes it a 415. A real mkfifo, not a symlink to one.
  const fifo = join(work(), 'pipe');
  execFileSync('mkfifo', [fifo]);

  const res = await read(fifo);
  assert.equal(res.status, 415, JSON.stringify(res.body));
  assert.deepEqual(res.body, { error: 'This file is not text, so the editor cannot show it.' });

  const saved = await write({ path: fifo, text: 'x\n', eol: 'lf', bom: false });
  assert.equal(saved.status, 415, JSON.stringify(saved.body));

  // The server is still answering, which is the assertion the timeout guards.
  const health = await fetch(`${server.baseUrl}/health`);
  assert.equal(health.status, 200);
  assert.equal(await health.text(), '{"ok":true}');
});

test('a unix-domain SOCKET is a 415 on both routes, and no [error] line behind it', async () => {
  // `open(2)` on a socket answers ENXIO BEFORE there is an fd, so the fstat
  // rule never gets to judge it — the errno table is what must answer. MEASURED
  // without `case 'ENXIO'`: 500 plus an `[error] [fs] fs read failed
  // (FsBrowseError) at textErrorFor …` line for a planted socket.
  const sockPath = join(work(), 'x.sock');
  const listener = createServer();
  await new Promise<void>((done) => listener.listen(sockPath, () => done()));
  try {
    const res = await read(sockPath);
    assert.equal(res.status, 415, JSON.stringify(res.body));
    assert.deepEqual(res.body, { error: 'This file is not text, so the editor cannot show it.' });

    // Both shapes of the write: with an expectation, and the Overwrite that
    // takes the create-then-retry path.
    for (const expect of [undefined, '2'.repeat(64)]) {
      const saved = await write({ path: sockPath, text: 'x\n', eol: 'lf', bom: false, expect });
      assert.equal(saved.status, 415, `expect=${String(expect)}: ${JSON.stringify(saved.body)}`);
      assert.deepEqual(saved.body, { error: 'This file is not text, so the editor cannot show it.' });
    }
    assert.ok((await lstat(sockPath)).isSocket(), 'and it is still a socket');

    // A byte count no other line in this suite writes: it is the marker that
    // says the four requests above have reached the log file already.
    const marker = await plant('sock-marker.txt', '');
    const mark = await write({ path: marker, text: 'm'.repeat(937), eol: 'lf', bom: false });
    assert.equal(mark.status, 200, JSON.stringify(mark.body));
    const log = await waitForLog(server, '[fs] PUT /api/fs/write -> 200, 937 bytes');
    const fsErrors = log.split('\n').filter((line) => line.includes('[error]') && line.includes('[fs]'));
    assert.deepEqual(fsErrors, [], 'the [fs] channel logged no error at all');
  } finally {
    await new Promise<void>((done) => listener.close(() => done()));
  }
});

// ---------------------------------------------------------------------------
// The boundary (§1)
// ---------------------------------------------------------------------------

test('a symlink INSIDE the boundary is read and written AT ITS TARGET', async () => {
  const target = await plant('link-target.txt', 'target\n');
  const linkPath = join(work(), 'a-link.txt');
  await symlink(target, linkPath);
  const before = await stat(target);

  const body = readBody(await read(linkPath));
  assert.ok(body.changed);
  assert.equal(body.text, 'target\n', 'the read follows the link');

  const saved = await write({ path: linkPath, text: 'through the link\n', eol: 'lf', bom: false, expect: body.stamp });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(await readFile(target, 'utf8'), 'through the link\n', 'the TARGET was written');
  assert.ok((await lstat(linkPath)).isSymbolicLink(), 'and the link is still a link');
  assert.equal((await stat(target)).ino, before.ino, 'the same inode, written in place');
});

test('a symlink whose target is OUTSIDE every anchor is a 403, like a listing', async () => {
  const secret = join(evil, 'secret.txt');
  await writeFile(secret, 'OUTSIDE\n');
  const linkPath = join(work(), 'out-link.txt');
  await symlink(secret, linkPath);

  const res = await read(linkPath);
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'This folder is outside your home folder.' });

  const saved = await write({ path: linkPath, text: 'PWNED\n', eol: 'lf', bom: false });
  assert.equal(saved.status, 403, JSON.stringify(saved.body));
  assert.equal(await readFile(secret, 'utf8'), 'OUTSIDE\n', 'nothing was written out there');
});

test('a link planted at a MISSING name is never followed — not even by Overwrite', async () => {
  // `/home/you/work/planted.txt -> /elsewhere/never.txt` in the real world.
  const never = join(evil, 'never.txt');
  const planted = join(work(), 'planted.txt');
  await symlink(never, planted);

  // The read: realpath of a dangling link is ENOENT, so the file is "gone".
  const res = await read(planted);
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'This file is no longer there.' });

  // The write with `expect`: the same 404, and nothing created.
  const withExpect = await write({
    path: planted,
    text: 'PWNED\n',
    eol: 'lf',
    bom: false,
    expect: '0'.repeat(64),
  });
  assert.equal(withExpect.status, 404, JSON.stringify(withExpect.body));
  assert.equal(existsSync(never), false, 'nothing was created through the link');

  // The write WITHOUT `expect` — the pane's `Overwrite`, which recreates a gone
  // file: O_CREAT|O_EXCL answers EEXIST for the link, the in-place retry
  // answers ELOOP under O_NOFOLLOW, and the answer is the not-a-regular-file
  // 415. The one thing that must never happen is a byte through that link.
  const overwrite = await write({ path: planted, text: 'PWNED\n', eol: 'lf', bom: false });
  assert.equal(overwrite.status, 415, JSON.stringify(overwrite.body));
  assert.equal(existsSync(never), false, 'still nothing through the link');
  assert.ok((await lstat(planted)).isSymbolicLink(), 'and the link was not replaced');
});

test('a CREATE is judged by its PARENT: outside every anchor is a 403, and nothing is created', async () => {
  // `Overwrite` of a file that is GONE is the one branch that creates, and the
  // file itself cannot be resolved (it is not there) — so the PARENT is what
  // goes through resolveUnderAllowed. Both shapes of an escape must be refused
  // before O_CREAT: a parent plainly outside the anchors, and a parent symlink
  // INSIDE home that LEAVES them.
  const direct = join(evil, 'created-outside.txt');
  const first = await write({ path: direct, text: 'PWNED\n', eol: 'lf', bom: false });
  assert.equal(first.status, 403, JSON.stringify(first.body));
  assert.deepEqual(first.body, { error: 'This folder is outside your home folder.' });
  assert.equal(existsSync(direct), false, 'nothing was created out there');

  const escape = join(work(), 'escape-dir');
  await symlink(evil, escape);
  const through = join(escape, 'created-through-link.txt');
  const second = await write({ path: through, text: 'PWNED\n', eol: 'lf', bom: false });
  assert.equal(second.status, 403, JSON.stringify(second.body));
  assert.equal(
    existsSync(join(evil, 'created-through-link.txt')),
    false,
    'and nothing through the link either',
  );
});

test('a CREATE whose final NAME is not a safe segment is a 400, and creates nothing', async () => {
  // The create branch is the one place a NAME is taken from the client's own
  // string, so it gets createEntry()'s whole vocabulary: no backslash, no
  // control character, no dots-only name.
  for (const name of ['back\\slash.txt', 'bell\u0007.txt', '...']) {
    const path = join(work(), name);
    const res = await write({ path, text: 'x\n', eol: 'lf', bom: false });
    assert.equal(res.status, 400, `${JSON.stringify(name)}: ${res.status} ${JSON.stringify(res.body)}`);
    assert.deepEqual(res.body, { error: 'The app cannot open that folder.' }, JSON.stringify(name));
    assert.equal(existsSync(path), false, `${JSON.stringify(name)}: nothing was created`);
  }
});

test('a malformed path is a 400 on both routes, before any syscall', async () => {
  const cases: [string, number, string][] = [
    ['relative/path.txt', 400, 'a relative path'],
    [`${home}\0/work/x.txt`, 400, 'a NUL in the path'],
    [join(work(), 'no-such-file.txt'), 404, 'a file that is not there'],
    [join(work(), 'lf.txt', 'deeper.txt'), 404, 'a path THROUGH a file'],
    [join(evil, 'secret.txt'), 403, 'outside every anchor'],
    [`${home}/../homeevil/secret.txt`, 403, 'a lexical .. out of home'],
  ];
  for (const [path, status, why] of cases) {
    const got = await read(path);
    assert.equal(got.status, status, `read ${why} -> ${got.status} ${JSON.stringify(got.body)}`);
    // The WRITE has an expectation, so a missing file is a 404 there too.
    const saved = await write({ path, text: 'x\n', eol: 'lf', bom: false, expect: '1'.repeat(64) });
    assert.equal(saved.status, status, `write ${why} -> ${saved.status} ${JSON.stringify(saved.body)}`);
  }
  // An absent and an empty `path` are the same 400 as a malformed one.
  assert.equal((await api(server, 'GET', '/api/fs/read')).status, 400);
  assert.equal((await api(server, 'GET', '/api/fs/read?path=')).status, 400);
  assert.equal((await write({ text: 'x', eol: 'lf', bom: false })).status, 400);
  assert.equal((await write({ path: '', text: 'x', eol: 'lf', bom: false })).status, 400);
  assert.equal((await write({ path: 42, text: 'x', eol: 'lf', bom: false })).status, 400);
});

test('both length limits are a 400 on BOTH routes: PATH_MAX and NAME_MAX', async () => {
  // Two different limits, both refused BEFORE any syscall. Without the gate the
  // kernel's ENAMETOOLONG arrives through realpathSync, which resolveUnderAllowed
  // maps to a 500 (`The app could not read this folder.`) — MEASURED — and a
  // 500 is not what a path plainly too long for the filesystem earns.
  const longName = join(work(), 'é'.repeat(200)); // ONE name of 400 BYTES
  const longPath = join(home, ...Array.from({ length: 60 }, () => 'd'.repeat(100)), 'x.txt');
  assert.ok(Buffer.byteLength(longPath, 'utf8') > 4096, 'the whole path is over PATH_MAX');
  assert.ok(
    longPath.split('/').every((segment) => Buffer.byteLength(segment, 'utf8') <= 255),
    'and no single NAME in it is too long — only the total is',
  );
  for (const [path, why] of [
    [longName, 'a 400-byte name'],
    [longPath, 'a path over PATH_MAX'],
  ] as const) {
    const got = await read(path);
    assert.equal(got.status, 400, `read ${why}: ${got.status} ${JSON.stringify(got.body)}`);
    assert.deepEqual(got.body, { error: 'The app cannot open that folder.' }, `read ${why}`);
    const saved = await write({ path, text: 'x\n', eol: 'lf', bom: false, expect: '3'.repeat(64) });
    assert.equal(saved.status, 400, `write ${why}: ${saved.status} ${JSON.stringify(saved.body)}`);
    assert.deepEqual(saved.body, { error: 'The app cannot open that folder.' }, `write ${why}`);
    assert.equal(existsSync(path), false, `${why}: nothing was created`);
  }
});

test("the app's own data dir is refused BY PATH — no token in the body for that path", async () => {
  // runtime.json holds the auth token: if this route ever answered 200 for its
  // path — its own, or a symlink resolving to it — the token would be in the
  // response body. It must be a 403, and BEFORE the file is opened.
  //
  // BY PATH is the whole claim: a HARD LINK is a second name for the same
  // inode, and the KNOWN LIMIT test below pins that such a link DOES read the
  // token back (module header § HARD LINKS ARE NOT SEEN).
  const runtime = join(dataDir, 'runtime.json');
  assert.ok(existsSync(runtime), 'the fixture server wrote its runtime.json');
  const res = await read(runtime);
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: "The app's own folder is not a place to edit files." });
  assert.ok(!JSON.stringify(res.body).includes(server.token), 'and no token in the answer');

  const saved = await write({ path: runtime, text: '{}\n', eol: 'lf', bom: false });
  assert.equal(saved.status, 403, JSON.stringify(saved.body));
  assert.ok(JSON.parse(await readFile(runtime, 'utf8')) !== null, 'runtime.json survived');

  // A name that does not exist yet in the data dir goes down the CREATE path,
  // where the PARENT is what the data-dir rule is applied to.
  const fresh = join(dataDir, 'not-yours.txt');
  const created = await write({ path: fresh, text: 'x\n', eol: 'lf', bom: false });
  assert.equal(created.status, 403, JSON.stringify(created.body));
  assert.deepEqual(created.body, { error: "The app's own folder is not a place to edit files." });
  assert.equal(existsSync(fresh), false, 'and nothing was created there');
});

test('a registered project OUTSIDE home is editable; unregistering it takes that back', async () => {
  const path = join(outside, 'in-project.txt');
  await writeFile(path, 'project text\n');
  assert.equal((await read(path)).status, 403, 'unregistered: refused');

  const created = await api(server, 'POST', '/api/projects', { name: 'Outside', path: outside });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const project = created.body as Project;
  try {
    const body = readBody(await read(path));
    assert.ok(body.changed);
    assert.equal(body.text, 'project text\n');
    const saved = await write({ path, text: 'edited\n', eol: 'lf', bom: false, expect: body.stamp });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(await readFile(path, 'utf8'), 'edited\n');

    // `<project>evil` is a string PREFIX of the anchor, not a child.
    const trap = `${outside}evil`;
    await mkdir(trap, { recursive: true });
    await writeFile(join(trap, 'x.txt'), 'TRAP\n');
    assert.equal((await read(join(trap, 'x.txt'))).status, 403, 'the prefix trap holds');
  } finally {
    assert.equal((await api(server, 'DELETE', `/api/projects/${project.id}`)).status, 200);
  }
  assert.equal((await read(path)).status, 403, 'the anchor went with the project');
  assert.equal(await readFile(path, 'utf8'), 'edited\n', 'and the file is untouched');
});

/**
 * A hard link, or the reason this filesystem cannot make one. `EPERM`
 * (fs.protected_hardlinks on a file the test does not own) and `EXDEV` (two
 * filesystems) are facts about the machine, not failures of the route.
 */
async function hardLink(target: string, linkPath: string): Promise<string | null> {
  try {
    await link(target, linkPath);
    return null;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EXDEV') return `no hard links on this filesystem (${code})`;
    throw err;
  }
}

test('KNOWN LIMIT: a hard link inside home to a file outside every anchor is read and written through', async (t) => {
  // ACCEPTED, recorded in the module header (§ HARD LINKS ARE NOT SEEN): a hard
  // link is a second NAME for one inode, not a path to follow, so neither the
  // anchor containment nor the data-dir rule can see it. Planting one already
  // requires running as this user, and the caller holds the token that can
  // spawn a shell. This test exists so the behaviour is explicit, not implied.
  const secret = join(evil, 'hl-secret.txt');
  await writeFile(secret, 'OUTSIDE\n');
  const linkPath = join(work(), 'hl-outside.txt');
  const why = await hardLink(secret, linkPath);
  if (why !== null) {
    t.skip(why);
    return;
  }
  try {
    const body = readBody(await read(linkPath));
    assert.ok(body.changed);
    assert.equal(body.text, 'OUTSIDE\n', 'the outside bytes come back');

    const saved = await write({
      path: linkPath,
      text: 'THROUGH THE LINK\n',
      eol: 'lf',
      bom: false,
      expect: body.stamp,
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(
      await readFile(secret, 'utf8'),
      'THROUGH THE LINK\n',
      'the file OUTSIDE every anchor was changed through the link',
    );
  } finally {
    await rm(linkPath, { force: true });
  }
});

test("KNOWN LIMIT: a hard link to the data dir's file is read and written through", async (t) => {
  // The same accepted limit, on the folder the path rule refuses: runtime.json
  // holds the auth token, and a hard link to it reads that token back and is
  // written in place. The original bytes are restored here — the point is the
  // 200s and the changed inode, not leaving the fixture server without its
  // runtime file.
  const runtime = join(dataDir, 'runtime.json');
  const original = await readFile(runtime, 'utf8');
  const linkPath = join(work(), 'hl-runtime.json');
  const why = await hardLink(runtime, linkPath);
  if (why !== null) {
    t.skip(why);
    return;
  }
  try {
    const body = readBody(await read(linkPath));
    assert.ok(body.changed);
    assert.ok(body.text.includes(server.token), 'the auth token comes back through the link');

    const parsed = JSON.parse(body.text) as Record<string, unknown>;
    const marked = `${JSON.stringify({ ...parsed, hlpin: 1 })}\n`;
    const saved = await write({
      path: linkPath,
      text: marked,
      eol: 'lf',
      bom: false,
      expect: body.stamp,
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(await readFile(runtime, 'utf8'), marked, "the data dir's own file was rewritten");
  } finally {
    await writeFile(runtime, original);
    await rm(linkPath, { force: true });
  }
});

// ---------------------------------------------------------------------------
// The stamp compare (§2, orchestrator default D4)
// ---------------------------------------------------------------------------

test('a stale stamp is a 409 and writes nothing; the fresh one writes', async () => {
  const path = await plant('conflict.txt', 'v1\n');
  const first = readBody(await read(path));
  assert.ok(first.changed);

  await writeFile(path, 'v2 from elsewhere\n');
  const stale = await write({ path, text: 'my edit\n', eol: 'lf', bom: false, expect: first.stamp });
  assert.equal(stale.status, 409);
  assert.deepEqual(stale.body, { error: 'This file changed on disk since you opened it.' });
  assert.equal(await readFile(path, 'utf8'), 'v2 from elsewhere\n', 'the disk was not touched');

  const fresh = readBody(await read(path));
  assert.ok(fresh.changed);
  const ok = await write({ path, text: 'my edit\n', eol: 'lf', bom: false, expect: fresh.stamp });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(await readFile(path, 'utf8'), 'my edit\n');

  // `expect` ABSENT is the Overwrite button: it never compares.
  await writeFile(path, 'moved again\n');
  const forced = await write({ path, text: 'mine wins\n', eol: 'lf', bom: false });
  assert.equal(forced.status, 200, JSON.stringify(forced.body));
  assert.equal(await readFile(path, 'utf8'), 'mine wins\n');
});

test('the `expect` compare is over the BYTES on disk, never over a decoded string', async () => {
  // A stamp is the hash of the bytes THEMSELVES. Hashing a decoded string
  // instead would collapse every byte the decoder cannot read onto U+FFFD, so a
  // client that sends the stamp of the DECODED form would be told its
  // expectation holds — and would overwrite bytes it never saw.
  const bytes = Buffer.from([0x68, 0x69, 0xff, 0x0a]); // `hi` + an invalid byte
  const path = await plant('bytes-stamp.bin', bytes);
  const ofDecoded = stampOf(Buffer.from(bytes.toString('utf8'), 'utf8'));
  assert.notEqual(ofDecoded, stampOf(bytes), 'the two stamps differ — which is the point');

  const res = await write({ path, text: 'PWNED\n', eol: 'lf', bom: false, expect: ofDecoded });
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.deepEqual(res.body, { error: 'This file changed on disk since you opened it.' });
  assert.ok((await readFile(path)).equals(bytes), 'and the bytes are untouched');
});

test('a deleted file is a 404 with `expect` and a CREATE without one', async () => {
  const path = join(work(), 'gone.txt');
  await writeFile(path, 'here\n');
  const body = readBody(await read(path));
  assert.ok(body.changed);
  await rm(path);

  const withExpect = await write({ path, text: 'x\n', eol: 'lf', bom: false, expect: body.stamp });
  assert.equal(withExpect.status, 404);
  assert.deepEqual(withExpect.body, { error: 'This file is no longer there.' });
  assert.equal(existsSync(path), false, 'a 404 creates nothing');

  const recreated = await write({ path, text: 'back again\n', eol: 'lf', bom: false });
  assert.equal(recreated.status, 200, JSON.stringify(recreated.body));
  assert.equal(await readFile(path, 'utf8'), 'back again\n');
  assert.equal((await stat(path)).mode & 0o777, 0o666 & ~0o022, 'created 0666 minus the umask');

  // A create whose parent is a FILE is the same 404 — a path through a file
  // names nothing (both the isExistingDirectory gate and the O_CREAT's own
  // ENOTDIR answer it; MEASURED as the same 404 either way).
  const throughFile = await write({ path: join(path, 'x.txt'), text: 'x\n', eol: 'lf', bom: false });
  assert.equal(throughFile.status, 404, JSON.stringify(throughFile.body));
  assert.deepEqual(throughFile.body, { error: 'This file is no longer there.' });

  // A create whose PARENT is gone is a 404, not a folder the app builds.
  const deep = join(work(), 'no-such-dir', 'x.txt');
  const nested = await write({ path: deep, text: 'x\n', eol: 'lf', bom: false });
  assert.equal(nested.status, 404, JSON.stringify(nested.body));
  assert.equal(existsSync(join(work(), 'no-such-dir')), false, 'and no folder was created');

  // A name no file can have: 200 × `é` is 400 BYTES, over NAME_MAX. Refused
  // before any syscall (pathTooLong), because a realpath that fails
  // ENAMETOOLONG is not the 404 that means "create it" — MEASURED: without
  // that gate this answered 500 `The app could not read this folder.`
  const longName = join(work(), 'é'.repeat(200));
  const tooLong = await write({ path: longName, text: 'x\n', eol: 'lf', bom: false });
  assert.equal(tooLong.status, 400, JSON.stringify(tooLong.body));
  assert.equal(existsSync(longName), false);
});

test('a malformed `expect` or `if` is a 400; an EMPTY one counts as absent', async () => {
  const path = await plant('stamps.txt', 'body\n');
  const body = readBody(await read(path));
  assert.ok(body.changed);

  for (const bad of ['nope', body.stamp.toUpperCase(), `${body.stamp}0`, body.stamp.slice(0, 63), 'g'.repeat(64)]) {
    assert.equal((await read(path, bad)).status, 400, `if=${bad}`);
    const saved = await write({ path, text: 'x\n', eol: 'lf', bom: false, expect: bad });
    assert.equal(saved.status, 400, `expect=${bad}`);
  }
  assert.equal((await write({ path, text: 'x\n', eol: 'lf', bom: false, expect: 7 })).status, 400);
  // The shape is the WHOLE string, anchored at both ends with no `m` flag: a
  // stamp with a trailing newline is not a stamp (`$` would otherwise match
  // before it), and neither is a one-element ARRAY that stringifies to one —
  // the typeof check is what refuses that, not the pattern.
  const withNewline = `${body.stamp}\n`;
  assert.equal((await read(path, withNewline)).status, 400, 'if= with a trailing newline');
  assert.equal(
    (await write({ path, text: 'x\n', eol: 'lf', bom: false, expect: withNewline })).status,
    400,
    'expect with a trailing newline',
  );
  assert.equal(
    (await write({ path, text: 'x\n', eol: 'lf', bom: false, expect: [body.stamp] })).status,
    400,
    'expect as an ARRAY of one stamp',
  );
  assert.equal(await readFile(path, 'utf8'), 'body\n', 'and a 400 writes nothing');

  // EMPTY = absent, on both sides.
  assert.equal((await api(server, 'GET', `/api/fs/read?path=${encodeURIComponent(path)}&if=`)).status, 200);
  const empty = await write({ path, text: 'empty expect\n', eol: 'lf', bom: false, expect: '' });
  assert.equal(empty.status, 200, JSON.stringify(empty.body));
  assert.equal(await readFile(path, 'utf8'), 'empty expect\n');
});

test('`text`, `eol` and `bom` are each a 400 when they are not what they must be', async () => {
  const path = await plant('fields.txt', 'keep\n');
  const bad: unknown[] = [
    { path, eol: 'lf', bom: false },
    { path, text: 42, eol: 'lf', bom: false },
    { path, text: 'x', eol: 'cr', bom: false },
    { path, text: 'x', eol: '', bom: false },
    { path, text: 'x', bom: false },
    { path, text: 'x', eol: 'lf' },
    { path, text: 'x', eol: 'lf', bom: 'yes' },
    'not an object',
    [],
    null,
  ];
  for (const body of bad) {
    const res = await write(body);
    assert.equal(res.status, 400, `${JSON.stringify(body)} -> ${res.status}`);
    assert.deepEqual(res.body, { error: 'The app cannot open that folder.' });
  }
  assert.equal(await readFile(path, 'utf8'), 'keep\n');

  // A body that is not JSON at all: a 400 whose sentence says nothing about
  // the bytes (readJsonBodySafe never lets the parse error out).
  const raw = await rawRequest(server.port, {
    method: 'PUT',
    path: '/api/fs/write',
    headers: { 'x-auth-token': server.token, 'content-type': 'application/json' },
    body: '{"path": "/home/you/x.txt", "text": ',
  });
  assert.equal(raw.status, 400);
  assert.deepEqual(JSON.parse(raw.body), { error: 'The app cannot open that folder.' });
});

// ---------------------------------------------------------------------------
// In place, and nothing else (the orchestrator's default)
// ---------------------------------------------------------------------------

test('a save keeps the inode, the mode and every hard link — it is never a rename', async () => {
  const path = await plant('inplace.txt', 'original\n');
  await chmod(path, 0o640);
  const hard = join(work(), 'inplace-hardlink.txt');
  await link(path, hard);
  const before = await stat(path);
  assert.equal(before.nlink, 2, 'two links to one inode');

  const body = readBody(await read(path));
  assert.ok(body.changed);
  const saved = await write({ path, text: 'rewritten\n', eol: 'lf', bom: false, expect: body.stamp });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));

  const after = await stat(path);
  assert.equal(after.ino, before.ino, 'the SAME inode');
  assert.equal(after.mode, before.mode, 'the same mode (0640, not 0666 minus umask)');
  assert.equal(after.nlink, 2, 'the hard link still points at it');
  assert.equal(await readFile(hard, 'utf8'), 'rewritten\n', 'and sees the new bytes');
  assert.equal(after.size, 10, 'ftruncate + write, not an append');
});

test(
  'a file the user cannot write answers 403 and keeps its bytes',
  { skip: SKIP_IF_ROOT },
  async () => {
    const path = await plant('readonly.txt', 'precious\n');
    const body = readBody(await read(path));
    assert.ok(body.changed, 'a 0444 file is still READABLE');
    await chmod(path, 0o444);

    const saved = await write({ path, text: 'PWNED\n', eol: 'lf', bom: false, expect: body.stamp });
    assert.equal(saved.status, 403, JSON.stringify(saved.body));
    assert.deepEqual(saved.body, { error: 'You do not have permission to change this file.' });
    assert.equal(await readFile(path, 'utf8'), 'precious\n', 'the bytes are untouched');

    // Overwrite (no `expect`) is not a way around the mode either: a
    // rename-based save WOULD have replaced this file through its writable
    // parent, which is exactly why this route writes in place.
    const forced = await write({ path, text: 'PWNED\n', eol: 'lf', bom: false });
    assert.equal(forced.status, 403, JSON.stringify(forced.body));
    assert.equal(await readFile(path, 'utf8'), 'precious\n');
    assert.equal((await stat(path)).mode & 0o777, 0o444, 'and the mode is still 0444');

    const reread = readBody(await read(path));
    assert.ok(reread.changed);
    assert.equal(reread.text, 'precious\n', 'still readable, still the same');
  },
);

test('PIN: Overwrite truncates a BINARY file the read side refused — "mine wins"', async () => {
  // INTENDED, not a gap: `expect` absent is the pane's Overwrite, which does
  // not compare and does not ask what was there. A file the read route answered
  // 415 for (and, the same way, one it answered 413 for) is replaced by the
  // text the user typed.
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
  const path = await plant('mine-wins.png', png);
  const refused = await read(path);
  assert.equal(refused.status, 415, JSON.stringify(refused.body));

  const forced = await write({ path, text: 'text now\n', eol: 'lf', bom: false });
  assert.equal(forced.status, 200, JSON.stringify(forced.body));
  assert.equal(await readFile(path, 'utf8'), 'text now\n', 'the binary bytes are gone');
  assert.equal((await stat(path)).size, 9, 'ftruncate + write, not an append');
});

test(
  'a file the user cannot READ answers 403 with the READ sentence',
  { skip: SKIP_IF_ROOT },
  async () => {
    // The other half of the 403: the write side is pinned on a 0444 file above,
    // and the read side needs a mode that refuses the owner outright.
    const path = await plant('unreadable.txt', 'secret bytes\n');
    await chmod(path, 0o000);
    try {
      const res = await read(path);
      assert.equal(res.status, 403, JSON.stringify(res.body));
      assert.deepEqual(res.body, { error: 'You do not have permission to read this file.' });

      const saved = await write({ path, text: 'PWNED\n', eol: 'lf', bom: false });
      assert.equal(saved.status, 403, JSON.stringify(saved.body));
      assert.deepEqual(saved.body, { error: 'You do not have permission to change this file.' });
    } finally {
      await chmod(path, 0o600);
    }
    assert.equal(await readFile(path, 'utf8'), 'secret bytes\n', 'the bytes are untouched');
  },
);

// ---------------------------------------------------------------------------
// The HTTP shell (§1, §4)
// ---------------------------------------------------------------------------

test('every method other than GET (read) and PUT (write) is a 405', async () => {
  // And the 405 is taken BEFORE the body is read, so it closes the connection:
  // a POST/PUT to either route may be streaming megabytes into a server that
  // has already said no.
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const res = await api(server, method, '/api/fs/read');
    assert.equal(res.status, 405, `${method} /api/fs/read -> ${res.status}`);
    assert.equal(res.headers.get('connection'), 'close', `${method} /api/fs/read closes`);
  }
  for (const method of ['GET', 'POST', 'DELETE', 'PATCH']) {
    const res = await api(server, method, '/api/fs/write');
    assert.equal(res.status, 405, `${method} /api/fs/write -> ${res.status}`);
    assert.equal(res.headers.get('connection'), 'close', `${method} /api/fs/write closes`);
  }
});

test('both routes need the app token', async () => {
  for (const [method, path] of [
    ['GET', '/api/fs/read'],
    ['PUT', '/api/fs/write'],
  ] as const) {
    const noToken = await rawRequest(server.port, { method, path });
    assert.equal(noToken.status, 401, `${method} ${path} without a token`);
    const wrongToken = await rawRequest(server.port, {
      method,
      path,
      headers: { 'x-auth-token': '0'.repeat(64) },
    });
    assert.equal(wrongToken.status, 401, `${method} ${path} with a wrong token`);
  }
});

test('server.log records COUNTS — never a path, never a byte of text, never a stamp', async () => {
  const path = await plant(NAME_CANARY, `${TEXT_CANARY}\n`);
  const body = readBody(await read(path));
  assert.ok(body.changed);
  // The three shapes of line the spec names: bytes, unchanged, a refusal.
  assert.equal(readBody(await read(path, body.stamp)).changed, false);
  assert.equal((await read(join(work(), 'overcap.txt'))).status, 413);
  const saved = await write({ path, text: `${TEXT_CANARY} edited\n`, eol: 'lf', bom: false, expect: body.stamp });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const bytes = (saved.body as FsWriteResponse).bytes;

  await waitForLog(server, `[fs] PUT /api/fs/write -> 200, ${bytes} bytes`);
  const log = await readServerLog(server);
  assert.ok(log.includes(`[fs] GET /api/fs/read -> 200, ${TEXT_CANARY.length + 1} bytes`), 'the read count');
  assert.ok(log.includes('[fs] GET /api/fs/read -> 200, unchanged'), 'the unchanged answer');
  assert.ok(log.includes('[fs] GET /api/fs/read -> 413'), 'a refusal');
  assert.ok(log.includes('[http] GET /api/fs/read ?… -> 200'), 'the access line, query reduced');
  assert.ok(log.includes('[http] PUT /api/fs/write -> 200'), 'and the write access line');

  assert.ok(!log.includes('TEXTNAMECANARY'), 'NO file name reaches the log');
  assert.ok(!log.includes('TEXTBYTESCANARY'), 'NO byte of the text reaches the log');
  assert.ok(!log.includes(body.stamp), 'and no stamp');
  assert.ok(!log.includes((saved.body as FsWriteResponse).stamp), 'not the new one either');
  assert.ok(!log.includes(server.token), 'and never the token');
  // NOT `!log.includes(home)`: the server logs its own data dir at boot, and
  // the fixture data dir lives inside the fixture home. The rule is per LINE —
  // no line about either route may carry the folder the file is in.
  const routeLines = log
    .split('\n')
    .filter((line) => line.includes('/api/fs/read') || line.includes('/api/fs/write'));
  assert.ok(routeLines.length >= 8, `the lines are there to judge: ${routeLines.length}`);
  for (const line of routeLines) {
    assert.ok(!line.includes(work()), `no path in: ${line}`);
    assert.ok(!line.includes('.txt'), `not even a bare name in: ${line}`);
  }
});

test('the log LEVELS are the rule: a 200 on either route is demoted, a refusal is not', async () => {
  // An open pane polls the read route every 5 s and a Ctrl+S burst writes: at
  // info those two would out-shout the rest of server.log, so the ACCESS line
  // of a 200 on either route is demoted to debug. A refusal is the diagnostic
  // and stays info. On the route's OWN `[fs]` channel it is the other way
  // round — every refusal is debug (the access line already carries it), the
  // read's 200 is debug (it is the poll), and the write's 200 is info.
  const path = await plant('levels.txt', 'v1\n');
  const first = readBody(await read(path));
  assert.ok(first.changed);
  assert.equal(readBody(await read(path, first.stamp)).changed, false);
  assert.equal((await read(join(work(), 'no-levels-here.txt'))).status, 404, 'a read refusal');
  await writeFile(path, 'moved under it\n');
  const stale = await write({ path, text: 'x\n', eol: 'lf', bom: false, expect: first.stamp });
  assert.equal(stale.status, 409, 'a write refusal');
  // A byte count no other line in this suite writes: it identifies this save.
  const saved = await write({ path, text: 'z'.repeat(881), eol: 'lf', bom: false });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));

  for (const needle of [
    '[debug] [http] GET /api/fs/read ?… -> 200', // the 5 s poll, demoted
    '[debug] [http] PUT /api/fs/write -> 200', // and the save with it
    '[info] [http] GET /api/fs/read ?… -> 404', // a refusal is never demoted
    '[info] [http] PUT /api/fs/write -> 409',
    '[debug] [fs] GET /api/fs/read -> 404', // the route's own channel
    '[debug] [fs] PUT /api/fs/write -> 409',
    '[debug] [fs] GET /api/fs/read -> 200, 3 bytes',
    '[debug] [fs] GET /api/fs/read -> 200, unchanged',
    '[info] [fs] PUT /api/fs/write -> 200, 881 bytes',
  ]) {
    // waitForLog, not a read-and-hope: the access line is written when the
    // response closes, which is not ordered against the next request.
    await waitForLog(server, needle);
  }
});
