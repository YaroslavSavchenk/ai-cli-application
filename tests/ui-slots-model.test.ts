/**
 * `web/src/ui/slots-model.ts` — the pure rules behind A10's mixed panes
 * (user decision 2026-09-15): which tab a file belongs to, what a tab and a
 * pane are CALLED, and which drop zone a pointer is over.
 *
 * WHY here and not in a DOM test: the drag geometry is the half of drag & drop
 * that has nothing to do with the browser, and it is the half that decides
 * whether a dropped file splits a pane or replaces it. Pinning it without a
 * DOM means part 1B can change the plumbing without changing the answer.
 *
 * NOT claimed here (needs a browser, `.claude/skills/verify-terminal/SKILL.md`):
 * that the drop indicator is drawn where this says, or that a pane is legible.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EDGE_FRACTION,
  fileName,
  rootForSubject,
  slotTitle,
  tabTitle,
  viewLabel,
  zoneForPoint,
  type Rect,
} from '../web/src/ui/slots-model.ts';
import type { EditorTab, PaneSlot } from '../web/src/state.ts';

/** An editor pane holding `tabs`, showing `active` (A10b shape, made by hand). */
const editor = (tabs: EditorTab[], active = 0): PaneSlot => ({
  kind: 'editor',
  id: 'e:1',
  tabs,
  active,
});

// A 400x200 pane at the origin: every fraction below is a round number in it.
const PANE: Rect = { left: 0, top: 0, width: 400, height: 200 };

// ---------------------------------------------------------------------------
// rootForSubject — three cases, and none of them is a path
// ---------------------------------------------------------------------------

test('rootForSubject: Home, a project, and a session without one', () => {
  assert.deepEqual(rootForSubject({ home: true }), { kind: 'home' });
  assert.deepEqual(rootForSubject({ home: false, projectId: 'p1' }), { kind: 'project', id: 'p1' });
  // The A10 gap part B2 closes: a session with no project has no folder of its
  // own to open files into, so they land at Home rather than in someone else's
  // tab.
  assert.deepEqual(rootForSubject({ home: false, projectId: null }), { kind: 'home' });
  assert.deepEqual(rootForSubject({ home: false }), { kind: 'home' });
  assert.deepEqual(rootForSubject({ home: false, projectId: '' }), { kind: 'home' });
});

test('rootForSubject: `home` wins even when a project id rides along', () => {
  // The panel says Home; a stale project id under it must not silently open a
  // second folder tab the user never asked for.
  assert.deepEqual(rootForSubject({ home: true, projectId: 'p1' }), { kind: 'home' });
});

// ---------------------------------------------------------------------------
// viewLabel / slotTitle — a path never reaches a label
// ---------------------------------------------------------------------------

const names = (map: Record<string, string>) => (id: string) => map[id] ?? null;

test('viewLabel: Home says Home, a project says its NAME, a plain tab joins its panes', () => {
  const lookup = names({ p1: 'Session Manager' });
  assert.equal(viewLabel({ kind: 'home' }, lookup, []), 'Home');
  assert.equal(viewLabel({ kind: 'home' }, lookup, ['claude', 'main.ts']), 'Home');
  assert.equal(viewLabel({ kind: 'project', id: 'p1' }, lookup, ['main.ts']), 'Session Manager');
  assert.equal(viewLabel(null, lookup, ['claude', 'bash']), 'claude, bash');
  assert.equal(viewLabel(null, lookup, ['claude']), 'claude');
});

test('viewLabel: no label is ever a path, whatever the lookup answers', () => {
  const lookup = names({ p1: 'Session Manager' });
  const labels = [
    viewLabel({ kind: 'home' }, lookup, ['web/src/main.ts']),
    viewLabel({ kind: 'project', id: 'p1' }, lookup, []),
    // A project deleted under an open tab: the panes' own names stand in, and
    // a tab with nothing in it says so with the strip's own stand-in.
    viewLabel({ kind: 'project', id: 'gone' }, lookup, ['main.ts']),
    viewLabel({ kind: 'project', id: 'gone' }, lookup, []),
    viewLabel(null, lookup, []),
  ];
  assert.deepEqual(labels, ['Home', 'Session Manager', 'main.ts', '…', '…']);
  for (const l of labels) assert.ok(!l.includes('/'), `no path separator in "${l}"`);
});

test('tabTitle: a file chip prints the LAST SEGMENT, a diff chip says which commit', () => {
  assert.equal(tabTitle({ kind: 'file', path: 'web/src/ui/panes.ts' }), 'panes.ts');
  assert.equal(tabTitle({ kind: 'file', path: 'LICENSE' }), 'LICENSE');
  assert.equal(tabTitle({ kind: 'file', path: '/a/b//c.ts' }), 'c.ts');
  assert.equal(tabTitle({ kind: 'diff', hash: '474d891', path: 'server/ws.ts', root: '/home/you/app' }), 'Changes in 474d891');
  for (const t of [
    { kind: 'file', path: 'web/src/ui/panes.ts' },
    { kind: 'diff', hash: '474d891', path: 'server/ws.ts', root: '/home/you/app' },
  ] as EditorTab[]) {
    assert.ok(!tabTitle(t).includes('/'), 'no path separator reaches a chip');
  }
});

