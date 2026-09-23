/**
 * `web/src/ui/settings.ts` — the Settings panel's Preferences page (live
 * since Nocturne B6) and its API key rows (B5): saved / set outside the app /
 * nothing, Save, Remove, Show, the server's refusal under the row, and
 * `openSettings()` landing on a focused key field. Split out of
 * `ui-settings-panel.test.ts`.
 *
 * Seam: the REAL module against the DOM double in `tests/helpers/fake-dom.ts`,
 * booted once per file by `tests/helpers/ui-settings-panel-fixture.ts` (the real
 * `ui/util.ts`, `ui/launch-args.ts`, `ui/statusline-model.ts`,
 * `ui/term-colours.ts` and `ui/term-colours-model.ts` take part; only the
 * non-pure imports are stubbed — see the fixture). Tests in one file share the
 * one panel and run in order.
 *
 * Why it matters: a key field that keeps a typed key across an open, or stays
 * revealed, leaks a secret on screen; a row that claims a key the server no
 * longer has sends the user to a failing launch.
 *
 * NOT claimed (browser work, `.claude/skills/verify-terminal/SKILL.md`):
 * layout, colour rendering, that a native colour swatch opens a picker,
 * hit-testing, screen-reader output.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { byClass, dispatch, textsOf, type FakeElement } from '../helpers/fake-dom.ts';
import {
  H,
  S,
  dom,
  panel,
  panelOf,
  reopen,
  settle,
  tab,
} from '../helpers/ui-settings-panel-fixture.ts';

// ===========================================================================
// Preferences — every block live since part B6
// ===========================================================================

test('the Preferences page: live key rows for the three keyed tools, Tools and Defaults under them', async () => {
  await reopen();
  tab('Preferences').click();
  const page = panelOf('prefs');
  // The key rows first (no tile for the custom-command card, which has no key
  // to store), then one Tools row per card, carrying the same tiles (B6).
  // B12: the tiles hold the tools' real logos, no letters.
  assert.deepEqual(
    byClass(page, 'sg-mark').map((m) => [m.textContent, (m.children[0] as FakeElement | undefined)?.getAttribute('data-tool')]),
    [
      ['', 'claude'], ['', 'codex'], ['', 'gemini'], ['', 'grok'], ['', 'terminal'],
      ['', 'claude'], ['', 'codex'], ['', 'gemini'], ['', 'grok'], ['', 'terminal'], ['', 'command'],
    ],
  );
  assert.deepEqual(
    byClass(page, 'sg-prow').map((r) => byClass(r, 'sg-rowlb')[0]?.textContent),
    ['Claude Code', 'Codex', 'Gemini CLI', 'Grok', 'Terminal'],
  );
  assert.deepEqual(textsOf(page, 'sg-prowkey'), [
    // Claude Code does need authentication, just not one this app must store.
    'Uses your Claude login. A saved key is used instead.',
    // Codex gets NO field: a key alone does not authenticate it.
    'Signs in inside the terminal',
    'Needs an API key, or a sign-in inside the terminal.',
    'Needs an API key, or a sign-in inside the terminal.',
    'No key needed',
  ]);
  assert.equal(byClass(page, 'sg-keyin').length, 3, 'a key field only where this app can store one');
  assert.deepEqual(
    byClass(page, 'sg-keyin').map((i) => i.placeholder),
    ['Paste API key', 'Paste API key', 'Paste API key'],
  );
  // A credential field: masked, never offered as a saved login, no `name` for
  // an autofill to match — and LIVE since part B5.
  for (const i of byClass(page, 'sg-keyin')) {
    assert.equal(i.type, 'password');
    assert.equal(i.autocomplete, 'new-password');
    assert.equal(i.getAttribute('name'), null);
    assert.equal(i.disabled, false);
  }
  // Three verbs per row; Save and Remove start off because there is nothing
  // to save and nothing stored.
  assert.deepEqual(textsOf(page, 'sg-smallbtn'), [
    'Show', 'Save', 'Remove',
    'Show', 'Save', 'Remove',
    'Show', 'Save', 'Remove',
  ]);
  for (const b of byClass(page, 'sg-smallbtn')) {
    assert.equal(b.disabled, b.textContent !== 'Show', b.textContent);
  }
  // Three headed blocks since B6, all live, and no honesty line left on the
  // page: nothing here is an example any more.
  assert.deepEqual(textsOf(page, 'sg-sub'), ['API keys', 'Tools', 'Defaults']);
  assert.deepEqual(
    byClass(page, 'sg-row').map((r) => byClass(r, 'sg-rowlb')[0]?.textContent),
    [
      'Claude Code',
      'Codex',
      'Gemini CLI',
      'Grok',
      'Terminal',
      'Other',
      'Reopen tabs on start',
      'Confirm before ending a session',
      'Follow output',
      // Nocturne C1: the peek mascot's switch, the Defaults block's fourth row.
      'Peek mascot',
    ],
  );
  for (const c of byClass(page, 'sg-row')) assert.equal(c.disabled, false, 'live since part B6');
  assert.deepEqual(textsOf(page, 'sg-note'), [], 'the placeholder line went with the mock');
});

// ---- the key rows, live (Nocturne B5) --------------------------------------

/** One key row by the tool's product name. */
function keyRow(label: string): FakeElement {
  const page = panelOf('prefs');
  const hit = byClass(page, 'sg-prow').find(
    (r) => byClass(r, 'sg-rowlb')[0]?.textContent === label,
  );
  assert.ok(hit !== undefined, `no row "${label}"`);
  return hit;
}
const keyField = (label: string): FakeElement => byClass(keyRow(label), 'sg-keyin')[0] as FakeElement;
const keyBtn = (label: string, verb: string): FakeElement => {
  const hit = byClass(keyRow(label), 'sg-smallbtn').find((b) => b.textContent === verb);
  assert.ok(hit !== undefined, `no "${verb}" on the ${label} row`);
  return hit;
};
const keyState = (label: string): string => byClass(keyRow(label), 'sg-keystate')[0]?.textContent ?? '';
const keyErrText = (label: string): FakeElement => byClass(keyRow(label), 'sg-keyerr')[0] as FakeElement;

