/**
 * AI CLI Session Manager backend — entry point.
 *
 * Binds 127.0.0.1 ONLY on an OS-assigned port (never 0.0.0.0, no fixed
 * port), then atomically writes the discovery file runtime.json (mode 0600)
 * with { port, token, pid, startedAt, appDir }. The file is removed on clean
 * SIGINT/SIGTERM shutdown.
 *
 * The process runs detached (setsid for MVP): nothing depends on stdout;
 * all logging appends to server.log in the data dir. Sessions are
 * server-side objects — a page reload or a brief window close never kills
 * a session; clients reattach with scrollback replayed.
 *
 * Lifetime is bound to UI presence (decided 2026-07-19): the frontend holds
 * a presence WebSocket; when no presence and no session clients remain, a
 * grace timer (LifecycleController) expires into the same clean shutdown as
 * SIGTERM — history 'shutdown', kill PTYs, remove runtime.json, exit 0. The
 * crash-safe session history (history.ts) lets any ended session be resumed
 * later, on this run or a future one.
 *
 * Runs directly on Node 24 native type stripping: erasable syntax only,
 * relative imports carry explicit .ts extensions.
 */
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { readFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RuntimeInfo } from '../shared/protocol.ts';
import {
  resolveDataPaths,
  resolveGithubApiBase,
  resolveWebDistDir,
  resolveLogLevel,
  createLogger,
  scoped,
  describeError,
  atomicWriteFile,
  createRefusalLimiter,
  oneLine,
  MAX_LOG_BYTES,
  DEFAULT_GITHUB_API_BASE,
  DEFAULT_UPDATE_API_BASE,
  resolveUpdateApiBase,
} from './config.ts';
import {
  readServerCommit,
  readWebBuild,
  mtimeOf,
  createUpdateChecker,
  dependenciesInStep,
} from './buildinfo.ts';
import {
  readBundleInfo,
  createInstalledUpdateChecker,
  resolveInstalledTarget,
  type InstalledTarget,
} from './bundle.ts';
import { generateToken } from './auth.ts';
import { ProjectStore } from './projects.ts';
import { PrefsStore } from './prefs.ts';
import { SessionManager } from './sessions.ts';
import { SessionSettingsStore } from './session-settings.ts';
import { SessionHistory } from './history.ts';
import { GithubConnection } from './github.ts';
import { LifecycleController } from './lifecycle.ts';
import { createRequestHandler, type ApiDeps } from './api.ts';
import { createUpgradeHandler } from './ws.ts';
import {
  RestartController,
  createStandbyStarter,
  RestartRefusal,
  REFUSED_STANDBY,
  STANDBY_TIMEOUT_MS,
} from './restart.ts';
import {
  buildFrontend,
  commitFrontend,
  discardFrontend,
  revertFrontend,
  swapFrontend,
} from './webbuild.ts';
import {
  composeUpdateStatus,
  createReleaseChecker,
  releaseCheckSupported,
  type ReleaseChecker,
} from './update-release.ts';
import {
  cleanupUpdatesDir,
  createInteropLauncher,
  UpdateController,
} from './update-install.ts';

const paths = resolveDataPaths();
const logLevel = resolveLogLevel();
const log = createLogger(paths.logFile, logLevel.level);
const token = generateToken();
const serverDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(serverDir, '..');
/**
 * INSTALLED MODE (2026-09-08) — is this a developer clone or an unpacked
 * bundle? `bundle.json` at the root is the marker, and `repoRoot` is then the
 * VERSION DIR of the install (`<app>/<version>`), with `<app>/current` naming
 * the version the launcher starts.
 *
 * Five things branch on it, all in this file: the banner line, the update
 * check, the dependency preflight, what the restart preflight verifies and who
 * it hands the port to. Everything else — data dir, ports, sessions, history,
 * logging — is identical, and with no marker present the developer path is
 * byte-for-byte what it was.
 */
