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
 *
 * Split by topic (PLAN-RESTRUCTURE O8, 2026-09-23): the scrollback ring, bell
 * scan and final-output rescue live in server/sessions-output.ts; the PTY's
 * environment (ptyEnv) in server/sessions-env.ts. Both re-exported here.
 */
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
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
import { sameAgents, type AgentsReport, type AgentsWatcher } from './agents.ts';
import { describeError, scoped, type Logger } from './config.ts';
import { ptyEnv } from './sessions-env.ts';
import { rescueFinalOutput, RingBuffer, scanForBell, SCROLLBACK_MAX_BYTES } from './sessions-output.ts';

// Split out by PLAN-RESTRUCTURE O8 (2026-09-23) and re-exported so every importer
// of this module keeps its surface.
export { ptyEnv } from './sessions-env.ts';
export { RingBuffer, SCROLLBACK_MAX_BYTES } from './sessions-output.ts';

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
 * Nocturne C1 (.claude/plans/nocturne/PLAN-C1.md § The signal): keep
 * `pendingSince` in step with `attention || turnEnded`. Stamped when that
 * goes false -> true, KEPT while either stays set (a second BEL, or a turn
 * ending on a session a BEL already made pending, does not move it — the
 * mascots are ordered oldest-first), deleted when both are false. Returns
 * whether the field changed.
 */
function syncPending(info: SessionInfo): boolean {
  const pending = info.attention || info.turnEnded === true;
  if (pending && info.pendingSince === undefined) {
    info.pendingSince = new Date().toISOString();
    return true;
  }
  if (!pending && info.pendingSince !== undefined) {
    delete info.pendingSince;
    return true;
  }
  return false;
}

