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
 * The REST API base (api.github.com) is overridable via AI_SM_GITHUB_API_BASE
 * for offline tests, but ONLY with a loopback origin (config.ts
 * assertLoopbackApiBase; anything else makes the server refuse to start) — the
 * token must never be sendable to a remote host. The device-flow urls and the
 * clone host-lock (exactly github.com) are NOT affected by that knob.
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

  /** Bumped on every startDeviceFlow/disconnect so stale poll timers self-cancel. */
  #gen = 0;
  #pollCount = 0;
  #pollTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: GithubConnectionOptions) {
    this.#file = options.file;
    this.#log = options.log;
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
          `${this.#apiBase}${REPOS_PATH}?per_page=${REPOS_PER_PAGE}&sort=pushed&page=${page}`,
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
   * The env token is visible only via /proc to the SAME user (same trust
   * boundary as github.json 0600) — acceptable; argv/url/config are not, and
   * are avoided.
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

    // 2. There must be a connected token to send.
    if (!this.#configured) throw new GithubError(409, 'github not configured');
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
   * NO token and NO raw body dump. Requires connected state (409 otherwise).
   */
  async createRepo(input: { name: string; private: boolean; description?: string }): Promise<GithubRepo> {
    if (!this.#configured) throw new GithubError(409, 'github not configured');
    if (this.#state !== 'connected' || this.#token === undefined) {
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
      throw new GithubError(409, 'github not connected');
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
