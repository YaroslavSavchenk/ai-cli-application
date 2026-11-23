/**
 * The logger's open file — PLAN-QUALITY Q12 (`.claude/plans/PLAN-QUALITY.md`):
 * `createLogger` (server/config-log.ts) keeps server.log open between lines
 * instead of an open/write/close per line, so WHICH file it writes to is now
 * state: after a rotation it must write to the new live file, not the one
 * renamed to `.1`; a log removed or renamed from outside must come back at
 * its path; a write that fails must not leave it writing nowhere.
 *
 * How: the logger in-process on a temp file — a rotation is reached by writing
 * past MAX_LOG_BYTES through the same logger, the outside removal by `rmSync`.
 *
 * Why it matters: with an fd that outlives a rotation every later line lands
 * in `server.log.1` and then in `.2` — server.log, the only diagnostic channel
 * of a detached backend, looks silent while the old generations grow.
 *
 * NOT claimed: rotation's own shape, modes and its failure fallback
 * (`logging.test.ts`, `logging-hardening.test.ts`); that the fd is
 * close-on-exec (Node opens every file O_CLOEXEC; checked live, not here).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_LOG_BYTES, createLogger } from '../../server/config-log.ts';
import { makeTempDirSync, removeTempDir, waitUntil } from '../helpers/helpers.ts';

test('after a rotation the same logger writes to the new live file, never to the rotated one', async () => {
  const dir = makeTempDirSync('ai-sm-logfd-');
  try {
    const file = join(dir, 'server.log');
    const log = createLogger(file, 'debug');
    log('info', 'BEFORE-ROTATION');
    // Eleven 1 MiB lines cross the 10 MiB cap once: one rotation.
    const big = 'x'.repeat(1024 * 1024);
    for (let i = 0; i < 11; i++) log('debug', `BIG-${i} ${big}`);
    log('info', 'AFTER-ROTATION');
    log('info', 'AFTER-ROTATION-2');
    const live = readFileSync(file, 'utf8');
    const rotated = readFileSync(`${file}.1`, 'utf8');
    assert.ok(rotated.includes('BEFORE-ROTATION'), 'the first generation holds the old lines');
    assert.ok(!rotated.includes('AFTER-ROTATION'), 'nothing written after the rotation went to server.log.1');
    assert.ok(live.includes('AFTER-ROTATION\n') && live.includes('AFTER-ROTATION-2\n'), 'both later lines are in server.log');
    for (let i = 0; i < 11; i++) {
      const where = Number(live.includes(`BIG-${i} `)) + Number(rotated.includes(`BIG-${i} `));
      assert.equal(where, 1, `BIG-${i} is in exactly one generation (the line that rotated included)`);
    }
    assert.ok(statSync(file).size <= MAX_LOG_BYTES, 'the live file is under the cap');
    assert.equal(statSync(file).mode & 0o777, 0o600, 'the reopened live file is 0600');
  } finally {
    await removeTempDir(dir);
  }
});

test('a log removed from outside comes back at its path, 0600, and holds the lines written after it', async () => {
  const dir = makeTempDirSync('ai-sm-logfd-');
  try {
    const file = join(dir, 'server.log');
    const log = createLogger(file, 'debug');
    log('info', 'FIRST');
    rmSync(file);
    // The path is checked at most once a second, so a line written in that
    // window may land in the removed file; the file is back after it.
    let n = 0;
    await waitUntil(() => {
      log('info', `AFTER-REMOVAL-${n++}`);
      return existsSync(file) ? true : undefined;
    }, 'server.log to be recreated', 5000, 50);
    log('info', 'LANDED');
    assert.ok(readFileSync(file, 'utf8').endsWith(' [info] LANDED\n'), 'the next line is in the recreated file');
    assert.equal(statSync(file).mode & 0o777, 0o600);
  } finally {
    await removeTempDir(dir);
  }
});

test('a log renamed away from outside is not written to any longer once the path is checked', async () => {
  const dir = makeTempDirSync('ai-sm-logfd-');
  try {
    const file = join(dir, 'server.log');
    const log = createLogger(file, 'debug');
    log('info', 'FIRST');
    renameSync(file, `${file}.moved`);
    let n = 0;
    await waitUntil(() => {
      log('info', `AFTER-RENAME-${n++}`);
      return existsSync(file) ? true : undefined;
    }, 'server.log to be recreated', 5000, 50);
    const movedSize = statSync(`${file}.moved`).size;
    log('info', 'ONLY-IN-THE-NEW-FILE');
    assert.equal(statSync(`${file}.moved`).size, movedSize, 'the renamed file got no more lines');
    assert.ok(readFileSync(file, 'utf8').includes('ONLY-IN-THE-NEW-FILE'));
  } finally {
    await removeTempDir(dir);
  }
});
