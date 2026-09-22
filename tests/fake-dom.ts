/**
 * A DOM double for driving the real `web/src/ui/*` modules under `node:test`,
 * with no browser and no dependency.
 *
 * It started as the double inside `tests/ui-launch-dialog.test.ts` (Nocturne
 * A4) and was lifted here when a SECOND part needed it (A5: the Files panel
 * and the restyled Sessions panel), with the pieces those two modules use
 * added: pointer events with capture (`setPointerCapture`), `style`,
 * `dataset`, `click()`, a one-selector `querySelector`, and a `window` whose
 * `setTimeout` records instead of firing (an armed two-step confirm must not
 * depend on a wall clock, and a pending 3.1s timer must not hold the runner
 * open).
 *
 * This is NOT a browser. What it models is exactly what the modules ask of it:
 * a tree, attributes/classes/dataset/style as plain values, and an event
 * dispatch with real capture -> target -> bubble order and stopPropagation.
 * Layout, CSS, hit-testing, screen-reader output and real focus policy stay
 * with `.claude/skills/verify-terminal/SKILL.md` and the browser.
 */

export type Handler = (e: FakeEvent) => void;

export interface FakeEvent {
  type: string;
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  button: number;
  clientX: number;
  clientY: number;
  pointerId: number;
  target: FakeNode | null;
  /**
   * The element a pointer moved INTO, on a `dragleave`. `null` is the only
   * value that means "it left the window", which is exactly the test
   * `ui/filedrop.ts` makes (PLAN-A9 §1: no enter/leave counting).
   */
  relatedTarget: FakeNode | null;
  /** Drag payload (`makeDataTransfer`), or null on an event that carries none. */
  dataTransfer: FakeDataTransfer | null;
  /** Paste payload — the same shape, since only `files` is ever read. */
  clipboardData: FakeDataTransfer | null;
  defaultPrevented: boolean;
  cancelBubble: boolean;
  preventDefault(): void;
  stopPropagation(): void;
  /**
   * Always false here. The app's chord handlers ask it for `AltGraph` only
   * (AltGr reports as ctrl+alt on European layouts), and "this is a real
   * ctrl+alt" is the state every test wants; a test that needs the AltGr case
   * passes `altGraph: true`.
   */
  getModifierState(name: string): boolean;
}

export interface EventInit {
  key?: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  altGraph?: boolean;
  button?: number;
  clientX?: number;
  clientY?: number;
  pointerId?: number;
  relatedTarget?: FakeNode | null;
  dataTransfer?: FakeDataTransfer | null;
  clipboardData?: FakeDataTransfer | null;
}

// ---------------------------------------------------------------------------
// Drag payloads (part A9)
// ---------------------------------------------------------------------------

/**
 * One node of a dropped TREE (part B10): a file with a size, or a folder with
 * children. `unreadable` makes the folder's reader fail the way a folder the
 * browser will not open really does, and `batch` caps how many entries one
 * `readEntries()` call answers with — Chromium's is about 100, and a walk that
 * does not loop would copy only the first batch.
 */
export interface FakeTreeNode {
  name: string;
  dir?: boolean;
  size?: number;
  children?: FakeTreeNode[];
  unreadable?: boolean;
  /** Entries per `readEntries()` call. Defaults to `READ_BATCH`. */
  batch?: number;
}

/** What Chromium's `readEntries()` really answers with at most, per call. */
export const READ_BATCH = 100;

/**
 * What `webkitGetAsEntry()` answers: a NAME, whether it is a folder, and —
 * since part B10, which walks the tree — the two callback APIs the real
 * `FileSystemEntry` carries.
 */
export interface FakeEntry {
  name: string;
  isDirectory: boolean;
  isFile?: boolean;
  file?(ok: (f: unknown) => void, fail?: (e: unknown) => void): void;
  createReader?(): {
    readEntries(ok: (entries: FakeEntry[]) => void, fail?: (e: unknown) => void): void;
  };
}

/**
 * A tree node as the browser hands it over. Callback-style on purpose: the
 * real API is, and a walk that forgets to loop `readEntries()` has to fail
 * here the same way it fails in Chromium.
 */
