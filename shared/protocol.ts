/**
 * Shared protocol contract for the AI CLI Session Manager.
 *
 * This file is the single source of truth, in code form, for everything that
 * crosses a process boundary: the runtime discovery file, REST request and
 * response bodies, and WebSocket message frames.
 *
 * Consumers:
 *   - server/  (imported with an explicit `.ts` extension — Node 24 native
 *     type stripping, erasable syntax only)
 *   - web/src/ (bundled by Vite)
 *
 * Changing anything here changes the wire contract. Update every consumer
 * and flag the change in review.
 *
 * Constraints on this file: erasable TypeScript syntax only — types and
 * interfaces are fine; no enums, no namespaces; runtime code only as
 * plain constants and tiny type guards both sides share (limits, key names,
 * update sentences).
 */

// ---------------------------------------------------------------------------
// The pieces (O8, 2026-09-23): this file stays the single import point and
// re-exports every topic file, so every importer keeps importing from here.
// ---------------------------------------------------------------------------

export * from './protocol-settings.ts';
export * from './protocol-runtime.ts';
export * from './protocol-github.ts';
export * from './protocol-fs.ts';
export * from './protocol-git.ts';

// ---------------------------------------------------------------------------
// Core entities
// ---------------------------------------------------------------------------

/** Permission mode a session is launched with. */
export type PermissionMode = 'standard' | 'skip-permissions';

/**
 * The four Claude Code `--permission-mode` values, in launch-dialog vocabulary.
 * Distinct from the legacy 2-value `PermissionMode` above (which projects still
 * use): this is what the launch dialog's permission cards and the settings
 * panel's default speak. launch-args.ts's `Perm` aliases this.
 */
export type ClaudePermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';

/**
 * A project as stored in projects.json in the data dir
 * (~/.ai-session-manager/ by default, overridable via AI_SM_DATA_DIR).
 * The UI shows `name`, never `path`.
 */
export interface Project {
  id: string;
  name: string;
  /** Absolute path to an existing directory. */
  path: string;
  defaultModel?: string;
  defaultMode?: PermissionMode;
  /** ISO-8601 timestamp. */
  createdAt: string;
}

export type SessionStatus = 'running' | 'exited';

/**
 * A session is a server-side object with its own lifetime; the browser is
 * only a view. The PTY keeps running with no client attached, and an exited
 * session stays listed (with its scrollback) until DELETEd — but only while
 * the backend itself lives: with zero presence connections AND zero attached
 * session sockets past the grace timer, the backend ends all sessions and
 * exits (see the presence-channel docs below).
 */
