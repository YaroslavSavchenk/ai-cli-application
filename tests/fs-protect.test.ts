/**
 * server/fsprotect.ts — the identity walk behind the rename/delete anchor and
 * data-dir refusals (B13 security re-review round 2), on a FAKE filesystem.
 *
 * The fake is what ext4 cannot be: CASE-INSENSITIVE, like drvfs (`/mnt/c`),
 * where realpath keeps the request's spelling and no string test can tell
 * `/mnt/c/work/proj` from the anchor `/mnt/c/work/Proj`. The real-filesystem
 * cases (P10/P12 chains) live in tests/fs-rename.test.ts and
 * tests/fs-delete.test.ts.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fsp, { lstat, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildProtectedSet,
  FS_PROTECT_UNAVAILABLE,
  identityOf,
  MAX_SYMLINK_HOPS,
  PROTECT_TIMEOUT_MS,
  PROTECT_TTL_MS,
  ProtectTimeoutError,
  protectedSetFor,
  protectedSetForRequest,
  resetProtectedSetCache,
  walkEntries,
  type ProtectedSet,
  type WalkFs,
} from '../server/fsprotect.ts';

interface FakeEntry { ino: number; link?: string }

/** A case-insensitive fake: keys are lowercased paths. */
function fakeFs(entries: Record<string, FakeEntry>, caseInsensitive = true): WalkFs & { calls: string[] } {
  const norm = (p: string): string => (caseInsensitive ? p.toLowerCase() : p);
  const table = new Map(Object.entries(entries).map(([k, v]) => [norm(k), v]));
  const calls: string[] = [];
  const find = (p: string): FakeEntry => {
    calls.push(p);
    const e = table.get(norm(p));
    if (e === undefined) throw Object.assign(new Error('nope'), { code: 'ENOENT' });
    return e;
  };
  return {
    calls,
    lstat: async (p) => {
      const e = find(p);
      return { dev: 7, ino: e.ino, isSymbolicLink: () => e.link !== undefined };
    },
    readlink: async (p) => {
      const e = find(p);
      if (e.link === undefined) throw Object.assign(new Error('nope'), { code: 'EINVAL' });
      return e.link;
    },
  };
}

const id = (ino: number): string => identityOf({ dev: 7, ino });

test('a drvfs case variant has the anchor identity', async () => {
  const fs = fakeFs({ '/mnt': { ino: 1 }, '/mnt/c': { ino: 2 }, '/mnt/c/work': { ino: 3 }, '/mnt/c/work/Proj': { ino: 4 } });
  const set = await buildProtectedSet(['/mnt/c/work/Proj'], [], fs);
  const asked = await fs.lstat('/mnt/c/work/proj');
  assert.equal(set.get(identityOf(asked)), 'anchor', 'lowercase spelling, same entry');
  assert.equal(set.get(id(3)), 'anchor', 'and the folder holding it');
});

test('the walk records every entry the kernel passes: relative and absolute links, `..`', async () => {
  const fs = fakeFs(
    {
      '/h': { ino: 10 },
      '/h/a': { ino: 11, link: 'b' }, // relative
      '/h/b': { ino: 12 },
      '/h/b/lnk': { ino: 13, link: '/h/c' }, // absolute
      '/h/c': { ino: 14 },
      '/h/c/up': { ino: 15, link: '../d' }, // `..` from the link's folder
      '/h/d': { ino: 16 },
      '/h/d/proj': { ino: 17 },
      '/h/unrelated': { ino: 99 },
    },
    false,
  );
  const seen: string[] = [];
  await walkEntries('/h/a/lnk/up/proj', (x) => seen.push(x), fs);
  // `/h` twice: the ABSOLUTE link restarts the walk from `/`, as the kernel does.
  assert.deepEqual(seen, [10, 11, 12, 13, 10, 14, 15, 16, 17].map(id));
  const set = await buildProtectedSet(['/h/a/lnk/up/proj'], [], fs);
  assert.equal(set.has(id(99)), false, 'nothing off the walk');
});

