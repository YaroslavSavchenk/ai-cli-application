/**
 * `web/src/ui/launch-prefs-model.ts` — how the New session dialog lays a
 * project's preferences onto its controls, part D1
 * (`.claude/plans/nocturne/PLAN-D1.md`): `projectChoice` (a stored project ->
 * Claude Code values) and `layerChoice` (what wins: a hand change this open,
 * then the project's preference, then the fallbacks; the permission
 * preference is Claude Code's only).
 *
 * Seam: the pure model, imported and called. The dialog that wires it —
 * re-laid on open, on every project change and tool switch — is driven
 * through the DOM in `ui-launch-dialog-d1.test.ts`.
 *
 * Why it matters: before D1 a `No prompts` preference armed Codex's and
 * Gemini's bypass flags, and the first project's model rode along to the next.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layerChoice, projectChoice, type ClaudeChoice, type PrefField } from '../../web/src/ui/launch-prefs-model.ts';

const NONE = new Set<PrefField>();
const HELD: ClaudeChoice = { model: 'claude-opus-4-8', perm: 'plan', effort: 'low' };
const WANTED: ClaudeChoice = { model: 'claude-fable-5-1', perm: 'bypassPermissions', effort: 'max' };

test('projectChoice: no project, or one with no preferences, is Opus 5.5 / Always ask / Default', () => {
  const fallback: ClaudeChoice = { model: 'claude-opus-5-5', perm: 'default', effort: 'default' };
  assert.deepEqual(projectChoice(undefined), fallback);
  assert.deepEqual(projectChoice({}), fallback);
});

test('projectChoice: each stored preference, the bare alias and the legacy mode included', () => {
  assert.deepEqual(projectChoice({ defaultModel: 'fable', defaultMode: 'skip-permissions' }), {
    model: 'claude-fable-5-1',
    perm: 'bypassPermissions',
    effort: 'default',
  });
  assert.deepEqual(
    projectChoice({ defaultModel: 'claude-sonnet-4-5', defaultPerm: 'acceptEdits', defaultMode: 'skip-permissions', defaultEffort: 'xhigh' }),
    { model: 'claude-sonnet-4-5', perm: 'acceptEdits', effort: 'xhigh' },
    'defaultPerm wins over the legacy mode',
  );
});

test('layerChoice on Claude Code: with no hand change the project’s choice is laid on whole', () => {
  assert.deepEqual(layerChoice('claude', HELD, WANTED, NONE), WANTED);
});

test('layerChoice: a field changed by hand this open stays, the others follow the project', () => {
  const fields: PrefField[] = ['model', 'perm', 'effort'];
  for (const f of fields) {
    const got = layerChoice('claude', HELD, WANTED, new Set([f]));
    for (const g of fields) {
      assert.equal(got[g], g === f ? HELD[g] : WANTED[g], `hand-changed ${f}: ${g}`);
    }
  }
  assert.deepEqual(layerChoice('claude', HELD, WANTED, new Set(fields)), HELD, 'all three by hand: nothing moves');
});

test('layerChoice: a No prompts preference never arms another tool — Codex, Gemini and Grok start on Always ask', () => {
  for (const agent of ['codex', 'gemini', 'grok'] as const) {
    const got = layerChoice(agent, HELD, WANTED, NONE);
    assert.equal(got.perm, 'default', agent);
    assert.equal(got.model, WANTED.model, `${agent}: Claude Code’s own model still follows the project`);
  }
});

test('layerChoice: a mode picked by hand stays on any tool — it is the user’s, not the project’s', () => {
  const perm = new Set<PrefField>(['perm']);
  for (const agent of ['claude', 'codex', 'gemini', 'grok'] as const) {
    assert.equal(layerChoice(agent, { ...HELD, perm: 'bypassPermissions' }, WANTED, perm).perm, 'bypassPermissions', agent);
  }
});
