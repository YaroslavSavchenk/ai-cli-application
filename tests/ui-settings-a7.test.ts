/**
 * Nocturne part A7 — the STYLE contract of the Settings panel, pinned by source
 * inspection, in the manner of `tests/ui-launch-a4.test.ts` (which does the same
 * for the New session dialog). Behaviour is driven for real in
 * `tests/ui-settings-panel.test.ts`; the colour model in
 * `tests/ui-term-colours-model.test.ts`. What is left for a source pin:
 *
 *   1. PRIMITIVES ONLY. Every `var(--x)` in the panel's `sg-` block must be
 *      declared ABOVE the `LEGACY ALIAS LAYER` marker in tokens.css — or be one
 *      of the few named exceptions below, each with its reason. Part A8 deletes
 *      that layer.
 *   2. NO HARDCODED COLOR in the block (tokens.css: "Never hardcode a color
 *      outside this file"). The Terminal colours page's chosen hexes are DATA
 *      and arrive inline from ui/term-colours.ts, never from here.
 *   3. CLASS PARITY. Every `sg-` class settings.ts / term-colours.ts puts on an
 *      element has a rule, and every `sg-` selector in app.css is still used —
 *      no dead rules into A8, no unstyled class.
 *   4. The modal is TOP-anchored (the page swaps under one fixed top edge).
 *   5. The Legacy settings classes A7 removed are gone from both sides, and the
 *      block header `tests/ui-launch-a4.test.ts` uses as its own end marker is
 *      still there.
 *
 * Looks, sizes, and whether it reads right stay manual
 * (`.claude/skills/verify-terminal/SKILL.md`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { projectRoot } from './helpers.ts';

const UI = join(projectRoot, 'web', 'src', 'ui');
const STYLES = join(projectRoot, 'web', 'src', 'styles');
const read = (p: string): string => readFileSync(p, 'utf8');

const APP_CSS = read(join(STYLES, 'app.css'));
const TOKENS_CSS = read(join(STYLES, 'tokens.css'));
const SETTINGS = read(join(UI, 'settings.ts'));
const COLOURS = read(join(UI, 'term-colours.ts'));

/** The block header `tests/ui-launch-a4.test.ts` uses as ITS end marker — it may never be reworded here. */
const BLOCK_START = '/* ---- settings panel (status line)';
/** The block's own sub-headers share the `/* ---- ` shape, so A7 ends it with an explicit sentinel. */
const BLOCK_END = '/* ---- settings panel: END of the primitives-only sg- block';
const start = APP_CSS.indexOf(BLOCK_START);
const end = APP_CSS.indexOf(BLOCK_END, start + BLOCK_START.length);
const SG_CSS = start === -1 || end === -1 ? '' : APP_CSS.slice(start, end);
/** Comments out: a comment may NAME what the rules may not use. */
const SG_RULES = SG_CSS.replace(/\/\*[\s\S]*?\*\//g, '');

const LEGACY_MARK = 'LEGACY ALIAS LAYER';
const legacyAt = TOKENS_CSS.indexOf(LEGACY_MARK);

function declared(src: string): Set<string> {
  return new Set([...src.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((m) => m[1] as string));
}
const PRIMITIVES = declared(TOKENS_CSS.slice(0, legacyAt));
const LEGACY_LAYER = declared(TOKENS_CSS.slice(legacyAt));

/**
 * Tokens the block uses that are declared BELOW the Legacy marker. Each is a
 * structural or type value with no primitive twin today — the same three the A4
 * dialog block needs (see BELOW_MARKER_ALLOWED there); A8 must keep or re-home
 * exactly these.
 */
const BELOW_MARKER_ALLOWED: Record<string, string> = {
  '--line': 'the 1px hairline width; Nocturne has no border-width primitive',
  '--tick': 'the 2px focus-ring width; Nocturne has no outline-width primitive',
  '--font-mono': 'the JetBrains Mono stack A1 declared; no font primitive above the marker',
};

test('non-vacuity: the A7 block and the token split are really being read', () => {
  assert.notEqual(start, -1, `app.css must carry the "${BLOCK_START}" section`);
  assert.notEqual(end, -1, `the block must still end with "${BLOCK_END}"`);
  assert.ok(SG_RULES.length > 3000, 'the sg- block looks empty');
  assert.ok(SG_RULES.includes('.sg-modal'), 'the block must style .sg-modal');
  assert.ok(SG_RULES.includes('.sg-nav'), 'the block must style the left nav');
  assert.notEqual(legacyAt, -1, `tokens.css must still carry the "${LEGACY_MARK}" marker`);
  assert.ok(PRIMITIVES.has('--color-accent') && PRIMITIVES.has('--space-4'), 'primitives parsed');
  assert.ok(LEGACY_LAYER.has('--text-mute') && LEGACY_LAYER.has('--edge'), 'legacy names parsed');
});

test('primitives only: every var() in the sg- block is a Nocturne primitive or a named exception', () => {
  const used = [...new Set([...SG_RULES.matchAll(/var\(\s*(--[a-z0-9-]+)/g)].map((m) => m[1] as string))];
  assert.ok(used.length >= 10, `non-vacuity: found ${used.length} tokens`);
  const offenders = used.filter((t) => !PRIMITIVES.has(t) && !(t in BELOW_MARKER_ALLOWED));
  assert.deepEqual(
    offenders,
    [],
    'the Settings panel must not reach into the Legacy alias layer (A8 deletes it). Offenders: ' +
      offenders.join(', '),
  );
  // Every token used must exist at all (a typo'd var() silently falls back).
  for (const t of used) assert.ok(PRIMITIVES.has(t) || LEGACY_LAYER.has(t), `${t} is declared nowhere`);
});

test('the below-marker exceptions are real and still used (no stale entry)', () => {
  for (const [t, why] of Object.entries(BELOW_MARKER_ALLOWED)) {
    assert.ok(LEGACY_LAYER.has(t), `${t} is not below the marker any more — drop the exception`);
    assert.ok(SG_RULES.includes(`var(${t})`), `${t} is no longer used by the block — drop the exception`);
    assert.ok(why.length > 10, t);
  }
});

test('no hardcoded color in the sg- block (the page’s chosen hexes are inline DATA)', () => {
  const hits = [...SG_RULES.matchAll(/#[0-9a-fA-F]{3,8}\b|\b(rgba?|hsla?|oklch)\(/g)].map((m) => m[0]);
  assert.deepEqual(hits, [], 'colors come from tokens.css only');
  // And the module that DOES carry hexes hands them to style.setProperty, never
  // to a class — so nothing in app.css has to know them.
  assert.match(COLOURS, /style\.setProperty\(/, 'term-colours.ts sets the chosen colours inline');
});

/** Every `selector { declarations }` pair in the block, innermost (so @media bodies too). */
function sgRules(): { sel: string[]; body: string }[] {
  return [...SG_RULES.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    sel: (m[1] as string).split(',').map((s) => s.trim()).filter((s) => s !== ''),
    body: m[2] as string,
  }));
}

test('the modal is TOP-anchored, never vertically centred (the A4 lesson: a page swap must not move the box)', () => {
  const rules = sgRules();
  const boxRules = rules.filter((r) =>
    r.sel.some((s) => /\.sg-(?:scrim|modal)(?![\w-])/.test(s.split(/[\s>+~]+/).pop() as string)),
  );
  const scrimRules = boxRules.filter((r) => r.sel.some((s) => /\.sg-scrim(?![\w-])/.test(s)));
  assert.ok(boxRules.length >= 2 && scrimRules.length >= 1, `non-vacuity: ${boxRules.length} box rules`);
  // Own declaration, not inherited from the shared Legacy `.modal-scrim` rule
  // (other dialogs use that one; A8 may change it).
  assert.ok(
    scrimRules.some((r) => /(?:^|;)\s*align-items:\s*(?:flex-start|start)\s*(?:;|$)/.test(r.body)),
    '.sg-scrim must declare align-items: flex-start itself',
  );
  const offenders: string[] = [];
  for (const r of boxRules) {
    for (const decl of r.body.split(';').map((d) => d.trim()).filter((d) => d !== '')) {
      const [prop = '', val = ''] = decl.split(/:(.*)/s).map((x) => x.trim());
      const first = val.split(/\s+/)[0];
      const centred =
        (/^(?:align-items|align-self|align-content|place-items|place-self|place-content)$/.test(prop) &&
          /\bcenter\b/.test(val)) ||
        ((prop === 'margin' || prop === 'margin-block') && first === 'auto') ||
        ((prop === 'margin-top' || prop === 'margin-block-start') && /\bauto\b/.test(val)) ||
        (prop === 'flex-direction' && /column/.test(val) && r.sel.some((s) => s.includes('sg-scrim')));
      if (centred) offenders.push(`${r.sel.join(', ')} { ${decl} }`);
    }
  }
  assert.deepEqual(offenders, [], 'the Settings modal must keep a stable top edge');
});

test('the panel keeps the shared modal z-layer, so the restart confirmation still opens OVER it', () => {
  // app.css: `.restart-scrim { z-index: var(--z-modal-top) }` is only ABOVE the
  // settings panel while the panel sits on --z-modal, which it gets from the
  // shared `.modal-scrim` class. Dropping that class is the silent regression.
  assert.match(SETTINGS, /'modal-scrim sg-scrim'/, 'the settings scrim keeps the shared .modal-scrim class');
  assert.match(APP_CSS, /\.restart-scrim\s*\{[^}]*z-index:\s*var\(--z-modal-top\)/);
  assert.match(SG_RULES, /\.modal-scrim\.sg-scrim\s*\{/, 'the sg- scrim rule refines .modal-scrim rather than replacing it');
});

/** Every class name a module assigns through a string literal. */
function classesIn(src: string): Set<string> {
  const out = new Set<string>();
  for (const m of src.matchAll(/(['`])([^'`\n]*)\1/g)) {
    for (const c of (m[2] as string).replace(/\$\{[^}]*\}/g, ' ').split(/\s+/)) {
      // A template that BUILDS an id (`sg-tab-${id}`) leaves a trailing hyphen:
      // that is an id fragment, not a class.
      if (/^sg-[a-z0-9-]+$/.test(c) && !c.endsWith('-')) out.add(c);
    }
  }
  return out;
}

/**
 * `sg-`-prefixed strings that are ELEMENT IDS, not classes: they wire
 * aria-labelledby / aria-controls / a label's `for`, and an id needs no rule.
 * Each entry names what points at it.
 */
const ID_LITERALS: Record<string, string> = {
  'sg-tab-colours': 'the Terminal colours nav button, passed to buildTermColours as its aria-labelledby target',
  'sg-tc-schemes-lb': 'the Schemes label the preset radiogroup is labelled by',
  'sg-tc-ground': 'the Ground hex field, named by its <label for>',
  'sg-tc-text': 'the Text hex field, named by its <label for>',
};

test('class parity: every sg- class the panel sets has a rule, and every sg- rule is still used', () => {
  const inTs = new Set([...classesIn(SETTINGS), ...classesIn(COLOURS)]);
  const ids = new Set([
    ...Object.keys(ID_LITERALS),
    ...[...SETTINGS.matchAll(/\.id = '(sg-[a-z0-9-]+)'/g)].map((m) => m[1] as string),
    ...[...COLOURS.matchAll(/\.id = '(sg-[a-z0-9-]+)'/g)].map((m) => m[1] as string),
  ]);
  const inCss = new Set([...SG_RULES.matchAll(/\.(sg-[a-z0-9-]+)/g)].map((m) => m[1] as string));
  assert.ok(inTs.size >= 30 && inCss.size >= 30, `non-vacuity: ts ${inTs.size}, css ${inCss.size}`);
  const unstyled = [...inTs].filter((c) => !inCss.has(c) && !ids.has(c));
  const dead = [...inCss].filter((c) => !inTs.has(c));
  assert.deepEqual(unstyled, [], `the panel sets sg- classes no rule styles: ${unstyled.join(', ')}`);
  assert.deepEqual(dead, [], `app.css styles sg- classes the panel never sets: ${dead.join(', ')}`);
  for (const [id, why] of Object.entries(ID_LITERALS)) {
    assert.ok(SETTINGS.includes(id) || COLOURS.includes(id), `stale id entry: ${id}`);
    assert.ok(why.length > 10, id);
  }
});

test('the Legacy settings classes A7 replaced are gone from app.css and every frontend module', () => {
  const removed = [
    'settings-body',
    'settings-sect',
    'settings-note',
    'settings-notice',
    'settings-items',
    'settings-rowcap',
    'settings-keys',
    'settings-keyrow',
    'settings-keychips',
    'settings-keygesture',
    'settings-actionrow',
    'settings-facts',
    'settings-fact',
    'settings-ft',
    'settings-modal',
    // The shared boolean-row idiom: A7 moved the panel onto .sg-row, and the
    // two dialogs that shared it moved too — so the whole family is gone.
    'status-rows',
    'status-row',
    'status-box',
    'status-lb',
    'status-sample',
  ];
  const tsFiles = readdirSync(UI)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => [f, read(join(UI, f))] as const);
  tsFiles.push(['main.ts', read(join(projectRoot, 'web', 'src', 'main.ts'))]);
  const offenders: string[] = [];
  for (const c of removed) {
    if (new RegExp(`\\.${c}\\b`).test(APP_CSS)) offenders.push(`app.css .${c}`);
    for (const [f, src] of tsFiles) if (new RegExp(`['\` ]${c}\\b`).test(src)) offenders.push(`${f} ${c}`);
  }
  assert.deepEqual(offenders, []);
});

test('the five pages are the nav, in the plan’s order, and the gear opens the first', () => {
  const ids = [...SETTINGS.matchAll(/\{ id: '([a-z]+)', label: '([^']+)' \}/g)].map(
    (m) => [m[1] as string, m[2] as string] as const,
  );
  assert.deepEqual(ids, [
    ['status', 'Status bar'],
    ['prefs', 'Preferences'],
    ['keys', 'Keyboard'],
    ['colours', 'Terminal colours'],
    ['service', 'Background service'],
  ]);
  assert.match(SETTINGS, /showPage\(PAGES\[0\]\.id\)/, 'open() shows the first page');
});

test('every existing wire is still in the panel (A7 is a restyle, not a rewrite)', () => {
  for (const [needle, what] of [
    ['api.updatePrefs(statusLinePatch(cfg), DEAD_PREFS_KEYS)', 'the statusLine prefs write'],
    ['api\n      .getPrefs()', 'the re-read on open'],
    ['sessionsWithoutStatusLine', 'the notice for sessions without a status line'],
    ['openReleasesPage()', 'Check for updates'],
    ["openRestartConfirm('settings')", 'the restart confirmation'],
    ['deps.openShortcuts()', 'the all-shortcuts link'],
    ['statusLineDefaults()', 'Reset to defaults'],
    ['trapTab(modal)', 'the focus trap'],
  ] as const) {
    assert.ok(SETTINGS.includes(needle), `${what} must still be wired (${needle})`);
  }
});

test('the mock pages each carry exactly ONE honesty line, through one function', () => {
  for (const [src, name, fn, line] of [
    [SETTINGS, 'settings.ts', 'prefsPlaceholderNote', 'Example settings until the app saves them.'],
    [
      COLOURS,
      'term-colours.ts',
      'placeholderNote',
      'Example colours until the app applies them to your terminals.',
    ],
  ] as const) {
    assert.ok(src.includes(line), `${name} must say: ${line}`);
    const calls = [...src.matchAll(new RegExp(`${fn}\\(\\)`, 'g'))].length;
    assert.equal(calls, 2, `${name}: ${fn} is one definition and one call site`);
  }
});

test('the Terminal colours page never touches :root, a terminal, or prefs in A7 (part B9 owns that)', () => {
  // Comments stripped: the file header NAMES what part B9 will wire, which is
  // documentation, not a reach.
  const code = COLOURS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const bad of ['documentElement', 'refreshAllTerminalThemes', 'updatePrefs', 'theme.ts', 'terminal.ts']) {
    assert.equal(code.includes(bad), false, `A7 must not reach for ${bad}`);
  }
  assert.ok(code.length > 2000, `non-vacuity: ${code.length} chars of code scanned`);
  // It reads the tables it previews from, and nothing else.
  assert.match(COLOURS, /from '\.\/term-colours-model\.ts'/);
});
