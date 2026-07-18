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
 * session stays listed (with its scrollback) until DELETEd.
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
