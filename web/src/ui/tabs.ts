/**
 * Tab strip, tmux-window style: `n:name` per tab, inverse amber `!` badge
 * when any session in the tab has attention, `×` to close, `+` to create.
 * The name is the project (or command) of the first occupied pane.
 */
import * as st from '../state.ts';
import { el, button } from './util.ts';

function tabName(t: st.TabState): string {
  for (const id of t.panes) {
    if (id === null) continue;
    const s = st.state.sessions.get(id);
    if (s !== undefined) return st.projectName(s.projectId) ?? s.command;
  }
  return '—';
}

export function initTabs(strip: HTMLElement): { render(): void } {
  let lastSig = '';

  function render(): void {
    // Signature check so 3s polls don't rebuild (and steal focus from) the strip.
    const sig = st.state.tabs
      .map(
        (t) =>
          `${t.id}:${tabName(t)}:${st.tabAttention(t) ? '!' : ''}:${t.id === st.state.activeTabId ? '*' : ''}`,
      )
      .join('|');
    if (sig === lastSig) return;
    lastSig = sig;

    const nodes: HTMLElement[] = [];
    st.state.tabs.forEach((t, i) => {
      const wrap = el('div', `tab${t.id === st.state.activeTabId ? ' is-active' : ''}`);
      const sel = button('tab-sel', `${i + 1}:${tabName(t)}`, () => st.setActiveTab(t.id));
      sel.title = `switch to tab ${i + 1} (ctrl+alt+${i + 1})`;
      if (t.id === st.state.activeTabId) sel.setAttribute('aria-current', 'true');
      wrap.append(sel);
      if (st.tabAttention(t)) {
        const b = el('span', 'badge-attn', '!');
        b.title = 'a session in this tab wants attention';
        wrap.append(b);
      }
      const close = button('tab-x', '×', () => st.closeTab(t.id));
      close.setAttribute('aria-label', `close tab ${i + 1}`);
      close.title = 'close tab (sessions keep running)';
      wrap.append(close);
      nodes.push(wrap);
    });
    const add = button('tab-new', '+', () => st.addTab());
    add.title = 'new tab (ctrl+alt+t)';
    add.setAttribute('aria-label', 'new tab');
    nodes.push(add);
    strip.replaceChildren(...nodes);
  }

  return { render };
}
