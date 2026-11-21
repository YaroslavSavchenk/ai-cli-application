/**
 * The real backend child every server test boots: `startTestServer` spawns
 * `node server/index.ts` on a fresh (or given) data dir and finds it through
 * runtime.json exactly like the launcher does; `TestServer.stop()` ends it,
 * the pty-host it may have started (Nocturne D9 P3) and the temp dir.
 *
 * Split from tests/helpers/helpers.ts by topic (D9 P3, when the pty-host
 * option took that file past 800 lines; the moved code is unchanged except
 * for that option), which re-exports everything here. Import cycle with
 * helpers.ts (`waitUntil`, `projectRoot`): both only call each other's
 * functions later, never at import time.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { RuntimeInfo } from '../../shared/protocol.ts';
import { projectRoot, waitUntil } from './helpers.ts';
import { stopDataDirPtyHost } from './pty-host-backend-fixture.ts';

/** The suite runs every test backend over a real pty-host (CI's socket leg, D9 P3). */
const SOCKET_SUITE = process.env['AI_SM_TEST_PTY_HOST'] === 'socket';

export interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface TestServer {
  child: ChildProcess;
  /** mkdtemp root removed by stop(); null when the caller owns the data dir. */
  tmpRoot: string | null;
  /** The AI_SM_DATA_DIR value. The server itself must create it (mode 0700). */
  dataDir: string;
  runtimeFile: string;
  runtime: RuntimeInfo;
  port: number;
  token: string;
  baseUrl: string;
  /** Resolves when the server process exits. */
  exit: Promise<ExitInfo>;
  /** SIGTERM the server (SIGKILL fallback) and remove the temp dir. Idempotent. */
  stop(): Promise<void>;
}

/**
 * Spawn `node server/index.ts` with a fresh data dir, wait until runtime.json
 * exists AND /health answers 200, and return a handle with port + token.
 *
 * Lifecycle note: the backend is presence-bound — with no presence/session
 * WS connected it shuts itself down after the startup grace. Tests hold no
 * presence socket, so both graces default to a generous 10 minutes here;
 * lifecycle-specific tests override via `opts.env`
 * (AI_SM_STARTUP_GRACE_MS / AI_SM_GRACE_MS).
 *
 * `opts.dataDir` reuses an existing data dir (session-history / restart
 * tests). The caller owns its cleanup: stop() will NOT remove it.
 *
 * `opts.entry` / `opts.cwd` start a backend that is NOT this checkout — the
 * installed-mode tests boot an unpacked bundle fixture (`<app>/current/server/
 * index.ts`) so `bundle.json`, `web/dist` and `<app>/current` are the ones the
 * process really resolves. Both default to the repo, so every existing caller
 * is unchanged.
 *
 * `opts.ptyHost` (D9 P3): default `inproc` (AI_SM_PTY_HOST=inproc) for this
 * checkout — survival is irrelevant there, and a SIGKILLed backend would
 * leave its pty-host and PTYs for the 10-minute orphan grace; `socket` for the
 * survival tests and an installed `entry` (it refuses the seam). With
 * `AI_SM_TEST_PTY_HOST=socket` in the test run's env (the CI's second leg)
 * the default is `socket` for every backend, so the whole suite runs over a
 * real pty-host too. stop() ends a pty-host left in the data dir either way.
 */
export async function startTestServer(
  opts: {
    env?: Record<string, string>;
    dataDir?: string;
    entry?: string;
    cwd?: string;
    ptyHost?: 'socket' | 'inproc';
  } = {},
): Promise<TestServer> {
  const tmpRoot =
    opts.dataDir === undefined ? await mkdtemp(join(tmpdir(), 'ai-sm-test-')) : null;
  // Deliberately a not-yet-existing subdir: the server must create it (0700).
  const dataDir = opts.dataDir ?? join(tmpRoot as string, 'data');
  const ptyHost = opts.ptyHost ?? (opts.entry === undefined && !SOCKET_SUITE ? 'inproc' : 'socket');
  const child = spawn(process.execPath, [opts.entry ?? join(projectRoot, 'server', 'index.ts')], {
    cwd: opts.cwd ?? projectRoot,
    env: {
      ...process.env,
      AI_SM_DATA_DIR: dataDir,
      AI_SM_STARTUP_GRACE_MS: '600000',
      AI_SM_GRACE_MS: '600000',
      AI_SM_PTY_HOST: ptyHost === 'inproc' ? 'inproc' : '',
      ...opts.env,
    },
    stdio: 'ignore', // The server must not depend on stdout in any way.
  });
  let exited = false;
  const exit: Promise<ExitInfo> = new Promise((resolve) => {
    child.once('exit', (code, signal) => {
      exited = true;
      resolve({ code, signal });
    });
  });
  const runtimeFile = join(dataDir, 'runtime.json');

  let runtime: RuntimeInfo;
  try {
    runtime = await waitUntil<RuntimeInfo>(async () => {
      if (exited) throw new Error('server process exited before becoming healthy');
      let raw: string;
      try {
        raw = await readFile(runtimeFile, 'utf8');
      } catch {
        return undefined;
      }
      let parsed: RuntimeInfo;
      try {
        parsed = JSON.parse(raw) as RuntimeInfo;
      } catch {
        return undefined; // Should not happen (atomic write), but be safe.
      }
      if (typeof parsed.port !== 'number') return undefined;
      // A data dir reused after a SIGKILL still holds the dead run's file,
      // and since the remembered port the new run listens on the SAME port:
      // /health answers, but the token is the dead run's (a CI 401, v0.4.3).
      if (parsed.pid !== child.pid) return undefined;
      try {
        const res = await fetch(`http://127.0.0.1:${parsed.port}/health`);
        if (res.status !== 200) return undefined;
      } catch {
        return undefined;
      }
      return parsed;
    }, 'server startup (runtime.json + /health)');
  } catch (err) {
    child.kill('SIGKILL');
    if (tmpRoot !== null) await rm(tmpRoot, { recursive: true, force: true });
    throw err;
  }

  return {
    child,
    tmpRoot,
    dataDir,
    runtimeFile,
    runtime,
    port: runtime.port,
    token: runtime.token,
    baseUrl: `http://127.0.0.1:${runtime.port}`,
    exit,
    async stop(): Promise<void> {
      if (!exited) {
        child.kill('SIGTERM');
        const done = await Promise.race([exit, delay(5_000).then(() => undefined)]);
        if (done === undefined) {
          child.kill('SIGKILL');
          await exit;
        }
      }
      await stopDataDirPtyHost(dataDir);
      if (tmpRoot !== null) await rm(tmpRoot, { recursive: true, force: true });
    },
  };
}
