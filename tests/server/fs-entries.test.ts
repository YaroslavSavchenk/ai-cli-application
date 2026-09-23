/**
 * GET /api/fs/entries — the Files panel's listing route (B2).
 *
 * Everything here runs against a REAL server child (tests/helpers/helpers.ts) whose
 * home boundary is moved onto a fixture tree with the AI_SM_HOME_OVERRIDE test
 * seam, so the traversal, prefix and symlink cases are exercised against a
 * `home` this test owns instead of the developer's own.
 *
 * Layout (`root` is a mkdtemp dir; `home` is what the server calls home):
 *
 *   <root>/home            <- the first anchor
 *   <root>/homeevil        <- the PREFIX TRAP: a string prefix of home, not a child
 *   <root>/outside         <- a folder outside home, registered as a PROJECT in
 *                             one test: the SECOND kind of anchor (user
 *                             decision 2026-09-16)
 *   <root>/outsideevil     <- the same prefix trap, against a project anchor
 *
 * Example paths in comments are `/home/you/...`, never anyone's real one.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { chmod, mkdir, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FsEntriesResponse, FsListResponse, Project } from '../../shared/protocol.ts';
import {
  anchorsFor,
  ANCHOR_REALPATH_TTL_MS,
  compareEntries,
  MAX_ENTRIES,
  FS_LIST_GONE,
  FS_NO_READ_PERMISSION,
  FS_OUTSIDE_HOME,
  FS_PATH_BAD,
  FS_READ_FAILED,
} from '../../server/fsbrowse.ts';
import {
  api,
  createSession,
  rawRequest,
  readServerLog,
  startTestServer,
  waitForLog,
  WsClient,
  wsUrl,
  type TestServer,
  sleep,
  SKIP_IF_ROOT,
  makeTempDir,
  makeTempDirSync,
  removeTempDir,
  projectRoot,
} from '../helpers/helpers.ts';

let server: TestServer;
let root: string;
let home: string;
let evil: string;
/** A folder OUTSIDE home, registered as a project in the anchor tests. */
let outside: string;
/** `<outside>evil` — the prefix trap against a PROJECT anchor. */
let outsideEvil: string;

/** A name that must NEVER reach server.log (it is an entry name, = user content). */
const ENTRY_CANARY = 'ENTRYNAMECANARY_qz.txt';

/** A segment of a path the CLIENT sends: it must reach no log line either. */
const PATH_CANARY = 'PATHCANARY_qz';

