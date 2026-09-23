/**
 * Pane grid for the ACTIVE view (= tab). A view holds 0..4 SLOTS in a fixed
 * split shape (see state.ts for the slot maps), and since Nocturne part A10b a
 * slot is one of TWO things: a terminal, or an EDITOR holding a strip of file
 * and read-only diff tabs. They mix freely inside one tab — files may sit
 * beside a running session.
 *
 * Sessions exist independently of views; this module only attaches and
 * detaches xterm views. Terminals exist only for the active view's SESSION
 * slots; switching TABS disposes and re-attaches (the server replays the
 * scrollback's tail, `REPLAY_MAX_LINES`). Within one tab a pane keeps its card — and so its terminal and its
 * socket — for as long as its content stays in the tab (`relayout`, Quality
 * part P2): a split, a close, an extract or a swap moves the card in the grid
 * and its own ResizeObserver refits it, so only a pane NEW to the tab
 * attaches. A slot that merely changes CONTENT is converted in place
 * (`reconcileSlot`), so swapping a file with the terminal beside it
 * re-attaches nothing.
 *
 * A pane (Nocturne part A3) is a neutral-900 card holding, top to bottom: a
 * 38px header, the exited/lost banner when there is one, and the body on the
 * terminal ground. What those two hold depends on the kind:
 *
 *   session  header: state dot, session name, project NAME, state pill,
 *            "Own tab" in a split, the End session button (B8). Body: the xterm mount, a thin status bar
 *            (ui/pane-status-model.ts) and the background-agents table
 *            (ui/pane-agents.ts, fed by ui/pane-agents-model.ts since B7).
 *   editor   header: one chip per open file — its name, an amber dot while it
 *            is unsaved, its own `×` — then the pane's `×`. Body: the ACTIVE
 *            chip's body (ui/file-pane.ts: line numbers, the text, Save; or
 *            the A6 unified diff, read-only). All of it lives in
 *            ui/editor-pane.ts, which this module only drives: `update`,
 *            `focus`, `holdsFocus`, `dispose`.
 *
 * A `×` on an EDITOR pane closes the pane and kills nothing: closing a file —
 * or the pane it sits in — ends no session. Ending one is a SESSION pane's
 * header button (B8), the tab strip's `×` and the Sessions panel, all of
 * which follow `Confirm before ending a session`.
 *
 * The status bar is NOT the 2026-07-26 telemetry strip that was removed: it
 * states only what the app already knows — the session's own argv (model,
 * permission mode), its PTY age, and, since Nocturne B1, what Claude Code
 * reported for it (SessionInfo.telemetry, by way of server/telemetry.ts).
 * Claude Code keeps drawing its OWN status line inside the PTY
 * (ui/statusline-model.ts, server/statusline.mjs), and since B1 both bars read
 * the SAME checklist: with both switches on the same values stand twice, which
 * is the user's accepted consequence rather than something to solve here.
 *
 * Every slot carries a `.pane-drop` overlay that ui/dnd.ts reveals while
 * something is dragged over it. Pane headers are drag sources — an editor
 * header as much as a session header: onto another pane = swap, onto the tab
 * strip = extract (sessions only). A CHIP inside an editor header is its own,
 * smaller drag source (the tab moves, not the pane), and it is armed on a
 * descendant, so it always wins the gesture over the header it sits in.
 *
 * Split by O8 (2026-09-23): what a session pane SHOWS about its session — the
 * header readout, the status bar and agents table, the exited/lost banner with
 * its relaunch, and `killSession` (re-exported here) — lives in
 * `panes-status.ts`. The grid, the slots, the terminals, resize and focus stay
 * here.
 */
import type { SessionInfo } from '../../../shared/protocol.ts';
import * as api from '../api.ts';
import * as st from '../state.ts';
import type { ConnState } from '../ws.ts';
import { TerminalView, type TerminalEvents } from './terminal.ts';
import { el, button } from './util.ts';
import { endSessionButton } from './pane-end.ts';
import { armDrag } from './dnd.ts';
import { editorPane, type EditorPane } from './editor-pane.ts';
import { tabIdOf } from './editor-model.ts';
import { slotTitle } from './slots-model.ts';
import { planCards } from './pane-reuse-model.ts';
import { killSession, updateHeader, updateNote, updateStatus } from './panes-status.ts';

export { killSession } from './panes-status.ts';

/** How often the status bar's `Time` and a running agent's time are refreshed
    (the statusline's rate). */
const STATUS_TICK_MS = 15_000;

