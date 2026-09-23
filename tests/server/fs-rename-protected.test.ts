/**
 * POST /api/fs/rename — what protects a project or the data dir reached
 * through a symlink (Nocturne B13 security review F1/F2 and re-review round 2,
 * `server/fsprotect.ts`): paths AS STORED, by IDENTITY (dev+ino), nothing
 * renamed ONTO a stored project path (N5), the order of the checks, and the
 * STRING layer on its own while the cached identity set is stale.
 *
 * One real server child on a fixture `home` (AI_SM_HOME_OVERRIDE,
 * `tests/helpers/fs-server-fixture.ts`); a data dir configured through links
 * gets a second child of its own. Split out of `fs-rename.test.ts`
 * (restructure O6).
 *
 * EVERY refusal asserts that the entries are unchanged on disk afterwards: a
 * rename that replaced something would be a hidden permanent delete (D1).
 *
 * NOT claimed: a true drvfs mount or Windows.
 *
 * Example paths in comments are `/home/you/...`, never anyone's real one.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rename as fsRename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { FS_RENAME_ANCHOR, FS_RENAME_DATA_DIR } from '../../server/fsrename.ts';
import {
  api,
  startTestServer,
  type TestServer,
  makeTempDir,
  removeTempDir,
} from '../helpers/helpers.ts';
import {
  bootFsServer,
  evil,
  home,
  NAME_NOT_ALLOWED,
  OUTSIDE_HOME,
  server,
  stopFsServer,
  work,
} from '../helpers/fs-server-fixture.ts';
import { refused, renamed, withProject } from '../helpers/fs-rename-fixture.ts';

before(() => bootFsServer('ai-sm-fsren-'));

after(() => stopFsServer(() => [[join(home, 'readonly'), 0o700]]));

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
  const nestRoot = await realpath(await makeTempDir('ai-sm-fsren3-'));
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
    await removeTempDir(nestRoot);
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
  const nestRoot = await realpath(await makeTempDir('ai-sm-fsren4-'));
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
    await removeTempDir(nestRoot);
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
  const nestRoot = await realpath(await makeTempDir('ai-sm-fsren5-'));
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
    await removeTempDir(nestRoot);
  }
});

test('STALE set: the configured data dir link, asked through a second link, is refused by `src`', async () => {
  // AI_SM_DATA_DIR=<nh>/ddl/data, `ddl -> realdd`; asked as `<nh>/back/ddl`
  // with `back -> nh`: only `src` (`<nh>/ddl`) holds the configured path.
  const nestRoot = await realpath(await makeTempDir('ai-sm-fsren6-'));
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
    await removeTempDir(nestRoot);
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
