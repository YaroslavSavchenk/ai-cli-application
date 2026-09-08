/**
 * Rebuilding the frontend as part of a restart (server/restart.ts, preflight
 * step 2).
 *
 * WHY (open decision closed 2026-09-08, user's call: the update must be
 * "bulletproof … flawless"): `web/dist` is gitignored, so a `git pull` moves
 * `web/src` and leaves the built bundle exactly where it was. A restart that
 * only re-executes the server code would come back serving the OLD screens,
 * with the update pill still lit and nothing saying why. So the restart builds
 * the frontend itself, and it does so BEFORE anything is torn down: a build
 * that fails refuses the restart instead of breaking a working app.
 *
 * NEVER A WINDOW WITHOUT A UI, AND NEVER A NEW UI ON THE OLD BACKEND. The build
 * goes into `web/dist-next` and stays there: `buildFrontend` only builds and
 * VERIFIES (index.html + assets/index-*.js + build-id.json). The swap is a
 * separate call, `swapFrontend`, which the restart makes only once the
 * replacement backend has reported ready — two renames, `dist` → `dist-prev`
 * and `dist-next` → `dist`, with a restore if the second one fails. Any refusal
 * in between calls `discardFrontend`, so `web/dist-next` never survives a
 * refused restart.
 *
 * `dist-prev` OUTLIVES THE SWAP on purpose (2026-09-08): the standby child can
 * still be found dead in the window between the swap and the teardown, and that
 * answers 422 — which the docs promise leaves `web/dist` UNCHANGED. So the
 * backup stays until the restart is committed: `revertFrontend` puts the old
 * build back on that path, `commitFrontend` drops the backup once `go` is out
 * and the child owns the served directory.
 *
 * SWAPPING IS NOT A BLIND RENAME. `webDistDir` comes from AI_SM_WEB_DIST_DIR,
 * and a careless value would make the swap rename and then DELETE whatever
 * directory it names. So the directory being moved aside must look like a
 * frontend build (index.html + an assets/index-*.js entry bundle) or not exist
 * at all; anything else refuses the restart with nothing renamed.
 *
 * SECURITY. Vite is run as `process.execPath node_modules/vite/bin/vite.js` —
 * this very node binary plus an argv ARRAY. No shell, no PATH lookup, no
 * interpolation of anything a caller controls (nothing here comes from a
 * request at all: POST /api/restart reads no body). Its stdout/stderr are
 * captured as a BOUNDED tail and one-lined before they reach server.log.
 */
import { spawn, type SpawnOptions, type ChildProcess } from 'node:child_process';
import { existsSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { describeError, oneLine, type Logger } from './config.ts';
import { readWebBuild } from './buildinfo.ts';
import {
  REFUSED_BUILD,
  REFUSED_DEPENDENCIES,
  RestartRefusal,
  type FrontendBuild,
  type FrontendSwap,
} from './restart.ts';

/** A frontend build that takes longer than this is hung; kill it and refuse. */
export const BUILD_TIMEOUT_MS = 120_000;
/** How long a killed vite gets to die before SIGKILL. */
export const BUILD_KILL_GRACE_MS = 2_000;
/** Bytes of vite's combined stdout+stderr kept for the log (the TAIL). */
export const BUILD_OUTPUT_TAIL_BYTES = 4_096;

export interface WebBuildOptions {
  /** Repo root: holds node_modules/ and vite.config.ts, and is vite's cwd. */
  repoRoot: string;
  /** The directory being SERVED. `<dir>-next` and `<dir>-prev` sit beside it. */
  webDistDir: string;
  /** Already scoped by the caller (`[restart]`). */
  log: Logger;
  /** Seams for tests: no real vite, no real clock. */
  spawnFn?: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;
  now?: () => number;
  timeoutMs?: number;
  /**
   * The vite process, handed to the caller the moment it exists. server/index.ts
   * keeps it so an ordinary shutdown (SIGTERM, idle grace) during the up-to-120 s
   * build can SIGTERM it instead of leaving it writing into `web/dist-next`
   * after this process is gone.
   */
  onSpawn?: (child: ChildProcess) => void;
}

/** `<dist>-next` (the staged build) and `<dist>-prev` (the swap's backup). */
function stagingDirs(webDistDir: string): { nextDir: string; prevDir: string } {
  const parent = dirname(webDistDir);
  const name = basename(webDistDir);
  return { nextDir: join(parent, `${name}-next`), prevDir: join(parent, `${name}-prev`) };
}

/** rm -rf that never throws: a leftover directory must not fail a restart. */
function removeQuietly(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // Best effort — the next build empties its own output dir anyway.
  }
}

