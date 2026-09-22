/**
 * THE QUESTION BEFORE TYPED TEXT IS DROPPED (Nocturne part B4, user decision
 * D1, 2026-09-22) — `web/src/ui/unsaved.ts` and `state.dirtyLostBy`, driven
 * through the REAL modules on the shared DOM double against the REAL
 * `web/src/state.ts`.
 *
 * WHY THIS FILE EXISTS. Until B4 a file pane held text that had never been on
 * disk, and the amber dot was the whole warning. Now that text is a file, and
 * this is the only thing standing between a mis-clicked `×` and work that is
 * gone — so the two halves are pinned separately and both against the real
 * model:
 *
 *   1. WHAT WOULD BE LOST (`dirtyLostBy`, pure): the premise of the question.
 *      A file open in TWO panes is not lost by closing one of them, and a
 *      question with a false premise trains the user to answer it blindly.
 *   2. THAT THE DOOR REALLY WAITS FOR THE ANSWER. Every guarded closer must
 *      call the state mutator ONLY after `Discard` — a card that closes the
 *      tab while it asks is worse than no card at all.
 *
 * NOT claimed (browser work, `.claude/skills/verify-terminal/SKILL.md`): the
 * card's layout and colour, and the browser's own `beforeunload` sheet — only
 * the DECISION to arm it is testable here.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { projectRoot } from './helpers.ts';
import { byClass, descendants, dispatch, installDom, textsOf, type FakeElement } from './fake-dom.ts';
import { settle } from './fs-fixture.ts';

const dom = installDom();

type EditorTab =
  | { kind: 'file'; path: string }
  | { kind: 'diff'; hash: string; path: string; root: string };
interface EditorSlot {
  kind: 'editor';
  id: string;
  tabs: EditorTab[];
  active: number;
}
type PaneSlot = { kind: 'session'; id: string } | EditorSlot;
interface ViewLike {
  id: string;
  root: { kind: 'home' } | { kind: 'project'; id: string } | null;
  slots: PaneSlot[];
  focused: number;
  l3: 'L' | 'R';
  split: { col: number; row: number };
}

interface Eviction {
  tabIndex: number;
  lostIds: string[];
}
interface StateModule {
  state: { views: ViewLike[]; activeViewId: string; edits: Map<string, string> };
  newEditorSlot(tabs: EditorTab[]): EditorSlot;
  editorFileId(path: string): string;
  dirtyLostBy(viewId: string, slot?: number, tab?: number): string[];
  activeTabIndex(viewId: string, slot: number): number | null;
  MAX_TABS: number;
  evictionFor(viewId: string, slot: number, tabId: string): Eviction | null;
  evictionForOpen(root: ViewLike['root'], tab: EditorTab): Eviction | null;
  openFile(root: { kind: 'home' } | { kind: 'project'; id: string }, path: string, label: string): string;
}
interface UnsavedModule {
  confirmDiscard(ids: readonly string[], returnFocus?: FakeElement | null): Promise<boolean>;
  isDiscardDialogOpen(): boolean;
  discardDialogEscape(): void;
  closeTabGuarded(viewId: string, slot: number, tab: number, returnFocus?: FakeElement | null): void;
  closeActiveTabGuarded(viewId: string, slot: number): void;
  closeSlotGuarded(viewId: string, slot: number, returnFocus?: FakeElement | null): void;
  closeViewGuarded(viewId: string, act: () => void, returnFocus?: FakeElement | null): void;
  unloadGuard(e: { preventDefault(): void; returnValue: unknown }): boolean;
  disarmUnloadGuard(): void;
  openFileGuarded(
    root: { kind: 'home' } | { kind: 'project'; id: string },
    path: string,
    label: string,
    opts?: { returnFocus?: FakeElement | null; done?: (r: string) => void },
  ): void;
  openDiffGuarded(
    root: { kind: 'home' } | { kind: 'project'; id: string },
    hash: string,
    path: string,
    requestRoot: string,
    opts?: { returnFocus?: FakeElement | null; done?: (r: string) => void },
  ): void;
  openTabAtGuarded(
    viewId: string,
    slot: number,
    where: string,
    tab: EditorTab,
    opts?: { returnFocus?: FakeElement | null; done?: (r: string) => void },
  ): void;
}

const st = (await import(new URL('../web/src/state.ts', import.meta.url).href)) as unknown as StateModule;
const U = (await import(new URL('../web/src/ui/unsaved.ts', import.meta.url).href)) as unknown as UnsavedModule;

const A = '/home/you/web/src/Pane.tsx';
const B = '/home/you/web/src/App.tsx';
const HASH = 'a'.repeat(40);

function view(id: string, slots: PaneSlot[], root: ViewLike['root'] = { kind: 'home' }): ViewLike {
  return { id, root, slots, focused: 0, l3: 'L', split: { col: 0.5, row: 0.5 } };
}

/** Make the file dirty, exactly as a keystroke in its pane does. */
function dirty(path: string, text = 'typed\n'): void {
  st.state.edits.set(st.editorFileId(path), text);
}

