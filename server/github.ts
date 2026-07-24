/**
 * GitHub connection via OAuth DEVICE FLOW (Phase 2b).
 *
 * The server owns the WHOLE OAuth exchange; the browser only ever triggers the
 * flow, shows the user_code, polls status, and reads repo metadata. The
 * device_code and the access_token live 100% server-side:
 *
 *   - the access token is persisted to github.json in the data dir via
 *     atomicWriteFile (mode 0600), mirroring prefs.ts;
 *   - no public method that feeds an HTTP response ever returns the token, and
 *     the token / device_code are NEVER written to server.log (cf. the
 *     runtime.json token-redaction rule);
 *   - errors are generic; GitHub response bodies are never dumped to the log.
 *
 * Config: the OAuth App client_id comes from env AI_SM_GITHUB_CLIENT_ID (passed
 * in by index.ts). Absent/empty -> "not configured": every method answers a
 * clean not-configured signal and never crashes. No client_secret is used or
 * stored — a public OAuth app's device flow does not need one. Scope = `repo`.
 *
 * Device-flow state machine (see status()):
 *   disconnected --startDeviceFlow()--> connecting --(poll: access_token)--> connected
 *   connecting --(expiry / access_denied / expired_token)--> disconnected
 *   connected  --disconnect()--> disconnected
 *   connected  --(listRepos 401)--> disconnected
 * Polling is bounded: it stops on success/expiry/disconnect, honors the server
 * `interval` (and `slow_down`), and is hard-capped by the device code's expiry
 * (also clamped to MAX_FLOW_SECONDS) and MAX_POLLS iterations.
 *
 * HTTP is done with the Node global `fetch` (no new deps); the fetch impl is
 * injectable (a seam) so tests can drive the state machine with no network.
 *
 * Erasable TypeScript only; relative imports carry explicit .ts extensions.
 */
import { readFileSync, unlinkSync } from 'node:fs';
import type { GithubRepo, GithubStatus } from '../shared/protocol.ts';
import { atomicWriteFile, type Logger } from './config.ts';

/** GitHub endpoints (device flow lives on github.com; the REST API on api.github.com). */
const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const USER_URL = 'https://api.github.com/user';
const REPOS_URL = 'https://api.github.com/user/repos';

/** OAuth scope requested up front (list + clone + create-repo + push, no re-auth). */
const SCOPE = 'repo';
/** Every GitHub request MUST carry a User-Agent. */
const USER_AGENT = 'ai-cli-session-manager';
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

/** Injectable fetch seam — defaults to the Node global `fetch`. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Carries an HTTP status so the API layer can map it directly (like ScaffoldError). */
export class GithubError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'GithubError';
  }
}

export interface GithubConnectionOptions {
  /** Absolute path to github.json in the data dir. */
  file: string;
  log: Logger;
  /** OAuth App client_id (env AI_SM_GITHUB_CLIENT_ID); absent/empty => not configured. */
  clientId?: string | undefined;
  /** Fetch seam for tests; defaults to the Node global fetch. */
  fetchImpl?: FetchLike;
}

/** Shape persisted to github.json. The accessToken never leaves the server. */
interface StoredToken {
  accessToken: string;
  login?: string;
  scope: string;
  connectedAt: string;
}

/** In-flight device-flow state (connecting only). */
interface DeviceFlow {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresAtMs: number;
  intervalMs: number;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : undefined;
}

