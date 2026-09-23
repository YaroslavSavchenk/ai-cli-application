/**
 * GitHub connection — the SHARED STATUS CONTROLLER: the status, the repo list
 * and its load state, the poll and its cadence, the clones in flight, and the
 * disconnect that drops the local credential (the resolved home folder is
 * ui/home-store.ts since Q1).
 * The chip and the New Project dialog's GitHub tab both read it; neither owns
 * it. Every write to this state happens in this module.
 *
 * Split from `ui/github.ts` (O8, 2026-09-23), code moved as it stood — the
 * rules it keeps (the honesty notes, the poll cadence, V-4) are in that
 * module's header. Sibling: `github.ts` (the chip and the panel).
 */
import type { GithubRepo, GithubStatus } from '../../../shared/protocol.ts';
import * as api from '../api.ts';
import { cloneErrText, pollIntervalMs } from './github-model.ts';

// ---------------------------------------------------------------------------
// Shared controller state
// ---------------------------------------------------------------------------

export let status: GithubStatus | null = null; // null = not yet fetched
export let repos: GithubRepo[] = [];
type RepoState = 'idle' | 'loading' | 'loaded' | 'error';
export let repoState: RepoState = 'idle';
export let repoErr = '';
export let reposVersion = 0; // bumps whenever the repo list/state changes (list rebuild gate)

const listeners = new Set<() => void>();
let timer: number | null = null;
let tabOpen = false;
let inFlight = false;
let repoToken = 0;

/**
 * V-4: a connection that DROPS on its own — an expired or revoked token, or one
 * that lost access — used to flip the UI to "disconnected" with no explanation,
 * which with user-pasted tokens will be routine. These two flags separate that
 * from a disconnect the user asked for, so the panel can say what happened.
 * Both are per-run observations: after a reload the status is simply
 * disconnected and we do NOT invent a reason for it.
 */
let userDropped = false;
export let credentialLost = false;

// Phase 2c: repos with a clone in flight, keyed by fullName. Lives OUTSIDE the
// row DOM (like util.ArmedSet) so a per-row "cloning…" state survives a list
// rebuild (search / repo-list reload) instead of being wiped by replaceChildren.
export const cloning = new Set<string>();

export function emit(): void {
  for (const cb of listeners) cb();
}

// ---------------------------------------------------------------------------
// Phase 2c helpers: ApiError narrowing (the destination path, already-cloned
// detection, and the error copy itself live in github-model.ts; the home folder
// they need is ui/home-store.ts since Q1).
// ---------------------------------------------------------------------------

/**
 * Honest clone-error copy: prefer the server's real `{error}` message; fall
 * back to friendly text only for a bare `HTTP <status>` (no body) — that
 * status→copy mapping lives in github-model.cloneErrText.
 */
export function cloneErr(e: unknown): string {
  if (e instanceof api.ApiError) return cloneErrText(e.status, e.message);
  return e instanceof Error ? e.message : String(e);
}

export function onGithubUpdate(cb: () => void): void {
  listeners.add(cb);
}

/** Fast poll while connecting or while the dialog's GitHub tab is open (paused otherwise). */
function syncTimer(): void {
  const ms = pollIntervalMs(tabOpen, status);
  if (ms !== null) {
    if (timer === null) timer = window.setInterval(() => void poll(), ms);
  } else if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

/** Apply a fresh (or optimistic) status: fire transitions, notify, resync poll. */
export function applyStatus(next: GithubStatus): void {
  const prev = status;
  status = next;
  if (next.state === 'connected' && prev?.state !== 'connected') {
    credentialLost = false;
    void loadRepos(''); // load the list once on reaching connected
  }
  if (next.state !== 'connected' && prev?.state === 'connected') {
    repos = [];
    repoState = 'idle';
    reposVersion++;
    // Only an UNASKED-FOR drop is news (V-4); a disconnect the user pressed is not.
    // Nor is the drop the "remember this token" toggle CREATES: a credential the
    // user chose not to store lives only in the backend process, so a plain
    // restart ends it exactly this way. Saying "expired, revoked, or lost access"
    // there would name three causes we know to be false — and could send the user
    // to revoke a healthy token. `prev.persisted === false` is the server's own
    // report of that choice.
    credentialLost = !userDropped && prev.persisted !== false;
    userDropped = false;
  }
  emit();
  syncTimer();
}

export async function poll(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    applyStatus(await api.githubStatus());
  } catch {
    // Soft: keep last-known status (chip/panel stand); the health probe lives
    // in the main session poll, not here.
  } finally {
    inFlight = false;
  }
}

export async function loadRepos(q: string): Promise<void> {
  const mine = ++repoToken;
  repoState = 'loading';
  reposVersion++;
  emit();
  try {
    const res = await api.githubRepos(q);
    if (mine !== repoToken) return; // superseded by a newer query
    repos = res.repos;
    repoState = 'loaded';
    reposVersion++;
    emit();
  } catch (e) {
    if (mine !== repoToken) return;
    repoErr = e instanceof Error ? e.message : String(e);
    repoState = 'error';
    reposVersion++;
    emit();
  }
}

/** Fetch status once at boot so the chip is honest from the first paint. */
export function initGithub(): void {
  void poll();
}

/** The dialog's GitHub tab opened/closed — drives the fast/paused cadence. */
export function setTabOpen(open: boolean): void {
  tabOpen = open;
  syncTimer();
  if (open) void poll();
}

/** `submitToken()` accepted a token: whatever dropped before is not news any more (V-4). */
export function forgetCredentialLost(): void {
  credentialLost = false;
}

/** Something the repo list is drawn from changed outside this module (the home folder landed). */
export function bumpReposVersion(): void {
  reposVersion++;
}


/** Cancel a pending flow / disconnect — both drop the LOCAL token, then re-poll. */
export async function drop(): Promise<void> {
  userDropped = true; // an asked-for disconnect is not a lost credential (V-4)
  credentialLost = false;
  try {
    await api.githubDisconnect();
  } catch {
    // Soft: the poll below reconciles the real state either way.
  }
  repos = [];
  repoState = 'idle';
  reposVersion++;
  void poll();
}
