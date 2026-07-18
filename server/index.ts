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
 * server-side objects — closing every browser window never kills a session;
 * only server shutdown or DELETE does.
 *
 * Runs directly on Node 24 native type stripping: erasable syntax only,
 * relative imports carry explicit .ts extensions.
 */
import { createServer } from 'node:http';
import { unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RuntimeInfo } from '../shared/protocol.ts';
import { resolveDataPaths, createLogger, atomicWriteFile } from './config.ts';
import { generateToken } from './auth.ts';
import { ProjectStore } from './projects.ts';
import { SessionManager } from './sessions.ts';
import { createRequestHandler } from './api.ts';
import { createUpgradeHandler } from './ws.ts';

const paths = resolveDataPaths();
const log = createLogger(paths.logFile);
const token = generateToken();
const webDistDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'dist');

const projects = new ProjectStore(paths.projectsFile, log);
const sessions = new SessionManager(log);

let port = 0;
const getPort = (): number => port;

const server = createServer(
  createRequestHandler({ token, getPort, projects, sessions, webDistDir, log }),
);
server.on('upgrade', createUpgradeHandler({ token, getPort, sessions, log }));

server.listen(0, '127.0.0.1', () => {
  const addr = server.address();
  if (addr === null || typeof addr !== 'object') {
    log('error', 'listen returned no address, exiting');
    process.exit(1);
  }
  port = addr.port;
  const runtime: RuntimeInfo = {
    port,
    token,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
  try {
    atomicWriteFile(paths.runtimeFile, JSON.stringify(runtime, null, 2) + '\n');
  } catch (err) {
    log('error', `failed to write ${paths.runtimeFile}: ${String(err)}`);
    process.exit(1);
  }
  log('info', `listening on 127.0.0.1:${port} (pid ${process.pid}, data dir ${paths.dataDir})`);
});

server.on('error', (err) => {
  log('error', `server error: ${String(err)}`);
  process.exit(1);
});

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log('info', `received ${signal}, shutting down`);
  try {
    unlinkSync(paths.runtimeFile);
  } catch {
    // Already gone.
  }
  sessions.destroyAll();
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
