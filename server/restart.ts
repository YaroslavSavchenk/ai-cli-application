/**
 * Manual backend restart — a same-port handoff to a fresh process.
 *
 * WHY (2026-09-06 incident): a freshly built UI ran against a backend started
 * before the history commit; `/api/history` 404'd and the only remedy was
 * "close the window, wait 30 s for the grace timer, relaunch from the desktop
 * shortcut". `POST /api/restart` replaces that ritual.
 *
 * HARD CONSTRAINT — the port. The WebView2 host
 * (launcher/host/AiSessionManagerHost.cs) locks navigation to the EXACT launch
 * origin (scheme + host + port), so a restart that lands on a different port
 * strands the window. The child therefore gets AI_SM_PORT_HINT and tries that
 * port first; the auto-picked-port architecture is untouched — the hint is a
 * hint on a handoff, and a busy port still falls back to listen(0). That case
 * is reported honestly as `samePort: false` so the UI can say "close this
 * window and relaunch" instead of navigating nowhere.
 *
 * SESSIONS DIE, and that is the documented contract: sessions are server-side
 * objects bound to this process. They are stamped 'shutdown' in history.json
 * first — exactly like a normal shutdown — so every one of them keeps its
 * `resume` button in HISTORY.
 *
 * SECURITY. The route this drives is token + Origin/Host gated like every other
 * /api route, and the child is spawned with process.execPath + an argv ARRAY:
 * no shell, no PATH lookup, no interpolation of anything a caller controls. The
 * only env we add is a port number and a pid. The 202 body never carries the
 * auth token — the UI gets the new one by reloading index.html, which injects
 * it.
 *
 * PREFLIGHT FIRST (2026-09-08, user's call: "de update moet echt bulletproof
 * zijn"). Nothing is torn down until a replacement has been PROVEN:
 *
 *   1. dependencies — node_modules in step with package-lock.json, or refuse
 *      (we never run `npm install` ourselves: node-pty is native and installs
 *      run lifecycle scripts; that is the user's call);
 *   2. the frontend is rebuilt into `web/dist-next` and VERIFIED — staged, not
 *      served, so a restart after a `git pull` will serve the NEW UI (the
 *      2026-09-06 open decision) without ever putting new screens on the old
 *      backend;
 *   3. a STANDBY child boots all the way up to (not including) `listen` and
 *      reports `standby-ready` over IPC;
 *   4. only now is the staged build swapped into `web/dist` — the last thing
 *      before the teardown, and still recoverable: a failed swap restores the
 *      old build, kills the standby and refuses.
 *
 * Any of those failing answers 422 and CHANGES NOTHING: the old process is
 * still serving, its sessions are still alive, its listener is still open,
 * `web/dist` is what it was and `web/dist-next` is gone. Only after all four
 * pass does the teardown run, and then the standby is told `go`.
 *
 * IPC here is MESSAGES ONLY — two tiny objects, `{type:'standby-ready'}` and
 * `{type:'go'}`. That is deliberately NOT the thing rejected on 2026-09-06:
 * what was rejected was passing the LISTENING SOCKET over IPC (a handle whose
 * ownership fights with `detached` + `unref`). The port is still handed over as
 * a HINT with the same single auto-pick fallback; nothing about the port design
 * changed.
 *
 * Every dependency that touches the OS (build, spawn, health probe,
 * runtime.json read, clock, sleep, exit) is injected so the sequence can be
 * tested without a real child; `tests/restart.test.ts` also drives one REAL
 * restart.
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import type { Duplex } from 'node:stream';
import type { RuntimeInfo, RestartResponse } from '../shared/protocol.ts';
import { describeError, errorStackOnly, oneLine, scoped, type Logger } from './config.ts';

/** How long the old process waits for the child to own runtime.json + answer /health. */
export const RESTART_TIMEOUT_MS = 15_000;
/** Poll interval while waiting for the child. */
export const RESTART_POLL_MS = 100;
/**
 * Force-exit backstop: if the 202/500 body is not flushed this fast, leave
 * anyway. Unref'd — it must never be the thing keeping a dead process alive.
 */
export const RESTART_FLUSH_BACKSTOP_MS = 500;

