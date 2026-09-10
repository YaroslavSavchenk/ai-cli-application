/**
 * The copy chord's SECOND decision (2026-09-10): `isCopyChord` only answers "is
 * this the chord" (tests/ui-keys.test.ts); whether the keystroke is TAKEN is
 * decided in `web/src/ui/terminal.ts`'s xterm key handler, and the rule there
 * is the one the overlay promises the user: a copy chord is the app's only
 * while the terminal HAS a selection. With nothing selected the handler must
 * return `true` (hand the event on to xterm, untouched — no preventDefault,
 * no clipboard write), exactly as before the chord existed.
 *
 * WHY A SOURCE SCAN. `ui/terminal.ts` imports `@xterm/xterm`, a browser bundle
 * that cannot load under Node, and `TerminalView` needs a DOM; there is no
 * runtime seam to drive its key handler headless. So the ORDER of the three
 * statements that make the rule is pinned in the source: the selection test
 * first, then preventDefault, then the copy. A behavioural check of the real
 * keystroke in a real pane stays manual
 * (`.claude/skills/verify-terminal/SKILL.md`).
 *
 * Also pinned: the copied text is PTY output, so it never reaches a log line
 * (PROJECT-SCOPE logging rule — counts, never content).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TERMINAL = readFileSync(join(REPO_ROOT, 'web', 'src', 'ui', 'terminal.ts'), 'utf8');

/** The body of xterm's custom key handler, up to the ctrl+alt reservation that follows it. */
function keyHandler(): string {
  const start = TERMINAL.indexOf('this.term.attachCustomKeyEventHandler(');
  assert.notEqual(start, -1, 'terminal.ts must still install a custom key handler');
  const end = TERMINAL.indexOf("e.type === 'keydown' &&", start);
  assert.notEqual(end, -1, 'the ctrl+alt reservation must still follow the chord branches');
  return TERMINAL.slice(start, end);
}

// ---------------------------------------------------------------------------

test('the scan reads the real module (non-vacuity: the handler and both chord branches are found)', () => {
  assert.ok(TERMINAL.length > 5000, 'ui/terminal.ts looks empty');
  const h = keyHandler();
  assert.ok(h.includes('isPasteChord(e)'), 'the paste branch must be in the handler');
  assert.ok(h.includes('isCopyChord(e)'), 'the copy branch must be in the handler');
  assert.match(TERMINAL, /import \{[^}]*\bisCopyChord\b[^}]*\} from '\.\/keys\.ts';/);
});

test('a copy chord is taken ONLY with a selection: no selection -> `return true` before any preventDefault or copy', () => {
  const h = keyHandler();
  const branch = /if \(isCopyChord\(e\)\) \{([\s\S]*?)\n {6}\}/.exec(h);
  assert.notEqual(branch, null, 'the copy branch must still be one `if (isCopyChord(e)) { … }` block');
  const body = (branch?.[1] ?? '').trim();
  const lines = body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('//'));
  assert.deepEqual(lines, [
    'if (!this.term.hasSelection()) return true;',
    'e.preventDefault();',
    'void this.#copySelection();',
    'return false;',
  ]);
});

test('the copy branch comes after the paste branch and before the ctrl+alt reservation (inside the same handler)', () => {
  const h = keyHandler();
  const paste = h.indexOf('if (isPasteChord(e))');
  const copy = h.indexOf('if (isCopyChord(e))');
  assert.ok(paste !== -1 && copy !== -1 && paste < copy, 'paste first, then copy');
});

test('the copy writes the terminal selection to the clipboard and never logs the text', () => {
  const m = /async #copySelection\(\): Promise<void> \{([\s\S]*?)\n {2}\}/.exec(TERMINAL);
  assert.notEqual(m, null, 'terminal.ts must still define #copySelection');
  const body = m?.[1] ?? '';
  assert.ok(body.includes('const text = this.term.getSelection();'), 'copies xterm\'s own selection');
  assert.ok(body.includes('await navigator.clipboard.writeText(text);'), 'through the async clipboard API');
  // Every log call in the copy path is a constant string: no template, no `text`.
  const logs = [...body.matchAll(/log\.\w+\(([^)]*)\)/g)].map((x) => x[1] as string);
  assert.ok(logs.length >= 1, 'expected the one refusal debug line — the check would be vacuous');
  for (const arg of logs) {
    assert.match(arg, /^'[^'$`]*'$/, `a copy-path log line must be a constant: ${arg}`);
    assert.equal(arg.includes('text'), false, `the copied text must never be logged: ${arg}`);
  }
});
