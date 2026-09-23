/**
 * POST /api/fs/delete — what protects a project or the data dir reached
 * through a symlink (Nocturne B13 security review F1/F2 and re-review round 2,
 * `server/fsprotect.ts`): paths AS STORED, by IDENTITY (dev+ino), the STRING
 * layer on its own while the cached identity set is stale, and the two
 * in-process cases (`handleDelete` called directly, `node:fs/promises` spied
 * for the lstat options; a protected set that never comes).
 *
 * One real server child on a fixture `home` (AI_SM_HOME_OVERRIDE,
 * `tests/helpers/fs-server-fixture.ts`); a data dir configured through links
 * gets a second child of its own. The in-process tests set this process's env
 * to the same home and data dir. Split out of `fs-delete.test.ts`
 * (restructure O6).
 *
 * Every refusal asserts that the link, the project or runtime.json is still
 * there: this route is the one that cannot be undone.
 *
 * NOT claimed: a real drvfs mount or Windows; the Files panel's delete UI.
 *
 * Example paths in comments are `/home/you/...`, never anyone's real one.
 */
import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import fsp, {
  lstat,
  mkdir,
  readFile,
  readlink,
  realpath,
  rename as fsRename,
  symlink,
  writeFile,
} from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import type { FsDeleteResponse, Project } from '../../shared/protocol.ts';
import { FS_DELETE_ANCHOR, FS_DELETE_DATA_DIR, handleDelete } from '../../server/fsdelete.ts';
import {
  FS_PROTECT_UNAVAILABLE,
  PROTECT_TIMEOUT_MS,
  protectedSetFor,
  resetProtectedSetCache,
  type ProtectedSet,
} from '../../server/fsprotect.ts';
import {
  api,
  startTestServer,
  type TestServer,
  makeTempDir,
  removeTempDir,
} from '../helpers/helpers.ts';
import { bootFsServer, dataDir, home, server, stopFsServer, work } from '../helpers/fs-server-fixture.ts';
import { del } from '../helpers/fs-delete-fixture.ts';

before(() => bootFsServer('ai-sm-fsdel-'));

after(() => stopFsServer(() => [[join(home, 'readonly'), 0o700]]));

// ---------------------------------------------------------------------------
// Paths AS STORED (B13 security review F1/F2): a project or data dir reached
// through a symlink is protected by its stored/configured path too.
// ---------------------------------------------------------------------------

test('a project registered THROUGH a symlink: the link and a symlinked ancestor are refused', async () => {
  const realProj = join(home, 'del-real-proj');
  await mkdir(realProj);
  await writeFile(join(realProj, 'src.txt'), 'SRC\n');
  const projLink = join(home, 'del-proj-link');
  await symlink(realProj, projLink);
  const realHolder = join(home, 'del-real-holder');
  await mkdir(join(realHolder, 'proj'), { recursive: true });
  const lnk = join(home, 'del-lnk');
  await symlink(realHolder, lnk);
  const a = await api(server, 'POST', '/api/projects', { name: 'ViaLink', path: projLink });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  const b = await api(server, 'POST', '/api/projects', { name: 'ViaAncestor', path: join(lnk, 'proj') });
  assert.equal(b.status, 201, JSON.stringify(b.body));
  try {
    assert.deepEqual(await del(projLink, lnk), [
      { ok: false, status: 403, error: FS_DELETE_ANCHOR },
      { ok: false, status: 403, error: FS_DELETE_ANCHOR },
    ]);
    assert.ok((await lstat(projLink)).isSymbolicLink(), 'the project link is still there');
    assert.ok((await lstat(lnk)).isSymbolicLink(), 'the ancestor link is still there');
    assert.equal(await readFile(join(realProj, 'src.txt'), 'utf8'), 'SRC\n');
  } finally {
    for (const p of [a, b]) {
      assert.equal((await api(server, 'DELETE', `/api/projects/${(p.body as Project).id}`)).status, 200);
    }
  }
  // Unregistered, both are ordinary links again.
  assert.deepEqual(await del(projLink, lnk), [{ ok: true }, { ok: true }]);
  assert.ok(existsSync(join(realProj, 'src.txt')), 'and deleting a link never touched its target');
});