/** Reason text for the 500 body. CONSTANTS only: this string reaches server.log. */
const FAILED_SPAWN = 'restart failed: could not start the new backend; relaunch from the desktop shortcut';
const FAILED_TEARDOWN = 'restart failed: the old backend could not step aside; relaunch from the desktop shortcut';
const FAILED_UNHEALTHY = 'restart failed: the new backend did not come back in time; relaunch from the desktop shortcut';
export const RESTART_IN_PROGRESS = 'restart already in progress';

/**
 * REFUSAL reasons — the 422 bodies. A refusal happens BEFORE anything is torn
 * down, so these say what to do rather than "relaunch from the shortcut".
 *
 * CONSTANTS, like everything else that reaches server.log — and the UI renders
 * them VERBATIM, so they obey the project's UI copy rule (2026-07-25): plain
 * sentences, no command names, no flags, no file paths, and no pointer to an
 * artifact the user cannot open from the GUI. The REASON stays in server.log;
 * the screen only says what happened, and only the dependency case can be
 * acted on, so only that one carries an instruction.
 */
export const REFUSED_DEPENDENCIES = 'Dependencies changed. Install them in the project folder, then restart.';
export const REFUSED_BUILD = "The app's screens could not be rebuilt.";
export const REFUSED_STANDBY = 'The new backend did not start.';

/** How long the parent waits for the standby child's `standby-ready`. */
export const STANDBY_READY_TIMEOUT_MS = 20_000;
/** How long a standby child waits for `go` before deciding it was forgotten. */
export const STANDBY_TIMEOUT_MS = 30_000;

/**
 * Thrown by a preflight step to name WHICH refusal the user gets. `refusal` is
 * always one of the REFUSED_* constants above — never derived from anything a
 * caller supplies.
 */
export class RestartRefusal extends Error {
  refusal: string;

  constructor(refusal: string, detail: string) {
    super(detail);
    this.name = 'RestartRefusal';
    this.refusal = refusal;
  }
}

/**
 * A real TCP port. The child writes runtime.json, but this process must not
 * trust a half-written or corrupted one: a 0/-1/1e9/fractional value would be
 * probed, formatted into a log line and handed to the UI as a navigation
 * target. Anything outside 1-65535 is treated as "not written yet" — the poll
 * simply keeps waiting until the deadline.
 */
function isPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535;
}

export interface RestartOutcome {
  /**
   * 202 handed off; 409 one already running; 422 the PREFLIGHT refused and
   * this process is untouched and still serving; 500 the handoff failed after
   * the teardown and this process is leaving anyway.
   */
  status: 202 | 409 | 422 | 500;
  body: RestartResponse | { error: string };
  /**
   * Called by the route once the response bytes are flushed: the old process
   * leaves. Null for 409 — that request changed nothing.
   */
  onFlushed: (() => void) | null;
}

/**
 * What the HTTP route actually needs. An INTERFACE, not the class, so a test
 * can drive the route's wire shapes (202/409/500/405) without spawning
 * anything — the class's private fields would make a structural stub
 * impossible.
 */
export interface RestartRunner {
  /** True once a handoff has begun: the process is already leaving. */
  readonly inProgress: boolean;
  request(keepSocket?: Duplex): Promise<RestartOutcome>;
}

/** What a finished frontend build is known by. Logged, never sent to the UI. */
export interface FrontendBuild {
  /** The id from build-id.json, or null when it could not be read back. */
  buildId: string | null;
  /** The hashed entry bundle, e.g. `assets/index-Br1e6z0Q.js`. */
  asset: string | null;
  /** Wall-clock milliseconds the build took. */
  ms: number;
}

/** What `swapFrontend` replaced — the one fact `revertFrontend` needs. */
export interface FrontendSwap {
  /**
   * True when a frontend build was moved aside into `<dist>-prev`. FALSE means
   * there was NO served directory before the swap, so undoing it is removing
   * the new build again, not restoring a backup that does not exist.
   */
  hadPrevious: boolean;
}

