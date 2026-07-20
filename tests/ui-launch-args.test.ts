/**
 * `web/src/ui/launch-args.ts` — the launch dialog's pure argv vocabulary.
 * Deliberately DOM-free and xterm-free so plain `node --test` can import it;
 * this file is also the guard that keeps it that way (an accidental DOM
 * dependency would throw at import time here).
 *
 * The invariant under test: the command preview and the POST body share
 * these composers, so what they produce IS what the server spawns.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  composeArgs,
  parseCustomCommand,
  previewLine,
  permFromDefaultMode,
  MODELS,
  PERMS,
  CHIPS,
} from '../web/src/ui/launch-args.ts';

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

test('vocabulary: PERMS is the fixed 4-mode set (default/acceptEdits/plan/bypassPermissions), exactly one dangerous', () => {
  assert.deepEqual(PERMS, [
    { mode: 'default', desc: 'ask before every tool call', danger: false },
    { mode: 'acceptEdits', desc: 'auto-approve file edits', danger: false },
    { mode: 'plan', desc: 'read-only planning mode', danger: false },
    { mode: 'bypassPermissions', desc: 'never ask · dangerous', danger: true },
  ]);
});

test('CHIPS mapping: deep work = opus+acceptEdits+continue', () => {
  assert.deepEqual(CHIPS[0], {
    label: 'deep work · opus · acceptEdits · continue',
    model: 'opus',
    perm: 'acceptEdits',
    resume: 'continue',
    danger: false,
  });
});

test('CHIPS mapping: quick fix = sonnet+default (fresh)', () => {
  assert.deepEqual(CHIPS[1], {
    label: 'quick fix · sonnet · default',
    model: 'sonnet',
    perm: 'default',
    resume: 'fresh',
    danger: false,
  });
});

test('CHIPS mapping: yolo = opus+bypassPermissions (fresh), the one danger chip', () => {
  assert.deepEqual(CHIPS[2], {
    label: 'yolo · opus · bypass',
    model: 'opus',
    perm: 'bypassPermissions',
    resume: 'fresh',
    danger: true,
  });
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
