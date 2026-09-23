/**
 * Layout guard for the memory vault (`memory/`), decided 2026-09-20 — rules
 * and rationale in `memory/decisions/repo-layout.md`, procedure for any move
 * in `.claude/skills/restructure-repo/SKILL.md`.
 *
 * The layout is a convention, and a convention nobody checks drifts: one
 * session files a log entry in the old flat folder, the next one cites it by
 * path, and the vault is two layouts again. These tests make the convention
 * the only state the suite accepts:
 *
 *   1. a work-log entry lives at `memory/log/<YYYY-MM>/<area>/<YYYY-MM-DD>-<topic>.md`,
 *      in the month its own filename states, `<area>` from the fixed list;
 *   2. `decisions/` and `knowledge/` are flat;
 *   3. basenames are unique across the vault — `[[wikilinks]]` resolve by
 *      filename, so a duplicate silently splits a link;
 *   4. every note has a line in `memory/INDEX.md` and every INDEX line has a
 *      note ("a note absent from the index is invisible");
 *   5. a `memory/…/<note>.md` path cited from ANY tracked file exists — code
 *      comments and the scope doc cite decision notes by path, and a moved
 *      note must take those citations with it.
 *
 * Tracked files only, like `tests/repo/no-author-paths.test.ts`: stage a new note
 * (`git add`) before trusting a green run.
 *
 * Not checked, deliberately: wikilinks inside notes. A handful of log entries
 * link to notes of the orchestrator's own auto-memory, which lives outside the
 * repo; they are history and stay as written.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { projectRoot } from '../helpers/helpers.ts';

/** The one list. A new area is a decision: add it here AND in the memory skill. */
const LOG_AREAS = new Set(['nocturne', 'backend', 'ui', 'launcher', 'github', 'release', 'project']);

/** Files that sit at the vault root and are not notes of a folder. */
const ROOT_FILES = new Set(['memory/INDEX.md', 'memory/BACKLOG.md']);

function trackedFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z'], {
    cwd: projectRoot,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return out.split('\0').filter((p) => p.length > 0);
}

const tracked = trackedFiles();
const vault = tracked.filter((p) => p.startsWith('memory/') && p.endsWith('.md'));

test('the vault is where the layout says it is', () => {
  assert.ok(vault.length > 50, `only ${vault.length} tracked vault notes - is this a git tree?`);
  for (const root of ROOT_FILES) assert.ok(vault.includes(root), `${root} is missing`);
});

test('a work-log entry lives at memory/log/<YYYY-MM>/<area>/<YYYY-MM-DD>-<topic>.md', () => {
  const wrong: string[] = [];
  for (const rel of vault.filter((p) => p.startsWith('memory/log/'))) {
    const parts = rel.split('/');
    const [, , month, area, file] = parts;
    const ok =
      parts.length === 5 &&
      /^\d{4}-\d{2}$/.test(month) &&
      LOG_AREAS.has(area) &&
      /^\d{4}-\d{2}-\d{2}-[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(file) &&
      file.startsWith(`${month}-`);
    if (!ok) wrong.push(rel);
  }
  assert.deepEqual(
    wrong,
    [],
    `misplaced log entries (areas: ${[...LOG_AREAS].join(', ')}; the month folder must match the filename)`,
  );
});

test('decisions/ and knowledge/ are flat, and nothing else sits in the vault', () => {
  const wrong = vault.filter((rel) => {
    if (ROOT_FILES.has(rel) || rel.startsWith('memory/log/')) return false;
    return !/^memory\/(decisions|knowledge)\/[a-z0-9][a-z0-9.-]*\.md$/.test(rel);
  });
  assert.deepEqual(wrong, [], 'notes outside memory/{decisions,knowledge}/<kebab-case>.md');
});

test('basenames are unique across the vault (wikilinks resolve by filename)', () => {
  const seen = new Map<string, string>();
  const dup: string[] = [];
  for (const rel of vault) {
    const name = basename(rel);
    const first = seen.get(name);
    if (first) dup.push(`${first} <-> ${rel}`);
    else seen.set(name, rel);
  }
  assert.deepEqual(dup, []);
});

test('memory/INDEX.md lists every note, and lists nothing that does not exist', () => {
  const index = readFileSync(join(projectRoot, 'memory/INDEX.md'), 'utf8');
  const listed = new Set([...index.matchAll(/^- \[\[([^\]|#]+)/gm)].map((m) => m[1].trim()));
  const notes = new Set(vault.filter((p) => p !== 'memory/INDEX.md').map((p) => basename(p, '.md')));
  assert.ok(listed.size > 50, `INDEX.md lists only ${listed.size} notes - did its line format change?`);
  assert.deepEqual([...notes].filter((n) => !listed.has(n)).sort(), [], 'notes without an INDEX line');
  assert.deepEqual([...listed].filter((n) => !notes.has(n)).sort(), [], 'INDEX lines without a note');
});

test('every memory/…/<note>.md path cited from a tracked file exists', () => {
  // A concrete path only: `<placeholders>` and globs are prose, not citations.
  const CITED = /memory\/(?:decisions|knowledge|log)\/[A-Za-z0-9._/-]*\.md/g;
  const dead: string[] = [];
  for (const rel of tracked) {
    const abs = join(projectRoot, rel);
    let text: string;
    try {
      if (statSync(abs).size > 2 * 1024 * 1024) continue;
      text = readFileSync(abs, 'utf8');
    } catch {
      continue; // listed by git but gone from the working tree: not this test's business
    }
    for (const m of text.matchAll(CITED)) {
      if (!existsSync(join(projectRoot, m[0]))) dead.push(`${rel}: ${m[0]}`);
    }
  }
  assert.deepEqual([...new Set(dead)].sort(), []);
});
