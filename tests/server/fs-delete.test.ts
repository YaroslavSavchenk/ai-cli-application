/**
 * POST /api/fs/delete — the app's FIRST delete primitive (Nocturne B10a): the
 * errno table and the route against a real filesystem.
 *
 * One real server child on a fixture `home` (AI_SM_HOME_OVERRIDE, the same test
 * seam tests/server/fs-create.test.ts and tests/server/fs-entries.test.ts use), so the anchor
 * boundary, the anchor-itself refusal, the data-dir refusal and — the one that
 * matters most for a PERMANENT delete — the symlink rules are exercised against
 * the real filesystem. The errno table is a PURE function and is tested
 * directly, because half of those states cannot be produced on demand.
 *
 * EVERY test that deletes something outside-adjacent asserts the OUTSIDE thing
 * is still there afterwards: this route is the one that cannot be undone.
 *
 * The rest of the route lives in its topic pieces: containment both ways,
 * mid-path symlinks and the order inside one item in
 * `fs-delete-boundaries.test.ts`; paths as stored, identity, the stale set and
 * the in-process cases in `fs-delete-protected.test.ts`. Fixture home:
 * `tests/helpers/fs-server-fixture.ts`.
 *
 * NOT claimed: a real drvfs mount or Windows; the Files panel's delete UI.
 *
 * Example paths in comments are `/home/you/...`, never anyone's real one.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FsDeleteResponse, Project } from '../../shared/protocol.ts';
import { MAX_DELETE_ITEMS } from '../../shared/protocol.ts';
import {
  DELETE_MAX_BYTES,
  deleteErrorFor,
  FS_DELETE_ANCHOR,
  FS_DELETE_BUSY,
  FS_DELETE_CHANGED,
  FS_DELETE_DATA_DIR,
  FS_DELETE_FAILED,
  FS_DELETE_GONE,
  FS_DELETE_TOO_MANY,
  FS_NO_DELETE_PERMISSION,
} from '../../server/fsdelete.ts';
import { api, rawRequest, readServerLog, waitForLog, SKIP_IF_ROOT } from '../helpers/helpers.ts';
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
import { del, post } from '../helpers/fs-delete-fixture.ts';

/** A name the client "selected": it must NEVER reach server.log. */
const NAME_CANARY = 'DELETECANARY_qz.txt';

before(() => bootFsServer('ai-sm-fsdel-'));

after(() => stopFsServer(() => [[join(home, 'readonly'), 0o700]]));

// ---------------------------------------------------------------------------
// The errno table, as a pure function
// ---------------------------------------------------------------------------

test('deleteErrorFor maps every errno this route can meet', () => {
  const table: [string | undefined, number, string][] = [
    ['ENOENT', 404, FS_DELETE_GONE],
    ['ENOTDIR', 404, FS_DELETE_GONE],
    ['EACCES', 403, FS_NO_DELETE_PERMISSION],
    ['EPERM', 403, FS_NO_DELETE_PERMISSION],
    ['EROFS', 403, FS_NO_DELETE_PERMISSION],
    ['ENOTEMPTY', 409, FS_DELETE_CHANGED],
    ['EBUSY', 409, FS_DELETE_BUSY],
    ['ETXTBSY', 409, FS_DELETE_BUSY],
    ['ENAMETOOLONG', 400, NAME_NOT_ALLOWED],
    // A tripwire: Node raises this only for a NON-recursive rm of a directory,
    // which this route never issues.
    ['ERR_FS_EISDIR', 500, FS_DELETE_FAILED],
    ['EWHATEVER', 500, FS_DELETE_FAILED],
    [undefined, 500, FS_DELETE_FAILED],
  ];
  for (const [code, status, message] of table) {
    const err = deleteErrorFor(code);
    assert.equal(err.status, status, `${String(code)} -> ${err.status}`);
    assert.equal(err.message, message, String(code));
  }
});

