/**
 * Shared setup for `tests/ui/ui-filedrop*.test.ts` (Nocturne parts A9, A9b,
 * B10): the DOM double installed at import, the REAL `web/src/ui/filedrop.ts`
 * and `web/src/ui/dnd.ts` imported after it, and a shell just real enough to
 * hit-test — the Files panel with folder rows (and two `Changes` rows that look
 * like destinations and are not), a grid with two panes (one holding a
 * terminal), an empty state, a scrim — plus the points over each surface and
 * the dispatch helpers. Not a test.
 *
 * The injected deps and their mutable state stay in each test file: the tests
 * reassign them, which an imported binding cannot be. Each file calls
 * `FD.initFileDrop(DEPS)` itself — one process per file, one wiring each.
 */
import {
  byClass,
  dispatch,
  installDom,
  makeDataTransfer,
  setRect,
  type FakeDataTransfer,
  type FakeElement,
} from './fake-dom.ts';
import { nextImmediate } from './helpers.ts';

export const dom = installDom();

export const FD = (await import(new URL('../../web/src/ui/filedrop.ts', import.meta.url).href)) as FileDropModule;
export const DND = (await import(new URL('../../web/src/ui/dnd.ts', import.meta.url).href)) as DndModule;

export interface DropItem {
  name: string;
  dir: boolean;
  bytes: number | null;
}
/** A real folder: the NAME a drop is allowed to show, the PATH B10 will post to. */
export interface Dest {
  path: string;
  name: string;
}
export interface DropRequest {
  dest: Dest;
  items: DropItem[];
  listing: readonly string[];
  returnFocus: unknown;
}
/** What part B10 added to the request: the walk's own answer. */
export interface WalkShape {
  files: { top: number; rel: string; file: unknown }[];
  folders: { top: number; rel: string }[];
  bytes: number;
  biggest: number;
  unreadable: number;
}
export interface FileDropModule {
  initFileDrop(deps: Record<string, unknown>): void;
  installDropGuard(): () => void;
  openCopyFilesPicker(into?: Dest): void;
  copyIntoText(dest: string): string;
}

/**
 * A destination for the fakes below. The PATH is never shown anywhere — every
 * visible string is built from `.name` — so these tests read the name and pin
 * the path only where the contract is about it.
 */
export function dest(name: string): Dest {
  return { path: `/home/you/${name === 'Home' ? '' : name}`.replace(/\/$/, ''), name };
}

/**
 * Let the module's own promise chain land: since part B2 `offer()` awaits the
 * destination's listing before the dialog opens, so a drop is one microtask
 * turn away from its dialog.
 */
export async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  // Part B10 made the chain arbitrarily long: the walk awaits every
  // `readEntries()` and every `file()` callback, so a 2000-file folder is
  // 2000 microtask turns. One macrotask turn drains the whole queue, however
  // deep it is — and it still cannot resolve a listing a test is HOLDING.
  await nextImmediate();
}
export interface DndModule {
  armDrag(source: unknown, ignore: string | null, makeSpec: () => unknown): void;
}

// ---------------------------------------------------------------------------
// A shell just real enough to hit-test: the Files panel with two folder rows,
// a grid with two panes (one holding a terminal), an empty state, a scrim.
// ---------------------------------------------------------------------------

export function div(cls: string, rect?: { left: number; top: number; width: number; height: number }): FakeElement {
  const n = dom.doc.createElement('div');
  n.className = cls;
  if (rect !== undefined) setRect(n, rect);
  return n;
}

export const panel = div('files-view', { left: 0, top: 0, width: 300, height: 800 });
export const rowWeb = div('files-row is-dir', { left: 0, top: 100, width: 300, height: 26 });
rowWeb.setAttribute('data-k', 'fdir:web');
export const rowSrc = div('files-row is-dir', { left: 0, top: 130, width: 300, height: 26 });
rowSrc.setAttribute('data-k', 'fdir:web/src');
/**
 * The `Changes` tab draws folder and file rows too (part B2), with the same
 * classes and a REPO-RELATIVE path under a `gdir:`/`gfile:` key. They are in
 * this shell because they are the one thing in the panel that LOOKS like a
 * destination and is not one.
 */
export const rowGdir = div('files-row is-dir', { left: 0, top: 200, width: 300, height: 26 });
rowGdir.setAttribute('data-k', 'gdir:web/src');
export const rowGfile = div('files-row is-file', { left: 0, top: 230, width: 300, height: 26 });
rowGfile.setAttribute('data-k', 'gfile:web/src/App.tsx');
panel.append(rowWeb, rowSrc, rowGdir, rowGfile);
/**
 * The shell's own host for the panel. `main.ts` hides THIS aside when the
 * Projects drawer takes the left column (`filesAside.hidden = !filesShown`),
 * which is the only way the panel ever leaves the screen — so a test of "the
 * panel is away" hides the host, exactly as the app does.
 */
