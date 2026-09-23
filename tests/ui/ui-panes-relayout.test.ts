/**
 * `web/src/ui/panes.ts` relayout (Quality part P2, `.claude/plans/PLAN-QUALITY.md`):
 * a split, a close, an "Own tab", an extract or a swap inside one tab keeps
 * every terminal whose session stays in the tab — same TerminalView, same
 * socket, never disposed, never attached again — and only a NEW pane attaches.
 *
 * How: the REAL panes.ts, on the DOM double (`helpers/fake-dom.ts`), driven by
 * the REAL state transitions (`web/src/state.ts`). `registerHooks` swaps the
 * five imports that cannot run here for recorders: `./terminal.ts` (xterm is a
 * browser bundle — the stub TerminalView records construct, attach, focus and
 * dispose), `../api.ts`, `./dnd.ts`, `./editor-pane.ts` and `./panes-status.ts`
 * (the header readout, which this file does not judge). The same seam
 * `tests/ui/ui-sessions-panel.test.ts` uses.
 *
 * Why it matters: a terminal that is re-attached costs a full scrollback
 * replay (P0: 1.28 MB and ~240 ms per pane on a 2→3 split) and looks, on
 * screen, like nothing more than a flicker.
 *
 * NOT claimed: layout, the ResizeObserver refit and the one resize it sends
 * (`tests/ui/ui-terminal-resize.test.ts` drives that seam), and that a moved
 * canvas keeps its WebGL context — a browser check, measured for P2 over CDP
 * (`memory/log/2026-09/project/`) and part of `/verify-terminal`.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { dispatch, installDom, type FakeElement } from '../helpers/fake-dom.ts';
import { st, resetState, activeTab, sess } from '../helpers/ui-state-fixture.ts';

const dom = installDom();

/** One stub TerminalView, as panes.ts built it. */
interface FakeView {
  container: FakeElement;
  id: string | null;
  disposed: boolean;
  focusCalls: number;
}
const H = { views: [] as FakeView[] };
(globalThis as unknown as { __panesHarness: typeof H }).__panesHarness = H;

const STUB_SRC: Record<string, string> = {
  terminal: `
    const H = globalThis.__panesHarness;
    export class TerminalView {
      constructor(container) { this.container = container; this.id = null; this.disposed = false; this.focusCalls = 0; H.views.push(this); }
      connect(id) { this.id = id; }
      proposeDims() { return { cols: 80, rows: 24 }; }
      focus() { this.focusCalls++; this.container.focus(); }
      sendSeen() {}
      dispose() { this.disposed = true; }
    }`,
  api: `export async function markSeen() {}`,
  dnd: `export function armDrag() {}`,
  'editor-pane': `
    export function editorPane() { return { update() {}, focus() {}, holdsFocus() { return false; }, dispose() {} }; }`,
  'panes-status': `
    export async function killSession() {}
    export function updateHeader() {}
    export function updateNote() {}
    export function updateStatus() {}`,
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((context.parentURL ?? '').endsWith('/web/src/ui/panes.ts')) {
      const m = /^(?:\.\.\/(api)|\.\/(terminal|dnd|editor-pane|panes-status))\.ts$/.exec(specifier);
      const name = m?.[1] ?? m?.[2];
      if (name !== undefined) return { url: `panes-stub:${name}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith('panes-stub:')) {
      return { format: 'module', source: STUB_SRC[url.slice('panes-stub:'.length)], shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const P = await import('../../web/src/ui/panes.ts');
const grid = dom.doc.createElement('div');
dom.body.append(grid);
P.initPanes(grid as unknown as HTMLElement, () => {});

type View = ReturnType<typeof activeTab>;

/** The active tab holding `ids` (one tab per id in `others`), drawn. */
function tab(ids: string[], others: string[] = []): View {
  const v = activeTab(ids, others);
  st.notify('ui');
  return v;
}

const cards = (): FakeElement[] =>
  grid.children.filter((n): n is FakeElement => (n as FakeElement).classList?.contains('pane') === true);
const dividers = (): FakeElement[] =>
  grid.children.filter((n): n is FakeElement => (n as FakeElement).classList?.contains('divider') === true);
const live = (): FakeView[] => H.views.filter((x) => !x.disposed);

/** The live terminal of every session, by id — the identity a relayout must keep. */
function terminals(): Map<string, FakeView> {
  return new Map(live().map((x) => [x.id as string, x]));
}

/** Every card stands at its slot, says so, and holds the terminal of that slot's session. */
function assertGridMatches(v: View, what: string): void {
  const cs = cards();
  assert.equal(cs.length, v.slots.length, `${what}: one card per slot`);
  cs.forEach((card, i) => {
    assert.equal(card.dataset.slot, String(i), `${what}: card ${i} says it is slot ${i}`);
    const slot = v.slots[i];
    const inCard = live().filter((x) => card.contains(x.container));
    assert.equal(inCard.length, 1, `${what}: card ${i} holds one live terminal`);
    assert.equal(slot?.kind === 'session' ? slot.id : null, inCard[0]?.id, `${what}: card ${i} shows slot ${i}'s session`);
  });
  assert.equal(live().length, v.slots.length, `${what}: no terminal outlives its slot`);
}