export function makeEntry(node: FakeTreeNode): FakeEntry {
  const dir = node.dir === true;
  if (!dir) {
    return {
      name: node.name,
      isDirectory: false,
      isFile: true,
      file(ok, fail) {
        if (node.unreadable === true) {
          fail?.(new Error('unreadable'));
          return;
        }
        ok({ name: node.name, size: node.size ?? 0 });
      },
    };
  }
  const children = node.children ?? [];
  const per = node.batch ?? READ_BATCH;
  return {
    name: node.name,
    isDirectory: true,
    isFile: false,
    createReader() {
      let i = 0;
      return {
        readEntries(ok, fail) {
          if (node.unreadable === true) {
            fail?.(new Error('unreadable'));
            return;
          }
          const slice = children.slice(i, i + per);
          i += slice.length;
          ok(slice.map(makeEntry));
        },
      };
    },
  };
}

/** What `getAsFile()` answers, and what a `files` list holds. */
export interface FakeFile {
  name: string;
  size?: number;
}

export interface FakeDataTransferItem {
  kind: string;
  type: string;
  webkitGetAsEntry(): FakeEntry | null;
  getAsFile(): FakeFile | null;
}

/**
 * A `DataTransfer` double. `dropEffect` is MUTABLE on purpose: it is how the
 * drop layer states validity ('copy' vs 'none'), so a test reads back what the
 * module wrote.
 */
export interface FakeDataTransfer {
  types: string[];
  dropEffect: string;
  effectAllowed: string;
  items: FakeDataTransferItem[];
  files: FakeFile[];
}

export interface DataTransferInit {
  /** Defaults to `['Files']` when items or files are given, `[]` otherwise. */
  types?: string[];
  /**
   * Top-level things being dragged. `dir` makes it a folder (no size), and
   * `children` gives that folder a TREE the walk can read (part B10).
   */
  items?: {
    name: string;
    dir?: boolean;
    size?: number;
    kind?: string;
    children?: FakeTreeNode[];
    unreadable?: boolean;
    batch?: number;
  }[];
  /** A plain file list (a paste, the native chooser). */
  files?: FakeFile[];
  /**
   * The DRAGOVER phase, as Chromium really behaves: `types` is all there is,
   * and `webkitGetAsEntry()` / `getAsFile()` answer null until `drop`
   * (measured, PLAN-A9 "Facts checked").
   */
  blind?: boolean;
}

export function makeDataTransfer(init: DataTransferInit = {}): FakeDataTransfer {
  const blind = init.blind === true;
  const items: FakeDataTransferItem[] = (init.items ?? []).map((it) => ({
    kind: it.kind ?? 'file',
    type: '',
    webkitGetAsEntry: () =>
      blind || it.kind === 'string'
        ? null
        : makeEntry({
            name: it.name,
            dir: it.dir === true,
            size: it.size ?? 0,
            ...(it.children === undefined ? {} : { children: it.children }),
            ...(it.unreadable === undefined ? {} : { unreadable: it.unreadable }),
            ...(it.batch === undefined ? {} : { batch: it.batch }),
          }),
    getAsFile: () =>
      blind || it.dir === true || it.kind === 'string'
        ? null
        : { name: it.name, size: it.size ?? 0 },
  }));
  const files: FakeFile[] = init.files ?? [];
  const types =
    init.types ?? (items.length > 0 || files.length > 0 ? ['Files'] : []);
  return { types, dropEffect: 'none', effectAllowed: 'all', items, files };
}

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

export interface FakeDocument extends FakeTarget {
  body: FakeElement;
  activeElement: FakeElement;
  /**
   * `visible` / `hidden`, as a value a test sets (part B4): the editor's disk
   * follow ticks only while the document is visible, and there is no window
   * manager here to hide it.
   */
  visibilityState: string;
  createElement(tag: string): FakeElement;
  createElementNS(ns: string, tag: string): FakeElement;
  /**
   * A bare text node. `ui/github.ts` builds one sentence out of text + a span +
   * text (the device-flow instruction), so a module under test asks for this at
   * CONSTRUCTION time — without it the Add-a-project dialog cannot be built here.
   */
  createTextNode(data: string): FakeText;
  /** Document-wide queries, delegated to the body (ui/dnd.ts asks for these). */
  querySelector(sel: string): FakeElement | null;
  querySelectorAll(sel: string): FakeElement[];
  /**
   * Hit-testing without a layout engine: the LAST element in document order
   * whose set rect contains the point — "last" because a later sibling paints
   * over an earlier one, which is the only stacking rule the drag layer needs
   * (`ui/dnd.ts` resolves its target through this). Elements a test never
   * placed have no rect and are never hit.
   */
  elementFromPoint(x: number, y: number): FakeElement | null;
}

