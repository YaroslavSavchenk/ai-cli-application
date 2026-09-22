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
  FsCreateResponse,
  FsEntriesResponse,
  FsListResponse,
  FsMkdirResponse,
  FsReadResponse,
  FsWriteRequest,
  FsWriteResponse,
  FsUploadMode,
  FsDeleteResponse,
  FsRenameRequest,
  FsRenameResponse,
  FsUploadResponse,
  FsWinPathResponse,
  GitChangesResponse,
  GitCommitDiffResponse,
  GitCommitResponse,
  GitCommitsResponse,
  GithubCloneRequest,
  GithubCreateRepoRequest,
  GithubRepo,
  GithubReposResponse,
  GithubStatus,
  GithubTokenRequest,
  HistoryEntry,
  KeyedTool,
  KeyStatus,
  OkResponse,
  Project,
  ResumeHistoryRequest,
  RuntimeStatusResponse,
  SaveKeyRequest,
  SessionInfo,
  ToolAvailability,
  UiPrefs,
  UpdateStatus,
} from '../../shared/protocol.ts';
import { UPLOAD_CONTENT_TYPE } from '../../shared/protocol.ts';
import { formatError, log } from './log.ts';
import { isMascotShape } from './ui/prefs-model.ts';

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
 * Called on a REST response that `isAuthFailure()` calls an auth failure. The
 * token is injected at page-serve time and rotates on every backend restart,
 * so an auth failure after boot means this page can never talk to the server
 * again — main.ts registers a handler that takes over the page with a reload
 * panel. Registered after boot succeeds; boot-time failures keep their own
 * error path.
 */
let authErrorHandler: (() => void) | null = null;

/**
 * Is this failed response "this page can no longer talk to the server"?
 *
 * - 401 always: the token check (`'unauthorized'`) is the only 401 on `/api/`.
 * - 403 only for the Origin/Host gate (`'forbidden host'`, `'forbidden
 *   origin'`) — or when there is no readable `error` text (`null`): the gate
 *   runs first on every request, and the only other text-less 403 the server
 *   has (the static-file `'forbidden'`) never answers an `/api/` path.
 * - Any other 403 is an ordinary refusal the caller renders — the filesystem's
 *   `'permission denied'` (folder picker, new project) or a GitHub refusal —
 *   and must NOT tear the page down.
 */
export function isAuthFailure(status: number, errorText: string | null): boolean {
  if (status === 401) return true;
  if (status !== 403) return false;
  return errorText === null || errorText === 'forbidden host' || errorText === 'forbidden origin';
}

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
/**
 * Routes whose 2xx is not worth a line each — the `route` form, with the query
 * already reduced to `?…`. One entry today: the per-file upload of a drop.
 */
const QUIET_ON_SUCCESS = new Set(['/api/fs/upload ?…']);

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
  // A RAW body (B10's upload: a File or a Blob) is not JSON and must not be
  // announced as any: the upload route answers 415 to anything but
  // `application/octet-stream`, and that refusal is also what keeps a
  // cross-site form post — which cannot set this header — off the route.
  // Every other call in this file sends a JSON string.
  if (typeof init.body === 'string') headers['content-type'] = 'application/json';
  else if (init.body !== undefined && init.body !== null) headers['content-type'] = UPLOAD_CONTENT_TYPE;
  let res: Response;
  try {
    res = await fetch(path, { ...init, headers });
  } catch (err) {
    log.warn(`api ${method} ${route} → network error ${took()}ms: ${formatError(err)}`);
    throw err;
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // Non-JSON body (shouldn't happen; treat as empty).
  }
  const errorText =
    body !== null &&
    typeof body === 'object' &&
    typeof (body as { error?: unknown }).error === 'string'
      ? (body as { error: string }).error
      : null;
  if (isAuthFailure(res.status, errorText)) authErrorHandler?.();
  if (!res.ok) {
    const msg = errorText ?? `HTTP ${res.status}`;
    const line = `api ${method} ${route} → ${res.status} ${took()}ms: ${msg}`;
    if (res.status >= 500) log.error(line);
    else log.warn(line);
    throw new ApiError(res.status, msg);
  }
  // QUIET, on success only (B10, user decision 2026-09-20): a 2000-file drop
  // is 2000 identical `201` lines, and the server's own access log demotes the
  // very same route for the very same reason. The per-drop summary (`logDrop`)
  // is the record; every REFUSAL above still writes its warn line, because
  // that is the one a reader is looking for.
  if (!QUIET_ON_SUCCESS.has(route)) log.debug(`api ${method} ${route} → ${res.status} ${took()}ms`);
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
 * POST /api/update/check (Nocturne B6): run the release check now and get the
 * composed status back. Unlike `startUpdate()` this goes through `request()`:
 * a non-ok answer (503 = not an installed app, which the page never asks in)
 * IS an error for the caller, who prints one sentence for every failure.
 */
