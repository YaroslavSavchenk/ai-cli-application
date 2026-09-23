/**
 * The wiring of the manual restart (POST /api/restart, same-port handoff to a
 * fresh process) to the real OS: what the RestartController tears down, how
 * the preflight builds or verifies the frontend, how the standby child is
 * started and probed. The sequence and its reasons live in server/restart.ts.
 *
 * Split from server/index.ts (O8, 2026-09-23): a pure move of the
 * controller's deps literal, behaviour and log lines unchanged. index.ts
 * calls createRestartController() at the exact point the literal stood and
 * keeps the boot sequence, shutdown() and the frontend build child it reads.
 */
import type { Server } from 'node:http';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RuntimeInfo } from '../shared/protocol.ts';
import { scoped, oneLine, type DataPaths, type Logger } from './config.ts';
import { readWebBuild, dependenciesInStep } from './buildinfo.ts';
import { resolveInstalledTarget, type InstalledTarget } from './bundle.ts';
import type { SessionManager } from './sessions.ts';
import type { TelemetryWatcher } from './telemetry.ts';
import type { AgentsWatcher } from './agents.ts';
import type { SessionHistory } from './history.ts';
import type { LifecycleController } from './lifecycle.ts';
import type { UpgradeHandler } from './ws.ts';
import {
  RestartController,
  createStandbyStarter,
  RestartRefusal,
  REFUSED_STANDBY,
} from './restart.ts';
import {
  buildFrontend,
  commitFrontend,
  discardFrontend,
  revertFrontend,
  swapFrontend,
} from './webbuild.ts';
import type { ReleaseChecker } from './update-release.ts';

/** What the restart wiring reads from the boot in server/index.ts. */
export interface RestartWiring {
  log: Logger;
  getPort: () => number;
  paths: DataPaths;
  repoRoot: string;
  serverDir: string;
  webDistDir: string;
  installed: boolean;
  sessions: SessionManager;
  history: SessionHistory;
  lifecycle: LifecycleController;
  telemetry: TelemetryWatcher;
  agents: AgentsWatcher;
  releaseChecker: ReleaseChecker | undefined;
  server: Server;
  upgrade: UpgradeHandler;
  openSockets: Set<Socket>;
  wsSockets: WeakSet<Duplex>;
  /** A preflight build spawned vite: index.ts holds the child so shutdown() can stop it. */
  onBuildSpawn: (child: ChildProcess) => void;
}

