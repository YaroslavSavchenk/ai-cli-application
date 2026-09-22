/**
 * `web/src/ui/pane-agents-model.ts` — the MODEL behind the pane's "Background
 * agents" table (Nocturne part B7, `.claude/plans/nocturne/PLAN-B7.md`; the
 * table itself is part A3's).
 *
 * The module is DOM-free and clock-free (`now` is a parameter), so plain
 * `node --test` imports it directly and this file is also the guard that keeps
 * it that way: an accidental `document` dependency shows up here as an
 * import-time throw, an accidental `Date.now()` as a nondeterministic time.
 *
 * What is pinned:
 *   1. WHO GETS A TABLE. The known agent only (`isClaudeCommand`, the same
 *      rule the status bar follows) and only once a subagent exists: no
 *      session, another tool, or an absent/empty list all yield [] — the block
 *      is ABSENT, not an empty table (the A3 rule `renderAgents([])` keeps).
 *   2. THE SERVER ORDERS AND CAPS; this module neither sorts, filters nor
 *      trims. The rows come out in the order they came in, one per agent.
 *   3. THE TWO FORMATS AT THEIR BOUNDARIES — every unit change of
 *      `formatDuration` (60 s, 1 h, 1 d) and of `formatTokens` (1000, and the
 *      999 950 where the rounded k figure would read `1000.0k`), plus what a
 *      value that is not a value reads as: `0s` and `0`, never `NaN`.
 *   4. TIME'S TWO SOURCES: a running agent is measured against `now` (so the
 *      pane's 15 s tick moves it), a finished one against its own `endedAt`
 *      (so it stands still and states what it took, not how long ago it ran).
 *   5. NO ROW IS EVER `attention` — a subagent asks the user nothing (B7).
 *
 * NOT claimed here: that anything is rendered or legible. The renderer is
 * `web/src/ui/pane-agents.ts` (pinned structurally by `tests/ui-pane-a3.test.ts`)
 * and the looks stay manual (`.claude/skills/verify-terminal/SKILL.md`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionAgent, SessionInfo } from '../shared/protocol.ts';
import {
  agentRows,
  formatDuration,
  formatTokens,
} from '../web/src/ui/pane-agents-model.ts';
import type { AgentRow } from '../web/src/ui/pane-agents.ts';
import { projectRoot } from './helpers.ts';

/** A fixed clock, and a timestamp a known distance before it. */
const NOW = Date.parse('2026-09-22T12:00:00.000Z');
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const at = (ms: number): string => new Date(NOW + ms).toISOString();

/** A running session of the known agent, as `GET /api/sessions` shapes it. */
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
    createdAt: at(-30 * MIN),
    attention: false,
    statusline: true,
    ...over,
  };
}

/** One agent on the wire, exactly as `server/agents.ts` sends it. */
function agent(over: Partial<SessionAgent> = {}): SessionAgent {
  return {
    id: 'a1',
    name: 'test-engineer',
    task: 'Test gate B7',
    startedAt: at(-2 * MIN - 10 * SEC),
    tokens: 12_400,
    state: 'running',
    ...over,
  };
}

const rows = (agents: SessionAgent[], now: number = NOW): AgentRow[] =>
  agentRows(session({ agents }), now);

// ---------------------------------------------------------------------------
// 1. Who gets a table at all
// ---------------------------------------------------------------------------

test('no session (an empty pane) -> no rows, so no table', () => {
  assert.deepEqual(agentRows(undefined, NOW), []);
});

test('a non-claude command gets NO table — not an empty one', () => {
  for (const command of ['/bin/bash', 'bash', 'powershell.exe', 'npm', 'claude-code', 'myclaude']) {
    assert.deepEqual(
      agentRows(session({ command, agents: [agent()] }), NOW),
      [],
      `${command} is not the known agent`,
    );
  }
});

test('a claude session with no agents key, or an empty one, yields no rows', () => {
  assert.deepEqual(agentRows(session(), NOW), []);
  assert.deepEqual(agentRows(session({ agents: [] }), NOW), []);
});

test('the known agent is recognised by basename, the same rule the status bar uses', () => {
  for (const command of ['claude', '/usr/local/bin/claude', 'C:\\bin\\claude']) {
    assert.equal(
      agentRows(session({ command, agents: [agent()] }), NOW).length,
      1,
      `${command} must get its table`,
    );
  }
});

