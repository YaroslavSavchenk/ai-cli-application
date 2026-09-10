/**
 * `web/src/ui/pane-status-model.ts` — the pane status bar's MODEL (Nocturne
 * part A3; `design_handoff_session_manager/README-v3.md`, "Pane").
 *
 * The module is deliberately DOM-free and clock-free (`now` is a parameter),
 * so plain `node --test` imports it directly and this file is also the guard
 * that keeps it that way: an accidental `document` or `Date.now()` dependency
 * shows up here as an import-time throw or a nondeterministic Time value.
 *
 * What is pinned:
 *   1. THE HONESTY RULE. The bar exists for the known agent only, and every
 *      item is read from data the app already has — the session's own argv
 *      (`--model`, `--permission-mode`) and its `createdAt`. Anything the app
 *      does not know is ABSENT, never a placeholder.
 *   2. THE KEY SET IS CLOSED: exactly `Model`, `Mode`, `Time`, in that order,
 *      and `Time` belongs to a LIVE PTY only (an exited session has no end
 *      time in `SessionInfo`, so a running counter would be a lie).
 *      Branch, Cost, Context, Usage, Skill and Changed are part B1 (open
 *      decision #2 of `.claude/PLAN-NOCTURNE.md`); their ABSENCE is asserted
 *      over an argv matrix AND over the module source, so nobody can ship a
 *      faked value under a v3 label before its data source exists.
 *   3. THE LABELS ARE THE ONE TABLE. Mode values are compared against
 *      `PERM_SHORT` itself (imported, never retyped), so a copy change moves
 *      both or fails here.
 *
 * NOT claimed here: that anything is rendered, positioned or legible — the
 * renderer lives in `web/src/ui/panes.ts` (`updateStatus`) and is manual
 * (`.claude/skills/verify-terminal/SKILL.md`). `tests/ui-pane-a3.test.ts`
 * pins A3's structural facts around this model.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionInfo } from '../shared/protocol.ts';
import { paneStatusItems } from '../web/src/ui/pane-status-model.ts';
import { PERM_SHORT, type Perm } from '../web/src/ui/launch-args.ts';
import { projectRoot } from './helpers.ts';

/** A fixed clock and a `createdAt` a known distance before it. */
const NOW = Date.parse('2026-09-10T12:00:00.000Z');
const ago = (ms: number): string => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;

/** A running session, exactly as `GET /api/sessions` shapes it. */
function session(over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: 's1',
    title: 'work',
    command: 'claude',
    args: [],
    cwd: '/home/u/projects/app',
    status: 'running',
    cols: 120,
    rows: 30,
    createdAt: ago(5 * MIN),
    attention: false,
    statusline: true,
    ...over,
  };
}

const keys = (s: SessionInfo, now: number = NOW): string[] =>
  paneStatusItems(s, now).map((i) => i.k);
const valueOf = (s: SessionInfo, k: string, now: number = NOW): string | undefined =>
  paneStatusItems(s, now).find((i) => i.k === k)?.v;
const toneOf = (s: SessionInfo, k: string, now: number = NOW): string | undefined =>
  paneStatusItems(s, now).find((i) => i.k === k)?.tone;

// ---------------------------------------------------------------------------
// Who gets a bar at all
// ---------------------------------------------------------------------------

test('no session (an empty pane) -> no items, so no bar', () => {
  assert.deepEqual(paneStatusItems(undefined, NOW), []);
});

test('a non-claude command gets NO bar — not an empty one', () => {
  for (const command of ['/bin/bash', 'bash', 'powershell.exe', 'npm', 'claude-code', 'myclaude']) {
    assert.deepEqual(
      paneStatusItems(session({ command, args: ['--model', 'opus'] }), NOW),
      [],
      `${command} is not the known agent`,
    );
  }
});

test('the known agent is matched by basename, both separators', () => {
  for (const command of ['claude', '/usr/local/bin/claude', 'C:\\bin\\claude']) {
    assert.deepEqual(keys(session({ command })), ['Time'], command);
  }
});

test('claude with NO args -> only Time (the argv names neither model nor mode)', () => {
  assert.deepEqual(paneStatusItems(session({ args: [] }), NOW), [
    { k: 'Time', v: '5m', tone: 'neutral' },
  ]);
});

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

test('Model: the `--model <value>` form, value byte-exact', () => {
  assert.equal(valueOf(session({ args: ['--model', 'opus'] }), 'Model'), 'opus');
});

test('Model: the `--model=<value>` form, value byte-exact', () => {
  assert.equal(valueOf(session({ args: ['--model=sonnet'] }), 'Model'), 'sonnet');
});

test('Model: absent / valueless flag -> no Model item at all', () => {
  assert.deepEqual(keys(session({ args: [] })), ['Time']);
  assert.deepEqual(keys(session({ args: ['--model'] })), ['Time']);
  assert.deepEqual(keys(session({ args: ['--model', ''] })), ['Time']);
  assert.deepEqual(keys(session({ args: ['--model='] })), ['Time']);
});

