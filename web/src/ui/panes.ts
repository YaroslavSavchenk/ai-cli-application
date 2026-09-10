/**
 * Pane grid for the ACTIVE view (= tab). A view holds 1..4 sessions in a
 * fixed split shape (see state.ts for the slot maps). Sessions exist
 * independently of views — this module only attaches/detaches xterm views.
 * Zero views renders the centered empty state; new sessions come from the
 * launch dialog (ui/launch.ts).
 *
 * Terminals exist only for the active view's slots; switching tabs or
 * changing the split shape disposes and re-attaches (the server replays the
 * full buffer).
 *
 * A pane (Nocturne part A3) is a neutral-900 card holding, top to bottom: a
 * 38px header (state dot, session name, project NAME, state pill, "Own tab"
 * in a split), the exited/lost banner when there is one, and the terminal
 * card — the xterm mount on the terminal ground, with a thin status bar
 * under it (label + mono value pairs, ui/pane-status-model.ts) and the
 * background-agents table (ui/pane-agents.ts, empty in A3) below that.
 *
 * The status bar is NOT the 2026-07-26 telemetry strip that was removed: it
 * states only what the app already knows (argv model, argv permission mode,
 * PTY age). Claude Code keeps drawing its OWN status line inside the PTY
 * (ui/statusline-model.ts, server/statusline.mjs); the two do not compete —
 * one is the app's view of the session, the other is the session's view of
 * itself.
 *
 * Every slot carries a `.pane-drop` overlay that ui/dnd.ts reveals while a
 * tab is dragged over it (drag-to-split). Pane headers are drag sources:
 * onto another pane = swap, onto the tab strip = extract to its own tab.
 */
import type { CreateSessionRequest, SessionInfo } from '../../../shared/protocol.ts';
import * as api from '../api.ts';
import * as st from '../state.ts';
import { log } from '../log.ts';
import type { ConnState } from '../ws.ts';
import { TerminalView, type TerminalEvents } from './terminal.ts';
import { el, button, armButton } from './util.ts';
import { armDrag } from './dnd.ts';
import { scheduleHistoryRefresh } from './history.ts';
import { flash } from './statusline.ts';
import { paneStatusItems } from './pane-status-model.ts';
import { renderAgents, type AgentRow } from './pane-agents.ts';

/** How often the status bar's `Time` value is refreshed (the statusline's rate). */
const STATUS_TICK_MS = 15_000;

interface Slot {
  index: number;
  root: HTMLElement;
  termHost: HTMLElement;
  view: TerminalView | null;
  sessionId: string | null;
  conn: ConnState | null;
  exitCode: number | null;
  dead: boolean;
  dot: HTMLElement;
  proj: HTMLElement;
  title: HTMLElement;
  state: HTMLElement;
  connChip: HTMLElement;
  extractBtn: HTMLButtonElement;
  note: HTMLElement;
  statusBar: HTMLElement;
  agentsHost: HTMLElement;
  /** Last rendered status-bar / agents content, so a tick that changed
      nothing does not rebuild the DOM under the user's pointer. */
  statusSig: string;
  agentsSig: string;
}

let grid: HTMLElement;
let slots: Slot[] = [];
/** Injected by main.ts (avoids a panes ↔ launch import cycle). */
let openLaunch: () => void = () => {};
/** Rendered view id, or the empty-state sentinel `__empty`. */
let renderedViewId = '';
let renderedCount = -1;
let renderedL3: st.L3 = 'L';
let lastFocusKey = '';

// --------------------------------------------------------------------------
// Public API
// --------------------------------------------------------------------------

export function initPanes(gridEl: HTMLElement, openLaunchDialog: () => void): void {
  grid = gridEl;
  openLaunch = openLaunchDialog;
  st.subscribe((kind) => {
    if (kind === 'ui') render();
    else if (kind === 'sessions') {
      // No panes to reconcile without an active view: the grid is showing the
      // empty state, whose copy is static (renderEmpty draws two buttons and
      // no count), so this call only MOUNTS it if it is not up yet.
      if (st.activeView() === null) {
        render();
        return;
      }
      for (const s of slots) {
        updateHeader(s);
        updateNote(s);
        updateStatus(s);
      }
    }
  });
  // The status bar's `Time` value ages; nothing else in a pane ticks. One
  // timer for the whole grid, at the statusline's rate.
  window.setInterval(() => {
    for (const s of slots) updateStatus(s);
  }, STATUS_TICK_MS);
  // Regaining window focus while a pane with attention is focused clears it.
  window.addEventListener('focus', () => {
    const v = st.activeView();
    if (v === null) return;
    const s = slots[v.focused];
    if (s !== undefined) clearAttentionIfPending(s);
  });
  render();
}

