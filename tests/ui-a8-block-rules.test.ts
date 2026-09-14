/**
 * Every Nocturne block class has a BASE rule — not only a refinement inside a
 * media query.
 *
 * WHY THIS FILE EXISTS (measured, 2026-09-14, A8 test gate). The class-parity
 * guards (`tests/ui-a8-dialogs.test.ts`, `tests/ui-a8-chrome.test.ts`,
 * `tests/ui-a7-parity.test.ts`) ask "does the stylesheet mention this class
 * anywhere". That question is answered YES by a narrow-window override, so
 * deleting the whole `.sc-cap` rule — the caption under the paste and copy
 * rows, the answer to the user's own "why not ctrl+v?" — left the suite green:
 * the `@media (max-width: …)` refinement two hundred lines down still named
 * the class. The caption would have rendered unstyled at every normal window
 * width and no test would have said a word.
 *
 * So: for the blocks the Nocturne parts own, a class a module assigns must be
 * styled OUTSIDE every `@media` block. A media query may change a rule; it may
 * not BE the rule.
 *
 * Source inspection only — no DOM, no server.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APP_CSS, frontendFiles, stripComments } from './tokens-helpers.ts';

/** Comments hold prose that NAMES classes; only rules count. */
const strip = stripComments;
const RULES = strip(APP_CSS);

/**
 * The stylesheet with every `@media` block (body included) cut out: what a
 * browser applies at ANY window size.
 */
