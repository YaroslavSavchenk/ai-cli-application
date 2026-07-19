/**
 * Sessions drawer: ALL server-side sessions, whoever created them — sessions
 * are global; every one of them has a tab. Each row: attention badge,
 * project NAME (never the path), title, status (running / exit code),
 * created time, and its tab (+ pane when it sits in the active view).
 *
 * Actions: show (go to the session's tab), split (append it into the active
 * view — the keyboard path for drag-to-split), kill (armed two-step confirm;
 * rows are rebuilt on every poll so the armed state lives in an ArmedSet
 * keyed by id).
 *
 * When the previous run left crash/shutdown offers (GET /api/previous), a
 * "previous run" section sits above the live list: rows show project name /
 * title / command with relaunch + dismiss actions and a dismiss-all.
 * Relaunch opens the new session as its own tab.
 */
import type { CreateSessionRequest, PreviousSession } from '../../../shared/protocol.ts';
import * as api from '../api.ts';
import * as st from '../state.ts';
import { el, button, ArmedSet, fmtAge } from './util.ts';
import { killSession, requestTerminalFocus, focusedPaneDims } from './panes.ts';
import { flash } from './statusline.ts';

const armed = new ArmedSet();

/** Go to the session's tab and put the keyboard in its terminal. */
function showSession(sessionId: string): void {
  st.focusSession(sessionId);
  requestTerminalFocus();
}

/** Keyboard path for drag-to-split: append the session into the active view. */
function splitIntoActive(sessionId: string): void {
  const result = st.moveSessionToView(sessionId, st.state.activeViewId);
  if (result === 'full') flash('view is full — 4 panes max');
  else if (result === 'no') flash('already in the active view');
  else requestTerminalFocus();
}

/**
 * Previous-run relaunch: POST a new session with the entry's cwd/command/
 * args/title (sized to the focused pane; the attach flow reconciles), then
 * focus the tab it gets and dismiss the offer. Claude continuity: a `claude`
 * entry that carries neither '--continue' nor '--resume' gets '--continue'
 * prepended so the conversation resumes (Claude Code persists its own
 * history).
 */
/** Claude flags that already resume a conversation ('-c'/'-r' are the short
 *  aliases; our own launcher preset emits '-c'). Prepending '--continue' on
 *  top of any of these would double the flag. */
const RESUME_FLAGS = ['--continue', '-c', '--resume', '-r'];

