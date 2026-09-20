/**
 * Nocturne part A4 — the STYLE contract of the New session dialog, pinned by
 * source inspection (`.claude/plans/PLAN-NOCTURNE.md` §A4). Behaviour is driven for
 * real in `tests/ui-launch-dialog.test.ts`; the argv vocabulary in
 * `tests/ui-launch-args.test.ts`. What is left for a source pin:
 *
 *   1. TOKENS ONLY. The A4 brief: new CSS is written against the Nocturne
 *      primitives, never the Legacy alias layer — which part A8 has since
 *      deleted, names and all. So every `var(--x)` in the dialog's `ns-` block
 *      must be declared in tokens.css; a name that is not is a typo that
 *      resolves to nothing at runtime.
 *   2. NO HARDCODED COLOR in the block (tokens.css: "Never hardcode a color
 *      outside this file").
 *   3. CLASS PARITY. Every `ns-` class launch.ts puts on an element has a rule,
 *      and every `ns-` selector in app.css is still used by launch.ts — the
 *      block cannot carry dead rules into A8, nor launch.ts a class nothing
 *      styles.
 *   4. The removed Legacy dialog classes are gone from both sides.
 *
 * Looks, sizes, and whether it reads right stay manual
 * (`.claude/skills/verify-terminal/SKILL.md`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { projectRoot } from './helpers.ts';
import { declaredTokens, usedTokens } from './tokens-helpers.ts';

const UI = join(projectRoot, 'web', 'src', 'ui');
const STYLES = join(projectRoot, 'web', 'src', 'styles');
const read = (p: string): string => readFileSync(p, 'utf8');

const APP_CSS = read(join(STYLES, 'app.css'));
const LAUNCH = read(join(UI, 'launch.ts'));

const BLOCK_START = '/* ---- New session dialog (Nocturne A4)';
/** The block's own sub-headers share the `/* ---- ` shape, so the end is the NEXT dialog's header. */
const BLOCK_END = '/* ---- settings panel (status line)';
const start = APP_CSS.indexOf(BLOCK_START);
const end = APP_CSS.indexOf(BLOCK_END, start + BLOCK_START.length);
const NS_CSS = start === -1 || end === -1 ? '' : APP_CSS.slice(start, end);
/** Comments out: a comment may NAME what the rules may not use. */
const NS_RULES = NS_CSS.replace(/\/\*[\s\S]*?\*\//g, '');

/** The whole token vocabulary — A8 phase 2 left exactly one set. */
const DECLARED = declaredTokens();

test('non-vacuity: the A4 block and the token vocabulary are really being read', () => {
  assert.notEqual(start, -1, `app.css must carry the "${BLOCK_START}" section`);
  assert.notEqual(end, -1, `the block must still be followed by "${BLOCK_END}"`);
  assert.ok(NS_RULES.length > 3000, 'the ns- block looks empty');
  assert.ok(NS_RULES.includes('.ns-modal'), 'the block must style .ns-modal');
  assert.ok(DECLARED.has('--color-accent') && DECLARED.has('--space-4'), 'tokens parsed');
  assert.ok(DECLARED.size >= 100, `non-vacuity: ${DECLARED.size} tokens declared`);
});

test('tokens only: every var() in the ns- block is declared in tokens.css', () => {
  const used = [...new Set(usedTokens(NS_RULES))];
  assert.ok(used.length >= 10, `non-vacuity: found ${used.length} tokens`);
  const offenders = used.filter((t) => !DECLARED.has(t));
  assert.deepEqual(
    offenders,
    [],
    'a var() naming no declared token resolves to nothing at runtime. Offenders: ' + offenders.join(', '),
  );
});

test('non-vacuity: the block still consumes a token (the 1px hairline), so the scan is not empty', () => {
  assert.ok(NS_RULES.includes('var(--line)'), 'the block must still wear the 1px hairline width');
});

test('no hardcoded color in the ns- block', () => {
  const hits = [...NS_RULES.matchAll(/#[0-9a-fA-F]{3,8}\b|\b(rgba?|hsla?|oklch)\(/g)].map((m) => m[0]);
  assert.deepEqual(hits, [], 'colors come from tokens.css only');
});

test('--color-scrim is a semantics token and the dialog scrim consumes it', () => {
  assert.ok(DECLARED.has('--color-scrim'), '--color-scrim must be declared in tokens.css');
  assert.match(NS_RULES, /\.ns-scrim\s*\{[^}]*background:\s*var\(--color-scrim\)/);
});

/** Every `selector { declarations }` pair in the block, innermost (so @media bodies too). */
function nsRules(): { sel: string[]; body: string }[] {
  return [...NS_RULES.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    sel: (m[1] as string).split(',').map((s) => s.trim()).filter((s) => s !== ''),
    body: m[2] as string,
  }));
}

test('the modal is TOP-anchored, never vertically centred (fix round 1: switching Tool moved the grid under the pointer)', () => {
  // The modal's height changes with the Tool. Centred, its top edge moved
  // ~80 px between Claude Code and Terminal; top-anchored, the Tool grid stays
  // put. What is pinned is the anchoring, not the offset (that stays manual).
  const rules = nsRules();
  // A rule "places the box" when its LAST compound is the scrim or the modal
  // itself (`.ns-modal .ns-field input` styles a descendant, not the box).
  const boxRules = rules.filter((r) =>
    r.sel.some((s) => /\.ns-(?:scrim|modal)(?![\w-])/.test(s.split(/[\s>+~]+/).pop() as string)),
  );
  const scrimRules = boxRules.filter((r) => r.sel.some((s) => /\.ns-scrim(?![\w-])/.test(s)));
  assert.ok(boxRules.length >= 2 && scrimRules.length >= 1, `non-vacuity: ${boxRules.length} box rules`);

  // Own declaration, not inherited from the shared Legacy `.modal-scrim` (other
  // dialogs use that rule; A8 may change it).
  assert.ok(
    scrimRules.some((r) => /(?:^|;)\s*align-items:\s*(?:flex-start|start)\s*(?:;|$)/.test(r.body)),
    '.ns-scrim must declare align-items: flex-start itself',
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
        (prop === 'flex-direction' && /column/.test(val) && r.sel.some((s) => s.includes('ns-scrim')));
      if (centred) offenders.push(`${r.sel.join(', ')} { ${decl} }`);
    }
  }
  assert.deepEqual(offenders, [], 'the New session modal must keep a stable top edge');
});

