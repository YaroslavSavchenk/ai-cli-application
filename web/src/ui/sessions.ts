/**
 * Sessions drawer: ALL server-side sessions, whoever created them — sessions
 * are global, panes are only views. Each row: attention badge, project NAME
 * (never the path), title, status (running / exit code), created time, and a
 * marker when the session is visible in the active tab.
 *
 * Actions: attach-to-focused-pane, kill (armed two-step confirm; rows are
 * rebuilt on every poll so the armed state lives in an ArmedSet keyed by id).
 */
import * as st from '../state.ts';
import { el, button, ArmedSet, fmtTime } from './util.ts';
import { killSession, requestTerminalFocus } from './panes.ts';

const armed = new ArmedSet();

/** Attach a session to the focused pane and put the keyboard in its terminal. */
function attachToFocused(sessionId: string): void {
  const t = st.activeTab();
  st.assignPane(t.id, t.focused, sessionId);
  requestTerminalFocus();
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

  function sig(): string {
    if (st.state.drawer !== 'sessions') return 'hidden';
    const tab = st.activeTab();
    // Count prefix so the empty list still differs from the initial ''.
    // Layout is in the prefix: the "pane n" marker depends on slot < tab.layout,
    // and a layout switch changes no per-session field.
    return `n${st.state.sessions.size}L${tab.layout}|` + Array.from(st.state.sessions.values())
      .map(
        (s) =>
          `${s.id}:${st.projectName(s.projectId) ?? ''}:${s.title}:${s.status}:${s.exitCode ?? ''}:` +
          `${s.cols}x${s.rows}:${s.attention ? '!' : ''}:${tab.panes.indexOf(s.id)}:` +
          `${armed.isArmed(s.id) ? 'a' : ''}`,
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
    const tab = st.activeTab();
    const sessions = Array.from(st.state.sessions.values());
    count.textContent = String(sessions.length);

    // Rows are rebuilt wholesale; keep keyboard focus on the same control.
    const focusKey =
      document.activeElement instanceof HTMLElement
        ? document.activeElement.getAttribute('data-k')
        : null;

    const rows: HTMLElement[] = [];
    if (sessions.length === 0) {
      rows.push(el('div', 'drawer-empty', 'no sessions — launch one from an empty pane'));
    }
    for (const info of sessions) {
      const row = el('div', 'sess-row');
      // Double-click anywhere on the row = the attach button (documented in
      // the shortcuts overlay; the button stays the keyboard path).
      row.title = 'double-click: attach to the focused pane';
      row.addEventListener('dblclick', (e) => {
        if (e.target instanceof HTMLElement && e.target.closest('button') !== null) return;
        attachToFocused(info.id);
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
        meta.append(el('span', 'is-ok', 'running'));
      } else {
        const code = info.exitCode ?? 0;
        meta.append(el('span', code === 0 ? '' : 'is-danger', `exit ${code}`));
      }
      meta.append(el('span', '', `${info.cols}×${info.rows}`));
      meta.append(el('span', '', fmtTime(info.createdAt)));
      const slot = tab.panes.indexOf(info.id);
      if (slot !== -1 && slot < tab.layout) {
        meta.append(el('span', 'sess-here', `pane ${slot + 1}`));
      }
      main.append(name, meta);

      const actions = el('div', 'sess-actions');
      const attach = button('row-btn', 'attach', () => attachToFocused(info.id));
      attach.setAttribute('data-k', `attach:${info.id}`);
      attach.title = 'attach to the focused pane';
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
      actions.append(attach, kill);

      row.append(badge, main, actions);
      rows.push(row);
    }
    body.replaceChildren(...rows);

    if (focusKey !== null) {
      body.querySelector<HTMLElement>(`[data-k="${CSS.escape(focusKey)}"]`)?.focus();
    }
  }

  return { render };
}
