/**
 * `web/src/ui/editor-pane.ts` — the file-tab strip of an EDITOR pane (Nocturne
 * part A10b, user decision 1, 2026-09-15), driven through the REAL module on
 * the DOM double in `tests/fake-dom.ts`, against the REAL `web/src/state.ts`,
 * `ui/util.ts`, `ui/dnd.ts`, `ui/slots-model.ts`, `ui/editor-model.ts`,
 * `ui/file-pane.ts` — with the two backends plain fakes
 * (`tests/editor-fixture.ts` for the files, `tests/fs-fixture.ts` for git).
 *
 * WHY THIS FILE EXISTS, next to `tests/ui-pane-a10.test.ts`. That file is a
 * SOURCE scan: `ui/panes.ts` reaches @xterm/xterm and cannot be imported under
 * `node --test`. This module deliberately does not — it is the half of a pane
 * that is plain DOM — so the things a source scan can only describe are really
 * driven here. All five of them are regressions that keep every other test in
 * the suite green:
 *
 *   1. A STRIP REBUILT ON EVERY KEYSTROKE. The chips are the only DOM in a
 *      pane header that is redrawn while the user types; rebuilding them per
 *      letter throws away the focus ring and costs a pane's worth of nodes 20
 *      times a second.
 *   2. A BODY REBUILT ON A TAB SWITCH. The bodies are parked DETACHED so the
 *      textarea keeps its value, its selection and its scroll offset; a swap
 *      that re-BUILDS them puts the caret back at 0 on every round trip — the
 *      A6 editor-column lesson, one level up.
 *   3. A PARKED BODY THAT OUTLIVES ITS TAB. A closed tab whose body stayed in
 *      the Map hands a re-opened file the textarea of a strip that is gone.
 *   4. A `×` THAT RAISES BEFORE IT CLOSES — the file being closed flashes on
 *      screen on its way out.
 *   5. THE CHIP LOSING ITS OWN DRAG to the pane header it sits in: the gesture
 *      would move the whole pane where the user meant to move one file.
 *
 * NOT claimed (browser work, `.claude/skills/verify-terminal/SKILL.md`):
 * layout, colour, the strip really scrolling, screen-reader output, and that a
 * dropped tab really reflows a PTY.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectRoot } from './helpers.ts';
import {
  byClass,
  descendants,
  dispatch,
  installDom,
  textsOf,
  type FakeElement,
} from './fake-dom.ts';
import { PROJ, makeFixture, settle } from './fs-fixture.ts';
import { makeEditor } from './editor-fixture.ts';
import { HEAD } from './commits-fixture.ts';

const dom = installDom();

// ---------------------------------------------------------------------------
// The real modules. Loaded through a computed URL so the SERVER tsconfig does
// not walk the browser type graph (web/tsconfig.json owns that) — the same
// seam `tests/ui-file-pane.test.ts` and `tests/ui-dnd-a10.test.ts` use.
// ---------------------------------------------------------------------------

type EditorTab =
  | { kind: 'file'; path: string }
  /** Part B3: a diff tab carries the folder it is READ from, and the full hash. */
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
}

interface StateModule {
  state: {
    views: ViewLike[];
    activeViewId: string;
    sessions: Map<string, unknown>;
    projects: unknown[];
    history: unknown[];
    edits: Map<string, string>;
  };
  openFile(root: { kind: 'home' }, path: string, label: string): string;
  openDiff(root: { kind: 'home' }, hash: string, path: string, repoRoot: string): string;
  activeView(): ViewLike | null;
  slotKey(s: PaneSlot): string;
  setActiveTab(viewId: string, slot: number, tabIndex: number): boolean;
  editorFileId(path: string): string;
  editorDirty(id: string | null): boolean;
  setEdit(id: string, text: string): void;
  newEditorSlot(tabs: EditorTab[]): EditorSlot;
  retargetFiles(from: string, to: string): boolean;
}
interface EditorPaneModule {
  editorPane(
    hd: FakeElement,
    body: FakeElement,
  ): {
    update(slot: EditorSlot, viewId: string, slotIndex: number): void;
    focus(): void;
    holdsFocus(): boolean;
    dispose(): void;
  };
  fileTabSpec(
    viewId: string,
    slot: EditorSlot,
    slotIndex: number,
    tabIndex: number,
  ): Record<string, unknown> | null;
}
interface DndModule {
  armDrag(source: unknown, ignore: string | null, makeSpec: () => unknown): void;
}

