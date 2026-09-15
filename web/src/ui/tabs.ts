/**
 * Tab strip (Nocturne A2, rebuilt for A10) — every view is a tab, and a tab is
 * about a FOLDER (`Home`, or a project) or about the sessions it holds.
 *
 * A tab: a 7px state dot (pulsing amber = a session in it is waiting for you,
 * green = working, neutral = finished, NOTHING at all when the tab holds no
 * session), the name, an amber dot when a file in it has unsaved text, a count
 * pill when the tab holds more than one pane, the words "Needs you" when a
 * session awaits input, and `×`. The active tab is the only filled one. After
 * the tabs: `+` (opens the launch dialog) and the right-aligned drag hint.
 *
 * `Home` is the fixed first tab (user decision 4, 2026-09-15): no `×`, no drag
 * handle, never moved. Everything else is draggable (see ui/dnd.ts): drag onto
 * a pane or another tab to merge into a split, onto strip space to reorder.
 * Every drag has a keyboard/button equivalent (shortcuts overlay).
 *
 * WHAT `×` COSTS. A tab holding sessions ENDS them, so it keeps the armed
 * two-step confirm. A folder tab holding only files and diffs kills nothing —
 * the panes go away, and the unsaved text goes with them for good (the amber
 * dot is the only warning until part B4 adds the confirm), so no armed
 * two-step stands in the way: nothing running is ended.
 *
 * `killSession` and `openLaunch` are INJECTED by main.ts rather than imported:
 * both live behind modules that pull in @xterm/xterm, and this strip has to
 * stay drivable under `node --test`.
 */
import * as st from '../state.ts';
import { el, button, ArmedSet } from './util.ts';
import { armDrag } from './dnd.ts';
import { slotTitle, viewLabel } from './slots-model.ts';

const armed = new ArmedSet();

export interface TabDeps {
  /** End one session (ui/panes.ts `killSession`). */
  killSession(id: string): Promise<void> | void;
  /** Open the New session dialog (ui/launch.ts). */
  openLaunch(): void;
}

/**
 * The tab's name: the root's own name — `Home`, or the PROJECT's name, never
 * its path — and for a plain session tab its panes' names, joined by a comma
 * and a space (plain language, no decorative separator; README-v3 copy rules).
 */
export function tabLabel(v: st.ViewState): string {
  return viewLabel(v.root, (id) => st.projectName(id), v.slots.map(titleOf));
}

function titleOf(slot: st.PaneSlot): string {
  return slot.kind === 'session'
    ? slotTitle(slot, st.state.sessions.get(slot.id)?.title)
    : slotTitle(slot);
}

/** Does any FILE pane of this tab hold unsaved text? */
function viewDirty(v: st.ViewState): boolean {
  return v.slots.some((s) => s.kind === 'file' && st.editorDirty(st.slotKey(s)));
}

/**
 * End every session of the view. The view dissolves when the last one goes —
 * unless it is a folder tab, which is about its folder and stays. File and
 * diff panes are not ended: they are closed with the tab itself.
 */
async function killView(v: st.ViewState, deps: TabDeps): Promise<void> {
  for (const id of st.sessionIds(v)) await deps.killSession(id);
  // The tab itself goes with them. Whatever is left in it is a file or a diff,
  // and closing a tab puts those away without ending anything; a session that
  // could NOT be killed (the server refused) keeps its tab, which is the one
  // state where this must not close. `Home` refuses, as decision 4 asks.
  const still = st.state.views.find((x) => x.id === v.id);
  if (still !== undefined && st.sessionIds(still).length === 0) st.closeView(v.id);
}

export function initTabs(strip: HTMLElement, deps: TabDeps): { render(): void } {
  // `null`, not '': with no tabs at all the signature IS the empty string, and
  // starting from '' made the very first render a no-op — an empty app booted
  // with a strip that held neither the `+` nor the hint until a session opened.
  let lastSig: string | null = null;

  function render(): void {
    // Signature check so 3s polls don't rebuild (and steal focus from) the
    // strip. It carries the root, the pane KINDS and the dirty flag, because
    // all three change what a chip draws without changing its name.
    const sig = st.state.views
      .map(
        (v) =>
          `${v.id}:${v.root?.kind ?? '-'}:${tabLabel(v)}:${st.viewStatus(v)}:` +
          `${v.slots.map((s) => s.kind).join('')}:${viewDirty(v) ? 'd' : ''}:` +
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
      const home = v.root?.kind === 'home';
      const wrap = el('div', `tab${v.id === st.state.activeViewId ? ' is-active' : ''}`);
      wrap.dataset.viewId = v.id;

      const sel = button('tab-sel', '', () => st.setActiveView(v.id));
      sel.setAttribute('data-k', `tab:${v.id}`);
      sel.title = home
        ? `Go to the Home tab (ctrl+alt+${i + 1}).`
        : `Go to tab ${i + 1} (ctrl+alt+${i + 1}). Drag it onto a pane or another tab to show them side by side.`;
      if (v.id === st.state.activeViewId) sel.setAttribute('aria-current', 'true');
      const status = st.viewStatus(v);
      // No session in this tab, no state to report: a dot there would be a
      // readout of nothing.
      if (status !== 'none') {
        const dot = el('span', `dot is-${status}`);
        dot.setAttribute('aria-hidden', 'true');
        sel.append(dot);
      }
      sel.append(el('span', 'tab-label', tabLabel(v)));
      if (viewDirty(v)) {
        const dirty = el('span', 'tab-dirty');
        dirty.setAttribute('aria-hidden', 'true');
        sel.append(dirty, el('span', 'sr-only', 'Unsaved changes'));
        sel.title = `${sel.title} A file in it has unsaved changes.`;
      }
      if (v.slots.length > 1) {
        const count = el('span', 'tab-count', String(v.slots.length));
        count.title = `${v.slots.length} panes in this tab`;
        sel.append(count);
      }
      if (st.viewAttention(v)) {
        const pill = el('span', 'tab-attn', 'Needs you');
        pill.title = 'A session in this tab is waiting for your answer';
        sel.append(pill);
      }
      wrap.append(sel);

      // Home is never closed and never dragged (user decision 4): it is the
      // one place that is always there.
      if (!home) {
        const kills = st.sessionIds(v).length > 0;
        const close = button('tab-x', armed.isArmed(v.id) ? 'sure?' : '×', () => {
          if (!kills) {
            void killView(v, deps);
            return;
          }
          if (
            armed.trigger(v.id, () => {
              lastSig = null;
              render();
            })
          ) {
            void killView(v, deps);
          }
        });
        if (armed.isArmed(v.id)) close.dataset.armed = '1';
        close.setAttribute('data-k', `tabx:${v.id}`);
        close.setAttribute('aria-label', `Close tab ${i + 1}`);
        // Two different acts, two different sentences: one ends sessions, the
        // other only puts files away.
        close.title = kills
          ? 'End the sessions in this tab (asks to confirm)'
          : 'Close this tab. Nothing is ended.';
        wrap.append(close);

        armDrag(wrap, '.tab-x', () => ({ kind: 'tab', viewId: v.id, label: tabLabel(v) }));
      }
      nodes.push(wrap);
    });

    const add = button('tab-new', '+', () => deps.openLaunch());
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
