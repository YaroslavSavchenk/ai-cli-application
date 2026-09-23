/**
 * `web/src/ui/panes.ts` tab switch without a replay (Quality part P5,
 * `.claude/plans/PLAN-QUALITY.md`): the tab the user leaves is PARKED — its
 * terminals stay alive and hidden, no attach and no dispose — and coming back
 * shows the same terminals again, fitted once. At most `MAX_LIVE_TERMINALS`
 * live; over that the least recently seen parked tab is disposed and attaches
 * again on return. A parked pane never acknowledges attention.
 *
 * How: the REAL panes.ts on the DOM double, driven by the REAL state
 * transitions (`web/src/state.ts`), with the recorders of
 * `tests/helpers/ui-panes-fixture.ts` in place of xterm, the socket and the
 * REST call. A server frame (`attention`, `info`) is played through the
 * events panes.ts handed the stub view.
 *
 * Why it matters: a parked pane shares slot indexes with the tab on screen,
 * so a BEL in a hidden tab could be acked as if the user had looked at it —
 * the `Needs you` badge and the mascot would vanish for a session nobody saw.
 * An eviction of the wrong tab, or a re-attach on return, costs the replay
 * P5 exists to remove and shows nothing on screen but a stall.
 *
 * NOT claimed: that a hidden canvas keeps its WebGL context, the replay bytes
 * and frame gaps of a real switch (a browser measurement, P5 log in
 * `memory/log/2026-09/project/`), nor the resize a shown view sends — that
 * seam is `TerminalView.show()`, driven in `tests/ui/ui-terminal-resize.test.ts`.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { st, resetState, activeTab, addView, sess, mkSession } from '../helpers/ui-state-fixture.ts';
import { dom, grid, H, P, tab, cards, live, terminals, focus, type FakeView, type View } from '../helpers/ui-panes-fixture.ts';
import { MAX_LIVE_TERMINALS } from '../../web/src/ui/pane-reuse-model.ts';

beforeEach(() => {
  resetState();
  H.reset();
});

/** The stub view of session `id` (the newest one built for it). */
function viewOf(id: string): FakeView {
  const v = [...H.views].reverse().find((x) => x.id === id);
  assert.ok(v !== undefined, `a terminal was built for ${id}`);
  return v;
}

/** Is this view's card on screen — in the grid, and nothing hidden above it? */
function inGrid(x: FakeView): boolean {
  return cards().some((c) => c.contains(x.container)) && x.container.rendered;
}

/** One tab per list of session ids, the first one active and drawn. */
function tabsOf(specs: string[][]): View[] {
  const first = activeTab(specs[0] as string[], []);
  st.initServer([], specs.flat().map((id) => mkSession(id)));
  const rest = specs.slice(1).map((ids) => addView(null, ids.map(sess)));
  st.state.activeViewId = first.id;
  st.notify('ui');
  return [first, ...rest];
}

/** Tabs of four sessions each (`a1..a4`, `b1..b4` …), the first one active and drawn. */
function fourPaneTabs(names: string[]): View[] {
  return tabsOf(names.map((n) => [1, 2, 3, 4].map((i) => `${n}${i}`)));
}

/** Play the window regaining focus (panes.ts listens on `window`). */
function windowFocus(): void {
  for (const h of dom.win.handlers) if (h.type === 'focus') h.fn({} as never);
}

// ---------------------------------------------------------------------------
// Switch and return
// ---------------------------------------------------------------------------

test('a tab switch keeps the left tab’s terminals alive and hidden: no dispose, no attach', () => {
  tab(['s1', 's2'], ['s3']);
  const s1 = viewOf('s1');
  const s2 = viewOf('s2');
  st.setActiveView((st.state.views[2] as View).id);
  assert.equal(H.views.length, 3, 'only the shown tab’s terminal was built');
  assert.equal(s1.disposed || s2.disposed, false, 'the left tab’s terminals live on');
  assert.deepEqual([s1.hides, s2.hides], [1, 1], 'each was told once that it is hidden');
  assert.equal(inGrid(s1) || inGrid(s2), false, 'neither is on screen');
  assert.equal(s1.container.isConnected, true, 'they stay in the document (xterm keeps its state)');
  assert.equal(cards().length, 1, 'the grid holds the shown tab alone');
  assert.ok(inGrid(viewOf('s3')), 's3 is on screen');
});

