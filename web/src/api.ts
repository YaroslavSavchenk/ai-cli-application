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
  OkResponse,
  PreviousSession,
  Project,
  RuntimeStatusResponse,
  SessionInfo,
  TelemetryResponse,
  UiPrefs,
  UsageResponse,
} from '../../shared/protocol.ts';

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

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { 'x-auth-token': authToken() };
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(path, { ...init, headers });
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
    throw new ApiError(res.status, msg);
  }
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

/** Previous-run sessions offered for relaunch ('shutdown'/'crash' only). */
export function getPrevious(): Promise<PreviousSession[]> {
  return request<PreviousSession[]>('/api/previous');
}

export function dismissPrevious(id: string): Promise<OkResponse> {
  return request<OkResponse>(`/api/previous/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function dismissAllPrevious(): Promise<OkResponse> {
  return request<OkResponse>('/api/previous', { method: 'DELETE' });
}

/** Backend boot time (statusline uptime). */
export function getRuntime(): Promise<RuntimeStatusResponse> {
  return request<RuntimeStatusResponse>('/api/runtime');
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
 * panel writing `defaults`) must never PUT a stale bag or they drop each
 * other's keys. This reads the current bag, shallow-merges `patch` at the top
 * level, and PUTs the result. Last-write-wins per top-level key (documented,
 * not solved) if two windows race; a failed GET degrades to patch-only rather
 * than clobbering (best effort — a subsequent successful write reconciles).
 */
export async function updatePrefs(patch: UiPrefs): Promise<void> {
  let current: UiPrefs = {};
  try {
    const bag = await getPrefs();
    if (bag !== null && typeof bag === 'object' && !Array.isArray(bag)) current = bag;
  } catch {
    // GET failed — write the patch alone rather than nothing.
  }
  await putPrefs({ ...current, ...patch });
}

/** Read-only Claude Code usage aggregates (settings panel usage section). */
export function getUsage(): Promise<UsageResponse> {
  return request<UsageResponse>('/api/usage');
}

/**
 * Per-session telemetry for the terminal status bars (running sessions only;
 * exited omitted → the client keeps last-known). Same token+Origin gate as
 * every /api route; the endpoint is 200 with partial data, never 500.
 */
export function getTelemetry(): Promise<TelemetryResponse> {
  return request<TelemetryResponse>('/api/telemetry');
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
