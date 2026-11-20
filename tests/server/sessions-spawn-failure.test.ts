/**
 * A spawn that fails leaves nothing behind — `SessionManager.create`
 * (`server/sessions.ts`) after Nocturne D9 P1
 * (`.claude/plans/nocturne/PLAN-D9.md` § Phases) moved the spawn behind
 * `server/pty-host-api.ts`: the rejection reaches the caller, and the
 * session, its history entry and the status-line settings file written for
 * it before the spawn are all gone.
 *
 * How: SessionManager in-process with a real SessionSettingsStore on a temp
 * dir, launching a `claude` whose working directory node-pty refuses (a
 * number where a path belongs — the one input node-pty's Unix spawn throws on
 * synchronously; a missing binary or directory only fails inside the forked
 * child, as an exit). The cast is the test's only way to make the real
 * node-pty refuse; the HTTP route validates `cwd` before it gets here.
 *
 * Why it matters: the settings file is written BEFORE the spawn (its path is
 * in the argv), so a failed spawn that skipped the clean-up would leave one
 * file per failed launch in the data dir until the next boot's wipe — and a
 * session or history entry for a PTY that never existed.
 *
 * NOT claimed: the HTTP route's answer to a failed spawn (the route rejects a
 * non-string `cwd` itself, so this failure cannot be reached through it); a
 * pty-host process whose spawn fails over the wire (P2).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { SessionHistory } from '../../server/history.ts';
import { SessionManager } from '../../server/sessions.ts';
import { SessionSettingsStore } from '../../server/session-settings.ts';
import { makeTempDir, removeTempDir, projectRoot } from '../helpers/helpers.ts';

test('a claude launch node-pty refuses rejects, and leaves no session, no history entry and no settings file', async () => {
  const root = await makeTempDir('ai-sm-spawnfail-');
  try {
    const silent = (): void => {};
    const dir = join(root, 'session-settings');
    const store = new SessionSettingsStore(
      {
        dir,
        snapshotDir: join(root, 'statusline-snapshots'),
        scriptPath: join(projectRoot, 'server', 'statusline.mjs'),
        prefsFile: join(root, 'prefs.json'),
        nodePath: process.execPath,
      },
      silent,
    );
    store.resetDir();
    const history = new SessionHistory(join(root, 'history.json'), silent);
    const manager = new SessionManager(silent, history, store);

    await assert.rejects(
      manager.create({
        command: 'claude',
        args: [],
        cwd: 42 as unknown as string,
        title: 'refused',
        cols: 80,
        rows: 24,
      }),
      /cwd must be a string/,
      "node-pty's refusal reaches the caller",
    );
    assert.deepEqual(manager.list(), [], 'no session for a PTY that never existed');
    assert.deepEqual(history.list(), [], 'no history entry either');
    assert.deepEqual(await readdir(dir), [], 'the settings file written for the launch is removed');
  } finally {
    await removeTempDir(root);
  }
});
