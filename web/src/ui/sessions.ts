/**
 * Sessions panel (Nocturne A5, right, 300px): ALL server-side sessions,
 * whoever created them — sessions are global; every one of them has a tab.
 *
 * "Running now" rows: an 8px state dot, the session name, "Side by side"
 * (append into the current view, max 4 — the button twin of drag-to-merge) and
 * an end control that arms into a worded "End" before it kills anything. Dot
 * and name are one button: clicking it activates that session's view and
 * focuses its terminal, and its accessible name carries the state word the
 * v3 row does not print.
 * Meta line, indented under the name: the project's NAME and what is running
 * in it ("api, Claude Code Opus"), the amber "Needs your answer" when the
 * session is waiting, or how it finished. A5 dropped the tab/pane PLACE from
 * this line (it is what truncated it at 300px); the row still takes you there.
 *
 * "Earlier" (GET /api/history, ENDED entries only) replaced the old
 * PREVIOUS RUN offers on 2026-09-06 (user's call): every session the app ever
 * launched is kept across backend runs and can be resumed per conversation.
 * Entries live in a FOLDER PER PROJECT — the user's own framing, "not loose
 * sessions" — collapsible, newest folder first. Resuming POSTs
 * /api/history/:id/resume and the SERVER composes the argv; the browser never
 * decides how a conversation is continued. Its rows keep the per-project
 * FOLDERS (the user's own framing, 2026-09-06) even though the v3 reference
 * draws one flat list: the folders are a decided feature, not a style.
 */
import type { HistoryEntry } from '../../../shared/protocol.ts';
import * as api from '../api.ts';
import * as st from '../state.ts';
import { log } from '../log.ts';
import { el, button, ArmedSet, fmtAgo, modelFromArgs, fmtCount } from './util.ts';
import { commandLabel, isClaudeCommand, modelLabel } from './launch-args.ts';
import { groupHistory, scheduleHistoryRefresh } from './history.ts';
import { killSession, requestTerminalFocus, focusedPaneDims } from './panes.ts';
import { flash } from './statusline.ts';

const armed = new ArmedSet();

/** Folder keys the user has collapsed. In memory only — origins churn per backend run. */
const collapsed = new Set<string>();

/** Go to the session's tab and put the keyboard in its terminal. */
function showSession(sessionId: string): void {
  st.focusSession(sessionId);
  requestTerminalFocus();
}

