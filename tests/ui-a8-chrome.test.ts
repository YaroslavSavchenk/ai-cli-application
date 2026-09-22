/**
 * Nocturne A8, phase 1 — the chrome half: the app shell sections of
 * `web/src/styles/app.css` (base, status dots, keyframes, topbar, middle row,
 * pane area, split dividers, pane card/header, terminal card, pane status bar,
 * background agents, empty state, tab strip, drag & drop, statusline, boot
 * overlay and the boot/restart takeover panels) plus `web/src/main.ts`'s boot
 * surfaces.
 *
 * What it pins:
 *
 *   1. TOKENS ONLY. Every `var(--x)` in those sections is declared in
 *      tokens.css — the same check the A4 and A7 block tests make for their own
 *      blocks. Phase 2 deleted the alias layer, so this is a typo guard: a
 *      var() naming no token resolves to nothing at runtime.
 *   2. THE DELETED NAMES have zero users left anywhere under web/src: the
 *      theme popover's classes, the `scanlines-on` body class, and the whole
 *      Legacy `.btn` family (ghost, green "go", accent tint, link) whose last
 *      users were the boot panel's Reload and the update surfaces.
 *   3. THE BOOT SURFACES stay honest: four step rows, three real marks
 *      (spinner / green check / red ×), a message only on a failed row, and
 *      the two takeover panels' action is the accent outline.
 *   4. THE BOOT COPY is plain sentences — the 2026-07-25 UI copy rule. The
 *      Legacy lowercase fragments (`token check`, `attach ws`, `backend
 *      restarted — reload`) may not come back.
 *
 * Source inspection only — no DOM, no server.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  APP_CSS,
  TOKENS_CSS,
  WEB_SRC,
  declaredTokens,
  frontendFiles,
  mySections as sectionsNamed,
  stripComments,
  usedTokens,
  RUNTIME_PROPS,
} from './tokens-helpers.ts';

const MAIN_TS = readFileSync(join(WEB_SRC, 'main.ts'), 'utf8');

/** The .ts sources, the stylesheets and the page. */
const FILES = frontendFiles(['.ts', '.css']);

/** The section titles Developer A owns in phase 1, by their opening words. */
const MINE = [
  'base',
  'status dots',
  'keyframes',
  'topbar (Nocturne A2)',
  'middle row',
  'pane area (Nocturne A3)',
  'split dividers',
  'pane card',
  'pane header (38px)',
  'terminal card',
  'pane status bar',
  'background agents',
  'empty state',
  'tab strip (Nocturne A2)',
  'drag & drop',
  'statusline (Nocturne A2)',
  'boot overlay (honest steps',
  'boot / restart takeover panels',
];

const mySections = (): ReturnType<typeof sectionsNamed> => sectionsNamed(MINE);

/** Comments hold prose that NAMES tokens and classes; only rules count. */
const strip = stripComments;

test('non-vacuity: the stylesheet, the tokens, main.ts and every frontend file are really read', () => {
  assert.ok(APP_CSS.length > 50_000, `app.css looks empty: ${APP_CSS.length} chars`);
  assert.ok(TOKENS_CSS.length > 5_000, `tokens.css looks empty: ${TOKENS_CSS.length} chars`);
  assert.ok(MAIN_TS.includes('function createBootPanel'), 'main.ts must still build the boot panel');
  assert.ok(FILES.length >= 20, `only ${FILES.length} frontend files found`);
  const mine = mySections();
  assert.equal(mine.length, MINE.length);
  for (const s of mine) assert.ok(s.body.length > 40, `${s.title} looks empty at app.css:${s.at}`);
});

test('tokens only: every var() in the chrome sections is declared in tokens.css', () => {
  const declared = declaredTokens();
  assert.ok(declared.size >= 100, `non-vacuity: ${declared.size} tokens declared`);

  const offenders: string[] = [];
  const used = new Set<string>();
  for (const s of mySections()) {
    for (const name of usedTokens(strip(s.body))) {
      if (name in RUNTIME_PROPS) continue;
      used.add(name);
      if (!declared.has(name)) offenders.push(`${s.title}: ${name}`);
    }
  }
  assert.ok(used.size >= 25, `non-vacuity: only ${used.size} tokens used by the chrome sections`);
  // The runtime exceptions really are written by a module, not forgotten tokens.
  const panes = readFileSync(join(WEB_SRC, 'ui', 'panes.ts'), 'utf8');
  for (const [prop, why] of Object.entries(RUNTIME_PROPS)) {
    assert.ok(panes.includes(`'${prop}'`), `stale RUNTIME_PROPS entry (${why}): ${prop}`);
    assert.equal(declared.has(prop), false, `${prop} is state, not a token`);
  }
  assert.deepEqual(offenders, [], `a chrome rule reads a token that is declared nowhere:\n  ${offenders.join('\n  ')}`);
});