before(async () => {
  root = await realpath(await makeTempDir('ai-sm-fsent-'));
  home = join(root, 'home');
  evil = join(root, 'homeevil');
  outside = join(root, 'outside');
  outsideEvil = `${outside}evil`;
  await mkdir(home);
  await mkdir(evil);
  await mkdir(outside);
  await mkdir(join(outside, 'deep'));
  await writeFile(join(outside, 'out.txt'), 'x\n');
  await mkdir(outsideEvil);
  await writeFile(join(outsideEvil, 'secret.txt'), 'not yours\n');
  await writeFile(join(evil, 'secret.txt'), 'not yours\n');

  // Dotfiles, node_modules and .git are LISTED — no hiding, no blocklist.
  await mkdir(join(home, '.config'));
  await mkdir(join(home, 'node_modules'));
  await mkdir(join(home, '.git'));
  await writeFile(join(home, '.hidden'), 'x\n');
  await writeFile(join(home, ENTRY_CANARY), 'x\n');
  await mkdir(join(home, 'inside'));
  await writeFile(join(home, 'inside', 'note.txt'), 'x\n');
  await writeFile(join(home, 'plain.txt'), 'x\n');

  // Symlinks: one inside home, one out of home, one broken.
  await symlink(join(home, 'inside'), join(home, 'link-in'));
  await symlink(evil, join(home, 'link-out'));
  await symlink(join(home, 'no-such-target'), join(home, 'link-broken'));

  // Sort fixture: folders first, then case-insensitive natural order.
  const sortDir = join(home, 'sortdir');
  await mkdir(sortDir);
  await mkdir(join(sortDir, 'Zed'));
  await mkdir(join(sortDir, 'alpha'));
  for (const name of ['Apple', 'banana', 'img9.png', 'img10.png', 'zeta', 'A', 'a']) {
    await writeFile(join(sortDir, name), 'x\n');
  }

  // Truncation fixture: 1200 files, so the answer is the FIRST 1000 of the order.
  // Written in REVERSE, and with the one folder written LAST, on purpose: the
  // sort has to happen BEFORE the cap or `truncated` is a lie about which names
  // are missing, and a fixture written in sorted order cannot tell the two
  // apart on a filesystem whose readdir hands back creation order.
  const bigDir = join(home, 'bigdir');
  await mkdir(bigDir);
  for (let i = 1200; i >= 1; i -= 1) {
    await writeFile(join(bigDir, `file${String(i).padStart(4, '0')}`), '');
  }
  await mkdir(join(bigDir, 'zfolder'));

  // A symlink CHAIN inside home (two hops to a real folder), and a LOOP.
  await symlink(join(home, 'link-in'), join(home, 'link-chain'));
  await symlink(join(home, 'loop-b'), join(home, 'loop-a'));
  await symlink(join(home, 'loop-a'), join(home, 'loop-b'));

  // A real folder OUTSIDE home whose name is a canary: asking for it is a 403
  // that carries a client-sent path, which is the shape the log must not keep.
  await mkdir(join(evil, PATH_CANARY));

  // An unreadable folder (mode 0) for the 403 branch.
  await mkdir(join(home, 'locked'));
  await chmod(join(home, 'locked'), 0o000);

  server = await startTestServer({
    // The data dir lives INSIDE the fixture home on purpose: it is a real
    // folder in home, so the listing must show it (the create route is what
    // refuses to write into it — tests/server/fs-create.test.ts).
    dataDir: join(home, '.ai-session-manager'),
    env: { AI_SM_HOME_OVERRIDE: home },
  });
});

after(async () => {
  if (server !== undefined) await server.stop();
  if (root !== undefined) {
    await chmod(join(home, 'locked'), 0o700).catch(() => undefined);
    await removeTempDir(root);
  }
});

const list = (path?: string): Promise<{ status: number; body: unknown }> =>
  api(
    server,
    'GET',
    path === undefined ? '/api/fs/entries' : `/api/fs/entries?path=${encodeURIComponent(path)}`,
  );

const namesOf = (body: unknown): string[] => (body as FsEntriesResponse).entries.map((e) => e.name);

test('an omitted path lists HOME itself — dotfiles, node_modules and .git included', async () => {
  const res = await list();
  assert.equal(res.status, 200);
  const body = res.body as FsEntriesResponse;
  assert.equal(body.path, home, 'the RESOLVED absolute path comes back');
  assert.equal(body.truncated, 0);
  const names = namesOf(body);
  for (const name of ['.config', '.git', '.hidden', 'node_modules', '.ai-session-manager']) {
    assert.ok(names.includes(name), `${name} must be listed — no hiding, no blocklist`);
  }
  // Per entry exactly two fields: a field no row renders is a field that leaks.
  for (const entry of body.entries) {
    assert.deepEqual(Object.keys(entry).sort(), ['dir', 'name'], JSON.stringify(entry));
  }
  assert.equal(body.entries.find((e) => e.name === '.git')?.dir, true);
  assert.equal(body.entries.find((e) => e.name === 'plain.txt')?.dir, false);
});

test('folders first, then case-insensitive NATURAL order; ties broken by code units', async () => {
  const res = await list(join(home, 'sortdir'));
  assert.equal(res.status, 200);
  assert.deepEqual(namesOf(res.body), [
    'alpha',
    'Zed',
    'A',
    'a',
    'Apple',
    'banana',
    'img9.png',
    'img10.png',
    'zeta',
  ]);
});