/** Everything a SESSION pane owns beyond the shared chrome. */
interface SessionPayload {
  kind: 'session';
  id: string;
  termHost: HTMLElement;
  view: TerminalView | null;
  conn: ConnState | null;
  exitCode: number | null;
  dead: boolean;
  dot: HTMLElement;
  /** Holds the session's tool mark (B12); empty until the session is known. */
  tool: HTMLElement;
  proj: HTMLElement;
  title: HTMLElement;
  state: HTMLElement;
  connChip: HTMLElement;
  extractBtn: HTMLButtonElement;
  statusBar: HTMLElement;
  agentsHost: HTMLElement;
  /** Last rendered status-bar / agents content, so a tick that changed
      nothing does not rebuild the DOM under the user's pointer. */
  statusSig: string;
  agentsSig: string;
}

/**
 * Everything an EDITOR pane owns beyond the shared chrome — which is one
 * object: `ui/editor-pane.ts` owns the chips, the parked bodies and the
 * keyboard inside them. `id` is the slot's own `e:<n>` (= `s.key`), NOT the
 * id of whatever tab is up: a pane whose active tab changed is the same pane.
 */
interface EditorPayload {
  kind: 'editor';
  id: string;
  pane: EditorPane;
}

type Payload = SessionPayload | EditorPayload;

/**
 * One pane: the chrome that survives every content change, plus the payload of
 * whatever it is showing right now. The chrome is what makes an in-place
 * conversion possible — the card stays attached to the grid, so the terminals
 * in the OTHER panes are never touched when this one changes kind.
 */
interface Slot {
  /** Where the card stands now; a relayout moves a card and updates this. */
  index: number;
  /** The `.pane` card; attached to the grid for as long as the layout holds. */
  root: HTMLElement;
  /** The 38px header; its children are per kind, the element itself is not. */
  hd: HTMLElement;
  /** The body on the terminal ground; its children are per kind. */
  body: HTMLElement;
  /** `slotKey()` of what this pane shows, '' while it shows nothing. */
  key: string;
  /** The exited/lost banner. Session-only content, chrome-owned so a
      conversion never reorders the card's children. */
  note: HTMLElement;
  pay: Payload | null;
}

let grid: HTMLElement;
let slots: Slot[] = [];
/** Injected by main.ts (avoids a panes ↔ launch import cycle). */
let openLaunch: () => void = () => {};
/** Rendered view id, or the empty-state sentinel `__empty`. */
let renderedViewId = '';
let renderedCount = -1;
let renderedL3: st.L3 = 'L';
/** The split dividers of the current shape; rebuilt only when the shape changes. */
let dividers: HTMLElement[] = [];
let lastFocusKey = '';
/**
 * The last cols/rows any TerminalView measured for itself. Only read when the
 * focused pane cannot be measured — a hidden grid, or a file in that pane —
 * see `focusedPaneDims()`.
 */
let lastGoodDims: { cols: number; rows: number } | null = null;

// --------------------------------------------------------------------------
// Public API
// --------------------------------------------------------------------------

export function initPanes(gridEl: HTMLElement, openLaunchDialog: () => void): void {
  grid = gridEl;
  openLaunch = openLaunchDialog;
  st.subscribe((kind) => {
    if (kind === 'ui') render();
    else if (kind === 'sessions') {
      // Nothing to reconcile while the grid shows its empty state, whose copy
      // is static (renderEmpty draws two buttons and no count), so this call
      // only MOUNTS it if it is not up yet.
      const v = st.activeView();
      if (v === null || v.slots.length === 0) {
        render();
        return;
      }
      // An editor pane hears nothing from the server: only session panes have
      // a header, a banner and a status bar that a session list can change.
      for (const s of slots) {
        if (s.pay?.kind !== 'session') continue;
        updateHeader(s, s.pay);
        updateNote(s, s.pay);
        updateStatus(s.pay);
      }
    }
  });
  // The status bar's `Time` value ages, and so does a running background
  // agent's (B7); nothing else in a pane ticks. One timer for the whole grid,
  // at the statusline's rate.
  window.setInterval(() => {
    for (const s of slots) {
      if (s.pay?.kind === 'session') updateStatus(s.pay);
    }
  }, STATUS_TICK_MS);
  // Regaining window focus while a pane with attention is focused clears it.
  window.addEventListener('focus', () => {
    // ...unless the panes are not on screen (the commit view covers them):
    // acknowledging then would clear a "Needs you" badge for a terminal the
    // user never saw. The deferred `applyFocus()` that runs when the grid is
    // back acknowledges it honestly, on a pane that is actually visible.
    if (gridHidden()) return;
    const v = st.activeView();
    if (v === null) return;
    const s = slots[v.focused];
    if (s !== undefined) clearAttentionIfPending(s);
  });
  render();
}

/**
 * Is the pane grid hidden right now? Exactly one thing hides it: the commit
 * view covering the pane area (Nocturne A6, main.ts `applyScreenLayout`).
 * `[hidden] { display: none !important }` in app.css makes the flag real, and
 * a `display: none` node is unmeasurable — which is the one state xterm must
 * never be built against.
 */