test('a data dir CONFIGURED through a symlink: the link holding it is refused', async () => {
  const nestRoot = await realpath(await makeTempDir('ai-sm-fsdel3-'));
  const nestHome = join(nestRoot, 'home');
  const realDd = join(nestHome, 'real-dd');
  await mkdir(realDd, { recursive: true });
  const ddlink = join(nestHome, 'ddlink');
  await symlink(realDd, ddlink);
  const second = await startTestServer({ dataDir: join(ddlink, 'data'), env: { AI_SM_HOME_OVERRIDE: nestHome } });
  try {
    const res = await api(second, 'POST', '/api/fs/delete', { paths: [ddlink] });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual((res.body as FsDeleteResponse).results, [
      { ok: false, status: 403, error: FS_DELETE_DATA_DIR },
    ]);
    assert.ok((await lstat(ddlink)).isSymbolicLink(), 'the link is still there');
    assert.ok(existsSync(join(ddlink, 'data', 'runtime.json')), 'and still reaches the data dir');
  } finally {
    await second.stop();
    await removeTempDir(nestRoot);
  }
});

// ---------------------------------------------------------------------------
// By IDENTITY (B13 security re-review round 2, server/fsprotect.ts).
// ---------------------------------------------------------------------------

test('P10: a link deeper in a stored project chain, and the folder it sits in, are refused', async () => {
  const b = join(home, 'del-p10b');
  const c = join(home, 'del-p10c');
  await mkdir(b);
  await mkdir(join(c, 'proj'), { recursive: true });
  await writeFile(join(c, 'proj', 'src.txt'), 'SRC\n');
  await symlink(b, join(home, 'del-p10a'));
  await symlink(c, join(b, 'lnk'));
  const created = await api(server, 'POST', '/api/projects', { name: 'P10', path: join(home, 'del-p10a', 'lnk', 'proj') });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  try {
    assert.deepEqual(await del(join(b, 'lnk'), b), [
      { ok: false, status: 403, error: FS_DELETE_ANCHOR },
      { ok: false, status: 403, error: FS_DELETE_ANCHOR },
    ]);
    assert.ok((await lstat(join(b, 'lnk'))).isSymbolicLink(), 'the deep link is still there');
    assert.equal(await readFile(join(home, 'del-p10a', 'lnk', 'proj', 'src.txt'), 'utf8'), 'SRC\n');
  } finally {
    assert.equal((await api(server, 'DELETE', `/api/projects/${(created.body as Project).id}`)).status, 200);
  }
});

test('P12: a link deeper in the CONFIGURED data dir chain is refused as the data dir', async () => {
  const nestRoot = await realpath(await makeTempDir('ai-sm-fsdel4-'));
  const nestHome = join(nestRoot, 'home');
  const y = join(nestHome, 'y');
  const z = join(nestHome, 'z');
  await mkdir(y, { recursive: true });
  await mkdir(z);
  await symlink('y', join(nestHome, 'x'));
  await symlink(z, join(y, 'dl'));
  const second = await startTestServer({
    dataDir: join(nestHome, 'x', 'dl', 'data'),
    env: { AI_SM_HOME_OVERRIDE: nestHome },
  });
  try {
    const res = await api(second, 'POST', '/api/fs/delete', { paths: [join(y, 'dl'), y, join(nestHome, 'x')] });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const refusal = { ok: false, status: 403, error: FS_DELETE_DATA_DIR };
    assert.deepEqual((res.body as FsDeleteResponse).results, [refusal, refusal, refusal]);
    assert.ok((await lstat(join(y, 'dl'))).isSymbolicLink());
    assert.ok(existsSync(join(nestHome, 'x', 'dl', 'data', 'runtime.json')), 'the configured path still works');
  } finally {
    await second.stop();
    await removeTempDir(nestRoot);
  }
});

// ---------------------------------------------------------------------------
// Test-gate additions (B13 phases 0+1 mutation probe).
//
// STALE SET: the string tests stay as a first line because the identity set is
// cached for PROTECT_TTL_MS (server/fsprotect.ts). These prime that cache with
// an ordinary delete, then give the protected link a NEW inode (made before the
// old one goes, so the number cannot be reused), so the next request is judged
// against a set that no longer knows it: only the string layer under test can
// refuse. Priming files are created BEFORE any swap — a file made right after
// one can reuse the inode it freed, which the stale set still protects. (Past
// the TTL the identity check refuses too: the tests still pass, they just stop
// singling one layer out.)
// ---------------------------------------------------------------------------

let primeN = 0;
async function primeFile(dir: string): Promise<string> {
  primeN += 1;
  const p = join(dir, `del-prime-${primeN}.txt`);
  await writeFile(p, 'p\n');
  return p;
}
async function primeSet(srv: TestServer, file: string): Promise<void> {
  const res = await api(srv, 'POST', '/api/fs/delete', { paths: [file] });
  assert.equal(res.status, 200);
  assert.deepEqual((res.body as FsDeleteResponse).results, [{ ok: true }]);
}
/** Replace the symlink at `at` with a new one to the same target (new inode). */
async function relink(at: string): Promise<void> {
  const before = await lstat(at);
  const target = await readlink(at);
  await symlink(target, `${at}.relink`);
  await fsRename(`${at}.relink`, at);
  assert.notEqual((await lstat(at)).ino, before.ino, 'premise: a new inode');
}

