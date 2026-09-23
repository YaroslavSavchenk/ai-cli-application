/**
 * `web/src/ui/pane-reuse-model.ts` — which pane card each slot of a
 * re-laid-out tab takes (Quality part P2, `.claude/plans/PLAN-QUALITY.md`).
 *
 * How: the pure rule is called directly, first on hand-written key lists, then
 * on the key lists the REAL state transitions produce (`web/src/state.ts`:
 * `moveSessionToView` for a split, `extractSession` for "Own tab",
 * `movePane` for a swap, `mergeViews` for a top-zone split), so a change to
 * how state.ts orders slots cannot slip past the rule unnoticed.
 *
 * Why it matters: a card that is NOT kept is a terminal disposed and attached
 * again — the server then replays its whole scrollback (P0 measured 1.28 MB
 * per pane and a 240 ms stall for a 2→3 split). Nothing on screen says it
 * happened except a flicker, so only a test notices it coming back.
 *
 * Since P5 the file also drives `tabsToEvict`, the cap on live terminals
 * across parked tabs: least recently seen first, whole tabs, the shown tab
 * never.
 *
 * NOT claimed: that `ui/panes.ts` follows the plan (that is
 * `tests/ui/ui-panes-relayout.test.ts`, on the DOM double), nor that a moved
 * canvas keeps its WebGL context (a browser check, recorded in the P2 log).
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_LIVE_TERMINALS, planCards, tabsToEvict } from '../../web/src/ui/pane-reuse-model.ts';
import { st, resetState, activeTab, keys, ed } from '../helpers/ui-state-fixture.ts';

/** Which OLD key each new slot's card showed, or 'new' — readable in a diff. */
function cardsFor(prev: string[], next: string[]): string[] {
  return planCards(prev, next).map((from) => (from === null ? 'new' : `${prev[from]}@${from}`));
}

beforeEach(() => {
  resetState();
});

test('a slot whose content was already on screen takes that card, wherever it stood', () => {
  assert.deepEqual(cardsFor(['a', 'b'], ['a', 'b', 'c']), ['a@0', 'b@1', 'new'], 'split: append');
  assert.deepEqual(cardsFor(['a', 'b'], ['c', 'a', 'b']), ['new', 'a@0', 'b@1'], 'split: a new first slot');
  assert.deepEqual(cardsFor(['a', 'b', 'c'], ['a', 'b']), ['a@0', 'b@1'], 'close: the last pane');
  assert.deepEqual(cardsFor(['a', 'b', 'c', 'd'], ['c', 'b', 'd']), ['c@2', 'b@1', 'd@3'], '4→3 remaps');
  assert.deepEqual(cardsFor(['a', 'b'], ['b', 'a']), ['b@1', 'a@0'], 'swap: both cards move');
});

test('a slot with new content converts the card at its own index — unless that card moved on', () => {
  assert.deepEqual(cardsFor(['a', 'b'], ['a', 'e:1']), ['a@0', 'b@1'], 'a file dropped on b converts b in place');
  assert.deepEqual(
    cardsFor(['a', 'b'], ['b', 'e:1']),
    ['b@1', 'new'],
    'b moved to 0, so slot 1 gets a new card — never b’s, which would re-attach b',
  );
  assert.deepEqual(cardsFor(['a', 'b'], ['x', 'a']), ['new', 'a@0'], 'card 0 went with a: slot 0 gets a new card');
  assert.deepEqual(cardsFor(['', 'b'], ['x', 'b']), ['@0', 'b@1'], 'a card that shows nothing is free for its index');
});

test('no card is handed to two slots, and every kept content keeps exactly its own card', () => {
  const rows: [string[], string[]][] = [
    [['a', 'b', 'c', 'd'], ['d', 'c', 'b', 'a']],
    [['a', 'b', 'c'], ['x', 'y', 'z']],
    [['a'], ['a', 'b', 'c', 'd']],
    [['a', 'b', 'c', 'd'], ['b']],
    [[], ['a', 'b']],
  ];
  for (const [prev, next] of rows) {
    const plan = planCards(prev, next);
    const taken = plan.filter((x): x is number => x !== null);
    assert.equal(new Set(taken).size, taken.length, `${prev} → ${next}: a card taken twice`);
    next.forEach((key, i) => {
      if (prev.includes(key)) assert.equal(plan[i], prev.indexOf(key), `${prev} → ${next}: ${key} lost its card`);
    });
  }
});

// ---------------------------------------------------------------------------
// The transitions the app really makes, key lists straight out of state.ts
// ---------------------------------------------------------------------------

type View = ReturnType<typeof activeTab>;

/** Keys before, run the transition, keys after — and the plan between them. */
function across(v: View, act: () => void): string[] {
  const before = keys(v);
  act();
  return cardsFor(before, keys(v));
}

