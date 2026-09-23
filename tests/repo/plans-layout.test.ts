/**
 * Layout guard for the plans (`.claude/plans/`), decided 2026-09-20 — the
 * convention is `.claude/plans/README.md`, the rationale
 * `memory/decisions/repo-layout.md`, the sibling guard
 * `tests/repo/vault-layout.test.ts`.
 *
 * Plans are cited by path from code comments, tests, the scope doc and the
 * vault. That only works while a plan's path is stable and its state is
 * written in one place. Checked here, on tracked files:
 *
 *   1. a plan lives at `.claude/plans/PLAN-<NAME>.md` (a master plan) or
 *      `.claude/plans/<name>/PLAN-<ID>.md` (a part spec of `PLAN-<NAME>.md`);
 *      nothing plan-like sits loose in `.claude/` any more;
 *   2. basenames are unique, so a bare `PLAN-B10.md` names one file;
 *   3. a master plan opens with the status table, a part spec carries a
 *      `Status: <STATE> <date>` line with a known state;
 *   4. every part spec is a row of its master plan's table, and every spec
 *      the table names exists;
 *   5. `.claude/plans/README.md` indexes every plan file;
 *   6. every plan citation in every tracked file resolves — the full path
 *      form and the bare-filename form. `memory/log/` is exempt: a log entry
 *      is history and keeps the paths of its day.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { projectRoot, readSource as read, trackedFiles } from '../helpers/helpers.ts';

const SPEC_STATES = ['DRAFT', 'DECIDED', 'STARTED', 'LANDED', 'DROPPED'];
const TABLE_HEAD = '| Part | What | State | Spec | Landed |';

const tracked = trackedFiles();
const inPlans = tracked.filter((p) => p.startsWith('.claude/plans/'));
const masters = inPlans.filter((p) => /^\.claude\/plans\/PLAN-[A-Z0-9]+\.md$/.test(p));
const specs = inPlans.filter((p) => /^\.claude\/plans\/[a-z0-9-]+\/PLAN-[A-Za-z0-9]+\.md$/.test(p));

test('plans live under .claude/plans/ and nowhere else', () => {
  assert.ok(masters.length >= 1, 'no master plan found - is this a git tree?');
  const loose = tracked.filter((p) => /^\.claude\/(PLAN-|RELEASE-NOTES)/.test(p));
  assert.deepEqual(loose, [], 'plan files loose in .claude/ (they belong in .claude/plans/)');

  const known = new Set([...masters, ...specs, '.claude/plans/README.md']);
  const odd = inPlans.filter((p) => !known.has(p) && !/^\.claude\/plans\/RELEASE-NOTES-[A-Za-z0-9.-]+\.md$/.test(p));
  assert.deepEqual(odd, [], 'files in .claude/plans/ that match no shape of the convention');
});

test('a part spec sits in the folder of an existing master plan', () => {
  const masterNames = new Set(masters.map((m) => basename(m, '.md').slice('PLAN-'.length).toLowerCase()));
  const orphans = specs.filter((s) => !masterNames.has(s.split('/')[2]));
  assert.deepEqual(orphans, [], 'spec folders without a PLAN-<NAME>.md beside them');
});

test('plan basenames are unique, also when case is ignored', () => {
  const seen = new Map<string, string>();
  const dup: string[] = [];
  for (const rel of [...masters, ...specs]) {
    const key = basename(rel).toLowerCase();
    const first = seen.get(key);
    if (first) dup.push(`${first} <-> ${rel}`);
    else seen.set(key, rel);
  }
  assert.deepEqual(dup, []);
});

test('a master plan opens with the status table; a part spec states its status', () => {
  for (const rel of masters) {
    const head = read(rel).split('\n').slice(0, 12);
    assert.match(head[0], /^# Plan: /, `${rel}: line 1 is "# Plan: <title>"`);
    assert.ok(head.some((l) => l.startsWith('Status: see the table below')), `${rel}: no "Status: see the table below" line`);
    assert.ok(head.includes(TABLE_HEAD), `${rel}: the status table must start within the first 12 lines`);
  }
  const bad: string[] = [];
  for (const rel of specs) {
    const status = read(rel).split('\n').slice(0, 8).find((l) => l.startsWith('Status: '));
    const state = status?.slice('Status: '.length).split(/[\s(;,]/)[0] ?? '';
    if (!SPEC_STATES.includes(state) || !/\d{4}-\d{2}-\d{2}/.test(status ?? '')) bad.push(`${rel}: ${status ?? '(no Status line)'}`);
  }
  assert.deepEqual(bad, [], `a spec needs "Status: <${SPEC_STATES.join('|')}> <YYYY-MM-DD> …" in its first 8 lines`);
});

test('the status table and the spec files agree', () => {
  for (const master of masters) {
    const folder = `.claude/plans/${basename(master, '.md').slice('PLAN-'.length).toLowerCase()}/`;
    const rows = read(master).split('\n').filter((l) => l.startsWith('| ') && l !== TABLE_HEAD);
    const named = new Set(rows.flatMap((r) => [...r.matchAll(/`(\.claude\/plans\/[^`]+\.md)`/g)].map((m) => m[1])));
    const mine = specs.filter((s) => s.startsWith(folder));
    assert.deepEqual(mine.filter((s) => !named.has(s)), [], `${master}: specs without a row in the status table`);
    assert.deepEqual([...named].filter((s) => !existsSync(join(projectRoot, s))), [], `${master}: the table names specs that do not exist`);
  }
});

test('.claude/plans/README.md indexes every plan file', () => {
  const readme = read('.claude/plans/README.md');
  const missing = inPlans
    .filter((p) => p !== '.claude/plans/README.md')
    .filter((p) => !readme.includes(`\`${basename(p)}\``));
  assert.deepEqual(missing, [], 'plan files without a line in the index');
});

test('every plan citation in a tracked file resolves', () => {
  const names = new Set([...masters, ...specs].map((p) => basename(p)));
  const FULL = /\.claude\/(?:plans\/[A-Za-z0-9._/-]*|PLAN-[A-Za-z0-9._-]*|RELEASE-NOTES[A-Za-z0-9._-]*)\.md/g;
  const BARE = /(?<![A-Za-z0-9._/-])PLAN-[A-Za-z0-9]+\.md/g;
  const dead: string[] = [];
  for (const rel of tracked) {
    if (rel.startsWith('memory/log/')) continue; // history keeps the paths of its day
    const abs = join(projectRoot, rel);
    let text: string;
    try {
      if (statSync(abs).size > 2 * 1024 * 1024) continue;
      text = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    for (const m of text.matchAll(FULL)) if (!existsSync(join(projectRoot, m[0]))) dead.push(`${rel}: ${m[0]}`);
    for (const m of text.matchAll(BARE)) if (!names.has(m[0])) dead.push(`${rel}: ${m[0]}`);
  }
  assert.deepEqual([...new Set(dead)].sort(), []);
});