const st = (await import(new URL('../web/src/state.ts', import.meta.url).href)) as StateModule;
const EP = (await import(
  new URL('../web/src/ui/editor-pane.ts', import.meta.url).href
)) as unknown as EditorPaneModule;
const DND = (await import(new URL('../web/src/ui/dnd.ts', import.meta.url).href)) as DndModule;
const EM = (await import(new URL('../web/src/ui/editor-model.ts', import.meta.url).href)) as {
  fileTabId(path: string): string;
  diffTabId(hash: string, path: string): string;
};
const STORE = (await import(new URL('../web/src/ui/commit-store.ts', import.meta.url).href)) as {
  setCommitGateway(gw: unknown): void;
};
const ES = (await import(new URL('../web/src/ui/editor-store.ts', import.meta.url).href)) as {
  setEditorGateway(gw: unknown): void;
};
// A diff TAB fetches its own rows (part B3), through the gateway the commit
// store owns — injected here exactly as main.ts injects the real one.
STORE.setCommitGateway(makeFixture().gateway);
// A FILE tab reads and writes through the editor store's gateway (part B4).
// The strip is what this file is about, so the backend is a fake disk and
// every case lets its answer land (`await sync()`).
const ed = makeEditor();
ES.setEditorGateway(ed.gateway);

const A = '/home/you/web/src/Pane.tsx';
const B = '/home/you/web/src/App.tsx';
/** A diff path is REPOSITORY-relative, as git names it. */
const C = 'shared/protocol.ts';
const ORIGINAL_A = 'export function Pane() {\n  return null;\n}\n';
const ORIGINAL_B = 'export function App() {\n  return <Pane />;\n}\n';
const HASH = HEAD;
/** The chip shows seven characters of it; the tab's identity is all forty. */
const SHORT = HEAD.slice(0, 7);
/** The folder every diff tab below is read from. */
const REPO = PROJ;

// ---------------------------------------------------------------------------
// The two elements `ui/panes.ts` owns and hands over: a header and a body.
// ---------------------------------------------------------------------------

let hd: FakeElement;
let body: FakeElement;
let pane: ReturnType<EditorPaneModule['editorPane']>;
/** What the PANE's own header drag was asked for — panes.ts arms exactly one. */
let paneSpecCalls = 0;

/** The editor slot of the Home tab, as state.ts has it right now. */
function slot(): EditorSlot {
  const v = st.activeView() as ViewLike;
  const s = v.slots[0] as PaneSlot;
  assert.equal(s.kind, 'editor', 'the Home tab must hold exactly one editor pane');
  return s as EditorSlot;
}

/**
 * What `ui/panes.ts` does on every notify: hand the pane the current model —
 * and then let the read of any body it just built land (part B4: a file body
 * shows `Loading…` until its answer arrives).
 */
async function sync(): Promise<void> {
  pane.update(slot(), (st.activeView() as ViewLike).id, 0);
  await settle();
}

function chips(): FakeElement[] {
  return byClass(hd, 'pane-tab');
}

function labels(): string[] {
  return textsOf(hd, 'pane-tab-pick');
}

/** The one field the active tab's body offers, or null (a diff offers none). */
function field(): FakeElement | null {
  return descendants(body).find((n) => n.tagName === 'TEXTAREA') ?? null;
}

function type(ta: FakeElement, value: string): void {
  ta.value = value;
  dispatch(ta, 'input');
}

