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
 * PREVIOUS RUN · N (crash/shutdown offers from GET /api/previous): rows keep
 * the existing `--continue` relaunch + forget + dismiss-all EXACTLY — there
 * is deliberately NO per-id `--resume <id>` (the journal stores our session
 * ids, not Claude conversation ids). Footer note states the contract.
 */
import type { CreateSessionRequest, PreviousSession } from '../../../shared/protocol.ts';
import * as api from '../api.ts';
import * as st from '../state.ts';
import { el, button, ArmedSet, modelFromArgs } from './util.ts';
import { killSession, requestTerminalFocus, focusedPaneDims } from './panes.ts';
import { flash } from './statusline.ts';

const armed = new ArmedSet();

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
 * Previous-run relaunch: POST a new session with the entry's cwd/command/
 * args/title (sized to the focused pane; the attach flow reconciles), then
 * focus the tab it gets and dismiss the offer. Claude continuity: a `claude`
 * entry that carries neither '--continue' nor '--resume' gets '--continue'
 * prepended so the conversation resumes (Claude Code persists its own
 * history).
 */
/** Claude flags that already resume a conversation ('-c'/'-r' are the short
 *  aliases; the launch dialog emits '--continue'). Prepending '--continue'
 *  on top of any of these would double the flag. */
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

  const hd = el('header', 'drawer-hd');
  hd.append(el('span', 'drawer-label', 'SESSIONS'), el('span', 'drawer-gap'));
  const close = button('drawer-x', '×', () => st.closeDrawer());
  close.setAttribute('aria-label', 'close sessions panel');
  close.title = 'close panel (esc)';
  hd.append(close);

  const body = el('div', 'drawer-body');
  const note = el('div', 'drawer-note', 'relaunch resumes claude with --continue');
  note.hidden = true;
  root.append(hd, body, note);
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
    return (
      `n${st.state.sessions.size}` +
      `P${armed.isArmed('prev-all') ? 'a' : ''}${st.state.previous.map((p) => p.id).join(',')}|` +
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
      const pname = st.projectName(info.projectId) ?? info.command;
      let statusTxt: string;
      if (attention) statusTxt = 'waiting for input';
      else if (running) statusTxt = 'running';
      else statusTxt = `exited (${info.exitCode ?? 0})`;
      const place = placeOf(info.id);
      meta.textContent = `${pname} · ${statusTxt}${place !== '' ? ` · ${place}` : ''}`;
      meta.classList.toggle('is-attn', attention);
      main.append(line, meta);

      const actions = el('div', 'sess-actions');
      const model = el('span', 'sess-model', modelFromArgs(info.args) ?? info.command);
      const split = button('chip-btn is-acc', 'split', () => splitIntoActive(info.id));
      split.setAttribute('data-k', `split:${info.id}`);
      split.title = 'add to the current view, max 4 (drag its tab for placement)';
      const kill = button('chip-btn is-x', armed.isArmed(info.id) ? 'sure?' : '×', () => {
        if (
          armed.trigger(info.id, () => {
            lastSig = '';
            render();
          })
        ) {
          void killSession(info.id);
        }
      });
      if (armed.isArmed(info.id)) kill.dataset.armed = '1';
      kill.setAttribute('data-k', `kill:${info.id}`);
      kill.setAttribute('aria-label', `end session ${info.title}`);
      kill.title = 'end session (asks to confirm)';
      actions.append(model, split, kill);

      row.append(main, actions);
      rows.push(row);
    }

    if (st.state.previous.length > 0) {
      rows.push(prevHeader());
      for (const p of st.state.previous) rows.push(prevRow(p));
    }
    note.hidden = st.state.previous.length === 0;

    body.replaceChildren(...rows);

    if (focusKey !== null) {
      body.querySelector<HTMLElement>(`[data-k="${CSS.escape(focusKey)}"]`)?.focus();
    }
  }

  /** "PREVIOUS RUN" section header: label + count, dismiss-all. */
  function prevHeader(): HTMLElement {
    const hd2 = el('div', 'drawer-sect');
    hd2.append(
      el('span', '', `PREVIOUS RUN · ${st.state.previous.length}`),
      el('span', 'drawer-gap'),
    );
    // Armed two-step confirm, same contract as kill (key 'prev-all' cannot
    // collide with session ids in the shared ArmedSet).
    const all = button('chip-btn', armed.isArmed('prev-all') ? 'sure?' : 'dismiss all', () => {
      if (
        armed.trigger('prev-all', () => {
          lastSig = '';
          render();
        })
      ) {
        void dismissAllPrevious();
      }
    });
    if (armed.isArmed('prev-all')) all.dataset.armed = '1';
    all.setAttribute('data-k', 'prev-dismiss-all');
    all.title = 'dismiss all previous-run offers (asks to confirm)';
    hd2.append(all);
    return hd2;
  }

  /** One crash/shutdown offer: project name (never the path), title, command. */
  function prevRow(p: PreviousSession): HTMLElement {
    const row = el('div', 'sess-row is-prev');
    const main = el('div', 'sess-main');
    const line = el('div', 'sess-line');
    const dot = el('span', 'dot is-exit');
    dot.setAttribute('aria-hidden', 'true');
    line.append(dot, el('span', 'sess-name is-prev', p.title));
    const meta = el('div', 'sess-meta');
    const pname = st.projectName(p.projectId);
    meta.textContent = pname !== null ? `${pname} · ${p.command}` : p.command;
    main.append(line, meta);

    const actions = el('div', 'sess-actions');
    const re = button('chip-btn is-acc', 'relaunch', () => void relaunchPrevious(p));
    re.setAttribute('data-k', `prev-relaunch:${p.id}`);
    re.title =
      p.command === 'claude'
        ? 'relaunch as a new tab — claude resumes with --continue'
        : 'relaunch as a new tab';
    const dis = button('chip-btn is-x', '×', () => void dismissPrevious(p));
    dis.setAttribute('data-k', `prev-dismiss:${p.id}`);
    dis.setAttribute('aria-label', `forget ${p.title}`);
    dis.title = 'forget this offer';
    actions.append(re, dis);

    row.append(main, actions);
    return row;
  }

  return { render };
}