test('the sentences carry no path, no name and no errno', () => {
  const sentences = [
    FS_DELETE_GONE,
    FS_NO_DELETE_PERMISSION,
    FS_DELETE_ANCHOR,
    FS_DELETE_DATA_DIR,
    FS_DELETE_BUSY,
    FS_DELETE_CHANGED,
    FS_DELETE_FAILED,
    FS_DELETE_TOO_MANY,
  ];
  for (const s of sentences) {
    assert.ok(!s.includes('/'), `${s} has no path separator`);
    assert.ok(!/E[A-Z]{3,}/.test(s), `${s} has no errno`);
    assert.ok(/[.!]$/.test(s), `${s} is a sentence`);
  }
  assert.equal(FS_DELETE_TOO_MANY, `Too many items. Delete up to ${MAX_DELETE_ITEMS} at a time.`);
});

// ---------------------------------------------------------------------------
// The route, against a real filesystem
// ---------------------------------------------------------------------------

test('a file is deleted, and the answer is one bare ok — no path comes back', async () => {
  const file = join(work(), 'notes.txt');
  await writeFile(file, 'bye\n');

  const res = await post({ paths: [file] });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { results: [{ ok: true }] });
  assert.ok(!JSON.stringify(res.body).includes('notes'), 'no name in the answer');
  assert.ok(!JSON.stringify(res.body).includes(home), 'and no path');
  assert.equal(existsSync(file), false, 'really gone');
});

test('a whole folder tree is deleted, recursively', async () => {
  const tree = join(work(), 'tree');
  await mkdir(join(tree, 'a', 'b'), { recursive: true });
  await writeFile(join(tree, 'a', 'b', 'deep.txt'), 'x\n');
  await writeFile(join(tree, 'top.txt'), 'x\n');

  assert.deepEqual(await del(tree), [{ ok: true }]);
  assert.equal(existsSync(tree), false, 'the tree and everything under it');
  assert.ok(existsSync(work()), 'and only the tree');
});

test('a symlink is UNLINKED — the link goes, its outside target is untouched', async () => {
  const target = join(evil, 'precious.txt');
  await writeFile(target, 'PRECIOUS\n');
  const link = join(work(), 'shortcut.txt');
  await symlink(target, link);

  assert.deepEqual(await del(link), [{ ok: true }]);
  assert.equal(existsSync(link), false, 'the link is gone');
  assert.equal(await readFile(target, 'utf8'), 'PRECIOUS\n', 'and nothing was deleted through it');

  // A link to a DIRECTORY outside the boundary is the same rule: unlink the
  // link, never walk into it. MEASURED on node v24.14.0 — recursive rm lstats
  // the final component — which is why there is no unlink branch in the route.
  const dirLink = join(work(), 'outside-dir');
  await symlink(evil, dirLink);
  assert.deepEqual(await del(dirLink), [{ ok: true }]);
  assert.equal(existsSync(dirLink), false);
  assert.equal(await readFile(target, 'utf8'), 'PRECIOUS\n', 'the target FOLDER survives whole');

  // A DANGLING link has no target at all and still deletes cleanly.
  const dangling = join(work(), 'dangling');
  await symlink(join(evil, 'no-such-file'), dangling);
  assert.deepEqual(await del(dangling), [{ ok: true }]);
  assert.equal(existsSync(join(work(), 'dangling')), false);
});

test("recursive rm does not follow a symlink INSIDE the deleted tree", async () => {
  // The whole point of the permanent delete: `rm -r` on a folder that contains
  // `sub/link.txt -> <outside>/keep.txt` and `inner -> <outside>` must remove
  // the LINKS, never what they name.
  const outsideFile = join(evil, 'keep.txt');
  await writeFile(outsideFile, 'KEEP\n');
  const tree = join(work(), 'withlinks');
  await mkdir(join(tree, 'sub'), { recursive: true });
  await symlink(outsideFile, join(tree, 'sub', 'link.txt'));
  await symlink(evil, join(tree, 'inner'));

  assert.deepEqual(await del(tree), [{ ok: true }]);
  assert.equal(existsSync(tree), false, 'the tree is gone');
  assert.equal(await readFile(outsideFile, 'utf8'), 'KEEP\n', 'the outside FILE survives');
  assert.ok(existsSync(evil), 'and so does the outside FOLDER the inner link named');
});

