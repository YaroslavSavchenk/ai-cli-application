/**
 * The row context menu (Nocturne part A9b, user decision 3, 2026-09-16,
 * `.claude/plans/nocturne/PLAN-A9b.md` §3) — the app's first menu primitive, and the DOM half
 * of `ui/context-menu-model.ts`.
 *
 * DESIGN BRIEF (the direction, in one sentence): the menu is the Files row
 * itself, lifted one surface — the same 26px row rhythm (`--files-row-h`), the
 * same 12.5px left-aligned ink, the same `--color-neutral-900` hover — on a
 * `--color-bg` card with the popover's hairline-and-ambient elevation
 * (`--shadow-md`, `--radius-md`, `fadeUp .14s`), so it reads as a continuation
 * of the tree the pointer is standing in rather than as a floating widget
 * borrowed from somewhere else. No icons, no check marks, no counts: four
 * entries and three entries are a list, not a toolbar.
 *
 * ONE SEPARATOR EXISTS (B10a), and only above `Delete`: a 1px neutral hairline
 * with the block's own spacing around it, drawn because that entry is the only
 * one in the app that cannot be taken back. It is appended to the CARD, never
 * to the entry list, so the roving focus is exactly what it was.
 *
 * WHAT IT IS NOT. Not a modal: no scrim, no `.modal-scrim` (which is how
 * `ui/keys.ts` recognises a dialog — a menu that wore it would make every pane
 * a dead drop target and stop the terminal taking the keyboard back), no
 * `aria-modal`, no tab trap. Tab is not trapped on purpose: focus leaving the
 * menu closes it, which is the same answer with none of the machinery.
 *
 * ONE AT A TIME, created on open and removed on close — `ui/picker.ts`'s
 * idiom, and the reason a stale menu can never survive a rebuild of the rows
 * it was opened from (`ui/files.ts` calls `closeRowMenu()` at the top of its
 * own `rebuild()`).
 *
 * WHERE IT OPENS is `menuPosition()`, a pure function, because
 * `tests/helpers/fake-dom.ts` measures nothing: this module measures ONCE after
 * appending and applies the point that function returns. Flip before clamp, so
 * a menu near the right edge opens leftward and one near the bottom opens
 * upward — the pointer keeps standing on the row it belongs to.
 *
 * IT CHANGES NO LAYOUT. `position: fixed` on `document.body`, like the drag
 * ghost: nothing in the pane grid moves by a pixel, so no ResizeObserver
 * fires and no PTY is resized because a menu opened (the A9 rule).
 *
 * THE FOCUS RING IS `:focus`, NOT `:focus-visible`, in this block alone: the
 * roving focus IS the menu's selected row, and a menu opened with the pointer
 * would otherwise show no selected entry at all while the arrow keys move it.
 */
import { el, button } from './util.ts';
import {
  menuPosition,
  nextItem,
  type MenuAction,
  type MenuItem,
} from './context-menu-model.ts';

/** What `ui/files.ts` hands over to open a menu on one row. */
export interface RowMenuRequest {
  /** The entries, from `itemsFor()` — the model decides them, never this file. */
  items: readonly MenuItem[];
  /** Where it was asked for: the pointer, or the row's leading edge and bottom. */
  at: { x: number; y: number };
  /** The menu's accessible name, from `menuLabel()` — a NAME, never a path. */
  label: string;
  /** Where the keyboard goes when the menu closes, when it is still on screen. */
  returnFocus: HTMLElement | null;
  /** An ENABLED entry was chosen. Disabled entries never call this. */
  onChoose(action: MenuAction): void;
}

/** The open menu, or nothing. One at a time — the picker's rule. */
let menu: HTMLElement | null = null;
/** Its entries, in reading order, for the roving focus. */
let entries: HTMLButtonElement[] = [];
/** Where the keyboard came from, when it is still connected at close time. */
let restore: HTMLElement | null = null;
/**
 * Every listener this menu put on the window and the document, each paired
 * with the call that takes it off again. A menu is created and destroyed on
 * every gesture, so a listener that outlived one would be a leak that grows
 * for as long as the app is open — and a stale Escape handler that swallows
 * the key for a menu nobody can see.
 */
