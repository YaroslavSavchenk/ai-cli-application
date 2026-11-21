/**
 * Manual restart in INSTALLED MODE (2026-09-08) — the restart hands the port
 * to <app>/current. A packaged install has no git, no lockfile and no vite:
 * preflight step 2 stops being "build the frontend" and becomes "verify the
 * bundle we are about to start" (server/bundle.ts), and the standby is spawned
 * from THAT bundle — its own node binary, entry module and node_modules —
 * instead of from this process's execPath.
 *
 * Since Nocturne D9 P4 the real installed restart is also the update's: the
 * running session survives it, adopted by the new version from the pty-host
 * the old one started, and history stamps nothing.
 *
 * How: stubbed controllers for the preflight, and REAL restarts of real server
 * children on a real unpacked-bundle layout in a temp dir
 * (`tests/helpers/restart-installed-fixture.ts`: version dirs with copies of
 * server/ and shared/, a symlinked node_modules, a COPY of the repo's built
 * web/dist — never a rebuild — a bundle.json marker and a node binary link).
 *
 * SAFETY: every process here is one this file started; adopted children are
 * SIGTERMed by the pid in their own runtime.json.
 *
 * NOT claimed here: a real downloaded release or the installer —
 * `tests/release/`; Windows.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  HistoryEntry,
  RestartResponse,
  RuntimeStatusResponse,
  SessionInfo,
} from '../../shared/protocol.ts';
import {
  createStandbyStarter,
  RestartController,
  REFUSED_STANDBY,
  type RestartDeps,
} from '../../server/restart.ts';
import { readWebBuild } from '../../server/buildinfo.ts';
import { resolveInstalledTarget } from '../../server/bundle.ts';
import {
  api,
  createSession,
  readServerLog,
  startTestServer,
  waitForLog,
  waitUntil,
  makeTempDirSync,
} from '../helpers/helpers.ts';
import {
  repoWebDist,
  FAKE_BUILD,
  OLD_PID,
  OLD_PORT,
  fakeChild,
  readRuntime,
  isAlive,
} from '../helpers/restart-fixture.ts';
import { FIXTURE_NODE_VERSION, installedApp } from '../helpers/restart-installed-fixture.ts';
import { readHistory } from '../helpers/pty-host-backend-fixture.ts';

// ---------------------------------------------------------------------------
// 4. INSTALLED MODE (2026-09-08) — the restart hands the port to <app>/current
// ---------------------------------------------------------------------------
//
// A packaged install has no git, no lockfile and no vite: preflight step 2 stops
// being "build the frontend" and becomes "verify the bundle we are about to
// start" (server/bundle.ts), and the standby is spawned from THAT bundle — its
// own node binary, its own entry module, its own node_modules — instead of from
// this process's execPath.
//
// The fixture is a real unpacked-bundle layout in a temp dir:
// tests/helpers/restart-installed-fixture.ts.

test('installed mode, stubbed: the preflight VERIFIES the target bundle instead of building, and the standby is spawned from it', async () => {
  // The wiring server/index.ts installs when bundle.json is present, driven
  // through the real controller with a fake child: no vite, no swap, no real
  // process — only the decisions and the spawn arguments.
  const app = installedApp([{ name: 'v1' }, { name: 'v2' }]);
  const appDir = app.dir('v1');
  app.point('v2');
  const events: string[] = [];
  const logLines: string[] = [];
  const spawns: { cmd: string; args: string[]; opts: Record<string, unknown> }[] = [];
  const exits: number[] = [];
  const child = fakeChild();
  let clock = 2_000_000;
  let installedTarget: { execPath: string; entry: string; cwd: string } | undefined;
  try {
    const log = (level: string, message: string): void => void logLines.push(`[${level}] ${message}`);
    const deps: RestartDeps = {
      log: log as RestartDeps['log'],
      counts: () => ({ sessions: 0, presence: 1, attached: 0 }),
      sessionFacts: () => ({ running: 0, inProcess: 0 }),
      port: () => OLD_PORT,
      pid: OLD_PID,
      teardown: () => void events.push('teardown'),
      // Installed: nothing to compare against a lockfile that does not exist.
      dependenciesReady: () => {
        events.push('deps');
        return true;
      },
      buildFrontend: () => {
        events.push('verify-target');
        const target = resolveInstalledTarget(appDir);
        installedTarget = target;
        const built = readWebBuild(join(target.dir, 'web', 'dist'));
        return Promise.resolve({ buildId: built.buildId, asset: built.asset, ms: 0 });
      },
      swapFrontend: () => {
        events.push('swap');
        return { hadPrevious: false };
      },
      revertFrontend: () => void events.push('revert'),
      commitFrontend: () => void events.push('commit'),
      discardFrontend: () => {
        events.push('discard');
        installedTarget = undefined;
      },
      startStandby: createStandbyStarter({
        log: log as RestartDeps['log'],
        resolveTarget: () => installedTarget as { execPath: string; entry: string; cwd: string },
        spawnFn: (cmd, args, opts) => {
          spawns.push({ cmd, args, opts: opts as unknown as Record<string, unknown> });
          setImmediate(() => child.emit('message', { type: 'standby-ready' }));
          return child;
        },
      }),
      readRuntime: () => ({
        port: OLD_PORT,
        token: 'unused',
        pid: OLD_PID + 1,
        startedAt: '2026-09-08T12:00:00.000Z',
      }),
      probeHealth: () => Promise.resolve(true),
      exit: (code) => void exits.push(code),
      now: () => clock,
      sleep: (ms) => {
        clock += ms;
        return Promise.resolve();
      },
    };

    const outcome = await new RestartController(deps).request();
    assert.equal(outcome.status, 202, `installed preflight must pass: ${JSON.stringify(outcome.body)}`);
    assert.deepEqual(
      events,
      ['deps', 'verify-target', 'swap', 'teardown', 'commit'],
      'the target is verified where the build used to run, and NOTHING is staged or renamed',
    );

    const spawn0 = spawns[0];
    assert.ok(spawn0 !== undefined, 'exactly one standby spawn');
    assert.equal(spawns.length, 1);
    assert.equal(
      spawn0.cmd,
      join(app.dir('v2'), 'node', 'bin', 'node'),
      "the TARGET bundle's own node binary, never this process's execPath",
    );
    assert.deepEqual(spawn0.args, [join(app.dir('v2'), 'server', 'index.ts')]);
    assert.equal(spawn0.opts['cwd'], app.dir('v2'), "and the target's own directory, so its node_modules resolve");
    assert.equal(spawn0.opts['detached'], true);
    assert.deepEqual(spawn0.opts['stdio'], ['ignore', 'ignore', 'ignore', 'ipc']);
    const env = spawn0.opts['env'] as Record<string, string>;
    assert.equal(env['AI_SM_STANDBY'], '1');
    assert.equal(env['AI_SM_PORT_HINT'], String(OLD_PORT));
    assert.equal(env['AI_SM_RESTARTED_FROM'], String(OLD_PID));
    assert.deepEqual(child.sent, [{ type: 'go' }]);
    assert.ok(
      logLines.some((l) => l.includes('spawning the standby backend') && l.includes(app.dir('v2'))),
      `the log names the target dir: ${logLines.join(' | ')}`,
    );
  } finally {
    app.remove();
  }
});

test('installed mode, stubbed: a broken target refuses with 422 before anything is spawned', async () => {
  const app = installedApp([{ name: 'v1' }, { name: 'v2', broken: true }]);
  app.point('v2');
  const events: string[] = [];
  const spawns: unknown[] = [];
  try {
    const deps: RestartDeps = {
      log: () => {},
      counts: () => ({ sessions: 1, presence: 1, attached: 1 }),
      sessionFacts: () => ({ running: 0, inProcess: 0 }),
      port: () => OLD_PORT,
      pid: OLD_PID,
      teardown: () => void events.push('teardown'),
      dependenciesReady: () => true,
      buildFrontend: () => {
        // The refusal comes out of resolveInstalledTarget itself.
        try {
          return Promise.resolve({ ...FAKE_BUILD, ...resolveInstalledTarget(app.dir('v1')) });
        } catch (err) {
          return Promise.reject(err);
        }
      },
      swapFrontend: () => {
        events.push('swap');
        return { hadPrevious: false };
      },
      revertFrontend: () => void events.push('revert'),
      commitFrontend: () => void events.push('commit'),
      discardFrontend: () => void events.push('discard'),
      startStandby: () => {
        spawns.push('spawned');
        return Promise.reject(new Error('must never be reached'));
      },
      readRuntime: () => undefined,
      probeHealth: () => Promise.resolve(false),
      exit: () => {},
    };
    const outcome = await new RestartController(deps).request();
    assert.equal(outcome.status, 422);
    assert.deepEqual(outcome.body, { error: REFUSED_STANDBY }, 'the existing refusal copy, no new UI sentence');
    assert.equal(outcome.onFlushed, null, 'a refusal never exits the process');
    assert.deepEqual(events, [], 'nothing was swapped and nothing was torn down');
    assert.deepEqual(spawns, [], 'and nothing was spawned');
  } finally {
    app.remove();
  }
});

test('REAL installed restart: the port is handed to <app>/current, and the new process names the new version', async () => {
  const app = installedApp([{ name: 'v1' }, { name: 'v2' }]);
  const repoDistBefore = repoWebDist();
  // Started through `current`, exactly like launcher/start-backend.sh does.
  // Node resolves the symlink, so the process's app dir is the version dir.
  const server = await startTestServer({ entry: app.entry, cwd: join(app.root, 'current') });
  const oldPid = server.child.pid as number;
  let childPid: number | undefined;
  try {
    // Boot banner: the bundle marker, not a git commit (there is no .git here).
    const banner = await waitForLog(server, '[boot] installed build');
    assert.match(
      banner,
      new RegExp(
        `\\[boot\\] installed build v1 \\(commit 8c308cc, node ${FIXTURE_NODE_VERSION.replace(/\./g, '\\.')}, ` +
          `built 2026-09-08T10:00:00\\.000Z, app dir ${app.dir('v1').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`,
      ),
      `the banner names the bundle: ${banner.split('\n').filter((l) => l.includes('[boot]')).join(' | ')}`,
    );
    assert.ok(!banner.includes('[boot] server code '), 'and NOT the developer commit line');

    // runtime.json carries the version dir, so an installer can see which one
    // a live pid is running out of.
    assert.equal(server.runtime.appDir, app.dir('v1'));

    const session = await createSession(server, {
      cwd: '/tmp',
      command: 'bash',
      args: ['-i'],
      title: 'installed-victim',
      cols: 80,
      rows: 24,
    });

    // The installer unpacks v2 and flips the link. Done BEFORE the first
    // /api/runtime call: the checker caches for 5 s, and this test must not
    // sleep through that window.
    app.point('v2');
    const before = await api(server, 'GET', '/api/runtime');
    const beforeBody = before.body as RuntimeStatusResponse;
    assert.equal(beforeBody.installed, true, JSON.stringify(beforeBody));
    assert.equal(beforeBody.version, 'v1', JSON.stringify(beforeBody));
    assert.equal(beforeBody.serverCommit, null, 'a bundle has no .git to read a commit from');
    assert.deepEqual(
      beforeBody.update,
      { available: true, reason: 'a new version is installed' },
      'the ONE installed-mode signal',
    );

    const res = await api(server, 'POST', '/api/restart');
    assert.equal(res.status, 202, `the handoff must be accepted: ${JSON.stringify(res.body)}`);
    const body = res.body as RestartResponse;
    assert.equal(body.samePort, true, 'the host window is locked to the port; installed mode changes nothing there');
    assert.equal(body.port, server.port);

    const child = await waitUntil(
      () => {
        const rt = readRuntime(server.runtimeFile);
        return rt !== undefined && rt.pid !== oldPid ? rt : undefined;
      },
      "runtime.json to name the child's pid",
    );
    childPid = child.pid;
    assert.equal(child.port, server.port);
    assert.equal(child.appDir, app.dir('v2'), 'the new process runs from the NEW version directory');

    const exit = await Promise.race([server.exit, delay(15_000).then(() => undefined)]);
    assert.ok(exit !== undefined && exit.code === 0, `the old process exits 0 (${JSON.stringify(exit)})`);

    // The replacement is the v2 bundle, serving v2's own web/dist, with nothing
    // left to update to.
    const runtimeRes = await fetch(`http://127.0.0.1:${child.port}/api/runtime`, {
      headers: { 'x-auth-token': child.token },
    });
    assert.equal(runtimeRes.status, 200);
    const runtime = (await runtimeRes.json()) as RuntimeStatusResponse;
    assert.equal(runtime.version, 'v2', `the child must run the v2 bundle: ${JSON.stringify(runtime)}`);
    assert.equal(runtime.installed, true, JSON.stringify(runtime));
    assert.equal(runtime.webBuild, readWebBuild(join(app.dir('v2'), 'web', 'dist')).asset);
    assert.deepEqual(
      runtime.update,
      { available: false, reason: null },
      `a just-restarted installed backend has nothing to update to: ${JSON.stringify(runtime.update)}`,
    );

    // D9 P4: the session survived the update — the v2 backend adopted it from
    // the pty-host v1 started (same protocol), and history stamped nothing.
    const listed = await fetch(`http://127.0.0.1:${child.port}/api/sessions`, {
      headers: { 'x-auth-token': child.token },
    });
    const kept = ((await listed.json()) as SessionInfo[]).find((s) => s.id === session.id);
    assert.equal(kept?.status, 'running', 'the session runs on under the new version');
    assert.equal(kept?.title, 'installed-victim');
    const entry = readHistory(server.dataDir).find((e: HistoryEntry) => e.sessionId === session.id);
    assert.ok(entry !== undefined, 'the session has its history entry');
    assert.equal(entry.ended, null, 'and it is still live: an update is not a shutdown');

    // The log tells the installed story: a verified target, NO vite run, and a
    // second banner naming v2.
    const log = await readServerLog(server);
    assert.match(log, /\[restart\] preflight: dependencies ok/);
    assert.match(
      log,
      new RegExp(
        `\\[restart\\] preflight: target bundle v2 in ${app.dir('v2').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} verified`,
      ),
    );
    // The controller's generic step line is still written (the STEP is the same
    // one), but it must not claim a staging that never happened: nothing is
    // staged in installed mode, the bundle ships its own dist.
    assert.match(
      log,
      /\[restart\] preflight: frontend build ok \(.*; bundled dist, verified in place\)/,
    );
    assert.ok(
      !log.includes('staged, not served yet'),
      'an installed preflight stages nothing and must not say it did',
    );
    // No vite anywhere: neither the spawn line nor its output tail.
    assert.ok(
      !log.includes('building the frontend into') && !log.includes('vite output'),
      `an installed backend never runs vite: ${log
        .split('\n')
        .filter((l) => l.includes('vite') || l.includes('building the frontend'))
        .join(' | ')}`,
    );
    assert.match(log, /\[restart\] preflight: standby backend ready \(pid \d+\), booted and holding/);
    assert.match(
      log,
      new RegExp(`\\[boot\\] installed build v2 \\(commit 8c308cc, node ${FIXTURE_NODE_VERSION.replace(/\./g, '\\.')}`),
      'the child banner names the version it runs',
    );
    assert.match(log, /\[restart\] handoff complete: pid \d+ on 127\.0\.0\.1:\d+ \(samePort=true/);
    assert.ok(!log.includes(server.token) && !log.includes(child.token), 'no token in the log');

    // Nothing was staged, renamed or rebuilt — not in the fixture, not in the repo.
    for (const name of ['v1', 'v2']) {
      assert.ok(!existsSync(join(app.dir(name), 'web', 'dist-next')), `${name}: no staging dir`);
      assert.ok(!existsSync(join(app.dir(name), 'web', 'dist-prev')), `${name}: no backup dir`);
    }
    assert.deepEqual(repoWebDist(), repoDistBefore, "the repo's own web/dist is untouched");
  } finally {
    const adopted = childPid;
    if (adopted !== undefined && isAlive(adopted)) {
      process.kill(adopted, 'SIGTERM');
      await waitUntil(() => (isAlive(adopted) ? undefined : true), 'the child to exit', 10_000).catch(() =>
        process.kill(adopted, 'SIGKILL'),
      );
    }
    await server.stop();
    app.remove();
  }
});

test('REAL installed restart: a broken `current` answers 422 and the running backend is untouched', async () => {
  const app = installedApp([{ name: 'v1' }, { name: 'v2', broken: true }]);
  const server = await startTestServer({ entry: app.entry, cwd: join(app.root, 'current') });
  const oldPid = server.child.pid as number;
  try {
    const session = await createSession(server, {
      cwd: '/tmp',
      command: 'bash',
      args: ['-i'],
      title: 'survivor',
      cols: 80,
      rows: 24,
    });
    app.point('v2'); // A version dir with no node/bin/node — an interrupted unpack.

    const res = await api(server, 'POST', '/api/restart');
    assert.equal(res.status, 422, `a broken target must refuse: ${JSON.stringify(res.body)}`);
    assert.deepEqual(res.body, { error: REFUSED_STANDBY });

    // NOTHING changed: same pid, same port, same session, still serving.
    assert.equal(isAlive(oldPid), true, 'the old process is still running');
    const rt = readRuntime(server.runtimeFile);
    assert.equal(rt?.pid, oldPid, 'runtime.json still names it');
    assert.equal(rt?.appDir, app.dir('v1'));
    const sessions = await api(server, 'GET', '/api/sessions');
    assert.equal(sessions.status, 200);
    assert.ok(
      (sessions.body as { id: string }[]).some((s) => s.id === session.id),
      'the session survived the refusal',
    );

    const log = await readServerLog(server);
    assert.match(log, /node\/bin\/node is missing or not executable/, 'the log says WHICH piece was missing');
    assert.match(
      log,
      /nothing was torn down: this backend keeps serving and its sessions are untouched/,
    );
  } finally {
    await server.stop();
    app.remove();
  }
});

test('REAL installed restart IN PLACE: `current` still names this version — 202, same port, a NEW pid on the SAME bundle', async () => {
  // The plain "restart the backend" click, installed: no update has been
  // unpacked, `current` points at the version already running. It must still be
  // a real handoff — a fresh process on the same port out of the same bundle —
  // and not a refusal, because the button is also the way out of a wedged
  // process. (server/bundle.ts says so in words; this is the wire proof.)
  const app = installedApp([{ name: 'v1' }]);
  const server = await startTestServer({ entry: app.entry, cwd: join(app.root, 'current') });
  const oldPid = server.child.pid as number;
  let childPid: number | undefined;
  try {
    const before = await api(server, 'GET', '/api/runtime');
    assert.deepEqual(
      (before.body as RuntimeStatusResponse).update,
      { available: false, reason: null },
      'nothing to update to: `current` is where we already are',
    );

    const res = await api(server, 'POST', '/api/restart');
    assert.equal(res.status, 202, `an in-place restart must be accepted: ${JSON.stringify(res.body)}`);
    const body = res.body as RestartResponse;
    assert.equal(body.samePort, true);
    assert.equal(body.port, server.port);

    const child = await waitUntil(
      () => {
        const rt = readRuntime(server.runtimeFile);
        return rt !== undefined && rt.pid !== oldPid ? rt : undefined;
      },
      "runtime.json to name the child's pid",
    );
    childPid = child.pid;
    assert.notEqual(child.pid, oldPid, 'a NEW process, not the old one kept alive');
    assert.equal(child.appDir, app.dir('v1'), 'running out of the same bundle');
    assert.equal(child.startedAt, body.startedAt);

    const exit = await Promise.race([server.exit, delay(15_000).then(() => undefined)]);
    assert.ok(exit !== undefined && exit.code === 0, `the old process exits 0 (${JSON.stringify(exit)})`);
    assert.equal(isAlive(oldPid), false);

    const runtimeRes = await fetch(`http://127.0.0.1:${child.port}/api/runtime`, {
      headers: { 'x-auth-token': child.token },
    });
    const runtime = (await runtimeRes.json()) as RuntimeStatusResponse;
    assert.equal(runtime.version, 'v1', `the child must run the v1 bundle: ${JSON.stringify(runtime)}`);
    assert.equal(runtime.installed, true, JSON.stringify(runtime));
    assert.deepEqual(runtime.update, { available: false, reason: null });

    const log = await readServerLog(server);
    assert.match(
      log,
      new RegExp(`\\[restart\\] preflight: target bundle v1 in ${app.dir('v1').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} verified`),
    );
  } finally {
    const adopted = childPid;
    if (adopted !== undefined && isAlive(adopted)) {
      process.kill(adopted, 'SIGTERM');
      await waitUntil(() => (isAlive(adopted) ? undefined : true), 'the child to exit', 10_000).catch(() =>
        process.kill(adopted, 'SIGKILL'),
      );
    }
    await server.stop();
    app.remove();
  }
});

test('installed mode + AI_SM_WEB_DIST_DIR: the SEAM is what gets served, the BUNDLE is what gets verified', async () => {
  // DOCUMENTED BEHAVIOUR, not a recommendation. `AI_SM_WEB_DIST_DIR` is the
  // test seam that moves the SERVED frontend; in installed mode the restart
  // preflight no longer builds anything and verifies `<app>/current/web/dist`
  // instead — a different directory. So with the seam set, the two can disagree,
  // and this pins which is which:
  //   - the running server serves the seam directory (its asset is what
  //     GET /api/runtime reports);
  //   - the restart still refuses when the TARGET BUNDLE's own web/dist is
  //     incomplete, even though the served one is a perfectly good build.
  // Nothing in a real install sets this variable; a test that quietly assumed
  // the seam also moved the verification would be wrong about both.
  const app = installedApp([{ name: 'v1' }, { name: 'v2' }]);
  const served = makeTempDirSync('ai-sm-seamdist-');
  try {
    mkdirSync(join(served, 'assets'), { recursive: true });
    writeFileSync(join(served, 'index.html'), '<!doctype html><title>seam</title>');
    writeFileSync(join(served, 'assets', 'index-SeamOnly.js'), 'console.log("seam")\n');
    writeFileSync(join(served, 'build-id.json'), JSON.stringify({ id: '20260908-0000-seamdist' }));
    // The target bundle's frontend is INCOMPLETE — the case a half-finished
    // unpack leaves behind.
    rmSync(join(app.dir('v2'), 'web', 'dist', 'index.html'));

    const server = await startTestServer({
      entry: app.entry,
      cwd: join(app.root, 'current'),
      env: { AI_SM_WEB_DIST_DIR: served },
    });
    try {
      const before = (await api(server, 'GET', '/api/runtime')).body as RuntimeStatusResponse;
      assert.equal(before.installed, true);
      assert.equal(before.version, 'v1');
      assert.equal(
        before.webBuild,
        'assets/index-SeamOnly.js',
        'the SEAM directory is the served frontend, not the bundle\'s own web/dist',
      );
      const page = await fetch(`${server.baseUrl}/`);
      assert.equal(page.status, 200);
      assert.match(await page.text(), /<title>seam<\/title>/, 'and it is the seam that reaches the browser');

      app.point('v2');
      const res = await api(server, 'POST', '/api/restart');
      assert.equal(res.status, 422, `the target bundle has no frontend: ${JSON.stringify(res.body)}`);
      assert.deepEqual(res.body, { error: REFUSED_STANDBY });
      assert.equal(isAlive(server.child.pid as number), true, 'and the running backend is untouched');

      const log = await readServerLog(server);
      assert.match(
        log,
        /is not a frontend build \(index\.html missing, entry bundle assets\/index-/,
        'the refusal names the BUNDLE\'s web/dist, not the served one',
      );
      assert.ok(
        !log.includes(`${served} is not a frontend build`),
        'the seam directory is never the thing being verified',
      );
    } finally {
      await server.stop();
    }
  } finally {
    rmSync(served, { recursive: true, force: true });
    app.remove();
  }
});

test('a bundle tree whose bundle.json is CORRUPT boots as a developer clone — the marker is the only switch', async () => {
  // The failure mode of an interrupted or tampered install: every file of a
  // bundle is there, but the marker does not pass the charset gate. Installed
  // mode is then simply OFF — banner, /api/runtime and the restart wiring all
  // fall back to the developer path. Pinned because the alternative (a partly
  // installed mode driven by a half-read marker) is exactly what
  // readBundleInfo's all-or-nothing contract exists to prevent, and because the
  // symptom a user would report is "it says it is not installed".
  const app = installedApp([{ name: 'v1' }]);
  try {
    writeFileSync(join(app.dir('v1'), 'bundle.json'), '{"version":"v1 with spaces","platform":"linux-x64"}');
    const server = await startTestServer({ entry: app.entry, cwd: join(app.root, 'current') });
    try {
      const body = (await api(server, 'GET', '/api/runtime')).body as RuntimeStatusResponse;
      assert.equal(body.installed, false, 'no valid marker, no installed mode');
      assert.equal(body.version, null);
      const log = await readServerLog(server);
      assert.ok(!log.includes('[boot] installed build'), 'and the banner does not claim a bundle');
      // runtime.json still names the directory it runs from — that field is not
      // part of installed mode.
      assert.equal(readRuntime(server.runtimeFile)?.appDir, app.dir('v1'));
    } finally {
      await server.stop();
    }
  } finally {
    app.remove();
  }
});

test('REAL installed restart: a target whose node_modules are missing is caught by the STANDBY, not by the file checks', async () => {
  // resolveInstalledTarget deliberately verifies only marker + entry + runtime +
  // frontend; it does not walk node_modules. The claim that this is safe rests
  // entirely on the standby: the replacement is booted for real, and a bundle
  // that cannot import `ws`/`node-pty` dies there — while the old backend is
  // still whole. This is the test of that claim, and it is the only thing
  // standing between "a truncated unpack" and "the sessions are gone and
  // nothing listens".
  const app = installedApp([{ name: 'v1' }, { name: 'v2', noModules: true }]);
  const server = await startTestServer({ entry: app.entry, cwd: join(app.root, 'current') });
  const oldPid = server.child.pid as number;
  try {
    const session = await createSession(server, {
      cwd: '/tmp',
      command: 'bash',
      args: ['-i'],
      title: 'survivor-2',
      cols: 80,
      rows: 24,
    });
    app.point('v2');

    const res = await api(server, 'POST', '/api/restart');
    assert.equal(res.status, 422, `an unimportable bundle must refuse: ${JSON.stringify(res.body)}`);
    assert.deepEqual(res.body, { error: REFUSED_STANDBY });

    assert.equal(isAlive(oldPid), true, 'the old process is still running');
    assert.equal(readRuntime(server.runtimeFile)?.pid, oldPid);
    const sessions = await api(server, 'GET', '/api/sessions');
    assert.ok(
      (sessions.body as { id: string }[]).some((s) => s.id === session.id),
      'the session survived',
    );
    const health = await fetch(`${server.baseUrl}/health`);
    assert.equal(health.status, 200, 'and it is still serving');

    const log = await readServerLog(server);
    // The FILE checks passed — the marker, entry, node and web/dist are all
    // there — so the refusal must come from the standby step.
    assert.match(log, /\[restart\] preflight: target bundle v2 in .* verified/);
    assert.match(
      log,
      /\[restart\] The new backend did not start\. \(Error: the standby backend exited early \(code=1 signal=null\)/,
      'the refusal comes from the standby step, and the log says exactly that',
    );
    assert.match(
      log,
      /nothing was torn down: this backend keeps serving and its sessions are untouched/,
    );
  } finally {
    await server.stop();
    app.remove();
  }
});