function gridHidden(): boolean {
  // `hidden` is `boolean | 'until-found'` in the DOM types; anything but a
  // plain false means the node is not being rendered.
  return grid.hidden !== false;
}

/** The focused slot of the active view, if any. */
function focusedSlot(): Slot | undefined {
  const v = st.activeView();
  return v !== null ? slots[v.focused] : undefined;
}

/**
 * Re-render the pane area after it was INVISIBLE (Nocturne A6: the commit view
 * covered it). `render()` is signature-guarded and idempotent, so this is a
 * cheap "you can measure the grid again" nudge — and it is the other half of
 * the guard at the top of `render()`: the render that was refused while the
 * grid was hidden happens here instead, on a node xterm can measure.
 */
export function refreshPaneArea(): void {
  render();
  // The pane the user is now looking at may have raised attention while it
  // was covered; applyFocus() skips an unchanged focus key, so the ack that
  // belongs to "the grid is back on screen" is taken here — only when the
  // window really has the user (otherwise the next activation acks it).
  if (gridHidden() || !document.hasFocus()) return;
  const s = focusedSlot();
  if (s !== undefined) clearAttentionIfPending(s);
}

/**
 * Redraw every visible pane's status bar, for a reason no session notification
 * carries: the Settings checklist changed (Nocturne B1). `st.notify('sessions')`
 * would say something untrue — no session changed — and would re-render the
 * drawer, the tab strip and the statusline for a preference that concerns this
 * bar alone, so the settings page calls this through its injected deps instead
 * (`main.ts`, the same reason `ui/tabs.ts` takes its verbs injected).
 */
export function repaintStatus(): void {
  for (const s of slots) {
    if (s.pay?.kind === 'session') updateStatus(s.pay);
  }
}

/**
 * Hand the keyboard to the focused pane — whatever it is showing. The name is
 * the app's oldest: nine call sites (drawers, dialogs, the commit view, the
 * shortcuts overlay) say "give the keyboard back to the panes", and which kind
 * of pane is focused is this module's business, not theirs.
 */
export function requestTerminalFocus(): void {
  const s = focusedSlot();
  if (s === undefined || s.pay === null) return;
  if (s.pay.kind === 'session') s.pay.view?.focus();
  // An editor pane decides for itself where the keyboard belongs: the text of
  // the active file, or that tab's chip when it is a read-only diff (there is
  // nothing in such a body to type into).
  else s.pay.pane.focus();
}

/**
 * Measured cols/rows of the focused pane (sizes launch + relaunch POSTs).
 *
 * Two states make the focused pane unmeasurable, and 80x24 is the wrong answer
 * to both:
 *
 * - A HIDDEN grid is `display: none` (the commit view covers it), so
 *   `proposeDims()` would fall through to its 80x24 clamp fallback and the new
 *   PTY would write its first screenful wrapped at 80 columns. The attach
 *   reconcile fixes the size afterwards, but never that scrollback.
 * - The focused pane is an EDITOR (A10/A10b). Files have no cols and no rows
 *   at all, and `New session` is reachable from a focused textarea.
 *
 * So: the focused session's own live size, else a SESSION pane of this very
 * tab (it is the size the new pane will get), else the last size any
 * TerminalView reported, and only then the fallback.
 */
export function focusedPaneDims(): { cols: number; rows: number } {
  const s = focusedSlot();
  if (!gridHidden() && s?.pay?.kind === 'session' && s.pay.view !== null) {
    return s.pay.view.proposeDims();
  }
  const id = s?.pay?.kind === 'session' ? s.pay.id : null;
  const info = id === null ? undefined : st.state.sessions.get(id);
  if (info !== undefined && info.status === 'running') return { cols: info.cols, rows: info.rows };
  if (!gridHidden()) {
    // An editor pane is focused: a measurable terminal in the same tab is a
    // better answer than anything remembered.
    for (const other of slots) {
      if (other.pay?.kind === 'session' && other.pay.view !== null) return other.pay.view.proposeDims();
    }
  }
  for (const other of slots) {
    if (other.pay?.kind !== 'session') continue;
    const live = st.state.sessions.get(other.pay.id);
    if (live !== undefined && live.status === 'running') return { cols: live.cols, rows: live.rows };
  }
  return lastGoodDims ?? { cols: 80, rows: 24 };
}

// --------------------------------------------------------------------------
// Rendering / reconciliation
// --------------------------------------------------------------------------