test('the anchors themselves — home and a registered project root — are never deletable', async () => {
  // Home itself is refused with the ANCHOR sentence whether or not its parent
  // is inside the boundary: the anchors are compared lexically BEFORE the
  // parent is resolved (the B10a verify pass found the outside-home sentence
  // answering for `<home>` in the normal layout). Pinned first, then the
  // fixture root is registered so the rest of the table has a parent anchor.
  assert.deepEqual(await del(home), [{ ok: false, status: 403, error: FS_DELETE_ANCHOR }]);
  assert.ok(existsSync(home), 'home is still there (unregistered parent)');
  const rootProject = await api(server, 'POST', '/api/projects', { name: 'Root', path: root });
  assert.equal(rootProject.status, 201, JSON.stringify(rootProject.body));
  const outsideProject = await api(server, 'POST', '/api/projects', { name: 'Outside', path: outside });
  assert.equal(outsideProject.status, 201, JSON.stringify(outsideProject.body));
  try {
    assert.deepEqual(await del(home), [{ ok: false, status: 403, error: FS_DELETE_ANCHOR }]);
    assert.ok(existsSync(home), 'home is still there');
    assert.ok(existsSync(work()), 'with everything in it');

    // A project root registered OUTSIDE home is an anchor exactly like home.
    assert.deepEqual(await del(outside), [{ ok: false, status: 403, error: FS_DELETE_ANCHOR }]);
    assert.ok(existsSync(outside), 'the project root is still there');

    // A CHILD of that outside project root is ordinary deletable content.
    const child = join(outside, 'child.txt');
    await writeFile(child, 'x\n');
    assert.deepEqual(await del(child), [{ ok: true }]);
    assert.equal(existsSync(child), false);
    assert.ok(existsSync(outside), 'and the root it lived in stays');

    // A lexical `..` that lands ON an anchor is refused by the same check.
    assert.deepEqual(await del(`${work()}/..`), [{ ok: false, status: 403, error: FS_DELETE_ANCHOR }]);
    assert.ok(existsSync(work()), 'nothing under it was touched either');

    // A SYMLINK that points at an anchor is exempt on purpose: unlinking it
    // removes the LINK, and the anchor it names is never touched.
    const selfLink = join(work(), 'to-home');
    await symlink(home, selfLink);
    assert.deepEqual(await del(selfLink), [{ ok: true }]);
    assert.equal(existsSync(selfLink), false, 'the link is gone');
    assert.ok(existsSync(home), 'home is not');
  } finally {
    for (const p of [rootProject, outsideProject]) {
      const id = (p.body as Project).id;
      assert.equal((await api(server, 'DELETE', `/api/projects/${id}`)).status, 200);
    }
  }
});

test("the app's own data dir is refused, as a target and as a parent", async () => {
  await writeFile(join(dataDir, 'canary-in-data.txt'), 'x\n');

  assert.deepEqual(await del(dataDir), [{ ok: false, status: 403, error: FS_DELETE_DATA_DIR }]);
  assert.ok(existsSync(dataDir), 'the data dir is still there');

  assert.deepEqual(await del(join(dataDir, 'canary-in-data.txt')), [
    { ok: false, status: 403, error: FS_DELETE_DATA_DIR },
  ]);
  assert.ok(existsSync(join(dataDir, 'canary-in-data.txt')), 'and so is the file inside it');

  // The token file is the reason this rule exists.
  assert.ok(existsSync(join(dataDir, 'runtime.json')), 'runtime.json untouched');
});

test('a path outside home and every project is the outside-home refusal', async () => {
  const target = join(evil, 'safe.txt');
  await writeFile(target, 'SAFE\n');
  const outsideTarget = join(outside, 'safe.txt'); // `outside` is NOT registered here
  await writeFile(outsideTarget, 'SAFE\n');

  const results = await del(target, outsideTarget, '/etc/hosts');
  for (const r of results) {
    assert.deepEqual(r, { ok: false, status: 403, error: OUTSIDE_HOME });
  }
  assert.equal(await readFile(target, 'utf8'), 'SAFE\n', 'the <home>evil PREFIX TRAP holds');
  assert.equal(await readFile(outsideTarget, 'utf8'), 'SAFE\n', 'an unregistered folder is not reachable');
  assert.ok(existsSync('/etc/hosts'), '/etc/hosts is still there');

  // A `..` chain that walks OUT of the boundary dies on the boundary, not on a
  // string rule: `resolve()` is lexical, the anchors are realpath.
  const [dots] = await del(`${home}/work/../..`);
  assert.deepEqual(dots, { ok: false, status: 403, error: OUTSIDE_HOME });
  assert.ok(existsSync(home), 'home survived the `..` chain');
});

