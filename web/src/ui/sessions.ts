/**
 * Sessions drawer (handoff §7, right, 296px): ALL server-side sessions,
 * whoever created them — sessions are global; every one of them has a tab.
 *
 * ACTIVE · N rows: status dot, mono session name, model tag (derived from
 * argv), a `split` button (append into the current view, max 4 — the button
 * twin of drag-to-merge) and `×` (armed two-step kill). The row body is a
 * real button: clicking it activates that session's view and focuses it.
 * Meta line: project name · status (· tab place when assigned).
 *
 * HISTORY · N (GET /api/history, ENDED entries only) replaced the old
 * PREVIOUS RUN offers on 2026-09-06 (user's call): every session the app ever
 * launched is kept across backend runs and can be resumed per conversation.
 * Entries live in a FOLDER PER PROJECT — the user's own framing, "not loose
 * sessions" — collapsible, newest folder first. Resuming POSTs
 * /api/history/:id/resume and the SERVER composes the argv; the browser never
 * decides how a conversation is continued.
 */
import type { HistoryEntry } from '../../../shared/protocol.ts';
import * as api from '../api.ts';
import * as st from '../state.ts';
import { log } from '../log.ts';
import { el, button, ArmedSet, fmtAgo, modelFromArgs } from './util.ts';
import { AGENT_LABEL } from './launch-args.ts';
import { groupHistory, scheduleHistoryRefresh } from './history.ts';
import { killSession, requestTerminalFocus, focusedPaneDims } from './panes.ts';
import { flash } from './statusline.ts';

const armed = new ArmedSet();

/** Folder keys the user has collapsed. In memory only — origins churn per backend run. */
const collapsed = new Set<string>();

/**
 * A session's command as the UI says it: the ONE known agent reads as its
 * product name (the launch dialog's own `Claude Code`), anything else is echoed
 * exactly as the user typed it in the custom-command field. Inventing a display
 * name for an arbitrary command would be a lie about what is running.
 *
 * Exported because the settings panel's relaunch notice names sessions too, and
 * a second table would be a second place for the literal command name to leak
 * into UI chrome (PROJECT-SCOPE copy rule, 2026-07-25).
 */
export function commandLabel(command: string): string {
  return command === 'claude' ? AGENT_LABEL : command;
}

/** Go to the session's tab and put the keyboard in its terminal. */
function showSession(sessionId: string): void {
  st.focusSession(sessionId);
  requestTerminalFocus();
}

/** Button twin of drag-to-split: append the session into the active view. */
function splitIntoActive(sessionId: string): void {
  const result = st.moveSessionToView(sessionId, st.state.activeViewId);
  if (result === 'full') flash('view is full — 4 panes max');
  else if (result === 'no') flash('already in the active view');
  else requestTerminalFocus();
}

/**
 * Resume one history entry. The server owns the argv (a claude conversation
 * comes back with `--resume <id>`, any other command respawns as it was), so
 * this posts only the pane size and takes the SessionInfo it gets back.
 */