/** The card that is up, or null. */
function card(): FakeElement | null {
  return byClass(dom.body, 'ud-modal')[0] ?? null;
}

function answer(label: string): FakeElement {
  const hit = descendants(dom.body).find((n) => n.tagName === 'BUTTON' && n.textContent === label);
  assert.ok(hit !== undefined, `no ${label} button on screen`);
  return hit;
}

beforeEach(() => {
  if (U.isDiscardDialogOpen()) U.discardDialogEscape();
  dom.body.replaceChildren();
  dom.doc.activeElement = dom.body;
  st.state.edits = new Map();
  st.state.views = [];
  st.state.activeViewId = '';
});

// ---------------------------------------------------------------------------
// The premise: what a close would really throw away
// ---------------------------------------------------------------------------

test('a clean pane loses nothing — there is nothing to ask about', () => {
  st.state.views = [view('v1', [st.newEditorSlot([{ kind: 'file', path: A }])])];
  assert.deepEqual(st.dirtyLostBy('v1', 0, 0), []);
  assert.deepEqual(st.dirtyLostBy('v1', 0), []);
  assert.deepEqual(st.dirtyLostBy('v1'), []);
});

test('a dirty tab is lost by every door that removes it — the chip, its pane, its whole tab', () => {
  st.state.views = [
    view('v1', [st.newEditorSlot([{ kind: 'file', path: A }, { kind: 'file', path: B }])]),
  ];
  dirty(A);
  const id = st.editorFileId(A);
  assert.deepEqual(st.dirtyLostBy('v1', 0, 0), [id], 'that chip');
  assert.deepEqual(st.dirtyLostBy('v1', 0, 1), [], 'the OTHER chip loses nothing');
  assert.deepEqual(st.dirtyLostBy('v1', 0), [id], 'the pane, with both tabs');
  assert.deepEqual(st.dirtyLostBy('v1'), [id], 'the whole tab');
});

test('a file open in TWO panes is not lost by closing one of them', () => {
  st.state.views = [
    view('v1', [
      st.newEditorSlot([{ kind: 'file', path: A }]),
      st.newEditorSlot([{ kind: 'file', path: A }]),
    ]),
  ];
  dirty(A);
  assert.deepEqual(st.dirtyLostBy('v1', 0), [], 'the other pane still shows that text');
  assert.deepEqual(st.dirtyLostBy('v1', 1), []);
  assert.deepEqual(st.dirtyLostBy('v1'), [st.editorFileId(A)], 'both at once DOES lose it');
});

