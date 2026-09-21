/**
 * The EDITOR PANE (Nocturne part A10b, user decision 1, 2026-09-15): one pane
 * per group of open files, with an inner strip of file tabs in its header —
 * the shape the A6 editor column had, moved onto a pane.
 *
 * WHY A STRIP AND NOT A PANE PER FILE. A10 made every opened file its own
 * pane, so four files filled the tab and the fifth had nowhere to go. A10b
 * gives one pane many tabs: opening a file ADDS a chip, a split happens only
 * when a tab is dragged to an edge. `state.ts` owns that model
 * (`EditorSlot.tabs`), this module owns its DOM.
 *
 * WHAT THIS MODULE MAY IMPORT. state / util / dnd / slots-model /
 * editor-model / file-pane — and NEVER `ui/panes.ts`, which reaches
 * @xterm/xterm and would take `node --test` down with it. The pane's chrome
 * (the card, the header element, the body element, the drop overlay) belongs
 * to panes.ts; what goes INSIDE the header and the body belongs here.
 *
 * THE THREE THINGS THAT COST A REDRAW, AND NOTHING ELSE:
 *
 * 1. THE BODIES ARE KEPT, DETACHED. Every tab's body (`ui/file-pane.ts`) is
 *    built once and parked in a Map when another tab is raised. A detached
 *    `<textarea>` keeps its value, its selection and its scroll offset, so a
 *    round trip through another tab brings the user back to the same caret in
 *    the SAME NODE. Rebuilding it would throw all three away — the A6 lesson,
 *    one level up.
 * 2. THE STRIP IS REBUILT ONLY WHEN IT WOULD LOOK DIFFERENT. `sig` is the tab
 *    ids, which one is active, and each tab's dirty bit; an unchanged
 *    signature means a keystroke costs exactly one `update()` on the active
 *    body (the Save button) and not one DOM node.
 * 3. THE BODY IS SWAPPED ONLY WHEN THE ACTIVE TAB ID CHANGES. A dirty flip
 *    rebuilds the chips (the amber dot moved) and leaves the body alone.
 *
 * KEYBOARD. Every chip is a button and so is every `×`; the strip scrolls
 * rather than pushing the pane's own `×` out of reach, so nothing in this
 * header is pointer-only. `holdsFocus()` is what stops `ui/panes.ts` from
 * throwing the keyboard into the textarea while the user is arrowing across
 * the chips.
 *
 * TAB ID ≠ SLOT KEY. The pane's identity is the slot's own `e:<n>`; a tab's
 * id is `tabIdOf(tab)` and is only ever the key of its unsaved text. Keying
 * the pane on its active tab is what made A10's panes tear themselves down on
 * every switch.
 */
import * as st from '../state.ts';
import { el, button } from './util.ts';
import { armDrag, type DragSpec } from './dnd.ts';
import { tabTitle } from './slots-model.ts';
import { tabIdOf } from './editor-model.ts';
import { diffPaneBody, filePaneBody, type PaneBody } from './file-pane.ts';

/** How `ui/panes.ts` drives one editor pane. */
export interface EditorPane {
  /** Bring the strip and the body in line with the slot as state.ts has it. */
  update(slot: st.EditorSlot, viewId: string, slotIndex: number): void;
  /** Hand the keyboard to the active tab: its text, or its chip for a diff. */
  focus(): void;
  /** Is the keyboard already inside the strip? Then it must not be moved. */
  holdsFocus(): boolean;
  /** Give up every parked body. The header and the body are emptied by panes.ts. */
  dispose(): void;
}

/**
 * What a chip carries while it is dragged (ui/dnd.ts resolves it: a pane edge
 * splits, another editor pane takes the tab over, a terminal refuses).
 *
 * Exported because it is the only way to READ the spec: `armDrag` keeps the
 * factory in a closure, and a test that drove a whole pointer gesture would be
 * proving the drag layer, not this one. The INDEX and the `slotKey` are both
 * in it on purpose — the index is where the tab was picked up, the key says
 * which pane that was, so a drop can tell a moved pane from a moved tab.
 */
