/**
 * POST /api/fs/delete — the boundary's edges (Nocturne B10a, 2026-09-20
 * review and mutation gate): containment BOTH ways (a folder that contains an
 * anchor or the data dir), symlinks in the middle of a path and the
 * trailing-slash forms, and the ORDER of the rules inside one item.
 *
 * One real server child on a fixture `home` (AI_SM_HOME_OVERRIDE,
 * `tests/helpers/fs-server-fixture.ts`); a nested data dir gets a second child
 * of its own. Split out of `fs-delete.test.ts` (restructure O6), which holds the
 * errno table, the ordinary route and its connection hygiene.
 *
 * Every refusal asserts that the thing it protects is still there: this route
 * is the one that cannot be undone.
 *
 * NOT claimed: a real drvfs mount or Windows; the Files panel's delete UI.
 *
 * Example paths in comments are `/home/you/...`, never anyone's real one.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FsDeleteResult, FsDeleteResponse, Project } from '../../shared/protocol.ts';
import { FS_DELETE_ANCHOR, FS_DELETE_DATA_DIR, FS_DELETE_GONE } from '../../server/fsdelete.ts';
import {
  api,
  rawRequest,
  readServerLog,
  startTestServer,
  waitForLog,
  makeTempDir,
  removeTempDir,
} from '../helpers/helpers.ts';
import {
  bootFsServer,
  dataDir,
  evil,
  home,
  NAME_NOT_ALLOWED,
  OUTSIDE_HOME,
  PATH_BAD,
  root,
  server,
  stopFsServer,
  work,
} from '../helpers/fs-server-fixture.ts';
import { del, post } from '../helpers/fs-delete-fixture.ts';

before(() => bootFsServer('ai-sm-fsdel-'));

after(() => stopFsServer(() => [[join(home, 'readonly'), 0o700]]));

// ---------------------------------------------------------------------------
// Containment runs BOTH ways (2026-09-20 review): a folder that CONTAINS an
// anchor or the data dir is as undeletable as the anchor itself.
// ---------------------------------------------------------------------------

test('the PARENT of a registered project root is refused, and the project survives', async () => {
  // MEASURED before the fix: with a project at `<home>/projects/foo`,
  // `paths:['<home>/projects']` answered ok and the project was gone — one
  // Ctrl+A in the Home tab plus one confirmation removed every project there.
  const holder = join(home, 'projects');
  const projectPath = join(holder, 'foo');
  await mkdir(projectPath, { recursive: true });
  await writeFile(join(projectPath, 'src.txt'), 'SOURCE\n');
  const created = await api(server, 'POST', '/api/projects', { name: 'Foo', path: projectPath });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  try {
    assert.deepEqual(await del(holder), [{ ok: false, status: 403, error: FS_DELETE_ANCHOR }]);
    assert.equal(await readFile(join(projectPath, 'src.txt'), 'utf8'), 'SOURCE\n', 'the project is whole');

    // Any ancestor, however far up: home itself is one, and so is a holder two
    // levels above the project.
    const deep = join(home, 'nest', 'a', 'b', 'proj');
    await mkdir(deep, { recursive: true });
    const nested = await api(server, 'POST', '/api/projects', { name: 'Nested', path: deep });
    assert.equal(nested.status, 201);
    try {
      for (const ancestor of [join(home, 'nest'), join(home, 'nest', 'a'), join(home, 'nest', 'a', 'b')]) {
        assert.deepEqual(await del(ancestor), [{ ok: false, status: 403, error: FS_DELETE_ANCHOR }], ancestor);
      }
      assert.ok(existsSync(deep), 'the nested project survives every one of them');

      // A SYMLINK to a folder that contains a project root is still just a
      // link: unlinking it removes the link, and the project is untouched.
      const linkToHolder = join(work(), 'to-holder');
      await symlink(holder, linkToHolder);
      assert.deepEqual(await del(linkToHolder), [{ ok: true }]);
      assert.equal(existsSync(linkToHolder), false, 'the link is gone');
      assert.equal(await readFile(join(projectPath, 'src.txt'), 'utf8'), 'SOURCE\n', 'the project is not');

      // A sibling that contains NO anchor is ordinary deletable content.
      const plain = join(home, 'plain-holder', 'inner');
      await mkdir(plain, { recursive: true });
      assert.deepEqual(await del(join(home, 'plain-holder')), [{ ok: true }]);
      assert.equal(existsSync(join(home, 'plain-holder')), false);
    } finally {
      assert.equal((await api(server, 'DELETE', `/api/projects/${(nested.body as Project).id}`)).status, 200);
    }
  } finally {
    assert.equal((await api(server, 'DELETE', `/api/projects/${(created.body as Project).id}`)).status, 200);
  }
  // Unregistered, the holder is deletable like anything else in home.
  assert.deepEqual(await del(holder), [{ ok: true }]);
  assert.equal(existsSync(holder), false);
});

test('the PARENT of a nested custom data dir is refused, and runtime.json survives', async () => {
  // AI_SM_DATA_DIR can sit anywhere. Two levels under home (`<home>/dd/data`)
  // the folder ABOVE it is an ordinary-looking folder whose deletion would take
  // the auth token, prefs.json, history.json and runtime.json with it.
  const nestRoot = await realpath(await makeTempDir('ai-sm-fsdel2-'));
  const nestHome = join(nestRoot, 'home');
  const nestData = join(nestHome, 'dd', 'data');
  await mkdir(join(nestHome, 'dd'), { recursive: true });
  const second = await startTestServer({ dataDir: nestData, env: { AI_SM_HOME_OVERRIDE: nestHome } });
  try {
    const ask = async (p: string): Promise<FsDeleteResult> => {
      const res = await api(second, 'POST', '/api/fs/delete', { paths: [p] });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      return (res.body as FsDeleteResponse).results[0] as FsDeleteResult;
    };
    assert.ok(existsSync(join(nestData, 'runtime.json')), 'the fixture really has one');

    assert.deepEqual(await ask(join(nestHome, 'dd')), {
      ok: false,
      status: 403,
      error: FS_DELETE_DATA_DIR,
    });
    assert.deepEqual(await ask(nestData), { ok: false, status: 403, error: FS_DELETE_DATA_DIR });
    assert.ok(existsSync(join(nestData, 'runtime.json')), 'runtime.json survives both');

    // `~/link -> <dataDir>`: the LINK is deletable (it is only a name), what it
    // points at is not.
    const link = join(nestHome, 'data-link');
    await symlink(nestData, link);
    assert.deepEqual(await ask(join(link, 'runtime.json')), {
      ok: false,
      status: 403,
      error: FS_DELETE_DATA_DIR,
    });
    assert.ok(existsSync(join(nestData, 'runtime.json')), 'not through the link either');
    assert.deepEqual(await ask(link), { ok: true }, 'but the link itself goes');
    assert.equal(existsSync(link), false);
    assert.ok(existsSync(join(nestData, 'runtime.json')), 'and the data dir is whole');

    // A sibling of the data dir holder is ordinary content.
    await mkdir(join(nestHome, 'other'), { recursive: true });
    assert.deepEqual(await ask(join(nestHome, 'other')), { ok: true });
  } finally {
    await second.stop();
    await removeTempDir(nestRoot);
  }
});

// ---------------------------------------------------------------------------
// Symlinks in the middle of a path, and the trailing-slash forms
// ---------------------------------------------------------------------------

test('an intermediate symlink is judged where it LANDS, not where it is written', async () => {
  // OUTSIDE: `<home>/gate -> <outside>`; `<home>/gate/x.txt` is a path inside
  // home that the kernel resolves outside it. resolveUnderAllowed realpaths the
  // PARENT, so it is the boundary refusal, and nothing out there is touched.
  const outsideFile = join(evil, 'gate-target.txt');
  await writeFile(outsideFile, 'GATE\n');
  const gate = join(home, 'gate');
  await symlink(evil, gate);
  assert.deepEqual(await del(join(gate, 'gate-target.txt')), [
    { ok: false, status: 403, error: OUTSIDE_HOME },
  ]);
  assert.equal(await readFile(outsideFile, 'utf8'), 'GATE\n', 'untouched');
  assert.deepEqual(await del(gate), [{ ok: true }], 'the gate LINK itself is deletable');
  assert.equal(await readFile(outsideFile, 'utf8'), 'GATE\n', 'and that does not touch the target');

  // INSIDE: `<home>/inward -> <home>/work`; the delete happens at the REAL
  // location, once.
  const inward = join(home, 'inward');
  await symlink(work(), inward);
  const real = join(work(), 'through-link.txt');
  await writeFile(real, 'x\n');
  assert.deepEqual(await del(join(inward, 'through-link.txt')), [{ ok: true }]);
  assert.equal(existsSync(real), false, 'the real file is the one that went');
  assert.ok(existsSync(work()), 'and only it');
  assert.deepEqual(await del(inward), [{ ok: true }]);
});

test('a trailing slash and a trailing /. name the resolved path', async () => {
  const folder = join(work(), 'slashy');
  await mkdir(folder);
  await writeFile(join(folder, 'inside.txt'), 'x\n');
  assert.deepEqual(await del(`${folder}/`), [{ ok: true }], 'a trailing slash');
  assert.equal(existsSync(folder), false);

  const dotted = join(work(), 'dotty');
  await mkdir(dotted);
  assert.deepEqual(await del(`${dotted}/.`), [{ ok: true }], 'a trailing /.');
  assert.equal(existsSync(dotted), false);
  assert.ok(existsSync(work()), 'and never the parent');

  // `<work>/.` resolves to `<work>` itself, which is an ordinary folder — not
  // an anchor, not the data dir — so it deletes. Recreated for the tests after.
  const sacrifice = join(work(), 'sacrifice');
  await mkdir(join(sacrifice, 'deep'), { recursive: true });
  assert.deepEqual(await del(`${sacrifice}/./deep/..`), [{ ok: true }]);
  assert.equal(existsSync(sacrifice), false);
});

test('a child that NEVER existed, under a parent this request deleted, answers ok', async () => {
  // The rule is about the SELECTION, not about the filesystem's history: the
  // client sends what the user picked, and everything under something this
  // request removed is gone by definition. A path that names a thing which
  // never existed under such a parent is therefore an `ok`, not a 404 — telling
  // the user "that one was not there" about a folder they just deleted would be
  // noise about their own action. Only an ENOENT with NO deleted ancestor is a
  // 404 (pinned in the sibling case above).
  const parent = join(work(), 'ghosts');
  await mkdir(parent);
  assert.deepEqual(await del(parent, join(parent, 'never-was.txt'), join(parent, 'a', 'b.txt')), [
    { ok: true },
    { ok: true },
    { ok: true },
  ]);
  assert.equal(existsSync(parent), false);
});

// ---------------------------------------------------------------------------
// ORDER INSIDE ONE ITEM (mutation gate, 2026-09-20). The vocabulary of the raw
// path is judged BEFORE the filesystem, and the name BEFORE the parent, the
// boundary and every shortcut — the order the route calls its own security
// property. Each of these pins a rule whose removal the tests above could not
// see, because a LATER rule happened to answer the same thing.
// ---------------------------------------------------------------------------

test('a NUL in the LAST segment is the PATH sentence, not the name one', async () => {
  // The NUL lives in the final component, so `dirname()` is clean and
  // resolveUnderAllowed's own NUL refusal is never reached: the check on the
  // RAW path in this route is the only one that can answer, and the sentence
  // proves it ran — isSafeSegment would have said "That name is not allowed."
  const kept = join(work(), 'nul-kept.txt');
  await writeFile(kept, 'KEPT\n');
  assert.deepEqual(await del(`${work()}/nul-kept.txt\0.png`), [
    { ok: false, status: 400, error: PATH_BAD },
  ]);
  assert.equal(await readFile(kept, 'utf8'), 'KEPT\n', 'and nothing was deleted');
});

test('a name over 255 BYTES is refused BEFORE the parent is resolved', async () => {
  // 250 × `é` is 250 code units (isSafeSegment says yes) and 500 bytes (the
  // byte cap says no). The parent here is OUTSIDE the boundary, so the answer
  // says WHICH rule ran first: without the byte cap this is the outside-home
  // 403 instead, i.e. the route would be touching the filesystem to judge a
  // name the vocabulary already refuses.
  assert.deepEqual(await del(`${evil}/${'é'.repeat(250)}`), [
    { ok: false, status: 400, error: NAME_NOT_ALLOWED },
  ]);
  assert.ok(existsSync(evil), 'the outside folder is untouched');
});

test('the name rules run BEFORE the parent-already-deleted shortcut', async () => {
  // A parent deleted earlier in the same request turns a missing child into an
  // `ok`. That shortcut must never run in front of the name rules: a malformed
  // name is malformed whatever else the request did.
  const parent = join(work(), 'order-name');
  await mkdir(parent);
  assert.deepEqual(await del(parent, `${parent}/${'é'.repeat(250)}`, `${parent}/x\0.txt`), [
    { ok: true },
    { ok: false, status: 400, error: NAME_NOT_ALLOWED },
    { ok: false, status: 400, error: PATH_BAD },
  ]);
  assert.equal(existsSync(parent), false);
});

test('the SAME path twice in one request is ok twice — the second is not a 404', async () => {
  // A selection can name one row twice (two views of one folder). The second
  // attempt finds the parent still there and the target gone: that ENOENT is
  // the one the rm branch forgives, because the path IS something this same
  // request removed.
  const twice = join(work(), 'twice.txt');
  await writeFile(twice, 'x\n');
  assert.deepEqual(await del(twice, twice), [{ ok: true }, { ok: true }]);
  assert.equal(existsSync(twice), false);

  // A folder reads the same way...
  const dirTwice = join(work(), 'twice-dir');
  await mkdir(join(dirTwice, 'inner'), { recursive: true });
  assert.deepEqual(await del(dirTwice, dirTwice), [{ ok: true }, { ok: true }]);
  assert.equal(existsSync(dirTwice), false);

  // ...and a path this request never removed is still a 404.
  assert.deepEqual(await del(join(work(), 'never-twice.txt')), [
    { ok: false, status: 404, error: FS_DELETE_GONE },
  ]);
});

test('a FAILING item carries no path, no name and no errno back either', async () => {
  // rm's own messages quote the path TWICE (`EACCES, Permission denied: <p>
  // '<p>'`), so the results must stay constants: every failure is a status and
  // one sentence. A 403 or 404 that echoed the selection would also hand a
  // caller the layout of a folder it may not be allowed to list.
  const name = 'LEAKCANARY_qz.txt';
  const missing = join(work(), name);
  const outsideFile = join(evil, name);
  await writeFile(outsideFile, 'OUTSIDE\n');

  const res = await post({ paths: [missing, outsideFile, join(dataDir, name), home] });
  assert.equal(res.status, 200);
  const results = (res.body as FsDeleteResponse).results;
  assert.deepEqual(
    results.map((r) => r.ok),
    [false, false, false, false],
    'all four are refusals',
  );
  const text = JSON.stringify(res.body);
  assert.ok(!text.includes('LEAKCANARY'), `no selected NAME comes back: ${text}`);
  assert.ok(!text.includes(root), `and no path, not even the fixture root: ${text}`);
  assert.ok(!/E[A-Z]{3,}/.test(text), `and no errno: ${text}`);
  assert.equal(await readFile(outsideFile, 'utf8'), 'OUTSIDE\n', 'and nothing was deleted');
});

test('a malformed BODY reaches no log line — the parse error would quote the paths', async () => {
  // readJsonBodySafe, never the throwing reader: JSON.parse embeds a fragment
  // of its input in the SyntaxError, and this body is nothing but paths.
  const needle = '[http] POST /api/fs/delete -> 400';
  const before = (await readServerLog(server)).split(needle).length - 1;
  const bad = await rawRequest(server.port, {
    method: 'POST',
    path: '/api/fs/delete',
    headers: { 'x-auth-token': server.token, 'content-type': 'application/json' },
    body: `{"paths":["${join(work(), 'BODYCANARY_qz.txt')}"`,
  });
  assert.equal(bad.status, 400, bad.body);
  assert.deepEqual(JSON.parse(bad.body), { error: PATH_BAD });

  await waitForLog(server, needle, { count: before + 1 });
  const log = await readServerLog(server);
  assert.ok(!log.includes('BODYCANARY'), 'no fragment of the body reaches the log');
  assert.ok(!log.includes('SyntaxError'), 'and not the parse error that quotes it');
});
