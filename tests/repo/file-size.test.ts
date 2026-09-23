/**
 * Size guard: one file, one topic (decided 2026-09-23, user's call — the
 * rules are `tests/README.md` § Size, the plan
 * `.claude/plans/PLAN-RESTRUCTURE.md` § O4–O8).
 *
 * A tracked test module (`tests/**` `*.ts`) stays at or under 800 lines; a
 * tracked source file in `server/`, `web/src/` or `shared/` (`.ts`, `.mjs`,
 * `.css`) at or under 1 000. The reason is reading cost, not speed: a reader
 * — a person or an agent — opens the part about its topic, not 3 000 lines.
 *
 * When the rule came in, 52 files were over it; all were split the same day
 * (O6 tests, O8 source), so the rule has no exemptions.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectRoot } from '../helpers/helpers.ts';

const TEST_LIMIT = 800;
const SOURCE_LIMIT = 1000;


function limitFor(rel: string): number | null {
  if (rel.startsWith('tests/')) return rel.endsWith('.ts') ? TEST_LIMIT : null;
  if (/^(server|web\/src|shared)\//.test(rel) && /\.(ts|mjs|css)$/.test(rel)) return SOURCE_LIMIT;
  return null;
}

const tracked = execFileSync('git', ['ls-files', '-z', 'tests', 'server', 'web/src', 'shared'], {
  cwd: projectRoot,
  encoding: 'utf8',
  maxBuffer: 32 * 1024 * 1024,
})
  .split('\0')
  .filter((p) => p.length > 0);

/** Lines as `wc -l` counts them: newline characters. */
function lineCount(rel: string): number {
  const text = readFileSync(join(projectRoot, rel), 'utf8');
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

const measured = tracked
  .map((rel) => ({ rel, limit: limitFor(rel) }))
  .filter((f): f is { rel: string; limit: number } => f.limit !== null)
  .map((f) => ({ ...f, lines: lineCount(f.rel) }));

test('no test module over 800 lines and no source file over 1 000', () => {
  assert.ok(measured.length > 100, `only ${measured.length} files measured - is this a git tree?`);
  const over = measured
    .filter((f) => f.lines > f.limit)
    .map((f) => `${f.rel}: ${f.lines} lines (limit ${f.limit}) - split it by topic, see tests/README.md`);
  assert.deepEqual(over, []);
});
