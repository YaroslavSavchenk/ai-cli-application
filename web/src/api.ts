/**
 * REST client for the backend. All URLs are RELATIVE — the page is served by
 * the backend itself, so location implies host and port. Auth token comes
 * from window.__AUTH__, injected by the backend in place of the
 * __AUTH_TOKEN__ placeholder when serving index.html.
 *
 * Creates return 201: always check res.ok, never === 200.
 */
import type {
  CloneProjectRequest,
  CreateProjectRequest,
  CreateSessionRequest,
  FsListResponse,
  FsMkdirResponse,
  GithubCloneRequest,
  GithubCreateRepoRequest,
  GithubRepo,
  GithubReposResponse,
  GithubStatus,
  GithubTokenRequest,
  HistoryEntry,
  OkResponse,
  Project,
  ResumeHistoryRequest,
  RuntimeStatusResponse,
  SessionInfo,
  UiPrefs,
} from '../../shared/protocol.ts';
import { formatError, log } from './log.ts';

declare global {
  interface Window {
    /** Auth token injected at serve time in place of the __AUTH_TOKEN__ placeholder. */
    __AUTH__: string;
  }
}

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function authToken(): string {
  return window.__AUTH__;
}

/**
 * POST /api/github/device success body. The protocol has no named type for it
 * (it mirrors the connecting-only fields of GithubStatus); typed here for the
 * client. NEVER carries a token — the device_code stays 100% server-side.
 */
export interface GithubDeviceResponse {
  userCode: string;
  verificationUri: string;
  /** ISO-8601 expiry of the device code. */
  expiresAt: string;
}

/**
 * Called on ANY 401/403 REST response. The token is injected at page-serve
 * time and rotates on every backend restart, so an auth failure after boot
 * means this page can never talk to the server again — main.ts registers a
 * handler that takes over the page with a reload panel. Registered after
 * boot succeeds; boot-time failures keep their own error path.
 */
let authErrorHandler: (() => void) | null = null;

export function onAuthError(fn: () => void): void {
  authErrorHandler = fn;
}

/**
 * EVERY request is logged on completion (user's "everything gets logged",
 * 2026-09-06): the method, the path, the status and the elapsed ms — plus the
 * server's own error text when the call failed. What is NEVER logged, here or
 * anywhere: the auth token, any header, the request body (it can hold a pasted
 * GitHub token or a typed command), the response body, and QUERY STRING VALUES
 * (a query is reduced to `?…`, matching the server's own access log).
 *
 * Levels: `debug` for a 2xx, `warn` for a 4xx (the caller usually renders it),
 * `error` for a 5xx, `warn` for a network failure — the backend being briefly
 * unreachable is a routine condition here (the 3 s poll hits it repeatedly),
 * and `error` would force an immediate log flush against the very backend that
 * is not answering.
 */
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = init.method ?? 'GET';
  // The QUERY is never logged, only its presence — exactly what the server's
  // access log prints (`GET /api/fs/list ?… -> 200`). The values are real
  // secrets-in-waiting: `?path=` carries an absolute filesystem path from the
  // folder picker and `?q=` carries what the user typed into repo search.
  const cut = path.indexOf('?');
  const route = cut === -1 ? path : `${path.slice(0, cut)} ?…`;
  const started = performance.now();
  const took = (): number => Math.round(performance.now() - started);
  const headers: Record<string, string> = { 'x-auth-token': authToken() };
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(path, { ...init, headers });
  } catch (err) {
    log.warn(`api ${method} ${route} → network error ${took()}ms: ${formatError(err)}`);
    throw err;
  }
  if (res.status === 401 || res.status === 403) authErrorHandler?.();
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // Non-JSON body (shouldn't happen; treat as empty).
  }
  if (!res.ok) {
    const msg =
      body !== null &&
      typeof body === 'object' &&
      typeof (body as { error?: unknown }).error === 'string'
        ? (body as { error: string }).error
        : `HTTP ${res.status}`;
    const line = `api ${method} ${route} → ${res.status} ${took()}ms: ${msg}`;
    if (res.status >= 500) log.error(line);
    else log.warn(line);
    throw new ApiError(res.status, msg);
  }
  log.debug(`api ${method} ${route} → ${res.status} ${took()}ms`);
  return body as T;
}