// Collected, not logged here: the logger is scoped for the banner further down,
// and this line belongs with the "which code is this?" answer it contradicts.
const bundleWarnings: string[] = [];
const bundle = readBundleInfo(repoRoot, { warn: (line) => bundleWarnings.push(line) });
const installed = bundle !== null;
// AI_SM_WEB_DIST_DIR (an absolute, normalized directory path) moves the SERVED
// frontend, and with it the `-next`/`-prev` staging dirs a restart renames.
// Unset in normal use; the restart tests point it at a copy so a test run never
// rebuilds the repo's own web/dist.
//
// A bad value refuses the start — and the REASON has to reach server.log, not
// only stderr: this process is started as `setsid --fork nohup node
// server/index.ts </dev/null >/dev/null 2>&1` (launcher/start-backend.sh), so
// stderr goes nowhere and the user would see only the launcher's "did not
// become healthy" timeout. Same shape as the AI_SM_GITHUB_API_BASE refusal
// below; the message is already one-lined by resolveWebDistDir.
let webDistDir: string;
try {
  webDistDir = resolveWebDistDir(repoRoot);
} catch (err) {
  log('error', `refusing to start: ${err instanceof Error ? err.message : String(err)}`);
  throw err; // unchanged otherwise: uncaught at module eval -> stderr + exit 1.
}

// ---------------------------------------------------------------------------
// Boot banner. The first lines of every run answer "which code is this?" —
// server commit, server/index.ts mtime, frontend bundle, data dir, log level,
// and every AI_SM_* override in effect. Motivated by a real incident
// (2026-09-06): a freshly built UI talking to a backend started before the
// feature existed showed an empty HISTORY section, and the log gave the user
// nothing to go on. NO SECRET goes in here: token-shaped env values are
// redacted by name and the auth token is never printed at all.
// ---------------------------------------------------------------------------
const boot = scoped(log, 'boot');
/** Env names whose VALUE is never logged, whatever else they are. */
const SECRETISH_ENV = /TOKEN|SECRET|PASSWORD|PASSWD|KEY|CRED|AUTH/i;
/**
 * A URL with USERINFO (`scheme://user:password@host`). Measured, not
 * hypothetical: AI_SM_GITHUB_API_BASE is a URL and the server's own refusal
 * path deliberately declines to echo it for exactly this reason
 * (assertLoopbackApiBase). The banner must not undo that.
 */
const URL_WITH_USERINFO = /\/\/[^/\s@]*:[^/\s@]*@/;

/** The value as it may be logged: redacted whenever it could carry a secret. */
function envValueForLog(name: string, raw: string): string {
  if (SECRETISH_ENV.test(name)) return '<redacted by name>';
  if (URL_WITH_USERINFO.test(raw)) return '<redacted: embeds credentials>';
  return JSON.stringify(oneLine(raw));
}
const serverCommit = readServerCommit(repoRoot);
let webBuild = readWebBuild(webDistDir);

// ---------------------------------------------------------------------------
// STANDBY MODE, decided HERE — before the first thing that writes anything.
//
// A standby child (AI_SM_STANDBY=1 + an IPC channel, set only by a restart
// preflight) shares the data dir with a LIVE parent that is still serving. Until
// `go` it must therefore own NOTHING in it: no history rewrite, no wiping of the
// parent's session-settings files, no unlink of anything, not even on a signal.
// Everything that mutates the data dir is deferred to the `go` handler.
//
// Without a channel there is nobody to say `go`, so AI_SM_STANDBY set by hand is
// an ordinary boot (warned about below) and does all of it right away.
// ---------------------------------------------------------------------------
/** Bound once: `process.send` exists only when the parent opened an IPC channel. */
const sendToParent = process.send?.bind(process);
const standbyMode = process.env['AI_SM_STANDBY'] === '1';
/** True from module load until `go`: this process must not touch the data dir. */
let standbyWaiting = standbyMode && sendToParent !== undefined;

