/**
 * `web/src/mascot/view.ts` — the renderer of the Claude peek mascots, driven
 * on the shared DOM double (`tests/helpers/fake-dom.ts`) against the REAL
 * `web/src/mascot/model.ts`.
 *
 * WHY, next to `tests/ui/ui-mascot-model.test.ts`. That file pins the rules; this
 * one pins the two things a renderer of a HIGH-FIDELITY handoff
 * (`design/peek-mascot/README.md`) can quietly get wrong:
 *
 *   - the ARTWORK: the handoff says "Draw order matters" and lists every rect
 *     of the 15x18 pixel grid. A rect in the wrong order, at the wrong
 *     coordinate or in the wrong colour is invisible to any rule test, and a
 *     human reviewing a 100x120 px mascot will not count its pixels either.
 *   - the WRITE-IF-CHANGED discipline: assigning `animation` in CSS RESTARTS
 *     it. A view that rewrites the position layer on every render would replay
 *     slot 1's 1.6s climb every time slot 0 laughs, and would jump slot 1's
 *     `bottom` instead of running the .7s transition. That is only observable
 *     as "which style properties were written", so this file records writes.
 *
 * It also pins the stylesheet's keyframes against the handoff text, because
 * "copy verbatim" is only true until someone retimes one.
 *
 * NOT claimed (a browser and a human eye, no automation here): that anything
 * is visible, that the screen edge really clips the bodies, that the
 * animations look right, that a click target is where the mascot is drawn, or
 * that `web/src/mascot/main.ts` mounts — main.ts imports a .css and reads
 * `window.location`, so it is not loadable under `node:test`; what it does is
 * unpinned, see the report's coverage note.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  FakeElement,
  byClass,
  descendants,
  dispatch,
  installDom,
  setRect,
  type Dom,
} from '../helpers/fake-dom.ts';

const dom: Dom = installDom();

const { MascotModel } = await import('../../web/src/mascot/model.ts');
const { MascotView } = await import('../../web/src/mascot/view.ts');
type Model = InstanceType<typeof MascotModel>;
type View = InstanceType<typeof MascotView>;

const REPO = new URL('../..', import.meta.url);
// The handoff is a local design asset, excluded from git (.git/info/exclude,
// like design/session-manager) — the keyframe parity test skips
// where it is absent (CI) instead of failing the whole file at import.
const README_PATH = fileURLToPath(new URL('design/peek-mascot/README.md', REPO));
const CSS = readFileSync(fileURLToPath(new URL('web/src/mascot/mascot.css', REPO)), 'utf8');

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** Style writes per element, so "was this property written again?" is a fact. */
const writes = new WeakMap<FakeElement, string[]>();

function recording(el: FakeElement): FakeElement {
  const log: string[] = [];
  writes.set(el, log);
  const real = el.style;
  const spy = new Proxy(real, {
    set(target, key, value) {
      log.push(`${String(key)}=${String(value)}`);
      (target as unknown as Record<string, unknown>)[key as string] = value;
      return true;
    },
  });
  Object.defineProperty(el, 'style', { value: spy, configurable: true });
  return el;
}

// Every element the view builds records its style writes. Generic: the double
// itself stays untouched, and nothing here knows what a mascot is.
dom.doc.createElement = (tag: string) => recording(new FakeElement(tag));
dom.doc.createElementNS = (_ns: string, tag: string) => recording(new FakeElement(tag));

function written(el: FakeElement): string[] {
  return writes.get(el) ?? [];
}

interface Harness {
  root: FakeElement;
  model: Model;
  view: View;
  poked: number[];
  /** Fire a timer the model armed, by its delay. */
  fire(ms: number): void;
}

function mount(random = (): number => 0): Harness {
  const root = new FakeElement('div');
  dom.body.append(root);
  const timers: { fn: () => void; ms: number; id: number }[] = [];
  let seq = 0;
  const poked: number[] = [];
  let view!: View;
  const model: Model = new MascotModel({
    setTimeout: (fn, ms) => {
      seq += 1;
      timers.push({ fn, ms, id: seq });
      return seq;
    },
    clearTimeout: (handle) => {
      const i = timers.findIndex((t) => t.id === handle);
      if (i !== -1) timers.splice(i, 1);
    },
    random,
    onChange: (state) => view.render(state),
  });
  view = new MascotView(root as unknown as HTMLElement, {
    onPoke: (slot) => {
      poked.push(slot);
      model.poke(slot);
    },
  });
  view.render(model.snapshot());
  return {
    root,
    model,
    view,
    poked,
    fire(ms: number) {
      const i = timers.findIndex((t) => t.ms === ms);
      assert.notEqual(i, -1, `no timer armed for ${ms} ms`);
      const [t] = timers.splice(i, 1);
      t!.fn();
    },
  };
}

