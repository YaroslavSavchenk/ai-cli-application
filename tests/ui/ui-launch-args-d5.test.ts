/**
 * `web/src/ui/launch-args.ts` + `web/src/ui/format-model.ts` +
 * `shared/protocol.ts` — part D5 (`.claude/plans/PLAN-NOCTURNE.md`, user
 * decision 17, 2026-10-13, revised the same day): Always ask passes
 * `--permission-mode manual` explicitly to Claude Code, and to no other tool;
 * the app's own value stays `default` wherever it is stored; the pane's Mode
 * readout treats `manual`, an explicit `default` and no flag alike.
 *
 * Seam: the pure modules, imported and called (DOM-free by design). The dialog
 * path for a project whose preference is Always ask is pinned in
 * `ui-launch-dialog-d1.test.ts`; the server reader in
 * `tests/server/session-settings.test.ts`.
 *
 * Why it matters: with no flag Claude Code picks its own mode — verify-terminal
 * on 2026-09-27 saw 2.1.283 open in `auto mode` with no `defaultMode` in
 * `~/.claude/settings.json` — so the card that says "Asks before every edit or
 * command." did not keep that promise. `manual` is the name 2.1.287's help
 * documents (acceptEdits / auto / bypassPermissions / manual / dontAsk / plan);
 * `default` is only a hidden value there.
 *
 * NOT claimed: what Claude Code does with the flag; the orchestrator's
 * /verify-terminal run checks a live launch.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLAUDE_PERMISSION_MODES, claudePermissionFromFlag } from '../../shared/protocol.ts';
import { permFromArgs } from '../../web/src/ui/format-model.ts';
import { AGENT_KINDS, composeArgs, composeSpawn, resolvePerm } from '../../web/src/ui/launch-args.ts';
import { form } from '../helpers/ui-launch-args-fixture.ts';

test('Always ask: Claude Code gets `--permission-mode manual`, right after the model', () => {
  assert.deepEqual(composeArgs('claude-opus-5-5', 'default', false, 'default'), [
    '--model',
    'claude-opus-5-5',
    '--permission-mode',
    'manual',
  ]);
  assert.deepEqual(composeSpawn(form({ kind: 'claude', perm: 'default', effort: 'low', continueLast: true })), {
    command: 'claude',
    args: ['--model', 'claude-opus-5-5', '--permission-mode', 'manual', '--effort', 'low', '--continue'],
  });
});

test('the other three modes reach the CLI under their own names', () => {
  for (const mode of ['acceptEdits', 'plan', 'bypassPermissions'] as const) {
    assert.deepEqual(composeArgs('claude-opus-5-5', mode, false, 'default'), [
      '--model',
      'claude-opus-5-5',
      '--permission-mode',
      mode,
    ]);
  }
});

test('Always ask: Codex, Gemini CLI and Grok are unchanged — no `--permission-mode` for any of them', () => {
  const got: Record<string, unknown> = {};
  for (const k of AGENT_KINDS) {
    if (k === 'claude') continue;
    const spawn = composeSpawn(form({ kind: k, perm: 'default' }));
    // Read the argv BEFORE the deepEqual: assert narrows its first argument.
    const args: string[] = spawn?.args ?? [];
    assert.equal(args.includes('--permission-mode'), false, k);
    assert.equal(args.includes('manual'), false, `${k} never sees the claude value`);
    got[k] = spawn;
  }
  assert.deepEqual(got, {
    codex: { command: 'codex', args: ['-a', 'on-request', '-s', 'read-only'] },
    gemini: { command: 'gemini', args: [] },
    grok: { command: 'grok', args: [] },
  });
});

test('a project preference of Always ask stays `default` inside the app and launches with `manual`', () => {
  for (const [defaultPerm, defaultMode] of [
    ['default', undefined],
    ['default', 'skip-permissions'],
    [undefined, 'standard'],
    [undefined, undefined],
  ] as const) {
    const perm = resolvePerm(defaultPerm, defaultMode);
    assert.equal(perm, 'default', `${defaultPerm}/${defaultMode}: no migration, the stored value is unchanged`);
    assert.deepEqual(composeSpawn(form({ perm }))?.args, ['--model', 'claude-opus-5-5', '--permission-mode', 'manual']);
  }
});

test('reading a flag back: both names of Always ask are `default`, the others are themselves, the rest unknown', () => {
  assert.equal(claudePermissionFromFlag('manual'), 'default');
  for (const m of CLAUDE_PERMISSION_MODES) assert.equal(claudePermissionFromFlag(m), m, m);
  for (const odd of ['auto', 'dontAsk', 'Manual', '', 'toString', '__proto__']) {
    assert.equal(claudePermissionFromFlag(odd), undefined, JSON.stringify(odd));
  }
});

test('the pane Mode readout: `manual`, an explicit `default` and no flag all read the same — no Mode', () => {
  assert.equal(permFromArgs([]), null, 'non-vacuity: no flag shows no Mode');
  assert.deepEqual(permFromArgs(['--permission-mode', 'manual']), permFromArgs([]));
  assert.deepEqual(permFromArgs(['--permission-mode=manual']), permFromArgs([]));
  assert.deepEqual(permFromArgs(['--permission-mode', 'default']), permFromArgs([]));
  assert.deepEqual(permFromArgs(['--permission-mode=default']), permFromArgs([]));
  assert.deepEqual(
    permFromArgs(['--model', 'claude-opus-5-5', '--permission-mode', 'manual', '--continue']),
    permFromArgs(['--model', 'claude-opus-5-5', '--continue']),
    'an old session (no flag) and a D5 one read the same',
  );
  // Non-vacuity: a mode that IS shown still is, and an unknown one is verbatim.
  assert.deepEqual(permFromArgs(['--permission-mode', 'plan']), { label: 'Read only', danger: false });
  assert.deepEqual(permFromArgs(['--permission-mode', 'bypassPermissions']), { label: 'No prompts', danger: true });
  assert.deepEqual(permFromArgs(['--permission-mode', 'auto']), { label: 'auto', danger: false });
});