export const filesAside = div('drawer files-panel');
filesAside.append(panel);

export const grid = div('grid', { left: 300, top: 0, width: 1000, height: 400 });
/** One pane, with the drop overlay `ui/panes.ts` builds into every card. */
export function makePane(slot: number, left: number): FakeElement {
  const pane = div('pane', { left, top: 0, width: 500, height: 400 });
  pane.setAttribute('data-slot', String(slot));
  pane.dataset.slot = String(slot);
  const drop = div('pane-drop');
  drop.hidden = true;
  const box = div('pane-drop-box');
  const lb = div('pane-drop-lb');
  box.append(lb);
  drop.append(box);
  pane.append(drop);
  return pane;
}
export const pane0 = makePane(0, 300);
export const pane1 = makePane(1, 800);
export const termHost = div('term-host', { left: 810, top: 40, width: 480, height: 340 });

/**
 * xterm's own helper textarea, which is where a plain ctrl+v inside a focused
 * terminal really fires its `paste` — so it is BOTH a terminal target and an
 * editable one. xterm's own `paste` handler on it is registered (and counted)
 * by the test file that needs it (`xtermPastes`).
 */

export const termTextarea = dom.doc.createElement('textarea');
setRect(termTextarea, { left: 810, top: 40, width: 480, height: 340 });

termHost.append(termTextarea);
pane1.append(termHost);
grid.append(pane0, pane1);

export const empty = div('empty-state', { left: 300, top: 420, width: 1000, height: 300 });
export const scrim = div('modal-scrim');
scrim.hidden = true;
export const field = dom.doc.createElement('textarea');
setRect(field, { left: 0, top: 900, width: 100, height: 20 });

dom.body.append(filesAside, grid, empty, scrim, field);

export const LISTINGS: Record<string, string[]> = {
  src: ['App.tsx', 'Pane.tsx'],
  Home: ['web', 'server', 'README.md'],
};

export interface FileLikeIn {
  name: string;
  size?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A point over each surface of the shell. */
export const OVER_ROW = { clientX: 150, clientY: 140 }; // the `web/src` row
export const OVER_GDIR = { clientX: 150, clientY: 210 }; // a `Changes` folder row
export const OVER_GFILE = { clientX: 150, clientY: 240 }; // a `Changes` file row
export const OVER_PANEL = { clientX: 150, clientY: 400 }; // panel, no row under it
export const OVER_PANE = { clientX: 500, clientY: 200 };
export const OVER_TERM = { clientX: 1000, clientY: 200 };
export const OVER_EMPTY = { clientX: 700, clientY: 500 };
export const OVER_NOTHING = { clientX: 1500, clientY: 870 };

export function at(p: { clientX: number; clientY: number }): FakeElement {
  return dom.doc.elementFromPoint(p.clientX, p.clientY) ?? dom.body;
}

/** One `dragover`, dispatched on whatever is under the point. */
export function dragOver(
  p: { clientX: number; clientY: number },
  dt: FakeDataTransfer,
  on?: FakeElement,
): { prevented: boolean } {
  const e = dispatch(on ?? at(p), 'dragover', { ...p, dataTransfer: dt });
  return { prevented: e.defaultPrevented };
}

export function drop(
  p: { clientX: number; clientY: number },
  dt: FakeDataTransfer,
  on?: FakeElement,
): { prevented: boolean } {
  const e = dispatch(on ?? at(p), 'drop', { ...p, dataTransfer: dt });
  return { prevented: e.defaultPrevented };
}

export function ghost(): FakeElement | undefined {
  return byClass(dom.body, 'drag-ghost')[0];
}

export function litClasses(): string[] {
  return byClass(dom.body, 'is-drop').map((n) => n.className);
}

export function paneBox(pane: FakeElement): FakeElement {
  return byClass(pane, 'pane-drop')[0] as FakeElement;
}

/** Fire every armed timer (the watchdog is the only one here). */
export function flushTimers(): void {
  const armed = [...dom.win.timers];
  dom.win.timers.length = 0;
  for (const t of armed) t.fn();
}

export const FILES_DT = (): FakeDataTransfer =>
  makeDataTransfer({ items: [{ name: 'a.ts', size: 10 }, { name: 'b.ts', size: 20 }] });
export const TEXT_DT = (): FakeDataTransfer => makeDataTransfer({ types: ['text/plain'] });