test('a file open in another TAB is not lost either, and that tab is not asked about', () => {
  st.state.views = [
    view('v1', [st.newEditorSlot([{ kind: 'file', path: A }])]),
    view('v2', [st.newEditorSlot([{ kind: 'file', path: A }, { kind: 'file', path: B }])], null),
  ];
  dirty(A);
  dirty(B);
  assert.deepEqual(st.dirtyLostBy('v1'), [], 'v2 still has A');
  assert.deepEqual(st.dirtyLostBy('v2'), [st.editorFileId(B)], 'only B is nowhere else');
  assert.deepEqual(st.dirtyLostBy('nosuchview'), [], 'a view that is not there removes nothing');
});

test('a DIFF tab can never be lost: it is read-only and owns no text', () => {
  st.state.views = [
    view('v1', [st.newEditorSlot([{ kind: 'diff', hash: HASH, path: 'a.ts', root: '/repo' }])]),
  ];
  // Even with a stale `d:` key in the map (which the model never writes).
  st.state.edits.set(`d:${HASH}:a.ts`, 'impossible');
  assert.deepEqual(st.dirtyLostBy('v1'), []);
});

test('a terminal pane is not a door: ctrl+alt+w on one has no tab to close', () => {
  st.state.views = [view('v1', [{ kind: 'session', id: 's1' }])];
  assert.equal(st.activeTabIndex('v1', 0), null);
  U.closeActiveTabGuarded('v1', 0);
  assert.equal(U.isDiscardDialogOpen(), false, 'nothing to ask about');
  assert.deepEqual(st.state.views[0]?.slots.length, 1, 'and nothing happened');
});

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

test('the question NAMES one file, COUNTS several, and never shows a path', async () => {
  const one = U.confirmDiscard([st.editorFileId(A)]);
  assert.deepEqual(textsOf(dom.body, 'ud-title'), ['Discard unsaved changes to Pane.tsx?']);
  assert.equal((card() as FakeElement).textContent.includes('/home/you'), false, 'no path in the card');
  answer('Keep editing').click();
  assert.equal(await one, false);

  const many = U.confirmDiscard([st.editorFileId(A), st.editorFileId(B)]);
  assert.deepEqual(textsOf(dom.body, 'ud-title'), ['Discard unsaved changes to 2 files?']);
  answer('Keep editing').click();
  assert.equal(await many, false);
});

test("the question isolates the name's direction", async () => {
  // SECURITY: a file NAME comes out of a repository. A right-to-left run in it
  // reorders the sentence around itself unless the name is isolated — the rule
  // `.pane-tab-pick` and `.commit-fpath-t` already carry, and this card is the
  // one other place a name is printed.
  const asked = U.confirmDiscard([st.editorFileId(A)]);
  const name = byClass(dom.body, 'ud-name')[0];
  assert.ok(name !== undefined, 'the name is its own node');
  assert.equal(name.textContent, 'Pane.tsx', 'and it is exactly the name');
  assert.deepEqual(
    textsOf(dom.body, 'ud-title'),
    ['Discard unsaved changes to Pane.tsx?'],
    'the sentence itself is unchanged',
  );
  // The class has to mean something: the rule is in app.css, with the isolation.
  const css = readFileSync(join(projectRoot, 'web', 'src', 'styles', 'app.css'), 'utf8');
  const at = css.indexOf('.ud-name {');
  assert.notEqual(at, -1, 'app.css must carry a .ud-name rule');
  const rule = css.slice(at, css.indexOf('}', at));
  assert.match(rule, /unicode-bidi:\s*isolate/);
  assert.match(rule, /direction:\s*ltr/);
  U.discardDialogEscape();
  assert.equal(await asked, false);
});

