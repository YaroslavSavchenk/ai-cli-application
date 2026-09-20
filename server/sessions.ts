/**
 * SessionManager: sessions are first-class server-side objects.
 *
 * A session = a real PTY (node-pty) + metadata + a bounded scrollback ring
 * buffer. It exists independently of any browser connection; clients attach
 * and detach freely and the whole buffer is replayed on attach. On PTY exit
 * the session stays listed (status 'exited', buffer intact) until DELETEd.
 *
 * Ending a session signals the PTY's PROCESS GROUP, not just its leader, so a
 * CLI that does its work in a child (Gemini CLI) cannot be left behind holding
 * an API key in its environment: DELETE sends SIGHUP, then SIGTERM, then
 * SIGKILL; shutdown sends SIGHUP and SIGKILL at once (no grace).
 *
 * command + args are spawned as an argv array — client-supplied values never
 * enter a shell string. This is what keeps multi-CLI support generic.
 *
 * Every create/exit/kill is mirrored into the crash-safe SessionHistory so any
 * ended session can be RESUMED on this or a later run (history.ts).
 *
 * FOUR agent-specific behaviours live here, all deliberately narrow, all keyed
 * on `basename(command)` and all confined to the PTY's argv/env — none of them
 * ever enters SessionInfo.args (so history stores the CLIENT's argv and a
 * resume re-injects from scratch):
 *   - claude: a per-session settings file injected as `--settings <file>` so
 *     Claude Code draws OUR status line (session-settings.ts);
 *   - claude: an injected `--session-id <uuid>` pinning the launch to a
 *     conversation the history can later `--resume` (conversation.ts);
 *   - claude / gemini / grok: the API key stored for THAT tool set as that
 *     tool's environment variable (keys.ts, Nocturne B5). A saved key beats an
 *     inherited one; with none saved the environment is untouched;
 *   - cmd.exe with no client args: the working-directory tail
 *     `/k pushd <windows path>`, because cmd refuses a UNC cwd (winpath.ts).
 * Everything else about the spawn stays generic, a session that already carries
 * its own `--settings` is left alone, and one that already carries a
 * resume/session flag is never given a second one.
 */
import { randomUUID } from 'node:crypto';
import { fstatSync, readSync } from 'node:fs';
import { basename } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import * as pty from 'node-pty';
import type { WebSocket } from 'ws';
import type { SessionInfo, ServerMessage, SessionTelemetry } from '../shared/protocol.ts';
import { isKeyedTool, KEY_ENV } from '../shared/protocol.ts';
import type { SessionHistory } from './history.ts';
import type { KeyStore } from './keys.ts';
import { planCmdStart } from './winpath.ts';
import { planConversation } from './conversation.ts';
import { hasSettingsArg, parsePermissionMode, type SessionSettingsStore } from './session-settings.ts';
import { sameTelemetry } from './telemetry.ts';
import { describeError, scoped, type Logger } from './config.ts';

/** Scrollback cap: 1 MiB of bytes (not lines). Oldest chunks are dropped. */
export const SCROLLBACK_MAX_BYTES = 1024 * 1024;

/**
 * Last-resort session title: the working directory's own last segment.
 *
 * A session with no project and no client title used to be titled with the raw
 * COMMAND, which put a command name straight into the chrome the UI copy rule
 * forbids (PROJECT-SCOPE, 2026-07-25) — a plain terminal launched into the
 * home folder read as `/bin/bash`. The folder name is what the user recognises
 * and is what HISTORY already groups such a session under. A degenerate cwd
 * with no last segment (`/`) keeps the path itself rather than an empty title.
 */
function cwdTitle(cwd: string): string {
  const base = basename(cwd);
  return base !== '' ? base : cwd;
}

/** Minimum gap between per-session output summary lines (debug). */
export const OUTPUT_LOG_INTERVAL_MS = 1000;

/**
 * Kill escalation, step two (DELETE only). A TUI that honours SIGHUP is gone
 * within milliseconds, so 2 s is already generous for one that flushes state
 * to disk before it leaves.
 */
export const KILL_TERM_AFTER_MS = 2000;
/**
 * Kill escalation, step three (DELETE only): 3 s more for a TUI that does
 * honour SIGTERM but is slow about it, before the signal it cannot refuse.
 */
export const KILL_KILL_AFTER_MS = 3000;

/**
 * The one pid shape the kill ladder may turn into a process-group signal. A
 * seatbelt: `pty.pid` is always a real child pid, but `process.kill(-0, …)`
 * would signal the backend's own group and `process.kill(-(-1), …)` is a
 * signal to pid 1, so anything that is not a plain positive child pid is
 * refused before it can become a negative one.
 */
export function signalableChildPid(pid: number): boolean {
  return Number.isInteger(pid) && pid > 1;
}

/**
 * Byte-capped ring buffer of output chunks; drops oldest chunks when over cap.
 *
 * `onTrim` (optional) reports how many bytes were dropped, so the manager can
 * say in server.log that a session's scrollback is no longer complete — a
 * replay that silently starts mid-stream is otherwise indistinguishable from a
 * bug. It NEVER receives the bytes themselves.
 */