/** Type into a field the way a user does (settings.ts listens for `input`). */
function typeKey(label: string, text: string): void {
  const f = keyField(label);
  f.value = text;
  dispatch(f, 'input');
}

test('B5 keys: the page reads saved / set-outside-the-app / nothing from the server, on open', async () => {
  H.keys = {
    saved: { claude: false, gemini: true, grok: false },
    env: { claude: true, gemini: false, grok: false },
  };
  await reopen();
  tab('Preferences').click();
  assert.equal(H.keyCalls > 0, true, 'the key status is re-read on open');
  assert.equal(keyState('Gemini CLI'), 'Saved');
  assert.equal(keyState('Claude Code'), 'Set outside the app', 'the environment already carries one');
  assert.equal(keyState('Grok'), '', 'no key, no claim');
  // Remove can only be used where something is actually stored here.
  assert.equal(keyBtn('Gemini CLI', 'Remove').disabled, false);
  assert.equal(keyBtn('Claude Code', 'Remove').disabled, true, 'the app cannot remove an environment one');
  assert.equal(keyBtn('Grok', 'Remove').disabled, true);
});

test('B5 keys: Save sends the key once, clears the field, and marks the row Saved', async () => {
  H.keys = {
    saved: { claude: false, gemini: false, grok: false },
    env: { claude: false, gemini: false, grok: false },
  };
  await reopen();
  tab('Preferences').click();
  H.keySaves.length = 0;
  assert.equal(keyBtn('Grok', 'Save').disabled, true, 'nothing to save yet');
  typeKey('Grok', '  xai-secret-value  ');
  assert.equal(keyBtn('Grok', 'Save').disabled, false);
  keyBtn('Grok', 'Save').click();
  await settle();
  assert.deepEqual(H.keySaves, [{ tool: 'grok', key: 'xai-secret-value' }], 'trimmed, sent once');
  assert.equal(keyField('Grok').value, '', 'the field is cleared in the same turn');
  assert.equal(keyState('Grok'), 'Saved');
  assert.equal(keyBtn('Grok', 'Remove').disabled, false);
  assert.equal(keyBtn('Grok', 'Save').disabled, true, 'and there is nothing left to save');
  // The value never reaches the log — only which tool was written.
  const joined = H.logs.join('\n');
  assert.equal(joined.includes('xai-secret-value'), false, 'the key must never be logged');
  assert.ok(joined.includes('key saved for grok'));
});

test('B5 keys: Remove forgets the stored key and the row stops claiming one', async () => {
  H.keys = {
    saved: { claude: false, gemini: true, grok: false },
    env: { claude: false, gemini: false, grok: false },
  };
  await reopen();
  tab('Preferences').click();
  H.keyDeletes.length = 0;
  keyBtn('Gemini CLI', 'Remove').click();
  await settle();
  assert.deepEqual(H.keyDeletes, ['gemini']);
  assert.equal(keyState('Gemini CLI'), '');
  assert.equal(keyBtn('Gemini CLI', 'Remove').disabled, true);
});

test('B5 keys: Remove leaves a key set outside the app, and says it is still there', async () => {
  H.keys = {
    saved: { claude: false, gemini: true, grok: false },
    env: { claude: false, gemini: true, grok: false },
  };
  await reopen();
  tab('Preferences').click();
  assert.equal(keyState('Gemini CLI'), 'Saved', 'the stored one wins the line');
  keyBtn('Gemini CLI', 'Remove').click();
  await settle();
  assert.equal(keyState('Gemini CLI'), 'Set outside the app', 'the environment one is not ours to remove');
});

