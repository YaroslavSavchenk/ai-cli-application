/**
 * The node tree of the DOM double (`fake-dom.ts`, the entry every test
 * imports): event targets, nodes, text, `FakeElement` with attributes,
 * classes, dataset, style, focus and the small selector engine behind
 * `querySelector` / `closest` / `matches`.
 *
 * Focus and `click()` reach the document and the event dispatch through
 * `fake-dom-events.ts`. Split out of `fake-dom.ts` (restructure O6,
 * 2026-09-23) so each module keeps one topic.
 */
import { dispatch, getBody, getDoc, type Handler } from './fake-dom-events.ts';

export class FakeTarget {
  readonly handlers: { type: string; fn: Handler; capture: boolean }[] = [];
  addEventListener(type: string, fn: Handler, opts?: boolean | { capture?: boolean }): void {
    const capture = typeof opts === 'boolean' ? opts : opts?.capture === true;
    this.handlers.push({ type, fn, capture });
  }
  removeEventListener(type: string, fn: Handler): void {
    const i = this.handlers.findIndex((h) => h.type === type && h.fn === fn);
    if (i !== -1) this.handlers.splice(i, 1);
  }
}

export class FakeNode extends FakeTarget {
  parentNode: FakeElement | null = null;
  get textContent(): string {
    return '';
  }
}

export class FakeText extends FakeNode {
  readonly data: string;
  constructor(data: string) {
    super();
    this.data = data;
  }
  override get textContent(): string {
    return this.data;
  }
}

const FOCUSABLE_TAGS = new Set(['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA']);

/** Just enough of a DOMRect for the arithmetic the UI modules do. */
export interface FakeRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Place an element, so `elementFromPoint` and the drop geometry can see it. */
export function setRect(n: FakeElement, r: FakeRect): void {
  n.rect = r;
}

/**
 * `element.style`: a plain property bag that ALSO answers `setProperty` —
 * the UI modules set data-valued properties through it (ui/panes.ts writes the
 * split columns, ui/term-colours.ts the chosen ground and ink), and a bag
 * without the method would make those modules throw instead of being tested.
 */
export type FakeStyle = Record<string, string> & {
  setProperty(name: string, value: string): void;
  getPropertyValue(name: string): string;
  removeProperty(name: string): void;
};

function makeStyle(): FakeStyle {
  const bag: Record<string, string> = {};
  const api = {
    setProperty(name: string, value: string): void {
      bag[name] = value;
    },
    getPropertyValue(name: string): string {
      return bag[name] ?? '';
    },
    removeProperty(name: string): void {
      delete bag[name];
    },
  };
  // One object: the methods live on it, the properties land in the same bag, so
  // `style.width = '3px'` and `style.setProperty('width', '3px')` agree.
  return new Proxy(api as unknown as FakeStyle, {
    get: (t, k) => (k in api ? (api as Record<string, unknown>)[k as string] : bag[k as string]),
    set: (_t, k, v) => {
      bag[k as string] = String(v);
      return true;
    },
    has: (_t, k) => k in api || k in bag,
    deleteProperty: (_t, k) => {
      delete bag[k as string];
      return true;
    },
  });
}

