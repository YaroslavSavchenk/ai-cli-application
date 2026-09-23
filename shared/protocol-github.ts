/**
 * Wire shapes for the GitHub connection (github.json): status, token, repos, clone, create-repo.
 *
 * Split from shared/protocol.ts (O8, 2026-09-23) — a pure move; the wire
 * contract is unchanged. Import from shared/protocol.ts, which re-exports
 * everything here. Sibling pieces: 
 *   protocol.ts (the single import point), protocol-settings.ts, protocol-runtime.ts, protocol-github.ts, protocol-fs.ts, protocol-git.ts.
 */

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