test('coming back shows the SAME terminals, in their slots, with no attach and one show each', () => {
  const v = tab(['s1', 's2'], ['s3']);
  const before = terminals();
  st.setActiveView((st.state.views[2] as View).id);
  st.setActiveView(v.id);
  assert.equal(H.views.length, 3, 'coming back attaches nothing');
  for (const id of ['s1', 's2']) {
    const x = before.get(id) as FakeView;
    assert.equal(terminals().get(id), x, `${id} is the terminal it was`);
    assert.equal(x.shows, 1, `${id} was fitted once on its box`);
    assert.ok(inGrid(x), `${id} is on screen again`);
  }
  assert.deepEqual(
    cards().map((c) => live().find((x) => c.contains(x.container))?.id),
    ['s1', 's2'],
    'each card stands in its own slot',
  );
  assert.equal(grid.dataset.layout, '2');
  const s3 = viewOf('s3');
  assert.equal(s3.disposed, false, 'and the tab left now is parked in turn');
  assert.equal(s3.shows, 0, 'a hidden terminal is never shown');
});

test('a tab switch hands the keyboard to the shown tab; a parked terminal never takes it', () => {
  const v = tab(['s1', 's2'], ['s3']);
  const s1 = viewOf('s1');
  assert.ok(s1.container.contains(dom.doc.activeElement), 'precondition: s1 holds the keyboard');
  const calls = s1.focusCalls;
  st.setActiveView((st.state.views[2] as View).id);
  assert.ok(viewOf('s3').container.contains(dom.doc.activeElement), 'the keyboard went with the tab');
  P.requestTerminalFocus();
  assert.equal(s1.focusCalls, calls, 'a parked terminal is never focused');
  st.setActiveView(v.id);
  assert.ok(s1.container.contains(dom.doc.activeElement), 'back: the focused pane has it again');
});

test('a parked tab that is closed disposes its terminals', () => {
  tab(['s1', 's2'], ['s3']);
  const left = st.state.views[1] as View;
  st.setActiveView((st.state.views[2] as View).id);
  st.closeView(left.id);
  assert.equal(viewOf('s1').disposed && viewOf('s2').disposed, true, 'socket and WebGL go with the tab');
  assert.equal(live().length, 1, 'only the shown tab’s terminal lives');
});

test('a session moved out of a parked tab is disposed there before it attaches in the shown one', () => {
  tab(['s1', 's2'], ['s3']);
  const s1 = viewOf('s1');
  const shown = st.state.views[2] as View;
  st.setActiveView(shown.id);
  st.moveSessionToView('s1', shown.id);
  assert.equal(s1.disposed, true, 'the parked terminal of s1 is gone');
  assert.equal(live().filter((x) => x.id === 's1').length, 1, 'one live terminal per session, not two');
  assert.ok(inGrid(viewOf('s1')), 'and s1 is on screen in its new tab');
});

// ---------------------------------------------------------------------------
// The cap
// ---------------------------------------------------------------------------

