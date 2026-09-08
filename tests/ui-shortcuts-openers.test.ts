/**
 * The ways INTO the shortcuts overlay, and the settings panel's excerpt of it
 * (2026-09-08). The overlay was already correct and already listed the paste
 * chord — it was simply unreachable in practice: the only openers were the bare
 * `?` key, `ctrl+alt+/` and a 10.5px statusline hint, so a user who met
 * `ctrl+shift+v` in the wild had nowhere to ask why. This file pins the two new
 * answers to that:
 *
 *   1. a topbar `?` button, in the same icon-only idiom as the ⚙ gear beside it,
 *      wired to the SAME overlay instance the `?` key toggles (one open/close —
 *      a second `initShortcuts()` would mean two scrims and two states);
 *   2. a KEYS section in the settings panel whose rows are an EXCERPT of the
 *      overlay's table, plus an `all shortcuts` text button that opens it.
 *
 * WHY A SOURCE SCAN. There is no DOM in this test runner (see
 * `tests/ui-focus-trap.test.ts` for the doubles idiom that reaches the few
 * functions which can run headless); `buildShell()` in main.ts constructs the
 * topbar directly against `document`. So the shape of the wiring is checked in
 * the source, and every check below is paired with a non-vacuity assertion so a
 * regex that quietly matches nothing cannot make the file pass.
 *
 * The load-bearing half is the LAST test: the settings excerpt's chords are
 * compared against the real `isPasteChord` / `isLinkActivation` predicates, so
 * the panel cannot promise a key the app does not take (the same rule
 * `tests/ui-shortcuts-table.test.ts` enforces for the overlay itself).
 *
 * NOT claimed here: that the button is visible, sized, or in the right place on
 * screen. That stays manual (`.claude/skills/verify-terminal/SKILL.md`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isLinkActivation, isPasteChord } from '../web/src/ui/keys.ts';
import type { KeyChord } from '../web/src/ui/keys.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p: string[]): string => readFileSync(join(REPO_ROOT, ...p), 'utf8');

const MAIN = read('web', 'src', 'main.ts');
const SETTINGS = read('web', 'src', 'ui', 'settings.ts');
const SHORTCUTS = read('web', 'src', 'ui', 'shortcuts.ts');

/** Count of non-overlapping occurrences of a plain substring. */
function count(haystack: string, needle: string): number {
  let n = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) n += 1;
  return n;
}

// ---------------------------------------------------------------------------

test('the scan actually reads the modules (non-vacuity: the three files and their landmarks are found)', () => {
  // Without this, every assertion below could be passing over an empty string.
  for (const [name, src] of [
    ['main.ts', MAIN],
    ['ui/settings.ts', SETTINGS],
    ['ui/shortcuts.ts', SHORTCUTS],
  ] as const) {
    assert.ok(src.length > 1000, `${name} looks empty (${src.length} chars)`);
  }
  assert.ok(MAIN.includes('function buildShell'), 'main.ts must still build the shell here');
  assert.ok(MAIN.includes("button('tb-btn is-icon', '')"), 'the icon-only topbar idiom must still exist');
  assert.ok(SETTINGS.includes('export function initSettings'), 'settings.ts must still export its init');
  assert.ok(SHORTCUTS.includes('export function initShortcuts'), 'shortcuts.ts must still export its init');
});

test('the topbar has a `?` button in the gear idiom, and it opens the shortcuts overlay', () => {
  assert.ok(MAIN.includes('const helpBtn = '), 'the topbar `?` button must exist');
  // Same class as the ⚙ Settings button: icon-only 28px, not a text button.
  assert.match(MAIN, /const helpBtn = button\('tb-btn is-icon', ''\);/);
  // The glyph is decorative; the accessible name comes from aria-label.
  assert.match(MAIN, /const qmark = el\('span', '', '\?'\);\n\s*qmark\.setAttribute\('aria-hidden', 'true'\);/);
  assert.match(MAIN, /helpBtn\.setAttribute\('aria-label', 'Keyboard shortcuts'\);/);
  assert.match(MAIN, /helpBtn\.title = 'keyboard shortcuts';/);
  assert.match(MAIN, /helpBtn\.setAttribute\('aria-haspopup', 'dialog'\);/);
  // Wired to the overlay, not to a private copy of it.
  assert.match(MAIN, /helpBtn\.addEventListener\('click', \(\) => shortcuts\.toggle\(\)\);/);
});

test('the `?` button sits in the topbar, immediately after the gear', () => {
  const append = /topbar\.append\(([\s\S]*?)\);/.exec(MAIN);
  assert.notEqual(append, null, 'main.ts must still append the topbar children in one call');
  const children = (append?.[1] ?? '')
    .split(',')
    .map((c) => c.trim())
    .filter((c) => c !== '');
  assert.ok(children.includes('settingsBtn'), `the gear must be in the topbar: ${children.join(' ')}`);
  assert.equal(
    children[children.indexOf('settingsBtn') + 1],
    'helpBtn',
    `the ? button must follow the gear: ${children.join(' ')}`,
  );
});

test('there is exactly ONE overlay instance — the key, the button, the statusline and settings share it', () => {
  assert.ok(MAIN.includes("import { initShortcuts } from './ui/shortcuts.ts';"), 'the import must still be there');
  assert.equal(count(MAIN, 'initShortcuts('), 1, 'expected exactly one construction of the overlay');
  assert.equal(count(MAIN, 'const shortcuts = initShortcuts(modalHost);'), 1);
  // The three openers main.ts owns, each on the same handle.
  assert.ok(MAIN.includes('helpBtn.addEventListener(\'click\', () => shortcuts.toggle());'));
  assert.ok(MAIN.includes('openShortcuts: () => shortcuts.toggle(),'), 'the statusline hint must still open it');
  assert.ok(
    MAIN.includes('{ openShortcuts: () => shortcuts.toggle() }'),
    'the settings panel must be handed the same opener',
  );
  // The bare `?` key path (outside editable targets) must keep working.
  assert.match(MAIN, /e\.key === '\?'[\s\S]{0,200}?shortcuts\.toggle\(\);/);
});

