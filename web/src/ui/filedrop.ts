/**
 * External file drop (Nocturne part A9, user decisions 2026-09-15) — the layer
 * that lets files and folders dragged out of Windows Explorer land somewhere in
 * this app, plus its two keyboard/button twins: pasting files from the
 * clipboard, and the Files panel's copy strip button (`Copy files here…`, or
 * `Copy files into <folder>…` once a folder is chosen — A9b).
 *
 * NOTHING HERE COPIES ANYTHING. A9 is the visual half: this module resolves a
 * destination, says so while the pointer moves, and hands the drop to the
 * dialog (injected as `openDialog`, `ui/drop-dialog.ts` in the shell), which
 * pretends to copy and says out loud that it is pretending. Part B10 replaces
 * the pretending with a real upload; the events, the targets and the refusals
 * below are already the ones it will use.
 *
 * WHY THE WINDOW, AND WHY CAPTURE. An un-cancelled file drop NAVIGATES the
 * browser to that file — the app would simply disappear — so `dragover` calls
 * `preventDefault()` for EVERY `Files` drag anywhere in the window, on the
 * CAPTURE phase, before anything inside can take it. Validity is then said
 * with `dropEffect` ('copy' vs 'none'), a highlight and the ghost, never by
 * letting the browser have the drop back.
 *
 * WHY IT NEVER MEETS THE IN-APP DRAGS. Tabs, pane headers and Files rows are
 * POINTER drags (`ui/dnd.ts`) and no `draggable` attribute exists in `web/src`
 * (pinned). While a pointer drag is in flight `isDragging()` is true and every
 * external event below stops at its VISUALS, so one gesture can never light
 * two sets of them. It never stops at `preventDefault()`: an armed pointer
 * drag is cleared by a matching pointerup, so a button released outside the
 * window leaves `isDragging()` true for good, and a file dropped on a terminal
 * after that would reach xterm's helper textarea and navigate the page away.
 *
 * WHAT IT MAY NOT CLAIM. Escape does NOT cancel an operating-system drag — the
 * OS owns that gesture — so no overlay here says it does. The drag ends on the
 * drop, on a `dragleave` that really left the window, or on the watchdog
 * stamped by `dragover`; enter/leave counting is deliberately not used (it
 * desynchronises the moment one event is swallowed).
 *
 * COPY RULES IT FOLLOWS: a destination is always a NAME (`Home`, a project's
 * name, a folder's name), never a path, and refusals are one plain sentence
 * flashed AFTER the release — a statusline that talks while the pointer moves
 * is noise nobody can read mid-drag.
 */
import { flash } from './statusline.ts';
import { isDragging } from './dnd.ts';
import { isEditableTarget, isTerminalTarget, OPEN_MODAL_SELECTOR } from './keys.ts';
import { fileName } from './slots-model.ts';
import { el } from './util.ts';
import { DROP_HINT, MAX_ITEMS, destLine, hasFiles, tooMany, type DropItem } from './drop-model.ts';
import { copyIntoText, takesPaste } from './files-select-model.ts';

/**
 * How long after the last `dragover` the visuals give up on their own. The
 * HTML DnD model re-fires `dragover` only every ~350 ms while the pointer
 * stands still, so anything near that makes the ghost and the highlight blink
 * on every pause; 700 ms clears a drag the page stopped hearing about without
 * ever interrupting one that is merely holding still.
 */
const WATCHDOG_MS = 700;

/** More top-level items than one drop may carry (`MAX_ITEMS`), said once. */
const TOO_MANY = `Too many items. Drop up to ${MAX_ITEMS} at a time.`;

/**
 * A terminal pane whose session has no project (user decision 4, 2026-09-15).
 * The app may not print a path and cannot name that folder, so it says what it
 * knows and stops; B10 may fill the name in when the backend can answer with
 * one.
 */
const NO_PROJECT = 'This session has no project folder yet.';

/**
 * The same refusal for a pane that is NOT a session — a file or a diff in a
 * tab with no root folder and no session to borrow one from. It says `tab`,
 * not `session`, because there is no session in it to talk about.
 */