test('the card is a modal the rest of the app can see, and the SAFE answer holds the keyboard', async () => {
  const asked = U.confirmDiscard([st.editorFileId(A)]);
  // ui/keys.ts finds an open dialog by `.modal-scrim`: the keyboard rules and
  // the external-drop guard both have to know a question is up.
  const scrim = byClass(dom.body, 'modal-scrim')[0] as FakeElement;
  assert.ok(scrim !== undefined);
  assert.equal((card() as FakeElement).getAttribute('role'), 'dialog');
  assert.equal((card() as FakeElement).getAttribute('aria-modal'), 'true');
  assert.equal(dom.doc.activeElement, answer('Keep editing'), 'Enter half-pressed must not discard');
  // Two answers, and no third control that means the same as one of them.
  assert.equal(descendants(card() as FakeElement).filter((n) => n.tagName === 'BUTTON').length, 2);
  U.discardDialogEscape();
  assert.equal(await asked, false, 'Escape is Keep editing');
  assert.equal(card(), null, 'and the card is gone');
});

test('Discard answers true; Escape, the backdrop and Keep editing all answer false', async () => {
  const id = st.editorFileId(A);
  const yes = U.confirmDiscard([id]);
  answer('Discard').click();
  assert.equal(await yes, true);
  assert.equal(card(), null);

  const no = U.confirmDiscard([id]);
  const scrim = byClass(dom.body, 'modal-scrim')[0] as FakeElement;
  dispatch(scrim, 'mousedown');
  assert.equal(await no, false, 'the backdrop is the way out');

  const esc = U.confirmDiscard([id]);
  U.discardDialogEscape();
  assert.equal(await esc, false);
});

test('an empty list is answered without a card; a second question while one is up is refused', async () => {
  assert.equal(await U.confirmDiscard([]), true, 'nothing to lose, nothing to ask');
  assert.equal(card(), null);

  const first = U.confirmDiscard([st.editorFileId(A)]);
  assert.equal(await U.confirmDiscard([st.editorFileId(B)]), false, 'one question at a time');
  assert.deepEqual(textsOf(dom.body, 'ud-title'), ['Discard unsaved changes to Pane.tsx?']);
  answer('Discard').click();
  assert.equal(await first, true);
});

test('the keyboard goes back to the control the question was asked from', async () => {
  const from = dom.doc.createElement('button');
  dom.body.append(from);
  const asked = U.confirmDiscard([st.editorFileId(A)], from);
  answer('Discard').click();
  await asked;
  assert.equal(dom.doc.activeElement, from);
});

// ---------------------------------------------------------------------------
// The doors
// ---------------------------------------------------------------------------

test('a door with nothing to lose closes straight away — no card, no waiting', () => {
  st.state.views = [
    view('v1', [st.newEditorSlot([{ kind: 'file', path: A }, { kind: 'file', path: B }])]),
  ];
  U.closeTabGuarded('v1', 0, 0);
  assert.equal(card(), null, 'a clean file asks nothing');
  assert.deepEqual((st.state.views[0]?.slots[0] as EditorSlot).tabs, [{ kind: 'file', path: B }]);
});

test('the chip × waits for the answer: Keep editing changes NOTHING, Discard closes the tab', async () => {
  const slot = (): EditorSlot => st.state.views[0]?.slots[0] as EditorSlot;
  st.state.views = [
    view('v1', [st.newEditorSlot([{ kind: 'file', path: A }, { kind: 'file', path: B }])]),
  ];
  dirty(A);

  U.closeTabGuarded('v1', 0, 0);
  assert.ok(card() !== null, 'the question is up');
  assert.equal(slot().tabs.length, 2, 'and the tab is still there while it is up');
  answer('Keep editing').click();
  await settle();
  assert.equal(slot().tabs.length, 2, 'Keep editing changed nothing at all');
  assert.equal(st.state.edits.size, 1, 'and the text is still unsaved');

  U.closeTabGuarded('v1', 0, 0);
  answer('Discard').click();
  await settle();
  assert.deepEqual(slot().tabs, [{ kind: 'file', path: B }], 'now it is closed');
  assert.equal(st.state.edits.size, 0, 'and the text went with it (pruneOrphanEdits)');
});

