/**
 * THE OPEN COMMIT, once (Nocturne part B3). One commit is open or none is
 * (`state.openCommit`), and TWO surfaces draw it: the full commit view
 * (`ui/commit-view.ts`) and the Files panel's selected state
 * (`ui/files.ts`, the row per file that folds a block in that view). They must
 * never state different files, different numbers or different states — and
 * they must cost ONE request between them, not one each.
 *
 * So the answer lives here, with the fetching. The view is the only DRIVER
 * (`syncCommit()` on its render); the panel is a reader (`commitAsked()`).
 *
 * THE GATEWAY IS INJECTED, like the Files panel's. This module never imports
 * `../api.ts`: `main.ts` is the one module allowed to know those two questions
 * are HTTP, and everything here stays drivable under `node --test` against a
 * plain object.
 *
 * WHAT IS CACHED AND FOR HOW LONG. The commit itself and one entry per file's
 * diff, for as long as that commit is open. A commit is immutable, so a block
 * that has answered is never asked again (and a block that FAILED is not
 * either — a retry loop behind a fold is worse than a sentence that stays);
 * closing the view drops all of it, because the next visit is a new question
 * and a cache that outlives the screen is a cache nobody can clear.
 *
 * STALE ANSWERS ARE DROPPED, not drawn. Every request carries the generation
 * it was made in; closing the view or opening another commit bumps it, so the
 * answer for a commit nobody is looking at any more can never paint over the
 * one that is. The same rule the Files panel's listings already follow.
 *
 * NOTHING HERE TOUCHES A PANE. An answer arriving notifies `'screen'`, which
 * main.ts's layout owner and the panel listen on; `ui/panes.ts` renders on
 * `'ui'` alone, so a commit landing while the pane grid is hidden cannot build,
 * reconcile or measure a terminal (the A6 lesson, memory:
 * frontend-terminal-quirks).
 */
import * as st from '../state.ts';
import { messageOf } from './fs-model.ts';
import { promiseOf } from './util.ts';
import type { GitCommitDiffResponse, GitCommitResponse } from '../../../shared/protocol.ts';

/** The two questions this module asks, injected by `main.ts` (never imported). */
export interface CommitGateway {
  /** One commit: its message, who and when, and the files it changed. */
  commit(root: string, hash: string): Promise<GitCommitResponse>;
  /** What that commit changed in ONE file, as numbered lines. */
  commitDiff(root: string, hash: string, path: string): Promise<GitCommitDiffResponse>;
}

/**
 * A question that has been asked. `error` carries the SERVER's own sentence
 * (PLAN-B2 §1d, `messageOf`) and is rendered verbatim where the answer would
 * have been — never a code, never a retry button that hides what happened.
 */
export type Asked<T> =
  | { k: 'loading' }
  | { k: 'ready'; value: T }
  | { k: 'error'; message: string };

interface OpenCommit {
  hash: string;
  /** The folder the request is made from — the same root the Changes tab sends. */
  root: string;
  commit: Asked<GitCommitResponse>;
  /** One entry per file that has been unfolded at least once. */
  diffs: Map<string, Asked<GitCommitDiffResponse>>;
}

let gateway: CommitGateway | null = null;
let open: OpenCommit | null = null;
/** Bumped by every open and every close: an answer from an older one is dropped. */
let generation = 0;
/**
 * Bumped by every CHANGE here — a commit opening, an answer landing, the
 * screen closing — so a reader's render signature can see one without
 * inspecting the whole store.
 */
let version = 0;

/**
 * Hand over the backend (`main.ts`, once) — or take it away, which is what a
 * test does between cases. Either way the open commit is dropped: an answer
 * held from another gateway is an answer about another machine.
 */
export function setCommitGateway(gw: CommitGateway | null): void {
  gateway = gw;
  open = null;
  generation += 1;
  version += 1;
}

/** How many answers have landed. A reader puts it in its render signature. */
export function commitVersion(): number {
  return version;
}

/**
 * Bring the store in line with the screen: called by the commit view at the
 * top of every render, with the hash the view is standing on (or null) and the
 * root it was opened from.
 *
 * Opening the SAME commit again is a no-op — that is what makes a repaint
 * cheap and what keeps a fold from re-asking for a diff.
 */