const stageOf = (h: Harness): FakeElement => byClass(h.root, 'pm-stage')[0]!;
const posOf = (h: Harness): FakeElement[] => byClass(h.root, 'pm-pos');
const layersOf = (pos: FakeElement): { tilt: FakeElement; react: FakeElement; svg: FakeElement } => {
  const tilt = pos.children[0] as FakeElement;
  const react = tilt.children[0] as FakeElement;
  return { tilt, react, svg: react.children[0] as FakeElement };
};

/** `[x, y, width, height, fill]` of every rect under `el`, in document order. */
function rectsOf(el: FakeElement): string[][] {
  return descendants(el)
    .filter((n) => n.tagName === 'RECT')
    .map((n) => ['x', 'y', 'width', 'height', 'fill'].map((a) => n.getAttribute(a) ?? ''));
}

// ---------------------------------------------------------------------------
// The stage
// ---------------------------------------------------------------------------

test('the stage is one aria-hidden element, and count 0 puts no mascot in it', () => {
  const h = mount();
  const stage = stageOf(h);
  assert.equal(byClass(h.root, 'pm-stage').length, 1);
  assert.equal(stage.getAttribute('aria-hidden'), 'true', 'decorative art, not an interface');
  assert.equal(stage.children.length, 0);
  assert.equal(posOf(h).length, 0);
});

test('the number of mascots on the stage is the count, up and down', () => {
  const h = mount();
  for (const [count, drawn] of [
    [1, 1],
    [2, 2],
    [3, 3],
    [7, 3],
    [2, 2],
    [0, 0],
  ] as const) {
    h.model.setCount(count);
    assert.equal(posOf(h).length, drawn, `count ${count}`);
    assert.equal(stageOf(h).children.length, drawn, 'and nothing orphaned on the stage');
  }
});

test('each mascot is the handoff\'s three nested layers', () => {
  const h = mount();
  h.model.setCount(1);
  const pos = posOf(h)[0]!;
  assert.equal(pos.children.length, 1);
  const { tilt, react, svg } = layersOf(pos);
  assert.equal(tilt.className, 'pm-tilt');
  assert.equal(react.className, 'pm-react');
  assert.equal(react.children.length, 1);
  assert.equal(svg.tagName, 'SVG');
  assert.equal(svg.getAttribute('width'), '100');
  assert.equal(svg.getAttribute('height'), '120');
  assert.equal(svg.getAttribute('viewBox'), '0 0 15 18');
  assert.equal(svg.getAttribute('shape-rendering'), 'crispEdges');
  assert.equal(svg.getAttribute('class'), 'pm-art');
});

// ---------------------------------------------------------------------------
// Position, per slot
// ---------------------------------------------------------------------------

test('the inline position and animation strings are the pose table', () => {
  const h = mount();
  h.model.setCount(3);
  const rows = posOf(h).map((pos) => {
    const { tilt, react } = layersOf(pos);
    return {
      right: pos.style.right,
      bottom: pos.style.bottom,
      zIndex: pos.style.zIndex,
      animation: pos.style.animation,
      tilt: tilt.style.transform,
      react: react.style.animation,
    };
  });
  assert.deepEqual(rows, [
    {
      right: '-50px',
      bottom: '14px',
      zIndex: '3',
      animation: 'slideIn 1.4s cubic-bezier(.25,.8,.3,1) both, shove .4s ease-in-out 0.4s 5',
      tilt: 'rotate(-22deg)',
      react: 'strain 1.1s ease-in-out infinite',
    },
    {
      right: '-40px',
      bottom: '110px',
      zIndex: '1',
      animation: 'climb 1.6s cubic-bezier(.4,.1,.4,1) both, shove .4s ease-in-out 0.5s 5',
      tilt: 'rotate(-8deg)',
      react: 'bob 3s ease-in-out infinite',
    },
    {
      right: '-16px',
      bottom: '52px',
      zIndex: '2',
      animation: 'squeeze 2.6s ease-in-out both',
      tilt: 'rotate(6deg)',
      react: 'bob 3s ease-in-out infinite',
    },
  ]);
});