export class RingBuffer {
  #chunks: Buffer[] = [];
  #bytes = 0;
  readonly #maxBytes: number;
  readonly #onTrim: ((droppedBytes: number) => void) | undefined;

  constructor(maxBytes: number = SCROLLBACK_MAX_BYTES, onTrim?: (droppedBytes: number) => void) {
    this.#maxBytes = maxBytes;
    this.#onTrim = onTrim;
  }

  append(data: string): void {
    let chunk = Buffer.from(data, 'utf8');
    let trimmed = 0;
    if (chunk.byteLength > this.#maxBytes) {
      // A single chunk larger than the whole cap: keep only its tail.
      trimmed += this.#bytes + (chunk.byteLength - this.#maxBytes);
      chunk = chunk.subarray(chunk.byteLength - this.#maxBytes);
      this.#chunks = [];
      this.#bytes = 0;
    }
    this.#chunks.push(chunk);
    this.#bytes += chunk.byteLength;
    while (this.#bytes > this.#maxBytes && this.#chunks.length > 1) {
      const dropped = this.#chunks.shift();
      if (dropped !== undefined) {
        this.#bytes -= dropped.byteLength;
        trimmed += dropped.byteLength;
      }
    }
    if (trimmed > 0 && this.#onTrim !== undefined) this.#onTrim(trimmed);
  }

  get byteLength(): number {
    return this.#bytes;
  }

  toString(): string {
    return Buffer.concat(this.#chunks).toString('utf8');
  }
}

interface Session {
  info: SessionInfo;
  pty: pty.IPty | null;
  buffer: RingBuffer;
  clients: Set<WebSocket>;
  /** OSC-string parser state for bell detection, carried across data chunks. */
  inOsc: boolean;
  /**
   * I/O accounting for the log ONLY — byte COUNTS, never bytes. A PTY can
   * produce thousands of chunks a second and its content may hold anything the
   * user typed or the agent printed, so traffic is summarized at most once per
   * OUTPUT_LOG_INTERVAL_MS per session and flushed at exit. Input is counted
   * the same way and for the same reason: xterm.js sends one frame per
   * KEYSTROKE, so a line per frame is a line per key.
   */
  outBytes: number;
  outChunks: number;
  trimmedBytes: number;
  inBytes: number;
  inFrames: number;
  lastOutLogMs: number;
  /**
   * Pending escalation step (SIGTERM or SIGKILL). Cancelled when the PTY's
   * whole process GROUP is gone — never merely when its leader exited: a
   * worker child that ignored the signal keeps running in that group, and
   * ending it is the entire point of the ladder. A live group also pins its
   * leader's pid NUMBER (Linux frees a number only when nothing references it
   * under any type, PGID included), so while the group answers `kill(-pid, 0)`
   * the negative pid is still THIS session's group and can never be a
   * stranger's.
   */
  killTimer: NodeJS.Timeout | undefined;
}

export interface CreateSessionOptions {
  projectId?: string;
  cwd: string;
  command: string;
  args: string[];
  title?: string;
  cols: number;
  rows: number;
  /**
   * RESUME ONLY: the history entry this launch continues. The history upsert
   * targets THIS key instead of the one the composed args imply, so a resume
   * updates the entry it came from instead of forking a new one.
   */
  historyId?: string;
}

/**
 * True when the chunk contains a REAL bell — not the 0x07 that terminates an
 * OSC string. Shells repaint window titles ("\x1b]0;user@host: dir\x07") on
 * every prompt, so counting those BELs raises spurious attention on
 * background sessions after any repaint (e.g. a resize). OSC state carries
 * across chunk boundaries via the session's `inOsc` flag; OSC ends at BEL or
 * ST (ESC backslash).
 */
function scanForBell(data: string, session: { inOsc: boolean }): boolean {
  let bell = false;
  for (let i = 0; i < data.length; i++) {
    const c = data.charCodeAt(i);
    if (session.inOsc) {
      if (c === 0x07) session.inOsc = false;
      else if (c === 0x1b && data.charCodeAt(i + 1) === 0x5c) {
        session.inOsc = false;
        i++;
      }
    } else if (c === 0x1b && data.charCodeAt(i + 1) === 0x5d) {
      session.inOsc = true;
      i++;
    } else if (c === 0x07) {
      bell = true;
    }
  }
  return bell;
}

/**
 * The pieces of node-pty's UnixTerminal we need but that `IPty` does not
 * declare: the pty master fd and the tty.ReadStream node-pty reads it with.
 * Both are absent on Windows (ConPTY has no fd) — every use is guarded.
 */
interface PtyMasterInternals {
  readonly fd?: unknown;
  readonly _socket?: { destroy?: unknown; readonly destroyed?: unknown } | undefined;
}

/** One read(2) buffer's worth; the kernel's per-tty backlog is far below this. */
const TAIL_DRAIN_CHUNK_BYTES = 64 * 1024;
/** Safety bound on the drain loop so a pathological fd can never spin. */
const TAIL_DRAIN_MAX_READS = 64;
/** Warn once per process, not once per session, if the rescue can't attach. */
let rescueUnavailableLogged = false;

/** What a pty master fd must still look like for the drain to touch it. */
interface PtyMasterIdentity {
  readonly rdev: number;
  readonly ino: number;
}

/**
 * Identity of an fd that is a character device, or undefined for anything else
 * (regular file, closed fd, socket). rdev+ino is what distinguishes the pty
 * master's device node from an unrelated file the number may have been recycled
 * to. Note the limit: every pty master in this process clones /dev/ptmx and so
 * shares one rdev+ino, so this separates "a pty master" from "not a pty master"
 * — it cannot separate two pty masters.
 */
function ptyMasterIdentity(fd: number): PtyMasterIdentity | undefined {
  try {
    const st = fstatSync(fd);
    if (!st.isCharacterDevice()) return undefined;
    return { rdev: st.rdev, ino: st.ino };
  } catch {
    return undefined;
  }
}

/**
 * Synchronously pull whatever the kernel still holds on the pty master fd.
 *
 * The fd is non-blocking — but that guarantee does NOT come from libuv, which
 * for a pty master takes the `uv__tty_is_slave(fd)`-false branch of
 * `uv_tty_init`, sets UV_HANDLE_BLOCKING_WRITES and skips `uv__nonblock(fd, 1)`
 * (measured: a fresh /dev/ptmx handed to `new tty.ReadStream(fd)` stays at
 * flags 02100002, no O_NONBLOCK). What sets O_NONBLOCK is node-pty's own native
 * code: `pty_nonblock(master)` in `node_modules/node-pty/src/unix/pty.cc`
 * (Linux forkpty path ~:445, macOS posix_spawn path ~:375, impl :583-586).
 *
 * That is load-bearing — it is the whole safety case for a synchronous readSync
 * on the event loop. Without it, a read against a pty whose slave is still held
 * by a surviving grandchild blocks in the kernel with no timeout and freezes the
 * single process that serves every session, the HTTP API and every WebSocket.
 * A node-pty version bump is therefore a re-check of this invariant.
 *
 * With it, this never blocks: it ends on the kernel's own signal — EIO once the
 * pty is gone, EAGAIN/0 once it is empty — not on a clock. Errors are swallowed
 * by design; a failed rescue must never take a session down.
 */
function drainPtyMaster(
  fd: number,
  identity: PtyMasterIdentity,
  emit: (data: string) => void,
  log: Logger,
): void {
  // The fd number only means anything while it still refers to THIS pty master.
  // That is inherited from node-pty's teardown order; enforce it here instead.
  // If the fd were already closed and its number recycled, an unrelated file
  // (server.log, another session's master, runtime.json and its bearer token)
  // would be read into the scrollback and broadcast to every attached client.
  const now = ptyMasterIdentity(fd);
  if (now === undefined || now.rdev !== identity.rdev || now.ino !== identity.ino) return;

  const buf = Buffer.allocUnsafe(TAIL_DRAIN_CHUNK_BYTES);
  const decoder = new StringDecoder('utf8');
  let hitCap = true;
  for (let i = 0; i < TAIL_DRAIN_MAX_READS; i++) {
    let n: number;
    try {
      n = readSync(fd, buf, 0, buf.byteLength, null);
    } catch {
      hitCap = false;
      break; // EIO (pty gone), EAGAIN (empty), EBADF — nothing left to rescue.
    }
    if (n <= 0) {
      hitCap = false;
      break;
    }
    const text = decoder.write(buf.subarray(0, n));
    if (text !== '') emit(text);
  }
  const rest = decoder.end();
  if (rest !== '') emit(rest);
  if (hitCap) {
    // Ran out of read budget with the fd still producing: the remainder is
    // truncated. Silent truncation on the very path this rescue exists for.
    log(
      'warn',
      `pty final-output rescue stopped at its ${TAIL_DRAIN_MAX_READS}-read bound ` +
        `(${TAIL_DRAIN_MAX_READS * TAIL_DRAIN_CHUNK_BYTES} bytes); ` +
        'output past that point is missing from the scrollback',
    );
  }
}

/**
 * Rescue a session's FINAL output — the crown-jewel promise that reattaching
 * shows you what you left.
 *
 * node-pty reads the pty master through a tty.ReadStream. When the child exits
 * the master goes POLLHUP, and libuv (`uv__stream_io`, src/unix/stream.c)
 * short-circuits straight to a synthetic EOF whenever its previous read was a
 * short one — without reading again. Everything the kernel still holds is
 * dropped on the floor: it never reaches `onData`, so it never reaches the
 * scrollback ring, so `attach()` replays a buffer missing its newest bytes.
 * Whenever the reader is behind — CPU contention, a busy broadcast, a big
 * burst — that is exactly the tail of the session. Measured here: a bash
 * session writing 32 KiB and then `echo TAIL_MARK` loses the last ~4 KiB,
 * marker included, 6 runs out of 6.
 *
 * Those bytes are not gone at that point. A plain read(2) on the master still
 * returns them and only then reports EIO. So we hook the single moment before
 * the fd is closed — `net.Socket#destroy`, which is the only route to that
 * close and is taken both by the stream's autoDestroy after the fake EOF and
 * by node-pty's own post-exit destroy timer — and drain the fd there.
 *
 * Ordering is preserved for free: destroy runs before the socket's 'close',
 * and node-pty emits 'exit' from that 'close', so every rescued `data` frame
 * is broadcast before the `exit` frame, and the ring buffer is complete before
 * `onExit` stamps the session 'exited'.
 *
 * Known seam: node's stream flushes its own UTF-8 decoder at the synthetic EOF,
 * so a multi-byte character split across that boundary can show up as a
 * replacement character. Rare in practice and bounded to a single character —
 * measured here as zero U+FFFD across 2000 three-byte glyphs (48 probe runs,
 * 20 mutation-verified test runs), while a different shape (all-multibyte tail,
 * 15 ms/frame stall) did produce exactly 2. Pinned by
 * `tests/sessions-tail.test.ts:290`; the caveat stays because the flush point
 * is node's, not ours, and may differ on other Node versions. One garbled glyph
 * instead of a lost kilobyte.
 */
function rescueFinalOutput(proc: pty.IPty, emit: (data: string) => void, log: Logger): void {
  const internals = proc as unknown as PtyMasterInternals;
  const fd = internals.fd;
  const socket = internals._socket;
  // Captured now, while the fd is provably this session's master, and re-checked
  // in drainPtyMaster before any read.
  const identity = typeof fd === 'number' && fd >= 0 ? ptyMasterIdentity(fd) : undefined;
  if (
    typeof fd !== 'number' ||
    fd < 0 ||
    identity === undefined ||
    socket === undefined ||
    typeof socket.destroy !== 'function'
  ) {
    // Windows/ConPTY has no master fd; a reshaped node-pty would land here
    // too. Say so once — silently dropping the rescue would look like the
    // original bug coming back with no trace of why.
    if (!rescueUnavailableLogged) {
      rescueUnavailableLogged = true;
      log(
        'warn',
        'pty final-output rescue unavailable (no master fd / read socket / not a character ' +
          'device on this node-pty): ' +
          'output produced immediately before a session exits may be missing from scrollback replay',
      );
    }
    return;
  }

  const realDestroy = socket.destroy as (this: unknown, ...args: unknown[]) => unknown;
  let done = false;
  (socket as { destroy: unknown }).destroy = function (this: unknown, ...args: unknown[]): unknown {
    try {
      if (!done) {
        done = true; // The fd is closed by realDestroy below — never read after.
        if (socket.destroyed !== true) drainPtyMaster(fd, identity, emit, log);
      }
    } catch (err) {
      // Swallowed on purpose, and this is the guard that makes that true. emit()
      // runs the manager's whole output path (ring buffer, broadcast, ws.send).
      // A throw escaping here would skip realDestroy: the master fd would never
      // close, node-pty would never emit 'exit', and the session would stay
      // pinned 'running' with a non-null pty and no history stamp. It would also
      // surface inside node-pty's teardown as an uncaughtException, which tears
      // down the whole process — every session, not one.
      try {
        log('warn', `pty final-output rescue failed: ${String(err)}`);
      } catch {
        // Not even logging may stand between this handler and realDestroy.
      }
    }
    return realDestroy.apply(this, args);
  };
}

/**
 * The four variables that belong to a RESTART HANDOFF and to nothing else
 * (server/restart.ts): they describe how THIS backend was started. A session
 * inheriting them would hand a shell — and anything the user runs in it,
 * including another copy of this app — a port hint, a foreign pid, a served
 * frontend directory and a "you are a standby" flag that mean nothing there
 * and would be obeyed by a backend launched from inside the terminal.
 */
const HANDOFF_ENV = [
  'AI_SM_STANDBY',
  'AI_SM_PORT_HINT',
  'AI_SM_RESTARTED_FROM',
  'AI_SM_WEB_DIST_DIR',
  // Not a handoff value but the same kind of seam: it moves the boundary the
  // Files panel's routes are confined to (server/fsbrowse.ts). A PTY that
  // inherited it would run a shell whose idea of `home` is a test fixture.
  'AI_SM_HOME_OVERRIDE',
] as const;

/**
 * What a running Claude Code hands every process it spawns, to mark it as a
 * CHILD of that session (found 2026-09-17: a backend started from inside a
 * Claude Code terminal passed these on, and every claude the app launched
 * then believed it was a nested child — "Transcript saving is off — inherited
 * CLAUDE_CODE_CHILD_SESSION marker", so nothing it said could be resumed).
 * Sessions this app launches are top-level by definition, whatever started
 * the backend. Named one by one, NOT as `CLAUDE_CODE_*`: that prefix also
 * carries the user's own configuration (`CLAUDE_CODE_USE_BEDROCK`,
 * `CLAUDE_CODE_MAX_OUTPUT_TOKENS`, …), which must reach the session intact.
 */
const PARENT_CLAUDE_ENV = [
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
] as const;

/**
 * This process's environment as a PTY gets it: ours, minus the handoff flags
 * and minus the markers of whichever Claude Code session started the backend.
 *
 * EXPORTED because two read-only callers must mean the very same environment a
 * session is spawned with, or they would lie about it: the PATH probe behind
 * GET /api/tools (server/tools.ts) and the `env` half of GET /api/keys.
 */
export function ptyEnv(): Record<string, string> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
  };
  for (const name of HANDOFF_ENV) delete env[name];
  for (const name of PARENT_CLAUDE_ENV) delete env[name];
  return env;
}

export class SessionManager {
  #sessions = new Map<string, Session>();
  readonly #log: Logger;
  readonly #history: SessionHistory;
  /** Absent -> no status-line injection at all (tests that don't need it). */
  readonly #settings: SessionSettingsStore | undefined;
  /** Absent -> no API-key injection at all (tests that don't need it). */
  readonly #keys: KeyStore | undefined;