export class SessionManager {
  #sessions = new Map<string, Session>();
  readonly #log: Logger;
  readonly #history: SessionHistory;
  /** Absent -> no status-line injection at all (tests that don't need it). */
  readonly #settings: SessionSettingsStore | undefined;
  /** Absent -> no API-key injection at all (tests that don't need it). */
  readonly #keys: KeyStore | undefined;
  /**
   * Absent -> no background-agents polling at all (tests that don't need it).
   * The manager only ever tells it to STOP watching a session; what starts a
   * watch is the transcript path arriving through the telemetry snapshot
   * (server/index.ts), which is the only place that knows it.
   */
  readonly #agents: AgentsWatcher | undefined;

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
    agents?: AgentsWatcher,
  ) {
    this.#log = log;
    this.#slog = scoped(log, 'session');
    this.#history = history;
    this.#settings = settings;
    this.#keys = keys;
    this.#agents = agents;
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
   * True only for a session that exists AND whose PTY is still running.
   *
   * `has()` cannot answer this: an exited session STAYS listed until DELETE.
   * The caller is the B7 wiring in server/index.ts, which must not start (or
   * restart) polling a dead session's transcripts — a snapshot written by the
   * status line can land up to a debounce or a poll AFTER the process exited,
   * and tracking on that would never be undone.
   */
  isLive(id: string): boolean {
    return this.#sessions.get(id)?.info.status === 'running';
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
        // C1: a BEL makes the session pending too; the `attention` frame is
        // the news on the wire, `pendingSince` rides the next info / GET.
        syncPending(session.info);
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
      // The process is gone, so no new subagent can appear: stop polling its
      // transcripts. The list already on info stands — what it cost is still
      // true after the session ended.
      this.#agents?.untrack(id);
      // ...but a row still marked 'running' is no longer true: Claude Code runs
      // its subagents IN-PROCESS, so none of them outlived this exit, and the
      // browser would go on counting `now - startedAt` forever. The exit is the
      // fact the app knows, and its clock is the one that stamps the end.
      const endedAt = new Date().toISOString();
      const agents = session.info.agents;
      let changed = false;
      if (agents !== undefined && agents.some((a) => a.state === 'running')) {
        session.info.agents = agents.map((a) =>
          a.state === 'running' ? { ...a, state: 'finished' as const, endedAt } : a,
        );
        changed = true;
      }
      // The totals follow the same fact (B11): nothing tracked runs any more.
      const counts = session.info.agentCounts;
      if (counts !== undefined && counts.running > 0) {
        session.info.agentCounts = { running: 0, finished: counts.running + counts.finished };
        changed = true;
      }
      // B11: the turn verdict describes a live Claude; an exited session has
      // none (the UI ignores it there anyway, but the wire must not claim it).
      if (session.info.turn !== undefined) {
        delete session.info.turn;
        changed = true;
      }
      // C1: an ended turn is no longer news once the session is gone (a BEL's
      // `attention` stays, as before — and so does its `pendingSince`).
      if (session.info.turnEnded !== undefined) {
        delete session.info.turnEnded;
        changed = true;
      }
      if (syncPending(session.info)) changed = true;
      if (changed) {
        // ONE extra frame, before the exit: the client upserts this session on
        // `info` and repaints on `exit`, so the repaint already draws the
        // corrected rows.
        this.#broadcast(session, { type: 'info', session: { ...session.info } });
      }
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

  /**
   * Apply a session's report from server/agents.ts (Nocturne B7 + B11): the
   * background-agent rows and their totals, and the turn verdict read from
   * the session's own transcript. The attached clients are told — the table
   * under the pane status bar and the Working / Waiting for you readout are
   * drawn from this.
   *
   * `agents` + `agentCounts` are set only when at least one agent is tracked
   * (both absent otherwise, as before B11); `turn` exactly as reported
   * (absent = unknown).
   *
   * Three silent no-ops:
   *   - NO SUCH SESSION. A poll can land after the session ended, and a
   *     report never creates a session.
   *   - AN EXITED SESSION. The exit already finished its rows and dropped its
   *     turn; a poll racing the untrack must not bring either back.
   *   - NOTHING CHANGED. The watcher already compares field-wise before it
   *     calls, so this is belt and braces — but it is what guarantees one
   *     broadcast per real change.
   *
   * Nocturne C1 (PLAN-C1.md § The signal): `turnEnded` is set exactly on a
   * 'working' -> 'waiting' move of `turn` (a first readout of 'waiting', or
   * one following an unknown turn, is not news) and cleared when the turn
   * goes back to 'working'; `pendingSince` follows. Both ride the same one
   * frame as the turn move — `turnEnded` only ever changes when `turn` does,
   * so the unchanged check above stays complete.
   */
  setReport(id: string, report: AgentsReport): void {
    const session = this.#sessions.get(id);
    if (session === undefined) {
      this.#slog('debug', `${id} agents ignored: no such session`);
      return;
    }
    if (session.info.status === 'exited') {
      this.#slog('debug', `${id} agents ignored: session exited`);
      return;
    }
    const { counts } = report;
    const any = counts.running + counts.finished > 0;
    const agents = any ? report.agents : undefined;
    const agentCounts = any ? { running: counts.running, finished: counts.finished } : undefined;
    const prev = session.info.agentCounts;
    if (
      sameAgents(session.info.agents, agents) &&
      prev?.running === agentCounts?.running &&
      prev?.finished === agentCounts?.finished &&
      session.info.turn === report.turn
    ) {
      return;
    }
    if (agents === undefined) delete session.info.agents;
    else session.info.agents = agents;
    if (agentCounts === undefined) delete session.info.agentCounts;
    else session.info.agentCounts = agentCounts;
    const prevTurn = session.info.turn;
    if (report.turn === undefined) delete session.info.turn;
    else session.info.turn = report.turn;
    if (prevTurn === 'working' && report.turn === 'waiting') session.info.turnEnded = true;
    else if (report.turn === 'working') delete session.info.turnEnded;
    syncPending(session.info);
    this.#slog(
      'debug',
      `${id} agents updated: ${agents?.length ?? 0} row(s), ` +
        `${counts.running} running, ${counts.finished} finished, turn ${report.turn ?? 'unknown'}, ` +
        `${session.clients.size} client(s) attached`,
    );
    this.#broadcast(session, { type: 'info', session: { ...session.info } });
  }

  markSeen(id: string): boolean {
    const session = this.#sessions.get(id);
    if (session === undefined) return false;
    session.info.attention = false;
    // C1 (user, 2026-09-22): a look acks the BEL only. An ended turn stays
    // pending until the session works again or exits, so `pendingSince` goes
    // only when `turnEnded` is not set either.
    syncPending(session.info);
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
    // Same for the agents poll: no session, nothing to deliver a list to.
    this.#agents?.untrack(id);
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