export async function resumeEntry(entry: HistoryEntry): Promise<void> {
  // Entry ID + whether the server can pin a real conversation; never the
  // entry's title or cwd (the drawer already shows what the user picked).
  log.info(`resume: history entry=${entry.id} conversation=${entry.conversation}`);
  let info;
  try {
    info = await api.resumeHistory(entry.id, focusedPaneDims());
  } catch (err) {
    log.warn(`resume failed: entry=${entry.id} ${err instanceof Error ? err.message : String(err)}`);
    flash(`could not start it again: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  log.info(`resume ok: entry=${entry.id} session=${info.id}`);
  st.upsertSession(info); // gives the session its own tab
  st.focusSession(info.id);
  requestTerminalFocus();
  scheduleHistoryRefresh(); // the entry is live now — it leaves the ended list
}

async function forgetEntry(entry: HistoryEntry): Promise<void> {
  log.info(`forget: history entry=${entry.id}`);
  try {
    await api.forgetHistory(entry.id);
  } catch (err) {
    if (!(err instanceof api.ApiError && err.status === 404)) {
      flash(`could not forget it: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
  }
  st.removeHistory(entry.id);
}

async function forgetAll(): Promise<void> {
  log.info(`forget all history: ${st.state.history.length} entries`);
  try {
    await api.forgetAllHistory();
  } catch (err) {
    flash(`could not clear the history: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  st.clearHistory();
}

export function initSessionsDrawer(host: HTMLElement): { render(): void } {
  const root = el('section', 'drawer-view');

  const hd = el('header', 'drawer-hd');
  hd.append(el('span', 'drawer-label', 'SESSIONS'), el('span', 'drawer-gap'));
  const close = button('drawer-x', '×', () => st.closeDrawer());
  close.setAttribute('aria-label', 'close sessions panel');
  close.title = 'close panel';
  hd.append(close);

  const body = el('div', 'drawer-body');
  root.append(hd, body);
  host.append(root);

  let lastSig = '';

  /** The session's place in the strip: tab index (+ pane when in the active view). */
  function placeOf(id: string): string {
    const v = st.viewOfSession(id);
    if (v === undefined) return '';
    const tabIdx = st.state.views.indexOf(v) + 1;
    return v.id === st.state.activeViewId
      ? `tab ${tabIdx} · pane ${v.sessions.indexOf(id) + 1}`
      : `tab ${tabIdx}`;
  }

  function sig(): string {
    if (st.state.drawer !== 'sessions') return 'hidden';
    // Count prefix so the empty list still differs from the initial ''.
    // History entries change with every refetch, so id + lastUsedAt + armed
    // state + the collapse set capture everything the section renders.
    return (
      `n${st.state.sessions.size}` +
      `H${armed.isArmed('hist-all') ? 'a' : ''}` +
      `${st.state.history.map((h) => `${h.id}@${h.lastUsedAt}${armed.isArmed(`hist:${h.id}`) ? 'a' : ''}`).join(',')}` +
      `/${Array.from(collapsed).sort().join(',')}|` +
      Array.from(st.state.sessions.values())
        .map(
          (s) =>
            `${s.id}:${st.projectName(s.projectId) ?? ''}:${s.title}:${s.status}:${s.exitCode ?? ''}:` +
            `${s.attention ? '!' : ''}:${placeOf(s.id)}:${armed.isArmed(s.id) ? 'a' : ''}`,
        )
        .join('|')
    );
  }

  function render(): void {
    const visible = st.state.drawer === 'sessions';
    if (!visible) {
      lastSig = 'hidden';
      return;
    }
    const s = sig();
    if (s === lastSig) return;
    lastSig = s;
    rebuild();
  }

  /** Re-render from a control's own handler (armed toggles, collapse). */
  function refresh(): void {
    lastSig = '';
    render();
  }

  function rebuild(): void {
    const sessions = Array.from(st.state.sessions.values());

    // Rows are rebuilt wholesale; keep keyboard focus on the same control.
    const focusKey =
      document.activeElement instanceof HTMLElement
        ? document.activeElement.getAttribute('data-k')
        : null;

    const rows: HTMLElement[] = [];
    rows.push(el('div', 'drawer-sect', `ACTIVE · ${sessions.length}`));
    if (sessions.length === 0) {
      rows.push(el('div', 'drawer-empty', 'no sessions — launch one with + new session'));
    }
    for (const info of sessions) {
      const row = el('div', 'sess-row');

      const main = button('sess-main', '', () => showSession(info.id));
      main.setAttribute('data-k', `show:${info.id}`);
      main.title = 'view this session';
      const line = el('div', 'sess-line');
      const attention = info.attention;
      const running = info.status === 'running';
      const dot = el('span', `dot ${attention ? 'is-attn' : running ? 'is-run' : 'is-exit'}`);
      dot.setAttribute('aria-hidden', 'true');
      line.append(dot, el('span', 'sess-name', info.title));
      const meta = el('div', 'sess-meta');
      const pname = st.projectName(info.projectId) ?? commandLabel(info.command);
      let statusTxt: string;
      if (attention) statusTxt = 'waiting for input';
      else if (running) statusTxt = 'running';
      else statusTxt = `exited (${info.exitCode ?? 0})`;
      const place = placeOf(info.id);
      meta.textContent = `${pname} · ${statusTxt}${place !== '' ? ` · ${place}` : ''}`;
      meta.classList.toggle('is-attn', attention);
      main.append(line, meta);

      const actions = el('div', 'sess-actions');
      const model = el('span', 'sess-model', modelFromArgs(info.args) ?? commandLabel(info.command));
      const split = button('chip-btn is-acc', 'split', () => splitIntoActive(info.id));
      split.setAttribute('data-k', `split:${info.id}`);
      split.title = 'add to the current view, max 4 (drag its tab for placement)';
      const kill = button('chip-btn is-x', armed.isArmed(info.id) ? 'sure?' : '×', () => {
        if (armed.trigger(info.id, refresh)) void killSession(info.id);
      });
      if (armed.isArmed(info.id)) kill.dataset.armed = '1';
      kill.setAttribute('data-k', `kill:${info.id}`);
      kill.setAttribute('aria-label', `end session ${info.title}`);
      kill.title = 'end session (asks to confirm)';
      actions.append(model, split, kill);

      row.append(main, actions);
      rows.push(row);
    }

    if (st.state.history.length > 0) {
      rows.push(historyHeader());
      for (const g of groupHistory(st.state.history, st.projectName)) {
        const open = !collapsed.has(g.key);
        rows.push(groupHeader(g.key, g.label, g.entries.length, open));
        if (open) for (const e of g.entries) rows.push(historyRow(e));
      }
    }

    body.replaceChildren(...rows);

    if (focusKey !== null) {
      body.querySelector<HTMLElement>(`[data-k="${CSS.escape(focusKey)}"]`)?.focus();
    }
  }

  /** "HISTORY" section header: label + total count, clear-all. */
  function historyHeader(): HTMLElement {
    const hd2 = el('div', 'drawer-sect');
    hd2.append(el('span', '', `HISTORY · ${st.state.history.length}`), el('span', 'drawer-gap'));
    // Armed two-step confirm, same contract as kill (key 'hist-all' cannot
    // collide with session ids in the shared ArmedSet).
    const all = button('chip-btn', armed.isArmed('hist-all') ? 'sure?' : 'clear all', () => {
      if (armed.trigger('hist-all', refresh)) void forgetAll();
    });
    if (armed.isArmed('hist-all')) all.dataset.armed = '1';
    all.setAttribute('data-k', 'hist-clear-all');
    all.title = 'clear all (asks to confirm)';
    hd2.append(all);
    return hd2;
  }

  /** One folder header — the WHOLE row is the collapse toggle. */
  function groupHeader(key: string, label: string, count: number, open: boolean): HTMLElement {
    const row = button('hist-group', '', () => {
      if (collapsed.has(key)) collapsed.delete(key);
      else collapsed.add(key);
      refresh();
    });
    row.setAttribute('data-k', `hist-group:${key}`);
    row.setAttribute('aria-expanded', open ? 'true' : 'false');
    const glyph = el('span', 'hist-caret', open ? '▾' : '▸');
    glyph.setAttribute('aria-hidden', 'true');
    row.append(glyph, el('span', 'hist-folder', label), el('span', 'hist-count', `· ${count}`));
    return row;
  }

  /** One ended session: dot, title, when it ran, and how to bring it back. */
  function historyRow(entry: HistoryEntry): HTMLElement {
    const row = el('div', 'sess-row is-hist');
    const main = el('div', 'sess-main');
    const line = el('div', 'sess-line');
    const dot = el('span', 'dot is-exit');
    dot.setAttribute('aria-hidden', 'true');
    line.append(dot, el('span', 'sess-name is-hist', entry.title));

    const meta = el('div', 'sess-meta');
    const parts = [fmtAgo(entry.lastUsedAt)];
    const model = modelFromArgs(entry.args);
    if (model !== null) parts.push(model);
    const crashed = entry.ended?.reason === 'crash';
    if (crashed) parts.push('crashed');
    meta.textContent = parts.join(' · ');
    meta.classList.toggle('is-danger', crashed);
    main.append(line, meta);

    const actions = el('div', 'sess-actions');
    // `resume` is a promise about ONE conversation, so it keys on the pin, not
    // on the command: a claude session launched to continue the folder's most
    // recent conversation has no pinned id, and only gets started again.
    const label = entry.conversation ? 'resume' : 'start again';
    const re = button('chip-btn is-acc', label, () => void resumeEntry(entry));
    re.setAttribute('data-k', `hist-resume:${entry.id}`);
    re.setAttribute('aria-label', `${label} ${entry.title}`);
    const key = `hist:${entry.id}`;
    const forget = button('chip-btn is-x', armed.isArmed(key) ? 'sure?' : '×', () => {
      if (armed.trigger(key, refresh)) void forgetEntry(entry);
    });
    if (armed.isArmed(key)) forget.dataset.armed = '1';
    forget.setAttribute('data-k', `hist-forget:${entry.id}`);
    forget.setAttribute('aria-label', `forget ${entry.title}`);
    forget.title = 'forget (asks to confirm)';
    actions.append(re, forget);

    row.append(main, actions);
    return row;
  }

  return { render };
}
