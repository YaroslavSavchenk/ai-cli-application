/**
 * The backend's one `PtyHost` (server/pty-host-api.ts): a broker over the
 * data dir's pty-host process — connected to at boot, started lazily on the
 * first spawn when none answers, replaced after it is lost — or over the
 * in-process table when the pty-host is refused or cannot be started.
 *
 * Nocturne D9 P3 (.claude/plans/nocturne/PLAN-D9.md § Defaults, § Phases P3):
 * the SessionManager talks to this, never to a socket. What it decides:
 *   - Which host a spawn goes to, and which host every later command for that
 *     id goes to (a route per id: a run can hold sessions on a pty-host that
 *     was lost and on its replacement, or on the in-process fallback).
 *   - One pty-host start at a time (`#starting`); a data dir the pty-host
 *     cannot live in, or a start that fails twice, falls back to the
 *     in-process table for the rest of this run, with ONE server.log line.
 *     Today's behaviour, no survival; nothing is half-done.
 *   - Never the owner of PTYs nobody adopted (security review F1): whenever
 *     this backend becomes a pty-host's owner — at boot, or when a start
 *     finds one already running (a boot connect that timed out) — it lists
 *     what that host holds and adopts it (`setAdopter`, history reopened)
 *     before any event is delivered. The boot connect retries for a bounded
 *     window while the state file names a live process.
 *   - An INCOMPATIBLE pty-host (it refuses our hello: protocol or token) is
 *     ended — SIGTERM by the pid in its 0600 state file, only after
 *     /proc/<pid>/cmdline proves it is this data dir's pty-host-main — so its
 *     sessions end as decision 27 says (history `crash` is then true) instead
 *     of living on unseen; a new pty-host starts with the next session.
 *   - A spawn that met a host leaving idle (`bye idle` raced the spawn) is
 *     retried once on a fresh host.
 *   - A pty-host lost without our asking (`closed`: it crashed or was
 *     killed; any `bye` we did not cause): every PTY routed to it that has not
 *     reported its exit has its process GROUP probed and SIGKILLed
 *     (server/pty-table.ts `processGroupGone` / `signalProcessGroup` — one
 *     home), and the owner hears `lost(id)` (history `crash`). Except
 *     `taken-over`: another backend owns those PTYs now — nothing is killed
 *     or stamped, the owner hears `handedOver(id)`. The next spawn starts a
 *     new pty-host.
 *   - Boot adoption: `connectExisting()` connects as owner (takeover, 2 s)
 *     and lists what the host holds, but the host's events are held
 *     (server/pty-host-client.ts keeps events that arrive before `listen`)
 *     until `release()` — the caller adopts first, so no output of an adopted
 *     PTY reaches the owner before its mirror exists.
 *
 * `detach()` has no caller in P3: P4's restart hands the PTYs to the next
 * backend with it. A class: it lives, holds connections and is shut down.
 * Used by the boot (server/index-ptyhost.ts) and the tests that drive a real
 * pty-host.
 */
import type { PtyHostStatus } from '../shared/protocol.ts';
import { oneLine, scoped, type Logger } from './config.ts';
import { createInProcessPtyHost, type PtyHost, type PtyHostLostReason, type PtyOwnerEvents } from './pty-host-api.ts';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { connectPtyHost, pidAlive, PtyHostRefusal, startPtyHost, type SocketPtyHost } from './pty-host-client.ts';
import { buildOrUnknown, dataDirRefusal, readPtyHostFile } from './pty-host-wire.ts';
import {
  processGroupGone,
  signalProcessGroup,
  type PtyEntrySummary,
  type PtySnapshot,
  type PtySpawned,
  type PtySpawnRequest,
} from './pty-table.ts';

