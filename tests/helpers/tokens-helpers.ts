/**
 * One reader for `web/src/styles/tokens.css`, shared by every test that checks
 * a CSS block against the design tokens.
 *
 * Until Nocturne A8 each of those tests carried its own copy of the same
 * machinery: split tokens.css at the Legacy alias marker, take the names above
 * it as "the primitives", and assert the block used nothing from below. A8
 * phase 2 deleted that block and its marker, so there is only ONE
 * set left — everything tokens.css declares — and the check each block makes
 * becomes a typo guard: a `var(--x)` naming a token that does not exist
 * resolves to nothing at runtime and shows up as a missing colour, never as an
 * error.
 *
 * Source inspection only: no DOM, no server, nothing cached across files
 * beyond this module's own read.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { projectRoot } from './helpers.ts';

export const WEB_SRC = join(projectRoot, 'web', 'src');
export const TOKENS_CSS_PATH = join(WEB_SRC, 'styles', 'tokens.css');
export const APP_CSS_PATH = join(WEB_SRC, 'styles', 'app.css');
export const INDEX_HTML_PATH = join(projectRoot, 'web', 'index.html');

/** The raw stylesheets, read once per test process. */
export const TOKENS_CSS = readFileSync(TOKENS_CSS_PATH, 'utf8');
export const APP_CSS = readFileSync(APP_CSS_PATH, 'utf8');

/** Every custom property tokens.css declares — the whole vocabulary. */
export function declaredTokens(src: string = TOKENS_CSS): Set<string> {
  return new Set([...src.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((m) => m[1] as string));
}

/** Every custom property a chunk of CSS READS, in file order. */
export function usedTokens(css: string): string[] {
  return [...css.matchAll(/var\(\s*(--[a-z0-9-]+)/g)].map((m) => m[1] as string);
}

/**
 * Custom properties that are STATE, not design tokens: a module writes them
 * onto an element at runtime and the stylesheet reads them with a fallback, so
 * they are declared in no stylesheet BY DESIGN. Each entry says who writes it.
 */
export const RUNTIME_PROPS: Record<string, string> = {
  '--split-col': "ui/panes.ts: grid.style.setProperty('--split-col', …) on every split drag",
  '--split-row': "ui/panes.ts: grid.style.setProperty('--split-row', …) on every split drag",
};

/** Comments hold prose that NAMES tokens and classes; only rules count. */
export function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** One source file of the frontend: its repo-relative path and its bytes. */
export interface SrcFile {
  name: string;
  src: string;
}

/**
 * Every file the frontend is built from, walked once: the sources under
 * `web/src` whose extension is asked for, plus the one hand-written HTML page,
 * which is always included. Binary assets (the bundled woff2 faces) are never
 * read — an extension list is the whole filter.
 */
export function frontendFiles(exts: string[] = ['.ts']): SrcFile[] {
  const out: SrcFile[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (exts.some((x) => e.endsWith(x))) {
        out.push({ name: relative(projectRoot, p), src: readFileSync(p, 'utf8') });
      }
    }
  };
  walk(WEB_SRC);
  out.push({ name: relative(projectRoot, INDEX_HTML_PATH), src: readFileSync(INDEX_HTML_PATH, 'utf8') });
  return out;
}

/** One `/* ---- name ---` section of app.css: its title, its body, its line. */
export interface CssSection {
  title: string;
  body: string;
  at: number;
}

/** The section headers of app.css, in file order. */
export function sections(css: string = APP_CSS): CssSection[] {
  const out: CssSection[] = [];
  const marks = [...css.matchAll(/^\/\* ---- (.*)$/gm)];
  marks.forEach((m, i) => {
    const start = m.index as number;
    const end = i + 1 < marks.length ? (marks[i + 1]!.index as number) : css.length;
    out.push({
      title: (m[1] as string).replace(/-+\s*(\*\/)?\s*$/, '').trim(),
      body: css.slice(start, end),
      at: css.slice(0, start).split('\n').length,
    });
  });
  return out;
}

/**
 * The sections a test claims, by their opening words, in the order asked for.
 * Exactly one section must match each — a title that matched twice (or none)
 * would silently scan the wrong rules.
 */
export function mySections(titles: string[], css: string = APP_CSS): CssSection[] {
  const all = sections(css);
  return titles.map((want) => {
    const hits = all.filter((s) => s.title.startsWith(want));
    assert.equal(hits.length, 1, `app.css must carry exactly one "${want}" section, found ${hits.length}`);
    return hits[0] as CssSection;
  });
}
