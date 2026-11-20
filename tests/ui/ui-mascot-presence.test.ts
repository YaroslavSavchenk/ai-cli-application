/**
 * The peek mascot steps back while the app is the active window (Nocturne D8,
 * `.claude/plans/nocturne/PLAN-D8.md`): the host's `app-active` message
 * (`parseAppActive` / `onAppActive` in `web/src/ui/host-bridge.ts`), the pure
 * presence rules (`nextPresence`, `drawnState` in `web/src/mascot/model.ts`)
 * and the steps `web/src/mascot/presence.ts` runs between the model, the view
 * and the host.
 *
 * How: the REAL model (its timers injected, fired by hand), the REAL view on
 * the DOM double (`tests/helpers/fake-dom.ts`) and the REAL `HostReporter`,
 * whose posts are the strings the host would read. Whether a slide "runs" is
 * the stage's `getAnimations()` — given per test (`withAnimations`), with a
 * `finished` promise the test resolves; with none given nothing runs, which
 * is what a browser answers under `prefers-reduced-motion`.
 *
 * Why it matters: the host clips the overlay window to the rects the page
 * reports, and a region clips clicks AND drawing. Rects that go empty before
 * the slide ends cut the slide off; rects that stay after it leave an
 * invisible box blocking clicks on whatever is behind; rects that arrive
 * after the entrance starts clip its first frames.
 *
 * NOT claimed (a browser and the user's Windows check): that the slide looks
 * like the peek in reverse, that `getAnimations()` lists the stage's CSS
 * animation, or that the host posts `app-active` on foreground changes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FakeElement, byClass, installDom, type Dom } from '../helpers/fake-dom.ts';
import { nextImmediate } from '../helpers/helpers.ts';
import { withAnimations } from '../helpers/mascot-page.ts';

const dom: Dom = installDom();

const { MascotModel, drawnState, nextPresence } = await import('../../web/src/mascot/model.ts');
const { MascotView } = await import('../../web/src/mascot/view.ts');
const { MascotPresence } = await import('../../web/src/mascot/presence.ts');
const { HostReporter } = await import('../../web/src/mascot/feed.ts');
const { onAppActive, parseAppActive } = await import('../../web/src/ui/host-bridge.ts');
type HostWindow = import('../../web/src/ui/host-bridge.ts').HostWindow;

const CSS = readFileSync(fileURLToPath(new URL('../../web/src/mascot/mascot.css', import.meta.url)), 'utf8');

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** One page's worth: model + view + presence, wired like main.ts, posting to `posted`. */
function mount() {
  const root = new FakeElement('div');
  dom.body.append(root);
  const timers: { fn: () => void; ms: number }[] = [];
  const posted: string[] = [];
  const reporter = new HostReporter((m) => posted.push(m));
  const report = (): void => reporter.report(model.getCount(), view.rects());
  const model = new MascotModel({
    setTimeout: (fn, ms) => timers.push({ fn, ms }),
    clearTimeout: () => {},
    random: () => 0, // laugh
    onChange: (state) => presence.changed(state),
  });
  const view = new MascotView(root as unknown as HTMLElement, { onPoke: (slot) => model.poke(slot), onSettle: report });
  const presence = new MascotPresence({ model, view, report });
  view.render(model.snapshot());
  const stage = byClass(root, 'pm-stage')[0]!;
  return {
    root,
    stage,
    model,
    presence,
    timers,
    posted,
    last: (): unknown => JSON.parse(posted[posted.length - 1]!),
    mascots: (): number => byClass(root, 'pm-pos').length,
  };
}

/** A slide that runs until the test calls `end()`. */
function slide(): { list: () => { finished: Promise<unknown> }[]; end: () => void } {
  let end!: () => void;
  const finished = new Promise<unknown>((res) => (end = () => res(undefined)));
  return { list: () => [{ finished }], end };
}

const onStage = (el: FakeElement): boolean => el.classList.contains('pm-stage');
const onPos = (el: FakeElement): boolean => el.classList.contains('pm-pos');