test('a malformed path is a 400 for its own item — relative, NUL, no name', async () => {
  const kept = join(work(), 'kept.txt');
  await writeFile(kept, 'KEPT\n');

  const cases: [unknown, string, string][] = [
    ['work/kept.txt', PATH_BAD, 'a relative path'],
    [`${work()}\0/kept.txt`, PATH_BAD, 'a NUL'],
    ['/', NAME_NOT_ALLOWED, 'the filesystem root has no name to delete'],
    [`${work()}/${'é'.repeat(250)}`, NAME_NOT_ALLOWED, '500 bytes of a 250-character name'],
  ];
  for (const [path, error, why] of cases) {
    const [result] = await del(path);
    assert.deepEqual(result, { ok: false, status: 400, error }, why);
  }
  assert.equal(await readFile(kept, 'utf8'), 'KEPT\n');
  assert.ok(existsSync(home), 'home is still there');

  // A lexical `..` the KERNEL resolves back inside the boundary deletes the
  // place it really names, and nothing else.
  await writeFile(join(work(), 'viadots.txt'), 'x\n');
  assert.deepEqual(await del(`${work()}/../work/viadots.txt`), [{ ok: true }]);
  assert.equal(existsSync(join(work(), 'viadots.txt')), false);
  assert.ok(existsSync(work()), 'and the folder it was in');
});

test('something that is not there is a 404 with its own sentence', async () => {
  const [result] = await del(join(work(), 'never-existed.txt'));
  assert.deepEqual(result, { ok: false, status: 404, error: FS_DELETE_GONE });

  // A parent that is a FILE reads the same way: not there.
  await writeFile(join(work(), 'a-file'), 'x\n');
  const [through] = await del(join(work(), 'a-file', 'inside.txt'));
  assert.deepEqual(through, { ok: false, status: 404, error: FS_DELETE_GONE });
});

test('a partial batch is an ordinary 200 with one index-keyed result per path', async () => {
  const ok = join(work(), 'batch-ok.txt');
  await writeFile(ok, 'x\n');
  const missing = join(work(), 'batch-missing.txt');
  const refused = join(evil, 'batch-outside.txt');
  await writeFile(refused, 'OUTSIDE\n');

  const res = await post({ paths: [ok, missing, refused] });
  assert.equal(res.status, 200, 'a partial batch is not an error');
  assert.deepEqual(res.body, {
    results: [
      { ok: true },
      { ok: false, status: 404, error: FS_DELETE_GONE },
      { ok: false, status: 403, error: OUTSIDE_HOME },
    ],
  });
  assert.equal(existsSync(ok), false, 'the ok one is gone');
  assert.equal(await readFile(refused, 'utf8'), 'OUTSIDE\n', 'the refused one is untouched');

  // A failure NEVER stops the batch: the last item still ran. A NON-STRING
  // element is that item's 400 and nothing else's problem.
  const first = join(work(), 'z-first.txt');
  const last = join(work(), 'z-last.txt');
  await writeFile(first, 'x\n');
  await writeFile(last, 'x\n');
  const mixed = await del(join(work(), 'z-nope.txt'), first, 42, last);
  assert.deepEqual(mixed, [
    { ok: false, status: 404, error: FS_DELETE_GONE },
    { ok: true },
    { ok: false, status: 400, error: PATH_BAD },
    { ok: true },
  ]);
  assert.equal(existsSync(first), false);
  assert.equal(existsSync(last), false);
});

