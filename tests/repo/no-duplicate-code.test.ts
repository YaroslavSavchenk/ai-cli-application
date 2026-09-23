/**
 * Duplicate guard: one home per helper (decided 2026-09-23, user's call —
 * the rule is `CONTRIBUTING.md` § One home per helper, the plan
 * `.claude/plans/PLAN-QUALITY.md` § Q0).
 *
 * How: every function body in the tracked `.ts` sources of `server/`,
 * `web/src/` and `shared/` — `function name(…) {…}` and
 * `const name = (…) => {…}` — with comments stripped and whitespace
 * collapsed. Two bodies that are the same text in two different files fail,
 * whatever the functions are called. Bodies shorter than `MIN_BODY` characters
 * are ignored (a one-line getter is not a helper worth sharing).
 * `server/statusline.mjs` is out of scope by extension: it runs standalone and
 * imports nothing from `server/` on purpose.
 *
 * `KNOWN` listed the pairs found when the guard came in; part Q1 folded them
 * and emptied it. It may only shrink: a pair that is gone must leave it.
 *
 * NOT claimed: near-duplicates that differ by a character (review catches
 * those, `CONTRIBUTING.md` says what to do), duplicated logic inside a longer
 * function, or duplicates within one file.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readSource, trackedFiles } from '../helpers/helpers.ts';

const MIN_BODY = 80;

/** The four pairs found on 2026-09-23 were folded by part Q1: empty, and it stays so. */
const KNOWN = new Set<string>([]);

const sources = trackedFiles().filter((p) => /^(server|web\/src|shared)\/.*\.ts$/.test(p) && !p.endsWith('.d.ts'));

/** Comments out, whitespace collapsed — the body's shape. */
function normalise(body: string): string {
  return body
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The `{…}` block that starts at `open` (an index of `{`), braces matched outside strings. */
function blockAt(src: string, open: number): string | null {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (quote !== null) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return null;
}

interface Fn {
  where: string;
  body: string;
}

const HEAD = /(?:^|\n)[ \t]*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)[^{;]*?\)\s*(?::[^{;=]+)?\{|(?:^|\n)[ \t]*(?:export\s+)?const\s+([A-Za-z0-9_$]+)\s*(?::[^=]+)?=\s*(?:async\s+)?\([^)]*\)\s*(?::[^=>{]+)?=>\s*\{/g;

const fns: Fn[] = [];
for (const rel of sources) {
  const src = readSource(rel);
  for (const m of src.matchAll(HEAD)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    const block = blockAt(src, open);
    if (block === null) continue;
    const body = normalise(block);
    if (body.length < MIN_BODY) continue;
    fns.push({ where: `${rel}:${m[1] ?? m[2]}`, body });
  }
}

const pairs: string[] = [];
const byBody = new Map<string, Fn[]>();
for (const f of fns) byBody.set(f.body, [...(byBody.get(f.body) ?? []), f]);
for (const group of byBody.values()) {
  const files = new Set(group.map((f) => f.where.split(':')[0]));
  if (files.size < 2) continue;
  const names = group.map((f) => f.where).sort();
  pairs.push(names.join(' = '));
}

test('the scan reads the sources it claims to', () => {
  assert.ok(sources.length > 100, `only ${sources.length} source files - is this a git tree?`);
  assert.ok(fns.length > 500, `only ${fns.length} function bodies found - the pattern broke`);
});

test('no function body is written twice in two source files', () => {
  const fresh = pairs.filter((p) => !KNOWN.has(p));
  assert.deepEqual(fresh, [], 'give it one home (CONTRIBUTING.md § One home per helper) and import it');
});

test('the known-duplicates list only shrinks', () => {
  const gone = [...KNOWN].filter((p) => !pairs.includes(p));
  assert.deepEqual(gone, [], 'folded: remove these from KNOWN in tests/repo/no-duplicate-code.test.ts');
});