  readonly #slog: Logger;

  /**
   * Kill ladders still in flight, by session id: the session itself is already
   * out of #sessions, so this map is the ONLY handle destroyAll() has on a
   * process the ladder has not reached yet. Without it, a DELETE followed
   * within 5 s by Restart service / Update / launcher stop would leave exactly
   * the process the ladder exists to end, with its API key, outliving us.
   */
  readonly #escalating = new Map<string, { pid: number }>();
  /** The group probe warns about an unexpected errno at most once per run. */
  #groupProbeWarned = false;

  constructor(
    log: Logger,
    history: SessionHistory,
    settings?: SessionSettingsStore,
    keys?: KeyStore,
  ) {
    this.#log = log;
    this.#slog = scoped(log, 'session');
    this.#history = history;
    this.#settings = settings;
    this.#keys = keys;
  }

  list(): SessionInfo[] {
    return [...this.#sessions.values()].map((s) => ({ ...s.info }));
  }

  get(id: string): SessionInfo | undefined {
    const s = this.#sessions.get(id);
    return s === undefined ? undefined : { ...s.info };
  }

  has(id: string): boolean {
    return this.#sessions.has(id);
  }

  /**
   * Bytes attach() would replay right now (0 for an unknown session). Read by
   * the WS layer so the log can state how much scrollback a client received —
   * the count only, never the content.
   */
  scrollbackBytes(id: string): number {
    return this.#sessions.get(id)?.buffer.byteLength ?? 0;
  }

  /** Spawn the PTY and register the session. Throws if the spawn fails. */
  create(opts: CreateSessionOptions): SessionInfo {
    const id = randomUUID();
    // Status line: claude-kind sessions only, and never over a client's own
    // --settings. `spawnArgs` is what the PTY gets; `opts.args` is what the
    // session (and therefore the history entry, and therefore a resume)
    // remembers — a resume must get a FRESH settings file, not a path this
    // boot's wipe already removed.
    let spawnArgs = [...opts.args];
    const tool = basename(opts.command);
    let statusline = false;
    if (this.#settings !== undefined && tool === 'claude' && !hasSettingsArg(opts.args)) {
      const file = this.#settings.write(id, parsePermissionMode(opts.args));
      if (file !== undefined) {
        spawnArgs = [...spawnArgs, '--settings', file];
        statusline = true;
      }
    }
    // Conversation pinning: same discipline as --settings. Whatever the plan
    // adds on top of the client's own argv (today: `--session-id <id>`, and
    // only when the client asked for no resume/session flag itself) goes into
    // the PTY argv, never into info.args.
    const plan = planConversation(opts.command, opts.args, id);
    if (plan.injected.length > 0) spawnArgs = [...spawnArgs, ...plan.injected];

    const env = ptyEnv();
    // Stored API key -> the child ENVIRONMENT of exactly the tool it belongs
    // to, never argv (an argv is visible in `ps` to every process of this
    // user). A SAVED key overrides one inherited from the backend's own
    // environment: saving it was the user's explicit, later act. With no key
    // saved nothing is touched, so an inherited variable still reaches the CLI.
    if (isKeyedTool(tool)) {
      const key = this.#keys?.get(tool);
      if (key !== undefined) {
        env[KEY_ENV[tool]] = key;
        // The TOOL, never the value, never its length.
        this.#slog('debug', `${id} using the stored API key for ${tool}`);
      }
    }
    // Command Prompt: cmd.exe refuses a UNC working directory, so it is started
    // with `/k pushd <windows path>` — the tail is composed here, from the cwd
    // and this backend's WSL_DISTRO_NAME, and only for a launch that carries NO
    // client arguments (the dialog's Command Prompt card sends exactly that).
    if (tool === 'cmd.exe' && opts.args.length === 0) {
      const start = planCmdStart(opts.cwd, env['WSL_DISTRO_NAME']);
      if (start.ok) spawnArgs = [...spawnArgs, ...start.args];
      else this.#log('warn', `cmd.exe: working directory not passed (${start.reason})`);
    }

    let proc: pty.IPty;
    try {
      proc = pty.spawn(opts.command, spawnArgs, {
        name: 'xterm-256color',
        cols: opts.cols,
        rows: opts.rows,
        cwd: opts.cwd,
        env,
      });
    } catch (err) {
      // A failed spawn must not leave its settings file behind.
      if (statusline) this.#settings?.remove(id);
      throw err;
    }

    const info: SessionInfo = {
      id,
      ...(opts.projectId !== undefined ? { projectId: opts.projectId } : {}),
      title: opts.title !== undefined && opts.title !== '' ? opts.title : cwdTitle(opts.cwd),
      command: opts.command,
      args: [...opts.args],
      cwd: opts.cwd,
      status: 'running',
      cols: opts.cols,
      rows: opts.rows,
      createdAt: new Date().toISOString(),
      attention: false,
      ...(statusline ? { statusline: true } : {}),
    };

    // The ladder outlives `session.pty` (destroy() nulls it), so the pid the
    // group is addressed by is captured once, here.
    const ptyPid = proc.pid;

    const session: Session = {
      info,
      pty: proc,
      buffer: new RingBuffer(SCROLLBACK_MAX_BYTES, (dropped) => {
        session.trimmedBytes += dropped;
      }),
      clients: new Set(),
      inOsc: false,
      outBytes: 0,
      outChunks: 0,
      trimmedBytes: 0,
      inBytes: 0,
      inFrames: 0,
      lastOutLogMs: Date.now(),
      killTimer: undefined,
    };
    this.#sessions.set(id, session);
    this.#history.recordCreate(info, {
      id: opts.historyId ?? plan.id,
      conversation: plan.conversation,
      baseArgs: plan.baseArgs,
    });