test('a parent and its own child in one request are BOTH ok', async () => {
  // An ordinary Explorer selection: a folder and something inside it. The child
  // is already gone when its turn comes, and "gone" is what was asked for — so
  // it is an ok, not a 404. Only an ENOENT with no deleted ancestor is a 404.
  const parent = join(work(), 'order');
  await mkdir(join(parent, 'sub'), { recursive: true });
  await writeFile(join(parent, 'sub', 'x.txt'), 'x\n');

  assert.deepEqual(await del(parent, join(parent, 'sub', 'x.txt'), join(parent, 'sub')), [
    { ok: true },
    { ok: true },
    { ok: true },
  ]);
  assert.equal(existsSync(parent), false);

  // ...and the other order is just as ok.
  const p2 = join(work(), 'order2');
  await mkdir(join(p2, 'sub'), { recursive: true });
  await writeFile(join(p2, 'sub', 'y.txt'), 'y\n');
  assert.deepEqual(await del(join(p2, 'sub', 'y.txt'), p2), [{ ok: true }, { ok: true }]);
  assert.equal(existsSync(p2), false);

  // A sibling that was never deleted is still a 404: the rule is "under
  // something THIS request removed", not "any ENOENT is fine".
  const p3 = join(work(), 'order3');
  await mkdir(p3);
  assert.deepEqual(await del(p3, join(work(), 'order3-sibling.txt')), [
    { ok: true },
    { ok: false, status: 404, error: FS_DELETE_GONE },
  ]);
});

test('the request shape is refused as a whole — empty, not an array, over the cap', async () => {
  const survivor = join(work(), 'survivor.txt');
  await writeFile(survivor, 'SURVIVOR\n');

  // 101 paths: a 413, and NOTHING is deleted — the cap is checked before the
  // first item runs, so an over-long selection is never half-applied.
  const many = [survivor, ...Array.from({ length: 100 }, (_, i) => join(work(), `many-${i}.txt`))];
  assert.equal(many.length, MAX_DELETE_ITEMS + 1);
  const over = await post({ paths: many });
  assert.equal(over.status, 413, JSON.stringify(over.body));
  assert.deepEqual(over.body, { error: FS_DELETE_TOO_MANY });
  assert.equal(await readFile(survivor, 'utf8'), 'SURVIVOR\n', 'nothing was touched');

  // ...and exactly 100 is accepted (all missing, so all 404).
  const atCap = await post({ paths: many.slice(1) });
  assert.equal(atCap.status, 200);
  assert.equal((atCap.body as FsDeleteResponse).results.length, MAX_DELETE_ITEMS);

  const bad: [unknown, string][] = [
    [{ paths: [] }, 'an empty array'],
    [{ paths: 'x' }, 'a string instead of an array'],
    [{}, 'no paths at all'],
    [{ paths: null }, 'a null paths'],
  ];
  for (const body of bad) {
    const res = await post(body[0]);
    assert.equal(res.status, 400, `${body[1]} must be a whole-request 400`);
    assert.deepEqual(res.body, { error: PATH_BAD }, body[1]);
  }
  assert.ok(existsSync(survivor), 'and every one of those left the file alone');
});

test('a body past the cap is a 413 before it is parsed — and the cap fits 100 REAL paths', async () => {
  const survivor = join(work(), 'survivor.txt');
  // DERIVED from the constant, never a copy of the number: the cap moved from
  // 64 KiB to 512 KiB once it was measured against PATH_MAX (a 100-item
  // selection of deep paths was answering `Too many items.` falsely).
  const huge = await rawRequest(server.port, {
    method: 'POST',
    path: '/api/fs/delete',
    headers: { 'x-auth-token': server.token, 'content-type': 'application/json' },
    body: JSON.stringify({ paths: [survivor, `${work()}/${'x'.repeat(DELETE_MAX_BYTES)}`] }),
  });
  assert.equal(huge.status, 413, huge.body);
  assert.deepEqual(JSON.parse(huge.body), { error: FS_DELETE_TOO_MANY });
  assert.ok(existsSync(survivor), 'nothing was deleted');

  // The cap must hold a FULL selection of Linux-maximum paths: 100 × PATH_MAX
  // (4096) plus JSON overhead. Without this the sentence would be a lie.
  const PATH_MAX = 4096;
  assert.ok(
    DELETE_MAX_BYTES > MAX_DELETE_ITEMS * PATH_MAX + 1024,
    `${DELETE_MAX_BYTES} must hold ${MAX_DELETE_ITEMS} paths of ${PATH_MAX} bytes`,
  );
  // ...and it really does, over the wire: 100 paths of ~1000 characters each.
  const deep = Array.from({ length: MAX_DELETE_ITEMS }, (_, i) =>
    join(work(), 'nope', ...Array.from({ length: 10 }, (_, d) => `seg${d}${'y'.repeat(90)}`), `f${i}.txt`),
  );
  const body = JSON.stringify({ paths: deep });
  assert.ok(body.length > 64 * 1024, `a real deep selection is ${body.length} bytes — past the OLD cap`);
  const accepted = await rawRequest(server.port, {
    method: 'POST',
    path: '/api/fs/delete',
    headers: { 'x-auth-token': server.token, 'content-type': 'application/json' },
    body,
  });
  assert.equal(accepted.status, 200, 'deep paths are answered, not refused for being "too many"');
  assert.equal((JSON.parse(accepted.body) as FsDeleteResponse).results.length, MAX_DELETE_ITEMS);
});