export class FakeElement extends FakeNode {
  readonly tagName: string;
  children: FakeNode[] = [];
  className = '';
  readonly attrs = new Map<string, string>();
  readonly dataset: Record<string, string | undefined> = {};
  readonly style: FakeStyle = makeStyle();
  hidden = false;
  disabled = false;
  id = '';
  /**
   * Made by `createElementNS`, i.e. an SVG node — NOT an `HTMLElement`, which
   * is the whole point (part A9b, brief 2): a right-click that lands on the
   * folder mark inside a Files row has an `SVGElement` as its target, and a
   * delegated listener narrowing with `instanceof HTMLElement` silently drops
   * it. MEASURED in a real browser first; pinned here so the double can tell
   * the same truth (`g.HTMLElement` below answers `false` for these).
   */
  svgns = false;
  title = '';
  type = '';
  placeholder = '';
  autocomplete = '';
  /**
   * `<input>` state the UI modules really set (A9c: the Files panel's name row
   * makes its input read-only while the create is in flight, and turns the
   * spell checker off because a file name is not prose). Plain properties,
   * exactly as on a real HTMLInputElement, so a test reads back what the module
   * wrote — `value` is the accessor further down.
   */
  readOnly = false;
  spellcheck = true;
  /**
   * Caret, selection and scroll offset of a text field (part B4). There is no
   * layout and no caret here, so these are plain values the module under test
   * writes and reads back — which is exactly what the disk follow's caret
   * clamp (`min(old caret, new length)`) and the "scroll offset is kept" rule
   * are about.
   */
  selectionStart = 0;
  selectionEnd = 0;
  scrollTop = 0;
  readonly captured = new Set<number>();
  /**
   * Layout, as a value a test sets: there is no engine here, so a module that
   * hit-tests (ui/dnd.ts: `elementFromPoint` + `getBoundingClientRect`) is
   * handed the geometry it would have measured. `null` = never laid out, which
   * is what a real detached node reports as all-zero.
   */
  rect: FakeRect | null = null;
  #tabIndex: number | null = null;
  #value: string | null = null;

  constructor(tag: string) {
    super();
    this.tagName = tag.toUpperCase();
  }

  // ---- tree ---------------------------------------------------------------
  append(...nodes: (FakeNode | string)[]): void {
    for (const n of nodes) {
      const node = typeof n === 'string' ? new FakeText(n) : n;
      node.parentNode = this;
      this.children.push(node);
    }
  }
  /**
   * The DOM's older one-node form of `append`, returning the node it appended.
   * `createElementNS(...)` + `appendChild(...)` is the idiom every hand-built
   * SVG uses (`web/src/mascot/view.ts` draws its pixel art that way), so the
   * double answers both spellings.
   */
  appendChild<T extends FakeNode>(node: T): T {
    this.append(node);
    return node;
  }
  replaceChildren(...nodes: (FakeNode | string)[]): void {
    for (const c of this.children) c.parentNode = null;
    this.children = [];
    this.append(...nodes);
  }
  /** Detach from the parent — how a dialog that is CREATED on open goes away. */
  remove(): void {
    const parent = this.parentNode;
    if (parent === null) return;
    const i = parent.children.indexOf(this);
    if (i !== -1) parent.children.splice(i, 1);
    this.parentNode = null;
  }
  contains(n: unknown): boolean {
    let x = n instanceof FakeNode ? (n as FakeNode | null) : null;
    while (x !== null) {
      if (x === (this as FakeNode)) return true;
      x = x.parentNode;
    }
    return false;
  }
  /**
   * `childNodes` is text nodes included, which is what `children` already is
   * in this double (`ui/util.ts` armButton keeps a button's own nodes — an
   * icon, or its text — to put back on disarm, B8). A copy, as the live
   * NodeList would be one to the caller that spreads it.
   */
  get childNodes(): FakeNode[] {
    return [...this.children];
  }
  override get textContent(): string {
    return this.children.map((c) => c.textContent).join('');
  }
  override set textContent(v: string) {
    this.replaceChildren(...(v === '' ? [] : [v]));
  }