/**
 * Keep only the last `max` bytes of everything the child wrote. Bounded on the
 * way IN, so a runaway build cannot grow this process's memory either.
 */
function tailCollector(max: number): {
  push: (chunk: Buffer) => void;
  text: () => string;
  bytes: () => number;
} {
  let buf = Buffer.alloc(0);
  let bytes = 0;
  return {
    push: (chunk: Buffer): void => {
      bytes += chunk.length;
      buf = Buffer.concat([buf, chunk]);
      if (buf.length > max) buf = buf.subarray(buf.length - max);
    },
    // One-lined and whitespace-collapsed: server.log is one line per event, and
    // vite draws progress with control characters.
    text: (): string => oneLine(buf.toString('utf8')).replace(/\s+/g, ' ').trim(),
    bytes: (): number => bytes,
  };
}

/**
 * Build the frontend into `<dist>-next` and verify it. Resolves with the new
 * build's identity, leaving the output STAGED — nothing is served from it yet.
 * Throws a RestartRefusal (REFUSED_DEPENDENCIES when vite itself is missing,
 * REFUSED_BUILD otherwise) with `web/dist` untouched and `web/dist-next` gone.
 */
export async function buildFrontend(opts: WebBuildOptions): Promise<FrontendBuild> {
  const now = opts.now ?? ((): number => Date.now());
  const timeoutMs = opts.timeoutMs ?? BUILD_TIMEOUT_MS;
  const spawnFn = opts.spawnFn ?? spawn;
  const log = opts.log;

  const { nextDir } = stagingDirs(opts.webDistDir);
  const viteBin = join(opts.repoRoot, 'node_modules', 'vite', 'bin', 'vite.js');

  if (!existsSync(viteBin)) {
    // Not a build failure: the dependency tree is not installed. Same remedy,
    // same message as the node_modules check that runs before this.
    removeQuietly(nextDir);
    throw new RestartRefusal(REFUSED_DEPENDENCIES, 'node_modules/vite/bin/vite.js is missing');
  }

  removeQuietly(nextDir);
  const started = now();
  log('debug', `building the frontend into ${oneLine(nextDir)}`);

  const tail = tailCollector(BUILD_OUTPUT_TAIL_BYTES);
  let outcome: { ok: true } | { ok: false; why: string };
  try {
    outcome = await new Promise<{ ok: true } | { ok: false; why: string }>((resolve) => {
      // NEVER a shell: this node binary + an argv array, cwd = the repo root so
      // vite finds the ROOT config (the 2026-09-08 incident was a build run
      // from web/ without it, shipping a bare `__BUILD_ID__`).
      const child = spawnFn(process.execPath, [viteBin, 'build', '--outDir', nextDir, '--emptyOutDir'], {
        cwd: opts.repoRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      });
      opts.onSpawn?.(child);
      let settled = false;
      const finish = (result: { ok: true } | { ok: false; why: string }): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => {
        log('error', `the frontend build did not finish within ${timeoutMs}ms; killing it`);
        try {
          child.kill('SIGTERM');
        } catch {
          // Already gone.
        }
        // Escalation outlives the refusal on purpose: the promise resolves
        // now, but a vite that ignores SIGTERM must still be reaped.
        setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            // Already gone.
          }
        }, BUILD_KILL_GRACE_MS).unref();
        finish({ ok: false, why: `timed out after ${timeoutMs}ms` });
      }, timeoutMs);
      timer.unref();
      child.stdout?.on('data', (chunk: Buffer) => tail.push(chunk));
      child.stderr?.on('data', (chunk: Buffer) => tail.push(chunk));
      child.on('error', (err) => finish({ ok: false, why: `could not run vite: ${describeError(err)}` }));
      child.on('close', (code, signal) => {
        if (code === 0) {
          finish({ ok: true });
          return;
        }
        finish({ ok: false, why: `vite exited code=${code} signal=${signal}` });
      });
    });
  } catch (err) {
    removeQuietly(nextDir);
    throw new RestartRefusal(REFUSED_BUILD, describeError(err));
  }

  // The vite output is the ONLY thing here that is not a constant, so it is
  // bounded, one-lined and reported with its full byte count beside the tail.
  const outputLine = `vite output ${tail.bytes()} bytes, last ${BUILD_OUTPUT_TAIL_BYTES} bytes: ${tail.text()}`;
  if (!outcome.ok) {
    log('error', `the frontend build failed (${outcome.why})`);
    log('error', outputLine);
    removeQuietly(nextDir);
    throw new RestartRefusal(REFUSED_BUILD, outcome.why);
  }
  log('debug', outputLine);

  // A zero exit is not proof: verify the three files that make a build usable.
  const built = readWebBuild(nextDir);
  if (built.indexMtime === null || built.asset === null || built.buildId === null) {
    log(
      'error',
      `the frontend build produced an incomplete ${oneLine(nextDir)}: index.html ${
        built.indexMtime === null ? 'missing' : 'ok'
      }, entry bundle ${oneLine(built.asset ?? 'missing')}, build id ${built.buildId ?? 'missing'}`,
    );
    removeQuietly(nextDir);
    throw new RestartRefusal(REFUSED_BUILD, 'the build output is incomplete');
  }
  const ms = now() - started;
  log(
    'debug',
    `the frontend build is staged in ${oneLine(nextDir)} (build id ${built.buildId}, ` +
      `entry bundle ${oneLine(built.asset)}, ${ms}ms); it is not served until the swap`,
  );
  return { buildId: built.buildId, asset: built.asset, ms, note: 'staged, not served yet' };
}