test('STALE set: a link on the STORED path, asked through a linked parent, is refused lexically', async () => {
  // `dd1-via -> dd1-R`, `dd1-R/lnk -> dd1-T`, stored `<home>/dd1-via/lnk/proj`:
  // `lex` holds the stored path, `target` (`<home>/dd1-R/lnk`) does not.
  const R = join(home, 'dd1-R');
  const T = join(home, 'dd1-T');
  await mkdir(R);
  await mkdir(join(T, 'proj'), { recursive: true });
  await symlink(R, join(home, 'dd1-via'));
  await symlink(T, join(R, 'lnk'));
  const prime = await primeFile(work());
  const created = await api(server, 'POST', '/api/projects', { name: 'DD1', path: join(home, 'dd1-via', 'lnk', 'proj') });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  try {
    await primeSet(server, prime);
    await relink(join(R, 'lnk'));
    assert.deepEqual(await del(join(home, 'dd1-via', 'lnk')), [{ ok: false, status: 403, error: FS_DELETE_ANCHOR }]);
    assert.ok((await lstat(join(R, 'lnk'))).isSymbolicLink());
  } finally {
    assert.equal((await api(server, 'DELETE', `/api/projects/${(created.body as Project).id}`)).status, 200);
  }
});

test('STALE set: a link on an UNNORMALISED stored path, asked through a second link to home, is refused by `target`', async () => {
  // Stored as `<home>/dd2-seg/../dd2-lnk/proj`; asked as
  // `<home>/work/dd2-back/dd2-lnk` with `dd2-back -> home`.
  const real = join(home, 'dd2-real');
  await mkdir(join(real, 'proj'), { recursive: true });
  await mkdir(join(home, 'dd2-seg'));
  await symlink(real, join(home, 'dd2-lnk'));
  await symlink(home, join(work(), 'dd2-back'));
  const prime = await primeFile(work());
  const created = await api(server, 'POST', '/api/projects', { name: 'DD2', path: `${home}/dd2-seg/../dd2-lnk/proj` });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  try {
    await primeSet(server, prime);
    await relink(join(home, 'dd2-lnk'));
    assert.deepEqual(await del(join(work(), 'dd2-back', 'dd2-lnk')), [
      { ok: false, status: 403, error: FS_DELETE_ANCHOR },
    ]);
    assert.ok((await lstat(join(home, 'dd2-lnk'))).isSymbolicLink());
  } finally {
    assert.equal((await api(server, 'DELETE', `/api/projects/${(created.body as Project).id}`)).status, 200);
  }
});

test('STALE set: a folder holding a project REALPATH is refused by the string test', async () => {
  // Stored as `<home>/dd3-link/proj`, realpath `<home>/dd3-real/proj`:
  // deleting `dd3-real` matches no stored path, only the realpath anchor.
  const real = join(home, 'dd3-real');
  await mkdir(join(real, 'proj'), { recursive: true });
  await writeFile(join(real, 'proj', 'src.txt'), 'SRC\n');
  await symlink(real, join(home, 'dd3-link'));
  const prime = await primeFile(work());
  const created = await api(server, 'POST', '/api/projects', { name: 'DD3', path: join(home, 'dd3-link', 'proj') });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  try {
    await primeSet(server, prime);
    // A new inode for the folder: a fresh one takes over its children.
    const before = await lstat(real);
    await mkdir(`${real}.new`);
    await fsRename(join(real, 'proj'), join(`${real}.new`, 'proj'));
    await fsRename(`${real}.new`, real);
    assert.notEqual((await lstat(real)).ino, before.ino, 'premise: a new inode');
    assert.deepEqual(await del(real), [{ ok: false, status: 403, error: FS_DELETE_ANCHOR }]);
    assert.equal(await readFile(join(real, 'proj', 'src.txt'), 'utf8'), 'SRC\n');
  } finally {
    assert.equal((await api(server, 'DELETE', `/api/projects/${(created.body as Project).id}`)).status, 200);
  }
});