export interface SessionInfo {
  id: string;
  projectId?: string;
  title: string;
  /** The launched agent is a configurable command + args — never assume a specific CLI. */
  command: string;
  args: string[];
  /** Absolute working directory the PTY was spawned in. */
  cwd: string;
  status: SessionStatus;
  /** Present once status is 'exited'. */
  exitCode?: number;
  cols: number;
  rows: number;
  /** ISO-8601 timestamp. */
  createdAt: string;
  /** True when a BEL (0x07) was seen in output and not yet acknowledged via 'seen'. */
  attention: boolean;
  /**
   * True when the server injected `--settings <file>` into the spawned argv to
   * give THIS session Claude Code's own status line. Only ever true for
   * claude-kind sessions (basename(command) === 'claude') whose client-supplied
   * args did not already carry `--settings`.
   *
   * `args` above deliberately does NOT contain the injected flag — it stays the
   * client's own argv, so the history entry (and therefore a resume) never
   * points at a per-session settings file that was wiped at boot; the resume
   * gets a fresh one injected instead. The same holds for the injected
   * `--session-id` that pins a claude session to a conversation.
   *
   * The UI needs this to tell which running sessions predate a status-line
   * change that only takes effect on a new session (toggling ITEMS applies to
   * running sessions live — the script re-reads prefs.json every invocation —
   * but a session spawned without `--settings` has no status line at all until
   * it is relaunched).
   */
  statusline?: boolean;
  /**
   * Nocturne B1: what Claude Code last reported about this session, read from
   * the per-session snapshot server/statusline.mjs writes into
   * `<dataDir>/statusline-snapshots/<id>.json` (server/telemetry.ts). Absent
   * until the first snapshot; replaced whenever it changes (the server then
   * re-sends `info`); kept after exit — cost so far is still true then.
   */
  telemetry?: SessionTelemetry;
  /**
   * Nocturne B7: the subagents Claude Code ran for this session, from its
   * transcripts (server/agents.ts). Absent until the first one; running ones
   * first (oldest first, at most 4), then — only when fewer than 4 run — the
   * one most recently finished; `agentCounts` carries the totals; replaced
   * whenever the list changes (the server re-sends `info`); kept after exit.
   */
  agents?: SessionAgent[];
  /** Nocturne B11: totals behind `agents` (present exactly when `agents` is). */
  agentCounts?: SessionAgentCounts;
  /**
   * Nocturne B11: the transcript's verdict. Absent = unknown (no transcript
   * path known, refused path, no counting line yet, a non-claude session); a
   * known transcript Claude Code has not written yet reads 'waiting'. Dropped
   * when the session exits.
   */
  turn?: SessionTurn;
  /**
   * Nocturne C1 (.claude/plans/nocturne/PLAN-C1.md § The signal): true once
   * `turn` went 'working' -> 'waiting' (Claude ended its turn). Never set by
   * a first readout of 'waiting' (a fresh session at its first prompt, or the
   * backend's first read of an old transcript) nor for a session without a
   * turn readout. Cleared ONLY when `turn` goes back to 'working' and at
   * exit — NOT by the `seen` ack (user, 2026-09-22, on the Windows check: the
   * mascot for a finished turn stays until the session works again, also
   * while the user looks at it). Absent when false. Only the peek mascot
   * counts it — `attention` semantics stay BEL-only (B11).
   */
  turnEnded?: boolean;
  /**
   * Nocturne C1 (PLAN-C1.md § The signal): ISO-8601 time the session last
   * became pending, i.e. `attention || turnEnded` went false -> true. Kept
   * while either stays set; absent while neither is. Orders the mascots
   * (oldest = slot 0).
   */
  pendingSince?: string;
}

/**
 * Claude Code's own report about a session, via the status-line payload
 * (decision 2 of PLAN-NOCTURNE.md, 2026-09-16). Every value is OPTIONAL and
 * absent when the payload had no real one (honesty rule: no zero-as-unknown).
 * All of it crossed an untrusted file in the data dir and was sanitised by
 * server/telemetry.ts parseSnapshot: strings control-stripped and capped at
 * 64, numbers finite and clamped.
 */
export interface SessionTelemetry {
  /** ISO-8601: when the snapshot was written. */
  at: string;
  /** `model.display_name` (falls back to `model.id`). */
  model?: string;
  /** Branch the script probed in the workspace dir; absent when its toggle is off or not a repo. */
  branch?: string;
  /** `cost.total_cost_usd`, only when > 0. */
  costUsd?: number;
  /** `cost.total_lines_added`, integer ≥ 0, only when the pair is nonzero. */
  linesAdded?: number;
  /** `cost.total_lines_removed`, integer ≥ 0, only when the pair is nonzero. */
  linesRemoved?: number;
  /** `context_window.used_percentage`, 0-100 integer. */
  contextPct?: number;
  /** `rate_limits.five_hour.used_percentage`, 0-100 integer. */
  usage5hPct?: number;
  /** `rate_limits.seven_day.used_percentage`, 0-100 integer. */
  usage7dPct?: number;
}

/** A subagent's dot: it is working, or it has ended (its turn, or it went quiet — PLAN-B7 § defaults). */
export type SessionAgentState = 'running' | 'finished';