function readString(o: Record<string, unknown>, key: string): string | undefined {
  const v = o[key];
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/**
 * Map ONE raw GitHub repo object down to the GithubRepo wire shape — dropping
 * everything except the listed fields (no token, no raw payload leaks). Returns
 * undefined when a required field is missing. Exported for unit tests.
 */
export function mapRepo(raw: unknown): GithubRepo | undefined {
  const o = asRecord(raw);
  if (o === undefined) return undefined;
  const fullName = readString(o, 'full_name');
  const name = readString(o, 'name');
  const owner = readString(asRecord(o['owner']) ?? {}, 'login');
  const cloneUrl = readString(o, 'clone_url');
  if (fullName === undefined || name === undefined || owner === undefined || cloneUrl === undefined) {
    return undefined;
  }
  const repo: GithubRepo = {
    fullName,
    name,
    owner,
    private: o['private'] === true,
    cloneUrl,
  };
  const description = readString(o, 'description');
  if (description !== undefined) repo.description = description;
  const language = readString(o, 'language');
  if (language !== undefined) repo.language = language;
  const pushedAt = readString(o, 'pushed_at');
  if (pushedAt !== undefined) repo.pushedAt = pushedAt;
  return repo;
}

/**
 * Client-side filter on a mapped repo list: case-insensitive substring over
 * name / owner / fullName / description. Empty/absent query -> unchanged.
 * Exported for unit tests.
 */
export function filterRepos(repos: GithubRepo[], query?: string): GithubRepo[] {
  if (query === undefined) return repos;
  const q = query.trim().toLowerCase();
  if (q === '') return repos;
  return repos.filter(
    (r) =>
      r.name.toLowerCase().includes(q) ||
      r.owner.toLowerCase().includes(q) ||
      r.fullName.toLowerCase().includes(q) ||
      (r.description !== undefined && r.description.toLowerCase().includes(q)),
  );
}

export class GithubConnection {
  readonly #file: string;
  readonly #log: Logger;
  readonly #fetch: FetchLike;
  readonly #clientId: string | undefined;
  readonly #configured: boolean;

  #state: 'disconnected' | 'connecting' | 'connected' = 'disconnected';
  #token: string | undefined;
  #login: string | undefined;
  #scope: string | undefined;
  #connectedAt: string | undefined;
  #device: DeviceFlow | undefined;

  /** Bumped on every startDeviceFlow/disconnect so stale poll timers self-cancel. */
  #gen = 0;
  #pollCount = 0;
  #pollTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: GithubConnectionOptions) {
    this.#file = options.file;
    this.#log = options.log;
    this.#fetch = options.fetchImpl ?? ((url, init) => fetch(url, init));
    const cid = (options.clientId ?? '').trim();
    this.#clientId = cid === '' ? undefined : cid;
    this.#configured = this.#clientId !== undefined;
    this.#load();
  }

  // --- Public API -----------------------------------------------------------

  /** Status for the browser — NEVER contains a token. */
  status(): GithubStatus {
    if (!this.#configured) {
      return { configured: false, state: 'disconnected' };
    }
    if (this.#state === 'connected') {
      return {
        configured: true,
        state: 'connected',
        ...(this.#login !== undefined ? { login: this.#login } : {}),
      };
    }
    if (this.#state === 'connecting' && this.#device !== undefined) {
      return {
        configured: true,
        state: 'connecting',
        userCode: this.#device.userCode,
        verificationUri: this.#device.verificationUri,
        expiresAt: new Date(this.#device.expiresAtMs).toISOString(),
      };
    }
    return { configured: true, state: 'disconnected' };
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
   * Drop the connection. GitHub has no self-serve token-revoke endpoint that
   * works without the app's client_secret (which a public device-flow app does
   * not have), so this is a best-effort LOCAL drop: delete github.json and
   * clear in-memory state. The user can revoke the grant in GitHub settings.
   */
  async disconnect(): Promise<void> {
    this.#gen += 1;
    this.#toDisconnected();
    this.#log('info', 'github disconnected');
  }

  /**
   * List the connected user's repos (up to MAX_REPO_PAGES * REPOS_PER_PAGE),
   * sorted by most-recent push, optionally filtered by `query`. Throws
   * GithubError(409) when not configured / not connected; a 401 from GitHub
   * invalidates the token (-> disconnected) and also throws 409.
   */
  async listRepos(query?: string): Promise<GithubRepo[]> {
    if (!this.#configured) throw new GithubError(409, 'github not configured');
    if (this.#state !== 'connected' || this.#token === undefined) {
      throw new GithubError(409, 'github not connected');
    }
    const token = this.#token;
    const collected: GithubRepo[] = [];
    for (let page = 1; page <= MAX_REPO_PAGES; page += 1) {
      let res: Response;
      try {
        res = await this.#http(
          `${REPOS_URL}?per_page=${REPOS_PER_PAGE}&sort=pushed&page=${page}`,
          { headers: this.#authHeaders(token) },
        );
      } catch {
        throw new GithubError(502, 'failed to reach github');
      }
      if (res.status === 401) {
        this.#invalidateToken();
        throw new GithubError(409, 'github not connected');
      }
      if (!res.ok) throw new GithubError(502, 'github request failed');
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
      const res = await this.#http(USER_URL, { headers: this.#authHeaders(token) });
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
    this.#connectedAt = new Date().toISOString();
    this.#device = undefined;
    this.#state = 'connected';
    this.#persist();
    this.#log('info', 'github connected');
  }

  /** 401 on a repos call: the token is dead — drop it and go disconnected. */
  #invalidateToken(): void {
    this.#gen += 1;
    this.#toDisconnected();
    this.#log('warn', 'github token invalid, disconnected');
  }

  /** Clear every in-memory field and remove github.json. */
  #toDisconnected(): void {
    this.#stopPolling();
    this.#device = undefined;
    this.#token = undefined;
    this.#login = undefined;
    this.#scope = undefined;
    this.#connectedAt = undefined;
    this.#state = 'disconnected';
    try {
      unlinkSync(this.#file);
    } catch {
      // Already gone.
    }
  }

  #persist(): void {
    if (this.#token === undefined) return;
    const stored: StoredToken = {
      accessToken: this.#token,
      ...(this.#login !== undefined ? { login: this.#login } : {}),
      scope: this.#scope ?? SCOPE,
      connectedAt: this.#connectedAt ?? new Date().toISOString(),
    };
    try {
      atomicWriteFile(this.#file, JSON.stringify(stored, null, 2) + '\n');
    } catch (err) {
      // Never include the token in the message — err is a filesystem error only.
      this.#log('error', `failed to persist github token store: ${String(err)}`);
    }
  }

  #load(): void {
    let raw: string;
    try {
      raw = readFileSync(this.#file, 'utf8');
    } catch {
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
      this.#state = 'connected';
    } catch (err) {
      this.#log('error', 'failed to parse github.json, starting disconnected');
      this.#state = 'disconnected';
    }
  }

  #http(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();
    return this.#fetch(url, { ...init, signal: controller.signal }).finally(() => {
      clearTimeout(timer);
    });
  }
}
