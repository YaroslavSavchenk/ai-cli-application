/**
 * SessionManager: sessions are first-class server-side objects.
 *
 * A session = a real PTY (node-pty) + metadata + a bounded scrollback ring
 * buffer. It exists independently of any browser connection; clients attach
 * and detach freely and the buffer's tail — the last REPLAY_MAX_LINES lines,
 * what a browser terminal keeps (PLAN-QUALITY P1) — is replayed on attach.
 * On PTY exit the session stays listed (status 'exited', buffer intact) until
 * DELETEd.
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
 * on the command's last `/` or `\` segment (the shared `commandBase` /
 * `isClaudeCommand`, Q1) and all confined to the PTY's argv/env —
 * none of them ever enters SessionInfo.args (so history stores the CLIENT's
 * argv and a resume re-injects from scratch):
 *   - claude: a per-session settings file injected as `--settings <file>` so
 *     Claude Code draws OUR status line (session-settings.ts);
 *   - claude: an injected `--session-id <uuid>` pinning the launch to a
 *     conversation the history can later `--resume` (conversation.ts);
 *   - claude / gemini / grok: the API key stored for THAT tool set as that
 *     tool's environment variable (keys.ts, Nocturne B5). A saved key beats an
 *     inherited one; with none saved the environment is untouched;
 *   - cmd.exe with no client args: the working-directory tail
 *     `/k pushd <windows path>`, because cmd refuses a UNC cwd (winpath.ts).
 * One more claude-only fact is read at EXIT, not spawn (Nocturne D6): a
 * non-zero exit within EARLY_EXIT_MS sets `info.earlyExit` and the exit
 * frame's `early` (sessions-output.ts `earlyExitLine`), unless destroy() ended it.
 * Everything else about the spawn stays generic, a session that already carries
 * its own `--settings` is left alone, and one that already carries a
 * resume/session flag is never given a second one.
 *
 * Split by topic (PLAN-RESTRUCTURE O8, 2026-09-23): the bell and title scan,
 * the replay tail and the early-exit line live in server/sessions-output.ts;
 * the PTY's environment (ptyEnv) in server/sessions-env.ts; since D9 P3 the
 * per-session record in server/sessions-state.ts and the metadata blob a
 * restarted backend adopts a session from in server/sessions-meta.ts; since
 * PLAN-QUALITY Q13 the D9 adopt / detach / hand-over in server/sessions-adopt.ts.
 *
 * Nocturne D9 P1 (.claude/plans/nocturne/PLAN-D9.md): the PTY itself — spawn,
 * input, resize, the raw ring, the final-output rescue, the kill ladder — sits
 * behind the `PtyHost` interface (server/pty-host-api.ts over
 * server/pty-table.ts), so a pty-host process can own it later. This class
 * composes the launch (argv, env, settings, key) and interprets the output
 * (bell, title, early exit, history, logging); it keeps its own MIRROR of the
 * ring (`Session.buffer`), fed by the host's output events, so `attach()`
 * stays synchronous whoever owns the PTY.
 */
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import type { WebSocket } from 'ws';
import type { SessionInfo, ServerMessage, SessionTelemetry } from '../shared/protocol.ts';
import { commandBase, isClaudeCommand, isKeyedTool, KEY_ENV, REPLAY_MAX_LINES, SLOW_CLIENT_CLOSE_CODE } from '../shared/protocol.ts';
import type { SessionHistory } from './history.ts';
import type { KeyStore } from './keys.ts';
import { planCmdStart } from './winpath.ts';
import { planConversation } from './conversation.ts';
import { hasSettingsArg, parsePermissionMode, type SessionSettingsStore } from './session-settings.ts';
import { sameTelemetry } from './telemetry.ts';
import { sameAgents, type AgentsReport, type AgentsWatcher } from './agents.ts';
import { scoped, type Logger } from './config-log.ts';
import { ptyEnv } from './sessions-env.ts';
import { earlyExitLine, replayTail, scanOutput } from './sessions-output.ts';
import { sessionBlob, unseenTail } from './sessions-meta.ts';
import { flushOutputLog, metaMarks, metaMarksChanged, newSession, slowCloseLimiter, syncPending, type Session } from './sessions-state.ts';
import type { PtyEntrySummary, PtyExitRecord } from './pty-table.ts';
import { createInProcessPtyHost, type PtyHost } from './pty-host-api.ts';
import { adoptSessions, detachSessions, handOverSession, type AdoptContext } from './sessions-adopt.ts';

