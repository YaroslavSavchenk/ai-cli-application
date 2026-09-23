/**
 * Nocturne B9 (`.claude/plans/nocturne/PLAN-B9.md`) — the pins that live in
 * source: the D3 CSS split in app.css (`--term-bg` is the THEMED terminal
 * ground and nothing but terminal surfaces may read it; the editor chip, the
 * editor/diff pane bodies and the diff itself read the untouched twin
 * `--color-term`), and the boot wire in `main.ts` (the theme is built before
 * the settings panel and long before the first terminal). Split from
 * `tests/ui/ui-b9-theme.test.ts`.
 *
 * How: the stylesheet and `main.ts` read as text (`readSource`) — there is no
 * DOM boot here, and `main.ts`'s import graph reaches xterm.
 *
 * Why: an editor pane that reads `--term-bg` repaints in the user's terminal
 * colours; a theme built after the first terminal paints it in the default.
 *
 * NOT claimed: the rendered colours (`.claude/skills/verify-terminal/SKILL.md`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSource, readSources } from '../helpers/helpers.ts';
import { readAppCss } from '../helpers/tokens-helpers.ts';

// ===========================================================================
// D3 — which surfaces follow the themed ground, in app.css
// ===========================================================================

const APP_CSS = readAppCss();
/** Comments carry the word `--term-bg` in prose; only DECLARATIONS count here. */
const APP_RULES = APP_CSS.replace(/\/\*[\s\S]*?\*\//g, '');

/** Every `selector { ... }` block whose body contains `needle`. */
function selectorsReading(needle: string): string[] {
  const out: string[] = [];
  for (const m of APP_RULES.matchAll(/(^|\n)([^{}@][^{}]*?)\{([^{}]*)\}/g)) {
    if ((m[3] as string).includes(needle)) out.push((m[2] as string).trim().replace(/\s+/g, ' '));
  }
  return out;
}

test('D3: --term-bg is read by the TERMINAL surfaces only — the whole themed set, named', () => {
  assert.deepEqual(
    selectorsReading('var(--term-bg)'),
    ['.pane-body', '.term-host .xterm, .term-host .xterm .xterm-viewport'],
    'a new reader of --term-bg would take a user’s custom terminal ground somewhere it was never chosen (open decision 10c)',
  );
  // Non-vacuity: the scanner finds the twin's readers too, and they are others.
  assert.ok(
    selectorsReading('var(--color-term)').length >= 4,
    'non-vacuity: the unthemed twin has its own readers',
  );
});

test('D3: the editor chip, the editor/diff pane bodies and the diff itself read --color-term, the UNTHEMED twin', () => {
  for (const [sel, why] of [
    ['.pane-tab.is-on', 'the active file chip belongs to an editor pane, whose body is app ink'],
    ['.pane-file,\n.pane-diff', 'the editor and diff pane bodies paint their own ground'],
    ['.diff-body', 'a diff’s red and green are app ink and never follow the terminal'],
  ] as const) {
    const rule = new RegExp(`(^|\\n)${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(APP_CSS);
    assert.ok(rule !== null, `app.css must still carry a ${sel} rule`);
    assert.match((rule[2] as string), /background:\s*var\(--color-term\)/, `${sel}: ${why}`);
    assert.equal(
      (rule[2] as string).includes('var(--term-bg)'),
      false,
      `${sel} must not follow the themed ground: ${why}`,
    );
  }
});

test('D3: an EDITOR pane’s body is kept off the themed ground too (a pane with no drawable tab is a BARE .pane-body)', () => {
  const rule = /(^|\n)\.pane\.is-editor \.pane-body\s*\{([^}]*)\}/.exec(APP_CSS);
  assert.ok(rule !== null, 'app.css must carry the editor-pane body rule');
  assert.match(rule[2] as string, /background:\s*var\(--color-term\)/, 'the UNTHEMED twin, like .pane-file');
  // And the class it hangs on is kept in step with the payload by ui/panes.ts.
  const PANES = readSource('web/src/ui/panes.ts');
  assert.match(PANES, /classList\.add\('is-editor'\)/, 'buildEditorPane marks the card');
  assert.match(PANES, /classList\.remove\('is-editor'\)/, 'teardown takes it off again');
});

/**
 * The body of a top-level `function <name>(...)` in a source file, brace-matched.
 * ui/panes.ts reaches @xterm/xterm and cannot be imported under `node --test`,
 * so WHERE a statement sits is the strongest claim available — and it is the
 * claim that matters: a mutation probe (2026-09-22) showed a bare
 * `assert.match(PANES, /classList\.remove\('is-editor'\)/)` survives the call
 * being moved into a branch that can never run.
 */
function bodyOf(src: string, signature: string): string {
  const start = src.indexOf(signature);
  assert.notEqual(start, -1, `no such function: ${signature}`);
  let depth = 0;
  for (let i = start + signature.length - 1; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  assert.fail(`unbalanced braces after ${signature}`);
}

test('D3: `is-editor` goes on in buildEditorPane and off in teardown — unconditionally, in both', () => {
  const PANES = readSource('web/src/ui/panes.ts');
  const build = bodyOf(PANES, 'function buildEditorPane(s: Slot, slot: st.EditorSlot, index: number): void {');
  const tear = bodyOf(PANES, 'function teardown(s: Slot): void {');
  // A statement at the function's own indentation: not inside an `if`, a loop
  // or a callback, so it runs on EVERY build and EVERY teardown.
  assert.match(build, /\n {2}s\.root\.classList\.add\('is-editor'\);\n/, 'buildEditorPane marks the card, always');
  assert.match(tear, /\n {2}s\.root\.classList\.remove\('is-editor'\);\n/, 'teardown takes it off, always');
  assert.equal(build.includes("classList.remove('is-editor')"), false, 'and the two do not cancel each other out');
  // The removal happens BEFORE teardown's early return, or a pane that never
  // had a payload would keep the class.
  const ret = tear.indexOf('if (pay === null) return;');
  assert.notEqual(ret, -1, 'non-vacuity: teardown still has its early return');
  assert.ok(tear.indexOf("classList.remove('is-editor')") < ret, 'the class comes off before any early return');
  // Nobody else in the app touches the class — CSS reads it, panes.ts owns it.
  assert.equal([...PANES.matchAll(/'is-editor'/g)].length, 2, 'exactly two mentions: the add and the remove');
});

test('D3: the pane status bar takes the THEME’s own two ink steps, so it stays readable on any ground', () => {
  assert.match(APP_CSS, /\.pane-status-k\s*\{[^}]*color:\s*var\(--xt-bright-black\)/);
  assert.match(APP_CSS, /\.pane-status-v\s*\{[^}]*color:\s*var\(--xt-fg\)/);
  for (const dead of [
    /\.pane-status-k\s*\{[^}]*--color-neutral-600/,
    /\.pane-status-v\s*\{[^}]*--color-neutral-300/,
  ]) {
    assert.equal(dead.test(APP_CSS), false, 'the app neutrals are gone from the bar (they do not follow a light ground)');
  }
  // The semantic pair stays semantic (open decision 10c).
  assert.match(APP_CSS, /\.pane-status-v\.is-danger\s*\{[^}]*color:\s*var\(--color-danger\)/);
});

test('D3: the `.sg-note` honesty-line rule is gone with the last mock page', () => {
  assert.equal(/(^|\n)\.sg-note\s*\{/.test(APP_CSS), false, 'no rule');
  assert.equal(APP_CSS.includes('sg-note'), false, 'and no mention left behind');
  // Non-vacuity: the sibling Settings classes the rule sat among are still here.
  for (const kept of ['.sg-lead', '.sg-lb', '.sg-tcprev']) {
    assert.ok(APP_CSS.includes(kept), `non-vacuity: ${kept} must still exist`);
  }
});

// ===========================================================================
// The boot wire in main.ts (source pin — there is no DOM boot here)
// ===========================================================================

const MAIN_TS = readSources('web/src/main.ts', 'web/src/main-shell.ts');

test('main.ts builds the theme BEFORE the settings panel and long before the first terminal', () => {
  const at = (needle: string): number => {
    const i = MAIN_TS.indexOf(needle);
    assert.notEqual(i, -1, `main.ts must contain ${needle}`);
    return i;
  };
  // Each index is asserted to EXIST first: `-1 < x` would make an ordering
  // check pass for a call that was deleted.
  const theme = at('const theme = initTheme(prefs);');
  assert.ok(theme < at('initSettings(modalHost, settingsBtn, { repaintStatus, theme })'), 'before the panel it is handed to');
  assert.ok(theme < at('initPanes('), 'before anything that can build a terminal');
  assert.ok(at('initStatusLine(prefs?.statusLine)') < theme, 'inside buildShell’s boot block, after the status line');
  assert.ok(at('function buildShell') < theme, 'in buildShell, not in boot()');
});