test('compareEntries is total and stable on its own (the unit behind the order)', () => {
  assert.ok(compareEntries({ name: 'zzz', dir: true }, { name: 'aaa', dir: false }) < 0, 'folders first');
  assert.ok(compareEntries({ name: 'img9', dir: false }, { name: 'img10', dir: false }) < 0, 'img9 < img10');
  assert.ok(compareEntries({ name: 'Apple', dir: false }, { name: 'banana', dir: false }) < 0, 'Apple < banana');
  // `sensitivity: 'base'` calls these equal; the code-unit tiebreak is what
  // keeps the order from depending on readdir.
  assert.ok(compareEntries({ name: 'A', dir: false }, { name: 'a', dir: false }) < 0, 'A before a');
  assert.equal(compareEntries({ name: 'x', dir: false }, { name: 'x', dir: false }), 0);
});

test(`${MAX_ENTRIES} entries then truncated — and the window is the FIRST of the order`, async () => {
  const res = await list(join(home, 'bigdir'));
  assert.equal(res.status, 200);
  const body = res.body as FsEntriesResponse;
  assert.equal(body.entries.length, 1000);
  assert.equal(body.truncated, 201, '1200 files + 1 folder, 1000 shown');
  assert.deepEqual(
    body.entries[0],
    { name: 'zfolder', dir: true },
    'a folder written LAST is still row 0 — the whole folder is sorted, then cut',
  );
  assert.equal(body.entries[1]?.name, 'file0001', 'and the file written LAST is row 1');
  assert.equal(body.entries[999]?.name, 'file0999', 'the 1000 kept are the first of the sorted order');
});

test('symlinks: one inside home lists, one OUT of home is shown but not enterable, a broken one is skipped', async () => {
  const names = namesOf((await list()).body);
  assert.ok(names.includes('link-in'), 'a symlink to a folder inside home is listed');
  assert.ok(names.includes('link-out'), 'one pointing out of home is LISTED — hiding it would be a lie');
  assert.ok(!names.includes('link-broken'), 'a broken symlink has no kind to report; it is skipped');

  const inLink = await list(join(home, 'link-in'));
  assert.equal(inLink.status, 200);
  assert.deepEqual(namesOf(inLink.body), ['note.txt']);
  assert.equal((inLink.body as FsEntriesResponse).path, join(home, 'inside'), 'answers the REALPATH');

  const outLink = await list(join(home, 'link-out'));
  assert.equal(outLink.status, 403, 'the boundary is checked AFTER following the link');
  assert.deepEqual(outLink.body, { error: 'This folder is outside your home folder.' });
});

test('the PREFIX TRAP: <home>evil is not under <home>, and <home> itself is', async () => {
  const trap = await list(evil);
  assert.equal(trap.status, 403, `${evil} must not be readable through a ${home} boundary`);
  assert.deepEqual(trap.body, { error: 'This folder is outside your home folder.' });
  assert.ok(!JSON.stringify(trap.body).includes('secret.txt'), 'and nothing of it leaks');

  const self = await list(home);
  assert.equal(self.status, 200, 'home itself is inside the boundary');
});

test('traversal shapes: relative, .., //, a trailing /.., an empty path and a NUL each refuse — and list nothing', async () => {
  const cases: [string, string, number][] = [
    ['relative/path', 'a relative path never anchors to the server cwd', 400],
    ['../../etc', 'a relative traversal', 400],
    ['', 'an EXPLICITLY empty ?path= (only an OMITTED one means home)', 400],
    [`${home}/../homeevil`, 'lexical .. out of home', 403],
    [`${home}/inside/..`, 'a trailing /.. lands on home itself', 200],
    [`${home}//inside`, 'a doubled slash normalizes to the same folder', 200],
    [`${home}/inside/../../homeevil/secret.txt`, '.. out of home to a FILE', 403],
    [`${home}\0/inside`, 'a NUL in the path', 400],
    ['/etc', 'an absolute path outside home', 403],
    [`${home}/no-such-folder`, 'a folder that is not there', 404],
    [`${home}/plain.txt`, 'a FILE is not a folder', 404],
  ];
  for (const [path, why, status] of cases) {
    const res = await list(path);
    assert.equal(res.status, status, `${why}: ${JSON.stringify(path)} -> ${res.status}`);
    if (status !== 200) {
      assert.ok(
        !Object.hasOwn(res.body as object, 'entries'),
        `${why}: a refusal lists nothing`,
      );
      // Not one byte of what the caller sent comes back in the sentence.
      assert.ok(!JSON.stringify(res.body).includes('homeevil'), `${why}: no path echo`);
    }
  }
  // The two 200s above are home and home/inside, not something outside it.
  assert.equal((await list(`${home}/inside/..`)).status, 200);
  assert.equal(((await list(`${home}//inside`)).body as FsEntriesResponse).path, join(home, 'inside'));
});