beforeEach(async () => {
  ed.setFile(A, ORIGINAL_A);
  ed.setFile(B, ORIGINAL_B);
  st.state.views = [];
  st.state.activeViewId = '';
  st.state.sessions = new Map();
  st.state.projects = [];
  st.state.history = [];
  st.state.edits = new Map();
  dom.doc.activeElement = dom.body;

  hd = dom.doc.createElement('div');
  hd.className = 'pane-hd';
  body = dom.doc.createElement('div');
  body.className = 'pane-body';
  const card = dom.doc.createElement('div');
  card.className = 'pane';
  card.append(hd, body);
  dom.body.replaceChildren(card);

  // ui/panes.ts arms the PANE drag on the header, once, before the strip
  // exists — `ignore: 'button'`, exactly as `createSlot()` does.
  paneSpecCalls = 0;
  DND.armDrag(hd, 'button', () => {
    paneSpecCalls += 1;
    return { kind: 'pane', viewId: 'v', slot: 0, slotKey: 'x', label: 'pane' };
  });

  pane = EP.editorPane(hd, body);
  st.openFile({ kind: 'home' }, A, 'Pane.tsx');
  st.openFile({ kind: 'home' }, B, 'App.tsx');
  await sync();
});

/** Let go of whatever a test picked up, so the module singleton is clean. */
function releasePointer(id: number): void {
  dispatch(dom.body, 'pointerup', { pointerId: id });
}

// ---------------------------------------------------------------------------
// Non-vacuity
// ---------------------------------------------------------------------------

test('non-vacuity: two real files are open as TABS OF ONE PANE, with real text', async () => {
  assert.ok(ORIGINAL_A.length > 20 && ORIGINAL_B.length > 20, 'the example files look empty');
  assert.notEqual(ORIGINAL_A, ORIGINAL_B, 'two different files, or the round-trip proves nothing');
  const v = st.activeView() as ViewLike;
  assert.equal(v.slots.length, 1, 'a second file is a TAB, never a second pane (user decision 1)');
  assert.equal(slot().tabs.length, 2);
  assert.ok(field() !== null, 'and the active tab really renders a field');
});

// ---------------------------------------------------------------------------
// 1. The strip: what it draws, and that it says which file is up
// ---------------------------------------------------------------------------

test('one chip per tab, in strip order, and exactly ONE of them is on', async () => {
  assert.deepEqual(labels(), ['Pane.tsx', 'App.tsx'], 'the chips follow the model, in its order');
  const on = chips().filter((c) => c.classList.contains('is-on'));
  assert.equal(on.length, 1, 'exactly one chip is the one on screen');
  assert.equal(on[0], chips()[1], 'and it is the file that was opened last');
  assert.deepEqual(
    chips().map((c) => (c.querySelector('.pane-tab-pick') as FakeElement).getAttribute('aria-pressed')),
    ['false', 'true'],
    'the same fact, for a reader who cannot see the fill',
  );
  // The strip itself is a plain group of buttons, not a lie about WAI-ARIA tabs.
  const strip = byClass(hd, 'pane-tabs')[0] as FakeElement;
  assert.equal(strip.getAttribute('role'), 'group');
  assert.equal(strip.getAttribute('aria-label'), 'open files');
});

test('the strip is followed by the PANE’s own ×, which says what goes with it', async () => {
  const xs = byClass(hd, 'pane-x');
  // One × per chip, then the pane's own — and the pane's is the LAST thing in
  // the header, behind the `.pane-gap` that is the pane's grab area.
  assert.equal(xs.length, 3, 'two tab closers and one pane closer');
  assert.equal(byClass(hd, 'pane-gap').length, 1);
  const closePane = xs[2] as FakeElement;
  assert.equal(closePane.parentNode, hd, 'the pane × is in the header, not in a chip');
  assert.equal(closePane.getAttribute('aria-label'), 'Close this pane and its 2 files');
  assert.equal(closePane.title, 'Close this pane and its 2 files');
});

test('a read-only diff tab is called after its commit and never wears the unsaved mark', async () => {
  st.openDiff({ kind: 'home' }, HASH, C, REPO);
  await sync();
  assert.deepEqual(labels(), ['Pane.tsx', 'App.tsx', `Changes in ${SHORT}`]);
  assert.equal(field(), null, 'a diff has nothing to type into');
  assert.equal(byClass(hd, 'pane-dirty').length, 0, 'and so it can never be unsaved');
  const x = byClass(chips()[2] as FakeElement, 'pane-x')[0] as FakeElement;
  assert.equal(x.getAttribute('aria-label'), `Close Changes in ${SHORT}`);
});

