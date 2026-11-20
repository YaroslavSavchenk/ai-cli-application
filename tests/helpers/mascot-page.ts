/**
 * Mounts the REAL peek-mascot page entry (`web/src/mascot/main.ts`, Nocturne
 * C1 + D8) on the DOM double (`./fake-dom.ts`), for the tests that drive the
 * page as a whole: `tests/ui/ui-mascot-resize.test.ts`,
 * `tests/ui/ui-mascot-page-active.test.ts`, `tests/ui/ui-mascot-demo.test.ts`.
 *
 * - A fake `window.chrome.webview` records every string the page posts and
 *   holds the page's `message` listeners, so a test can play the host
 *   (`send`).
 * - `registerHooks` swaps the entry's `./mascot.css` import for an empty
 *   module (Node cannot load a stylesheet).
 * - The live feed's first poll is a fetch that never answers, and its re-poll
 *   is armed on the double's timers, never fired — the count is driven through
 *   the page's own seam, `window.aiSmMascot.setCount`, and no real timer holds
 *   the runner.
 *
 * The entry mounts at import, once per process: one call per test file.
 *
 * Also `withAnimations`, the stand-in for a running motion (`getAnimations()`
 * on the double), which the view and presence tests use without the page:
 * `tests/ui/ui-mascot-view.test.ts`, `tests/ui/ui-mascot-presence.test.ts`.
 */
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { FakeElement, installDom, type Dom } from './fake-dom.ts';

/** The page's `window.aiSmMascot`, as much of it as the tests drive. */
export interface PageSeam {
  setCount(n: number): void;
  getCount(): number;
  destroy(): void;
}

export interface MascotPage {
  dom: Dom;
  /** The `#mascot` element the page mounted on. */
  root: FakeElement;
  /** Every string the page posted to the host, in order. */
  posted: string[];
  /** The page's `chrome.webview` message listeners. */
  listeners: Set<(e: { data?: unknown }) => void>;
  page: PageSeam;
  /** Play the host: deliver `data` to every message listener. */
  send(data: unknown): void;
  /** The last message the page posted, parsed. */
  lastPosted(): unknown;
}

/** Import the page entry with `location.search` = `search` and hand back its handles. */
export async function mountMascotPage(search: string): Promise<MascotPage> {
  const dom = installDom();
  const posted: string[] = [];
  const listeners = new Set<(e: { data?: unknown }) => void>();
  const root = new FakeElement('div');
  dom.body.append(root);
  Object.assign(dom.win, {
    location: { search, reload() {} },
    chrome: {
      webview: {
        postMessage: (message: string) => posted.push(message),
        addEventListener: (_type: string, fn: (e: { data?: unknown }) => void) => void listeners.add(fn),
        removeEventListener: (_type: string, fn: (e: { data?: unknown }) => void) => void listeners.delete(fn),
      },
    },
    __AUTH__: 'test-token',
  });
  Object.assign(dom.doc, { getElementById: (id: string) => (id === 'mascot' ? root : null) });

  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === './mascot.css' && (context.parentURL ?? '').endsWith('/web/src/mascot/main.ts')) {
        return { url: 'mascot-stub:css', shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (url === 'mascot-stub:css') return { format: 'module', source: '', shortCircuit: true };
      return nextLoad(url, context);
    },
  });

  // Only while the page mounts: the feed polls at once (a fetch that never
  // answers) and arms its 2 s re-poll through the bare `setTimeout`.
  const g = globalThis as unknown as Record<string, unknown>;
  const realFetch = g.fetch;
  const realSetTimeout = g.setTimeout;
  g.fetch = () => new Promise(() => {});
  g.setTimeout = dom.win.setTimeout;
  try {
    // A URL, not a literal: the server typecheck (which includes tests/) must
    // not pull in a module that imports a .css — web/tsconfig.json checks it.
    await import(new URL('../../web/src/mascot/main.ts', import.meta.url).href);
  } finally {
    g.fetch = realFetch;
    g.setTimeout = realSetTimeout;
  }
  const mounted = (dom.win as unknown as { aiSmMascot?: PageSeam }).aiSmMascot;
  if (mounted === undefined) throw new Error('main.ts did not mount on #mascot');

  return {
    dom,
    root,
    posted,
    listeners,
    page: mounted,
    send: (data) => {
      for (const fn of [...listeners]) fn({ data });
    },
    lastPosted: () => {
      assert.ok(posted.length > 0, 'the page posted nothing');
      return JSON.parse(posted[posted.length - 1]!);
    },
  };
}

/**
 * Give the elements `pick` selects a `getAnimations()` answering `list()` for
 * the length of `fn` — how a test says "this motion is running" (or, with an
 * empty list, "reduced motion: nothing runs").
 */
export async function withAnimations(
  pick: (el: FakeElement) => boolean,
  list: () => { finished: Promise<unknown> }[],
  fn: () => void | Promise<void>,
): Promise<void> {
  const proto = FakeElement.prototype as unknown as Record<string, unknown>;
  proto.getAnimations = function (this: FakeElement) {
    return pick(this) ? list() : [];
  };
  try {
    await fn();
  } finally {
    delete proto.getAnimations;
  }
}