test('split 2→3 (Side by side): the two panes keep their cards, only the newcomer is new', () => {
  const v = activeTab(['s1', 's2'], ['s3']);
  assert.deepEqual(across(v, () => st.moveSessionToView('s3', v.id)), ['s:s1@0', 's:s2@1', 'new']);
});

test('split onto the TOP of the left pane: every old pane moves and keeps its card', () => {
  const v = activeTab(['s1', 's2'], ['s3']);
  const src = st.state.views[2] as View;
  const plan = across(v, () => assert.equal(st.mergeViews(v.id, src.id, 0, 'top'), 'ok'));
  assert.deepEqual(plan, ['new', 's:s1@0', 's:s2@1']);
});

test('close 3→2 (Own tab): the panes that stay keep their cards, and nothing is new', () => {
  for (const out of [0, 1, 2]) {
    resetState();
    const ids = ['s1', 's2', 's3'];
    const v = activeTab(ids);
    const plan = across(v, () => st.extractSession(ids[out] as string));
    assert.equal(plan.length, 2, `extract slot ${out}`);
    assert.equal(plan.includes('new'), false, `extract slot ${out}: ${plan}`);
    assert.equal(plan.some((p) => p.startsWith(`s:${ids[out]}@`)), false, `extract slot ${out}: the leaver is gone`);
  }
});

test('extract 4→3 from every slot: the 2x2 remaps and every remaining pane keeps its card', () => {
  const expect: Record<number, string[]> = {
    0: ['s:s3@2', 's:s2@1', 's:s4@3'],
    1: ['s:s1@0', 's:s3@2', 's:s4@3'],
    2: ['s:s1@0', 's:s2@1', 's:s4@3'],
    3: ['s:s1@0', 's:s3@2', 's:s2@1'],
  };
  for (const out of [0, 1, 2, 3]) {
    resetState();
    const v = activeTab(['s1', 's2', 's3', 's4']);
    assert.deepEqual(across(v, () => st.extractSession(`s${out + 1}`)), expect[out], `extract slot ${out}`);
  }
});

test('swap (ctrl+alt+shift+arrow): two terminals trade cards instead of re-attaching', () => {
  const v = activeTab(['s1', 's2']);
  v.focused = 0;
  assert.deepEqual(across(v, () => st.movePane('right')), ['s:s2@1', 's:s1@0']);
});

test('a file pane beside two terminals: a split keeps all three cards', () => {
  const v = activeTab(['s1'], ['s2']);
  const file = ed('/home/you/a.ts');
  v.slots.push(file);
  assert.deepEqual(across(v, () => st.moveSessionToView('s2', v.id)), ['s:s1@0', `${file.id}@1`, 'new']);
});

// ---------------------------------------------------------------------------
// P5: which parked tabs go when the live terminals exceed the cap
// ---------------------------------------------------------------------------

const t = (id: string, live: number, seen: number): { id: string; live: number; seen: number } => ({ id, live, seen });

test('the cap is 12 live terminals: under Chromium’s ~16 WebGL contexts, with margin', () => {
  assert.equal(MAX_LIVE_TERMINALS, 12);
});

test('at or under the cap nothing is evicted', () => {
  assert.deepEqual(tabsToEvict([t('a', 4, 1), t('b', 4, 2)], 4, 12), [], 'exactly 12');
  assert.deepEqual(tabsToEvict([], 4, 12), [], 'no parked tab');
});

test('over the cap the LEAST RECENTLY SEEN parked tab goes first, whole, and only as many as needed', () => {
  assert.deepEqual(tabsToEvict([t('b', 4, 2), t('a', 4, 1), t('c', 4, 3)], 4, 12), ['a'], 'lowest seen, not list order');
  assert.deepEqual(tabsToEvict([t('a', 4, 1), t('b', 4, 2), t('c', 4, 3)], 4, 8), ['a', 'b'], 'two to fit a smaller cap');
  assert.deepEqual(tabsToEvict([t('a', 1, 1), t('b', 4, 2), t('c', 4, 3)], 4, 12), ['a'], 'one terminal over: the one-pane LRU tab is enough');
});

test('a parked tab holding no terminal frees nothing and is skipped', () => {
  assert.deepEqual(tabsToEvict([t('files', 0, 1), t('a', 4, 2), t('b', 4, 3), t('c', 1, 4)], 4, 12), ['a']);
});

test('a shown tab with more panes than the cap keeps them all: every parked tab goes, and only those', () => {
  assert.deepEqual(tabsToEvict([t('a', 4, 1), t('b', 2, 2)], 14, 12), ['a', 'b']);
  assert.deepEqual(tabsToEvict([], 14, 12), [], 'nothing to evict — the shown tab is never a candidate');
});