test('slotTitle: an editor pane is called after the tab it is SHOWING', () => {
  // A10b: the pane header and the tab chip both follow the strip, so switching
  // tabs renames the pane — the one thing that tells the user which file the
  // keyboard is in.
  const tabs: EditorTab[] = [
    { kind: 'file', path: 'web/src/ui/panes.ts' },
    { kind: 'file', path: 'LICENSE' },
    { kind: 'diff', hash: '474d891', path: 'server/ws.ts', root: '/home/you/app' },
  ];
  assert.equal(slotTitle(editor(tabs, 0)), 'panes.ts');
  assert.equal(slotTitle(editor(tabs, 1)), 'LICENSE');
  assert.equal(slotTitle(editor(tabs, 2)), 'Changes in 474d891');
  assert.equal(slotTitle(editor(tabs, 0)), tabTitle(tabs[0] as EditorTab), 'one rule, not two');
  // Out of range is not a crash and not a path: the model never produces it,
  // and a hand-built slot still gets a label.
  assert.equal(slotTitle(editor(tabs, 9)), 'Changes in 474d891');
  assert.equal(slotTitle(editor([], 0)), '…');
});

test('slotTitle: a session pane says its own name', () => {
  const s: PaneSlot = { kind: 'session', id: 's1' };
  assert.equal(slotTitle(s, 'Session Manager'), 'Session Manager');
  // A session the browser has not heard about yet: the strip's own stand-in,
  // never the raw id (which is a uuid and says nothing to anyone).
  assert.equal(slotTitle(s), '…');
  assert.equal(slotTitle(s, null), '…');
  assert.equal(slotTitle(s, ''), '…');
});

test('fileName: the segment rule, on the shapes a real tree hands over', () => {
  assert.equal(fileName('a/b/c.ts'), 'c.ts');
  assert.equal(fileName('c.ts'), 'c.ts');
  assert.equal(fileName('a/b/'), 'b');
  assert.equal(fileName(''), '');
});

// ---------------------------------------------------------------------------
// zoneForPoint — the bands
// ---------------------------------------------------------------------------

test('zoneForPoint: one pane splits left/right, and its middle replaces', () => {
  const zones = ['left', 'right'] as const;
  const at = (x: number, y: number) => zoneForPoint(PANE, [...zones], x, y);
  assert.equal(EDGE_FRACTION, 0.25, 'the band the strip already uses for its edges');
  assert.equal(at(1, 100), 'left');
  assert.equal(at(99, 100), 'left', 'the outer quarter, up to but not including the band edge');
  assert.equal(at(100, 100), 'replace', 'exactly on the band edge is already the centre');
  assert.equal(at(200, 100), 'replace');
  assert.equal(at(300, 100), 'replace');
  assert.equal(at(301, 100), 'right');
  assert.equal(at(399, 100), 'right');
  // The vertical position says nothing when the pane splits horizontally.
  assert.equal(at(50, 0), 'left');
  assert.equal(at(50, 199), 'left');
});

test('zoneForPoint: a two-pane tab splits top/bottom, and its middle replaces', () => {
  const at = (x: number, y: number) => zoneForPoint(PANE, ['top', 'bottom'], x, y);
  assert.equal(at(200, 1), 'top');
  assert.equal(at(200, 49), 'top');
  assert.equal(at(200, 50), 'replace');
  assert.equal(at(200, 100), 'replace');
  assert.equal(at(200, 150), 'replace');
  assert.equal(at(200, 151), 'bottom');
  assert.equal(at(200, 199), 'bottom');
});

test('zoneForPoint: with NO zones left only the centre answers — the edges reject', () => {
  // A full tab, or the short pane of a 3-split. Replacing a pane costs no
  // pane, so the centre still works; an edge returns null so the caller can
  // flash "this tab is full" instead of quietly swallowing the file.
  const at = (x: number, y: number) => zoneForPoint(PANE, [], x, y);
  assert.equal(at(200, 100), 'replace');
  assert.equal(at(1, 100), null);
  assert.equal(at(399, 100), null);
  assert.equal(at(200, 1), null);
  assert.equal(at(200, 199), null);
  assert.equal(at(1, 1), null, 'a corner is on two edges at once');
});

test("zoneForPoint: a multi-pane merge takes the whole pane ('fill' beats every band)", () => {
  for (const [x, y] of [
    [1, 1],
    [200, 100],
    [399, 199],
  ] as const) {
    assert.equal(zoneForPoint(PANE, ['fill'], x, y), 'fill');
  }
});

test('zoneForPoint: an offset pane measures from its own edges, not the window', () => {
  const rect: Rect = { left: 1000, top: 500, width: 400, height: 200 };
  assert.equal(zoneForPoint(rect, ['left', 'right'], 1001, 600), 'left');
  assert.equal(zoneForPoint(rect, ['left', 'right'], 1200, 600), 'replace');
  assert.equal(zoneForPoint(rect, ['left', 'right'], 1399, 600), 'right');
  assert.equal(zoneForPoint(rect, ['top', 'bottom'], 1200, 501), 'top');
  assert.equal(zoneForPoint(rect, ['top', 'bottom'], 1200, 699), 'bottom');
});

test('zoneForPoint: a pane that has not been laid out yet answers replace, never a split', () => {
  // A zero-sized rect is what a hidden grid measures as. Dividing by it would
  // hand back Infinity and land the file at an edge the user never pointed at.
  const flat: Rect = { left: 0, top: 0, width: 0, height: 0 };
  assert.equal(zoneForPoint(flat, ['left', 'right'], 0, 0), 'replace');
  assert.equal(zoneForPoint(flat, [], 10, 10), 'replace');
});
