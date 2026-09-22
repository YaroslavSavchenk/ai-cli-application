/**
 * POST /api/fs/rename — rename one entry in place (Nocturne B13 phase 1).
 *
 * One real server child on a fixture `home` (AI_SM_HOME_OVERRIDE, the seam
 * tests/fs-delete.test.ts uses), so the boundary, the anchor and data-dir
 * refusals, the symlink rules and the NO-CLOBBER property are exercised
 * against the real filesystem. The errno table is a PURE function and is
 * tested directly.
 *
 * EVERY refusal asserts that BOTH entries are unchanged on disk afterwards:
 * a rename that replaced something would be a hidden permanent delete (D1).
 *
 * No filesystem in this checkout refuses link(2), fails an unlink the link
 * succeeded on, or is case-insensitive: those paths (the drvfs fallback, the
 * unlink rollback, the case-only rename on drvfs) are driven IN-PROCESS at the
 * end of this file, with node:fs/promises spied. A true drvfs mount stays
 * untested here.
 *
 * Example paths in comments are `/home/you/...`, never anyone's real one.
 */
import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import fsp, {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rename as fsRename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Project } from '../shared/protocol.ts';
import {
  FS_NO_RENAME_PERMISSION,
  FS_RENAME_ANCHOR,
  FS_RENAME_BUSY,
  FS_RENAME_DATA_DIR,
  FS_RENAME_FAILED,
  FS_RENAME_GONE,
  RENAME_MAX_BYTES,
  handleRename,
  renameErrorFor,
} from '../server/fsrename.ts';
import { FS_PROTECT_UNAVAILABLE, protectedSetFor, resetProtectedSetCache, type ProtectedSet } from '../server/fsprotect.ts';
import { api, rawRequest, readServerLog, startTestServer, waitForLog, type TestServer } from './helpers.ts';

let server: TestServer;
let root: string;
let home: string;
/** A folder OUTSIDE home — also the `<home>evil` string-prefix trap. */
let evil: string;
let outside: string;
let dataDir: string;

/** Names that must NEVER reach server.log. */
const CANARY = 'RENAMECANARY';

const OUTSIDE_HOME = 'This folder is outside your home folder.';
const NAME_NOT_ALLOWED = 'That name is not allowed.';
const PATH_BAD = 'The app cannot open that folder.';
const ALREADY_EXISTS = 'Something with that name already exists here.';

before(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'ai-sm-fsren-')));
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
    await chmod(join(home, 'readonly'), 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

const work = (): string => join(home, 'work');

/** POST /api/fs/rename with any body value (so bad shapes are testable too). */
const post = (body: unknown): Promise<{ status: number; body: unknown }> =>
  api(server, 'POST', '/api/fs/rename', body);

/** A refusal: status and the exact `{ error }` body. */
async function refused(path: unknown, name: unknown, status: number, error: string): Promise<void> {
  const res = await post({ path, name });
  assert.equal(res.status, status, `${String(path)} -> ${String(name)}: ${JSON.stringify(res.body)}`);
  assert.deepEqual(res.body, { error });
}

/** A success: 200 and an EMPTY body. */
async function renamed(path: string, name: string): Promise<void> {
  const res = await post({ path, name });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body, {}, 'no path, no name comes back');
}

async function withProject<T>(name: string, path: string, fn: () => Promise<T>): Promise<T> {
  const created = await api(server, 'POST', '/api/projects', { name, path });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  try {
    return await fn();
  } finally {
    const id = (created.body as Project).id;
    assert.equal((await api(server, 'DELETE', `/api/projects/${id}`)).status, 200);
  }
}

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
  const nestRoot = await realpath(await mkdtemp(join(tmpdir(), 'ai-sm-fsren2-')));
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
    await rm(nestRoot, { recursive: true, force: true });
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