const NO_TAB_PROJECT = 'This tab has no project folder yet.';

/** What a pane's drop box says. An external drop never splits a pane. */
function paneLabel(dest: string): string {
  return `Copy into ${dest}`;
}

/**
 * `Copy files into src` — the wording of the twin button's title, and what the
 * ghost says when the browser will not tell us how many items are being
 * dragged. ONE definition, so the button and the ghost can never promise
 * different things about the same destination.
 *
 * It MOVED to `ui/files-select-model.ts` in part A9b, where the selection that
 * now names the destination lives, and is re-exported here so every reader
 * that learned it from this module keeps working unchanged.
 */
export { copyIntoText };

/** A file, reduced to what an item needs. A real `File` satisfies it. */
export interface FileLike {
  readonly name: string;
  readonly size?: number;
}

/**
 * What a pane resolves to: a destination NAME, or nothing plus the REASON —
 * a session without a project, or a tab that has no folder at all. The
 * sentences themselves live here; `ui/files.ts` answers which case it is.
 */
export type PaneDest = { dest: string } | { dest: null; why: 'session' | 'tab' };

/** What `openDialog` is handed for one drop, paste or pick. */
export interface DropRequest {
  /** The destination, as a NAME. */
  dest: string;
  /** The TOP-LEVEL things being copied. */
  items: DropItem[];
  /** The destination's own top-level names, for the conflict question. */
  listing: readonly string[];
  /** Where the keyboard was, so the dialog can give it back. */
  returnFocus: HTMLElement | null;
}

/**
 * Everything this module is not allowed to decide for itself. Three of them
 * answer the same question in three places — "what is this surface called" —
 * and they all come from `ui/files.ts`, which owns the one `subject()` the
 * panel header already prints, so the ghost, the dialog and the button can
 * never name different folders.
 */
export interface FileDropDeps {
  /** Ask the drop dialog (ui/drop-dialog.ts) about this drop. */
  openDialog(req: DropRequest): void;
  /** The destination folder's own top-level names (the conflict input). */
  listingFor(dest: string): readonly string[];
  /**
   * A pane's destination, in the Files header's own order: a terminal pane's
   * session project, else its tab's folder; an editor pane's tab folder, else
   * the tab's first session's project; else the reason it has none.
   */
  destinationOfPane(paneEl: HTMLElement): PaneDest;
  /** The ACTIVE tab's root name — what the empty pane area stands for. */
  destinationOfActiveView(): string | null;
  /** The Files panel's own root name (its non-folder area). */
  filesPanelDestination(): string | null;
  /** The CHOSEN folder (A9b), else the Files folder row the keyboard last stood on, else the panel root, else the active tab's root. */
  pasteDestination(): string | null;
  /**
   * The folder the user CHOSE in the Files panel, as a name, else null (A9b).
   * It is read for one question only — may this `paste` be taken away from a
   * focused terminal or a focused field? — because that is the only thing the
   * chosen folder changes here; where the files then go is `pasteDestination()`,
   * which already answers the selection first.
   */
  selectedFolder(): string | null;
  /**
   * Open the native file chooser and hand over what was chosen. Injected so
   * tests can drive the twin button without a real `<input type=file>`; the
   * default really opens one.
   */
  openPicker?(take: (files: readonly FileLike[]) => void): void;
  /** Say a refusal. Injected only so tests can read it; the default flashes. */
  flash?(msg: string): void;
}

let deps: FileDropDeps | null = null;

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

/**
 * Where a drop at this point would land. `none` carries the sentence a drop
 * ATTEMPT should flash, or null when there is nothing to say (the pointer is
 * over ordinary chrome, and saying "not here" for every pixel of it would be
 * nagging).
 */
type Target =
  | { t: 'row' | 'panel' | 'pane' | 'empty'; el: HTMLElement; dest: string }
  | { t: 'none'; why: string | null };

const NOTHING: Target = { t: 'none', why: null };