test('the wrong content-type, the wrong method and a missing token are each refused', async () => {
  const kept = join(work(), 'survivor.txt');

  const wrongType = await rawRequest(server.port, {
    method: 'POST',
    path: '/api/fs/delete',
    headers: { 'x-auth-token': server.token, 'content-type': 'text/plain' },
    body: JSON.stringify({ paths: [kept] }),
  });
  assert.equal(wrongType.status, 415, wrongType.body);
  assert.ok(existsSync(kept), 'and it is still there');

  // A cross-site form post cannot set application/json, which is why this check
  // is a CSRF guard beside the token/Origin/Host gate.
  const formType = await rawRequest(server.port, {
    method: 'POST',
    path: '/api/fs/delete',
    headers: { 'x-auth-token': server.token, 'content-type': 'application/x-www-form-urlencoded' },
    body: JSON.stringify({ paths: [kept] }),
  });
  assert.equal(formType.status, 415);
  assert.ok(existsSync(kept));

  assert.equal((await api(server, 'GET', '/api/fs/delete')).status, 405, 'GET');
  assert.equal((await api(server, 'DELETE', '/api/fs/delete')).status, 405, 'DELETE');

  const noToken = await rawRequest(server.port, {
    method: 'POST',
    path: '/api/fs/delete',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ paths: [kept] }),
  });
  assert.equal(noToken.status, 401, 'no token must be 401');
  const wrongToken = await rawRequest(server.port, {
    method: 'POST',
    path: '/api/fs/delete',
    headers: { 'content-type': 'application/json', 'x-auth-token': '0'.repeat(64) },
    body: JSON.stringify({ paths: [kept] }),
  });
  assert.equal(wrongToken.status, 401, 'a wrong token must be 401');
  assert.ok(existsSync(kept), 'every refusal left the file alone');

  // Malformed JSON is a plain 400 and never reaches a log: the parse error
  // quotes the body, which here is nothing but paths (readJsonBodySafe).
  const badJson = await rawRequest(server.port, {
    method: 'POST',
    path: '/api/fs/delete',
    headers: { 'x-auth-token': server.token, 'content-type': 'application/json' },
    body: `{"paths":["${kept}"`,
  });
  assert.equal(badJson.status, 400);
  assert.deepEqual(JSON.parse(badJson.body), { error: PATH_BAD });
});

test("an upload's leftover .upload-<hex>.part file is deletable like any other file", async () => {
  // A kill -9 during an upload leaves one behind; the panel lists it, and this
  // route is how the user gets rid of it.
  const part = join(work(), '.upload-0123456789abcdef0123456789abcdef.part');
  await writeFile(part, 'half a file\n');
  assert.deepEqual(await del(part), [{ ok: true }]);
  assert.equal(existsSync(part), false);
});

test('an unwritable parent answers 403 with the DELETE sentence', { skip: SKIP_IF_ROOT }, async () => {
  const ro = join(home, 'readonly');
  await mkdir(ro);
  await writeFile(join(ro, 'locked.txt'), 'LOCKED\n');
  await chmod(ro, 0o500);

  const [result] = await del(join(ro, 'locked.txt'));
  assert.deepEqual(result, { ok: false, status: 403, error: FS_NO_DELETE_PERMISSION });
  await chmod(ro, 0o700);
  assert.equal(await readFile(join(ro, 'locked.txt'), 'utf8'), 'LOCKED\n', 'still there');
});

