/**
 * Nocturne part A7 (half b) — the STYLE contract of the Add-a-project dialog,
 * pinned by source inspection (`.claude/plans/PLAN-NOCTURNE.md` §A7), in the manner
 * of `tests/ui/ui-launch-a4.test.ts`. The BEHAVIOUR behind the dialog is tested
 * elsewhere and unchanged by A7: the pure path/intent helpers in
 * `tests/ui/ui-newproject*.test.ts`, the GitHub model in
 * `tests/ui/ui-github-model.test.ts`, the real endpoints in
 * `tests/server/projects.test.ts` and `tests/server/github*.test.ts`. What is left for a
 * source pin:
 *
 *   1. TOKENS ONLY. Every `var(--x)` in the dialog's block must be declared in
 *      tokens.css. It was written against the Nocturne primitives and never the
 *      Legacy alias layer, which part A8 deleted, names and all; what is left
 *      is a typo guard — a var() naming nothing resolves to nothing at runtime.
 *   2. NO HARDCODED COLOR in the block (tokens.css: "Never hardcode a color
 *      outside this file").
 *   3. CLASS PARITY. Every `ap-`/`gh-` class newproject.ts or github.ts puts on
 *      an element has a rule in the block, and every such selector in the block
 *      is still used by one of the two modules — the block cannot carry dead
 *      rules into A8, nor either module a class nothing styles.
 *   4. The Legacy classes A7 removed are gone from both sides, and the copy
 *      rules that apply to this dialog hold (no fake percentage, no command).
 *
 * Looks, sizes, and whether it reads right stay manual.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { projectRoot } from '../helpers/helpers.ts';
import { declaredTokens, readAppCss, usedTokens } from '../helpers/tokens-helpers.ts';

const UI = join(projectRoot, 'web', 'src', 'ui');
const STYLES = join(projectRoot, 'web', 'src', 'styles');
const read = (p: string): string => readFileSync(p, 'utf8');

const APP_CSS = readAppCss();
const TOKENS_CSS = read(join(STYLES, 'tokens.css'));
const NEWPROJECT = read(join(UI, 'newproject.ts'));
const GITHUB = read(join(UI, 'github.ts'));

const BLOCK_START = '/* ---- Add a project dialog (Nocturne A7)';
/** The block's own sub-headers share the `/* ---- ` shape, so the end is the NEXT dialog's header. */
const BLOCK_END = '/* ---- folder picker (Phase 2a)';
const start = APP_CSS.indexOf(BLOCK_START);
const end = APP_CSS.indexOf(BLOCK_END, start + BLOCK_START.length);
const AP_CSS = start === -1 || end === -1 ? '' : APP_CSS.slice(start, end);
/** Comments out: a comment may NAME what the rules may not use. */
const AP_RULES = AP_CSS.replace(/\/\*[\s\S]*?\*\//g, '');

/** The whole token vocabulary — A8 phase 2 left exactly one set. */
const DECLARED = declaredTokens();

test('non-vacuity: the A7 block and the token vocabulary is really being read', () => {
  assert.notEqual(start, -1, `app.css must carry the "${BLOCK_START}" section`);
  assert.notEqual(end, -1, `the block must still be followed by "${BLOCK_END}"`);
  assert.ok(AP_RULES.length > 3000, 'the ap- block looks empty');
  assert.ok(AP_RULES.includes('.ap-modal'), 'the block must style .ap-modal');
  assert.ok(AP_RULES.includes('.gh-repo'), 'the block must style the GitHub tab too');
  assert.ok(DECLARED.has('--color-accent') && DECLARED.has('--space-4'), 'tokens parsed');
  assert.ok(DECLARED.size >= 100, `non-vacuity: ${DECLARED.size} tokens declared`);
});

test('tokens only: every var() in the ap- block is declared in tokens.css', () => {
  const used = [...new Set(usedTokens(AP_RULES))];
  assert.ok(used.length >= 10, `non-vacuity: found ${used.length} tokens`);
  const offenders = used.filter((t) => !DECLARED.has(t));
  assert.deepEqual(
    offenders,
    [],
    'a var() naming no declared token resolves to nothing at runtime. Offenders: ' +
      offenders.join(', '),
  );
});

test('non-vacuity: the block still consumes a token (the 1px hairline), so the scan is not empty', () => {
  assert.ok(AP_RULES.includes('var(--line)'), 'the block must still wear the 1px hairline width');
});

test('no hardcoded color in the ap- block', () => {
  const hits = [...AP_RULES.matchAll(/#[0-9a-fA-F]{3,8}\b|\b(rgba?|hsla?|oklch)\(/g)].map((m) => m[0]);
  assert.deepEqual(hits, [], 'colors come from tokens.css only');
});

test('the dialog scrim consumes --color-scrim and is TOP-anchored, never vertically centred', () => {
  // The card's height changes per tab (New folder, Clone, the whole GitHub
  // panel). Centred, its top edge — and with it the tab row — would move under
  // the pointer on every tab switch. Same rule as the A4 dialog.
  assert.match(AP_RULES, /\.ap-scrim\s*\{[^}]*background:\s*var\(--color-scrim\)/);
  const rules = [...AP_RULES.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    sel: (m[1] as string).split(',').map((s) => s.trim()).filter((s) => s !== ''),
    body: m[2] as string,
  }));
  const boxRules = rules.filter((r) =>
    r.sel.some((s) => /\.ap-(?:scrim|modal)(?![\w-])/.test(s.split(/[\s>+~]+/).pop() as string)),
  );
  const scrimRules = boxRules.filter((r) => r.sel.some((s) => /\.ap-scrim(?![\w-])/.test(s)));
  assert.ok(boxRules.length >= 2 && scrimRules.length >= 1, `non-vacuity: ${boxRules.length} box rules`);
  assert.ok(
    scrimRules.some((r) => /(?:^|;)\s*align-items:\s*(?:flex-start|start)\s*(?:;|$)/.test(r.body)),
    '.ap-scrim must declare align-items: flex-start itself',
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
        ((prop === 'margin-top' || prop === 'margin-block-start') && /\bauto\b/.test(val));
      if (centred) offenders.push(`${r.sel.join(', ')} { ${decl} }`);
    }
  }
  assert.deepEqual(offenders, [], 'the Add-a-project modal must keep a stable top edge');
});

