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
 * SIGTERM — journal 'shutdown', kill PTYs, remove runtime.json, exit 0. The
 * crash-safe session journal (journal.ts) lets the next run offer relaunch.
 *
 * Runs directly on Node 24 native type stripping: erasable syntax only,
 * relative imports carry explicit .ts extensions.
 */
import { createServer } from 'node:http';
import { unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RuntimeInfo } from '../shared/protocol.ts';
import { resolveDataPaths, resolveClaudeDir, createLogger, atomicWriteFile } from './config.ts';
import { generateToken } from './auth.ts';
import { ProjectStore } from './projects.ts';
import { PrefsStore } from './prefs.ts';
import { SessionManager } from './sessions.ts';
import { SessionJournal } from './journal.ts';
import { UsageReader } from './usage.ts';
import { TelemetryReader } from './telemetry.ts';
import { GithubConnection } from './github.ts';
import { LifecycleController } from './lifecycle.ts';
import { createRequestHandler } from './api.ts';
import { createUpgradeHandler } from './ws.ts';

const paths = resolveDataPaths();
const log = createLogger(paths.logFile);
const token = generateToken();
const webDistDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'dist');

const projects = new ProjectStore(paths.projectsFile, log);
const prefs = new PrefsStore(paths.prefsFile, log);
const journal = new SessionJournal(paths.journalFile, paths.previousFile, log);
journal.rotate(); // A previous run's journal becomes previous.json ('crash'-stamped).
const sessions = new SessionManager(log, journal);
const claudeDir = resolveClaudeDir();
const usage = new UsageReader(claudeDir, log);
const telemetry = new TelemetryReader(claudeDir, log);
// GitHub OAuth device flow. client_id from env; absent/empty => "not configured"
// (the feature stays dormant, endpoints answer a clean not-configured signal).
const github = new GithubConnection({
  file: paths.githubFile,
  log,
  clientId: process.env['AI_SM_GITHUB_CLIENT_ID'],
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

const server = createServer(
  createRequestHandler({
    token,
    getPort,
    getStartedAt,
    projects,
    prefs,
    sessions,
    journal,
    usage,
    telemetry,
    github,
    webDistDir,
    log,
  }),
);
server.on('upgrade', createUpgradeHandler({ token, getPort, sessions, lifecycle, log }));

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
    log('error', `failed to write ${paths.runtimeFile}: ${String(err)}`);
    process.exit(1);
  }
  log('info', `listening on 127.0.0.1:${port} (pid ${process.pid}, data dir ${paths.dataDir})`);
  lifecycle.start(); // Startup grace: no window ever connecting must not leave a zombie.
});

server.on('error', (err) => {
  log('error', `server error: ${String(err)}`);
  process.exit(1);
});

let shuttingDown = false;
function shutdown(cause: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log('info', `received ${cause}, shutting down`);
  lifecycle.stop();
  // Journal first (crash safety), then kill: destroy()'s 'user-kill' and the
  // async onExit 'exit' stamps are no-ops on already-'shutdown' entries.
  journal.endAllLive('shutdown');
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

process.on('uncaughtException', (err) => {
  log('error', `uncaught exception: ${err.stack ?? String(err)}`);
  try {
    unlinkSync(paths.runtimeFile);
  } catch {
    // Already gone.
  }
  process.exit(1);
});
