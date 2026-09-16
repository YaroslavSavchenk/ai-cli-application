/**
 * POST /api/fs/create — the A9c inline name row's one write (B2).
 *
 * One real server child on a fixture `home` (AI_SM_HOME_OVERRIDE, the same test
 * seam tests/fs-entries.test.ts uses), so the boundary, the data-dir refusal and
 * the `wx` (O_CREAT|O_EXCL) guarantees are exercised for real.
 *
 * Example paths in comments are `/home/you/...`, never anyone's real one.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FsCreateResponse, FsMkdirResponse, Project } from '../shared/protocol.ts';
import { api, rawRequest, readServerLog, startTestServer, waitForLog, type TestServer } from './helpers.ts';

let server: TestServer;
let root: string;
let home: string;
let evil: string;
let dataDir: string;
/** A folder OUTSIDE home, registered as a project in the anchor test. */
let outside: string;

/** A name the user "typed": it must NEVER reach server.log. */
const NAME_CANARY = 'CREATEDNAMECANARY_qz.txt';

before(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'ai-sm-fscre-')));
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

const create = (dir: unknown, name: unknown, kind: unknown): Promise<{ status: number; body: unknown }> =>
  api(server, 'POST', '/api/fs/create', { dir, name, kind });

const work = (): string => join(home, 'work');

test('a file and a folder are created, and the answer is the absolute path', async () => {
  const file = await create(work(), 'notes.txt', 'file');
  assert.equal(file.status, 201, JSON.stringify(file.body));
  assert.equal((file.body as FsCreateResponse).path, join(work(), 'notes.txt'));
  assert.equal((await stat(join(work(), 'notes.txt'))).size, 0, 'an EMPTY file');

  const folder = await create(work(), 'ideas', 'folder');
  assert.equal(folder.status, 201, JSON.stringify(folder.body));
  assert.equal((folder.body as FsCreateResponse).path, join(work(), 'ideas'));
  assert.ok((await stat(join(work(), 'ideas'))).isDirectory());

  // A folder is NOT created recursively: only the one segment.
  assert.ok(!existsSync(join(work(), 'ideas', 'ideas')));
});

test('hidden names are allowed — .env, .gitignore and .claude are things people create', async () => {
  for (const name of ['.env', '.gitignore']) {
    const res = await create(work(), name, 'file');
    assert.equal(res.status, 201, `${name}: ${JSON.stringify(res.body)}`);
  }
  assert.equal((await create(work(), '.claude', 'folder')).status, 201);
});

test('a duplicate answers 409 with its own sentence — and does NOT truncate what is there', async () => {
  await writeFile(join(work(), 'kept.txt'), 'PRECIOUS\n');
  const res = await create(work(), 'kept.txt', 'file');
  assert.equal(res.status, 409);
  assert.deepEqual(res.body, { error: 'Something with that name already exists here.' });
  assert.equal(await readFile(join(work(), 'kept.txt'), 'utf8'), 'PRECIOUS\n', "`wx` never truncates");

  const dup = await create(work(), 'ideas', 'folder');
  assert.equal(dup.status, 409, 'a folder that exists is the same refusal');
});

test('`wx` refuses to follow a symlink at the final component — the pre-planted-link attack', async () => {
  // `/home/you/notes/x -> /etc/shadow` in the real world; here the target is a
  // file OUTSIDE the fixture home that must stay untouched and uncreated.
  const outsideTarget = join(evil, 'target.txt');
  await symlink(outsideTarget, join(work(), 'dangling'));
  const res = await create(work(), 'dangling', 'file');
  assert.equal(res.status, 409, 'O_EXCL fails EEXIST on a symlink, even a DANGLING one');
  assert.equal(existsSync(outsideTarget), false, 'nothing was created through the link');

  await writeFile(outsideTarget, 'OUTSIDE\n');
  const again = await create(work(), 'dangling', 'file');
  assert.equal(again.status, 409);
  assert.equal(await readFile(outsideTarget, 'utf8'), 'OUTSIDE\n', 'and nothing was written through it');
});