test('one accent rule: the active tab underline and the primary action', () => {
  // The accent marks what is interactive-and-chosen, nothing else. The active
  // tab's underline is the block's own use of it; the primary button borrows the
  // app-wide .btn-accent, so the block must NOT paint a second accent edge onto
  // an inert surface.
  assert.match(AP_RULES, /\.ap-tab\.is-on\s*\{[^}]*border-bottom-color:\s*var\(--color-accent\)/);
  assert.match(AP_RULES, /\.ap-check\[aria-pressed='true'\]\s\.ap-box\s*\{[^}]*background:\s*var\(--color-accent\)/);
  // One accent PRIMARY per tab, in the DOM too. The GitHub tab shows the sign-in
  // card and the paste-a-token card at the same time whenever the connection is
  // gone, so only the recommended path wears the accent; Add token is the same
  // neutral outline the repo actions use.
  assert.deepEqual(
    GITHUB.match(/'btn-accent'/g),
    ["'btn-accent'"],
    'Connect with GitHub is the GitHub tab’s only accent button',
  );
  assert.match(GITHUB, /button\('btn-quiet', 'Add token'/);
});

/** Every class name a module assigns through a string literal, for our prefixes. */
function classesIn(src: string): Set<string> {
  const out = new Set<string>();
  for (const m of src.matchAll(/(['`])([^'`\n]*)\1/g)) {
    for (const c of (m[2] as string).replace(/\$\{[^}]*\}/g, ' ').split(/\s+/)) {
      if (/^(?:ap|gh)-[a-z0-9-]+$/.test(c)) out.add(c);
    }
  }
  return out;
}

test('class parity: every ap-/gh- class the two modules set has a rule, and every such rule is used', () => {
  const inTs = new Set([...classesIn(NEWPROJECT), ...classesIn(GITHUB)]);
  // Element ids share the prefix (ap-title): an id is not a class.
  const ids = new Set([...NEWPROJECT.matchAll(/\.id = '(ap-[a-z0-9-]+)'/g)].map((m) => m[1] as string));
  for (const m of GITHUB.matchAll(/\.id = '(gh-[a-z0-9-]+)'/g)) ids.add(m[1] as string);
  for (const m of GITHUB.matchAll(/'aria-controls', '(gh-[a-z0-9-]+)'/g)) ids.add(m[1] as string);
  const inCss = new Set([...AP_RULES.matchAll(/\.((?:ap|gh)-[a-z0-9-]+)/g)].map((m) => m[1] as string));
  assert.ok(inTs.size >= 25 && inCss.size >= 25, `non-vacuity: ts ${inTs.size}, css ${inCss.size}`);
  const unstyled = [...inTs].filter((c) => !inCss.has(c) && !ids.has(c));
  const dead = [...inCss].filter((c) => !inTs.has(c));
  assert.deepEqual(unstyled, [], `a module sets classes no rule styles: ${unstyled.join(', ')}`);
  assert.deepEqual(dead, [], `app.css styles classes no module sets: ${dead.join(', ')}`);
});

test('the top-bar GitHub chip keeps its own A2 rules (the tab block never styles it)', () => {
  // .tb-gh* belongs to the top bar, not to this dialog: a change here must not
  // reach across into the chrome.
  assert.ok(!/\.tb-gh/.test(AP_RULES), 'the A7 block must not style the top-bar chip');
  assert.ok(/\.tb-gh/.test(APP_CSS.slice(0, start)), 'the chip is still styled by the A2 block');
});

test('the Legacy classes A7 dropped are gone from app.css and every frontend module', () => {
  // Each of these was worn by the New Project dialog or its GitHub tab and has
  // no owner left: the ink-well clone summary, the mode-tab buttons, the browse
  // row, the caption, the git-init trim, the spinner pair, and the per-repo
  // green "open"/private-badge variants.
  const removed = [
    'np-tabs',
    'np-tab',
    'np-panel',
    'np-pathrow',
    'np-pathrow-glyph',
    'np-pathrow-path',
    'np-pathrow-browse',
    'np-optional',
    'np-caption',
    'np-pathnote',
    // The dialog-tile glyph: A7 dropped the tile here, and the A7 follow-up
    // moved the folder picker — its last user — onto the Nocturne `pk-` chrome.
    'np-glyph',
    'np-gitrow',
    'np-busy',
    'np-spinner',
    'np-modal',
    'gh-connect',
    'gh-addtoken',
    'gh-tokenfield',
    'gh-remember',
    'gh-remember-note',
    'gh-meta-t',
  ];
  const tsFiles = readdirSync(UI)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => [f, read(join(UI, f))] as const);
  tsFiles.push(['main.ts', read(join(projectRoot, 'web', 'src', 'main.ts'))]);
  tsFiles.push(['main-shell.ts', read(join(projectRoot, 'web', 'src', 'main-shell.ts'))]);
  const offenders: string[] = [];
  for (const c of removed) {
    if (new RegExp(`\\.${c}\\b`).test(APP_CSS)) offenders.push(`app.css .${c}`);
    for (const [f, src] of tsFiles) if (new RegExp(`['\` ]${c}\\b`).test(src)) offenders.push(`${f} ${c}`);
  }
  assert.deepEqual(offenders, []);
});

test('honest progress: no percentage anywhere in the dialog or its GitHub tab', () => {
  // A clone is one synchronous backend call with nothing to measure, so the v3
  // mock's progress bar and "Cloning 40%" are deliberately not adopted (the
  // spinner is indeterminate). A `%` in this UI would be a fiction.
  for (const [name, src] of [
    ['newproject.ts', NEWPROJECT],
    ['github.ts', GITHUB],
  ] as const) {
    const strings = [...src.matchAll(/(['`])([^'`\n]*)\1/g)].map((m) => m[2] as string);
    const withPct = strings.filter((t) => /\d\s*%|%\s*$|percent/i.test(t));
    assert.deepEqual(withPct, [], `${name} must not show a progress percentage`);
  }
  assert.ok(!/progress/i.test(AP_RULES), 'no progress-bar rule in the block');
});

test('copy: the dialog names no command, flag or config variable', () => {
  // PROJECT-SCOPE "No commands, flags, or code in the UI" (2026-07-25). The
  // clone tab's old `$ git clone <url> <dest>` preview and its replacement ink
  // well are both gone; what is left must not reintroduce CLI syntax.
  const banned = [/\bgit clone\b/, /--[a-z][a-z-]+/, /\bAI_SM_[A-Z_]+/, /\$ /];
  const strings = [...NEWPROJECT.matchAll(/(['`])([^'`\n]*)\1/g)].map((m) => m[2] as string);
  const offenders: string[] = [];
  for (const t of strings) {
    // Placeholders and aria text are UI copy too; import paths and class names
    // are not user-visible, but they match none of the patterns anyway.
    for (const re of banned) if (re.test(t)) offenders.push(t);
  }
  assert.deepEqual(offenders, [], 'UI copy must stay plain language');
});
