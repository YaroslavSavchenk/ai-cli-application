/**
 * `web/src/ui/project-prefs-model.ts` — a project's launch preferences as the
 * Add a project and Edit project dialogs show and send them, part D1
 * (`.claude/plans/nocturne/PLAN-D1.md`): the three choice lists, the stored
 * project -> select values mapping, the create fields and the Edit PATCH body.
 *
 * Seam: the pure model, imported and called. The two dialogs are driven
 * through the DOM in `ui-addproject-dom.test.ts` and `ui-project-edit.test.ts`;
 * the server's own validation of the PATCH is the backend's tests.
 *
 * Why it matters: Save must send ONLY what changed (a stored bare alias must
 * not be rewritten by opening and saving), and No preference must clear.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Project } from '../../shared/protocol.ts';
import {
  EFFORT_PREF_CHOICES,
  MODEL_PREF_CHOICES,
  NAME_REQUIRED,
  NO_PREFS,
  PERM_PREF_CHOICES,
  createPrefFields,
  editPatch,
  isDangerPerm,
  prefValuesOf,
} from '../../web/src/ui/project-prefs-model.ts';
import { CLAUDE_MODELS } from '../../web/src/ui/launch-args.ts';

const P: Project = { id: 'p1', name: 'demo-api', path: '/home/you/demo-api', createdAt: '2026-10-13T00:00:00Z' };

test('the three lists open with No preference (value empty), then words only', () => {
  for (const list of [MODEL_PREF_CHOICES, PERM_PREF_CHOICES, EFFORT_PREF_CHOICES]) {
    assert.deepEqual(list[0], { id: '', label: 'No preference' });
  }
  assert.deepEqual(MODEL_PREF_CHOICES.slice(1), [...CLAUDE_MODELS], 'the whole pool, Older group marks kept');
  assert.deepEqual(
    PERM_PREF_CHOICES.slice(1).map((c) => c.label),
    ['Always ask', 'Auto edits', 'Read only', 'No prompts'],
  );
  assert.deepEqual(
    EFFORT_PREF_CHOICES.slice(1).map((c) => [c.id, c.label]),
    [['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra high'], ['max', 'Max']],
    'the Default sentinel is what No preference means, never a second option',
  );
});

test('prefValuesOf: nothing stored shows No preference everywhere', () => {
  assert.deepEqual(prefValuesOf(P), NO_PREFS);
});

test('prefValuesOf: a bare alias shows as the model it launches; an id outside the pool shows No preference', () => {
  assert.equal(prefValuesOf({ ...P, defaultModel: 'opus' }).model, 'claude-opus-5-5');
  assert.equal(prefValuesOf({ ...P, defaultModel: 'claude-opus-4-1' }).model, 'claude-opus-4-1');
  assert.equal(prefValuesOf({ ...P, defaultModel: 'claude-opus-9' }).model, '');
});

test('prefValuesOf: the legacy skip-permissions shows as No prompts; defaultPerm wins when both exist', () => {
  assert.equal(prefValuesOf({ ...P, defaultMode: 'skip-permissions' }).perm, 'bypassPermissions');
  assert.equal(prefValuesOf({ ...P, defaultMode: 'standard' }).perm, '');
  assert.equal(prefValuesOf({ ...P, defaultMode: 'skip-permissions', defaultPerm: 'plan' }).perm, 'plan');
  assert.equal(prefValuesOf({ ...P, defaultEffort: 'high' }).effort, 'high');
});

test('createPrefFields: only what was chosen, and never the legacy defaultMode', () => {
  assert.deepEqual(createPrefFields(NO_PREFS), {});
  assert.deepEqual(createPrefFields({ model: 'claude-opus-4-8', perm: 'acceptEdits', effort: 'max' }), {
    defaultModel: 'claude-opus-4-8',
    defaultPerm: 'acceptEdits',
    defaultEffort: 'max',
  });
  assert.deepEqual(createPrefFields({ model: '', perm: 'bypassPermissions', effort: '' }), {
    defaultPerm: 'bypassPermissions',
  });
});

test('editPatch: nothing touched sends an empty body — a stored alias is not rewritten', () => {
  const p = { ...P, defaultModel: 'opus' };
  const before = prefValuesOf(p);
  assert.deepEqual(editPatch(p, 'demo-api', before, before), { patch: {} });
  assert.deepEqual(editPatch(p, '  demo-api  ', before, before), { patch: {} }, 'a name that only gained spaces');
});

test('editPatch: only the changed fields, and No preference sends null', () => {
  const p: Project = { ...P, defaultModel: 'claude-opus-5-5', defaultPerm: 'plan', defaultEffort: 'high' };
  const before = prefValuesOf(p);
  assert.deepEqual(editPatch(p, 'demo-api', before, { ...before, model: 'claude-opus-4-8' }), {
    patch: { defaultModel: 'claude-opus-4-8' },
  });
  assert.deepEqual(editPatch(p, 'demo-api', before, NO_PREFS), {
    patch: { defaultModel: null, defaultPerm: null, defaultEffort: null },
  });
  assert.deepEqual(editPatch(p, ' api v2 ', before, { ...before, perm: 'bypassPermissions' }), {
    patch: { name: 'api v2', defaultPerm: 'bypassPermissions' },
  });
});

test('editPatch: a blank name is refused with the create rule’s sentence, nothing sent', () => {
  assert.deepEqual(editPatch(P, '   ', NO_PREFS, NO_PREFS), { error: NAME_REQUIRED });
  assert.equal(NAME_REQUIRED, 'A project name is required.');
});

test('isDangerPerm: only No prompts wears the danger edge', () => {
  assert.equal(isDangerPerm('bypassPermissions'), true);
  for (const v of ['', 'default', 'acceptEdits', 'plan', 'skip-permissions']) assert.equal(isDangerPerm(v), false, v);
});
