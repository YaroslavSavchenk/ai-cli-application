/**
 * GitHub connection — TWO credential paths, ONE credential at a time.
 *
 *   1. OAuth DEVICE FLOW (Phase 2b). The server owns the WHOLE OAuth exchange;
 *      the browser only ever triggers the flow, shows the user_code, polls
 *      status, and reads repo metadata.
 *   2. A PASTED TOKEN (connectWithToken, 2026-07-25). Needs no OAuth App, which
 *      is what makes the feature usable before a client id exists. Validated
 *      against GitHub, then used wherever the device-flow token is used.
 *
 * Whichever produced it, the credential lives 100% server-side:
 *
 *   - it is persisted to github.json in the data dir via atomicWriteFile (mode
 *     0600), mirroring prefs.ts — EXCEPT for a pasted token stored with
 *     remember=false, which stays in this process and is never written at all;
 *   - no public method that feeds an HTTP response ever returns the token — not
 *     whole, not a prefix, a suffix, a length, a hash or a masked form — and the
 *     token / device_code are NEVER written to server.log (cf. the runtime.json
 *     token-redaction rule);
 *   - errors are generic and STATUS-derived; GitHub response bodies are never
 *     surfaced or dumped to the log.
 *
 * STORAGE CEILING, stated plainly (memory/knowledge/wsl-0600-not-a-boundary.md):
 * 0600 plus discipline. Nothing here encrypts the token, and nothing may claim
 * it does. There is no OS keyring in this environment (verified absent), and on
 * WSL2 the 9p file server runs as root inside the distro, so ANY process running
 * as the Windows user reads every 0600 file in the data dir through
 * \\wsl.localhost\... regardless of the permission bits. The honest promise is
 * "stored on this machine, readable by your own user account" — no more.
 *
 * Config: the OAuth App client_id comes from env AI_SM_GITHUB_CLIENT_ID (passed
 * in by index.ts). Absent/empty means only that the DEVICE FLOW is unavailable
 * (status.deviceFlowAvailable=false, startDeviceFlow -> not-configured); the
 * pasted-token path and every connected operation keep working, because they
 * need a credential, not a client id. No client_secret is used or stored — a
 * public OAuth app's device flow does not need one. Device-flow scope = `repo`.
 * The REST API base (api.github.com) is overridable via AI_SM_GITHUB_API_BASE
 * for offline tests, but ONLY with a loopback origin (config.ts
 * assertLoopbackApiBase; anything else makes the server refuse to start) — the
 * token must never be sendable to a remote host. The device-flow urls and the
 * clone host-lock (exactly github.com) are NOT affected by that knob.
 *
 * State machine (see status()):
 *   disconnected --startDeviceFlow()--> connecting --(poll: access_token)--> connected
 *   connecting --(expiry / access_denied / expired_token)--> disconnected
 *   disconnected|connecting|connected --connectWithToken(ok)--> connected
 *   connected  --disconnect()--> disconnected
 *   connected  --(listRepos/createRepo 401)--> disconnected
 * Polling is bounded: it stops on success/expiry/disconnect, honors the server
 * `interval` (and `slow_down`), and is hard-capped by the device code's expiry
 * (also clamped to MAX_FLOW_SECONDS) and MAX_POLLS iterations. Accepting a
 * pasted token bumps the generation counter, so an in-flight device poll
 * self-cancels — there is never a merge or a fallback chain between the two.
 *
 * HTTP is done with the Node global `fetch` (no new deps); the fetch impl is
 * injectable (a seam) so tests can drive the state machine with no network.
 *
 * Split by topic (PLAN-RESTRUCTURE O8, 2026-09-23): the seams, GithubError and
 * every parser of remote/pasted input live in server/github-parse.ts (all
 * re-exported here); the authenticated clone's host-lock, destination rules and
 * `git clone` spawn in server/github-clone.ts.
 *
 * Erasable TypeScript only; relative imports carry explicit .ts extensions.
 */
import { spawn } from 'node:child_process';
import { readFileSync, unlinkSync } from 'node:fs';
import type { GithubRepo, GithubStatus } from '../shared/protocol.ts';
import {
  assertLoopbackApiBase,
  atomicWriteFile,
  errorStackOnly,
  scoped,
  DEFAULT_GITHUB_API_BASE,
  USER_AGENT,
  type Logger,
} from './config.ts';
import {
  asRecord,
  filterRepos,
  GithubError,
  mapRepo,
  parseScopesHeader,
  parseTokenExpiry,
  readString,
  validatePastedToken,
  type FetchLike,
  type SpawnLike,
  type TokenRejection,
} from './github-parse.ts';
import { buildAuthenticatedGithubUrl, cloneIntoDestination } from './github-clone.ts';

