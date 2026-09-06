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
 * Every dependency that touches the OS (spawn, health probe, runtime.json
 * read, clock, sleep, exit) is injected so the sequence can be tested without
 * a real child; `tests/restart.test.ts` also drives one REAL restart.
 */
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
  /** 202 handed off, 409 one already running, 500 the child never came up. */
  status: 202 | 409 | 500;
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
  /** Spawn the detached child. Throws on failure; returns its pid when known. */
  spawnChild: (env: { portHint: number; restartedFrom: number }) => number | undefined;
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

  /** True from the moment teardown starts: the process is already leaving. */
  get inProgress(): boolean {
    return this.#inProgress;
  }

  /**
   * Perform the handoff. Resolves with the response the route must send; the
   * process exits in `onFlushed`, never before the bytes are out.
   */
  async request(keepSocket?: Duplex): Promise<RestartOutcome> {
    if (this.#inProgress) {
      this.#log('warn', `restart refused: ${RESTART_IN_PROGRESS}`);
      return { status: 409, body: { error: RESTART_IN_PROGRESS }, onFlushed: null };
    }
    this.#inProgress = true;
    const oldPort = this.#deps.port();
    const c = this.#deps.counts();
    this.#log(
      'info',
      `restart requested by the ui: sessions=${c.sessions} presence=${c.presence} attached=${c.attached}`,
    );

    // Wrapped like the spawn below it: if stamping history, destroying sessions
    // or closing the listener throws, an unwrapped call would reject request(),
    // the route would answer a generic 400, and NOTHING would spawn — a live
    // pid serving nothing, with runtime.json still naming it. #failure exits.
    try {
      this.#deps.teardown(keepSocket);
    } catch (err) {
      this.#log('error', `restart teardown failed: ${errorStackOnly(err)}`);
      return this.#failure(FAILED_TEARDOWN);
    }

    let childPid: number | undefined;
    try {
      childPid = this.#deps.spawnChild({ portHint: oldPort, restartedFrom: this.#deps.pid });
    } catch (err) {
      this.#log('error', `spawning the new backend failed: ${describeError(err)}`);
      return this.#failure(FAILED_SPAWN);
    }
    this.#log(
      'info',
      `new backend spawned${childPid === undefined ? '' : ` (pid ${childPid})`}, ` +
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
