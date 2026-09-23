/**
 * The New session dialog's building blocks: the card radiogroup every card
 * grid in it is made of (Tool, Permissions, Shell), the group label those
 * grids point at, the per-tool select filler, and the two small tables the
 * dialog reads before the backend has said anything (`ASSUMED`) and when it
 * decides whether a tool needs the key notice (`keyToolFor`).
 *
 * Split from `ui/launch.ts` (O8, 2026-09-23), code moved as it stood; the
 * last three were closure-local helpers of `initLaunchDialog()` that read
 * nothing of its state, now module-level. Sibling: `launch.ts` (the dialog).
 */
import type { KeyedTool, ToolAvailability } from '../../../shared/protocol.ts';
import { el, button } from './util.ts';
import type { Choice, LaunchKind } from './launch-args.ts';


/** One card of a card radiogroup. */
interface CardSpec<T extends string> {
  /** The value the card selects. */
  value: T;
  /** Extra class on the card (the danger mode). */
  cls?: string;
  /** The tile before the words, decoration only (aria-hidden). */
  mark?: HTMLElement;
  label: string;
  /** The quieter line under the label while the card is LIVE. */
  sub?: string;
}

interface CardGroup<T extends string> {
  row: HTMLElement;
  buttons: Map<T, HTMLButtonElement>;
  select(v: T): void;
  /**
   * Make cards inert, each with the hint that replaces its sub-line; every card
   * not named goes back to live with its own words. Inert cards are
   * `aria-disabled`, never a tab stop, and skipped by the arrows.
   */
  setInert(hints: ReadonlyMap<T, string>): void;
  /**
   * Take the named cards OUT of the grid entirely — not inert, ABSENT: hidden,
   * never a tab stop, skipped by the arrows, invisible to `live()`. Every card
   * not named comes back. This is Settings' `Tools` list (B6 D1), a wish about
   * what the dialog offers, never about what the backend can run.
   */
  setHidden(hidden: ReadonlySet<T>): void;
  /** The values that can be picked right now, in reading order. */
  live(): T[];
  /** The values that are ON SCREEN, inert ones included, in reading order. */
  shown(): T[];
}

/**
 * A grid of cards that behaves like a real radiogroup — the same idiom the
 * segmented rows had: ONE tab stop (roving tabindex), arrow keys move the
 * selection in reading order, Home/End jump. Inert cards are
 * `aria-disabled="true"` and permanently `tabindex=-1`: the arrows skip them,
 * a click does nothing and does not even take focus, and the dialog's focus
 * trap (`tabIndex >= 0` filter) never counts them as a stop.
 *
 * Since B5 inert-ness is a RUNTIME state (an executable the backend cannot
 * find, a mode a tool does not take), so the same card can go live and back
 * without being rebuilt — `setInert` is the one way it changes.
 */