test('B12: every chip carries its file’s type icon before the name — a diff git’s — and the name stays the text', async () => {
  st.openDiff({ kind: 'home' }, HASH, C, REPO);
  await sync();
  const picks = byClass(hd, 'pane-tab-pick');
  assert.deepEqual(
    picks.map((p) => {
      const ic = p.children[0] as FakeElement;
      return [ic.getAttribute('data-icon'), ic.getAttribute('data-kind'), ic.getAttribute('aria-hidden')];
    }),
    [
      ['typescript', 'ts', 'true'],
      ['typescript', 'ts', 'true'],
      ['git', 'git', 'true'],
    ],
  );
  assert.deepEqual(labels(), ['Pane.tsx', 'App.tsx', `Changes in ${SHORT}`], 'the icon adds no text');
});

// ---------------------------------------------------------------------------
// 2. Unsaved: the dot, and the same fact in words
// ---------------------------------------------------------------------------

test('a dirty tab wears the amber dot AND says so in words — on ITS chip only', async () => {
  type(field() as FakeElement, `${ORIGINAL_B}\nchanged`);
  assert.equal(st.editorDirty(st.editorFileId(B)), true, 'non-vacuity: state really flipped');
  await sync();
  const dirtyChip = chips()[1] as FakeElement;
  assert.equal(byClass(dirtyChip, 'pane-dirty').length, 1, 'the dot is on the file that changed');
  assert.deepEqual(textsOf(dirtyChip, 'sr-only'), ['Unsaved changes']);
  assert.equal(byClass(chips()[0] as FakeElement, 'pane-dirty').length, 0, 'and on no other chip');
  assert.equal(byClass(hd, 'pane-dirty').length, 1);
  // The dot is a shape: it must not be read out twice.
  assert.equal(
    (byClass(dirtyChip, 'pane-dirty')[0] as FakeElement).getAttribute('aria-hidden'),
    'true',
  );
});

test('the dirty bit is IN the strip signature: the dot appears AND goes away again', async () => {
  // A signature built from the tab ids and the active index alone keeps every
  // assertion about the dot's arrival green (the first keystroke happens to
  // rebuild for another reason on some paths) and then never moves it again.
  const ta = field() as FakeElement;
  type(ta, `${ORIGINAL_B}\nchanged`);
  await sync();
  assert.equal(byClass(hd, 'pane-dirty').length, 1, 'non-vacuity: it appeared');
  (byClass(body, 'pane-save')[0] as FakeElement).click();
  await settle(); // the write is a request now (part B4): `Saved` is what LANDED
  assert.equal(st.editorDirty(st.editorFileId(B)), false, 'non-vacuity: the save really landed');
  await sync();
  assert.equal(byClass(hd, 'pane-dirty').length, 0, 'a strip sig without the dirty bit sticks');
});

// ---------------------------------------------------------------------------
// 3. The tab × closes THAT tab, and never raises it on the way out
// ---------------------------------------------------------------------------

test('the × of an unfocused chip closes THAT tab and leaves the active one alone', async () => {
  const before = slot().active;
  assert.equal(before, 1, 'non-vacuity: the SECOND tab is the one on screen');
  const x = byClass(chips()[0] as FakeElement, 'pane-x')[0] as FakeElement;
  assert.equal(x.getAttribute('aria-label'), 'Close Pane.tsx');
  x.click();
  assert.deepEqual(
    slot().tabs.map((t) => (t.kind === 'file' ? t.path : t.hash)),
    [B],
    'the tab that was clicked is the tab that went',
  );
  await sync();
  assert.deepEqual(labels(), ['App.tsx'], 'and the strip agrees');
  assert.equal((byClass(hd, 'pane-x')[1] as FakeElement).getAttribute('aria-label'),
    'Close this pane and the file in it', 'the pane × counts what is left');
});