test('a missing entry ends the walk, keeping what it touched; anchor wins over data', async () => {
  const fs = fakeFs({ '/h': { ino: 1 }, '/h/gone-parent': { ino: 2 }, '/h/data': { ino: 3 } }, false);
  const set = await buildProtectedSet(['/h/gone-parent/proj/deeper', '/h'], ['/h/data'], fs);
  assert.equal(set.get(id(2)), 'anchor');
  assert.equal(set.get(id(1)), 'anchor', 'home is on both chains: the anchor sentence');
  assert.equal(set.get(id(3)), 'data');
  assert.equal(set.size, 3);
});

test('a symlink loop stops after MAX_SYMLINK_HOPS; a relative root is ignored', async () => {
  const fs = fakeFs({ '/l': { ino: 1, link: '/l' } }, false);
  const seen: string[] = [];
  await walkEntries('/l', (x) => seen.push(x), fs);
  assert.equal(seen.length, MAX_SYMLINK_HOPS + 1);
  const none: string[] = [];
  await walkEntries('rel/path', (x) => none.push(x), fs);
  assert.deepEqual(none, []);
});

// ---------------------------------------------------------------------------
// B1: BIGINT identities — a drvfs inode is (NTFS seq << 48) + record.
// ---------------------------------------------------------------------------

test('two inodes that collide as a JS number stay distinct identities', async () => {
  const a = (1000n << 48n) + 1n;
  const b = (1000n << 48n) + 2n;
  assert.equal(Number(a), Number(b), 'the premise: past 2^53 a number rounds them together');
  assert.notEqual(identityOf({ dev: 5n, ino: a }), identityOf({ dev: 5n, ino: b }));
  const fs: WalkFs = {
    lstat: async (p) => ({ dev: 5n, ino: p === '/proj' ? a : b, isSymbolicLink: () => false }),
    readlink: async () => {
      throw new Error('no links here');
    },
  };
  const set = await buildProtectedSet(['/proj'], [], fs);
  assert.equal(set.get(identityOf(await fs.lstat('/proj'))), 'anchor');
  assert.equal(set.has(identityOf(await fs.lstat('/neighbour'))), false, 'the neighbour is NOT refused');
});

// ---------------------------------------------------------------------------
// B2: a HUNG walk (dead mount) refuses in time, and is never piled up.
// ---------------------------------------------------------------------------

test('a walk that never finishes is a ProtectTimeoutError, and the next request shares it', async () => {
  resetProtectedSetCache();
  assert.equal(PROTECT_TIMEOUT_MS, 3_000);
  assert.equal(FS_PROTECT_UNAVAILABLE, 'The app could not check this folder right now.');
  let builds = 0;
  let finish: (s: ProtectedSet) => void = () => undefined;
  const build = (): Promise<ProtectedSet> => {
    builds += 1;
    return new Promise<ProtectedSet>((r) => {
      finish = r;
    });
  };
  await assert.rejects(protectedSetFor(['/hung'], [], { timeoutMs: 20, build }), ProtectTimeoutError);
  // Retried: NOT a second walk into the same dead mount — the running one again.
  await assert.rejects(protectedSetFor(['/hung'], [], { timeoutMs: 20, build }), ProtectTimeoutError);
  assert.equal(builds, 1, 'one walk, however many requests time out on it');
  // The mount answers: the very next request gets the set.
  const ready: ProtectedSet = new Map([['1:2', 'anchor']]);
  finish(ready);
  assert.equal(await protectedSetFor(['/hung'], [], { timeoutMs: 20, build }), ready);
  assert.equal(builds, 1);
  resetProtectedSetCache();
});

test('a hung REAL-shaped walk (lstat never resolves) times out through the builder', async () => {
  resetProtectedSetCache();
  const hung: WalkFs = {
    lstat: () => new Promise(() => undefined),
    readlink: () => new Promise(() => undefined),
  };
  const started = performance.now();
  await assert.rejects(
    protectedSetFor(['/mnt/dead/proj'], [], { timeoutMs: 30, build: () => buildProtectedSet(['/mnt/dead/proj'], [], hung) }),
    (err: unknown) => err instanceof ProtectTimeoutError && err.message === FS_PROTECT_UNAVAILABLE,
  );
  assert.ok(performance.now() - started < 2_000, 'refused on the short timer, not hung');
  resetProtectedSetCache();
});