/**
 * Nocturne B7: one subagent Claude Code ran for a session, read by
 * server/agents.ts from `~/.claude/projects/<slug>/<session-id>/subagents/`
 * (found through the snapshot's transcript path). Every string crossed an
 * untrusted file and was sanitised: control-stripped, capped (name 64, task
 * 120); numbers are finite integers ≥ 0.
 */
export interface SessionAgent {
  /** The hex after `agent-` in the file names: `^[a-f0-9]{1,32}$`. */
  id: string;
  /** `agentType` from the meta file (`agent` when it had none), mono in the UI. */
  name: string;
  /** `description` from the meta file — what it was asked to do, in words. */
  task: string;
  /** ISO-8601: the first transcript line, or the meta file's mtime before there is one. */
  startedAt: string;
  /** ISO-8601, present exactly when `state` is 'finished'. */
  endedAt?: string;
  /** Billed total across the agent's unique API messages: input + cache creation + cache read + output. */
  tokens: number;
  state: SessionAgentState;
}

/**
 * Nocturne B11: what a Claude session is doing between BELs, read from its own
 * transcript (server/agents.ts, PLAN-B11 § The turn rule): 'working' — Claude
 * is generating or running a tool; 'waiting' — it ended its turn and waits for
 * input.
 */
export type SessionTurn = 'working' | 'waiting';

/** Nocturne B11: every subagent the server tracks for a session (≤ 64), by state. */
export interface SessionAgentCounts {
  running: number;
  finished: number;
}

// ---------------------------------------------------------------------------
// Session history (history.json in the data dir) — replaces journal/previous
// ---------------------------------------------------------------------------
//
// Decided 2026-09-06 (user's call): every session the app launches is kept
// across backend runs and can be RESUMED — per conversation, not "the most
// recent conversation in that folder". Mechanism: a claude-kind session whose
// client args carry no resume/session flag is spawned with an injected
// `--session-id <uuid>` (the app session id itself), so the app knows the
// Claude conversation id; resuming spawns `claude <base args> --resume <id>`.
//
// history.json is the crash-safe store: an entry is written at create time
// (ended: null) and stamped at end; on boot every entry still ended:null is
// stamped 'crash'. Atomic 0600 rewrites, bounded (oldest ended entries drop
// past HISTORY_MAX = 200).
//
// Routes (auth like every other /api route):
//   GET    /api/history            -> HistoryEntry[] — ENDED entries only,
//                                     newest `lastUsedAt` first. Claude
//                                     conversations whose transcript is
//                                     provably absent (nothing was ever said)
//                                     are pruned and never listed.
//   POST   /api/history/:id/resume -> 201 SessionInfo (ResumeHistoryRequest
//                                     body). 404 unknown; 409 while the entry
//                                     is live; 400 when its cwd is gone.
//   DELETE /api/history/:id        -> OkResponse (forget one; 404 unknown)
//   DELETE /api/history            -> OkResponse (forget all ended entries)

/**
 * Why a session ended. 'crash' is never written by a running server; it is
 * stamped at boot for entries the previous run left open (ended: null).
 */
export type SessionEndReason = 'user-kill' | 'exit' | 'shutdown' | 'crash';

export interface SessionEnd {
  /** ISO-8601 timestamp. */
  at: string;
  reason: SessionEndReason;
}

/** One entry in history.json — a session the app launched, kept across runs. */
export interface HistoryEntry {
  /**
   * Stable entry key. For a claude-kind session the server pinned to a
   * conversation this IS the Claude conversation id (the injected
   * `--session-id`, or the uuid a client-supplied `--session-id`/`--resume`
   * carried); otherwise it is the app session id of the first launch.
   */
  id: string;
  /** True when `id` is a Claude conversation id that `--resume` can target. */
  conversation: boolean;
  /** App session id of the most recent launch of this entry. */
  sessionId: string;
  projectId?: string;
  /** Absolute working directory the PTY was spawned in. */
  cwd: string;
  command: string;
  /**
   * The base argv resume re-uses: the client's own args with any
   * `--session-id <v>`, `--resume <v>`, `-r <v>`, `--continue`, `-c` removed
   * and never the injected `--settings`/`--session-id`. Resume appends
   * `--resume <id>` (conversation) or `--continue` (claude without one).
   */
  args: string[];
  title: string;
  /** ISO-8601, first launch. */
  createdAt: string;
  /** ISO-8601, latest launch (== createdAt until the first resume). */
  lastUsedAt: string;
  /** null while the latest launch is live. */
  ended: SessionEnd | null;
  /** Present when the latest launch's PTY exited on its own (reason 'exit'). */
  exitCode?: number;
}