export function radioCards<T extends string>(
  rowClass: string,
  labelledBy: string,
  specs: CardSpec<T>[],
  onPick: (v: T) => void,
): CardGroup<T> {
  const row = el('div', rowClass);
  row.setAttribute('role', 'radiogroup');
  row.setAttribute('aria-labelledby', labelledBy);
  const buttons = new Map<T, HTMLButtonElement>();
  /** Per card: its own sub-line words, and the two spans that render them. */
  const words = new Map<T, { txt: HTMLElement; lb: HTMLElement; sub: HTMLElement; own: string }>();
  const all: T[] = [];
  /** The pickable values: everything that is neither inert nor hidden. */
  let order: T[] = [];
  /** The cards the backend (or a tool's vocabulary) has made unselectable. */
  let inert = new Map<T, string>();
  /** The cards Settings took out of the grid (tool cards only, B6 D1). */
  let hidden = new Set<T>();
  for (const s of specs) {
    const b = button(s.cls !== undefined && s.cls !== '' ? `ns-card ${s.cls}` : 'ns-card', '');
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', 'false');
    b.tabIndex = -1;
    const txt = el('span', 'ns-card-txt');
    const lb = el('span', 'ns-card-lb', s.label);
    const sub = el('span', 'ns-card-sub', s.sub ?? '');
    txt.replaceChildren(...(s.sub !== undefined ? [lb, sub] : [lb]));
    if (s.mark !== undefined) b.append(s.mark);
    b.append(txt);
    words.set(s.value, { txt, lb, sub, own: s.sub ?? '' });
    all.push(s.value);
    order.push(s.value);
    buttons.set(s.value, b);
    b.addEventListener('click', () => {
      if (b.getAttribute('aria-disabled') === 'true') return;
      onPick(s.value);
    });
    // An inert card must not even take focus from a press (A4).
    b.addEventListener('mousedown', (e) => {
      if (b.getAttribute('aria-disabled') === 'true') e.preventDefault();
    });
    row.append(b);
  }
  let current = order[0] as T;
  row.addEventListener('keydown', (e: KeyboardEvent) => {
    if (order.length === 0) return;
    let i = order.indexOf(current);
    const k = e.key;
    if (k === 'ArrowRight' || k === 'ArrowDown') i = (i + 1) % order.length;
    else if (k === 'ArrowLeft' || k === 'ArrowUp') i = (i - 1 + order.length) % order.length;
    else if (k === 'Home') i = 0;
    else if (k === 'End') i = order.length - 1;
    else return;
    e.preventDefault();
    const next = order[i] as T;
    onPick(next);
    buttons.get(next)?.focus();
  });
  function select(v: T): void {
    current = v;
    for (const [value, b] of buttons) {
      const on = value === v;
      b.classList.toggle('is-sel', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      // An inert card is never a tab stop, selected or not — and neither is a
      // card that is not in the grid at all.
      b.tabIndex =
        on && !hidden.has(value) && b.getAttribute('aria-disabled') !== 'true' ? 0 : -1;
    }
    // A group whose selected card just went inert would have NO tab stop and
    // drop out of the keyboard's reach; its first live card takes the stop
    // until the caller moves the selection.
    if (order.length > 0 && ![...buttons.values()].some((b) => b.tabIndex === 0)) {
      const first = buttons.get(order[0] as T);
      if (first !== undefined) first.tabIndex = 0;
    }
  }
  function setInert(hints: ReadonlyMap<T, string>): void {
    inert = new Map(hints);
    order = all.filter((v) => !inert.has(v) && !hidden.has(v));
    for (const [value, b] of buttons) {
      const hint = hints.get(value);
      const w = words.get(value);
      if (hint === undefined) b.removeAttribute('aria-disabled');
      else b.setAttribute('aria-disabled', 'true');
      if (w === undefined) continue;
      const line = hint ?? w.own;
      w.sub.textContent = line;
      w.txt.replaceChildren(...(line !== '' ? [w.lb, w.sub] : [w.lb]));
    }
    select(current);
  }
  function setHidden(next: ReadonlySet<T>): void {
    hidden = new Set(next);
    order = all.filter((v) => !inert.has(v) && !hidden.has(v));
    // `hidden` on the button, not a removed node: the grid keeps ONE reading
    // order whatever is shown, so a card that comes back lands where it has
    // always been instead of at the end.
    for (const [value, b] of buttons) b.hidden = hidden.has(value);
    select(current);
  }
  select(current);
  return {
    row,
    buttons,
    select,
    setInert,
    setHidden,
    live: () => [...order],
    shown: () => all.filter((v) => !hidden.has(v)),
  };
}

/** A group label that a radiogroup can point `aria-labelledby` at. */
export function groupLabel(id: string, text: string): HTMLElement {
  const lb = el('span', 'ns-lb', text);
  lb.id = id;
  return lb;
}

/** Fill a select from a per-tool table: the option SHOWS a label, HOLDS an id. */
export function fillChoices(sel: HTMLSelectElement, choices: readonly Choice[]): void {
  sel.replaceChildren();
  for (const c of choices) {
    const opt = el('option', '', c.label);
    opt.value = c.id;
    sel.append(opt);
  }
}

/**
 * What the dialog assumes before it has ever been told. Exactly the set the
 * app could compose BEFORE part B5 — anything new stays inert until the
 * backend says it is there, so opening the dialog never flashes a row of
 * enabled cards that then go dark.
 */
export const ASSUMED: ToolAvailability = {
  claude: true,
  codex: false,
  gemini: false,
  grok: false,
  zsh: false,
  cmd: false,
  powershell: true,
};


/** The keyed tool a kind reads a key for, or null when it takes none. */
export function keyToolFor(k: LaunchKind): KeyedTool | null {
  // Claude Code signs in, and a key alone does not authenticate Codex — so
  // neither gets a notice, whatever is stored (user decision 2026-09-18).
  return k === 'gemini' || k === 'grok' ? k : null;
}