/** The focused slot of the active view, if any. */
function focusedSlot(): Slot | undefined {
  const v = st.activeView();
  return v !== null ? slots[v.focused] : undefined;
}

/** Focus the terminal of the focused slot (used after drawer/tab focus moves). */
export function requestTerminalFocus(): void {
  const s = focusedSlot();
  if (s !== undefined && s.view !== null && s.sessionId !== null) s.view.focus();
}

/** Measured cols/rows of the focused pane (sizes launch + relaunch POSTs). */
export function focusedPaneDims(): { cols: number; rows: number } {
  const s = focusedSlot();
  return s !== undefined && s.view !== null ? s.view.proposeDims() : { cols: 80, rows: 24 };
}

// --------------------------------------------------------------------------
// Rendering / reconciliation
// --------------------------------------------------------------------------

function render(): void {
  const v = st.activeView();
  if (v === null) {
    renderEmpty();
    return;
  }
  const count = v.sessions.length;
  if (v.id !== renderedViewId || count !== renderedCount || (count === 3 && v.l3 !== renderedL3)) {
    rebuild(v, count);
  } else {
    for (let i = 0; i < slots.length; i++) reconcileSlot(i, v.sessions[i] ?? null);
  }
  applyFocus();
}

/**
 * Empty state (zero views ⇔ zero sessions), Nocturne A3: a centred column of
 * words and two ways forward — "New session" (the launch dialog, same
 * outlined accent as the top bar's) and "Open history" (the sessions drawer,
 * where every earlier session can be picked up). No illustration, no tile.
 *
 * Two lines the reference has are deliberately absent: the grace countdown
 * ("the background service stops in N seconds") — the backend only counts
 * down once the LAST window closes, so a page that could render it is the
 * very reason it is not running — and a history count on the second button,
 * which would need the drawer's list to be honest about what it opens.
 */
function renderEmpty(): void {
  const sig = '__empty';
  if (renderedViewId === sig) return;
  for (const s of slots) s.view?.dispose();
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
  grid.replaceChildren(box);
}