export function syncCommit(hash: string | null, root: string | null): void {
  if (hash === null || root === null) {
    if (open === null) return;
    open = null;
    generation += 1;
    version += 1;
    return;
  }
  if (open !== null && open.hash === hash && open.root === root) return;
  generation += 1;
  // The store CHANGED — from nothing to a commit that is loading — and both
  // readers draw that state, so their signatures have to see it.
  version += 1;
  const gen = generation;
  const entry: OpenCommit = { hash, root, commit: { k: 'loading' }, diffs: new Map() };
  open = entry;
  const gw = gateway;
  if (gw === null) {
    entry.commit = { k: 'error', message: messageOf(null) };
    return;
  }
  // THE CALL ITSELF IS GUARDED, not only its promise. The gateway is injected,
  // so "it returns a promise" is a promise somebody else keeps: a client
  // function that throws SYNCHRONOUSLY (`encodeURIComponent` on a lone
  // surrogate is exactly that) would otherwise escape this call and take the
  // render that made it down with it, leaving the screen half-built.
  promiseOf(() => gw.commit(root, hash))
    .then((res) => {
      if (gen !== generation) return;
      entry.commit = { k: 'ready', value: res };
      landed();
    })
    .catch((err: unknown) => {
      if (gen !== generation) return;
      entry.commit = { k: 'error', message: messageOf(err) };
      landed();
    });
}

/** What is known about the open commit, or NULL when none is open. */
export function commitAsked(): Asked<GitCommitResponse> | null {
  return open === null ? null : open.commit;
}

/**
 * Ask for one file's diff, unless it has already been asked for. Called by the
 * view for every block that is UNFOLDED — which is how the first ten blocks
 * cost ten requests and the rest cost nothing until the user opens one.
 */
export function askDiff(path: string): void {
  const entry = open;
  if (entry === null || entry.diffs.has(path)) return;
  entry.diffs.set(path, { k: 'loading' });
  const gen = generation;
  const gw = gateway;
  if (gw === null) {
    entry.diffs.set(path, { k: 'error', message: messageOf(null) });
    return;
  }
  promiseOf(() => gw.commitDiff(entry.root, entry.hash, path))
    .then((res) => {
      if (gen !== generation) return;
      entry.diffs.set(path, { k: 'ready', value: res });
      landed(path);
    })
    .catch((err: unknown) => {
      if (gen !== generation) return;
      entry.diffs.set(path, { k: 'error', message: messageOf(err) });
      landed(path);
    });
}

/** What is known about one file's diff, or `loading` for one never asked for. */
export function diffAsked(path: string): Asked<GitCommitDiffResponse> {
  return open?.diffs.get(path) ?? { k: 'loading' };
}

/**
 * ONE diff, for a surface that is not the open commit: a `Changes in <hash>`
 * tab in an editor pane (`ui/file-pane.ts`), which outlives the view it was
 * opened from and shows an immutable commit, so it holds its own answer in its
 * own body and joins no cache and no generation here.
 *
 * It is still the store's call, because the gateway is injected ONCE and a
 * pane that imported `../api.ts` would be the second seam this module exists
 * to prevent.
 */
export function fetchDiff(
  root: string,
  hash: string,
  path: string,
): Promise<GitCommitDiffResponse> {
  const gw = gateway;
  if (gw === null) return Promise.reject(new Error('no gateway'));
  // Same guard as the two above: a synchronous throw becomes a rejection, so
  // the pane that is being BUILT around this call cannot die half-built.
  return promiseOf(() => gw.commitDiff(root, hash, path));
}

/**
 * WHO REPAINTS WHEN A DIFF LANDS. The commit view registers here and patches
 * the ONE block whose answer arrived; without it every diff of a ten-block
 * commit tore down and rebuilt the whole body (ten rebuilds of up to
 * 10 x 2000 rows). Nothing else in the app is about one file's diff, so this
 * is not a notification: the panel's rows and the header do not change.
 */
let onDiff: ((path: string) => void) | null = null;

/** Register (or, with null, drop) that painter. One view, one painter. */
export function setDiffListener(fn: ((path: string) => void) | null): void {
  onDiff = fn;
}

/**
 * An answer changed something on screen. A COMMIT lands on both surfaces, so
 * it notifies; a DIFF belongs to one block, so it goes to the painter above
 * and costs no rebuild anywhere else. With no painter registered (a test, a
 * surface that has not been built yet) it falls back to the notification.
 */
function landed(path?: string): void {
  version += 1;
  if (path !== undefined && onDiff !== null) {
    onDiff(path);
    return;
  }
  st.notify('screen');
}
