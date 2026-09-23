/**
 * `web/src/ui/launch-args.ts` — the Nocturne B5 agents (2026-09-18): Codex,
 * Gemini and Grok argv byte-exact, per tool, from the verified-contract table
 * in `.claude/plans/nocturne/PLAN-B5.md`; `composeSpawn` for each agent kind;
 * Claude's resume by conversation id; the per-tool vocabularies and the copy
 * rule over them. Split out of `ui-launch-args.test.ts`.
 *
 * Seam: the pure module, imported and called. `web/src/ui/launch-args.ts` is
 * deliberately DOM-free and xterm-free so plain `node --test` can import it;
 * an accidental DOM dependency would throw at import time here.
 *
 * Why it matters: each tool's option order is FIXED (for Codex the start-from
 * tail is a subcommand every option must precede), and a value from another
 * tool's table must never reach this tool's argv.
 *
 * NOT claimed: the DOM plumbing that fills the `LaunchForm` from the dialog's
 * controls (`tests/ui/ui-launch-dialog.test.ts`), or that the spawned CLI
 * accepts the argv (`.claude/skills/verify-terminal/SKILL.md`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  composeArgs,
  MODELS,
  PERMS,
  EFFORTS,
  KINDS,
  composeSpawn,
  AGENT_KINDS,
  TOOLS,
  GROK_PERM_HINT,
  composeCodexArgs,
  composeGeminiArgs,
  composeGrokArgs,
  isToolModel,
  isToolEffort,
  isToolStart,
} from '../../web/src/ui/launch-args.ts';
import type { LaunchForm } from '../../web/src/ui/launch-args.ts';
import { assertPlainCopy, form } from '../helpers/ui-launch-args-fixture.ts';

// ---------------------------------------------------------------------------
// Nocturne B5 (2026-09-18): the other three agents, argv byte-exact
// ---------------------------------------------------------------------------
//
// The expectations below are written out LITERALLY from the verified-contract
// table in `.claude/plans/nocturne/PLAN-B5.md`, never derived from the code under test. Each
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
