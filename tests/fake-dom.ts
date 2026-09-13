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
  button: number;
  clientX: number;
  clientY: number;
  pointerId: number;
  target: FakeNode | null;
  defaultPrevented: boolean;
  cancelBubble: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}

export interface EventInit {
  key?: string;
  shiftKey?: boolean;
  button?: number;
  clientX?: number;
  clientY?: number;
  pointerId?: number;
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

export class FakeElement extends FakeNode {
  readonly tagName: string;
  children: FakeNode[] = [];
  className = '';
  readonly attrs = new Map<string, string>();
  readonly dataset: Record<string, string | undefined> = {};
  readonly style: Record<string, string> = {};
  hidden = false;
  disabled = false;
  id = '';
  title = '';
  type = '';
  readonly captured = new Set<number>();
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
  replaceChildren(...nodes: (FakeNode | string)[]): void {
    for (const c of this.children) c.parentNode = null;
    this.children = [];
    this.append(...nodes);
  }
  contains(n: unknown): boolean {
    let x = n instanceof FakeNode ? (n as FakeNode | null) : null;
    while (x !== null) {
      if (x === (this as FakeNode)) return true;
      x = x.parentNode;
    }
    return false;
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
  blur(): void {
    if (getDoc().activeElement === this) getDoc().activeElement = getBody();
  }
  click(): void {
    dispatch(this, 'click');
  }
  /** Only the shapes the UI modules ask for: `[attr="value"]` and `.class`. */
  querySelector(sel: string): FakeElement | null {
    return this.querySelectorAll(sel)[0] ?? null;
  }
  querySelectorAll(sel: string): FakeElement[] {
    const parts = sel.split(',').map((s) => s.trim());
    const all = descendants(this);
    const out: FakeElement[] = [];
    for (const n of all) {
      if (parts.some((p) => matches(n, p)) && !out.includes(n)) out.push(n);
    }
    return out;
  }
}

function matches(n: FakeElement, sel: string): boolean {
  const attr = /^\[([a-zA-Z-]+)="(.*)"\]$/.exec(sel);
  if (attr !== null) {
    // CSS.escape'd values arrive here (`data-k="fdir\:web"`); the escape is a
    // selector-syntax detail, the attribute itself never carried it.
    const want = (attr[2] as string).replace(/\\(.)/g, '$1');
    return n.getAttribute(attr[1] as string) === want;
  }
  const notDisabled = /^([a-zA-Z]+):not\(\[disabled\]\)$/.exec(sel);
  if (notDisabled !== null) {
    return n.tagName === (notDisabled[1] as string).toUpperCase() && !n.disabled;
  }
  if (sel === '[tabindex]:not([tabindex="-1"])') {
    return n.hasAttribute('tabindex') && n.getAttribute('tabindex') !== '-1';
  }
  if (sel.startsWith('.')) return n.classList.contains(sel.slice(1));
  return n.tagName === sel.toUpperCase();
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
  createElement(tag: string): FakeElement;
  createElementNS(ns: string, tag: string): FakeElement;
}

export interface FakeWindow extends FakeTarget {
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
  /** Every timer the modules armed, never fired — a test decides. */
  readonly timers: { fn: () => void; ms: number; id: number }[];
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
    button: init.button ?? 0,
    clientX: init.clientX ?? 0,
    clientY: init.clientY ?? 0,
    pointerId: init.pointerId ?? 1,
    target,
    defaultPrevented: false,
    cancelBubble: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {
      this.cancelBubble = true;
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
  let nextTimer = 1;
  const w = Object.assign(new FakeTarget(), {
    timers,
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
  }) as FakeWindow;
  const d = Object.assign(new FakeTarget(), {
    body,
    activeElement: body,
    createElement: (tag: string) => new FakeElement(tag),
    createElementNS: (_ns: string, tag: string) => new FakeElement(tag),
  }) as FakeDocument;
  doc = d;
  win = w;
  const storage = new MemoryStorage();
  const g = globalThis as unknown as Record<string, unknown>;
  g.document = d;
  g.window = w;
  g.Node = FakeNode;
  g.HTMLElement = FakeElement;
  g.localStorage = storage;
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