test('the documented sentences: 400 / 403 / 404, each a constant with no path in it', async () => {
  assert.deepEqual((await list('relative/path')).body, { error: 'The app cannot open that folder.' });
  assert.deepEqual((await list('/etc')).body, { error: 'This folder is outside your home folder.' });
  assert.deepEqual((await list(`${home}/nope`)).body, { error: 'This folder is no longer there.' });
});

test('an unreadable folder answers 403 with the READ sentence', { skip: SKIP_IF_ROOT }, async () => {
  const res = await list(join(home, 'locked'));
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'You do not have permission to read this folder.' });
});

test('the route needs the token, and a wrong method is 405', async () => {
  const noToken = await rawRequest(server.port, { path: '/api/fs/entries' });
  assert.equal(noToken.status, 401, 'no token must be 401');
  const wrongToken = await rawRequest(server.port, {
    path: '/api/fs/entries',
    headers: { 'x-auth-token': '0'.repeat(64) },
  });
  assert.equal(wrongToken.status, 401, 'a wrong token must be 401');
  assert.equal((await api(server, 'POST', '/api/fs/entries')).status, 405);

  // Same Host/Origin parity as every other /api route, token or no token.
  const evilHost = await rawRequest(server.port, {
    path: '/api/fs/entries',
    headers: { host: `evil.example.com:${server.port}`, 'x-auth-token': server.token },
  });
  assert.equal(evilHost.status, 403, 'a forbidden Host is 403 even with a valid token');
  const evilOrigin = await rawRequest(server.port, {
    path: '/api/fs/entries',
    headers: { origin: 'http://evil.example.com', 'x-auth-token': server.token },
  });
  assert.equal(evilOrigin.status, 403, 'a cross-origin request is 403');
});

test('server.log records the request and the COUNT — never an entry name, never a query value', async () => {
  await list(home);
  await list(`${home}/nope`);
  await waitForLog(server, '[fs] GET /api/fs/entries');
  const log = await readServerLog(server);

  assert.ok(log.includes('[http] GET /api/fs/entries ?… -> 200'), 'the access line is there');
  assert.match(log, /\[fs\] GET \/api\/fs\/entries -> 200, \d+ entries/, 'route + status + a count');
  assert.ok(log.includes('[fs] GET /api/fs/entries -> 404'), 'a refusal logs its status');
  assert.ok(!log.includes(ENTRY_CANARY), 'NO entry name reaches the log');
  assert.ok(!log.includes('path='), 'no query string value at all');
  assert.ok(!log.includes(server.token), 'and never the token');
});

