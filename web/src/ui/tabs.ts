/**
 * Tab strip — every view is a tab, every session lives in a view.
 *
 * A tab row: status dot (green running / amber attention / hollow gray
 * exited / dashed hollow for a launcher tab), faint `n` index (the
 * ctrl+alt+n chord), mono label `project · command` (name from the FIRST
 * session of the view), a blue `+N` chip when the view holds a split,
 * inverse amber `!` badge on attention, and `×` = KILL the view's sessions
 * (armed two-step confirm; a launcher tab just closes). `+` opens a
 * new-session (launcher) tab.
 *
 * Tabs are pointer-drag sources (see ui/dnd.ts): drag onto a pane or another
 * tab to merge into a split, onto strip space to reorder.
 */
import * as st from '../state.ts';
import { el, button, ArmedSet } from './util.ts';
import { armDrag } from './dnd.ts';
import { killSession } from './panes.ts';

const armed = new ArmedSet();

export function tabLabel(v: st.ViewState): string {
  if (v.kind === 'launcher') return 'new session';
  const first = v.sessions[0];
  const info = first !== undefined ? st.state.sessions.get(first) : undefined;
  if (info === undefined) return '…';
  const pname = st.projectName(info.projectId);
  return pname !== null ? `${pname} · ${info.command}` : info.command;
}

/** Kill every session of the view; the view dissolves when the last one goes. */
async function killView(v: st.ViewState): Promise<void> {
  for (const id of [...v.sessions]) await killSession(id);
}

export function initTabs(strip: HTMLElement): { render(): void } {
  let lastSig = '';

  function render(): void {
    // Signature check so 3s polls don't rebuild (and steal focus from) the strip.
    const sig = st.state.views
      .map(
        (v) =>
          `${v.id}:${tabLabel(v)}:${st.viewStatus(v)}:${v.sessions.length}:` +
          `${v.id === st.state.activeViewId ? '*' : ''}:${armed.isArmed(v.id) ? 'a' : ''}`,
      )
      .join('|');
    if (sig === lastSig) return;
    lastSig = sig;

    const focusKey =
      document.activeElement instanceof HTMLElement &&
      strip.contains(document.activeElement)
        ? document.activeElement.getAttribute('data-k')
        : null;

    const nodes: HTMLElement[] = [];
    st.state.views.forEach((v, i) => {
      const wrap = el('div', `tab${v.id === st.state.activeViewId ? ' is-active' : ''}`);
      wrap.dataset.viewId = v.id;

      const sel = button('tab-sel', '', () => st.setActiveView(v.id));
      sel.setAttribute('data-k', `tab:${v.id}`);
      sel.title =
        `switch to tab ${i + 1} (ctrl+alt+${i + 1})` +
        (v.kind === 'launcher' ? '' : ' · drag onto a pane or tab to merge into a split');
      if (v.id === st.state.activeViewId) sel.setAttribute('aria-current', 'true');
      const status = st.viewStatus(v);
      const dot = el('span', `tab-dot is-${status}`);
      dot.setAttribute('aria-hidden', 'true');
      sel.append(dot, el('span', 'tab-idx', String(i + 1)), el('span', 'tab-label', tabLabel(v)));
      if (v.sessions.length > 1) {
        const count = el('span', 'tab-count', `+${v.sessions.length - 1}`);
        count.title = `${v.sessions.length} sessions in this view`;
        sel.append(count);
      }
      wrap.append(sel);

      if (st.viewAttention(v)) {
        const b = el('span', 'badge-attn', '!');
        b.title = 'a session in this tab wants attention';
        wrap.append(b);
      }

      const isLauncher = v.kind === 'launcher';
      const close = button('tab-x', armed.isArmed(v.id) ? 'sure?' : '×', () => {
        if (isLauncher) {
          st.closeView(v.id);
          return;
        }
        if (
          armed.trigger(v.id, () => {
            lastSig = '';
            render();
          })
        ) {
          void killView(v);
        }
      });
      if (armed.isArmed(v.id)) close.dataset.armed = '1';
      close.setAttribute('data-k', `tabx:${v.id}`);
      close.setAttribute('aria-label', `close tab ${i + 1}`);
      close.title = isLauncher ? 'close tab' : 'kill the sessions in this tab (asks to confirm)';
      wrap.append(close);

      armDrag(wrap, '.tab-x', () => ({ kind: 'tab', viewId: v.id, label: tabLabel(v) }));
      nodes.push(wrap);
    });

    const add = button('tab-new', '+', () => st.addLauncherTab());
    add.setAttribute('data-k', 'tab-new');
    add.title = 'new-session tab (ctrl+alt+t)';
    add.setAttribute('aria-label', 'new-session tab');
    nodes.push(add);
    strip.replaceChildren(...nodes);

    if (focusKey !== null) {
      strip.querySelector<HTMLElement>(`[data-k="${CSS.escape(focusKey)}"]`)?.focus();
    }
  }

  return { render };
}
