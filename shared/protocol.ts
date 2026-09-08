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
//
// ONE READER exists outside the API (added 2026-07-26): server/statusline.mjs
// — the script Claude Code runs to draw its native status line — READS
// prefs.json directly (same user, same data dir) on EVERY invocation and
// honours the `statusLine` key below. That is what makes a settings-panel
// toggle apply to already-running sessions with no restart. It only reads;
// prefs.json is still written exclusively through PUT /api/prefs.

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
 * Which items Claude Code's OWN status line should draw, per user preference.
 * Persisted in the prefs bag under `statusLine` and read by server/statusline.mjs
 * — the script named in each claude session's injected `--settings` file — on
 * EVERY invocation, so flipping a toggle applies to running sessions with no
 * restart.
 *
 * Every member is optional; an absent member takes the factory default listed
 * below, and an absent/corrupt prefs.json means all factory defaults. An item is
 * drawn only when its toggle is on AND the payload carries an honest value for
 * it (a missing value is omitted, never rendered as zero/unknown).
 *
 * Sources, all from the JSON payload Claude Code pipes to the script on stdin
 * (verified against Claude Code 2.1.220) except where noted:
 */
export interface UiStatusLine {
  /** Master switch. Default ON. Off -> the script prints nothing (blank bar). */
  enabled?: boolean;
  /** `model.display_name` (falls back to `model.id`). Default ON. */
  model?: boolean;
  /**
   * Permission mode in plain words. NOT in the payload: it is passed to the
   * script as an argument, parsed from the session's own `--permission-mode`
   * arg at spawn (the script prefers a payload field if a future Claude Code
   * adds one). Default ON.
   */
  mode?: boolean;
  /**
   * Git branch. NOT in the payload either: the script runs
   * `git branch --show-current` (argv, no shell) in `workspace.current_dir`,
   * cached ~5 s per `session_id`. Default ON.
   */
  branch?: boolean;
  /** `cost.total_cost_usd`, drawn only when > 0. Default ON. */
  cost?: boolean;
  /** `cost.total_lines_added` / `total_lines_removed`, drawn only when nonzero. Default OFF. */
  lines?: boolean;
  /** `context_window.used_percentage` (null until the first turn). Default ON. */
  context?: boolean;
  /**
   * `rate_limits.five_hour.used_percentage` / `.seven_day.used_percentage` —
   * the real account rate-limit windows. Claude.ai Pro/Max only, and only after
   * the first API response of the session; absent -> the item is omitted.
   * Default OFF.
   */
  usage?: boolean;
}

/**
 * Open preferences bag stored in prefs.json. `theme` and `statusLine` are typed
 * because the client uses them; any other key is opaque to the server and
 * preserved verbatim on PUT — merge-on-write (read the bag, replace only the
 * touched key, PUT the whole thing back) happens client-side, see
 * web/src/ui/theme.ts. The HTTP layer still never interprets the bag; the one
 * consumer of `statusLine` is server/statusline.mjs, which reads the file
 * directly (see the note above this section).
 */
export interface UiPrefs {
  theme?: UiTheme;
  statusLine?: UiStatusLine;
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
  /**
   * Short git hash of the server code this process is RUNNING (not the code on
   * disk now), or null when it could not be read. Added 2026-09-06 so a stale
   * backend is identifiable from the UI as well as from the boot banner in
   * server.log.
   */
  serverCommit: string | null;
  /**
   * The hashed frontend entry bundle this backend SERVES, e.g.
   * `assets/index-Br1e6z0Q.js`, or null when web/dist is absent/unbuilt.
   * Compare with the bundle the page actually loaded to spot a stale process.
   */
  webBuild: string | null;
  /**
   * Live "is the code on disk newer than this process" check, computed per
   * request (added 2026-09-06). `available` is true when the server commit,
   * the built frontend, or a server source file has moved past this run;
   * `reason` is a SHORT human string for the log and the UI tooltip (e.g.
   * "frontend rebuilt"), null when nothing changed. Never a command, never a
   * path the UI would print raw.
   */
  update: UpdateStatus;
}