test('the settings panel opens the same overlay through its injected dependency', () => {
  assert.match(SETTINGS, /export interface SettingsDeps \{[\s\S]*?openShortcuts\(\): void;[\s\S]*?\}/);
  assert.match(SETTINGS, /deps: SettingsDeps,/);
  assert.match(SETTINGS, /button\('btn-link', 'all shortcuts', \(\) => deps\.openShortcuts\(\)\)/);
  // A dialog opener says so, like every other one in this app.
  assert.match(SETTINGS, /allKeysBtn\.setAttribute\('aria-haspopup', 'dialog'\);/);
  // The panel must not build a second overlay of its own.
  assert.equal(count(SETTINGS, 'initShortcuts'), 0);
});

test('the settings KEYS section states both gestures, and nothing that is not in the overlay', () => {
  const block = /const KEY_ROWS: KeyRow\[\] = \[([\s\S]*?)\n\];/.exec(SETTINGS);
  assert.notEqual(block, null, 'settings.ts must still declare KEY_ROWS');
  const src = block?.[1] ?? '';
  const rows = [...src.matchAll(/\{([^}]*)\}/g)].map((m) => m[1] as string);
  assert.equal(rows.length, 2, `expected the two-row excerpt, parsed ${rows.length}`);

  const whats = rows.map((r) => (/what:\s*'([^']*)'/.exec(r) ?? [])[1]);
  assert.deepEqual(whats, ['paste into a terminal', 'open a link printed in a terminal']);

  // Row 1: chords, rendered as <kbd> chips. Row 2: a mouse sentence, never a chip.
  const chords = [...(rows[0] as string).matchAll(/'([^']+)'/g)].map((m) => m[1] as string).slice(1);
  assert.deepEqual(chords, ['ctrl+shift+v', 'shift+insert']);
  assert.match(rows[1] as string, /gesture:\s*'ctrl\+click'/);
  assert.equal((rows[0] as string).includes('gesture:'), false, 'a chord row must not render as a gesture');
  assert.equal((rows[1] as string).includes('keys:'), false, 'a mouse sentence must not render as a key chip');

  // The excerpt may not drift from the full table it excerpts.
  for (const c of chords) assert.ok(SHORTCUTS.includes(`'${c}'`), `${c} must also be in the overlay table`);
  assert.ok(SHORTCUTS.includes("'ctrl+click a link'"), 'the link gesture must also be in the overlay table');
});

test('every key the settings excerpt promises is one the app really takes', () => {
  // Same rule as the overlay's own table test: the copy is checked against the
  // predicates that read the events, not against a second hardcoded list.
  const chord = (text: string): KeyChord => {
    const parts = text.split('+');
    const key = parts[parts.length - 1] as string;
    return {
      type: 'keydown',
      key: key === 'insert' ? 'Insert' : key,
      ctrlKey: parts.includes('ctrl'),
      shiftKey: parts.includes('shift'),
      altKey: parts.includes('alt'),
      metaKey: parts.includes('meta'),
    };
  };
  const block = /const KEY_ROWS: KeyRow\[\] = \[([\s\S]*?)\n\];/.exec(SETTINGS);
  const rows = [...(block?.[1] ?? '').matchAll(/\{([^}]*)\}/g)].map((m) => m[1] as string);
  const chords = [...(rows[0] as string).matchAll(/'([^']+)'/g)].map((m) => m[1] as string).slice(1);
  assert.ok(chords.length >= 2, 'no chords parsed out of the panel — the check would be vacuous');
  for (const c of chords) assert.equal(isPasteChord(chord(c)), true, `the panel promises ${c}`);
  // The link row's claim is that the MODIFIER opens it; a plain click must not.
  assert.equal(isLinkActivation({ ctrlKey: true, altKey: false, metaKey: false }), true);
  assert.equal(isLinkActivation({ ctrlKey: false, altKey: false, metaKey: false }), false);
});

test('the overlay answers "why not ctrl+v?" on the paste row itself, not only in the footer', () => {
  // The user's actual question (2026-09-08). A row that lists the chord without
  // saying why it exists is what produced it in the first place.
  const rows = /const ROWS: Row\[\] = \[([\s\S]*?)\n\];/.exec(SHORTCUTS);
  assert.notEqual(rows, null, 'shortcuts.ts must still declare a ROWS table');
  const paste = /\{[^{}]*ctrl\+shift\+v[\s\S]*?\n  \}/.exec(rows?.[1] ?? '');
  assert.notEqual(paste, null, 'the paste row must still be in the table');
  const note = /note:\s*'([^']*)'/.exec(paste?.[0] ?? '');
  assert.notEqual(note, null, 'the paste row must carry a note explaining itself');
  const text = note?.[1] ?? '';
  assert.ok(text.includes('ctrl+v'), `the note must name the key the user pressed: ${text}`);
  assert.ok(text.includes('terminal'), `the note must say where ctrl+v goes: ${text}`);
  // And the note has to be rendered, not merely declared.
  assert.match(SHORTCUTS, /if \(r\.note !== undefined\) table\.append\(el\('div', 'sc-cap', r\.note\)\);/);
});