/** The whole 220 x 340 stage at the right edge of the double's 1600 x 900 viewport. */
const STAGE: [number, number, number, number] = [1380, 280, 220, 340];

// ---------------------------------------------------------------------------
// The message
// ---------------------------------------------------------------------------

test('app-active is read strictly: a string whose JSON is {type:"app-active", active:<boolean>}', () => {
  assert.equal(parseAppActive('{"type":"app-active","active":true}'), true);
  assert.equal(parseAppActive('{"type":"app-active","active":false}'), false);
  assert.equal(parseAppActive('{"active":true,"type":"app-active"}'), true, 'key order is free');
  const bad: unknown[] = [
    { type: 'app-active', active: true }, // an object, not a string
    '{"type":"app-active","active":"true"}',
    '{"type":"app-active","active":1}',
    '{"type":"app-active"}',
    '{"type":"focus-session","active":true}',
    '["app-active",true]',
    'true',
    'null',
    '{',
    '',
    'copy-files ok 1',
    `{"type":"app-active","active":true${' '.repeat(200)}}`,
    undefined,
    null,
    7,
  ];
  for (const b of bad) assert.equal(parseAppActive(b), null, JSON.stringify(b) ?? String(b));
});

test('onAppActive listens only inside a host, forwards only valid messages, and unsubscribes', () => {
  const listeners = new Set<(e: { data?: unknown }) => void>();
  const win: HostWindow = {
    chrome: {
      webview: {
        postMessage: () => {},
        addEventListener: (_t, fn) => void listeners.add(fn),
        removeEventListener: (_t, fn) => void listeners.delete(fn),
      },
    },
  };
  const got: boolean[] = [];
  const off = onAppActive((a) => got.push(a), win);
  assert.equal(listeners.size, 1);
  for (const fn of listeners) {
    fn({ data: '{"type":"app-active","active":true}' });
    fn({ data: 'copy-files ok 1' });
    fn({ data: '{"type":"app-active","active":"no"}' });
    fn({});
    fn({ data: '{"type":"app-active","active":false}' });
  }
  assert.deepEqual(got, [true, false]);
  off();
  assert.equal(listeners.size, 0);
  const none = onAppActive(() => assert.fail('no host, never active'), {});
  none();
});

// ---------------------------------------------------------------------------
// The pure rules
// ---------------------------------------------------------------------------

test('nextPresence: not active brings them out from anywhere; active leaves only when no reaction plays', () => {
  const rows: [Parameters<typeof nextPresence>, string][] = [
    [['out', false, false], 'out'],
    [['leaving', false, false], 'out'],
    [['away', false, true], 'out'],
    [['out', true, false], 'leaving'],
    [['out', true, true], 'out'],
    [['leaving', true, false], 'leaving'],
    [['away', true, false], 'away'],
  ];
  for (const [args, want] of rows) assert.equal(nextPresence(...args), want, JSON.stringify(args));
});

test('drawnState: everything out, nothing away (the count kept), and the drawing untouched while leaving', () => {
  const m = new MascotModel({ setTimeout: () => 0, clearTimeout: () => {} });
  m.setCount(2);
  const state = m.snapshot();
  assert.equal(drawnState(state, 'out'), state);
  assert.deepEqual(drawnState(state, 'away'), { count: 2, slots: [] });
  assert.equal(drawnState(state, 'leaving'), null);
});

// ---------------------------------------------------------------------------
// The steps
// ---------------------------------------------------------------------------

test('until it hears anything the page assumes not active: the mascots are out and reported', () => {
  const p = mount();
  p.model.setCount(2);
  assert.equal(p.mascots(), 2);
  const msg = p.last() as { count: number; rects: unknown[] };
  assert.equal(msg.count, 2);
  assert.equal(msg.rects.length, 2);
});

