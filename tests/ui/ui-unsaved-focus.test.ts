/**
 * Where the keyboard goes when the unsaved-text question closes (Nocturne D4,
 * `.claude/plans/PLAN-NOCTURNE.md` § D4) — `web/src/ui/unsaved.ts` through
 * the REAL `web/src/state.ts` and `web/src/ui/util.ts` on the DOM double in
 * `tests/helpers/fake-dom.ts`. The question itself is pinned in
 * `ui-unsaved.test.ts`.
 *
 * How: the fallback `main-shell.ts` injects at boot is a plain element whose
 * focus the test sees; the chip × is a button a state listener removes on the
 * close, the way the pane's synchronous re-render does.
 *
 * Why: Discard closes the chip whose × asked. Handing the keyboard back to
 * that × BEFORE the close ran left it on an element about to vanish — on
 * `<body>`, where no key reaches a PTY. Same for a question asked with
 * nothing focused.
 *
 * NOT claimed: real browser focus after a removal (the double keeps
 * `activeElement` on a removed node); `.claude/skills/verify-terminal/SKILL.md`.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { buttonByLabel, installDom, type FakeElement } from '../helpers/fake-dom.ts';

const dom = installDom();

type EditorTab = { kind: 'file'; path: string };
interface EditorSlot {
  kind: 'editor';
  tabs: EditorTab[];
}
interface StateModule {
  state: { views: unknown[]; activeViewId: string; edits: Map<string, string> };
  newEditorSlot(tabs: EditorTab[]): EditorSlot;
  editorFileId(path: string): string;
  subscribe(fn: () => void): void;
}
interface UnsavedModule {
  closeTabGuarded(viewId: string, slot: number, tab: number, returnFocus?: FakeElement | null): void;
  isDiscardDialogOpen(): boolean;
  discardDialogEscape(): void;
}

const st = (await import(new URL('../../web/src/state.ts', import.meta.url).href)) as unknown as StateModule;
const U = (await import(new URL('../../web/src/ui/unsaved.ts', import.meta.url).href)) as unknown as UnsavedModule;
const UT = (await import(new URL('../../web/src/ui/util.ts', import.meta.url).href)) as {
  setFocusFallback(fn: () => void): void;
};

const A = '/home/you/web/src/Pane.tsx';
const B = '/home/you/web/src/App.tsx';

let terminal: FakeElement;
/** The chip ×; the "re-render" removes it once its tab is gone. */
let chipX: FakeElement;

st.subscribe(() => {
  const slot = (st.state.views[0] as { slots: EditorSlot[] } | undefined)?.slots[0];
  if (slot !== undefined && slot.tabs.length < 2) chipX.remove();
});

beforeEach(() => {
  if (U.isDiscardDialogOpen()) U.discardDialogEscape();
  dom.body.replaceChildren();
  terminal = dom.doc.createElement('textarea');
  chipX = dom.doc.createElement('button');
  dom.body.append(terminal, chipX);
  UT.setFocusFallback(() => terminal.focus());
  st.state.edits = new Map([[st.editorFileId(A), 'typed\n']]);
  st.state.views = [
    {
      id: 'v1',
      root: { kind: 'home' },
      slots: [st.newEditorSlot([{ kind: 'file', path: A }, { kind: 'file', path: B }])],
      focused: 0,
      l3: 'L',
      split: { col: 0.5, row: 0.5 },
    },
  ];
  st.state.activeViewId = 'v1';
});

function answer(label: string): FakeElement {
  return buttonByLabel(dom.body, label);
}

test('Discard closes the chip FIRST, so the keyboard goes to the focused pane, not the vanished ×', () => {
  chipX.focus();
  U.closeTabGuarded('v1', 0, 0, chipX);
  answer('Discard').click();
  assert.equal(chipX.isConnected, false, 'the tab and its × are gone');
  assert.equal(dom.doc.activeElement, terminal, 'the typed keys reach the PTY');
});

test('Keep editing leaves the chip, and the keyboard goes back to its ×', () => {
  chipX.focus();
  U.closeTabGuarded('v1', 0, 0, chipX);
  answer('Keep editing').click();
  assert.equal(chipX.isConnected, true);
  assert.equal(dom.doc.activeElement, chipX);
});

test('D4: a question asked with nothing focused gives the keyboard to the focused pane', () => {
  dom.doc.activeElement = dom.body;
  U.closeTabGuarded('v1', 0, 0, dom.body);
  answer('Keep editing').click();
  assert.equal(dom.doc.activeElement, terminal, 'not <body>');
});
