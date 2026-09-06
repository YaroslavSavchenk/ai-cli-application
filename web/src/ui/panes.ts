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
 * A pane is HEADER + terminal, nothing else: the app-rendered telemetry strip
 * that used to sit under the terminal was removed 2026-07-26 in favour of
 * Claude Code's own status line, which the session draws inside the PTY (see
 * ui/statusline-model.ts and server/statusline.mjs).
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
import { el, button, armButton, modelFromArgs, permFromArgs } from './util.ts';
import { armDrag } from './dnd.ts';
import { scheduleHistoryRefresh } from './history.ts';
import { flash } from './statusline.ts';

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
  tagModel: HTMLElement;
  tagPerm: HTMLElement;
  connChip: HTMLElement;
  extractBtn: HTMLButtonElement;
  note: HTMLElement;
}

let grid: HTMLElement;
let slots: Slot[] = [];
/** Injected by main.ts (avoids a panes ↔ launch import cycle). */
let openLaunch: () => void = () => {};
/** Rendered view id, or the empty-state sentinel `__empty:<prevCount>`. */
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
      // The empty state depends on the history count; re-render it.
      if (st.activeView() === null) {
        render();
        return;
      }
      for (const s of slots) {
        updateHeader(s);
        updateNote(s);
      }
    }
  });
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

