/**
 * Media files as EDITOR TABS (Nocturne D7, `.claude/plans/nocturne/PLAN-D7.md`):
 * the real `web/src/ui/editor-pane.ts`, `ui/unsaved.ts` and `web/src/state.ts`
 * on the DOM double, the backend the fake gateway in
 * `tests/helpers/editor-fixture.ts` (text and media halves).
 *
 * What: the BODY is chosen by kind — a picture, video or PDF tab builds the
 * viewer, any other file the text editor, and a tab restored from storage
 * builds the same body a click does; `Edit as text` on an SVG opens a second
 * tab `fileTabId(path) + ':text'` in the same strip with the text editor in
 * it; that tab survives a save/load of the layout, follows a rename with its
 * unsaved text, and the unsaved question names the FILE.
 *
 * Why: the `:text` id is where an SVG's unsaved text lives; if persistence,
 * a rename or the close guard read it as some other file, typed work is lost
 * or the wrong file is named — silently.
 *
 * NOT claimed: rendering (the browser, PLAN-D7 § Phases 3), the Files panel
 * click itself (it goes through `openFileGuarded`, unchanged — the tab it
 * opens is the ordinary file tab this file builds bodies for).
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  buttonByLabel,
  byClass,
  descendants,
  installDom,
  textsOf,
  type FakeElement,
  typeInto as type,
} from '../helpers/fake-dom.ts';
import { settle } from '../helpers/fs-fixture.ts';
import { makeEditor } from '../helpers/editor-fixture.ts';

const dom = installDom();

type EditorTab = { kind: 'file'; path: string; asText?: true } | { kind: 'diff'; hash: string; path: string; root: string };
interface EditorSlot {
  kind: 'editor';
  id: string;
  tabs: EditorTab[];
  active: number;
}
interface ViewLike {
  id: string;
  slots: ({ kind: 'session'; id: string } | EditorSlot)[];
}
const st = (await import(new URL('../../web/src/state.ts', import.meta.url).href)) as {
  state: { views: ViewLike[]; activeViewId: string; edits: Map<string, string> };
  openFile(root: { kind: 'home' }, path: string, label: string): string;
  activeView(): ViewLike | null;
  editorDirty(id: string | null): boolean;
  retargetFiles(from: string, to: string): boolean;
  saveUi(): void;
  loadUi(opts: { reopen: boolean; run: string | null }): void;
};
const EP = (await import(new URL('../../web/src/ui/editor-pane.ts', import.meta.url).href)) as {
  editorPane(hd: FakeElement, body: FakeElement): {
    update(slot: EditorSlot, viewId: string, slotIndex: number): void;
    dispose(): void;
  };
};
const EM = (await import(new URL('../../web/src/ui/editor-model.ts', import.meta.url).href)) as {
  fileTabId(path: string, asText?: boolean): string;
  tabIdOf(t: EditorTab): string;
};
const US = (await import(new URL('../../web/src/ui/unsaved.ts', import.meta.url).href)) as {
  closeTabGuarded(viewId: string, slot: number, tab: number): void;
};
const ES = (await import(new URL('../../web/src/ui/editor-store.ts', import.meta.url).href)) as {
  setEditorGateway(gw: unknown): void;
};
const ed = makeEditor();
ES.setEditorGateway(ed.gateway);

const SVG = '/home/you/art/logo.svg';
const PNG = '/home/you/art/front.png';
const TXT = '/home/you/art/notes.md';
const SVG_TEXT = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>\n';

let hd: FakeElement;
let body: FakeElement;
let pane: ReturnType<typeof EP.editorPane>;

function slot(): EditorSlot {
  const s = (st.activeView() as ViewLike).slots[0];
  assert.ok(s !== undefined && s.kind === 'editor', 'one editor pane');
  return s;
}

async function sync(): Promise<void> {
  pane.update(slot(), (st.activeView() as ViewLike).id, 0);
  await settle();
}

function field(): FakeElement | null {
  return descendants(body).find((n) => n.tagName === 'TEXTAREA') ?? null;
}

beforeEach(async () => {
  pane?.dispose();
  st.state.views = [];
  st.state.activeViewId = '';
  st.state.edits = new Map();
  dom.storage.clear();
  ed.setFile(SVG, SVG_TEXT);
  ed.setMedia(SVG, { size: SVG_TEXT.length, mtimeMs: 1, ino: 1 });
  ed.setMedia(PNG, { size: 2048, mtimeMs: 1, ino: 2 });
  ed.setFile(TXT, '# notes\n');
  hd = dom.doc.createElement('div');
  body = dom.doc.createElement('div');
  const card = dom.doc.createElement('div');
  card.append(hd, body);
  dom.body.replaceChildren(card);
  pane = EP.editorPane(hd, body);
});

test('the body is chosen by kind: a picture gets the viewer, a text file the editor', async () => {
  st.openFile({ kind: 'home' }, PNG, 'front.png');
  await sync();
  assert.equal(byClass(body, 'pane-mimg').length, 1, 'a picture tab is a viewer');
  assert.equal(field(), null, 'and offers no text field');
  st.openFile({ kind: 'home' }, TXT, 'notes.md');
  await sync();
  assert.ok(field() !== null, 'a text file is the editor, as before');
  assert.equal(byClass(body, 'pane-media').length, 0);
});

test('Edit as text opens `fileTabId(path) + ":text"` in the SAME strip, with the text editor', async () => {
  st.openFile({ kind: 'home' }, SVG, 'logo.svg');
  await sync();
  buttonByLabel(body, 'Edit as text').click();
  await sync();
  assert.deepEqual(
    slot().tabs.map((t) => EM.tabIdOf(t)),
    [EM.fileTabId(SVG), `${EM.fileTabId(SVG)}:text`],
    'the picture and its text, side by side in one strip',
  );
  assert.equal(slot().active, 1, 'the text tab is raised');
  assert.deepEqual(textsOf(hd, 'pane-tab-pick'), ['logo.svg', 'logo.svg (text)']);
  assert.equal((field() as FakeElement).value, SVG_TEXT, 'the text editor, reading the file');
});

test('a media tab restored from storage builds the viewer; its text tab the editor', async () => {
  st.openFile({ kind: 'home' }, SVG, 'logo.svg');
  await sync();
  buttonByLabel(body, 'Edit as text').click();
  await sync();
  st.saveUi();
  st.state.views = [];
  st.loadUi({ reopen: true, run: null });
  assert.deepEqual(
    slot().tabs,
    [
      { kind: 'file', path: SVG },
      { kind: 'file', path: SVG, asText: true },
    ],
    'both views come back',
  );
  pane.dispose();
  pane = EP.editorPane(hd, body);
  await sync();
  assert.ok(field() !== null, 'the active (text) tab is the editor');
  pane.update({ ...slot(), active: 0 }, (st.activeView() as ViewLike).id, 0);
  await settle();
  assert.equal(byClass(body, 'pane-mimg').length, 1, 'the picture tab is the viewer again');
});

test('a stored asText on a plain file is dropped: one file, one view', () => {
  dom.storage.setItem(
    'ai-sm:ui:v2',
    JSON.stringify({
      views: [
        {
          id: 'h',
          root: { kind: 'home' },
          slots: [{ kind: 'editor', tabs: [{ kind: 'file', path: TXT, asText: true }], active: 0 }],
          focused: 0,
        },
      ],
      active: 'h',
    }),
  );
  st.loadUi({ reopen: true, run: null });
  assert.deepEqual(slot().tabs, [{ kind: 'file', path: TXT }]);
});

test('the text tab follows a rename with its unsaved text, and stays the text view', async () => {
  st.openFile({ kind: 'home' }, SVG, 'logo.svg');
  await sync();
  buttonByLabel(body, 'Edit as text').click();
  await sync();
  type(field() as FakeElement, `${SVG_TEXT}<!-- typed -->\n`);
  const moved = '/home/you/art/mark.svg';
  ed.setFile(moved, SVG_TEXT);
  ed.setMedia(moved, { size: 1, mtimeMs: 1, ino: 1 });
  assert.equal(st.retargetFiles(SVG, moved), true);
  assert.deepEqual(slot().tabs, [
    { kind: 'file', path: moved },
    { kind: 'file', path: moved, asText: true },
  ]);
  assert.equal(st.editorDirty(EM.fileTabId(moved, true)), true, 'the typed text moved with it');
  assert.equal(st.editorDirty(EM.fileTabId(SVG, true)), false, 'nothing left on the old id');
  assert.equal(st.editorDirty(EM.fileTabId(moved)), false, 'and the picture tab owns none');
});

test('closing a dirty text tab asks about the FILE by name — never `logo.svg:text`', async () => {
  st.openFile({ kind: 'home' }, SVG, 'logo.svg');
  await sync();
  buttonByLabel(body, 'Edit as text').click();
  await sync();
  type(field() as FakeElement, 'typed\n');
  US.closeTabGuarded((st.activeView() as ViewLike).id, 0, 1);
  const said = dom.body.textContent;
  assert.match(said, /Discard unsaved changes to logo\.svg\?/);
  assert.equal(said.includes(':text'), false);
  buttonByLabel(dom.body, 'Keep editing').click();
  assert.equal(slot().tabs.length, 2, 'Keep editing kept the tab');
});

test('a picture tab is never dirty — closing it asks nothing', async () => {
  st.openFile({ kind: 'home' }, PNG, 'front.png');
  await sync();
  US.closeTabGuarded((st.activeView() as ViewLike).id, 0, 0);
  assert.equal(dom.body.textContent.includes('Discard'), false);
  assert.equal(st.activeView()?.slots.length ?? 0, 0, 'closed at once');
});