boot('info', `ai-cli-application backend starting (node ${process.version}, pid ${process.pid})`);
boot('info', `data dir ${paths.dataDir}`);
boot(
  'info',
  `log level ${logLevel.level} (AI_SM_LOG_LEVEL ${
    logLevel.raw === undefined ? 'unset, default' : `= ${JSON.stringify(oneLine(logLevel.raw))}`
  }${logLevel.valid ? '' : ' — unrecognized, using the default'}), rotation at ${MAX_LOG_BYTES} bytes, 2 kept generations`,
);
// SET means non-empty: every consumer in this codebase (resolveDataPaths,
// resolveGithubApiBase, envMs) treats '' as unset, so an empty value is not an
// override and must not be reported as one.
for (const name of Object.keys(process.env).filter((n) => n.startsWith('AI_SM_')).sort()) {
  const raw = process.env[name] ?? '';
  if (raw === '') continue;
  boot('info', `env ${name}=${envValueForLog(name, raw)}`);
}
// Which code is this? An install answers with its bundle marker (there is no
// .git in a packaged tree, so the commit line would always read "unknown"), a
// clone with the checked-out commit. Every field of the marker is charset-gated
// in server/bundle.ts — this line prints untrusted disk content otherwise.
if (bundle !== null) {
  boot(
    'info',
    `installed build ${bundle.version} (commit ${bundle.commit ?? 'unknown'}, ` +
      `node ${bundle.nodeVersion}, built ${oneLine(bundle.builtAt)}, app dir ${oneLine(repoRoot)})`,
  );
} else {
  // An unreadable (not absent) bundle.json makes the line below a possible
  // LIE: this may be an INSTALL running as a clone for the rest of its life.
  for (const line of bundleWarnings) boot('warn', line);
  boot(
    'info',
    `server code ${serverCommit ?? 'commit unknown'} (server/index.ts mtime ${
      mtimeOf(join(serverDir, 'index.ts')) ?? 'unknown'
    })`,
  );
}
// A restart handoff (POST /api/restart) says so in one line, so the log reads
// as one continuous story across the two processes.
// The value is our OWN env, but a log line is a text record: an unvalidated
// string could carry anything a future caller puts there, so only a plain pid
// is printed and everything else is named as invalid.
const restartedFrom = process.env['AI_SM_RESTARTED_FROM'];
if (restartedFrom !== undefined && restartedFrom !== '') {
  boot(
    'info',
    /^\d{1,10}$/.test(restartedFrom)
      ? `restarted from pid ${restartedFrom}`
      : `restarted from pid <invalid> (${JSON.stringify(oneLine(restartedFrom))})`,
  );
}
/**
 * The frontend identity line. In a standby child it is printed at `go`, not
 * here: the parent's preflight swaps a freshly built web/dist into place while
 * this process waits, so anything read at module load names the OLD bundle.
 */
function logWebBuild(): void {
  boot(
    'info',
    webBuild.indexMtime === null
      ? 'web build: web/dist missing — the UI will not be served'
      : `web build ${webBuild.asset ?? 'no assets/index-*.js'} (build id ${
          webBuild.buildId ?? 'unknown'
        }, web/dist/index.html mtime ${webBuild.indexMtime})`,
  );
}
if (!standbyWaiting) logWebBuild();

const projects = new ProjectStore(paths.projectsFile, log);
const prefs = new PrefsStore(paths.prefsFile, log);
const history = new SessionHistory(paths.historyFile, log);
// A standby reads the file WITHOUT stamping or rewriting it: those entries
// belong to the parent that is still running them. The full load runs at `go`.
history.load({ readOnly: standbyWaiting });
// Per-session `--settings` files giving claude sessions our status line. The
// script is run by a FOREIGN process (claude), so it is named by absolute path
// and run with this very node binary — never by a name resolved through the
// child's PATH. Any file left by a previous run is wiped: sessions do not
// survive a restart.
const sessionSettings = new SessionSettingsStore(
  {
    dir: paths.sessionSettingsDir,
    scriptPath: join(serverDir, 'statusline.mjs'),
    prefsFile: paths.prefsFile,
    nodePath: process.execPath,
  },
  log,
);
/**
 * Wipe what no session may inherit across a run. Deferred to `go` in a standby:
 * `session-settings/` holds the `--settings` files of the PARENT's live claude
 * sessions, and the statusline cache is written by those very sessions.
 */
function resetSessionArtifacts(): void {
  sessionSettings.resetDir();
  // Same reasoning for the status line's git-branch cache (written by the
  // script, keyed by claude session id): those sessions are gone, so every
  // entry is stale — and a leftover written by anything else must not outlive
  // a restart.
  try {
    unlinkSync(paths.statuslineCacheFile);
  } catch {
    // Absent (the normal case) or unremovable — the script tolerates either.
  }
}
/**
 * IN-APP UPDATE (phase E): drop `<dataDir>/updates` — a `.part` from a killed
 * download, or a Setup.exe from a release nobody ran, must never be reused.
 * The only file this app ever executes is one it verified in the CURRENT run.
 * Deferred to `go` in a standby, like every other data-dir mutation.
 */
