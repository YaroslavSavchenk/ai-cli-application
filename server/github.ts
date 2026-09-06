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
 * Erasable TypeScript only; relative imports carry explicit .ts extensions.
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { GithubRepo, GithubStatus } from '../shared/protocol.ts';
import {
  assertLoopbackApiBase,
  atomicWriteFile,
  errorStackOnly,
  scoped,
  DEFAULT_GITHUB_API_BASE,
  type Logger,
} from './config.ts';
import { assertVacant, ScaffoldError, CLONE_TIMEOUT_MS } from './scaffold.ts';

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
/** Reject absurdly long clone urls before parsing them. */
const MAX_CLONE_URL_LEN = 2048;
/**
 * Hard cap on a PASTED token's length. No real GitHub token comes near it;
 * anything longer is a paste accident or an attack, and is refused by RULE —
 * the refusal never quotes the value.
 */
export const MAX_PASTED_TOKEN_LEN = 1024;
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
/** Bound on the expiry header before parsing it (it is remote input). */
const MAX_EXPIRY_HEADER_LEN = 64;
/** Bound on the scopes header before splitting it (remote input; ~30 scopes exist). */
const MAX_SCOPES_HEADER_LEN = 1024;
/**
 * Thrown (409) after a stored credential is invalidated by a 401 from GitHub.
 * Deliberately DIFFERENT from the plain 'github not connected' 409, so the UI
 * can say "the credential stopped working" instead of showing an unexplained
 * flip to disconnected. Identical for both credential sources.
 */
export const CREDENTIAL_REJECTED_MESSAGE =
  'GitHub rejected the stored credential — connect again';
/**
 * Username embedded in the authenticated clone url. NOT a secret — the actual
 * password (the OAuth token) is fed to git via GIT_ASKPASS-through-env, never
 * the url. git uses this username and asks GIT_ASKPASS for the matching password.
 */
const CLONE_USERNAME = 'x-access-token';
/** Env var the throwaway askpass script reads the token from (never on argv/url). */
const ASKPASS_TOKEN_ENV = 'AI_SM_GH_TOKEN';

/** Injectable fetch seam — defaults to the Node global `fetch`. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Injectable spawn seam — defaults to the Node global `spawn`. Lets tests
 * assert the exact argv + env of an authenticated clone (proving the token is
 * ONLY in the env, never in argv or the url) without running git.
 */
export type SpawnLike = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

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

/** Why a pasted token was refused. Both the status and the copy are OURS. */
export interface TokenRejection {
  ok: false;
  /** HTTP status for the API layer: 400 = the token is the problem, 502 = GitHub is. */
  status: number;
  message: string;
}

/**
 * Shape-only validation of a pasted token (III-5). Deliberately NO prefix
 * allowlist: `ghp_`, `github_pat_`, `gho_`, `ghu_`, `ghs_` and legacy 40-hex
 * tokens are all valid today and GitHub is free to mint new shapes tomorrow.
 * Only structural impossibilities are refused, and every message names the RULE
 * and never any part of the value.
 *
 * Leading/trailing whitespace is stripped first — clipboards and terminals add
 * it, and a paste that fails for an invisible reason is a terrible experience.
 * Interior whitespace (including Unicode spaces that survive nothing) and
 * control characters stay fatal: they cannot be part of a credential, and a
 * control character in a header value is a request-splitting primitive.
 * Exported for tests.
 */
export function validatePastedToken(raw: string): { ok: true; token: string } | TokenRejection {
  if (raw.length > MAX_PASTED_TOKEN_LEN) {
    return { ok: false, status: 400, message: `token must be at most ${MAX_PASTED_TOKEN_LEN} characters` };
  }
  const token = raw.trim();
  if (token === '') return { ok: false, status: 400, message: 'token is required' };
  if (token.length > MAX_PASTED_TOKEN_LEN) {
    return { ok: false, status: 400, message: `token must be at most ${MAX_PASTED_TOKEN_LEN} characters` };
  }
  for (let i = 0; i < token.length; i += 1) {
    const c = token.charCodeAt(i);
    // C0 + space + DEL + C1. The regex adds the Unicode spaces (NBSP, thin
    // space, U+FEFF …) a paste can smuggle in the middle of a value.
    if (c <= 0x20 || (c >= 0x7f && c <= 0x9f)) {
      return { ok: false, status: 400, message: 'token must not contain spaces or control characters' };
    }
  }
  if (/\s/u.test(token)) {
    return { ok: false, status: 400, message: 'token must not contain spaces or control characters' };
  }
  return { ok: true, token };
}

