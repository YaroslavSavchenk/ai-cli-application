/**
 * Readers of frontend SOURCE TEXT for the tests that hold web/src to a rule
 * without running it: the string/template literals a module contains, the
 * class names it assigns, a function's body, its code without comments.
 *
 * Each of these lived as a byte-identical copy in two or more test files
 * until part O5 of the restructure (2026-09-23) folded them here.
 */
import assert from 'node:assert/strict';

/**
 * Stand-in for a `${…}` interpolation, so a template's literal text is still
 * checked. A character that cannot occur in source, deliberately: with a SPACE
 * here a signature join like `` `${a}|${b}` `` would read as ` | ` and be
 * reported as a separator it is not.
 */
export const HOLE = '\u0000';

export interface Lit {
  text: string;
  line: number;
}

/** Read one string/template literal starting at the quote `src[i]`. */
export function readLiteral(src: string, i: number): { text: string; end: number } {
  const quote = src[i];
  let j = i + 1;
  let text = '';
  while (j < src.length) {
    const c = src[j];
    if (c === '\\') {
      text += src[j + 1] ?? '';
      j += 2;
      continue;
    }
    if (c === quote) return { text, end: j + 1 };
    if (quote === '`' && c === '$' && src[j + 1] === '{') {
      j = skipExpression(src, j + 2);
      text += HOLE;
      continue;
    }
    text += c;
    j += 1;
  }
  return { text, end: j };
}

/** Skip a `${ … }` expression, including nested braces, strings and templates. */
export function skipExpression(src: string, i: number): number {
  let depth = 1;
  let j = i;
  while (j < src.length) {
    const c = src[j];
    if (c === "'" || c === '"' || c === '`') {
      j = readLiteral(src, j).end;
      continue;
    }
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return j + 1;
    }
    j += 1;
  }
  return j;
}

/** Every string/template literal in `src`, with comments skipped entirely. */
export function literals(src: string): Lit[] {
  const out: Lit[] = [];
  let i = 0;
  let line = 1;
  while (i < src.length) {
    const c = src[i];
    if (c === '\n') {
      line += 1;
      i += 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') line += 1;
        i += 1;
      }
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const startLine = line;
      const { text, end } = readLiteral(src, i);
      for (let k = i; k < end; k += 1) if (src[k] === '\n') line += 1;
      out.push({ text, line: startLine });
      i = end;
      continue;
    }
    i += 1;
  }
  return out;
}

/**
 * Class names a module really ASSIGNS at its call sites (`el(tag, cls)`,
 * `button(cls)`, `.className =`, `classList.add/remove/toggle`), so a class
 * word that only appears in a comment or an identifier does not count.
 */
export function assignedClasses(src: string): string[] {
  const out: string[] = [];
  const push = (s: string): void => {
    for (const c of s.replace(/\$\{[^}]*\}/g, ' ').split(/\s+/)) if (c !== '') out.push(c);
  };
  for (const re of [
    /\bel\(\s*'[a-zA-Z0-9]+'\s*,\s*'([^']*)'/g,
    /\bbutton\(\s*'([^']*)'/g,
    /\.className\s*=\s*'([^']*)'/g,
    /classList\.(?:add|remove|toggle)\(\s*'([^']*)'/g,
  ]) {
    for (const m of src.matchAll(re)) push(m[1] as string);
  }
  return out;
}

/** `src` without block comments and without whole-line `//` comments. */
export const withoutComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** The body of a named function, from its signature to the next top-level `}`. */
export function functionBody(src: string, signature: string): string {
  const at = src.indexOf(signature);
  assert.notEqual(at, -1, `non-vacuity: ${signature} was not found`);
  const end = src.indexOf('\n}', at);
  assert.notEqual(end, -1, `non-vacuity: ${signature} has no end`);
  return src.slice(at, end + 2);
}