/** POST /api/history/:id/resume request body: the pane size for the new PTY. */
export interface ResumeHistoryRequest {
  cols: number;
  rows: number;
}

// ---------------------------------------------------------------------------
// REST shapes: generic answer, projects, the project-folder picker, sessions
// ---------------------------------------------------------------------------

/**
 * Generic success response, returned 200 by every mutating route that has no
 * richer body: PUT /api/prefs, DELETE /api/projects/:id, DELETE
 * /api/sessions/:id, POST /api/sessions/:id/seen, DELETE /api/history,
 * DELETE /api/history/:id.
 */
export interface OkResponse {
  ok: true;
}

/**
 * POST /api/projects request body. Responds 201 with the created Project.
 *
 * Two modes, selected by `create`:
 *   - REGISTER an existing directory (default; `create` absent or false):
 *     `path` must already be an absolute path to an existing directory —
 *     today's behavior, unchanged (400 otherwise).
 *   - CREATE a new local project (`create: true`): the server first makes the
 *     directory at `path` (mkdir recursive), then registers it. It refuses to
 *     clobber a path that already exists as a NON-EMPTY directory or as a
 *     non-directory (409). `gitInit` (default true) runs `git init` in the new
 *     directory; it is meaningful ONLY with `create: true` and ignored
 *     otherwise.
 */
export interface CreateProjectRequest {
  name: string;
  path: string;
  defaultModel?: string;
  defaultMode?: PermissionMode;
  /**
   * When true, create the directory at `path` before registering it. Absent or
   * false = today's behavior: `path` must already be an existing directory.
   */
  create?: boolean;
  /**
   * Only meaningful with `create: true`: run `git init` in the freshly created
   * directory. Defaults to true when omitted. Ignored when `create` is not set.
   */
  gitInit?: boolean;
}

/**
 * POST /api/projects/clone request body. Responds 201 with the created Project.
 * `git clone`s `url` into `dest` (argv, `{shell:false}`, `git clone -- url dest`),
 * then registers `dest` as a project named `name` (or the repo basename derived
 * from `url` when `name` is omitted/blank).
 *
 * `url` must be an http(s)://, git://, ssh://, or user@host: (scp-like) url;
 * file://, local paths, `-`-leading (option injection) and control-char urls
 * are rejected (400). `dest` must be an absolute path whose parent directory
 * exists and that does not already exist as a non-empty directory (400/409).
 */
export interface CloneProjectRequest {
  url: string;
  dest: string;
  name?: string;
}

/**
 * GET /api/fs/list?path=<abs> response. Directory NAMES only — no files, no
 * contents. `path` must be absolute; defaults to $HOME when omitted.
 */
export interface FsListResponse {
  path: string;
  dirs: string[];
  /**
   * True when the directory holds no entries at all (files, hidden files and
   * broken symlinks count too); lets the new-project dialog decide create vs add.
   */
  empty: boolean;
}

/**
 * POST /api/fs/mkdir request body. Creates a single new subdirectory `name`
 * inside the existing directory `parent`, returning its absolute path.
 *
 * `parent` must be an absolute path to an existing directory. `name` must be a
 * SINGLE safe path segment: no `/` or `\`, not `.`/`..` (nor an all-dots name),
 * no NUL/control chars, 1..255 chars. The target must not already exist.
 * Responds 201 with FsMkdirResponse.
 */
export interface FsMkdirRequest {
  parent: string;
  name: string;
}