/**
 * Split an `x-oauth-scopes` header into scopes. Present-but-empty is a REAL
 * answer (a classic token with no scopes) and maps to `[]`; an absent header is
 * the caller's business and maps to undefined there — never to `[]`, because
 * "GitHub did not report scopes" is not "this token has no permissions".
 * Exported for tests.
 */
export function parseScopesHeader(value: string): string[] {
  if (value.length > MAX_SCOPES_HEADER_LEN) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/**
 * Normalize GitHub's `github-authentication-token-expiration` header (e.g.
 * `2026-12-31 00:00:00 UTC`) to ISO-8601, or undefined when it is absent,
 * over-long or unparseable. Never surface the raw remote string: the protocol
 * says ISO-8601, and an unparseable value is better dropped than rendered.
 * Exported for tests.
 */
export function parseTokenExpiry(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > MAX_EXPIRY_HEADER_LEN) return undefined;
  const ms = Date.parse(trimmed);
  if (Number.isNaN(ms)) return undefined;
  return new Date(ms).toISOString();
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
 * Owner + repo of a github.com clone url (`https://github.com/<owner>/<repo>`,
 * optional `.git`), or undefined when the url is not exactly that shape.
 *
 * Used for two things only: the ONE-segment owner-directory allowance in
 * cloneAuthenticated (a comparison against an existing path segment) and the
 * `<owner>/<repo>` project-name disambiguation in server/api.ts (a display
 * string in projects.json). Path segments are taken RAW — never
 * percent-decoded — so an escaped separator like `..%2f..%2fetc` stays that
 * literal text instead of becoming `../../etc`; neither use ever builds a path
 * out of these values. Percent-encoded DOT SEGMENTS are a different mechanism:
 * `%2e%2e` and `%2E.` are decoded and removed by the WHATWG URL parser itself
 * before `pathname` is read (`https://github.com/%2e%2e/repo` → `/repo`), as
 * are plain `.`/`..` segments — so the explicit `.`/`..` refusal below is
 * belt-and-braces, not a pinned behaviour.
 *
 * The host lock matches #buildAuthenticatedGithubUrl: https, host exactly
 * github.com, NO port and NO embedded credentials. That parity is deliberate —
 * this function is exported, so a future caller must not inherit a laxer rule
 * than the one the credential path enforces. Exported for api.ts and tests.
 */
export function parseGithubRepoPath(cloneUrl: string): { owner: string; repo: string } | undefined {
  let parsed: URL;
  try {
    parsed = new URL(cloneUrl);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com') return undefined;
  if (parsed.port !== '') return undefined;
  if (parsed.username !== '' || parsed.password !== '') return undefined;
  const segments = parsed.pathname.split('/').filter((s) => s !== '');
  if (segments.length !== 2) return undefined;
  const owner = segments[0] as string;
  const repo = (segments[1] as string).replace(/\.git$/i, '');
  for (const s of [owner, repo]) {
    if (s === '' || s === '.' || s === '..') return undefined;
  }
  return { owner, repo };
}

/** True when `p` is an existing directory (symlinks followed, like statSync elsewhere). */
function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
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
   * Clone a (possibly PRIVATE) repo of the connected account into `destAbs`
   * using the stored OAuth token — WITHOUT the token ever touching argv, the
   * clone url, `.git/config`, or a log.
   *
   * Token-safety mechanism (the security crux):
   *   1. `cloneUrl` is validated FIRST (buildAuthenticatedGithubUrl): it MUST be
   *      https:// with host EXACTLY github.com — a hard guard so the token can
   *      never be aimed at another host (SSRF/exfil). The returned url embeds
   *      only the NON-secret username `x-access-token@` (never the token).
   *   2. A throwaway askpass script (mode 0700, in a mkdtemp under the OS tmpdir)
   *      reads the token from the env var AI_SM_GH_TOKEN and prints it. git is
   *      spawned with GIT_ASKPASS=<script> and AI_SM_GH_TOKEN=<token> in its env
   *      (argv is `git ... clone -- <username-in-url> <dest>` — NO token). git
   *      calls GIT_ASKPASS for the password, gets the token from env, and does
   *      NOT persist an askpass password into `.git/config`. `credential.helper`
   *      is cleared (`-c credential.helper=`) so no configured helper can cache
   *      the token to disk. `stdio:'ignore'` — git output is never buffered or
   *      logged (an error line could otherwise echo a credential).
   *   3. `finally`: the askpass script + its dir are deleted. On success the
   *      cloned `.git/config` is verified to NOT contain the token.
   *
   * WHAT THE ENV DOES AND DOES NOT BUY (corrected 2026-07-25 — the earlier
   * comment here overstated it). Passing the token through the child's
   * environment keeps it out of argv, the url, `.git/config`, and any log — the
   * places it would otherwise PERSIST or be readable by other local users. It is
   * still readable via /proc by this same Linux user, and, on WSL2, by anything
   * running as the WINDOWS user: the 9p file server runs as root inside the
   * distro, so `\\wsl.localhost\...` reads every 0600 file in the data dir
   * regardless of the permission bits (measured — see
   * memory/knowledge/wsl-0600-not-a-boundary.md). So this is NOT "the same trust
   * boundary as github.json 0600" in the protective sense that phrase implied;
   * both are inside one boundary that already includes the Windows user. The
   * mechanism is still right — it removes the persistent and cross-user
   * exposures — it just is not a wall against that principal, and nothing here
   * may claim it is.
   *
   * Reuses scaffold's assertVacant (409 non-empty, no clobber) and its partial-
   * cleanup discipline (a dest WE created is removed on failure). Throws
   * GithubError: 400 bad url/dest, 403 when creating the owner directory is
   * denied, 409 not connected / non-empty dest, 502 on clone failure.
   *
   * `dest` is normalized (path.resolve) before ANY filesystem decision, so the
   * path that is inspected, created, cloned into and cleaned up is always one
   * and the same — see step 3.
   *
   * Dest parents: normally the parent must already exist (400 otherwise). The
   * single exception is the OWNER directory of an owner-qualified destination
   * `<projects>/<owner>/<repo>` — see step 3b for the four conditions that must
   * all hold, and for the cleanup of an owner dir left empty by a failed clone.
   */
  async cloneAuthenticated(cloneUrl: string, dest: string): Promise<void> {
    // 1. Validate the url FIRST — the token must only ever be sent to github.com.
    const authUrl = this.#buildAuthenticatedGithubUrl(cloneUrl);

    // 2. There must be a connected token to send. The CREDENTIAL is the gate,
    //    whatever produced it — a pasted token clones on a server with no
    //    OAuth App configured.
    if (this.#state !== 'connected' || this.#token === undefined) {
      throw new GithubError(409, 'github not connected');
    }
    const token = this.#token;

    // 3. Dest no-clobber rules (reused from scaffold): absolute, not an existing
    //    non-empty dir / non-directory. Checked BEFORE the parent rules so no
    //    directory is ever created for a destination we would refuse anyway.
    //
    //    NORMALIZE BEFORE ANY FILESYSTEM DECISION. An un-normalized dest makes
    //    the checks below reason about a DIFFERENT directory than the one the
    //    string reaches on disk: `<X>/<owner>/..` stats as missing (so
    //    `existedBefore` would be false) while git — and the failure cleanup's
    //    recursive rmSync — act on the pre-existing `<X>`. From here on there is
    //    exactly one path: `destAbs` is what is stat'ed, what may be created,
    //    what git is handed, and the only thing cleanup may remove. (The route
    //    in server/api.ts refuses a non-normalized dest outright; this makes
    //    every in-process caller safe too.)
    //    (The absolute check is belt-and-braces: the route rejects a relative
    //    dest before this method is reached, so it cannot change an observable
    //    outcome — it is here for in-process callers, not pinned by a test.)
    if (!isAbsolute(dest)) throw new GithubError(400, 'dest must be absolute');
    const destAbs = resolve(dest);
    let existedBefore = true;
    try {
      statSync(destAbs);
    } catch {
      existedBefore = false;
    }
    try {
      assertVacant(destAbs);
    } catch (err) {
      if (err instanceof ScaffoldError) throw new GithubError(err.status, err.message);
      throw new GithubError(500, 'failed to inspect destination');
    }

    // 3b. OWNER-QUALIFIED DESTINATIONS (settled 2026-07-25): app clones land in
    //     `<projects>/<owner>/<repo>`, so exactly ONE missing segment — the
    //     directory the dest names as its OWNER — may be created here. What the
    //     code below actually requires (NOT a projects-root anchor: the dest may
    //     sit anywhere the user can write, e.g. `/tmp/acme/api` creates
    //     `/tmp/acme`):
    //       * only dest's DIRECT parent is ever created,
    //       * that parent's basename must equal the owner segment of the clone
    //         url (case-insensitive, never percent-decoded) — note BOTH sides
    //         come from the SAME request, so this is a coherence check on the
    //         caller's own two inputs, not a containment guarantee: it stops a
    //         mistyped/mismatched dest, it does not constrain WHERE a directory
    //         may appear,
    //       * dest's grandparent must already be a directory, and
    //       * one level only — mkdir, never mkdir -p.
    //     The containment here comes from those last two: one level, under an
    //     already-existing directory.
    //     Anything else keeps the old 400, so a typo'd dest still refuses
    //     instead of silently materialising a directory tree.
    //     Doing it OURSELVES rather than just dropping the check matters: real
    //     `git clone` creates leading directories unboundedly (verified against
    //     git 2.43), so this is what keeps creation to one level, turns a
    //     permission problem into a clean 403 instead of an opaque 502, and —
    //     because we know we made it — lets `createdOwnerDir` be removed again
    //     (only while empty) when the clone then fails.
    let createdOwnerDir: string | undefined;
    const parent = dirname(destAbs);
    if (!isDirectory(parent)) {
      const owner = parseGithubRepoPath(cloneUrl)?.owner;
      const grandparent = dirname(parent);
      if (
        owner === undefined ||
        // Root guard + grandparent check: both belt-and-braces rather than
        // pinned behaviour — a filesystem-root parent already fails the
        // basename comparison, and a missing grandparent makes the mkdirSync
        // below fail into the SAME 400. Neither can change an observable
        // outcome today; keep them, but do not assume a test covers them.
        parent === grandparent ||
        basename(parent).toLowerCase() !== owner.toLowerCase() ||
        !isDirectory(grandparent)
      ) {
        throw new GithubError(400, 'destination parent directory does not exist');
      }
      try {
        mkdirSync(parent);
        createdOwnerDir = parent;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'EACCES' || code === 'EPERM') throw new GithubError(403, 'permission denied');
        throw new GithubError(400, 'destination parent directory does not exist');
      }
    }

    /**
     * Undo what WE created: the dest, then an owner dir left empty by the
     * failure. `existedBefore` is exactly "statSync(destAbs) succeeded", so
     * `!existedBefore` is the broader "we could not see anything there" — it
     * also covers a dangling symlink at `destAbs` (rmSync removes the LINK, not
     * its target — measured) and an unreadable parent (EACCES), where the
     * removal then simply fails and is swallowed. Both stay bounded to
     * `destAbs` itself; the owner dir is removed non-recursively.
     */
    const undoOurDirs = (): void => {
      if (!existedBefore) {
        try {
          rmSync(destAbs, { recursive: true, force: true });
        } catch {
          // Best-effort cleanup.
        }
      }
      if (createdOwnerDir !== undefined) {
        try {
          rmdirSync(createdOwnerDir); // ENOTEMPTY (someone else's data) -> keep it
        } catch {
          // Best-effort cleanup.
        }
      }
    };

    // 4. Clone via GIT_ASKPASS-through-env (token never on argv/url). The
    //    mkdtemp lives INSIDE the protected region: if it throws (full/read-only
    //    tmpdir), an owner directory created in 3b must still be undone.
    let askDir: string | undefined;
    try {
      askDir = mkdtempSync(join(tmpdir(), 'ai-sm-gh-ask-'));
      const askScript = join(askDir, 'askpass.sh');
      // The script ignores its prompt arg and prints the token from the env.
      writeFileSync(askScript, `#!/bin/sh\nprintf '%s' "$${ASKPASS_TOKEN_ENV}"\n`, { mode: 0o700 });
      await this.#runGitClone(authUrl, destAbs, askScript, token);
    } catch (err) {
      undoOurDirs();
      throw err instanceof GithubError ? err : new GithubError(502, 'failed to clone repository');
    } finally {
      if (askDir !== undefined) {
        try {
          rmSync(askDir, { recursive: true, force: true });
        } catch {
          // Best-effort cleanup.
        }
      }
    }

    // 5. Belt-and-suspenders: git stores only the username in .git/config, never
    //    the askpass password. Prove the token did not leak onto disk.
    try {
      const cfg = readFileSync(join(destAbs, '.git', 'config'), 'utf8');
      if (cfg.includes(token)) {
        undoOurDirs();
        throw new GithubError(500, 'aborted: credential leaked into git config');
      }
    } catch (err) {
      if (err instanceof GithubError) throw err;
      // Config unreadable (unexpected) — that is not a leak; leave the clone.
    }
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

  /**
   * Validate a clone url and return the authenticated form. Hard guard: MUST be
   * https:// with host EXACTLY github.com (no port), no embedded credentials —
   * so the token (fed separately via GIT_ASKPASS) can never be aimed elsewhere.
   * Rejects `-`-leading, control chars, and over-length up front. The returned
   * url carries only the NON-secret `x-access-token` username, never the token.
   */
  #buildAuthenticatedGithubUrl(cloneUrl: string): string {
    if (typeof cloneUrl !== 'string' || cloneUrl === '') {
      throw new GithubError(400, 'cloneUrl is required');
    }
    if (cloneUrl.length > MAX_CLONE_URL_LEN) throw new GithubError(400, 'cloneUrl is too long');
    if (cloneUrl.startsWith('-')) throw new GithubError(400, 'invalid clone url');
    for (let i = 0; i < cloneUrl.length; i += 1) {
      const c = cloneUrl.charCodeAt(i);
      if (c <= 0x20 || c === 0x7f) throw new GithubError(400, 'clone url contains invalid characters');
    }
    let parsed: URL;
    try {
      parsed = new URL(cloneUrl);
    } catch {
      throw new GithubError(400, 'invalid clone url');
    }
    if (parsed.protocol !== 'https:') {
      throw new GithubError(400, 'clone url must be https://github.com/...');
    }
    if (parsed.hostname !== 'github.com' || parsed.port !== '') {
      throw new GithubError(400, 'clone url host must be exactly github.com');
    }
    if (parsed.username !== '' || parsed.password !== '') {
      throw new GithubError(400, 'clone url must not embed credentials');
    }
    // Rebuild from validated parts only: guarantees the target is github.com and
    // the token is NOT in the url (git gets it via GIT_ASKPASS instead).
    return `https://${CLONE_USERNAME}@github.com${parsed.pathname}`;
  }

  /**
   * Spawn `git -c credential.helper= clone -- <authUrl> <destAbs>` with the
   * token supplied ONLY through the env (GIT_ASKPASS + AI_SM_GH_TOKEN). No
   * shell, stdio fully ignored (no output buffered/logged), bounded by
   * CLONE_TIMEOUT_MS, GIT_TERMINAL_PROMPT=0 so a credential-needing clone fails
   * fast instead of hanging. Resolves on exit 0, else rejects GithubError(502).
   */
  #runGitClone(authUrl: string, destAbs: string, askScript: string, token: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (err?: GithubError): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        if (err !== undefined) reject(err);
        else resolve();
      };
      let child: ChildProcess;
      try {
        child = this.#spawn(
          'git',
          // `-c credential.helper=` clears any configured helper so the token is
          // never cached to disk. `--` stops the url/dest being read as options.
          ['-c', 'credential.helper=', 'clone', '--', authUrl, destAbs],
          {
            shell: false,
            stdio: 'ignore',
            windowsHide: true,
            env: {
              ...process.env,
              GIT_ASKPASS: askScript,
              [ASKPASS_TOKEN_ENV]: token,
              GIT_TERMINAL_PROMPT: '0',
            },
          },
        );
      } catch {
        finish(new GithubError(502, 'failed to clone repository'));
        return;
      }
      timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // Already gone.
        }
        finish(new GithubError(502, 'clone timed out'));
      }, CLONE_TIMEOUT_MS);
      if (typeof timer.unref === 'function') timer.unref();

      child.on('error', () => {
        finish(new GithubError(502, 'failed to clone repository'));
      });
      child.on('close', (code) => {
        finish(code === 0 ? undefined : new GithubError(502, 'failed to clone repository'));
      });
    });
  }

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
