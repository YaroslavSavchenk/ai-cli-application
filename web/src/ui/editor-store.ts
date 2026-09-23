/**
 * THE EDITOR'S BACKEND, and its ONE clock (Nocturne part B4).
 *
 * Two jobs, and they are here together because they are the same seam:
 *
 * 1. THE GATEWAY IS INJECTED, exactly like `ui/commit-store.ts`'s. `main.ts`
 *    is the one module allowed to know that reading and writing a file are
 *    HTTP; `ui/file-pane.ts` never imports `../api.ts`, which is what keeps a
 *    file body drivable under `node --test` against a plain object.
 * 2. ONE TIMER FOLLOWS EVERY FILE ON SCREEN (user decision D3, 2026-09-22): a
 *    clean tab re-reads its file when the bytes on disk change. One
 *    `setInterval` for the whole app — a timer per body would be one poll per
 *    pane per tab, and four panes of four tabs would ask sixteen times for the
 *    twelve files nobody is looking at.
 *
 * WHAT IS POLLED, AND WHAT IS SKIPPED. A registered body is asked to re-read
 * only when all four hold:
 *
 *   - `root.isConnected` — a PARKED body (its tab is not the active one, or
 *     its pane is gone) is detached, so this single test is also "the active
 *     tab of an editor pane that is on screen";
 *   - `!dirty()` — unsaved text is NEVER overwritten from disk (D3);
 *   - `!inFlight()` — a body with a read or a write of its own out would race
 *     its own answer;
 *   - `stamp() !== null` — a body that never read has nothing to compare, and
 *     a file that answered a refusal must not be re-asked every 5 s.
 *
 * And the tick itself does nothing at all while the document is hidden: a
 * background window is not a screen anybody is reading.
 *
 * THE TIMER IS THE WINDOW'S. `window.setInterval` rather than the bare global,
 * so `tests/helpers/fake-dom.ts` RECORDS it instead of running it — a test drives the
 * follow by calling `dom.win.intervals[0].fn()`, and no test depends on a
 * clock.
 */
import type { FsReadResponse, FsWriteRequest, FsWriteResponse } from '../../../shared/protocol.ts';
import { promiseOf } from './util.ts';

/** The two questions the editor asks, injected by `main.ts` (never imported). */
export interface EditorGateway {
  /**
   * One text file. `ifStamp` = the stamp already held: the answer is
   * `{ changed: false }` when the bytes are still those, so a follow tick
   * costs no body.
   */
  read(path: string, ifStamp?: string): Promise<FsReadResponse>;
  /** Write one text file back, with the stamp it was edited from. */
  write(body: FsWriteRequest): Promise<FsWriteResponse>;
}

/** How often a clean file on screen asks whether it changed (D3). */
export const FOLLOW_MS = 5000;

/**
 * What the poll needs to know about one file body. The BODY owns its request
 * and its painting (`follow()`); this module owns the rhythm and the four
 * conditions above, so there is one place to read what is and is not polled.
 */
export interface FileFollower {
  /** The body's own node. A detached one is parked and never polled. */
  readonly root: { readonly isConnected: boolean };
  /** Is there unsaved text in it? Then disk never wins. */
  dirty(): boolean;
  /** Is a read or a write of its own still out? */
  inFlight(): boolean;
  /** The stamp of the bytes it holds, or null while it holds none. */
  stamp(): string | null;
  /** Re-read and repaint. Called only when all four conditions allow it. */
  follow(): void;
}

let gateway: EditorGateway | null = null;
const followers = new Set<FileFollower>();
let timer: number | null = null;

/**
 * Hand over the backend (`main.ts`, once) — or take it away, which is what a
 * test does between cases.
 */
export function setEditorGateway(gw: EditorGateway | null): void {
  gateway = gw;
}

/**
 * Read one file through the gateway. A synchronous throw becomes the rejection
 * it should be (`encodeURIComponent` on a lone surrogate is exactly that), so
 * the body that is being BUILT around this call can never die half-built —
 * the same guard `ui/commit-store.ts` puts on its own three calls.
 */
export function editorRead(path: string, ifStamp?: string): Promise<FsReadResponse> {
  const gw = gateway;
  if (gw === null) return Promise.reject(new Error('no gateway'));
  return promiseOf(() => gw.read(path, ifStamp));
}

/** Write one file through the gateway, with the same guard. */
export function editorWrite(body: FsWriteRequest): Promise<FsWriteResponse> {
  const gw = gateway;
  if (gw === null) return Promise.reject(new Error('no gateway'));
  return promiseOf(() => gw.write(body));
}

/**
 * Put one body under the follow. Called by `filePaneBody` on build; the pane
 * drops it again through `dispose()` (`ui/editor-pane.ts` parks bodies and
 * gives them up with the pane), so a body that outlived its pane can never
 * keep asking about a file nobody has open.
 */
export function registerBody(f: FileFollower): void {
  followers.add(f);
  if (timer === null && followers.size > 0) {
    timer = window.setInterval(followTick, FOLLOW_MS);
  }
}

/** Take one body out of the follow, and stop the clock when none is left. */
export function unregisterBody(f: FileFollower): void {
  followers.delete(f);
  if (followers.size === 0 && timer !== null) {
    window.clearInterval(timer);
    timer = null;
  }
}

/** How many bodies the follow holds. A test reads it; nothing else does. */
export function followerCount(): number {
  return followers.size;
}

/**
 * One tick: every body that may be asked, asks. Exported so a test can drive
 * the rhythm directly as well as through the recorded interval.
 */
export function followTick(): void {
  // A hidden document is not a screen anybody is reading — and a window left
  // open for a week must not ask about twelve files every five seconds.
  if (document.visibilityState !== 'visible') return;
  for (const f of [...followers]) {
    if (!f.root.isConnected) continue;
    if (f.dirty() || f.inFlight()) continue;
    if (f.stamp() === null) continue;
    f.follow();
  }
}