/** Is a modal dialog up? Then nothing in the window takes a drop (PLAN-A9 §1). */
function modalOpen(): boolean {
  return document.querySelector(OPEN_MODAL_SELECTOR) !== null;
}

/**
 * Resolve a point to a destination, in the order PLAN-A9 §2 fixes:
 *
 *   1. `.files-row.is-dir`      -> that folder, by its OWN name;
 *   2. anywhere else in the panel -> the panel's root (its header's name);
 *   3. `.pane[data-slot]`       -> a terminal pane: its session's project,
 *      else the tab's folder; an editor pane: the tab's folder, else the
 *      tab's first session's project; else NOT a target (decision 4: it has
 *      no folder to name) — the same order the Files header uses;
 *   4. `.empty-state`           -> the active tab's root;
 *   5. anything else (chrome, the commit view over the grid) -> not a target.
 *
 * The row comes first because it is INSIDE the panel: `closest` would answer
 * `.files-view` for it too, and a folder the pointer is actually on beats the
 * panel it lives in.
 */
function resolveTarget(x: number, y: number): Target {
  if (deps === null || modalOpen()) return NOTHING;
  const hit = document.elementFromPoint(x, y);
  if (!(hit instanceof Element)) return NOTHING;

  const row = hit.closest<HTMLElement>('.files-row.is-dir');
  if (row !== null) {
    // `data-k="fdir:web/src"` — the row's path; only its last segment is ever
    // shown, and a folder row without one is not a target we can name.
    const key = row.getAttribute('data-k') ?? '';
    const path = key.startsWith('fdir:') ? key.slice('fdir:'.length) : '';
    const name = path === '' ? '' : fileName(path);
    return name === '' ? NOTHING : { t: 'row', el: row, dest: name };
  }

  const panel = hit.closest<HTMLElement>('.files-view');
  if (panel !== null) {
    const dest = deps.filesPanelDestination();
    return dest === null ? NOTHING : { t: 'panel', el: panel, dest };
  }

  const pane = hit.closest<HTMLElement>('.pane[data-slot]');
  if (pane !== null) {
    const d = deps.destinationOfPane(pane);
    if (d.dest === null) return { t: 'none', why: d.why === 'tab' ? NO_TAB_PROJECT : NO_PROJECT };
    return { t: 'pane', el: pane, dest: d.dest };
  }

  const empty = hit.closest<HTMLElement>('.empty-state');
  if (empty !== null) {
    const dest = deps.destinationOfActiveView();
    return dest === null ? NOTHING : { t: 'empty', el: empty, dest };
  }
  return NOTHING;
}

// ---------------------------------------------------------------------------
// Visuals
// ---------------------------------------------------------------------------

/** The drag that is being drawn right now, or null between drags. */
let ghost: HTMLElement | null = null;
/** Everything currently wearing one of our classes, so the clear is exact. */
let lit: HTMLElement[] = [];
/** The pane overlay currently revealed. */
let box: HTMLElement | null = null;
/**
 * What is drawn right now, as one string. `dragover` fires at pointer rate, so
 * without this every frame would rewrite a class list and a label for a picture
 * that did not change — the same guard `ui/dnd.ts` keeps as `targetKey`.
 */
let painted = '';
let watchdog: number | null = null;

function begin(): void {
  if (ghost !== null) return;
  ghost = el('div', 'drag-ghost');
  document.body.append(ghost);
  document.body.classList.add('is-filedrag');
}

/**
 * The ghost rides the cursor exactly as the pointer-drag ghost does
 * (ui/dnd.ts `positionGhost`), including the static tilt — one drag ghost in
 * this app, one look, whichever channel produced it.
 */
function positionGhost(x: number, y: number): void {
  if (ghost === null) return;
  ghost.style.transform = `translate(${x + 14}px, ${y + 10}px) rotate(-2deg)`;
}

/**
 * Light the target. NOTHING here may change layout: outlines and an absolutely
 * positioned overlay only. A border or a padding change would resize the pane
 * grid, every TerminalView's ResizeObserver would fire and the PTYs would be
 * resized — twice per drag — for a highlight (PLAN-A9 §2).
 */