/** A booted-but-not-listening replacement, waiting for its `go`. */
export interface StandbyChild {
  /** The child's pid when known — for the log line only. */
  pid: number | undefined;
  /**
   * Did it die AFTER reporting ready? Checked immediately before the teardown:
   * a dead standby there is still a 422 with this process whole, and it is the
   * only way to notice — the child cannot answer `go`, and a `send` on a
   * half-closed channel can fail asynchronously or not at all.
   */
  dead: () => boolean;
  /**
   * Send `{type:'go'}` and let it listen. Called ONLY after the teardown, so
   * the port is already free. Throws SYNCHRONOUSLY if the child is already
   * dead or the channel refuses the message — the caller answers 500 on that,
   * and an error reported only in an async callback would instead be a 15 s
   * wait for a backend that will never come.
   */
  go: () => void;
  /**
   * Kill it. Used when a step AFTER `standby-ready` refuses the restart: the
   * replacement is not going to be used and must not linger with an IPC
   * channel to a process that keeps serving.
   */
  stop: () => void;
}

export interface RestartDeps {
  log: Logger;
  /** Counts for the one request line: `sessions=N presence=N attached=N`. */
  counts: () => { sessions: number; presence: number; attached: number };
  /** This process's port — the child's AI_SM_PORT_HINT. */
  port: () => number;
  /** This process's pid — how the child is recognized in runtime.json. */
  pid: number;
  /**
   * Steps 2 + 3: stop the lifecycle timers, stamp history 'shutdown', destroy
   * every session, close the LISTENING socket and every other socket/WS. Runs
   * synchronously before the child is spawned, so the port is free.
   *
   * `keepSocket` is the connection carrying the in-flight POST /api/restart —
   * the ONE socket that must survive the teardown, because the 202 still has to
   * travel over it.
   */
  teardown: (keepSocket?: Duplex) => void;
  /**
   * PREFLIGHT 1 — is node_modules in step with package-lock.json? False
   * refuses the restart; we never install anything ourselves.
   */
  dependenciesReady: () => boolean;
  /**
   * PREFLIGHT 2 — rebuild the frontend into web/dist-next and verify it. It is
   * NOT served yet: the swap is a separate step, run only once the replacement
   * backend is proven. Rejects (ideally with a RestartRefusal) when anything
   * failed, having left web/dist alone.
   */
  buildFrontend: () => Promise<FrontendBuild>;
  /**
   * PREFLIGHT 4 — swap the staged build into web/dist. Runs AFTER the standby
   * reported ready and BEFORE the teardown, so the new screens and the new
   * backend arrive together. Throws (having restored the old build) → 422.
   * It KEEPS the old build as a backup; revert/commit below decide its fate.
   * Returns what it replaced, which is what `revertFrontend` needs back.
   */
  swapFrontend: () => FrontendSwap;
  /**
   * Undo a completed swap — the old build back in web/dist, or web/dist ABSENT
   * again when the swap found nothing there. Runs on the ONE refusal that can
   * still happen after it (a standby found dead just before the teardown), so
   * that 422 keeps the same promise as every other: nothing changed. Never
   * throws.
   */
  revertFrontend: (swap: FrontendSwap) => void;
  /**
   * Drop the swap's backup. Runs once `go` is out: this process is leaving and
   * the child owns the served directory, so there is nothing left to revert.
   */
  commitFrontend: () => void;
  /** Drop a staged build. Runs on every refusal after a successful build. */
  discardFrontend: () => void;
  /**
   * PREFLIGHT 3 — spawn the detached replacement in STANDBY mode and resolve
   * only once it has reported `standby-ready`. Rejects when it exited early,
   * failed to spawn or never reported in time — and kills it in that case.
   * See createStandbyStarter below for the real implementation.
   */
  startStandby: (env: { portHint: number; restartedFrom: number }) => Promise<StandbyChild>;
  /** runtime.json as it is on disk now; undefined when absent/unreadable/partial. */
  readRuntime: () => RuntimeInfo | undefined;
  /** GET http://127.0.0.1:<port>/health — true only on a 200 {"ok":true}. */
  probeHealth: (port: number) => Promise<boolean>;
  /** Leave. Injected so tests observe the intent instead of dying. */
  exit: (code: number) => void;
  /** Clock + sleep seams. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  pollMs?: number;
  flushBackstopMs?: number;
}

/**
 * The restart mechanism, as one object with one entry point.
 *
 * `inProgress` is what guards BOTH the second POST (409) and the ordinary
 * shutdown path: once teardown has run, a SIGTERM or an idle-grace expiry must
 * not tear anything down a second time and — critically — must not unlink
 * runtime.json, which by then belongs to the child.
 */
export class RestartController implements RestartRunner {
  readonly #deps: RestartDeps;
  readonly #log: Logger;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #timeoutMs: number;
  readonly #pollMs: number;
  readonly #backstopMs: number;
  #inProgress = false;
  /** True while the preflight runs: a second POST is 409, but nothing is torn down yet. */
  #preflighting = false;

