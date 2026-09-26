/**
 * `web/src/mascot/main.ts`, the live peek-mascot page (Nocturne C1,
 * `.claude/plans/nocturne/PLAN-C1.md`): it says its mascots' rects to the
 * host again when the window is resized, and only when they changed.
 *
 * How: the REAL page entry, imported on the DOM double
 * (`tests/helpers/fake-dom.ts`) with a fake `window.chrome.webview` that
 * records every string the page posts. `registerHooks` swaps the entry's
 * `./mascot.css` import for an empty module (Node cannot load a stylesheet).
 * The feed's first poll never gets an answer and its re-poll is armed on the
 * double's timers, never fired — so the count is driven through the page's
 * own seam, `window.aiSmMascot.setCount`, and no real timer holds the runner.
 *
 * Why it matters: under visual hosting the page can first lay out at the
 * WebView's pre-bounds size (seen 1281 x 1392) and get its real 220 x 340 a
 * moment later. `rects()` measures against the viewport, so a report made in
 * between leaves the host's click-through region off the mascot — clicks on
 * it fall through to the window behind — until the next settle.
 *
 * NOT claimed: that WebView2 fires `resize` in that order, or that the host
 * re-shapes its region on the message — the user's Windows check does.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { FakeElement, byClass, installDom, setRect, type Dom } from '../helpers/fake-dom.ts';

const dom: Dom = installDom();
const posted: string[] = [];
const root = new FakeElement('div');
dom.body.append(root);
Object.assign(dom.win, {
  location: { search: '', reload() {} },
  chrome: { webview: { postMessage: (message: string) => posted.push(message) } },
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
/** The page's `window.aiSmMascot`, as much of it as this file drives. */
interface PageSeam {
  setCount(n: number): void;
  destroy(): void;
}
const mounted = (dom.win as unknown as { aiSmMascot?: PageSeam }).aiSmMascot;
if (mounted === undefined) throw new Error('main.ts did not mount on #mascot');
const page: PageSeam = mounted;

/** Resize the viewport and fire the window's `resize` listeners, as a browser does. */
function resize(width: number, height: number): void {
  dom.win.innerWidth = width;
  dom.win.innerHeight = height;
  for (const h of [...dom.win.handlers]) if (h.type === 'resize') h.fn({ type: 'resize' } as never);
}

/** The last message the page posted, parsed. */
function lastPosted(): unknown {
  assert.ok(posted.length > 0, 'the page posted nothing');
  return JSON.parse(posted[posted.length - 1]!);
}

test('a resize while a mascot is on screen re-sends the count with its rects in the new viewport', () => {
  assert.deepEqual(JSON.parse(posted[0]!), { type: 'mascot-count', count: 0, rects: [] }, 'mount: 0 at once');
  // The entrance is running (no `finished` yet), so the mascot claims the
  // whole 220 x 340 stage at the right edge of whatever the viewport is.
  const proto = FakeElement.prototype as unknown as Record<string, unknown>;
  proto.getAnimations = function (this: FakeElement) {
    return String(this.className).includes('pm-pos') ? [{ finished: new Promise(() => {}) }] : [];
  };
  try {
    page.setCount(0);
    resize(1281, 1392); // the WebView's pre-bounds layout
    page.setCount(1);
    assert.deepEqual(
      lastPosted(),
      { type: 'mascot-count', count: 1, rects: [[1061, 526, 220, 340]] },
      'first report: measured against the pre-bounds viewport',
    );
    const before = posted.length;
    resize(220, 340); // the real bounds arrive
    assert.equal(posted.length, before + 1, 'the resize re-sends once');
    assert.deepEqual(lastPosted(), { type: 'mascot-count', count: 1, rects: [[0, 0, 220, 340]] });
  } finally {
    delete proto.getAnimations;
  }
});

test('a resize that leaves every rect where it was sends nothing', () => {
  page.setCount(0);
  resize(220, 340);
  page.setCount(1); // no running animation: settled at once, the tight box
  setRect(byClass(root, 'pm-react')[0]!, { left: 70, top: 100, width: 100, height: 120 });
  resize(220, 340);
  assert.deepEqual(lastPosted(), { type: 'mascot-count', count: 1, rects: [[54, 84, 132, 152]] }, 'laid out');
  const before = posted.length;
  resize(220, 340);
  resize(220, 340);
  assert.equal(posted.length, before, 'an unchanged report is not posted again');
});

test('destroy takes the resize listener with it', () => {
  const listening = (): number => dom.win.handlers.filter((h) => h.type === 'resize').length;
  assert.equal(listening(), 1, 'the live page listens for resize');
  page.destroy();
  assert.equal(listening(), 0, 'and stops on destroy');
  const before = posted.length;
  resize(300, 400);
  assert.equal(posted.length, before, 'a destroyed page posts nothing on a resize');
});
