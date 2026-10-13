/**
 * The update wiring: "is there newer code?" for GET /api/runtime (the
 * installed-mode `<app>/current` check, or the developer clone's on-disk
 * heuristics), the online release check with its AI_SM_UPDATE_* seams,
 * POST /api/update/check's shared in-flight check, and the UpdateController
 * behind POST /api/update.
 *
 * Split from server/index.ts (Quality Q5, 2026-10-13): a pure move, the
 * order, the log lines and the AI_SM_UPDATE_API_BASE refusal unchanged.
 * index.ts calls createUpdateWiring() at the exact point the statements
 * stood, at module load, so a refusal still throws out of module evaluation
 * (stderr + exit 1). It keeps the boot order, starting and stopping the
 * release checker, and the idle-shutdown deferral that reads the updater.
 * Siblings: server/index-banner.ts, server/index-stores.ts,
 * server/index-restart.ts.
 */
import { join } from 'node:path';
import type { UpdateStatus } from '../shared/protocol.ts';
import {
  oneLine,
  DEFAULT_UPDATE_API_BASE,
  resolveUpdateApiBase,
  type DataPaths,
  type Logger,
} from './config.ts';
import { createUpdateChecker } from './buildinfo.ts';
import { createInstalledUpdateChecker, type BundleInfo } from './bundle.ts';
import {
  CHECK_INTERVAL_MS,
  composeUpdateStatus,
  createReleaseChecker,
  releaseCheckSupported,
  type ReleaseChecker,
} from './update-release.ts';
import { createInteropLauncher, UpdateController } from './update-install.ts';

/** What the update wiring reads from the boot in server/index.ts. */
interface UpdateWiring {
  log: Logger;
  /** The banner's scoped logger: the seam warnings belong with the boot lines. */
  boot: Logger;
  paths: DataPaths;
  repoRoot: string;
  serverDir: string;
  webDistDir: string;
  bundle: BundleInfo | null;
  serverCommit: string | null;
  getStartedAt: () => string;
  /** The bundle this process serves NOW (a standby adopts a new one at `go`). */
  getWebAsset: () => string | null;
}

interface Updates {
  releaseChecker: ReleaseChecker | undefined;
  checkUpdate: () => UpdateStatus;
  updateCheck: (() => Promise<UpdateStatus>) | undefined;
  updater: UpdateController;
}

/**
 * Millisecond seam, same contract as AI_SM_GRACE_MS: invalid falls back loudly.
 *
 * FLOORED AT ONE SECOND. These two seams move the clock of a loop that talks to
 * api.github.com, and `0` (or 5) would turn it into a request flood against
 * someone else's service from a machine the user thought was idle. A value
 * below the floor is raised to it and said out loud; the test suite only ever
 * needs "sooner", never "as fast as the CPU allows".
 */
const UPDATE_ENV_MIN_MS = 1_000;
/**
 * CAPPED AT THE NODE TIMER MAXIMUM (2^31-1 ms). setTimeout silently treats a
 * larger delay as 1 ms, so an over-large seam would produce the exact flood the
 * floor above exists to prevent instead of the "practically never" the value
 * asks for.
 */
const UPDATE_ENV_MAX_MS = 2_147_483_647;
function updateEnvMs(boot: Logger, name: string, fallback: number): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    boot('warn', `${name} must be a non-negative integer (ms), got ${JSON.stringify(oneLine(raw))}; using ${fallback}`);
    return undefined;
  }
  if (value < UPDATE_ENV_MIN_MS) {
    boot('warn', `${name}=${value} is below the ${UPDATE_ENV_MIN_MS}ms floor; using ${UPDATE_ENV_MIN_MS}`);
    return UPDATE_ENV_MIN_MS;
  }
  if (value > UPDATE_ENV_MAX_MS) {
    boot('warn', `${name}=${value} is above the ${UPDATE_ENV_MAX_MS}ms timer maximum; using ${UPDATE_ENV_MAX_MS}`);
    return UPDATE_ENV_MAX_MS;
  }
  return value;
}