// Split out by PLAN-RESTRUCTURE O8 (2026-09-23) and re-exported so every importer
// of this module keeps its surface.
export { ptyEnv } from './sessions-env.ts';

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

/**
 * D9 P3 (§ Risks (c)): a launch of this conversation (or history entry) is
 * being spawned right now — the second of two concurrent resumes is refused,
 * since both passed the "not live" check before either was registered.
 */
export class ConversationStarting extends Error {
  constructor() {
    super('that conversation is being started already');
  }
}

/**
 * Q9: the most unsent bytes one client may have queued; past it the client is
 * closed, so a frozen tab under a busy session cannot grow this process until
 * it dies with every session in it. Well above the largest single frame (a
 * replay: the 1 MiB ring, ~6 MiB if every byte is JSON-escaped).
 */
const MAX_CLIENT_BUFFERED_BYTES = 16 * 1024 * 1024;

/** The exit code a session gets when its pty-host was lost and its group SIGKILLed (128 + 9). */
const LOST_EXIT_CODE = 137;

interface CreateSessionOptions {
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
  /**
   * Nocturne D6: the probed Claude Code version, read only for the early-exit
   * WARN line. Absent -> the line says `unknown`.
   */
  readonly #claudeVersion: (() => string | null) | undefined;

  readonly #slog: Logger;

  /**
   * Who owns the PTYs (D9 P1): in-process today, a pty-host process from P3.
   * Every byte and signal goes through it; nothing here imports node-pty.
   */
  readonly #host: PtyHost;
  /**
   * Sessions whose PTY has not reported its exit yet, by id — DESTROYED ones
   * included. destroy() takes a session out of #sessions at once, but its PTY
   * still reports output and then its exit (the history stamp no-ops, the exit
   * and totals lines are still written), so the host's events are routed
   * through this map, not #sessions.
   */
  readonly #ptys = new Map<string, Session>();
  /** D9 P3: history keys whose launch is being spawned (ConversationStarting). */
  readonly #launching = new Set<string>();
  /**
   * D9 P3 (§ Risks (a)): destroyAll() or (P4) detachAll() ran. A spawn still
   * awaiting its answer is killed the moment the answer arrives, and no new
   * one starts — no live PTY may outlive a shutdown, or be handed to the next
   * backend, unowned.
   */
  #closing = false;
  /** What the D9 adopt/detach functions reach (server/sessions-adopt.ts). */
  readonly #adoptCtx: AdoptContext;

