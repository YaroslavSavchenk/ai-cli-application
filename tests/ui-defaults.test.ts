/**
 * `web/src/ui/defaults.ts` — the in-memory shared launch-defaults store both
 * the settings panel (writer) and the launch dialog (reader) read from. DOM-
 * free (delegates to launch-args.ts's clampLaunchDefaults), so `node --test`
 * imports it directly. The guarantee: every write is CLAMPED, and getDefaults
 * returns the current clamped bag by value — the panel can't poison the dialog
 * with an unknown model/mode or a non-string command.
 *
 * State is module-level (one process), so each test seeds explicitly first.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initDefaults, getDefaults, setDefaults } from '../web/src/ui/defaults.ts';

test('initDefaults seeds a clamped copy from the boot prefs bag; getDefaults returns it', () => {
  initDefaults({ model: 'sonnet', permissionMode: 'plan', startupCommand: '/caveman', junk: 1 });
  assert.deepEqual(getDefaults(), {
    model: 'sonnet',
    permissionMode: 'plan',
    startupCommand: '/caveman',
  });
});

test('initDefaults with garbage / wrong-type / absent input degrades the store to {}', () => {
  // Unknown model, a legacy 2-value project mode that is NOT a ClaudePermissionMode,
  // and a non-string command are all dropped.
  initDefaults({ model: 'gpt-4', permissionMode: 'skip-permissions', startupCommand: 5 });
  assert.deepEqual(getDefaults(), {});
  initDefaults(undefined);
  assert.deepEqual(getDefaults(), {});
  initDefaults('not-an-object');
  assert.deepEqual(getDefaults(), {});
  initDefaults([1, 2, 3]);
  assert.deepEqual(getDefaults(), {});
});

test('setDefaults REPLACES (not merges) the live store, re-clamping — the launch dialog reads the new bag fresh', () => {
  initDefaults({ model: 'opus' });
  setDefaults({ model: 'haiku', permissionMode: 'acceptEdits' });
  assert.deepEqual(getDefaults(), { model: 'haiku', permissionMode: 'acceptEdits' });
  // Replace semantics: the earlier `model: opus` is gone, not merged.
  setDefaults({ startupCommand: '/x' });
  assert.deepEqual(getDefaults(), { startupCommand: '/x' });
  setDefaults({});
  assert.deepEqual(getDefaults(), {});
});