export interface FakeWindow extends FakeTarget {
  /**
   * The viewport, as a value a test sets: `ui/filedrop.ts` asks whether a
   * `dragleave` really left the window, and there is no layout here to ask.
   */
  innerWidth: number;
  innerHeight: number;
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
  /**
   * Recorded like `setTimeout`, and for the same reason: `ui/github.ts` arms a
   * status poll (and an expiry ticker) the moment its tab is shown, and a real
   * interval would both hold the runner open and make the test depend on a
   * clock. A test fires `win.intervals[i].fn()` when it wants a tick.
   */
  setInterval(fn: () => void, ms: number): number;
  clearInterval(id: number): void;
  /** Every timer the modules armed, never fired — a test decides. */
  readonly timers: { fn: () => void; ms: number; id: number }[];
  /** Every interval the modules armed, never fired — a test decides. */
  readonly intervals: { fn: () => void; ms: number; id: number }[];
}

let doc: FakeDocument | null = null;
let win: FakeWindow | null = null;

function getDoc(): FakeDocument {
  if (doc === null) throw new Error('installDom() was not called');
  return doc;
}
function getBody(): FakeElement {
  return getDoc().body;
}

/** Capture (window -> target's parent), target, bubble (parent -> window). */
export function dispatch(target: FakeElement, type: string, init: EventInit = {}): FakeEvent {
  const e: FakeEvent = {
    type,
    key: init.key ?? '',
    shiftKey: init.shiftKey ?? false,
    ctrlKey: init.ctrlKey ?? false,
    altKey: init.altKey ?? false,
    metaKey: init.metaKey ?? false,
    button: init.button ?? 0,
    clientX: init.clientX ?? 0,
    clientY: init.clientY ?? 0,
    pointerId: init.pointerId ?? 1,
    target,
    relatedTarget: init.relatedTarget ?? null,
    dataTransfer: init.dataTransfer ?? null,
    clipboardData: init.clipboardData ?? null,
    defaultPrevented: false,
    cancelBubble: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {
      this.cancelBubble = true;
    },
    getModifierState(name: string): boolean {
      return name === 'AltGraph' && init.altGraph === true;
    },
  };
  const ancestors: FakeTarget[] = [];
  for (let x: FakeElement | null = target.parentNode; x !== null; x = x.parentNode) ancestors.push(x);
  ancestors.push(getDoc(), win as FakeWindow);
  const run = (node: FakeTarget, phase: 'capture' | 'target' | 'bubble'): void => {
    for (const h of [...node.handlers]) {
      if (h.type !== type) continue;
      if (phase === 'capture' && !h.capture) continue;
      if (phase === 'bubble' && h.capture) continue;
      h.fn(e);
    }
  };
  for (const node of [...ancestors].reverse()) {
    run(node, 'capture');
    if (e.cancelBubble) return e;
  }
  run(target, 'target');
  if (e.cancelBubble) return e;
  for (const node of ancestors) {
    run(node, 'bubble');
    if (e.cancelBubble) return e;
  }
  return e;
}

/** A localStorage that lives in memory (state.ts persists the UI layout). */
export class MemoryStorage {
  #map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.#map.has(k) ? (this.#map.get(k) as string) : null;
  }
  setItem(k: string, v: string): void {
    this.#map.set(k, v);
  }
  removeItem(k: string): void {
    this.#map.delete(k);
  }
  clear(): void {
    this.#map.clear();
  }
}

export interface Dom {
  doc: FakeDocument;
  win: FakeWindow;
  body: FakeElement;
  storage: MemoryStorage;
}

/**
 * Put the double on `globalThis` — must run BEFORE the module under test is
 * imported, since `el()` and friends resolve `document` at call time but some
 * modules build DOM at import time.
 */
