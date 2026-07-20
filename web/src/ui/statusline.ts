/**
 * Statusline (handoff §5): 23px mono readout, bg #10141a via tokens.
 *
 * Left: `ws <n> ms` (presence ping round-trip), `<n> sessions · <n> panes`,
 * amber `<n> awaiting input` when >0, then the focused-session readout
 * (project · title · cols×rows · connection state — carried over, it is
 * information). Right: transient flash notices (inverse block), `up
 * HH:MM:SS` (GET /api/runtime startedAt, ticked locally every second),
 * `pty ok` (health-derived — replaced by a red `backend unreachable` when
 * the poll fails repeatedly), and the `?` shortcuts hint as a real button.
 *
 * Deliberately NO separate "healthy" item (the topbar dot covers
 * connection) and NO grace countdown (lifecycle fiction — a page able to
 * show it would itself be keeping the backend alive).
 */
import * as st from '../state.ts';
import type { ConnState } from '../ws.ts';
import { el, fmtUptime } from './util.ts';

interface Deps {
  getFocusedConn(): ConnState | null;
  openShortcuts(): void;
}

let root: HTMLElement | null = null;
let deps: Deps | null = null;
let flashMsg: string | null = null;
let flashTimer: number | null = null;
/** Mutable `up …` span — the 1s ticker updates it without a full rebuild. */
let upSeg: HTMLElement | null = null;

export function flash(msg: string): void {
  flashMsg = msg;
  if (flashTimer !== null) clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => {
    flashMsg = null;
    flashTimer = null;
    render();
  }, 3000);
  render();
}

export function initStatusline(container: HTMLElement, d: Deps): { render(): void } {
  root = container;
  deps = d;
  window.setInterval(() => {
    if (upSeg !== null && st.state.serverStartedAt !== null) {
      upSeg.textContent = `up ${fmtUptime(st.state.serverStartedAt)}`;
    }
  }, 1000);
  return { render };
}

export function render(): void {
  if (root === null || deps === null) return;
  const left = el('div', 'status-left');

  const lat = st.state.wsLatencyMs;
  left.append(el('span', 'status-seg', lat !== null ? `ws ${lat} ms` : 'ws —'));

  const v = st.activeView();
  const paneCount = v === null || v.kind === 'launcher' ? 0 : v.sessions.length;
  left.append(el('span', 'status-seg', `${st.state.sessions.size} sessions · ${paneCount} panes`));

  const attn = st.attentionCount();
  if (attn > 0) left.append(el('span', 'status-seg status-attn', `${attn} awaiting input`));

  if (v !== null) {
    if (v.kind === 'launcher') {
      left.append(el('span', 'status-seg', 'new session — pick a project and launch'));
    } else {
      const sessionId = v.sessions[v.focused] ?? null;
      const info = sessionId !== null ? st.state.sessions.get(sessionId) : undefined;
      if (info !== undefined) {
        const pname = st.projectName(info.projectId);
        left.append(
          el(
            'span',
            'status-seg status-strong',
            pname !== null ? `${pname} · ${info.title}` : info.title,
          ),
        );
        left.append(el('span', 'status-seg', `${info.cols}×${info.rows}`));
        if (info.status === 'exited') {
          const code = info.exitCode ?? 0;
          left.append(
            el('span', 'status-seg status-danger', code === 0 ? 'exited' : `exited · ${code}`),
          );
        } else {
          const conn = deps.getFocusedConn();
          const cls =
            conn === 'live' ? 'status-ok' : conn === 'dead' ? 'status-danger' : 'status-warn';
          left.append(el('span', `status-seg ${cls}`, conn ?? 'connecting'));
        }
      }
    }
  }

  const right = el('div', 'status-right');
  if (flashMsg !== null) {
    right.append(el('span', 'status-flash', flashMsg));
  }
  upSeg = el(
    'span',
    'status-seg',
    st.state.serverStartedAt !== null ? `up ${fmtUptime(st.state.serverStartedAt)}` : 'up —',
  );
  right.append(upSeg);
  right.append(
    st.state.backendReachable
      ? el('span', 'status-seg', 'pty ok')
      : el('span', 'status-seg status-danger', 'backend unreachable'),
  );

  const hadFocus =
    document.activeElement instanceof HTMLElement &&
    document.activeElement.getAttribute('data-k') === 'status-help';
  const hint = el('button', 'status-hint');
  hint.type = 'button';
  hint.setAttribute('data-k', 'status-help');
  hint.title = 'keyboard shortcuts (? or ctrl+alt+/)';
  hint.append(el('kbd', '', '?'), el('span', '', 'shortcuts'));
  hint.addEventListener('click', () => deps?.openShortcuts());
  right.append(hint);

  root.replaceChildren(left, right);
  if (hadFocus) hint.focus();
}