  constructor(deps: RestartDeps) {
    this.#deps = deps;
    this.#log = scoped(deps.log, 'restart');
    this.#now = deps.now ?? (() => Date.now());
    this.#sleep =
      deps.sleep ??
      ((ms: number) =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, ms).unref();
        }));
    this.#timeoutMs = deps.timeoutMs ?? RESTART_TIMEOUT_MS;
    this.#pollMs = deps.pollMs ?? RESTART_POLL_MS;
    this.#backstopMs = deps.flushBackstopMs ?? RESTART_FLUSH_BACKSTOP_MS;
  }

  /**
   * True from the moment TEARDOWN starts — never during the preflight. It is
   * the "this process is already leaving" flag the SIGTERM/idle-grace guard in
   * index.ts keys on: during a preflight nothing has been torn down and
   * runtime.json is still ours, so an ordinary shutdown there is correct.
   */
  get inProgress(): boolean {
    return this.#inProgress;
  }

  /**
   * Perform the handoff. Resolves with the response the route must send; the
   * process exits in `onFlushed`, never before the bytes are out.
   */
  async request(keepSocket?: Duplex): Promise<RestartOutcome> {
    if (this.#inProgress || this.#preflighting) {
      this.#log('warn', `restart refused: ${RESTART_IN_PROGRESS}`);
      return { status: 409, body: { error: RESTART_IN_PROGRESS }, onFlushed: null };
    }
    const oldPort = this.#deps.port();
    const c = this.#deps.counts();
    this.#log(
      'info',
      `restart requested by the ui: sessions=${c.sessions} presence=${c.presence} attached=${c.attached}`,
    );

    // ----- PREFLIGHT: nothing below this block touches the running process --
    this.#preflighting = true;
    let standby: StandbyChild;
    let swap: FrontendSwap;
    try {
      ({ standby, swap } = await this.#preflight(oldPort));
    } catch (err) {
      const refusal = err instanceof RestartRefusal ? err.refusal : REFUSED_STANDBY;
      this.#log(
        'error',
        `${refusal} (${err instanceof RestartRefusal ? oneLine(err.message) : describeError(err)}); ` +
          'nothing was torn down: this backend keeps serving and its sessions are untouched',
      );
      return { status: 422, body: { error: refusal }, onFlushed: null };
    } finally {
      this.#preflighting = false;
    }

    // The last look before the point of no return: a standby that died between
    // the swap and here would leave this process torn down with nothing to hand
    // the port to. Still a 422 — and a 422 means NOTHING changed, so the swap
    // that already happened is undone: the backend, its sessions, its listener
    // AND the served screens are all what they were.
    if (standby.dead()) {
      this.#revert(swap);
      this.#log(
        'error',
        `${REFUSED_STANDBY} (the standby backend died after reporting ready); ` +
          'nothing was torn down: this backend keeps serving and its sessions are untouched',
      );
      return { status: 422, body: { error: REFUSED_STANDBY }, onFlushed: null };
    }

    // ----- HANDOFF: from here the old process is committed to leaving -------
    this.#inProgress = true;
    // Wrapped like the spawn below it: if stamping history, destroying sessions
    // or closing the listener throws, an unwrapped call would reject request(),
    // the route would answer a generic 400, and NOTHING would spawn — a live
    // pid serving nothing, with runtime.json still naming it. #failure exits.
    try {
      this.#deps.teardown(keepSocket);
    } catch (err) {
      this.#log('error', `restart teardown failed: ${errorStackOnly(err)}`);
      this.#commit();
      return this.#failure(FAILED_TEARDOWN);
    }

    try {
      standby.go();
    } catch (err) {
      this.#log('error', `handing the port to the standby backend failed: ${describeError(err)}`);
      this.#commit();
      return this.#failure(FAILED_SPAWN);
    }
    // `go` is out: the child owns the served directory now and no refusal can
    // follow, so the swap's backup has nothing left to protect.
    this.#commit();
    this.#log(
      'info',
      `go sent: new backend spawned${standby.pid === undefined ? '' : ` (pid ${standby.pid})`}, ` +
        `port hint ${oldPort}; waiting up to ${this.#timeoutMs}ms for it to take over`,
    );

    const child = await this.#waitForChild();
    if (child === undefined) {
      this.#log(
        'error',
        `the new backend did not take over within ${this.#timeoutMs}ms ` +
          '(sessions are already ended and the listener is closed); exiting anyway',
      );
      return this.#failure(FAILED_UNHEALTHY);
    }

    const samePort = child.port === oldPort;
    if (!samePort) {
      this.#log(
        'warn',
        `the new backend took port ${child.port}, not the hinted ${oldPort}; ` +
          'the window cannot follow it and must be relaunched',
      );
    }
    this.#log(
      'info',
      `handoff complete: pid ${child.pid} on 127.0.0.1:${child.port} ` +
        `(samePort=${samePort}, startedAt ${oneLine(child.startedAt)}); this process is exiting 0`,
    );
    const body: RestartResponse = {
      port: child.port,
      startedAt: child.startedAt,
      samePort,
    };
    return { status: 202, body, onFlushed: this.#exitAfterFlush(0) };
  }

  /**
   * The four steps that must ALL pass before anything is torn down.
   * Throws a RestartRefusal (or anything else — treated as a standby failure)
   * and leaves this process exactly as it found it.
   */
  async #preflight(oldPort: number): Promise<{ standby: StandbyChild; swap: FrontendSwap }> {
    this.#log('info', 'preflight: dependencies, frontend build, standby backend');

    if (!this.#deps.dependenciesReady()) {
      throw new RestartRefusal(
        REFUSED_DEPENDENCIES,
        'node_modules is absent or older than package-lock.json',
      );
    }
    this.#log('info', 'preflight: dependencies ok');

    let build: FrontendBuild;
    try {
      build = await this.#deps.buildFrontend();
    } catch (err) {
      if (err instanceof RestartRefusal) throw err;
      throw new RestartRefusal(REFUSED_BUILD, describeError(err));
    }
    this.#log(
      'info',
      `preflight: frontend build ok (build id ${build.buildId ?? 'unknown'}, ` +
        `asset ${oneLine(build.asset ?? 'unknown')}, ${build.ms}ms; staged, not served yet)`,
    );

    // From here every refusal must also drop the staged build: a web/dist-next
    // left behind is a build the NEXT restart could inherit half of.
    let standby: StandbyChild;
    try {
      standby = await this.#deps.startStandby({ portHint: oldPort, restartedFrom: this.#deps.pid });
    } catch (err) {
      this.#deps.discardFrontend();
      throw new RestartRefusal(REFUSED_STANDBY, describeError(err));
    }
    this.#log(
      'info',
      `preflight: standby backend ready${standby.pid === undefined ? '' : ` (pid ${standby.pid})`}, ` +
        `booted and holding; port hint ${oldPort}`,
    );

    // THE ORDER THAT MATTERS: the screens change only once their backend is
    // proven. A refusal above this line leaves the user on the old pair — and
    // a standby that has already died must be caught HERE, before the swap,
    // not only by the check the caller makes before the teardown.
    if (standby.dead()) {
      this.#deps.discardFrontend();
      throw new RestartRefusal(REFUSED_STANDBY, 'the standby backend died after reporting ready');
    }
    let swap: FrontendSwap;
    try {
      swap = this.#deps.swapFrontend();
    } catch (err) {
      standby.stop();
      this.#deps.discardFrontend();
      if (err instanceof RestartRefusal) throw err;
      throw new RestartRefusal(REFUSED_BUILD, describeError(err));
    }
    this.#log('info', `preflight: frontend swapped in (build id ${build.buildId ?? 'unknown'})`);
    return { standby, swap };
  }

  /**
   * Drop the swap's backup. Runs on EVERY path past the teardown — the handoff
   * and the two failures after it — because none of them can revert: the
   * sessions are gone, and the swapped-in build is the one a relaunch from the
   * shortcut will serve, so `<dist>-prev` has no further use. Never fatal: a
   * leftover directory must not turn this into a different answer.
   */
  #commit(): void {
    try {
      this.#deps.commitFrontend();
    } catch (err) {
      this.#log('warn', `dropping the previous frontend failed: ${describeError(err)}`);
    }
  }

  /** Undo the swap, loudly but never fatally: a refusal must still answer 422. */
  #revert(swap: FrontendSwap): void {
    try {
      this.#deps.revertFrontend(swap);
    } catch (err) {
      this.#log('error', `restoring the previous frontend failed: ${describeError(err)}`);
    }
  }

  /** A failed handoff still exits: the sessions are gone and nothing is listening. */
  #failure(error: string): RestartOutcome {
    return { status: 500, body: { error }, onFlushed: this.#exitAfterFlush(0) };
  }

  /**
   * The exit hook the route calls once res.end() has flushed, plus an unref'd
   * backstop in case the client never drains the socket.
   */
  #exitAfterFlush(code: number): () => void {
    let left = false;
    const leave = (why: string): void => {
      if (left) return;
      left = true;
      this.#log('debug', `exiting ${code} (${why})`);
      this.#deps.exit(code);
    };
    setTimeout(() => leave(`response not flushed within ${this.#backstopMs}ms`), this.#backstopMs).unref();
    // setImmediate, not a direct call: node emits the response's 'close' on the
    // next tick, and that is what writes the access-log line for this very
    // request. Exiting inside the flush callback would swallow it — and this
    // process's LAST http line is the one a user reads after a failed restart.
    return () => {
      setImmediate(() => leave('response flushed'));
    };
  }

  /**
   * Poll runtime.json until it names a pid that is NOT ours, then health-check
   * the port it advertises. Both conditions matter: the file appears at the
   * child's listen, but only /health proves it is actually serving.
   */
  async #waitForChild(): Promise<RuntimeInfo | undefined> {
    const deadline = this.#now() + this.#timeoutMs;
    let sawFile = false;
    for (;;) {
      const rt = this.#deps.readRuntime();
      if (
        rt !== undefined &&
        typeof rt.pid === 'number' &&
        isPort(rt.port) &&
        typeof rt.startedAt === 'string' &&
        !Number.isNaN(Date.parse(rt.startedAt)) &&
        rt.pid !== this.#deps.pid
      ) {
        if (!sawFile) {
          sawFile = true;
          this.#log('debug', `runtime.json now names pid ${rt.pid} on port ${rt.port}; probing /health`);
        }
        let healthy = false;
        try {
          healthy = await this.#deps.probeHealth(rt.port);
        } catch (err) {
          this.#log('debug', `health probe failed: ${describeError(err)}`);
        }
        if (healthy) return rt;
      }
      if (this.#now() >= deadline) return undefined;
      await this.#sleep(this.#pollMs);
    }
  }
}

