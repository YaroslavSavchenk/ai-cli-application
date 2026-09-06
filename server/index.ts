/**
 * AI CLI Session Manager backend — entry point.
 *
 * Binds 127.0.0.1 ONLY on an OS-assigned port (never 0.0.0.0, no fixed
 * port), then atomically writes the discovery file runtime.json (mode 0600)
 * with { port, token, pid, startedAt }. The file is removed on clean
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
import { spawn } from 'node:child_process';
import { readFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RuntimeInfo } from '../shared/protocol.ts';
import {
  resolveDataPaths,
  resolveGithubApiBase,
  resolveLogLevel,
  createLogger,
  scoped,
  describeError,
  atomicWriteFile,
  createRefusalLimiter,
  oneLine,
  MAX_LOG_BYTES,
  DEFAULT_GITHUB_API_BASE,
} from './config.ts';
import { readServerCommit, readWebBuild, mtimeOf, createUpdateChecker } from './buildinfo.ts';
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
import { RestartController } from './restart.ts';

const paths = resolveDataPaths();
const logLevel = resolveLogLevel();
const log = createLogger(paths.logFile, logLevel.level);
const token = generateToken();
const serverDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(serverDir, '..');
const webDistDir = join(serverDir, '..', 'web', 'dist');

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
const webBuild = readWebBuild(webDistDir);

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
boot(
  'info',
  `server code ${serverCommit ?? 'commit unknown'} (server/index.ts mtime ${
    mtimeOf(join(serverDir, 'index.ts')) ?? 'unknown'
  })`,
);
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
boot(
  'info',
  webBuild.indexMtime === null
    ? 'web build: web/dist missing — the UI will not be served'
    : `web build ${webBuild.asset ?? 'no assets/index-*.js'} (web/dist/index.html mtime ${webBuild.indexMtime})`,
);

const projects = new ProjectStore(paths.projectsFile, log);
const prefs = new PrefsStore(paths.prefsFile, log);
const history = new SessionHistory(paths.historyFile, log);
history.load(); // Entries a previous run left live are stamped 'crash'.
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
sessionSettings.resetDir();
// Same reasoning for the status line's git-branch cache (written by the script,
// keyed by claude session id): those sessions are gone, so every entry is stale
// — and a leftover written by anything else must not outlive a restart.
try {
  unlinkSync(paths.statuslineCacheFile);
} catch {
  // Absent (the normal case) or unremovable — the script tolerates either.
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
const lifecycle = new LifecycleController({
  onIdleShutdown: () => shutdown('idle grace expiry'),
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
const checkUpdate = createUpdateChecker({
  repoRoot,
  serverDir,
  sharedDir: join(repoRoot, 'shared'),
  webDistDir,
  bootCommit: serverCommit,
  bootAsset: webBuild.asset,
  startedAt: getStartedAt,
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
  webAsset: webBuild.asset,
  checkUpdate,
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

server.listen(portHint, '127.0.0.1');

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
  spawnChild: ({ portHint: hint, restartedFrom: from }) => {
    // NEVER a shell: this very node binary + an argv array. The launcher
    // already resolved nvm into process.execPath, so no PATH lookup either.
    const child = spawn(process.execPath, [join(serverDir, 'index.ts')], {
      cwd: repoRoot,
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        AI_SM_PORT_HINT: String(hint),
        AI_SM_RESTARTED_FROM: String(from),
      },
    });
    child.unref();
    return child.pid;
  },
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

let shuttingDown = false;
function shutdown(cause: string): void {
  if (shuttingDown) return;
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

process.on('uncaughtException', (err) => {
  log('error', `uncaught exception: ${describeError(err)}`);
  // Not during a restart handoff: runtime.json is the CHILD's by then.
  if (!restart.inProgress) {
    try {
      unlinkSync(paths.runtimeFile);
    } catch {
      // Already gone.
    }
  }
  process.exit(1);
});
