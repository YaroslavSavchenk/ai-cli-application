/**
 * `web/src/ui/launch-args.ts` — the launch dialog's pure argv vocabulary AND
 * the plain-language copy layered over it. Deliberately DOM-free and
 * xterm-free so plain `node --test` can import it; this file is also the guard
 * that keeps it that way (an accidental DOM dependency would throw at import
 * time here).
 *
 * Two invariants under test:
 *   1. The summary/preview and the POST body share these composers, so what
 *      they produce IS what the server spawns.
 *   2. The 2026-07-25 copy rule is DISPLAY-ONLY: labels are plain English
 *      ("Auto-approve edits", "Continue last conversation"), while every VALUE
 *      that reaches argv (`acceptEdits`, `--continue`, …) is byte-identical to
 *      before. The composeArgs cases below are the guard for that half — they
 *      must never be relaxed to accommodate a wording change.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  composeArgs,
  parseCustomCommand,
  previewLine,
  launchSummary,
  permFromDefaultMode,
  clampLaunchDefaults,
  resolveModel,
  resolvePerm,
  isPerm,
  isModelId,
  MODELS,
  PERMS,
  PERM_SHORT,
  CHIPS,
  RESUME_OPTIONS,
  AGENT_LABEL,
} from '../web/src/ui/launch-args.ts';
import type { Perm, Resume } from '../web/src/ui/launch-args.ts';
import type { UiLaunchDefaults } from '../shared/protocol.ts';

// ---------------------------------------------------------------------------
// composeArgs (claude mode)
// ---------------------------------------------------------------------------

test('composeArgs: default perm + fresh -> model only', () => {
  assert.deepEqual(composeArgs('opus', 'default', 'fresh'), ['--model', 'opus']);
});

test('composeArgs: non-default perm adds --permission-mode <mode>', () => {
  assert.deepEqual(composeArgs('sonnet', 'acceptEdits', 'fresh'), [
    '--model',
    'sonnet',
    '--permission-mode',
    'acceptEdits',
  ]);
});

test('composeArgs: continue appends --continue last (handoff preview order)', () => {
  assert.deepEqual(composeArgs('opus', 'acceptEdits', 'continue'), [
    '--model',
    'opus',
    '--permission-mode',
    'acceptEdits',
    '--continue',
  ]);
});

test('composeArgs: bypassPermissions goes through --permission-mode (never the skip flag)', () => {
  assert.deepEqual(composeArgs('opus', 'bypassPermissions', 'fresh'), [
    '--model',
    'opus',
    '--permission-mode',
    'bypassPermissions',
  ]);
});

test('composeArgs: default perm + continue -> --continue appended with NO --permission-mode in between', () => {
  assert.deepEqual(composeArgs('haiku', 'default', 'continue'), ['--model', 'haiku', '--continue']);
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
// previewLine (shared preview rendering)
// ---------------------------------------------------------------------------

test('previewLine: renders the exact spawn as `$ cmd args…`', () => {
  assert.equal(previewLine({ command: 'htop', args: ['--tree'] }), '$ htop --tree');
  assert.equal(previewLine({ command: 'bash', args: [] }), '$ bash');
});

test('previewLine(parseCustomCommand(x)) round-trips a normalized line', () => {
  const spec = parseCustomCommand('  htop   --tree ');
  assert.ok(spec !== null);
  assert.equal(previewLine(spec), '$ htop --tree');
});

// ---------------------------------------------------------------------------
// vocabulary invariants
// ---------------------------------------------------------------------------

test('permFromDefaultMode: skip-permissions -> bypass; standard/undefined -> null', () => {
  assert.equal(permFromDefaultMode('skip-permissions'), 'bypassPermissions');
  assert.equal(permFromDefaultMode('standard'), null);
  assert.equal(permFromDefaultMode(undefined), null);
});

test('vocabulary: 4 models per handoff; 3 claude preset chips (custom is a mode, not a CHIPS entry)', () => {
  assert.deepEqual([...MODELS], ['opus', 'sonnet', 'haiku', 'fable']);
  assert.equal(CHIPS.length, 3);
  assert.equal(CHIPS.filter((c) => c.danger).length, 1, 'exactly one danger chip (yolo)');
});

test('vocabulary: PERMS is the fixed 4-mode set (default/acceptEdits/plan/bypassPermissions) with PLAIN-LANGUAGE titles + descriptions, exactly one dangerous', () => {
  assert.deepEqual(PERMS, [
    { mode: 'default', title: 'Always ask', desc: 'before tools that need approval', danger: false },
    {
      mode: 'acceptEdits',
      title: 'Auto-approve edits',
      desc: 'file changes go through without asking',
      danger: false,
    },
    {
      mode: 'plan',
      title: 'Read-only planning',
      desc: 'looks and plans, changes nothing',
      danger: false,
    },
    {
      mode: 'bypassPermissions',
      title: 'Never ask',
      desc: 'no prompts at all · dangerous',
      danger: true,
    },
  ]);
});

/**
 * The code-shaped strings the 2026-07-25 copy rule bans from the UI. Only the
 * camelCase mode values are listed: `plan` and `default` are ordinary English
 * words (and "planning" contains one), so a substring ban on those would be
 * meaningless — the rule is about CLI syntax, not vocabulary overlap.
 */
