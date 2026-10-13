/**
 * Release discipline for the Claude Code compatibility guard (Nocturne D6,
 * `.claude/plans/nocturne/PLAN-D6.md` § Defaults "Release discipline").
 *
 * What: the newest release-notes draft names the Claude Code version this
 * build was verified with, and that version is `CLAUDE_SUPPORTED.testedUpTo`
 * in `shared/claude-compat.ts` — the number the app shows as "tested up to".
 *
 * Why: the range is baked into the build; bumping it without saying so in the
 * release, or releasing after verifying against a newer Claude Code without
 * bumping it, makes the notice lie. One test ties the two.
 *
 * NOT claimed: that the verification really happened (CI has no Claude Code).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { projectRoot, readSource } from '../helpers/helpers.ts';
import { CLAUDE_SUPPORTED, compareClaudeVersion } from '../../shared/claude-compat.ts';

const PLANS = '.claude/plans';
const DRAFT = /^RELEASE-NOTES-v(\d+\.\d+\.\d+)-draft\.md$/;

function newestDraft(): string {
  const drafts = readdirSync(join(projectRoot, PLANS))
    .map((name) => ({ name, m: DRAFT.exec(name) }))
    .filter((d): d is { name: string; m: RegExpExecArray } => d.m !== null)
    .sort((a, b) => compareClaudeVersion(a.m[1], b.m[1]));
  const last = drafts.at(-1);
  assert.ok(last !== undefined, `no RELEASE-NOTES-v<X.Y.Z>-draft.md in ${PLANS}`);
  return `${PLANS}/${last.name}`;
}

test('the newest release-notes draft says which Claude Code it was verified with, and it is the baked testedUpTo', () => {
  const rel = newestDraft();
  const m = /^Verified with Claude Code (\d+\.\d+\.\d+)\.$/m.exec(readSource(rel));
  assert.ok(m !== null, `${rel}: no line "Verified with Claude Code X.Y.Z."`);
  assert.equal(m[1], CLAUDE_SUPPORTED.testedUpTo, `${rel} and shared/claude-compat.ts disagree on the tested Claude Code version`);
});
