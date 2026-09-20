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
 *      (`Always ask`, `Auto edits`, …) while every VALUE that reaches argv
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
import { readdirSync, readFileSync } from 'node:fs';
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
  SHELLS,
  composeSpawn,
  isKind,
  isShellId,
  shellLabel,
  shellSpawn,
  PERM_HELP,
  MODEL_LABEL,
  modelLabel,
  EFFORT_LABEL,
  NOT_INSTALLED,
  TOOL_CARDS,
  SHELL_CARDS,
  START_FROM,
  continueFromStart,
  isStartFrom,
  AGENT_KINDS,
  TOOLS,
  GROK_PERM_HINT,
  composeCodexArgs,
  composeGeminiArgs,
  composeGrokArgs,
  isAgentKind,
  isToolModel,
  isToolEffort,
  isToolStart,
  commandLabel,
} from '../web/src/ui/launch-args.ts';
import type {
  AgentKind,
  Effort,
  LaunchForm,
  LaunchKind,
  Perm,
  ShellId,
  SpawnSpec,
  StartFrom,
} from '../web/src/ui/launch-args.ts';

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

test('vocabulary: PERM_SHORT is the ONE label table — the permission cards AND the pane Mode read from it', () => {
  // Sentence case since Nocturne A4 (2026-09-10): the v3 handoff's own words.
  assert.deepEqual(PERM_SHORT, {
    default: 'Always ask',
    acceptEdits: 'Auto edits',
    plan: 'Read only',
    bypassPermissions: 'No prompts',
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
  // The effort VALUES are argv tokens (the select shows EFFORT_LABEL since
  // Nocturne A4, pinned below). They stay single plain words anyway: a value
  // is also what the launch log line prints, and a `--effort`-shaped value
  // would be a flag hiding inside a token.
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

test('vocabulary: the kind switch is exactly six kinds, claude first (the pre-selected one)', () => {
  assert.deepEqual([...KINDS], ['claude', 'codex', 'gemini', 'grok', 'terminal', 'other']);
  assert.equal(KINDS[0], 'claude');
  for (const k of KINDS) assert.ok(isKind(k));
  for (const bad of ['shell', 'Claude', '', 'terminal ', 'Codex', 7, null, undefined]) {
    assert.equal(isKind(bad), false, JSON.stringify(bad));
  }
  // The four that render an agent form; Terminal and Other never do.
  assert.deepEqual([...AGENT_KINDS], ['claude', 'codex', 'gemini', 'grok']);
  for (const k of AGENT_KINDS) assert.ok(isAgentKind(k) && isKind(k), k);
  for (const k of ['terminal', 'other', '', 'CLAUDE', 5, null, undefined]) {
    assert.equal(isAgentKind(k), false, JSON.stringify(k));
  }
});

test('vocabulary: four shells — two WSL, two through interop, argv byte-exact', () => {
  assert.deepEqual(
    SHELLS.map((s) => ({ id: s.id, command: s.command, args: [...s.args] })),
    [
      { id: 'wsl', command: '/bin/bash', args: ['-l'] },
      { id: 'zsh', command: 'zsh', args: ['-l'] },
      { id: 'powershell', command: 'powershell.exe', args: ['-NoLogo'] },
      // Command Prompt sends NO args: cmd.exe refuses a UNC working directory,
      // so the SERVER appends the tail that walks it into the project folder.
      { id: 'cmd', command: 'cmd.exe', args: [] },
    ],
  );
  for (const s of SHELLS) assert.ok(isShellId(s.id));
  for (const bad of ['bash', 'pwsh', '', 'WSL', 'Zsh', 3, null, undefined]) {
    assert.equal(isShellId(bad), false, JSON.stringify(bad));
  }
});

test('shellSpawn: each id spawns its own command + args, and the returned args are a COPY', () => {
  assert.deepEqual(shellSpawn('wsl'), { command: '/bin/bash', args: ['-l'] });
  assert.deepEqual(shellSpawn('zsh'), { command: 'zsh', args: ['-l'] });
  assert.deepEqual(shellSpawn('powershell'), { command: 'powershell.exe', args: ['-NoLogo'] });
  assert.deepEqual(shellSpawn('cmd'), { command: 'cmd.exe', args: [] });
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
    // The three B5 agents with no per-tool field set: their own defaults.
    codex: { command: 'codex', args: ['-a', 'on-request', '-s', 'read-only'] },
    gemini: { command: 'gemini', args: [] },
    grok: { command: 'grok', args: [] },
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
  const ps = SHELLS.find((s) => s.id === 'powershell');
  assert.deepEqual([...(ps?.args ?? [])], ['-NoLogo'], 'the SHELLS table itself must be untouched');
});

test('shellLabel: the four shells the app composes read as product names; anything else stays null', () => {
  assert.equal(shellLabel('/bin/bash'), 'Bash');
  assert.equal(shellLabel('zsh'), 'Zsh');
  assert.equal(shellLabel('powershell.exe'), 'PowerShell');
  assert.equal(shellLabel('cmd.exe'), 'Command Prompt');
  // A custom command the user typed is echoed verbatim by the caller — never
  // relabelled by resemblance.
  for (const other of ['bash', '/usr/bin/bash', '/usr/bin/zsh', 'cmd', 'pwsh', 'claude', 'htop', '']) {
    assert.equal(shellLabel(other), null, other);
  }
});

test('commandLabel: the four agents read as product names by BASENAME, shells exactly, anything else verbatim', () => {
  assert.deepEqual(
    ['claude', 'codex', 'gemini', 'grok'].map((c) => commandLabel(c)),
    ['Claude Code', 'Codex', 'Gemini CLI', 'Grok'],
  );
  // A path to an agent is still that agent; printing the path would put a
  // command in UI chrome (the isClaudeCommand rule, now for all four).
  assert.equal(commandLabel('/usr/local/bin/codex'), 'Codex');
  assert.equal(commandLabel('C:\\tools\\gemini'), 'Gemini CLI');
  assert.equal(commandLabel('/home/you/.local/bin/grok'), 'Grok');
  // The shells, by the table.
  assert.deepEqual(
    ['/bin/bash', 'zsh', 'powershell.exe', 'cmd.exe'].map((c) => commandLabel(c)),
    ['Bash', 'Zsh', 'PowerShell', 'Command Prompt'],
  );
  // Everything else is echoed exactly as typed — inventing a name for an
  // arbitrary command would be a lie about what is running.
  for (const raw of ['htop', '/usr/bin/env', 'Codex', 'GROK', 'codexx', '']) {
    assert.equal(commandLabel(raw), raw, raw);
  }
  // A command that names an Object.prototype member must not find a label there.
  for (const raw of ['toString', 'constructor', '__proto__', 'hasOwnProperty', 'valueOf']) {
    assert.equal(commandLabel(raw), raw, raw);
  }
});

test('copy rule: the shell words are plain names — no command, no path, no extension', () => {
  for (const s of SHELLS) {
    assertPlainCopy(s.label, 'shell label');
    assert.equal(s.label.includes('.exe'), false, s.label);
    assert.equal(s.label.includes('/'), false, s.label);
    // The label may not BE the command. Case matters and is the whole point:
    // `Zsh` is the product's own name, `zsh` is the executable, and the two
    // layers stay separate even when one word serves both (B5).
    assert.notEqual(s.label, s.command, `the shell label must not be its command: ${s.label}`);
    assert.equal(
      s.command.includes(s.label),
      false,
      `the command must not carry the label verbatim: ${s.command}`,
    );
  }
});

test('type-level guard: LaunchKind and ShellId are the literal unions the dialog binds to', () => {
  const kinds: LaunchKind[] = ['claude', 'codex', 'gemini', 'grok', 'terminal', 'other'];
  const shells: ShellId[] = ['wsl', 'zsh', 'powershell', 'cmd'];
  const agents: AgentKind[] = ['claude', 'codex', 'gemini', 'grok'];
  assert.deepEqual(kinds, [...KINDS]);
  assert.deepEqual(shells, SHELLS.map((s) => s.id));
  assert.deepEqual(agents, [...AGENT_KINDS]);
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

// ---------------------------------------------------------------------------
// Nocturne A4 (2026-09-10): every dialog state -> the argv it emitted BEFORE
// ---------------------------------------------------------------------------
//
// The dialog took the v3 layout: a Tool card grid (replacing the Claude /
// Terminal / Other segments), Shell cards (replacing the two shell segments),
// Permission cards (replacing the mode segments) and a Start from select
// (replacing the "Continue last conversation" checkbox). None of that may move
// a single argv byte. The expectations below are written out LITERALLY — the
// argv the pre-A4 dialog produced for the same choice — never derived from the
// code under test.

/** The cards a user can actually pick, and the kind each one launches. */
test('A4/B5 tool cards: six cards in v3 order, every one of them launching a real kind', () => {
  assert.deepEqual(
    TOOL_CARDS.map((t) => [t.id, t.label, t.kind]),
    [
      ['claude', 'Claude Code', 'claude'],
      ['codex', 'Codex', 'codex'],
      ['gemini', 'Gemini CLI', 'gemini'],
      ['grok', 'Grok', 'grok'],
      ['terminal', 'Terminal', 'terminal'],
      ['other', 'Other', 'other'],
    ],
  );
  // Every kind has exactly one card, in the kind vocabulary's own order. Since
  // B5 no card is inert in the TABLE — what a card cannot do is decided at
  // runtime by what the backend finds on its PATH.
  assert.deepEqual(TOOL_CARDS.map((t) => t.kind), [...KINDS]);
  assert.equal(TOOL_CARDS[0].label, AGENT_LABEL, 'the agent card IS the agent product name');
});

test('A4 tool cards: each selectable card spawns exactly what its old segment spawned', () => {
  const byCard: Record<string, SpawnSpec | null> = {};
  for (const t of TOOL_CARDS) {
    byCard[t.id] = composeSpawn(form({ kind: t.kind, customLine: 'htop --tree' }));
  }
  assert.deepEqual(byCard, {
    claude: { command: 'claude', args: ['--model', 'opus'] },
    codex: { command: 'codex', args: ['-a', 'on-request', '-s', 'read-only'] },
    gemini: { command: 'gemini', args: [] },
    grok: { command: 'grok', args: [] },
    terminal: { command: '/bin/bash', args: ['-l'] },
    other: { command: 'htop', args: ['--tree'] },
  });
});

test('A4/B5 shell cards: four cards, each wired to its SHELLS entry byte for byte', () => {
  assert.deepEqual(
    SHELL_CARDS.map((c) => [c.id, c.label, c.sub, c.shell]),
    [
      ['bash', 'Bash', 'WSL', 'wsl'],
      ['zsh', 'Zsh', 'WSL', 'zsh'],
      ['powershell', 'PowerShell', 'Windows', 'powershell'],
      ['cmd', 'Command Prompt', 'Windows', 'cmd'],
    ],
  );
  const spawned: Record<string, SpawnSpec | null> = {};
  for (const c of SHELL_CARDS) {
    spawned[c.id] = composeSpawn(form({ kind: 'terminal', shell: c.shell }));
  }
  assert.deepEqual(spawned, {
    bash: { command: '/bin/bash', args: ['-l'] },
    zsh: { command: 'zsh', args: ['-l'] },
    // v3 draws `pwsh.exe`; the app keeps today's argv (not adopted in A4).
    powershell: { command: 'powershell.exe', args: ['-NoLogo'] },
    cmd: { command: 'cmd.exe', args: [] },
  });
  // Every shell has exactly one card, in the SHELLS order.
  assert.deepEqual(SHELL_CARDS.map((c) => c.shell), SHELLS.map((s) => s.id));
});

test('A4 Start from: `The last conversation in this project` IS the old checkbox — --continue, last', () => {
  assert.deepEqual(
    START_FROM.map((s) => [s.value, s.label]),
    [
      ['fresh', 'A fresh conversation'],
      ['continue', 'The last conversation in this project'],
    ],
  );
  assert.equal(continueFromStart('fresh'), false);
  assert.equal(continueFromStart('continue'), true);
  // Anything the select could not have produced is a fresh start, never a resume.
  for (const odd of ['', 'Continue', 'resume', 'last']) assert.equal(continueFromStart(odd), false, odd);
  for (const s of START_FROM) assert.ok(isStartFrom(s.value));
  for (const bad of ['', 'resume', 'CONTINUE', 1, null, undefined]) assert.equal(isStartFrom(bad), false);

  assert.deepEqual(composeSpawn(form({ continueLast: continueFromStart('continue') })), {
    command: 'claude',
    args: ['--model', 'opus', '--continue'],
  });
  assert.deepEqual(composeSpawn(form({ continueLast: continueFromStart('fresh') })), {
    command: 'claude',
    args: ['--model', 'opus'],
  });
  // The checkbox's hardest case, now reached through the select.
  assert.deepEqual(
    composeSpawn(
      form({ model: 'fable', perm: 'bypassPermissions', effort: 'xhigh', continueLast: continueFromStart('continue') }),
    ),
    {
      command: 'claude',
      args: ['--model', 'fable', '--permission-mode', 'bypassPermissions', '--effort', 'xhigh', '--continue'],
    },
  );
});

test('A4 full matrix: model x permission card x effort x Start from -> the pre-A4 argv, spelled out', () => {
  // Pre-A4 recipe, written independently of composeArgs: `claude --model <m>`,
  // then `--permission-mode <p>` unless always-ask, then `--effort <e>` unless
  // default, then `--continue` when the checkbox (now: Start from) said so.
  let n = 0;
  for (const m of MODELS) {
    for (const p of PERMS) {
      for (const e of EFFORTS) {
        for (const s of START_FROM) {
          const expected: string[] = ['--model', m];
          if (p.mode !== 'default') expected.push('--permission-mode', p.mode);
          if (e !== 'default') expected.push('--effort', e);
          if (s.value === 'continue') expected.push('--continue');
          const got = composeSpawn(
            form({ model: m, perm: p.mode, effort: e, continueLast: continueFromStart(s.value) }),
          );
          assert.deepEqual(got, { command: 'claude', args: expected }, `${m}/${p.mode}/${e}/${s.value}`);
          n++;
        }
      }
    }
  }
  assert.equal(n, 4 * 4 * 6 * 2, 'the matrix must really cover every state');
});

test('A4 other card: the custom line with and without a project spawns what it always did', () => {
  // The project never enters argv (it is the cwd); pinned here so a future
  // card-level refactor cannot start threading it through composeSpawn.
  assert.deepEqual(composeSpawn(form({ kind: 'other', customLine: '/bin/echo hi' })), {
    command: '/bin/echo',
    args: ['hi'],
  });
  assert.equal(composeSpawn(form({ kind: 'other', customLine: '' })), null);
});

test('A4 display labels: capitalised model and effort words, the VALUES unchanged', () => {
  assert.deepEqual(MODEL_LABEL, { opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku', fable: 'Fable' });
  assert.deepEqual(EFFORT_LABEL, {
    default: 'Default',
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    xhigh: 'Extra high',
    max: 'Max',
  });
  // Total over the vocabularies — a value without a label would render empty.
  for (const m of MODELS) assert.equal(typeof MODEL_LABEL[m], 'string');
  for (const e of EFFORTS) assert.equal(typeof EFFORT_LABEL[e], 'string');
});

test('A4 copy rule: no label the dialog shows ever reaches argv, and every one is plain copy', () => {
  const shown: string[] = [
    ...Object.values(MODEL_LABEL),
    ...Object.values(EFFORT_LABEL),
    ...Object.values(PERM_SHORT),
    ...TOOL_CARDS.flatMap((t) => [t.label, t.sub]),
    ...SHELL_CARDS.flatMap((c) => [c.label, c.sub]),
    ...START_FROM.map((s) => s.label),
    ...AGENT_KINDS.flatMap((k) => [
      ...TOOLS[k].models.map((m) => m.label),
      ...TOOLS[k].efforts.map((e) => e.label),
      ...TOOLS[k].starts.map((s) => s.label),
      ...TOOLS[k].inertPerms.map((p) => p.hint),
    ]),
    NOT_INSTALLED,
  ];
  for (const text of shown) {
    assertPlainCopy(text, 'dialog label');
    for (const sep of ['·', '—', ' | ']) assert.equal(text.includes(sep), false, `separator in ${text}`);
  }
  // Across the whole matrix, argv carries values only — never a display word.
  const displayOnly = new Set(
    shown.filter((t) => !(MODELS as readonly string[]).includes(t) && !(EFFORTS as readonly string[]).includes(t)),
  );
  for (const m of MODELS) {
    for (const p of PERMS) {
      for (const e of EFFORTS) {
        const args = composeArgs(m, p.mode, true, e);
        for (const a of args) assert.equal(displayOnly.has(a), false, `display word ${a} reached argv`);
      }
    }
  }
});

test('A4 marks: every tile is at most two glyphs and never a command name', () => {
  assert.deepEqual(
    TOOL_CARDS.map((t) => t.mark),
    ['CC', 'CX', 'GM', 'GK', '>_', '…'],
  );
  for (const t of TOOL_CARDS) {
    assert.ok([...t.mark].length <= 2, t.mark);
    for (const cmd of ['claude', 'codex', 'gemini', 'grok', 'bash', 'sh', 'htop']) {
      assert.notEqual(t.mark.toLowerCase(), cmd, `${t.id}: a tile must not be a command`);
    }
  }
});

test('B5 inert hint: one plain string, and `Not available yet` is gone from the whole frontend', () => {
  assert.equal(NOT_INSTALLED, 'Not installed');
  assertPlainCopy(NOT_INSTALLED, 'inert hint');
  // Nothing in the card TABLES is inert any more: availability is a runtime
  // answer (GET /api/tools), rendered by the dialog.
  assert.deepEqual(TOOL_CARDS.filter((t) => !isKind(t.kind)), []);
  assert.deepEqual(SHELL_CARDS.filter((c) => !isShellId(c.shell)), []);
  // The retired string may not survive anywhere in the frontend (the janitor
  // item in .claude/PLAN-B5.md's final gate).
  const webSrc = new URL('../web/src/', import.meta.url);
  const walk = (dir: URL): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory()
        ? walk(new URL(`${e.name}/`, dir))
        : e.name.endsWith('.ts')
          ? [readFileSync(new URL(e.name, dir), 'utf8')]
          : [],
    );
  const offenders = walk(webSrc).filter((src) => src.includes('Not available yet'));
  assert.equal(offenders.length, 0, '`Not available yet` must be gone from web/src');
});

test('A4 permission help: the ONE explanation, one short plain line per mode, total over PERMS', () => {
  assert.deepEqual(PERM_HELP, {
    default: 'Asks before every edit or command.',
    acceptEdits: 'Edits files without asking. Still asks before commands.',
    plan: 'Reads and plans. Changes nothing.',
    bypassPermissions: 'Does everything without asking. Use with care.',
  });
  for (const p of PERMS) {
    const line = PERM_HELP[p.mode];
    assert.equal(typeof line, 'string', p.mode);
    assertPlainCopy(line, 'permission help');
    assert.equal(line.includes('\n'), false, 'one line per mode');
    assert.ok(line.length <= 60, `short: ${line}`);
    for (const sep of ['·', '—', ' | ']) assert.equal(line.includes(sep), false, `separator in ${line}`);
    // It explains the mode in words; it never names the CLI value (only the
    // camelCase ones are checkable — `plan` and `default` are English words).
    for (const v of ['acceptEdits', 'bypassPermissions']) {
      assert.equal(line.includes(v), false, `${p.mode}: help names ${v}`);
    }
  }
});

test('type-level guard: StartFrom is the literal union the select binds to', () => {
  const starts: StartFrom[] = ['fresh', 'continue'];
  assert.deepEqual(starts, START_FROM.map((s) => s.value));
});

// ---------------------------------------------------------------------------
// Nocturne A4 gate additions (test-engineer, 2026-09-10): the rules the card
// and label tables must keep, stated as rules rather than as one snapshot.
// ---------------------------------------------------------------------------

test('A4 cards: every card holds a REAL vocabulary value; ids and labels are unique per grid', () => {
  for (const t of TOOL_CARDS) assert.ok(isKind(t.kind), `${t.id} -> ${t.kind}`);
  for (const c of SHELL_CARDS) assert.ok(isShellId(c.shell), `${c.id} -> ${c.shell}`);
  for (const grid of [TOOL_CARDS, SHELL_CARDS] as const) {
    const ids = grid.map((c) => c.id);
    const labels = grid.map((c) => c.label);
    assert.equal(new Set(ids).size, ids.length, `duplicate id in ${ids.join(',')}`);
    assert.equal(new Set(labels).size, labels.length, `duplicate label in ${labels.join(',')}`);
  }
  // No two cards launch the same thing: one card per kind, one per shell.
  const kinds = TOOL_CARDS.map((t) => t.kind);
  const shells = SHELL_CARDS.map((c) => c.shell);
  assert.equal(new Set(kinds).size, kinds.length);
  assert.equal(new Set(shells).size, shells.length);
});

test('A4 card ids are never vocabulary values: a smuggled card id falls back to the WSL shell', () => {
  // A CARD id and a VALUE id are separate layers (`bash` is the card, `wsl` the
  // shell). The only way a card could launch the wrong thing is its id leaking
  // into a value slot; every guard refuses it, and shellSpawn's fallback is the
  // first real shell — never nothing.
  assert.equal(isShellId('bash'), false);
  assert.deepEqual(shellSpawn('bash' as ShellId), { command: '/bin/bash', args: ['-l'] });
  // The tool cards' ids DO equal their kinds since B5 — stated, so a future
  // rename of one without the other shows up here.
  assert.deepEqual(TOOL_CARDS.map((t) => t.id), TOOL_CARDS.map((t) => t.kind));
});

test('A4 card copy never names a command, a path or a flag (sub-lines included)', () => {
  const words = [
    ...TOOL_CARDS.flatMap((t) => [t.label, t.sub]),
    ...SHELL_CARDS.flatMap((c) => [c.label, c.sub]),
  ];
  for (const w of words) {
    assertPlainCopy(w, 'card copy');
    assert.equal(w.includes('/'), false, `a path in card copy: ${w}`);
    assert.equal(w.includes('\\'), false, `a path in card copy: ${w}`);
    assert.equal(/\.exe\b/i.test(w), false, `an executable in card copy: ${w}`);
    assert.equal(/(^|\s)-{1,2}[A-Za-z]/.test(w), false, `a flag in card copy: ${w}`);
    for (const s of SHELLS) assert.equal(w.includes(s.command), false, `${w} names ${s.command}`);
    assert.equal(/\bclaude\b/.test(w), false, `the lowercase command name in card copy: ${w}`);
  }
});

test('A4 Start from: the FIRST option (what a select shows when nothing else is chosen) never continues', () => {
  // open() resets the select to `fresh`; if that value ever vanished, a real
  // <select> would fall back to its first option — which therefore must be
  // the fresh start, or a reopened dialog would silently send --continue.
  assert.equal(START_FROM[0].value, 'fresh');
  assert.equal(continueFromStart(START_FROM[0].value), false);
  assert.equal(START_FROM.filter((s) => continueFromStart(s.value)).length, 1, 'exactly one option continues');
  // continueFromStart only ever says yes to a value the select can hold.
  for (const v of ['continue', 'fresh', '', 'Continue', ' continue', 'continue ', 'resume', 'The last conversation in this project']) {
    if (continueFromStart(v)) assert.ok(isStartFrom(v), v);
  }
  // The LABEL is never mistaken for the value (a label-valued option would do exactly this).
  for (const s of START_FROM) assert.equal(continueFromStart(s.label), false, s.label);
});

test('A4 select labels: MODEL_LABEL and EFFORT_LABEL are keyed by exactly their vocabulary, in order, all distinct', () => {
  assert.deepEqual(Object.keys(MODEL_LABEL), [...MODELS]);
  assert.deepEqual(Object.keys(EFFORT_LABEL), [...EFFORTS]);
  for (const table of [MODEL_LABEL, EFFORT_LABEL] as Record<string, string>[]) {
    const labels = Object.values(table);
    assert.equal(new Set(labels).size, labels.length, `two options would read the same: ${labels.join(', ')}`);
    for (const l of labels) {
      assertPlainCopy(l, 'select label');
      assert.ok(l.trim() === l && l.length > 0, JSON.stringify(l));
    }
  }
  // A label is never itself a DIFFERENT vocabulary value (a select that shows
  // `high` for `xhigh` would read as a lie).
  for (const [k, l] of Object.entries(EFFORT_LABEL)) {
    for (const v of EFFORTS) if (v !== k) assert.notEqual(l.toLowerCase(), v, `${k} reads as ${v}`);
  }
});

test('modelLabel: a known model id reads as its MODEL_LABEL; any other value is echoed verbatim', () => {
  for (const m of MODELS) assert.equal(modelLabel(m), MODEL_LABEL[m], m);
  assert.equal(modelLabel('opus'), 'Opus');
  // A custom command's own --model value is never relabelled by resemblance.
  for (const raw of ['Opus', 'OPUS', 'opus ', 'claude-opus-4-1', 'gpt-5', '']) assert.equal(modelLabel(raw), raw, raw);
  // A value that names an Object.prototype member must not be looked up in the
  // table (`MODEL_LABEL[id] ?? id` would render `function toString() {...}` in
  // the drawer for a custom `--model toString`); only the MODELS guard admits a key.
  for (const raw of ['toString', 'constructor', '__proto__', 'hasOwnProperty', 'valueOf']) {
    assert.equal(modelLabel(raw), raw, raw);
  }
});

test('B5 modelLabel: EVERY tool`s model id reads as the word its dialog select showed', () => {
  // The pane status bar, the sessions drawer and the Earlier rows read `-m`
  // now, so a Codex / Gemini / Grok model must not reach them as a raw CLI id.
  for (const kind of AGENT_KINDS) {
    for (const m of TOOLS[kind].models) assert.equal(modelLabel(m.id), m.label, `${kind} ${m.id}`);
  }
  assert.equal(modelLabel('gpt-6-astra'), 'GPT-6 Astra');
  assert.equal(modelLabel('pro'), 'Pro');
  assert.equal(modelLabel('grok-4.6'), 'Grok 4.6');
  assert.equal(modelLabel('opus'), 'Opus', 'claude unchanged');
});

test('B5 model ids: one id never means two different words across the four tables', () => {
  // modelLabel is ONE table over all four tools, so a shared id (`default`)
  // must carry the same label everywhere, or the same word on screen would
  // mean two things — and `pro` could read as a Codex model.
  const seen = new Map<string, string>();
  for (const kind of AGENT_KINDS) {
    for (const m of TOOLS[kind].models) {
      const prev = seen.get(m.id);
      if (prev !== undefined) assert.equal(m.label, prev, `${m.id} reads two ways`);
      seen.set(m.id, m.label);
    }
  }
  // The ids that appear twice are exactly the sentinels that emit NOTHING, so
  // no argv (and therefore no status bar) can ever carry them.
  const counts = new Map<string, number>();
  for (const kind of AGENT_KINDS) {
    for (const m of TOOLS[kind].models) counts.set(m.id, (counts.get(m.id) ?? 0) + 1);
  }
  for (const [id, n] of counts) {
    if (n > 1) {
      const owners = AGENT_KINDS.filter((k) => TOOLS[k].models.some((m) => m.id === id));
      for (const k of owners) assert.equal(TOOLS[k].modelNone, id, `${k} emits ${id}`);
    }
  }
});

test('A4 PERM_HELP: plain sentences, one per mode, naming no flag, command or CLI value', () => {
  assert.deepEqual(Object.keys(PERM_HELP), PERMS.map((p) => p.mode));
  const lines = PERMS.map((p) => PERM_HELP[p.mode]);
  assert.equal(new Set(lines).size, lines.length, 'each mode explains itself differently');
  const banned = [
    'claude',
    'permission-mode',
    'permission mode',
    'dangerously',
    'skip-permissions',
    'bypass',
    'acceptedits',
    'bypasspermissions',
    'plan mode',
    '--',
    '`',
    '$',
  ];
  for (const p of PERMS) {
    const line = PERM_HELP[p.mode];
    assert.match(line, /^[A-Z][^\n]*\.$/, `${p.mode}: one sentence-cased line ending in a full stop`);
    for (const b of banned) assert.equal(line.toLowerCase().includes(b), false, `${p.mode}: names ${b}`);
    // It explains; it does not repeat another mode's label as if it were that mode.
    for (const q of PERMS) {
      if (q.mode !== p.mode) assert.equal(line.includes(PERM_SHORT[q.mode]), false, `${p.mode} quotes ${q.mode}`);
    }
  }
  // The danger mode's line carries the caution; no other line does.
  assert.ok(/care/i.test(PERM_HELP.bypassPermissions));
  for (const p of PERMS) if (!p.danger) assert.equal(/care|danger/i.test(PERM_HELP[p.mode]), false, p.mode);
});

// ---------------------------------------------------------------------------
// Nocturne B5 (2026-09-18): the other three agents, argv byte-exact
// ---------------------------------------------------------------------------
//
// The expectations below are written out LITERALLY from the verified-contract
// table in `.claude/PLAN-B5.md`, never derived from the code under test. Each
// tool's order is FIXED: model, permission, effort, then the start-from tail —
// and for Codex the tail is a SUBCOMMAND, so every option must precede it.

test('B5 Codex: the whole permission column, verbatim', () => {
  const byPerm: Record<string, string[]> = {};
  for (const p of PERMS) byPerm[p.mode] = composeCodexArgs('default', p.mode, 'default', 'fresh');
  assert.deepEqual(byPerm, {
    default: ['-a', 'on-request', '-s', 'read-only'],
    acceptEdits: ['-a', 'on-request', '-s', 'workspace-write'],
    plan: ['-a', 'never', '-s', 'read-only'],
    bypassPermissions: ['--dangerously-bypass-approvals-and-sandbox'],
  });
});

test('B5 Codex: models, efforts and start-from tails, each on its own', () => {
  assert.deepEqual(composeCodexArgs('gpt-6-astra', 'default', 'default', 'fresh'), [
    '-m', 'gpt-6-astra', '-a', 'on-request', '-s', 'read-only',
  ]);
  // `Default` names no model: the CLI keeps its own recommended one.
  assert.equal(composeCodexArgs('default', 'default', 'default', 'fresh').includes('-m'), false);
  assert.deepEqual(composeCodexArgs('default', 'default', 'xhigh', 'fresh'), [
    '-a', 'on-request', '-s', 'read-only', '-c', 'model_reasoning_effort=xhigh',
  ]);
  assert.deepEqual(composeCodexArgs('default', 'default', 'default', 'last'), [
    '-a', 'on-request', '-s', 'read-only', 'resume', '--last',
  ]);
  assert.deepEqual(composeCodexArgs('default', 'default', 'default', 'pick'), [
    '-a', 'on-request', '-s', 'read-only', 'resume',
  ]);
});

test('B5 Codex: the hardest state — options BEFORE the resume subcommand', () => {
  assert.deepEqual(composeCodexArgs('gpt-5.6-sol', 'acceptEdits', 'high', 'last'), [
    '-m', 'gpt-5.6-sol',
    '-a', 'on-request', '-s', 'workspace-write',
    '-c', 'model_reasoning_effort=high',
    'resume', '--last',
  ]);
  const args = composeCodexArgs('gpt-5.4-mini', 'bypassPermissions', 'minimal', 'pick');
  assert.deepEqual(args, [
    '-m', 'gpt-5.4-mini',
    '--dangerously-bypass-approvals-and-sandbox',
    '-c', 'model_reasoning_effort=minimal',
    'resume',
  ]);
  assert.ok(args.indexOf('resume') === args.length - 1, 'the subcommand is LAST');
});

test('B5 Codex: every model and every effort emits its own id, the sentinels nothing', () => {
  for (const m of TOOLS.codex.models) {
    const args = composeCodexArgs(m.id, 'default', 'default', 'fresh');
    assert.deepEqual(
      args,
      m.id === 'default'
        ? ['-a', 'on-request', '-s', 'read-only']
        : ['-m', m.id, '-a', 'on-request', '-s', 'read-only'],
      m.id,
    );
  }
  for (const e of TOOLS.codex.efforts) {
    const args = composeCodexArgs('default', 'default', e.id, 'fresh');
    assert.deepEqual(
      args,
      e.id === 'default'
        ? ['-a', 'on-request', '-s', 'read-only']
        : ['-a', 'on-request', '-s', 'read-only', '-c', `model_reasoning_effort=${e.id}`],
      e.id,
    );
  }
  // Codex has no `max` level (the CLI does not take one).
  assert.equal(TOOLS.codex.efforts.some((e) => e.id === 'max'), false);
});

test('B5 Gemini: the whole permission column and both start-from values, verbatim', () => {
  const byPerm: Record<string, string[]> = {};
  for (const p of PERMS) byPerm[p.mode] = composeGeminiArgs('auto', p.mode, 'fresh');
  assert.deepEqual(byPerm, {
    // Always ask IS Gemini's default: it emits nothing at all.
    default: [],
    acceptEdits: ['--approval-mode', 'auto_edit'],
    plan: ['--approval-mode', 'plan'],
    bypassPermissions: ['--approval-mode', 'yolo'],
  });
  assert.deepEqual(composeGeminiArgs('auto', 'default', 'last'), ['-r', 'latest']);
  assert.deepEqual(composeGeminiArgs('flash-lite', 'bypassPermissions', 'last'), [
    '-m', 'flash-lite', '--approval-mode', 'yolo', '-r', 'latest',
  ]);
});

test('B5 Gemini: every model but `Auto` emits itself; the tool has NO effort levels', () => {
  for (const m of TOOLS.gemini.models) {
    assert.deepEqual(
      composeGeminiArgs(m.id, 'default', 'fresh'),
      m.id === 'auto' ? [] : ['-m', m.id],
      m.id,
    );
  }
  assert.deepEqual([...TOOLS.gemini.efforts], [], 'the Effort control is hidden for Gemini CLI');
});

test('B5 Grok: only No prompts emits an approval flag; the two middle modes are inert', () => {
  const byPerm: Record<string, string[]> = {};
  for (const p of PERMS) byPerm[p.mode] = composeGrokArgs('default', p.mode, 'default', 'fresh');
  assert.deepEqual(byPerm, {
    default: [],
    // INERT cards: unreachable from the dialog, and they emit nothing even if a
    // value were smuggled past it.
    acceptEdits: [],
    plan: [],
    bypassPermissions: ['--always-approve'],
  });
  assert.deepEqual(
    TOOLS.grok.inertPerms.map((p) => [p.mode, p.hint]),
    [
      ['acceptEdits', GROK_PERM_HINT],
      ['plan', GROK_PERM_HINT],
    ],
  );
  assert.equal(GROK_PERM_HINT, 'Grok switches this inside the session');
});

test('B5 Grok: model, effort and the last-session tail, verbatim', () => {
  assert.deepEqual(composeGrokArgs('grok-4.6', 'default', 'default', 'fresh'), ['-m', 'grok-4.6']);
  assert.deepEqual(composeGrokArgs('default', 'default', 'high', 'fresh'), ['--effort', 'high']);
  assert.deepEqual(composeGrokArgs('default', 'default', 'default', 'last'), ['--continue']);
  assert.deepEqual(composeGrokArgs('grok-4.6', 'bypassPermissions', 'low', 'last'), [
    '-m', 'grok-4.6', '--always-approve', '--effort', 'low', '--continue',
  ]);
  for (const e of TOOLS.grok.efforts) {
    assert.deepEqual(
      composeGrokArgs('default', 'default', e.id, 'fresh'),
      e.id === 'default' ? [] : ['--effort', e.id],
      e.id,
    );
  }
});

test('B5 composeSpawn: each agent kind spawns ITS command with ITS argv', () => {
  assert.deepEqual(
    composeSpawn(form({ kind: 'codex', codexModel: 'gpt-5.5', codexEffort: 'medium', start: 'last', perm: 'plan' })),
    {
      command: 'codex',
      args: ['-m', 'gpt-5.5', '-a', 'never', '-s', 'read-only', '-c', 'model_reasoning_effort=medium', 'resume', '--last'],
    },
  );
  assert.deepEqual(composeSpawn(form({ kind: 'gemini', geminiModel: 'pro', perm: 'acceptEdits', start: 'last' })), {
    command: 'gemini',
    args: ['-m', 'pro', '--approval-mode', 'auto_edit', '-r', 'latest'],
  });
  assert.deepEqual(
    composeSpawn(form({ kind: 'grok', grokModel: 'grok-4.6', grokEffort: 'medium', perm: 'bypassPermissions', start: 'last' })),
    { command: 'grok', args: ['-m', 'grok-4.6', '--always-approve', '--effort', 'medium', '--continue'] },
  );
});

test('B5 composeSpawn: a value from ANOTHER tool never reaches this tool’s argv', () => {
  // The dialog keeps one control set pointed at whichever tool is chosen, so
  // the form always carries every tool's last value at once.
  const full: Partial<LaunchForm> = {
    model: 'fable',
    effort: 'max',
    continueLast: true,
    resumeId: 'conv-1',
    codexModel: 'gpt-6-astra',
    codexEffort: 'xhigh',
    geminiModel: 'flash',
    grokModel: 'grok-4.6',
    grokEffort: 'high',
    start: 'last',
    shell: 'cmd',
    customLine: 'htop --tree',
  };
  const got: Record<string, unknown> = {};
  for (const k of KINDS) got[k] = composeSpawn(form({ ...full, kind: k }));
  assert.deepEqual(got, {
    claude: { command: 'claude', args: ['--model', 'fable', '--effort', 'max', '--resume', 'conv-1'] },
    codex: {
      command: 'codex',
      args: ['-m', 'gpt-6-astra', '-a', 'on-request', '-s', 'read-only', '-c', 'model_reasoning_effort=xhigh', 'resume', '--last'],
    },
    gemini: { command: 'gemini', args: ['-m', 'flash', '-r', 'latest'] },
    grok: { command: 'grok', args: ['-m', 'grok-4.6', '--effort', 'high', '--continue'] },
    terminal: { command: 'cmd.exe', args: [] },
    other: { command: 'htop', args: ['--tree'] },
  });
});

test('B5 claude resume: a conversation id replaces --continue, never joins it', () => {
  assert.deepEqual(composeArgs('opus', 'default', false, 'default', 'abc-123'), [
    '--model', 'opus', '--resume', 'abc-123',
  ]);
  // Both asked for: the named conversation is the more specific ask and wins.
  const both = composeArgs('opus', 'default', true, 'default', 'abc-123');
  assert.deepEqual(both, ['--model', 'opus', '--resume', 'abc-123']);
  assert.equal(both.includes('--continue'), false);
  // An absent or empty id changes nothing about the pre-B5 argv.
  assert.deepEqual(composeArgs('opus', 'default', true, 'default', ''), ['--model', 'opus', '--continue']);
  assert.deepEqual(composeArgs('opus', 'default', true, 'default', undefined), ['--model', 'opus', '--continue']);
  assert.deepEqual(composeArgs('opus', 'default', false, 'default'), ['--model', 'opus']);
  // The tail stays LAST, after model, mode and effort.
  assert.deepEqual(composeArgs('sonnet', 'plan', true, 'high', 'zz'), [
    '--model', 'sonnet', '--permission-mode', 'plan', '--effort', 'high', '--resume', 'zz',
  ]);
  assert.deepEqual(composeSpawn(form({ resumeId: 'q-9', continueLast: true })), {
    command: 'claude',
    args: ['--model', 'opus', '--resume', 'q-9'],
  });
});

test('B5 tool vocabularies: labels are display-only and every id passes its own guard', () => {
  for (const k of AGENT_KINDS) {
    const v = TOOLS[k];
    assert.ok(v.command.length > 0, k);
    const ids = v.models.map((m) => m.id);
    assert.equal(new Set(ids).size, ids.length, `${k}: duplicate model id`);
    const labels = v.models.map((m) => m.label);
    assert.equal(new Set(labels).size, labels.length, `${k}: two models would read the same`);
    for (const m of v.models) assert.ok(isToolModel(k, m.id), `${k}/${m.id}`);
    for (const e of v.efforts) assert.ok(isToolEffort(k, e.id), `${k}/${e.id}`);
    for (const s of v.starts) assert.ok(isToolStart(k, s.value), `${k}/${s.value}`);
    // The sentinel is the FIRST option: a select falling back to its first
    // option must never name a model or a level the user did not choose.
    if (v.modelNone !== '') assert.equal(v.models[0]?.id, v.modelNone, `${k}: sentinel first`);
    if (v.efforts.length > 0) assert.equal(v.efforts[0]?.id, v.effortNone, `${k}: effort sentinel first`);
    // And Start from's first option is always the fresh one.
    assert.equal(v.starts[0]?.value, 'fresh', k);
    for (const x of [...v.models, ...v.efforts]) {
      assertPlainCopy(x.label, `${k} option label`);
      assert.ok(x.label.trim() === x.label && x.label.length > 0, JSON.stringify(x.label));
    }
    for (const s of v.starts) assertPlainCopy(s.label, `${k} start label`);
    for (const p of v.inertPerms) assertPlainCopy(p.hint, `${k} inert hint`);
  }
  // Nothing outside a tool's own vocabulary passes its guards.
  assert.equal(isToolModel('codex', 'opus'), false);
  assert.equal(isToolModel('gemini', 'grok-4.6'), false);
  assert.equal(isToolEffort('gemini', 'high'), false, 'Gemini CLI has no effort levels at all');
  assert.equal(isToolEffort('codex', 'max'), false);
  assert.equal(isToolStart('gemini', 'pick'), false);
  for (const bad of ['', 'GPT-6 Astra', 7, null, undefined]) {
    assert.equal(isToolModel('codex', bad), false, JSON.stringify(bad));
  }
});

test('B5 tool vocabularies: the model and effort tables, spelled out', () => {
  assert.deepEqual(
    TOOLS.codex.models.map((m) => [m.id, m.label]),
    [
      ['default', 'Default'],
      ['gpt-6-astra', 'GPT-6 Astra'],
      ['gpt-5.6-sol', 'GPT-5.6 Sol'],
      ['gpt-5.6-terra', 'GPT-5.6 Terra'],
      ['gpt-5.6-luna', 'GPT-5.6 Luna'],
      ['gpt-5.5', 'GPT-5.5'],
      ['gpt-5.4', 'GPT-5.4'],
      ['gpt-5.4-mini', 'GPT-5.4 Mini'],
    ],
  );
  assert.deepEqual(
    TOOLS.codex.efforts.map((e) => [e.id, e.label]),
    [
      ['default', 'Default'],
      ['minimal', 'Minimal'],
      ['low', 'Low'],
      ['medium', 'Medium'],
      ['high', 'High'],
      ['xhigh', 'Extra high'],
    ],
  );
  assert.deepEqual(
    TOOLS.gemini.models.map((m) => [m.id, m.label]),
    [
      ['auto', 'Auto'],
      ['pro', 'Pro'],
      ['flash', 'Flash'],
      ['flash-lite', 'Flash Lite'],
    ],
  );
  assert.deepEqual(
    TOOLS.grok.models.map((m) => [m.id, m.label]),
    [
      ['default', 'Default'],
      ['grok-4.6', 'Grok 4.6'],
    ],
  );
  assert.deepEqual(
    TOOLS.grok.efforts.map((e) => [e.id, e.label]),
    [
      ['default', 'Default'],
      ['low', 'Low'],
      ['medium', 'Medium'],
      ['high', 'High'],
    ],
  );
  // Claude Code's own tables are the pre-B5 ones, reused rather than re-typed.
  assert.deepEqual(TOOLS.claude.models.map((m) => m.id), [...MODELS]);
  assert.deepEqual(TOOLS.claude.efforts.map((e) => e.id), [...EFFORTS]);
  assert.equal(TOOLS.claude.command, 'claude');
});

test('B5 Start from, per tool: the words the select shows', () => {
  const byTool: Record<string, [string, string][]> = {};
  for (const k of AGENT_KINDS) byTool[k] = TOOLS[k].starts.map((s) => [s.value, s.label]);
  assert.deepEqual(byTool, {
    claude: [
      ['fresh', 'A fresh conversation'],
      ['continue', 'The last conversation in this project'],
    ],
    codex: [
      ['fresh', 'A fresh session'],
      ['last', 'The last session'],
      ['pick', 'Pick an earlier session'],
    ],
    gemini: [
      ['fresh', 'A fresh session'],
      ['last', 'The last session'],
    ],
    grok: [
      ['fresh', 'A fresh session'],
      ['last', 'The last session'],
    ],
  });
  // The fresh option never resumes anything, for any tool.
  for (const k of AGENT_KINDS) {
    assert.deepEqual(composeSpawn(form({ kind: k, start: 'fresh' }))?.args.includes('resume'), false, k);
  }
  assert.equal(composeGeminiArgs('auto', 'default', 'fresh').length, 0);
  assert.equal(composeGrokArgs('default', 'default', 'default', 'fresh').length, 0);
});

test('a value outside a tool’s OWN vocabulary emits nothing — including another tool’s id', () => {
  // The selects only ever hold ids from TOOLS, but composeSpawn's output IS the
  // POST /api/sessions body: a stale stored form, a kind switch that left the
  // other tool's value behind, or a hand-built LaunchForm must not be able to
  // put an unknown token into an argv.
  const CODEX_ASK = ['-a', 'on-request', '-s', 'read-only'];
  const smuggled = 'gpt-9-unknown; rm -rf ~';
  assert.deepEqual(composeCodexArgs(smuggled, 'default', 'default', 'fresh'), CODEX_ASK);
  assert.deepEqual(composeCodexArgs('default', 'default', smuggled, 'fresh'), CODEX_ASK);
  // `max` is claude's effort id and `flash` is gemini's model id: neither is codex's.
  assert.deepEqual(composeCodexArgs('flash', 'default', 'max', 'fresh'), CODEX_ASK);
  assert.deepEqual(composeGeminiArgs(smuggled, 'default', 'fresh'), []);
  assert.deepEqual(composeGeminiArgs('gpt-6-astra', 'default', 'fresh'), []);
  assert.deepEqual(composeGrokArgs(smuggled, 'default', smuggled, 'fresh'), []);
  assert.deepEqual(composeGrokArgs('gpt-5.5', 'default', 'xhigh', 'fresh'), []);
  // Through the one composition path as well.
  assert.deepEqual(composeSpawn(form({ kind: 'codex', codexModel: 'flash', codexEffort: 'max' })), {
    command: 'codex',
    args: CODEX_ASK,
  });
  assert.deepEqual(composeSpawn(form({ kind: 'gemini', geminiModel: 'grok-4.6' })), {
    command: 'gemini',
    args: [],
  });
  assert.deepEqual(composeSpawn(form({ kind: 'grok', grokModel: 'pro', grokEffort: 'xhigh' })), {
    command: 'grok',
    args: [],
  });
});

test('B5 copy rule: no tool label, hint or start-from word ever reaches any tool’s argv', () => {
  const shown = AGENT_KINDS.flatMap((k) => [
    ...TOOLS[k].models.map((m) => m.label),
    ...TOOLS[k].efforts.map((e) => e.label),
    ...TOOLS[k].starts.map((s) => s.label),
    ...TOOLS[k].inertPerms.map((p) => p.hint),
  ]);
  const emitted = new Set<string>();
  for (const p of PERMS) {
    for (const m of TOOLS.codex.models) {
      for (const e of TOOLS.codex.efforts) {
        for (const s of TOOLS.codex.starts) {
          for (const a of composeCodexArgs(m.id, p.mode, e.id, s.value)) emitted.add(a);
        }
      }
    }
    for (const m of TOOLS.gemini.models) {
      for (const s of TOOLS.gemini.starts) {
        for (const a of composeGeminiArgs(m.id, p.mode, s.value)) emitted.add(a);
      }
    }
    for (const m of TOOLS.grok.models) {
      for (const e of TOOLS.grok.efforts) {
        for (const s of TOOLS.grok.starts) {
          for (const a of composeGrokArgs(m.id, p.mode, e.id, s.value)) emitted.add(a);
        }
      }
    }
  }
  assert.ok(emitted.size > 20, `non-vacuity: ${emitted.size} distinct argv tokens composed`);
  for (const label of shown) assert.equal(emitted.has(label), false, `display word ${label} reached argv`);
  // And a label change can never move a byte: the ids are what compose.
  for (const k of AGENT_KINDS) {
    for (const m of TOOLS[k].models) {
      if (m.id === TOOLS[k].modelNone) continue;
      assert.ok(emitted.has(m.id) || k === 'claude', `${k}/${m.id} never composed`);
    }
  }
});