let listeners: (() => void)[] = [];

export function isRowMenuOpen(): boolean {
  return menu !== null;
}

/**
 * Take the menu away and hand the keyboard back to the row it came from — but
 * only when that row is still on screen (`ui/picker.ts`'s rule): a rebuild may
 * have replaced it, and focusing a detached element drops the keyboard on
 * `<body>`, where no key reaches anything.
 */
export function closeRowMenu(): void {
  if (menu === null) return;
  for (const off of listeners) off();
  listeners = [];
  entries = [];
  menu.remove();
  menu = null;
  const back = restore;
  restore = null;
  if (back !== null && back.isConnected) back.focus();
}

export function openRowMenu(req: RowMenuRequest): void {
  closeRowMenu(); // one menu at a time, whatever opened the last one
  restore = req.returnFocus;

  const box = el('div', 'cm-menu');
  box.setAttribute('role', 'menu');
  box.setAttribute('aria-label', req.label);

  entries = req.items.map((item, i) => {
    const b = button('cm-item', '', () => choose(item, req.onChoose));
    b.setAttribute('role', 'menuitem');
    b.tabIndex = i === 0 ? 0 : -1;
    // The one entry that cannot be taken back (B10a: `Delete`) is danger INK
    // on the same ground as every other entry — never a red fill, which would
    // turn a list into a warning.
    if (item.danger === true) b.classList.add('is-danger');
    b.append(el('span', 'cm-label', item.label));
    if (!item.enabled) {
      // `aria-disabled`, NEVER the `disabled` attribute (user decision 3): the
      // arrows must still reach the entry, because the one-line explanation
      // under its label is the entire reason it is on the menu at all.
      b.setAttribute('aria-disabled', 'true');
      if (item.note !== undefined) b.append(el('span', 'cm-sub', item.note));
    }
    return b;
  });
  // The hairline above a `separated` entry is appended to the BOX, never to
  // `entries` (B10a): the roving focus walks `entries`, so a separator that
  // was one would be an arrow stop with nothing to activate. It is a
  // `role="separator"` div, which is what a menu's own grouping mark is.
  req.items.forEach((item, i) => {
    if (item.separated === true) box.append(separator());
    box.append(entries[i] as HTMLButtonElement);
  });

  box.addEventListener('keydown', onMenuKey);
  document.body.append(box);
  menu = box;

  // MEASURE ONCE, then place. The stylesheet parks the card at the viewport's
  // top-left so what is measured is its natural size, not a box squeezed by
  // the edge it happens to be near.
  const size = box.getBoundingClientRect();
  const at = menuPosition(
    req.at,
    { w: size.width, h: size.height },
    { w: window.innerWidth, h: window.innerHeight },
  );
  box.style.left = `${at.x}px`;
  box.style.top = `${at.y}px`;

  entries[0]?.focus();

  // ---- everything that closes it ------------------------------------------

  // Escape, on a WINDOW CAPTURE listener that stops the key (the `ui/launch.ts`
  // popover idiom): main.ts's Escape ladder is a BUBBLE listener on the same
  // window, so this runs first and that ladder never sees the key — the menu
  // closes without also closing the Files panel behind it.
  on(window, 'keydown', (e) => {
    const ev = e as KeyboardEvent;
    if (ev.key !== 'Escape') return;
    ev.preventDefault();
    ev.stopPropagation();
    closeRowMenu();
  }, true);

  // A press anywhere outside closes it, and then does whatever it does — the
  // press is not swallowed, exactly as the permissions popover behaves.
  on(document, 'pointerdown', (e) => {
    const t = e.target;
    if (t instanceof Node && box.contains(t)) return;
    closeRowMenu();
  }, true);

  // The keyboard moving anywhere else (Tab out of the menu, a click that
  // focuses something behind it) closes it: a focused control under a menu is
  // a focus ring nobody can see.
  on(document, 'focusin', (e) => {
    const t = e.target;
    if (t instanceof Node && box.contains(t)) return;
    closeRowMenu();
  }, false);

  // The browser's OWN `contextmenu` for the key that opened this menu. Windows
  // sends WM_CONTEXTMENU off the APPS key even when the keydown was prevented,
  // and by then the keyboard is on the first entry — so the event's target is
  // INSIDE the menu, where `ui/files.ts`'s delegated listener on the panel root
  // can never see it (the card lives on `document.body`). Unprevented, the
  // system menu would open on top of ours. It is swallowed, not acted on: the
  // menu the key asked for is already up.
  on(box, 'contextmenu', (e) => {
    e.preventDefault();
  }, false);

  // The menu is fixed to the VIEWPORT and anchored to a row that scrolls: the
  // tree body scrolling under it would leave it pointing at a different row.
  // Capture, because a scroll event does not bubble.
  on(document, 'scroll', closeRowMenu, true);
  // A resized window re-lays out everything the point was computed from.
  on(window, 'resize', closeRowMenu, false);
  // The user went to another window (Explorer, to copy the files they came
  // here for): a menu waiting behind it is a menu they will not expect back.
  on(window, 'blur', closeRowMenu, false);
}