/**
 * Does this directory hold a frontend build — a page plus the bundle it loads?
 *
 * `build-id.json` is deliberately NOT required (2026-09-08): a `web/dist` built
 * before that file existed is still a real frontend build, and demanding it
 * here would refuse every restart on such a tree forever. The NEW build is
 * still verified with the id in `buildFrontend`; this guard only decides
 * whether a directory may be moved aside.
 */
function looksLikeFrontendBuild(dir: string): boolean {
  return existsSync(join(dir, 'index.html')) && readWebBuild(dir).asset !== null;
}

/**
 * Swap the STAGED build in: `dist` → `dist-prev`, `dist-next` → `dist`. Called
 * only after the replacement backend has reported ready, so a refusal anywhere
 * before it leaves the user on the old screens AND the old backend — never a
 * new UI talking to a process that predates it.
 *
 * `dist-prev` is KEPT: until `commitFrontend` the restart can still be refused
 * (a standby found dead before the teardown), and `revertFrontend` needs the
 * backup to keep the "every 422 leaves web/dist unchanged" promise.
 *
 * REFUSES rather than renaming a directory that is not a frontend build: this
 * path deletes the backup it makes, and `webDistDir` is an env-supplied value.
 *
 * Throws a RestartRefusal (REFUSED_BUILD) having put the old build back.
 *
 * RETURNS WHAT IT REPLACED (`hadPrevious`): with no `web/dist` at all there is
 * no `dist-prev` to restore, and `revertFrontend` has to be told so — otherwise
 * a refusal after the swap leaves the NEW build being served by the OLD
 * backend, which is the one thing this order exists to prevent.
 */
export function swapFrontend(opts: Pick<WebBuildOptions, 'webDistDir' | 'log'>): FrontendSwap {
  const { nextDir, prevDir } = stagingDirs(opts.webDistDir);
  const log = opts.log;

  const hadDist = existsSync(opts.webDistDir);
  if (hadDist && !looksLikeFrontendBuild(opts.webDistDir)) {
    // Nothing is renamed and nothing is deleted: the served path names
    // something this code has no business moving.
    log(
      'error',
      `refusing to swap the frontend: ${oneLine(opts.webDistDir)} is not a frontend build ` +
        'directory (no index.html and entry bundle); nothing was renamed',
    );
    removeQuietly(nextDir);
    throw new RestartRefusal(REFUSED_BUILD, 'the served directory is not a frontend build');
  }
  removeQuietly(prevDir);
  if (hadDist) {
    try {
      renameSync(opts.webDistDir, prevDir);
    } catch (err) {
      log('error', `could not move the old frontend aside: ${describeError(err)}`);
      removeQuietly(nextDir);
      throw new RestartRefusal(REFUSED_BUILD, 'the old build could not be moved aside');
    }
  }
  try {
    renameSync(nextDir, opts.webDistDir);
  } catch (err) {
    log('error', `could not move the new frontend into place: ${describeError(err)}`);
    if (hadDist) {
      try {
        renameSync(prevDir, opts.webDistDir); // Put the working UI back.
      } catch (restoreErr) {
        // The one genuinely bad outcome: say so loudly, in one line.
        log('error', `and the OLD frontend could not be restored: ${describeError(restoreErr)}`);
      }
    }
    removeQuietly(nextDir);
    throw new RestartRefusal(REFUSED_BUILD, 'the new build could not be moved into place');
  }
  // prevDir stays: commitFrontend drops it, revertFrontend needs it.
  return { hadPrevious: hadDist };
}