function render(): void {
  // EVERY path below can construct a TerminalView (a rebuild does, and so do a
  // relayout that adds a pane and a reconcile whose slot changed kind or
  // session), and xterm must open on an attached, MEASURABLE node — opening or
  // measuring one on a hidden grid can permanently downgrade the WebGL
  // renderer and leaves the new view at xterm's default 80x24, which
  // `connect()` then sends to a PTY that is not (memory: frontend-terminal-quirks). While the commit view covers the pane
  // area the whole render is therefore refused and the pane area is left
  // exactly as it was; `refreshPaneArea()` replays it the moment the grid is
  // back (main.ts calls it on the same 'screen' notification that unhides it).
  if (gridHidden()) return;
  const v = st.activeView();
  // `Home` is always a view (A10), so `null` is only the moment before
  // `loadUi()` has run. It and an EMPTY tab draw the same thing.
  if (v === null || v.slots.length === 0) {
    renderEmpty(v);
    return;
  }
  const count = v.slots.length;
  // A rebuild disposes and re-attaches every terminal in the tab, so only a
  // TAB switch takes it. Everything inside one tab — a split, a close, an
  // extract, a swap, a file dropped on a terminal — goes through `relayout`,
  // which keeps every pane whose content stayed (Quality P2: a 2→3 split used
  // to replay all three terminals).
  if (v.id !== renderedViewId) rebuild(v, count);
  else relayout(v, count);
  applyFocus();
}

/**
 * Empty state, Nocturne A3 + A10: a centred column of words and two ways
 * forward — "New session" (the launch dialog, same outlined accent as the top
 * bar's) and "Open history" (the sessions drawer, where every earlier session
 * can be picked up). No illustration, no tile.
 *
 * Since A10 an empty pane area means an empty TAB, and that is normally only
 * `Home`: a project folder tab is removed with its last pane and a rootless
 * one dissolves (a folder tab CAN stand empty for one other reason — its
 * sessions were pruned because the server no longer has them). Home says one
 * extra line, because it is where the Files panel's rows land.
 *
 * Two lines the reference has are deliberately absent: the grace countdown
 * ("the background service stops in N seconds") — the backend only counts
 * down once the LAST window closes, so a page that could render it is the
 * very reason it is not running — and a history count on the second button,
 * which would need the drawer's list to be honest about what it opens.
 */
function renderEmpty(v: st.ViewState | null): void {
  const home = v !== null && v.root?.kind === 'home';
  const sig = home ? '__empty-home' : '__empty';
  if (renderedViewId === sig) return;
  for (const s of slots) teardown(s);
  slots = [];
  renderedViewId = sig;
  renderedCount = -1;
  lastFocusKey = '';
  delete grid.dataset.layout;
  delete grid.dataset.l3;

  const box = el('div', 'empty-state');
  const hd = el('div', 'empty-hd', 'No sessions running');
  const sub = el(
    'div',
    'empty-sub',
    'Start a new session, or pick one up from where you left off in the Sessions panel.',
  );
  const row = el('div', 'empty-actions');
  row.append(
    button('btn-accent', 'New session', () => openLaunch()),
    button('btn-quiet', 'Open history', () => st.openDrawer('sessions')),
  );
  box.append(hd, sub, row);
  if (home) {
    box.append(el('div', 'empty-sub', 'A file you open in the Files panel opens here too.'));
  }
  grid.replaceChildren(box);
}

function rebuild(v: st.ViewState, count: number): void {
  for (const s of slots) teardown(s);
  slots = [];
  renderedViewId = v.id;
  lastFocusKey = '';
  grid.replaceChildren();
  applyShape(v, count);
  applySplit(v);
  // The cards go into the grid first; reconcileSlot fills them AFTER that —
  // xterm must open on an attached, measurable node.
  for (let i = 0; i < count; i++) {
    const s = createSlot(i);
    grid.append(s.root);
    slots.push(s);
  }
  buildDividers(v);
  for (let i = 0; i < slots.length; i++) reconcileSlot(i, v.slots[i] ?? null);
}

/**
 * The same tab, drawn again (Quality part P2). Each slot takes a card by the
 * rule in `ui/pane-reuse-model.ts`: the card already showing its content, else
 * the card at its index (converted in place), else a new one. A kept card is
 * MOVED — its terminal, socket and scrollback go with it, so it is never
 * re-attached and the server replays nothing for it — and the grid is in its
 * final shape before anything is measured:
 *
 *   1. cards no slot takes are disposed and leave the grid;
 *   2. the shape attributes and the dividers change (only when the shape did);
 *   3. the cards are put in slot order — grid auto-placement IS the slot map
 *      (app-pane.css), so the order is what places a pane;
 *   4. only then `reconcileSlot` fills a new or converted card, so a NEW
 *      terminal opens on the final layout.
 *
 * A kept terminal whose box changed size is refit by its own ResizeObserver
 * (ui/terminal.ts: debounce → fit → ONE resize over its socket, only when
 * cols/rows really changed). The canvas is moved, not rebuilt: the P2
 * browser check found the WebGL renderer still active after every move.
 */