export function getProjects(): Promise<Project[]> {
  return request<Project[]>('/api/projects');
}

export function createProject(body: CreateProjectRequest): Promise<Project> {
  return request<Project>('/api/projects', { method: 'POST', body: JSON.stringify(body) });
}

/**
 * Create a NEW local project: POSTs with `create: true` so the backend makes
 * the directory (mkdir recursive), optionally `git init`s it (`gitInit`), and
 * registers it. 201 Project on success; the backend refuses a non-empty/
 * non-directory path (409) and surfaces meaningful errors we render inline.
 */
export function createLocalProject(body: Omit<CreateProjectRequest, 'create'>): Promise<Project> {
  return request<Project>('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ ...body, create: true }),
  });
}

/**
 * Clone a repo into a NEW project: `git clone -- <url> <dest>` (argv, no
 * shell), then register `dest`. A SLOW synchronous call — the caller shows an
 * honest indeterminate "cloning…" state while awaiting. 201 Project on
 * success; invalid url / non-empty dest / git failure come back as errors.
 */
export function cloneProject(body: CloneProjectRequest): Promise<Project> {
  return request<Project>('/api/projects/clone', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/** Create a single new subdirectory `name` inside existing `parent`; 201 with its abs path. */
export function fsMkdir(parent: string, name: string): Promise<FsMkdirResponse> {
  return request<FsMkdirResponse>('/api/fs/mkdir', {
    method: 'POST',
    body: JSON.stringify({ parent, name }),
  });
}

export function deleteProject(id: string): Promise<OkResponse> {
  return request<OkResponse>(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function getSessions(): Promise<SessionInfo[]> {
  return request<SessionInfo[]>('/api/sessions');
}

export function createSession(body: CreateSessionRequest): Promise<SessionInfo> {
  return request<SessionInfo>('/api/sessions', { method: 'POST', body: JSON.stringify(body) });
}

export function deleteSession(id: string): Promise<OkResponse> {
  return request<OkResponse>(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function markSeen(id: string): Promise<OkResponse> {
  return request<OkResponse>(`/api/sessions/${encodeURIComponent(id)}/seen`, { method: 'POST' });
}

/**
 * Session history — every session the app launched, kept across backend runs
 * (ENDED entries only, newest `lastUsedAt` first).
 */
export function getHistory(): Promise<HistoryEntry[]> {
  return request<HistoryEntry[]>('/api/history');
}

/**
 * Resume one history entry: the server respawns it (a claude conversation
 * with `--resume <id>`, anything else with the same argv) and answers 201 with
 * the new SessionInfo. `dims` sizes the new PTY; the attach flow reconciles it
 * with the pane's real dimensions afterwards.
 */
export function resumeHistory(id: string, dims: ResumeHistoryRequest): Promise<SessionInfo> {
  return request<SessionInfo>(`/api/history/${encodeURIComponent(id)}/resume`, {
    method: 'POST',
    body: JSON.stringify(dims),
  });
}

export function forgetHistory(id: string): Promise<OkResponse> {
  return request<OkResponse>(`/api/history/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function forgetAllHistory(): Promise<OkResponse> {
  return request<OkResponse>('/api/history', { method: 'DELETE' });
}

/** Backend boot time (statusline uptime). */
export function getRuntime(): Promise<RuntimeStatusResponse> {
  return request<RuntimeStatusResponse>('/api/runtime');
}

/**
 * POST /api/restart — hand the port to a fresh backend process.
 *
 * Deliberately NOT routed through `request()`: this is the one call whose
 * NON-ok statuses are the answer rather than an error (409 = one already
 * running, 500 = it did not come back), and whose 401 must not trigger the
 * fatal token-rotation takeover — the page is *expecting* the server to go
 * away. It resolves for every outcome, including a network failure
 * (`status: 0`), so the flow in `ui/restart-flow.ts` has one shape to read.
 *
 * The 202 body carries port/startedAt/samePort and NEVER a token; the reloaded
 * page gets its token injected into index.html the way every page does.
 */
export async function restartBackend(): Promise<{ status: number; body: unknown }> {
  const started = performance.now();
  const took = (): number => Math.round(performance.now() - started);
  let res: Response;
  try {
    res = await fetch('/api/restart', { method: 'POST', headers: { 'x-auth-token': authToken() } });
  } catch (err) {
    log.warn(`api POST /api/restart → network error ${took()}ms: ${formatError(err)}`);
    return { status: 0, body: null };
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // No/!JSON body — the status alone decides the outcome.
  }
  log.info(`api POST /api/restart → ${res.status} ${took()}ms`);
  return { status: res.status, body };
}

/**
 * POST /api/update — start the in-app update (phase E). The backend downloads
 * the release's Setup, verifies its checksum, and runs it silently on Windows;
 * this call only STARTS that and answers immediately.
 *
 * Same treatment as `restartBackend()` and for the same reason: its non-ok
 * statuses are the ANSWER, not an error (409 = one is already running and the
 * UI adopts it, 422/503 = nothing happened), so it never throws and never
 * routes through `request()`. Nothing is sent: the backend decides WHAT to
 * install from the release it already found — the page cannot name a version,
 * a file or an address.
 */
export async function startUpdate(): Promise<{ status: number; body: unknown }> {
  const started = performance.now();
  const took = (): number => Math.round(performance.now() - started);
  let res: Response;
  try {
    res = await fetch('/api/update', { method: 'POST', headers: { 'x-auth-token': authToken() } });
  } catch (err) {
    log.warn(`api POST /api/update → network error ${took()}ms: ${formatError(err)}`);
    return { status: 0, body: null };
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // No/!JSON body — the status alone decides the outcome.
  }
  log.info(`api POST /api/update → ${res.status} ${took()}ms`);
  return { status: res.status, body };
}

/**
 * GET /api/update/status — the progress readout, polled once a second while an
 * install runs and once at page boot to adopt one that is already in flight.
 *
 * UNLOGGED, like `/health` and for the same reason: a several-minute install is
 * hundreds of calls, and the client log is a metered channel (the backend drops
 * everything past 200 entries a minute — a progress poll would spend that
 * budget and take the interesting lines down with it). The flow logs the phase
 * CHANGES instead, which is the information.
 *
 * Authed like every route, and it never throws: `status: 0` is the flow's
 * "unreadable answer", which it tolerates a few of before giving up.
 */
export async function updateStatus(): Promise<{ status: number; body: unknown }> {
  let res: Response;
  try {
    res = await fetch('/api/update/status', {
      headers: { 'x-auth-token': authToken() },
      cache: 'no-store',
    });
  } catch {
    return { status: 0, body: null };
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // Non-JSON body: the flow reads it as unreadable, which it is.
  }
  return { status: res.status, body };
}

/**
 * GET /health, UNAUTHENTICATED and unlogged — the one probe that still works
 * across a restart gap, when this page's token belongs to a process that no
 * longer exists. Called up to 80 times in 20 s, so it stays out of the client
 * log entirely (the outcome is logged once, by the caller).
 */
export async function backendHealth(): Promise<boolean> {
  try {
    const res = await fetch('/health', { cache: 'no-store' });
    return res.ok;
  } catch {
    return false;
  }
}

/** Stored UI prefs bag ({} if none stored yet) — server never interprets it. */
export function getPrefs(): Promise<UiPrefs> {
  return request<UiPrefs>('/api/prefs');
}

/** Replace-whole-object; server responds 200 OkResponse on success. */
export function putPrefs(body: UiPrefs): Promise<OkResponse> {
  return request<OkResponse>('/api/prefs', { method: 'PUT', body: JSON.stringify(body) });
}

/**
 * Merge-on-write for the shared prefs bag. `/api/prefs` PUT replaces the WHOLE
 * object, so two writers (the theme popover writing `theme`, the settings
 * panel writing `statusLine`) must never PUT a stale bag or they drop each
 * other's keys. This reads the current bag, shallow-merges `patch` at the top
 * level, and PUTs the result. Last-write-wins per top-level key (documented,
 * not solved) if two windows race; a failed GET degrades to patch-only rather
 * than clobbering (best effort — a subsequent successful write reconciles).
 *
 * `drop` removes top-level keys from the merged bag before the PUT — the one
 * way to actually DELETE a key from an opaque bag whose write is a whole-object
 * replace. It is applied AFTER the merge, so a key cannot be dropped and
 * re-added by the same call. Used by the settings panel to retire the two keys
 * this app no longer writes (see DEAD_PREFS_KEYS in ui/statusline-model.ts);
 * every other writer passes nothing and keeps preserving unknown keys verbatim.
 */
export async function updatePrefs(patch: UiPrefs, drop: readonly string[] = []): Promise<void> {
  let current: UiPrefs = {};
  try {
    const bag = await getPrefs();
    if (bag !== null && typeof bag === 'object' && !Array.isArray(bag)) current = bag;
  } catch {
    // GET failed — write the patch alone rather than nothing.
  }
  const next: UiPrefs = { ...current, ...patch };
  for (const key of drop) delete next[key];
  await putPrefs(next);
}

export function fsList(path?: string): Promise<FsListResponse> {
  const suffix = path !== undefined && path !== '' ? `?path=${encodeURIComponent(path)}` : '';
  return request<FsListResponse>(`/api/fs/list${suffix}`);
}

// ---------------------------------------------------------------------------
// GitHub connection (Phase 2b) — OAuth device flow. The token is 100%
// server-side; these calls never send or receive it. Behind the same
// X-Auth-Token + Origin/Host gate request() already applies.
// ---------------------------------------------------------------------------

/** Current connection status (deviceFlowAvailable · disconnected|connecting|connected). */
export function githubStatus(): Promise<GithubStatus> {
  return request<GithubStatus>('/api/github/status');
}

/**
 * Start the device flow: 200 { userCode, verificationUri, expiresAt }, or a 409
 * ApiError when the server has no OAuth client id configured (not-configured).
 */
export function githubDevice(): Promise<GithubDeviceResponse> {
  return request<GithubDeviceResponse>('/api/github/device', { method: 'POST' });
}

/**
 * Connect with a token the USER pasted (the second credential path, decided
 * 2026-07-25). The server validates it against GitHub and answers 200 with the
 * resulting GithubStatus — resolved `login`, `source: 'pat'`, `persisted`, and
 * `scopes`/`expiresAt` when GitHub reports them. It never returns the token in
 * any form.
 *
 * THE BODY IS THE ONLY PLACE THE CREDENTIAL EXISTS CLIENT-SIDE. The caller
 * (ui/github.ts) clears its input and drops its own reference in the same frame
 * it calls this; nothing here retains `body` beyond the JSON.stringify below,
 * and a failure throws an ApiError carrying the SERVER's message only — never
 * the request body. On failure the user re-pastes, by design: no retry buffer.
 */
export function githubToken(body: GithubTokenRequest): Promise<GithubStatus> {
  return request<GithubStatus>('/api/github/token', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/** Drop the LOCAL token (deletes github.json server-side); never revokes the grant. */
export function githubDisconnect(): Promise<OkResponse> {
  return request<OkResponse>('/api/github/disconnect', { method: 'POST' });
}

/** List the connected account's repos (filtered by `q`); 409 when not connected. */
export function githubRepos(q?: string): Promise<GithubReposResponse> {
  const suffix = q !== undefined && q !== '' ? `?q=${encodeURIComponent(q)}` : '';
  return request<GithubReposResponse>(`/api/github/repos${suffix}`);
}

/**
 * Clone a repo of the CONNECTED account into a NEW project (Phase 2c). The
 * server-side OAuth token authenticates the clone (supplied via GIT_ASKPASS,
 * never sent to the client, never in argv/url); `cloneUrl` MUST be an https
 * github.com url. A SLOW synchronous call — the caller shows an HONEST
 * indeterminate "cloning…" state while awaiting (NEVER a fake percentage). 201
 * Project on success; 400 bad cloneUrl/dest, 409 not connected OR non-empty
 * dest, 502 clone failure surface as ApiError.
 */
export function githubClone(body: GithubCloneRequest): Promise<Project> {
  return request<Project>('/api/github/clone', { method: 'POST', body: JSON.stringify(body) });
}

/**
 * Create a NEW repo on the connected account (Phase 2c). 201 GithubRepo on
 * success; 400 bad name, 409 not connected, 422 name already taken, 502 surface
 * as ApiError (the 422 message is rendered inline on the name field). SEPARATE
 * from githubClone — the "+ New repo" flow chains create -> clone client-side.
 */
export function githubCreateRepo(body: GithubCreateRepoRequest): Promise<GithubRepo> {
  return request<GithubRepo>('/api/github/repos', { method: 'POST', body: JSON.stringify(body) });
}