/**
 * Put the swapped-in build back: `dist` → `dist-next`, `dist-prev` → `dist`,
 * `dist-next` dropped. Runs on the ONE refusal that can happen after the swap —
 * the standby found dead just before the teardown — so that 422 keeps the
 * promise every other refusal keeps: `web/dist` is exactly what it was.
 *
 * Never throws: this is a recovery path, and a served directory is better than
 * an exception. Everything it cannot do is one log line.
 */
export function revertFrontend(opts: Pick<WebBuildOptions, 'webDistDir' | 'log'> & FrontendSwap): void {
  const { nextDir, prevDir } = stagingDirs(opts.webDistDir);
  const log = opts.log;

  if (!opts.hadPrevious) {
    // The swap moved nothing aside because there was nothing there. Restoring
    // that state means the served directory is ABSENT again — leaving the new
    // build would hand the old process screens built for its successor.
    removeQuietly(nextDir);
    if (existsSync(opts.webDistDir)) {
      try {
        renameSync(opts.webDistDir, nextDir); // Out of the served path first.
      } catch (err) {
        log('error', `could not take the new frontend back out of ${oneLine(opts.webDistDir)}: ${describeError(err)}`);
        return;
      }
      removeQuietly(nextDir);
    }
    log(
      'info',
      `the refused restart changed nothing: there was no frontend in ${oneLine(opts.webDistDir)} ` +
        'before it and there is none now',
    );
    return;
  }
  if (!existsSync(prevDir)) {
    // The swap did move a build aside, but the backup is gone (removed under
    // us). Removing the new build here would leave the running process serving
    // nothing at all.
    log('warn', `no previous frontend to restore; ${oneLine(opts.webDistDir)} is left as it is`);
    return;
  }
  removeQuietly(nextDir);
  const hasDist = existsSync(opts.webDistDir);
  if (hasDist) {
    try {
      renameSync(opts.webDistDir, nextDir);
    } catch (err) {
      log('error', `could not move the new frontend aside to restore the old one: ${describeError(err)}`);
      return;
    }
  }
  try {
    renameSync(prevDir, opts.webDistDir);
  } catch (err) {
    log('error', `could not put the old frontend back: ${describeError(err)}`);
    if (hasDist) {
      try {
        renameSync(nextDir, opts.webDistDir); // Better the new build than none.
      } catch {
        // Already reported: the line above is the one that matters.
      }
    }
    return;
  }
  removeQuietly(nextDir);
  log('info', `the old frontend is back in ${oneLine(opts.webDistDir)}: the refused restart changed nothing`);
}

/**
 * Commit the swap by dropping `dist-prev`. Called once `go` is out: the old
 * process is leaving and the child owns the served directory, so there is
 * nothing left that could revert. Idempotent — the child runs it too, as a
 * belt-and-braces cleanup for a parent that died between the two.
 */
export function commitFrontend(opts: Pick<WebBuildOptions, 'webDistDir'>): void {
  removeQuietly(stagingDirs(opts.webDistDir).prevDir);
}

/**
 * Drop a staged build. Every refusal after a successful build runs this, so
 * `web/dist-next` never outlives the restart that created it — and the next
 * restart can never verify leftovers from this one.
 *
 * A leftover `dist-prev` goes too, but ONLY while the served directory is in
 * place: when `dist` is missing, `dist-prev` is the last copy of the UI and a
 * failed restore is exactly the case that put it there.
 */
export function discardFrontend(opts: Pick<WebBuildOptions, 'webDistDir'>): void {
  const { nextDir, prevDir } = stagingDirs(opts.webDistDir);
  removeQuietly(nextDir);
  if (existsSync(opts.webDistDir)) removeQuietly(prevDir);
}