test('Model is neutral, whatever it names', () => {
  for (const m of ['opus', 'sonnet', 'haiku', 'fable']) {
    assert.equal(toneOf(session({ args: ['--model', m] }), 'Model'), 'neutral', m);
  }
});

// ---------------------------------------------------------------------------
// Mode — the labels come from PERM_SHORT, never from this file
// ---------------------------------------------------------------------------

test('Mode: every PERM_SHORT mode reads exactly its own label (default excepted)', () => {
  const modes = Object.keys(PERM_SHORT) as Perm[];
  assert.deepEqual(modes.sort(), ['acceptEdits', 'bypassPermissions', 'default', 'plan']);
  for (const mode of modes) {
    const s = session({ args: ['--permission-mode', mode] });
    if (mode === 'default') {
      // `permFromArgs` returns null for `default` (web/src/ui/util.ts) — the
      // CLI's own default is not a claim this bar makes.
      assert.deepEqual(keys(s), ['Time'], 'default mode shows no Mode item');
      continue;
    }
    assert.equal(valueOf(s, 'Mode'), PERM_SHORT[mode], mode);
  }
});

test('Mode: the `--permission-mode=<value>` form reads the same label', () => {
  assert.equal(
    valueOf(session({ args: ['--permission-mode=acceptEdits'] }), 'Mode'),
    PERM_SHORT.acceptEdits,
  );
});

test('Mode: an absent, empty or `default` mode shows no Mode item', () => {
  for (const args of [
    [],
    ['--permission-mode'],
    ['--permission-mode', ''],
    ['--permission-mode='],
    ['--permission-mode', 'default'],
    ['--permission-mode=default'],
  ]) {
    assert.deepEqual(keys(session({ args })), ['Time'], JSON.stringify(args));
  }
});

test('Mode: a mode outside the known four is shown verbatim, neutral', () => {
  const s = session({ args: ['--permission-mode', 'yolo'] });
  assert.equal(valueOf(s, 'Mode'), 'yolo');
  assert.equal(toneOf(s, 'Mode'), 'neutral');
});

// ---------------------------------------------------------------------------
// Tone — the only red on this bar is a removed safety net
// ---------------------------------------------------------------------------

test('tone danger: `--permission-mode bypassPermissions`', () => {
  const s = session({ args: ['--permission-mode', 'bypassPermissions'] });
  assert.deepEqual(paneStatusItems(s, NOW).find((i) => i.k === 'Mode'), {
    k: 'Mode',
    v: PERM_SHORT.bypassPermissions,
    tone: 'danger',
  });
});

test('tone danger: `--dangerously-skip-permissions` (the same mode, the other spelling)', () => {
  const s = session({ args: ['--dangerously-skip-permissions'] });
  assert.deepEqual(paneStatusItems(s, NOW).find((i) => i.k === 'Mode'), {
    k: 'Mode',
    v: PERM_SHORT.bypassPermissions,
    tone: 'danger',
  });
});

test('tone neutral for every other mode, and for Model and Time', () => {
  for (const mode of ['acceptEdits', 'plan', 'yolo']) {
    const s = session({ args: ['--model', 'opus', '--permission-mode', mode] });
    assert.deepEqual(
      paneStatusItems(s, NOW).map((i) => i.tone),
      ['neutral', 'neutral', 'neutral'],
      mode,
    );
  }
  // And the danger tone is reachable at all from this same shape (non-vacuity:
  // a model that returned 'neutral' unconditionally would pass the loop above).
  const danger = session({ args: ['--model', 'opus', '--permission-mode', 'bypassPermissions'] });
  assert.deepEqual(
    paneStatusItems(danger, NOW).map((i) => i.tone),
    ['neutral', 'danger', 'neutral'],
  );
});

// ---------------------------------------------------------------------------
// Time — the injected clock, never Date.now()
// ---------------------------------------------------------------------------

test('Time uses the INJECTED now: 2h 15m before it reads `2h 15m`', () => {
  const s = session({ createdAt: ago(2 * HOUR + 15 * MIN) });
  assert.equal(valueOf(s, 'Time'), '2h 15m');
});

test('Time: the minutes-only form, the zero-minute form, and seconds never show', () => {
  assert.equal(valueOf(session({ createdAt: ago(31 * MIN) }), 'Time'), '31m');
  assert.equal(valueOf(session({ createdAt: ago(45_000) }), 'Time'), '0m');
  assert.equal(valueOf(session({ createdAt: ago(HOUR) }), 'Time'), '1h 0m');
  assert.equal(valueOf(session({ createdAt: ago(25 * HOUR) }), 'Time'), '25h 0m');
});