function rebuild(v: st.ViewState, count: number): void {
  for (const s of slots) s.view?.dispose();
  slots = [];
  renderedViewId = v.id;
  renderedCount = count;
  renderedL3 = v.l3;
  lastFocusKey = '';
  grid.dataset.layout = String(st.viewLayout(v));
  if (count === 3) grid.dataset.l3 = v.l3;
  else delete grid.dataset.l3;
  grid.replaceChildren();
  applySplit(v);
  // createSessionSlot appends its root to the grid BEFORE constructing the
  // TerminalView — xterm must open on an attached, measurable node.
  for (let i = 0; i < count; i++) slots.push(createSessionSlot(i));
  buildDividers(v);
  for (let i = 0; i < slots.length; i++) reconcileSlot(i, v.sessions[i] ?? null);
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
  const n = v.sessions.length;
  if (n >= 2) grid.append(makeDivider('col', v, null));
  // 3 panes: the row divider only spans the stacked column (L = right, R = left).
  if (n >= 3) grid.append(makeDivider('row', v, n === 3 ? v.l3 : null));
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

function reconcileSlot(index: number, sessionId: string | null): void {
  const s = slots[index];
  if (s === undefined) return;
  if (s.sessionId === sessionId) {
    updateHeader(s);
    updateNote(s);
    updateStatus(s);
    return;
  }
  s.sessionId = sessionId;
  s.conn = null;
  s.exitCode = null;
  s.dead = false;
  if (sessionId !== null) {
    // Reuse a never-connected terminal (it measured this very container);
    // otherwise start clean.
    if (s.view === null || s.view.connected) {
      s.view?.dispose();
      s.termHost.replaceChildren();
      s.view = new TerminalView(s.termHost);
    }
    s.view.connect(sessionId, slotEvents(s, sessionId));
  }
  updateHeader(s);
  updateNote(s);
  updateStatus(s);
}

function slotEvents(s: Slot, sessionId: string): TerminalEvents {
  return {
    onInfo: (info: SessionInfo) => {
      st.upsertSession(info);
      // Attention may predate the attach (BEL while the session had no view
      // on screen): the FOCUSED pane acks it the moment it learns of it —
      // applyFocus ran before this frame arrived and could not know.
      const v = st.activeView();
      if (
        info.attention &&
        v !== null &&
        v.id === renderedViewId &&
        v.focused === s.index &&
        document.hasFocus()
      ) {
        clearAttentionIfPending(s);
      }
    },
    onExit: (exitCode) => {
      s.exitCode = exitCode;
      st.markExited(sessionId, exitCode);
      updateNote(s);
      updateStatus(s);
    },
    onAttention: () => {
      const v = st.activeView();
      if (v !== null && v.id === renderedViewId && v.focused === s.index && document.hasFocus()) {
        // Attention arrived on the focused pane: acknowledge immediately.
        ackSeen(s, sessionId);
      } else {
        st.setAttention(sessionId, true);
      }
    },
    onConn: (conn) => {
      s.conn = conn;
      if (conn === 'dead') s.dead = true;
      updateHeader(s);
      updateNote(s);
      st.notify('conn');
    },
    onDims: (cols, rows) => st.setSessionDims(sessionId, cols, rows),
  };
}

function applyFocus(): void {
  const v = st.activeView();
  if (v === null) return;
  for (const s of slots) s.root.classList.toggle('focused', s.index === v.focused);
  const key = `${v.id}:${v.focused}`;
  if (key === lastFocusKey) return;
  lastFocusKey = key;
  const s = slots[v.focused];
  if (s === undefined) return;
  if (s.view !== null && s.sessionId !== null) s.view.focus();
  else s.root.focus();
  clearAttentionIfPending(s);
}

function clearAttentionIfPending(s: Slot): void {
  if (s.sessionId === null) return;
  const info = st.state.sessions.get(s.sessionId);
  if (info !== undefined && info.attention) ackSeen(s, s.sessionId);
}

function ackSeen(s: Slot, sessionId: string): void {
  // Both channels per spec; both are idempotent server-side.
  s.view?.sendSeen();
  void api.markSeen(sessionId).catch(() => {});
  st.setAttention(sessionId, false);
}

// --------------------------------------------------------------------------
// Slot DOM
// --------------------------------------------------------------------------

/** Drop-zone overlay revealed by ui/dnd.ts while a tab is dragged over the pane. */
function buildDropOverlay(): HTMLElement {
  const drop = el('div', 'pane-drop');
  drop.hidden = true;
  const box = el('div', 'pane-drop-box');
  box.append(el('span', 'pane-drop-lb'));
  drop.append(box);
  return drop;
}

function createSessionSlot(index: number): Slot {
  const root = el('section', 'pane');
  root.tabIndex = -1;
  root.dataset.slot = String(index);

  // A3 header (38px): dot, session name, project NAME, spacer, state pill,
  // (conn chip while degraded), "Own tab" when the tab holds more than one
  // pane. Ending a session is NOT here — it lives on the tab × and in the
  // sessions drawer, both of which confirm; a one-click kill on every pane
  // header would be the only destructive control on this surface. The whole
  // header is the drag source — keyboard twins: ctrl+alt+shift+arrows (swap)
  // and the "Own tab" button (extract).
  const hd = el('header', 'pane-hd');
  const dot = el('span', 'dot pane-dot');
  dot.setAttribute('aria-hidden', 'true');
  const title = el('span', 'pane-title');
  const proj = el('span', 'pane-proj');
  const gap = el('span', 'pane-gap');
  const state = el('span', 'pane-state');
  const connChip = el('span', 'pane-conn');
  connChip.hidden = true;
  const extractBtn = button('pane-pop', 'Own tab');
  extractBtn.title = 'Move to its own tab';
  hd.append(dot, title, proj, gap, state, connChip, extractBtn);
  hd.title = 'Drag onto a pane to swap them, or onto the tab strip to give it its own tab.';

  const note = el('div', 'pane-note');
  note.hidden = true;

  // The terminal card: the xterm mount fills it, the status bar and the
  // agents table sit under it on the same terminal ground, and the rounded
  // corners are the card's own (overflow hidden).
  const body = el('div', 'pane-body');
  const termWrap = el('div', 'pane-termwrap');
  const termHost = el('div', 'term-host');
  termWrap.append(termHost);
  const statusBar = el('div', 'pane-status');
  statusBar.hidden = true;
  const agentsHost = el('div', 'pane-agents-host');
  body.append(termWrap, statusBar, agentsHost);

  root.append(hd, note, body, el('div', 'pane-foot'), buildDropOverlay());
  root.addEventListener('mousedown', () => st.focusPane(index), true);
  grid.append(root); // Attach before TerminalView so xterm opens on a live node.

  const slot: Slot = {
    index,
    root,
    termHost,
    view: new TerminalView(termHost),
    sessionId: null,
    conn: null,
    exitCode: null,
    dead: false,
    dot,
    proj,
    title,
    state,
    connChip,
    extractBtn,
    note,
    statusBar,
    agentsHost,
    // A sentinel no signature can equal, so the FIRST update always renders.
    statusSig: '\u0000',
    agentsSig: '\u0000',
  };

  extractBtn.addEventListener('click', () => {
    if (slot.sessionId !== null) st.extractSession(slot.sessionId);
  });

  // Header drag: onto another pane = swap; onto the tab strip = extract.
  armDrag(hd, 'button', () => {
    if (slot.sessionId === null) return null;
    const info = st.state.sessions.get(slot.sessionId);
    return {
      kind: 'pane',
      viewId: renderedViewId,
      slot: index,
      sessionId: slot.sessionId,
      label: info?.title ?? '…',
    };
  });

  return slot;
}

/** DELETE a session; its view slot closes everywhere (drawer + tab close reuse this). */
export async function killSession(id: string): Promise<void> {
  log.info(`kill session ${id}`);
  try {
    await api.deleteSession(id);
    st.removeSessionEverywhere(id);
  } catch (err) {
    if (err instanceof api.ApiError && err.status === 404) {
      log.info(`kill session ${id}: already gone server-side`);
      st.removeSessionEverywhere(id);
      return;
    }
    log.warn(`kill failed: session=${id} ${err instanceof Error ? err.message : String(err)}`);
    flash(`Could not end it: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function updateHeader(s: Slot): void {
  if (s.sessionId === null) return;
  const info = st.state.sessions.get(s.sessionId);
  // Projects are named, never pathed (PROJECT-SCOPE); a session without one
  // shows nothing at all rather than a folder.
  const pname = st.projectName(info?.projectId);
  s.proj.textContent = pname ?? '';
  s.title.textContent = info?.title ?? s.sessionId.slice(0, 8);
  const attention = info !== undefined && info.attention;
  const running = info === undefined || info.status === 'running';
  // Dot and pill are one readout: green Working, pulsing amber Needs your
  // answer, neutral Finished. The exit code rides in the pill's title (and
  // on the banner) — a code is not a state word.
  s.dot.className = `dot pane-dot ${attention ? 'is-attn' : running ? 'is-run' : 'is-exit'}`;
  const stateText = attention ? 'Needs your answer' : running ? 'Working' : 'Finished';
  s.state.textContent = stateText;
  s.state.className = `pane-state ${attention ? 'is-attn' : running ? 'is-run' : 'is-exit'}`;
  const code = info?.exitCode ?? s.exitCode;
  s.state.title = !running && code !== null && code !== undefined ? `Finished, code ${code}` : stateText;
  if (s.conn === null || s.conn === 'live') {
    s.connChip.hidden = true;
  } else {
    s.connChip.hidden = false;
    s.connChip.textContent = s.conn === 'dead' ? 'Lost' : 'Reconnecting';
    s.connChip.className = `pane-conn ${s.conn === 'dead' ? 'is-danger' : 'is-warn'}`;
  }
  // Alone in its view, a session already IS its own tab.
  s.extractBtn.hidden = renderedCount <= 1;
}

/**
 * The status bar under the terminal, plus the (A3: always empty) background
 * agents table. Both are absent — not blank — when there is nothing honest to
 * put in them: `paneStatusItems` returns [] for anything but the known agent,
 * so a plain shell's pane is terminal edge to terminal edge.
 */
function updateStatus(s: Slot): void {
  const info = s.sessionId !== null ? st.state.sessions.get(s.sessionId) : undefined;
  const items = paneStatusItems(info, Date.now());
  // The 15 s tick calls this for every slot; most ticks change nothing (Time
  // moves once a minute at most). Rebuilding then would throw away live DOM
  // — a text selection inside the bar, the row the pointer is over — for no
  // pixel change, so the rendered content is compared first.
  const statusSig = items.map((i) => `${i.k}=${i.v}:${i.tone}`).join('\n');
  if (statusSig !== s.statusSig) {
    s.statusSig = statusSig;
    s.statusBar.hidden = items.length === 0;
    s.statusBar.replaceChildren(
      ...items.map((it) => {
        const cell = el('span', 'pane-status-item');
        cell.append(
          el('span', 'pane-status-k', it.k),
          el('span', `pane-status-v${it.tone === 'danger' ? ' is-danger' : ''}`, it.v),
        );
        return cell;
      }),
    );
  }
  // Part B7 decides where background agents come from (open decision #7);
  // until then the list is empty and the table renders as nothing at all —
  // which is exactly once, by the same signature rule.
  const rows: AgentRow[] = [];
  const agentsSig = rows.map((r) => JSON.stringify(r)).join('\n');
  if (agentsSig !== s.agentsSig) {
    s.agentsSig = agentsSig;
    const table = renderAgents(rows);
    s.agentsHost.replaceChildren(...(table === null ? [] : [table]));
  }
}

function updateNote(s: Slot): void {
  if (s.sessionId === null) {
    s.note.hidden = true;
    return;
  }
  if (s.dead) {
    // Reconnect exhausted and the server does not know the session anymore.
    s.note.hidden = false;
    s.note.className = 'pane-note is-dead';
    s.note.replaceChildren(
      el('span', 'pane-note-text', 'This session is gone from the server'),
      button('pane-note-btn', 'Close pane', () => {
        if (s.sessionId !== null) st.removeSessionEverywhere(s.sessionId);
      }),
    );
    return;
  }
  if (s.exitCode !== null) {
    // Structural exited banner; the buffer below stays readable.
    s.note.hidden = false;
    s.note.className = `pane-note ${s.exitCode === 0 ? 'is-exit' : 'is-exit-err'}`;
    const relaunchBtn = button('pane-note-btn is-primary', 'Start it again', () => void relaunch(s));
    const delBtn = button('pane-note-btn', 'End session');
    armButton(delBtn, 'Sure?', () => {
      if (s.sessionId !== null) void killSession(s.sessionId);
    });
    s.note.replaceChildren(
      el('span', 'pane-note-text', `Finished, code ${s.exitCode}`),
      relaunchBtn,
      delBtn,
    );
    return;
  }
  s.note.hidden = true;
}

/**
 * Exited-banner relaunch: bring this pane's session back, swap it into this
 * slot, then DELETE the exited one. The attach flow reconciles the PTY size
 * with the pane's actual dimensions, so stale cols/rows self-correct.
 *
 * When the session history still holds THIS session's entry, relaunch goes
 * through /api/history/:id/resume so a claude session continues its own
 * conversation instead of starting an empty one (the server composes the
 * argv). Without an entry — a backend without history, or one already
 * forgotten — it falls back to reposting the same command.
 *
 * The lookup reads a FRESH /api/history rather than `state.history`: the cached
 * list is filled by a 300 ms-debounced refetch, so a click inside that window
 * would find no entry, fall back to the create path, and silently FORK the
 * conversation onto a new pinned id. A failing fetch keeps today's behaviour.
 */
async function relaunch(s: Slot): Promise<void> {
  const oldId = s.sessionId;
  if (oldId === null) return;
  const info = st.state.sessions.get(oldId);
  if (info === undefined) return;
  const viewId = renderedViewId; // Captured: the user may switch tabs mid-await.
  const index = s.index;
  let history = st.state.history;
  try {
    history = await api.getHistory();
    st.setHistory(history); // Publish it, so the drawer agrees with this click.
  } catch {
    // Unreachable/absent history routes: fall back to the cached list.
  }
  const entry = history.find((h) => h.sessionId === oldId);
  const req: CreateSessionRequest = {
    ...(info.projectId !== undefined ? { projectId: info.projectId } : {}),
    cwd: info.cwd, // Explicit, so relaunch survives a deleted project.
    command: info.command,
    args: info.args,
    title: info.title,
    cols: info.cols,
    rows: info.rows,
  };
  try {
    const created =
      entry !== undefined
        ? await api.resumeHistory(entry.id, { cols: info.cols, rows: info.rows })
        : await api.createSession(req);
    log.info(
      `relaunch ok: old=${oldId} new=${created.id} via=${entry !== undefined ? 'history entry ' + entry.id : 'fresh session'}`,
    );
    st.upsertSession(created);
    st.replaceSessionInView(viewId, index, created.id);
    if (st.state.activeViewId === viewId) {
      st.focusPane(index);
      requestTerminalFocus();
    }
  } catch (err) {
    log.warn(`relaunch failed: old=${oldId} ${err instanceof Error ? err.message : String(err)}`);
    flash(`Could not start it again: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  scheduleHistoryRefresh(); // the entry is live again — it leaves the ended list
  // The new session is live; losing the DELETE only leaves the exited one
  // listed in the drawer (its kill button still works).
  try {
    await api.deleteSession(oldId);
    st.removeSessionEverywhere(oldId);
  } catch (err) {
    if (err instanceof api.ApiError && err.status === 404) st.removeSessionEverywhere(oldId);
  }
}