/** Button twin of drag-to-split: append the session into the active view. */
function splitIntoActive(sessionId: string): void {
  const result = st.moveSessionToView(sessionId, st.state.activeViewId);
  if (result === 'full') flash('This tab is full. It can show 4 panes.');
  else if (result === 'no') flash('It is already in this tab.');
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
    flash(`Could not start it again: ${err instanceof Error ? err.message : String(err)}`);
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
      flash(`Could not forget it: ${err instanceof Error ? err.message : String(err)}`);
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
    flash(`Could not clear the history: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  st.clearHistory();
}

export function initSessionsDrawer(host: HTMLElement): { render(): void } {
  const root = el('section', 'drawer-view');

  const hd = el('header', 'drawer-hd');
  hd.append(el('span', 'drawer-label', 'Sessions'), el('span', 'drawer-gap'));
  const close = button('drawer-x', '×', () => st.closeDrawer());
  close.setAttribute('aria-label', 'close sessions panel');
  close.title = 'close panel';
  hd.append(close);

  const body = el('div', 'drawer-body');
  root.append(hd, body);
  host.append(root);

  let lastSig = '';

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
            `${s.attention ? '!' : ''}:${armed.isArmed(s.id) ? 'a' : ''}`,
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
    rows.push(el('div', 'drawer-sect', 'Running now'));
    if (sessions.length === 0) {
      rows.push(el('div', 'drawer-empty', 'No sessions yet. Start one with New session.'));
    }
    for (const info of sessions) {
      const row = el('div', 'sess-row');
      const line = el('div', 'sess-line');

      const attention = info.attention;
      const running = info.status === 'running';
      // The state word the v3 row does not print. It is not decoration: the
      // dot is the visual, this is what a screen reader and a hover get.
      const stateWord = attention
        ? 'Needs your answer'
        : running
          ? 'Working'
          : `Finished (${info.exitCode ?? 0})`;

      const open = button('sess-open', '', () => showSession(info.id));
      open.setAttribute('data-k', `show:${info.id}`);
      open.setAttribute('aria-label', `${info.title}, ${stateWord}`);
      open.title = stateWord;
      const dot = el('span', `dot ${attention ? 'is-attn' : running ? 'is-run' : 'is-exit'}`);
      dot.setAttribute('aria-hidden', 'true');
      open.append(dot, el('span', 'sess-name', info.title));

      const split = button('row-btn', 'Side by side', () => splitIntoActive(info.id));
      split.setAttribute('data-k', `split:${info.id}`);
      split.setAttribute('aria-label', `show ${info.title} next to the current session`);
      split.title = 'Show next to the current session, up to four';
      const armedKill = armed.isArmed(info.id);
      const kill = button('row-x', armedKill ? 'End' : '×', () => {
        if (armed.trigger(info.id, refresh)) void killSession(info.id);
      });
      if (armedKill) kill.dataset.armed = '1';
      kill.setAttribute('data-k', `kill:${info.id}`);
      kill.setAttribute('aria-label', armedKill ? `end ${info.title} now` : `end session ${info.title}`);
      kill.title = armedKill ? 'Click again to end it' : 'End session';
      line.append(open, split, kill);

      // The quiet fact under the name: what it is and where it runs, or the
      // one thing that needs the user.
      const meta = el('div', 'sess-meta');
      const pname = st.projectName(info.projectId);
      const modelId = modelFromArgs(info.args);
      const tool = `${commandLabel(info.command)}${modelId !== null ? ` ${modelLabel(modelId)}` : ''}`;
      let metaTxt: string;
      if (attention) metaTxt = stateWord;
      else if (!running) metaTxt = pname !== null ? `${pname}, ${stateWord}` : stateWord;
      else metaTxt = pname !== null ? `${pname}, ${tool}` : tool;
      meta.textContent = metaTxt;
      meta.classList.toggle('is-attn', attention);

      row.append(line, meta);
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

  /** "Earlier" section header: the word, and the clear-all action. */
  function historyHeader(): HTMLElement {
    const hd2 = el('div', 'drawer-sect is-later');
    hd2.append(el('span', '', 'Earlier'), el('span', 'drawer-gap'));
    // Armed two-step confirm, same contract as kill (key 'hist-all' cannot
    // collide with session ids in the shared ArmedSet).
    const isArmed = armed.isArmed('hist-all');
    const all = button('link-btn', isArmed ? 'Clear them all?' : 'Clear', () => {
      if (armed.trigger('hist-all', refresh)) void forgetAll();
    });
    if (isArmed) all.dataset.armed = '1';
    all.setAttribute('data-k', 'hist-clear-all');
    all.setAttribute('aria-label', 'clear the earlier sessions');
    all.title = 'Clear the list (asks to confirm)';
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
    row.append(glyph, el('span', 'hist-folder', label), el('span', 'hist-count', fmtCount(count)));
    return row;
  }

  /** One ended session: hollow dot, title, when it ran, and how to bring it back. */
  function historyRow(entry: HistoryEntry): HTMLElement {
    const row = el('div', 'sess-row is-hist');
    const line = el('div', 'sess-line');
    const dot = el('span', 'dot is-past');
    dot.setAttribute('aria-hidden', 'true');
    line.append(dot, el('span', 'sess-name is-hist', entry.title));

    const meta = el('div', 'sess-meta is-hist');
    const parts = [fmtAgo(entry.lastUsedAt)];
    // What RAN, for everything that is not the known agent: without it a shell
    // entry is indistinguishable from a claude one (the ACTIVE rows say it in
    // their model slot; history rows have no model to say). Claude rows are
    // left alone — their model tag already names them.
    if (!isClaudeCommand(entry.command)) parts.push(commandLabel(entry.command));
    const model = modelFromArgs(entry.args);
    if (model !== null) parts.push(modelLabel(model));
    const crashed = entry.ended?.reason === 'crash';
    if (crashed) parts.push('crashed');
    // Sentence case: this line starts with a moment in time ("Yesterday").
    const text = parts.join(', ');
    meta.textContent = text.charAt(0).toUpperCase() + text.slice(1);
    meta.classList.toggle('is-danger', crashed);

    // `Continue` is a promise about ONE conversation, so it keys on the pin,
    // not on the command: a claude session launched to continue the folder's
    // most recent conversation has no pinned id, and only gets started again.
    const label = entry.conversation ? 'Continue' : 'Start again';
    const re = button('row-btn is-acc', label, () => void resumeEntry(entry));
    re.setAttribute('data-k', `hist-resume:${entry.id}`);
    re.setAttribute('aria-label', `${label} ${entry.title}`);
    const key = `hist:${entry.id}`;
    const isArmed = armed.isArmed(key);
    const forget = button('row-x is-quiet', isArmed ? 'Forget' : '×', () => {
      if (armed.trigger(key, refresh)) void forgetEntry(entry);
    });
    if (isArmed) forget.dataset.armed = '1';
    forget.setAttribute('data-k', `hist-forget:${entry.id}`);
    forget.setAttribute('aria-label', isArmed ? `forget ${entry.title} now` : `forget ${entry.title}`);
    forget.title = isArmed ? 'Click again to forget it' : 'Forget this session';
    line.append(re, forget);

    row.append(line, meta);
    return row;
  }

  return { render };
}
