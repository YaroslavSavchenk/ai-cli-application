/**
 * The ways INTO the shortcuts overlay, and the settings panel's excerpt of it
 * (2026-09-08). The overlay was already correct and already listed the paste
 * chord — it was simply unreachable in practice: the only openers were the bare
 * `?` key, `ctrl+alt+/` and a 10.5px statusline hint, so a user who met
 * `ctrl+shift+v` in the wild had nowhere to ask why. This file pins the two new
 * answers to that:
 *
 *   1. a Keyboard page in the settings panel, which since Nocturne B6 draws the
 *      WHOLE table from the module both surfaces read (`ui/shortcuts-rows.ts`)
 *      — it used to be a hand-copied three-row excerpt with an `all shortcuts`
 *      button beside it, and a second table is how two answers drift apart;
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
 * `tests/ui/ui-focus-trap.test.ts` for the doubles idiom that reaches the few
 * functions which can run headless); `buildShell()` in main.ts constructs the
 * topbar directly against `document`. So the shape of the wiring is checked in
 * the source, and every check below is paired with a non-vacuity assertion so a
 * regex that quietly matches nothing cannot make the file pass.
 *
 * The load-bearing half is the LAST test: the chords the PANEL puts on screen
 * are compared against the real `isPasteChord` / `isCopyChord` /
 * `isLinkActivation` predicates, so the panel cannot promise a key the app does
 * not take. Since B6 it promises exactly what the overlay promises, because it
 * reads the same rows — which is what the first half now pins.
 *
 * NOT claimed here: that the button is visible, sized, or in the right place on
 * screen. That stays manual (`.claude/skills/verify-terminal/SKILL.md`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isCopyChord, isLinkActivation, isPasteChord } from '../../web/src/ui/keys.ts';
import type { KeyChord } from '../../web/src/ui/keys.ts';
import { readSource as read, readSources } from '../helpers/helpers.ts';

const MAIN = readSources('web/src/main.ts', 'web/src/main-shell.ts');
const SETTINGS = read('web', 'src', 'ui', 'settings.ts');
const SHORTCUTS = read('web', 'src', 'ui', 'shortcuts.ts');
/** The rows both surfaces draw (Nocturne B6). */
const ROWS_TS = read('web', 'src', 'ui', 'shortcuts-rows.ts');

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
  assert.equal(count(MAIN, 'const shortcuts = initShortcuts(modalHost, requestTerminalFocus);'), 1);
  // The opener main.ts owns since B6: the statusline's, and only that one —
  // the settings panel no longer opens the overlay at all.
  assert.equal(
    count(MAIN, 'openShortcuts: () => shortcuts.toggle(),'),
    1,
    'the statusline button must still open it, and it is the only injected opener',
  );
  assert.match(
    MAIN,
    /initSettings\(modalHost, settingsBtn, \{ repaintStatus, theme \}\)/,
    'the settings panel takes no overlay opener since part B6 — repaintStatus and, since B9, the theme control',
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

test('the settings panel needs no overlay at all: it draws the same rows itself (B6)', () => {
  assert.match(SETTINGS, /deps: SettingsDeps,/);
  assert.equal(count(SETTINGS, 'openShortcuts'), 0, 'the dep is gone with the excerpt');
  assert.equal(count(SETTINGS, 'all shortcuts'), 0, 'and so is the link to a second table');
  assert.match(SETTINGS, /import \{ ROWS \} from '\.\/shortcuts-rows\.ts';/);
  assert.match(SETTINGS, /for \(const r of ROWS\) \{/, 'the Keyboard page walks the shared table');
  // The panel must not build a second overlay of its own either.
  assert.equal(count(SETTINGS, 'initShortcuts'), 0);
  // And the overlay reads the very same module — one table, two layouts.
  assert.match(SHORTCUTS, /import \{ ROWS \} from '\.\/shortcuts-rows\.ts';/);
  assert.equal(count(SHORTCUTS, 'const ROWS'), 0, 'the rows are not declared twice');
});

test('the panel states paste, copy and the link gesture because it states the WHOLE table', () => {
  // One source: the three rows the panel used to copy by hand are simply rows
  // of the shared table now, and the page renders every one of them.
  for (const what of [
    "what: 'paste the clipboard into the terminal'",
    "what: 'copy the selection'",
    "what: 'open it in your browser'",
  ]) {
    assert.ok(ROWS_TS.includes(what), `the table must carry ${what}`);
  }
  assert.ok(ROWS_TS.includes("'ctrl+click a link'"), 'the link gesture is a row of the table');
  // A chord is a key chip; a mouse gesture is a sentence and never a chip —
  // the same rule on the page as in the overlay.
  assert.match(
    SETTINGS,
    /r\.gesture === true \? el\('span', 'sg-gesture', k\) : el\('kbd', 'sg-kbd', k\)/,
  );
  assert.match(
    SETTINGS,
    /row\.append\(chips, el\('span', 'sg-rowlb', r\.what\), el\('span', 'sg-keyui', r\.ui\)\);/,
    'the page carries all three facts of a row, like the overlay',
  );
  assert.match(
    SETTINGS,
    /if \(r\.note !== undefined\) row\.append\(el\('div', 'sg-cap', r\.note\)\);/,
    'and the note of the rows that carry one',
  );
});

test('every key the settings page promises is one the app really takes', () => {
  // Same rule as the overlay's own table test: the claim is checked against the
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
  // The rows the page draws, read out of the module it draws them from.
  const rowOf = (what: string): string => {
    const hit = new RegExp(`\\{[^{}]*what: '${what}'[\\s\\S]*?\\n  \\}`).exec(ROWS_TS);
    assert.notEqual(hit, null, `no row for ${what}`);
    return hit?.[0] ?? '';
  };
  const keysOf = (what: string): string[] => {
    const keys = /keys: \[([^\]]*)\]/.exec(rowOf(what));
    return [...(keys?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1] as string);
  };
  const chords = keysOf('paste the clipboard into the terminal');
  assert.ok(chords.length >= 2, 'no chords parsed out of the table — the check would be vacuous');
  for (const c of chords) assert.equal(isPasteChord(chord(c)), true, `the panel promises ${c}`);
  // The copy row: exactly the copy pair, each one a chord isCopyChord accepts
  // — and none of them a paste chord.
  const copyChords = keysOf('copy the selection');
  assert.deepEqual(copyChords, ['ctrl+shift+c', 'ctrl+insert']);
  for (const c of copyChords) {
    assert.equal(isCopyChord(chord(c)), true, `the panel promises ${c} copies`);
    assert.equal(isPasteChord(chord(c)), false, `${c} must not also paste`);
  }
  // The link row's claim is that the MODIFIER opens it; a plain click must not.
  assert.equal(isLinkActivation({ ctrlKey: true, altKey: false, metaKey: false }), true);
  assert.equal(isLinkActivation({ ctrlKey: false, altKey: false, metaKey: false }), false);
});

test('the table answers "why not ctrl+v?" on the paste row itself, not only in the footer', () => {
  // The user's actual question (2026-09-08). A row that lists the chord without
  // saying why it exists is what produced it in the first place. Both surfaces
  // draw the note, because both draw this row.
  const rows = /const ROWS: Row\[\] = \[([\s\S]*?)\n\];/.exec(ROWS_TS);
  assert.notEqual(rows, null, 'shortcuts-rows.ts must still declare a ROWS table');
  const paste = /\{[^{}]*ctrl\+shift\+v[\s\S]*?\n  \}/.exec(rows?.[1] ?? '');
  assert.notEqual(paste, null, 'the paste row must still be in the table');
  const note = /note:\s*'([^']*)'/.exec(paste?.[0] ?? '');
  assert.notEqual(note, null, 'the paste row must carry a note explaining itself');
  const text = note?.[1] ?? '';
  assert.ok(text.includes('ctrl+v'), `the note must name the key the user pressed: ${text}`);
  assert.ok(text.includes('terminal'), `the note must say where ctrl+v goes: ${text}`);
  // And the note has to be rendered, not merely declared.
  // A8 moved the row and its caption into one `sc-item`, so the hairline
  // between entries can never cut a row away from its own explanation.
  assert.match(SHORTCUTS, /if \(r\.note !== undefined\) item\.append\(el\('div', 'sc-cap', r\.note\)\);/);
});