test("a path the CLIENT sent reaches no log line — not even the access line's reason= field", async () => {
  // The OTHER half of the log-privacy claim (plan §8 item 6). `?…` already
  // hides the query VALUE from the access line, but that line has a second
  // channel: `reason=` prints server/api.ts's `responseReason`, whose contract
  // is that it only ever holds a CONSTANT sentence. A route that recorded the
  // requested path there would write a filesystem path into server.log through
  // a door the `?…` rule does not cover — and nothing above would notice.
  await list(join(home, PATH_CANARY)); // 404, a canary inside home
  await list(join(evil, PATH_CANARY)); // 403, a canary outside it
  await waitForLog(server, '[http] GET /api/fs/entries ?… -> 403');
  const log = await readServerLog(server);

  assert.ok(!log.includes(PATH_CANARY), 'no segment of a client path reaches the log');

  // Positive half: every reason this route ever printed is one of the module's
  // own sentences, so the claim survives a sentence being reworded.
  const allowed = [
    FS_PATH_BAD,
    FS_OUTSIDE_HOME,
    FS_NO_READ_PERMISSION,
    FS_LIST_GONE,
    FS_READ_FAILED,
    // server/api.ts's own gate constants — the route never runs for these.
    'unauthorized',
    'forbidden host',
    'forbidden origin',
    'method not allowed',
  ];
  const reasons = [...log.matchAll(/GET \/api\/fs\/entries [^\n]*? reason=("(?:[^"\\]|\\.)*")/g)].map(
    (m) => JSON.parse(m[1] as string) as string,
  );
  assert.ok(reasons.length >= 2, `non-vacuity: only ${reasons.length} refusals logged`);
  for (const reason of reasons) {
    assert.ok(allowed.includes(reason), `a non-constant reason reached the log: ${JSON.stringify(reason)}`);
  }
});

test('a symlink CHAIN resolves to its end, and a symlink LOOP is a refusal, not a hang', async () => {
  // Plan §8 item 2 names both. The chain is the ordinary developer setup
  // (`~/work -> ~/src -> ~/projects`) and must behave like the folder it ends
  // at; the loop is what a lexical resolver would walk forever and the kernel
  // answers ELOOP for — resolveUnderAllowed maps that to the same `no longer
  // there` sentence, with no path in it.
  const chain = await list(join(home, 'link-chain'));
  assert.equal(chain.status, 200, 'two hops to a real folder is still that folder');
  assert.equal((chain.body as FsEntriesResponse).path, join(home, 'inside'), 'the END of the chain');
  assert.deepEqual(namesOf(chain.body), ['note.txt']);

  const loop = await list(join(home, 'loop-a'));
  assert.equal(loop.status, 404, 'a loop is refused, never followed');
  assert.deepEqual(loop.body, { error: 'This folder is no longer there.' });
});

// ---------------------------------------------------------------------------
// The SECOND kind of anchor: a registered project (user decision 2026-09-16)
// ---------------------------------------------------------------------------

test('a project registered OUTSIDE home is an anchor: it lists, and unregistering it takes that back', async () => {
  // The boundary is home OR the path of any project in projects.json. A user
  // who registered /mnt/c/work/app must see its files — `This folder is
  // outside your home folder.` for a project they added themselves is the
  // half-usable state the amendment exists to kill.
  const before_ = await list(outside);
  assert.equal(before_.status, 403, 'unregistered, it is outside every anchor');
  assert.deepEqual(before_.body, { error: 'This folder is outside your home folder.' });

  const created = await api(server, 'POST', '/api/projects', { name: 'Outside', path: outside });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const project = created.body as Project;
  try {
    const listed = await list(outside);
    assert.equal(listed.status, 200, `registered, it lists: ${JSON.stringify(listed.body)}`);
    assert.deepEqual(namesOf(listed.body), ['deep', 'out.txt']);
    assert.equal((listed.body as FsEntriesResponse).path, outside);

    // UNDER the anchor too, not just the anchor itself.
    assert.equal((await list(join(outside, 'deep'))).status, 200);

    // The anchor list is read PER REQUEST from the store, so a project that is
    // still there a moment later is still an anchor — nothing is cached from
    // the first call.
    assert.equal((await list(outside)).status, 200, 'and again');

    // The PREFIX TRAP against a project anchor: `<project>evil` is a string
    // prefix, not a child. This is what the `+ sep` in isUnder() defends, and
    // it now has to hold for every anchor, not only home.
    const trap = await list(outsideEvil);
    assert.equal(trap.status, 403, `${outsideEvil} is not under ${outside}`);
    assert.deepEqual(trap.body, { error: 'This folder is outside your home folder.' });
    assert.ok(!JSON.stringify(trap.body).includes('secret.txt'), 'and nothing of it leaks');

    // A DIFFERENT folder outside home is still refused: registering one
    // project opens that project, not "outside home".
    assert.equal((await list(evil)).status, 403, 'one anchor is not a blanket');
  } finally {
    assert.equal((await api(server, 'DELETE', `/api/projects/${project.id}`)).status, 200);
  }

  const after_ = await list(outside);
  assert.equal(after_.status, 403, 'removing the project takes the anchor back with it');
  assert.deepEqual(after_.body, { error: 'This folder is outside your home folder.' });
});