test('a chip’s × never raises its tab first — the click stops at the button', async () => {
  // The chip AROUND the × is the picker. A × that let its click through would
  // raise the file it is closing, so the user sees it flash on the way out.
  const chip = chips()[0] as FakeElement;
  const x = byClass(chip, 'pane-x')[0] as FakeElement;
  let raised = 0;
  chip.addEventListener('click', () => {
    raised += 1;
  });
  dispatch(x, 'click');
  assert.equal(raised, 0, 'stopPropagation is what keeps the closing file off the screen');
});

test('clicking a chip raises its tab, through state.ts', async () => {
  const pick = byClass(chips()[0] as FakeElement, 'pane-tab-pick')[0] as FakeElement;
  pick.click();
  assert.equal(slot().active, 0, 'the model moved');
  await sync();
  assert.equal((chips()[0] as FakeElement).classList.contains('is-on'), true);
  assert.equal((chips()[1] as FakeElement).classList.contains('is-on'), false);
});

// ---------------------------------------------------------------------------
// 4. The bodies are PARKED, not rebuilt
// ---------------------------------------------------------------------------

test('a tab round trip brings back the SAME textarea node — with its text in it', async () => {
  const taB = field() as FakeElement;
  type(taB, `${ORIGINAL_B}\ntyped in B`);

  st.setActiveTab((st.activeView() as ViewLike).id, 0, 0);
  await sync();
  const taA = field() as FakeElement;
  assert.notEqual(taA, taB, 'non-vacuity: the other tab has its own field');
  assert.equal(taA.value, ORIGINAL_A);

  st.setActiveTab((st.activeView() as ViewLike).id, 0, 1);
  await sync();
  assert.equal(field(), taB, 'the SAME node: a rebuilt one loses caret, selection and scroll');
  assert.equal((field() as FakeElement).value, `${ORIGINAL_B}\ntyped in B`);
});

test('20 keystrokes: the node never moves and the chips are rebuilt at most ONCE', async () => {
  const ta = field() as FakeElement;
  let chipRebuilds = 0;
  let last = chips()[0];
  for (let i = 1; i <= 20; i++) {
    type(ta, `${ORIGINAL_B}\n${'x'.repeat(i)}`);
    await sync();
    assert.equal(field(), ta, `the field survived keystroke ${i}`);
    if (chips()[0] !== last) {
      chipRebuilds += 1;
      last = chips()[0];
    }
  }
  // The one rebuild it is allowed is the dirty FLIP on the first keystroke:
  // the amber dot really did arrive. Every letter after it changes nothing the
  // strip draws, so it must cost no DOM at all.
  assert.ok(chipRebuilds <= 1, `the strip was rebuilt ${chipRebuilds} times for 20 letters`);
  assert.equal(byClass(hd, 'pane-dirty').length, 1, 'and the rebuild it spent was the dot');
});

test('a closed tab’s parked body is dropped: re-opening the file builds a new one', async () => {
  const taB = field() as FakeElement;
  // Close the tab that is up, then open the same path again.
  const x = byClass(chips()[1] as FakeElement, 'pane-x')[0] as FakeElement;
  x.click();
  await sync();
  assert.deepEqual(labels(), ['Pane.tsx'], 'non-vacuity: it really left the strip');

  st.openFile({ kind: 'home' }, B, 'App.tsx');
  await sync();
  assert.deepEqual(labels(), ['Pane.tsx', 'App.tsx']);
  assert.notEqual(
    field(),
    taB,
    'a body kept past its tab hands a re-opened file the textarea of a strip that is gone',
  );
});