test('a REJECTED build is not cached: the next request builds again', async () => {
  resetProtectedSetCache();
  let builds = 0;
  const failing = (): Promise<ProtectedSet> => {
    builds += 1;
    return Promise.reject(new Error('boom'));
  };
  await assert.rejects(protectedSetFor(['/r'], [], { timeoutMs: 50, build: failing }), /boom/);
  await new Promise((r) => setImmediate(r));
  const ok: ProtectedSet = new Map();
  assert.equal(await protectedSetFor(['/r'], [], { timeoutMs: 50, build: async () => ok }), ok);
  assert.equal(builds, 1, 'the second request did not reuse the rejected promise');
  resetProtectedSetCache();
});

test('a finished set is reused for the same roots; different roots build anew', async () => {
  resetProtectedSetCache();
  let builds = 0;
  const build = async (): Promise<ProtectedSet> => {
    builds += 1;
    return new Map();
  };
  await protectedSetFor(['/a'], [], { build });
  await new Promise((r) => setImmediate(r));
  await protectedSetFor(['/a'], [], { build });
  assert.equal(builds, 1);
  await protectedSetFor(['/a', '/b'], [], { build });
  assert.equal(builds, 2);
  resetProtectedSetCache();
});

// ---------------------------------------------------------------------------
// Test-gate additions (B13 phases 0+1 mutation probe): the walk's edges, the
// cache's TTL, the real-fs BIGINT lstat, and the per-request root list.
// ---------------------------------------------------------------------------

test('the walk: a RELATIVE root records nothing, even when `/<first segment>` exists', async () => {
  // Without the isAbsolute guard, `h/a` would be walked from `/` as `/h/a`.
  const fs = fakeFs({ '/h': { ino: 1 }, '/h/a': { ino: 2 } }, false);
  const seen: string[] = [];
  await walkEntries('h/a', (x) => seen.push(x), fs);
  assert.deepEqual(seen, []);
});

test('the walk: `.` segments are skipped, never lstat-ed as an entry of their own', async () => {
  const fs = fakeFs({ '/h': { ino: 1 }, '/h/a': { ino: 2 } }, false);
  const seen: string[] = [];
  await walkEntries('/h/./a/.', (x) => seen.push(x), fs);
  assert.deepEqual(seen, [1, 2].map(id));
  assert.deepEqual(fs.calls, ['/h', '/h/a'], 'one lstat per real component');
});

test('the walk STOPS at a missing entry — nothing past the gap is recorded', async () => {
  // `/h/gone` is missing, but the fake still answers for `/h/gone/x`: a walk
  // that stepped over the gap would record it.
  const fs = fakeFs({ '/h': { ino: 1 }, '/h/gone/x': { ino: 3 } }, false);
  const seen: string[] = [];
  await walkEntries('/h/gone/x', (x) => seen.push(x), fs);
  assert.deepEqual(seen, [id(1)]);
});

test('the walk STOPS at a link whose target cannot be read', async () => {
  const fs: WalkFs = {
    lstat: async (p) => ({ dev: 7, ino: p === '/l' ? 1 : 2, isSymbolicLink: () => p === '/l' }),
    readlink: async () => {
      throw Object.assign(new Error('nope'), { code: 'EACCES' });
    },
  };
  const seen: string[] = [];
  await walkEntries('/l/next', (x) => seen.push(x), fs);
  assert.deepEqual(seen, [id(1)], 'the link itself, and nothing after it');
});

test('identityOf keeps the DEVICE: the same inode number on two filesystems is two entries', () => {
  assert.notEqual(identityOf({ dev: 1, ino: 5 }), identityOf({ dev: 2, ino: 5 }));
  assert.equal(identityOf({ dev: 3n, ino: 5n }), identityOf({ dev: 3, ino: 5 }), 'bigint and number agree below 2^53');
});

