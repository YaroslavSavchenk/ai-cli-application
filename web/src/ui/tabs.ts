/**
 * Tab strip (Nocturne A2, rebuilt for A10, re-tabbed by A10b) — every view is a
 * tab, and a tab is
 * about a FOLDER (`Home`, or a project) or about the sessions it holds.
 *
 * A tab: a 7px state dot (pulsing amber = a session in it is waiting for you,
 * green = working, neutral = finished, NOTHING at all when the tab holds no
 * session), the name, an amber dot when a file in it has unsaved text, a count
 * pill when the tab holds more than one PANE (never a tab count: since A10b
 * one editor pane can hold four files and it is still one pane), the words
 * "Needs you" when a session awaits input, and `×`. The active tab is the only
 * filled one. After the tabs: `+` (opens the launch dialog) and the
 * right-aligned drag hint.
 *
 * `Home` is the fixed first tab (user decision 4, 2026-09-15): no `×`, no drag
 * handle, never moved. Everything else is draggable (see ui/dnd.ts): drag onto
 * a pane or another tab to merge into a split, onto strip space to reorder.
 * Every drag has a keyboard/button equivalent (shortcuts overlay).
 *
 * WHAT `×` COSTS. A tab holding sessions ENDS them, so it keeps the armed
 * two-step confirm — unless `Confirm before ending a session` is switched off
 * in Settings (part B6), which makes the first click the act. A folder tab
 * holding only editor panes kills nothing —
 * the panes go away — so no armed two-step stands in the way: nothing running
 * is ended. What DOES stand in the way, since part B4 (user decision D1), is
 * the unsaved-changes question: closing a tab whose files hold text no other
 * tab shows asks before that text goes (`closeViewGuarded`, ui/unsaved.ts).
 * The two are not the same question and never merge: one is about sessions
 * being ended, the other about typing being dropped.
 *
 * `killSession` and `openLaunch` are INJECTED by main.ts rather than imported:
 * both live behind modules that pull in @xterm/xterm, and this strip has to
 * stay drivable under `node --test`.
 */
import * as st from '../state.ts';
import { el, button, ArmedSet } from './util.ts';
import { armDrag } from './dnd.ts';
import { slotTitle, viewLabel } from './slots-model.ts';
import { tabIdOf } from './editor-model.ts';
import { closeViewGuarded } from './unsaved.ts';
import { getBehaviour } from './prefs-model.ts';

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

/**
 * What one pane is called on the chip. An EDITOR pane is called after the tab
 * it is showing (`slotTitle` reads the strip), so raising another file inside
 * a pane renames a plain session tab with it — a folder tab keeps its folder's
 * name whatever its panes show.
 */
function titleOf(slot: st.PaneSlot): string {
  return slot.kind === 'session'
    ? slotTitle(slot, st.state.sessions.get(slot.id)?.title)
    : slotTitle(slot);
}

/**
 * Does any file OPEN IN THIS TAB hold unsaved text? Every tab of every editor
 * pane, not just the ones on screen: a file two chips deep in a strip is as
 * unsaved as the one being looked at, and the chip is the only place that says
 * so from another tab. The key is the TAB's id (`tabIdOf`, the `state.edits`
 * spelling) — never the pane's `slotKey`, which is its own `e:<n>`.
 */
function viewDirty(v: st.ViewState): boolean {
  return v.slots.some(
    (s) => s.kind === 'editor' && s.tabs.some((t) => st.editorDirty(tabIdOf(t))),
  );
}

/**
 * End every session of the view. The view dissolves when the last one goes —
 * unless it is a folder tab, which is about its folder and stays. Editor panes
 * are not ended: they are closed, with every file in them, by the tab itself.
 */
async function killView(v: st.ViewState, deps: TabDeps): Promise<void> {
  for (const id of st.sessionIds(v)) await deps.killSession(id);
  // The tab itself goes with them. Whatever is left in it is an editor pane,
  // and closing a tab puts its files away without ending anything; a session that
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
    // all three change what a chip draws without changing its name. The
    // LABEL covers the rest: raising another file inside an editor pane is a
    // new `tabLabel` for a plain session tab, and no change at all for a
    // folder tab, which is named after its folder.
    const sig = st.state.views
      .map(
        (v) =>
          `${v.id}:${v.root?.kind ?? '-'}:${tabLabel(v)}:${st.viewStatus(v)}:` +
          `${v.slots.map((s) => s.kind).join('')}:${viewDirty(v) ? 'd' : ''}:` +
          `${v.id === st.state.activeViewId ? '*' : ''}:${armed.isArmed(v.id) ? 'a' : ''}:` +
          `${getBehaviour().confirmEnd ? 'c' : ''}`,
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
      const wrap = el(
        'div',
        `tab${v.id === st.state.activeViewId ? ' is-active' : ''}${home ? ' is-home' : ''}`,
      );
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
          // TWO QUESTIONS, NEVER MERGED. The armed two-step is about ENDING
          // sessions and stays on the button; the unsaved-changes question
          // (part B4, D1) is about dropping typed text and stands between the
          // confirmed click and the act. Nothing is ended and nothing is
          // closed until both have been answered.
          const act = (): void => {
            void killView(v, deps);
          };
          if (!kills) {
            closeViewGuarded(v.id, act, close);
            return;
          }
          // `Confirm before ending a session` (B6), read HERE, at click time,
          // so a flip in Settings applies to the strip already on screen. Off =
          // the first click is the act; the unsaved question below still
          // stands, because it is the other question.
          if (
            !getBehaviour().confirmEnd ||
            armed.trigger(v.id, () => {
              lastSig = null;
              render();
            })
          ) {
            closeViewGuarded(v.id, act, close);
          }
        });
        if (armed.isArmed(v.id)) close.dataset.armed = '1';
        close.setAttribute('data-k', `tabx:${v.id}`);
        close.setAttribute('aria-label', `Close tab ${i + 1}`);
        // Two different acts, two different sentences: one ends sessions, the
        // other only puts files away. The confirm is only promised while it is
        // switched on (B6) — a tooltip that names a question nobody will be
        // asked would be a lie about what the button costs.
        close.title = kills
          ? getBehaviour().confirmEnd
            ? 'End the sessions in this tab (asks to confirm)'
            : 'End the sessions in this tab'
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
