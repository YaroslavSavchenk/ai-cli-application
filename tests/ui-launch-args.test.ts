/**
 * `web/src/ui/launch-args.ts` — the launch dialog's pure argv vocabulary AND
 * the plain-language copy layered over it. Deliberately DOM-free and
 * xterm-free so plain `node --test` can import it; this file is also the guard
 * that keeps it that way (an accidental DOM dependency would throw at import
 * time here).
 *
 * Two invariants under test:
 *   1. `composeArgs` is what the POST body carries, so what it produces IS what
 *      the server spawns.
 *   2. The copy rules are DISPLAY-ONLY: the labels are plain short words
 *      (`always ask`, `auto edits`, …) while every VALUE that reaches argv
 *      (`acceptEdits`, `--continue`, `--effort high`, …) is byte-exact. The
 *      composeArgs cases below are the guard for that half — they must never be
 *      relaxed to accommodate a wording change.
 *
 * REWRITTEN 2026-09-06 with the dialog: the preset chips, the resume select and
 * the readable launch summary were removed (user's call — "far too many
 * unnecessary things"), and an Effort level was added.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  composeArgs,
  parseCustomCommand,
  permFromDefaultMode,
  resolveModel,
  resolvePerm,
  isPerm,
  isModelId,
  isEffort,
  MODELS,
  PERMS,
  PERM_SHORT,
  EFFORTS,
  AGENT_LABEL,
} from '../web/src/ui/launch-args.ts';
import type { Effort, Perm } from '../web/src/ui/launch-args.ts';

// ---------------------------------------------------------------------------
// composeArgs (claude mode)
// ---------------------------------------------------------------------------

test('composeArgs: default perm + no effort + no continue -> model only', () => {
  assert.deepEqual(composeArgs('opus', 'default', false, 'default'), ['--model', 'opus']);
});

test('composeArgs: non-default perm adds --permission-mode <mode>', () => {
  assert.deepEqual(composeArgs('sonnet', 'acceptEdits', false, 'default'), [
    '--model',
    'sonnet',
    '--permission-mode',
    'acceptEdits',
  ]);
});

test('composeArgs: a chosen effort adds --effort <level>', () => {
  assert.deepEqual(composeArgs('opus', 'default', false, 'high'), [
    '--model',
    'opus',
    '--effort',
    'high',
  ]);
});

test('composeArgs: the `default` effort emits NOTHING — the sentinel names no level', () => {
  assert.equal(composeArgs('opus', 'default', false, 'default').includes('--effort'), false);
  assert.equal(composeArgs('opus', 'bypassPermissions', true, 'default').includes('--effort'), false);
});

test('composeArgs: continue appends --continue LAST', () => {
  assert.deepEqual(composeArgs('opus', 'acceptEdits', true, 'max'), [
    '--model',
    'opus',
    '--permission-mode',
    'acceptEdits',
    '--effort',
    'max',
    '--continue',
  ]);
});

test('composeArgs: continue without a mode or an effort -> --continue straight after the model', () => {
  assert.deepEqual(composeArgs('haiku', 'default', true, 'default'), [
    '--model',
    'haiku',
    '--continue',
  ]);
});

test('composeArgs: bypassPermissions goes through --permission-mode (never the skip flag)', () => {
  assert.deepEqual(composeArgs('opus', 'bypassPermissions', false, 'default'), [
    '--model',
    'opus',
    '--permission-mode',
    'bypassPermissions',
  ]);
});

test('composeArgs: every effort level in the vocabulary emits itself verbatim, except the sentinel', () => {
  for (const e of EFFORTS) {
    const args = composeArgs('opus', 'default', false, e);
    if (e === 'default') {
      assert.deepEqual(args, ['--model', 'opus'], 'the sentinel adds nothing');
      continue;
    }
    assert.deepEqual(args, ['--model', 'opus', '--effort', e]);
  }
});

test('composeArgs: the full cross product keeps its fixed order (model, mode, effort, continue)', () => {
  for (const p of PERMS) {
    for (const e of EFFORTS) {
      for (const cont of [false, true]) {
        const args = composeArgs('sonnet', p.mode, cont, e);
        const expected = ['--model', 'sonnet'];
        if (p.mode !== 'default') expected.push('--permission-mode', p.mode);
        if (e !== 'default') expected.push('--effort', e);
        if (cont) expected.push('--continue');
        assert.deepEqual(args, expected, `${p.mode} / ${e} / continue=${cont}`);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// parseCustomCommand (custom mode)
// ---------------------------------------------------------------------------

test('parseCustomCommand: first token = command, rest = args', () => {
  assert.deepEqual(parseCustomCommand('htop --tree'), { command: 'htop', args: ['--tree'] });
});

test('parseCustomCommand: collapses any whitespace runs (spaces, tabs)', () => {
  assert.deepEqual(parseCustomCommand('  bash \t -c   true '), {
    command: 'bash',
    args: ['-c', 'true'],
  });
});

test('parseCustomCommand: single token -> empty args', () => {
  assert.deepEqual(parseCustomCommand('bash'), { command: 'bash', args: [] });
});

test('parseCustomCommand: empty and whitespace-only input -> null (nothing to spawn)', () => {
  assert.equal(parseCustomCommand(''), null);
  assert.equal(parseCustomCommand('   \t '), null);
});

test('parseCustomCommand: NO shell semantics — quotes are plain characters, not grouping', () => {
  assert.deepEqual(parseCustomCommand(`echo "a b"`), { command: 'echo', args: ['"a', 'b"'] });
});

test('parseCustomCommand: a flag-like first token is preserved as the command (no special-casing)', () => {
  assert.deepEqual(parseCustomCommand('--weird foo'), { command: '--weird', args: ['foo'] });
});

// ---------------------------------------------------------------------------
// vocabulary invariants
// ---------------------------------------------------------------------------

test('permFromDefaultMode: skip-permissions -> bypass; standard/undefined -> null', () => {
  assert.equal(permFromDefaultMode('skip-permissions'), 'bypassPermissions');
  assert.equal(permFromDefaultMode('standard'), null);
  assert.equal(permFromDefaultMode(undefined), null);
});

test('vocabulary: 4 models per handoff', () => {
  assert.deepEqual([...MODELS], ['opus', 'sonnet', 'haiku', 'fable']);
});

test('vocabulary: PERMS is the fixed 4-mode set, in row order, exactly one dangerous', () => {
  assert.deepEqual(PERMS, [
    { mode: 'default', danger: false },
    { mode: 'acceptEdits', danger: false },
    { mode: 'plan', danger: false },
    { mode: 'bypassPermissions', danger: true },
  ]);
});

test('vocabulary: PERM_SHORT is the ONE label table — the mode segments AND the pane tag read from it', () => {
  assert.deepEqual(PERM_SHORT, {
    default: 'always ask',
    acceptEdits: 'auto edits',
    plan: 'read-only',
    bypassPermissions: 'no prompts',
  });
});

test("vocabulary: EFFORTS is Claude Code's own level list plus the app-only `default` sentinel", () => {
  // `claude --help` (2.1.263): --effort <level> ... (low, medium, high, xhigh, max)
  assert.deepEqual([...EFFORTS], ['default', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(EFFORTS[0], 'default', 'the sentinel is first — it is the pre-selected value');
});

/**
 * The code-shaped strings the copy rule bans from the UI. Only the camelCase
 * mode values are listed: `plan` and `default` are ordinary English words, so a
 * substring ban on those would be meaningless — the rule is about CLI syntax,
 * not vocabulary overlap.
 */