test('at count 2 slot 1 stands at 58px and nobody shoves', () => {
  const h = mount();
  h.model.setCount(2);
  const [first, second] = posOf(h);
  assert.equal(second!.style.bottom, '58px');
  assert.equal(second!.style.animation, 'climb 1.6s cubic-bezier(.4,.1,.4,1) both');
  assert.equal(first!.style.animation, 'slideIn 1.4s cubic-bezier(.25,.8,.3,1) both');
});

// ---------------------------------------------------------------------------
// Draw order and artwork (handoff §SVG pixel art)
// ---------------------------------------------------------------------------

test('the svg draw order is the handoff\'s six steps', () => {
  const h = mount();
  h.model.setCount(1);
  const { svg } = layersOf(posOf(h)[0]!);
  const kids = svg.children as FakeElement[];
  assert.deepEqual(
    kids.map((n) => n.tagName),
    ['PATH', 'G', 'G', 'G', 'G'],
    'outline path first, then body, left arm, right arm + feet, face',
  );

  const [outline, body, arm, trailing, face] = kids;
  // 1. silhouette
  assert.equal(
    outline!.getAttribute('d'),
    'M4 5 H13 V6 H14 V8 H15 V12 H14 V13 H13 V14 H12 V17 H10 V14 H7 V17 H5 V14 H4 V13 H3 V13 H1 V8 H3 V6 H4 Z',
    'the arm-down outline, verbatim',
  );
  assert.equal(outline!.getAttribute('fill'), '#2d2b26');
  assert.equal(outline!.getAttribute('stroke'), '#2d2b26');
  assert.equal(outline!.getAttribute('stroke-width'), '1');
  assert.equal(outline!.getAttribute('stroke-linejoin'), 'miter');

  // 2. body
  assert.deepEqual(rectsOf(body!), [
    ['4', '5', '9', '1', '#d97757'],
    ['3', '6', '11', '7', '#d97757'],
    ['4', '13', '9', '1', '#c96442'],
    ['4', '6', '2', '1', '#eb9878'],
    ['4', '7', '1', '1', '#eb9878'],
    ['12', '7', '1', '6', '#c96442'],
  ]);

  // 3. left arm, down
  assert.deepEqual(rectsOf(arm!), [
    ['1', '8', '2', '4', '#d97757'],
    ['1', '12', '2', '1', '#eb9878'],
  ]);

  // 4 + 5. right arm, feet, soles
  assert.deepEqual(rectsOf(trailing!), [
    ['14', '8', '1', '4', '#c96442'],
    ['5', '14', '2', '2', '#d97757'],
    ['10', '14', '2', '2', '#d97757'],
    ['5', '16', '2', '1', '#c96442'],
    ['10', '16', '2', '1', '#c96442'],
  ]);

  // 6. face, normal: blinking eyes in their own group, then the mouth.
  const eyes = face!.children[0] as FakeElement;
  assert.equal(eyes.tagName, 'G');
  assert.equal(eyes.style.animation, 'blink 4s infinite');
  assert.equal(eyes.style.transformOrigin, '8.5px 9px');
  assert.deepEqual(rectsOf(eyes), [
    ['6', '8', '1', '2', '#2d2b26'],
    ['10', '8', '1', '2', '#2d2b26'],
  ]);
  assert.deepEqual(rectsOf(face!).slice(2), [['8', '11', '1', '1', '#2d2b26']], 'the mouth does not blink');
});

test('the arm-up pose draws the up outline and the raised arm', () => {
  const h = mount();
  h.model.setCount(2);
  const { svg } = layersOf(posOf(h)[1]!);
  assert.equal(
    (svg.children[0] as FakeElement).getAttribute('d'),
    'M4 5 H13 V6 H14 V8 H15 V12 H14 V13 H13 V14 H12 V17 H10 V14 H7 V17 H5 V14 H4 V13 H3 V9 H1 V2 H3 V6 H4 Z',
  );
  assert.deepEqual(rectsOf(svg.children[2] as FakeElement), [
    ['1', '3', '2', '6', '#d97757'],
    ['1', '2', '2', '1', '#eb9878'],
  ]);
});