function resetUpdateArtifacts(): void {
  cleanupUpdatesDir(paths.updatesDir, log);
}
if (!standbyWaiting) {
  resetSessionArtifacts();
  resetUpdateArtifacts();
}
const sessions = new SessionManager(log, history, sessionSettings);
// GitHub connection. The OAuth client_id comes from env; absent/empty disables
// only the DEVICE FLOW (status.deviceFlowAvailable=false, POST /api/github/device
// answers a clean not-available signal). The PASTED-TOKEN path and every
// connected operation keep working without it — that is the whole point of the
// second credential path (2026-07-25).
// AI_SM_GITHUB_API_BASE re-points the REST API for offline tests — loopback
// only; a non-loopback value throws here and the server refuses to start
// (before listen, so no runtime.json is ever written).
let githubApiBase: string;
try {
  githubApiBase = resolveGithubApiBase();
} catch (err) {
  // The reason must reach server.log: in production this process is started as
  // `setsid --fork nohup node server/index.ts </dev/null >/dev/null 2>&1`
  // (launcher/start-backend.sh), so stderr goes to /dev/null and the user would
  // otherwise see only the launcher's "did not become healthy" timeout. The
  // message never carries a credential (the embedded-credential branch of
  // assertLoopbackApiBase refuses without echoing the value).
  log('error', `refusing to start: ${err instanceof Error ? err.message : String(err)}`);
  throw err; // unchanged otherwise: uncaught at module eval -> stderr + exit 1.
}
if (githubApiBase !== DEFAULT_GITHUB_API_BASE) {
  log('warn', `github REST api base overridden via AI_SM_GITHUB_API_BASE: ${githubApiBase}`);
}
const github = new GithubConnection({
  file: paths.githubFile,
  log,
  clientId: process.env['AI_SM_GITHUB_CLIENT_ID'],
  apiBase: githubApiBase,
});
/**
 * Absolute ceiling on deferring the idle shutdown for an install: the download
 * budget (15 min) plus the Setup budget (15 min) plus a minute of slack. The
 * states below already end by themselves within it; this is the backstop for a
 * state machine that somehow does not, so "an update is installing" can never
 * become an immortal backend.
 */
const IDLE_DEFER_MAX_MS = 15 * 60 * 1000 + 15 * 60 * 1000 + 60_000;
const lifecycle = new LifecycleController({
  onIdleShutdown: () => {
    // An in-app update that is WORKING holds the backend alive: the presence
    // grace is about idle windows, and exiting mid-download (or while the Setup
    // runs on the Windows side) would abandon the install with nothing left to
    // report its outcome. `holdsProcess` — not `inProgress` — is the question:
    // a Setup that outran its timeout keeps the single-flight lock (so a second
    // press is refused) but is detached and may never exit, and THAT must not
    // defer anything. Belt and braces on top: IDLE_DEFER_MAX_MS since the
    // install started ends the deferrals whatever the state says.
    if (updater.holdsProcess) {
      const heldFor = Date.now() - updater.holdingSince;
      if (heldFor < IDLE_DEFER_MAX_MS) {
        lifecycle.deferIdleShutdown('an update is installing');
        return;
      }
      log('warn', `an update has been installing for ${heldFor}ms; shutting down anyway`);
    }
    shutdown('idle grace expiry');
  },
  log,
});

let port = 0;
const getPort = (): number => port;
/** Set once at listen; the exact value written to runtime.json (GET /api/runtime). */
let startedAt = '';
const getStartedAt = (): string => startedAt;

/**
 * ONE budget for every log line an UNAUTHENTICATED caller can cause, shared by
 * the HTTP access log and the WebSocket upgrade reject — two instances would
 * silently double the ceiling the README documents.
 */
// Scoped `log`, not `http`: the one budget covers HTTP refusals AND rejected
// WebSocket upgrades, so its suppression lines must not point at one surface.
const allowRefusalLine = createRefusalLimiter(scoped(log, 'log'));

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
function updateEnvMs(name: string, fallback: number): number | undefined {
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
const firstCheckMs = updateEnvMs('AI_SM_UPDATE_FIRST_MS', 20_000);
const checkIntervalMs = updateEnvMs('AI_SM_UPDATE_INTERVAL_MS', 6 * 60 * 60 * 1000);

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
      bootCommit: serverCommit,
      bootAsset: () => webBuild.asset,
      startedAt: getStartedAt,
    });

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

