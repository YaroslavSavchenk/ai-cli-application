/**
 * Integration of the NEW settings modules along the exact DOM-free path the
 * launch dialog runs — the store (`defaults.ts`) feeding the precedence chain
 * (`launch-args.ts` resolveModel/resolvePerm) and the arm registry
 * (`startup.ts`). Each piece is unit-tested in isolation elsewhere; this file
 * proves their COMPOSITION, mirroring web/src/ui/launch.ts byte-for-byte:
 *
 *   applyDefaults() (launch.ts:289-294):
 *     const g = getDefaults();
 *     modelSel.value = resolveModel(g, p?.defaultModel);
 *     setPerm(resolvePerm(g, p?.defaultMode));
 *
 *   arm on launch (launch.ts:365, claude-mode only):
 *     armStartupCommand(info.id, getDefaults().startupCommand ?? '');
 *
 * The guarantee under test: a settings-panel write (setDefaults) pre-selects
 * the NEXT dialog open with no reload; a per-project default still overrides
 * the global (the override is not locked); and the startup line handed to the
 * PTY comes from the CLAMPED store, so a dirty persisted bag can never smuggle
 * an extra line. State is a module singleton (one process — node --test runs
 * each *.test.ts in its own process), so every test seeds the store first.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initDefaults, getDefaults, setDefaults } from '../web/src/ui/defaults.ts';
import { resolveModel, resolvePerm } from '../web/src/ui/launch-args.ts';
import { armStartupCommand, consumeStartupCommand } from '../web/src/ui/startup.ts';
import type { PermissionMode } from '../shared/protocol.ts';

/** launch.ts applyDefaults(), reconstructed against the shared store. */
function preselect(
  projectModel?: string,
  projectMode?: PermissionMode,
): { model: string; perm: string } {
  const g = getDefaults();
  return { model: resolveModel(g, projectModel), perm: resolvePerm(g, projectMode) };
}

/** launch.ts:365 claude-mode arm — the store is the ONLY source of the line. */
function armFromStore(sessionId: string): void {
  armStartupCommand(sessionId, getDefaults().startupCommand ?? '');
}

test('a settings write pre-selects the NEXT dialog open — global default surfaces with no project default', () => {
  setDefaults({ model: 'sonnet', permissionMode: 'plan' });
  assert.deepEqual(preselect(undefined, undefined), { model: 'sonnet', perm: 'plan' });
});

test('a per-project default OVERRIDES the global — the override is not locked by the settings default', () => {
  setDefaults({ model: 'sonnet', permissionMode: 'plan' });
  // project defaultModel + defaultMode both win over the global settings default.
  assert.deepEqual(preselect('haiku', 'skip-permissions'), {
    model: 'haiku',
    perm: 'bypassPermissions',
  });
  // project `standard` asserts NO preference → the global still stands.
  assert.deepEqual(preselect(undefined, 'standard'), { model: 'sonnet', perm: 'plan' });
});

test('an empty store pre-selects the hardcoded fallback (opus / default)', () => {
  setDefaults({});
  assert.deepEqual(preselect(undefined, undefined), { model: 'opus', perm: 'default' });
});

test('live update: a second setDefaults changes the pre-selection with no reload (dialog reads getDefaults fresh)', () => {
  setDefaults({ model: 'opus' });
  assert.equal(preselect(undefined, undefined).model, 'opus');
  setDefaults({ model: 'haiku', permissionMode: 'acceptEdits' });
  assert.deepEqual(preselect(undefined, undefined), { model: 'haiku', perm: 'acceptEdits' });
});

test('a dirty BOOT prefs bag is clamped before it ever reaches the dialog — unknown model/mode fall through to the fallback', () => {
  initDefaults({ model: 'gpt-4', permissionMode: 'skip-permissions', junk: true });
  assert.deepEqual(preselect(undefined, undefined), { model: 'opus', perm: 'default' });
});

test('arm-from-store: a control-char-laden persisted startup line reaches the PTY path as ONE clean line', () => {
  // The real launch.ts:365 source is getDefaults().startupCommand — the CLAMPED
  // store, not the raw prefs bag. A \r/\n in the persisted bag is stripped by
  // initDefaults→clampLaunchDefaults, so arming can only ever carry one line.
  initDefaults({ startupCommand: '/foo\rrm -rf ~\n/bar' });
  assert.equal(getDefaults().startupCommand, '/foorm -rf ~/bar');
  armFromStore('s-dirty');
  assert.equal(consumeStartupCommand('s-dirty'), '/foorm -rf ~/bar');
  assert.equal(consumeStartupCommand('s-dirty'), null, 'reattach first-output must not re-type');
});

test('arm-from-store: an off (absent) startup command arms nothing — consume is null', () => {
  setDefaults({ model: 'opus' }); // no startupCommand member
  armFromStore('s-off');
  assert.equal(consumeStartupCommand('s-off'), null, 'empty store command = off, nothing typed');
});

test('arm-from-store: a whitespace-only persisted command strips to off — nothing is armed', () => {
  initDefaults({ startupCommand: '   \t ' });
  assert.equal(getDefaults().startupCommand, undefined);
  armFromStore('s-ws');
  assert.equal(consumeStartupCommand('s-ws'), null);
});
