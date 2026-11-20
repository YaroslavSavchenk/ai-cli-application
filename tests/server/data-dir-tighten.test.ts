/**
 * The data dir is brought to 0700 at boot — Nocturne D9 P2 fix round
 * (`.claude/plans/nocturne/PLAN-D9.md`): `server/config.ts` `tightenDataDir`,
 * called by `resolveDataPaths`, and its one `server.log` line.
 *
 * How: a real backend child booted on a data dir created 0755 (what an
 * install before D9 left: `umask 022; mkdir -p <data>/app`); the function
 * itself for the cases a boot cannot show (a link, a dir already private).
 *
 * Why it matters: the pty-host refuses any data dir that is not exactly 0700
 * (`server/pty-host-wire.ts` `dataDirRefusal`). `mkdirSync({ mode })` leaves an
 * existing directory alone, so without this every existing install would run
 * without session survival, for good, and say nothing.
 *
 * Another user's directory cannot be made without root: the uid rule is
 * shown by mocking `process.getuid` (the dir then looks like someone else's).
 *
 * NOT claimed: a real directory of another user (the pty-host refuses it too —
 * pinned in `pty-host-wire.test.ts` and `pty-host-auth.test.ts`).
 */
import { test, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, realpath, symlink } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { tightenDataDir } from '../../server/config.ts';
import { SKIP_IF_ROOT, makeTempDir, removeTempDir, startTestServer, waitForLog } from '../helpers/helpers.ts';

const dirs: string[] = [];
after(async () => {
  for (const d of dirs) await removeTempDir(d);
});

test('a backend booting on a 0755 data dir tightens it to 0700 and says so', { skip: SKIP_IF_ROOT }, async () => {
  const root = await realpath(await makeTempDir('ai-sm-tighten-'));
  dirs.push(root);
  const dataDir = join(root, 'data');
  await mkdir(dataDir);
  await chmod(dataDir, 0o755);
  const server = await startTestServer({ dataDir });
  try {
    await waitForLog(server, `data dir ${dataDir} had mode 755; tightened to 700`);
    assert.equal(statSync(dataDir).mode & 0o777, 0o700);
  } finally {
    await server.stop();
  }
});

test('tightenDataDir leaves a private dir and a link alone, and only clears group and other bits', async () => {
  const root = await makeTempDir('ai-sm-tighten-');
  dirs.push(root);
  const priv = join(root, 'private');
  await mkdir(priv, { mode: 0o700 });
  assert.equal(tightenDataDir(priv), undefined, 'already 0700');
  assert.equal(tightenDataDir(join(root, 'missing')), undefined, 'nothing there');

  const open = join(root, 'open');
  await mkdir(open);
  await chmod(open, 0o750);
  const link = join(root, 'link');
  await symlink(open, link);
  assert.equal(tightenDataDir(link), undefined, 'a link is not followed');
  assert.equal(statSync(open).mode & 0o777, 0o750, 'its target is untouched');

  assert.equal(tightenDataDir(open), 0o750, 'the old mode is reported');
  assert.equal(statSync(open).mode & 0o777, 0o700);
});

test('tightenDataDir leaves a directory that only looks like another user\'s alone', async () => {
  const root = await makeTempDir('ai-sm-tighten-');
  dirs.push(root);
  const open = join(root, 'theirs');
  await mkdir(open);
  await chmod(open, 0o755);
  const uid = process.getuid?.() ?? 0;
  const getuid = mock.method(process as { getuid: () => number }, 'getuid', () => uid + 1) // getuid is optional in the types (absent on Windows); present on Linux;
  try {
    assert.equal(tightenDataDir(open), undefined, 'not ours: nothing changed, nothing reported');
  } finally {
    getuid.mock.restore();
  }
  assert.equal(statSync(open).mode & 0o777, 0o755, 'its mode is untouched');
});

test('tightenDataDir: owner-only modes are left as they are; group or other bits become exactly 0700', async () => {
  const root = await makeTempDir('ai-sm-tighten-');
  dirs.push(root);
  const cases: [number, number, number | undefined][] = [
    [0o500, 0o500, undefined], // owner-only: not widened to 0700
    [0o570, 0o700, 0o570], // group bits set: the result is 0700, owner write included
    [0o711, 0o700, 0o711],
    [0o701, 0o700, 0o701],
  ];
  for (const [before, after, reported] of cases) {
    const dir = join(root, before.toString(8));
    await mkdir(dir);
    await chmod(dir, before);
    assert.equal(tightenDataDir(dir), reported, `${before.toString(8)}: reported`);
    assert.equal(statSync(dir).mode & 0o777, after, `${before.toString(8)}: mode after`);
    await chmod(dir, 0o700); // so the temp dir can be removed
  }
});