// Mutable so the restart controller — which needs `server`, which needs this —
// can be attached after both exist. The route reads deps.restart per request.
const apiDeps: ApiDeps = {
  token,
  getPort,
  getStartedAt,
  projects,
  prefs,
  sessions,
  history,
  github,
  webDistDir,
  serverCommit,
  serverVersion: bundle?.version ?? null,
  installed,
  webAsset: webBuild.asset,
  checkUpdate,
  update: updater,
  log,
  allowRefusalLine,
};
const server = createServer(createRequestHandler(apiDeps));
const upgrade = createUpgradeHandler({
  token,
  getPort,
  sessions,
  lifecycle,
  log,
  allowRefusalLine,
});

/**
 * Every accepted connection, so the restart handoff can close them instead of
 * leaving the child to race a half-open keep-alive. `wsSockets` marks the ones
 * that became WebSockets: those get a proper 1012 close frame from the ws layer
 * and must NOT be destroyed underneath it.
 */
const openSockets = new Set<Socket>();
const wsSockets = new WeakSet<Duplex>();
server.on('connection', (socket: Socket) => {
  openSockets.add(socket);
  socket.on('close', () => openSockets.delete(socket));
});
// Registered BEFORE the real handler: both listeners run, this one only marks.
server.on('upgrade', (_req, socket) => {
  wsSockets.add(socket);
});
server.on('upgrade', upgrade);

/**
 * PORT HINT (AI_SM_PORT_HINT) — set ONLY by a restart handoff.
 *
 * The port stays auto-picked by architecture (decided 2026-07-18): this is a
 * hint on a handoff, tried once, and a busy port falls straight back to
 * listen(0). It exists because the WebView2 host locks navigation to the exact
 * launch origin, so keeping the port is what lets the window simply reload.
 * Anything that is not a plausible port number is refused loudly and ignored.
 */
const portHintRaw = process.env['AI_SM_PORT_HINT'];
let portHint = 0;
if (portHintRaw !== undefined && portHintRaw !== '') {
  const parsed = Number(portHintRaw);
  if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65_535) {
    portHint = parsed;
  } else {
    boot(
      'warn',
      `AI_SM_PORT_HINT must be a port number 1-65535, got ${JSON.stringify(oneLine(portHintRaw))}; auto-picking instead`,
    );
  }
}
/** The hint is tried EXACTLY once; after that the OS picks and that is final. */
let hintFellBack = false;
let listening = false;

server.on('listening', () => {
  listening = true;
  const addr = server.address();
  if (addr === null || typeof addr !== 'object') {
    log('error', 'listen returned no address, exiting');
    process.exit(1);
  }
  port = addr.port;
  startedAt = new Date().toISOString();
  const runtime: RuntimeInfo = {
    port,
    token,
    pid: process.pid,
    startedAt,
    // ADDITIVE (2026-09-08): the directory this process runs from. In installed
    // mode that is `<app>/<version>`, and the installer must never prune the
    // version dir a live pid is running out of. Harmless on the developer path
    // (the repo root) — launch.ps1's parser reads the fields it knows and
    // ignores the rest.
    appDir: repoRoot,
  };
  try {
    atomicWriteFile(paths.runtimeFile, JSON.stringify(runtime, null, 2) + '\n');
  } catch (err) {
    log('error', `failed to write ${paths.runtimeFile}: ${describeError(err)}`);
    process.exit(1);
  }
  if (hintFellBack) {
    boot('warn', `port hint ${portHint} busy, auto-picked ${port}`);
  } else if (portHint !== 0) {
    boot(
      'info',
      `port hint ${portHint} taken (a hint on a restart handoff — the port is auto-picked otherwise)`,
    );
  }
  log('info', `listening on 127.0.0.1:${port} (pid ${process.pid}, data dir ${paths.dataDir})`);
  lifecycle.start(); // Startup grace: no window ever connecting must not leave a zombie.
  // Only now: the first check is deliberately late (WSL often has no network
  // the instant Windows boots), and a standby child never reaches this handler
  // before its `go`, so a waiting standby asks GitHub nothing.
  releaseChecker?.start();
});

server.on('error', (err) => {
  // A listen error while trying the HINT is the one recoverable case: the port
  // belongs to someone else (EADDRINUSE is the expected one, but a hint is
  // untrusted enough that ANY listen failure falls back rather than dying).
  if (portHint !== 0 && !hintFellBack && !listening) {
    hintFellBack = true;
    boot('warn', `listening on the hinted port ${portHint} failed: ${describeError(err)}`);
    server.listen(0, '127.0.0.1');
    return;
  }
  log('error', `server error: ${describeError(err)}`);
  process.exit(1);
});