/** The boot connect and a connect after a start (D9 § Defaults: 2 s). */
const CONNECT_TIMEOUT_MS = 2000;
/** How long a spawn that failed on a closing connection waits for the host's `bye` reason. */
const LOST_REASON_WAIT_MS = 1000;
/**
 * Boot connects while the state file names a live process: a busy host may
 * miss one 2 s window, and giving up would stamp its live sessions `crash`.
 */
const BOOT_CONNECT_ATTEMPTS = 3;
const BOOT_CONNECT_PAUSE_MS = 500;
/** How long an incompatible pty-host gets to end its PTYs after our SIGTERM. */
const INCOMPATIBLE_EXIT_WAIT_MS = 5000;

/** What adopts a running host's sessions into the owner (server/index-ptyhost.ts). */
type Adopter = (entries: PtyEntrySummary[]) => Promise<void>;

interface Route {
  host: PtyHost;
  /** undefined while the spawn is pending. */
  pid: number | undefined;
  exited: boolean;
  forgotten: boolean;
}

interface PtyHostBrokerOptions {
  mode: 'socket' | 'inproc';
  dataDir: string;
  /** Passed to a started pty-host as AI_SM_PTY_HOST_BUILD (bundle version or commit). */
  build: string;
  log: Logger;
  /** Where `pty-host-main.ts` lives (default: this module's directory). */
  serverDir?: string;
}

/**
 * An error as the one sentence a log line carries: the starter's and the
 * client's own sentences, or a socket errno — no stack, the reasons here are
 * expected (no pty-host yet), not bugs.
 */
function reasonOf(err: unknown): string {
  return oneLine(err instanceof Error ? err.message : String(err));
}

/**
 * True only when `pid` is this data dir's pty-host process: its cmdline is
 * `<node> <…>/pty-host-main.ts <dataDir>`. The guard before a SIGTERM by a pid
 * read from a file — a stale file's pid may have been reused by anything.
 */
function isOurPtyHost(pid: number, dataDir: string): boolean {
  let argv: string[];
  try {
    argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
  } catch {
    return false;
  }
  return argv.some((a) => a.endsWith('/pty-host-main.ts')) && argv.includes(dataDir);
}

export class PtyHostBroker implements PtyHost {
  readonly #opts: PtyHostBrokerOptions;
  readonly #log: Logger;
  #owner: PtyOwnerEvents | undefined;
  #adopter: Adopter | undefined;
  #current: SocketPtyHost | undefined;
  #starting: Promise<PtyHost> | undefined;
  #inproc: PtyHost | undefined;
  /** Set once the in-process fallback took over: every later spawn goes there. */
  #fallenBack = false;
  /** `shutdownAll()` ran: nothing new is spawned and a `bye` is not a loss. */
  #closing = false;
  readonly #routes = new Map<string, Route>();
  /** Every socket host this broker connected, with a promise of why it was lost. */
  readonly #sockets = new WeakMap<PtyHost, { host: SocketPtyHost; lost: Promise<PtyHostLostReason> }>();

  constructor(opts: PtyHostBrokerOptions) {
    this.#opts = opts;
    this.#log = scoped(opts.log, 'pty-host');
    if (opts.mode === 'inproc') this.#fallenBack = true;
  }

  /** GET /api/runtime's `ptyHost`: the pty-host this backend is connected to, or null (none yet, in-process, or lost). */
  status(): PtyHostStatus | null {
    const host = this.#current;
    return host === undefined ? null : { build: buildOrUnknown(host.welcome.build), proto: host.welcome.proto };
  }

  listen(events: PtyOwnerEvents): void {
    this.#owner = events;
  }

  /**
   * Who adopts the sessions of a pty-host this backend becomes the owner of
   * AFTER the boot (F1): a start that found one already running. Without one,
   * such a host's PTYs are ended rather than owned unseen.
   */
  setAdopter(adopter: Adopter): void {
    this.#adopter = adopter;
  }