export function installDom(): Dom {
  const body = new FakeElement('body');
  const timers: { fn: () => void; ms: number; id: number }[] = [];
  const intervals: { fn: () => void; ms: number; id: number }[] = [];
  let nextTimer = 1;
  const w = Object.assign(new FakeTarget(), {
    innerWidth: 1600,
    innerHeight: 900,
    timers,
    intervals,
    setTimeout(fn: () => void, ms: number): number {
      const id = nextTimer;
      nextTimer += 1;
      timers.push({ fn, ms, id });
      return id;
    },
    clearTimeout(id: number): void {
      const i = timers.findIndex((t) => t.id === id);
      if (i !== -1) timers.splice(i, 1);
    },
    setInterval(fn: () => void, ms: number): number {
      const id = nextTimer;
      nextTimer += 1;
      intervals.push({ fn, ms, id });
      return id;
    },
    clearInterval(id: number): void {
      const i = intervals.findIndex((t) => t.id === id);
      if (i !== -1) intervals.splice(i, 1);
    },
  }) as FakeWindow;
  const d = Object.assign(new FakeTarget(), {
    body,
    activeElement: body,
    visibilityState: 'visible',
    createElement: (tag: string) => new FakeElement(tag),
    createElementNS: (_ns: string, tag: string) => {
      const n = new FakeElement(tag);
      n.svgns = true;
      return n;
    },
    createTextNode: (data: string) => new FakeText(data),
    querySelector: (sel: string) => body.querySelector(sel),
    querySelectorAll: (sel: string) => body.querySelectorAll(sel),
    elementFromPoint: (x: number, y: number) => {
      let hit: FakeElement | null = null;
      for (const n of descendants(body)) {
        const r = n.rect;
        if (r === null) continue;
        // A `hidden` element has no box, so the real elementFromPoint never
        // answers one — and the app hides whole panels that way (main.ts:
        // `filesAside.hidden = !filesShown`). Without this a test could only
        // pretend a panel is away by taking its geometry off it.
        if (!n.rendered) continue;
        if (x >= r.left && x <= r.left + r.width && y >= r.top && y <= r.top + r.height) hit = n;
      }
      return hit;
    },
  }) as FakeDocument;
  doc = d;
  win = w;
  const storage = new MemoryStorage();
  const g = globalThis as unknown as Record<string, unknown>;
  g.document = d;
  g.window = w;
  g.Node = FakeNode;
  // An SVG node is an `Element` but NOT an `HTMLElement`, in a browser and now
  // here: `instanceof HTMLElement` is how several modules narrow an event
  // target, and narrowing that way throws away every click, drop and
  // right-click that lands on an icon (measured in a real browser, part A9b).
  class FakeHTMLElement {
    static [Symbol.hasInstance](v: unknown): boolean {
      return v instanceof FakeElement && !v.svgns;
    }
  }
  g.HTMLElement = FakeHTMLElement;
  // `ui/dnd.ts` narrows an elementFromPoint hit with `instanceof Element`
  // before it reads `closest()`; without the global that check throws.
  g.Element = FakeElement;
  g.localStorage = storage;
  // `ui/github.ts` clears with the BARE globals (`clearInterval(timer)`), so the
  // fake ids must reach the same bookkeeping as `window.clearInterval`.
  g.clearInterval = (id: number) => {
    w.clearInterval(id);
  };
  g.clearTimeout = (id: number) => {
    w.clearTimeout(id);
  };
  g.CSS = { escape: (s: string) => s.replace(/([^\w-])/g, '\\$1') };
  return { doc: d, win: w, body, storage };
}

// ---------------------------------------------------------------------------
// Query helpers for the tests themselves
// ---------------------------------------------------------------------------

/** Every descendant carrying `cls`, in document order. */
export function byClass(root: FakeElement, cls: string): FakeElement[] {
  return descendants(root).filter((n) => n.classList.contains(cls));
}

/** The one descendant whose `data-k` matches, or null. */
export function byKey(root: FakeElement, key: string): FakeElement | null {
  return descendants(root).find((n) => n.getAttribute('data-k') === key) ?? null;
}

/** Visible text of every descendant carrying `cls`. */
export function textsOf(root: FakeElement, cls: string): string[] {
  return byClass(root, cls).map((n) => n.textContent);
}