test('server.log records COUNTS and statuses — never a name, never a path', async () => {
  const file = join(work(), NAME_CANARY);
  const folder = join(work(), 'DELETECANARY_dir');
  await writeFile(file, 'x\n');
  await mkdir(folder);

  const results = await del(file, folder, join(work(), 'DELETECANARY_missing.txt'));
  assert.deepEqual(results.map((r) => r.ok), [true, true, false]);
  await waitForLog(server, '[fs] POST /api/fs/delete -> 200, 2 ok, 1 failed');

  const log = await readServerLog(server);
  assert.ok(log.includes('[fs] POST /api/fs/delete -> 200, 2 ok, 1 failed'), 'the counts');
  assert.ok(log.includes('[fs] delete item 2 -> 404'), 'the failing item by INDEX and status');
  assert.ok(log.includes('[http] POST /api/fs/delete -> 200'), 'and the access line');
  assert.ok(!log.includes('DELETECANARY'), 'NO selected name reaches the log');
  assert.ok(!log.includes(work()), 'and no path either');
  assert.ok(!log.includes(server.token), 'and never the token');
});

// ---------------------------------------------------------------------------
// The route stays a good neighbour: refusals end the connection, a big delete
// does not stall the server.
// ---------------------------------------------------------------------------

test('every refusal taken before the body is read answers connection: close', async () => {
  const kept = join(work(), 'survivor.txt');
  const body = JSON.stringify({ paths: [kept] });
  const cases: [Record<string, string>, string, number, string][] = [
    [{ 'x-auth-token': server.token, 'content-type': 'application/json' }, body, 200, 'POST-ok'],
    [{ 'x-auth-token': server.token, 'content-type': 'text/plain' }, body, 415, '415'],
    [
      { 'x-auth-token': server.token, 'content-type': 'application/json' },
      JSON.stringify({ paths: [`${work()}/${'x'.repeat(DELETE_MAX_BYTES)}`] }),
      413,
      '413',
    ],
    [{ 'content-type': 'application/json' }, body, 401, 'the token gate with a body'],
  ];
  for (const [headers, payload, status, why] of cases) {
    const res = await rawRequest(server.port, {
      method: why === 'POST-ok' ? 'DELETE' : 'POST',
      path: '/api/fs/delete',
      headers,
      body: payload,
    });
    const expected = why === 'POST-ok' ? 405 : status;
    assert.equal(res.status, expected, `${why}: ${res.body}`);
    assert.equal(res.headers['connection'], 'close', `${why} must end the connection`);
  }
  assert.ok(existsSync(kept), 'and none of them deleted anything');
});

test('a big recursive delete does not stall the server — /health is answered while it runs', async () => {
  // MEASURED before the fix: `rmSync` of a 20k-file tree blocked the event loop
  // for 404 ms with zero timer ticks — no PTY byte, no resize and no presence
  // ping moved while a `node_modules` was being deleted. The promises `rm`
  // yields between entries, so a request that arrives mid-delete is answered
  // BEFORE the delete finishes. Ordering, not a stopwatch: a timing threshold
  // would be flaky on a loaded WSL host.
  const big = join(work(), 'bigtree');
  for (let d = 0; d < 30; d += 1) {
    const dir = join(big, `d${d}`);
    await mkdir(dir, { recursive: true });
    await Promise.all(
      Array.from({ length: 100 }, (_, f) => writeFile(join(dir, `f${f}.txt`), 'x')),
    );
  }

  const order: string[] = [];
  const deleting = post({ paths: [big] }).then((res) => {
    order.push('delete');
    return res;
  });
  const health = fetch(`${server.baseUrl}/health`).then((res) => {
    order.push('health');
    return res;
  });
  const [deleted, healthy] = await Promise.all([deleting, health]);
  assert.equal(healthy.status, 200);
  assert.deepEqual(await healthy.json(), { ok: true });
  assert.equal(deleted.status, 200);
  assert.deepEqual(deleted.body, { results: [{ ok: true }] });
  assert.equal(existsSync(big), false, '3000 files really went');
  assert.deepEqual(order, ['health', 'delete'], '/health was answered while the delete was running');
});