test('a finished set EXPIRES after PROTECT_TTL_MS (5 s): the next request walks again', async () => {
  resetProtectedSetCache();
  assert.equal(PROTECT_TTL_MS, 5_000);
  let now = 1_000_000;
  mock.method(performance, 'now', () => now);
  try {
    let builds = 0;
    const build = async (): Promise<ProtectedSet> => {
      builds += 1;
      return new Map();
    };
    await protectedSetFor(['/ttl'], [], { build });
    await new Promise((r) => setImmediate(r)); // the `at` stamp lands
    now += PROTECT_TTL_MS - 1;
    await protectedSetFor(['/ttl'], [], { build });
    assert.equal(builds, 1, 'still fresh 1 ms before the TTL');
    now += 1;
    await protectedSetFor(['/ttl'], [], { build });
    assert.equal(builds, 2, 'expired AT the TTL');
    await new Promise((r) => setImmediate(r));
    // The TTL counts from when the walk FINISHED, not from when it started.
    now += PROTECT_TTL_MS - 1;
    await protectedSetFor(['/ttl'], [], { build });
    assert.equal(builds, 2);
  } finally {
    mock.restoreAll();
    resetProtectedSetCache();
  }
});

test('the TTL counts from the FINISH: a slow walk is fresh for 5 s after it lands', async () => {
  resetProtectedSetCache();
  let now = 2_000_000;
  mock.method(performance, 'now', () => now);
  try {
    let builds = 0;
    let finish: (s: ProtectedSet) => void = () => undefined;
    const build = (): Promise<ProtectedSet> => {
      builds += 1;
      return new Promise<ProtectedSet>((r) => {
        finish = r;
      });
    };
    const first = protectedSetFor(['/slow'], [], { build, timeoutMs: 60_000 });
    now += 10 * PROTECT_TTL_MS; // the walk takes "50 s"
    finish(new Map());
    await first;
    await new Promise((r) => setImmediate(r));
    now += PROTECT_TTL_MS - 1;
    await protectedSetFor(['/slow'], [], { build });
    assert.equal(builds, 1);
  } finally {
    mock.restoreAll();
    resetProtectedSetCache();
  }
});

test('the REAL walk lstats with { bigint: true } (drvfs inodes exceed 2^53)', async () => {
  const seen: unknown[] = [];
  const real = fsp.lstat;
  mock.method(fsp, 'lstat', (p: string, o?: unknown) => {
    seen.push(o);
    return (real as (p: string, o?: unknown) => Promise<unknown>)(p, o);
  });
  syncBuiltinESMExports();
  try {
    const ids: string[] = [];
    await walkEntries(tmpdir(), (x) => ids.push(x));
    assert.ok(seen.length > 0, 'the default fs is node:fs/promises');
    for (const o of seen) assert.deepEqual(o, { bigint: true });
    const st = await real(tmpdir(), { bigint: true });
    assert.equal(ids[ids.length - 1], identityOf(st));
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test('protectedSetForRequest walks the anchors, every STORED project path and the configured data dir', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-sm-fsprot-')));
  const saved = process.env['AI_SM_DATA_DIR'];
  try {
    const anchor = join(root, 'anchor');
    const stored = join(root, 'stored');
    const data = join(root, 'data');
    for (const d of [anchor, stored, data]) await mkdir(d);
    process.env['AI_SM_DATA_DIR'] = data;
    resetProtectedSetCache();
    const set = await protectedSetForRequest([stored, 'relative/ignored'], [anchor]);
    const idOf = async (p: string): Promise<string> => identityOf(await lstat(p, { bigint: true }));
    assert.equal(set.get(await idOf(anchor)), 'anchor', 'the anchor list itself');
    assert.equal(set.get(await idOf(stored)), 'anchor', 'a stored project path');
    assert.equal(set.get(await idOf(data)), 'data', 'the configured data dir');
    assert.equal(set.get(await idOf(root)), 'anchor', 'their common ancestor: anchor wins');
  } finally {
    if (saved === undefined) delete process.env['AI_SM_DATA_DIR'];
    else process.env['AI_SM_DATA_DIR'] = saved;
    resetProtectedSetCache();
    await rm(root, { recursive: true, force: true });
  }
});