test('STALE set: the configured data dir link — on `lex` (linked parent) and on `target` (second link)', async () => {
  for (const shape of ['lex', 'target'] as const) {
    const nestRoot = await realpath(await makeTempDir('ai-sm-fsdel5-'));
    const nh = join(nestRoot, 'home');
    const realdd = join(nh, 'realdd');
    await mkdir(realdd, { recursive: true });
    let dataDirCfg: string;
    let ask: string;
    let link: string;
    if (shape === 'lex') {
      // AI_SM_DATA_DIR=<nh>/seg/../via/ddl/data, `via -> R`, `R/ddl -> realdd`.
      await mkdir(join(nh, 'seg'));
      await mkdir(join(nh, 'R'));
      await symlink(join(nh, 'R'), join(nh, 'via'));
      link = join(nh, 'R', 'ddl');
      await symlink(realdd, link);
      dataDirCfg = `${nh}/seg/../via/ddl/data`;
      ask = join(nh, 'via', 'ddl');
    } else {
      // AI_SM_DATA_DIR=<nh>/ddl/data, `ddl -> realdd`, asked as `<nh>/back/ddl`.
      link = join(nh, 'ddl');
      await symlink(realdd, link);
      await symlink(nh, join(nh, 'back'));
      dataDirCfg = join(nh, 'ddl', 'data');
      ask = join(nh, 'back', 'ddl');
    }
    const prime = await primeFile(nh);
    const second = await startTestServer({ dataDir: dataDirCfg, env: { AI_SM_HOME_OVERRIDE: nh } });
    try {
      await primeSet(second, prime);
      await relink(link);
      const res = await api(second, 'POST', '/api/fs/delete', { paths: [ask] });
      assert.equal(res.status, 200);
      assert.deepEqual((res.body as FsDeleteResponse).results, [{ ok: false, status: 403, error: FS_DELETE_DATA_DIR }], shape);
      assert.ok(existsSync(join(realdd, 'data', 'runtime.json')), shape);
    } finally {
      await second.stop();
      await removeTempDir(nestRoot);
    }
  }
});

// ---------------------------------------------------------------------------
// IN-PROCESS: handleDelete called directly (same home and data dir as the
// server child, set in THIS process's env before the first call).
// ---------------------------------------------------------------------------

async function inProcDelete(paths: string[]): Promise<{ status: number; body: unknown; logs: [string, string][] }> {
  process.env['AI_SM_HOME_OVERRIDE'] = home;
  process.env['AI_SM_DATA_DIR'] = dataDir;
  const out = { status: 0, body: undefined as unknown, logs: [] as [string, string][] };
  await handleDelete(
    { method: 'POST', headers: { 'content-type': 'application/json' } } as unknown as IncomingMessage,
    {} as ServerResponse,
    {
      projects: () => [],
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
      },
      readJson: async () => ({ ok: true, value: { paths } }),
    },
  );
  return out;
}

test('in-process: the entry is lstat-ed with { bigint: true } before its identity is judged', async () => {
  const d = join(work(), 'inproc-big');
  await mkdir(d, { recursive: true });
  const file = join(d, 'x.txt');
  await writeFile(file, 'x\n');
  const calls: [unknown, unknown][] = [];
  const real = fsp.lstat as unknown as (p: unknown, o?: unknown) => Promise<unknown>;
  mock.method(fsp, 'lstat', (p: unknown, o?: unknown) => (calls.push([p, o]), real(p, o)));
  syncBuiltinESMExports();
  try {
    const res = await inProcDelete([file]);
    assert.deepEqual((res.body as FsDeleteResponse).results, [{ ok: true }]);
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.deepEqual(calls.filter(([p]) => p === file).map(([, o]) => o), [{ bigint: true }]);
});

test('in-process: a protected set that does not come in time is a 503 for EVERY item, fetched ONCE per request', async () => {
  const d = join(work(), 'inproc-hung');
  await mkdir(d, { recursive: true });
  const files = ['a.txt', 'b.txt', 'c.txt'].map((n) => join(d, n));
  for (const f of files) await writeFile(f, 'h\n');
  process.env['AI_SM_HOME_OVERRIDE'] = home;
  process.env['AI_SM_DATA_DIR'] = dataDir;
  resetProtectedSetCache();
  protectedSetFor([home], [dataDir], { build: () => new Promise<ProtectedSet>(() => undefined), timeoutMs: 1 }).catch(
    () => undefined,
  );
  try {
    const started = performance.now();
    const res = await inProcDelete(files);
    const took = performance.now() - started;
    const refusal = { ok: false, status: 503, error: FS_PROTECT_UNAVAILABLE };
    assert.equal(res.status, 200);
    assert.deepEqual((res.body as FsDeleteResponse).results, [refusal, refusal, refusal]);
    for (const f of files) assert.ok(existsSync(f), 'nothing deleted');
    // ONE wait of PROTECT_TIMEOUT_MS for the batch, not one per item.
    assert.ok(took >= PROTECT_TIMEOUT_MS - 50, `waited the timeout (${took} ms)`);
    assert.ok(took < 2 * PROTECT_TIMEOUT_MS, `once per request, not per item (${took} ms)`);
    assert.equal(res.logs.filter(([level]) => level === 'error').length, 0, 'a refusal, not a failure');
  } finally {
    resetProtectedSetCache();
  }
});
