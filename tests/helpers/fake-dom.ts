/**
 * A DOM double for driving the real `web/src/ui/*` modules under `node:test`,
 * with no browser and no dependency.
 *
 * It started as the double inside `tests/ui/ui-launch-dialog.test.ts` (Nocturne
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
 *
 * The double is four modules (restructure O6, 2026-09-23): this entry
 * (`installDom`, `MemoryStorage`, the query helpers) re-exports the rest, so
 * a test imports everything from here — `fake-dom-events.ts` (events,
 * document, window, `dispatch`), `fake-dom-element.ts` (the node tree and
 * selectors) and `fake-dom-transfer.ts` (drag and paste payloads).
 */
import assert from 'node:assert/strict';
import {
  descendants,
  FakeElement,
  FakeNode,
  FakeTarget,
  FakeText,
} from './fake-dom-element.ts';
import { dispatch, setDom, type FakeDocument, type FakeWindow } from './fake-dom-events.ts';

export {
  descendants,
  FakeElement,
  FakeNode,
  FakeTarget,
  FakeText,
  setRect,
  type FakeRect,
  type FakeStyle,
} from './fake-dom-element.ts';
export {
  dispatch,
  type EventInit,
  type FakeDocument,
  type FakeEvent,
  type FakeWindow,
  type Handler,
} from './fake-dom-events.ts';
export {
  makeDataTransfer,
  makeEntry,
  READ_BATCH,
  type DataTransferInit,
  type FakeDataTransfer,
  type FakeDataTransferItem,
  type FakeEntry,
  type FakeFile,
  type FakeTreeNode,
} from './fake-dom-transfer.ts';

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
  setDom(d, w);
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

/** The first element with class `cls` under `root`; fails the test when there is none. */
export function oneByClass(root: FakeElement, cls: string): FakeElement {
  const hit = byClass(root, cls)[0];
  assert.ok(hit !== undefined, `no .${cls}`);
  return hit;
}

/** Put `value` in a text field and fire the `input` event a keystroke would. */
export function typeInto(ta: FakeElement, value: string): void {
  ta.value = value;
  dispatch(ta, 'input');
}