test('an EXITED claude session keeps its table — what its agents cost is still true', () => {
  const out = agentRows(
    session({ status: 'exited', agents: [agent({ state: 'finished', endedAt: at(-MIN) })] }),
    NOW,
  );
  assert.equal(out.length, 1);
  assert.equal(out[0]?.dot, 'finished');
});

// ---------------------------------------------------------------------------
// 2. The server's order and cap are taken as given
// ---------------------------------------------------------------------------

test('rows come out one per agent, in the order they arrived — nothing is sorted or dropped', () => {
  const list: SessionAgent[] = [
    agent({ id: 'a1', name: 'running-old', startedAt: at(-9 * MIN) }),
    agent({ id: 'a2', name: 'running-new', startedAt: at(-MIN) }),
    agent({ id: 'a3', name: 'done-new', state: 'finished', startedAt: at(-8 * MIN), endedAt: at(-2 * MIN) }),
    agent({ id: 'a4', name: 'done-old', state: 'finished', startedAt: at(-40 * MIN), endedAt: at(-30 * MIN) }),
  ];
  assert.deepEqual(
    rows(list).map((r) => r.name),
    ['running-old', 'running-new', 'done-new', 'done-old'],
  );
});

test('the name and the task travel verbatim — the server sanitised and capped them', () => {
  const out = rows([agent({ name: 'scope-reviewer', task: 'Read both diffs against the spec' })]);
  assert.equal(out[0]?.name, 'scope-reviewer');
  assert.equal(out[0]?.task, 'Read both diffs against the spec');
});

test('an empty task is an empty cell, not a placeholder', () => {
  assert.equal(rows([agent({ task: '' })])[0]?.task, '');
});

// ---------------------------------------------------------------------------
// 3. formatDuration — every unit boundary
// ---------------------------------------------------------------------------

test('formatDuration: below a minute is seconds only', () => {
  assert.equal(formatDuration(0), '0s');
  assert.equal(formatDuration(999), '0s');
  assert.equal(formatDuration(42 * SEC), '42s');
  assert.equal(formatDuration(59 * SEC), '59s');
  assert.equal(formatDuration(59 * SEC + 999), '59s');
});

test('formatDuration: a minute turns the display over, with a padded second unit', () => {
  assert.equal(formatDuration(60 * SEC), '1m 00s');
  assert.equal(formatDuration(2 * MIN + 10 * SEC), '2m 10s');
  assert.equal(formatDuration(9 * MIN + 5 * SEC), '9m 05s');
  assert.equal(formatDuration(3599 * SEC), '59m 59s');
});

test('formatDuration: an hour turns it over again', () => {
  assert.equal(formatDuration(3600 * SEC), '1h 00m');
  assert.equal(formatDuration(HOUR + 5 * MIN), '1h 05m');
  assert.equal(formatDuration(HOUR + 5 * MIN + 59 * SEC), '1h 05m');
  assert.equal(formatDuration(DAY - SEC), '23h 59m');
});

test('formatDuration: a day is the last unit', () => {
  assert.equal(formatDuration(86_400 * SEC), '1d 00h');
  assert.equal(formatDuration(3 * DAY + 2 * HOUR), '3d 02h');
  assert.equal(formatDuration(12 * DAY + 23 * HOUR + 59 * MIN), '12d 23h');
});

test('formatDuration: what is not a span reads 0s, never NaN', () => {
  for (const bad of [NaN, -1, -5 * MIN, Infinity, -Infinity]) {
    assert.equal(formatDuration(bad), '0s', `${bad} is not a duration`);
  }
});

// ---------------------------------------------------------------------------
// 4. formatTokens — every unit boundary
// ---------------------------------------------------------------------------

test('formatTokens: under a thousand is the number itself', () => {
  assert.equal(formatTokens(0), '0');
  assert.equal(formatTokens(1), '1');
  assert.equal(formatTokens(999), '999');
});

test('formatTokens: thousands carry one decimal and drop a trailing .0', () => {
  assert.equal(formatTokens(1000), '1k');
  assert.equal(formatTokens(1049), '1k');
  assert.equal(formatTokens(1050), '1.1k');
  assert.equal(formatTokens(12_400), '12.4k');
  assert.equal(formatTokens(999_949), '999.9k');
});