const CODE_SHAPED = ['acceptEdits', 'bypassPermissions', '--', '$'];

function assertPlainCopy(text: string, where: string): void {
  for (const bad of CODE_SHAPED) {
    assert.ok(!text.includes(bad), `${where} must not contain ${bad}: ${text}`);
  }
}

test('copy rule: no permission-card label leaks a CLI mode value or a flag (the `mode` field still carries it)', () => {
  for (const p of PERMS) {
    assertPlainCopy(p.title, 'card title');
    assertPlainCopy(p.desc, 'card description');
  }
});

test('vocabulary: PERM_SHORT is the narrow-chip form of every mode (pane tag + status bar), plain words only', () => {
  assert.deepEqual(PERM_SHORT, {
    default: 'always ask',
    acceptEdits: 'auto edits',
    plan: 'read-only',
    bypassPermissions: 'no prompts',
  });
});

test('RESUME_OPTIONS: plain labels over the UNCHANGED fresh/continue values', () => {
  assert.deepEqual(RESUME_OPTIONS, [
    { value: 'fresh', label: 'Start fresh' },
    { value: 'continue', label: 'Continue last conversation' },
  ]);
  // The value — not the label — is what composeArgs turns into --continue.
  assert.deepEqual(composeArgs('opus', 'default', RESUME_OPTIONS[1]!.value), [
    '--model',
    'opus',
    '--continue',
  ]);
});

test('CHIPS mapping: deep work = opus+acceptEdits+continue', () => {
  assert.deepEqual(CHIPS[0], {
    label: 'deep work · opus · auto edits · continue',
    model: 'opus',
    perm: 'acceptEdits',
    resume: 'continue',
    danger: false,
  });
});

test('CHIPS mapping: quick fix = sonnet+default (fresh)', () => {
  assert.deepEqual(CHIPS[1], {
    label: 'quick fix · sonnet · always ask',
    model: 'sonnet',
    perm: 'default',
    resume: 'fresh',
    danger: false,
  });
});

test('CHIPS mapping: yolo = opus+bypassPermissions (fresh), the one danger chip', () => {
  assert.deepEqual(CHIPS[2], {
    label: 'yolo · opus · no prompts',
    model: 'opus',
    perm: 'bypassPermissions',
    resume: 'fresh',
    danger: true,
  });
});

test('copy rule: no chip label leaks a CLI mode value (the `perm` field still carries it)', () => {
  for (const c of CHIPS) assertPlainCopy(c.label, 'chip label');
  for (const r of RESUME_OPTIONS) assertPlainCopy(r.label, 'resume label');
  for (const v of Object.values(PERM_SHORT)) assertPlainCopy(v, 'short mode form');
});

// ---------------------------------------------------------------------------
// launchSummary — the readable replacement for the argv preview
// ---------------------------------------------------------------------------

test('launchSummary: three plain-language lines (agent · model / mode clause · resume clause / folder)', () => {
  assert.deepEqual(
    launchSummary(composeArgs('opus', 'acceptEdits', 'continue'), '/home/sava/projects/web-ui'),
    {
      head: 'Claude Code · opus',
      mode: 'auto-approves file edits',
      danger: false,
      resume: 'continues your last conversation',
      folder: 'folder: /home/sava/projects/web-ui',
    },
  );
});

