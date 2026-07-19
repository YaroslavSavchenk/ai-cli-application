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
 * interfaces are fine; no enums, no namespaces, no runtime code.
 */

// ---------------------------------------------------------------------------
// Core entities
// ---------------------------------------------------------------------------

/** Permission mode a session is launched with. */
export type PermissionMode = 'standard' | 'skip-permissions';

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
}

// ---------------------------------------------------------------------------
// Session journal (journal.json / previous.json in the data dir)
// ---------------------------------------------------------------------------
//
// The backend's lifetime is bound to UI presence (decided 2026-07-19): when
// the last window closes, a grace timer runs out and the backend kills all
// PTYs and exits. The journal is the crash/shutdown safety net: journal.json
// mirrors live sessions (atomic rewrite on every create/exit/delete and at
// shutdown). On boot, a leftover journal from the previous run is rotated to
// previous.json — entries still ended:null are stamped reason 'crash' — and
// a fresh journal begins.

/**
 * Why a session ended. 'crash' is never written to the live journal; it is
 * stamped only during boot rotation for entries the previous run left open.
 */
export type SessionEndReason = 'user-kill' | 'exit' | 'shutdown' | 'crash';

export interface SessionEnd {
  /** ISO-8601 timestamp. */
  at: string;
  reason: SessionEndReason;
}

/** One entry in journal.json / previous.json. */
export interface SessionJournalEntry {
  id: string;
  projectId?: string;
  /** Absolute working directory the PTY was spawned in. */
  cwd: string;
  command: string;
  args: string[];
  title: string;
  /** ISO-8601 timestamp. */
  createdAt: string;
  /** null while the session is live. */
  ended: SessionEnd | null;
  /** Present when the PTY exited on its own (reason 'exit'). */
  exitCode?: number;
}

/**
 * GET  /api/previous      -> PreviousSession[] — entries from previous.json
 *   whose ended.reason is 'shutdown' or 'crash' (user-kill and natural exit
 *   are NOT offered for relaunch).
 * DELETE /api/previous/:id -> OkResponse (dismiss one; 404 if unknown)
 * DELETE /api/previous     -> OkResponse (dismiss all)
 * Auth like every other /api route.
 */
export type PreviousSession = SessionJournalEntry;

// ---------------------------------------------------------------------------
// Runtime discovery file (runtime.json in the data dir)
// ---------------------------------------------------------------------------

/**
 * Written atomically with mode 0600 on startup; removed on clean
 * SIGINT/SIGTERM shutdown. Read by the Windows-side launcher and tooling.
 */
export interface RuntimeInfo {
  /** OS-assigned port the server is listening on (127.0.0.1 only). */
  port: number;
  /** Hex auth token, >= 32 bytes of entropy. */
  token: string;
  pid: number;
  /** ISO-8601 timestamp. */
  startedAt: string;
}

// ---------------------------------------------------------------------------
// REST shapes (JSON bodies/responses)
// ---------------------------------------------------------------------------
//
// Every /api route requires the header "X-Auth-Token: <token>".
// GET /health is unauthenticated and returns exactly {"ok":true}.

/** GET /health response. */
export interface HealthResponse {
  ok: true;
}

/**
 * GET /api/runtime response — runtime status for the UI (statusline uptime).
 * `startedAt` is the very same ISO-8601 timestamp the backend wrote to
 * runtime.json at boot. Deliberately excludes port/token/pid: the browser
 * must never need them, so they are not exposed here.
 */
export interface RuntimeStatusResponse {
  /** ISO-8601 timestamp. */
  startedAt: string;
}

/** Generic success response (DELETE /api/projects/:id, DELETE /api/sessions/:id, POST /api/sessions/:id/seen). */
export interface OkResponse {
  ok: true;
}

/**
 * POST /api/projects request body. Responds with the created Project.
 * Rejected if `path` is not an existing directory.
 */
export interface CreateProjectRequest {
  name: string;
  path: string;
  defaultModel?: string;
  defaultMode?: PermissionMode;
}

/**
 * GET /api/fs/list?path=<abs> response. Directory NAMES only — no files, no
 * contents. `path` must be absolute; defaults to $HOME when omitted.
 */
export interface FsListResponse {
  path: string;
  dirs: string[];
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

/** Clears session.attention (same effect as POST /api/sessions/:id/seen). */
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
// On expiry the backend marks live journal entries ended {reason:'shutdown'},
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