test('a wave swaps the outline and hangs the arm in its own animated group', () => {
  const h = mount(() => 0.99); // wave
  h.model.setCount(1);
  const { svg } = layersOf(posOf(h)[0]!);
  dispatch(layersOf(posOf(h)[0]!).react, 'click');

  assert.equal(
    (svg.children[0] as FakeElement).getAttribute('d'),
    'M4 5 H13 V6 H14 V8 H15 V12 H14 V13 H13 V14 H12 V17 H10 V14 H7 V17 H5 V14 H4 V13 H3 V6 H4 Z',
    'the waving silhouette has no left arm in it',
  );
  const waving = (svg.children[2] as FakeElement).children[0] as FakeElement;
  assert.equal(waving.tagName, 'G');
  assert.equal(waving.style.transformOrigin, '2px 9px');
  assert.equal(waving.style.animation, 'wave 1.3s ease-in-out 1');
  assert.deepEqual(rectsOf(waving), [
    ['0.5', '2.5', '2.5', '7', '#2d2b26'],
    ['1', '4', '2', '5', '#d97757'],
    ['1', '3', '2', '1', '#eb9878'],
  ]);
});

test('the laughing face is the happy artwork', () => {
  const h = mount(() => 0); // laugh
  h.model.setCount(1);
  dispatch(layersOf(posOf(h)[0]!).react, 'click');
  const { svg } = layersOf(posOf(h)[0]!);
  assert.deepEqual(rectsOf(svg.children[4] as FakeElement), [
    ['5', '8', '1', '1', '#2d2b26'],
    ['6', '7', '1', '1', '#2d2b26'],
    ['7', '8', '1', '1', '#2d2b26'],
    ['9', '8', '1', '1', '#2d2b26'],
    ['10', '7', '1', '1', '#2d2b26'],
    ['11', '8', '1', '1', '#2d2b26'],
    ['6', '11', '5', '1', '#2d2b26'],
    ['5', '10', '1', '1', '#2d2b26'],
    ['11', '10', '1', '1', '#2d2b26'],
  ]);
});

test('the strain face carries the one blue sweat drop', () => {
  const h = mount();
  h.model.setCount(3);
  const { svg } = layersOf(posOf(h)[0]!);
  const face = rectsOf(svg.children[4] as FakeElement);
  assert.deepEqual(face, [
    ['5', '8', '1', '1', '#2d2b26'],
    ['6', '9', '2', '1', '#2d2b26'],
    ['11', '8', '1', '1', '#2d2b26'],
    ['9', '9', '2', '1', '#2d2b26'],
    ['6', '11', '5', '1', '#2d2b26'],
    ['7', '12', '1', '1', '#2d2b26'],
    ['9', '12', '1', '1', '#2d2b26'],
    ['12', '6', '1', '1', '#9cc7e8'],
  ]);
  assert.equal(
    face.filter((r) => r[4] === '#9cc7e8').length,
    1,
    'the sweat drop is the only non-ink pixel of a face',
  );

  // …and it is gone once the strain runs out.
  h.fire(3400);
  assert.equal(
    rectsOf(layersOf(posOf(h)[0]!).svg.children[4] as FakeElement).some((r) => r[4] === '#9cc7e8'),
    false,
  );
});

// ---------------------------------------------------------------------------
// The click
// ---------------------------------------------------------------------------

test('a click on the reaction layer reaches the model', () => {
  const h = mount(() => 0); // laugh
  h.model.setCount(2);
  const react = layersOf(posOf(h)[1]!).react;
  assert.equal(react.title, 'Click me');

  dispatch(react, 'click');
  assert.deepEqual(h.poked, [1], 'the slot it was clicked on, not another');
  assert.equal(layersOf(posOf(h)[1]!).react.style.animation, 'laugh 1.4s ease-in-out 1');

  // A click while reacting still reaches the model — and the model ignores it.
  dispatch(react, 'click');
  assert.deepEqual(h.poked, [1, 1]);
  assert.equal(layersOf(posOf(h)[1]!).react.style.animation, 'laugh 1.4s ease-in-out 1');

  h.fire(1400);
  assert.equal(layersOf(posOf(h)[1]!).react.style.animation, 'bob 3s ease-in-out infinite');
});