  /**
   * Boot (before listen): connect as owner to a pty-host that is already
   * running for this data dir and list what it holds. Its events are held
   * until `release()`. [] when there is none (the first spawn starts one),
   * in-process mode, the fallback was taken (logged once), or an
   * incompatible pty-host was found and ended.
   */
  async connectExisting(): Promise<PtyEntrySummary[]> {
    if (this.#fallenBack) return [];
    const refusal = dataDirRefusal(this.#opts.dataDir);
    if (refusal !== undefined) {
      this.#fallBack(refusal);
      return [];
    }
    for (let attempt = 1; ; attempt += 1) {
      const file = readPtyHostFile(this.#opts.dataDir);
      if (file === undefined) {
        this.#log('info', 'no pty-host to re-attach to; the first session starts one');
        return [];
      }
      try {
        const host = await connectPtyHost({ dataDir: this.#opts.dataDir, takeover: true, timeoutMs: CONNECT_TIMEOUT_MS });
        return await this.#own(host, 'boot');
      } catch (err) {
        if (err instanceof PtyHostRefusal) {
          await this.#endIncompatible(err);
          return [];
        }
        if (attempt >= BOOT_CONNECT_ATTEMPTS || !pidAlive(file.pid)) {
          this.#log('info', `no pty-host answered (${reasonOf(err)}); the first session starts one`);
          return [];
        }
        this.#log('info', `the pty-host (pid ${file.pid}) did not answer (${reasonOf(err)}); trying again`);
        await delay(BOOT_CONNECT_PAUSE_MS);
      }
    }
  }

  /** After the boot's adoption: deliver the events the boot connection held back. */
  release(): void {
    this.#current?.listen(this.#forwarder());
  }

  async spawn(req: PtySpawnRequest): Promise<PtySpawned> {
    return this.#spawn(req, true);
  }

  async #spawn(req: PtySpawnRequest, mayRetry: boolean): Promise<PtySpawned> {
    if (this.#closing) throw new Error('the backend is shutting down');
    const host = await this.#hostForSpawn();
    if (this.#closing) throw new Error('the backend is shutting down');
    const route: Route = { host, pid: undefined, exited: false, forgotten: false };
    this.#routes.set(req.id, route);
    try {
      const spawned = await host.spawn(req);
      route.pid = spawned.pid;
      return spawned;
    } catch (err) {
      if (this.#routes.get(req.id) === route) this.#routes.delete(req.id);
      if (mayRetry && (await this.#lostReason(host)) === 'idle') {
        this.#log('info', `${req.id} spawn met a pty-host leaving idle; retrying on a new one`);
        return this.#spawn(req, false);
      }
      throw err;
    }
  }

  write(id: string, data: string): void {
    this.#routes.get(id)?.host.write(id, data);
  }

  resize(id: string, cols: number, rows: number): void {
    this.#routes.get(id)?.host.resize(id, cols, rows);
  }

  kill(id: string, mode: 'ladder' | 'now'): void {
    this.#routes.get(id)?.host.kill(id, mode);
  }

  async snapshot(id: string): Promise<PtySnapshot | undefined> {
    return this.#routes.get(id)?.host.snapshot(id);
  }

  setMeta(id: string, meta: string): void {
    this.#routes.get(id)?.host.setMeta(id, meta);
  }

  async list(): Promise<PtyEntrySummary[]> {
    const lists = await Promise.all(this.#hosts().map((h) => h.list()));
    return lists.flat();
  }

  forget(id: string): void {
    const route = this.#routes.get(id);
    if (route === undefined) return;
    route.host.forget(id);
    route.forgotten = true;
    if (route.exited) this.#routes.delete(id);
  }

  /** Backend shutdown: every host kills its PTYs (a pty-host then exits); no spawn after this. */
  shutdownAll(): void {
    this.#closing = true;
    for (const host of this.#hosts()) host.shutdownAll();
  }

  /**
   * Resolves once the shutdown frame has left this process, or after
   * `timeoutMs` — the caller exits right after (P2 note: a queued frame dies
   * with the process).
   */
  async flushed(timeoutMs: number): Promise<void> {
    const host = this.#current;
    if (host === undefined) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      host.flushed(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
    clearTimeout(timer);
  }

  /** P4's restart: the pty-host keeps the PTYs for the next backend. */
  detach(): void {
    const host = this.#current;
    this.#current = undefined;
    host?.detach();
  }

  #hosts(): PtyHost[] {
    const hosts: PtyHost[] = [];
    if (this.#current !== undefined) hosts.push(this.#current);
    if (this.#inproc !== undefined) hosts.push(this.#inproc);
    return hosts;
  }

  /**
   * Why this socket host went away, or undefined: the in-process fallback, a
   * host still up (the spawn itself failed), or no reason within
   * LOST_REASON_WAIT_MS.
   */
  async #lostReason(host: PtyHost): Promise<PtyHostLostReason | undefined> {
    const socket = this.#sockets.get(host);
    if (socket === undefined || !socket.host.closed) return undefined;
    let timer: NodeJS.Timeout | undefined;
    const got = await Promise.race([
      socket.lost,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), LOST_REASON_WAIT_MS);
      }),
    ]);
    clearTimeout(timer);
    return got;
  }

  #forwarder(): PtyOwnerEvents {
    return {
      output: (id, data, offset) => this.#owner?.output(id, data, offset),
      exit: (id, record) => {
        const route = this.#routes.get(id);
        if (route !== undefined) {
          route.exited = true;
          if (route.forgotten) this.#routes.delete(id);
        }
        this.#owner?.exit(id, record);
      },
    };
  }

  async #hostForSpawn(): Promise<PtyHost> {
    if (this.#fallenBack) return this.#inProcess();
    if (this.#current !== undefined) return this.#current;
    this.#starting ??= this.#start().finally(() => {
      this.#starting = undefined;
    });
    return this.#starting;
  }

  /**
   * Start a pty-host (or find the one already running) and become its owner,
   * adopting what it holds; one retry, then the in-process fallback.
   */
  async #start(): Promise<PtyHost> {
    const refusal = dataDirRefusal(this.#opts.dataDir);
    if (refusal !== undefined) {
      this.#fallBack(refusal);
      return this.#inProcess();
    }
    let last: unknown;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const file = await startPtyHost({
          dataDir: this.#opts.dataDir,
          build: this.#opts.build,
          ...(this.#opts.serverDir === undefined ? {} : { serverDir: this.#opts.serverDir }),
        });
        const host = await connectPtyHost({ dataDir: this.#opts.dataDir, takeover: true, timeoutMs: CONNECT_TIMEOUT_MS });
        await this.#own(host, 'late');
        this.#log('info', `owner of pty-host pid ${file.pid} (build ${buildOrUnknown(host.welcome.build)})`);
        return host;
      } catch (err) {
        last = err;
        if (err instanceof PtyHostRefusal) await this.#endIncompatible(err);
        else this.#log('info', `starting a pty-host failed (attempt ${attempt}): ${reasonOf(err)}`);
      }
    }
    this.#fallBack(`it could not be started (${reasonOf(last)})`);
    return this.#inProcess();
  }

  /**
   * Become `host`'s owner: route what it holds, and — after the boot — adopt
   * it (or end it when nothing can adopt) BEFORE its events flow (F1). The
   * boot returns the list and delivers the events at `release()`.
   */
  async #own(host: SocketPtyHost, when: 'boot' | 'late'): Promise<PtyEntrySummary[]> {
    this.#current = host;
    const lost = new Promise<PtyHostLostReason>((resolve) => {
      host.onLost((reason) => {
        resolve(reason);
        this.#onLost(host, reason);
      });
    });
    this.#sockets.set(host, { host, lost });
    const entries = await host.list();
    for (const e of entries) {
      this.#routes.set(e.id, { host, pid: e.pid, exited: e.exit !== null, forgotten: false });
    }
    const build = buildOrUnknown(host.welcome.build);
    if (when === 'boot') {
      this.#log('info', `re-attached to pty-host pid ${host.welcome.pid} (build ${build}): ${entries.length} session(s) held`);
      return entries;
    }
    if (entries.length > 0) {
      this.#log(
        'warn',
        `pty-host pid ${host.welcome.pid} (build ${build}) already held ${entries.length} session(s) ` +
          `the boot did not adopt; ${this.#adopter === undefined ? 'ending' : 'adopting'} them`,
      );
      if (this.#adopter !== undefined) {
        await this.#adopter(entries);
      } else {
        for (const e of entries) this.kill(e.id, 'now');
        for (const e of entries) this.forget(e.id);
      }
    }
    host.listen(this.#forwarder());
    return entries;
  }

  /**
   * Decision 27 in P3: a pty-host that refuses us cannot be adopted, and its
   * sessions must not live on unseen — SIGTERM it (its handler kills every
   * PTY's group and exits), but only once /proc proves the pid in the state
   * file is this data dir's pty-host. Waited for, bounded; a holder that does
   * not leave makes the next start fail and the run fall back in-process.
   */
  async #endIncompatible(refusal: PtyHostRefusal): Promise<void> {
    const pid = readPtyHostFile(this.#opts.dataDir)?.pid;
    if (pid === undefined || !isOurPtyHost(pid, this.#opts.dataDir)) {
      this.#log('warn', `a pty-host refused this backend (${refusal.reason}) and could not be identified; leaving it`);
      return;
    }
    this.#log(
      'warn',
      `an incompatible pty-host (pid ${pid}, protocol ${refusal.hostProto}, refused: ${refusal.reason}) holds this ` +
        'data dir; ending it and its sessions (they can be resumed from History)',
    );
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      return; // Already gone.
    }
    const deadline = performance.now() + INCOMPATIBLE_EXIT_WAIT_MS;
    while (pidAlive(pid) && performance.now() < deadline) await delay(50);
  }

  /** ONE line for the whole run: the reason, and what it costs. */
  #fallBack(reason: string): void {
    if (this.#fallenBack) return;
    this.#fallenBack = true;
    this.#log(
      'warn',
      `pty-host unavailable, sessions run inside the backend this run and end with it: ${reason}`,
    );
  }

  #inProcess(): PtyHost {
    if (this.#inproc === undefined) {
      const host = createInProcessPtyHost(this.#opts.log);
      host.listen(this.#forwarder());
      this.#inproc = host;
    }
    return this.#inproc;
  }

  #onLost(host: SocketPtyHost, reason: PtyHostLostReason): void {
    if (this.#current === host) this.#current = undefined;
    if (this.#closing) return;
    const at = Date.now();
    let ended = 0;
    let killed = 0;
    for (const [id, route] of this.#routes) {
      if (route.host !== host) continue;
      this.#routes.delete(id);
      if (route.exited || route.pid === undefined) continue; // A pending spawn: its promise rejected.
      ended += 1;
      if (reason === 'taken-over') {
        // Another backend owns this PTY now: it runs on, nothing is stamped.
        this.#owner?.handedOver?.(id);
        continue;
      }
      if (!processGroupGone(route.pid, this.#log)) {
        signalProcessGroup(id, route.pid, 'SIGKILL', this.#log);
        killed += 1;
      }
      this.#owner?.lost?.(id, at);
    }
    this.#log(
      reason === 'idle' ? 'info' : 'warn',
      reason === 'taken-over'
        ? `pty-host taken over by another backend: ${ended} session(s) handed over, none ended`
        : `pty-host lost (${reason}): ${ended} session(s) ended, ${killed} process group(s) killed; ` +
            'the next session starts a new pty-host',
    );
  }
}
