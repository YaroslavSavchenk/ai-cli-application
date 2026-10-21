/**
 * server/fstext.ts openReadOnly() and closeQuietly() — the one open every
 * route that reads a file's bytes goes through (GET /api/fs/read since B4,
 * the media viewer's two routes since Nocturne D7,
 * `.claude/plans/nocturne/PLAN-D7.md`).
 *
 * How: the functions in process on a temp dir. The open is handed a REALPATH
 * by its callers, so a symlink standing at that name only happens in a race
 * (or a link planted between the realpath and the open) — a window no HTTP
 * test can hit on purpose. Calling the helper with a link is the deterministic
 * stand-in for that race. The FIFO half (O_NONBLOCK) is proven through the
 * server in fs-media-boundary.test.ts and fs-text-boundary.test.ts.
 *
 * Why it matters: without O_NOFOLLOW, a link swapped in at the last moment is
 * followed to wherever it points — outside home, into the data dir — after
 * the boundary already said yes.
 *
 * NOT claimed: the realpath and anchor rules themselves (the boundary files).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, fstatSync, openSync } from 'node:fs';
import { symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { closeQuietly, openReadOnly } from '../../server/fstext.ts';
import { FsBrowseError } from '../../server/fsbrowse.ts';
import { makeTempDir, removeTempDir } from '../helpers/helpers.ts';

let dir: string;

before(async () => {
  dir = await makeTempDir('ai-sm-read-open-');
});
after(() => removeTempDir(dir));

test('a symlink standing at the opened name is refused (ELOOP as a 415), never followed', async () => {
  const target = join(dir, 'target.png');
  await writeFile(target, 'BYTES');
  const link = join(dir, 'raced.png');
  await symlink(target, link);
  assert.throws(
    () => openReadOnly(link),
    (err: unknown) =>
      err instanceof FsBrowseError && err.status === 415 && (err as { code?: string }).code === 'ELOOP',
    'O_NOFOLLOW refuses the link',
  );
  const fd = openReadOnly(target);
  try {
    assert.equal(fstatSync(fd).size, 5, 'non-vacuity: the target itself opens');
  } finally {
    closeSync(fd);
  }
});

test('closeQuietly closes an fd, and swallows undefined and an fd already closed', async () => {
  const path = join(dir, 'close.png');
  await writeFile(path, 'x');
  const fd = openSync(path, 'r');
  closeQuietly(fd);
  assert.throws(() => fstatSync(fd), { code: 'EBADF' }, 'the fd was closed');
  assert.doesNotThrow(() => closeQuietly(fd), 'a second close');
  assert.doesNotThrow(() => closeQuietly(undefined), 'no fd at all');
});
