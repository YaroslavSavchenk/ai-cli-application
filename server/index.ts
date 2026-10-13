/**
 * AI CLI Session Manager backend — entry point.
 *
 * Binds 127.0.0.1 ONLY (never 0.0.0.0, never a configured port): the port is
 * the one this data dir last bound (last-port.json, decision D5 2026-09-22)
 * and an OS-assigned one when that is taken. It then atomically writes the
 * discovery file runtime.json (mode 0600) with { port, token, pid, startedAt,
 * appDir }. The file is removed on clean SIGINT/SIGTERM shutdown.
 *
 * The process runs detached (setsid for MVP): nothing depends on stdout;
 * all logging appends to server.log in the data dir. Sessions are
 * server-side objects — a page reload or a brief window close never kills
 * a session; clients reattach with scrollback replayed.
 *
 * Lifetime is bound to UI presence (decided 2026-07-19): the frontend holds
 * a presence WebSocket; when no presence and no session clients remain, a
 * grace timer (LifecycleController) expires into the same clean shutdown as
 * SIGTERM — history 'shutdown', kill PTYs, remove its own runtime.json
 * (runtime-file.ts: only while it still names this process), exit 0. The
 * crash-safe session history (history.ts) lets any ended session be resumed
 * later, on this run or a future one.
 *
 * This file is the composition root — boot order, listen, signal handlers,
 * shutdown, the standby handoff. Construction blocks live beside it, each
 * called at the point it ran from: index-banner.ts (the boot banner),
 * index-stores.ts (stores and watchers), index-update.ts (update checks and
 * the updater), index-restart.ts (the restart wiring); split O8 and Quality Q5.
 *
 * Runs directly on Node 24 native type stripping: erasable syntax only,
 * relative imports carry explicit .ts extensions.
 */
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RuntimeInfo } from '../shared/protocol.ts';
import {
  resolveDataPaths,
  resolveHomeBoundary,
  resolveWebDistDir,
  resolveLogLevel,
  createLogger,
  scoped,
  describeError,
  atomicWriteFile,
  createRefusalLimiter,
  oneLine,
} from './config.ts';
import { choosePortHint, readLastPort, writeLastPort } from './last-port.ts';
import { removeOwnRuntimeFile } from './runtime-file.ts';
import { readServerCommit, readWebBuild } from './buildinfo.ts';
import { readBundleInfo } from './bundle.ts';
import { generateToken } from './auth.ts';
import { subagentsDirFor } from './agents.ts';
import { LifecycleController } from './lifecycle.ts';
import { createRequestHandler, type ApiDeps } from './api.ts';
import { PollTally } from './poll-log.ts';
import { createUpgradeHandler } from './ws.ts';
import { STANDBY_TIMEOUT_MS } from './restart.ts';
import { commitFrontend, discardFrontend } from './webbuild.ts';
import { logBootBanner, logWebBuild } from './index-banner.ts';
import { createStores } from './index-stores.ts';
import { createUpdateWiring } from './index-update.ts';
import { createRestartController } from './index-restart.ts';

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
 * Five things branch on it, all in this file and its index-* pieces: the
 * banner line (index-banner.ts), the update check (index-update.ts), the
 * dependency preflight, what the restart preflight verifies and who it hands
 * the port to (index-restart.ts). Everything else — data dir, ports, sessions, history,
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
// in server/index-stores.ts; the message is already one-lined by
// resolveWebDistDir.
let webDistDir: string;
try {
  webDistDir = resolveWebDistDir(repoRoot);
} catch (err) {
  log('error', `refusing to start: ${err instanceof Error ? err.message : String(err)}`);
  throw err; // unchanged otherwise: uncaught at module eval -> stderr + exit 1.
}