test('launchSummary: every mode has a clause; only a bypass form is flagged danger', () => {
  const clauses = new Map<string, string>([
    ['default', 'asks before tools that need approval'],
    ['acceptEdits', 'auto-approves file edits'],
    ['plan', 'read-only planning, changes nothing'],
    ['bypassPermissions', 'never asks · dangerous'],
  ]);
  for (const p of PERMS) {
    const s = launchSummary(composeArgs('sonnet', p.mode, 'fresh'), '/tmp/x');
    assert.equal(s.mode, clauses.get(p.mode));
    assert.equal(s.danger, p.danger, `danger flag must follow PERMS for ${p.mode}`);
  }
});

test('launchSummary: the resume clause follows the resume VALUE', () => {
  assert.equal(
    launchSummary(composeArgs('opus', 'default', 'fresh'), '/tmp/x').resume,
    'starts a fresh conversation',
  );
  assert.equal(
    launchSummary(composeArgs('opus', 'default', 'continue'), '/tmp/x').resume,
    'continues your last conversation',
  );
});

test('copy rule: no summary line contains a flag, a `$` shell prompt or a CLI mode value', () => {
  for (const p of PERMS) {
    for (const r of ['fresh', 'continue'] as const) {
      const s = launchSummary(composeArgs('opus', p.mode, r), '/home/sava/projects/web-ui');
      for (const line of [s.head, s.mode, s.resume, s.folder]) assertPlainCopy(line, 'summary line');
    }
  }
});

test('launchSummary: the folder line keeps the REAL absolute path (paths are sanctioned here) and the empty glyph when unknown', () => {
  assert.equal(
    launchSummary(composeArgs('opus', 'plan', 'fresh'), '/srv/deep/nest').folder,
    'folder: /srv/deep/nest',
  );
  assert.equal(launchSummary(composeArgs('opus', 'plan', 'fresh'), '—').folder, 'folder: —');
});

/**
 * The FULL 4 modes × 2 resume choices table, byte for byte.
 *
 * The tests above each cover one axis (mode clauses at resume=fresh, resume
 * clauses at mode=default, head+folder for one combination), which leaves the
 * combinations themselves — and `head`/`folder` for 7 of the 8 — unpinned. The
 * ink well is the ONLY place the user is told what is about to run now that the
 * argv line is gone, so every cell of it is written out here rather than
 * derived from the same maps the implementation uses (a derived expectation
 * would agree with any renaming, including a wrong one).
 */
const SUMMARY_TABLE: {
  perm: Perm;
  resume: Resume;
  mode: string;
  danger: boolean;
  resumeText: string;
}[] = [
  { perm: 'default', resume: 'fresh', mode: 'asks before tools that need approval', danger: false, resumeText: 'starts a fresh conversation' },
  { perm: 'default', resume: 'continue', mode: 'asks before tools that need approval', danger: false, resumeText: 'continues your last conversation' },
  { perm: 'acceptEdits', resume: 'fresh', mode: 'auto-approves file edits', danger: false, resumeText: 'starts a fresh conversation' },
  { perm: 'acceptEdits', resume: 'continue', mode: 'auto-approves file edits', danger: false, resumeText: 'continues your last conversation' },
  { perm: 'plan', resume: 'fresh', mode: 'read-only planning, changes nothing', danger: false, resumeText: 'starts a fresh conversation' },
  { perm: 'plan', resume: 'continue', mode: 'read-only planning, changes nothing', danger: false, resumeText: 'continues your last conversation' },
  { perm: 'bypassPermissions', resume: 'fresh', mode: 'never asks · dangerous', danger: true, resumeText: 'starts a fresh conversation' },
  { perm: 'bypassPermissions', resume: 'continue', mode: 'never asks · dangerous', danger: true, resumeText: 'continues your last conversation' },
];