// Split out by PLAN-RESTRUCTURE O8 (2026-09-23) and re-exported so every importer
// of this module keeps its surface.
export {
  filterRepos,
  GithubError,
  mapRepo,
  MAX_PASTED_TOKEN_LEN,
  parseGithubRemote,
  parseGithubRepoPath,
  parseScopesHeader,
  parseTokenExpiry,
  validatePastedToken,
  type FetchLike,
  type SpawnLike,
  type TokenRejection,
} from './github-parse.ts';

/**
 * GitHub endpoints. The device flow lives on github.com and is NEVER
 * overridable; only the REST API base (api.github.com by default) can be
 * re-pointed, and only at a loopback origin — see assertLoopbackApiBase.
 */
const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
/** REST paths appended to the API base. */
const USER_PATH = '/user';
const REPOS_PATH = '/user/repos';

/** OAuth scope requested up front (list + clone + create-repo + push, no re-auth). */
const SCOPE = 'repo';
/** Per-request hard timeout (device code, token poll, /user, repos page). */
const HTTP_TIMEOUT_MS = 15_000;
/** Poll cadence when the server omits `interval`. */
const DEFAULT_INTERVAL_SEC = 5;
/** GitHub's `slow_down` asks us to add (at least) 5s to the interval. */
const SLOW_DOWN_INCREMENT_MS = 5_000;
/** Hard cap on a device flow's lifetime regardless of the server `expires_in`. */
const MAX_FLOW_SECONDS = 900;
/** Belt-and-suspenders cap on total poll iterations for one flow. */
const MAX_POLLS = 300;
/** Repo pagination cap: up to 5 * 100 = 500 repos. */
const MAX_REPO_PAGES = 5;
const REPOS_PER_PAGE = 100;
/**
 * Probe page size for the capability check: `GET /user/repos?per_page=1` is the
 * thing the app actually needs (listing repositories), so a token that
 * authenticates but cannot do that is caught at connect time instead of at the
 * first repo list.
 */
const PROBE_REPOS_PATH = '/user/repos?per_page=1';
/** Classic-PAT scopes ride on this response header; fine-grained tokens have none. */
const SCOPES_HEADER = 'x-oauth-scopes';
/** GitHub reports a token's expiry here when it has one. */
const TOKEN_EXPIRY_HEADER = 'github-authentication-token-expiration';
/**
 * Thrown (409) after a stored credential is invalidated by a 401 from GitHub.
 * Deliberately DIFFERENT from the plain 'github not connected' 409, so the UI
 * can say "the credential stopped working" instead of showing an unexplained
 * flip to disconnected. Identical for both credential sources.
 */
export const CREDENTIAL_REJECTED_MESSAGE =
  'GitHub rejected the stored credential — connect again';
export interface GithubConnectionOptions {
  /** Absolute path to github.json in the data dir. */
  file: string;
  log: Logger;
  /** OAuth App client_id (env AI_SM_GITHUB_CLIENT_ID); absent/empty => not configured. */
  clientId?: string | undefined;
  /**
   * REST API base (env AI_SM_GITHUB_API_BASE via resolveGithubApiBase); absent
   * => https://api.github.com. Re-validated here (assertLoopbackApiBase) so no
   * caller can aim the Bearer token at a non-loopback host. Does NOT affect the
   * device-flow urls or the clone host-lock.
   */
  apiBase?: string | undefined;
  /** Fetch seam for tests; defaults to the Node global fetch. */
  fetchImpl?: FetchLike;
  /** Spawn seam for tests; defaults to the Node global spawn (authenticated clone). */
  spawnImpl?: SpawnLike;
}

/**
 * Shape persisted to github.json (mode 0600). The accessToken never leaves the
 * server. `source` was added with the pasted-token path: a record WITHOUT it
 * predates that path and therefore came from the device flow, so it reads as
 * 'device' (never as "unknown"). `scopes`/`expiresAt` are only ever present when
 * GitHub actually reported them.
 */
interface StoredToken {
  accessToken: string;
  login?: string;
  /** Device-flow OAuth scope string, kept for backwards compatibility. */
  scope: string;
  connectedAt: string;
  /** Absent = 'device' (a record written before the pasted-token path existed). */
  source?: 'device' | 'pat';
  /** Classic-PAT scopes from x-oauth-scopes; absent for fine-grained tokens. */
  scopes?: string[];
  /** ISO-8601 credential expiry, when GitHub reported one. */
  expiresAt?: string;
}

/** In-flight device-flow state (connecting only). */
interface DeviceFlow {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresAtMs: number;
  intervalMs: number;
}

