/**
 * Nocturne A8, phase 2 — the token vocabulary itself, after the Legacy alias
 * layer was deleted.
 *
 * Parts A1-A7 recoloured the Legacy UI through an alias block at the bottom of
 * `web/src/styles/tokens.css`: 84 old role names (`--text`, `--edge`, `--acc`,
 * `--s-4`, `--fs-row`, `--r-btn`, …) re-pointed at Nocturne values so a surface
 * nobody had rewritten yet still looked right. A8 migrated every use site and
 * deleted the block, its marker and those names. CSS makes both halves of that
 * silent: an undeclared `var(--x)` resolves to nothing (a missing colour, not
 * an error), and a declared token nobody reads is dead weight that the next
 * reader takes for a rule. This file is the standing guard for both.
 *
 *   (a) the marker text is gone from web/src, and from tests/ except where a
 *       test asserts its absence;
 *   (b) every `var(--x)` in app.css / fonts.css and every `--x` string literal
 *       in web/src TS + web/index.html is declared in tokens.css;
 *   (c) every token tokens.css declares has at least one reader, with one
 *       explicit allow-list: the handoff ramp steps A1 (a) forces the file to
 *       carry verbatim;
 *   (d) the 89 retired names have zero users anywhere in web/src and are
 *       declared nowhere;
 *   (e) non-vacuity on every scan.
 *
 * Source inspection only — no DOM, no server.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { projectRoot } from '../helpers/helpers.ts';
import {
  APP_CSS,
  INDEX_HTML_PATH,
  WEB_SRC,
  declaredTokens,
  frontendFiles,
  stripComments,
  usedTokens,
  RUNTIME_PROPS,
} from '../helpers/tokens-helpers.ts';

const FONTS_CSS = readFileSync(join(WEB_SRC, 'styles', 'fonts.css'), 'utf8');
const INDEX_HTML = readFileSync(INDEX_HTML_PATH, 'utf8');

const MARKER = ['LEGACY', 'ALIAS', 'LAYER'].join(' ');

/**
 * Every file the frontend is built from: TS and CSS under web/src, plus the
 * page. The bundled woff2 faces are binaries — reading them as text would put
 * megabytes of noise through every scan below and prove nothing.
 */
const FILES = frontendFiles(['.ts', '.css']);
const TS_FILES = FILES.filter((f) => f.name.endsWith('.ts'));
const DECLARED = declaredTokens();

/**
 * The 89 names A8 retired: the 84 alias names that died with the marker block
 * (`git show HEAD:web/src/styles/tokens.css`), the two green-button tints that
 * phase 1's deletion of the Legacy `.btn` family left with no reader
 * (`--color-ok-tint-hover`, `--color-ok-glow`), `--z-popover` (the theme
 * popover's layer, deleted with the popover — `.theme-pop` was its only user),
 * and the two names the projects drawer's migration onto the Sessions panel's
 * 24px `.row-btn` / `.row-x` idiom left with no reader: `--chip-h` (the chip
 * height) and `--color-ok-text` (the green ink of the deleted "go" chip's
 * word). None may be declared again, and none may be read.
 */
const RETIRED = [
  '--acc', '--acc-glow', '--acc-sel', '--acc-tint', '--attn', '--attn-tint', '--bg-app',
  '--bg-deep', '--chip-h', '--color-ok-glow', '--color-ok-text', '--color-ok-tint-hover',
  '--ctl-h-lg', '--danger',
  '--danger-edge', '--danger-ink', '--danger-mut', '--danger-tint', '--dlg-gap', '--dlg-pad-x',
  '--edge', '--edge-accent', '--edge-hover', '--edge-mid', '--edge-soft', '--edge-strong',
  '--exit', '--field-h', '--fs-label', '--fs-micro', '--fs-name', '--fs-row', '--fs-status',
  '--fs-tab', '--fs-tag', '--fs-title', '--fs-ui', '--grad-dialoghd', '--grad-panearea',
  '--grad-topbar', '--ls-label', '--ls-title', '--ls-wordmark', '--modal-w', '--modal-w-narrow',
  '--modal-w-wide', '--modalhd-h', '--ok', '--ok-glow', '--ok-text', '--ok-tint',
  '--ok-tint-hover', '--popover-w', '--r-box', '--r-btn', '--r-card', '--r-card-sm', '--r-field',
  '--r-input', '--r-pill', '--r-tab', '--restart-list-h', '--s-1', '--s-2', '--s-3', '--s-4',
  '--s-5', '--s-6', '--s-7', '--s-8', '--sc-keys-w', '--scrim', '--sh-dialog', '--sh-ghost',
  '--sh-pane', '--sh-popover', '--surface', '--surface-active', '--surface-hover',
  '--surface-panehd', '--surface-status', '--text', '--text-2', '--text-dim', '--text-faint',
  '--text-hd', '--text-mute', '--well', '--z-popover',
];

