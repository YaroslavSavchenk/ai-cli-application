/**
 * Bottom tab strip (handoff §4, Steam-style) — every view is a tab, every
 * session lives in a view.
 *
 * A tab: status dot (green running / pulsing amber attention / hollow gray
 * exited / dashed hollow launcher), mono name (a split view joins member
 * names with " · "), a blue `▦ N` split badge when the view holds >1
 * session, a pulsing amber `input` pill when a member awaits input, and `×`
 * = KILL the view's sessions (armed two-step confirm; a launcher tab just
 * closes). The active tab drops to the terminal ground and carries the
 * glowing accent bar. After the tabs: a ghost `+` (opens the launcher tab)
 * and the right-aligned drag hint.
 *
 * Tabs are pointer-drag sources (see ui/dnd.ts): drag onto a pane or another
 * tab to merge into a split, onto strip space to reorder. Every drag has a
 * keyboard/button equivalent (shortcuts overlay).
 */
import * as st from '../state.ts';
import { el, button, ArmedSet } from './util.ts';
import { armDrag } from './dnd.ts';
import { killSession } from './panes.ts';

const armed = new ArmedSet();

export function tabLabel(v: st.ViewState): string {
  if (v.kind === 'launcher') return 'new session';
  const names = v.sessions.map((id) => st.state.sessions.get(id)?.title ?? '…');
  return names.join(' · ');
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
      document.activeElement instanceof HTMLElement && strip.contains(document.activeElement)
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
      const dot = el('span', `dot is-${status}`);
      dot.setAttribute('aria-hidden', 'true');
      sel.append(dot, el('span', 'tab-label', tabLabel(v)));
      if (v.sessions.length > 1) {
        const split = el('span', 'tab-split', `▦ ${v.sessions.length}`);
        split.title = `${v.sessions.length} sessions in this view`;
        sel.append(split);
      }
      if (st.viewAttention(v)) {
        const pill = el('span', 'tab-input', 'input');
        pill.title = 'a session in this tab wants attention';
        sel.append(pill);
      }
      wrap.append(sel);

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

    const gap = el('span', 'strip-gap');
    const hint = el('span', 'strip-hint', 'drag a tab onto a tab or pane to merge · ⇱ splits it back out');
    nodes.push(gap, hint);

    strip.replaceChildren(...nodes);

    if (focusKey !== null) {
      strip.querySelector<HTMLElement>(`[data-k="${CSS.escape(focusKey)}"]`)?.focus();
    }
  }

  return { render };
}