function relayout(v: st.ViewState, count: number): void {
  const plan = planCards(
    slots.map((s) => s.key),
    v.slots.map((slot) => st.slotKey(slot)),
  );
  const next = plan.map((from, i) => (from === null ? createSlot(i) : (slots[from] as Slot)));
  for (const s of slots) {
    if (next.includes(s)) continue;
    teardown(s);
    s.root.remove();
  }
  slots = next;
  slots.forEach((s, i) => {
    s.index = i;
    s.root.dataset.slot = String(i);
  });
  if (count !== renderedCount || (count === 3 && v.l3 !== renderedL3)) {
    for (const d of dividers) d.remove();
    applyShape(v, count);
    buildDividers(v);
  }
  // Moving a node that holds the keyboard blurs it. The focus key alone does
  // not always change (the pane can keep its index), so a lost focus is
  // re-handed explicitly — to the pane that had it, by applyFocus.
  const had = document.activeElement;
  slots.forEach((s, i) => {
    const at = grid.children[i];
    if (at !== s.root) grid.insertBefore(s.root, at ?? null);
  });
  if (document.activeElement !== had) lastFocusKey = '';
  for (let i = 0; i < slots.length; i++) reconcileSlot(i, v.slots[i] ?? null);
}

/** The grid's split shape: pane count and 3-pane variant, as CSS reads them. */
function applyShape(v: st.ViewState, count: number): void {
  renderedCount = count;
  renderedL3 = v.l3;
  grid.dataset.layout = String(st.viewLayout(v));
  if (count === 3) grid.dataset.l3 = v.l3;
  else delete grid.dataset.l3;
}

// --------------------------------------------------------------------------
// Split dividers (2..4 panes)
// --------------------------------------------------------------------------
//
// The grid templates read --split-col/--split-row; every ratio change goes
// through applySplit and nothing else — the panes resize, each TerminalView's
// ResizeObserver fires, and the existing debounced fit -> ws resize chain
// propagates cols/rows to the PTY.

function applySplit(v: st.ViewState): void {
  grid.style.setProperty('--split-col', String(v.split.col));
  grid.style.setProperty('--split-row', String(v.split.row));
}

/** applySplit for the current active view (divider handlers). */
function applySplitNow(): void {
  const v = st.activeView();
  if (v !== null) applySplit(v);
}

function buildDividers(v: st.ViewState): void {
  const n = v.slots.length;
  dividers = [];
  if (n >= 2) dividers.push(makeDivider('col', v, null));
  // 3 panes: the row divider only spans the stacked column (L = right, R = left).
  if (n >= 3) dividers.push(makeDivider('row', v, n === 3 ? v.l3 : null));
  // After the cards: relayout places card i at grid child i.
  grid.append(...dividers);
}

/**
 * A divider is a grab strip as wide as the gutter, carrying a 1px line that
 * is ALWAYS drawn (neutral-900 at rest) and takes the accent while hovered,
 * focused or dragging — a control that appears only under the pointer is
 * forbidden here (app.css, "split dividers"). Pointer-drag adjusts the
 * fraction (min pane 15%), double-click or Enter resets to equal, arrow
 * keys nudge 2% — keyboard-reachable like every control.
 */
function makeDivider(axis: 'col' | 'row', v: st.ViewState, partialSide: st.L3 | null): HTMLElement {
  const partial =
    partialSide === null ? '' : partialSide === 'L' ? ' is-partial-r' : ' is-partial-l';
  const d = el('div', `divider divider-${axis}${partial}`);
  d.tabIndex = 0;
  d.setAttribute('role', 'separator');
  d.setAttribute('aria-orientation', axis === 'col' ? 'vertical' : 'horizontal');
  d.setAttribute('aria-label', axis === 'col' ? 'column split' : 'row split');
  d.setAttribute('aria-valuemin', String(Math.round(st.SPLIT_MIN * 100)));
  d.setAttribute('aria-valuemax', String(Math.round(st.SPLIT_MAX * 100)));
  d.title = 'Drag to resize. Arrow keys nudge it, double-click or enter resets it.';
  const setNow = (f: number): void => {
    d.setAttribute('aria-valuenow', String(Math.round(f * 100)));
  };
  setNow(v.split[axis]);

  d.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    d.setPointerCapture(e.pointerId);
    d.classList.add('is-dragging');
  });
  d.addEventListener('pointermove', (e) => {
    if (!d.hasPointerCapture(e.pointerId)) return;
    const r = grid.getBoundingClientRect();
    // The grid carries 10px padding and a 10px gap (handoff); the split
    // fraction covers only the usable track space between them.
    const cs = getComputedStyle(grid);
    const pad = parseFloat(cs.paddingLeft) || 0;
    const gap = parseFloat(axis === 'col' ? cs.columnGap : cs.rowGap) || 0;
    const size = axis === 'col' ? r.width : r.height;
    const pos = axis === 'col' ? e.clientX - r.left : e.clientY - r.top;
    const usable = size - 2 * pad - gap;
    const f = usable > 0 ? (pos - pad - gap / 2) / usable : 0.5;
    // Live: style only, no persist/notify — the ResizeObservers do the rest.
    setNow(st.setSplit(axis, f, false));
    applySplitNow();
  });
  const endDrag = (e: PointerEvent): void => {
    if (!d.hasPointerCapture(e.pointerId)) return;
    d.releasePointerCapture(e.pointerId);
    d.classList.remove('is-dragging');
    const cur = st.activeView()?.split[axis] ?? 0.5;
    st.setSplit(axis, cur, true); // Persist + notify.
  };
  d.addEventListener('pointerup', endDrag);
  d.addEventListener('pointercancel', endDrag);
  d.addEventListener('dblclick', () => {
    setNow(st.setSplit(axis, 0.5, true));
    applySplitNow();
  });
  d.addEventListener('keydown', (e) => {
    const cur = st.activeView()?.split[axis] ?? 0.5;
    let f: number | null = null;
    if (axis === 'col' && e.key === 'ArrowLeft') f = cur - 0.02;
    else if (axis === 'col' && e.key === 'ArrowRight') f = cur + 0.02;
    else if (axis === 'row' && e.key === 'ArrowUp') f = cur - 0.02;
    else if (axis === 'row' && e.key === 'ArrowDown') f = cur + 0.02;
    else if (e.key === 'Enter') f = 0.5;
    if (f !== null) {
      e.preventDefault();
      setNow(st.setSplit(axis, f, true));
      applySplitNow();
    }
  });
  return d;
}