    const handleOutput = (data: string): void => {
      session.buffer.append(data);
      session.outBytes += Buffer.byteLength(data);
      session.outChunks += 1;
      this.#flushOutputLog(id, session, false);
      this.#broadcast(session, { type: 'data', data });
      if (scanForBell(data, session)) {
        session.info.attention = true;
        this.#slog('debug', `${id} attention raised (BEL in output)`);
        this.#broadcast(session, { type: 'attention' });
      }
    };

    proc.onData(handleOutput);
    // The child's last bytes can outlive node-pty's read stream; rescue them
    // into the SAME path, before onExit stamps the session 'exited'.
    rescueFinalOutput(proc, handleOutput, this.#log);

    proc.onExit(({ exitCode, signal }) => {
      // The LEADER is gone; the ladder is only called off when the whole group
      // is. A CLI whose top-level process honours SIGHUP but whose worker child
      // ignores it would otherwise leave that child running forever — with the
      // stored API key in its environment.
      if (session.killTimer !== undefined && this.#groupGone(ptyPid)) {
        clearTimeout(session.killTimer);
        session.killTimer = undefined;
        this.#escalating.delete(id);
      }
      session.info.status = 'exited';
      session.info.exitCode = exitCode;
      session.pty = null;
      if (statusline) this.#settings?.remove(id);
      // No-op if already stamped 'user-kill'/'shutdown' (first stamp wins).
      this.#history.markEnded(id, 'exit', exitCode);
      this.#broadcast(session, { type: 'exit', exitCode });
      // Wording kept verbatim (tests and habits key off it); the signal and the
      // final output tally are appended.
      this.#log(
        'info',
        `session ${id} exited with code ${exitCode}` +
          `${signal === undefined || signal === 0 ? '' : ` (signal ${signal})`}`,
      );
      this.#flushOutputLog(id, session, true);
      this.#slog(
        'info',
        `${id} totals: scrollback ${session.buffer.byteLength} bytes, ` +
          `${session.clients.size} client(s) attached at exit`,
      );
    });

