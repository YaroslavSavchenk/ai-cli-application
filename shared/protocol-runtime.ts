/**
 * Wire shapes for the running backend: runtime.json, /health, GET /api/runtime, updates, restart, client log shipping.
 *
 * Split from shared/protocol.ts (O8, 2026-09-23) — a pure move; the wire
 * contract is unchanged. Import from shared/protocol.ts, which re-exports
 * everything here. Sibling pieces: 
 *   protocol.ts (the single import point), protocol-settings.ts, protocol-runtime.ts, protocol-github.ts, protocol-fs.ts, protocol-git.ts.
 */

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
  /**
   * The directory the running backend was started from — the repo root on a
   * developer clone, `<app>/<version>` for an installed bundle (added
   * 2026-09-08). Optional: a file written by an older backend does not have it.
   * The installer reads it so it never prunes the version directory a live pid
   * is running out of.
   */
  appDir?: string;
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
   * INSTALLED MODE (2026-09-08): the version of the bundle this process runs
   * from (`bundle.json`'s `version`, e.g. `v0.2.0`), or null on a developer
   * clone — where `serverCommit` is the identity instead. Charset-gated
   * server-side (`server/bundle.ts`) before it ever reaches here.
   */
  version: string | null;
  /**
   * True when this backend runs from an installed bundle rather than a git
   * checkout. It changes what an update MEANS (a newer version unpacked beside
   * this one, not edited sources) and what a restart does (hand the port to
   * `<app>/current`, never run a build).
   */
  installed: boolean;
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
 *
 * INSTALLED MODE (2026-09-08, server/bundle.ts) replaces all six with a single
 * seventh reason — `a new version is installed`, meaning `<app>/current` points
 * at a version directory other than the running one. A packaged tree can
 * produce no other signal, and an installed backend never reports any of the
 * six above.
 */
export interface UpdateStatus {
  available: boolean;
  reason: string | null;
  /**
   * Present ONLY when `reason === 'a new version is available'` (installed
   * mode, phase E in-app update): the release the backend found on GitHub.
   * Never rendered as text by the UI — it drives the Update button and the
   * progress readout only. Precedence: `a new version is installed` (the
   * bundle on disk already moved) always wins over `a new version is
   * available` (the release exists online).
   */
  release?: UpdateRelease;
}

/**
 * POST /api/update/check (Nocturne B6) — no body. Runs the release check now
 * (a check already in flight is shared, never doubled) and answers 200 with
 * the SAME composed UpdateStatus that GET /api/runtime carries under `update`.
 * 503 UPDATE_NOT_AVAILABLE when this backend has no checker (not an installed
 * app); 405 for any other method. A failed check answers the last known
 * status — the checker never rejects, a failure is a log line.
 */

/** A published release the installed app could update to (phase E). */
export interface UpdateRelease {
  /** The release tag, e.g. `v0.3.0`; gated by the backend's VERSION_SHAPE. */
  version: string;
  /** `AI-Session-Manager-Setup-<version>.exe` — constructed by the backend. */
  setupName: string;
  /** The Setup asset URL; constructed by the backend and equality-checked against the API. */
  setupUrl: string;
  /** The release's `SHA256SUMS.txt` URL; same construction rule. */
  sumsUrl: string;
  /** Setup size in bytes (integer, ≤ 200 MiB); drives the percent readout. */
  size: number;
}

/**
 * Phase E in-app update — the install flow the Update button drives.
 *
 * - `POST /api/update` (authed, no body): `202 { version }` started ·
 *   `409 { error }` already in flight · `422 { error }` nothing to install /
 *   not installed mode / release gone · `503 { error }` no updater wired.
 * - `GET /api/update/status` (authed): `UpdateInstallStatus`, polled by the
 *   UI at 1 Hz while busy and once at page boot to adopt an install in flight.
 *
 * `error` is always one of the constant sentences below — never remote text.
 */
export type UpdateInstallState =
  | 'idle'
  | 'downloading'
  | 'verifying'
  | 'installing'
  | 'installed'
  | 'failed';

export interface UpdateInstallStatus {
  state: UpdateInstallState;
  /** The version being (or last) installed; null when idle. */
  version: string | null;
  /** 0..100 integer; meaningful while downloading. */
  percent: number;
  /** A constant sentence (see UPDATE_ERROR_*), or null. */
  error: string | null;
}

/** The only sentences `UpdateInstallStatus.error` may carry (wire contract). */
export const UPDATE_ERROR_DOWNLOAD = 'The update could not be downloaded.';
export const UPDATE_ERROR_CHECKSUM = 'The downloaded file did not match the release checksum.';
export const UPDATE_ERROR_SPACE = 'There was not enough space to download the update.';
export const UPDATE_ERROR_START = 'The update could not be started on Windows.';
export const UPDATE_ERROR_FINISH = 'The update did not finish.';

/** `UpdateStatus.reason` in installed mode when a newer release is published (phase E). */
export const UPDATE_NEW_VERSION_AVAILABLE = 'a new version is available';

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