test('active: the region is the whole stage while the slide runs, and rects [] only once it has ended', async () => {
  const p = mount();
  p.model.setCount(2);
  const s = slide();
  await withAnimations(onStage, s.list, async () => {
    p.presence.setActive(true);
    assert.ok(p.stage.classList.contains('pm-away'), 'the stage slides');
    assert.equal(p.mascots(), 2, 'the mascots are still there, sliding');
    assert.deepEqual(p.last(), { type: 'mascot-count', count: 2, rects: [STAGE, STAGE] }, 'region widened first');
    await nextImmediate();
    assert.equal(p.mascots(), 2, 'nothing changes before the slide ends');
    s.end();
    await nextImmediate();
  });
  assert.equal(p.mascots(), 0, 'gone once behind the edge');
  assert.deepEqual(p.last(), { type: 'mascot-count', count: 2, rects: [] }, 'the real count, an empty region');
});

test('while away a count change draws nothing and reports its count with rects []', async () => {
  const p = mount();
  p.model.setCount(1);
  await withAnimations(onStage, () => [], () => p.presence.setActive(true));
  p.model.setCount(3);
  assert.equal(p.mascots(), 0);
  assert.deepEqual(p.last(), { type: 'mascot-count', count: 3, rects: [] });
  p.model.setCount(0);
  assert.deepEqual(p.last(), { type: 'mascot-count', count: 0, rects: [] });
});

test('a count rise during the slide shows no new mascot', async () => {
  const p = mount();
  p.model.setCount(1);
  const s = slide();
  await withAnimations(onStage, s.list, async () => {
    p.presence.setActive(true);
    p.model.setCount(2);
    assert.equal(p.mascots(), 1, 'only the one that was out slides back');
    s.end();
    await nextImmediate();
  });
  assert.deepEqual(p.last(), { type: 'mascot-count', count: 2, rects: [] });
});

test('not active again: every mascot is drawn with its entrance and its rects are posted in the same call', async () => {
  const p = mount();
  p.model.setCount(2);
  await withAnimations(onStage, () => [], () => p.presence.setActive(true));
  assert.equal(p.mascots(), 0);
  const before = p.posted.length;
  await withAnimations(onPos, () => [{ finished: new Promise(() => {}) }], () => {
    p.presence.setActive(false);
    // Still inside the same task: the browser has not painted a frame yet.
    assert.equal(p.posted.length, before + 1, 'reported synchronously');
    assert.deepEqual(p.last(), { type: 'mascot-count', count: 2, rects: [STAGE, STAGE] }, 'the region is there');
    assert.ok(!p.stage.classList.contains('pm-away'), 'the stage is back');
    const pos = byClass(p.root, 'pm-pos');
    assert.equal(pos.length, 2);
    assert.match(String(pos[0]!.style.animation), /^slideIn 1\.4s/, 'the existing entrance, from the start');
    assert.match(String(pos[1]!.style.animation), /^climb 1\.6s/);
  });
});

test('a click reaction finishes first; the slide starts when it has ended', async () => {
  const p = mount();
  p.model.setCount(1);
  assert.equal(p.model.poke(0), 'laugh');
  const s = slide();
  await withAnimations(onStage, s.list, async () => {
    p.presence.setActive(true);
    assert.ok(!p.stage.classList.contains('pm-away'), 'no slide while it laughs');
    assert.equal(p.mascots(), 1);
    const laugh = p.timers.find((t) => t.ms === 1400);
    assert.ok(laugh, 'the laugh timer is armed');
    laugh.fn();
    assert.ok(p.stage.classList.contains('pm-away'), 'the laugh over, the slide starts');
    s.end();
    await nextImmediate();
  });
  assert.equal(p.mascots(), 0);
  assert.deepEqual(p.last(), { type: 'mascot-count', count: 1, rects: [] });
});