test('a project whose folder is GONE is not an anchor — and does not break the others', async () => {
  // anchorsFor() realpaths each project path per request; one that cannot be
  // resolved is skipped, never treated as "allow everything" and never an
  // exception that takes the listing down with it.
  const vanishing = join(root, 'vanishing');
  await mkdir(vanishing);
  const created = await api(server, 'POST', '/api/projects', { name: 'Vanishing', path: vanishing });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const project = created.body as Project;
  try {
    assert.equal((await list(vanishing)).status, 200, 'while it exists it is an anchor');
    await rm(vanishing, { recursive: true });
    assert.equal((await list(vanishing)).status, 404, 'gone: `no longer there`, not a 500');
    assert.equal((await list(home)).status, 200, 'and home still lists');
    assert.equal((await list(evil)).status, 403, 'and the boundary still holds');
  } finally {
    await api(server, 'DELETE', `/api/projects/${project.id}`);
  }
});

test('an anchor that was NEVER listed and is now GONE still cannot 500 another anchor', async () => {
  // The twin of the test above, and NOT a duplicate of it: that one lists
  // `vanishing` while it exists, which puts a POSITIVE realpath in anchorsFor's
  // 5 s memo — so for the rest of its window the realpath is never repeated and
  // a resolver that THREW on an unresolvable project path would never be asked.
  // This one registers a project and deletes its folder without ever touching a
  // /api/fs route in between, so the very next request is the FIRST realpath of
  // a path that is no longer there.
  const ghost = join(root, 'ghost-project');
  await mkdir(ghost);
  const created = await api(server, 'POST', '/api/projects', { name: 'Ghost', path: ghost });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const project = created.body as Project;
  try {
    await rm(ghost, { recursive: true }); // No listing has run: nothing is memoized.
    const listed = await list(home);
    assert.equal(listed.status, 200, `home still lists: ${JSON.stringify(listed.body)}`);
    assert.equal((await list(evil)).status, 403, 'and the boundary still holds');
    assert.equal((await list(ghost)).status, 404, 'the gone anchor itself is `no longer there`');
  } finally {
    await api(server, 'DELETE', `/api/projects/${project.id}`);
  }
});

/**
 * Past the realpath cache's window — a clock-separation wait, deliberate
 * (tests/README.md § Time): the TTL plus 200 ms for the timer turn.
 */
const PAST_ANCHOR_TTL_MS = ANCHOR_REALPATH_TTL_MS + 200;

test(`anchorsFor caches one project path's realpath for ${ANCHOR_REALPATH_TTL_MS}ms`, async () => {
  // IN-PROCESS, not through the server child: the cache is what is under test,
  // and the route's own `realpathSync(?path=)` would answer 404 for a folder
  // that is gone before the anchor list is even consulted.
  //
  // WHY THE CACHE EXISTS (2026-09-16 review): anchorsFor did one SYNCHRONOUS
  // realpathSync per project per request, on paths the user chose — the Changes
  // tab polls 12x/min, and a dead network or drvfs mount blocks the event loop
  // for its timeout on every one of them.
  const cached = join(root, 'cached-project');
  await mkdir(cached);
  const real = await realpath(cached);

  assert.ok(anchorsFor([cached]).includes(real), 'it is an anchor while it exists');
  await rm(cached, { recursive: true });
  assert.ok(
    anchorsFor([cached]).includes(real),
    'and still is INSIDE the window — that is the realpath that was not repeated',
  );

  await sleep(PAST_ANCHOR_TTL_MS);
  assert.equal(
    anchorsFor([cached]).includes(real),
    false,
    'past the window it is realpathed again, and a gone folder is no anchor',
  );
  // A gone project narrows nothing else: home is still the anchor it always was
  // (the negative answer is cached as well, so the failed realpath is not
  // repeated per request either).
  assert.deepEqual(anchorsFor([cached]), anchorsFor([]), 'and only home is left');

  // AND THE NEGATIVE ANSWER EXPIRES LIKE THE POSITIVE ONE. A project folder is
  // absent for reasons that end: a drvfs mount that was not up yet, a `git
  // clone` into a path being recreated, a rename. Caching "not an anchor"
  // FOREVER would mean the panel refuses that project until the backend is
  // restarted — with nothing in the log to say why.
  await mkdir(cached);
  assert.equal(
    anchorsFor([cached]).includes(real),
    false,
    'inside the window the cached NEGATIVE still stands (that is the realpath not repeated)',
  );
  await sleep(PAST_ANCHOR_TTL_MS);
  assert.ok(
    anchorsFor([cached]).includes(real),
    'past the window a folder that came BACK is an anchor again',
  );
});