/** Connection state of the focused pane's session view (for the statusline). */
export function focusedConn(): ConnState | null {
  const s = focusedSlot();
  return s !== undefined && s.sessionId !== null ? s.conn : null;
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
 * Handoff §11 empty state (zero views ⇔ zero sessions): centered logo tile,
 * "No active sessions", + New session (opens the launch dialog) and, when the
 * session history holds anything, "Resume a session (N)" opening the sessions
 * drawer. NO grace countdown — a page able to display one would itself be
 * keeping the backend alive.
 */
function renderEmpty(): void {
  const sig = `__empty:${st.state.history.length}`;
  if (renderedViewId === sig) return;
  for (const s of slots) s.view?.dispose();
  slots = [];
  renderedViewId = sig;
  renderedCount = -1;
  lastFocusKey = '';
  delete grid.dataset.layout;
  delete grid.dataset.l3;

  const box = el('div', 'empty-state');
  const tile = el('div', 'empty-tile');
  tile.append(el('span', 'empty-glyph', '>_'));
  tile.setAttribute('aria-hidden', 'true');
  const hd = el('div', 'empty-hd', 'No active sessions');
  const row = el('div', 'empty-actions');
  const launch = button('btn-go', '+ New session', () => openLaunch());
  row.append(launch);
  if (st.state.history.length > 0) {
    row.append(
      button('btn-ghost', `Resume a session (${st.state.history.length})`, () =>
        st.openDrawer('sessions'),
      ),
    );
  }
  box.append(tile, hd, row);
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
 * A divider is a wide invisible hit strip centered on the 1px gutter; its
 * 1px line surfaces only on hover/focus/drag. Pointer-drag adjusts the
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
  d.title = 'drag to resize · arrow keys nudge · double-click or enter resets';
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

  // Handoff §3 header: dot · session name · project name · spacer · model
  // tag · permission tag · (conn chip while degraded) · ⇱ own tab. Status is
  // the dot (pulsing amber = attention); killing lives on the tab × and the
  // sessions drawer. The whole header is the drag source — keyboard twins:
  // ctrl+alt+shift+arrows (swap) and the ⇱ button (extract).
  const hd = el('header', 'pane-hd');
  const dot = el('span', 'dot');
  dot.setAttribute('aria-hidden', 'true');
  const title = el('span', 'pane-title');
  const proj = el('span', 'pane-proj');
  const gap = el('span', 'pane-gap');
  const tagModel = el('span', 'pane-tag');
  tagModel.hidden = true;
  const tagPerm = el('span', 'pane-tag');
  tagPerm.hidden = true;
  const connChip = el('span', 'pane-conn');
  connChip.hidden = true;
  const extractBtn = button('pane-pop', '⇱ own tab');
  extractBtn.title = 'move to its own tab (or drag the header onto the tab strip)';
  hd.append(dot, title, proj, gap, tagModel, tagPerm, connChip, extractBtn);
  hd.title = 'drag onto a pane to swap · onto the tab strip to extract';

  const note = el('div', 'pane-note');
  note.hidden = true;

  const body = el('div', 'pane-body');
  const termHost = el('div', 'term-host');
  // Scanline overlay (theme popover toggle): OUTSIDE the isolated term-host,
  // pointer-events:none, revealed by html.scanlines-on. Terminal body only.
  const scan = el('div', 'pane-scan');
  scan.setAttribute('aria-hidden', 'true');
  body.append(termHost, scan);

  // Terminal-only below the header: the session's own status line (drawn by
  // Claude Code inside the PTY) replaced the app-rendered strip that used to
  // sit here (2026-07-26).
  root.append(hd, note, body, buildDropOverlay());
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
    tagModel,
    tagPerm,
    connChip,
    extractBtn,
    note,
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
    flash(`kill failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function updateHeader(s: Slot): void {
  if (s.sessionId === null) return;
  const info = st.state.sessions.get(s.sessionId);
  const pname = st.projectName(info?.projectId);
  s.proj.textContent = pname ?? '·';
  s.title.textContent = info?.title ?? s.sessionId.slice(0, 8);
  const attention = info !== undefined && info.attention;
  const running = info === undefined || info.status === 'running';
  // The dot IS the status readout: green running / pulsing amber
  // attention / hollow gray exited (exit code lives on the banner).
  s.dot.className = `dot ${attention ? 'is-attn' : running ? 'is-run' : 'is-exit'}`;
  s.dot.title = attention ? 'needs input' : running ? 'running' : 'exited';
  // Model/permission tags derive from argv client-side (no protocol fields).
  const m = info !== undefined ? modelFromArgs(info.args) : null;
  s.tagModel.hidden = m === null;
  if (m !== null) s.tagModel.textContent = m;
  const p = info !== undefined ? permFromArgs(info.args) : null;
  s.tagPerm.hidden = p === null;
  if (p !== null) {
    s.tagPerm.textContent = p.label;
    s.tagPerm.classList.toggle('is-danger', p.danger);
    s.tagPerm.title = p.danger ? 'permissions bypassed — dangerous' : 'permission mode';
  }
  if (s.conn === null || s.conn === 'live') {
    s.connChip.hidden = true;
  } else {
    s.connChip.hidden = false;
    s.connChip.textContent = s.conn === 'dead' ? 'lost' : `${s.conn}…`;
    s.connChip.className = `pane-conn ${s.conn === 'dead' ? 'is-danger' : 'is-warn'}`;
  }
  // Alone in its view, a session already IS its own tab.
  s.extractBtn.hidden = renderedCount <= 1;
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
      el('span', 'pane-note-text', 'session gone from server'),
      button('pane-note-btn', 'close pane', () => {
        if (s.sessionId !== null) st.removeSessionEverywhere(s.sessionId);
      }),
    );
    return;
  }
  if (s.exitCode !== null) {
    // Structural exited banner; the buffer below stays readable.
    s.note.hidden = false;
    s.note.className = `pane-note ${s.exitCode === 0 ? 'is-exit' : 'is-exit-err'}`;
    const relaunchBtn = button('pane-note-btn is-primary', 'relaunch', () => void relaunch(s));
    const delBtn = button('pane-note-btn', 'delete session');
    armButton(delBtn, 'sure?', () => {
      if (s.sessionId !== null) void killSession(s.sessionId);
    });
    s.note.replaceChildren(
      el('span', 'pane-note-text', `exited · code ${s.exitCode}`),
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
    flash(`relaunch failed: ${err instanceof Error ? err.message : String(err)}`);
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