  // ---- attributes ---------------------------------------------------------
  setAttribute(k: string, v: string): void {
    this.attrs.set(k, v);
    if (k === 'tabindex') this.#tabIndex = Number(v);
  }
  getAttribute(k: string): string | null {
    return this.attrs.get(k) ?? null;
  }
  hasAttribute(k: string): boolean {
    return this.attrs.has(k);
  }
  removeAttribute(k: string): void {
    this.attrs.delete(k);
  }
  get classList(): {
    add(...c: string[]): void;
    remove(...c: string[]): void;
    toggle(c: string, force?: boolean): boolean;
    contains(c: string): boolean;
  } {
    const list = (): string[] => this.className.split(/\s+/).filter((c) => c !== '');
    const set = (xs: string[]): void => {
      this.className = xs.join(' ');
    };
    return {
      add: (...c) => set([...new Set([...list(), ...c])]),
      remove: (...c) => set(list().filter((x) => !c.includes(x))),
      toggle: (c, force) => {
        const on = force ?? !list().includes(c);
        set(on ? [...new Set([...list(), c])] : list().filter((x) => x !== c));
        return on;
      },
      contains: (c) => list().includes(c),
    };
  }
  get tabIndex(): number {
    return this.#tabIndex ?? (FOCUSABLE_TAGS.has(this.tagName) ? 0 : -1);
  }
  set tabIndex(v: number) {
    this.#tabIndex = v;
    this.attrs.set('tabindex', String(v));
  }
  get value(): string {
    return this.#value ?? '';
  }
  set value(v: string) {
    this.#value = v;
  }

  /** What a real text field does with `setSelectionRange` (part B4). */
  setSelectionRange(start: number, end: number): void {
    this.selectionStart = start;
    this.selectionEnd = end;
  }

  /** The set rect, or an all-zero one (a node no test placed has no box). */
  getBoundingClientRect(): FakeRect & { right: number; bottom: number } {
    const r = this.rect ?? { left: 0, top: 0, width: 0, height: 0 };
    return { ...r, right: r.left + r.width, bottom: r.top + r.height };
  }

  // ---- pointer capture ----------------------------------------------------
  setPointerCapture(id: number): void {
    this.captured.add(id);
  }
  hasPointerCapture(id: number): boolean {
    return this.captured.has(id);
  }
  releasePointerCapture(id: number): void {
    this.captured.delete(id);
  }

  // ---- behaviour ----------------------------------------------------------
  get isConnected(): boolean {
    let x: FakeElement = this;
    while (x.parentNode !== null) x = x.parentNode;
    return x === getBody();
  }
  /** Rendered = connected and nothing on the way up is `hidden`. */
  get rendered(): boolean {
    if (!this.isConnected) return false;
    let x: FakeElement | null = this;
    while (x !== null) {
      if (x.hidden) return false;
      x = x.parentNode;
    }
    return true;
  }
  get offsetParent(): unknown {
    return this.rendered ? getBody() : null;
  }
  focus(): void {
    if (this.disabled) return;
    getDoc().activeElement = this;
    dispatch(this, 'focusin');
  }
  /**
   * There is no viewport here, so this RECORDS instead of scrolling (part
   * B10: the drop dialog scrolls each settled row into view inside its own
   * bounded list). A test reads `scrolledInto` to see which rows asked, and
   * with which option — which is the whole contract: `block: 'nearest'` is
   * the minimum scroll, the one that moves nothing when the row already fits.
   */
  scrollIntoView(opts?: unknown): void {
    this.scrolledInto.push(opts);
  }
  readonly scrolledInto: unknown[] = [];
  /**
   * Give the keyboard up, and SAY SO: a real element fires `blur` when it
   * loses the focus, and a module can hang behaviour off that (A9c: the Files
   * panel's name row cancels when the keyboard leaves it). The event does not
   * bubble in a browser; this double has one dispatch, and the handlers that
   * read it are on the element itself.
   */
  blur(): void {
    if (getDoc().activeElement !== this) return;
    getDoc().activeElement = getBody();
    dispatch(this, 'blur');
  }
  click(): void {
    dispatch(this, 'click');
  }
  /**
   * Nearest self-or-ancestor matching the selector. Beyond `matches()`'s
   * shapes it understands the bare `[hidden]` that `ui/update.ts` asks for
   * (`back.closest('[hidden]')`): `hidden` is a PROPERTY on this double, as it
   * is on a real HTMLElement, and the question that call asks is "is anything
   * on the way up hidden".
   */
  closest(sel: string): FakeElement | null {
    const parts = sel.split(',').map((s) => s.trim());
    let x: FakeElement | null = this;
    while (x !== null) {
      for (const p of parts) {
        if (p === '[hidden]' ? x.hidden : matches(x, p)) return x;
      }
      x = x.parentNode;
    }
    return null;
  }
  /**
   * The shapes the UI modules ask for: a tag, `.class`, `[attr]`,
   * `[attr="value"]`, any of those concatenated (`.tab[data-view-id]`), a
   * comma list, and a descendant chain (`.grid .pane[data-slot="0"]`).
   */
  querySelector(sel: string): FakeElement | null {
    return this.querySelectorAll(sel)[0] ?? null;
  }
  querySelectorAll(sel: string): FakeElement[] {
    const groups = sel.split(',').map((s) => splitDescendants(s.trim()));
    const out: FakeElement[] = [];
    for (const n of descendants(this)) {
      if (groups.some((g) => matchesChain(n, g)) && !out.includes(n)) out.push(n);
    }
    return out;
  }
}

