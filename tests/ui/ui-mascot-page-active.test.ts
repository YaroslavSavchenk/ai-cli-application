/**
 * `web/src/mascot/main.ts`, the live peek-mascot page, hears the host's
 * `app-active` (Nocturne D8, `.claude/plans/nocturne/PLAN-D8.md`): the
 * mascots step back while the app is the active window and come out again
 * when it is not.
 *
 * How: the REAL page entry, mounted on the DOM double by
 * `tests/helpers/mascot-page.ts`; the test plays the host through the fake
 * `chrome.webview` (`send`) and reads what the page posts back. No CSS runs
 * on the double, so nothing animates — the steps run as they do under
 * `prefers-reduced-motion` — except where a test gives the stage a slide
 * (`withAnimations`) to end after `destroy()`; the slide's timing is pinned
 * in `tests/ui/ui-mascot-presence.test.ts`.
 *
 * Why it matters: this is the only wiring between the host's message and the
 * presence steps — a page that never subscribes, keeps listening after
 * `destroy()`, or still reports when a slide ends after `destroy()`, passes
 * every unit test.
 *
 * NOT claimed: that WebView2 delivers the host's string as `e.data`, or that
 * the host posts it on foreground changes — the user's Windows check does.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { byClass } from '../helpers/fake-dom.ts';
import { nextImmediate } from '../helpers/helpers.ts';
import { mountMascotPage, withAnimations } from '../helpers/mascot-page.ts';

const { root, posted, listeners, page, send, lastPosted } = await mountMascotPage('');
const mascots = (): number => byClass(root, 'pm-pos').length;

test('the live page listens to the host once it mounts', () => {
  assert.equal(listeners.size, 1);
  assert.deepEqual(lastPosted(), { type: 'mascot-count', count: 0, rects: [] }, 'not active until told: C1 as before');
});

test('app-active true takes the mascots in and reports the real count with rects []', () => {
  page.setCount(2);
  assert.equal(mascots(), 2);
  send('{"type":"app-active","active":true}');
  assert.equal(mascots(), 0);
  assert.deepEqual(lastPosted(), { type: 'mascot-count', count: 2, rects: [] });
});

test('anything that is not an app-active string is ignored', () => {
  const before = posted.length;
  for (const data of ['{"type":"app-active","active":"false"}', '{"type":"app-active"}', 'nope', { type: 'app-active', active: false }]) {
    send(data);
  }
  assert.equal(posted.length, before, 'nothing changed, nothing posted');
  assert.equal(mascots(), 0);
});

test('app-active false brings them out again with their rects', () => {
  send('{"type":"app-active","active":false}');
  assert.equal(mascots(), 2);
  const msg = lastPosted() as { count: number; rects: unknown[] };
  assert.equal(msg.count, 2);
  assert.equal(msg.rects.length, 2);
});

// A slide still running when the page is destroyed (the dev seam's
// `destroy()`): its end must not draw or tell the host anything.
let finishSlide!: () => void;
const slideFinished = new Promise<unknown>((res) => (finishSlide = () => res(undefined)));

test('app-active true with a slide running widens the region to the stage while it slides', async () => {
  await withAnimations((el) => el.classList.contains('pm-stage'), () => [{ finished: slideFinished }], () => {
    send('{"type":"app-active","active":true}');
  });
  assert.ok(byClass(root, 'pm-stage')[0]!.classList.contains('pm-away'), 'the stage slides');
  assert.equal(mascots(), 2, 'still there, sliding');
});

test('destroy stops listening to the host', () => {
  page.destroy();
  assert.equal(listeners.size, 0);
});

test('a slide that ends after destroy draws nothing and posts nothing', async () => {
  const before = posted.length;
  finishSlide();
  await nextImmediate();
  await nextImmediate();
  assert.equal(posted.length, before, 'no mascot-count after destroy');
  assert.equal(byClass(root, 'pm-stage').length, 0, 'the stage stays removed');
  assert.equal(mascots(), 0, 'nothing drawn');
});
