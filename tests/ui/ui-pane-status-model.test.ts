/**
 * `web/src/ui/pane-status-model.ts` — the pane status bar's MODEL (Nocturne
 * part A3, extended by part B1 to the configurable bar of the v3 design).
 *
 * The module is deliberately DOM-free and clock-free (`now` is a parameter),
 * so plain `node --test` imports it directly and this file is also the guard
 * that keeps it that way: an accidental `document` or `Date.now()` dependency
 * shows up here as an import-time throw or a nondeterministic Time value.
 *
 * What is pinned:
 *   1. THE HONESTY RULE. The bar exists for the known agent only, and every
 *      item is read from data the app already has — the session's own argv
 *      (`--model`, `--permission-mode`), its `createdAt`, and what Claude Code
 *      itself reported (`SessionInfo.telemetry`, the status-line payload).
 *      Anything the app does not know is ABSENT, never a placeholder and never
 *      a zero standing in for an unknown.
 *   2. THE KEY SET IS CLOSED: exactly `Model`, `Mode`, `Branch`, `Cost`,
 *      `Context`, `Usage`, `Time`, `Changed`, in that order — the v3 mock's
 *      order. `Time` belongs to a LIVE PTY only (an exited session has no end
 *      time in `SessionInfo`, so a running counter would be a lie), while the
 *      REPORTED items survive the exit — what a session cost is still true
 *      after it ended. `Skill` has no data source at all (user decision
 *      2026-09-16) and is asserted absent over an argv × telemetry matrix AND
 *      over the module source, so nobody can ship a faked value under a v3
 *      label before its data source exists.
 *   3. ONE CHECKLIST, TWO PLACES. Every item follows its Settings toggle, and
 *      `paneBar` off means no bar at all — the user asked for it gone, not for
 *      an empty strip.
 *   4. THE LABELS ARE THE ONE TABLE. Mode values are compared against
 *      `PERM_SHORT` itself (imported, never retyped), so a copy change moves
 *      both or fails here.
 *
 * NOT claimed here: that anything is rendered, positioned or legible — the
 * renderer lives in `web/src/ui/panes.ts` (`updateStatus`) and is manual
 * (`.claude/skills/verify-terminal/SKILL.md`). `tests/ui/ui-pane-a3.test.ts`
 * pins A3's structural facts around this model.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SessionInfo, SessionTelemetry } from '../../shared/protocol.ts';
import { paneStatusItems, type PaneStatusItem } from '../../web/src/ui/pane-status-model.ts';
import { PERM_SHORT, type Perm } from '../../web/src/ui/launch-args.ts';
import {
  statusLineDefaults,
  type StatusLineCfg,
} from '../../web/src/ui/statusline-model.ts';
import { readSource } from '../helpers/helpers.ts';

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

/**
 * Every toggle on, built FROM the shared factory set so a key added there
 * cannot quietly escape this file's matrix. This is the cfg the assertions
 * below use unless they are about a toggle itself: with it, an absent item is
 * an absent VALUE, which is what the honesty rule is about.
 */
const ALL: StatusLineCfg = (() => {
  const out = statusLineDefaults();
  for (const k of Object.keys(out) as (keyof StatusLineCfg)[]) out[k] = true;
  return out;
})();

const cfg = (over: Partial<StatusLineCfg> = {}): StatusLineCfg => ({ ...ALL, ...over });

/** A telemetry snapshot, as `SessionInfo.telemetry` carries it. */
const tel = (over: Partial<SessionTelemetry> = {}): SessionTelemetry => ({
  at: '2026-09-10T11:59:00.000Z',
  ...over,
});

const items = (s: SessionInfo, c: StatusLineCfg = ALL, now: number = NOW): PaneStatusItem[] =>
  paneStatusItems(s, c, now);
const keys = (s: SessionInfo, now: number = NOW): string[] => items(s, ALL, now).map((i) => i.k);
const valueOf = (s: SessionInfo, k: string, now: number = NOW): string | undefined =>
  items(s, ALL, now).find((i) => i.k === k)?.v;
const toneOf = (s: SessionInfo, k: string, now: number = NOW): string | undefined =>
  items(s, ALL, now).find((i) => i.k === k)?.tone;

// ---------------------------------------------------------------------------
// Who gets a bar at all
// ---------------------------------------------------------------------------

