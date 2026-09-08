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
  KINDS,
  KIND_LABEL,
  SHELLS,
  composeSpawn,
  isKind,
  isShellId,
  shellLabel,
  shellSpawn,
} from '../web/src/ui/launch-args.ts';
import type { Effort, LaunchForm, LaunchKind, Perm, ShellId, SpawnSpec } from '../web/src/ui/launch-args.ts';

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
// Session kind + the plain-terminal shells (2026-09-08)
// ---------------------------------------------------------------------------
//
// `composeSpawn` is the ONE composition path `currentSpawn()` in launch.ts
// calls for all three kinds, so what these tests pin IS the POST /api/sessions
// body. The claude branch delegates to the composeArgs cases above; the other
// two are pinned here byte-exact, because a shell spawned with the wrong argv
// is a session that opens and immediately dies.

/** A form bag with the dialog's own initial values; each test overrides what it means. */
function form(over: Partial<LaunchForm> = {}): LaunchForm {
  return {
    kind: 'claude',
    model: 'opus',
    perm: 'default',
    continueLast: false,
    effort: 'default',
    shell: 'wsl',
    customLine: '',
    ...over,
  };
}

test('vocabulary: the kind switch is exactly three kinds, claude first (the pre-selected one)', () => {
  assert.deepEqual([...KINDS], ['claude', 'terminal', 'other']);
  assert.equal(KINDS[0], 'claude');
  for (const k of KINDS) assert.ok(isKind(k));
  for (const bad of ['shell', 'Claude', '', 'terminal ', 7, null, undefined]) {
    assert.equal(isKind(bad), false, JSON.stringify(bad));
  }
});

test('vocabulary: two shells — the WSL login shell and PowerShell through interop, argv byte-exact', () => {
  assert.deepEqual(
    SHELLS.map((s) => ({ id: s.id, command: s.command, args: [...s.args] })),
    [
      { id: 'wsl', command: '/bin/bash', args: ['-l'] },
      { id: 'powershell', command: 'powershell.exe', args: ['-NoLogo'] },
    ],
  );
  for (const s of SHELLS) assert.ok(isShellId(s.id));
  for (const bad of ['bash', 'pwsh', '', 'WSL', 3, null, undefined]) {
    assert.equal(isShellId(bad), false, JSON.stringify(bad));
  }
});

test('shellSpawn: each id spawns its own command + args, and the returned args are a COPY', () => {
  assert.deepEqual(shellSpawn('wsl'), { command: '/bin/bash', args: ['-l'] });
  assert.deepEqual(shellSpawn('powershell'), { command: 'powershell.exe', args: ['-NoLogo'] });
  const spawned = shellSpawn('wsl');
  spawned.args.push('mutated');
  assert.deepEqual(shellSpawn('wsl').args, ['-l'], 'the table must not be mutable through a spawn');
});

test('shellSpawn: an id outside the vocabulary falls back to the first shell, never to nothing', () => {
  assert.deepEqual(shellSpawn('nope' as ShellId), { command: '/bin/bash', args: ['-l'] });
});

test('composeSpawn: the claude kind is `claude` + composeArgs, unchanged', () => {
  assert.deepEqual(composeSpawn(form({ model: 'sonnet', perm: 'acceptEdits', effort: 'high' })), {
    command: 'claude',
    args: ['--model', 'sonnet', '--permission-mode', 'acceptEdits', '--effort', 'high'],
  });
  assert.deepEqual(composeSpawn(form({ continueLast: true })), {
    command: 'claude',
    args: ['--model', 'opus', '--continue'],
  });
});

test('composeSpawn: the terminal kind spawns the chosen shell and NOTHING claude-shaped', () => {
  for (const s of SHELLS) {
    const spawn = composeSpawn(
      // Claude-only fields deliberately set to non-defaults: they must not leak.
      form({ kind: 'terminal', shell: s.id, perm: 'bypassPermissions', effort: 'max', continueLast: true }),
    );
    // Read the argv BEFORE the deepEqual: node's assert narrows its first
    // argument to the expected type, which would make these checks vacuous.
    const args: string[] = spawn?.args ?? [];
    for (const flag of ['--model', '--continue', '--permission-mode', '--effort']) {
      assert.equal(args.includes(flag), false, `${s.id} must not carry ${flag}`);
    }
    assert.deepEqual(spawn, { command: s.command, args: [...s.args] }, s.id);
  }
});