test('over the cap the LEAST RECENTLY SEEN tab is disposed — whole — and attaches again on return', () => {
  assert.equal(MAX_LIVE_TERMINALS, 12, 'these steps are sized for a cap of 12');
  const [a, b, c, d] = fourPaneTabs(['a', 'b', 'c', 'd']) as [View, View, View, View];
  st.setActiveView(b.id);
  st.setActiveView(c.id);
  assert.equal(live().length, 12, 'three tabs of four: at the cap, nothing evicted');
  st.setActiveView(d.id);
  assert.deepEqual(
    H.views.filter((x) => x.disposed).map((x) => x.id),
    ['a1', 'a2', 'a3', 'a4'],
    'the fourth tab evicts exactly the first one seen',
  );
  assert.equal(live().length, 12);
  st.setActiveView(b.id); // b comes back from parking: no eviction, no attach
  assert.equal(H.views.length, 16, 'b was parked, not evicted');
  assert.equal(live().length, 12);
  st.setActiveView(a.id); // seen order now: c (longest ago), d, b
  const gone = H.views.filter((x) => x.disposed).map((x) => x.id);
  assert.deepEqual(gone.slice(4), ['c1', 'c2', 'c3', 'c4'], 'a return over the cap evicts c, the least recently seen');
  assert.equal(H.views.length, 20, 'the evicted tab a attaches its four again (the pre-P5 replay)');
  assert.equal(live().length, 12, 'and the total stays at the cap');
  assert.ok(['b', 'd'].every((n) => [1, 2, 3, 4].every((i) => !viewOf(`${n}${i}`).disposed)), 'b and d live on');
});

test('a split in the shown tab that crosses the cap evicts the least recently seen parked tab first', () => {
  const [, b, x, c] = tabsOf([
    ['a1', 'a2', 'a3', 'a4'],
    ['b1', 'b2', 'b3', 'b4'],
    ['x1'],
    ['c1', 'c2', 'c3'],
    ['y1'],
  ]) as [View, View, View, View];
  for (const t of [b, x, c]) st.setActiveView(t.id);
  assert.equal(live().length, 12, 'precondition: a 4 + b 4 + x 1 + c 3, at the cap');
  const aViews = ['a1', 'a2', 'a3', 'a4'].map(viewOf);
  st.moveSessionToView('y1', c.id); // c becomes 4: one over
  assert.ok(aViews.every((v) => v.disposed), 'a, the least recently seen, is evicted');
  assert.ok(inGrid(viewOf('y1')), 'the new pane attached');
  assert.equal(live().length, 9, 'b 4 + x 1 + c 4');
  assert.equal(st.activeView()?.id, c.id, 'the shown tab is never the one evicted');
});

// ---------------------------------------------------------------------------
// Attention: a parked pane is not looked at
// ---------------------------------------------------------------------------

test('a BEL on a PARKED pane raises attention and sends no ack — even at the focused slot index', () => {
  tab(['s1', 's2'], ['s3']);
  const s1 = viewOf('s1'); // slot 0 of its tab — the same index as the shown tab's focused pane
  st.setActiveView((st.state.views[2] as View).id);
  s1.events?.onAttention();
  assert.equal(st.state.sessions.get('s1')?.attention, true, 'the badge is raised');
  assert.equal(s1.seen, 0, 'no `seen` frame');
  assert.deepEqual(H.markSeen, [], 'no POST /seen');
  s1.events?.onInfo({ ...mkSession('s1'), attention: true });
  windowFocus();
  assert.equal(st.state.sessions.get('s1')?.attention, true, 'an info frame or a window focus does not clear it');
  assert.equal(s1.seen, 0);
  assert.deepEqual(H.markSeen, []);
});

test('the same BEL on the shown, focused pane is acked at once, as before P5', () => {
  tab(['s1', 's2'], ['s3']);
  st.setActiveView((st.state.views[2] as View).id);
  const s3 = viewOf('s3');
  s3.events?.onAttention();
  assert.equal(s3.seen, 1, 'a `seen` frame');
  assert.deepEqual(H.markSeen, ['s3'], 'and the POST');
  assert.equal(st.state.sessions.get('s3')?.attention, false);
});

test('a parked pane’s attention is acked when its tab is shown and the pane focused — not before', () => {
  const v = tab(['s1', 's2'], ['s3']);
  const s1 = viewOf('s1');
  st.setActiveView((st.state.views[2] as View).id);
  s1.events?.onAttention();
  focus.window = true;
  st.setActiveView(v.id);
  assert.equal(st.state.sessions.get('s1')?.attention, false, 'shown and focused: seen');
  assert.deepEqual(H.markSeen, ['s1']);
  assert.equal(s1.seen, 1);
});