test('Time is a pure function of (createdAt, now) — the same pair, the same string', () => {
  const s = session({ createdAt: ago(2 * HOUR + 15 * MIN) });
  const later = paneStatusItems(s, NOW + 45 * MIN).find((i) => i.k === 'Time');
  assert.equal(later?.v, '3h 0m', 'moving the injected clock is the ONLY thing that moves Time');
  assert.equal(valueOf(s, 'Time'), '2h 15m', 'and the original clock still reads the original value');
});

test('an EXITED session shows no Time — nothing may keep counting after the exit', () => {
  const s = session({ args: ['--model', 'opus'], status: 'exited', exitCode: 0 });
  assert.deepEqual(keys(s), ['Model'], 'Time is dropped, the argv items stay');
  assert.deepEqual(keys(session({ status: 'exited' })), [], 'and an argv-less exited session gets no bar');
  // Non-vacuity: the very same session while it is running DOES carry Time.
  assert.deepEqual(keys(session({ args: ['--model', 'opus'] })), ['Model', 'Time']);
});

test('Time: an unparsable createdAt shows no Time item (no em dash on the bar)', () => {
  assert.deepEqual(paneStatusItems(session({ createdAt: 'not a date' }), NOW), []);
  assert.deepEqual(keys(session({ args: ['--model', 'opus'], createdAt: '' })), ['Model']);
});

// ---------------------------------------------------------------------------
// The closed key set and its order
// ---------------------------------------------------------------------------

test('order is Model, Mode, Time — always, whatever the argv order', () => {
  const full = session({
    args: ['--continue', '--permission-mode', 'plan', '--effort', 'high', '--model', 'opus'],
    createdAt: ago(2 * HOUR + 15 * MIN),
  });
  assert.deepEqual(paneStatusItems(full, NOW), [
    { k: 'Model', v: 'opus', tone: 'neutral' },
    { k: 'Mode', v: PERM_SHORT.plan, tone: 'neutral' },
    { k: 'Time', v: '2h 15m', tone: 'neutral' },
  ]);
});

/** Every A3 key there is. The v3 labels, byte-exact. */
const ALLOWED_KEYS = ['Model', 'Mode', 'Time'];

/** Part B1's labels (open decision #2). None of them may appear before B1. */
const B1_KEYS = ['Branch', 'Cost', 'Context', 'Usage', 'Skill', 'Changed'];

test('no key outside Model / Mode / Time is ever produced (B1 labels stay absent)', () => {
  const argvs: string[][] = [
    [],
    ['--model', 'opus'],
    ['--model=sonnet'],
    ['--permission-mode', 'acceptEdits'],
    ['--permission-mode', 'plan'],
    ['--permission-mode', 'bypassPermissions'],
    ['--dangerously-skip-permissions'],
    ['--model', 'haiku', '--permission-mode', 'plan', '--effort', 'max', '--continue'],
    ['--resume', '5f0b6a1e-0000-4000-8000-000000000000'],
    ['--continue'],
    ['--settings', '/tmp/x.json'],
    ['--session-id', '5f0b6a1e-0000-4000-8000-000000000000'],
    ['--add-dir', '/home/u/other'],
  ];
  const seen = new Set<string>();
  for (const args of argvs) {
    for (const status of ['running', 'exited'] as const) {
      for (const createdAt of [ago(0), ago(3 * HOUR), 'not a date']) {
        for (const attention of [false, true]) {
          const produced = paneStatusItems(session({ args, status, createdAt, attention }), NOW);
          if (status === 'exited') {
            assert.deepEqual(
              produced.filter((i) => i.k === 'Time'),
              [],
              `an exited session must carry no Time (argv ${JSON.stringify(args)})`,
            );
          }
          for (const item of produced) {
            seen.add(item.k);
            assert.ok(ALLOWED_KEYS.includes(item.k), `unexpected key ${JSON.stringify(item.k)}`);
            assert.ok(!B1_KEYS.includes(item.k), `part B1 key leaked: ${item.k}`);
            assert.equal(typeof item.v, 'string');
            assert.notEqual(item.v, '', `${item.k} must never render an empty value`);
            assert.ok(['neutral', 'danger'].includes(item.tone), `${item.k} tone ${item.tone}`);
          }
        }
      }
    }
  }
  // Non-vacuity: the matrix really did exercise all three keys.
  assert.deepEqual([...seen].sort(), ['Mode', 'Model', 'Time']);
});

test('the module itself names no part-B1 item (no faked Branch/Cost/Context/Usage/Skill/Changed)', () => {
  const SRC = readFileSync(join(projectRoot, 'web', 'src', 'ui', 'pane-status-model.ts'), 'utf8');
  assert.ok(SRC.includes('export function paneStatusItems'), 'non-vacuity: wrong file');
  // Comments are stripped: the header explains WHY those items are absent, and
  // that explanation must stay legal while the code stays clean.
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const k of B1_KEYS) {
    assert.equal(code.includes(`'${k}'`), false, `pane-status-model.ts must not emit a ${k} item`);
  }
  for (const k of ALLOWED_KEYS) assert.ok(code.includes(`'${k}'`), `the ${k} key is emitted here`);
});