test('composeSpawn: the other kind is the whitespace-split custom line, blank -> null', () => {
  assert.deepEqual(composeSpawn(form({ kind: 'other', customLine: 'htop --tree' })), {
    command: 'htop',
    args: ['--tree'],
  });
  assert.equal(composeSpawn(form({ kind: 'other', customLine: '   ' })), null);
});

test('composeSpawn: a blank custom line only blocks the OTHER kind — the two real kinds always spawn', () => {
  assert.notEqual(composeSpawn(form({ kind: 'claude', customLine: '' })), null);
  assert.notEqual(composeSpawn(form({ kind: 'terminal', customLine: '' })), null);
});

test('composeSpawn: every kind answers, and only the composed kind is read', () => {
  // A form carrying values for ALL three kinds at once (which is exactly the
  // dialog's state — the fields keep what the user typed) must compose the
  // selected kind and ignore the rest.
  const full = form({ kind: 'claude', shell: 'powershell', customLine: 'htop' });
  const byKind: Record<LaunchKind, unknown> = {
    claude: { command: 'claude', args: ['--model', 'opus'] },
    terminal: { command: 'powershell.exe', args: ['-NoLogo'] },
    other: { command: 'htop', args: [] },
  };
  for (const k of KINDS) {
    assert.deepEqual(composeSpawn({ ...full, kind: k }), byKind[k], k);
  }
});

test('composeSpawn: a kind is INVARIANT under every field that belongs to another kind', () => {
  // The dialog keeps what the user typed in the controls it hides, so the form
  // handed to composeSpawn always carries values for all three kinds at once.
  // Stronger than the byKind case above: each kind's output is composed once
  // per combination of the OTHER kinds' fields and must never move.
  const claudeVariants: Partial<LaunchForm>[] = [
    { model: 'opus', perm: 'default', continueLast: false, effort: 'default' },
    { model: 'sonnet', perm: 'bypassPermissions', continueLast: true, effort: 'max' },
    { model: 'haiku', perm: 'plan', continueLast: true, effort: 'low' },
  ];
  const shellVariants: ShellId[] = SHELLS.map((s) => s.id);
  const lineVariants = ['', '   ', 'htop --tree', '/usr/bin/env python3 -i'];

  // claude: neither the shell nor the custom line may reach the argv.
  const claudeBase = composeSpawn(form({ kind: 'claude' }));
  for (const shell of shellVariants) {
    for (const customLine of lineVariants) {
      assert.deepEqual(composeSpawn(form({ kind: 'claude', shell, customLine })), claudeBase, `${shell}|${customLine}`);
    }
  }

  // terminal: none of the four claude controls, and not the custom line either.
  for (const shell of shellVariants) {
    const base = composeSpawn(form({ kind: 'terminal', shell }));
    for (const claude of claudeVariants) {
      for (const customLine of lineVariants) {
        assert.deepEqual(composeSpawn(form({ kind: 'terminal', shell, customLine, ...claude })), base, shell);
      }
    }
  }

  // other: the typed line and nothing else.
  for (const customLine of lineVariants) {
    const base = composeSpawn(form({ kind: 'other', customLine }));
    for (const shell of shellVariants) {
      for (const claude of claudeVariants) {
        assert.deepEqual(composeSpawn(form({ kind: 'other', customLine, shell, ...claude })), base, customLine);
      }
    }
  }
  // Non-vacuity: the three bases really are three different spawns.
  assert.equal(new Set([claudeBase, null].map((s) => JSON.stringify(s))).size, 2);
});