/**
 * The `update` member of RuntimeStatusResponse — its own name so the UI can
 * hold one. `reason` is one of a fixed set of constants (server/buildinfo.ts),
 * in this order of precedence: `dependencies changed`, `server code changed
 * (<a> → <b>)`, `frontend build missing`, `frontend rebuilt`, `frontend source
 * changed`, `server files edited`.
 */
export interface UpdateStatus {
  available: boolean;
  reason: string | null;
}

/**
 * POST /api/restart — the same-port handoff. Full status contract (the
 * sequence itself lives in server/restart.ts):
 *
 * - **202 `RestartResponse`** — handed off. The preflight passed (dependencies
 *   in step, the frontend rebuilt and verified, a standby backend booted and
 *   only THEN the new build swapped in), the old process then tore down and
 *   told the standby to take the port; it is exiting as this body is flushed.
 * - **409 `{ error }`** — a restart is already in flight (preflight or
 *   handoff). Nothing changed.
 * - **422 `{ error }`** — the PREFLIGHT REFUSED (added 2026-09-08). The old
 *   backend is UNTOUCHED: still listening, sessions still alive, `web/dist`
 *   unchanged and the staged `web/dist-next` removed — the swap is the LAST
 *   preflight step, after the replacement has reported ready, so a refusal
 *   never puts new screens in front of the old backend. Reasons are constants:
 *   dependencies changed (run `npm install`), the frontend could not be
 *   rebuilt, or the replacement failed to start. The UI must un-arm its
 *   "restarting" state and show `error` — never reload.
 * - **500 `{ error }`** — the handoff failed AFTER the teardown: sessions are
 *   already ended and the listener is closed, so the old process answers this
 *   and exits anyway. The UI tells the user to relaunch from the shortcut.
 * - **503 `{ error }`** — no restart mechanism wired (test harnesses).
 *
 * 202 body: `samePort` false means the child could not take the port back
 * (busy) and auto-picked `port` instead: a host window locked to the launch
 * origin cannot follow, so the UI says "relaunch" rather than reloading.
 * The auth token is NEVER in this body; the reloaded page gets a fresh one.
 */
export interface RestartResponse {
  port: number;
  startedAt: string;
  samePort: boolean;
}

// ---------------------------------------------------------------------------
// Client log shipping (POST /api/client-log)
// ---------------------------------------------------------------------------
//
// The browser is only a view, but its failures are invisible in server.log —
// which is the ONLY diagnostic channel a detached backend has. The frontend
// batches its own log lines here and the server writes each one as
// `[client] <message>` at the entry's level, with the client's timestamp
// appended so clock skew is visible.
//
// Server-side limits (server/api.ts): 64 KiB body (413 beyond), 50 entries per
// request (the rest are dropped), `message` truncated to 2048 characters and
// stripped of control characters, an unknown `level` becomes 'info', an invalid
// `at` becomes server time, and ≥200 entries/minute across all clients are
// dropped. Answers 204.
//
// NEVER put anything sensitive in `message`: it lands in server.log verbatim.

/** Severity of one client log entry; anything else is treated as 'info'. */
export type ClientLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface ClientLogEntry {
  level: ClientLogLevel;
  /** ISO-8601 timestamp taken on the CLIENT. */
  at: string;
  message: string;
}

export interface ClientLogRequest {
  entries: ClientLogEntry[];
}