/**
 * The hairline between the ordinary entries and the one that cannot be undone.
 * A `<div role="separator">`, not a `<hr>`: it carries no focus, no label and
 * no margin of its own beyond the block's, and a screen reader hears it as the
 * grouping mark it is.
 */
function separator(): HTMLElement {
  const sep = el('div', 'cm-sep');
  sep.setAttribute('role', 'separator');
  return sep;
}

/** Register a listener and remember how to remove it. */
function on(
  target: EventTarget,
  type: string,
  fn: (e: Event) => void,
  capture: boolean,
): void {
  target.addEventListener(type, fn, capture);
  listeners.push(() => target.removeEventListener(type, fn, capture));
}

/**
 * An entry was activated. A DISABLED one does nothing at all and the menu
 * STAYS OPEN — its note is the answer, and taking the menu away would hide the
 * only sentence that explains why the entry cannot work yet.
 *
 * An enabled one closes FIRST and acts second: closing hands the keyboard back
 * to the row, and the action that follows (a folder toggle, a file opening)
 * rebuilds those rows and restores the focus by `data-k` from there.
 */
function choose(item: MenuItem, onChoose: (action: MenuAction) => void): void {
  if (!item.enabled) return;
  closeRowMenu();
  onChoose(item.action);
}

/** Roving focus: arrows wrap, Home/End jump, Enter and Space activate. */
function onMenuKey(e: Event): void {
  const ev = e as KeyboardEvent;
  const from = entries.findIndex((b) => b === document.activeElement);
  const count = entries.length;
  if (count === 0) return;
  let to: number | null = null;
  if (ev.key === 'ArrowDown') to = nextItem(count, from === -1 ? -1 : from, 1);
  else if (ev.key === 'ArrowUp') to = nextItem(count, from === -1 ? 0 : from, -1);
  else if (ev.key === 'Home') to = 0;
  else if (ev.key === 'End') to = count - 1;
  if (to !== null) {
    ev.preventDefault();
    ev.stopPropagation();
    focusAt(to);
    return;
  }
  if (ev.key !== 'Enter' && ev.key !== ' ') return;
  // `preventDefault()` FIRST, then the click: a browser's own activation of a
  // `<button>` is the default action of this very key (Enter on keydown, Space
  // on keyup), so cancelling it is what keeps one keystroke one activation —
  // and the click below is then the single path, the same one the pointer
  // takes and the only one `node --test` can see (the fake DOM activates
  // nothing by itself).
  ev.preventDefault();
  ev.stopPropagation();
  entries[from === -1 ? 0 : from]?.click();
}

/** Move the roving tabindex and the keyboard to one entry. */
function focusAt(i: number): void {
  entries.forEach((b, j) => {
    b.tabIndex = j === i ? 0 : -1;
  });
  entries[i]?.focus();
}