// AI_SM_HOME_OVERRIDE moves the boundary the Files panel's routes are confined
// to (server/fsbrowse.ts). Validated HERE, at boot, for its own sake: the value
// is resolved lazily by that module, so a bad one would otherwise first be seen
// by whichever request happened to touch it — a 500 on a listing rather than a
// refused start. The seam is checked in the same shape as AI_SM_WEB_DIST_DIR
// above, and the REASON reaches server.log before the throw, because a detached
// backend's stderr is /dev/null. The resolved value is deliberately discarded:
// resolveHomeBoundary() is a pure function of the environment and fsbrowse.ts
// calls the same one.
try {
  resolveHomeBoundary();
} catch (err) {
  log('error', `refusing to start: ${err instanceof Error ? err.message : String(err)}`);
  throw err;
}

// ---------------------------------------------------------------------------
// Boot banner. The first lines of every run answer "which code is this?" —
// server commit, server/index.ts mtime, frontend bundle, data dir, log level,
// and every AI_SM_* override in effect. The lines and their reasons live in
// server/index-banner.ts (Quality Q5 split, 2026-10-13).
// ---------------------------------------------------------------------------
const boot = scoped(log, 'boot');
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

/** Set by a restart handoff: printed by the banner, and the standby's parent. */
const restartedFrom = process.env['AI_SM_RESTARTED_FROM'];
logBootBanner(boot, {
  dataDir: paths.dataDir,
  logLevel,
  bundle,
  bundleWarnings,
  serverCommit,
  repoRoot,
  serverDir,
  restartedFrom,
});
if (!standbyWaiting) logWebBuild(boot, webBuild);

// The stores and watchers, and the wipe of what no run may inherit (deferred to
// `go` in a standby): server/index-stores.ts (Quality Q5 split, 2026-10-13).
const {
  projects,
  prefs,
  history,
  keys,
  agents,
  sessions,
  telemetry,
  github,
  resetSessionArtifacts,
  resetUpdateArtifacts,
} = createStores({ log, paths, serverDir, standbyWaiting });
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
 * The successful-poll counter (Quality P4, server/poll-log.ts): one summary
 * line a minute. Owned here so shutdown() and the restart teardown stop it,
 * which writes the last partial window.
 */
const polls = new PollTally({ log: scoped(log, 'http') });

