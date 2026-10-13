/**
 * Size guard: one file, one topic (decided 2026-09-23, user's call — the
 * rules are `tests/README.md` § Size, the plan
 * `.claude/plans/PLAN-RESTRUCTURE.md` § O4–O8).
 *
 * A tracked test module (`tests/**` `*.ts`) stays at or under 800 lines; a
 * tracked source file in `server/`, `web/src/` or `shared/` (`.ts`, `.mjs`,
 * `.css`) at or under 1 000, and so does every tracked text file under
 * `launcher/` (Q6, 2026-10-13, the user's call: `.cs .ps1 .psm1 .cmd .vbs .sh
 * .mjs .md` — an allow-list, so `app.ico` or a future image is never read as
 * text). The reason is reading cost, not speed: a reader — a person or an
 * agent — opens the part about its topic, not 3 000 lines.
 *
 * When the rule came in, 52 files were over it; all were split the same day
 * (O6 tests, O8 source), so the rule has no exemptions. The Windows host's
 * one 2 550-line `.cs` was cut into four by Q6
 * (`.claude/plans/quality/PLAN-Q6.md`) when `launcher/` joined.
 *
 * A host cut into parts must still compile whole: the second test pins
 * `launcher/build-host.ps1`'s fixed source list to the tracked
 * `launcher/host/*.cs`, so a fifth part nobody compiles fails here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectRoot, readSource } from '../helpers/helpers.ts';
import { HOST_SOURCES } from '../helpers/host-sources.ts';

const TEST_LIMIT = 800;
const SOURCE_LIMIT = 1000;


function limitFor(rel: string): number | null {
  if (rel.startsWith('tests/')) return rel.endsWith('.ts') ? TEST_LIMIT : null;
  if (/^(server|web\/src|shared)\//.test(rel) && /\.(ts|mjs|css)$/.test(rel)) return SOURCE_LIMIT;
  if (rel.startsWith('launcher/') && /\.(cs|ps1|psm1|cmd|vbs|sh|mjs|md)$/.test(rel)) return SOURCE_LIMIT;
  return null;
}

const tracked = execFileSync('git', ['ls-files', '-z', 'tests', 'server', 'web/src', 'shared', 'launcher'], {
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

test('build-host.ps1 compiles exactly the tracked launcher/host/*.cs', () => {
  const build = readSource('launcher', 'build-host.ps1');
  const block = /^\$SrcFiles = @\(\r?\n([\s\S]*?)\r?\n\)/m.exec(build);
  assert.ok(block, 'build-host.ps1 has no `$SrcFiles = @(...)` list');
  const lines = block[1]!.split('\n');
  const listed = lines.map((l) => /^\s*\(Join-Path \$HostDir '([^']+)'\),?\r?$/.exec(l)?.[1]);
  assert.ok(listed.every((f) => f !== undefined), `a list line is not one Join-Path entry:\n${block[1]}`);
  const hostCs = tracked.filter((p) => /^launcher\/host\/[^/]+\.cs$/.test(p));
  assert.ok(hostCs.length >= 1, 'no tracked launcher/host/*.cs');
  assert.equal(new Set(listed).size, listed.length, 'a file listed twice');
  assert.deepEqual(listed.map((f) => `launcher/host/${f}`).sort(), [...hostCs].sort());
  // The tests read the host in the same order csc gets it.
  assert.deepEqual(listed.map((f) => `launcher/host/${f}`), [...HOST_SOURCES]);
  // That list is what csc gets, after the flags: no glob, no second source.
  assert.match(build, /^\) \+ \$SrcFiles\r?$/m);
  assert.equal(build.split('$SrcFiles').length - 1, 3, 'declared, existence-checked, passed to csc');
});