const CODE_SHAPED = ['acceptEdits', 'bypassPermissions', '--', '$'];

function assertPlainCopy(text: string, where: string): void {
  for (const bad of CODE_SHAPED) {
    assert.ok(!text.includes(bad), `${where} must not contain ${bad}: ${text}`);
  }
}

test('copy rule: every label the dialog renders is plain short words, no CLI value and no flag', () => {
  for (const v of Object.values(PERM_SHORT)) assertPlainCopy(v, 'mode segment label');
  assertPlainCopy(AGENT_LABEL, 'agent label');
  // Effort options are rendered verbatim; they are single plain words by
  // construction, and they must stay that way (a `--effort` label would leak a
  // flag into the select).
  for (const e of EFFORTS) {
    assertPlainCopy(e, 'effort option');
    assert.match(e, /^[a-z]+$/, `effort option must be one lowercase word: ${e}`);
  }
});

test('copy rule: a mode label change can never change the emitted argv', () => {
  // The VALUE is what composeArgs writes; the label lives in a separate table.
  for (const p of PERMS) {
    if (p.mode === 'default') continue;
    assert.ok(composeArgs('opus', p.mode, false, 'default').includes(p.mode));
    assert.equal(
      composeArgs('opus', p.mode, false, 'default').includes(PERM_SHORT[p.mode]),
      false,
      `the label ${PERM_SHORT[p.mode]} must never reach argv`,
    );
  }
});