  constructor(
    log: Logger,
    history: SessionHistory,
    settings?: SessionSettingsStore,
    keys?: KeyStore,
    agents?: AgentsWatcher,
    claudeVersion?: () => string | null,
    /**
     * Who owns the PTYs (D9 P2 seam): the in-process table by default; a test
     * passes a recording fake, P3 the pty-host's socket client.
     */
    host: PtyHost = createInProcessPtyHost(log),
  ) {
    this.#log = log;
    this.#slog = scoped(log, 'session');
    this.#history = history;
    this.#settings = settings;
    this.#keys = keys;
    this.#agents = agents;
    this.#claudeVersion = claudeVersion;
    this.#host = host;
    this.#adoptCtx = {
      sessions: this.#sessions,
      ptys: this.#ptys,
      host,
      history,
      settings,
      agents,
      log,
      slog: this.#slog,
      overrunLogged: false,
      onExit: (id, session, record) => this.#onExit(id, session, record),
      flushMeta: (id, session) => this.#flushMeta(id, session),
    };
    this.#host.listen({
      output: (id, data, offset, bytes) => {
        const session = this.#ptys.get(id);
        if (session === undefined) return;
        const fresh = unseenTail(session.buffer.endOffset, bytes, offset);
        if (fresh.byteLength === 0) return;
        this.#onOutput(id, session, fresh === bytes ? data : fresh.toString('utf8'), fresh);
      },
      exit: (id, record) => this.#ended(id, record, 'exit'),
      // D9 P3: the pty-host holding this PTY is gone and its group was killed.
      lost: (id, at) => this.#ended(id, { code: LOST_EXIT_CODE, signal: 9, at }, 'crash'),
      handedOver: (id) => handOverSession(this.#adoptCtx, id),
    });
  }

  /** The PTY is gone: end its session now, or right after it is registered. */
  #ended(id: string, record: PtyExitRecord, reason: 'exit' | 'crash'): void {
    const session = this.#ptys.get(id);
    if (session === undefined) return;
    this.#ptys.delete(id);
    if (!session.destroyed && !this.#sessions.has(id)) {
      session.earlyEnd = { record, reason };
      return;
    }
    this.#onExit(id, session, record, reason);
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
   * C2 DEV-check fix: when this session's window title last turned Claude
   * Code's idle mark (a Date.now() ms), or undefined — no such session, it
   * exited, or its title is anything else. Read by the agents watcher's
   * session verdict (server/agents-verdict.ts), injected in server/index-stores.ts.
   */
  titleIdleSince(id: string): number | undefined {
    return this.#sessions.get(id)?.titleIdleSince;
  }

  /** Spawn the PTY and register the session. Rejects if the spawn fails. */
  async create(opts: CreateSessionOptions): Promise<SessionInfo> {
    if (this.#closing) throw new Error('the backend is shutting down');
    const id = randomUUID();
    // Conversation pinning (below) decides the history key; it is claimed
    // BEFORE the spawn is awaited (D9 P3 § Risks (c)).
    const plan = planConversation(opts.command, opts.args, id);
    const historyKey = opts.historyId ?? plan.id;
    if (this.#launching.has(historyKey)) throw new ConversationStarting();
    this.#launching.add(historyKey);
    try {
      return await this.#create(id, plan, historyKey, opts);
    } finally {
      this.#launching.delete(historyKey);
    }
  }

  async #create(
    id: string,
    plan: ReturnType<typeof planConversation>,
    historyKey: string,
    opts: CreateSessionOptions,
  ): Promise<SessionInfo> {
    // Status line: claude-kind sessions only, and never over a client's own
    // --settings. `spawnArgs` is what the PTY gets; `opts.args` is what the
    // session (and therefore the history entry, and therefore a resume)
    // remembers — a resume must get a FRESH settings file, not a path this
    // boot's wipe already removed.
    let spawnArgs = [...opts.args];
    // Which tool this is has ONE answer, the shared last-segment rule cut on `/`
    // AND `\` (commandBase / isClaudeCommand, Q1) — the one planConversation
    // uses for --session-id. So `C:\tools\claude` gets --settings and its key
    // exactly as it gets the conversation pin, and every keyed tool and cmd.exe
    // is named the same way.
    const tool = commandBase(opts.command);
    const claude = isClaudeCommand(opts.command);
    let statusline = false;
    if (this.#settings !== undefined && claude && !hasSettingsArg(opts.args)) {
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
      // Stamped when the spawn is asked for (D9 P1; before it, right after a
      // synchronous spawn): the early-exit window (EARLY_EXIT_MS, 3 s) counts
      // from here, so a forkpty — or, from P3, a socket round trip — is inside
      // it. Milliseconds against seconds; the verdict cannot turn on it.
      createdAt: new Date().toISOString(),
      attention: false,
      ...(statusline ? { statusline: true } : {}),
    };

    const session = newSession(info, claude);
    // Routed BEFORE the spawn is asked for: a host behind a socket may deliver
    // this PTY's first output before its spawn answer has been read.
    this.#ptys.set(id, session);
    // The first metadata blob rides the spawn (D9 P3): a backend that dies
    // right after it still left what the next one adopts the session from.
    const meta = sessionBlob(session);
    let pid: number;
    try {
      ({ pid } = await this.#host.spawn({
        id,
        file: opts.command,
        argv: spawnArgs,
        cwd: opts.cwd,
        env,
        cols: opts.cols,
        rows: opts.rows,
        ...(meta === undefined ? {} : { meta }),
      }));
    } catch (err) {
      this.#ptys.delete(id);
      // A failed spawn must not leave its settings file behind.
      if (statusline) this.#settings?.remove(id);
      throw err;
    }
    if (this.#closing) {
      // destroyAll() ran while the answer was in flight (§ Risks (a)): this
      // PTY is live and nobody else knows it. End it, never register it.
      this.#ptys.delete(id);
      this.#host.kill(id, 'now');
      this.#host.forget(id);
      if (statusline) this.#settings?.remove(id);
      this.#slog('info', `${id} spawned during shutdown; killed at once`);
      throw new Error('the backend is shutting down');
    }
    this.#sessions.set(id, session);
    this.#history.recordCreate(info, {
      id: historyKey,
      conversation: plan.conversation,
      baseArgs: plan.baseArgs,
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
      `${id} created: pid ${pid}, title ${JSON.stringify(info.title)}, ` +
        `project ${info.projectId ?? 'none'}, statusline ${statusline}, ` +
        `history key ${historyKey} (conversation ${plan.conversation})`,
    );
    const early = session.earlyEnd;
    if (early !== undefined) {
      // Ended before its registration could run (§ Risks (b)): stamped now.
      session.earlyEnd = undefined;
      this.#onExit(id, session, early.record, early.reason);
    }
    return { ...info };
  }

  /**
   * One chunk of PTY output: mirror ring, log counts, broadcast, bell and
   * title scan. `bytes` is `data`'s UTF-8 as the host sent it (Q12): the
   * mirror keeps it as is, never encodes `data` again.
   */
  #onOutput(id: string, session: Session, data: string, bytes: Buffer): void {
    const before = metaMarks(session);
    session.buffer.append(bytes);
    session.outBytes += bytes.byteLength;
    session.outChunks += 1;
    flushOutputLog(this.#slog, id, session, false);
    this.#broadcast(session, { type: 'data', data });
    const scan = scanOutput(data, session.scan);
    if (scan.bell) {
      session.info.attention = true;
      // C1: a BEL makes the session pending too; the `attention` frame is
      // the news on the wire, `pendingSince` rides the next info / GET.
      syncPending(session.info);
      this.#slog('debug', `${id} attention raised (BEL in output)`);
      this.#broadcast(session, { type: 'attention' });
    }
    // C2: an idle title keeps the stamp of the FIRST idle one (Claude Code
    // repaints its title about every second); any other title clears it.
    if (scan.titleIdle === true) session.titleIdleSince ??= Date.now();
    else if (scan.titleIdle === false) session.titleIdleSince = undefined;
    if (metaMarksChanged(session, before)) this.#flushMeta(id, session);
  }

  /** The PTY exited (the host already called off a ladder whose group is gone). */
  #onExit(id: string, session: Session, record: PtyExitRecord, reason: 'exit' | 'crash' = 'exit'): void {
    const exitCode = record.code;
    const signal = record.signal;
    session.info.status = 'exited';
    session.info.exitCode = exitCode;
    session.ptyLive = false;
    // Nothing waits on the title of a process that is gone.
    session.titleIdleSince = undefined;
    if (session.info.statusline === true) this.#settings?.remove(id);
    // The process is gone, so no new subagent can appear: stop polling its
    // transcripts. The list already on info stands — what it cost is still
    // true after the session ended.
    this.#agents?.untrack(id);
    // ...but a row still marked 'running' is no longer true: Claude Code runs
    // its subagents IN-PROCESS, so none of them outlived this exit, and the
    // browser would go on counting `now - startedAt` forever. The exit is the
    // fact the app knows, and its clock is the one that stamps the end.
    const endedAt = new Date(record.at).toISOString();
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
    // D6: a Claude launch (or resume) that died right after it started —
    // the one place program output reaches server.log: its first line,
    // escape-, bidi- and control-stripped and capped (earlyExitLine).
    const verdict =
      session.claude && !session.destroyed && reason === 'exit'
        ? earlyExitLine(session.info.createdAt, record.at, exitCode, session.buffer)
        : undefined;
    const early = verdict === undefined ? undefined : { line: verdict.line };
    if (verdict !== undefined) {
      session.info.earlyExit = { line: verdict.line };
      changed = true;
      this.#slog(
        'warn',
        `${id} Claude Code stopped right after it started (code ${exitCode}, after ${verdict.ranMs}ms, ` +
          `Claude Code ${this.#claudeVersion?.() ?? 'unknown'}): ${JSON.stringify(verdict.line)}`,
      );
    }
    if (changed) {
      // ONE extra frame, before the exit: the client upserts this session on
      // `info` and repaints on `exit`, so the repaint already draws the
      // corrected rows.
      this.#broadcast(session, { type: 'info', session: { ...session.info } });
    }
    // No-op if already stamped 'user-kill'/'shutdown' (first stamp wins).
    // 'crash' (D9 P3): the pty-host holding it was lost.
    this.#history.markEnded(id, reason, exitCode);
    // An exited session survives a backend restart too (D9): its blob is
    // the one a new backend rebuilds the row from.
    this.#flushMeta(id, session);
    this.#broadcast(session, { type: 'exit', exitCode, ...(early === undefined ? {} : { early }) });
    // Wording kept verbatim (tests and habits key off it); the signal and the
    // final output tally are appended.
    this.#log(
      'info',
      `session ${id} exited with code ${exitCode}` +
        `${signal === null || signal === 0 ? '' : ` (signal ${signal})`}`,
    );
    flushOutputLog(this.#slog, id, session, true);
    this.#slog(
      'info',
      `${id} totals: scrollback ${session.buffer.byteLength} bytes, ` +
        `${session.clients.size} client(s) attached at exit`,
    );
  }

  /**
   * Attach a client: replay the scrollback buffer's tail (replayTail) FIRST, then an info
   * snapshot (and an exit notice if already exited), then live traffic.
   * ws frames are delivered in send order per socket, and the client is only
   * added to the broadcast set after replay is queued, so replay always
   * precedes any live data on this socket.
   * Returns the replayed byte count (the WS layer logs the count, never the
   * content), or null for an unknown session.
   */
  attach(id: string, ws: WebSocket): number | null {
    const session = this.#sessions.get(id);
    if (session === undefined) return null;
    const replay = replayTail(session.buffer, REPLAY_MAX_LINES);
    this.#slog(
      'debug',
      `${id} attach: replaying ${replay.byteLength} of ${session.buffer.byteLength} ring bytes, ` +
        `status ${session.info.status}, ${session.clients.size + 1} client(s) after this one`,
    );
    this.#send(session, ws, { type: 'replay', data: replay.toString('utf8') });
    this.#send(session, ws, { type: 'info', session: { ...session.info } });
    if (session.info.status === 'exited') {
      const early = session.info.earlyExit;
      this.#send(session, ws, {
        type: 'exit',
        exitCode: session.info.exitCode ?? 0,
        ...(early === undefined ? {} : { early: { ...early } }),
      });
    }
    session.clients.add(ws);
    ws.on('close', () => session.clients.delete(ws));
    return replay.byteLength;
  }

  write(id: string, data: string): void {
    const session = this.#sessions.get(id);
    if (session === undefined || !session.ptyLive) return;
    // Counted, never logged per frame: one ws `input` frame is one keystroke.
    session.inBytes += Buffer.byteLength(data);
    session.inFrames += 1;
    this.#host.write(id, data);
    flushOutputLog(this.#slog, id, session, false);
  }

  resize(id: string, cols: number, rows: number): void {
    const session = this.#sessions.get(id);
    if (session === undefined) {
      this.#slog('debug', `${id} resize ignored: no such session`);
      return;
    }
    session.info.cols = cols;
    session.info.rows = rows;
    if (session.ptyLive) this.#host.resize(id, cols, rows);
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
    const before = metaMarks(session);
    if (prevTurn === 'working' && report.turn === 'waiting') session.info.turnEnded = true;
    else if (report.turn === 'working') delete session.info.turnEnded;
    syncPending(session.info);
    if (metaMarksChanged(session, before)) this.#flushMeta(id, session);
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
    const before = metaMarks(session);
    session.info.attention = false;
    // C1 (user, 2026-09-22): a look acks the BEL only. An ended turn stays
    // pending until the session works again or exits, so `pendingSince` goes
    // only when `turnEnded` is not set either.
    syncPending(session.info);
    if (metaMarksChanged(session, before)) this.#flushMeta(id, session);
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
   * The signal ladder is the host's (server/pty-table.ts `kill`): SIGHUP first
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
    session.destroyed = true;
    // D9 P3: a backend that dies before this PTY reports its exit must not
    // bring the deleted session back from the pty-host (an exited one is
    // dropped by the host at the `forget` below).
    if (session.ptyLive) this.#flushMeta(id, session);
    // No-op when the session never had one, or when onExit already removed it.
    if (session.info.statusline === true) this.#settings?.remove(id);
    // Same for the agents poll: no session, nothing to deliver a list to.
    this.#agents?.untrack(id);
    if (session.ptyLive) {
      // Stamp BEFORE kill so the async exit's 'exit' stamp is the no-op.
      // At server shutdown endAllLive() ran first, so THIS is the no-op.
      this.#history.markEnded(id, 'user-kill');
      session.ptyLive = false;
      // SIGHUP, then the ladder (DELETE) or SIGKILL to the group at once
      // (shutdown): server/pty-table.ts `kill`.
      this.#host.kill(id, by === 'shutdown' ? 'now' : 'ladder');
    }
    // The host drops its entry once the PTY has reported its exit.
    this.#host.forget(id);
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

  /**
   * Kill every PTY: a server shutdown (grace expiry, SIGTERM, `-Stop`), or a
   * restart that cannot keep the sessions (D9 P4, decision 27).
   */
  destroyAll(): void {
    this.#closing = true;
    const ids = [...this.#sessions.keys()];
    this.#slog('info', `destroying all ${ids.length} session(s) for shutdown`);
    for (const id of ids) this.destroy(id, 'shutdown');
    // Sessions already DELETEd whose ladder is still counting down: the caller
    // exits the process right after this returns, so the host finishes them
    // off now (server/pty-table.ts `shutdownAll`).
    this.#host.shutdownAll();
  }

  /**
   * D9 P4 — restart and update: hand every PTY to the next backend instead of
   * ending it (server/sessions-adopt.ts `detachSessions`).
   */
  detachAll(): void {
    this.#closing = true;
    detachSessions(this.#adoptCtx);
  }

  /**
   * D9 P3 — boot, before listen: take over the sessions a pty-host still holds
   * from an earlier backend (server/sessions-adopt.ts `adoptSessions`).
   */
  adopt(entries: readonly PtyEntrySummary[]): Promise<void> {
    return adoptSessions(this.#adoptCtx, entries);
  }

  /** Park the current blob with the PTY (D9 P3): what a restarted backend adopts the session from. */
  #flushMeta(id: string, session: Session): void {
    const meta = sessionBlob(session);
    if (meta === undefined) return;
    this.#host.setMeta(id, meta);
  }

  #broadcast(session: Session, message: ServerMessage): void {
    if (session.clients.size === 0) return;
    const text = JSON.stringify(message); // Once per broadcast, not once per client.
    // Q12: with more than one client, UTF-8 encoded once too — ws would encode
    // a string again for every socket. Still a TEXT frame, the same bytes.
    const payload = session.clients.size > 1 ? Buffer.from(text, 'utf8') : text;
    for (const ws of session.clients) this.#sendText(session, ws, payload);
  }

  #send(session: Session, ws: WebSocket, message: ServerMessage): void {
    this.#sendText(session, ws, JSON.stringify(message));
  }

  /**
   * One frame, then the backpressure check (Q9). Once CLOSING, nothing more is
   * queued; ws destroys the socket if the close handshake stalls 30 s.
   */
  #sendText(session: Session, ws: WebSocket, text: string | Buffer): void {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(text, { binary: false });
    const unsent = ws.bufferedAmount;
    if (!(unsent > MAX_CLIENT_BUFFERED_BYTES)) return; // Closed only when PROVEN over.
    ws.close(SLOW_CLIENT_CLOSE_CODE, 'client too slow');
    const id = session.info.id;
    session.slowCloseLines ??= slowCloseLimiter(this.#slog, id);
    // Counts only: the queued bytes are terminal output. Budgeted per session (a slow tab reconnects).
    if (session.slowCloseLines()) this.#slog('info', `${id} client closed, ${unsent} bytes unsent (cap ${MAX_CLIENT_BUFFERED_BYTES})`);
  }

}