test('the pane × asks about every file in it, once, and closes the whole pane on Discard', async () => {
  st.state.views = [
    view('v1', [
      st.newEditorSlot([{ kind: 'file', path: A }, { kind: 'file', path: B }]),
      { kind: 'session', id: 's1' },
    ]),
  ];
  dirty(A);
  dirty(B);
  U.closeSlotGuarded('v1', 0);
  assert.deepEqual(textsOf(dom.body, 'ud-title'), ['Discard unsaved changes to 2 files?']);
  answer('Discard').click();
  await settle();
  assert.deepEqual(st.state.views[0]?.slots, [{ kind: 'session', id: 's1' }]);
  assert.equal(st.state.edits.size, 0);
});

test('ctrl+alt+w goes through the same guard, on the ACTIVE tab', async () => {
  st.state.views = [
    view('v1', [st.newEditorSlot([{ kind: 'file', path: A }, { kind: 'file', path: B }])]),
  ];
  (st.state.views[0]?.slots[0] as EditorSlot).active = 1;
  dirty(B);
  U.closeActiveTabGuarded('v1', 0);
  assert.deepEqual(textsOf(dom.body, 'ud-title'), ['Discard unsaved changes to App.tsx?']);
  answer('Discard').click();
  await settle();
  assert.deepEqual((st.state.views[0]?.slots[0] as EditorSlot).tabs, [{ kind: 'file', path: A }]);
});

test("a whole tab's × asks first and runs the strip's OWN act — sessions and all — only on Discard", async () => {
  let ran = 0;
  st.state.views = [
    view('v0', []),
    view('v1', [st.newEditorSlot([{ kind: 'file', path: A }])], null),
  ];
  dirty(A);
  U.closeViewGuarded('v1', () => {
    ran += 1;
  });
  assert.ok(card() !== null);
  assert.equal(ran, 0, 'nothing is ended while the question is up');
  answer('Keep editing').click();
  await settle();
  assert.equal(ran, 0);

  U.closeViewGuarded('v1', () => {
    ran += 1;
  });
  answer('Discard').click();
  await settle();
  assert.equal(ran, 1, 'the act the strip handed in is what runs');
});

// ---------------------------------------------------------------------------
// THE FIFTH DOOR: an OPEN that evicts (part B4 amendment, the user's Windows
// check 2026-09-22 — four files per pane, and a fifth evicts the last chip)
//
// The strip's cap lives in state.ts and is pinned there (tests/ui-state.test.ts).
// What is pinned HERE is the question in front of it: the state opener may
// never be reachable with a dirty eviction without it, and `Keep editing`
// cancels the OPEN itself — the strip stands exactly as it was.
// ---------------------------------------------------------------------------

const C = '/home/you/web/src/Grid.tsx';
const D = '/home/you/web/src/Tabs.tsx';
const E5 = '/home/you/web/src/Fifth.tsx';

/** A view whose one editor pane is FULL, in strip order. */
function fullPane(): EditorSlot {
  const slot = st.newEditorSlot([
    { kind: 'file', path: A },
    { kind: 'file', path: B },
    { kind: 'file', path: C },
    { kind: 'file', path: D },
  ]);
  st.state.views = [view('v1', [slot])];
  st.state.activeViewId = 'v1';
  assert.equal(slot.tabs.length, st.MAX_TABS, 'precondition: the strip is full');
  return slot;
}

/** The paths on screen in that pane, in strip order. */
function paths(slot: EditorSlot): string[] {
  return slot.tabs.map((t) => (t.kind === 'file' ? t.path : `d:${t.hash}`));
}

test('an open into a full strip with a CLEAN last chip asks nothing and evicts it', () => {
  const slot = fullPane();
  const results: string[] = [];
  U.openFileGuarded({ kind: 'home' }, E5, 'Fifth.tsx', { done: (r) => results.push(r) });
  assert.equal(card(), null, 'nothing would be lost, so nothing is asked');
  assert.deepEqual(results, ['ok'], 'and it happened SYNCHRONOUSLY, like every clean door');
  assert.deepEqual(paths(slot), [A, B, C, E5], 'position 4 made room');
  assert.equal(slot.active, st.MAX_TABS - 1, 'and the new file is the one on screen');
});