test('the name vocabulary is isSafeSegment and nothing else', async () => {
  const refused: [unknown, string][] = [
    ['a/b', 'a slash'],
    ['a\\b', 'a backslash'],
    ['..', 'dot dot'],
    ['.', 'one dot'],
    ['...', 'three dots'],
    ['', 'empty'],
    ['x'.repeat(256), '256 characters'],
    ['badname', 'a control character'],
    ['nul\0name', 'a NUL'],
    ['line\nname', 'a newline'],
    [42, 'not a string'],
  ];
  for (const [name, why] of refused) {
    const res = await create(work(), name, 'file');
    assert.equal(res.status, 400, `${why} must be 400`);
    assert.deepEqual(res.body, { error: 'That name is not allowed.' }, `${why}: the constant sentence`);
  }
  const ok = 'y'.repeat(255);
  const res = await create(work(), ok, 'file');
  assert.equal(res.status, 201, '255 characters is still a name');
  assert.equal((res.body as FsCreateResponse).path, join(work(), ok));
});

test('the parent is resolved and bounded exactly like a listing', async () => {
  const cases: [unknown, number, string][] = [
    [join(work(), 'no-such-folder'), 404, 'a parent that is not there'],
    [join(work(), 'notes.txt'), 404, 'a parent that is a FILE'],
    ['relative/path', 400, 'a relative parent'],
    ['', 400, 'an empty parent'],
    [`${home}\0/work`, 400, 'a NUL in the parent'],
    [42, 400, 'a parent that is not a string'],
    [evil, 403, 'the <home>evil PREFIX TRAP'],
    ['/etc', 403, 'a parent outside home'],
    [`${home}/../homeevil`, 403, 'a lexical .. out of home'],
  ];
  for (const [dir, status, why] of cases) {
    const res = await create(dir, 'x.txt', 'file');
    assert.equal(res.status, status, `${why} -> ${res.status} ${JSON.stringify(res.body)}`);
  }
  assert.deepEqual((await create(join(work(), 'nope'), 'x.txt', 'file')).body, {
    error: 'That folder is no longer there.',
  });
  assert.deepEqual((await create(evil, 'x.txt', 'file')).body, {
    error: 'This folder is outside your home folder.',
  });
  assert.equal(existsSync(join(evil, 'x.txt')), false, 'and nothing was created out there');
});

test("the app's own data dir is LISTED but never written into", async () => {
  const inside = await create(dataDir, 'x.txt', 'file');
  assert.equal(inside.status, 403);
  assert.deepEqual(inside.body, { error: "The app's own folder is not a place to create files." });
  assert.equal(existsSync(join(dataDir, 'x.txt')), false);

  await mkdir(join(dataDir, 'session-settings'), { recursive: true });
  const deeper = await create(join(dataDir, 'session-settings'), 'x.txt', 'file');
  assert.equal(deeper.status, 403, 'UNDER it is refused too');

  // ...and it is still a real folder in home, which the listing shows.
  const listed = await api(server, 'GET', `/api/fs/entries?path=${encodeURIComponent(home)}`);
  assert.ok(
    (listed.body as { entries: { name: string }[] }).entries.some(
      (e) => e.name === '.ai-session-manager',
    ),
    'refusing to WRITE there is not hiding it',
  );
});

test('an unwritable parent answers 403 with the CREATE sentence', { skip: process.getuid?.() === 0 ? 'running as root' : false }, async () => {
  const ro = join(home, 'readonly');
  await mkdir(ro);
  await chmod(ro, 0o500);
  const res = await create(ro, 'x.txt', 'file');
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'You do not have permission to create it here.' });
});

test('a bad `kind`, a wrong method and a missing token are each refused', async () => {
  for (const kind of ['symlink', '', undefined, 7]) {
    const res = await create(work(), 'k.txt', kind);
    assert.equal(res.status, 400, `kind ${JSON.stringify(kind)} must be 400`);
  }
  assert.equal((await api(server, 'GET', '/api/fs/create')).status, 405);

  const noToken = await rawRequest(server.port, { method: 'POST', path: '/api/fs/create' });
  assert.equal(noToken.status, 401, 'no token must be 401');
  const wrongToken = await rawRequest(server.port, {
    method: 'POST',
    path: '/api/fs/create',
    headers: { 'x-auth-token': '0'.repeat(64) },
  });
  assert.equal(wrongToken.status, 401, 'a wrong token must be 401');
});

test('server.log records the KIND and the outcome — never the name the user typed', async () => {
  assert.equal((await create(work(), NAME_CANARY, 'file')).status, 201);
  assert.equal((await create(work(), NAME_CANARY, 'file')).status, 409);
  assert.equal((await create(work(), 'CREATEDNAMECANARY_dir', 'folder')).status, 201);
  await waitForLog(server, '[fs] POST /api/fs/create folder -> 201');
  const log = await readServerLog(server);

  assert.ok(log.includes('[fs] POST /api/fs/create file -> 201'), 'the kind and the outcome');
  assert.ok(log.includes('[fs] POST /api/fs/create file -> 409'), 'a refusal too');
  assert.ok(log.includes('[http] POST /api/fs/create -> 201'), 'and the access line');
  assert.ok(!log.includes('CREATEDNAMECANARY'), 'NO created name reaches the log');
  assert.ok(!log.includes(server.token), 'and never the token');
});

