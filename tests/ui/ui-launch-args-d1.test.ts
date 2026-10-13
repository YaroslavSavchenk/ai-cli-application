/**
 * `web/src/ui/launch-args.ts` — Claude Code's model pool and the project
 * preference resolvers, part D1 (`.claude/plans/nocturne/PLAN-D1.md`):
 * the pinned ids in their order and groups, the bare-alias map every pre-D1
 * `projects.json` relies on, the NAMED fallback (Opus 5.5), the byte-exact
 * argv, and the `defaultPerm` / `defaultEffort` tiers over the legacy
 * `defaultMode`.
 *
 * Seam: the pure module, imported and called (DOM-free by design).
 *
 * Why it matters: a pool entry in the wrong place, or an alias that resolves
 * to the wrong family, launches a different model than the select showed —
 * silently, because the screen only ever shows labels.
 *
 * NOT claimed: that Claude Code 2.1.287 accepts every id (checked against its
 * binary when the spec was written; the user's DEV check launches one), and
 * the select rendering (`ui-launch-dialog-d1.test.ts`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLAUDE_MODELS,
  MODEL_FALLBACK,
  OLDER_MODELS_LABEL,
  TOOLS,
  composeSpawn,
  isModelId,
  modelLabel,
  poolModel,
  resolveEffort,
  resolveModel,
  resolvePerm,
} from '../../web/src/ui/launch-args.ts';
import { form } from '../helpers/ui-launch-args-fixture.ts';

test('the pool: the newest four first, in the decided order, as plain options', () => {
  assert.deepEqual(
    CLAUDE_MODELS.filter((m) => m.older !== true).map((m) => [m.id, m.label]),
    [
      ['claude-fable-5-1', 'Fable 5.1'],
      ['claude-opus-5-5', 'Opus 5.5'],
      ['claude-sonnet-5-5', 'Sonnet 5.5'],
      ['claude-haiku-4-5', 'Haiku 4.5'],
    ],
  );
  assert.deepEqual(
    CLAUDE_MODELS.slice(0, 4).map((m) => m.older),
    [undefined, undefined, undefined, undefined],
    'the newest come first in the table too',
  );
});

test('the pool: every older model the installed Claude Code knows, after the newest, marked older', () => {
  assert.deepEqual(
    CLAUDE_MODELS.slice(4).map((m) => [m.id, m.label, m.older]),
    [
      ['claude-opus-5', 'Opus 5', true],
      ['claude-sonnet-5', 'Sonnet 5', true],
      ['claude-fable-5', 'Fable 5', true],
      ['claude-opus-4-8', 'Opus 4.8', true],
      ['claude-opus-4-7', 'Opus 4.7', true],
      ['claude-opus-4-6', 'Opus 4.6', true],
      ['claude-opus-4-5', 'Opus 4.5', true],
      ['claude-opus-4-1', 'Opus 4.1', true],
      ['claude-sonnet-4-6', 'Sonnet 4.6', true],
      ['claude-sonnet-4-5', 'Sonnet 4.5', true],
    ],
  );
  assert.equal(OLDER_MODELS_LABEL, 'Older models', 'sentence case, plain words');
  assert.equal(new Set(CLAUDE_MODELS.map((m) => m.id)).size, CLAUDE_MODELS.length, 'no id twice');
  assert.equal(new Set(CLAUDE_MODELS.map((m) => m.label)).size, CLAUDE_MODELS.length, 'no two options read alike');
});

test('only Claude Code has an Older group: the other tools keep flat lists', () => {
  for (const k of ['codex', 'gemini', 'grok'] as const) {
    assert.equal(TOOLS[k].models.some((m) => m.older === true), false, k);
  }
  assert.equal(TOOLS.claude.models, CLAUDE_MODELS);
});

test('the fallback is NAMED Opus 5.5, not "the first entry" (Fable 5.1 heads the list)', () => {
  assert.equal(MODEL_FALLBACK, 'claude-opus-5-5');
  assert.notEqual(CLAUDE_MODELS[0]?.id, MODEL_FALLBACK, 'non-vacuity: the first entry is another model');
  assert.equal(TOOLS.claude.modelStart, MODEL_FALLBACK, 'the select starts on it');
  assert.equal(resolveModel(undefined), 'claude-opus-5-5');
});

test('a stored bare alias resolves to today’s newest of its family', () => {
  const want: [string, string][] = [
    ['fable', 'claude-fable-5-1'],
    ['opus', 'claude-opus-5-5'],
    ['sonnet', 'claude-sonnet-5-5'],
    ['haiku', 'claude-haiku-4-5'],
  ];
  for (const [alias, id] of want) {
    assert.equal(resolveModel(alias), id, alias);
    assert.equal(poolModel(alias), id, alias);
    assert.equal(isModelId(alias), false, `${alias} is not itself a pool id`);
  }
});

test('a pool id is itself; an unknown id falls back to Opus 5.5 (and is no pool model)', () => {
  for (const m of CLAUDE_MODELS) assert.equal(resolveModel(m.id), m.id, m.id);
  for (const odd of ['claude-opus-9', 'Opus', 'OPUS', 'opus ', '', 'toString', '__proto__']) {
    assert.equal(resolveModel(odd), 'claude-opus-5-5', JSON.stringify(odd));
    assert.equal(poolModel(odd), undefined, JSON.stringify(odd));
  }
  assert.equal(poolModel(undefined), undefined);
});

test('argv: Opus 5.5 launches exactly `claude --model claude-opus-5-5 --permission-mode manual`, byte for byte', () => {
  assert.deepEqual(composeSpawn(form({ model: 'claude-opus-5-5' })), {
    command: 'claude',
    args: ['--model', 'claude-opus-5-5', '--permission-mode', 'manual'],
  });
  assert.deepEqual(composeSpawn(form({ model: 'claude-opus-4-8', perm: 'plan', effort: 'high' })), {
    command: 'claude',
    args: ['--model', 'claude-opus-4-8', '--permission-mode', 'plan', '--effort', 'high'],
  });
});

test('labels: every pool id reads as its name, and the bare aliases of old history rows still read as a word', () => {
  for (const m of CLAUDE_MODELS) assert.equal(modelLabel(m.id), m.label, m.id);
  assert.equal(modelLabel('opus'), 'Opus');
  assert.equal(modelLabel('fable'), 'Fable');
  assert.equal(modelLabel('sonnet'), 'Sonnet');
  assert.equal(modelLabel('haiku'), 'Haiku');
});

test('resolvePerm: defaultPerm wins over the legacy defaultMode, which still reads skip-permissions as bypass', () => {
  assert.equal(resolvePerm('plan', 'skip-permissions'), 'plan', 'defaultPerm wins when both exist');
  assert.equal(resolvePerm('default', 'skip-permissions'), 'default', 'an explicit Always ask wins too');
  assert.equal(resolvePerm(undefined, 'skip-permissions'), 'bypassPermissions');
  assert.equal(resolvePerm(undefined, 'standard'), 'default');
  assert.equal(resolvePerm('acceptEdits', undefined), 'acceptEdits');
  assert.equal(resolvePerm(undefined, undefined), 'default');
});

test('resolvePerm: a garbage defaultPerm (a hand-edited projects.json) falls through to the legacy defaultMode', () => {
  assert.equal(resolvePerm('yolo' as never, 'skip-permissions'), 'bypassPermissions');
  assert.equal(resolvePerm('yolo' as never, undefined), 'default');
});

test('resolveEffort: a stored level, else the Default sentinel that emits nothing', () => {
  for (const e of ['low', 'medium', 'high', 'xhigh', 'max'] as const) assert.equal(resolveEffort(e), e);
  assert.equal(resolveEffort(undefined), 'default');
});