function paint(target: Target, count: number, x: number, y: number): void {
  begin();
  positionGhost(x, y);
  const key =
    target.t === 'none' ? `none:${count}` : `${target.t}:${target.dest}:${count}:${elementKey(target.el)}`;
  if (key === painted) return;
  painted = key;
  clearVisuals();
  if (ghost !== null) {
    const onTarget = target.t !== 'none';
    ghost.textContent = onTarget
      ? count > 0
        ? destLine(count, target.dest)
        : copyIntoText(target.dest)
      : DROP_HINT;
    ghost.classList.toggle('is-invalid', !onTarget);
  }
  if (target.t === 'none') return;
  if (target.t === 'pane') {
    const drop = target.el.querySelector<HTMLElement>('.pane-drop');
    if (drop === null) return;
    // NO `data-zone`: an external drop never splits a pane, so the box covers
    // the whole card and the label says the one thing it will do.
    delete drop.dataset.zone;
    const label = drop.querySelector('.pane-drop-lb');
    if (label !== null) label.textContent = paneLabel(target.dest);
    drop.hidden = false;
    box = drop;
    return;
  }
  target.el.classList.add('is-drop');
  lit.push(target.el);
}

/**
 * Tells two elements of the same kind apart between frames (two folder rows,
 * two panes). The `data-k` / `data-slot` a row and a pane already carry is
 * exactly that identity; anything else is a singleton on screen.
 */
function elementKey(n: HTMLElement): string {
  return n.getAttribute('data-k') ?? n.dataset.slot ?? '';
}

function clearVisuals(): void {
  for (const n of lit) n.classList.remove('is-drop');
  lit = [];
  if (box !== null) {
    box.hidden = true;
    box = null;
  }
}

/** The drag is over, whichever of the three endings got here first. */
function endDrag(): void {
  clearVisuals();
  painted = '';
  if (watchdog !== null) {
    window.clearTimeout(watchdog);
    watchdog = null;
  }
  ghost?.remove();
  ghost = null;
  document.body.classList.remove('is-filedrag');
}

/**
 * Re-arm the watchdog. A drag that leaves through a gap in the events — a
 * window that loses focus mid-drag, a drop the page never hears about — would
 * otherwise leave the ghost and a lit row behind for good.
 */
function stamp(): void {
  if (watchdog !== null) window.clearTimeout(watchdog);
  watchdog = window.setTimeout(() => {
    watchdog = null;
    endDrag();
  }, WATCHDOG_MS);
}

// ---------------------------------------------------------------------------
// Reading what is being dropped
// ---------------------------------------------------------------------------

/** What `dataTransfer` will say about itself mid-drag. */
function typesOf(dt: DataTransfer | null): readonly string[] {
  if (dt === null) return [];
  const types = dt.types as readonly string[] | undefined;
  return types ?? [];
}

/**
 * How many things are being dragged. Mid-drag this is ALL the browser will
 * say (measured, PLAN-A9 "Facts checked": names, sizes and folder-ness only
 * exist from `drop` onwards), so the ghost counts items and the dialog is the
 * first thing that can say `2 files and 1 folder`.
 */
function dragCount(dt: DataTransfer | null): number {
  if (dt === null) return 0;
  const items = dt.items as DataTransferItemList | undefined;
  if (items === undefined || items === null) return dt.files?.length ?? 0;
  let n = 0;
  for (let i = 0; i < items.length; i += 1) {
    const it = items[i] as DataTransferItem | undefined;
    const kind = it?.kind as string | undefined;
    if (kind === undefined || kind === 'file') n += 1;
  }
  return n;
}

/**
 * The TOP-LEVEL items of a drop. `webkitGetAsEntry()` is the only thing that
 * can tell a folder from a file, and it answers from `drop` onwards only; a
 * folder's size is a recursive walk, which is B10's job, so it carries
 * `bytes: null` and can never trip the size limit.
 */