test('composeSpawn: the returned args are a COPY — a caller mutating the POST body cannot poison the next launch', () => {
  // The POST body is built from this result; `api.createSession` and the log
  // line both read `spawn.args`. A shared array would make one launch's argv
  // leak into the next one for the whole page lifetime.
  const first = composeSpawn(form({ kind: 'terminal', shell: 'powershell' }));
  assert.notEqual(first, null);
  (first as SpawnSpec).args.push('--poisoned');
  (first as SpawnSpec).args[0] = '--stomped';
  assert.deepEqual(composeSpawn(form({ kind: 'terminal', shell: 'powershell' })), {
    command: 'powershell.exe',
    args: ['-NoLogo'],
  });
  assert.deepEqual(shellSpawn('powershell').args, ['-NoLogo']);
  assert.deepEqual([...SHELLS[1].args], ['-NoLogo'], 'the SHELLS table itself must be untouched');
});

test('shellLabel: the two shells the app composes read as product names; anything else stays null', () => {
  assert.equal(shellLabel('/bin/bash'), 'WSL shell');
  assert.equal(shellLabel('powershell.exe'), 'PowerShell');
  // A custom command the user typed is echoed verbatim by the caller — never
  // relabelled by resemblance.
  for (const other of ['bash', '/usr/bin/bash', 'pwsh', 'claude', 'htop', '']) {
    assert.equal(shellLabel(other), null, other);
  }
});

test('copy rule: the kind and shell words are plain names — no command, no path, no extension', () => {
  assert.deepEqual(Object.values(KIND_LABEL), ['Claude', 'Terminal', 'Other']);
  for (const k of KINDS) {
    assertPlainCopy(KIND_LABEL[k], 'kind label');
    assert.match(KIND_LABEL[k], /^[A-Za-z]+$/, `a kind label is one word: ${KIND_LABEL[k]}`);
  }
  for (const s of SHELLS) {
    assertPlainCopy(s.label, 'shell label');
    assert.equal(s.label.includes('.exe'), false, s.label);
    assert.equal(s.label.includes('/'), false, s.label);
    assert.equal(
      s.label.toLowerCase().includes(s.command.toLowerCase()),
      false,
      `the shell label must not be its command: ${s.label}`,
    );
  }
});

test('type-level guard: LaunchKind and ShellId are the literal unions the dialog binds to', () => {
  const kinds: LaunchKind[] = ['claude', 'terminal', 'other'];
  const shells: ShellId[] = ['wsl', 'powershell'];
  assert.deepEqual(kinds, [...KINDS]);
  assert.deepEqual(shells, SHELLS.map((s) => s.id));
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
// SpawnSpec equivalence (launch.ts's currentSpawn() -> composeSpawn())
// ---------------------------------------------------------------------------
//
// `currentSpawn()` in web/src/ui/launch.ts is NOT DOM-free-importable: it
// pulls in ./panes.ts -> @xterm/xterm, which throws at import time under
// plain node:test. Per the gate instructions, this is covered-by-probe, not
// by an executable test — no browser harness added. What it does is read the
// dialog's controls into a `LaunchForm` and hand that to `composeSpawn(f)`,
// the ONE composition path for all three kinds (2026-09-08); `composeSpawn`
// itself is DOM-free and directly under test above, and its claude branch is
// exactly `{ command: 'claude', args: composeArgs(...) }` — the same
// composeArgs under test above. So these tests cover the argv contents of
// every branch; only the DOM-sourced plumbing that fills the LaunchForm
// (kind/model/perm/continue/effort/shell/custom line) is untested here.

test('type-level guard: Perm and Effort are the literal unions the dialog binds to', () => {
  // A compile-time assertion with a runtime body — if either type widened to
  // `string`, the assignments below would stop being exhaustive checks.
  const perms: Perm[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];
  const efforts: Effort[] = ['default', 'low', 'medium', 'high', 'xhigh', 'max'];
  assert.deepEqual(perms, PERMS.map((p) => p.mode));
  assert.deepEqual(efforts, [...EFFORTS]);
});