export function createUpdateWiring(wiring: UpdateWiring): Updates {
  const { log, boot, paths, repoRoot, serverDir, webDistDir, bundle, getStartedAt } = wiring;
  const installed = bundle !== null;
  /**
   * "Is the code on disk newer than this process?" for GET /api/runtime — the
   * signal behind the UI's update notice. Computed per request (cached ~5 s in
   * the checker), NOT at boot: the whole point is code that landed after we
   * started.
   */
  // Installed mode has ONE honest signal on disk — `<app>/current` points at
  // another version dir — and none of the six developer heuristics can fire in a
  // packaged tree (no .git, no lockfile stamp, no sources). See server/bundle.ts.
  const installedCheck = installed
    ? createInstalledUpdateChecker({ appDir: repoRoot, startedAt: getStartedAt })
    : undefined;

  // ---------------------------------------------------------------------------
  // IN-APP UPDATE (phase E, 2026-09-09) — the ONLINE half of the same question.
  //
  // AI_SM_UPDATE_API_BASE re-points the anonymous `releases/latest` GET (and with
  // it the host an update executable may be downloaded from) — loopback only, and
  // a non-loopback value refuses the start here, before `listen`, so no
  // runtime.json is ever written. Same shape and same reason as the
  // AI_SM_GITHUB_API_BASE refusal: stderr goes to /dev/null in production, so the
  // reason has to reach server.log.
  // ---------------------------------------------------------------------------
  let updateApiBase: string;
  try {
    updateApiBase = resolveUpdateApiBase();
  } catch (err) {
    log('error', `refusing to start: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
  if (updateApiBase !== DEFAULT_UPDATE_API_BASE) {
    log('warn', `release check api base overridden via AI_SM_UPDATE_API_BASE: ${updateApiBase}`);
  }

  const firstCheckMs = updateEnvMs(boot, 'AI_SM_UPDATE_FIRST_MS', 20_000);
  const checkIntervalMs = updateEnvMs(boot, 'AI_SM_UPDATE_INTERVAL_MS', CHECK_INTERVAL_MS);

  /**
   * The periodic release check. Built ONLY for an installed bundle whose version
   * is a real release: a developer clone and a `0.0.0-dev+<sha>` bundle make zero
   * outbound requests, which is the promise this project makes about itself.
   */
  let releaseChecker: ReleaseChecker | undefined;
  if (bundle !== null) {
    if (releaseCheckSupported(bundle.version)) {
      releaseChecker = createReleaseChecker({
        currentVersion: bundle.version,
        apiBase: updateApiBase,
        cacheFile: paths.updateCheckFile,
        log,
        ...(firstCheckMs !== undefined ? { firstCheckMs } : {}),
        ...(checkIntervalMs !== undefined ? { intervalMs: checkIntervalMs } : {}),
      });
    } else {
      boot(
        'debug',
        `online release check disabled for build ${oneLine(bundle.version)} (not a released version)`,
      );
    }
  }

  // COMPOSITION (the scope bullet): installed-on-disk beats available-online. A
  // bundle that is already unpacked is one restart away; a release still has to
  // be downloaded, verified and installed.
  const checkUpdate = installedCheck !== undefined
    ? () => composeUpdateStatus(installedCheck(), releaseChecker?.status())
    : createUpdateChecker({
        repoRoot,
        serverDir,
        sharedDir: join(repoRoot, 'shared'),
        webDistDir,
        bootCommit: wiring.serverCommit,
        bootAsset: wiring.getWebAsset,
        startedAt: getStartedAt,
      });

  /**
   * POST /api/update/check (Nocturne B6) — the user asking "is there anything
   * new?" right now instead of waiting for the timer. Defined ONLY when there IS
   * a checker: on a developer clone or an unreleased bundle the route answers 503
   * rather than quietly making the outbound request this project promises not to
   * make.
   *
   * SERIALISED on one promise per process: two windows pressing the button (or a
   * double click) share the check in flight instead of doubling the GitHub
   * request. The composed status is read AFTER the check resolves, so the answer
   * already carries whatever it found — and `checkNow()` never rejects, so a
   * failure simply answers the last known status.
   */
  const checker = releaseChecker;
  let updateCheckInFlight: Promise<UpdateStatus> | undefined;
  const updateCheck =
    checker === undefined
      ? undefined
      : (): Promise<UpdateStatus> =>
          (updateCheckInFlight ??= checker
            .checkNow()
            .then(() => checkUpdate())
            .finally(() => {
              updateCheckInFlight = undefined;
            }));

  /**
   * POST /api/update — download, verify, and start the Setup on Windows. The
   * Windows launch is injected so the pipeline is testable on Linux; here it is
   * the real WSL interop spawn. A developer clone gets a controller too, and it
   * answers 422 ("only in the installed app") instead of a bare 503, which is a
   * different and more honest thing to say.
   */
  const updater = new UpdateController({
    log,
    updatesDir: paths.updatesDir,
    installed,
    release: () => releaseChecker?.release(),
    installedCheck: () => installedCheck?.() ?? { available: false, reason: null },
    launchSetup: createInteropLauncher({ log, appDir: repoRoot }),
    // With the seam set, the asset host allow-list collapses to exactly it.
    ...(updateApiBase !== DEFAULT_UPDATE_API_BASE ? { seamOrigin: updateApiBase } : {}),
  });

  return { releaseChecker, checkUpdate, updateCheck, updater };
}