// ---------------------------------------------------------------------------
// GitHub connection (github.json in the data dir) — device flow OR pasted token
// ---------------------------------------------------------------------------
//
// Phase 2b: a first-class GitHub connection via OAuth DEVICE FLOW. The server
// owns the WHOLE OAuth exchange; the browser only ever sees status + the
// user_code + repo metadata. The device_code and the access_token stay 100%
// server-side (github.json in the data dir, mode 0600) and are NEVER returned
// to the browser, embedded in a response, or written to server.log.
//
// SECOND CREDENTIAL PATH (2026-07-25, user's decision): the user may instead
// PASTE a GitHub token (POST /api/github/token). It is stored and used exactly
// where the device-flow token is, needs NO OAuth App, and is therefore the path
// that works before a client id exists. Exactly ONE credential exists at a
// time — pasting replaces a device-flow connection and cancels its in-flight
// poll. `source` records which path produced the current credential.
//
// Config: the OAuth App client_id comes from env AI_SM_GITHUB_CLIENT_ID. When
// it is absent/empty only the DEVICE FLOW is unavailable
// (status.deviceFlowAvailable=false, POST device -> 409 { deviceFlowAvailable:
// false }); the pasted-token path and every connected route keep working, since
// they need a credential, not a client id. No client_secret is used or stored
// (a public OAuth app's device flow needs none). Device-flow scope = `repo`.
//
// Config: env AI_SM_GITHUB_API_BASE re-points the REST API base
// (https://api.github.com by default). UNSET IN NORMAL USE — it exists only as a
// test seam, so the offline suite can stand a local stub in for GitHub. It is
// the variable that decides WHERE THE OAUTH BEARER TOKEN IS SENT, so it accepts
// LOOPBACK ORIGINS ONLY (127.0.0.1 / [::1] / localhost, bare origin, no
// credentials); any other value makes the server refuse to start. It moves
// nothing else: the device-flow urls (github.com/login/...) and the clone
// host-lock (exactly github.com) stay hardcoded.
//
// Endpoints (ALL behind the same X-Auth-Token + Origin/Host gate as every /api
// route):
//   POST /api/github/device     -> 200 { userCode, verificationUri, expiresAt }
//                                  or 409 { deviceFlowAvailable:false } when no
//                                  client id is configured.
//                                  Starts the device flow + server-side polling.
//   POST /api/github/token      -> 200 GithubStatus (GithubTokenRequest body).
//                                  Validates a PASTED token against GitHub and
//                                  connects with it. NEVER a GET, and the token
//                                  travels ONLY in the request body.
//   GET  /api/github/status     -> 200 GithubStatus.
//   POST /api/github/disconnect -> 200 OkResponse. Drops the token locally
//                                  (deletes github.json); no token is ever
//                                  echoed back. Identical for both sources.
//   GET  /api/github/repos?q=   -> 200 GithubReposResponse, or 409 when not
//                                  connected. `q` filters
//                                  client-side on name/owner/fullName/description.

/**
 * GET /api/github/status response (also the 200 body of POST /api/github/token).
 * `state` is the connection state. `login` is present ONLY when connected;
 * `userCode`/`verificationUri` are present ONLY while connecting (the user
 * enters `userCode` at `verificationUri`).
 * The access token is NEVER present in this shape — not whole, not as a prefix,
 * a suffix, a length, a hash or a masked form. It stays server-side.
 */
