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
import { unlinkSync } from 'node:fs';
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
import { readServerCommit, readWebBuild, mtimeOf } from './buildinfo.ts';
import { generateToken } from './auth.ts';
import { ProjectStore } from './projects.ts';
import { PrefsStore } from './prefs.ts';
import { SessionManager } from './sessions.ts';
import { SessionSettingsStore } from './session-settings.ts';
import { SessionHistory } from './history.ts';
import { GithubConnection } from './github.ts';
import { LifecycleController } from './lifecycle.ts';
import { createRequestHandler } from './api.ts';
import { createUpgradeHandler } from './ws.ts';

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

const server = createServer(
  createRequestHandler({
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
    log,
    allowRefusalLine,
  }),
);
server.on(
  'upgrade',
  createUpgradeHandler({ token, getPort, sessions, lifecycle, log, allowRefusalLine }),
);

server.listen(0, '127.0.0.1', () => {
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
  log('info', `listening on 127.0.0.1:${port} (pid ${process.pid}, data dir ${paths.dataDir})`);
  lifecycle.start(); // Startup grace: no window ever connecting must not leave a zombie.
});

server.on('error', (err) => {
  log('error', `server error: ${describeError(err)}`);
  process.exit(1);
});

let shuttingDown = false;
function shutdown(cause: string): void {
  if (shuttingDown) return;
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
  try {
    unlinkSync(paths.runtimeFile);
  } catch {
    // Already gone.
  }
  process.exit(1);
});