/**
 * Bring one pane in line with what the view says it should show — IN PLACE.
 *
 * The card, its header element and its body element survive; only their
 * contents change. That is the whole point: a rebuild would dispose every
 * TerminalView in the tab and attach them all again, so swapping a file with
 * the terminal beside it would cost the untouched sessions an attach and a
 * full replay (verify-terminal check 8).
 *
 * ORDER, for a session leaving a pane: `dispose()` FIRST, then empty the
 * mount. Emptying the host under a live TerminalView leaves xterm's observer
 * and renderer attached to nodes that are no longer in the document.
 */
function reconcileSlot(index: number, slot: st.PaneSlot | null): void {
  const s = slots[index];
  if (s === undefined) return;
  const key = slot === null ? '' : st.slotKey(slot);
  if (key === s.key && s.pay !== null) {
    // Same content: refresh what the world may have changed under it.
    if (s.pay.kind === 'session') {
      updateHeader(s, s.pay);
      updateNote(s, s.pay);
      updateStatus(s.pay);
    } else if (s.pay.kind === 'editor' && slot !== null && slot.kind === 'editor') {
      // THE BRANCH THAT MAKES A TAB CHEAP. Adding, closing or raising a tab
      // leaves the pane's key untouched (it is the slot's own `e:<n>`), so the
      // strip and the body change and nothing else in the tab is disturbed —
      // no teardown, no caret lost, no terminal re-attached beside it.
      s.pay.pane.update(slot, renderedViewId, index);
    }
    return;
  }
  teardown(s);
  s.key = key;
  if (slot === null) return;
  if (slot.kind === 'session') buildSessionPane(s, slot.id);
  else buildEditorPane(s, slot, index);
}

/** Give up whatever this pane was showing. The card itself stays. */
function teardown(s: Slot): void {
  const pay = s.pay;
  s.pay = null;
  s.key = '';
  s.note.hidden = true;
  s.root.classList.remove('is-editor');
  if (pay === null) return;
  if (pay.kind === 'session') {
    // Dispose BEFORE emptying the mount: the view's observer and renderer are
    // attached to the nodes below it.
    pay.view?.dispose();
    pay.termHost.replaceChildren();
  } else {
    // Same order, same reason: the parked bodies go before the header and the
    // body they were built in, or a pane converted back to an editor would
    // resurrect textareas state.ts has already dropped.
    pay.pane.dispose();
  }
  s.hd.replaceChildren();
  s.body.replaceChildren();
}

// --------------------------------------------------------------------------
// The two pane kinds
// --------------------------------------------------------------------------