test('a click on a mascot that left the screen pokes nothing', () => {
  const h = mount();
  h.model.setCount(3);
  const gone = layersOf(posOf(h)[2]!).react;
  h.model.setCount(1);
  dispatch(gone, 'click');
  assert.deepEqual(h.poked, [2], 'the handler still fires on a detached node…');
  assert.equal(h.model.getCount(), 1, '…and the model refuses a slot that is not on screen');
  assert.equal(posOf(h).length, 1);
});

// ---------------------------------------------------------------------------
// Stable nodes, write-if-changed
// ---------------------------------------------------------------------------

test('slot nodes are reused across a 2 -> 3 re-render, never rebuilt', () => {
  const h = mount();
  h.model.setCount(2);
  const before = posOf(h);
  const svgBefore = before.map((p) => layersOf(p).svg);

  h.model.setCount(3);
  const after = posOf(h);
  assert.equal(after.length, 3);
  assert.equal(after[0], before[0], 'slot 0 is the same node');
  assert.equal(after[1], before[1], 'slot 1 is the same node');
  assert.equal(layersOf(after[0]!).svg, svgBefore[0], 'and so is its artwork');
  assert.equal(layersOf(after[1]!).svg, svgBefore[1]);

  h.model.setCount(2);
  assert.equal(posOf(h)[0], before[0], 'and back down');
  assert.equal(posOf(h)[1], before[1]);
});

test('a re-render writes a style property only when its value changed', () => {
  const h = mount(() => 0); // laugh
  h.model.setCount(2);
  const [pos0, pos1] = posOf(h);
  const react0 = layersOf(pos0!).react;

  const posWrites = written(pos1!).length;
  const tiltWrites = written(layersOf(pos1!).tilt).length;

  // Slot 0 laughs: slot 1 is re-rendered with the same values.
  dispatch(react0, 'click');
  assert.equal(written(pos1!).length, posWrites, 'slot 1\'s climb is not restarted by a neighbour');
  assert.equal(written(layersOf(pos1!).tilt).length, tiltWrites);

  h.fire(1400);
  assert.equal(written(pos1!).length, posWrites);

  // Only the two values the handoff makes count-dependent are rewritten when
  // the third mascot arrives: `bottom` (58px -> 110px) and the entrance.
  const baseline = written(pos1!).length;
  h.model.setCount(3);
  assert.deepEqual(written(pos1!).slice(baseline), [
    'bottom=110px',
    'animation=climb 1.6s cubic-bezier(.4,.1,.4,1) both, shove .4s ease-in-out 0.5s 5',
  ]);
});

test('a neighbour\'s reaction does not rebuild a face: the blink would restart', () => {
  const h = mount(() => 0); // laugh
  h.model.setCount(2);
  const eyesBefore = (layersOf(posOf(h)[1]!).svg.children[4] as FakeElement).children[0];

  dispatch(layersOf(posOf(h)[0]!).react, 'click');
  assert.equal(
    (layersOf(posOf(h)[1]!).svg.children[4] as FakeElement).children[0],
    eyesBefore,
    'slot 1 kept its blinking eyes while slot 0 laughed',
  );

  h.fire(1400);
  assert.equal((layersOf(posOf(h)[1]!).svg.children[4] as FakeElement).children[0], eyesBefore);

  h.model.setCount(3);
  assert.equal(
    (layersOf(posOf(h)[1]!).svg.children[4] as FakeElement).children[0],
    eyesBefore,
    'nor when a third mascot arrived',
  );
});

test('only the artwork whose variant changed is rebuilt', () => {
  const h = mount(() => 0); // laugh
  h.model.setCount(1);
  const { svg } = layersOf(posOf(h)[0]!);
  const body = svg.children[1] as FakeElement;
  const trailing = svg.children[3] as FakeElement;
  const bodyRects = body.children[0];
  const armBefore = (svg.children[2] as FakeElement).children[0];

  dispatch(layersOf(posOf(h)[0]!).react, 'click');
  assert.equal(body.children[0], bodyRects, 'the body is never rebuilt');
  assert.equal(trailing.children[0], (svg.children[3] as FakeElement).children[0]);
  assert.equal(
    (svg.children[2] as FakeElement).children[0],
    armBefore,
    'a laugh does not touch the arm, so the arm is left alone',
  );
});

