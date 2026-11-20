/**
 * Entry of the pty-host process: `node server/pty-host-main.ts <dataDir>`.
 *
 * Nocturne D9 P2 (.claude/plans/nocturne/PLAN-D9.md § Defaults). Started
 * detached by the backend (server/pty-host-client.ts `startPtyHost`), one per
 * data dir; it outlives backend restarts, updates and crashes so the PTYs
 * (and the CLIs in them) do too. The serving is server/pty-host-server.ts;
 * this file only checks where it runs, binds, writes `pty-host.json` and
 * wires the signals.
 *
 * Exit codes (server/pty-host-wire.ts `PTY_HOST_EXIT`): 0 after a shutdown, 2 when the data
 * dir or the socket path is refused (said on stderr only: nothing is written
 * into a directory that failed the check), 3 when another pty-host already
 * holds this data dir (its instance lock — server/pty-host-server.ts).
 *
 * One of four flat pieces (CONTRIBUTING: `server/` stays flat): this entry,
 * server/pty-host-server.ts (serving), server/pty-host-wire.ts (what both
 * sides share), server/pty-host-client.ts (the backend's side).
 *
 * `pty-host.log` honours AI_SM_LOG_LEVEL exactly as server.log does.
 *
 * Every import is static, so the whole program is in memory before the first
 * spawn: an installer that prunes this version dir later does not hurt it.
 */
import { unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateToken } from './auth.ts';
import { atomicWriteFile, createLogger, describeError, resolveLogLevel } from './config.ts';
import { PtyHostServer, resolveHostBuild, resolveHostTimers } from './pty-host-server.ts';
import { PTY_HOST_EXIT, PTY_HOST_PROTOCOL, dataDirRefusal, ptyHostPaths, readPtyHostFile } from './pty-host-wire.ts';

const dataDir = process.argv[2];
if (dataDir === undefined || !dataDir.startsWith('/')) {
  process.stderr.write('pty-host: usage: pty-host-main.ts <absolute data dir>\n');
  process.exit(PTY_HOST_EXIT.refused);
}
const refusal = dataDirRefusal(dataDir);
if (refusal !== undefined) {
  process.stderr.write(`pty-host: refusing to start: ${refusal}\n`);
  process.exit(PTY_HOST_EXIT.refused);
}

const paths = ptyHostPaths(dataDir);
const logLevel = resolveLogLevel();
const log = createLogger(paths.log, logLevel.level);
if (!logLevel.valid) {
  log('warn', `AI_SM_LOG_LEVEL ${JSON.stringify(logLevel.raw?.slice(0, 32))} is not one of debug|info|warn|error; logging ${logLevel.level}`);
}
const token = generateToken();
const build = resolveHostBuild();
const timers = resolveHostTimers(log);
const startedAt = new Date().toISOString();
/** The app (or version) dir this code runs from: the installer keeps it while this pid lives (P5). */
const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Remove `pty-host.json` only while it still names this process. */
function removeStateFile(): void {
  if (readPtyHostFile(dataDir)?.pid !== process.pid) return;
  try {
    unlinkSync(paths.stateFile);
  } catch {
    // Already gone.
  }
}

const host = new PtyHostServer({
  dataDir,
  socketPath: paths.socket,
  token,
  build,
  startedAt,
  timers,
  log,
  exit: (reason) => {
    host.removeSocket();
    removeStateFile();
    log('info', `exiting (${reason})`);
    process.exit(0);
  },
});

process.on('SIGTERM', () => host.shutdown('SIGTERM'));
process.on('SIGINT', () => host.shutdown('SIGINT'));
// No controlling terminal (started detached), so a SIGHUP is a stray: it
// must not end the process that holds every session.
process.on('SIGHUP', () => log('info', 'SIGHUP ignored'));
process.on('uncaughtException', (err) => {
  // The table may be in any state now. Leaving the PTYs to a dead holder
  // would keep CLIs (and their API keys) running with nobody to end them.
  log('error', `uncaught exception, shutting down: ${describeError(err)}`);
  host.shutdown('uncaught exception');
});

log(
  'info',
  `pty-host starting (pid ${process.pid}, proto ${PTY_HOST_PROTOCOL}, build ${build}, ` +
    `idle ${timers.idleMs}ms, orphan grace ${timers.orphanMs}ms)`,
);
// Checked again right before the bind: the first check ran before the logger
// and the lock; the directory must still be ours when the socket goes in it.
const late = dataDirRefusal(dataDir);
if (late !== undefined) {
  log('error', `refusing to start: ${late}`);
  process.exit(PTY_HOST_EXIT.refused);
}
let bound: 'bound' | 'taken';
try {
  bound = await host.listen();
} catch (err) {
  log('error', `cannot bind ${paths.socket}: ${describeError(err)}`);
  process.exit(PTY_HOST_EXIT.refused);
}
if (bound === 'taken') {
  log('info', 'another pty-host holds this data dir; exiting');
  process.exit(PTY_HOST_EXIT.otherInstance);
}
atomicWriteFile(
  paths.stateFile,
  JSON.stringify({ pid: process.pid, startedAt, proto: PTY_HOST_PROTOCOL, build, appDir, token }, null, 2) + '\n',
);
log('info', `listening on ${paths.socket}`);