// ---------------------------------------------------------------------------
// PREFLIGHT 3, for real: the standby child
// ---------------------------------------------------------------------------

export interface StandbyStarterOptions {
  /** Absolute path of the entry module the replacement re-executes. */
  entry: string;
  /** The child's working directory (the repo root). */
  cwd: string;
  /** Unscoped logger; this factory scopes it itself. */
  log: Logger;
  /** Seam: node:child_process.spawn by default, so the glue is unit-testable. */
  spawnFn?: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;
  readyTimeoutMs?: number;
}

/**
 * Spawn the replacement in STANDBY mode and resolve once it reports ready.
 *
 * Lives here rather than in server/index.ts because index.ts is an entry point:
 * importing it to test this glue would boot a whole second backend. Everything
 * that touches the OS is one injected `spawnFn`.
 *
 * NEVER A SHELL: this very node binary + an argv ARRAY (the launcher already
 * resolved nvm into process.execPath, so no PATH lookup either). The only extra
 * channel is 'ipc', and only MESSAGES travel over it — never a handle: passing
 * the listening socket itself is the design that was rejected on 2026-09-06.
 *
 * The returned StandbyChild tracks DEATH after `standby-ready`: an exit, a
 * disconnect or a spawn error in that window makes `dead()` true and `go()`
 * throw synchronously, so the caller can refuse (422, nothing torn down) or
 * fail fast (500) instead of waiting out the 15 s takeover timeout for a
 * process that no longer exists.
 */
