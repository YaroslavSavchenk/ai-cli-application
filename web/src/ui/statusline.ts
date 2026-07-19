/**
 * Bottom statusline: pure readout. Left — tab/pane index and the focused
 * session (project · title · cols×rows · connection state). Right — flash
 * messages (inverse block, transient) and the always-visible help hint.
 */
import * as st from '../state.ts';
import type { ConnState } from '../ws.ts';
import { el } from './util.ts';

interface Deps {
  getFocusedConn(): ConnState | null;
}

let root: HTMLElement | null = null;
let deps: Deps | null = null;
let flashMsg: string | null = null;
let flashTimer: number | null = null;
let unreachable = false;

/**
 * Poll-driven backend health readout. Repeated network failures show
 * "backend: unreachable"; the first successful poll clears it. 401/403
 * escalates to the full-page reload panel instead (main.ts).
 */
export function setBackendReachable(ok: boolean): void {
  if (unreachable === !ok) return;
  unreachable = !ok;
  render();
}

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
  return { render };
}

export function render(): void {
  if (root === null || deps === null) return;
  const tab = st.activeTab();
  const tabIdx = st.state.tabs.indexOf(tab) + 1;
  const left = el('div', 'status-left');
  left.append(el('span', 'status-seg', `tab ${tabIdx}/${st.state.tabs.length}`));
  left.append(el('span', 'status-seg', `pane ${tab.focused + 1}/${tab.layout}`));

  const sessionId = tab.panes[tab.focused] ?? null;
  const info = sessionId !== null ? st.state.sessions.get(sessionId) : undefined;
  if (info !== undefined) {
    const pname = st.projectName(info.projectId);
    left.append(
      el('span', 'status-seg status-strong', pname !== null ? `${pname} · ${info.title}` : info.title),
    );
    left.append(el('span', 'status-seg', `${info.cols}×${info.rows}`));
    if (info.status === 'exited') {
      left.append(el('span', 'status-seg status-danger', `exit ${info.exitCode ?? 0}`));
    } else {
      const conn = deps.getFocusedConn();
      const cls =
        conn === 'live' ? 'status-ok' : conn === 'dead' ? 'status-danger' : 'status-warn';
      left.append(el('span', `status-seg ${cls}`, conn ?? 'connecting'));
    }
  } else {
    left.append(el('span', 'status-seg', 'empty pane — ctrl+alt+enter launches'));
  }

  const right = el('div', 'status-right');
  if (unreachable) {
    right.append(el('span', 'status-seg status-danger', 'backend: unreachable'));
  }
  if (flashMsg !== null) {
    right.append(el('span', 'status-flash', flashMsg));
  }
  right.append(el('span', 'status-seg', '? shortcuts'));

  root.replaceChildren(left, right);
}