test('a strip with ROOM never asks at all', () => {
  st.state.views = [view('v1', [st.newEditorSlot([{ kind: 'file', path: A }])])];
  dirty(A);
  U.openFileGuarded({ kind: 'home' }, B, 'App.tsx');
  assert.equal(card(), null, 'a dirty tab that is not going anywhere is not a question');
  assert.deepEqual(
    (st.state.views[0]?.slots[0] as EditorSlot).tabs.length,
    2,
    'and the file simply opened',
  );
});

test('the open WAITS for the answer: Keep editing cancels the open, and the strip stands', async () => {
  const slot = fullPane();
  dirty(D);
  const results: string[] = [];

  U.openFileGuarded({ kind: 'home' }, E5, 'Fifth.tsx', { done: (r) => results.push(r) });
  assert.deepEqual(textsOf(dom.body, 'ud-title'), ['Discard unsaved changes to Tabs.tsx?']);
  assert.deepEqual(paths(slot), [A, B, C, D], 'nothing moved while the question is up');

  answer('Keep editing').click();
  await settle();
  assert.deepEqual(paths(slot), [A, B, C, D], 'Keep editing changed nothing at all');
  assert.equal(st.state.edits.has(st.editorFileId(D)), true, 'the unsaved text is still there');
  assert.deepEqual(results, [], 'and the open never ran, so there is no result to report');
});

test('Discard opens the fifth file and the evicted text goes with its chip', async () => {
  const slot = fullPane();
  dirty(D);
  U.openFileGuarded({ kind: 'home' }, E5, 'Fifth.tsx');
  answer('Discard').click();
  await settle();
  assert.deepEqual(paths(slot), [A, B, C, E5]);
  assert.equal(st.state.edits.has(st.editorFileId(D)), false, 'pruned by the eviction');
  assert.equal(st.state.edits.size, 0);
});

test('the question is about the chip that LEAVES — not about the dirty ones that stay', async () => {
  const slot = fullPane();
  dirty(A);
  dirty(D);
  U.openFileGuarded({ kind: 'home' }, E5, 'Fifth.tsx');
  assert.deepEqual(
    textsOf(dom.body, 'ud-title'),
    ['Discard unsaved changes to Tabs.tsx?'],
    'one name, the evicted one',
  );
  answer('Discard').click();
  await settle();
  assert.equal(st.state.edits.has(st.editorFileId(A)), true, "A's text is still on screen");
  assert.deepEqual(paths(slot), [A, B, C, E5], 'and only the last chip left');
});

test('a file already in the full strip is RAISED — no question, no eviction', () => {
  const slot = fullPane();
  dirty(D);
  U.openFileGuarded({ kind: 'home' }, B, 'App.tsx');
  assert.equal(card(), null, 'a raise loses nothing');
  assert.deepEqual(paths(slot), [A, B, C, D], 'all four survive');
  assert.equal(slot.active, 1, 'raised');
});

test('openDiffGuarded asks about the chip a DIFF would evict', async () => {
  const slot = fullPane();
  dirty(D);
  U.openDiffGuarded({ kind: 'home' }, HASH, 'a.ts', '/repo');
  assert.deepEqual(textsOf(dom.body, 'ud-title'), ['Discard unsaved changes to Tabs.tsx?']);
  answer('Discard').click();
  await settle();
  assert.deepEqual(paths(slot), [A, B, C, `d:${HASH}`], 'a diff counts in the same four');
});