test('a registered project OUTSIDE home can be created in; unregistering it takes that back', async () => {
  // The anchor list is home OR any registered project path (user decision
  // 2026-09-16), and it is the SAME boundary for the write route as for the
  // listing one — a folder you can browse but never create in would be the
  // half-usable state again.
  assert.equal((await create(outside, 'before.txt', 'file')).status, 403, 'unregistered: refused');
  assert.equal(existsSync(join(outside, 'before.txt')), false, 'and nothing was written');

  const created = await api(server, 'POST', '/api/projects', { name: 'Outside', path: outside });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const project = created.body as Project;
  try {
    const file = await create(outside, 'in-project.txt', 'file');
    assert.equal(file.status, 201, JSON.stringify(file.body));
    assert.equal((file.body as FsCreateResponse).path, join(outside, 'in-project.txt'));

    const folder = await create(outside, 'sub', 'folder');
    assert.equal(folder.status, 201, JSON.stringify(folder.body));
    assert.equal((await create(join(outside, 'sub'), 'deeper.txt', 'file')).status, 201, 'and under it');

    // `<project>evil` is a string prefix of the anchor, not a child.
    const trap = `${outside}evil`;
    await mkdir(trap);
    assert.equal((await create(trap, 'x.txt', 'file')).status, 403, 'the prefix trap holds per anchor');
    assert.equal(existsSync(join(trap, 'x.txt')), false);
  } finally {
    assert.equal((await api(server, 'DELETE', `/api/projects/${project.id}`)).status, 200);
  }

  const after_ = await create(outside, 'after.txt', 'file');
  assert.equal(after_.status, 403, 'removing the project takes the anchor back with it');
  assert.deepEqual(after_.body, { error: 'This folder is outside your home folder.' });
  assert.equal(existsSync(join(outside, 'after.txt')), false);
});

test('/api/fs/mkdir — the PICKER’s new-folder button — still has no boundary at all, on purpose', async () => {
  // The other half of the asymmetry pinned in tests/fs-entries.test.ts: the
  // picker creates the folder a user is ABOUT to register as a project, which
  // by definition is not an anchor yet. Narrowing this would break
  // Add-a-project and the GitHub clone destination.
  assert.equal((await create(evil, 'nope', 'folder')).status, 403, 'the PANEL refuses it');

  const picker = await api(server, 'POST', '/api/fs/mkdir', { parent: evil, name: 'picker-made' });
  assert.equal(picker.status, 201, `the PICKER creates it: ${JSON.stringify(picker.body)}`);
  assert.equal((picker.body as FsMkdirResponse).path, join(evil, 'picker-made'));
  assert.ok((await stat(join(evil, 'picker-made'))).isDirectory());
});

test('a name that is legal in CODE UNITS but too long in BYTES is a 400, not a 500', async () => {
  // isSafeSegment counts UTF-16 code units (1..255); the filesystem's NAME_MAX
  // is 255 BYTES. `é` is one unit and two bytes, so 250 of them pass the
  // vocabulary check and cost 500 bytes — without the byte check the kernel
  // answers ENAMETOOLONG and the user gets `The app could not create it.` for
  // what is plainly a name problem.
  const name = 'é'.repeat(250);
  assert.equal(name.length, 250, 'legal in code units');
  assert.equal(Buffer.byteLength(name, 'utf8'), 500, 'and 500 bytes on disk');

  const res = await create(work(), name, 'file');
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.deepEqual(res.body, { error: 'That name is not allowed.' });
  assert.equal(existsSync(join(work(), name)), false, 'and nothing was created');

  assert.equal((await create(work(), name, 'folder')).status, 400, 'a folder is the same rule');

  // The boundary in BYTES, from both sides, so the check cannot drift into
  // "no non-ASCII names at all": 127 × 2 = 254 bytes is fine, 128 × 2 = 256 is not.
  assert.equal((await create(work(), 'é'.repeat(127), 'file')).status, 201, '254 bytes is a name');
  assert.equal((await create(work(), 'é'.repeat(128), 'file')).status, 400, '256 bytes is not');
});