function buildSessionPane(s: Slot, sessionId: string): void {
  // A3 header (38px): dot, tool mark (B12), session name, project NAME,
  // spacer, state pill, (conn chip while degraded), "Own tab" when the tab holds more than one
  // pane, then End session — on EVERY session pane, a one-pane tab included
  // (B8, user's decision 2026-09-22). A3 kept ending off the header because
  // it would have been a one-click kill on every pane; since B6 it is not:
  // the button asks `Confirm before ending a session` at click time, exactly
  // like the tab × and the sessions drawer (arm first when on, one click when
  // the user turned the question off). The whole header is the drag source,
  // buttons excepted (createSlot's armDrag) — keyboard twins:
  // ctrl+alt+shift+arrows (swap) and the "Own tab" button (extract).
  const dot = el('span', 'dot pane-dot');
  dot.setAttribute('aria-hidden', 'true');
  const tool = el('span', 'pane-tool');
  tool.setAttribute('aria-hidden', 'true');
  const title = el('span', 'pane-title');
  const proj = el('span', 'pane-proj');
  const state = el('span', 'pane-state');
  const connChip = el('span', 'pane-conn');
  connChip.hidden = true;
  const extractBtn = button('pane-pop', 'Own tab');
  extractBtn.title = 'Move to its own tab';
  const endBtn = endSessionButton(() => void killSession(sessionId));
  s.hd.replaceChildren(dot, tool, title, proj, el('span', 'pane-gap'), state, connChip, extractBtn, endBtn);
  s.hd.title = 'Drag onto a pane to swap them, or onto the tab strip to give it its own tab.';

  // The terminal card: the xterm mount fills it, the status bar and the
  // agents table sit under it on the same terminal ground.
  const termWrap = el('div', 'pane-termwrap');
  const termHost = el('div', 'term-host');
  termWrap.append(termHost);
  const statusBar = el('div', 'pane-status');
  statusBar.hidden = true;
  const agentsHost = el('div', 'pane-agents-host');
  s.body.replaceChildren(termWrap, statusBar, agentsHost);

  const pay: SessionPayload = {
    kind: 'session',
    id: sessionId,
    termHost,
    view: null,
    conn: null,
    exitCode: null,
    dead: false,
    dot,
    tool,
    proj,
    title,
    state,
    connChip,
    extractBtn,
    statusBar,
    agentsHost,
    // A sentinel no signature can equal, so the FIRST update always renders.
    statusSig: '\u0000',
    agentsSig: '\u0000',
  };
  s.pay = pay;

  extractBtn.addEventListener('click', () => st.extractSession(sessionId));

  // The mount is attached (rebuild and relayout put the card in the grid first),
  // so xterm can measure itself.
  pay.view = new TerminalView(termHost);
  pay.view.connect(sessionId, slotEvents(s, pay, sessionId));

  updateHeader(s, pay);
  updateNote(s, pay);
  updateStatus(pay);
}

/**
 * An EDITOR pane: the header becomes a file-tab strip and the body shows the
 * active tab. Everything inside both belongs to `ui/editor-pane.ts`; this
 * module hands it the two elements that survive a conversion and then only
 * tells it what the model says.
 *
 * The header `title` is the PANE's drag, not the strip's: a chip carries its
 * own (ui/editor-pane.ts) and says so on itself.
 */
function buildEditorPane(s: Slot, slot: st.EditorSlot, index: number): void {
  // The card says what kind it is, so CSS can keep the editor's body off the
  // THEMED terminal ground (open decision 10c): an editor pane with no drawable
  // tab leaves .pane-body bare, and .pane-body is painted var(--term-bg).
  // teardown() takes the class off again, in step with the payload.
  s.root.classList.add('is-editor');
  const pane = editorPane(s.hd, s.body);
  s.hd.title = 'Drag onto a pane to swap them. Drag one file tab to move just that file.';
  s.pay = { kind: 'editor', id: slot.id, pane };
  pane.update(slot, renderedViewId, index);
}

function slotEvents(s: Slot, pay: SessionPayload, sessionId: string): TerminalEvents {
  return {
    onInfo: (info: SessionInfo) => {
      st.upsertSession(info);
      // Attention may predate the attach (BEL while the session had no view
      // on screen): the FOCUSED pane acks it the moment it learns of it —
      // applyFocus ran before this frame arrived and could not know.
      // A focused pane under the commit view is not ON SCREEN: the badge
      // must survive until the grid is back (the deferred applyFocus acks it).
      // BEL only: a turn that ended (`turnEnded`, Nocturne C1) is NOT acked
      // by a look — its mascot stays until the session works again or ends
      // (user, 2026-09-22, overriding decision 14).
      const v = st.activeView();
      if (
        info.attention &&
        v !== null &&
        v.id === renderedViewId &&
        v.focused === s.index &&
        document.hasFocus() &&
        !gridHidden()
      ) {
        clearAttentionIfPending(s);
      }
    },
    onExit: (exitCode) => {
      pay.exitCode = exitCode;
      st.markExited(sessionId, exitCode);
      updateNote(s, pay);
      updateStatus(pay);
    },
    onAttention: () => {
      const v = st.activeView();
      if (
        v !== null &&
        v.id === renderedViewId &&
        v.focused === s.index &&
        document.hasFocus() &&
        !gridHidden()
      ) {
        // Attention arrived on the focused, VISIBLE pane: acknowledge at once.
        ackSeen(pay, sessionId);
      } else {
        st.setAttention(sessionId, true);
      }
    },
    onConn: (conn) => {
      pay.conn = conn;
      if (conn === 'dead') pay.dead = true;
      updateHeader(s, pay);
      updateNote(s, pay);
      st.notify('conn');
    },
    onDims: (cols, rows) => {
      lastGoodDims = { cols, rows };
      st.setSessionDims(sessionId, cols, rows);
    },
  };
}

