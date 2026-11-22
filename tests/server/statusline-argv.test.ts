/**
 * The CROSS-VERSION CONTRACT of `server/statusline.mjs` (Nocturne D9 P5,
 * `.claude/plans/nocturne/PLAN-D9.md`; the rule itself is in the script's
 * header): a session spawned by version N keeps running the status-line
 * command its `--settings` file named — after a restart or an update hands it
 * to a newer backend, and, in installed mode, against the statusline.mjs of
 * whatever version `<app>/current` names later (server/bundle.ts
 * `statuslinePaths`). So the argv only ever grows at the end.
 *
 * Pinned here:
 *   - the ORDER the server composes (`SessionSettingsStore.command`):
 *     `<node> <statusline.mjs> <mode> <prefs.json> <snapshot>`, run exactly as
 *     Claude Code runs it (through a shell): the mode reaches the line, the
 *     prefs are read, the snapshot is written — a swapped word breaks one of
 *     the three;
 *   - every OLDER form the script still accepts: `<mode> <prefs.json>` (a
 *     session spawned before B1 added the snapshot) draws the same line.
 *
 * NOT claimed: the line's items (tests/server/statusline-script.test.ts) or
 * the snapshot's content rules (statusline-script-snapshot.test.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SessionSettingsStore } from '../../server/session-settings.ts';
import { SCRIPT, fixture, makeWorkspace, runRaw } from '../helpers/statusline-script-fixture.ts';

const ID = '7c1e9a52-0f4b-4c1e-9d6a-2b8f3e4d5a61';
const LINE = 'Opus 5 | auto-edits';

/** prefs.json with the line on and exactly the model + mode items. */
async function prefsWithModelAndMode(file: string): Promise<void> {
  await writeFile(
    file,
    JSON.stringify({
      statusLine: { enabled: true, model: true, mode: true, branch: false, cost: false, lines: false, context: false, usage: false },
    }),
  );
}

test('the command the server composes runs as <node> <script> <mode> <prefs.json> <snapshot>', async () => {
  const ws = await makeWorkspace();
  try {
    await prefsWithModelAndMode(ws.prefs);
    const store = new SessionSettingsStore(
      {
        dir: join(ws.root, 'session-settings'),
        snapshotDir: ws.root,
        scriptPath: SCRIPT,
        prefsFile: ws.prefs,
        nodePath: process.execPath,
      },
      () => {},
    );
    const command = store.command('acceptEdits', ID);
    const snapshot = join(ws.root, `${ID}.json`);
    // The words themselves, in order (the shell splits the quoted string).
    const words = spawnSync('sh', ['-c', `set -- ${command}; printf '%s\\n' "$@"`], { encoding: 'utf8' }).stdout.split('\n');
    assert.deepEqual(words.slice(0, 5), [process.execPath, SCRIPT, 'acceptEdits', ws.prefs, snapshot]);
    // And run as Claude Code runs it.
    const res = spawnSync('sh', ['-c', command], { input: JSON.stringify(fixture(ws.plain, 'sess-argv')), encoding: 'utf8', timeout: 30_000 });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout.trim(), LINE);
    assert.ok(existsSync(snapshot), 'the snapshot (4th argument) was not written');
    assert.equal((JSON.parse(readFileSync(snapshot, 'utf8')) as { model?: string }).model, 'Opus 5');
  } finally {
    await rm(ws.root, { recursive: true, force: true });
  }
});

test('the older form <mode> <prefs.json> (before the snapshot argument) still draws the same line', async () => {
  const ws = await makeWorkspace();
  try {
    await prefsWithModelAndMode(ws.prefs);
    const res = await runRaw(['acceptEdits', ws.prefs], fixture(ws.plain, 'sess-argv-old'));
    assert.equal(res.code, 0, res.err);
    assert.equal(res.out, LINE);
  } finally {
    await rm(ws.root, { recursive: true, force: true });
  }
});
