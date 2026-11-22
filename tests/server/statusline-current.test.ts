/**
 * Installed mode names the status line through `<app>/current` (Nocturne D9
 * P5, `.claude/plans/nocturne/PLAN-D9.md` § Defaults; server/bundle.ts
 * `statuslinePaths`).
 *
 * Why: since D9 a claude session outlives the backend that spawned it — a
 * Restart or an update hands it to the next backend through the pty-host — and
 * its Claude keeps running the `statusLine.command` its `--settings` file named
 * at spawn. A later Setup prunes the version dir that backend ran from, so a
 * command naming `<app>/<version>/…` would draw a blank bar for good.
 *
 * Two layers:
 *   - `statuslinePaths` on temp `<app>` layouts: the developer clone keeps its
 *     own node + `<serverDir>/statusline.mjs`; installed mode names both through
 *     the `current` LINK path (never its target), including while `current`
 *     already points at a newer version; a `current` that is not the
 *     installer's link falls back to the version dir with one warning.
 *   - a REAL installed backend (tests/helpers/restart-installed-fixture.ts)
 *     spawning a stub `claude`: the settings file it writes names `current`,
 *     and that exact command string runs — before and after `current` moves to
 *     a version the session was not spawned from.
 *
 * The developer-clone command is pinned byte for byte in
 * tests/server/session-settings.test.ts and is unchanged.
 *
 * NOT claimed: that Claude Code re-reads a rewritten `--settings` file (the
 * spec's open risk; with `current` paths the boot rewrite of an adopted
 * session's file changes nothing in the common case), or a real Setup prune.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { statuslinePaths } from '../../server/bundle.ts';
import { createSession, makeTempDirSync, projectRoot, startTestServer, type TestServer } from '../helpers/helpers.ts';
import { installedApp } from '../helpers/restart-installed-fixture.ts';
import { makeStubClaude } from '../helpers/stub-claude-fixture.ts';

const roots: string[] = [];
after(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/** `<app>` with version dirs carrying a valid marker, and `current` -> `point`. */
function appLayout(versions: string[], point: string | null): string {
  const app = realpathSync(makeTempDirSync('ai-sm-slcur-'));
  roots.push(app);
  for (const v of versions) {
    mkdirSync(join(app, v, 'server'), { recursive: true });
    writeFileSync(
      join(app, v, 'bundle.json'),
      JSON.stringify({ version: v, commit: null, nodeVersion: 'v24.8.0', builtAt: '2026-11-21T08:00:00.000Z', platform: 'linux-x64' }),
    );
  }
  if (point !== null) symlinkSync(join(app, point), join(app, 'current'));
  return app;
}

/** `statuslinePaths` with its warnings collected. */
function paths(serverDir: string, installed: boolean): { nodePath: string; scriptPath: string; warnings: string[] } {
  const warnings: string[] = [];
  return { ...statuslinePaths(serverDir, installed, (line) => warnings.push(line)), warnings };
}

test('developer clone: this process’s own node and <serverDir>/statusline.mjs, no warning', () => {
  const serverDir = join(projectRoot, 'server');
  assert.deepEqual(paths(serverDir, false), {
    nodePath: process.execPath,
    scriptPath: join(serverDir, 'statusline.mjs'),
    warnings: [],
  });
});

test('installed: both paths go through the `current` LINK, also when it already names a newer version', () => {
  for (const point of ['v0.4.4', 'v0.4.5']) {
    const app = appLayout(['v0.4.4', 'v0.4.5'], point);
    assert.deepEqual(paths(join(app, 'v0.4.4', 'server'), true), {
      nodePath: join(app, 'current', 'node', 'bin', 'node'),
      scriptPath: join(app, 'current', 'server', 'statusline.mjs'),
      warnings: [],
    }, `current -> ${point}`);
  }
});

test('installed: a `current` that is not the installer’s link falls back to the version dir, with one warning', () => {
  const cases: [string, (app: string) => void][] = [
    ['absent', () => {}],
    ['a plain directory', (app) => mkdirSync(join(app, 'current'))],
    ['dangling', (app) => symlinkSync(join(app, 'v9.9.9'), join(app, 'current'))],
    ['a target without bundle.json', (app) => {
      mkdirSync(join(app, 'half'));
      symlinkSync(join(app, 'half'), join(app, 'current'));
    }],
    ['a target outside <app>', (app) => {
      const away = appLayout(['v0.4.4'], null);
      symlinkSync(join(away, 'v0.4.4'), join(app, 'current'));
    }],
  ];
  for (const [name, arrange] of cases) {
    const app = appLayout(['v0.4.4'], null);
    arrange(app);
    const serverDir = join(app, 'v0.4.4', 'server');
    const got = paths(serverDir, true);
    assert.equal(got.nodePath, process.execPath, name);
    assert.equal(got.scriptPath, join(serverDir, 'statusline.mjs'), name);
    assert.equal(got.warnings.length, 1, name);
    assert.match(got.warnings[0] as string, /not the installer's link/, name);
  }
});

test('a REAL installed backend writes a status-line command through `current`, and it runs wherever `current` points', async () => {
  const app = installedApp([{ name: 'v0.4.4' }, { name: 'v0.4.5' }]);
  const stub = await makeStubClaude();
  let server: TestServer | undefined;
  try {
    server = await startTestServer({ entry: app.entry, cwd: app.dir('v0.4.4') });
    const session = await createSession(server, {
      command: stub.bin,
      args: ['--permission-mode', 'acceptEdits'],
      cwd: projectRoot,
      cols: 80,
      rows: 24,
    });
    assert.equal(session.statusline, true);
    const file = join(server.dataDir, 'session-settings', `${session.id}.json`);
    const written = JSON.parse(readFileSync(file, 'utf8')) as { statusLine: { command: string } };
    const snapshot = join(server.dataDir, 'statusline-snapshots', `${session.id}.json`);
    assert.equal(
      written.statusLine.command,
      `${join(app.root, 'current', 'node', 'bin', 'node')} ${join(app.root, 'current', 'server', 'statusline.mjs')} ` +
        `acceptEdits ${join(server.dataDir, 'prefs.json')} ${snapshot}`,
    );
    assert.ok(!written.statusLine.command.includes(app.dir('v0.4.4')), 'the command names the version dir it was spawned from');

    // The exact string, run the way Claude Code runs it (through a shell, the
    // payload on stdin): it works now, and after an update moved `current`
    // to a version this session was never spawned from. The proof that the
    // script really ran is the snapshot it writes whether or not the line is
    // enabled (server/statusline.mjs, B1).
    for (const point of ['v0.4.4', 'v0.4.5']) {
      app.point(point);
      rmSync(snapshot, { force: true });
      const res = spawnSync('sh', ['-c', written.statusLine.command], {
        input: JSON.stringify({ session_id: session.id, model: { id: 'claude-opus-4', display_name: 'Opus' } }),
        encoding: 'utf8',
        timeout: 30_000,
      });
      assert.equal(res.status, 0, `current -> ${point}: ${res.stderr}`);
      assert.ok(existsSync(snapshot), `current -> ${point}: the script did not run (no snapshot)`);
    }
  } finally {
    app.point('v0.4.4');
    await server?.stop();
    rmSync(stub.dir, { recursive: true, force: true });
    app.remove();
  }
});
