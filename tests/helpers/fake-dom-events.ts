/**
 * Events, the document and the window of the DOM double (`fake-dom.ts`, the
 * entry every test imports): the event shape, the document/window
 * interfaces, the one installed document, and `dispatch` with real
 * capture -> target -> bubble order and stopPropagation.
 *
 * `installDom()` in `fake-dom.ts` builds the document and window and hands
 * them over with `setDom`. Split out of `fake-dom.ts` (restructure O6,
 * 2026-09-23) so each module keeps one topic.
 */
import type { FakeElement, FakeNode, FakeTarget, FakeText } from './fake-dom-element.ts';
import type { FakeDataTransfer } from './fake-dom-transfer.ts';

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

/** The document and window `installDom()` built; `dispatch` and focus reach them here. */
export function setDom(d: FakeDocument, w: FakeWindow): void {
  doc = d;
  win = w;
}

export function getDoc(): FakeDocument {
  if (doc === null) throw new Error('installDom() was not called');
  return doc;
}
export function getBody(): FakeElement {
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
