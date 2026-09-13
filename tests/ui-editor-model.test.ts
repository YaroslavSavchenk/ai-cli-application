/**
 * `web/src/ui/editor-model.ts` — the editor tab strip's rules (Nocturne A6),
 * with no DOM: the id scheme that decides a tab's KIND, dedupe on open, which
 * tab is active after a close, the line gutter, and the Save label.
 *
 * WHY. Every one of these is a rule the user feels and no screenshot shows:
 * a file opened twice must not stack two tabs, closing the active tab must
 * land somewhere deterministic, and a gutter that disagrees with the text by
 * one line makes the whole column look broken.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

interface Tab {
  id: string;
  label: string;
  path: string;
  hash?: string;
}
interface State {
  tabs: Tab[];
  active: string | null;
}

const E = (await import(new URL('../web/src/ui/editor-model.ts', import.meta.url).href)) as {
  tabKind(id: string): 'file' | 'diff';
  fileTabId(path: string): string;
  diffTabId(hash: string, path: string): string;
  openTab(s: State, t: Tab): State;
  closeTab(s: State, id: string): State;
  setActive(s: State, id: string): State;
  activeTab(s: State): Tab | null;
  gutterText(text: string): string;
  saveLabel(dirty: boolean): string;
};

const EMPTY: State = { tabs: [], active: null };
const file = (path: string): Tab => ({
  id: E.fileTabId(path),
  label: path.split('/').pop() as string,
  path,
});

// ---------------------------------------------------------------------------
// The id IS the kind
// ---------------------------------------------------------------------------

test('an id says what the tab is: a file is editable, a diff is read-only', () => {
  assert.equal(E.fileTabId('web/src/Pane.tsx'), 'f:web/src/Pane.tsx');
  assert.equal(E.diffTabId('474d891', 'server/ws.ts'), 'd:474d891:server/ws.ts');
  assert.equal(E.tabKind('f:web/src/Pane.tsx'), 'file');
  assert.equal(E.tabKind('d:474d891:server/ws.ts'), 'diff');
  assert.equal(E.tabKind('web/src/Pane.tsx'), 'file', 'anything unknown reads as a file');
});

test('the same file in two commits gives two different diff tabs', () => {
  assert.notEqual(E.diffTabId('474d891', 'server/ws.ts'), E.diffTabId('55c9be7', 'server/ws.ts'));
  assert.notEqual(E.diffTabId('474d891', 'server/ws.ts'), E.fileTabId('server/ws.ts'));
});

// ---------------------------------------------------------------------------
// open / close / raise
// ---------------------------------------------------------------------------

test('opening a tab appends it and makes it the active one', () => {
  const a = E.openTab(EMPTY, file('a.ts'));
  assert.deepEqual(a.tabs.map((t) => t.id), ['f:a.ts']);
  assert.equal(a.active, 'f:a.ts');
  const b = E.openTab(a, file('b.ts'));
  assert.deepEqual(b.tabs.map((t) => t.id), ['f:a.ts', 'f:b.ts']);
  assert.equal(b.active, 'f:b.ts', 'opening a file the user cannot see would be a click that did nothing');
});

test('opening the same id twice raises the tab instead of stacking a second one', () => {
  const two = E.openTab(E.openTab(EMPTY, file('a.ts')), file('b.ts'));
  const again = E.openTab(two, file('a.ts'));
  assert.equal(again.tabs.length, 2, 'the id is the dedupe key');
  assert.equal(again.active, 'f:a.ts');
  assert.deepEqual(again.tabs.map((t) => t.id), ['f:a.ts', 'f:b.ts'], 'and the order is untouched');
});

test('closing the ACTIVE tab lands on the first tab left', () => {
  const three = ['a.ts', 'b.ts', 'c.ts'].reduce((s, p) => E.openTab(s, file(p)), EMPTY);
  assert.equal(three.active, 'f:c.ts');
  const closed = E.closeTab(three, 'f:c.ts');
  assert.deepEqual(closed.tabs.map((t) => t.id), ['f:a.ts', 'f:b.ts']);
  assert.equal(closed.active, 'f:a.ts');
});

test('closing a tab that is NOT active leaves the active one alone', () => {
  const three = ['a.ts', 'b.ts', 'c.ts'].reduce((s, p) => E.openTab(s, file(p)), EMPTY);
  const closed = E.closeTab(three, 'f:a.ts');
  assert.equal(closed.active, 'f:c.ts');
  assert.deepEqual(closed.tabs.map((t) => t.id), ['f:b.ts', 'f:c.ts']);
});

test('closing the last tab empties the editor — which is what hides the column', () => {
  const one = E.openTab(EMPTY, file('a.ts'));
  const gone = E.closeTab(one, 'f:a.ts');
  assert.deepEqual(gone.tabs, []);
  assert.equal(gone.active, null);
});

test('closing an id that is not open changes nothing at all (same object back)', () => {
  const one = E.openTab(EMPTY, file('a.ts'));
  assert.equal(E.closeTab(one, 'f:nope.ts'), one);
});

test('raising works only for a tab that exists — an unknown id never blanks the body', () => {
  const two = E.openTab(E.openTab(EMPTY, file('a.ts')), file('b.ts'));
  assert.equal(E.setActive(two, 'f:a.ts').active, 'f:a.ts');
  assert.equal(E.setActive(two, 'f:ghost.ts').active, 'f:b.ts');
  assert.equal(E.activeTab(two)?.path, 'b.ts');
  assert.equal(E.activeTab(EMPTY), null);
});

test('a diff tab carries its commit, a file tab carries none', () => {
  const d: Tab = { id: E.diffTabId('474d891', 'server/ws.ts'), label: 'ws.ts', path: 'server/ws.ts', hash: '474d891' };
  const s = E.openTab(E.openTab(EMPTY, file('a.ts')), d);
  assert.equal(E.activeTab(s)?.hash, '474d891');
  assert.equal(E.activeTab(E.setActive(s, 'f:a.ts'))?.hash, undefined);
});

// ---------------------------------------------------------------------------
// The gutter and the Save label
// ---------------------------------------------------------------------------

test('the gutter has exactly one number per line of the text', () => {
  assert.equal(E.gutterText('a\nb\nc'), '1\n2\n3');
  assert.equal(E.gutterText(''), '1', 'an empty file still has a first line');
  // A trailing newline is a real (empty) last line in every editor.
  assert.equal(E.gutterText('a\n'), '1\n2');
  const many = E.gutterText(Array.from({ length: 120 }, (_, i) => `line ${i}`).join('\n'));
  assert.equal(many.split('\n').length, 120);
  assert.equal(many.split('\n').pop(), '120');
});

test('the Save button is a statement when there is nothing to write', () => {
  assert.equal(E.saveLabel(true), 'Save');
  assert.equal(E.saveLabel(false), 'Saved');
});

// ---------------------------------------------------------------------------
// Gate additions (test-engineer, A6): the edges the contract names and the
// tests above leave open — which tab OBJECT a dedupe keeps, what an unknown id
// does to the state object itself, and the line endings a real file arrives in.
// ---------------------------------------------------------------------------

test('a dedupe keeps the tab that is already open, not the one handed in again', () => {
  // Same id, different label and a hash: the open tab wins. Anything else would
  // let a second click relabel a tab under the user's hands — and would turn a
  // file tab into a diff tab while its id still says `f:`.
  const first = E.openTab(EMPTY, file('a.ts'));
  const again = E.openTab(first, {
    id: 'f:a.ts',
    label: 'RENAMED.ts',
    path: 'somewhere/else/a.ts',
    hash: '474d891',
  });
  assert.equal(again.tabs.length, 1);
  assert.deepEqual(again.tabs[0], { id: 'f:a.ts', label: 'a.ts', path: 'a.ts' });
  assert.equal(again.tabs[0]?.hash, undefined, 'a file tab never grows a commit');
  assert.equal(again.active, 'f:a.ts');
});

test('a dedupe keeps the POSITION: the raised tab does not jump to the end', () => {
  const three = ['a.ts', 'b.ts', 'c.ts'].reduce((s, p) => E.openTab(s, file(p)), EMPTY);
  const again = E.openTab(three, file('a.ts'));
  assert.deepEqual(again.tabs.map((t) => t.id), ['f:a.ts', 'f:b.ts', 'f:c.ts']);
  assert.equal(again.active, 'f:a.ts', 'raised, not moved');
});

test('raising an unknown id hands back the SAME state object (nothing to notify about)', () => {
  const two = E.openTab(E.openTab(EMPTY, file('a.ts')), file('b.ts'));
  assert.equal(E.setActive(two, 'f:ghost.ts'), two, 'state.ts leans on this to skip the notify');
  assert.equal(E.setActive(two, 'd:474d891:a.ts'), two);
});

test('closing leaves a NEW list and never mutates the old one', () => {
  const two = E.openTab(E.openTab(EMPTY, file('a.ts')), file('b.ts'));
  const closed = E.closeTab(two, 'f:b.ts');
  assert.deepEqual(two.tabs.map((t) => t.id), ['f:a.ts', 'f:b.ts'], 'the old state still holds both');
  assert.equal(two.active, 'f:b.ts');
  assert.deepEqual(closed.tabs.map((t) => t.id), ['f:a.ts']);
});

test('the gutter counts LINES, so a Windows file is not numbered twice', () => {
  // A file read on this machine can arrive CRLF-terminated; `\r` is part of the
  // line, not a second one. (The textarea shows it the same way.)
  assert.equal(E.gutterText('a\r\nb\r\nc'), '1\n2\n3');
  assert.equal(E.gutterText('a\r\n'), '1\n2', 'a trailing CRLF is still one empty last line');
  assert.equal(E.gutterText('\n'), '1\n2');
  assert.equal(E.gutterText('\n\n\n'), '1\n2\n3\n4');
  assert.equal(E.gutterText('one line, no ending'), '1');
});