test('a SECOND pane on the same file refreshes its Save button while the first is typed in', async () => {
  // The cheap path — same strip, same active tab — ends in
  // `bodies.get(shown).update()`, and that call is the ONLY thing that carries
  // an outside change into a body that is already on screen. A pane that
  // swapped its body on every `update()` instead would skip it, and this
  // second pane would keep saying `Saved` about a file that is unsaved.
  const second = st.newEditorSlot([{ kind: 'file', path: A }]);
  const hd2 = dom.doc.createElement('div');
  hd2.className = 'pane-hd';
  const body2 = dom.doc.createElement('div');
  body2.className = 'pane-body';
  const card2 = dom.doc.createElement('div');
  card2.className = 'pane';
  card2.append(hd2, body2);
  dom.body.append(card2);
  const pane2 = EP.editorPane(hd2, body2);
  const viewId = (st.activeView() as ViewLike).id;
  pane2.update(second, viewId, 1);
  await settle(); // its body reads its file before it draws one
  const saveOf = (host: FakeElement): string =>
    (byClass(host, 'pane-save')[0] as FakeElement).textContent;
  const fieldOf = (host: FakeElement): FakeElement =>
    descendants(host).find((n) => n.tagName === 'TEXTAREA') as FakeElement;
  assert.equal(saveOf(body2), 'Saved', 'non-vacuity: nothing is unsaved yet');

  // The first pane raises the same file and the user types in it.
  st.setActiveTab(viewId, 0, 0);
  await sync();
  type(field() as FakeElement, `${ORIGINAL_A}\ntyped in the other pane`);
  assert.equal(st.editorDirty(st.editorFileId(A)), true, 'non-vacuity: the file is unsaved now');

  const before = fieldOf(body2);
  pane2.update(second, viewId, 1);
  assert.equal(saveOf(body2), 'Save', 'the second pane heard about it');
  assert.equal(fieldOf(body2), before, 'and it did not rebuild its field to hear it');
  pane2.dispose();
  card2.remove();
});

test('dispose() gives up every parked body, so a converted pane resurrects nothing', async () => {
  const taB = field() as FakeElement;
  pane.dispose();
  hd.replaceChildren();
  body.replaceChildren();
  // panes.ts builds a NEW editorPane on the same elements after a conversion.
  pane = EP.editorPane(hd, body);
  await sync();
  assert.notEqual(field(), taB, 'a stale textarea would carry text state.ts has already dropped');
  assert.deepEqual(labels(), ['Pane.tsx', 'App.tsx'], 'and the strip is drawn from the model again');
});

// ---------------------------------------------------------------------------
// 5. The keyboard
// ---------------------------------------------------------------------------

test('focus() lands in the text of a file tab, and on the CHIP of a read-only diff', async () => {
  pane.focus();
  assert.equal(dom.doc.activeElement, field(), 'a file pane focuses what can be typed in');
  assert.equal(pane.holdsFocus(), false, 'the textarea is the BODY, not the strip');

  st.openDiff({ kind: 'home' }, HASH, C, REPO);
  await sync();
  pane.focus();
  const pick = byClass(chips()[2] as FakeElement, 'pane-tab-pick')[0] as FakeElement;
  assert.equal(dom.doc.activeElement, pick, 'a diff has no field: the keyboard lands on its chip');
  assert.equal(pane.holdsFocus(), true, 'and panes.ts must not move it out of the strip');
});

test('a rebuilt strip hands the keyboard back to the chip that had it', async () => {
  const pick = byClass(chips()[0] as FakeElement, 'pane-tab-pick')[0] as FakeElement;
  const key = pick.getAttribute('data-k');
  assert.equal(key, `ptab:${slot().id}:${EM.fileTabId(A)}`, 'the key names the PANE and the TAB');
  pick.focus();
  assert.equal(pane.holdsFocus(), true);
  // Something else makes the strip redraw under the user's hands.
  st.setEdit(st.editorFileId(B), `${ORIGINAL_B}\nchanged`);
  await sync();
  assert.notEqual(byClass(chips()[0] as FakeElement, 'pane-tab-pick')[0], pick, 'it really redrew');
  assert.equal(
    (dom.doc.activeElement as FakeElement).getAttribute('data-k'),
    key,
    'the keyboard followed the chip, not the node',
  );
});

// ---------------------------------------------------------------------------
// 6. The chip is its own drag source
// ---------------------------------------------------------------------------

test('fileTabSpec names the pane twice and the tab twice — nothing more', async () => {
  const s = slot();
  const spec = EP.fileTabSpec('v9', s, 2, 1) as Record<string, unknown>;
  assert.deepEqual(spec, {
    kind: 'filetab',
    viewId: 'v9',
    slot: 2,
    slotKey: st.slotKey(s),
    tab: 1,
    tabId: EM.fileTabId(B),
    label: 'App.tsx',
  });
  // TAB ID ≠ SLOT KEY: the drop layer tells a moved pane from a moved tab.
  assert.equal(spec.slotKey, s.id);
  assert.notEqual(spec.slotKey, spec.tabId);
  // A strip rebuilt under the drag resolves to nothing rather than to whatever
  // slid into that position.
  assert.equal(EP.fileTabSpec('v9', s, 2, 9), null, 'an index past the strip carries nothing');
});

