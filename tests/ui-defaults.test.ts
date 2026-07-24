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
import {
  initStatusBar,
  getStatusBar,
  setStatusBar,
  statusBarDefaults,
} from '../web/src/ui/defaults.ts';
import type { StatusBarCfg } from '../web/src/ui/defaults.ts';

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

// ---------------------------------------------------------------------------
// Terminal status-bar toggles — clampStatusBar (via init/set/get/defaults).
// The store resolves an untrusted UiStatusBar bag to a fully-populated
// StatusBarCfg: every key present, absent/garbage members falling to their
// per-key factory default (ON: model/mode/branch/cost/context; OFF:
// time/diff/skill).
// ---------------------------------------------------------------------------

const FACTORY: StatusBarCfg = {
  model: true,
  mode: true,
  branch: true,
  cost: true,
  context: true,
  time: false,
  diff: false,
  skill: false,
};

test('statusBarDefaults() is the factory ON/OFF set (ON: model/mode/branch/cost/context; OFF: time/diff/skill), returned by value', () => {
  assert.deepEqual(statusBarDefaults(), FACTORY);
  const a = statusBarDefaults();
  a.model = false;
  assert.equal(statusBarDefaults().model, true, 'callers cannot mutate the shared default');
});

test('initStatusBar with absent / garbage / wrong-shape input resolves to the full factory defaults', () => {
  for (const bad of [undefined, null, 'nope', 42, true, [1, 2, 3]]) {
    initStatusBar(bad);
    assert.deepEqual(getStatusBar(), FACTORY, `input ${JSON.stringify(bad)} → factory defaults`);
  }
});

test('clampStatusBar fills every key: a partial bag keeps its booleans and defaults the rest', () => {
  // Turn a normally-OFF item on and a normally-ON item off; leave the rest absent.
  initStatusBar({ time: true, model: false });
  assert.deepEqual(getStatusBar(), {
    model: false, // explicitly off
    mode: true,
    branch: true,
    cost: true,
    context: true,
    time: true, // explicitly on
    diff: false,
    skill: false,
  });
});

test('clampStatusBar coerces per key: non-boolean members fall to their default, never a truthy/falsy string', () => {
  initStatusBar({ model: 'yes', time: 1, diff: 'x', cost: null, skill: {} });
  // Every provided member is a non-boolean → each takes its per-key default.
  assert.deepEqual(getStatusBar(), FACTORY);
});

test('setStatusBar REPLACES and re-clamps; getStatusBar returns a fresh copy each call', () => {
  initStatusBar(FACTORY);
  setStatusBar({ skill: true }); // only skill provided
  assert.deepEqual(getStatusBar(), { ...FACTORY, skill: true });

  const got = getStatusBar();
  got.branch = false;
  assert.equal(getStatusBar().branch, true, 'mutating a returned copy must not poison the store');
});

test('a full explicit bag round-trips verbatim (the exact inverse of the defaults)', () => {
  const inverse: StatusBarCfg = {
    model: false,
    mode: false,
    branch: false,
    cost: false,
    context: false,
    time: true,
    diff: true,
    skill: true,
  };
  initStatusBar(inverse);
  assert.deepEqual(getStatusBar(), inverse);
});