test('reduced motion: no slide — gone at once with rects [], and back at once with the tight box', async () => {
  const p = mount();
  p.model.setCount(1);
  // Under prefers-reduced-motion nothing runs on the stage or the position layers.
  await withAnimations(() => true, () => [], () => {
    p.presence.setActive(true);
    assert.equal(p.mascots(), 0, 'gone in the same call');
    assert.deepEqual(p.last(), { type: 'mascot-count', count: 1, rects: [] });
    p.presence.setActive(false);
    assert.equal(p.mascots(), 1, 'back in the same call');
    const rects = (p.last() as { rects: number[][] }).rects;
    assert.equal(rects.length, 1);
    assert.notDeepEqual(rects[0], STAGE, 'settled at once: the tight box, not the stage');
  });
});

test('not active again in the middle of the slide calls it back: no late rects [] after the mascots return', async () => {
  const p = mount();
  p.model.setCount(1);
  const s = slide();
  await withAnimations(onStage, s.list, async () => {
    p.presence.setActive(true);
    p.presence.setActive(false);
    assert.ok(!p.stage.classList.contains('pm-away'));
    s.end();
    await nextImmediate();
  });
  assert.equal(p.mascots(), 1, 'still out');
  const msg = p.last() as { count: number; rects: unknown[] };
  assert.equal(msg.rects.length, 1, 'the region stays');
});

test('the stylesheet: a 250 ms ease-in slide by the stage width, the fade in its last 100 ms; none under reduced motion', () => {
  assert.match(CSS, /\.pm-stage\.pm-away \{\s*animation: pmRetreat 0\.25s ease-in forwards;\s*\}/);
  const at = CSS.indexOf('@keyframes pmRetreat');
  const frames = CSS.slice(at, CSS.indexOf('\n}\n', at));
  assert.match(frames, /from \{ transform: translate\(0, -50%\); opacity: 1; \}/, 'keeps the stage centred');
  assert.match(frames, /60% \{ opacity: 1; \}/, '150 of 250 ms fully opaque');
  assert.match(frames, /to \{ transform: translate\(100%, -50%\); opacity: 0; \}/, 'off the right edge');
  const media = CSS.indexOf('@media (prefers-reduced-motion: reduce)');
  const block = CSS.slice(media, CSS.indexOf('\n}\n', media));
  assert.match(block, /\.pm-stage,\s*\.pm-pos,\s*\.pm-pos \* \{\s*animation: none !important;/);
});

// ---------------------------------------------------------------------------
// A called-back slide, each layer on its own
// ---------------------------------------------------------------------------
// The view (`retreat`'s `leave` counter) and the presence (`#retreated`'s
// 'leaving' check) both drop a slide that was called back. Through the wired
// page either one alone hides a missing other, so each is pinned by itself.

test('view: a slide called back by comeBack never calls its done, even when it ends later', async () => {
  const root = new FakeElement('div');
  dom.body.append(root);
  const view = new MascotView(root as unknown as HTMLElement, { onPoke: () => {} });
  const s = slide();
  let done = 0;
  await withAnimations(onStage, s.list, async () => {
    view.retreat(() => done++);
    view.comeBack();
    s.end();
    await nextImmediate();
  });
  assert.equal(done, 0, 'a called-back slide reports nothing');
  view.destroy();
});

test('presence: a done from a slide it already called back is ignored — the mascots stay out', () => {
  const m = new MascotModel({ setTimeout: () => 0, clearTimeout: () => {} });
  m.setCount(1);
  const dones: (() => void)[] = [];
  const renders: number[] = [];
  let reports = 0;
  const presence = new MascotPresence({
    model: m,
    view: { render: (s) => void renders.push(s.slots.length), retreat: (done) => void dones.push(done), comeBack: () => {} },
    report: () => void reports++,
  });
  presence.setActive(true);
  presence.setActive(false);
  const before = { renders: renders.length, reports };
  assert.equal(dones.length, 1, 'one slide was started');
  dones[0]!(); // a view that let the stale slide through
  assert.equal(renders.length, before.renders, 'nothing redrawn: no empty "away" render');
  assert.equal(reports, before.reports, 'no late rects [] to the host');
  presence.changed(m.snapshot());
  assert.equal(renders[renders.length - 1], 1, 'still out');
});
