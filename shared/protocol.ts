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
// UI preferences (prefs.json in the data dir)
// ---------------------------------------------------------------------------
//
// GET  /api/prefs -> UiPrefs ({} if none stored yet).
// PUT  /api/prefs body: UiPrefs (REPLACES the whole stored object) ->
//   OkResponse. Body must be a JSON object (arrays/null/scalars are 400) and
//   <= 64 KiB (PREFS_MAX_BYTES in server/api.ts); the server stores it
//   VERBATIM and never interprets its contents — deliberately an opaque
//   bag, so a future user-gated settings panel can add keys without a
//   server-side schema change. Auth like every other /api route.

/**
 * The one UiPrefs member the client currently reads/writes — mirrors the
 * persisted shape in web/src/ui/theme-model.ts exactly: `bg`/`fg` are
 * indices into that module's GROUNDS/RAMPS tables, `scan` is the scanline
 * toggle.
 */
export interface UiTheme {
  bg: number;
  fg: number;
  scan: boolean;
}

/**
 * Launch defaults the settings panel persists (every member optional). The
 * launch dialog pre-selects from these; a per-launch override ALWAYS wins.
 * Like the rest of the prefs bag these are opaque to the server — it stores
 * them verbatim and never reads or validates them beyond the object/size
 * gate on PUT /api/prefs. Mirrors the panel's persisted shape.
 */
export interface UiLaunchDefaults {
  /** Pre-selected model for the launch dialog (e.g. a Claude model id). */
  model?: string;
  /** Pre-selected permission mode for the launch dialog (all four CLI modes). */
  permissionMode?: ClaudePermissionMode;
  /**
   * A line auto-typed into every new session once it is ready — e.g. a skill
   * or slash command. Empty/absent means no auto-run.
   */
  startupCommand?: string;
}

/**
 * Which per-pane terminal status-bar items the user wants shown. Persisted in
 * the prefs bag under `statusBar`; every member optional so the UI can add
 * items without a contract break. Opaque to the server (stored verbatim). The
 * account rate-limit `usage %` is deliberately ABSENT — it lives in live API
 * response headers, not the local logs, so there is no honest source for it.
 */
export interface UiStatusBar {
  /** Model id (from launch args / the session's Claude log). */
  model?: boolean;
  /** Permission mode (from launch args). */
  mode?: boolean;
  /** Git branch of the session cwd. */
  branch?: boolean;
  /** Elapsed session time (client-side, from createdAt). */
  time?: boolean;
  /** Approximate cumulative cost (Claude log × model pricing). */
  cost?: boolean;
  /** Context window used vs the model's max (latest Claude turn). */
  context?: boolean;
  /** Working-tree diff (+added / -deleted / untracked) of the session cwd. */
  diff?: boolean;
  /** Most-recent Skill tool_use in the session's Claude log (best-effort). */
  skill?: boolean;
}

/**
 * Open preferences bag stored in prefs.json. `theme`, `defaults` and
 * `statusBar` are typed because the client uses them; any other key is opaque
 * to the server and preserved verbatim on PUT — merge-on-write (read the bag,
 * replace only the touched key, PUT the whole thing back) happens client-side,
 * see web/src/ui/theme.ts. The server never interprets `defaults`/`statusBar`;
 * they are part of the opaque bag and only typed here so the UI and this
 * contract agree.
 */
