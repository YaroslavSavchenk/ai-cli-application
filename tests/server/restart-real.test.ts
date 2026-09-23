/**
 * Manual restart — one REAL restart of a real backend on a scratch data dir:
 * the child keeps the port, the old pid is gone, runtime.json belongs to the
 * child (never unlinked by the parent — also when a SIGTERM races the
 * handoff), the killed session is stamped 'shutdown' in history, and the
 * presence socket is closed 1012. Plus the boot variables a restart relies
 * on: AI_SM_WEB_DIST_DIR (a bad value refuses to start and says so),
 * AI_SM_PORT_HINT (a busy or nonsense hint falls back once to an auto-picked
 * port) and AI_SM_RESTARTED_FROM.
 *
 * How: real server children (`startTestServer`) serving a private copy of the
 * built frontend (`webDistCopy` in `tests/helpers/restart-fixture.ts`), so the
 * working tree's own web/dist never moves.
 *
 * SAFETY: every process here is one this file started, on a temp data dir. The
 * real-restart tests adopt the CHILD they caused and SIGTERM it by the pid in
 * the child's own runtime.json.
 *
 * NOT claimed here: installed mode — `tests/server/restart-installed.test.ts`;
 * the UI's restart button.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  HistoryEntry,
  RestartResponse,
  RuntimeStatusResponse,
} from '../../shared/protocol.ts';
import { readWebBuild } from '../../server/buildinfo.ts';
import {
  api,
  createSession,
  presenceUrl,
  projectRoot,
  readServerLog,
  startTestServer,
  waitUntil,
  WsClient,
  makeTempDirSync,
} from '../helpers/helpers.ts';
import { webDistCopy, repoWebDist, readRuntime, isAlive } from '../helpers/restart-fixture.ts';

// ---------------------------------------------------------------------------
// 3. One REAL restart, end to end, on a scratch data dir
// ---------------------------------------------------------------------------

test('REAL restart: same port, new pid, old pid gone, runtime.json owned by the child, sessions stamped shutdown', async () => {
  // The restart rebuilds and swaps the frontend it SERVES; point it at a copy so
  // this test never touches the repo's own web/dist (asserted at the end).
  const web = webDistCopy();
  const repoDistBefore = repoWebDist();
  const server = await startTestServer({ env: { AI_SM_WEB_DIST_DIR: web.served } });
  const oldPid = server.child.pid as number;
  let childPid: number | undefined;
  try {
    // A real PTY session and a presence window, so the handoff has something to
    // end and someone to say goodbye to.
    const session = await createSession(server, {
      cwd: '/tmp',
      command: 'bash',
      args: ['-i'],
      title: 'restart-victim',
      cols: 80,
      rows: 24,
    });
    const presence = await WsClient.connect(presenceUrl(server));

    // runtime.json must be present at EVERY instant of the handoff, not merely
    // at the end: the parent tears down before it spawns, and an unlink there
    // would leave a window in which the launcher sees no backend and starts a
    // second one. The child recreates the file, so a check taken afterwards
    // cannot tell the difference — hence a monitor that samples throughout.
    // (A false PASS needs the sampler to miss a ~200 ms window; a false FAIL is
    // impossible: an absent file IS the violation.)
    let everAbsent = false;
    let samples = 0;
    let stopMonitor = false;
    const monitor = (async (): Promise<void> => {
      while (!stopMonitor) {
        samples += 1;
        if (!existsSync(server.runtimeFile)) {
          everAbsent = true;
          return;
        }
        await delay(1);
      }
    })();

    const res = await api(server, 'POST', '/api/restart');
    assert.equal(res.status, 202, `restart must be accepted: ${JSON.stringify(res.body)}`);
    const body = res.body as RestartResponse;
    assert.deepEqual(Object.keys(body).sort(), ['port', 'samePort', 'startedAt']);
    assert.equal(body.samePort, true, 'the hinted port must be taken back (the host window is locked to it)');
    assert.equal(body.port, server.port, 'and it is the SAME port the UI is talking to');
    assert.ok(!JSON.stringify(body).includes(server.token), 'no token in the handoff body');

    // The child owns runtime.json now — the restart path must NOT unlink it.
    const child = await waitUntil(
      () => {
        const rt = readRuntime(server.runtimeFile);
        return rt !== undefined && rt.pid !== oldPid ? rt : undefined;
      },
      "runtime.json to name the child's pid",
    );
    childPid = child.pid;
    assert.equal(child.port, server.port, "the child's own file agrees on the port");
    assert.equal(child.startedAt, body.startedAt, 'the 202 quoted the child, not itself');
    assert.notEqual(child.token, server.token, 'the child generated a FRESH token');
    stopMonitor = true;
    await monitor;
    assert.ok(samples > 50, `the monitor must actually have sampled the handoff (${samples} samples)`);
    assert.equal(everAbsent, false, 'runtime.json is never unlinked by a restart, not even for an instant');
    assert.ok(existsSync(server.runtimeFile), 'and it is there at the end too');

    // The old process is gone, exit code 0.
    const exit = await Promise.race([server.exit, delay(15_000).then(() => undefined)]);
    assert.ok(exit !== undefined, 'the old process must exit after handing over');
    assert.equal(exit.code, 0, `a handoff is a clean exit (code=${exit.code} signal=${exit.signal})`);
    assert.equal(isAlive(oldPid), false, 'the old pid is really gone');

    // The presence socket was told it is a restart, not an error.
    await waitUntil(() => (presence.closed ? true : undefined), 'the presence socket to close');
    assert.equal(presence.closeInfo?.code, 1012, 'presence closes 1012 "service restart"');
    assert.equal(presence.closeInfo?.reason, 'service restart');

    // The child serves on the same port, with its own token.
    const health = await fetch(`http://127.0.0.1:${child.port}/health`);
    assert.equal(health.status, 200);
    assert.equal(await health.text(), '{"ok":true}');
    const stale = await fetch(`http://127.0.0.1:${child.port}/api/history`, {
      headers: { 'x-auth-token': server.token },
    });
    assert.equal(stale.status, 401, 'the OLD token is worthless against the new process');

    // The killed session is in HISTORY, stamped 'shutdown' — resumable exactly
    // like after a normal shutdown. (No 'restart' end reason exists, by design.)
    const listed = await fetch(`http://127.0.0.1:${child.port}/api/history`, {
      headers: { 'x-auth-token': child.token },
    });
    assert.equal(listed.status, 200);
    const entries = (await listed.json()) as HistoryEntry[];
    const entry = entries.find((e) => e.title === 'restart-victim');
    assert.ok(entry !== undefined, `the session must be in history: ${JSON.stringify(entries)}`);
    assert.equal(entry.ended?.reason, 'shutdown', 'the same stamp a normal shutdown leaves');
    assert.ok(entry.id === session.id || entry.id.length > 0);

    // The child SERVES the freshly built screens and knows it does: it reads
    // web/dist at `go`, not at module load (the parent swapped it in while the
    // child was waiting). Without that, /api/runtime would name the OLD bundle
    // and the update check would light the pill on a backend restarted seconds
    // ago — the exact symptom the restart button exists to remove.
    const built = readWebBuild(web.served);
    const runtimeRes = await fetch(`http://127.0.0.1:${child.port}/api/runtime`, {
      headers: { 'x-auth-token': child.token },
    });
    assert.equal(runtimeRes.status, 200);
    const runtime = (await runtimeRes.json()) as RuntimeStatusResponse;
    assert.equal(runtime.webBuild, built.asset, 'the child names the bundle it actually serves');
    assert.notEqual(runtime.webBuild, null);
    assert.deepEqual(
      runtime.update,
      { available: false, reason: null },
      `a just-restarted backend has nothing to update to: ${JSON.stringify(runtime.update)}`,
    );

    // The log tells the whole story across both processes.
    const log = await readServerLog(server);
    assert.match(log, /\[restart\] restart requested by the ui: sessions=1 presence=1 attached=0/);
    // The preflight, in order, BEFORE the teardown line.
    assert.match(log, /\[restart\] preflight: dependencies, frontend build, standby backend/);
    assert.match(log, /\[restart\] preflight: dependencies ok/);
    assert.match(
      log,
      /\[restart\] preflight: frontend build ok \(build id [A-Za-z0-9._+-]+, asset assets\/index-[A-Za-z0-9_-]+\.js, \d+ms/,
      'the real vite build is logged by id and asset',
    );
    assert.match(log, /\[restart\] preflight: standby backend ready \(pid \d+\), booted and holding/);
    assert.match(log, /\[boot\] standby: ready, waiting for the handoff from pid \d+/);
    assert.ok(
      log.indexOf('preflight: standby backend ready') < log.indexOf('restart teardown: listener closed'),
      'the standby must be PROVEN before anything is torn down',
    );
    assert.match(log, /restart teardown: listener closed, 1 websocket\(s\) closed 1012/);
    assert.match(log, new RegExp(`\\[restart\\] go sent: new backend spawned \\(pid \\d+\\), port hint ${server.port}`));
    assert.match(log, /\[boot\] standby: handoff received from pid \d+, taking the port/);
    assert.match(log, new RegExp(`\\[boot\\] restarted from pid ${oldPid}`));
    assert.match(log, new RegExp(`\\[boot\\] port hint ${server.port} taken`));
    assert.match(log, /\[restart\] handoff complete: pid \d+ on 127\.0\.0\.1:\d+ \(samePort=true/);
    assert.ok(!log.includes(server.token), 'no token anywhere in the log');
    assert.ok(!log.includes(child.token), 'not the new one either');

    // The real build landed in the COPY, and only there.
    const rebuilt = readWebBuild(web.served);
    assert.ok(rebuilt.buildId !== null && rebuilt.asset !== null, 'the copy holds a complete build');
    assert.ok(!existsSync(join(web.dir, 'dist-next')), 'no staging dir survives a completed restart');
    assert.ok(!existsSync(join(web.dir, 'dist-prev')), 'and no backup either');
    assert.deepEqual(
      repoWebDist(),
      repoDistBefore,
      "the repo's own web/dist is byte-identical: a test run must never rebuild the tree it runs in",
    );
    assert.ok(
      !existsSync(join(projectRoot, 'web', 'dist-next')) &&
        !existsSync(join(projectRoot, 'web', 'dist-prev')),
      'and it leaves no staging dirs in the repo either',
    );
  } finally {
    // Kill the CHILD this test caused, then let the helper clean up the rest.
    const adopted = childPid;
    if (adopted !== undefined && isAlive(adopted)) {
      process.kill(adopted, 'SIGTERM');
      await waitUntil(() => (isAlive(adopted) ? undefined : true), 'the child to exit', 10_000).catch(
        () => process.kill(adopted, 'SIGKILL'),
      );
    }
    await server.stop();
    web.remove();
  }
});

test('AI_SM_WEB_DIST_DIR: a bad value makes the server refuse to start — exit 1, no runtime.json, and it SAYS so in server.log', async () => {
  // The seam names the directory a restart REBUILDS, RENAMES and whose backup
  // it later DELETES, and the one the static-file guard measures paths against.
  //   - relative: resolves against whatever cwd was inherited, so the swap
  //     could rename a directory nobody meant to touch;
  //   - unnormalized ('/x/', '/x/../y', '/'): `startsWith(webDistDir + sep)` in
  //     server/api.ts fails for EVERY asset (a 403 UI), and `<dir>-prev` of a
  //     trailing-slash value is a sibling nobody meant.
  // Refused before listen, publishing nothing — and the REASON goes to
  // server.log, because a detached backend's stderr is /dev/null and the log is
  // the only channel the user has.
  const cases: { value: string; expect: RegExp }[] = [
    { value: 'web/dist', expect: /AI_SM_WEB_DIST_DIR must be an absolute path/ },
    { value: './web/dist', expect: /AI_SM_WEB_DIST_DIR must be an absolute path/ },
    { value: '../dist', expect: /AI_SM_WEB_DIST_DIR must be an absolute path/ },
    { value: '/tmp/x/', expect: /AI_SM_WEB_DIST_DIR must be a normalized absolute directory path/ },
    { value: '/tmp/x/../y', expect: /AI_SM_WEB_DIST_DIR must be a normalized absolute directory path/ },
    { value: '/', expect: /AI_SM_WEB_DIST_DIR must be a normalized absolute directory path/ },
  ];
  for (const { value, expect } of cases) {
    const root = makeTempDirSync('ai-sm-webdist-refuse-');
    const dataDir = join(root, 'data');
    try {
      const child = spawn(process.execPath, [join(projectRoot, 'server', 'index.ts')], {
        cwd: projectRoot,
        env: {
          ...process.env,
          AI_SM_DATA_DIR: dataDir,
          AI_SM_WEB_DIST_DIR: value,
          AI_SM_STARTUP_GRACE_MS: '600000',
          AI_SM_GRACE_MS: '600000',
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr?.on('data', (c: Buffer) => {
        stderr += c.toString('utf8');
      });
      // 30 s, not 10: the pass path exits in well under a second, so this only
      // bounds a FAILING mutant — and a 10 s bound flaked once under load, with
      // this refusing boot competing with the real servers this file spawns.
      const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve) => child.once('exit', (code, signal) => resolve({ code, signal })),
      );
      clearTimeout(timer);
      assert.equal(exit.code, 1, `${value}: must exit 1 (signal ${exit.signal})`);
      assert.match(stderr, expect, value);
      assert.ok(
        !existsSync(join(dataDir, 'runtime.json')),
        `${value}: a refused start must publish no discovery file`,
      );
      // The line the USER can actually see: stderr is /dev/null in production.
      const logFile = join(dataDir, 'server.log');
      assert.ok(existsSync(logFile), `${value}: the refusal must still have written server.log`);
      const serverLog = readFileSync(logFile, 'utf8');
      assert.match(
        serverLog,
        new RegExp(`\\[error\\] refusing to start: ${expect.source}`),
        `${value}: the reason must reach server.log, not only stderr: ${serverLog}`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('AI_SM_PORT_HINT: a busy hint falls back ONCE to an auto-picked port and says so', async () => {
  // Occupy a port, then hand that very port to a fresh backend as its hint.
  const squatter = createNetServer();
  await new Promise<void>((resolve) => squatter.listen(0, '127.0.0.1', resolve));
  const busyPort = (squatter.address() as { port: number }).port;
  let server: Awaited<ReturnType<typeof startTestServer>> | undefined;
  try {
    server = await startTestServer({ env: { AI_SM_PORT_HINT: String(busyPort) } });
    assert.notEqual(server.port, busyPort, 'it must not have stolen the busy port');
    assert.ok(server.port > 0);

    const health = await fetch(`${server.baseUrl}/health`);
    assert.equal(health.status, 200, 'and it is serving on the auto-picked one');

    const log = await readServerLog(server);
    assert.ok(
      log.includes(`port hint ${busyPort} busy, auto-picked ${server.port}`),
      `the fallback is one explicit line: ${log.split('\n').filter((l) => l.includes('hint')).join(' | ')}`,
    );
    assert.ok(
      log.includes(`listening on 127.0.0.1:${server.port}`),
      'and the usual listening line still names the real port',
    );
  } finally {
    if (server !== undefined) await server.stop();
    await new Promise<void>((resolve) => squatter.close(() => resolve()));
  }
});

test('AI_SM_RESTARTED_FROM: a plain pid is printed, anything else is named invalid on ONE line', async () => {
  const ok = await startTestServer({ env: { AI_SM_RESTARTED_FROM: '4242' } });
  try {
    assert.ok((await readServerLog(ok)).includes('restarted from pid 4242'));
  } finally {
    await ok.stop();
  }

  // A log line is a text record: a newline in the value would forge a second,
  // fake line, and free text would let it say whatever it likes.
  const forged = await startTestServer({
    env: { AI_SM_RESTARTED_FROM: '1\n2026-09-06T00:00:00.000Z [error] [restart] handoff failed' },
  });
  try {
    const log = await readServerLog(forged);
    assert.ok(log.includes('restarted from pid <invalid>'), 'a non-pid is never printed as a pid');
    assert.ok(
      !/^\S+ \[error\] \[restart\] handoff failed/m.test(log),
      'and it can never start a line of its own',
    );
  } finally {
    await forged.stop();
  }
});

test('AI_SM_PORT_HINT: a nonsense value is refused loudly and the port is auto-picked', async () => {
  const server = await startTestServer({ env: { AI_SM_PORT_HINT: '99999999' } });
  try {
    assert.ok(server.port > 0 && server.port <= 65_535);
    const log = await readServerLog(server);
    assert.ok(
      log.includes('AI_SM_PORT_HINT must be a port number 1-65535, got "99999999"; auto-picking instead'),
      'the refusal names the rule and the value',
    );
  } finally {
    await server.stop();
  }
});

test('REAL restart: a SIGTERM racing the handoff never deletes runtime.json out from under the child', async () => {
  // The guard in index.ts: once a restart has torn everything down, the normal
  // shutdown path (SIGTERM, SIGINT, idle grace) must NOT run again — its
  // unlink() would blind the launcher by removing the CHILD's discovery file.
  // The race is timed by the log line the old process writes right after the
  // spawn; whoever wins it, the invariant below must hold.
  const web = webDistCopy();
  const repoDistBefore = repoWebDist();
  const server = await startTestServer({ env: { AI_SM_WEB_DIST_DIR: web.served } });
  const oldPid = server.child.pid as number;
  let childPid: number | undefined;
  try {
    void api(server, 'POST', '/api/restart').catch(() => undefined); // May never answer: we kill it.
    await waitUntil(
      async () => ((await readServerLog(server)).includes('new backend spawned') ? true : undefined),
      'the spawn line',
      15_000,
      5,
    );
    try {
      process.kill(oldPid, 'SIGTERM');
    } catch {
      // Already exited on its own — the handoff simply won the race.
    }

    const child = await waitUntil(
      () => {
        const rt = readRuntime(server.runtimeFile);
        return rt !== undefined && rt.pid !== oldPid ? rt : undefined;
      },
      'runtime.json to survive and name the child',
    );
    childPid = child.pid;
    assert.ok(existsSync(server.runtimeFile), 'runtime.json must still be there');
    assert.equal(isAlive(child.pid), true, 'the child is alive and owns the file');
    const health = await fetch(`http://127.0.0.1:${child.port}/health`);
    assert.equal(health.status, 200, 'and it is serving');

    const exit = await Promise.race([server.exit, delay(15_000).then(() => undefined)]);
    assert.ok(exit !== undefined, 'the old process is gone');
    assert.equal(exit.code, 0, `and left cleanly (code=${exit.code} signal=${exit.signal})`);

    // The invariant above is timing-dependent (the unlink can land before the
    // child ever creates the file), so the GUARD itself is asserted directly:
    // the signal must have taken the restart-aware exit, never the ordinary
    // shutdown that unlinks runtime.json.
    const log = await readServerLog(server);
    assert.match(
      log,
      /received SIGTERM while a restart is in progress; exiting without further teardown/,
      `the SIGTERM must hit the guarded path: ${log
        .split('\n')
        .filter((l) => l.includes('received SIGTERM'))
        .join(' | ')}`,
    );
    assert.ok(
      !log.includes('received SIGTERM, shutting down'),
      'and never the ordinary teardown, which would unlink the file',
    );
    assert.deepEqual(repoWebDist(), repoDistBefore, "the repo's own web/dist never moved");
  } finally {
    const adopted = childPid;
    if (adopted !== undefined && isAlive(adopted)) {
      process.kill(adopted, 'SIGTERM');
      await waitUntil(() => (isAlive(adopted) ? undefined : true), 'the child to exit', 10_000).catch(
        () => process.kill(adopted, 'SIGKILL'),
      );
    }
    await server.stop();
    web.remove();
  }
});