// The update check, the online release check and POST /api/update's
// controller: server/index-update.ts (Quality Q5 split, 2026-10-13). A
// non-loopback AI_SM_UPDATE_API_BASE throws out of this call and refuses the
// start, before listen.
const { releaseChecker, checkUpdate, updateCheck, updater } = createUpdateWiring({
  log,
  boot,
  paths,
  repoRoot,
  serverDir,
  webDistDir,
  bundle,
  serverCommit,
  getStartedAt,
  getWebAsset: () => webBuild.asset,
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
  keys,
  webDistDir,
  serverCommit,
  serverVersion: bundle?.version ?? null,
  installed,
  webAsset: webBuild.asset,
  checkUpdate,
  ...(updateCheck === undefined ? {} : { updateCheck }),
  update: updater,
  log,
  allowRefusalLine,
  polls,
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
 * A hint on a handoff, tried once; a busy port falls straight back to
 * listen(0). It exists because the WebView2 host locks navigation to the exact
 * launch origin, so keeping the port is what lets the window simply reload.
 * Anything that is not a plausible port number is refused loudly and ignored.
 */
const portHintRaw = process.env['AI_SM_PORT_HINT'];
let envPortHint = 0;
if (portHintRaw !== undefined && portHintRaw !== '') {
  const parsed = Number(portHintRaw);
  if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65_535) {
    envPortHint = parsed;
  } else {
    boot(
      'warn',
      `AI_SM_PORT_HINT must be a port number 1-65535, got ${JSON.stringify(oneLine(portHintRaw))}; auto-picking instead`,
    );
  }
}
/**
 * THE PORT TRIED FIRST, and where it came from (decision D5, 2026-09-22):
 * the handoff hint, else the port this data dir last bound
 * (`<dataDir>/last-port.json`, see server/last-port.ts), else 0 — the OS
 * picks. Both hints travel the identical path from here on; `portSource` only
 * decides which sentence the log writes. The file is read ONLY without a
 * handoff hint, so a restart never complains about a file it would ignore.
 */
const lastPort = envPortHint === 0 ? readLastPort(paths.lastPortFile, boot) : null;
const { port: portHint, source: portSource } = choosePortHint(envPortHint, lastPort);
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
  // Remember the port that was really bound — by every run, a restart
  // handoff's child included (it binds the same number, so it writes the same
  // value). Best effort: never fatal, the next start would just auto-pick.
  //
  // ONE EXCEPTION: a REMEMBERED port that fell back is NOT overwritten. What
  // holds that number is usually another process's outgoing connection using
  // it as its ephemeral source port for a few seconds; writing the auto-picked
  // port instead would move the origin permanently and orphan the tab layout
  // the sticky port exists to keep. So the fallback is for this run only and
  // the next start tries the remembered port again. A HANDOFF hint that fell
  // back still writes — that window's origin is lost either way.
  const keepRememberedPort = hintFellBack && portSource === 'last';
  if (!keepRememberedPort) writeLastPort(paths.lastPortFile, port, boot);
  if (hintFellBack) {
    boot(
      'warn',
      portSource === 'last'
        ? `last port ${portHint} busy, auto-picked ${port}, keeping ${portHint} for next time`
        : `port hint ${portHint} busy, auto-picked ${port}`,
    );
  } else if (portSource === 'last') {
    boot('info', `listening on the last port ${port}`);
  } else if (portSource === 'handoff') {
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
  // A listen error while trying the first port is the one recoverable case:
  // the port belongs to someone else (EADDRINUSE is the expected one, but
  // neither a handoff hint nor a remembered port is trusted enough to die on,
  // so ANY listen failure falls back).
  if (portHint !== 0 && !hintFellBack && !listening) {
    hintFellBack = true;
    boot(
      'warn',
      `listening on the ${portSource === 'last' ? 'last' : 'hinted'} port ${portHint} failed: ${describeError(err)}`,
    );
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
  // After resetSessionArtifacts() on both paths (module load for a normal boot,
  // the `go` handler for a standby), so the directory being watched is the one
  // this run's sessions write into.
  telemetry.start((id, snapshot, transcript) => {
    sessions.setTelemetry(id, snapshot);
    // B7: the one place a transcript path is known. It is UNTRUSTED (the
    // snapshot is a file any local process can write), so subagentsDirFor()
    // refuses everything that is not a real transcript inside Claude Code's
    // own projects root before any directory is opened.
    //
    // Only for a session that is still RUNNING: the watcher fires for any
    // snapshot file in the directory, and one written just before a session
    // exited can arrive a debounce (or a poll) after onExit already untracked
    // it — tracking then would never be undone.
    if (transcript !== undefined && sessions.isLive(id)) {
      const dir = subagentsDirFor(transcript, paths.claudeProjectsDir);
      if (dir !== null) agents.track(id, dir);
      // server.log is the only diagnostic channel this process has: a refused
      // path must not be silent, or "the table never appears" has no trace.
      // oneLine is belt and braces — the value already passed a control-char
      // check on the way out of the snapshot.
      else log('debug', `[agents] ${id}: transcript path refused: ${oneLine(transcript)}`);
    }
  });
  agents.start((id, report) => sessions.setReport(id, report));
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
  logWebBuild(boot, webBuild);
}

// ---------------------------------------------------------------------------
// Manual restart: same-port handoff to a fresh process (POST /api/restart).
// The sequence and its reasons live in server/restart.ts; this is only the
// wiring to the real OS.
// ---------------------------------------------------------------------------
// The wiring itself lives in server/index-restart.ts (O8 split, 2026-09-23).
const restart = createRestartController({
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
  polls,
  server,
  upgrade,
  openSockets,
  wsSockets,
  onBuildSpawn: (child) => {
    buildChild = child;
  },
});
apiDeps.restart = restart;

/** The vite process of a running preflight build, while there is one. */
let buildChild: ChildProcess | undefined;

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
  telemetry.stop();
  agents.stop();
  releaseChecker?.stop();
  polls.stop();
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
  removeOwnRuntimeFile(paths.runtimeFile, { pid: process.pid, startedAt }, log);
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
    removeOwnRuntimeFile(paths.runtimeFile, { pid: process.pid, startedAt }, log);
  }
  process.exit(1);
});