function applyFocus(): void {
  const v = st.activeView();
  if (v === null) return;
  for (const s of slots) s.root.classList.toggle('focused', s.index === v.focused);
  const s = slots[v.focused];
  // The KEY is part of the focus identity: a pane whose content was replaced
  // (a file dropped on a terminal, a swap) has to take the keyboard again,
  // even though the tab and the slot index did not move. Since A10b it also
  // carries the ACTIVE TAB id — raising another file is a content change and
  // must re-hand the keyboard, while a KEYSTROKE (which notifies 'ui' on the
  // dirty flip) must not.
  const model = v.slots[v.focused];
  const active = model === undefined ? null : st.activeTabOf(model);
  const key = `${v.id}:${v.focused}:${s?.key ?? ''}:${active === null ? '' : tabIdOf(active)}`;
  if (key === lastFocusKey) return;
  lastFocusKey = key;
  if (s === undefined) return;
  // The keyboard is ALREADY inside this pane's tab strip (the user clicked a
  // chip, or arrowed across them): moving it into the textarea would take the
  // strip away mid-gesture.
  const holds = s.pay?.kind === 'editor' && s.pay.pane.holdsFocus();
  if (s.pay === null) s.root.focus();
  else if (!holds) requestTerminalFocus();
  clearAttentionIfPending(s);
}

/**
 * The user is looking at this pane: ack its BEL (`attention`). Only a BEL is
 * acked by a look. A turn that ended (`turnEnded`, what the peek mascot also
 * counts, Nocturne C1) is not: its mascot stays until the session works again
 * or ends (user, 2026-09-22), so it never sends a `seen` on its own.
 */
function clearAttentionIfPending(s: Slot): void {
  if (s.pay?.kind !== 'session') return;
  const info = st.state.sessions.get(s.pay.id);
  if (info !== undefined && info.attention) ackSeen(s.pay, s.pay.id);
}

function ackSeen(pay: SessionPayload, sessionId: string): void {
  // Both channels per spec; both are idempotent server-side.
  pay.view?.sendSeen();
  void api.markSeen(sessionId).catch(() => {});
  st.markSeenLocally(sessionId);
}

// --------------------------------------------------------------------------
// Slot DOM
// --------------------------------------------------------------------------

/** Drop-zone overlay revealed by ui/dnd.ts while a drag hovers this pane. */
function buildDropOverlay(): HTMLElement {
  const drop = el('div', 'pane-drop');
  drop.hidden = true;
  const box = el('div', 'pane-drop-box');
  box.append(el('span', 'pane-drop-lb'));
  drop.append(box);
  return drop;
}

/**
 * The chrome of one pane, empty: the card, the header, the banner, the body
 * and the drop overlay. The CALLER puts it in the grid; what it SHOWS arrives
 * through `reconcileSlot` after that, so the card is attached by the time a
 * TerminalView is built on it (xterm must open on an attached, measurable
 * node). Its handlers read `slot.index`, never a captured index: a relayout
 * moves the card (Quality P2).
 */
function createSlot(index: number): Slot {
  const root = el('section', 'pane');
  root.tabIndex = -1;
  root.dataset.slot = String(index);
  const hd = el('header', 'pane-hd');
  const note = el('div', 'pane-note');
  note.hidden = true;
  const body = el('div', 'pane-body');
  root.append(hd, note, body, el('div', 'pane-foot'), buildDropOverlay());

  const slot: Slot = { index, root, hd, body, key: '', note, pay: null };
  root.addEventListener('mousedown', () => st.focusPane(slot.index), true);

  // Header drag: onto another pane = swap; onto the tab strip = extract (an
  // editor pane has no own tab to be extracted into — ui/dnd.ts answers null
  // for it). Armed ONCE, on the header element that survives every conversion,
  // and it IGNORES buttons: every control an editor header puts in the strip
  // is one, so the pane drag never fires on a chip, and the chip's own
  // `armDrag` (a descendant, therefore first) wins the rest of the gesture.
  armDrag(hd, 'button', () => {
    if (slot.pay === null) return null;
    // The name comes from the MODEL, so an editor pane is called after the tab
    // it is showing right now (`slotTitle`) without this module knowing what a
    // tab is.
    const live = st.activeView()?.slots[slot.index];
    if (live === undefined) return null;
    const label = slotTitle(live, live.kind === 'session' ? st.state.sessions.get(live.id)?.title : undefined);
    return {
      kind: 'pane',
      viewId: renderedViewId,
      slot: slot.index,
      slotKey: slot.key,
      label,
    };
  });

  return slot;
}

// Read by panes-status.ts (O8 split glue): live bindings, read at call time only.
export { renderedViewId, renderedCount, type SessionPayload, type Slot };
