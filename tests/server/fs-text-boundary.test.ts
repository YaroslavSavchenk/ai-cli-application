/**
 * GET /api/fs/read + PUT /api/fs/write — the boundary (Nocturne B4 phase 1,
 * `.claude/plans/nocturne/PLAN-B4.md` §1): symlinks inside and outside it, a
 * link planted at a missing name, a create judged by its parent, malformed and
 * over-long paths, the data dir refused by path, a registered project outside
 * home, and the KNOWN LIMIT of hard links.
 *
 * One real server child on a fixture `home` (AI_SM_HOME_OVERRIDE,
 * `tests/helpers/fs-server-fixture.ts`), against the real kernel. Split out of
 * `fs-text.test.ts` (restructure O6).
 *
 * NOT claimed: the editor pane in a browser; a drvfs mount or Windows. The
 * hard-link cases skip on a filesystem that cannot make one (EPERM, EXDEV).
 *
 * Example paths in comments are `/home/you/...`, never anyone's real one.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import {
  link,
  lstat,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import type { Project } from '../../shared/protocol.ts';
import { api } from '../helpers/helpers.ts';
import {
  bootFsServer,
  dataDir,
  evil,
  home,
  outside,
  server,
  stopFsServer,
  work,
} from '../helpers/fs-server-fixture.ts';
import { plant, read, readBody, write } from '../helpers/fs-text-fixture.ts';

before(() => bootFsServer('ai-sm-fstxt-'));

after(() =>
  // A 0444 file and a 0500 folder must not be able to defeat the teardown.
  stopFsServer(() => [[join(work(), 'readonly.txt'), 0o600]]),
);

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