export function createStandbyStarter(
  opts: StandbyStarterOptions,
): (env: { portHint: number; restartedFrom: number }) => Promise<StandbyChild> {
  const log = scoped(opts.log, 'restart');
  const spawnFn = opts.spawnFn ?? spawn;
  const readyTimeoutMs = opts.readyTimeoutMs ?? STANDBY_READY_TIMEOUT_MS;

  return ({ portHint, restartedFrom }) =>
    new Promise<StandbyChild>((resolve, reject) => {
      const child = spawnFn(process.execPath, [opts.entry], {
        cwd: opts.cwd,
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        env: {
          ...process.env,
          AI_SM_PORT_HINT: String(portHint),
          AI_SM_RESTARTED_FROM: String(restartedFrom),
          AI_SM_STANDBY: '1',
        },
      });
      /** Settled = the promise above answered, either way. */
      let settled = false;
      /** Ready = it reported in; from then on a death is `dead`, not a reject. */
      let ready = false;
      /** Handed off = `go` is out; the disconnect we cause ourselves is normal. */
      let handedOff = false;
      let dead = false;

      const kill = (): void => {
        try {
          child.kill('SIGTERM'); // A standby that is not going to be used must not linger.
        } catch {
          // Never started, or already gone.
        }
      };
      const fail = (why: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        kill();
        reject(new Error(why));
      };
      const died = (why: string): void => {
        if (handedOff || dead) return;
        dead = true;
        log('warn', `the standby backend is gone before the handoff: ${why}`);
      };

      const timer = setTimeout(
        () => fail(`the standby backend did not report ready within ${readyTimeoutMs}ms`),
        readyTimeoutMs,
      );
      timer.unref();

      child.on('error', (err) => {
        if (ready) {
          died(`spawn error (${describeError(err)})`);
          return;
        }
        fail(`the standby backend could not be spawned: ${describeError(err)}`);
      });
      child.on('exit', (code, signal) => {
        if (ready) {
          died(`it exited (code=${code} signal=${signal})`);
          return;
        }
        fail(`the standby backend exited early (code=${code} signal=${signal})`);
      });
      child.on('disconnect', () => {
        if (ready) died('the ipc channel closed');
      });
      child.on('message', (message) => {
        if (settled) return;
        // Shape-validated: anything that is not exactly our one message is ignored.
        if (typeof message !== 'object' || message === null) return;
        if ((message as { type?: unknown }).type !== 'standby-ready') return;
        settled = true;
        ready = true;
        clearTimeout(timer);
        resolve({
          pid: child.pid,
          dead: () => dead,
          stop: () => {
            handedOff = true; // Our own kill must not be reported as a death.
            kill();
          },
          go: () => {
            // SYNCHRONOUS failure or nothing: the caller answers 500 on a throw,
            // and an error surfacing only in the callback below would instead be
            // a 15 s wait for a backend that is never coming.
            if (dead) throw new Error('the standby backend died before the handoff');
            if (child.connected === false) throw new Error('the standby backend closed the ipc channel');
            handedOff = true;
            // The callback form: disconnecting before the message is written
            // would drop it, and this message is the whole handoff.
            const queued = child.send({ type: 'go' }, (err) => {
              if (err !== null) {
                log('error', `sending 'go' to the standby backend failed: ${describeError(err)}`);
              }
              try {
                child.disconnect();
              } catch {
                // Channel already closed — the child has what it needs.
              }
              child.unref();
            });
            if (queued === false) throw new Error('the ipc channel refused the handoff message');
          },
        });
      });
    });
}
