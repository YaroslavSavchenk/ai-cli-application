/**
 * Shared fixtures for the manual-restart tests (server/restart.ts,
 * server/webbuild.ts, POST /api/restart): `tests/server/restart.test.ts` and
 * its `restart-*.test.ts` siblings.
 *
 * Temp dirs and a private copy of the repo's built web/dist (a REAL restart
 * rebuilds and swaps what it serves — never the working tree's own web/dist);
 * the RestartController harness with every OS-touching dependency injected and
 * a fake clock; a bound on a promise that turns a hang into a failure; a fake
 * `vite build` and a repo root to run it in; a ChildProcess stand-in for the
 * standby starter; and runtime.json / pid probes for real processes.
 */
import { EventEmitter } from 'node:events';
import { type ChildProcess } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RuntimeInfo } from '../../shared/protocol.ts';
import {
  RestartController,
  RestartRefusal,
  REFUSED_BUILD,
  type FrontendBuild,
  type RestartDeps,
} from '../../server/restart.ts';
import { readWebBuild } from '../../server/buildinfo.ts';
import { projectRoot, makeTempDirSync } from './helpers.ts';

export function tempDir(): string {
  return makeTempDirSync('ai-sm-restart-');
}

/**
 * A private copy of the repo's built frontend for a REAL restart to chew on.
 *
 * A restart REBUILDS and SWAPS the directory it serves. Without this the
 * real-restart tests would rebuild `web/dist` in the working tree on every
 * `npm test`: a developer's running backend would light its update pill
 * after every test run, and for the length of the two renames `web/dist` would
 * not exist at all — while other test files (tests/server/auth.test.ts) fetch `/`.
 * AI_SM_WEB_DIST_DIR points the server at this copy instead; `dist-next` and
 * `dist-prev` are created beside it, inside the temp dir.
 */