export function createRestartController(wiring: RestartWiring): RestartController {
  const {
    log,
    getPort,
    paths,
    repoRoot,
    serverDir,
    webDistDir,
    installed,
    sessions,
    history,
    lifecycle,
    telemetry,
    agents,
    releaseChecker,
    server,
    upgrade,
    openSockets,
    wsSockets,
    onBuildSpawn,
  } = wiring;
  /**
   * INSTALLED MODE: the bundle this restart verified, between preflight step 2
   * and the spawn. Held in this closure rather than threaded through the controller
   * because a preflight is single-flighted (a second POST /api/restart is 409),
   * so exactly one value is ever in flight.
   */
  let installedTarget: InstalledTarget | undefined;

  return new RestartController({
    log,
    pid: process.pid,
    port: getPort,
    counts: () => ({
      sessions: sessions.list().length,
      presence: lifecycle.presenceCount,
      attached: lifecycle.attachedCount,
    }),
    teardown: (keepSocket) => {
      // Same order as shutdown(), minus the unlink: runtime.json is about to
      // belong to the child, so removing it here would blind the launcher.
      lifecycle.stop();
      telemetry.stop();
      agents.stop();
      releaseChecker?.stop();
      history.endAllLive('shutdown');
      sessions.destroyAll();
      server.close(); // Releases the LISTENING socket; the in-flight request lives on.
      const closedWs = upgrade.closeAll(1012, 'service restart');
      let destroyed = 0;
      for (const socket of openSockets) {
        if (socket === keepSocket) continue; // The 202 still has to travel here.
        if (wsSockets.has(socket)) continue; // Let the 1012 close frame flush.
        socket.destroy();
        destroyed += 1;
      }
      log(
        'info',
        `restart teardown: listener closed, ${closedWs} websocket(s) closed 1012, ` +
          `${destroyed} idle connection(s) destroyed`,
      );
    },
    // A packaged tree has no package-lock.json and its node_modules ships inside
    // the bundle, so the dependency question is answered by the build, not by a
    // stamp comparison that could only ever produce a refusal nobody can clear.
    dependenciesReady: () => (installed ? true : dependenciesInStep(repoRoot)),
    // PREFLIGHT STEP 2, installed: there is no vite in a bundle and nothing to
    // build — the frontend of the version we are about to start is already on
    // disk. The step keeps its JOB (prove the replacement's screens before
    // anything is torn down) by RESOLVING AND VERIFYING the target bundle:
    // `<app>/current` inside `<app>`, with a marker, an entry module, its own
    // node binary and a real web/dist. A refusal here is a 422 with the old
    // backend untouched, exactly like a failed build.
    buildFrontend: installed
      ? () => {
          const target = resolveInstalledTarget(repoRoot);
          installedTarget = target;
          const built = readWebBuild(join(target.dir, 'web', 'dist'));
          scoped(log, 'restart')(
            'info',
            `preflight: target bundle ${target.version} in ${oneLine(target.dir)} verified ` +
              `(node ${oneLine(target.execPath)}, entry bundle ${oneLine(built.asset ?? 'unknown')})`,
          );
          return Promise.resolve({
            buildId: built.buildId,
            asset: built.asset,
            ms: 0,
            // Nothing is staged in installed mode: the bundle ships its own
            // web/dist and the restart only proves it is there.
            note: 'bundled dist, verified in place',
          });
        }
      : () =>
          buildFrontend({
            repoRoot,
            webDistDir,
            log: scoped(log, 'restart'),
            // A build can run for up to two minutes; a SIGTERM or an idle-grace
            // expiry in that window must not leave vite writing into web/dist-next
            // after this process is gone.
            onSpawn: (child) => {
              onBuildSpawn(child);
            },
          }),
    // Nothing was staged, so nothing swaps: the target bundle serves its OWN
    // web/dist from its own directory. `hadPrevious: false` says there is no
    // backup, which is what makes revert a no-op rather than a restore.
    swapFrontend: installed ? () => ({ hadPrevious: false }) : () => swapFrontend({ webDistDir, log: scoped(log, 'restart') }),
    revertFrontend: installed
      ? () => {
          // Nothing to put back: this process's web/dist was never touched.
        }
      : (swap) =>
          revertFrontend({ webDistDir, log: scoped(log, 'restart'), hadPrevious: swap.hadPrevious }),
    commitFrontend: installed
      ? () => {
          // No backup exists to drop.
        }
      : () => commitFrontend({ webDistDir }),
    discardFrontend: installed
      ? () => {
          // No staging dir exists; only the resolved target is forgotten, so the
          // next attempt re-reads where `current` points.
          installedTarget = undefined;
        }
      : () => discardFrontend({ webDistDir }),
    startStandby: installed
      ? createStandbyStarter({
          log,
          // The bundle's OWN node binary and entry module — never this process's
          // execPath, which belongs to the version being replaced.
          resolveTarget: () => {
            if (installedTarget === undefined) {
              throw new RestartRefusal(REFUSED_STANDBY, 'the target bundle was not resolved by the preflight');
            }
            return installedTarget;
          },
        })
      : createStandbyStarter({
          entry: join(serverDir, 'index.ts'),
          cwd: repoRoot,
          log,
        }),
    readRuntime: () => {
      try {
        return JSON.parse(readFileSync(paths.runtimeFile, 'utf8')) as RuntimeInfo;
      } catch {
        return undefined; // Absent, half-written (it is renamed into place), unreadable.
      }
    },
    probeHealth: async (probePort) => {
      try {
        const res = await fetch(`http://127.0.0.1:${probePort}/health`, {
          signal: AbortSignal.timeout(2_000),
          redirect: 'error',
        });
        if (res.status !== 200) return false;
        const body = (await res.json()) as { ok?: unknown };
        return body.ok === true;
      } catch {
        return false;
      }
    },
    exit: (code) => process.exit(code),
  });
}