test('launchSummary: every mode × resume combination, in full, including the danger clause', () => {
  assert.equal(SUMMARY_TABLE.length, PERMS.length * 2, 'the table covers the whole vocabulary');
  for (const row of SUMMARY_TABLE) {
    assert.deepEqual(
      launchSummary(composeArgs('sonnet', row.perm, row.resume), '/home/sava/projects/web-ui'),
      {
        head: 'Claude Code · sonnet',
        mode: row.mode,
        danger: row.danger,
        resume: row.resumeText,
        folder: 'folder: /home/sava/projects/web-ui',
      },
      `${row.perm} × ${row.resume}`,
    );
  }
  // The danger clause belongs to the bypass mode ONLY, in both resume states.
  assert.equal(SUMMARY_TABLE.filter((r) => r.danger).length, 2);
  for (const row of SUMMARY_TABLE) {
    assert.equal(
      launchSummary(composeArgs('opus', row.perm, row.resume), '/tmp/x').danger,
      row.perm === 'bypassPermissions',
      `only bypass is dangerous (${row.perm})`,
    );
  }
});

test('launchSummary is a FUNCTION OF THE EMITTED ARGV — every clause is derived from the array that becomes the POST body', () => {
  // The structural guarantee the old `previewLine(spawn)` had for free, and the
  // regression this pins: the dialog must not compose argv and then re-read its
  // controls for the summary, because an arg added to composeArgs would then
  // change what SPAWNS while the summary kept describing the previous launch.
  // Only the argv array is passed in below — there is no second input left that
  // could disagree with it.
  const args = composeArgs('haiku', 'plan', 'continue');
  assert.deepEqual(args, ['--model', 'haiku', '--permission-mode', 'plan', '--continue']);
  assert.deepEqual(launchSummary(args, '/srv/x'), {
    head: 'Claude Code · haiku',
    mode: 'read-only planning, changes nothing',
    danger: false,
    resume: 'continues your last conversation',
    folder: 'folder: /srv/x',
  });

  // Change the ARGV alone and every clause follows it.
  assert.deepEqual(launchSummary(['--model', 'opus', '--permission-mode', 'bypassPermissions'], '/srv/x'), {
    head: 'Claude Code · opus',
    mode: 'never asks · dangerous',
    danger: true,
    resume: 'starts a fresh conversation',
    folder: 'folder: /srv/x',
  });

  // An argv with NO --permission-mode is the CLI's default mode (what
  // composeArgs emits for `default`), and an argv with no model at all reads as
  // the app's empty glyph rather than an invented one.
  assert.equal(launchSummary(['--model', 'sonnet'], '/srv/x').mode, 'asks before tools that need approval');
  assert.equal(launchSummary([], '/srv/x').head, 'Claude Code · —');
  assert.equal(launchSummary(['--model'], '/srv/x').head, 'Claude Code · —', 'a dangling flag invents nothing');
  // An unknown mode value cannot fabricate a clause either — it degrades to the
  // ask-first reading, never to the dangerous one.
  const unknown = launchSummary(['--model', 'opus', '--permission-mode', 'newMode'], '/srv/x');
  assert.equal(unknown.mode, 'asks before tools that need approval');
  assert.equal(unknown.danger, false);
});

test('launchSummary: the head follows the model argument for every model in the vocabulary', () => {
  for (const m of MODELS) {
    assert.equal(launchSummary(composeArgs(m, 'default', 'fresh'), '/tmp/x').head, `Claude Code · ${m}`);
  }
  // AGENT_LABEL is a product name, not the spawned command — `claude` is still
  // what composeArgs feeds the server, and the two must not be confused.
  assert.equal(AGENT_LABEL, 'Claude Code');
  assert.ok(!AGENT_LABEL.includes('claude '), 'the summary names the product, not the binary');
});

// ---------------------------------------------------------------------------
// The custom-mode EXEMPTION (the one place CLI syntax is allowed on purpose)
// ---------------------------------------------------------------------------

test('the custom-mode exemption is a separate function: previewLine still echoes the exact command line', () => {
  // User's call (2026-07-25): the custom-command field's content IS a command,
  // so it keeps being shown verbatim — flags, dashes and all. Anything that
  // "cleaned up" this output would be lying about what gets spawned.
  const spec = parseCustomCommand('htop --tree -d 5');
  assert.ok(spec !== null);
  assert.equal(previewLine(spec), '$ htop --tree -d 5');
  assert.deepEqual(spec, { command: 'htop', args: ['--tree', '-d', '5'] });
});