function readItems(dt: DataTransfer): DropItem[] {
  const out: DropItem[] = [];
  const items = dt.items as DataTransferItemList | undefined;
  if (items !== undefined && items !== null && items.length > 0) {
    for (let i = 0; i < items.length; i += 1) {
      const it = items[i] as DataTransferItem | undefined;
      if (it === undefined) continue;
      const kind = it.kind as string | undefined;
      if (kind !== undefined && kind !== 'file') continue;
      const entry = it.webkitGetAsEntry?.() ?? null;
      const file = it.getAsFile?.() ?? null;
      const name = entry?.name ?? file?.name ?? '';
      if (name === '') continue;
      const dir = entry?.isDirectory === true;
      out.push({ name, dir, bytes: dir ? null : (file?.size ?? null) });
    }
    return out;
  }
  return itemsOfFiles(dt.files ?? []);
}

/** Files (a paste, or the native chooser) are always files — never folders. */
function itemsOfFiles(files: ArrayLike<FileLike>): DropItem[] {
  const out: DropItem[] = [];
  for (let i = 0; i < files.length; i += 1) {
    const f = files[i] as FileLike | undefined;
    if (f === undefined || f.name === '') continue;
    out.push({ name: f.name, dir: false, bytes: f.size ?? null });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Handing a drop over
// ---------------------------------------------------------------------------

function say(msg: string): void {
  (deps?.flash ?? flash)(msg);
}

function activeEl(): HTMLElement | null {
  return document.activeElement instanceof HTMLElement ? document.activeElement : null;
}

/**
 * The one door to the dialog: every path (drop, paste, button) arrives here
 * with a destination and its items, so the limit is checked once and the
 * listing is looked up once.
 */
function offer(dest: string, items: DropItem[], returnFocus: HTMLElement | null): void {
  const d = deps;
  if (d === null) return;
  if (tooMany(items.length)) {
    say(TOO_MANY);
    return;
  }
  // A drop the browser described as nothing at all is not a refusal to
  // announce — there is nothing the user could do differently.
  if (items.length === 0) return;
  d.openDialog({ dest, items, listing: d.listingFor(dest), returnFocus });
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * A non-`Files` drag (text from another program) over a TERMINAL is cancelled:
 * xterm's helper textarea would take it as typed input, straight into the PTY
 * with no bracketed paste around it (user decision 5, 2026-09-15). Preventing
 * the default is what TAKES the drop away from the textarea — we then do
 * nothing with it. Anywhere else such a drag is left completely alone, so
 * dragging text into a file pane's editor keeps working.
 */
function cancelTextOnTerminal(e: DragEvent): void {
  const t = e.target;
  if (!(t instanceof HTMLElement) || !isTerminalTarget(t)) return;
  e.preventDefault();
  // `preventDefault()` alone leaves the OS cursor saying `copy` over a drop
  // this app refuses outright: the cursor has to say `no`, like everywhere
  // else a target is invalid.
  const dt = e.dataTransfer;
  if (dt !== null) dt.dropEffect = 'none';
}

function onDragOver(e: DragEvent): void {
  if (deps === null) return;
  const dt = e.dataTransfer;
  if (!hasFiles(typesOf(dt))) {
    cancelTextOnTerminal(e);
    return;
  }
  // EVERY Files drag in the window, target or not, in-app pointer drag in
  // flight or not: without this the browser fires no `drop` and a miss
  // navigates the page to the dropped file. A stuck `isDragging()` may cost
  // this drag its visuals; it may never cost the app its window.
  e.preventDefault();
  if (isDragging()) {
    if (dt !== null) dt.dropEffect = 'none';
    return;
  }
  const target = resolveTarget(e.clientX, e.clientY);
  if (dt !== null) dt.dropEffect = target.t === 'none' ? 'none' : 'copy';
  paint(target, dragCount(dt), e.clientX, e.clientY);
  stamp();
}

/** Did the pointer really leave the window, or just cross into a child? */
function outsideViewport(x: number, y: number): boolean {
  const w = window.innerWidth;
  const h = window.innerHeight;
  if (typeof w !== 'number' || typeof h !== 'number') return true;
  return x <= 0 || y <= 0 || x >= w || y >= h;
}

function onDragLeave(e: DragEvent): void {
  if (ghost === null) return;
  // `relatedTarget === null` is the only leave that means "the window": every
  // crossing between two elements inside the page names the element entered.
  if (e.relatedTarget !== null) return;
  if (!outsideViewport(e.clientX, e.clientY)) return;
  endDrag();
}

function onDrop(e: DragEvent): void {
  if (deps === null) return;
  const dt = e.dataTransfer;
  if (!hasFiles(typesOf(dt))) {
    cancelTextOnTerminal(e);
    return;
  }
  // Prevented FIRST, whatever else is in flight — an un-cancelled file drop
  // navigates the page to the file (see `onDragOver`).
  e.preventDefault();
  if (isDragging()) return;
  const target = resolveTarget(e.clientX, e.clientY);
  const returnFocus = activeEl();
  endDrag();
  if (target.t === 'none') {
    if (target.why !== null) say(target.why);
    return;
  }
  if (dt === null) return;
  // Counted BEFORE the entries are read: 10 000 items must be refused by a
  // number, not by walking 10 000 of them first.
  if (tooMany(dragCount(dt))) {
    say(TOO_MANY);
    return;
  }
  offer(target.dest, readItems(dt), returnFocus);
}

/**
 * Files on the clipboard, pasted into the app itself — the keyboard twin of
 * the drop.
 *
 * The app listens for the `paste` EVENT, never for a chord, and `takesPaste`
 * (the frozen rule in `ui/files-select-model.ts`) decides whether the event is
 * ours at all. Its four sentences, restated where they act:
 *
 *   - a TEXT-ONLY clipboard is never ours, so a terminal's paste and a field's
 *     paste stay entirely their own and the PTY loses nothing, ever;
 *   - FILES plus a CHOSEN folder is ours from anywhere — a focused terminal
 *     and a focused field included (A9b user decision 2) — because files carry
 *     no text, so nothing was going to be typed, and the copy strip has been
 *     saying where they land the whole time;
 *   - FILES with nothing chosen is the A9 rule exactly: outside terminals and
 *     editables the fallback chain answers, inside one nothing happens at all;
 *   - a modal up means nothing in the window takes a paste.
 *
 * WHY stopPropagation(), and why on the capture phase. `preventDefault()`
 * alone leaves xterm's own textarea `paste` handler to run behind us; an
 * Explorer clipboard that happens to carry `text/plain` beside its files would
 * then type that text into the PTY unbracketed — the very accident A9
 * decision 5 exists to prevent. An event this module has taken is nobody
 * else's.
 *
 * KNOWN LIMIT (`.claude/PLAN-A9B.md` §2, said out loud in the shortcuts
 * overlay): inside a focused terminal only plain ctrl+v can carry files.
 * `ui/terminal.ts` takes ctrl+shift+v and shift+insert itself and serves them
 * from `navigator.clipboard.readText()`, which cannot see a file list — and
 * that module is a terminal seam A9b does not touch.
 */
function onPaste(e: ClipboardEvent): void {
  const d = deps;
  if (d === null) return;
  const files = e.clipboardData?.files;
  const t = e.target instanceof HTMLElement ? e.target : null;
  const ours = takesPaste({
    files: files !== undefined && files !== null && files.length > 0,
    selected: d.selectedFolder() !== null,
    inTerminal: isTerminalTarget(t),
    inEditable: isEditableTarget(t),
    modalOpen: modalOpen(),
  });
  if (!ours || files === undefined || files === null) return;
  const dest = d.pasteDestination();
  if (dest === null) return;
  e.preventDefault();
  e.stopPropagation();
  // `document.activeElement` at PASTE time: the dialog hands the keyboard back
  // to it when it closes (ui/drop-dialog.ts `restore`), so a terminal the
  // paste came from is typing again the moment the card is gone. Nothing here
  // moves the focus, so there is nothing to undo.
  offer(dest, itemsOfFiles(files), activeEl());
}

// ---------------------------------------------------------------------------
// The button twin
// ---------------------------------------------------------------------------

/** The default chooser: a plain multi-file `<input type=file>`, made on demand. */
function nativePicker(take: (files: readonly FileLike[]) => void): void {
  const input = el('input');
  input.type = 'file';
  input.multiple = true;
  input.hidden = true;
  input.addEventListener('change', () => {
    const files = input.files;
    take(files === null ? [] : Array.from(files));
    input.remove();
  });
  // A cancelled chooser fires no `change`; without this every cancel would
  // leave one dead input in the body for the life of the page.
  input.addEventListener('cancel', () => input.remove());
  document.body.append(input);
  input.click();
}

/**
 * The copy strip's button under the Files-panel header (ui/files.ts owns the
 * button; this owns what it does). It acts on the SAME destination the paste
 * does, and reads it at CLICK time — the button's label and title said that
 * name a moment ago and have to keep their word.
 *
 * `into` names a destination outright, for the row-level twin: ctrl+alt+c on a
 * focused FOLDER row copies into THAT folder, and the row menu's
 * `Copy files here…` entry does the same for the row it was opened on (A9b).
 * The strip button sits before the tree and every row is a button, so a
 * keyboard user can reach the button or the folder they mean, never both — the
 * chord is how a nested folder is aimed at at all.
 */
export function openCopyFilesPicker(into?: string): void {
  const d = deps;
  if (d === null) return;
  const dest = into ?? d.pasteDestination();
  if (dest === null) return;
  const returnFocus = activeEl();
  (d.openPicker ?? nativePicker)((files) => {
    offer(dest, itemsOfFiles(files), returnFocus);
  });
}

// ---------------------------------------------------------------------------
// The boot guard
// ---------------------------------------------------------------------------

/** Removes the guard below, while it is installed. */
let guardOff: (() => void) | null = null;

/**
 * The window's file drop, REFUSED, from the first line of the boot path until
 * `initFileDrop` takes over — and forever when boot never gets that far (a
 * failed hydrate leaves the boot panel up, with no drop listener anywhere
 * behind it). Without this a file dropped on the window in that gap NAVIGATES
 * the browser to that file and the app is simply gone.
 *
 * It does exactly two things and knows nothing: `preventDefault()` so the
 * browser does not take the drop, and `dropEffect = 'none'` so the cursor says
 * so. No targets, no visuals, no dialog — those need a shell that does not
 * exist yet. Returns its own uninstaller; `initFileDrop` calls it before
 * registering the real listeners, so exactly one of the two is ever live.
 */
export function installDropGuard(): () => void {
  guardOff?.();
  const guard = (e: DragEvent): void => {
    if (!hasFiles(typesOf(e.dataTransfer))) return;
    e.preventDefault();
    const dt = e.dataTransfer;
    if (dt !== null) dt.dropEffect = 'none';
  };
  const off = (): void => {
    window.removeEventListener('dragover', guard, true);
    window.removeEventListener('drop', guard, true);
    if (guardOff === off) guardOff = null;
  };
  window.addEventListener('dragover', guard, true);
  window.addEventListener('drop', guard, true);
  guardOff = off;
  return off;
}

/**
 * Wire the window. Called once from main.ts after the Files panel exists (its
 * `subject()` answers three of the deps). Idempotent in the sense that matters
 * for tests: calling it again replaces the deps and re-registers nothing.
 */
export function initFileDrop(d: FileDropDeps): void {
  const first = deps === null;
  deps = d;
  // The boot guard steps aside BEFORE anything else here, and whether or not
  // this is the first call: two handlers both calling `preventDefault()` on
  // the same drop is one handling too many.
  guardOff?.();
  if (!first) return;
  // CAPTURE everywhere: the decision about a file drop belongs to the window,
  // before any editable element inside can take it as typed input.
  window.addEventListener('dragenter', onDragOver, true);
  window.addEventListener('dragover', onDragOver, true);
  window.addEventListener('dragleave', onDragLeave, true);
  window.addEventListener('drop', onDrop, true);
  window.addEventListener('paste', onPaste, true);
}