test('a diff chip carries its own id, from the other id space', async () => {
  st.openDiff({ kind: 'home' }, HASH, C, REPO);
  await sync();
  const spec = EP.fileTabSpec('v9', slot(), 0, 2) as Record<string, unknown>;
  assert.equal(spec.tabId, EM.diffTabId(HASH, C));
  assert.equal(spec.label, `Changes in ${SHORT}`);
});

test('a pointerdown on a chip arms the CHIP’s drag, never the pane’s', async () => {
  const chip = chips()[0] as FakeElement;
  dispatch(chip, 'pointerdown', { clientX: 10, clientY: 10, pointerId: 31 });
  dispatch(dom.body, 'pointermove', { clientX: 200, clientY: 300, pointerId: 31 });
  assert.equal(paneSpecCalls, 0, 'the pane drag stands down: a drag is already in flight');
  const ghost = byClass(dom.body, 'drag-ghost')[0] as FakeElement | undefined;
  assert.equal(ghost?.textContent, 'Pane.tsx', 'and what is being dragged is the FILE');
  assert.equal(chip.classList.contains('is-dragging'), true, 'the CHIP dims — the pane is staying');
  assert.equal(
    (byClass(dom.body, 'pane')[0] as FakeElement).classList.contains('is-dragging'),
    false,
    'a dimmed pane would say the whole pane is leaving',
  );
  releasePointer(31);
});

test('a pointerdown on a chip’s LABEL arms the chip too (the label is most of the chip)', async () => {
  const pick = byClass(chips()[1] as FakeElement, 'pane-tab-pick')[0] as FakeElement;
  dispatch(pick, 'pointerdown', { clientX: 10, clientY: 10, pointerId: 32 });
  dispatch(dom.body, 'pointermove', { clientX: 200, clientY: 300, pointerId: 32 });
  assert.equal(paneSpecCalls, 0);
  assert.equal((byClass(dom.body, 'drag-ghost')[0] as FakeElement | undefined)?.textContent, 'App.tsx');
  releasePointer(32);
});

test('a pointerdown on a chip’s × drags nothing at all', async () => {
  const x = byClass(chips()[0] as FakeElement, 'pane-x')[0] as FakeElement;
  dispatch(x, 'pointerdown', { clientX: 10, clientY: 10, pointerId: 33 });
  dispatch(dom.body, 'pointermove', { clientX: 200, clientY: 300, pointerId: 33 });
  assert.equal(paneSpecCalls, 0, 'the pane drag ignores buttons');
  assert.equal(byClass(dom.body, 'drag-ghost').length, 0, 'and the chip ignores its own ×');
  releasePointer(33);
});

test('the pane header itself is still the PANE’s handle', async () => {
  // Non-vacuity for the three tests above: the header drag is really armed, so
  // "it did not fire" means the chip won, not that nothing was listening.
  dispatch(hd, 'pointerdown', { clientX: 10, clientY: 10, pointerId: 34 });
  assert.equal(paneSpecCalls, 1, 'a grab on the header — not on a chip — moves the pane');
  releasePointer(34);
});

// ---------------------------------------------------------------------------
// 7. Class parity: a typo is an invisible strip
// ---------------------------------------------------------------------------

test('every class the strip renders has a rule in app.css', async () => {
  const seen = new Set<string>();
  const collect = (): void => {
    for (const n of [hd, body, ...descendants(hd), ...descendants(body)]) {
      for (const c of n.className.split(/\s+/)) if (c !== '') seen.add(c);
    }
  };
  collect();
  type(field() as FakeElement, `${ORIGINAL_B}\nchanged`); // the dot and its words
  await sync();
  collect();
  st.openDiff({ kind: 'home' }, HASH, C, REPO); // a read-only tab
  await sync();
  collect();

  assert.ok(seen.size >= 8, `non-vacuity: only ${seen.size} classes were collected`);
  for (const must of ['pane-tabs', 'pane-tab', 'pane-tab-pick', 'pane-dirty', 'pane-x', 'pane-gap']) {
    assert.ok(seen.has(must), `non-vacuity: the strip did not render .${must}`);
  }
  const css = readFileSync(join(projectRoot, 'web', 'src', 'styles', 'app.css'), 'utf8');
  const missing = [...seen].filter((c) => !css.includes(`.${c}`)).sort();
  assert.deepEqual(missing, [], `classes with no rule in app.css: ${missing.join(', ')}`);
});

