/**
 * Nocturne A7 — the parity checks that span BOTH halves of the part and every
 * frontend module, next to the two per-block pin files
 * (`tests/ui/ui-settings-a7.test.ts` for the `sg-` block,
 * `tests/ui/ui-addproject-a7.test.ts` for the `ap-`/`gh-` block). Those two scope
 * their parity to their own CSS block and their own two modules, which leaves
 * three holes a real change can fall through:
 *
 *   1. A class whose ONLY rule lives OUTSIDE the A7 block (app.css already has
 *      one such rule: the `font-variant-ligatures: none` family that includes
 *      `.sg-tcprev`) — and, the other way round, a `sg-`/`ap-`/`gh-`/`pk-` rule
 *      anywhere in app.css that no module sets any more. Checked here over the
 *      WHOLE stylesheet and the WHOLE of web/src.
 *   2. The token vocabulary as ONE check: a single block test could be relaxed
 *      on its own, so the union of all three blocks is pinned here too. Since
 *      part A8 deleted the Legacy alias layer there is one vocabulary left, and
 *      a name outside it resolves to nothing at runtime.
 *   3. The `.status-*` family half (a) deleted, and the four Legacy rules the
 *      folder-picker restyle deleted (follow-up c): zero users anywhere under
 *      web/src (not only ui/*.ts + main.ts) and no rule left in app.css.
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
} from '../helpers/tokens-helpers.ts';
/** Comments hold prose that NAMES classes and tokens; only rules count. */
const APP_RULES = APP_CSS.replace(/\/\*[\s\S]*?\*\//g, '');

/** Every .ts under web/src, plus the one hand-written HTML page. */
const FILES = frontendFiles(['.ts']);

const PREFIXED = /^(?:sg|ap|gh|pk)-[a-z0-9-]+$/;

/** Class names a module assigns through a string literal, per file. */
function classesOf(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/(['"`])([^'"`\n]*)\1/g)) {
    for (const c of (m[2] as string).replace(/\$\{[^}]*\}/g, ' ').split(/\s+/)) {
      // A template that BUILDS an id (`sg-tab-${id}`) leaves a trailing hyphen.
      if (PREFIXED.test(c) && !c.endsWith('-')) out.push(c);
    }
  }
  return out;
}

/**
 * Prefixed id literals a module hands to a helper as an ARGUMENT, so no
 * `.id = '...'` assignment names them. Each entry says what makes it an id.
 */
const ID_ARGUMENTS: Record<string, string> = {
  'sg-tc-ground': "colourField('Ground', 'sg-tc-ground', …) — assigned as hex.id and as the label's htmlFor",
  'sg-tc-text': "colourField('Text', 'sg-tc-text', …) — assigned as hex.id and as the label's htmlFor",
};

/** Prefixed strings that are element IDS, not classes — an id needs no rule. */
function idsOf(src: string): string[] {
  const out: string[] = [];
  for (const re of [
    /\.id = '((?:sg|ap|gh|pk)-[a-z0-9-]+)'/g,
    /htmlFor = '((?:sg|ap|gh|pk)-[a-z0-9-]+)'/g,
    /'aria-(?:controls|labelledby|describedby)', '((?:sg|ap|gh|pk)-[a-z0-9-]+)'/g,
    // The one id a module is HANDED as an argument (buildTermColours' title id;
    // part B9 gave that call a second argument, the theme control).
    /buildTermColours\('((?:sg|ap|gh|pk)-[a-z0-9-]+)'[,)]/g,
  ]) {
    for (const m of src.matchAll(re)) out.push(m[1] as string);
  }
  return out;
}

test('non-vacuity: the stylesheet, the tokens and every frontend file are really being read', () => {
  assert.ok(APP_RULES.length > 50_000, `app.css looks empty: ${APP_RULES.length} chars`);
  assert.ok(FILES.length >= 20, `only ${FILES.length} frontend files found`);
  assert.ok(
    FILES.some((f) => f.name === 'web/src/ui/term-colours.ts'),
    'the A7 module list must include the new page',
  );
  assert.ok(
    FILES.some((f) => f.name === 'web/index.html'),
    'the page itself is scanned for classes too',
  );
});

test('class parity over the WHOLE stylesheet: no unstyled class, no dead rule, wherever the rule lives', () => {
  const inTs = new Map<string, string[]>();
  const ids = new Set<string>();
  for (const f of FILES) {
    for (const c of classesOf(f.src)) {
      const owners = inTs.get(c) ?? [];
      if (!owners.includes(f.name)) owners.push(f.name);
      inTs.set(c, owners);
    }
    for (const id of idsOf(f.src)) ids.add(id);
  }
  for (const [id, why] of Object.entries(ID_ARGUMENTS)) {
    // A stale entry would silently excuse a class from needing a rule.
    assert.ok(
      FILES.some((f) => f.src.includes(`'${id}'`)),
      `stale ID_ARGUMENTS entry: ${id}`,
    );
    assert.ok(why.length > 10, id);
    ids.add(id);
  }
  const inCss = new Map<string, number>();
  for (const m of APP_RULES.matchAll(/\.((?:sg|ap|gh|pk)-[a-z0-9-]+)/g)) {
    const name = m[1] as string;
    if (!inCss.has(name)) inCss.set(name, APP_RULES.slice(0, m.index).split('\n').length);
  }
  assert.ok(inTs.size >= 100 && inCss.size >= 100, `non-vacuity: ts ${inTs.size}, css ${inCss.size}`);

  const unstyled = [...inTs.keys()]
    .filter((c) => !inCss.has(c) && !ids.has(c))
    .map((c) => `${c} (set by ${(inTs.get(c) as string[]).join(', ')})`);
  assert.deepEqual(unstyled, [], `classes no rule styles: ${unstyled.join('; ')}`);

  const dead = [...inCss.keys()].filter((c) => !inTs.has(c)).map((c) => `${c} (app.css)`);
  assert.deepEqual(dead, [], `rules no module sets: ${dead.join('; ')}`);

  // The prefixes belong to exactly the four A7 modules — a fifth module reaching
  // into the Settings or Add-a-project styling is a boundary break, not a reuse.
  const owners = new Set([...inTs.values()].flat());
  assert.deepEqual(
    [...owners].sort(),
    [
      'web/src/ui/github.ts',
      'web/src/ui/newproject.ts',
      'web/src/ui/picker.ts',
      'web/src/ui/settings.ts',
      'web/src/ui/term-colours.ts',
    ],
    'only the A7 modules may wear the A7 prefixes',
  );
});

test('the three A7 blocks name no token that tokens.css does not declare', () => {
  const declared = declaredTokens();
  assert.ok(declared.size >= 100, `non-vacuity: ${declared.size} tokens declared`);

  const slice = (from: string, to: string): string => {
    const a = APP_CSS.indexOf(from);
    assert.notEqual(a, -1, `app.css must carry "${from}"`);
    const b = APP_CSS.indexOf(to, a + from.length);
    assert.notEqual(b, -1, `the block starting at "${from}" must end at "${to}"`);
    return APP_CSS.slice(a, b).replace(/\/\*[\s\S]*?\*\//g, '');
  };
  const blocks = [
    slice(
      '/* ---- settings panel (status line)',
      '/* ---- settings panel: END of the primitives-only sg- block',
    ),
    slice('/* ---- Add a project dialog (Nocturne A7)', '/* ---- folder picker (Phase 2a)'),
    // The folder picker, restyled in follow-up c: its own file allows three of
    // the four, so the union may not grow by admitting a fifth there either.
    slice('/* ---- folder picker (Phase 2a)', '/* ---- boot overlay (honest steps;'),
  ];
  const used = new Set<string>();
  for (const b of blocks) {
    assert.ok(b.length > 3000, `a block looks empty: ${b.length} chars`);
    for (const m of b.matchAll(/var\(\s*(--[a-z0-9-]+)/g)) used.add(m[1] as string);
  }
  assert.ok(used.size >= 15, `non-vacuity: ${used.size} tokens used by the three blocks`);
  const undeclared = [...used].filter((t) => !declared.has(t)).sort();
  assert.deepEqual(
    undeclared,
    [],
    'every token the A7 blocks use is declared in tokens.css; a name that is not resolves to nothing',
  );
});

test('the .status-* family half (a) deleted has zero users left in app.css or anywhere under web/src', () => {
  // A7 moved the shared boolean-row idiom onto `.sg-row` / `.ap-check`. These
  // five names may not survive anywhere, including the files the per-block test
  // does not read (web/src/*.ts, web/src/styles/*, web/index.html).
  const gone = ['status-rows', 'status-row', 'status-box', 'status-lb', 'status-sample'];
  const offenders: string[] = [];
  for (const c of gone) {
    const asSelector = new RegExp(`\\.${c}(?![\\w-])`);
    if (asSelector.test(APP_CSS)) offenders.push(`web/src/styles/app.css .${c}`);
    for (const f of FILES) {
      // A word-bounded match inside a string literal or a class attribute.
      if (new RegExp(`['\`" ]${c}(?![\\w-])`).test(f.src)) offenders.push(`${f.name} ${c}`);
    }
  }
  assert.deepEqual(offenders, [], `the retired status-* family is still referenced: ${offenders.join('; ')}`);
  // Non-vacuity: the replacements ARE there, so the regexes above are looking in
  // a file that really carries this kind of rule.
  assert.match(APP_RULES, /\.sg-row(?![\w-])/);
  assert.match(APP_RULES, /\.ap-check(?![\w-])/);
});

test('the four Legacy rules the folder-picker restyle deleted have zero users left, anywhere', () => {
  // Follow-up c rewrote `ui/picker.ts` to the `pk-` chrome and took the last
  // users of these four with it, plus the one token only the deleted list rule
  // read. `tests/ui/ui-picker-a7.test.ts` checks them against picker.ts and ui/*.ts;
  // this is the same check over the WHOLE stylesheet and EVERY frontend file —
  // web/src/*.ts and web/index.html included — so a rule cannot survive by
  // having a user the per-block test never reads.
  const gone = ['np-glyph', 'form-err', 'dirlist', 'dir-btn'];
  const offenders: string[] = [];
  for (const c of gone) {
    if (new RegExp(`\\.${c}(?![\\w-])`).test(APP_RULES)) offenders.push(`web/src/styles/app.css .${c}`);
    for (const f of FILES) {
      if (new RegExp(`['\`" ]${c}(?![\\w-])`).test(f.src)) offenders.push(`${f.name} ${c}`);
    }
  }
  assert.deepEqual(offenders, [], `the retired picker chrome is still referenced: ${offenders.join('; ')}`);
  // The token the deleted list rule was the only reader of.
  assert.equal(TOKENS_CSS.includes('--dirlist-min-h'), false, 'the list-height token went with the list rule');
  assert.equal(APP_RULES.includes('--dirlist-min-h'), false);
  // Non-vacuity: the replacements ARE there, in both halves of the check.
  assert.match(APP_RULES, /\.pk-row(?![\w-])/);
  assert.match(APP_RULES, /\.pk-err(?![\w-])/);
  assert.ok(
    FILES.some((f) => f.name === 'web/src/ui/picker.ts' && f.src.includes("'pk-row'")),
    'the rewritten picker is in the scanned file set',
  );
});

test('the A7 modules keep their colour decisions out of the stylesheet and vice versa', () => {
  // The only hexes in the A7 surface are DATA (a preset's own value, or what the
  // user picked) and they live in term-colours-model.ts / theme-model.ts, never
  // in a module that styles. A hex literal in settings.ts, term-colours.ts,
  // newproject.ts or github.ts would be a colour decision outside tokens.css.
  for (const name of [
    'web/src/ui/settings.ts',
    'web/src/ui/term-colours.ts',
    'web/src/ui/newproject.ts',
    'web/src/ui/github.ts',
  ]) {
    const f = FILES.find((x) => x.name === name);
    assert.ok(f !== undefined, name);
    const code = f.src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const hits = [...code.matchAll(/#[0-9a-fA-F]{6}\b|\b(?:rgba?|hsla?|oklch)\(/g)].map((m) => m[0]);
    assert.deepEqual(hits, [], `${name} must not carry a colour literal: ${hits.join(', ')}`);
    assert.ok(code.length > 500, `non-vacuity: ${name} (${code.length} chars)`);
  }
  // The model that DOES speak in hexes owns no palette of its own: its one
  // literal is the black `mixHex` falls back to, and every preset colour comes
  // from theme-model.ts's two tables (so this page previews what is painted).
  const model = readFileSync(join(WEB_SRC, 'ui', 'term-colours-model.ts'), 'utf8');
  const modelCode = model.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.deepEqual(
    [...modelCode.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]),
    ['#000000'],
    'the only hex in the model is the mixHex fallback',
  );
  assert.match(model, /from '\.\/theme-model\.ts'/, 'the presets are indexes into the theme tables');
});
