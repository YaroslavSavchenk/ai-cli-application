/**
 * The body of a DIFF pane (Nocturne part B3), and the edges both bodies share,
 * driven through the REAL `web/src/ui/file-pane.ts` on the shared DOM double
 * against the REAL `ui/commit-store.ts` and the commit view's own diff
 * renderer, git a plain fake (`tests/helpers/fs-fixture.ts`; shared setup:
 * `tests/helpers/ui-file-pane-fixture.ts`). Split from
 * `tests/ui/ui-file-pane.test.ts`.
 *
 * What: a diff body is read-only and notifies nothing; a gateway that throws
 * synchronously, or none at all, still builds a pane with an honest sentence;
 * a binary or refused file draws one note; every class a body renders has a
 * rule in app.css (read as source).
 *
 * Why: a diff arriving may never put a terminal through a pane-grid rebuild,
 * and a read-only diff that renders an editable field invites typing into
 * history.
 *
 * NOT claimed (browser work, `.claude/skills/verify-terminal/SKILL.md`):
 * layout, colour, scrolling, the gutter really lining up with the text, and
 * the browser's own `beforeunload` card.
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  byClass,
  descendants,
  textsOf,
  type FakeElement,
  typeInto as type,
} from '../helpers/fake-dom.ts';
import { PROJ, settle } from '../helpers/fs-fixture.ts';
import {
  BINARY_PATH,
  GONE_PATH,
  GONE_TEXT as DIFF_GONE_TEXT,
  HEAD,
  diffOf,
} from '../helpers/commits-fixture.ts';
import { NOT_TEXT_TEXT } from '../helpers/editor-fixture.ts';
import {
  dom,
  st,
  FP,
  STORE,
  ES,
  fx,
  ed,
  PATH,
  OTHER,
  DIFF_PATH,
  mount,
  field,
  saveBtn,
  resetPanes,
} from '../helpers/ui-file-pane-fixture.ts';
import { readAppCss } from '../helpers/tokens-helpers.ts';

beforeEach(() => {
  resetPanes();
});

// ---------------------------------------------------------------------------
// The diff half (part B3)
// ---------------------------------------------------------------------------

test('a diff body is READ-ONLY: diff rows, and no field at all', async () => {
  const body = FP.diffPaneBody(PROJ, HEAD, DIFF_PATH);
  dom.body.replaceChildren(body.root);
  // It says `Loading…` first and asks exactly once, with the root the tab
  // carries and the commit it is about.
  assert.deepEqual(textsOf(body.root, 'diff-note'), ['Loading…']);
  assert.deepEqual(fx.diffCalls, [`${HEAD} ${DIFF_PATH}`]);
  await settle();
  assert.equal(field(body.root), null, 'the changes in a commit are not something to type into');
  assert.equal(byClass(body.root, 'pane-save').length, 0, 'and nothing to save');
  assert.equal(
    byClass(body.root, 'diff-line').length,
    diffOf(HEAD, DIFF_PATH).lines.length,
    'it draws exactly the lines the answer carried',
  );
  // The same renderer, so the pane and the screen it came from cannot disagree.
  assert.equal(byClass(body.root, 'diff-body').length, 1);
  assert.equal(byClass(body.root, 'diff-n').length % 2, 0, 'two gutters per row');
});

test('a diff pane notifies NOTHING — its answer may not put the pane grid through a render', async () => {
  const kinds: string[] = [];
  st.subscribe((k) => kinds.push(k));
  const body = FP.diffPaneBody(PROJ, HEAD, DIFF_PATH);
  dom.body.replaceChildren(body.root);
  await settle();
  assert.ok(byClass(body.root, 'diff-line').length > 0, 'non-vacuity: the answer really landed');
  assert.deepEqual(kinds, [], 'it paints its own node and nothing else');
});

test('a gateway that throws SYNCHRONOUSLY still builds the pane, with the sentence in it', async () => {
  // `encodeURIComponent` throws a URIError on a lone surrogate, and a path is
  // git's verbatim bytes. In a pane that throw would escape the BUILD — the
  // body would never be returned and the tab would show nothing at all.
  STORE.setCommitGateway({
    commit: () => Promise.reject(new Error('not asked here')),
    commitDiff: () => {
      throw new URIError('URI malformed');
    },
  });
  try {
    const body = FP.diffPaneBody(PROJ, HEAD, 'a\ud800b');
    dom.body.replaceChildren(body.root);
    assert.equal(byClass(body.root, 'diff-body').length, 1, 'the pane was built');
    await settle();
    assert.deepEqual(textsOf(body.root, 'diff-note'), ['The app could not reach the service.']);
    assert.equal(byClass(body.root, 'diff-line').length, 0);
  } finally {
    STORE.setCommitGateway(fx.gateway);
  }
});

test('a file body built with no gateway at all still builds, and says the one honest thing', async () => {
  ES.setEditorGateway(null);
  try {
    const root = await mount(PATH);
    assert.deepEqual(textsOf(root, 'pane-fempty'), ['The app could not reach the service.']);
    assert.equal(field(root), null);
  } finally {
    ES.setEditorGateway(ed.gateway);
  }
});

test('a binary file and a refused one each draw ONE note, never a numbered row', async () => {
  const bin = FP.diffPaneBody(PROJ, HEAD, BINARY_PATH);
  dom.body.replaceChildren(bin.root);
  await settle();
  assert.equal(byClass(bin.root, 'diff-line').length, 0);
  assert.deepEqual(textsOf(bin.root, 'diff-note'), ['Binary file.']);

  const gone = FP.diffPaneBody(PROJ, HEAD, GONE_PATH);
  dom.body.replaceChildren(gone.root);
  await settle();
  assert.equal(byClass(gone.root, 'diff-line').length, 0);
  assert.deepEqual(textsOf(gone.root, 'diff-note'), [DIFF_GONE_TEXT], "the server's own sentence");
  assert.equal((byClass(gone.root, 'diff-note')[0] as FakeElement).classList.contains('is-bad'), true);
});

test('every class a file or diff body renders has a rule in app.css', async () => {
  const seen = new Set<string>();
  const collect = (root: FakeElement): void => {
    for (const n of [root, ...descendants(root)]) {
      for (const c of n.className.split(/\s+/)) if (c !== '') seen.add(c);
    }
  };
  const root = await mount(PATH);
  collect(root);
  type(field(root) as FakeElement, 'dirty\n');
  collect(root);
  // The conflict bar and the two refusal inks are classes too.
  ed.setFile(PATH, 'theirs\n');
  saveBtn(root).click();
  await settle();
  collect(root);
  ed.failRead(OTHER, 415, NOT_TEXT_TEXT);
  collect(await mount(OTHER));
  collect(await mount('/home/you/never-existed.ts'));
  const diff = FP.diffPaneBody(PROJ, HEAD, DIFF_PATH);
  collect(diff.root);
  await settle();
  collect(diff.root);
  const bin = FP.diffPaneBody(PROJ, HEAD, BINARY_PATH);
  await settle();
  collect(bin.root);

  assert.ok(seen.size >= 10, `non-vacuity: only ${seen.size} classes were collected`);
  const css = readAppCss();
  const missing = [...seen].filter((c) => !css.includes(`.${c}`)).sort();
  assert.deepEqual(missing, [], `classes with no rule in app.css: ${missing.join(', ')}`);
});