export class GithubConnection {
  readonly #file: string;
  readonly #log: Logger;
  /**
   * `[github] …`-tagged view of the same logger.
   *
   * THE RULE FOR EVERY LINE WRITTEN THROUGH EITHER LOGGER (measured leak,
   * fixed 2026-07-25): operation names and HTTP STATUS CODES only. Never the
   * token, never a response body, never an error MESSAGE from this file's
   * paths — a GitHub error can quote the credential back at us.
   */
  readonly #ghlog: Logger;
  /** Normalized REST API origin (no trailing slash). Loopback or api.github.com. */
  readonly #apiBase: string;
  readonly #fetch: FetchLike;
  readonly #spawn: SpawnLike;
  readonly #clientId: string | undefined;
  readonly #configured: boolean;

  #state: 'disconnected' | 'connecting' | 'connected' = 'disconnected';
  #token: string | undefined;
  #login: string | undefined;
  #scope: string | undefined;
  #connectedAt: string | undefined;
  #device: DeviceFlow | undefined;
  /** Which path produced the current credential. A stored record without one reads as 'device'. */
  #source: 'device' | 'pat' = 'device';
  /** Whether the CURRENT credential is on disk. False = process memory only. */
  #persisted = false;
  /** Classic-PAT scopes, when GitHub reported them. undefined = not reported (fine-grained). */
  #scopes: string[] | undefined;
  /** ISO-8601 credential expiry, when GitHub reported one. */
  #expiresAt: string | undefined;