/**
 * Tokens with no reader that STAY. `tests/ui/nocturne-tokens.test.ts` (a) requires
 * tokens.css to carry every `--color-*` primitive of the design handoff with
 * the handoff's own value, and the handoff's ramps are complete ramps — the UI
 * uses the steps it needs and the rest are the palette's definition, not dead
 * code. Anything NOT in this list needs a reader or it goes.
 */
const UNREAD_BY_DESIGN: Record<string, string> = {
  '--color-accent-2': 'handoff primitive (secondary blurple); ramp steps below are its scale',
  '--color-divider': 'handoff primitive — the app draws every hairline with --color-neutral-900 instead',
  '--color-neutral-100': 'handoff ramp step — the lightest neutral, spelled into --xt-bright-white as a hex',
  '--color-accent-100': 'handoff ramp step',
  '--color-accent-400': 'handoff ramp step',
  '--color-accent-500': 'handoff ramp step',
  '--color-accent-600': 'handoff ramp step',
  '--color-accent-2-100': 'handoff ramp step',
  '--color-accent-2-200': 'handoff ramp step',
  '--color-accent-2-300': 'handoff ramp step',
  '--color-accent-2-400': 'handoff ramp step',
  '--color-accent-2-500': 'handoff ramp step',
  '--color-accent-2-600': 'handoff ramp step',
  '--color-accent-2-700': 'handoff ramp step',
  '--color-accent-2-800': 'handoff ramp step',
  '--color-accent-2-900': 'handoff ramp step',
};

/** Does anything in the frontend read this token by name? */
function readers(token: string): string[] {
  const out: string[] = [];
  for (const f of FILES) {
    // Comments NAME tokens (this header, every block comment in app.css); only
    // code counts as a reader, in every file and not just tokens.css.
    const body = stripComments(f.src);
    const read =
      body.includes(`var(${token})`) ||
      body.includes(`var( ${token}`) ||
      (f.name.endsWith('.ts') && new RegExp(`['"\`]${token}['"\`]`).test(body));
    if (read) out.push(f.name);
  }
  return out;
}

test('(e) non-vacuity: the stylesheets, the tokens and every frontend file are really read', () => {
  assert.ok(DECLARED.size >= 100, `only ${DECLARED.size} tokens declared`);
  assert.ok(usedTokens(APP_CSS).length >= 400, `only ${usedTokens(APP_CSS).length} var() uses in app.css`);
  assert.ok(APP_CSS.length > 50_000, `app.css looks empty: ${APP_CSS.length} chars`);
  assert.ok(FONTS_CSS.includes('@font-face'), 'fonts.css must be the face file');
  assert.ok(TS_FILES.length >= 20, `only ${TS_FILES.length} TS files found`);
  assert.ok(INDEX_HTML.includes('<html'), 'the page must be read');
  assert.ok(RETIRED.length === 89, `the retired list is the A8 record: ${RETIRED.length}`);
});

test('(a) the alias marker text survives nowhere in the frontend', () => {
  const offenders = FILES.filter((f) => f.src.includes(MARKER)).map((f) => f.name);
  assert.deepEqual(offenders, [], `the deleted alias block is still named in: ${offenders.join(', ')}`);
  // In tests/ only the file that asserts its absence may spell it (plus this
  // one, which builds the string from parts so the scan below stays honest).
  const allowed = new Set(['nocturne-tokens.test.ts', 'ui-a8-tokens.test.ts']);
  const dir = join(projectRoot, 'tests');
  const stale = readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((n) => n.endsWith('.ts') && !allowed.has(basename(n)))
    .filter((n) => readFileSync(join(dir, n), 'utf8').includes(MARKER));
  assert.deepEqual(stale, [], `a test still splits tokens.css at the deleted marker: ${stale.join(', ')}`);
  // Non-vacuity: the guard that DOES spell it is really there.
  assert.ok(
    readFileSync(join(dir, 'ui', 'nocturne-tokens.test.ts'), 'utf8').includes(MARKER),
    'nocturne-tokens.test.ts asserts the marker is gone, so it must still name it',
  );
});