// ---------------------------------------------------------------------------
// Pre-selection guards + precedence chain (launch dialog)
// ---------------------------------------------------------------------------

test('isPerm / isModelId / isEffort: only the fixed vocabularies pass', () => {
  for (const p of ['default', 'acceptEdits', 'plan', 'bypassPermissions']) assert.ok(isPerm(p));
  for (const bad of ['skip-permissions', 'standard', '', 'DEFAULT', 42, null, undefined]) {
    assert.equal(isPerm(bad), false);
  }
  for (const m of ['opus', 'sonnet', 'haiku', 'fable']) assert.ok(isModelId(m));
  for (const bad of ['gpt-4', 'Opus', '', 3, null]) assert.equal(isModelId(bad), false);
  for (const e of ['default', 'low', 'medium', 'high', 'xhigh', 'max']) assert.ok(isEffort(e));
  for (const bad of ['ultra', 'HIGH', '', 'none', 7, null, undefined]) {
    assert.equal(isEffort(bad), false);
  }
});

/*
 * The middle tier of both chains — an app-wide default stored by the settings
 * panel — was REMOVED 2026-07-26 with the panel section that wrote it. The
 * chains below are the whole remaining truth: a project's own default, else the
 * hardcoded fallback, with the per-launch choice always able to override both
 * (the dialog resolves once per open and stays editable).
 */

test('resolveModel: explicit project model > hardcoded MODELS[0]', () => {
  assert.equal(resolveModel('haiku'), 'haiku'); // project wins
  assert.equal(resolveModel(undefined), 'opus'); // hardcoded fallback
  assert.equal(resolveModel('gpt-4'), 'opus'); // unknown project model falls through
  assert.equal(resolveModel(''), 'opus');
});

test('resolvePerm: project skip-permissions > hardcoded default', () => {
  assert.equal(resolvePerm('skip-permissions'), 'bypassPermissions'); // project wins
  assert.equal(resolvePerm(undefined), 'default'); // hardcoded fallback
});

test('resolvePerm: legacy project mode `standard` never asserts a preference — it lands on the hardcoded `default`, NEVER on bypass', () => {
  // `standard` maps to NO override (permFromDefaultMode returns null).
  assert.equal(resolvePerm('standard'), 'default');
});

test('vocabulary alignment: isPerm accepts EXACTLY the PERMS modes — guards PERMS/isPerm drift', () => {
  assert.deepEqual(PERMS.map((p) => p.mode), ['default', 'acceptEdits', 'plan', 'bypassPermissions']);
  for (const p of PERMS) assert.ok(isPerm(p.mode), `PERMS mode ${p.mode} must pass isPerm`);
  assert.equal(PERMS.filter((p) => p.danger).length, 1, 'exactly one danger mode (bypassPermissions)');
  assert.equal(PERMS.find((p) => p.danger)?.mode, 'bypassPermissions');
  // PERM_SHORT must stay TOTAL over the vocabulary: a mode without a label
  // would render as an empty segment.
  for (const p of PERMS) assert.equal(typeof PERM_SHORT[p.mode], 'string');
});

// ---------------------------------------------------------------------------
// SpawnSpec claude-mode equivalence (launch.ts's currentSpawn(), claude branch)
// ---------------------------------------------------------------------------
//
// `currentSpawn()` in web/src/ui/launch.ts is NOT DOM-free-importable: it
// pulls in ./panes.ts -> @xterm/xterm, which throws at import time under
// plain node:test. Per the gate instructions, this is covered-by-probe, not
// by an executable test — no browser harness added. The claude branch is:
//   customMode ? parseCustomCommand(cmdInput.value)
//              : { command: 'claude', args: composeArgs(modelSel.value, perm, continueLast, effort) }
// i.e. exactly `{ command: 'claude', args: composeArgs(...) }` — the same
// composeArgs under test above, so these tests transitively cover the argv
// contents of that branch; only the `command: 'claude'` literal and the
// DOM-sourced (model/perm/continue/effort) plumbing are untested here.

test('type-level guard: Perm and Effort are the literal unions the dialog binds to', () => {
  // A compile-time assertion with a runtime body — if either type widened to
  // `string`, the assignments below would stop being exhaustive checks.
  const perms: Perm[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];
  const efforts: Effort[] = ['default', 'low', 'medium', 'high', 'xhigh', 'max'];
  assert.deepEqual(perms, PERMS.map((p) => p.mode));
  assert.deepEqual(efforts, [...EFFORTS]);
});
