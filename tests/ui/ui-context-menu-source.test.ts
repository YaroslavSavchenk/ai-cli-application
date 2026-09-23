/**
 * The row context menu (Nocturne part A9b, brief 2) — the pins that live in
 * source and CSS: it is not a modal, it is the only right-click in the app,
 * `main.ts`'s Escape ladder knows nothing about it, the selection rule is the
 * model's, and the `cm-` block of app.css (class parity, tokens only, no
 * colour literal, `--z-menu`, the row's rhythm). Split from
 * `tests/ui/ui-context-menu.test.ts`.
 *
 * How: source text (`frontendFiles`, `readSource`, `APP_CSS`) — the wiring
 * and the stylesheet cannot be exercised on the DOM double — plus the REAL
 * module on the DOM double where a rendered card is the claim (shared setup:
 * `tests/helpers/ui-context-menu-fixture.ts`).
 *
 * Why: a second `contextmenu` listener anywhere takes the SYSTEM menu away
 * from xterm; a class with no rule or a colour literal in the block passes
 * every DOM assertion and still renders wrong.
 *
 * NOT claimed (browser work, `.claude/skills/verify-terminal/SKILL.md`): that
 * the card is legible, that it changes no layout, that a real `<button>`
 * activates on Enter/Space (the fake DOM activates nothing — the module's own
 * handler is the single path and is asserted instead), that a right-click
 * inside a terminal really reaches xterm, and screen-reader output.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { descendants, type FakeElement } from '../helpers/fake-dom.ts';
import { readSource, readSources, projectRoot, filesUnder } from '../helpers/helpers.ts';
import { assignedClasses } from '../helpers/source-scan.ts';
import {
  APP_CSS,
  declaredTokens,
  frontendFiles,
  stripComments,
  usedTokens,
} from '../helpers/tokens-helpers.ts';
import {
  CM,
  liveSession,
  row,
  menuEl,
  rightClick,
  resetWorld,
  FILES_SRC,
} from '../helpers/ui-context-menu-fixture.ts';

beforeEach(() => {
  resetWorld();
});

afterEach(() => {
  CM.closeRowMenu();
});

// ---------------------------------------------------------------------------
// It is not a modal, and it is the only right-click in the app
// ---------------------------------------------------------------------------

const MENU_SRC = frontendFiles(['.ts']).find((f) => f.name === 'web/src/ui/context-menu.ts')?.src ?? '';

test('the menu is NOT a dialog: no scrim, no aria-modal, no tab trap', async () => {
  await liveSession();
  rightClick(row('web'));
  const box = menuEl() as FakeElement;
  assert.equal(box.classList.contains('modal-scrim'), false);
  assert.equal(box.getAttribute('aria-modal'), null);
  assert.equal(box.getAttribute('role'), 'menu', 'never `dialog`');
  // `ui/keys.ts` finds keyboard owners by these selectors; matching either
  // would make every pane a dead file-drop target and stop the terminal
  // taking the keyboard back after an alt-tab.
  assert.equal(box.closest('[role="dialog"], .drawer, .modal-scrim, .boot-overlay'), null);
  const code = MENU_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(code.length > 2_000, `non-vacuity: ${code.length} chars of the module`);
  for (const forbidden of ['modal-scrim', 'aria-modal', 'trapTab']) {
    assert.equal(code.includes(forbidden), false, `the menu must not be a modal: ${forbidden}`);
  }
});

test('only ui/files.ts and the menu card itself register a contextmenu listener', () => {
  // The mirror of the no-`dragstart` pin (tests/ui/ui-filedrop.test.ts): a second
  // right-click handler anywhere — a pane, the tab strip, the terminal host —
  // would take the SYSTEM menu away from xterm, whose own `contextmenu`
  // handler is what makes the system Copy and Paste act on the selection.
  // `ui/context-menu.ts` is the one addition, and it is scoped to the OPEN
  // card only: the browser's own contextmenu for the key that opened the menu
  // targets an entry inside it, out of reach of the panel's delegated listener.
  const rootDir = join(projectRoot, 'web', 'src');
  const files = filesUnder(rootDir, /\.(ts|html|css)$/);
  assert.ok(files.length >= 20, `non-vacuity: scanned ${files.length} files`);
  const offenders = files.filter((f) => /['"]contextmenu['"]/.test(readFileSync(f, 'utf8')));
  assert.deepEqual(
    offenders.map((f) => f.slice(rootDir.length + 1)).sort(),
    ['ui/context-menu.ts', 'ui/files.ts'],
  );
  // And the menu's one is on its OWN card, registered through `on()` so it is
  // removed with the menu — never on the document, never on anything a
  // terminal is inside of.
  assert.equal(MENU_SRC.split("'contextmenu'").length - 1, 1);
  assert.match(MENU_SRC, /on\(box, 'contextmenu'/);
  // And it is ONE delegated listener, not one per row.
  assert.equal(FILES_SRC.split("addEventListener('contextmenu'").length - 1, 1);
  assert.match(FILES_SRC, /root\.addEventListener\('contextmenu'/);
});

test('main.ts s Escape ladder knows nothing about the menu', () => {
  // The menu owns Escape on its own window CAPTURE listener; a rung in the
  // ladder would be a second owner, and the ladder's length bound in
  // tests/ui/ui-files-panel.test.ts is what A9b promised not to touch.
  const main = readSources('web/src/main.ts', 'web/src/main-shell.ts');
  assert.ok(main.length > 10_000, 'non-vacuity: main.ts');
  for (const name of ['RowMenu', 'context-menu', 'cm-menu']) {
    assert.equal(main.includes(name), false, `main.ts must not know the menu: ${name}`);
  }
});

test('the right-click s selection is the MODEL s rule, not a second copy of it', () => {
  // `afterMenuOpen()` is where "a row already in the selection keeps the whole
  // selection, any other row becomes it" is decided, and
  // tests/ui/ui-files-select-model.test.ts is where it is tested. Inlining the
  // same rule here is behaviour-identical TODAY — MEASURED (gate,
  // 2026-09-16): `selected = dir ? path : selected` left the whole suite
  // green — so this is a SOURCE pin and says so: it is the second place that
  // would have to change when the rule does.
  assert.match(
    FILES_SRC,
    /selected = afterMenuOpen\(selected, key\)/,
    'the menu s selection must go through the model',
  );
});

test('the row menu region closes the menu at the top of every rebuild', () => {
  const from = FILES_SRC.indexOf('function rebuild(');
  assert.notEqual(from, -1, 'non-vacuity: rebuild() was found');
  const body = FILES_SRC.slice(from, FILES_SRC.indexOf('const focusKey', from));
  assert.match(body, /closeRowMenu\(\)/, 'the anchor row is about to be replaced');
});

// ---------------------------------------------------------------------------
// The block: class parity, tokens only, no colour literal
// ---------------------------------------------------------------------------

/** The `cm-` section: the last one in app.css, so it runs to the end. */
function cmSection(): string {
  const css = APP_CSS;
  const at = css.indexOf('/* ---- row context menu (Nocturne A9b)');
  assert.notEqual(at, -1, 'non-vacuity: the cm- section header was not found');
  return css.slice(at);
}