test('an unwritable parent is a 403 with the RENAME sentence', { skip: process.getuid?.() === 0 ? 'running as root' : false }, async () => {
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

// ---------------------------------------------------------------------------
// Paths AS STORED (B13 security review F1/F2): a project or data dir reached
// through a symlink is protected by its stored/configured path too, not only
// by its realpath.
// ---------------------------------------------------------------------------

test('a project registered THROUGH a symlink: the link and a symlinked ancestor are anchors', async () => {
  const realProj = join(home, 'real-proj');
  await mkdir(realProj);
  await writeFile(join(realProj, 'src.txt'), 'SRC\n');
  const projLink = join(home, 'proj-link');
  await symlink(realProj, projLink);
  await withProject('ViaLink', projLink, async () => {
    await refused(projLink, 'proj-link-2', 403, FS_RENAME_ANCHOR);
  });
  assert.equal(await readlink(projLink), realProj, 'the link is unchanged');

  // `<home>/lnk -> <home>/real-holder`, project stored as `<home>/lnk/proj`.
  const realHolder = join(home, 'real-holder');
  await mkdir(join(realHolder, 'proj'), { recursive: true });
  const lnk = join(home, 'lnk');
  await symlink(realHolder, lnk);
  await withProject('ViaAncestor', join(lnk, 'proj'), async () => {
    await refused(lnk, 'lnk-2', 403, FS_RENAME_ANCHOR);
    // Reached through a SECOND link to home: `src` (under the real parent) is
    // still the stored ancestor.
    await symlink(home, join(work(), 'home-again'));
    await refused(join(work(), 'home-again', 'lnk'), 'lnk-3', 403, FS_RENAME_ANCHOR);
  });
  assert.equal(await readlink(lnk), realHolder, 'the ancestor link is unchanged');
  assert.ok(existsSync(join(realHolder, 'proj')));
  // Unregistered, both links are ordinary names again.
  await renamed(projLink, 'proj-link-2');
  await renamed(lnk, 'lnk-2');
});

test('a data dir CONFIGURED through a symlink: the link holding it is refused', async () => {
  const nestRoot = await realpath(await mkdtemp(join(tmpdir(), 'ai-sm-fsren3-')));
  const nestHome = join(nestRoot, 'home');
  const realDd = join(nestHome, 'real-dd');
  await mkdir(realDd, { recursive: true });
  const ddlink = join(nestHome, 'ddlink');
  await symlink(realDd, ddlink);
  const second = await startTestServer({ dataDir: join(ddlink, 'data'), env: { AI_SM_HOME_OVERRIDE: nestHome } });
  try {
    assert.ok(existsSync(join(realDd, 'data', 'runtime.json')), 'the fixture really lives behind the link');
    const res = await api(second, 'POST', '/api/fs/rename', { path: ddlink, name: 'ddlink-2' });
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.deepEqual(res.body, { error: FS_RENAME_DATA_DIR });
    assert.equal(await readlink(ddlink), realDd, 'the link is unchanged');
    assert.ok(existsSync(join(ddlink, 'data', 'runtime.json')), 'the configured path still reaches the data dir');
  } finally {
    await second.stop();
    await rm(nestRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// By IDENTITY (B13 security re-review round 2, server/fsprotect.ts): a symlink
// DEEPER in a chain escapes every string test; dev+ino does not.
// ---------------------------------------------------------------------------

test('P10: a link deeper in a stored project chain, and the folder it sits in, are anchors', async () => {
  // Project stored as `<home>/p10a/lnk/proj`; `p10a -> <home>/p10b`;
  // `<home>/p10b/lnk -> <home>/p10c`; the project really is `<home>/p10c/proj`.
  const b = join(home, 'p10b');
  const c = join(home, 'p10c');
  await mkdir(b);
  await mkdir(join(c, 'proj'), { recursive: true });
  await symlink(b, join(home, 'p10a'));
  await symlink(c, join(b, 'lnk'));
  await withProject('P10', join(home, 'p10a', 'lnk', 'proj'), async () => {
    await refused(join(b, 'lnk'), 'lnk2', 403, FS_RENAME_ANCHOR);
    await refused(b, 'p10b2', 403, FS_RENAME_ANCHOR);
  });
  assert.equal(await readlink(join(b, 'lnk')), c, 'the deep link is unchanged');
  assert.ok(existsSync(join(home, 'p10a', 'lnk', 'proj')), 'the stored path still reaches the project');
  // A sibling in the same folder is ordinary content.
  await writeFile(join(b, 'sibling.txt'), 's\n');
  await renamed(join(b, 'sibling.txt'), 'sibling2.txt');
});

test('P12: a link deeper in the CONFIGURED data dir chain is refused as the data dir', async () => {
  // AI_SM_DATA_DIR=<home>/x/dl/data, `x -> y`, `y/dl -> z`.
  const nestRoot = await realpath(await mkdtemp(join(tmpdir(), 'ai-sm-fsren4-')));
  const nestHome = join(nestRoot, 'home');
  const y = join(nestHome, 'y');
  const z = join(nestHome, 'z');
  await mkdir(y, { recursive: true });
  await mkdir(z);
  await symlink('y', join(nestHome, 'x')); // relative on purpose
  await symlink(z, join(y, 'dl'));
  const second = await startTestServer({
    dataDir: join(nestHome, 'x', 'dl', 'data'),
    env: { AI_SM_HOME_OVERRIDE: nestHome },
  });
  try {
    assert.ok(existsSync(join(z, 'data', 'runtime.json')), 'the data dir really lives in z');
    for (const [p, name] of [
      [join(y, 'dl'), 'dl2'],
      [y, 'y2'],
      [join(nestHome, 'x'), 'x2'],
    ] as const) {
      const res = await api(second, 'POST', '/api/fs/rename', { path: p, name });
      assert.equal(res.status, 403, `${p}: ${JSON.stringify(res.body)}`);
      assert.deepEqual(res.body, { error: FS_RENAME_DATA_DIR });
    }
    assert.equal(await readlink(join(y, 'dl')), z);
    assert.ok(existsSync(join(nestHome, 'x', 'dl', 'data', 'runtime.json')), 'the configured path still works');
  } finally {
    await second.stop();
    await rm(nestRoot, { recursive: true, force: true });
  }
});

test('N5: nothing is renamed ONTO a stored project path', async () => {
  const stale = join(home, 'stale-proj');
  await mkdir(stale);
  await withProject('Stale', stale, async () => {
    await rm(stale, { recursive: true });
    const other = join(home, 'wannabe');
    await mkdir(other);
    await refused(other, 'stale-proj', 403, FS_RENAME_ANCHOR);
    assert.ok(existsSync(other));
    assert.ok(!existsSync(stale));
  });
});

// ---------------------------------------------------------------------------
// Test-gate additions (B13 phases 0+1 mutation probe).
// ---------------------------------------------------------------------------

test('ORDER: the old name\'s byte limit is judged before the boundary; the new name\'s before the anchor tests', async () => {
  // Step 1: a 256-byte OLD name outside home is the NAME refusal, not "outside".
  await refused(join(evil, 'é'.repeat(128)), 'y', 400, NAME_NOT_ALLOWED);
  // Step 4 before step 5: a 256-byte NEW name for a folder that holds a
  // project is the NAME refusal, not the anchor one.
  const holder = join(home, 'order-holder');
  await mkdir(join(holder, 'proj'), { recursive: true });
  await withProject('Order', join(holder, 'proj'), async () => {
    await refused(holder, 'é'.repeat(128), 400, NAME_NOT_ALLOWED);
    await refused(holder, `${'é'.repeat(127)}x`, 403, FS_RENAME_ANCHOR);
  });
});

test('ORDER: the same-name no-op comes AFTER the anchor and boundary checks', async () => {
  await writeFile(join(evil, 'same-out.txt'), 'x\n');
  await refused(join(evil, 'same-out.txt'), 'same-out.txt', 403, OUTSIDE_HOME);
  await refused(home, 'home', 403, FS_RENAME_ANCHOR);
});

test('a PREFIX sibling of a project root (`fo` next to `foo`) is ordinary content', async () => {
  const holder = join(home, 'pfx');
  await mkdir(join(holder, 'foo'), { recursive: true });
  await mkdir(join(holder, 'fo'));
  await withProject('Pfx', join(holder, 'foo'), async () => {
    await renamed(join(holder, 'fo'), 'fo2');
  });
  assert.ok(existsSync(join(holder, 'fo2')));
});

test('renaming ONTO a project realpath registered through a link is the anchor refusal, not a 409', async () => {
  const real = join(home, 's6-real');
  await mkdir(real);
  await symlink(real, join(home, 's6-link'));
  await mkdir(join(home, 's6-other'));
  await withProject('S6', join(home, 's6-link'), async () => {
    await refused(join(home, 's6-other'), 's6-real', 403, FS_RENAME_ANCHOR);
  });
});

test('N5 both spellings: onto the stored path through the REAL parent, and through the LINKED parent', async () => {
  // Stored as `<home>/s4-real/stale`; asked through `<home>/s4-link/…`: only
  // the join under the REAL parent (`dst`) spells the stored path.
  const r4 = join(home, 's4-real');
  await mkdir(join(r4, 'stale'), { recursive: true });
  await mkdir(join(r4, 'other'));
  await symlink(r4, join(home, 's4-link'));
  await withProject('S4', join(r4, 'stale'), async () => {
    await rm(join(r4, 'stale'), { recursive: true });
    await refused(join(home, 's4-link', 'other'), 'stale', 403, FS_RENAME_ANCHOR);
    assert.ok(!existsSync(join(r4, 'stale')));
  });
  // Stored as `<home>/s5-link/stale`: only the LEXICAL join spells it.
  const r5 = join(home, 's5-real');
  await mkdir(join(r5, 'stale'), { recursive: true });
  await mkdir(join(r5, 'other'));
  await symlink(r5, join(home, 's5-link'));
  await withProject('S5', join(home, 's5-link', 'stale'), async () => {
    await rm(join(r5, 'stale'), { recursive: true });
    await refused(join(home, 's5-link', 'other'), 'stale', 403, FS_RENAME_ANCHOR);
    assert.ok(!existsSync(join(r5, 'stale')));
  });
});

// The STRING tests stay as a first line because the identity set is cached for
// PROTECT_TTL_MS (server/fsprotect.ts). These prime that cache with an
// ordinary rename, then give the protected entry a NEW inode (created before
// the old one goes, so the number cannot be reused), so the next request is
// judged against a set that no longer knows it: only the string layer under
// test can refuse. (Past the TTL the identity check refuses too — the tests
// then still pass, they just stop singling one layer out.)
//
// A priming file is CREATED BEFORE any swap: a file made right after a swap can
// get the inode number the swap just freed, which the stale set still holds
// as protected (a harmless false refusal, but not the request under test).
let primeN = 0;
async function primeFile(dir: string): Promise<string> {
  primeN += 1;
  const p = join(dir, `prime-${primeN}.txt`);
  await writeFile(p, 'p\n');
  return p;
}
async function primeSet(srv: TestServer, dirOrFile: string): Promise<void> {
  const p = dirOrFile.endsWith('.txt') ? dirOrFile : await primeFile(dirOrFile);
  const res = await api(srv, 'POST', '/api/fs/rename', { path: p, name: `primed-${p.slice(p.lastIndexOf('-') + 1)}` });
  assert.equal(res.status, 200, JSON.stringify(res.body));
}
/** Replace the symlink at `at` with a new one to the same target (new inode). */
async function relink(at: string): Promise<void> {
  const before = await lstat(at);
  const target = await readlink(at);
  const tmp = `${at}.relink`;
  await symlink(target, tmp);
  await fsRename(tmp, at);
  assert.notEqual((await lstat(at)).ino, before.ino, 'premise: a new inode');
}
/** Replace the folder at `at` with a new one holding the same children. */
async function refolder(at: string): Promise<void> {
  const before = await lstat(at);
  const fresh = `${at}.refolder`;
  await mkdir(fresh);
  for (const child of await readdir(at)) await fsRename(join(at, child), join(fresh, child));
  await fsRename(fresh, at);
  assert.notEqual((await lstat(at)).ino, before.ino, 'premise: a new inode');
}

test('STALE set: a folder holding a project REALPATH is refused by the string test', async () => {
  // Stored as `<home>/s1-link/proj`, realpath `<home>/s1-real/proj`: renaming
  // `s1-real` matches no stored path, only the realpath anchor.
  const real = join(home, 's1-real');
  await mkdir(join(real, 'proj'), { recursive: true });
  await symlink(real, join(home, 's1-link'));
  await withProject('S1', join(home, 's1-link', 'proj'), async () => {
    await primeSet(server, work());
    await refolder(real);
    await refused(real, 's1-moved', 403, FS_RENAME_ANCHOR);
  });
  assert.ok(existsSync(join(home, 's1-link', 'proj')));
});

test('STALE set: a link on the STORED path, asked through a linked parent, is refused lexically', async () => {
  // `s2-via -> s2-R`, `s2-R/lnk2 -> s2-T`, stored `<home>/s2-via/lnk2/proj`.
  // Asked as `<home>/s2-via/lnk2`: `lex` holds the stored path, `src`
  // (`<home>/s2-R/lnk2`) does not.
  const R = join(home, 's2-R');
  const T = join(home, 's2-T');
  await mkdir(R);
  await mkdir(join(T, 'proj'), { recursive: true });
  await symlink(R, join(home, 's2-via'));
  await symlink(T, join(R, 'lnk2'));
  await withProject('S2', join(home, 's2-via', 'lnk2', 'proj'), async () => {
    await primeSet(server, work());
    await relink(join(R, 'lnk2'));
    await refused(join(home, 's2-via', 'lnk2'), 'lnk3', 403, FS_RENAME_ANCHOR);
  });
  assert.ok(existsSync(join(home, 's2-via', 'lnk2', 'proj')));
});

test('STALE set: a link on an UNNORMALISED stored path, asked through a second link to home, is refused by `src`', async () => {
  // Stored as `<home>/s3-seg/../s3-lnk/proj` (the store keeps what it was
  // given); asked as `<home>/work/s3-back/s3-lnk` with `s3-back -> home`:
  // only `src` (`<home>/s3-lnk`) holds the RESOLVED stored path.
  const real = join(home, 's3-real');
  await mkdir(join(real, 'proj'), { recursive: true });
  await mkdir(join(home, 's3-seg'));
  await symlink(real, join(home, 's3-lnk'));
  await symlink(home, join(work(), 's3-back'));
  await withProject('S3', `${home}/s3-seg/../s3-lnk/proj`, async () => {
    await primeSet(server, work());
    await relink(join(home, 's3-lnk'));
    await refused(join(work(), 's3-back', 's3-lnk'), 's3-lnk2', 403, FS_RENAME_ANCHOR);
  });
  assert.ok(existsSync(join(home, 's3-lnk', 'proj')));
});

test('STALE set: the data dir configured through links — the link on `lex`, and the real folder holding it', async () => {
  // AI_SM_DATA_DIR=<nh>/seg/../via/ddl/data (unnormalised on purpose),
  // `via -> R`, `R/ddl -> realdd`.
  const nestRoot = await realpath(await mkdtemp(join(tmpdir(), 'ai-sm-fsren5-')));
  const nh = join(nestRoot, 'home');
  const R = join(nh, 'R');
  const realdd = join(nh, 'realdd');
  await mkdir(join(nh, 'seg'), { recursive: true });
  await mkdir(R);
  await mkdir(realdd);
  await symlink(R, join(nh, 'via'));
  await symlink(realdd, join(R, 'ddl'));
  const second = await startTestServer({
    dataDir: `${nh}/seg/../via/ddl/data`,
    env: { AI_SM_HOME_OVERRIDE: nh },
  });
  try {
    assert.ok(existsSync(join(realdd, 'data', 'runtime.json')));
    const primes = [await primeFile(nh), await primeFile(nh)];
    // `lex` holds the configured path; `src` (`<nh>/R/ddl`) does not.
    await primeSet(second, primes[0] as string);
    await relink(join(R, 'ddl'));
    const viaLink = await api(second, 'POST', '/api/fs/rename', { path: join(nh, 'via', 'ddl'), name: 'ddl2' });
    assert.equal(viaLink.status, 403, JSON.stringify(viaLink.body));
    assert.deepEqual(viaLink.body, { error: FS_RENAME_DATA_DIR });
    // The REAL folder holding the data dir: only the realpath test knows it.
    await primeSet(second, primes[1] as string);
    await refolder(realdd);
    const holder = await api(second, 'POST', '/api/fs/rename', { path: realdd, name: 'realdd2' });
    assert.equal(holder.status, 403, JSON.stringify(holder.body));
    assert.deepEqual(holder.body, { error: FS_RENAME_DATA_DIR });
    assert.ok(existsSync(join(nh, 'via', 'ddl', 'data', 'runtime.json')), 'the configured path still works');
  } finally {
    await second.stop();
    await rm(nestRoot, { recursive: true, force: true });
  }
});

test('STALE set: the configured data dir link, asked through a second link, is refused by `src`', async () => {
  // AI_SM_DATA_DIR=<nh>/ddl/data, `ddl -> realdd`; asked as `<nh>/back/ddl`
  // with `back -> nh`: only `src` (`<nh>/ddl`) holds the configured path.
  const nestRoot = await realpath(await mkdtemp(join(tmpdir(), 'ai-sm-fsren6-')));
  const nh = join(nestRoot, 'home');
  const realdd = join(nh, 'realdd');
  await mkdir(realdd, { recursive: true });
  await symlink(realdd, join(nh, 'ddl'));
  await symlink(nh, join(nh, 'back'));
  const second = await startTestServer({ dataDir: join(nh, 'ddl', 'data'), env: { AI_SM_HOME_OVERRIDE: nh } });
  try {
    await primeSet(second, nh);
    await relink(join(nh, 'ddl'));
    const res = await api(second, 'POST', '/api/fs/rename', { path: join(nh, 'back', 'ddl'), name: 'ddl2' });
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.deepEqual(res.body, { error: FS_RENAME_DATA_DIR });
    assert.ok(existsSync(join(nh, 'ddl', 'data', 'runtime.json')));
  } finally {
    await second.stop();
    await rm(nestRoot, { recursive: true, force: true });
  }
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

// ---------------------------------------------------------------------------
// IN-PROCESS: handleRename called directly, with node:fs/promises SPIED
// (mock.method on the module object + syncBuiltinESMExports, which rebinds
// the named imports of server/fsrename.ts and server/fsprotect.ts). This is
// how the paths the real filesystem cannot produce are reached: the drvfs
// link refusal, an unlink that fails, a case-insensitive filesystem, a hung
// protected-set walk. Same home and data dir as the server child, set in THIS
// process's env before the first call (fsbrowse caches both on first use).
// ---------------------------------------------------------------------------

interface Answer { status: number; body: unknown; close: boolean; logs: [string, string][] }

function inProcEnv(): void {
  process.env['AI_SM_HOME_OVERRIDE'] = home;
  process.env['AI_SM_DATA_DIR'] = dataDir;
}

async function inProc(path: string, name: string, projects: string[] = []): Promise<Answer> {
  inProcEnv();
  const out: Answer = { status: 0, body: undefined, close: false, logs: [] };
  await handleRename(
    { method: 'POST', headers: { 'content-type': 'application/json' } } as unknown as IncomingMessage,
    {} as ServerResponse,
    {
      projects: () => projects,
      log: (level, message) => out.logs.push([level, message]),
      sendJson: (_res, status, body) => {
        out.status = status;
        out.body = body;
      },
      sendError: (_res, status, message) => {
        out.status = status;
        out.body = { error: message };
      },
      sendErrorAndClose: (_res, status, message) => {
        out.status = status;
        out.body = { error: message };
        out.close = true;
      },
      readJson: async () => ({ ok: true, value: { path, name } }),
    },
  );
  return out;
}

type FsName = 'lstat' | 'link' | 'unlink' | 'rename' | 'readdir';
type Real = (...args: unknown[]) => Promise<unknown>;

/** Run `fn` with some node:fs/promises calls replaced; every override gets the real call first. */
async function withFs<T>(
  overrides: Partial<Record<FsName, (real: Real, ...args: unknown[]) => Promise<unknown>>>,
  fn: () => Promise<T>,
): Promise<T> {
  for (const [key, impl] of Object.entries(overrides) as [FsName, (real: Real, ...a: unknown[]) => Promise<unknown>][]) {
    const real = fsp[key] as unknown as Real;
    mock.method(fsp, key, (...args: unknown[]) => impl(real, ...args));
  }
  syncBuiltinESMExports();
  try {
    return await fn();
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
}

const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`${code}: spied`), { code });

async function ipDir(): Promise<string> {
  const d = join(work(), 'inproc');
  await mkdir(d, { recursive: true });
  return d;
}

test('in-process: the entry and a taken-name probe are lstat-ed with { bigint: true }', async () => {
  const d = await ipDir();
  const file = join(d, 'big.txt');
  const dir = join(d, 'bigdir');
  await writeFile(file, 'b\n');
  await mkdir(dir);
  const calls: [unknown, unknown][] = [];
  await withFs({ lstat: (real, p, o) => (calls.push([p, o]), real(p, o)) }, async () => {
    assert.equal((await inProc(file, 'big2.txt')).status, 200);
    assert.equal((await inProc(dir, 'bigdir2')).status, 200);
    assert.equal((await inProc(join(d, 'big2.txt'), 'BIG2.txt')).status, 200, 'case-only: probes dst');
  });
  const on = (p: string): unknown[] => calls.filter(([q]) => q === p).map(([, o]) => o);
  assert.deepEqual(on(file), [{ bigint: true }], 'the source file');
  assert.deepEqual(on(dir), [{ bigint: true }], 'the source folder');
  assert.deepEqual(on(join(d, 'bigdir2')), [{ bigint: true }], 'the folder\'s taken-name probe');
  assert.deepEqual(on(join(d, 'BIG2.txt')), [{ bigint: true }], 'the case-only probe');
});

test('in-process: a protected set that does not come in time is a 503 — nothing renamed, no error line', async () => {
  inProcEnv();
  const d = await ipDir();
  const file = join(d, 'hung.txt');
  await writeFile(file, 'h\n');
  resetProtectedSetCache();
  // A walk into a "dead mount" for exactly the roots this request asks for.
  protectedSetFor([home], [dataDir], { build: () => new Promise<ProtectedSet>(() => undefined), timeoutMs: 1 }).catch(
    () => undefined,
  );
  try {
    const res = await inProc(file, 'hung2.txt');
    assert.equal(res.status, 503);
    assert.deepEqual(res.body, { error: FS_PROTECT_UNAVAILABLE });
    assert.equal(res.close, false);
    assert.equal(await readFile(file, 'utf8'), 'h\n');
    assert.ok(!existsSync(join(d, 'hung2.txt')));
    assert.deepEqual(res.logs, [['info', 'POST /api/fs/rename -> 503']], 'a refusal, not a failure');
  } finally {
    resetProtectedSetCache();
  }
});

test('in-process: a protected set that FAILS (not a timeout) is a 500 — nothing renamed', async () => {
  inProcEnv();
  const d = await ipDir();
  const file = join(d, 'boom.txt');
  await writeFile(file, 'b\n');
  resetProtectedSetCache();
  let fail: (e: Error) => void = () => undefined;
  protectedSetFor([home], [dataDir], {
    build: () =>
      new Promise<ProtectedSet>((_r, reject) => {
        fail = reject;
      }),
    timeoutMs: 60_000,
  }).catch(() => undefined);
  try {
    const res = await withFs(
      {
        // Fail the walk only AFTER the request has lstat-ed its entry and is
        // waiting on the running walk (setImmediate runs after the microtasks
        // that attach it).
        lstat: (real, p, o) =>
          real(p, o).then((v) => {
            // The message quotes a path, as an errno message would.
            if (p === file) setImmediate(() => fail(new Error(`walk failed at ${file}`)));
            return v;
          }),
      },
      () => inProc(file, 'boom2.txt'),
    );
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error: FS_RENAME_FAILED });
    assert.equal(await readFile(file, 'utf8'), 'b\n');
    assert.equal(res.logs.filter(([level]) => level === 'error').length, 1, 'a failure IS logged');
    for (const [, line] of res.logs) assert.ok(!line.includes(file), `no path in: ${line}`);
  } finally {
    resetProtectedSetCache();
  }
});

test('in-process: link refused as "no hard links here" (drvfs) falls back to rename — and still never clobbers', async () => {
  const d = await ipDir();
  for (const code of ['EPERM', 'EXDEV', 'ENOSYS', 'ENOTSUP']) {
    const src = join(d, `fb-${code}.txt`);
    const taken = join(d, `fb-${code}-taken.txt`);
    await writeFile(src, `${code}\n`);
    await writeFile(taken, 'TAKEN\n');
    await withFs({ link: async () => Promise.reject(errno(code)) }, async () => {
      const clash = await inProc(src, `fb-${code}-taken.txt`);
      assert.equal(clash.status, 409, `${code}: ${JSON.stringify(clash.body)}`);
      assert.deepEqual(clash.body, { error: ALREADY_EXISTS });
      assert.equal(await readFile(taken, 'utf8'), 'TAKEN\n', `${code}: the taken name is untouched`);
      const ok = await inProc(src, `fb-${code}-new.txt`);
      assert.equal(ok.status, 200, `${code}: ${JSON.stringify(ok.body)}`);
    });
    assert.ok(!existsSync(src), code);
    assert.equal(await readFile(join(d, `fb-${code}-new.txt`), 'utf8'), `${code}\n`);
  }
});

test('in-process: an unlink that fails undoes the new name — the user keeps exactly what they had', async () => {
  const d = await ipDir();
  const src = join(d, 'undo.txt');
  await writeFile(src, 'U\n');
  const res = await withFs(
    { unlink: (real, p) => (p === src ? Promise.reject(errno('EACCES')) : real(p)) },
    () => inProc(src, 'undo2.txt'),
  );
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: FS_NO_RENAME_PERMISSION });
  assert.equal(await readFile(src, 'utf8'), 'U\n');
  assert.ok(!existsSync(join(d, 'undo2.txt')), 'the new name was taken back');
  assert.equal((await lstat(src)).nlink, 1, 'no second hard link left');
});

test('in-process: the old name vanishing between link and unlink KEEPS the new name (never lose the file)', async () => {
  const d = await ipDir();
  const src = join(d, 'vanish.txt');
  await writeFile(src, 'V\n');
  const res = await withFs(
    {
      unlink: (real, p) =>
        p === src ? (real(p) as Promise<unknown>).then(() => Promise.reject(errno('ENOENT'))) : real(p),
    },
    () => inProc(src, 'vanish2.txt'),
  );
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(await readFile(join(d, 'vanish2.txt'), 'utf8'), 'V\n', 'the only name the file has left');
});

test('in-process: a folder is never hard-linked; a taken-name probe that errors is refused, not skipped', async () => {
  const d = await ipDir();
  const dir = join(d, 'nolink');
  await mkdir(dir);
  const links: unknown[] = [];
  await withFs({ link: (real, a, b) => (links.push(a), real(a, b)) }, async () => {
    assert.equal((await inProc(dir, 'nolink2')).status, 200);
  });
  assert.deepEqual(links, [], 'lstat-then-rename, no link attempt');
  const dir2 = join(d, 'probe');
  await mkdir(dir2);
  const dst = join(d, 'probe2');
  const res = await withFs(
    { lstat: (real, p, o) => (p === dst ? Promise.reject(errno('EACCES')) : real(p, o)) },
    () => inProc(dir2, 'probe2'),
  );
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: FS_NO_RENAME_PERMISSION });
  assert.ok(existsSync(dir2) && !existsSync(dst));
});

test('in-process: a CASE-ONLY rename on a case-insensitive filesystem (drvfs) is done by rename', async () => {
  // Simulated: `CI.txt` lstats as the SAME entry as `ci.txt`, link answers
  // EEXIST (the name IS taken — by the file itself), and after the rename the
  // old spelling still lstats (drvfs finds it case-insensitively). Only the
  // directory LISTING says whether the rename happened.
  const d = await ipDir();
  const src = join(d, 'ci.txt');
  const dst = join(d, 'CI.txt');
  await writeFile(src, 'CI\n');
  const st = await lstat(src, { bigint: true });
  const res = await withFs(
    {
      lstat: (real, p, o) => (p === dst || p === src ? Promise.resolve(st) : real(p, o)),
      link: (real, a, b) => (b === dst ? Promise.reject(errno('EEXIST')) : real(a, b)),
    },
    () => inProc(src, 'CI.txt'),
  );
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const names = await readdir(d);
  assert.ok(names.includes('CI.txt') && !names.includes('ci.txt'));
});

test('in-process: a case-only name that is a DIFFERENT entry (another device, same inode number) is a 409', async () => {
  const d = await ipDir();
  const src = join(d, 'dv.txt');
  const dst = join(d, 'DV.txt');
  await writeFile(src, 'dv\n');
  const st = await lstat(src, { bigint: true });
  const other = Object.assign(Object.create(Object.getPrototypeOf(st) as object) as object, st, { dev: st.dev + 1n });
  const res = await withFs(
    { lstat: (real, p, o) => (p === dst ? Promise.resolve(other) : real(p, o)) },
    () => inProc(src, 'DV.txt'),
  );
  assert.equal(res.status, 409);
  assert.deepEqual(res.body, { error: ALREADY_EXISTS });
  assert.ok((await readdir(d)).includes('dv.txt'));
});

test('in-process: a 5xx logs the error CLASS and frames — never the errno message with its paths', async () => {
  const d = await ipDir();
  const src = join(d, `${CANARY}_eio`);
  await mkdir(src);
  const dst = join(d, `${CANARY}_eio2`);
  const res = await withFs(
    {
      rename: (real, a, b) =>
        a === src
          ? Promise.reject(Object.assign(new Error(`EIO: i/o error, rename '${src}' -> '${dst}'`), { code: 'EIO' }))
          : real(a, b),
    },
    () => inProc(src, `${CANARY}_eio2`),
  );
  assert.equal(res.status, 500);
  assert.deepEqual(res.body, { error: FS_RENAME_FAILED });
  const errors = res.logs.filter(([level]) => level === 'error');
  assert.equal(errors.length, 1);
  assert.ok(errors[0]?.[1].includes('FsBrowseError') || errors[0]?.[1].includes('Error'), errors[0]?.[1]);
  for (const [, line] of res.logs) {
    assert.ok(!line.includes(CANARY), `no name in: ${line}`);
    assert.ok(!line.includes(d), `no path in: ${line}`);
  }
});

test('N5 by location: a stale project stored THROUGH a symlink cannot be re-pointed by a rename at the real place', async () => {
  // Project stored as `<home>/g1-link/stale`, `g1-link -> <home>/g1-real`,
  // `stale` gone. Renaming `<home>/g1-real/other` to `stale` would make the
  // stored path lead to `other` — the text test never sees `g1-real`.
  const g1Real = join(home, 'g1-real');
  await mkdir(join(g1Real, 'stale'), { recursive: true });
  await symlink(g1Real, join(home, 'g1-link'));
  await withProject('G1', join(home, 'g1-link', 'stale'), async () => {
    await rm(join(g1Real, 'stale'), { recursive: true });
    const other = join(g1Real, 'other');
    await mkdir(other);
    await writeFile(join(other, 'o.txt'), 'O\n');
    await refused(other, 'stale', 403, FS_RENAME_ANCHOR);
    assert.equal(await readFile(join(other, 'o.txt'), 'utf8'), 'O\n', 'other is unchanged');
    assert.ok(!existsSync(join(home, 'g1-link', 'stale')), 'the stored path still leads nowhere');
    // Any OTHER name in that folder is ordinary.
    await renamed(other, 'other2');
    assert.ok(existsSync(join(g1Real, 'other2', 'o.txt')));
  });
});