test('(b) every token the frontend reads is declared in tokens.css', () => {
  const offenders: string[] = [];
  for (const [name, css] of [
    ['web/src/styles/app.css', APP_CSS],
    ['web/src/styles/fonts.css', FONTS_CSS],
  ] as const) {
    for (const t of new Set(usedTokens(stripComments(css)))) {
      if (t in RUNTIME_PROPS) continue;
      if (!DECLARED.has(t)) offenders.push(`${name}: var(${t})`);
    }
  }
  // A TS file names a token only to read or write it through the CSSOM. CLI
  // flags look the same (`--continue`, `--model`), so only names that tokens.css
  // could plausibly own are checked: the ones a cssVar/setProperty call wraps.
  const CSSOM = /(?:cssVar|getPropertyValue|setProperty|removeProperty)\(\s*'(--[a-z0-9-]+)'/g;
  for (const f of TS_FILES) {
    for (const m of f.src.matchAll(CSSOM)) {
      const t = m[1] as string;
      if (t in RUNTIME_PROPS) continue;
      if (!DECLARED.has(t)) offenders.push(`${f.name}: ${t}`);
    }
  }
  for (const m of INDEX_HTML.matchAll(/var\(\s*(--[a-z0-9-]+)/g)) {
    const t = m[1] as string;
    if (!DECLARED.has(t)) offenders.push(`web/index.html: var(${t})`);
  }
  assert.deepEqual(offenders, [], `a var() that resolves to nothing:\n  ${offenders.join('\n  ')}`);
  // Non-vacuity: the CSSOM scan really finds the reads it exists for.
  const cssom = TS_FILES.flatMap((f) => [...f.src.matchAll(CSSOM)].map((m) => m[1] as string));
  for (const must of ['--xt-bg', '--font-mono', '--fs-term', '--term-bg']) {
    assert.ok(cssom.includes(must), `the CSSOM scan should have seen ${must}`);
  }
});

test('(c) every declared token has a reader, or a stated reason to exist unread', () => {
  const unread = [...DECLARED].filter((t) => readers(t).length === 0).sort();
  const unexplained = unread.filter((t) => !(t in UNREAD_BY_DESIGN));
  assert.deepEqual(
    unexplained,
    [],
    `tokens nothing reads — delete them or state why they stay:\n  ${unexplained.join('\n  ')}`,
  );
  // No stale excuse: every allow-list entry is still declared AND still unread.
  for (const [t, why] of Object.entries(UNREAD_BY_DESIGN)) {
    assert.ok(DECLARED.has(t), `stale UNREAD_BY_DESIGN entry (no longer declared): ${t}`);
    assert.ok(why.length > 10, `every entry states a reason: ${t}`);
    assert.deepEqual(readers(t), [], `${t} has a reader now — drop its allow-list entry`);
  }
  // Non-vacuity: the reader scan finds real readers of every kind.
  assert.ok(
    readers('--color-bg').some((n) => n.endsWith('app.css')),
    'a CSS-read token must show app.css as its reader',
  );
  assert.ok(readers('--term-bg').length >= 2, 'a token read from BOTH a stylesheet and a module');
  assert.ok(readers('--xt-red').some((n) => n.endsWith('terminal.ts')), 'a TS-read token must show terminal.ts');
});

test('(d) the retired Legacy names are declared nowhere and read nowhere', () => {
  const redeclared = RETIRED.filter((t) => DECLARED.has(t));
  assert.deepEqual(redeclared, [], `a retired alias is declared again: ${redeclared.join(', ')}`);
  const used: string[] = [];
  for (const t of RETIRED) {
    for (const f of FILES) {
      const body = stripComments(f.src);
      if (body.includes(`var(${t})`)) used.push(`${f.name}: var(${t})`);
      else if (f.name.endsWith('.ts') && new RegExp(`['"\`]${t}['"\`]`).test(body)) used.push(`${f.name}: ${t}`);
    }
  }
  assert.deepEqual(used, [], `a retired alias still has a reader:\n  ${used.join('\n  ')}`);
  // Non-vacuity: the same scan DOES find the live token that replaced one.
  assert.ok(stripComments(APP_CSS).includes('var(--color-neutral-500)'), 'the replacement of --text-mute is in use');
});