/**
 * `a b c` -> ['a','b','c'], leaving an escaped space alone (CSS.escape turns
 * a space inside an attribute value into `\\ `).
 */
function splitDescendants(sel: string): string[] {
  return sel.split(/(?<!\\)\s+/).filter((p) => p !== '');
}

/** The last part must match `n`, every earlier part some ancestor, in order. */
function matchesChain(n: FakeElement, parts: string[]): boolean {
  let i = parts.length - 1;
  if (i < 0 || !matches(n, parts[i] as string)) return false;
  let x = n.parentNode;
  for (i -= 1; i >= 0; i -= 1) {
    while (x !== null && !matches(x, parts[i] as string)) x = x.parentNode;
    if (x === null) return false;
    x = x.parentNode;
  }
  return true;
}

/** One simple selector: a tag, `.class`, `[attr]` or `[attr="value"]`. */
const SIMPLE = /^(?:([a-zA-Z]+)|\.([\w-]+)|\[([a-zA-Z-]+)(?:="((?:\\.|[^"\\])*)")?\])/;

const NOT_HIDDEN = ':not([hidden])';

function matches(n: FakeElement, sel: string): boolean {
  // `.modal-scrim:not([hidden])` — "a dialog that is UP" (ui/keys.ts
  // OPEN_MODAL_SELECTOR): every scrim is built once and kept, so `hidden` is
  // the whole question. Stripped here and asked as the property it is.
  if (sel.endsWith(NOT_HIDDEN)) {
    return !n.hidden && matches(n, sel.slice(0, -NOT_HIDDEN.length));
  }
  // The two `:not(...)` shapes stay special-cased: they are the only ones the
  // UI asks for, and a general negation parser would be a browser.
  const notDisabled = /^([a-zA-Z]+):not\(\[disabled\]\)$/.exec(sel);
  if (notDisabled !== null) {
    return n.tagName === (notDisabled[1] as string).toUpperCase() && !n.disabled;
  }
  if (sel === '[tabindex]:not([tabindex="-1"])') {
    return n.hasAttribute('tabindex') && n.getAttribute('tabindex') !== '-1';
  }
  let rest = sel;
  let any = false;
  while (rest !== '') {
    const m = SIMPLE.exec(rest);
    if (m === null) return false;
    any = true;
    if (m[1] !== undefined && n.tagName !== m[1].toUpperCase()) return false;
    if (m[2] !== undefined && !n.classList.contains(m[2])) return false;
    if (m[3] !== undefined) {
      const have = n.getAttribute(m[3]);
      if (have === null) return false;
      // CSS.escape'd values arrive here (`data-k="fdir\:web"`); the escape is
      // a selector-syntax detail, the attribute itself never carried it.
      if (m[4] !== undefined && have !== m[4].replace(/\\(.)/g, '$1')) return false;
    }
    rest = rest.slice(m[0].length);
  }
  return any;
}

export function descendants(root: FakeElement): FakeElement[] {
  const out: FakeElement[] = [];
  for (const c of root.children) {
    if (c instanceof FakeElement) out.push(c, ...descendants(c));
  }
  return out;
}