export function webDistCopy(): { dir: string; served: string; remove: () => void } {
  const dir = makeTempDirSync('ai-sm-webdist-');
  const served = join(dir, 'dist');
  const source = join(projectRoot, 'web', 'dist');
  if (existsSync(source)) cpSync(source, served, { recursive: true });
  else mkdirSync(served, { recursive: true });
  return { dir, served, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

/** What the repo's own web/dist IS, so a test can prove it did not move. */
export function repoWebDist(): { buildId: string | null; asset: string | null; indexMtime: string | null } {
  return readWebBuild(join(projectRoot, 'web', 'dist'));
}

export interface Harness {
  controller: RestartController;
  events: string[];
  spawned: { portHint: number; restartedFrom: number }[];
  exits: number[];
  logLines: string[];
}

/** The build a stubbed preflight reports — never a real vite run. */
export const FAKE_BUILD: FrontendBuild = { buildId: '20260908-1200-abc1234', asset: 'assets/index-New.js', ms: 42 };

export const OLD_PID = 4242;
export const OLD_PORT = 41000;

export function harness(opts: {
  /** runtime.json contents, evaluated on every poll. */
  runtime?: () => RuntimeInfo | undefined;
  healthy?: (port: number) => boolean;
  /** Preflight 1: false = node_modules out of step. */
  depsReady?: boolean;
  /** Preflight 2: the reason a build refuses, or undefined for a good build. */
  buildRefusal?: string;
  /** Preflight 3: the standby never reports ready. */
  standbyThrows?: boolean;
  /** Preflight 3b: the standby reported ready and then died before the teardown. */
  standbyDies?: 'before-swap' | 'after-swap';
  /** Preflight 4: the swap of the staged build fails. */
  swapThrows?: boolean;
  /** Preflight 4b: was there a served build for the swap to move aside? */
  hadPreviousDist?: boolean;
  /** The handoff itself: `go` throws (the standby died between ready and go). */
  goThrows?: boolean;
  teardownThrows?: boolean;
  timeoutMs?: number;
} = {}): Harness {
  const events: string[] = [];
  const spawned: { portHint: number; restartedFrom: number }[] = [];
  const exits: number[] = [];
  const logLines: string[] = [];
  // A fake clock the fake sleep advances: a 15 s timeout costs no real time.
  let clock = 1_000_000;
  const childRuntime: RuntimeInfo = {
    port: OLD_PORT,
    token: 'unused',
    pid: OLD_PID + 1,
    startedAt: '2026-09-06T12:00:00.000Z',
  };
  const deps: RestartDeps = {
    log: (level, message) => logLines.push(`[${level}] ${message}`),
    counts: () => ({ sessions: 2, presence: 1, attached: 3 }),
    port: () => OLD_PORT,
    pid: OLD_PID,
    teardown: () => {
      events.push('teardown');
      if (opts.teardownThrows === true) throw new Error('server.close blew up');
    },
    dependenciesReady: () => {
      events.push('deps');
      return opts.depsReady ?? true;
    },
    buildFrontend: () => {
      events.push('build');
      if (opts.buildRefusal !== undefined) {
        return Promise.reject(new RestartRefusal(opts.buildRefusal, 'vite exited code=1 signal=null'));
      }
      return Promise.resolve(FAKE_BUILD);
    },
    swapFrontend: () => {
      events.push('swap');
      if (opts.swapThrows === true) {
        throw new RestartRefusal(REFUSED_BUILD, 'the new build could not be moved into place');
      }
      return { hadPrevious: opts.hadPreviousDist ?? true };
    },
    revertFrontend: (swap) => events.push(`revert(hadPrevious=${swap.hadPrevious})`),
    commitFrontend: () => events.push('commit'),
    discardFrontend: () => events.push('discard'),
    startStandby: (env) => {
      events.push('standby');
      if (opts.standbyThrows === true) return Promise.reject(new Error('the standby exited early'));
      spawned.push(env);
      return Promise.resolve({
        pid: 9999,
        // 'before-swap' is caught inside the preflight, 'after-swap' by the
        // last look the controller takes before the teardown.
        dead: () => {
          if (opts.standbyDies === 'before-swap') return true;
          return opts.standbyDies === 'after-swap' && events.includes('swap');
        },
        stop: () => events.push('stop'),
        go: () => {
          events.push('go');
          if (opts.goThrows === true) throw new Error('ERR_IPC_CHANNEL_CLOSED');
        },
      });
    },
    readRuntime: opts.runtime ?? ((): RuntimeInfo => childRuntime),
    probeHealth: (port) => Promise.resolve(opts.healthy?.(port) ?? true),
    exit: (code) => exits.push(code),
    now: () => clock,
    sleep: (ms) => {
      clock += ms;
      return Promise.resolve();
    },
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  };
  return { controller: new RestartController(deps), events, spawned, exits, logLines };
}

/**
 * Await `p`, but never for longer than `ms`.
 *
 * The 409 guard is what the two 409 tests in tests/server/restart.test.ts are
 * FOR, and a regression that removes it does not turn them red — it makes the
 * second request run the whole sequence, block on the very gate the first
 * request is holding, and hang `npm test` forever. (Measured: dropping
 * `|| this.#preflighting` from server/restart.ts hangs the file instead of
 * failing it.) A hang is a strictly worse failure mode than an assertion, so
 * this bound turns it back into one.
 */
export async function within<T>(p: Promise<T>, what: string, ms = 5_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms}ms`)), ms);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** A fake `vite build`: writes what `write` says, then exits with `code`. */
export function fakeVite(behaviour: {
  code: number;
  stdout?: string;
  stderr?: string;
  write?: (outDir: string) => void;
}): (cmd: string, args: string[]) => ChildProcess {
  return (_cmd: string, args: string[]): ChildProcess => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: () => boolean;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = (): boolean => true;
    const outDir = args[args.indexOf('--outDir') + 1] as string;
    setImmediate(() => {
      behaviour.write?.(outDir);
      if (behaviour.stdout !== undefined) child.stdout.emit('data', Buffer.from(behaviour.stdout));
      if (behaviour.stderr !== undefined) child.stderr.emit('data', Buffer.from(behaviour.stderr));
      child.emit('close', behaviour.code, null);
    });
    return child as unknown as ChildProcess;
  };
}

/** A complete build output: the three files webbuild.ts insists on. */
export function writeBuild(outDir: string, id: string, asset = 'index-NEWNEW00.js'): void {
  mkdirSync(join(outDir, 'assets'), { recursive: true });
  writeFileSync(join(outDir, 'index.html'), `<!doctype html><!--${id}-->`);
  writeFileSync(join(outDir, 'assets', asset), '//new');
  writeFileSync(join(outDir, 'build-id.json'), `{"id":"${id}"}\n`);
}

/** A repo root with an installed vite and an already-built web/dist. */
export function buildFixture(): { root: string; dist: string; lines: string[] } {
  const root = tempDir();
  mkdirSync(join(root, 'node_modules', 'vite', 'bin'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'vite', 'bin', 'vite.js'), '// not run in these tests');
  const dist = join(root, 'web', 'dist');
  writeBuild(dist, '20260101-0000-oldold0', 'index-OLDOLD00.js');
  return { root, dist, lines: [] };
}

/** A ChildProcess stand-in: nothing is spawned, every call is recorded. */
export function fakeChild(): ChildProcess & {
  sent: unknown[];
  killed: string[];
  disconnects: number;
  unrefs: number;
  connectedFlag: boolean;
} {
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
  child['pid'] = 31337;
  child['sent'] = [];
  child['killed'] = [];
  child['disconnects'] = 0;
  child['unrefs'] = 0;
  child['connectedFlag'] = true;
  Object.defineProperty(child, 'connected', { get: () => child['connectedFlag'] });
  child['send'] = (message: unknown, cb?: (err: Error | null) => void): boolean => {
    if (child['connectedFlag'] !== true) {
      cb?.(new Error('ERR_IPC_CHANNEL_CLOSED'));
      return false;
    }
    (child['sent'] as unknown[]).push(message);
    cb?.(null);
    return true;
  };
  child['kill'] = (signal?: string): boolean => {
    (child['killed'] as string[]).push(signal ?? 'SIGTERM');
    return true;
  };
  child['disconnect'] = (): void => {
    child['disconnects'] = (child['disconnects'] as number) + 1;
  };
  child['unref'] = (): void => {
    child['unrefs'] = (child['unrefs'] as number) + 1;
  };
  return child as unknown as ChildProcess & {
    sent: unknown[];
    killed: string[];
    disconnects: number;
    unrefs: number;
    connectedFlag: boolean;
  };
}

/** Read a runtime.json straight from disk (the launcher's own view). */
export function readRuntime(file: string): RuntimeInfo | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as RuntimeInfo;
  } catch {
    return undefined;
  }
}

export const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