/**
 * Bind the port. Called immediately in a normal boot, and only on the parent's
 * `go` in a STANDBY boot (see the bottom of this file) — everything above this
 * point is the entire rest of the boot, which is exactly what a standby child
 * has already done by the time it reports in.
 */
function beginListening(): void {
  server.listen(portHint, '127.0.0.1');
}

/**
 * Adopt the frontend that is on disk NOW. Called at `go`: the parent's
 * preflight built and swapped web/dist while this process was waiting, so the
 * bundle read at module load is the OLD one — and it feeds the boot banner,
 * GET /api/runtime's `webBuild`, and the update check's "is the build newer
 * than me?" comparison, which would otherwise light the update pill on a
 * backend that had just been restarted.
 */
function adoptWebBuild(): void {
  webBuild = readWebBuild(webDistDir);
  apiDeps.webAsset = webBuild.asset;
  logWebBuild();
}

// ---------------------------------------------------------------------------
// Manual restart: same-port handoff to a fresh process (POST /api/restart).
// The sequence and its reasons live in server/restart.ts; this is only the
// wiring to the real OS.
// ---------------------------------------------------------------------------
const restart = new RestartController({
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
            buildChild = child;
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
apiDeps.restart = restart;

/** The vite process of a running preflight build, while there is one. */
let buildChild: ChildProcess | undefined;
/**
 * INSTALLED MODE: the bundle this restart verified, between preflight step 2
 * and the spawn. Module-scoped rather than threaded through the controller
 * because a preflight is single-flighted (a second POST /api/restart is 409),
 * so exactly one value is ever in flight.
 */
let installedTarget: InstalledTarget | undefined;

let shuttingDown = false;
function shutdown(cause: string): void {
  if (shuttingDown) return;
  // A standby that never got its `go` owns NOTHING in the data dir: runtime.json,
  // history.json and session-settings/ all still belong to the LIVE parent, which
  // is exactly who sends this SIGTERM when it gives up on us. Leave, touch nothing.
  if (standbyWaiting) {
    shuttingDown = true;
    boot('info', `standby: received ${cause} before the handoff; exiting without touching the data dir`);
    process.exit(0);
  }
  // A restart already ran the whole teardown (lifecycle stopped, history
  // stamped 'shutdown', PTYs killed, listener closed) and runtime.json now
  // describes the CHILD. Doing any of it twice would, at worst, delete the
  // discovery file of a healthy new backend — so this path only leaves.
  if (restart.inProgress) {
    shuttingDown = true;
    log('info', `received ${cause} while a restart is in progress; exiting without further teardown`);
    process.exit(0);
  }
  shuttingDown = true;
  // ONE line. The `received <cause>, shutting down` wording is pinned by tests
  // and by habit, so the counts are appended to it rather than duplicated into
  // a second, hand-prefixed line.
  log(
    'info',
    `received ${cause}, shutting down: sessions=${sessions.list().length} ` +
      `presence=${lifecycle.presenceCount} attached=${lifecycle.attachedCount}`,
  );
  lifecycle.stop();
  releaseChecker?.stop();
  // A frontend build in flight is this process's child: it must not outlive us
  // writing into web/dist-next, and its half-written output goes with it.
  if (buildChild !== undefined && buildChild.exitCode === null && buildChild.signalCode === null) {
    log('info', 'a frontend build was still running; stopping it and dropping its output');
    try {
      buildChild.kill('SIGTERM');
    } catch {
      // Already gone.
    }
  }
  // Always, not only while a build runs: a preflight that got past the build
  // (standby wait, swap) leaves a staged web/dist-next behind when this
  // process leaves now, and the next restart may be refused before the build
  // gets to clear it. Idempotent — nothing to remove is the common case.
  //
  // Never in installed mode: nothing there ever stages or renames a directory,
  // so this would only be a rmSync aimed at paths beside a bundle's web/dist.
  if (!installed) discardFrontend({ webDistDir });
  // History first (crash safety), then kill: destroy()'s 'user-kill' and the
  // async onExit 'exit' stamps are no-ops on already-'shutdown' entries.
  history.endAllLive('shutdown');
  sessions.destroyAll();
  try {
    unlinkSync(paths.runtimeFile);
  } catch {
    // Already gone.
  }
  server.close();
  // Force exit even if some socket lingers.
  setTimeout(() => process.exit(0), 500).unref();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('unhandledRejection', (reason) => {
  // Logged, never fatal: a rejected promise somewhere must not take running
  // PTY sessions down, but it must be diagnosable from server.log alone.
  log('error', `unhandled promise rejection: ${describeError(reason)}`);
});

// ---------------------------------------------------------------------------
// STANDBY MODE (AI_SM_STANDBY=1) — set ONLY by a restart preflight.
//
// The parent must never tear itself down for a replacement that cannot start.
// So the child does the ENTIRE boot first — imports, config, the server object,
// every handler above — reports `standby-ready` over IPC, and waits. It binds
// the port only when the parent has closed its listener and says `go`.
//
// While it waits it owns NOTHING: the data dir belongs to the parent, which is
// still serving. Everything that WRITES there — the history crash-stamp pass,
// the session-settings wipe, the statusline cache unlink — is deferred to the
// `go` handler below, and so is reading which frontend to serve (the parent
// swaps a freshly built one in meanwhile).
//
// It must never linger: a parent that dies before the handoff closes the IPC
// channel ('disconnect'), and a parent that forgets it is caught by a timeout
// measured from `standby-ready`. Both leave with exit 0, having listened on
// nothing and written no runtime.json.
// ---------------------------------------------------------------------------
if (!standbyMode) {
  beginListening();
} else if (sendToParent === undefined) {
  // Someone set the variable by hand on a normal start. Say so and boot
  // normally rather than hanging forever on a channel that does not exist.
  boot('warn', 'AI_SM_STANDBY is set but this process has no IPC channel; starting normally');
  beginListening();
} else {
  const parent = /^\d{1,10}$/.test(restartedFrom ?? '') ? (restartedFrom as string) : 'unknown';
  let standbyTimer: NodeJS.Timeout | undefined;
  process.on('message', (message) => {
    if (!standbyWaiting) return;
    // Shape-validated; anything else on the channel is ignored, not obeyed.
    if (typeof message !== 'object' || message === null) return;
    if ((message as { type?: unknown }).type !== 'go') return;
    standbyWaiting = false; // From here the data dir is OURS.
    if (standbyTimer !== undefined) clearTimeout(standbyTimer);
    boot('info', `standby: handoff received from pid ${parent}, taking the port`);
    // The three data-dir mutations an ordinary boot does at module load. They
    // waited for this moment because until now every one of them would have
    // hit files the parent was still using.
    //
    // history.load() also RE-READS the file: the teardown that just happened
    // stamped the parent's live sessions 'shutdown' on disk — the honest
    // reason, and the one HISTORY shows.
    history.load();
    resetSessionArtifacts();
    resetUpdateArtifacts();
    adoptWebBuild();
    // Belt and braces: the parent drops the swap's backup the moment `go` is
    // out, but a parent that died in between would leave `<dist>-prev` behind.
    // Idempotent — normally there is nothing to remove.
    commitFrontend({ webDistDir });
    try {
      // The channel has done its job. Closing it here is also what makes the
      // 'disconnect' below harmless: after `go` this process lives on its own.
      process.disconnect?.();
    } catch {
      // Already closed by the parent.
    }
    beginListening();
  });
  process.on('disconnect', () => {
    if (!standbyWaiting) return;
    boot('warn', 'standby: the parent went away before the handoff; exiting');
    process.exit(0);
  });
  boot('info', `standby: ready, waiting for the handoff from pid ${parent}`);
  sendToParent({ type: 'standby-ready' });
  // Armed AFTER the report, so the window is measured from the moment the
  // parent starts counting on us — not from a boot that may itself have taken
  // most of the parent's own ready timeout.
  standbyTimer = setTimeout(() => {
    if (!standbyWaiting) return;
    boot('warn', `standby: no handoff within ${STANDBY_TIMEOUT_MS}ms of reporting ready; exiting`);
    process.exit(0);
  }, STANDBY_TIMEOUT_MS);
}

process.on('uncaughtException', (err) => {
  log('error', `uncaught exception: ${describeError(err)}`);
  // Not during a restart handoff: runtime.json is the CHILD's by then. And not
  // in a standby before `go` either: there it is the live PARENT's.
  if (!restart.inProgress && !standbyWaiting) {
    try {
      unlinkSync(paths.runtimeFile);
    } catch {
      // Already gone.
    }
  }
  process.exit(1);
});