test('the strip’s CSS is ONE new section, inserted after the pane header block', async () => {
  const css = readFileSync(join(projectRoot, 'web', 'src', 'styles', 'app.css'), 'utf8');
  const header = css.indexOf('/* ---- pane header (38px)');
  const section = css.indexOf('/* ---- editor pane tabs (Nocturne A10b)');
  assert.notEqual(header, -1, 'non-vacuity: the pane header block was found');
  assert.notEqual(section, -1, 'the A10b section exists');
  assert.ok(header < section, 'and it comes after the block it extends');
  // A9's `fd-` block is the LAST one in the file; appending here would put the
  // strip's rules behind it and split the pane's own vocabulary in two.
  const fd = css.indexOf('/* ---- drag & drop');
  assert.ok(fd === -1 || section < fd, 'nothing of A10b is appended at the end of the file');
  const block = css.slice(section, css.indexOf('\n/* ', section + 10));
  assert.match(block, /min-width: 0;/, 'the strip must be allowed to shrink');
  assert.match(block, /overflow-x: auto;/, 'and to scroll rather than push the pane × away');
  assert.match(block, /height: 26px;/, 'the chip height is a literal, not a new token');
  // Tokens only: no raw colour may enter the pane's vocabulary here.
  assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(block), false, 'colours come from tokens.css');
  assert.equal(/\brgba?\(/.test(block), false, 'and so do the tints');
});

// ---------------------------------------------------------------------------
// A rename in the Files panel (part B13, user decision D3)
// ---------------------------------------------------------------------------

test('a DIRTY tab follows a file rename: new chip name, same unsaved text in the rebuilt field', async () => {
  const typed = `${ORIGINAL_B}\ntyped before the rename`;
  type(field() as FakeElement, typed);
  const moved = '/home/you/web/src/Shell.tsx';
  ed.setFile(moved, ORIGINAL_B); // the disk moved with it
  assert.equal(st.retargetFiles(B, moved), true);
  await sync();
  assert.deepEqual(labels(), ['Pane.tsx', 'Shell.tsx'], 'the chip names the new file');
  assert.equal((field() as FakeElement).value, typed, 'the text the user typed is still there');
  assert.equal(st.editorDirty(st.editorFileId(moved)), true, 'and still unsaved');
  assert.equal(st.editorDirty(st.editorFileId(B)), false, 'nothing is left on the old id');
});

test('a DIRTY tab follows a FOLDER rename; a diff tab in the same strip is left alone', async () => {
  st.openDiff({ kind: 'home' }, HASH, C, REPO);
  await sync();
  st.setActiveTab((st.activeView() as ViewLike).id, 0, 0);
  await sync();
  const typed = `${ORIGINAL_A}\ntyped in A`;
  type(field() as FakeElement, typed);
  const before = slot().tabs.find((t) => t.kind === 'diff');
  ed.setFile('/home/you/web/lib/Pane.tsx', ORIGINAL_A);
  ed.setFile('/home/you/web/lib/App.tsx', ORIGINAL_B);
  st.retargetFiles('/home/you/web/src', '/home/you/web/lib');
  await sync();
  assert.deepEqual(
    slot().tabs.filter((t) => t.kind === 'file').map((t) => t.path),
    ['/home/you/web/lib/Pane.tsx', '/home/you/web/lib/App.tsx'],
  );
  assert.deepEqual(slot().tabs.find((t) => t.kind === 'diff'), before, 'the diff tab is untouched');
  assert.equal((field() as FakeElement).value, typed, 'the active file kept its unsaved text');
});