export function checkForUpdates(): Promise<UpdateStatus> {
  return request<UpdateStatus>('/api/update/check', { method: 'POST' });
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

// ---------------------------------------------------------------------------
// Launchable tools + stored API keys (Nocturne B5). The key VALUE travels in
// exactly one direction: into `saveKey`'s body and nowhere else. `getKeys()`
// answers saved/not-saved only — the page can never read a key back, and
// `request()` logs no request body, so nothing here can put one in the log.
// ---------------------------------------------------------------------------

/** Which launchable executables the backend finds on its own PATH. */
export function getTools(): Promise<ToolAvailability> {
  return request<ToolAvailability>('/api/tools');
}

/** Per keyed tool: is a key stored, and does the backend's own environment carry one. */
export function getKeys(): Promise<KeyStatus> {
  return request<KeyStatus>('/api/keys');
}

/**
 * Store ONE tool's API key. THE BODY IS THE ONLY PLACE THE CREDENTIAL EXISTS
 * client-side — the caller (ui/settings.ts) clears its field in the same frame
 * and keeps no copy; a 400 carries the server's own sentence and never the
 * value that was refused.
 */
export function saveKey(tool: KeyedTool, key: string): Promise<OkResponse> {
  const body: SaveKeyRequest = { key };
  return request<OkResponse>(`/api/keys/${encodeURIComponent(tool)}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

/** Forget ONE tool's stored key. The environment variable, if any, stays. */
export function deleteKey(tool: KeyedTool): Promise<OkResponse> {
  return request<OkResponse>(`/api/keys/${encodeURIComponent(tool)}`, { method: 'DELETE' });
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
 * object, so two writers (ui/theme.ts writing `theme`, the settings
 * panel writing `statusLine`) must never PUT a stale bag or they drop each
 * other's keys. This reads the current bag, shallow-merges `patch` at the top
 * level, and PUTs the result. Last-write-wins per top-level key (documented,
 * not solved) if two windows race; a FAILED GET rejects without writing at all,
 * because the merge base would be `{}` and a whole-object PUT of the patch
 * alone would reset every other key in the bag (statusLine, behaviour, tools)
 * to its factory value. Every caller catches and reverts its own row.
 *
 * `drop` removes top-level keys from the merged bag before the PUT — the one
 * way to actually DELETE a key from an opaque bag whose write is a whole-object
 * replace. It is applied AFTER the merge, so a key cannot be dropped and
 * re-added by the same call. Every writer in the app passes the two keys this
 * app no longer writes (DEAD_PREFS_KEYS in ui/statusline-model.ts) so whichever
 * write goes last cannot resurrect them; unknown keys are preserved verbatim.
 */
export async function updatePrefs(patch: UiPrefs, drop: readonly string[] = []): Promise<void> {
  // No read, no write: the PUT replaces the whole object, so PUTting the patch
  // on an unknown bag is data loss, not best effort. A wrong-SHAPE answer is a
  // different thing — the bag really holds nothing mergeable, so {} is right.
  const bag = await getPrefs();
  let current: UiPrefs = {};
  if (bag !== null && typeof bag === 'object' && !Array.isArray(bag)) current = bag;
  const next: UiPrefs = { ...current, ...patch };
  for (const key of drop) delete next[key];
  // Nocturne C1: the server refuses a PUT whose `mascot` is not exactly
  // `{enabled: boolean}` but loads prefs.json unchecked, so a hand-edited bad
  // value read back here would fail EVERY save (theme, status bar, …). Drop it,
  // never coerce it: absent = on.
  if ('mascot' in next && !isMascotShape(next.mascot)) delete next.mascot;
  await putPrefs(next);
}

export function fsList(path?: string): Promise<FsListResponse> {
  const suffix = path !== undefined && path !== '' ? `?path=${encodeURIComponent(path)}` : '';
  return request<FsListResponse>(`/api/fs/list${suffix}`);
}

// ---------------------------------------------------------------------------
// The Files panel's file system (B2). These three are CONFINED server-side to
// your home OR the path of a project you registered (user decision
// 2026-09-16); fsList/fsMkdir above browse the whole machine for the project
// picker. Same token + Origin/Host gate, same `{ error }` shape — and the
// server's sentence is written for the user, so the panel renders it verbatim
// (a folder outside all of them says `This folder is outside your home
// folder.`, one sentence for both kinds of anchor).
// ---------------------------------------------------------------------------

/** One folder's entries (files and folders). `path` omitted = your home folder. */
export function fsEntries(path?: string): Promise<FsEntriesResponse> {
  const suffix = path !== undefined && path !== '' ? `?path=${encodeURIComponent(path)}` : '';
  return request<FsEntriesResponse>(`/api/fs/entries${suffix}`);
}

/** Create ONE empty file or ONE folder `name` inside the existing folder `dir`; 201. */
export function fsCreate(
  dir: string,
  name: string,
  kind: 'file' | 'folder',
): Promise<FsCreateResponse> {
  return request<FsCreateResponse>('/api/fs/create', {
    method: 'POST',
    body: JSON.stringify({ dir, name, kind }),
  });
}

/**
 * Read ONE text file for the editor (B4). `ifStamp` = the stamp already held:
 * the server answers `{ changed: false }` when the bytes are still the same, so
 * the 5 s disk follow costs no body. Refusals reject with `ApiError(status)`
 * carrying the server's sentence (413 too large, 415 not text, 404 gone).
 */
export function fsRead(path: string, ifStamp?: string): Promise<FsReadResponse> {
  const q = `path=${encodeURIComponent(path)}${ifStamp === undefined ? '' : `&if=${encodeURIComponent(ifStamp)}`}`;
  return request<FsReadResponse>(`/api/fs/read?${q}`);
}

/**
 * Write ONE text file for the editor (B4). `body.expect` is the stamp the text
 * was edited from; the server answers 409 when the file changed since, 404
 * when it is gone. Without `expect` the write lands regardless (`Overwrite`).
 */
export function fsWrite(body: FsWriteRequest): Promise<FsWriteResponse> {
  return request<FsWriteResponse>('/api/fs/write', {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

/**
 * Copy ONE file into `dir` under the relative path `rel` (B10). One raw-body
 * `PUT` per file, never multipart: the server refuses on `content-length`
 * before it reads a byte, and `fetch` sets that length itself for a `File` or
 * `Blob` body — so the request is never chunked and a 50 MiB file streams from
 * disk instead of sitting in either process's heap.
 *
 * `rel` is `/`-joined and percent-encoded whole (`encodeURIComponent` escapes
 * the separators too, which is what keeps a name containing `/`, `&` or `#`
 * from becoming a second path segment or a second parameter). The server
 * splits the decoded value on `/` and puts every segment through its own name
 * check; nothing here decides what is safe.
 *
 * Rejects with `ApiError(status)` on every refusal — the status is the whole
 * vocabulary the failed row speaks (`failNote`). 201 answers `{ bytes }`.
 */
export function fsUpload(
  dir: string,
  rel: string,
  mode: FsUploadMode,
  body: Blob,
): Promise<FsUploadResponse> {
  const q = `dir=${encodeURIComponent(dir)}&rel=${encodeURIComponent(rel)}&mode=${mode}`;
  return request<FsUploadResponse>(`/api/fs/upload?${q}`, { method: 'PUT', body });
}

/**
 * The Windows form of a path inside the boundary (B10 phase 3's clipboard).
 * The MAPPING is the server's: it is the half that knows the distro name and
 * the one that can refuse a path outside home and every registered project.
 * 422 means there is no Windows form of it at all.
 */
export function fsWinPath(path: string): Promise<FsWinPathResponse> {
  return request<FsWinPathResponse>(`/api/fs/winpath?path=${encodeURIComponent(path)}`);
}

/**
 * Delete these paths for good (B10a). ONE request per confirmed action: the
 * user is asked once, so the whole selection travels in a single POST and one
 * line reaches the log.
 *
 * PERMANENT — no trash, no undo (user decision 2026-09-20). The confirmation
 * in `ui/delete-dialog.ts` is the only stop before this call.
 *
 * It answers 200 whenever the REQUEST was well formed, with `results`
 * index-keyed to `paths`: each item carries its own `ok`, and a partial batch
 * is an ordinary answer rather than an error. A REJECTION therefore means the
 * request itself was refused (over the cap, over the body limit, the token or
 * the Origin gate) and nothing was touched at all.
 */
export function fsDelete(paths: string[]): Promise<FsDeleteResponse> {
  return request<FsDeleteResponse>('/api/fs/delete', {
    method: 'POST',
    body: JSON.stringify({ paths }),
  });
}

/**
 * Give one file or folder a new name in the SAME folder (B13). The request
 * carries a name, never a destination, so a move cannot be expressed. The
 * answer carries no path either: the server works on the resolved parent, and
 * the panel's tree is keyed by the path as SHOWN, so the caller builds the new
 * path itself (`renamedPath`). A taken name is refused (409), never replaced.
 */
export function fsRename(path: string, name: string): Promise<FsRenameResponse> {
  const body: FsRenameRequest = { path, name };
  return request<FsRenameResponse>('/api/fs/rename', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/**
 * ONE line per drop, at info, and COUNTS ONLY (B10): how many files it
 * carried, how big it was, how many rows failed. No name, no path, no
 * destination — the per-request lines above already say `PUT /api/fs/upload
 * ?… → 201`, with the query reduced to `?…` exactly as the server's own
 * access log does.
 */
export function logDrop(files: number, bytes: number, failed: number): void {
  const mb = (bytes / 1_000_000).toFixed(1);
  log.info(`drop: ${files} files, ${mb} MB, ${failed} failed`);
}

/** What the repository at (or above) `root` has changed since its last commit. */
export function gitChanges(root: string): Promise<GitChangesResponse> {
  return request<GitChangesResponse>(`/api/git/changes?root=${encodeURIComponent(root)}`);
}

/**
 * One page of the history of HEAD (B3). `from` pins every later page to the
 * head of page one.
 *
 * THE THREE HISTORY CALLS ARE `async` ON PURPOSE. `encodeURIComponent` THROWS
 * a `URIError` on a lone surrogate — and a path is git's verbatim bytes, so a
 * repository really can hand one over. In a plain function that throw escapes
 * the CALLER (a half-built render, a block stuck on `Loading…`); in an `async`
 * one it becomes a rejected promise, which every caller here already handles
 * with the server-sentence path (`messageOf`).
 */
export async function gitCommits(
  root: string,
  limit: number,
  skip: number,
  from?: string,
): Promise<GitCommitsResponse> {
  const pin = from === undefined ? '' : `&from=${encodeURIComponent(from)}`;
  return request<GitCommitsResponse>(
    `/api/git/commits?root=${encodeURIComponent(root)}&limit=${limit}&skip=${skip}${pin}`,
  );
}

/** One commit: its message, who and when, and the files it changed (B3). */
export async function gitCommit(root: string, hash: string): Promise<GitCommitResponse> {
  return request<GitCommitResponse>(
    `/api/git/commit?root=${encodeURIComponent(root)}&hash=${encodeURIComponent(hash)}`,
  );
}

/** What one commit changed in one file, as numbered lines (B3). */
export async function gitCommitDiff(
  root: string,
  hash: string,
  path: string,
): Promise<GitCommitDiffResponse> {
  return request<GitCommitDiffResponse>(
    `/api/git/commit-diff?root=${encodeURIComponent(root)}&hash=${encodeURIComponent(hash)}` +
      `&path=${encodeURIComponent(path)}`,
  );
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