test('the exemption does NOT leak the other way: launchSummary never renders a command line for ANY input', () => {
  // Adversarial arguments — a model id and a folder that themselves look like
  // shell — must not turn the summary into a command line. `folder` is the one
  // caller-controlled string that reaches the ink well verbatim (paths are
  // sanctioned copy), so it is checked separately from the generated clauses.
  for (const row of SUMMARY_TABLE) {
    const s = launchSummary(composeArgs('$ claude --model opus', row.perm, row.resume), '/tmp/x');
    for (const line of [s.mode, s.resume]) assertPlainCopy(line, 'generated clause');
    assert.ok(!s.mode.startsWith('$'), 'no clause is ever a shell line');
    assert.ok(!s.resume.startsWith('$'), 'no clause is ever a shell line');
    // The model is echoed as given — the summary does not invent one — but it
    // reaches only `head`, never the clauses.
    assert.equal(s.head, 'Claude Code · $ claude --model opus');
  }
  assert.equal(
    launchSummary(composeArgs('opus', 'default', 'fresh'), '/srv/a b/c').folder,
    'folder: /srv/a b/c',
    'a folder is shown exactly as it is — never quoted or escaped like an argv token',
  );
});

// ---------------------------------------------------------------------------
// Global launch defaults — guards + precedence chain (settings panel)
// ---------------------------------------------------------------------------

test('isPerm / isModelId: only the fixed vocabularies pass', () => {
  for (const p of ['default', 'acceptEdits', 'plan', 'bypassPermissions']) assert.ok(isPerm(p));
  for (const bad of ['skip-permissions', 'standard', '', 'DEFAULT', 42, null, undefined]) {
    assert.equal(isPerm(bad), false);
  }
  for (const m of ['opus', 'sonnet', 'haiku', 'fable']) assert.ok(isModelId(m));
  for (const bad of ['gpt-4', 'Opus', '', 3, null]) assert.equal(isModelId(bad), false);
});

test('clampLaunchDefaults: keeps valid members, drops unknown model/mode, coerces non-string command away', () => {
  assert.deepEqual(
    clampLaunchDefaults({ model: 'sonnet', permissionMode: 'plan', startupCommand: '/caveman' }),
    { model: 'sonnet', permissionMode: 'plan', startupCommand: '/caveman' },
  );
  // Unknown model + unknown mode dropped; note skip-permissions is NOT a valid
  // ClaudePermissionMode, so it is dropped too.
  assert.deepEqual(clampLaunchDefaults({ model: 'gpt-4', permissionMode: 'skip-permissions' }), {});
  assert.deepEqual(clampLaunchDefaults({ startupCommand: 5 }), {});
  // An empty / whitespace-only command means "off": it strips to empty, so the
  // member is dropped (absent === off).
  assert.deepEqual(clampLaunchDefaults({ startupCommand: '' }), {});
  assert.deepEqual(clampLaunchDefaults({ startupCommand: '   ' }), {});
});

test('clampLaunchDefaults: garbage / non-object input degrades to {}', () => {
  for (const bad of [null, undefined, 'x', 42, [], true]) {
    assert.deepEqual(clampLaunchDefaults(bad), {});
  }
});

test('resolveModel: explicit project model > global default > hardcoded MODELS[0]', () => {
  const g: UiLaunchDefaults = { model: 'sonnet' };
  assert.equal(resolveModel(g, 'haiku'), 'haiku'); // project wins
  assert.equal(resolveModel(g, undefined), 'sonnet'); // global stands
  assert.equal(resolveModel({}, undefined), 'opus'); // hardcoded fallback
  assert.equal(resolveModel(undefined, undefined), 'opus');
  assert.equal(resolveModel(g, 'gpt-4'), 'sonnet'); // invalid project falls through
  assert.equal(resolveModel({ model: 'gpt-4' }, undefined), 'opus'); // invalid global falls through
});

test('resolvePerm: project skip-permissions > global default > hardcoded default', () => {
  const g: UiLaunchDefaults = { permissionMode: 'acceptEdits' };
  assert.equal(resolvePerm(g, 'skip-permissions'), 'bypassPermissions'); // project wins
  assert.equal(resolvePerm(g, 'standard'), 'acceptEdits'); // project standard defers to global
  assert.equal(resolvePerm(g, undefined), 'acceptEdits'); // absent project defers to global
  assert.equal(resolvePerm({ permissionMode: 'plan' }, undefined), 'plan');
  assert.equal(resolvePerm({}, undefined), 'default'); // hardcoded fallback
  assert.equal(resolvePerm(undefined, undefined), 'default');
  assert.equal(
    resolvePerm({ permissionMode: 'nonsense' } as unknown as UiLaunchDefaults, undefined),
    'default',
  ); // invalid global falls through
});

