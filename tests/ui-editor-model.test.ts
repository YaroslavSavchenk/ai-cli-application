/**
 * `web/src/ui/editor-model.ts` — the rules a file shown in a PANE hangs on
 * (Nocturne A6, pruned by A10), with no DOM: the id scheme that decides a
 * pane's KIND, the line gutter, and the Save label.
 *
 * WHY. Every one of these is a rule the user feels and no screenshot shows: a
 * gutter that disagrees with the text by one line makes the whole pane look
 * broken, and the id scheme is what keeps one file's unsaved text in ONE place
 * while two panes show it.
 *
 * GONE with A10 (user decision 2026-09-15): the editor column's tab strip.
 * `EditorState`/`openTab`/`closeTab`/`setActive`/`activeTab` were deleted —
 * a file is a pane now, and `state.ts` owns which panes a tab holds
 * (`tests/ui-state.test.ts`). What survived is what a PANE still needs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

type EditorTab = import('../web/src/state.ts').EditorTab;

const E = (await import(new URL('../web/src/ui/editor-model.ts', import.meta.url).href)) as {
  tabKind(id: string): 'file' | 'diff';
  fileTabId(path: string): string;
  diffTabId(hash: string, path: string): string;
  tabIdOf(t: EditorTab): string;
  gutterText(text: string): string;
  saveLabel(dirty: boolean): string;
};

/**
 * The folder a diff tab is read from (part B3). It is part of the TAB and not
 * part of its id: the same commit and the same path are the same tab whatever
 * folder the request was made from.
 */
const REPO = '/home/you/projects/app';

// ---------------------------------------------------------------------------
// The id IS the kind
// ---------------------------------------------------------------------------

test('an id says what the pane is: a file is editable, a diff is read-only', () => {
  assert.equal(E.fileTabId('web/src/Pane.tsx'), 'f:web/src/Pane.tsx');
  assert.equal(E.diffTabId('474d891', 'server/ws.ts'), 'd:474d891:server/ws.ts');
  assert.equal(E.tabKind('f:web/src/Pane.tsx'), 'file');
  assert.equal(E.tabKind('d:474d891:server/ws.ts'), 'diff');
  assert.equal(E.tabKind('web/src/Pane.tsx'), 'file', 'anything unknown reads as a file');
});

test('the same file in two commits gives two different diff panes', () => {
  assert.notEqual(E.diffTabId('474d891', 'server/ws.ts'), E.diffTabId('55c9be7', 'server/ws.ts'));
  assert.notEqual(E.diffTabId('474d891', 'server/ws.ts'), E.fileTabId('server/ws.ts'));
});

test('the SAME file always gives the same id — which is what makes two panes share one text', () => {
  // `state.edits` is keyed by this. Two panes on one path must land on one
  // entry, or typing in the left pane would leave the right one showing the
  // old text and Save would write whichever pane the user happened to press.
  assert.equal(E.fileTabId('a/b/c.ts'), E.fileTabId('a/b/c.ts'));
  assert.notEqual(E.fileTabId('a/b/c.ts'), E.fileTabId('a/b/c.tsx'));
  // A path that looks like an id is still just a path — the prefix is added,
  // never assumed.
  assert.equal(E.fileTabId('f:weird'), 'f:f:weird');
  assert.equal(E.tabKind(E.fileTabId('f:weird')), 'file');
});

test('tabIdOf is BYTE-IDENTICAL to fileTabId / diffTabId — one spelling of the edits key', () => {
  // A10b: every caller holds an `EditorTab` now, so the id has to come from one
  // place. A second spelling here would give one pane's text a key no other
  // pane looks under — the alias trap, in the map the user's typing lives in.
  for (const path of ['web/src/main.ts', 'LICENSE', 'a b/c:d.ts', '', 'f:weird']) {
    assert.equal(E.tabIdOf({ kind: 'file', path }), E.fileTabId(path), `file: ${path}`);
    assert.equal(E.tabKind(E.tabIdOf({ kind: 'file', path })), 'file');
  }
  for (const [hash, path] of [
    ['474d891', 'server/ws.ts'],
    ['55c9be7', 'a/b.ts'],
  ] as const) {
    assert.equal(E.tabIdOf({ kind: 'diff', hash, path, root: REPO }), E.diffTabId(hash, path));
    assert.equal(E.tabKind(E.tabIdOf({ kind: 'diff', hash, path, root: REPO })), 'diff');
  }
  // The same file as a file tab and as a diff tab are two different tabs.
  assert.notEqual(
    E.tabIdOf({ kind: 'file', path: 'server/ws.ts' }),
    E.tabIdOf({ kind: 'diff', hash: '474d891', path: 'server/ws.ts', root: REPO }),
  );
});

test('the editor-column API is gone: a file is a pane, not a tab in a column', () => {
  // A10 (user decision 2026-09-15). Pinned because the deletion is the point:
  // a second tab strip inside the pane area is exactly what this part removed.
  for (const name of ['openTab', 'closeTab', 'setActive', 'activeTab']) {
    assert.equal(
      (E as unknown as Record<string, unknown>)[name],
      undefined,
      `${name} must not come back`,
    );
  }
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

test('the gutter counts LINES, so a Windows file is not numbered twice', () => {
  // A file read on this machine can arrive CRLF-terminated; `\r` is part of the
  // line, not a second one. (The textarea shows it the same way.)
  assert.equal(E.gutterText('a\r\nb\r\nc'), '1\n2\n3');
  assert.equal(E.gutterText('a\r\n'), '1\n2', 'a trailing CRLF is still one empty last line');
  assert.equal(E.gutterText('\n'), '1\n2');
  assert.equal(E.gutterText('\n\n\n'), '1\n2\n3\n4');
  assert.equal(E.gutterText('one line, no ending'), '1');
});
