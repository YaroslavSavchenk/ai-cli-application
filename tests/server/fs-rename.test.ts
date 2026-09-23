/**
 * POST /api/fs/rename — rename one entry in place (Nocturne B13 phase 1): the
 * errno table, what renames, a taken name, names, sources and the HTTP shape.
 *
 * One real server child on a fixture `home` (AI_SM_HOME_OVERRIDE, the seam
 * tests/server/fs-delete.test.ts uses; `tests/helpers/fs-server-fixture.ts`),
 * so the boundary, the anchor and data-dir refusals, the symlink rules and the
 * NO-CLOBBER property are exercised against the real filesystem. The errno
 * table is a PURE function and is tested directly.
 *
 * EVERY refusal asserts that BOTH entries are unchanged on disk afterwards:
 * a rename that replaced something would be a hidden permanent delete (D1).
 *
 * Topic pieces: paths as stored, identity, the order of the checks and the
 * stale set in `fs-rename-protected.test.ts`; the paths the real filesystem
 * cannot produce, driven in-process, in `fs-rename-in-process.test.ts`.
 *
 * NOT claimed: a true drvfs mount (case-insensitive, refusing link(2)) —
 * `fs-rename-in-process.test.ts` spies those paths, a real mount stays
 * untested here.
 *
 * Example paths in comments are `/home/you/...`, never anyone's real one.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import {
  chmod,
  link,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import {
  FS_NO_RENAME_PERMISSION,
  FS_RENAME_ANCHOR,
  FS_RENAME_BUSY,
  FS_RENAME_DATA_DIR,
  FS_RENAME_FAILED,
  FS_RENAME_GONE,
  RENAME_MAX_BYTES,
  renameErrorFor,
} from '../../server/fsrename.ts';
import {
  api,
  rawRequest,
  readServerLog,
  startTestServer,
  waitForLog,
  SKIP_IF_ROOT,
  makeTempDir,
  removeTempDir,
} from '../helpers/helpers.ts';
import {
  bootFsServer,
  dataDir,
  evil,
  home,
  NAME_NOT_ALLOWED,
  outside,
  OUTSIDE_HOME,
  PATH_BAD,
  root,
  server,
  stopFsServer,
  work,
} from '../helpers/fs-server-fixture.ts';
import { ALREADY_EXISTS, CANARY, post, refused, renamed, withProject } from '../helpers/fs-rename-fixture.ts';

before(() => bootFsServer('ai-sm-fsren-'));

after(() => stopFsServer(() => [[join(home, 'readonly'), 0o700]]));

// ---------------------------------------------------------------------------
// The errno table, as a pure function
// ---------------------------------------------------------------------------

test('renameErrorFor maps every errno this route can meet', () => {
  const table: [string | undefined, number, string][] = [
    ['ENOENT', 404, FS_RENAME_GONE],
    ['ENOTDIR', 404, FS_RENAME_GONE],
    ['EACCES', 403, FS_NO_RENAME_PERMISSION],
    ['EPERM', 403, FS_NO_RENAME_PERMISSION],
    ['EROFS', 403, FS_NO_RENAME_PERMISSION],
    ['EEXIST', 409, ALREADY_EXISTS],
    ['ENOTEMPTY', 409, ALREADY_EXISTS],
    ['EISDIR', 409, ALREADY_EXISTS],
    ['EBUSY', 409, FS_RENAME_BUSY],
    ['ETXTBSY', 409, FS_RENAME_BUSY],
    ['ENAMETOOLONG', 400, NAME_NOT_ALLOWED],
    ['EXDEV', 500, FS_RENAME_FAILED],
    ['EWHATEVER', 500, FS_RENAME_FAILED],
    [undefined, 500, FS_RENAME_FAILED],
  ];
  for (const [code, status, message] of table) {
    const err = renameErrorFor(code);
    assert.equal(err.status, status, `${String(code)} -> ${err.status}`);
    assert.equal(err.message, message, String(code));
  }
});

test('the sentences are the spec ones and carry no path, name or errno', () => {
  assert.equal(FS_RENAME_GONE, 'That item is no longer there.');
  assert.equal(FS_NO_RENAME_PERMISSION, 'You do not have permission to rename this.');
  assert.equal(FS_RENAME_ANCHOR, 'The app cannot rename your home folder or a project folder.');
  assert.equal(FS_RENAME_DATA_DIR, "The app's own folder cannot be renamed.");
  assert.equal(FS_RENAME_BUSY, 'That item is in use right now.');
  assert.equal(FS_RENAME_FAILED, 'The app could not rename that.');
  for (const s of [FS_RENAME_GONE, FS_NO_RENAME_PERMISSION, FS_RENAME_ANCHOR, FS_RENAME_DATA_DIR, FS_RENAME_BUSY, FS_RENAME_FAILED]) {
    assert.ok(!s.includes('/'), s);
    assert.ok(!/E[A-Z]{3,}/.test(s), s);
  }
});

// ---------------------------------------------------------------------------
// What renames
// ---------------------------------------------------------------------------

test('a file is renamed: new name has the content, old name is gone, no second link left', async () => {
  const src = join(work(), 'notes.txt');
  await writeFile(src, 'NOTES\n');
  const before = await lstat(src);
  await renamed(src, 'renamed.txt');
  assert.equal(existsSync(src), false, 'the old name is gone');
  const dst = join(work(), 'renamed.txt');
  assert.equal(await readFile(dst, 'utf8'), 'NOTES\n');
  const after = await lstat(dst);
  assert.equal(after.ino, before.ino, 'the same file, not a copy');
  assert.equal(after.nlink, 1, 'the link-then-unlink left no extra hard link');
});

test('a folder with contents is renamed whole', async () => {
  const src = join(work(), 'folder');
  await mkdir(join(src, 'a', 'b'), { recursive: true });
  await writeFile(join(src, 'a', 'b', 'deep.txt'), 'DEEP\n');
  await renamed(src, 'folder2');
  assert.equal(existsSync(src), false);
  assert.equal(await readFile(join(work(), 'folder2', 'a', 'b', 'deep.txt'), 'utf8'), 'DEEP\n');
});

test('a symlink to a folder: the LINK is renamed, its target untouched', async () => {
  const target = join(evil, 'linked-dir');
  await mkdir(target);
  await writeFile(join(target, 'keep.txt'), 'KEEP\n');
  const src = join(work(), 'to-dir');
  await symlink(target, src);
  await renamed(src, 'to-dir-2');
  const dst = join(work(), 'to-dir-2');
  assert.equal(existsSync(src), false);
  assert.ok((await lstat(dst)).isSymbolicLink(), 'still a link');
  assert.equal(await readlink(dst), target, 'pointing where it did');
  assert.deepEqual(await readdir(evil), ['linked-dir'], 'the target folder kept its name');
  assert.equal(await readFile(join(target, 'keep.txt'), 'utf8'), 'KEEP\n');
});

test('a dangling symlink is renamed as itself', async () => {
  const src = join(work(), 'dangling');
  await symlink(join(evil, 'no-such-thing'), src);
  await renamed(src, 'dangling-2');
  assert.equal((await lstat(join(work(), 'dangling-2'))).isSymbolicLink(), true);
  assert.equal(await readlink(join(work(), 'dangling-2')), join(evil, 'no-such-thing'));
  await assert.rejects(lstat(src), { code: 'ENOENT' });
});

test('a symlink to HOME (an anchor) is only a name: renamed, home untouched', async () => {
  const src = join(work(), 'to-home');
  await symlink(home, src);
  await renamed(src, 'to-home-2');
  assert.equal(await readlink(join(work(), 'to-home-2')), home);
  assert.ok(existsSync(work()));
});

test('the same name is a 200 with nothing done', async () => {
  const src = join(work(), 'same.txt');
  await writeFile(src, 'SAME\n');
  const ino = (await lstat(src)).ino;
  await renamed(src, 'same.txt');
  assert.equal((await lstat(src)).ino, ino);
  assert.equal((await lstat(src)).nlink, 1);
});

test('a case-only rename works on ext4 (a different name here)', async () => {
  const src = join(work(), 'readme.md');
  await writeFile(src, 'CASE\n');
  await renamed(src, 'README.md');
  const names = await readdir(work());
  assert.ok(names.includes('README.md'));
  assert.ok(!names.includes('readme.md'));
});

test('a case-only rename onto a HARD LINK of the same file (rename(2) is a no-op) is a 409', async () => {
  const src = join(work(), 'hl.txt');
  await writeFile(src, 'HL\n');
  await link(src, join(work(), 'HL.txt'));
  await refused(src, 'HL.txt', 409, ALREADY_EXISTS);
  const names = await readdir(work());
  assert.ok(names.includes('hl.txt') && names.includes('HL.txt'), 'both names still there');
  assert.equal(await readFile(src, 'utf8'), 'HL\n');
});

test('a case-only rename onto a DIFFERENT entry is a 409', async () => {
  const src = join(work(), 'case.txt');
  await writeFile(src, 'lower\n');
  await writeFile(join(work(), 'CASE.txt'), 'UPPER\n');
  await refused(src, 'CASE.txt', 409, ALREADY_EXISTS);
  assert.equal(await readFile(src, 'utf8'), 'lower\n');
  assert.equal(await readFile(join(work(), 'CASE.txt'), 'utf8'), 'UPPER\n');
});

// ---------------------------------------------------------------------------
// A taken name is REFUSED (D1) — both entries unchanged
// ---------------------------------------------------------------------------

test('a taken name — file, folder, dangling link — is a 409 and nothing moves', async () => {
  const dir = join(work(), 'taken');
  await mkdir(dir);
  const file = join(dir, 'a.txt');
  const otherFile = join(dir, 'b.txt');
  const folder = join(dir, 'f1');
  const otherFolder = join(dir, 'f2');
  const dangling = join(dir, 'ghost');
  await writeFile(file, 'A\n');
  await writeFile(otherFile, 'B\n');
  await mkdir(folder);
  await writeFile(join(folder, 'in1.txt'), '1\n');
  await mkdir(otherFolder);
  await writeFile(join(otherFolder, 'in2.txt'), '2\n');
  await symlink(join(evil, 'nothing-here'), dangling);

  const snapshot = async (): Promise<string> =>
    JSON.stringify([
      (await readdir(dir)).sort(),
      await readFile(file, 'utf8'),
      await readFile(otherFile, 'utf8'),
      await readdir(folder),
      await readdir(otherFolder),
      await readlink(dangling),
    ]);
  const start = await snapshot();

  // file -> an existing file, a folder, a dangling link
  await refused(file, 'b.txt', 409, ALREADY_EXISTS);
  await refused(file, 'f1', 409, ALREADY_EXISTS);
  await refused(file, 'ghost', 409, ALREADY_EXISTS);
  // folder -> an existing folder (even an EMPTY-looking one is refused up front), a file, a dangling link
  await refused(folder, 'f2', 409, ALREADY_EXISTS);
  await refused(folder, 'a.txt', 409, ALREADY_EXISTS);
  await refused(folder, 'ghost', 409, ALREADY_EXISTS);
  // a link -> a taken name
  await refused(dangling, 'a.txt', 409, ALREADY_EXISTS);

  assert.equal(await snapshot(), start, 'both sides of every refusal are unchanged');
  assert.equal((await lstat(file)).nlink, 1, 'no stray hard link');
});

test('an EMPTY folder as the target is still refused — never replaced', async () => {
  const src = join(work(), 'full');
  await mkdir(src);
  await writeFile(join(src, 'x.txt'), 'x\n');
  await mkdir(join(work(), 'empty'));
  await refused(src, 'empty', 409, ALREADY_EXISTS);
  assert.ok(existsSync(join(src, 'x.txt')));
  assert.deepEqual(await readdir(join(work(), 'empty')), []);
});

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

test('a bad NEW name is a 400 and nothing moves', async () => {
  const src = join(work(), 'named.txt');
  await writeFile(src, 'N\n');
  const bad = ['a/b', '..', '.', '...', 'a\0b', '\0', 'é'.repeat(128), '', 'a\\b', 'tab\there'];
  for (const name of bad) await refused(src, name, 400, NAME_NOT_ALLOWED);
  assert.equal(await readFile(src, 'utf8'), 'N\n');
  assert.ok(!existsSync(join(work(), 'a')), 'nothing created by `a/b`');
  // 255 bytes exactly is fine (127 x `é` = 254 bytes + `x`).
  const ok = `${'é'.repeat(127)}x`;
  assert.equal(Buffer.byteLength(ok), 255);
  await renamed(src, ok);
  assert.equal(await readFile(join(work(), ok), 'utf8'), 'N\n');
});

test('a non-string path is the PATH sentence; a non-string name the NAME sentence', async () => {
  const src = join(work(), 'types.txt');
  await writeFile(src, 'T\n');
  await refused(42, 'x', 400, PATH_BAD);
  await refused(null, 'x', 400, PATH_BAD);
  await refused(undefined, 'x', 400, PATH_BAD);
  await refused(src, 42, 400, NAME_NOT_ALLOWED);
  await refused(src, ['x'], 400, NAME_NOT_ALLOWED);
  await refused(src, undefined, 400, NAME_NOT_ALLOWED);
  const notObject = await post(['x']);
  assert.equal(notObject.status, 400);
  const nullBody = await post(null);
  assert.equal(nullBody.status, 400);
  assert.equal(await readFile(src, 'utf8'), 'T\n');
});

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

test('a malformed source is refused BEFORE resolve — relative, NUL, root, empty', async () => {
  await writeFile(join(work(), 'x.txt'), 'x\n');
  await refused('work/x.txt', 'y.txt', 400, PATH_BAD);
  await refused('./x.txt', 'y.txt', 400, PATH_BAD);
  await refused('', 'y.txt', 400, PATH_BAD);
  await refused(`${work()}/x.txt\0`, 'y.txt', 400, PATH_BAD);
  await refused('/', 'y', 400, NAME_NOT_ALLOWED);
  // An over-long OLD name is refused before the parent is resolved.
  await refused(join(work(), 'é'.repeat(128)), 'y', 400, NAME_NOT_ALLOWED);
  assert.ok(existsSync(join(work(), 'x.txt')));
  assert.ok(!existsSync(join(work(), 'y.txt')));
});

test('a missing source is a 404; a missing parent is a 404', async () => {
  await refused(join(work(), 'nope.txt'), 'y.txt', 404, FS_RENAME_GONE);
  await refused(join(work(), 'nodir', 'nope.txt'), 'y.txt', 404, FS_RENAME_GONE);
});

test('home, `<home>/x/..`, a project root and the parent of a project root are anchors', async () => {
  await refused(home, 'home2', 403, FS_RENAME_ANCHOR);
  await refused(`${work()}/..`, 'home2', 403, FS_RENAME_ANCHOR);
  await refused(`${home}/`, 'home2', 403, FS_RENAME_ANCHOR);
  assert.ok(existsSync(home));

  const holder = join(home, 'projects');
  const proj = join(holder, 'foo');
  await mkdir(proj, { recursive: true });
  await writeFile(join(proj, 'src.txt'), 'SRC\n');
  await withProject('Foo', proj, async () => {
    await refused(proj, 'bar', 403, FS_RENAME_ANCHOR);
    await refused(holder, 'projects2', 403, FS_RENAME_ANCHOR);
    // A folder two levels above a project too.
    const deep = join(home, 'nest', 'a', 'proj');
    await mkdir(deep, { recursive: true });
    await withProject('Deep', deep, async () => {
      await refused(join(home, 'nest'), 'nest2', 403, FS_RENAME_ANCHOR);
      await refused(join(home, 'nest', 'a'), 'a2', 403, FS_RENAME_ANCHOR);
      assert.ok(existsSync(deep));
    });
    // Renaming something ONTO a project root's path is refused as an anchor.
    await mkdir(join(holder, 'other'));
    await refused(join(holder, 'other'), 'foo', 403, FS_RENAME_ANCHOR);
    // A project OUTSIDE home is an anchor like home; its children are content.
    await withProject('Outside', outside, async () => {
      await refused(outside, 'outside2', 403, FS_RENAME_ANCHOR);
      await writeFile(join(outside, 'child.txt'), 'C\n');
      await renamed(join(outside, 'child.txt'), 'child2.txt');
      assert.equal(await readFile(join(outside, 'child2.txt'), 'utf8'), 'C\n');
    });
  });
  assert.equal(await readFile(join(proj, 'src.txt'), 'utf8'), 'SRC\n', 'the project is whole');
  // Unregistered, the holder is an ordinary folder.
  await renamed(holder, 'projects2');
  assert.ok(existsSync(join(home, 'projects2', 'foo', 'src.txt')));
});

test('the data dir, a child of it, and a rename ONTO its name are refused', async () => {
  await writeFile(join(dataDir, 'canary-in-data.txt'), 'x\n');
  await refused(dataDir, 'dd', 403, FS_RENAME_DATA_DIR);
  await refused(join(dataDir, 'canary-in-data.txt'), 'moved.txt', 403, FS_RENAME_DATA_DIR);
  await refused(join(dataDir, 'runtime.json'), 'r.json', 403, FS_RENAME_DATA_DIR);
  await mkdir(join(home, 'impostor'));
  await refused(join(home, 'impostor'), '.ai-session-manager', 403, FS_RENAME_DATA_DIR);
  assert.ok(existsSync(join(dataDir, 'runtime.json')));
  assert.ok(existsSync(join(dataDir, 'canary-in-data.txt')));
  assert.ok(existsSync(join(home, 'impostor')));
});

test('a folder CONTAINING a nested custom data dir is refused', async () => {
  const nestRoot = await realpath(await makeTempDir('ai-sm-fsren2-'));
  const nestHome = join(nestRoot, 'home');
  const nestData = join(nestHome, 'dd', 'data');
  await mkdir(join(nestHome, 'dd'), { recursive: true });
  const second = await startTestServer({ dataDir: nestData, env: { AI_SM_HOME_OVERRIDE: nestHome } });
  try {
    const ask = (p: string, name: string) => api(second, 'POST', '/api/fs/rename', { path: p, name });
    assert.ok(existsSync(join(nestData, 'runtime.json')));
    const holder = await ask(join(nestHome, 'dd'), 'dd2');
    assert.equal(holder.status, 403);
    assert.deepEqual(holder.body, { error: FS_RENAME_DATA_DIR });
    const itself = await ask(nestData, 'data2');
    assert.equal(itself.status, 403);
    assert.deepEqual(itself.body, { error: FS_RENAME_DATA_DIR });
    // Through a link: judged where it lands.
    await symlink(nestData, join(nestHome, 'data-link'));
    const through = await ask(join(nestHome, 'data-link', 'runtime.json'), 'r.json');
    assert.equal(through.status, 403);
    assert.deepEqual(through.body, { error: FS_RENAME_DATA_DIR });
    // The LINK itself is only a name.
    assert.equal((await ask(join(nestHome, 'data-link'), 'data-link-2')).status, 200);
    assert.ok(existsSync(join(nestData, 'runtime.json')), 'the data dir is whole');
    // A sibling folder is ordinary content.
    await mkdir(join(nestHome, 'other'));
    assert.equal((await ask(join(nestHome, 'other'), 'other2')).status, 200);
  } finally {
    await second.stop();
    await removeTempDir(nestRoot);
  }
});

test('an intermediate symlink is judged where it LANDS — out is 403, in renames at the real place', async () => {
  const outsideFile = join(evil, 'gate-target.txt');
  await writeFile(outsideFile, 'GATE\n');
  const gate = join(home, 'gate');
  await symlink(evil, gate);
  await refused(join(gate, 'gate-target.txt'), 'moved.txt', 403, OUTSIDE_HOME);
  assert.equal(await readFile(outsideFile, 'utf8'), 'GATE\n');
  assert.ok(!existsSync(join(evil, 'moved.txt')));

  const inward = join(home, 'inward');
  await symlink(work(), inward);
  await writeFile(join(work(), 'through.txt'), 'T\n');
  await renamed(join(inward, 'through.txt'), 'through2.txt');
  assert.equal(await readFile(join(work(), 'through2.txt'), 'utf8'), 'T\n', 'renamed at the real location');
  assert.ok(!existsSync(join(work(), 'through.txt')));
});

test('a path outside home and every project is the outside-home refusal', async () => {
  await writeFile(join(evil, 'x.txt'), 'x\n');
  await refused(join(evil, 'x.txt'), 'y.txt', 403, OUTSIDE_HOME);
  await refused(`${home}/../homeevil/x.txt`, 'y.txt', 403, OUTSIDE_HOME);
  assert.ok(existsSync(join(evil, 'x.txt')));
});

test('an unwritable parent is a 403 with the RENAME sentence', { skip: SKIP_IF_ROOT }, async () => {
  const ro = join(home, 'readonly');
  await mkdir(ro);
  await writeFile(join(ro, 'locked.txt'), 'L\n');
  await mkdir(join(ro, 'lockeddir'));
  await chmod(ro, 0o500);
  try {
    await refused(join(ro, 'locked.txt'), 'l2.txt', 403, FS_NO_RENAME_PERMISSION);
    await refused(join(ro, 'lockeddir'), 'ld2', 403, FS_NO_RENAME_PERMISSION);
  } finally {
    await chmod(ro, 0o700);
  }
  assert.deepEqual((await readdir(ro)).sort(), ['locked.txt', 'lockeddir']);
});

// ---------------------------------------------------------------------------
// The HTTP shape
// ---------------------------------------------------------------------------

test('405, 415, 413 and 401 are refused before the body is read, with connection: close', async () => {
  const src = join(work(), 'survivor.txt');
  await writeFile(src, 'S\n');
  const body = JSON.stringify({ path: src, name: 'moved.txt' });
  const json = { 'x-auth-token': server.token, 'content-type': 'application/json' };
  const cases: [string, Record<string, string>, string, number][] = [
    ['GET', json, body, 405],
    ['DELETE', json, body, 405],
    ['PUT', json, body, 405],
    ['POST', { 'x-auth-token': server.token, 'content-type': 'text/plain' }, body, 415],
    ['POST', { 'x-auth-token': server.token, 'content-type': 'application/x-www-form-urlencoded' }, body, 415],
    ['POST', json, JSON.stringify({ path: src, name: 'x'.repeat(RENAME_MAX_BYTES) }), 413],
    ['POST', { 'content-type': 'application/json' }, body, 401],
    ['POST', { 'content-type': 'application/json', 'x-auth-token': '0'.repeat(64) }, body, 401],
  ];
  for (const [method, headers, payload, status] of cases) {
    const res = await rawRequest(server.port, { method, path: '/api/fs/rename', headers, body: payload });
    assert.equal(res.status, status, `${method} ${status}: ${res.body}`);
    assert.equal(res.headers['connection'], 'close', `${method} ${status} ends the connection`);
  }
  const big = await rawRequest(server.port, {
    method: 'POST',
    path: '/api/fs/rename',
    headers: json,
    body: JSON.stringify({ path: src, name: 'x'.repeat(RENAME_MAX_BYTES) }),
  });
  assert.deepEqual(JSON.parse(big.body), { error: PATH_BAD });
  assert.ok(existsSync(src), 'no refusal moved anything');
  assert.ok(!existsSync(join(work(), 'moved.txt')));
});

test('malformed JSON is a plain 400 with the PATH sentence', async () => {
  const res = await rawRequest(server.port, {
    method: 'POST',
    path: '/api/fs/rename',
    headers: { 'x-auth-token': server.token, 'content-type': 'application/json' },
    body: `{"path":"${work()}/${CANARY}_json.txt","name":`,
  });
  assert.equal(res.status, 400);
  assert.deepEqual(JSON.parse(res.body), { error: PATH_BAD });
});

test('server.log has statuses only — never a name or a path; no body carries a path', async () => {
  const file = join(work(), `${CANARY}_old.txt`);
  await writeFile(file, 'x\n');
  const bodies: unknown[] = [];
  const collect = async (p: unknown, n: unknown): Promise<void> => {
    bodies.push((await post({ path: p, name: n })).body);
  };
  await collect(file, `${CANARY}_new.txt`);
  await collect(join(work(), `${CANARY}_missing.txt`), `${CANARY}_x.txt`);
  await collect(join(work(), `${CANARY}_new.txt`), `${CANARY}/bad`);
  await collect(home, `${CANARY}_home`);
  await collect(join(evil, `${CANARY}.txt`), `${CANARY}_y`);
  await waitForLog(server, '[fs] POST /api/fs/rename -> 200');
  await waitForLog(server, '[fs] POST /api/fs/rename -> 404');

  const log = await readServerLog(server);
  assert.ok(log.includes('[http] POST /api/fs/rename -> 200'), 'the access line');
  assert.ok(log.includes('[fs] POST /api/fs/rename -> 403'));
  assert.ok(!log.includes(CANARY), 'NO name reaches the log');
  assert.ok(!log.includes(work()), 'no path either');
  // (Not `root`: the boot lines name the data dir, which lives under it.)
  assert.ok(!log.includes(evil), 'nor the outside path');
  const text = JSON.stringify(bodies);
  assert.ok(!text.includes(CANARY), `no name in any body: ${text}`);
  assert.ok(!text.includes(root), 'no path in any body');
  assert.ok(!/E[A-Z]{3,}/.test(text), 'no errno');
});

test('a content-type that merely CONTAINS json is a 415; a malformed body keeps the connection', async () => {
  const src = join(work(), 'ctype.txt');
  await writeFile(src, 'c\n');
  const body = JSON.stringify({ path: src, name: 'ctype2.txt' });
  for (const type of ['text/json', 'application/json-patch+json', 'application/jsonx']) {
    const res = await rawRequest(server.port, {
      method: 'POST',
      path: '/api/fs/rename',
      headers: { 'x-auth-token': server.token, 'content-type': type },
      body,
    });
    assert.equal(res.status, 415, type);
  }
  assert.ok(existsSync(src));
  const bad = await rawRequest(server.port, {
    method: 'POST',
    path: '/api/fs/rename',
    headers: { 'x-auth-token': server.token, 'content-type': 'application/json' },
    body: '{"path":',
  });
  assert.equal(bad.status, 400);
  assert.notEqual(bad.headers['connection'], 'close', 'the body WAS read: the connection stays usable');
});