function withoutMediaBlocks(css: string): string {
  let out = '';
  let i = 0;
  for (;;) {
    const m = /@media[^{]*\{/.exec(css.slice(i));
    if (m === null) {
      out += css.slice(i);
      return out;
    }
    const start = i + (m.index as number);
    out += css.slice(i, start);
    let depth = 1;
    let j = start + m[0].length;
    while (depth > 0 && j < css.length) {
      if (css[j] === '{') depth += 1;
      else if (css[j] === '}') depth -= 1;
      j += 1;
    }
    i = j;
  }
}

const BASE = withoutMediaBlocks(RULES);

/** Every .ts under web/src, plus the one hand-written HTML page. */
const FILES = frontendFiles(['.ts']);

/**
 * A template's `${…}` holes are not class names, and they nest
 * (`${n > 0 ? 'a' : 'b'}` carries its own braces), so a non-greedy regex would
 * shred the tail of the literal into junk words. This removes the holes by
 * counting braces.
 */
function withoutInterpolations(s: string): string {
  let out = '';
  let depth = 0;
  for (let i = 0; i < s.length; i += 1) {
    if (depth === 0 && s.startsWith('${', i)) {
      depth = 1;
      i += 1;
      out += ' ';
      continue;
    }
    if (depth > 0) {
      if (s[i] === '{') depth += 1;
      else if (s[i] === '}') depth -= 1;
      continue;
    }
    out += s[i] as string;
  }
  return out;
}

/** A class name, not a fragment of an expression that survived the strip. */
const CLASS_SHAPE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/**
 * Class names a module really ASSIGNS — the same call sites
 * `tests/ui-a8-dialogs.test.ts` reads, plus the template-literal form, so a
 * class built as `` `sc-row ${extra}` `` is not silently invisible here.
 */
function assignedClasses(src: string): string[] {
  const out: string[] = [];
  const push = (s: string): void => {
    for (const c of withoutInterpolations(s).split(/\s+/)) if (CLASS_SHAPE.test(c)) out.push(c);
  };
  for (const re of [
    /\bel\(\s*'[a-zA-Z0-9]+'\s*,\s*['`]([^'`]*)['`]/g,
    /\bbutton\(\s*['`]([^'`]*)['`]/g,
    /\.className\s*=\s*['`]([^'`]*)['`]/g,
    /classList\.(?:add|remove|toggle)\(\s*['`]([^'`]*)['`]/g,
    /\bclass="([^"]*)"/g,
  ]) {
    for (const m of src.matchAll(re)) push(m[1] as string);
  }
  return out;
}

/**
 * The block prefixes the Nocturne parts introduced. `boot-` is A8's boot card,
 * `sc-`/`ut-`/`rs-` A8's overlay, toast and confirmation, the rest A2-A7.
 */
const PREFIXES = ['boot', 'sc', 'ut', 'rs', 'sg', 'ap', 'gh', 'pk', 'tb', 'ns'];
const PREFIXED = new RegExp(`^(?:${PREFIXES.join('|')})-[a-z0-9-]+$`);

test('non-vacuity: the stylesheet, its media queries and the modules are really read', () => {
  assert.ok(RULES.length > 50_000, `app.css looks empty: ${RULES.length} chars`);
  assert.ok(BASE.length > 40_000, `the base stylesheet looks empty: ${BASE.length} chars`);
  assert.ok(BASE.length < RULES.length, 'app.css must still carry @media blocks, or this file proves nothing');
  assert.ok(FILES.length >= 20, `only ${FILES.length} frontend files found`);
  // The cut really removes a media-query body and keeps the base rules: the
  // stylesheet refines SOME class at a narrow window, and that class still has
  // its unconditional rule in what is left.
  assert.equal(/@media/.test(BASE), false, 'no @media may survive the cut');
  const inMediaOnly = new Set([...RULES.matchAll(/\.([a-z][a-z0-9-]+)\s*\{/g)].map((m) => m[1] as string));
  for (const m of BASE.matchAll(/\.([a-z][a-z0-9-]+)\s*\{/g)) inMediaOnly.delete(m[1] as string);
  const refined = [...RULES.matchAll(/\.([a-z][a-z0-9-]+)\s*\{/g)]
    .map((m) => m[1] as string)
    .filter((c) => !inMediaOnly.has(c));
  assert.ok(refined.length > 0, 'non-vacuity: the class scan found nothing at all');
  assert.ok(BASE.length + 500 < RULES.length, 'the media blocks that were cut carried real rules');
});

test('every Nocturne block class a module assigns is styled outside every @media block', () => {
  const assigned = new Map<string, string[]>();
  for (const f of FILES) {
    for (const c of assignedClasses(f.src)) {
      if (!PREFIXED.test(c)) continue;
      const owners = assigned.get(c) ?? [];
      if (!owners.includes(f.name)) owners.push(f.name);
      assigned.set(c, owners);
    }
  }
  assert.ok(assigned.size >= 100, `non-vacuity: only ${assigned.size} block classes found`);

  const mentioned = (css: string, cls: string): boolean => new RegExp(`\\.${cls}(?![\\w-])`).test(css);
  const offenders: string[] = [];
  for (const [cls, owners] of assigned) {
    if (!mentioned(BASE, cls)) {
      offenders.push(
        `${cls} (set by ${owners.join(', ')}) — ${
          mentioned(RULES, cls) ? 'styled ONLY inside a @media block' : 'no rule at all'
        }`,
      );
    }
  }
  assert.deepEqual(offenders, [], `a class whose only styling is conditional:\n  ${offenders.join('\n  ')}`);
});

/**
 * The A5 panel vocabulary (`proj-`, `row-`, `drawer-`, `dot`, the `is-*`
 * states) has NO prefix of its own and no parity guard anywhere in the suite —
 * `tests/ui-a7-parity.test.ts` covers `sg-/ap-/gh-/pk-`, `ui-a8-dialogs`
 * covers `sc-/ut-/rs-`, and the two drawers were covered by nothing. Fix cycle
 * 1 moved the projects drawer's row actions onto the Sessions panel's
 * `.row-btn` / `.row-x` idiom and deleted the `.chip-btn` rules, which is
 * exactly the move a parity guard has to watch: a leftover `chip-btn` on a
 * button now paints nothing at all.
 */
test('every class the two drawers assign is styled, and styled outside every @media block', () => {
  const MODULES = ['web/src/ui/projects.ts', 'web/src/ui/sessions.ts'];
  const assigned = new Map<string, string[]>();
  for (const name of MODULES) {
    const f = FILES.find((x) => x.name === name);
    assert.ok(f !== undefined, `${name} must be part of the scan`);
    for (const c of assignedClasses(f.src)) {
      const owners = assigned.get(c) ?? [];
      if (!owners.includes(name)) owners.push(name);
      assigned.set(c, owners);
    }
  }
  assert.ok(assigned.size >= 30, `non-vacuity: only ${assigned.size} classes found in the two drawers`);
  for (const must of ['row-btn', 'row-x', 'proj-row', 'drawer-label']) {
    assert.ok(assigned.has(must), `the scan must see ${must} — it is assigned by one of the two modules`);
  }

  const mentioned = (css: string, cls: string): boolean => new RegExp(`\\.${cls}(?![\\w-])`).test(css);
  const offenders: string[] = [];
  for (const [cls, owners] of assigned) {
    if (!mentioned(BASE, cls)) {
      offenders.push(
        `${cls} (set by ${owners.join(', ')}) — ${
          mentioned(RULES, cls) ? 'styled ONLY inside a @media block' : 'no rule at all'
        }`,
      );
    }
  }
  assert.deepEqual(offenders, [], `a drawer class with no unconditional rule:\n  ${offenders.join('\n  ')}`);
});