test('the theme popover is gone: its classes have zero users anywhere under web/src', () => {
  const gone = [
    'theme-pop',
    'theme-grid',
    'theme-sw',
    'theme-sw-fg',
    'theme-lb',
    'theme-note',
    'theme-scan',
    'scanlines-on',
  ];
  const offenders: string[] = [];
  for (const c of gone) {
    for (const f of FILES) {
      const re = f.name.endsWith('.css')
        ? new RegExp(`\\.${c}(?![\\w-])`)
        : new RegExp(`['\`" ]${c}(?![\\w-])`);
      if (re.test(strip(f.src))) offenders.push(`${f.name} ${c}`);
    }
  }
  assert.deepEqual(offenders, [], `the deleted theme popover is still referenced: ${offenders.join('; ')}`);
  // Non-vacuity: the regexes DO find a class that is really there.
  assert.match(strip(APP_CSS), /\.boot-mark(?![\w-])/);
  assert.ok(FILES.some((f) => f.name === 'web/src/main.ts' && f.src.includes("'boot-mark is-spin'")));
});

test('ui/theme.ts is the terminal-colours machinery, with no DOM of its own', () => {
  const theme = readFileSync(join(WEB_SRC, 'ui', 'theme.ts'), 'utf8');
  const code = strip(theme).replace(/^\s*\/\/.*$/gm, '');
  // The load/apply/reconcile machinery part B9 wired up.
  for (const keep of ['function loadState', 'function saveState', 'function apply', 'function send', 'export function initTheme']) {
    assert.ok(code.includes(keep), `ui/theme.ts must keep ${keep}`);
  }
  assert.match(
    code,
    /updatePrefs\(\{ theme \}, DEAD_PREFS_KEYS\)/,
    'the merged PUT of the theme stays, and drops the retired keys like every other writer',
  );
  // No popover: nothing here builds an element or a button any more — the page
  // (ui/term-colours.ts) owns every element and drives this module's control.
  for (const bad of ['el(', 'button(', 'classList', 'appendChild', 'addEventListener', 'getBoundingClientRect']) {
    assert.equal(code.includes(bad), false, `ui/theme.ts must not build DOM: ${bad}`);
  }
  // WIRED since part B9: main.ts applies the theme before it builds a terminal.
  assert.ok(MAIN_TS.includes('initTheme(prefs)'), 'main.ts wires the theme from the boot prefs bag');
  assert.ok(
    MAIN_TS.indexOf('initTheme(prefs)') < MAIN_TS.indexOf('initPanes('),
    'initTheme must run BEFORE initPanes, so a terminal is born in the chosen colours',
  );
});