test('/api/fs/list — the PICKER — still has no boundary at all, on purpose', async () => {
  // The asymmetry is a decision (plan §2, orchestrator defaults): the picker's
  // whole job is choosing a folder anywhere on the machine, and the folder a
  // user is about to register as a project is by definition not an anchor yet.
  // Pinned so that "the panel got a boundary" can never quietly become "the
  // picker got one too" and break Add-a-project.
  const outsideNow = await list(evil);
  assert.equal(outsideNow.status, 403, 'the PANEL refuses it');

  const picker = await api(server, 'GET', `/api/fs/list?path=${encodeURIComponent(evil)}`);
  assert.equal(picker.status, 200, 'and the PICKER lists it: /api/fs/list is not confined');
  assert.equal((picker.body as FsListResponse).path, evil);

  const rootZone = await api(server, 'GET', `/api/fs/list?path=${encodeURIComponent('/')}`);
  assert.equal(rootZone.status, 200, "and its `Root` quick zone still reaches /");
});

test(`exactly ${MAX_ENTRIES} entries is truncated 0; one more is truncated 1`, async () => {
  // The CAP BOUNDARY, off-by-one on both sides. The 1200-entry fixture above
  // proves the window is the first N of the order; this one proves where the
  // window starts being a window at all.
  const capDir = join(home, 'capdir');
  await mkdir(capDir);
  for (let i = 1; i <= MAX_ENTRIES; i += 1) {
    await writeFile(join(capDir, `f${String(i).padStart(4, '0')}`), '');
  }
  const exact = await list(capDir);
  assert.equal(exact.status, 200);
  assert.equal((exact.body as FsEntriesResponse).entries.length, MAX_ENTRIES);
  assert.equal((exact.body as FsEntriesResponse).truncated, 0, 'exactly the cap is NOT truncated');

  await writeFile(join(capDir, `f${String(MAX_ENTRIES + 1).padStart(4, '0')}`), '');
  const over = await list(capDir);
  assert.equal((over.body as FsEntriesResponse).entries.length, MAX_ENTRIES, 'still the cap');
  assert.equal((over.body as FsEntriesResponse).truncated, 1, 'one over the cap leaves exactly one out');
  await unlink(join(capDir, `f${String(MAX_ENTRIES + 1).padStart(4, '0')}`));
});