test('no session (an empty pane) -> no items, so no bar', () => {
  assert.deepEqual(paneStatusItems(undefined, ALL, NOW), []);
});

test('a non-claude command gets NO bar — not an empty one', () => {
  for (const command of ['/bin/bash', 'bash', 'powershell.exe', 'npm', 'claude-code', 'myclaude']) {
    assert.deepEqual(
      items(session({ command, args: ['--model', 'opus'] })),
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
  assert.deepEqual(items(session({ args: [] })), [
    { k: 'Time', v: '5m', tone: 'neutral' },
  ]);
});

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

test('Model: the `--model <value>` form, a known id reads as its dialog label', () => {
  assert.equal(valueOf(session({ args: ['--model', 'opus'] }), 'Model'), 'Opus');
});

test('Model: the `--model=<value>` form, a known id reads as its dialog label', () => {
  assert.equal(valueOf(session({ args: ['--model=sonnet'] }), 'Model'), 'Sonnet');
});

test('Model: an id outside the dialog list is shown verbatim, byte-exact', () => {
  assert.equal(valueOf(session({ args: ['--model', 'claude-opus-4-1'] }), 'Model'), 'claude-opus-4-1');
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
      // `permFromArgs` returns null for `default` (web/src/ui/format-model.ts) — the
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
  assert.deepEqual(items(s).find((i) => i.k === 'Mode'), {
    k: 'Mode',
    v: PERM_SHORT.bypassPermissions,
    tone: 'danger',
  });
});

test('tone danger: `--dangerously-skip-permissions` (the same mode, the other spelling)', () => {
  const s = session({ args: ['--dangerously-skip-permissions'] });
  assert.deepEqual(items(s).find((i) => i.k === 'Mode'), {
    k: 'Mode',
    v: PERM_SHORT.bypassPermissions,
    tone: 'danger',
  });
});

test('tone neutral for every other mode, and for Model and Time', () => {
  for (const mode of ['acceptEdits', 'plan', 'yolo']) {
    const s = session({ args: ['--model', 'opus', '--permission-mode', mode] });
    assert.deepEqual(
      items(s).map((i) => i.tone),
      ['neutral', 'neutral', 'neutral'],
      mode,
    );
  }
  // And the danger tone is reachable at all from this same shape (non-vacuity:
  // a model that returned 'neutral' unconditionally would pass the loop above).
  const danger = session({ args: ['--model', 'opus', '--permission-mode', 'bypassPermissions'] });
  assert.deepEqual(
    items(danger).map((i) => i.tone),
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
  const later = items(s, ALL, NOW + 45 * MIN).find((i) => i.k === 'Time');
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
  assert.deepEqual(items(session({ createdAt: 'not a date' })), []);
  assert.deepEqual(keys(session({ args: ['--model', 'opus'], createdAt: '' })), ['Model']);
});

// ---------------------------------------------------------------------------
// Part B1 — what Claude Code reported (SessionInfo.telemetry)
// ---------------------------------------------------------------------------

test('Model: a reported model beats the argv guess, byte-exact', () => {
  const s = session({ args: ['--model', 'opus'], telemetry: tel({ model: 'Opus 4.1' }) });
  assert.equal(valueOf(s, 'Model'), 'Opus 4.1');
  assert.equal(toneOf(s, 'Model'), 'neutral');
});

test('Model: the argv stays the fallback while nothing has been reported', () => {
  assert.equal(valueOf(session({ args: ['--model', 'opus'], telemetry: tel() }), 'Model'), 'Opus');
  assert.equal(valueOf(session({ args: ['--model', 'opus'] }), 'Model'), 'Opus');
  // An empty reported model is not a value: the argv answers again.
  assert.equal(
    valueOf(session({ args: ['--model', 'opus'], telemetry: tel({ model: '' }) }), 'Model'),
    'Opus',
  );
  // And with neither there is no Model item at all.
  assert.deepEqual(keys(session({ telemetry: tel({ model: '' }) })), ['Time']);
});

test('Model reported without any argv still shows — the payload is a source of its own', () => {
  assert.deepEqual(keys(session({ args: [], telemetry: tel({ model: 'Sonnet 4.5' }) })), [
    'Model',
    'Time',
  ]);
});

test('Branch is the reported branch, and nothing when none was reported', () => {
  assert.equal(valueOf(session({ telemetry: tel({ branch: 'main' }) }), 'Branch'), 'main');
  assert.equal(valueOf(session({ telemetry: tel({ branch: 'feat/b1-x' }) }), 'Branch'), 'feat/b1-x');
  assert.equal(valueOf(session({ telemetry: tel() }), 'Branch'), undefined);
  assert.equal(valueOf(session({ telemetry: tel({ branch: '' }) }), 'Branch'), undefined);
  assert.equal(valueOf(session({}), 'Branch'), undefined);
});

test('Cost: two decimals with a leading $, and ABSENT at zero or without telemetry', () => {
  assert.equal(valueOf(session({ telemetry: tel({ costUsd: 0.42 }) }), 'Cost'), '$0.42');
  assert.equal(valueOf(session({ telemetry: tel({ costUsd: 12 }) }), 'Cost'), '$12.00');
  assert.equal(valueOf(session({ telemetry: tel({ costUsd: 0.005 }) }), 'Cost'), '$0.01');
  assert.equal(valueOf(session({ telemetry: tel({ costUsd: 0 }) }), 'Cost'), undefined);
  assert.equal(valueOf(session({ telemetry: tel() }), 'Cost'), undefined);
  assert.equal(valueOf(session({}), 'Cost'), undefined);
});

test('Context is the reported percentage; 0% is a real reading and IS shown', () => {
  assert.equal(valueOf(session({ telemetry: tel({ contextPct: 62 }) }), 'Context'), '62%');
  assert.equal(valueOf(session({ telemetry: tel({ contextPct: 0 }) }), 'Context'), '0%');
  assert.equal(valueOf(session({ telemetry: tel({ contextPct: 100 }) }), 'Context'), '100%');
  assert.equal(valueOf(session({ telemetry: tel() }), 'Context'), undefined);
});

test('Usage: 5h only, both windows, 7d only — and nothing when neither was reported', () => {
  assert.equal(valueOf(session({ telemetry: tel({ usage5hPct: 38 }) }), 'Usage'), '38% of 5h');
  assert.equal(
    valueOf(session({ telemetry: tel({ usage5hPct: 38, usage7dPct: 12 }) }), 'Usage'),
    '38% of 5h, 12% of 7d',
  );
  assert.equal(valueOf(session({ telemetry: tel({ usage7dPct: 12 }) }), 'Usage'), '12% of 7d');
  assert.equal(valueOf(session({ telemetry: tel() }), 'Usage'), undefined);
});

test('Usage turns amber at 80 and stays neutral at 79 — the 5h window decides', () => {
  assert.equal(toneOf(session({ telemetry: tel({ usage5hPct: 79 }) }), 'Usage'), 'neutral');
  assert.equal(toneOf(session({ telemetry: tel({ usage5hPct: 80 }) }), 'Usage'), 'warn');
  assert.equal(toneOf(session({ telemetry: tel({ usage5hPct: 100 }) }), 'Usage'), 'warn');
  // With both windows the 5h one decides, whichever way the 7d one reads.
  assert.equal(
    toneOf(session({ telemetry: tel({ usage5hPct: 12, usage7dPct: 95 }) }), 'Usage'),
    'neutral',
  );
  assert.equal(
    toneOf(session({ telemetry: tel({ usage5hPct: 95, usage7dPct: 12 }) }), 'Usage'),
    'warn',
  );
  // Without a 5h value the 7d one is the one shown, so it is the one that warns.
  assert.equal(toneOf(session({ telemetry: tel({ usage7dPct: 79 }) }), 'Usage'), 'neutral');
  assert.equal(toneOf(session({ telemetry: tel({ usage7dPct: 80 }) }), 'Usage'), 'warn');
});

test('Changed: the pair, and ABSENT when both are zero or absent', () => {
  assert.equal(
    valueOf(session({ telemetry: tel({ linesAdded: 128, linesRemoved: 41 }) }), 'Changed'),
    '+128 -41',
  );
  assert.equal(valueOf(session({ telemetry: tel({ linesAdded: 3 }) }), 'Changed'), '+3 -0');
  assert.equal(valueOf(session({ telemetry: tel({ linesRemoved: 7 }) }), 'Changed'), '+0 -7');
  assert.equal(
    valueOf(session({ telemetry: tel({ linesAdded: 0, linesRemoved: 0 }) }), 'Changed'),
    undefined,
    'a session that changed nothing says nothing',
  );
  assert.equal(valueOf(session({ telemetry: tel() }), 'Changed'), undefined);
});

test('a value that is not a finite number is not a value (NaN%, $NaN never render)', () => {
  const bad = tel({
    costUsd: Number.NaN,
    contextPct: Number.POSITIVE_INFINITY,
    usage5hPct: Number.NaN,
    usage7dPct: Number.NaN,
    linesAdded: Number.NaN,
    linesRemoved: Number.NaN,
  } as Partial<SessionTelemetry>);
  assert.deepEqual(keys(session({ telemetry: bad })), ['Time']);
});

test('an EXITED session keeps every reported item and drops Time only', () => {
  const t = tel({
    model: 'Opus 4.1',
    branch: 'main',
    costUsd: 0.42,
    contextPct: 62,
    usage5hPct: 38,
    linesAdded: 128,
    linesRemoved: 41,
  });
  assert.deepEqual(keys(session({ telemetry: t, status: 'exited', exitCode: 0 })), [
    'Model',
    'Branch',
    'Cost',
    'Context',
    'Usage',
    'Changed',
  ]);
  assert.equal(
    valueOf(session({ telemetry: t, status: 'exited', exitCode: 0 }), 'Cost'),
    '$0.42',
    'what it cost is still true after it ended',
  );
  // Non-vacuity: the very same session while it runs also carries Time.
  assert.ok(keys(session({ telemetry: t })).includes('Time'));
});

// ---------------------------------------------------------------------------
// One checklist, two places — every item follows its own toggle
// ---------------------------------------------------------------------------

/** A session with an honest value for every single item. */
function loaded(): SessionInfo {
  return session({
    args: ['--model', 'opus', '--permission-mode', 'plan'],
    createdAt: ago(2 * HOUR + 15 * MIN),
    telemetry: tel({
      model: 'Opus 4.1',
      branch: 'main',
      costUsd: 0.42,
      contextPct: 62,
      usage5hPct: 38,
      usage7dPct: 12,
      linesAdded: 128,
      linesRemoved: 41,
    }),
  });
}

test('paneBar off -> NO bar at all, whatever the session has to say', () => {
  assert.deepEqual(items(loaded(), cfg({ paneBar: false })), []);
  // And the switch is independent of Claude's own line inside the terminal.
  assert.equal(items(loaded(), cfg({ enabled: false })).length, 8, '`enabled` is the other place');
});

test('every item is its own toggle: off one at a time, on one at a time', () => {
  const byKey: [keyof StatusLineCfg, string][] = [
    ['model', 'Model'],
    ['mode', 'Mode'],
    ['branch', 'Branch'],
    ['cost', 'Cost'],
    ['context', 'Context'],
    ['usage', 'Usage'],
    ['time', 'Time'],
    ['lines', 'Changed'],
  ];
  const all = keys(loaded());
  assert.deepEqual(all, byKey.map(([, label]) => label));
  for (const [key, label] of byKey) {
    const off = items(loaded(), cfg({ [key]: false })).map((i) => i.k);
    assert.deepEqual(off, all.filter((k) => k !== label), `${key} off drops ${label} and nothing else`);
    // Only-this-one-on: the key really is what produces that label.
    const onlyCfg = cfg();
    for (const [k2] of byKey) onlyCfg[k2] = k2 === key;
    assert.deepEqual(items(loaded(), onlyCfg).map((i) => i.k), [label], `only ${key} -> only ${label}`);
  }
});

test('all items off (but paneBar on) -> an empty array, so no bar is drawn', () => {
  const none = cfg({
    model: false,
    mode: false,
    branch: false,
    cost: false,
    context: false,
    usage: false,
    time: false,
    lines: false,
  });
  assert.deepEqual(items(loaded(), none), []);
});

test('the factory set draws the factory bar (Changed and Usage start off)', () => {
  assert.deepEqual(items(loaded(), statusLineDefaults()).map((i) => i.k), [
    'Model',
    'Mode',
    'Branch',
    'Cost',
    'Context',
    'Time',
  ]);
});

// ---------------------------------------------------------------------------
// The closed key set and its order
// ---------------------------------------------------------------------------

test('order is the v3 order — always, whatever the argv or the payload order', () => {
  assert.deepEqual(items(loaded()), [
    { k: 'Model', v: 'Opus 4.1', tone: 'neutral' },
    { k: 'Mode', v: PERM_SHORT.plan, tone: 'neutral' },
    { k: 'Branch', v: 'main', tone: 'neutral' },
    { k: 'Cost', v: '$0.42', tone: 'neutral' },
    { k: 'Context', v: '62%', tone: 'neutral' },
    { k: 'Usage', v: '38% of 5h, 12% of 7d', tone: 'neutral' },
    { k: 'Time', v: '2h 15m', tone: 'neutral' },
    { k: 'Changed', v: '+128 -41', tone: 'neutral' },
  ]);
  // The argv-only order A3 pinned is the same list with the reported items gone.
  const argvOnly = session({
    args: ['--continue', '--permission-mode', 'plan', '--effort', 'high', '--model', 'opus'],
    createdAt: ago(2 * HOUR + 15 * MIN),
  });
  assert.deepEqual(items(argvOnly), [
    { k: 'Model', v: 'Opus', tone: 'neutral' },
    { k: 'Mode', v: PERM_SHORT.plan, tone: 'neutral' },
    { k: 'Time', v: '2h 15m', tone: 'neutral' },
  ]);
});

/** Every key this bar may ever produce. The v3 labels, byte-exact. */
const ALLOWED_KEYS = [
  'Model',
  'Mode',
  'Branch',
  'Cost',
  'Context',
  'Usage',
  'Time',
  'Changed',
];

/**
 * `Active skill` is in the v3 mock and has NO data source — no payload field,
 * no hook, no file (user decision, 2026-09-16). It gets no row and no
 * placeholder, here or anywhere.
 */
const NO_SOURCE_KEYS = ['Skill', 'Active skill'];

test('no key outside the v3 set is ever produced, and Skill never appears', () => {
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
  const telemetries: (SessionTelemetry | undefined)[] = [
    undefined,
    tel(),
    tel({ model: 'Opus 4.1', branch: 'main' }),
    tel({ costUsd: 0.42, contextPct: 62, usage5hPct: 88, usage7dPct: 12 }),
    tel({ linesAdded: 128, linesRemoved: 41, contextPct: 0 }),
  ];
  const seen = new Set<string>();
  const tones = new Set<string>();
  for (const args of argvs) {
    for (const status of ['running', 'exited'] as const) {
      for (const createdAt of [ago(0), ago(3 * HOUR), 'not a date']) {
        for (const telemetry of telemetries) {
          const produced = items(session({ args, status, createdAt, telemetry }));
          if (status === 'exited') {
            assert.deepEqual(
              produced.filter((i) => i.k === 'Time'),
              [],
              `an exited session must carry no Time (argv ${JSON.stringify(args)})`,
            );
          }
          for (const item of produced) {
            seen.add(item.k);
            tones.add(item.tone);
            assert.ok(ALLOWED_KEYS.includes(item.k), `unexpected key ${JSON.stringify(item.k)}`);
            assert.ok(!NO_SOURCE_KEYS.includes(item.k), `a source-less key leaked: ${item.k}`);
            assert.equal(typeof item.v, 'string');
            assert.notEqual(item.v, '', `${item.k} must never render an empty value`);
            assert.ok(['neutral', 'warn', 'danger'].includes(item.tone), `${item.k} tone ${item.tone}`);
          }
        }
      }
    }
  }
  // Non-vacuity: the matrix really did exercise every key and every tone.
  assert.deepEqual([...seen].sort(), [...ALLOWED_KEYS].sort());
  assert.deepEqual([...tones].sort(), ['danger', 'neutral', 'warn']);
});

test('the module names the v3 keys and no source-less one (no faked Skill)', () => {
  const SRC = readSource('web', 'src', 'ui', 'pane-status-model.ts');
  assert.ok(SRC.includes('export function paneStatusItems'), 'non-vacuity: wrong file');
  // Comments are stripped: the header explains WHY Skill is absent, and that
  // explanation must stay legal while the code stays clean.
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const k of NO_SOURCE_KEYS) {
    assert.equal(code.includes(`'${k}'`), false, `pane-status-model.ts must not emit a ${k} item`);
  }
  for (const k of ALLOWED_KEYS) assert.ok(code.includes(`'${k}'`), `the ${k} key is emitted here`);
});
