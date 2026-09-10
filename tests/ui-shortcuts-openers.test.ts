/**
 * The ways INTO the shortcuts overlay, and the settings panel's excerpt of it
 * (2026-09-08). The overlay was already correct and already listed the paste
 * chord — it was simply unreachable in practice: the only openers were the bare
 * `?` key, `ctrl+alt+/` and a 10.5px statusline hint, so a user who met
 * `ctrl+shift+v` in the wild had nowhere to ask why. This file pins the two new
 * answers to that:
 *
 *   1. a KEYS section in the settings panel whose rows are an EXCERPT of the
 *      overlay's table, plus an `all shortcuts` text button that opens it;
 *   2. a labelled `Keyboard shortcuts` button in the statusline.
 *
 * NOCTURNE A2 (2026-09-10) removed the third one, the topbar `?` button: the
 * design's top bar has no help icon, and the statusline now spells the opener
 * out in words instead of a 10.5px hint. The tests for that button are gone
 * with it (its subject no longer exists); what stays pinned is that there is
 * still exactly ONE overlay instance and that every REMAINING opener toggles
 * that same handle, plus the full top-bar order that replaced it.
 *
 * WHY A SOURCE SCAN. There is no DOM in this test runner (see
 * `tests/ui-focus-trap.test.ts` for the doubles idiom that reaches the few
 * functions which can run headless); `buildShell()` in main.ts constructs the
 * topbar directly against `document`. So the shape of the wiring is checked in
 * the source, and every check below is paired with a non-vacuity assertion so a
 * regex that quietly matches nothing cannot make the file pass.
 *
 * The load-bearing half is the LAST test: the settings excerpt's chords are
 * compared against the real `isPasteChord` / `isCopyChord` / `isLinkActivation`
 * predicates, so the panel cannot promise a key the app does not take (the
 * same rule `tests/ui-shortcuts-table.test.ts` enforces for the overlay
 * itself). 2026-09-10 added the copy row (`ctrl+shift+c` / `ctrl+insert`) as
 * the excerpt's second row; the link row moved to third.
 *
 * NOT claimed here: that the button is visible, sized, or in the right place on
 * screen. That stays manual (`.claude/skills/verify-terminal/SKILL.md`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCopyChord, isLinkActivation, isPasteChord } from '../web/src/ui/keys.ts';
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
  assert.ok(MAIN.includes("button('tb-icon', '')"), 'the icon-only topbar idiom must still exist');
  assert.ok(SETTINGS.includes('export function initSettings'), 'settings.ts must still export its init');
  assert.ok(SHORTCUTS.includes('export function initShortcuts'), 'shortcuts.ts must still export its init');
});

/**
 * The arguments of `topbar.append(...)`, split at the TOP level only — a child
 * like `el('span', 'tb-divider')` carries its own commas, so a plain split
 * would shred it into `el('span'` + `'tb-divider')`.
 */