test('class parity for cm-: no class without a rule, no rule without a setter, one owner', () => {
  const rules = stripComments(APP_CSS);
  const inTs = new Map<string, string[]>();
  for (const f of frontendFiles(['.ts'])) {
    for (const c of assignedClasses(f.src)) {
      if (!/^cm-[a-z0-9-]+$/.test(c)) continue;
      const owners = inTs.get(c) ?? [];
      if (!owners.includes(f.name)) owners.push(f.name);
      inTs.set(c, owners);
    }
  }
  const inCss = new Set<string>();
  for (const m of rules.matchAll(/\.(cm-[a-z0-9-]+)/g)) inCss.add(m[1] as string);
  assert.ok(inTs.size >= 4 && inCss.size >= 4, `non-vacuity: ts ${inTs.size}, css ${inCss.size}`);

  assert.deepEqual([...inTs.keys()].filter((c) => !inCss.has(c)), [], 'a class no rule styles');
  assert.deepEqual([...inCss].filter((c) => !inTs.has(c)), [], 'a rule no module sets');

  const owners = new Set<string>();
  for (const files of inTs.values()) for (const f of files) owners.add(f);
  assert.deepEqual([...owners], ['web/src/ui/context-menu.ts'], 'a prefix is one block s name');

  // Every rule is a BASE rule (the tests/ui/ui-a8-block-rules.test.ts lesson: a
  // class styled only inside a @media block renders unstyled at every normal
  // window width and no parity guard notices).
  const base = cmSection().replace(/@media[^{]*\{[\s\S]*?\n\}\n/g, '');
  for (const c of inTs.keys()) {
    assert.match(base, new RegExp(`\\.${c}(?![\\w-])`), `${c} is styled only inside a @media block`);
  }
});

test('tokens only: every var() in the cm- section is declared, and it declares none of its own', () => {
  const declared = declaredTokens();
  assert.ok(declared.size >= 100, `non-vacuity: ${declared.size} tokens declared`);
  const block = stripComments(cmSection());
  assert.ok(block.length > 800, `non-vacuity: the cm- section is ${block.length} chars`);
  const used = usedTokens(block);
  assert.ok(used.length >= 10, `non-vacuity: only ${used.length} token reads`);
  assert.deepEqual([...new Set(used)].filter((t) => !declared.has(t)), []);
  assert.deepEqual([...block.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((m) => m[1]), []);
});

test('no colour literal in the cm- section or in the module that paints it', () => {
  const offenders: string[] = [];
  for (const m of stripComments(cmSection()).matchAll(/#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch)\(/g)) {
    offenders.push(`app.css: ${m[0]}`);
  }
  const code = MENU_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(code.length > 2_000, 'non-vacuity: the module scan found nothing');
  for (const m of code.matchAll(/#[0-9a-fA-F]{6}\b|\b(?:rgba?|hsla?|oklch)\(/g)) {
    offenders.push(`context-menu.ts: ${m[0]}`);
  }
  assert.deepEqual(offenders, [], `a colour decision outside tokens.css: ${offenders.join('; ')}`);
});

test('--z-menu is declared once, sits between the toast and the modals, and is read here only', () => {
  const tokens = readSource('web', 'src', 'styles', 'tokens.css');
  const decl = [...tokens.matchAll(/^\s*--z-menu:\s*(\d+);/gm)];
  assert.equal(decl.length, 1, 'declared exactly once');
  assert.equal(decl[0]?.[1], '47');
  const n = (name: string): number =>
    Number(new RegExp(`--z-${name}:\\s*(\\d+);`).exec(tokens)?.[1] ?? '0');
  assert.ok(n('toast') < 47 && 47 < n('modal'), 'above the toast, below every dialog');
  const readers = [...stripComments(APP_CSS).matchAll(/var\(--z-menu\)/g)];
  assert.equal(readers.length, 1, 'one reader: the menu itself');
  assert.match(stripComments(cmSection()), /z-index: var\(--z-menu\)/);
});

test('the menu wears the row s own rhythm and the popover s elevation — and no icon, no separator', async () => {
  const block = stripComments(cmSection());
  assert.match(block, /min-height: var\(--files-row-h\)/, 'the tree s own 26px row');
  assert.match(block, /background: var\(--color-bg\)/);
  assert.match(block, /border-radius: var\(--radius-md\)/);
  assert.match(block, /box-shadow: var\(--shadow-md\)/);
  assert.match(block, /animation: fadeUp 0\.14s ease/);
  assert.match(block, /prefers-reduced-motion/);
  assert.match(block, /\.cm-item:hover\s*\{\s*background: var\(--color-neutral-900\)/);
  assert.match(block, /\.cm-item\[aria-disabled='true'\]\s*\{\s*color: var\(--color-neutral-700\)/);
  assert.match(block, /\.cm-sub\s*\{\s*color: var\(--color-neutral-600\)/);
  assert.match(block, /outline: var\(--tick\) solid var\(--color-accent\)/, 'the base focus ring');
  // The accent is an outline and a small mark, never a fill (Nocturne rule).
  assert.deepEqual([...block.matchAll(/background:\s*var\(--color-accent\)/g)].map((m) => m[0]), []);
  // No icon: the module renders text, and ONE hairline. The separator above
  // `Delete` is B10a's single amendment to A9b's "no separators" rule — it is
  // a `div.cm-sep`, it carries no words, and it is the only DIV in the card.
  await liveSession();
  rightClick(row('web'));
  const drawn = descendants(menuEl() as FakeElement);
  assert.deepEqual(
    [...new Set(drawn.map((n) => n.tagName))].sort(),
    ['BUTTON', 'DIV', 'SPAN'],
    'buttons, their words, and the one hairline',
  );
  const seps = drawn.filter((n) => n.className === 'cm-sep');
  assert.equal(seps.length, 1, 'exactly one, and only above Delete');
  assert.equal(seps[0]?.textContent, '', 'a hairline says nothing');
  assert.match(stripComments(cmSection()), /\.cm-sep\s*\{[^}]*background: var\(--color-neutral-800\)/);
});