test('openTabAtGuarded: the pane CENTRE asks; an EDGE makes a pane and never asks', async () => {
  const slot = fullPane();
  dirty(D);

  U.openTabAtGuarded('v1', 0, 'replace', { kind: 'file', path: E5 });
  assert.deepEqual(textsOf(dom.body, 'ud-title'), ['Discard unsaved changes to Tabs.tsx?']);
  answer('Keep editing').click();
  await settle();
  assert.deepEqual(paths(slot), [A, B, C, D], 'the drop was cancelled with the question');

  const results: string[] = [];
  U.openTabAtGuarded('v1', 0, 'left', { kind: 'file', path: E5 }, { done: (r) => results.push(r) });
  assert.equal(card(), null, 'an edge makes a NEW pane, which evicts nothing');
  assert.deepEqual(results, ['ok']);
  assert.equal(st.state.views[0]?.slots.length, 2);
  assert.deepEqual(paths(slot), [A, B, C, D], 'and the full strip is untouched');
});

test('no module reaches the state openers past the guard', () => {
  // THE INVARIANT: the state opener must never be reachable with a dirty
  // eviction and no question. `state.ts` performs the eviction, `unsaved.ts`
  // is the only door in front of it — so no other module may call the three
  // openers directly. Read from SOURCE, because main.ts and ui/panes.ts pull
  // @xterm/xterm in and cannot be imported here.
  const web = join(projectRoot, 'web', 'src');
  const files = readdirSync(web, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts'))
    .filter((f) => f !== 'state.ts' && f !== join('ui', 'unsaved.ts'));
  let scanned = 0;
  let guardedCalls = 0;
  for (const rel of files) {
    const src = readFileSync(join(web, rel), 'utf8');
    scanned += 1;
    for (const call of ['st.openFile(', 'st.openDiff(', 'st.openTabAt(']) {
      assert.equal(
        src.includes(call),
        false,
        `${rel}: ${call} must go through ui/unsaved.ts's guarded twin (B4 amendment)`,
      );
    }
    for (const call of ['openFileGuarded(', 'openDiffGuarded(', 'openTabAtGuarded(']) {
      if (src.includes(call)) guardedCalls += 1;
    }
  }
  assert.ok(scanned > 40, `non-vacuity: only ${scanned} sources scanned`);
  assert.ok(guardedCalls >= 4, `non-vacuity: only ${guardedCalls} guarded openers called`);
});

// ---------------------------------------------------------------------------
// Reload and window close
// ---------------------------------------------------------------------------

test('beforeunload is armed ONLY while something is unsaved', () => {
  const event = (): { preventDefault(): void; returnValue: unknown; prevented: boolean } => ({
    prevented: false,
    preventDefault() {
      this.prevented = true;
    },
    returnValue: undefined,
  });

  const clean = event();
  assert.equal(U.unloadGuard(clean), false, 'a page that always asks means nothing');
  assert.equal(clean.prevented, false);
  assert.equal(clean.returnValue, undefined);

  dirty(A);
  const armed = event();
  assert.equal(U.unloadGuard(armed), true);
  assert.equal(armed.prevented, true, 'preventDefault is what the modern browsers read');
  assert.equal(armed.returnValue, '', 'and returnValue is what the older ones read');

  st.state.edits.clear();
  assert.equal(U.unloadGuard(event()), false, 'saved is saved');
});

test('after disarm, beforeunload asks nothing even while dirty', () => {
  // LAST OF THIS SECTION ON PURPOSE: the disarm is one-way (the page is
  // leaving), so nothing after it may depend on the guard being armed.
  const event = (): { preventDefault(): void; returnValue: unknown; prevented: boolean } => ({
    prevented: false,
    preventDefault() {
      this.prevented = true;
    },
    returnValue: undefined,
  });
  dirty(A);
  assert.equal(U.unloadGuard(event()), true, 'non-vacuity: it was armed');

  // An APP-initiated reload is not a door the user is walking out of: by the
  // time it runs the old backend has torn down, so "stay" would leave the page
  // on a backend that is gone.
  U.disarmUnloadGuard();
  const after = event();
  assert.equal(U.unloadGuard(after), false, 'the handoff asks nothing');
  assert.equal(after.prevented, false);
  assert.equal(after.returnValue, undefined);

  // And the reloads the app performs really do disarm it first. A reload the
  // USER presses (`button('btn-accent', 'Reload', …)` on the boot-fatal and
  // takeover panels) is their own move and stays armed; a comment about one is
  // not a call site.
  let checked = 0;
  for (const rel of ['web/src/ui/update.ts', 'web/src/main.ts']) {
    const src = readFileSync(join(projectRoot, ...rel.split('/')), 'utf8');
    for (const line of src.split('\n')) {
      if (!line.includes('location.reload()')) continue;
      const code = line.trim();
      if (code.startsWith('*') || code.startsWith('//')) continue; // prose
      if (line.includes('button(')) continue; // a button the USER presses
      checked += 1;
      const at = src.indexOf(line);
      assert.match(
        src.slice(Math.max(0, at - 400), at),
        /disarmUnloadGuard\(\);/,
        `${rel}: an app-initiated reload must disarm the unsaved question first (${code})`,
      );
    }
  }
  assert.ok(checked >= 2, `non-vacuity: only ${checked} app-initiated reloads found`);
});

test('main.ts wires the browser question and ranks this card in its Escape ladder', () => {
  // main.ts imports @xterm/xterm through ui/panes.ts and cannot be loaded here,
  // so the WIRING is read from source — the two lines that make the module
  // above reachable at all.
  const src = readFileSync(join(projectRoot, 'web', 'src', 'main.ts'), 'utf8');
  assert.match(src, /addEventListener\('beforeunload'/, 'the reload question must be wired');
  assert.match(src, /unloadGuard\(e\)/, 'and it must be THIS decision, not a second copy of it');
  assert.ok(src.includes('closeActiveTabGuarded('), 'ctrl+alt+w goes through the guard');
  assert.equal(src.includes('st.closeActiveTab('), false, 'and never past it');
  // Ranked in the ONE Escape ladder, with the dialog it is modelled on.
  const ladder = src.slice(src.indexOf("if (e.key === 'Escape'"));
  const delAt = ladder.indexOf('isDeleteDialogOpen()');
  const discardAt = ladder.indexOf('isDiscardDialogOpen()');
  assert.ok(delAt !== -1 && discardAt !== -1, 'both dialogs must be in the ladder');
  assert.ok(discardAt > delAt, 'ranked beside the delete confirmation it copies');
});

test('every door in the app goes through a guard — no raw closer is left anywhere', () => {
  // The greppable half of D1: a `×` that called the state mutator directly
  // would be a door with no question, and nothing else in the suite would see
  // it (the mutator itself is right, and its own tests stay green).
  const pane = readFileSync(join(projectRoot, 'web', 'src', 'ui', 'editor-pane.ts'), 'utf8');
  for (const call of ['st.closeSlot(', 'st.closeTab(']) {
    assert.equal(pane.includes(call), false, `ui/editor-pane.ts still closes without asking: ${call}`);
  }
  assert.match(pane, /closeSlotGuarded\(/);
  assert.match(pane, /closeTabGuarded\(/);

  // The tab strip's `×` is the one door whose ACT is more than a close (it ends
  // the sessions in the tab first), so the raw `st.closeView` is legitimate —
  // INSIDE that act. What must not happen is the BUTTON calling it.
  const tabs = readFileSync(join(projectRoot, 'web', 'src', 'ui', 'tabs.ts'), 'utf8');
  const from = tabs.indexOf("const close = button('tab-x'");
  assert.notEqual(from, -1, 'non-vacuity: the tab × must still be built here');
  const handler = tabs.slice(from, tabs.indexOf('wrap.append(close)', from));
  assert.match(handler, /closeViewGuarded\(/, 'the × asks first');
  assert.equal(handler.includes('st.closeView('), false, 'and never closes past the question');
  assert.equal(handler.includes('killView('), true, 'the act it hands in is the strip\'s own');
});