export interface GithubStatus {
  /**
   * An OAuth App client id exists on this server, so the DEVICE FLOW can be
   * offered. Replaced the old `configured` field (2026-07-25): it says nothing
   * about whether the app is connected and MUST NOT gate the pasted-token
   * affordance — the token path exists precisely for servers where this is
   * false.
   */
  deviceFlowAvailable: boolean;
  state: 'disconnected' | 'connecting' | 'connected';
  /** GitHub login of the connected account (present only when connected). */
  login?: string;
  /** Device-flow user code to enter at `verificationUri` (present only while connecting). */
  userCode?: string;
  /** Where the user enters `userCode` (present only while connecting). */
  verificationUri?: string;
  /**
   * ISO-8601 expiry, present in two different situations:
   *   - while CONNECTING: when the current device code expires;
   *   - while CONNECTED: when the credential itself expires, if GitHub said so
   *     (the `github-authentication-token-expiration` response header, which
   *     fine-grained tokens with an expiry carry). Absent = no expiry is known,
   *     which is NOT a promise that the credential never expires.
   */
  expiresAt?: string;
  /**
   * Which path produced the current credential (present only when connected).
   * A stored record without a source reads as 'device' — every record written
   * before the token path existed came from the device flow.
   */
  source?: 'device' | 'pat';
  /**
   * Whether the current credential is written to disk (github.json). False =
   * it lives only in this backend process and is gone when the process exits
   * (~30 s after the last window closes). Present only when connected.
   */
  persisted?: boolean;
  /**
   * Classic-PAT scopes, from GitHub's `x-oauth-scopes` response header.
   *
   * ABSENT means GitHub sent no such header — which is what a FINE-GRAINED
   * token looks like, since its permissions are not expressible as scopes.
   * Absence must NEVER be rendered as "no permissions"; the honest reading is
   * "not reported". An EMPTY ARRAY is different and real: a classic token that
   * carries no scopes at all.
   */
  scopes?: string[];
}

/**
 * POST /api/github/token request body — the PASTED-token credential path.
 * Responds 200 with the resulting GithubStatus (never the token, in any form).
 *
 * INGRESS: the body is the ONLY channel this token may arrive through. Never a
 * query parameter, path segment, custom header, or WebSocket url — those end up
 * in logs, shell history and referrers. The route is POST-only (405 on GET),
 * requires `content-type: application/json` (415 otherwise), and caps the body
 * at 4096 bytes.
 *
 * `token` is validated by SHAPE only: trimmed (clipboards add whitespace),
 * non-empty, at most 1024 characters, no whitespace or control characters
 * inside. There is deliberately NO prefix allowlist — `ghp_`, `github_pat_`,
 * `gho_`, `ghu_`, `ghs_` and legacy 40-hex tokens are all valid, and GitHub is
 * free to invent more. Whether the token WORKS is decided by GitHub
 * (`GET /user` + `GET /user/repos?per_page=1`), never by a pattern here.
 *
 * `remember` is required and decides persistence: true writes github.json
 * (0600) so the connection survives a backend restart; false keeps the
 * credential in the backend process ONLY and removes any existing github.json,
 * so a restart is disconnected.
 *
 * Failures answer `{ error }` with a message derived from GitHub's STATUS, never
 * from its response body: 400 for a token GitHub rejected (401) or refused
 * (403, e.g. an org requiring SSO authorization), 502 when GitHub could not be
 * reached or answered unexpectedly. No failure ever quotes the token.
 */
export interface GithubTokenRequest {
  token: string;
  remember: boolean;
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
 * is rejected (400). `dest` must be an absolute path that is not already a
 * non-empty directory (409) and whose parent exists (400) — with ONE exception,
 * for the owner-qualified destinations the GitHub panel now uses (settled
 * 2026-07-25): a single missing `<owner>` directory is created when `dest`'s
 * direct parent is named exactly after the owner segment of `cloneUrl` and that
 * parent's own parent already exists (one level, never `mkdir -p`; removed again
 * if the clone fails and it is still empty) — 403 when creating that directory
 * is denied by the filesystem. `dest` must also already be NORMALIZED: a `.`/
 * `..` component or a trailing slash is rejected (400), because such a path
 * reads as one directory and resolves to another. 409 when GitHub is not
 * connected; 502 on clone failure. After cloning, `dest` is
 * registered as a project named `name` (or the repo basename from `cloneUrl`) —
 * except when a project ALREADY carries that name, in which case the clone is
 * registered as `<owner>/<repo>` so the UI, which shows names only, can tell the
 * two apart. THE SHAPE BELOW IS UNCHANGED by any of this.
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
 * NO token and NO raw body dump. 409 when not connected. This is a
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