  /** Bumped on every startDeviceFlow/disconnect so stale poll timers self-cancel. */
  #gen = 0;
  #pollCount = 0;
  #pollTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: GithubConnectionOptions) {
    this.#file = options.file;
    this.#log = options.log;
    this.#ghlog = scoped(options.log, 'github');
    // Defense in depth: even though index.ts already validated the env value,
    // re-validate here so no in-process caller can point the token elsewhere.
    const base = (options.apiBase ?? '').trim();
    this.#apiBase =
      base === '' || base === DEFAULT_GITHUB_API_BASE
        ? DEFAULT_GITHUB_API_BASE
        : assertLoopbackApiBase(base);
    this.#fetch = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.#spawn = options.spawnImpl ?? ((command, args, opts) => spawn(command, args, opts));
    const cid = (options.clientId ?? '').trim();
    this.#clientId = cid === '' ? undefined : cid;
    this.#configured = this.#clientId !== undefined;
    this.#load();
  }

  // --- Public API -----------------------------------------------------------

  /**
   * Status for the browser — NEVER contains a token, in any form.
   *
   * `deviceFlowAvailable` reports ONLY whether an OAuth client id exists. It is
   * deliberately decoupled from the connection state (2026-07-25): a pasted
   * token connects, lists, clones and creates with no client id at all, and the
   * UI must keep offering the paste affordance exactly when this is false.
   */
  status(): GithubStatus {
    const deviceFlowAvailable = this.#configured;
    if (this.#state === 'connected') {
      return {
        deviceFlowAvailable,
        state: 'connected',
        ...(this.#login !== undefined ? { login: this.#login } : {}),
        source: this.#source,
        persisted: this.#persisted,
        ...(this.#scopes !== undefined ? { scopes: [...this.#scopes] } : {}),
        ...(this.#expiresAt !== undefined ? { expiresAt: this.#expiresAt } : {}),
      };
    }
    if (this.#state === 'connecting' && this.#device !== undefined) {
      return {
        deviceFlowAvailable,
        state: 'connecting',
        userCode: this.#device.userCode,
        verificationUri: this.#device.verificationUri,
        expiresAt: new Date(this.#device.expiresAtMs).toISOString(),
      };
    }
    return { deviceFlowAvailable, state: 'disconnected' };
  }

  /**
   * Connect with a PASTED token (the second credential path, 2026-07-25).
   *
   * The token arrives from POST /api/github/token's BODY and nowhere else. This
   * method:
   *   1. re-validates its SHAPE (validatePastedToken — trim, non-empty,
   *      <= 1024 chars, no whitespace/control characters, NO prefix allowlist),
   *      so an in-process caller gets the same guarantee as the route;
   *   2. asks GITHUB whether it works: `GET /user` for identity, then
   *      `GET /user/repos?per_page=1` for the capability the app actually needs.
   *      Both go through #http, so they inherit `redirect: 'error'` and the
   *      timeout, and carry the token ONLY as an Authorization header;
   *   3. stores it ONLY on success, replacing whatever credential existed —
   *      atomically, and bumping the generation counter so an in-flight device
   *      poll self-cancels. Exactly one credential exists at any moment: no
   *      merge, no fallback chain.
   *
   * `remember` decides persistence: true writes github.json (0600); false keeps
   * the credential in this process ONLY and REMOVES any existing github.json, so
   * a restart is genuinely disconnected rather than silently re-using an older
   * stored credential.
   *
   * Failure reporting is STATUS-derived, never body-derived (the GitHub body is
   * never read, surfaced or logged), and no message — success or failure —
   * contains the token, a fragment of it, its length or a masked form.
   *
   * WRITE ACCESS IS NOT VERIFIED and is not claimed to be: there is no
   * non-destructive probe for it. Nor are "permissions checked" for a
   * fine-grained token — GitHub sends no x-oauth-scopes header for one, and
   * absence is reported as absence.
   */
  async connectWithToken(
    rawToken: string,
    remember: boolean,
  ): Promise<{ ok: true; status: GithubStatus } | TokenRejection> {
    const shape = validatePastedToken(typeof rawToken === 'string' ? rawToken : '');
    if (!shape.ok) {
      this.#log('info', 'github token rejected');
      return shape;
    }
    const token = shape.token;

    // 1. Identity: GET /user.
    let userRes: Response;
    try {
      userRes = await this.#http(`${this.#apiBase}${USER_PATH}`, { headers: this.#authHeaders(token) });
    } catch {
      return this.#rejectToken(502, "couldn't reach GitHub");
    }
    const mapped = this.#mapTokenFailure(userRes.status);
    if (mapped !== undefined) return mapped;
    if (!userRes.ok) return this.#rejectToken(502, 'GitHub returned an unexpected response');

    let login: string | undefined;
    try {
      const u = asRecord(await userRes.json());
      if (u !== undefined) login = readString(u, 'login');
    } catch {
      // A valid 200 whose body will not parse: identity is best-effort, the
      // credential is still good. Never surface or log the body.
      login = undefined;
    }
    // Scopes: classic PATs carry them here. NO header (fine-grained) stays
    // undefined — "not reported", never an empty list.
    const scopesHeader = userRes.headers.get(SCOPES_HEADER);
    const scopes = scopesHeader === null ? undefined : parseScopesHeader(scopesHeader);
    const expiresAt = parseTokenExpiry(userRes.headers.get(TOKEN_EXPIRY_HEADER));

    // 2. Capability: the repo listing this app is built on. A token that
    //    authenticates but cannot list repositories is refused HERE rather than
    //    failing later; a token that CAN list but sees zero repositories is a
    //    real fine-grained outcome and connects fine (the list is just empty).
    let reposRes: Response;
    try {
      reposRes = await this.#http(`${this.#apiBase}${PROBE_REPOS_PATH}`, {
        headers: this.#authHeaders(token),
      });
    } catch {
      return this.#rejectToken(502, "couldn't reach GitHub");
    }
    const mappedRepos = this.#mapTokenFailure(reposRes.status);
    if (mappedRepos !== undefined) return mappedRepos;
    if (!reposRes.ok) return this.#rejectToken(502, 'GitHub returned an unexpected response');

    // 3. Commit. Bumping #gen supersedes any in-flight device-flow poll, so the
    //    two paths can never both land a credential.
    this.#gen += 1;
    this.#stopPolling();
    this.#pollCount = 0;
    this.#device = undefined;
    this.#token = token;
    this.#login = login;
    this.#scope = SCOPE;
    this.#scopes = scopes;
    this.#expiresAt = expiresAt;
    this.#connectedAt = new Date().toISOString();
    this.#source = 'pat';
    this.#state = 'connected';
    if (remember) {
      // Reports what actually happened: a failed write says persisted:false.
      this.#persisted = this.#persist();
    } else {
      // No on-disk copy at all — including any older one, which would otherwise
      // resurrect a superseded credential on the next start.
      this.#persisted = false;
      this.#removeStore();
    }
    this.#log('info', 'github token accepted');
    return { ok: true, status: this.status() };
  }

  /**
   * Refuse a pasted token. ONE constant log line — never the token, its length,
   * its prefix, the request body, or GitHub's response body.
   */
  #rejectToken(status: number, message: string): TokenRejection {
    this.#log('info', 'github token rejected');
    return { ok: false, status, message };
  }

  /**
   * Map a GitHub RESPONSE STATUS to our refusal copy, or undefined when that
   * status is not a refusal. Status-derived by construction: the response body
   * is never read here, so it can never reach the user or the log.
   */
  #mapTokenFailure(status: number): TokenRejection | undefined {
    if (status === 401) {
      return this.#rejectToken(400, 'GitHub rejected this token (expired, revoked, or mistyped)');
    }
    if (status === 403) {
      return this.#rejectToken(
        400,
        'GitHub refused this token — if the organization uses SSO, authorize the token for that organization first',
      );
    }
    return undefined;
  }

  /**
   * Start (or reuse) the device flow. Returns the user-facing code to display,
   * or a not-configured/error signal. Kicks off background polling on success.
   */
  async startDeviceFlow(): Promise<
    | { ok: true; userCode: string; verificationUri: string; expiresAt: string }
    | { ok: false; reason: 'not-configured' | 'error' }
  > {
    if (!this.#configured) return { ok: false, reason: 'not-configured' };

    // Idempotent double-click: reuse a still-valid in-flight flow.
    if (this.#state === 'connecting' && this.#device !== undefined && Date.now() < this.#device.expiresAtMs) {
      return {
        ok: true,
        userCode: this.#device.userCode,
        verificationUri: this.#device.verificationUri,
        expiresAt: new Date(this.#device.expiresAtMs).toISOString(),
      };
    }

    let payload: Record<string, unknown> | undefined;
    try {
      const res = await this.#http(DEVICE_CODE_URL, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': USER_AGENT,
        },
        body: JSON.stringify({ client_id: this.#clientId, scope: SCOPE }),
      });
      if (!res.ok) {
        this.#log('error', `github device code request failed: ${res.status}`);
        return { ok: false, reason: 'error' };
      }
      payload = asRecord(await res.json());
    } catch {
      this.#log('error', 'github device code request failed');
      return { ok: false, reason: 'error' };
    }
    if (payload === undefined) {
      this.#log('error', 'github device code response malformed');
      return { ok: false, reason: 'error' };
    }

    const deviceCode = readString(payload, 'device_code');
    const userCode = readString(payload, 'user_code');
    const verificationUri = readString(payload, 'verification_uri');
    if (deviceCode === undefined || userCode === undefined || verificationUri === undefined) {
      this.#log('error', 'github device code response malformed');
      return { ok: false, reason: 'error' };
    }

    const expiresInRaw = payload['expires_in'];
    const expiresInSec =
      typeof expiresInRaw === 'number' && Number.isFinite(expiresInRaw) && expiresInRaw > 0
        ? Math.min(expiresInRaw, MAX_FLOW_SECONDS)
        : MAX_FLOW_SECONDS;
    const intervalRaw = payload['interval'];
    const intervalSec =
      typeof intervalRaw === 'number' && Number.isFinite(intervalRaw) && intervalRaw > 0
        ? intervalRaw
        : DEFAULT_INTERVAL_SEC;

    // New flow: supersede any prior poll, clear any in-memory token (honest
    // "connecting" state). github.json is left intact until success overwrites
    // it or disconnect() deletes it.
    this.#gen += 1;
    const gen = this.#gen;
    this.#stopPolling();
    this.#pollCount = 0;
    this.#token = undefined;
    this.#login = undefined;
    const expiresAtMs = Date.now() + expiresInSec * 1000;
    this.#device = {
      deviceCode,
      userCode,
      verificationUri,
      expiresAtMs,
      intervalMs: intervalSec * 1000,
    };
    this.#state = 'connecting';
    this.#scheduleNextPoll(gen, this.#device.intervalMs);

    return { ok: true, userCode, verificationUri, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  /**
   * Drop the connection. IDENTICAL for both credential sources: delete
   * github.json and clear in-memory state.
   *
   * It revokes NOTHING remotely, and must never be described as if it did.
   * GitHub has no self-serve token-revoke endpoint that works without the app's
   * client_secret (which a public device-flow app does not have), and a pasted
   * token is not ours to revoke at all. What the user must do to truly kill the
   * credential differs by source — an OAuth grant is removed under GitHub's
   * Applications settings, a personal access token under its token settings —
   * which is why the UI branches that copy on `status.source`.
   */
  async disconnect(): Promise<void> {
    this.#gen += 1;
    this.#toDisconnected();
    this.#log('info', 'github disconnected');
  }

  /**
   * List the connected user's repos (up to MAX_REPO_PAGES * REPOS_PER_PAGE),
   * sorted by most-recent push, optionally filtered by `query`. Throws
   * GithubError(409) when not connected; a 401 from GitHub invalidates the
   * token (-> disconnected) and also throws 409.
   *
   * The gate is the CREDENTIAL, not the client id (2026-07-25): a pasted token
   * works on a server that has no OAuth App at all.
   */
  async listRepos(query?: string): Promise<GithubRepo[]> {
    // The query is the user's own typing; only its LENGTH is logged.
    this.#ghlog(
      'debug',
      `listRepos requested (filter ${query === undefined ? 'none' : `${query.length} chars`})`,
    );
    if (this.#state !== 'connected' || this.#token === undefined) {
      this.#ghlog('debug', 'listRepos refused: not connected');
      throw new GithubError(409, 'github not connected');
    }
    const token = this.#token;
    const collected: GithubRepo[] = [];
    for (let page = 1; page <= MAX_REPO_PAGES; page += 1) {
      let res: Response;
      try {
        res = await this.#http(
          `${this.#apiBase}${REPOS_PATH}?per_page=${REPOS_PER_PAGE}&sort=pushed&page=${page}`,
          { headers: this.#authHeaders(token) },
        );
      } catch {
        throw new GithubError(502, 'failed to reach github');
      }
      if (res.status === 401) {
        this.#ghlog('warn', 'listRepos: github answered 401, credential invalidated');
        this.#invalidateToken();
        throw new GithubError(409, CREDENTIAL_REJECTED_MESSAGE);
      }
      if (!res.ok) {
        this.#ghlog('warn', `listRepos: github answered ${res.status}`);
        throw new GithubError(502, 'github request failed');
      }
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw new GithubError(502, 'github request failed');
      }
      if (!Array.isArray(body)) break;
      for (const raw of body) {
        const repo = mapRepo(raw);
        if (repo !== undefined) collected.push(repo);
      }
      if (body.length < REPOS_PER_PAGE) break; // last page
    }
    return filterRepos(collected, query);
  }

  /**
   * Clone a (possibly PRIVATE) repo of the connected account into `dest` using
   * the stored credential — WITHOUT the token ever touching argv, the clone url,
   * `.git/config`, or a log. Steps 1-2 run here; steps 3-5 (destination rules,
   * the askpass clone, the leak check) and the full token-safety account are
   * cloneIntoDestination in server/github-clone.ts. Throws GithubError: 400 bad
   * url/dest, 403 when creating the owner directory is denied, 409 not connected
   * / non-empty dest, 502 on clone failure.
   */
  async cloneAuthenticated(cloneUrl: string, dest: string): Promise<void> {
    // 1. Validate the url FIRST — the token must only ever be sent to github.com.
    const authUrl = buildAuthenticatedGithubUrl(cloneUrl);

    // 2. There must be a connected token to send. The CREDENTIAL is the gate,
    //    whatever produced it — a pasted token clones on a server with no
    //    OAuth App configured.
    if (this.#state !== 'connected' || this.#token === undefined) {
      throw new GithubError(409, 'github not connected');
    }
    const token = this.#token;

    // 3.-5. Destination rules, the GIT_ASKPASS clone, the leak check.
    await cloneIntoDestination(this.#spawn, cloneUrl, dest, authUrl, token);
  }

  /**
   * Create a new repository for the connected account:
   * `POST https://api.github.com/user/repos` with the token in the
   * Authorization header ONLY (#authHeaders). Maps the response down to
   * GithubRepo (drops everything else — no token, no raw payload). GitHub
   * validation errors (e.g. 422 name-taken) surface as a clean GithubError with
   * NO token and NO raw body dump. Requires a connected CREDENTIAL (409
   * otherwise) — not a client id: a pasted token creates repos too.
   */
  async createRepo(input: { name: string; private: boolean; description?: string }): Promise<GithubRepo> {
    this.#ghlog('info', `createRepo requested (private ${input.private})`);
    if (this.#state !== 'connected' || this.#token === undefined) {
      this.#ghlog('debug', 'createRepo refused: not connected');
      throw new GithubError(409, 'github not connected');
    }
    const token = this.#token;
    const body: Record<string, unknown> = { name: input.name, private: input.private };
    if (input.description !== undefined) body.description = input.description;

    let res: Response;
    try {
      res = await this.#http(`${this.#apiBase}${REPOS_PATH}`, {
        method: 'POST',
        headers: { ...this.#authHeaders(token), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      throw new GithubError(502, 'failed to reach github');
    }
    if (res.status === 401) {
      this.#invalidateToken();
      throw new GithubError(409, CREDENTIAL_REJECTED_MESSAGE);
    }
    if (res.status === 403) {
      // The most predictable failure of the credential this panel recommends: a
      // fine-grained token limited to selected repositories cannot create new
      // ones (its own footnote says so). Status-derived like #mapTokenFailure —
      // GitHub's response body is never read — and it names no flag or scope,
      // per the UI copy rule.
      throw new GithubError(
        403,
        'this token cannot create repositories on this account — creating one needs a token with broader access',
      );
    }
    if (res.status === 422) {
      // Validation failure (name already exists, invalid name, etc.). Clean
      // message only — the raw GitHub body is never surfaced or logged.
      throw new GithubError(422, 'github rejected the repository (the name may already be taken)');
    }
    if (!res.ok) throw new GithubError(502, 'github request failed');

    let payload: unknown;
    try {
      payload = await res.json();
    } catch {
      throw new GithubError(502, 'github request failed');
    }
    const repo = mapRepo(payload);
    if (repo === undefined) throw new GithubError(502, 'github returned an unexpected repository payload');
    return repo;
  }

  // --- Internals ------------------------------------------------------------

  #authHeaders(token: string): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': USER_AGENT,
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }

  #scheduleNextPoll(gen: number, delayMs: number): void {
    this.#pollTimer = setTimeout(() => {
      void this.#poll(gen);
    }, delayMs);
    // A detached, presence-bound backend must never be kept alive by a poll.
    if (typeof this.#pollTimer.unref === 'function') this.#pollTimer.unref();
  }

  #stopPolling(): void {
    if (this.#pollTimer !== undefined) {
      clearTimeout(this.#pollTimer);
      this.#pollTimer = undefined;
    }
  }

  /** One poll of the token endpoint. Guarded by `gen` against superseded flows. */
  async #poll(gen: number): Promise<void> {
    if (gen !== this.#gen || this.#state !== 'connecting') return;
    const device = this.#device;
    if (device === undefined) return;
    if (Date.now() >= device.expiresAtMs) {
      this.#log('info', 'github device flow expired');
      this.#toDisconnected();
      return;
    }
    this.#pollCount += 1;
    if (this.#pollCount > MAX_POLLS) {
      this.#log('info', 'github device flow poll cap reached');
      this.#toDisconnected();
      return;
    }

    let payload: Record<string, unknown> | undefined;
    try {
      const res = await this.#http(TOKEN_URL, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': USER_AGENT,
        },
        body: JSON.stringify({
          client_id: this.#clientId,
          device_code: device.deviceCode,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }),
      });
      payload = asRecord(await res.json());
    } catch {
      // Transient network error — retry after the interval (still bounded by expiry).
      if (gen === this.#gen && this.#state === 'connecting') {
        this.#scheduleNextPoll(gen, device.intervalMs);
      }
      return;
    }
    if (gen !== this.#gen || this.#state !== 'connecting') return;
    if (payload === undefined) {
      this.#scheduleNextPoll(gen, device.intervalMs);
      return;
    }

    const accessToken = readString(payload, 'access_token');
    if (accessToken !== undefined) {
      await this.#onToken(accessToken, readString(payload, 'scope'), gen);
      return;
    }

    const error = readString(payload, 'error');
    if (error === 'authorization_pending') {
      this.#scheduleNextPoll(gen, device.intervalMs);
    } else if (error === 'slow_down') {
      device.intervalMs += SLOW_DOWN_INCREMENT_MS;
      this.#scheduleNextPoll(gen, device.intervalMs);
    } else {
      // expired_token, access_denied, unsupported_grant_type, or anything else.
      const known =
        error === 'expired_token' || error === 'access_denied' ? error : 'unknown';
      this.#log('info', `github device flow ended: ${known}`);
      this.#toDisconnected();
    }
  }

  /** Success path: cache the token (0600), fetch the login, go connected. */
  async #onToken(token: string, scope: string | undefined, gen: number): Promise<void> {
    let login: string | undefined;
    try {
      const res = await this.#http(`${this.#apiBase}${USER_PATH}`, {
        headers: this.#authHeaders(token),
      });
      if (res.ok) {
        const u = asRecord(await res.json());
        if (u !== undefined) login = readString(u, 'login');
      }
    } catch {
      // Login is best-effort; connection succeeds regardless.
    }
    if (gen !== this.#gen) return; // superseded during the await

    this.#stopPolling();
    this.#token = token;
    this.#login = login;
    this.#scope = scope ?? SCOPE;
    // The device flow's granted scope is already known (we asked for it) and is
    // recorded in `scope`. `scopes` is reserved for what GitHub REPORTS about a
    // credential we did not mint — the pasted-token path — so it stays absent
    // here rather than duplicating the same fact in two vocabularies.
    this.#scopes = undefined;
    this.#expiresAt = undefined;
    this.#connectedAt = new Date().toISOString();
    this.#device = undefined;
    this.#source = 'device';
    this.#state = 'connected';
    this.#persisted = this.#persist();
    this.#log('info', 'github connected');
  }

  /**
   * 401 on a repos/create call: the credential is dead — drop it and go
   * disconnected. Identical for both sources. The caller then throws a 409
   * whose message says the credential STOPPED WORKING, so the UI can say that
   * instead of showing an unexplained flip to disconnected.
   */
  #invalidateToken(): void {
    this.#gen += 1;
    this.#toDisconnected();
    this.#log('warn', 'github token invalid, disconnected');
  }

  /** Remove github.json. Best-effort: an absent file is the desired end state. */
  #removeStore(): void {
    try {
      unlinkSync(this.#file);
    } catch {
      // Already gone.
    }
  }

  /** Clear every in-memory field and remove github.json (both sources alike). */
  #toDisconnected(): void {
    this.#stopPolling();
    this.#device = undefined;
    this.#token = undefined;
    this.#login = undefined;
    this.#scope = undefined;
    this.#scopes = undefined;
    this.#expiresAt = undefined;
    this.#connectedAt = undefined;
    this.#source = 'device';
    this.#persisted = false;
    this.#state = 'disconnected';
    this.#removeStore();
  }

  /**
   * Write github.json. Returns whether the credential is now ACTUALLY on disk —
   * `status.persisted` is set from this, so a failed write reports
   * `persisted:false` instead of promising a durability the disk refused.
   */
  #persist(): boolean {
    if (this.#token === undefined) return false;
    this.#ghlog('debug', `persisting credential store to ${this.#file}`);
    const stored: StoredToken = {
      accessToken: this.#token,
      ...(this.#login !== undefined ? { login: this.#login } : {}),
      scope: this.#scope ?? SCOPE,
      connectedAt: this.#connectedAt ?? new Date().toISOString(),
      source: this.#source,
      ...(this.#scopes !== undefined ? { scopes: [...this.#scopes] } : {}),
      ...(this.#expiresAt !== undefined ? { expiresAt: this.#expiresAt } : {}),
    };
    try {
      atomicWriteFile(this.#file, JSON.stringify(stored, null, 2) + '\n');
      return true;
    } catch (err) {
      // Never include the token in the message — err is a filesystem error only.
      this.#log('error', `failed to persist github token store: ${errorStackOnly(err)}`);
      return false;
    }
  }

  /**
   * Load github.json on construction. A stored credential sets `connected`
   * WITHOUT verifying it — the first real API call decides, and a 401 there
   * invalidates it (#invalidateToken). A record with no `source` predates the
   * pasted-token path and therefore came from the device flow.
   */
  #load(): void {
    let raw: string;
    try {
      raw = readFileSync(this.#file, 'utf8');
    } catch {
      this.#ghlog('debug', `no ${this.#file} — starting disconnected`);
      return; // No github.json yet — start disconnected.
    }
    try {
      const o = asRecord(JSON.parse(raw));
      const accessToken = o !== undefined ? readString(o, 'accessToken') : undefined;
      if (o === undefined || accessToken === undefined) {
        throw new Error('github.json missing accessToken');
      }
      this.#token = accessToken;
      this.#login = readString(o, 'login');
      this.#scope = readString(o, 'scope') ?? SCOPE;
      this.#connectedAt = readString(o, 'connectedAt') ?? new Date().toISOString();
      this.#source = readString(o, 'source') === 'pat' ? 'pat' : 'device';
      const scopes = o['scopes'];
      this.#scopes = Array.isArray(scopes) && scopes.every((s) => typeof s === 'string')
        ? (scopes as string[])
        : undefined;
      this.#expiresAt = readString(o, 'expiresAt');
      this.#persisted = true;
      this.#state = 'connected';
      // Source and scope only — NEVER the token, the login is metadata GitHub
      // itself gave us and is already shown in the UI.
      this.#ghlog(
        'debug',
        `credential store loaded: connected via ${this.#source}, scope '${this.#scope}'`,
      );
    } catch {
      this.#log('error', 'failed to parse github.json, starting disconnected');
      this.#state = 'disconnected';
      this.#persisted = false;
    }
  }

  /**
   * SECURITY: `redirect: 'error'` — a 3xx is a failure here, never a hop.
   * These requests carry the OAuth Bearer token (and the device_code), so
   * following a redirect would let a redirecting upstream steer a
   * token-bearing GET/POST at a target of its choosing and have the reply
   * parsed as a repo list. The Fetch spec makes undici strip Authorization
   * across origins, but that guarantee is inherited, not ours; refusing the
   * redirect outright pins it locally. No GitHub REST endpoint we call
   * (/user, /user/repos) or device-flow endpoint redirects in normal
   * operation — the redirect-following endpoints are the repo-scoped ones
   * (renamed repositories), which this client never calls.
   */
  #http(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();
    return this.#fetch(url, { ...init, redirect: 'error', signal: controller.signal }).finally(() => {
      clearTimeout(timer);
    });
  }
}