test('destroy takes the whole stage out of the page', () => {
  const h = mount();
  h.model.setCount(3);
  h.view.destroy();
  assert.equal(byClass(h.root, 'pm-stage').length, 0);
  assert.equal(h.root.children.length, 0);
});

// ---------------------------------------------------------------------------
// The stylesheet against the handoff
// ---------------------------------------------------------------------------

test('every keyframe block is the handoff\'s, character for character', (t) => {
  if (!existsSync(README_PATH)) {
    t.skip('design/peek-mascot/README.md is not present (local design asset, excluded from git) — keyframe parity cannot be checked here');
    return;
  }
  const wanted = readFileSync(README_PATH, 'utf8').split('\n').filter((l) => l.startsWith('@keyframes'));
  const shipped = CSS.split('\n').filter((l) => l.startsWith('@keyframes'));
  assert.equal(wanted.length, 10, 'the handoff lists ten');
  for (const line of wanted) {
    const name = line.slice('@keyframes '.length).split(' ')[0];
    assert.ok(shipped.includes(line), `retimed or missing: @keyframes ${name}`);
  }
  assert.deepEqual(shipped, wanted, 'no extra, no reordering');
});

test('the stage and the three layers carry the handoff\'s CSS facts', () => {
  for (const decl of [
    'position: fixed',
    'right: 0',
    'top: 50%',
    'width: 220px',
    'height: 340px',
    'transform: translateY(-50%)',
    'pointer-events: none',
  ]) {
    assert.ok(CSS.includes(decl), `.pm-stage is missing \`${decl}\``);
  }
  assert.ok(CSS.includes('transform-origin: 80% 100%'), 'the tilt layer hinges at the feet');
  assert.ok(CSS.includes('transform-origin: center bottom'), 'the reaction layer hinges at the ground');
  // C1 fix (Windows check: with several mascots only ONE could be clicked):
  // no layer BOX takes a click — the 100 x 120 boxes overlap and the front
  // one swallowed clicks on the others' visible bodies. Only painted art does.
  const rule = (sel: string): string => {
    const at = CSS.indexOf(`${sel} {`);
    assert.ok(at >= 0, `no rule for ${sel}`);
    return CSS.slice(at, CSS.indexOf('}', at));
  };
  assert.match(rule('.pm-pos'), /pointer-events: none;/, 'the position layer box takes no click');
  assert.doesNotMatch(rule('.pm-react'), /pointer-events: auto|cursor/, 'nor the reaction layer box');
  assert.doesNotMatch(CSS, /pointer-events: auto/, 'no box anywhere takes clicks back');
  assert.match(
    CSS,
    /\.pm-art path,\s*\.pm-art rect \{\s*pointer-events: visiblePainted;\s*cursor: pointer;/,
    'the painted pixels are the hit area',
  );
  assert.ok(/transition:\s*\n?\s*bottom 0\.7s cubic-bezier\(0\.3, 1\.4, 0\.5, 1\)/.test(CSS));
});

// ---------------------------------------------------------------------------
// rects() — the host's click-through region (Nocturne C1, PLAN-C1 § The window)
// ---------------------------------------------------------------------------

/** A view with `onSettle` wired, over a model driven by hand. */
function mountSettling(): { model: Model; view: View; root: FakeElement; settled: number[] } {
  const root = new FakeElement('div');
  dom.body.append(root);
  const settled: number[] = [];
  let view!: View;
  const model: Model = new MascotModel({
    setTimeout: () => 0,
    clearTimeout: () => {},
    random: () => 0,
    onChange: (state) => view.render(state),
  });
  view = new MascotView(root as unknown as HTMLElement, {
    onPoke: (slot) => model.poke(slot),
    onSettle: () => settled.push(settled.length),
  });
  view.render(model.snapshot());
  return { model, view, root, settled };
}

/** Give every position layer a `getAnimations()` for the length of `fn`. */
async function withAnimations(
  list: () => { finished: Promise<unknown> }[],
  fn: () => Promise<void>,
): Promise<void> {
  const proto = FakeElement.prototype as unknown as Record<string, unknown>;
  proto.getAnimations = function (this: FakeElement) {
    return String(this.className).includes('pm-pos') ? list() : [];
  };
  try {
    await fn();
  } finally {
    delete proto.getAnimations;
  }
}

test('rects(): each settled mascot is its reaction box + 16 px, rounded OUTWARD, clipped to the page, slot order', () => {
  const { model, view, root } = mountSettling();
  assert.deepEqual(view.rects(), [], 'count 0: an empty region');
  model.setCount(2);
  const [p0, p1] = byClass(root, 'pm-pos');
  // Slot 0 at fractional px (outward rounding), slot 1 half past the right
  // edge of the 1600 x 900 page (clipped).
  setRect(layersOf(p0!).react, { left: 1400.4, top: 300.6, width: 100, height: 120.2 });
  setRect(layersOf(p1!).react, { left: 1550, top: 350, width: 100, height: 120 });
  assert.deepEqual(view.rects(), [
    [1384, 284, 1517 - 1384, 437 - 284],
    [1534, 334, 1600 - 1534, 486 - 334],
  ]);
  view.destroy();
});

test('rects(): while an entrance runs a mascot claims the whole stage, then settles and says so', async () => {
  let done!: () => void;
  const finished = new Promise<void>((res) => (done = res));
  await withAnimations(
    () => [{ finished }],
    async () => {
      const { model, view, root, settled } = mountSettling();
      model.setCount(1);
      setRect(layersOf(byClass(root, 'pm-pos')[0]!).react, { left: 1450, top: 380, width: 100, height: 120 });
      // The 220 x 340 stage at the right edge, vertically centred on 900.
      assert.deepEqual(view.rects(), [[1380, 280, 220, 340]], 'mid-climb: the whole stage');
      assert.deepEqual(settled, []);
      done();
      for (let i = 0; i < 5; i++) await Promise.resolve();
      assert.equal(settled.length, 1, 'onSettle once the entrance is over');
      assert.deepEqual(view.rects(), [[1434, 364, 132, 152]], 'then the tight box');
      view.destroy();
    },
  );
});

test('rects(): with no running animation (reduced motion) a mascot is settled the moment it is drawn', async () => {
  await withAnimations(
    () => [],
    async () => {
      const { model, view, root, settled } = mountSettling();
      model.setCount(1);
      setRect(layersOf(byClass(root, 'pm-pos')[0]!).react, { left: 1450, top: 380, width: 100, height: 120 });
      assert.deepEqual(view.rects(), [[1434, 364, 132, 152]], 'tight at once: nothing to wait on');
      for (let i = 0; i < 5; i++) await Promise.resolve();
      assert.deepEqual(settled, [], 'and no settle report for an entrance that never ran');
      view.destroy();
    },
  );
});

test('rects(): a position MOVE alone (the .7s bottom transition) is watched too, then re-reported tight', async () => {
  let done!: () => void;
  const finished = new Promise<void>((res) => (done = res));
  let running: { finished: Promise<unknown> }[] = [];
  await withAnimations(
    () => running,
    async () => {
      const { model, view, root, settled } = mountSettling();
      model.setCount(2); // nothing running: settled at once
      const state = model.snapshot();
      setRect(layersOf(byClass(root, 'pm-pos')[1]!).react, { left: 1450, top: 380, width: 100, height: 120 });
      assert.deepEqual(view.rects()[1], [1434, 364, 132, 152]);
      // Only slot 1's `bottom` changes — no entrance restarts — and the browser
      // lists the CSS transition it started on the position layer.
      running = [{ finished }];
      const moved = { ...state, slots: state.slots.map((v) => (v.slot === 1 ? { ...v, bottom: '110px' } : v)) };
      view.render(moved);
      running = [];
      assert.deepEqual(view.rects()[1], [1380, 280, 220, 340], 'mid-move: the whole stage, never a stale box');
      done();
      for (let i = 0; i < 5; i++) await Promise.resolve();
      assert.equal(settled.length, 1, 'onSettle when the move ends');
      assert.deepEqual(view.rects()[1], [1434, 364, 132, 152], 'then the tight box where it stands');
      view.destroy();
    },
  );
});