function topbarChildren(src: string): string[] {
  const start = src.indexOf('topbar.append(');
  assert.notEqual(start, -1, 'main.ts must still append the topbar children in one call');
  const from = start + 'topbar.append('.length;
  let depth = 0;
  let quote = '';
  let cur = '';
  const out: string[] = [];
  for (let i = from; i < src.length; i += 1) {
    const c = src[i] as string;
    if (quote !== '') {
      cur += c;
      if (c === '\\') {
        cur += src[i + 1] ?? '';
        i += 1;
      } else if (c === quote) quote = '';
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      cur += c;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth += 1;
    if (c === ')' && depth === 0) break;
    if (c === ')' || c === ']' || c === '}') depth -= 1;
    if (c === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  out.push(cur.trim());
  return out.filter((c) => c !== '');
}

test('the top bar holds exactly the Nocturne row, in order, and no help button', () => {
  // A2's top bar (README-v3 §top bar): brand, hairline, the three panel
  // toggles, spacer, the connection readout, hairline, the GitHub account
  // chip, Settings, New session. Order is the contract — the update pill is
  // inserted after `conn` at runtime (`conn.after(upd.pill)`), not here.
  assert.deepEqual(topbarChildren(MAIN), [
    'brand',
    "el('span', 'tb-divider')",
    'toggles',
    "el('span', 'tb-gap')",
    'conn',
    "el('span', 'tb-divider')",
    'ghChip',
    'settingsBtn',
    'newBtn',
  ]);
  // The gear is still there and still an opener; the `?` button is not.
  assert.match(MAIN, /settingsBtn\.setAttribute\('aria-label', 'Settings'\);/);
  assert.match(MAIN, /settingsBtn\.setAttribute\('aria-haspopup', 'dialog'\);/);
  assert.equal(count(MAIN, 'helpBtn'), 0, 'the topbar `?` button was removed in A2');
});

test('there is exactly ONE overlay instance — the key, the button, the statusline and settings share it', () => {
  assert.ok(MAIN.includes("import { initShortcuts } from './ui/shortcuts.ts';"), 'the import must still be there');
  assert.equal(count(MAIN, 'initShortcuts('), 1, 'expected exactly one construction of the overlay');
  assert.equal(count(MAIN, 'const shortcuts = initShortcuts(modalHost);'), 1);
  // The two openers main.ts owns, each on the same handle.
  assert.ok(
    MAIN.includes('openShortcuts: () => shortcuts.toggle(),'),
    'the statusline button must still open it',
  );
  assert.ok(
    MAIN.includes('{ openShortcuts: () => shortcuts.toggle() }'),
    'the settings panel must be handed the same opener',
  );
  // The bare `?` key path (outside editable targets) must keep working.
  assert.match(MAIN, /e\.key === '\?'[\s\S]{0,200}?shortcuts\.toggle\(\);/);
});

test('the statusline opener is a spelled-out button, not a glyph (it replaced the topbar `?`)', () => {
  const STATUSLINE = read('web', 'src', 'ui', 'statusline.ts');
  assert.ok(STATUSLINE.length > 1000, 'ui/statusline.ts looks empty');
  assert.match(STATUSLINE, /el\('button', 'status-hint', 'Keyboard shortcuts'\)/);
  assert.match(STATUSLINE, /hint\.title = 'Keyboard shortcuts \(\? or ctrl\+alt\+\/\)';/);
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

test('the settings KEYS section states paste, copy and the link gesture, and nothing that is not in the overlay', () => {
  const block = /const KEY_ROWS: KeyRow\[\] = \[([\s\S]*?)\n\];/.exec(SETTINGS);
  assert.notEqual(block, null, 'settings.ts must still declare KEY_ROWS');
  const src = block?.[1] ?? '';
  const rows = [...src.matchAll(/\{([^}]*)\}/g)].map((m) => m[1] as string);
  assert.equal(rows.length, 3, `expected the three-row excerpt, parsed ${rows.length}`);

  const whats = rows.map((r) => (/what:\s*'([^']*)'/.exec(r) ?? [])[1]);
  assert.deepEqual(whats, ['paste into a terminal', 'copy the selection', 'open a link printed in a terminal']);

  // Rows 0 and 1: chords, rendered as <kbd> chips. Row 2: a mouse sentence, never a chip.
  const chords = [...(rows[0] as string).matchAll(/'([^']+)'/g)].map((m) => m[1] as string).slice(1);
  assert.deepEqual(chords, ['ctrl+shift+v', 'shift+insert']);
  const copyChords = [...(rows[1] as string).matchAll(/'([^']+)'/g)].map((m) => m[1] as string).slice(1);
  assert.deepEqual(copyChords, ['ctrl+shift+c', 'ctrl+insert']);
  assert.match(rows[2] as string, /gesture:\s*'ctrl\+click'/);
  assert.equal((rows[0] as string).includes('gesture:'), false, 'a chord row must not render as a gesture');
  assert.equal((rows[1] as string).includes('gesture:'), false, 'a chord row must not render as a gesture');
  assert.equal((rows[2] as string).includes('keys:'), false, 'a mouse sentence must not render as a key chip');

  // The excerpt may not drift from the full table it excerpts.
  for (const c of [...chords, ...copyChords]) {
    assert.ok(SHORTCUTS.includes(`'${c}'`), `${c} must also be in the overlay table`);
  }
  assert.ok(SHORTCUTS.includes("'ctrl+click a link'"), 'the link gesture must also be in the overlay table');
  // Same words in both places: the panel and the overlay name the copy row alike.
  assert.ok(SHORTCUTS.includes("what: 'copy the selection'"), 'the overlay must carry the same copy row');
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
  // Row 1 is the copy row: its chords are exactly the copy pair, each one a
  // chord isCopyChord accepts — and none of them a paste chord.
  const copyChords = [...(rows[1] as string).matchAll(/'([^']+)'/g)].map((m) => m[1] as string).slice(1);
  assert.deepEqual(copyChords, ['ctrl+shift+c', 'ctrl+insert']);
  for (const c of copyChords) {
    assert.equal(isCopyChord(chord(c)), true, `the panel promises ${c} copies`);
    assert.equal(isPasteChord(chord(c)), false, `${c} must not also paste`);
  }
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