beforeEach(() => {
  resetState();
  H.views.length = 0;
});

test('split 2→3 attaches ONLY the newcomer; the two kept terminals are the same instances', () => {
  const v = tab(['s1', 's2'], ['s3']);
  const before = terminals();
  assert.equal(H.views.length, 2, 'precondition: two terminals attached');
  st.moveSessionToView('s3', v.id);
  assert.equal(H.views.length, 3, 'exactly one TerminalView was built');
  assert.equal(H.views[2]?.id, 's3', 'and it is the new pane');
  for (const id of ['s1', 's2']) {
    assert.equal(terminals().get(id), before.get(id), `${id} kept its terminal`);
  }
  assert.equal(grid.dataset.layout, '3');
  assert.equal(dividers().length, 2, 'a 3-split has a column and a row divider');
  assertGridMatches(v, 'split 2→3');
});

test('split onto the TOP of the left pane: every old terminal moves with its card', () => {
  const v = tab(['s1', 's2'], ['s3']);
  const before = terminals();
  const src = st.state.views[2] as View;
  assert.equal(st.mergeViews(v.id, src.id, 0, 'top'), 'ok');
  assert.equal(H.views.length, 3, 'one new terminal');
  assert.equal(terminals().get('s1'), before.get('s1'));
  assert.equal(terminals().get('s2'), before.get('s2'));
  assertGridMatches(v, 'top split');
});

test('close 3→2 (Own tab) from every slot: nothing attaches, only the leaver is disposed', () => {
  for (const out of [0, 1, 2]) {
    resetState();
    H.views.length = 0;
    const ids = ['s1', 's2', 's3'];
    const v = tab(ids);
    const before = terminals();
    st.extractSession(ids[out] as string);
    assert.equal(H.views.length, 3, `Own tab on slot ${out}: no TerminalView was built`);
    assert.equal(before.get(ids[out] as string)?.disposed, true, `slot ${out}: the leaver is disposed`);
    for (const id of ids.filter((_, i) => i !== out)) {
      assert.equal(terminals().get(id), before.get(id), `slot ${out}: ${id} kept its terminal`);
    }
    assert.equal(grid.dataset.layout, '2');
    assert.equal(grid.dataset.l3, undefined, 'the 3-split variant is gone');
    assert.equal(dividers().length, 1, 'a 2-split has one divider');
    assertGridMatches(v, `Own tab on slot ${out}`);
  }
});