test('resolvePerm: legacy project mode `standard` never asserts a preference — the full chain falls through to the global default, then to hardcoded `default`', () => {
  // `standard` maps to NO override (permFromDefaultMode returns null), so with
  // no global default it must land on the hardcoded 'default', NOT bypass.
  assert.equal(resolvePerm(undefined, 'standard'), 'default');
  assert.equal(resolvePerm({}, 'standard'), 'default');
  assert.equal(resolvePerm({ permissionMode: 'plan' }, 'standard'), 'plan'); // standard defers to global
});

test('clampLaunchDefaults: startupCommand keeps its meaningful content — leading slash + args, inner spaces, and unicode survive; surrounding whitespace is trimmed and control chars stripped', () => {
  const cases: [string, string][] = [
    ['/model opus', '/model opus'], // plain line, unchanged
    ['  /caveman  ', '/caveman'], // surrounding whitespace trimmed
    ['/模型 café ✓', '/模型 café ✓'], // unicode + inner spaces survive
    ['/a\tb', '/ab'], // inner control char (\t) stripped
  ];
  for (const [cmd, want] of cases) {
    assert.deepEqual(
      clampLaunchDefaults({ startupCommand: cmd }),
      { startupCommand: want },
      `startupCommand sanitization: ${JSON.stringify(cmd)} -> ${JSON.stringify(want)}`,
    );
  }
});

test('clampLaunchDefaults strips control chars from a persisted startupCommand — embedded \\r / \\n cannot reach the PTY-injection path', () => {
  const injected = '/foo\rrm -rf ~\n/bar';
  // \r and \n (and every other \x00-\x1f / \x7f) are removed so one configured
  // line submits as exactly one line; the surviving text concatenates.
  assert.deepEqual(clampLaunchDefaults({ startupCommand: injected }), {
    startupCommand: '/foorm -rf ~/bar',
  });
  // A line that is only control chars / whitespace strips to empty -> off (absent).
  assert.deepEqual(clampLaunchDefaults({ startupCommand: '\r\n\t\x00\x1b\x7f' }), {});
});

test('vocabulary alignment: isPerm accepts EXACTLY the PERMS modes (and PERMS is the 4 ClaudePermissionMode literals) — guards PERMS/isPerm drift', () => {
  assert.deepEqual(PERMS.map((p) => p.mode), ['default', 'acceptEdits', 'plan', 'bypassPermissions']);
  for (const p of PERMS) assert.ok(isPerm(p.mode), `PERMS mode ${p.mode} must pass isPerm`);
  assert.equal(PERMS.filter((p) => p.danger).length, 1, 'exactly one danger mode (bypassPermissions)');
  assert.equal(PERMS.find((p) => p.danger)?.mode, 'bypassPermissions');
});

// ---------------------------------------------------------------------------
// SpawnSpec claude-mode equivalence (launch.ts's currentSpawn(), claude branch)
// ---------------------------------------------------------------------------
//
// `currentSpawn()` in web/src/ui/launch.ts is NOT DOM-free-importable: it
// pulls in ./panes.ts -> @xterm/xterm, which throws at import time under
// plain node:test (confirmed by probe: `import('../web/src/ui/launch.ts')`
// fails with "The requested module '@xterm/xterm' does not provide an
// export named 'Terminal'"). Per the gate instructions, this is
// covered-by-probe, not by an executable test — no browser harness added.
// The claude branch, read from source at web/src/ui/launch.ts:290-293, is:
//   customMode ? parseCustomCommand(cmdInput.value)
//               : { command: 'claude', args: composeArgs(modelSel.value, perm, resumeSel.value as Resume) }
// i.e. exactly `{ command: 'claude', args: composeArgs(...) }` — the same
// composeArgs under test above, so the composeArgs tests transitively cover
// the argv contents of that branch; only the `command: 'claude'` literal
// and the DOM-sourced (model/perm/resume) plumbing are untested here.