/** Every class name launch.ts assigns through a string literal. */
function launchClasses(): Set<string> {
  const out = new Set<string>();
  for (const m of LAUNCH.matchAll(/(['`])([^'`\n]*)\1/g)) {
    for (const c of (m[2] as string).replace(/\$\{[^}]*\}/g, ' ').split(/\s+/)) {
      if (/^ns-[a-z0-9-]+$/.test(c)) out.add(c);
    }
  }
  return out;
}

test('class parity: every ns- class launch.ts sets has a rule, and every ns- rule is still used', () => {
  const inTs = launchClasses();
  // Element ids share the prefix (ns-title, ns-tool-lb, ns-perm-help, ...):
  // an id is not a class and needs no rule.
  const ids = new Set([...LAUNCH.matchAll(/\.id = '(ns-[a-z0-9-]+)'/g)].map((m) => m[1] as string));
  for (const m of LAUNCH.matchAll(/groupLabel\('(ns-[a-z0-9-]+)'/g)) ids.add(m[1] as string);
  for (const m of LAUNCH.matchAll(/'(ns-[a-z0-9-]+-lb)'/g)) ids.add(m[1] as string);
  const inCss = new Set([...NS_RULES.matchAll(/\.(ns-[a-z0-9-]+)/g)].map((m) => m[1] as string));
  assert.ok(inTs.size >= 20 && inCss.size >= 20, `non-vacuity: ts ${inTs.size}, css ${inCss.size}`);
  const unstyled = [...inTs].filter((c) => !inCss.has(c) && !ids.has(c));
  const dead = [...inCss].filter((c) => !inTs.has(c));
  assert.deepEqual(unstyled, [], `launch.ts sets ns- classes no rule styles: ${unstyled.join(', ')}`);
  assert.deepEqual(dead, [], `app.css styles ns- classes launch.ts never sets: ${dead.join(', ')}`);
});

test('the Legacy dialog-only classes A4 removed are gone from app.css and every frontend module', () => {
  const removed = ['launch-fields', 'launch-custom', 'mode-seg', 'launch-kind', 'launch-check', 'launch-none', 'launch-other'];
  const tsFiles = readdirSync(UI).filter((f) => f.endsWith('.ts')).map((f) => [f, read(join(UI, f))] as const);
  tsFiles.push(['main.ts', read(join(projectRoot, 'web', 'src', 'main.ts'))]);
  const offenders: string[] = [];
  for (const c of removed) {
    if (new RegExp(`\\.${c}\\b`).test(APP_CSS)) offenders.push(`app.css .${c}`);
    for (const [f, src] of tsFiles) if (new RegExp(`['\` ]${c}\\b`).test(src)) offenders.push(`${f} ${c}`);
  }
  assert.deepEqual(offenders, []);
});
