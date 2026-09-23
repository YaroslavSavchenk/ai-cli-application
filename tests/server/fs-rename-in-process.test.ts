/**
 * POST /api/fs/rename, IN-PROCESS (Nocturne B13 phase 1): `handleRename`
 * called directly with `node:fs/promises` SPIED — the paths no filesystem in
 * this checkout produces: link(2) refused (the drvfs fallback), an unlink that
 * fails after the link succeeded (the rollback), a case-insensitive
 * filesystem, a protected-set walk that hangs or fails, a 5xx log line.
 *
 * The spies are `mock.method` on the module object + `syncBuiltinESMExports`,
 * restored in `finally`. The server child on the fixture `home`
 * (`tests/helpers/fs-server-fixture.ts`) makes the tree and the data dir; this
 * process's env points at the same two. Split out of `fs-rename.test.ts`
 * (restructure O6); every in-process test stays in this one file.
 *
 * NOT claimed: a true drvfs mount — these prove the handler's branches on a
 * spied errno, not what a real mount answers.
 *
 * Example paths in comments are `/home/you/...`, never anyone's real one.
 */
import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import fsp, {
  lstat,
  mkdir,
  readdir,
  readFile,
  writeFile,
} from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { FS_NO_RENAME_PERMISSION, FS_RENAME_FAILED, handleRename } from '../../server/fsrename.ts';
import {
  FS_PROTECT_UNAVAILABLE,
  protectedSetFor,
  resetProtectedSetCache,
  type ProtectedSet,
} from '../../server/fsprotect.ts';
import {
  bootFsServer,
  dataDir,
  home,
  stopFsServer,
  work,
} from '../helpers/fs-server-fixture.ts';
import { ALREADY_EXISTS, CANARY } from '../helpers/fs-rename-fixture.ts';

before(() => bootFsServer('ai-sm-fsren-'));

after(() => stopFsServer(() => [[join(home, 'readonly'), 0o700]]));

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
