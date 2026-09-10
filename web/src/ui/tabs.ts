/**
 * Tab strip (Nocturne A2) — every view is a tab, every session lives in a view.
 *
 * A tab: a 7px state dot (pulsing amber = a member is waiting for you, green =
 * working, neutral = finished), the name (a multi-session tab joins its
 * members' names with a comma), a count pill when the tab holds more than one
 * session, the words "Needs you" when one of them awaits input, and `×` = END
 * the tab's sessions (armed two-step confirm). The active tab is the only
 * filled one. After the tabs: `+` (opens the launch dialog) and the
 * right-aligned drag hint.
 *
 * Tabs are pointer-drag sources (see ui/dnd.ts): drag onto a pane or another
 * tab to merge into a split, onto strip space to reorder. Every drag has a
 * keyboard/button equivalent (shortcuts overlay).
 */
import * as st from '../state.ts';
import { el, button, ArmedSet } from './util.ts';
import { armDrag } from './dnd.ts';
import { killSession } from './panes.ts';
import { openLaunchDialog } from './launch.ts';

const armed = new ArmedSet();

/**
 * The tab's name: the members' own names, joined by a comma and a space —
 * plain language, no decorative separator (README-v3 copy rules; the same rule
 * the v3 reference applies to a multi-session tab).
 */
export function tabLabel(v: st.ViewState): string {
  const names = v.sessions.map((id) => st.state.sessions.get(id)?.title ?? '…');
  return names.join(', ');
}

/** End every session of the view; the view dissolves when the last one goes. */
async function killView(v: st.ViewState): Promise<void> {
  for (const id of [...v.sessions]) await killSession(id);
}

export function initTabs(strip: HTMLElement): { render(): void } {
  // `null`, not '': with no tabs at all the signature IS the empty string, and
  // starting from '' made the very first render a no-op — an empty app booted
  // with a strip that held neither the `+` nor the hint until a session opened.
  let lastSig: string | null = null;

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
      sel.title = `Go to tab ${i + 1} (ctrl+alt+${i + 1}). Drag it onto a pane or another tab to show them side by side.`;
      if (v.id === st.state.activeViewId) sel.setAttribute('aria-current', 'true');
      const status = st.viewStatus(v);
      const dot = el('span', `dot is-${status}`);
      dot.setAttribute('aria-hidden', 'true');
      sel.append(dot, el('span', 'tab-label', tabLabel(v)));
      if (v.sessions.length > 1) {
        const count = el('span', 'tab-count', String(v.sessions.length));
        count.title = `${v.sessions.length} sessions in this tab`;
        sel.append(count);
      }
      if (st.viewAttention(v)) {
        const pill = el('span', 'tab-attn', 'Needs you');
        pill.title = 'A session in this tab is waiting for your answer';
        sel.append(pill);
      }
      wrap.append(sel);

      const close = button('tab-x', armed.isArmed(v.id) ? 'sure?' : '×', () => {
        if (
          armed.trigger(v.id, () => {
            lastSig = null;
            render();
          })
        ) {
          void killView(v);
        }
      });
      if (armed.isArmed(v.id)) close.dataset.armed = '1';
      close.setAttribute('data-k', `tabx:${v.id}`);
      close.setAttribute('aria-label', `Close tab ${i + 1}`);
      close.title = 'End the sessions in this tab (asks to confirm)';
      wrap.append(close);

      armDrag(wrap, '.tab-x', () => ({ kind: 'tab', viewId: v.id, label: tabLabel(v) }));
      nodes.push(wrap);
    });

    const add = button('tab-new', '+', () => openLaunchDialog());
    add.setAttribute('data-k', 'tab-new');
    add.title = 'New session (ctrl+alt+t)';
    add.setAttribute('aria-label', 'New session');
    nodes.push(add);

    const gap = el('span', 'strip-gap');
    const hint = el('span', 'strip-hint', 'Drag a tab onto another to show them side by side');
    nodes.push(gap, hint);

    strip.replaceChildren(...nodes);

    if (focusKey !== null) {
      strip.querySelector<HTMLElement>(`[data-k="${CSS.escape(focusKey)}"]`)?.focus();
    }
  }

  return { render };
}