async function relaunchPrevious(p: PreviousSession): Promise<void> {
  const dims = focusedPaneDims();
  const resumes = p.args.some((a) => RESUME_FLAGS.includes(a));
  const req: CreateSessionRequest = {
    // projectId only while the project still exists — relaunch must survive
    // a deleted project (cwd is explicit either way).
    ...(p.projectId !== undefined && st.projectName(p.projectId) !== null
      ? { projectId: p.projectId }
      : {}),
    cwd: p.cwd,
    command: p.command,
    args: p.command === 'claude' && !resumes ? ['--continue', ...p.args] : [...p.args],
    title: p.title,
    cols: dims.cols,
    rows: dims.rows,
  };
  let created;
  try {
    created = await api.createSession(req);
  } catch (err) {
    flash(`relaunch failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  st.upsertSession(created); // Gives the session its own tab.
  showSession(created.id);
  // Dismiss AFTER the successful relaunch; a lost DELETE only means the
  // offer reappears on the next reload (its dismiss button still works).
  try {
    await api.dismissPrevious(p.id);
  } catch {
    // 404 (already gone) or a blip — drop it locally either way.
  }
  st.removePrevious(p.id);
}

async function dismissPrevious(p: PreviousSession): Promise<void> {
  try {
    await api.dismissPrevious(p.id);
  } catch (err) {
    if (!(err instanceof api.ApiError && err.status === 404)) {
      flash(`dismiss failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
  }
  st.removePrevious(p.id);
}

async function dismissAllPrevious(): Promise<void> {
  try {
    await api.dismissAllPrevious();
  } catch (err) {
    flash(`dismiss failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  st.clearPrevious();
}

export function initSessionsDrawer(host: HTMLElement): { render(): void } {
  const root = el('section', 'drawer-view');
  root.hidden = true;

  const hd = el('header', 'drawer-hd');
  const label = el('span', 'drawer-label', 'sessions');
  const count = el('span', 'drawer-count');
  const gap = el('span', 'drawer-gap');
  const close = button('drawer-x', '×', () => st.closeDrawer());
  close.setAttribute('aria-label', 'close sessions panel');
  close.title = 'close panel (esc)';
  hd.append(label, count, gap, close);

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
    // Previous-run offers are immutable per id, so their id list captures
    // every change; placeOf covers tab moves/merges.
    return `n${st.state.sessions.size}` +
      `P${armed.isArmed('prev-all') ? 'a' : ''}${st.state.previous.map((p) => p.id).join(',')}|` +
      Array.from(st.state.sessions.values())
      .map(
        (s) =>
          `${s.id}:${st.projectName(s.projectId) ?? ''}:${s.title}:${s.status}:${s.exitCode ?? ''}:` +
          `${s.cols}x${s.rows}:${s.attention ? '!' : ''}:${placeOf(s.id)}:` +
          `${fmtAge(s.createdAt)}:${armed.isArmed(s.id) ? 'a' : ''}`,
      )
      .join('|');
  }

  function render(): void {
    const visible = st.state.drawer === 'sessions';
    root.hidden = !visible;
    if (!visible) {
      lastSig = 'hidden';
      return;
    }
    const s = sig();
    if (s === lastSig) return;
    lastSig = s;
    rebuild();
  }

  function rebuild(): void {
    const sessions = Array.from(st.state.sessions.values());
    count.textContent = String(sessions.length);

    // Rows are rebuilt wholesale; keep keyboard focus on the same control.
    const focusKey =
      document.activeElement instanceof HTMLElement
        ? document.activeElement.getAttribute('data-k')
        : null;

    const rows: HTMLElement[] = [];
    if (st.state.previous.length > 0) {
      rows.push(prevHeader());
      for (const p of st.state.previous) rows.push(prevRow(p));
    }
    if (sessions.length === 0) {
      rows.push(el('div', 'drawer-empty', 'no sessions — launch one from a new-session tab (+)'));
    }
    for (const info of sessions) {
      const row = el('div', 'sess-row');
      // Double-click anywhere on the row = the show button (documented in
      // the shortcuts overlay; the button stays the keyboard path).
      row.title = 'double-click: go to this session’s tab';
      row.addEventListener('dblclick', (e) => {
        if (e.target instanceof HTMLElement && e.target.closest('button') !== null) return;
        showSession(info.id);
      });

      const badge = el('span', 'badge-attn', '!');
      badge.title = 'session wants attention';
      badge.hidden = !info.attention;

      const main = el('div', 'sess-main');
      const name = el('div', 'sess-name');
      const pname = st.projectName(info.projectId);
      name.append(
        el('span', 'sess-proj', pname ?? info.command),
        el('span', 'sess-sep', '·'),
        el('span', 'sess-title', info.title),
      );
      const meta = el('div', 'sess-meta');
      if (info.status === 'running') {
        // Human status; amber text = attention (matches the inverse badge).
        if (info.attention) meta.append(el('span', 'is-attn', 'needs input'));
        else meta.append(el('span', 'is-ok', 'running'));
      } else {
        const code = info.exitCode ?? 0;
        meta.append(el('span', code === 0 ? '' : 'is-danger', code === 0 ? 'exited' : `exited · ${code}`));
      }
      meta.append(el('span', '', `${info.cols}×${info.rows}`));
      meta.append(el('span', '', fmtAge(info.createdAt)));
      const place = placeOf(info.id);
      if (place !== '') meta.append(el('span', 'sess-here', place));
      main.append(name, meta);

      const actions = el('div', 'sess-actions');
      const show = button('row-btn', 'show', () => showSession(info.id));
      show.setAttribute('data-k', `show:${info.id}`);
      show.title = 'go to this session’s tab';
      const split = button('row-btn', 'split', () => splitIntoActive(info.id));
      split.setAttribute('data-k', `split:${info.id}`);
      split.title = 'append this session into the active view (drag its tab for placement)';
      const kill = button('row-btn is-danger', armed.isArmed(info.id) ? 'sure?' : 'kill', () => {
        if (armed.trigger(info.id, () => {
          lastSig = '';
          render();
        })) {
          void killSession(info.id);
        }
      });
      if (armed.isArmed(info.id)) kill.dataset.armed = '1';
      kill.setAttribute('data-k', `kill:${info.id}`);
      kill.title = 'kill session (asks to confirm)';
      actions.append(show, split, kill);

      row.append(badge, main, actions);
      rows.push(row);
    }
    body.replaceChildren(...rows);

    if (focusKey !== null) {
      body.querySelector<HTMLElement>(`[data-k="${CSS.escape(focusKey)}"]`)?.focus();
    }
  }

  /** "previous run" section header: label, count, dismiss-all. */
  function prevHeader(): HTMLElement {
    const hd = el('div', 'drawer-sect');
    hd.append(
      el('span', 'drawer-sect-lb', 'previous run'),
      el('span', 'drawer-count', String(st.state.previous.length)),
      el('span', 'drawer-gap'),
    );
    // Armed two-step confirm, same contract as kill (key 'prev-all' cannot
    // collide with session ids in the shared ArmedSet).
    const all = button('row-btn', armed.isArmed('prev-all') ? 'sure?' : 'dismiss all', () => {
      if (armed.trigger('prev-all', () => {
        lastSig = '';
        render();
      })) {
        void dismissAllPrevious();
      }
    });
    if (armed.isArmed('prev-all')) all.dataset.armed = '1';
    all.setAttribute('data-k', 'prev-dismiss-all');
    all.title = 'dismiss all previous-run offers (asks to confirm)';
    hd.append(all);
    return hd;
  }

  /** One crash/shutdown offer: project name (never the path), title, command. */
  function prevRow(p: PreviousSession): HTMLElement {
    const row = el('div', 'sess-row is-prev');
    const main = el('div', 'sess-main');
    const name = el('div', 'sess-name');
    const pname = st.projectName(p.projectId);
    name.append(
      el('span', 'sess-proj', pname ?? p.command),
      el('span', 'sess-sep', '·'),
      el('span', 'sess-title', p.title),
    );
    const meta = el('div', 'sess-meta');
    meta.append(el('span', '', p.command));
    main.append(name, meta);

    const actions = el('div', 'sess-actions');
    // Green = primary action, same contract as the exited-banner relaunch.
    const re = button('row-btn is-primary', 'relaunch', () => void relaunchPrevious(p));
    re.setAttribute('data-k', `prev-relaunch:${p.id}`);
    re.title =
      p.command === 'claude'
        ? 'relaunch as a new tab — claude resumes with --continue'
        : 'relaunch as a new tab';
    const dis = button('row-btn', 'dismiss', () => void dismissPrevious(p));
    dis.setAttribute('data-k', `prev-dismiss:${p.id}`);
    dis.title = 'dismiss this offer';
    actions.append(re, dis);

    row.append(main, actions);
    return row;
  }

  return { render };
}