test('AI_SM_HOME_OVERRIDE: a bad value makes the server refuse to start — exit 1, no runtime.json, and it SAYS so in server.log', async () => {
  // The seam moves the boundary these routes are confined to, so a value that
  // cannot be trusted must stop the process, not silently widen or narrow what
  // the panel can read. Validated at BOOT (server/index.ts), in the same shape
  // as AI_SM_WEB_DIST_DIR — and the reason has to reach server.log, because a
  // detached backend's stderr is /dev/null and the module that owns the value
  // resolves it lazily (a module that threw at IMPORT died before the logger
  // existed and left an EMPTY log).
  const cases: { value: string; expect: RegExp }[] = [
    { value: 'home', expect: /AI_SM_HOME_OVERRIDE must be an absolute path/ },
    { value: './home', expect: /AI_SM_HOME_OVERRIDE must be an absolute path/ },
    { value: `${home}/`, expect: /AI_SM_HOME_OVERRIDE must be a normalized absolute directory path/ },
    { value: `${home}/../home`, expect: /AI_SM_HOME_OVERRIDE must be a normalized absolute directory path/ },
    { value: '/', expect: /AI_SM_HOME_OVERRIDE must be a normalized absolute directory path/ },
    { value: join(home, 'no-such-folder'), expect: /AI_SM_HOME_OVERRIDE must name an existing directory/ },
    { value: join(home, 'plain.txt'), expect: /AI_SM_HOME_OVERRIDE must name an existing directory/ },
  ];
  for (const { value, expect } of cases) {
    const dir = makeTempDirSync('ai-sm-homeover-refuse-');
    const dataDir = join(dir, 'data');
    try {
      const child = spawn(process.execPath, [join(projectRoot, 'server', 'index.ts')], {
        cwd: projectRoot,
        env: {
          ...process.env,
          AI_SM_DATA_DIR: dataDir,
          AI_SM_HOME_OVERRIDE: value,
          AI_SM_STARTUP_GRACE_MS: '600000',
          AI_SM_GRACE_MS: '600000',
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr?.on('data', (c: Buffer) => {
        stderr += c.toString('utf8');
      });
      const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve) => child.once('exit', (code, signal) => resolve({ code, signal })),
      );
      clearTimeout(timer);
      assert.equal(exit.code, 1, `${value}: must exit 1 (signal ${exit.signal})`);
      assert.match(stderr, expect, value);
      assert.ok(
        !existsSync(join(dataDir, 'runtime.json')),
        `${value}: a refused start must publish no discovery file`,
      );
      const logFile = join(dataDir, 'server.log');
      assert.ok(existsSync(logFile), `${value}: the refusal must still have written server.log`);
      const serverLog = readFileSync(logFile, 'utf8');
      assert.match(
        serverLog,
        new RegExp(`\\[error\\] refusing to start: ${expect.source}`),
        `${value}: the reason must reach server.log, not only stderr: ${serverLog}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('AI_SM_HOME_OVERRIDE never reaches a PTY: a session\'s shell keeps its own idea of home', async () => {
  // The seam moves the boundary the Files panel's routes are confined to. A
  // shell that INHERITED it would be a terminal whose `home` is this test's
  // fixture tree — and, worse, an app launched from inside that terminal would
  // adopt a boundary nobody chose. server/sessions.ts strips it in ptyEnv(),
  // beside the four restart-handoff variables, and nothing else in the suite
  // notices when that line is deleted.
  const probe = await createSession(server, {
    command: 'bash',
    // `-c`, not `-l`: no profile is sourced, so what the shell reports is
    // exactly what the PTY was handed. The braces are ${VAR-unset}, so an
    // EMPTY inherited value is still a leak and still fails this.
    args: ['-c', 'echo "OVERRIDE=[${AI_SM_HOME_OVERRIDE-unset}] DATADIR=[${AI_SM_DATA_DIR-unset}]"'],
    cwd: home,
    cols: 80,
    rows: 24,
  });
  const client = await WsClient.connect(wsUrl(server, probe.id));
  try {
    const out = await client.waitForOutput('DATADIR=[');
    assert.ok(
      out.includes('OVERRIDE=[unset]'),
      `the seam must not reach the shell, got: ${JSON.stringify(out.slice(0, 200))}`,
    );
    assert.ok(!out.includes(`OVERRIDE=[${home}`), 'and certainly not its value');
    // NON-VACUITY, or the test would pass just as well if the PTY got no
    // environment at all: a variable that is NOT a seam is still inherited.
    assert.ok(
      out.includes(`DATADIR=[${server.dataDir}]`),
      `the rest of the environment is still there, got: ${JSON.stringify(out.slice(0, 200))}`,
    );
  } finally {
    client.ws.close();
    await api(server, 'DELETE', `/api/sessions/${probe.id}`).catch(() => undefined);
  }
});
