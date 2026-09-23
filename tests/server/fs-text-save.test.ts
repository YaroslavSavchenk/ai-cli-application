/**
 * PUT /api/fs/write — the save (Nocturne B4 phase 1,
 * `.claude/plans/nocturne/PLAN-B4.md` §2): the stamp compare (orchestrator
 * default D4) over the bytes on disk, the body's field rules, and the write IN
 * PLACE — inode, mode and every hard link kept, never a rename.
 *
 * One real server child on a fixture `home` (AI_SM_HOME_OVERRIDE,
 * `tests/helpers/fs-server-fixture.ts`), against the real kernel. Split out of
 * `fs-text.test.ts` (restructure O6).
 *
 * NOT claimed: the editor pane in a browser; a drvfs mount or Windows.
 *
 * Example paths in comments are `/home/you/...`, never anyone's real one.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import {
  chmod,
  link,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { stampOf } from '../../server/fstext.ts';
import { api, rawRequest, SKIP_IF_ROOT } from '../helpers/helpers.ts';
import { bootFsServer, server, stopFsServer, work } from '../helpers/fs-server-fixture.ts';
import { plant, read, readBody, write } from '../helpers/fs-text-fixture.ts';

before(() => bootFsServer('ai-sm-fstxt-'));

after(() =>
  // A 0444 file and a 0500 folder must not be able to defeat the teardown.
  stopFsServer(() => [[join(work(), 'readonly.txt'), 0o600]]),
);

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