/** POST /api/fs/mkdir response: the created directory's absolute path. */
export interface FsMkdirResponse {
  path: string;
}

/**
 * POST /api/sessions request body. Responds with the created SessionInfo.
 * cwd = explicit `cwd` or the project's path. The server spawns
 * command + args as an argv array via node-pty — client-supplied values
 * never enter a shell string.
 */
export interface CreateSessionRequest {
  projectId?: string;
  cwd?: string;
  command: string;
  args: string[];
  title?: string;
  cols: number;
  rows: number;
}

// GET /api/projects -> Project[]
// GET /api/sessions -> SessionInfo[]
// (arrays of the entity interfaces above; no wrapper object)

// ---------------------------------------------------------------------------
// WebSocket messages (/ws/sessions/:id?token=<token>)
// ---------------------------------------------------------------------------
//
// JSON text frames; terminal bytes are UTF-8 strings. Multiple concurrent
// clients per session are allowed.

/** Sent exactly once on attach, BEFORE any live data. `data` is the whole scrollback ring buffer. */
export interface ReplayMessage {
  type: 'replay';
  data: string;
}

/** Live PTY output. */
export interface DataMessage {
  type: 'data';
  data: string;
}

/** The PTY exited; the session stays listed as 'exited' until DELETEd. */
export interface ExitMessage {
  type: 'exit';
  exitCode: number;
}

/** A BEL (0x07) was seen in output; session.attention is now true. */
export interface AttentionMessage {
  type: 'attention';
}

/** Full session snapshot. */
export interface InfoMessage {
  type: 'info';
  session: SessionInfo;
}

export type ServerMessage =
  | ReplayMessage
  | DataMessage
  | ExitMessage
  | AttentionMessage
  | InfoMessage;

/** Keyboard/paste input for the PTY. */
export interface InputMessage {
  type: 'input';
  data: string;
}

/** Pane resize; the server calls pty.resize(cols, rows). */
export interface ResizeMessage {
  type: 'resize';
  cols: number;
  rows: number;
}

/**
 * Clears session.attention (same effect as POST /api/sessions/:id/seen) — and
 * session.pendingSince with it when session.turnEnded is not set. It never
 * clears turnEnded (Nocturne C1, user 2026-09-22).
 */
export interface SeenMessage {
  type: 'seen';
}

export type ClientMessage = InputMessage | ResizeMessage | SeenMessage;

// ---------------------------------------------------------------------------
// Presence channel (/ws/presence?token=<token>)
// ---------------------------------------------------------------------------
//
// Same auth/Host/Origin rules as the session WS. A connection IS the signal;
// no messages are required and inbound frames are ignored — EXCEPT a
// well-formed ping (below), which the server echoes back as a pong so each
// window can measure round-trip latency. Frames larger than 1024 bytes close
// the socket (1009 Message Too Big); malformed JSON, binary frames, non-ping
// types, and pings whose `t` is not a finite number are silently ignored
// (no reply, socket stays open).
//
// Ping/pong traffic has ZERO lifecycle effect: it never touches the
// counters or timers below — only the socket's existence does. The backend
// tracks presenceCount (open presence sockets) and attachedCount (open
// session sockets); a shutdown grace timer runs ONLY while both are zero:
//
//   - grace after the last client disconnects: 30000 ms default,
//     env override AI_SM_GRACE_MS (integer ms);
//   - startup grace from listen until the FIRST presence connection ever:
//     120000 ms default, env override AI_SM_STARTUP_GRACE_MS.
//
// On expiry the backend marks live history entries ended {reason:'shutdown'},
// kills all PTYs, removes runtime.json, and exits 0.

/** Client -> server on /ws/presence: latency probe. */
export interface PingMessage {
  type: 'ping';
  /** Client-chosen finite number (e.g. performance.now()); echoed verbatim. */
  t: number;
}

/** Server -> client: reply to a well-formed ping; `t` is the ping's `t`, unchanged. */
export interface PongMessage {
  type: 'pong';
  t: number;
}
