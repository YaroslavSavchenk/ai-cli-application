/**
 * `web/src/mascot/main.ts`, the live peek-mascot page (Nocturne C1,
 * `.claude/plans/nocturne/PLAN-C1.md`): it says its mascots' rects to the
 * host again when the window is resized, and only when they changed.
 *
 * How: the REAL page entry, mounted on the DOM double by
 * `tests/helpers/mascot-page.ts` (a fake `window.chrome.webview` that records
 * every string the page posts, the .css import stubbed, the feed never
 * answering) — the count is driven through the page's own seam,
 * `window.aiSmMascot.setCount`, and no real timer holds the runner.
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
import { FakeElement, byClass, setRect } from '../helpers/fake-dom.ts';
import { mountMascotPage } from '../helpers/mascot-page.ts';

const { dom, root, posted, page, lastPosted } = await mountMascotPage('');

/** Resize the viewport and fire the window's `resize` listeners, as a browser does. */
function resize(width: number, height: number): void {
  dom.win.innerWidth = width;
  dom.win.innerHeight = height;
  for (const h of [...dom.win.handlers]) if (h.type === 'resize') h.fn({ type: 'resize' } as never);
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