test('the Legacy .btn family is gone; .btn-accent / .btn-quiet is the one shared pair', () => {
  const rules = strip(APP_CSS);
  // The whole "shared form bits" block died in A8: the boot panel's Reload
  // moved to the accent outline, and the update toast / restart confirmation
  // moved to the same pair, which left every one of these without a setter.
  for (const re of [/\.btn\s*[,{]/, /\.btn\.is-primary/, /\.btn\.is-acc/, /\.btn-link/]) {
    assert.equal(re.test(rules), false, `app.css still carries a Legacy button rule: ${String(re)}`);
  }
  for (const f of FILES) {
    if (f.name.endsWith('.css')) continue;
    assert.equal(
      /button\('btn['\s,]/.test(f.src) || /['"`]btn (?:is-primary|is-acc)/.test(f.src) || /['"`]btn-link/.test(f.src),
      false,
      `${f.name} still sets a deleted Legacy button class`,
    );
  }
  // The pane banner's own primary keeps the name — a different base class.
  assert.match(rules, /\.pane-note-btn\.is-primary/);
  // And the surviving pair is styled AND set.
  for (const cls of ['btn-accent', 'btn-quiet']) {
    assert.match(rules, new RegExp(`\\.${cls}\\s*[,{]`), `app.css must style .${cls}`);
    assert.ok(
      FILES.some((f) => !f.name.endsWith('.css') && f.src.includes(`'${cls}'`)),
      `.${cls} has a rule but no module sets it`,
    );
  }
});

test('the boot panel keeps four honest rows, three real marks and one message slot', () => {
  const labels = [...MAIN_TS.matchAll(/panel\.step\('([^']+)'\)/g)].map((m) => m[1] as string);
  assert.deepEqual(labels, [
    'Reaching the background service',
    'Loading projects and sessions',
    'Opening the live connection',
    'Loading the terminal font',
  ]);
  // The marks are state, not decoration: a spinner only while pending.
  assert.ok(MAIN_TS.includes("el('span', 'boot-mark is-spin')"), 'a pending row spins');
  assert.match(MAIN_TS, /mark\.className = 'boot-mark is-ok';\s*\n\s*mark\.textContent = '✓';/);
  assert.match(MAIN_TS, /mark\.className = 'boot-mark is-err';\s*\n\s*mark\.textContent = '×';/);
  // The message belongs to a failed row only.
  assert.match(MAIN_TS, /msg\.hidden = true;/);
  assert.match(MAIN_TS, /msg\.textContent = m;\s*\n\s*msg\.hidden = false;/);
  // And the CSS gives each mark its own meaning, from the semantic tokens.
  const boot = mySections().filter((s) => s.title.startsWith('boot'));
  const css = strip(boot.map((s) => s.body).join('\n'));
  assert.match(css, /\.boot-mark\.is-spin \{[^}]*animation: spin var\(--t-spin\) linear infinite;/);
  assert.match(css, /\.boot-mark\.is-ok \{\s*color: var\(--color-ok\);/);
  assert.match(css, /\.boot-mark\.is-err \{\s*color: var\(--color-danger\);/);
  assert.match(css, /\.boot-overlay \{[\s\S]*?background: var\(--color-term\);/);
  assert.match(css, /\.boot-panel \{[\s\S]*?width: min\(var\(--panel-w\), 92vw\);/);
});

test('every boot- class main.ts sets has a rule, and every boot- rule has a setter', () => {
  const inTs = new Set(
    [...MAIN_TS.matchAll(/'((?:boot)-[a-z0-9- ]+)'/g)]
      .flatMap((m) => (m[1] as string).split(/\s+/))
      .filter((c) => c.startsWith('boot-')),
  );
  const inCss = new Set([...strip(APP_CSS).matchAll(/\.(boot-[a-z0-9-]+)/g)].map((m) => m[1] as string));
  assert.ok(inTs.size >= 7 && inCss.size >= 7, `non-vacuity: ts ${inTs.size}, css ${inCss.size}`);
  assert.deepEqual([...inTs].filter((c) => !inCss.has(c)).sort(), [], 'a boot class with no rule');
  assert.deepEqual([...inCss].filter((c) => !inTs.has(c)).sort(), [], 'a boot rule nothing sets');
});

test('the boot copy is plain sentences — the Legacy fragments are gone', () => {
  // Every string the boot surfaces put on screen: the step labels, the row
  // failures, the two fatal sentences and the takeover panel.
  const shown = [
    ...[...MAIN_TS.matchAll(/panel\.step\('([^']+)'\)/g)].map((m) => m[1] as string),
    ...[...MAIN_TS.matchAll(/step[A-Za-z]+\.fail\('([^']+)'\)/g)].map((m) => m[1] as string),
    ...[...MAIN_TS.matchAll(/panel\.fatal\(\s*'([^']+)',?\s*\)/g)].map((m) => m[1] as string),
    ...[...MAIN_TS.matchAll(/'(boot-err-(?:hd|msg))',\s*\n?\s*'([^']+)'/g)].map((m) => m[2] as string),
  ];
  assert.ok(shown.length >= 9, `non-vacuity: only ${shown.length} boot literals found`);
  const offenders = shown.filter((s) => !/^[A-Z]/.test(s));
  assert.deepEqual(offenders, [], `boot copy starts as a sentence: ${offenders.join(' | ')}`);
  // Comments explain the mechanism and may name the old steps; only the code
  // puts words on a screen.
  const code = strip(MAIN_TS).replace(/^\s*\/\/.*$/gm, '');
  for (const dead of [
    "'token check'",
    "'hydrate sessions'",
    "'attach ws'",
    'backend restarted —',
    'backend unreachable',
    'reload to reattach',
  ]) {
    assert.equal(code.includes(dead), false, `the Legacy boot fragment ${dead} is gone`);
  }
  // The takeover action is the app-wide accent outline, never a filled button.
  assert.equal([...MAIN_TS.matchAll(/button\('btn-accent', 'Reload'/g)].length, 2, 'both takeovers offer Reload');
});