export function fileTabSpec(
  viewId: string,
  slot: st.EditorSlot,
  slotIndex: number,
  tabIndex: number,
): DragSpec | null {
  const t = slot.tabs[tabIndex];
  if (t === undefined) return null;
  return {
    kind: 'filetab',
    viewId,
    slot: slotIndex,
    slotKey: st.slotKey(slot),
    tab: tabIndex,
    tabId: tabIdOf(t),
    label: tabTitle(t),
  };
}

/** The `×` that closes the whole pane says what goes with it. */
function closePaneTitle(n: number): string {
  return n === 1 ? 'Close this pane and the file in it' : `Close this pane and its ${n} files`;
}

/**
 * Build the strip into `hd` and take ownership of `body`. Nothing is drawn
 * until the first `update()`: panes.ts builds the pane and then tells it what
 * to show, exactly as it does for a terminal.
 */
export function editorPane(hd: HTMLElement, body: HTMLElement): EditorPane {
  // role=group, not tablist: these chips are not WAI-ARIA tabs (there is no
  // tabpanel relationship to a body that the pane, not the strip, owns), and
  // a lie in the accessibility tree is worse than a plain group of buttons
  // that each say whether they are pressed.
  const strip = el('div', 'pane-tabs');
  strip.setAttribute('role', 'group');
  strip.setAttribute('aria-label', 'open files');
  const closePane = button('pane-x', '×', () => {
    if (slot !== null) st.closeSlot(viewId, slotIndex);
  });
  hd.replaceChildren(strip, el('span', 'pane-gap'), closePane);

  /** Parked bodies, by tab id. The one on screen is in here too. */
  const bodies = new Map<string, PaneBody>();
  /** The chip of each tab id, so `focus()` can reach a diff's chip. */
  let chips = new Map<string, HTMLElement>();
  /** What the strip currently draws; a sentinel no signature can equal. */
  let sig = '\0';
  /** The tab id the body belongs to, '' while the pane shows nothing. */
  let shown = '';
  let slot: st.EditorSlot | null = null;
  let viewId = '';
  let slotIndex = -1;

  function update(next: st.EditorSlot, nextViewId: string, nextSlotIndex: number): void {
    slot = next;
    viewId = nextViewId;
    slotIndex = nextSlotIndex;
    const ids = next.tabs.map((t) => tabIdOf(t));
    const active = Math.min(Math.max(0, next.active), Math.max(0, next.tabs.length - 1));
    const activeId = ids[active] ?? '';
    // The dirty bits are IN the signature: without them the amber dot would
    // appear on the first keystroke of the page and never move again.
    const nextSig = ids.map((id, i) => `${id}~${i === active ? 1 : 0}~${st.editorDirty(id) ? 1 : 0}`).join('|');
    if (nextSig !== sig) {
      sig = nextSig;
      rebuildStrip(next, active);
      closePane.title = closePaneTitle(next.tabs.length);
      closePane.setAttribute('aria-label', closePaneTitle(next.tabs.length));
      // A tab that left takes its parked body with it; keeping it would hand
      // a re-opened file the text of a pane that no longer exists.
      const live = new Set(ids);
      for (const id of [...bodies.keys()]) if (!live.has(id)) bodies.delete(id);
    }
    if (activeId !== shown) {
      shown = activeId;
      const tab = next.tabs[active];
      if (tab === undefined) {
        body.replaceChildren();
        return;
      }
      body.replaceChildren(bodyFor(activeId, tab).root);
      return;
    }
    // Same tab, same strip: the only thing that can have changed under it is
    // the Save button (the text itself lives in the node the user is typing in).
    bodies.get(shown)?.update();
  }

  /** The body of one tab, built once and kept for as long as the tab lives. */
  function bodyFor(id: string, tab: st.EditorTab): PaneBody {
    const known = bodies.get(id);
    if (known !== undefined) return known;
    const made =
      tab.kind === 'file'
        ? filePaneBody(tab.path, () => {
            // The dirty flag FLIPPED: this strip's chip, the pane's own tab
            // chip and the Files panel all read it from state.
            st.notify('ui');
          })
        : diffPaneBody(tab.root, tab.hash, tab.path);
    bodies.set(id, made);
    return made;
  }

  function rebuildStrip(s: st.EditorSlot, active: number): void {
    // The chips are rebuilt under the user's hands; whatever held the keyboard
    // gets it back by its `data-k` (the strip is the one place in a pane where
    // the keyboard lives on something that is redrawn).
    const focusKey =
      document.activeElement instanceof HTMLElement && strip.contains(document.activeElement)
        ? document.activeElement.getAttribute('data-k')
        : null;
    const nodes: HTMLElement[] = [];
    chips = new Map();

    s.tabs.forEach((t, i) => {
      const id = tabIdOf(t);
      const label = tabTitle(t);
      const on = i === active;
      const chip = el('div', `pane-tab${on ? ' is-on' : ''}`);

      const pick = button('pane-tab-pick', label, () => st.setActiveTab(viewId, slotIndex, i));
      pick.setAttribute('data-k', `ptab:${s.id}:${id}`);
      pick.setAttribute('aria-pressed', on ? 'true' : 'false');
      // A chip is narrow and its name is elided; the tooltip is where the rest
      // of it lives (the A10 file header did the same with its path).
      pick.title = t.kind === 'file' ? t.path : label;
      chip.append(pick);

      // A diff is read-only: it can never be unsaved, so it never wears the
      // mark (`state.edits` has no `d:` key by construction).
      if (st.editorDirty(id)) {
        const dot = el('span', 'pane-dirty');
        dot.setAttribute('aria-hidden', 'true');
        // The dot is a shape; the same fact in words for a reader who cannot
        // see it — the tab strip's own idiom (ui/tabs.ts).
        chip.append(dot, el('span', 'sr-only', 'Unsaved changes'));
      }

      const x = button('pane-x', '×', () => st.closeTab(viewId, slotIndex, i));
      x.setAttribute('data-k', `ptabx:${s.id}:${id}`);
      x.setAttribute('aria-label', `Close ${label}`);
      x.title =
        t.kind === 'file' ? 'Close this file (ctrl+alt+w)' : 'Close these changes (ctrl+alt+w)';
      // Closing a tab must never RAISE it first: the chip around this button
      // is a picker, and a `×` that changed what is on screen on its way out
      // would flash the file it is closing.
      x.addEventListener('click', (e) => e.stopPropagation());
      chip.append(x);

      // The chip is the drag source; its `×` keeps its own pointer behaviour.
      // The pane's own header drag (panes.ts, `armDrag(hd, 'button', …)`) is
      // armed on an ANCESTOR, so this handler runs first and the pane drag
      // sees a drag already in flight and stands down.
      armDrag(chip, '.pane-x', () => (slot === null ? null : fileTabSpec(viewId, slot, slotIndex, i)));

      chips.set(id, chip);
      nodes.push(chip);
    });

    strip.replaceChildren(...nodes);
    if (focusKey !== null) {
      strip.querySelector<HTMLElement>(`[data-k="${CSS.escape(focusKey)}"]`)?.focus();
    }
  }

  function focus(): void {
    const tab = slot === null ? null : st.activeTabOf(slot);
    if (tab === null) return;
    const id = tabIdOf(tab);
    // A read-only diff has nothing to type into, so the keyboard lands on its
    // chip — which is what that pane IS (the A6 rule for a diff tab).
    if (tab.kind === 'diff') chips.get(id)?.querySelector<HTMLElement>('.pane-tab-pick')?.focus();
    else bodies.get(id)?.focus();
  }

  function holdsFocus(): boolean {
    return document.activeElement instanceof HTMLElement && strip.contains(document.activeElement);
  }

  function dispose(): void {
    // Without this a pane converted back to an editor would resurrect the
    // textareas of files state.ts has already dropped.
    bodies.clear();
    chips = new Map();
    sig = '\0';
    shown = '';
    slot = null;
  }

  return { update, focus, holdsFocus, dispose };
}