test('B5 keys: Show reveals what is being typed and puts it back', async () => {
  await reopen();
  tab('Preferences').click();
  const f = keyField('Grok');
  assert.equal(f.type, 'password');
  assert.equal(keyBtn('Grok', 'Show').getAttribute('aria-pressed'), 'false');
  keyBtn('Grok', 'Show').click();
  assert.equal(f.type, 'text');
  assert.equal(keyBtn('Grok', 'Hide').getAttribute('aria-pressed'), 'true');
  keyBtn('Grok', 'Hide').click();
  assert.equal(f.type, 'password');
  assert.equal(keyBtn('Grok', 'Show').textContent, 'Show');
});

test('B5 keys: a refusal from the server is shown under the row, in its own words', async () => {
  await reopen();
  tab('Preferences').click();
  assert.equal(keyErrText('Grok').hidden, true, 'nothing said until something goes wrong');
  H.nextKeyError = new Error('That does not look like an API key.');
  typeKey('Grok', 'nope');
  keyBtn('Grok', 'Save').click();
  await settle();
  assert.equal(keyErrText('Grok').hidden, false);
  assert.equal(keyErrText('Grok').textContent, 'That does not look like an API key.');
  assert.equal(keyState('Grok'), '', 'and nothing claims to be saved');
  assert.equal(keyField('Grok').value, 'nope', 'the typed value is left to be corrected');
  assert.equal(keyBtn('Grok', 'Save').disabled, false, 'and can be tried again');
  // A later success clears the sentence.
  typeKey('Grok', 'xai-good');
  keyBtn('Grok', 'Save').click();
  await settle();
  assert.equal(keyErrText('Grok').hidden, true);
  assert.equal(keyState('Grok'), 'Saved');
});

test('B5 keys: a failure with no sentence of its own falls back to plain words, never a status code', async () => {
  await reopen();
  tab('Preferences').click();
  // `request()` throws `HTTP 413` when the server's body carried no sentence —
  // a status code is not something to read.
  H.nextKeyError = new Error('HTTP 413');
  typeKey('Grok', 'x'.repeat(50));
  keyBtn('Grok', 'Save').click();
  await settle();
  assert.equal(keyErrText('Grok').textContent, 'That key was not saved.');
  H.keys = { saved: { claude: false, gemini: false, grok: true }, env: { claude: false, gemini: false, grok: false } };
  await reopen();
  tab('Preferences').click();
  H.nextKeyError = new Error('HTTP 500');
  keyBtn('Grok', 'Remove').click();
  await settle();
  assert.equal(keyErrText('Grok').textContent, 'That key was not removed.');
});

test('B5 keys: a field never carries a typed key across an open, and is never shown revealed', async () => {
  await reopen();
  tab('Preferences').click();
  typeKey('Grok', 'half-typed-secret');
  keyBtn('Grok', 'Show').click();
  panel.close();
  await reopen();
  tab('Preferences').click();
  assert.equal(keyField('Grok').value, '', 'the credential does not survive the close');
  assert.equal(keyField('Grok').type, 'password', 'and it is masked again');
  assert.equal(keyBtn('Grok', 'Show').textContent, 'Show');
});

test('B5 keys: closing the panel drops a typed-but-unsaved key immediately, not at the next open', async () => {
  // Between the close and the next open the panel lives on in the page. A
  // credential the user typed and abandoned must not sit in the input's value
  // for that whole time — it is dropped in the closing gesture itself.
  await reopen();
  tab('Preferences').click();
  typeKey('Grok', 'half-typed-secret');
  keyBtn('Grok', 'Show').click();
  panel.close();
  assert.equal(keyField('Grok').value, '', 'gone as the panel closes');
  assert.equal(keyField('Grok').type, 'password', 'and masked again');
  assert.equal(keyBtn('Grok', 'Show').textContent, 'Show');
  assert.equal(keyBtn('Grok', 'Save').disabled, true, 'nothing left to save');
});

test('B5 keys: openSettings() lands on Preferences with one field focused (the dialog’s Add key)', async () => {
  panel.close();
  S.openSettings({ page: 'prefs', focusKey: 'grok' });
  await settle();
  assert.equal(panel.isOpen(), true);
  assert.equal(panelOf('prefs').hidden, false);
  assert.equal(dom.doc.activeElement, keyField('Grok'), 'the keyboard lands ON the field');
  // Already open on another page: a named destination still gets the user there.
  tab('Status bar').click();
  S.openSettings({ page: 'prefs', focusKey: 'gemini' });
  await settle();
  assert.equal(panelOf('prefs').hidden, false);
  assert.equal(dom.doc.activeElement, keyField('Gemini CLI'));
  // A plain open is unchanged: first page, keyboard in the nav.
  panel.close();
  panel.open();
  await settle();
  assert.equal(panelOf('status').hidden, false);
  assert.equal(dom.doc.activeElement, tab('Status bar'));
});