test('formatTokens: the turn to M happens where k would read 1000.0k', () => {
  assert.equal(formatTokens(999_950), '1M');
  assert.equal(formatTokens(1_000_000), '1M');
  assert.equal(formatTokens(1_200_000), '1.2M');
  // The figure a 15-minute agent really reported (PLAN-B7 § defaults).
  assert.equal(formatTokens(12_500_000), '12.5M');
});

test('formatTokens: what is not a count reads 0', () => {
  for (const bad of [NaN, Infinity, -Infinity, -1, -12_400]) {
    assert.equal(formatTokens(bad), '0', `${bad} is not a token count`);
  }
});

// ---------------------------------------------------------------------------
// 5. Time's two sources, and the dot
// ---------------------------------------------------------------------------

test('a RUNNING agent is measured against now — the 15 s tick moves it', () => {
  const a = agent({ startedAt: at(-2 * MIN - 10 * SEC) });
  assert.equal(rows([a], NOW)[0]?.time, '2m 10s');
  assert.equal(rows([a], NOW + 15 * SEC)[0]?.time, '2m 25s');
  assert.equal(rows([a], NOW + HOUR)[0]?.time, '1h 02m');
});

test('a FINISHED agent is measured against its own end — it states what it took', () => {
  const a = agent({ state: 'finished', startedAt: at(-40 * MIN), endedAt: at(-30 * MIN) });
  assert.equal(rows([a], NOW)[0]?.time, '10m 00s');
  // ...and an hour later it still says the same thing.
  assert.equal(rows([a], NOW + HOUR)[0]?.time, '10m 00s');
});

test('a finished agent whose end is missing or unparseable reads 0s, not NaN', () => {
  const started = at(-10 * MIN);
  assert.equal(rows([agent({ state: 'finished', startedAt: started })], NOW)[0]?.time, '0s');
  assert.equal(
    rows([agent({ state: 'finished', startedAt: started, endedAt: 'yesterday' })], NOW)[0]?.time,
    '0s',
  );
  assert.equal(
    rows([agent({ state: 'finished', startedAt: 'not a date', endedAt: at(0) })], NOW)[0]?.time,
    '0s',
  );
});

test('a running agent with an unparseable or future start reads 0s', () => {
  assert.equal(rows([agent({ startedAt: 'not a date' })], NOW)[0]?.time, '0s');
  assert.equal(rows([agent({ startedAt: at(5 * MIN) })], NOW)[0]?.time, '0s');
});

test('the dot is the state, and it is NEVER attention (B7 emits two tones)', () => {
  const out = rows([
    agent({ id: 'a1', state: 'running' }),
    agent({ id: 'a2', state: 'finished', endedAt: at(-MIN) }),
  ]);
  assert.deepEqual(out.map((r) => r.dot), ['running', 'finished']);
  for (const r of out) assert.notEqual(r.dot, 'attention');
});

test('a whole row, end to end', () => {
  assert.deepEqual(
    rows([
      agent({
        name: 'backend-pty',
        task: 'Wire the agents watcher',
        startedAt: at(-2 * MIN - 10 * SEC),
        tokens: 12_400,
        state: 'running',
      }),
    ]),
    [
      {
        name: 'backend-pty',
        task: 'Wire the agents watcher',
        time: '2m 10s',
        tokens: '12.4k',
        dot: 'running',
      },
    ],
  );
});

// ---------------------------------------------------------------------------
// 6. The module stays DOM-free and clock-free
// ---------------------------------------------------------------------------

test('the model imports no DOM module and reads no clock of its own', () => {
  const src = readFileSync(
    join(projectRoot, 'web', 'src', 'ui', 'pane-agents-model.ts'),
    'utf8',
  );
  assert.ok(src.length > 500, 'non-vacuity: the model source is being read');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.equal(/\bdocument\b|\bwindow\b/.test(code), false, 'no DOM here');
  // The only Date.now() allowed is the default parameter the caller overrides.
  const clocks = [...code.matchAll(/Date\.now\(\)/g)];
  assert.equal(clocks.length, 1, 'exactly one Date.now(), the `now` default');
  assert.match(code, /now:\s*number\s*=\s*Date\.now\(\)/, 'and it IS that default');
  // The type import from the renderer is type-only: no DOM is pulled in.
  assert.match(code, /import type \{ AgentRow \} from '\.\/pane-agents\.ts'/);
});