export interface UiPrefs {
  theme?: UiTheme;
  defaults?: UiLaunchDefaults;
  statusBar?: UiStatusBar;
  [key: string]: unknown;
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

// ---------------------------------------------------------------------------
// Usage aggregates (GET /api/usage) — read-only Claude Code usage
// ---------------------------------------------------------------------------
//
// GET /api/usage -> UsageResponse. Authed like every /api route; GET only
// (405 otherwise). Read-only, informational: the backend streams Claude
// Code's OWN local session logs (<claudeDir>/projects/**/*.jsonl, where
// claudeDir is ~/.claude, override AI_SM_CLAUDE_DIR) and aggregates the
// per-message `usage` blocks. NEVER returns message content — token counts
// only. Absent/empty logs dir -> a valid zero response, never an error.
//
// Aggregation rules mirrored from the ccusage ecosystem:
//   - Only assistant records carrying a `usage` block are counted.
//   - Deduped by (message.id, requestId): the same message is copied across
//     JSONL files on session resume/fork; each unique pair counts once.
//   - Records whose model is '<synthetic>' (all-zero placeholder turns) are
//     dropped.
//   - Bucketed by LOCAL calendar day; the window is `today` plus the
//     preceding `windowDays - 1` days.
//   - Malformed JSONL lines are skipped and counted, never fatal.

/** Token counts, split by type; `total` is the sum of the other four. */
export interface UsageTokens {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
  total: number;
}

/** Aggregate for one local calendar day. */
export interface UsageDay {
  /** Local calendar day, YYYY-MM-DD. */
  date: string;
  tokens: UsageTokens;
  /** Deduped assistant/usage records on this day. */
  entryCount: number;
  /** Distinct Claude Code sessionIds seen on this day. */
  sessionCount: number;
  /** Distinct model ids seen on this day, sorted ascending. */
  models: string[];
}

/** Per-model totals across the whole window. */
export interface UsageModelTotal {
  model: string;
  tokens: UsageTokens;
  entryCount: number;
}

/**
 * GET /api/usage response. All figures are scoped to the window (`today`
 * plus the preceding `windowDays - 1` local days). `days` holds only days
 * that have data, ascending by date. Approximate/informational — the app
 * cannot see or change account-side limits.
 */
export interface UsageResponse {
  /** ISO-8601 timestamp when these aggregates were computed. */
  updatedAt: string;
  /** Number of local calendar days the window spans (incl. today). */
  windowDays: number;
  /** Days with data, ascending by `date`. */
  days: UsageDay[];
  /** Token totals across the window. */
  totals: UsageTokens;
  /** Per-model totals across the window, descending by total tokens. */
  models: UsageModelTotal[];
  /** Deduped entries across the window. */
  entryCount: number;
  /** Distinct sessionIds across the window. */
  sessionCount: number;
  /** JSONL lines skipped because they were not valid JSON. */
  malformedLines: number;
}

// ---------------------------------------------------------------------------
// Per-session telemetry (GET /api/telemetry) — read-only status-bar feed
// ---------------------------------------------------------------------------
//
// GET /api/telemetry -> TelemetryResponse. Authed like every /api route; GET
// only (405 otherwise). Feeds the per-pane terminal status bar. Every field is
// derived from a REAL source or OMITTED — the server never fabricates a value:
//   - branch/add/del/untracked: `git` probes (argv, no shell) in session.cwd.
//   - model/costUsd/contextTokens/contextMax/skill: the session's OWN Claude
//     Code JSONL log (only for claude-kind sessions), mapped by cwd-slug +
//     newest-after-spawn. costUsd is APPROXIMATE (log tokens × baked-in model
//     pricing) and cumulative for the session. Unknown model -> costUsd and
//     contextMax omitted (never guessed).
// Message CONTENT never leaves the server — only these numeric/string fields.
// Git/log failures omit the affected field; the endpoint is 200 with partial
// data, NEVER 500 (mirrors GET /api/usage "absent -> valid response").

/**
 * Telemetry for one running session. Every field is optional and present ONLY
 * when a real value was sourced; an absent field means "no honest value",
 * never zero-as-unknown.
 */
export interface TelemetryItem {
  /** Git branch of the session cwd (detached HEAD shows "HEAD"). */
  branch?: string;
  /** Lines added in the working-tree diff (git diff --numstat sum). */
  add?: number;
  /** Lines deleted in the working-tree diff (git diff --numstat sum). */
  del?: number;
  /** Untracked file count (git ls-files --others --exclude-standard). */
  untracked?: number;
  /** Model id from the latest assistant turn in the session's Claude log. */
  model?: string;
  /** Approximate cumulative session cost in USD (rounded to cents). */
  costUsd?: number;
  /** Context tokens sent on the latest assistant turn (input + cache read + cache creation). */
  contextTokens?: number;
  /** The model's context-window size (from the pricing table). */
  contextMax?: number;
  /** Most-recent Skill tool_use name in the session's Claude log (best-effort). */
  skill?: string;
}

/**
 * GET /api/telemetry response. Keyed by SessionInfo.id; contains an entry for
 * every RUNNING session (exited sessions are omitted — the client keeps their
 * last-known value). A session with no sourceable data maps to an empty {}.
 */
export interface TelemetryResponse {
  sessions: Record<string, TelemetryItem>;
}

// ---------------------------------------------------------------------------
// GitHub connection (github.json in the data dir) — OAuth device flow
// ---------------------------------------------------------------------------
//
// Phase 2b: a first-class GitHub connection via OAuth DEVICE FLOW. The server
// owns the WHOLE OAuth exchange; the browser only ever sees status + the
// user_code + repo metadata. The device_code and the access_token stay 100%
// server-side (github.json in the data dir, mode 0600) and are NEVER returned
// to the browser, embedded in a response, or written to server.log.
//
// Config: the OAuth App client_id comes from env AI_SM_GITHUB_CLIENT_ID. When
// it is absent/empty the feature is "not configured" — every endpoint answers
// a clean not-configured signal (status.configured=false, POST device -> 409
// { configured:false }, repos -> 409) and never crashes. No client_secret is
// used or stored (a public OAuth app's device flow needs none). Scope = `repo`.
//
// Endpoints (ALL behind the same X-Auth-Token + Origin/Host gate as every /api
// route):
//   POST /api/github/device     -> 200 { userCode, verificationUri, expiresAt }
//                                  or 409 { configured:false } when unconfigured.
//                                  Starts the device flow + server-side polling.
//   GET  /api/github/status     -> 200 GithubStatus.
//   POST /api/github/disconnect -> 200 OkResponse. Drops the token locally
//                                  (deletes github.json); no token is ever
//                                  echoed back.
//   GET  /api/github/repos?q=   -> 200 GithubReposResponse, or 409 when not
//                                  connected/configured. `q` filters
//                                  client-side on name/owner/fullName/description.

/**
 * GET /api/github/status response. `configured` reflects whether an OAuth App
 * client_id is present; `state` is the connection state. `login` is present
 * ONLY when connected; `userCode`/`verificationUri`/`expiresAt` are present
 * ONLY while connecting (the user enters `userCode` at `verificationUri`).
 * The access token is NEVER present in this shape — it stays server-side.
 */
export interface GithubStatus {
  configured: boolean;
  state: 'disconnected' | 'connecting' | 'connected';
  /** GitHub login of the connected account (present only when connected). */
  login?: string;
  /** Device-flow user code to enter at `verificationUri` (present only while connecting). */
  userCode?: string;
  /** Where the user enters `userCode` (present only while connecting). */
  verificationUri?: string;
  /** ISO-8601 expiry of the current device code (present only while connecting). */
  expiresAt?: string;
}

/**
 * One repository in GET /api/github/repos, mapped down from the GitHub API to
 * exactly these fields — no token, no raw payload leaks through.
 */
export interface GithubRepo {
  /** "owner/name". */
  fullName: string;
  name: string;
  owner: string;
  private: boolean;
  description?: string;
  language?: string;
  /** ISO-8601 last-push timestamp. */
  pushedAt?: string;
  /** https clone url (used by Phase 2c clone-by-picking). */
  cloneUrl: string;
}

/** GET /api/github/repos response. */
export interface GithubReposResponse {
  repos: GithubRepo[];
}

/**
 * POST /api/github/clone request body (Phase 2c: clone-by-picking). Responds
 * 201 with the created Project. Clones a (possibly PRIVATE) repo of the
 * CONNECTED account into `dest` using the server-side OAuth token — supplied to
 * git via GIT_ASKPASS-through-env so it NEVER touches argv, the clone url, or
 * `.git/config`. `cloneUrl` MUST be `https://` with host EXACTLY `github.com`
 * (hard SSRF/token-exfil guard: the token can only ever be sent to GitHub); any
 * other host, non-https, `-`-leading, control-char, or credential-embedding url
 * is rejected (400). `dest` must be an absolute path whose parent exists and
 * that is not already a non-empty directory (400/409). 409 when GitHub is not
 * connected/configured; 502 on clone failure. After cloning, `dest` is
 * registered as a project named `name` (or the repo basename from `cloneUrl`).
 */
export interface GithubCloneRequest {
  cloneUrl: string;
  dest: string;
  name?: string;
}

/**
 * POST /api/github/repos request body (Phase 2c: create-repo). Responds 201
 * with the created GithubRepo. Calls `POST https://api.github.com/user/repos`
 * with the server-side token in the Authorization header only (never echoed
 * back). `name` is required and bounded; `private` is required. GitHub
 * validation failures (e.g. 422 name-already-taken) surface as a clean 4xx with
 * NO token and NO raw body dump. 409 when not connected/configured. This is a
 * SEPARATE endpoint from POST /api/github/clone: the frontend chains
 * create -> clone; the server never auto-clones here.
 */
export interface GithubCreateRepoRequest {
  name: string;
  private: boolean;
  description?: string;
}

/**
 * Generic success response, returned 200 by every mutating route that has no
 * richer body: PUT /api/prefs, DELETE /api/projects/:id, DELETE
 * /api/sessions/:id, POST /api/sessions/:id/seen, DELETE /api/previous,
 * DELETE /api/previous/:id.
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