test('extract 4→3 from every slot: the 2x2 remaps, no terminal re-attaches, the cards follow', () => {
  for (const out of [0, 1, 2, 3]) {
    resetState();
    H.views.length = 0;
    const v = tab(['s1', 's2', 's3', 's4']);
    const before = terminals();
    st.extractSession(`s${out + 1}`);
    assert.equal(H.views.length, 4, `extract slot ${out}: no TerminalView was built`);
    for (const [id, view] of terminals()) assert.equal(view, before.get(id), `extract slot ${out}: ${id} kept`);
    assert.equal(grid.dataset.l3, v.l3, `extract slot ${out}: the grid draws the variant state.ts chose`);
    assertGridMatches(v, `extract slot ${out}`);
  }
});

test('swap two terminals: both cards move, nothing attaches, nothing is disposed', () => {
  const v = tab(['s1', 's2']);
  v.focused = 0;
  const before = terminals();
  st.movePane('right');
  assert.equal(H.views.length, 2, 'no TerminalView was built');
  assert.equal(live().length, 2, 'none was disposed');
  assert.equal(terminals().get('s1'), before.get('s1'));
  assertGridMatches(v, 'swap');
});

test('a tab switch still rebuilds: the other tab attaches, this one is disposed (P5 is the user’s call)', () => {
  const v = tab(['s1', 's2'], ['s3']);
  const other = st.state.views[2] as View;
  st.setActiveView(other.id);
  assert.equal(live().length, 1, 'only the other tab’s terminal is alive');
  assert.equal(live()[0]?.id, 's3');
  st.setActiveView(v.id);
  assert.equal(H.views.length, 5, 'coming back attaches both again');
});

test('the pane that had the keyboard gets it back after its card moved', () => {
  const v = tab(['s1', 's2', 's3', 's4']);
  st.focusPane(2);
  const s3 = terminals().get('s3') as FakeView;
  assert.ok(s3.container.contains(dom.doc.activeElement), 'precondition: s3 holds the keyboard');
  const calls = s3.focusCalls;
  st.extractSession('s1'); // [s1,s2,s3,s4] → [s3,s2,s4]: the s3 card moves to the front
  assert.equal(v.slots[v.focused]?.kind === 'session' && v.slots[v.focused]?.id, 's3', 'state keeps the focus on s3');
  assert.equal(s3.focusCalls, calls + 1, 'the moved terminal is focused again, once');
  assert.ok(s3.container.contains(dom.doc.activeElement), 'and the keyboard is back inside it');
  assert.ok(cards()[0]?.classList.contains('focused'), 'the focus ring moved with the card');
});

test('a click on a moved card focuses its NEW slot, not the one it was built for', () => {
  const v = tab(['s1', 's2', 's3', 's4']);
  st.extractSession('s1'); // s3's card, built as slot 2, now stands at slot 0
  const s3card = cards()[0] as FakeElement;
  st.focusPane(1);
  dispatch(s3card, 'mousedown');
  assert.equal(v.focused, 0, 'the card reports where it stands now');
});

test('a card moved WITHOUT changing its index still gets the keyboard back', () => {
  // [s1,s2,s3,s4] → [s4,s2,s3,s1]: putting s4 first and s2 second moves the s3
  // card too (a browser blurs a moved node), yet s3 is slot 2 before and after
  // — the focus key alone would not notice. No transition in state.ts makes
  // this order with the focus left on s3 today; the view is plain data and a
  // reload or a future verb can, so the rule is pinned on the data.
  const v = tab(['s1', 's2', 's3', 's4']);
  st.focusPane(2);
  const s3 = terminals().get('s3') as FakeView;
  const calls = s3.focusCalls;
  v.slots = [sess('s4'), sess('s2'), sess('s3'), sess('s1')];
  st.notify('ui');
  assert.equal(H.views.length, 4, 'a pure reorder attaches nothing');
  assertGridMatches(v, 'reorder');
  assert.equal(s3.focusCalls, calls + 1, 'the moved terminal is focused again');
  assert.ok(s3.container.contains(dom.doc.activeElement), 'and holds the keyboard');
});
