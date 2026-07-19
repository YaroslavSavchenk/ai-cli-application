/**
 * REST client for the backend. All URLs are RELATIVE — the page is served by
 * the backend itself, so location implies host and port. Auth token comes
 * from window.__AUTH__, injected by the backend in place of the
 * __AUTH_TOKEN__ placeholder when serving index.html.
 *
 * Creates return 201: always check res.ok, never === 200.
 */
import type {
  CreateProjectRequest,
  CreateSessionRequest,
  FsListResponse,
  OkResponse,
  Project,
  SessionInfo,
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

export function fsList(path?: string): Promise<FsListResponse> {
  const suffix = path !== undefined && path !== '' ? `?path=${encodeURIComponent(path)}` : '';
  return request<FsListResponse>(`/api/fs/list${suffix}`);
}