    // The FULL spawned argv, injections included (`--settings <file>`,
    // `--session-id <uuid>`, `--resume <id>`) — this is the line that answers
    // "what did the app actually run?".
    this.#log(
      'info',
      `session ${id} spawned: ${opts.command} ${JSON.stringify(spawnArgs)} in ${opts.cwd} (${opts.cols}x${opts.rows})`,
    );
    this.#slog(
      'debug',
      `${id} created: pid ${proc.pid}, title ${JSON.stringify(info.title)}, ` +
        `project ${info.projectId ?? 'none'}, statusline ${statusline}, ` +
        `history key ${opts.historyId ?? plan.id} (conversation ${plan.conversation})`,
    );
    return { ...info };
  }

  /**
   * Attach a client: replay the whole scrollback buffer FIRST, then an info
   * snapshot (and an exit notice if already exited), then live traffic.
   * ws frames are delivered in send order per socket, and the client is only
   * added to the broadcast set after replay is queued, so replay always
   * precedes any live data on this socket.
   */
  attach(id: string, ws: WebSocket): boolean {
    const session = this.#sessions.get(id);
    if (session === undefined) return false;
    this.#slog(
      'debug',
      `${id} attach: replaying ${session.buffer.byteLength} bytes, status ${session.info.status}, ` +
        `${session.clients.size + 1} client(s) after this one`,
    );
    this.#send(ws, { type: 'replay', data: session.buffer.toString() });
    this.#send(ws, { type: 'info', session: { ...session.info } });
    if (session.info.status === 'exited') {
      this.#send(ws, { type: 'exit', exitCode: session.info.exitCode ?? 0 });
    }
    session.clients.add(ws);
    ws.on('close', () => session.clients.delete(ws));
    return true;
  }

  write(id: string, data: string): void {
    const session = this.#sessions.get(id);
    if (session === undefined || session.pty === null) return;
    // Counted, never logged per frame: one ws `input` frame is one keystroke.
    session.inBytes += Buffer.byteLength(data);
    session.inFrames += 1;
    session.pty.write(data);
    this.#flushOutputLog(id, session, false);
  }

  resize(id: string, cols: number, rows: number): void {
    const session = this.#sessions.get(id);
    if (session === undefined) {
      this.#slog('debug', `${id} resize ignored: no such session`);
      return;
    }
    session.info.cols = cols;
    session.info.rows = rows;
    if (session.pty !== null) session.pty.resize(cols, rows);
    else this.#slog('debug', `${id} resize ${cols}x${rows} recorded but the pty has exited`);
  }

  /**
   * Record what Claude Code last reported about a session (server/telemetry.ts
   * watching the snapshot the status-line script writes) and tell the attached
   * clients — the pane status bar under the terminal is drawn from this.
   *
   * Two silent no-ops, both normal:
   *   - NO SUCH SESSION. The watcher can fire for a file whose session ended
   *     between the write and the read, and a snapshot never creates a session.
   *   - NOTHING CHANGED. The script already writes only on change, so this is
   *     belt and braces — but it is what guarantees one broadcast per real
   *     change and none for a re-read of the same file.
   */
  setTelemetry(id: string, telemetry: SessionTelemetry): void {
    const session = this.#sessions.get(id);
    if (session === undefined) {
      this.#slog('debug', `${id} telemetry ignored: no such session`);
      return;
    }
    if (sameTelemetry(session.info.telemetry, telemetry)) return;
    session.info.telemetry = telemetry;
    this.#slog('debug', `${id} telemetry updated (${session.clients.size} client(s) attached)`);
    this.#broadcast(session, { type: 'info', session: { ...session.info } });
  }

  markSeen(id: string): boolean {
    const session = this.#sessions.get(id);
    if (session === undefined) return false;
    session.info.attention = false;
    return true;
  }

  /**
   * Kill the PTY (if running), close all attached clients, remove the session.
   *
   * `by` says WHO asked — 'user' for DELETE /api/sessions/:id, 'shutdown' for
   * destroyAll() at server exit. It shapes the log line and the kill
   * escalation; the history stamp stays 'user-kill' (endAllLive() has already
   * stamped 'shutdown' by then, and the first stamp wins).
   *
   * The signal ladder is in #escalateKill / #signalGroup below: SIGHUP first
   * either way, then (user) SIGTERM and SIGKILL to the process group, or
   * (shutdown) SIGKILL to it at once.
   */
  destroy(id: string, by: 'user' | 'shutdown' = 'user'): boolean {
    const session = this.#sessions.get(id);
    if (session === undefined) {
      this.#slog('debug', `${id} delete ignored: no such session`);
      return false;
    }
    this.#slog(
      'info',
      `${id} kill requested by ${by} (status ${session.info.status}, ` +
        `${session.clients.size} client(s) attached)`,
    );
    this.#sessions.delete(id);
    // No-op when the session never had one, or when onExit already removed it.
    if (session.info.statusline === true) this.#settings?.remove(id);
    if (session.pty !== null) {
      // Stamp BEFORE kill so the async onExit's 'exit' stamp is the no-op.
      // At server shutdown endAllLive() ran first, so THIS is the no-op.
      this.#history.markEnded(id, 'user-kill');
      // Captured before the field is cleared: the escalation signals the pid,
      // not the (already detached) IPty.
      const pid = session.pty.pid;
      try {
        session.pty.kill();
      } catch (err) {
        this.#log('warn', `session ${id} kill failed: ${describeError(err)}`);
      }
      session.pty = null;
      if (by === 'shutdown') {
        // No grace at shutdown: sessions die with the server by design, and a
        // process that ignores SIGHUP must not outlive the backend carrying an
        // API key in its environment. `-pid` is unambiguous here: the group was
        // alive a line ago, and a live group pins its leader's pid number.
        this.#slog(
          'info',
          `${id} killed for shutdown with SIGHUP; sending SIGKILL to its process group immediately`,
        );
        this.#signalGroup(id, pid, 'SIGKILL');
      } else {
        this.#escalateKill(id, session, pid);
      }
    }
    for (const ws of session.clients) {
      try {
        ws.close(1000, 'session deleted');
      } catch {
        // Socket already gone.
      }
    }
    session.clients.clear();
    this.#log('info', `session ${id} deleted`);
    return true;
  }

  /** Kill every PTY (server shutdown). Sessions die with the server by design. */
  destroyAll(): void {
    const ids = [...this.#sessions.keys()];
    this.#slog('info', `destroying all ${ids.length} session(s) for shutdown`);
    for (const id of ids) this.destroy(id, 'shutdown');
    // Sessions already DELETEd whose ladder is still counting down: the caller
    // exits the process right after this returns and the ladder's timers are
    // unref'd, so anything still alive here would survive the backend. Same
    // treatment as a live session at shutdown — SIGKILL to the group, now.
    for (const [id, { pid }] of this.#escalating) {
      if (this.#groupGone(pid)) continue;
      this.#slog(
        'info',
        `${id} killed for shutdown with SIGHUP; sending SIGKILL to its process group immediately`,
      );
      this.#signalGroup(id, pid, 'SIGKILL');
    }
    this.#escalating.clear();
  }

  /**
   * DELETE's signal ladder after the SIGHUP `pty.kill()` already sent: SIGTERM
   * to the process group after KILL_TERM_AFTER_MS, SIGKILL after a further
   * KILL_KILL_AFTER_MS, each step skipped once the whole GROUP is gone.
   *
   * Measured 2026-09-20: Gemini CLI 0.60 (a `node` wrapper that relaunches
   * itself as a `node --max-old-space-size=…` CHILD) ignores both SIGHUP and
   * SIGTERM, so a deleted gemini session and its child kept running — and kept
   * GEMINI_API_KEY in their environment after the user had removed that key.
   * Only SIGKILL ended them.
   *
   * Both timers are unref'd: an escalation in flight never keeps the process
   * alive, and shutdown takes the immediate path anyway.
   */
  #escalateKill(id: string, session: Session, pid: number): void {
    this.#escalating.set(id, { pid });
    const term = setTimeout(() => {
      session.killTimer = undefined;
      if (this.#groupGone(pid)) {
        this.#escalating.delete(id);
        return;
      }
      this.#slog(
        'info',
        `${id} still running ${KILL_TERM_AFTER_MS}ms after SIGHUP; sending SIGTERM to its process group`,
      );
      this.#signalGroup(id, pid, 'SIGTERM');
      const kill = setTimeout(() => {
        session.killTimer = undefined;
        this.#escalating.delete(id);
        if (this.#groupGone(pid)) return;
        this.#slog(
          'info',
          `${id} still running ${KILL_KILL_AFTER_MS}ms after SIGTERM; sending SIGKILL to its process group`,
        );
        this.#signalGroup(id, pid, 'SIGKILL');
      }, KILL_KILL_AFTER_MS);
      kill.unref();
      session.killTimer = kill;
    }, KILL_TERM_AFTER_MS);
    term.unref();
    session.killTimer = term;
  }

  /**
   * True when the PTY's process group holds NO process any more — the only
   * safe "stop signalling" answer, and a stronger one than "its leader exited":
   * a worker child that ignored the signal still lives in that group.
   *
   * It doubles as the pid-reuse guard. Linux frees a pid NUMBER only once
   * nothing references it under any type — PGID and SID included — so a group
   * that still answers pins its leader's number even after the leader itself
   * was reaped. A successful `kill(-pid, 0)` therefore proves `-pid` is still
   * THIS session's group and never a stranger that inherited the number.
   *
   * Anything other than ESRCH (EPERM, or an errno we did not foresee) is read
   * as "alive": the ladder may then signal in vain, which is harmless, while
   * the opposite mistake leaks a process.
   */
  #groupGone(pid: number): boolean {
    if (!signalableChildPid(pid)) return true;
    try {
      process.kill(-pid, 0);
      return false;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') return true;
      if (code !== 'EPERM' && !this.#groupProbeWarned) {
        this.#groupProbeWarned = true;
        this.#log('warn', `process group probe failed, assuming alive: ${describeError(err)}`);
      }
      return false;
    }
  }

  /**
   * Signal the PTY's whole PROCESS GROUP. node-pty's forkpty child calls
   * setsid(), so `pty.pid` IS the group leader and the negative pid reaches
   * every descendant the CLI spawned — which is the only way to end a wrapper
   * whose real work runs in a child.
   *
   * ESRCH means the group is already gone: the ordinary race with onExit, not
   * an error. The pid guard is a seatbelt only — `process.kill(-1, …)` would
   * signal every process this user owns, so a pid that is not a plain child
   * pid is never signalled.
   */
  #signalGroup(id: string, pid: number, signal: 'SIGTERM' | 'SIGKILL'): void {
    if (!signalableChildPid(pid)) {
      this.#log('warn', `session ${id} not signalling process group: implausible pid ${pid}`);
      return;
    }
    try {
      process.kill(-pid, signal);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') return;
      this.#log(
        'warn',
        `session ${id} ${signal} to process group ${pid} failed: ${describeError(err)}`,
      );
    }
  }

  /**
   * Summarize a session's traffic at most once per OUTPUT_LOG_INTERVAL_MS (and
   * unconditionally at exit, `force`): one output line and one input line.
   * COUNTS ONLY — both directions can hold anything the user typed or the agent
   * printed, so no byte of either is ever written to server.log.
   */
  #flushOutputLog(id: string, session: Session, force: boolean): void {
    const now = Date.now();
    if (!force && now - session.lastOutLogMs < OUTPUT_LOG_INTERVAL_MS) return;
    if (session.outBytes === 0 && session.trimmedBytes === 0 && session.inBytes === 0) {
      session.lastOutLogMs = now;
      return;
    }
    const elapsed = now - session.lastOutLogMs;
    if (session.outBytes > 0 || session.trimmedBytes > 0) {
      this.#slog(
        'debug',
        `${id} output ${session.outBytes} bytes in ${session.outChunks} chunk(s) over ${elapsed}ms` +
          `${session.trimmedBytes > 0 ? `, scrollback trimmed ${session.trimmedBytes} bytes` : ''}`,
      );
    }
    if (session.inBytes > 0) {
      this.#slog(
        'debug',
        `${id} input ${session.inBytes} bytes in ${session.inFrames} frame(s) over ${elapsed}ms`,
      );
    }
    session.outBytes = 0;
    session.outChunks = 0;
    session.trimmedBytes = 0;
    session.inBytes = 0;
    session.inFrames = 0;
    session.lastOutLogMs = now;
  }

  #broadcast(session: Session, message: ServerMessage): void {
    for (const ws of session.clients) this.#send(ws, message);
  }

  #send(ws: WebSocket, message: ServerMessage): void {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

}
