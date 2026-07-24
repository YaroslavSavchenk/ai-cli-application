/**
 * server/telemetry.ts — the TelemetryReader class, unit-tested directly (no
 * HTTP, no PTY) against synthetic <claudeDir>/projects/<slug>/*.jsonl fixtures.
 *
 * Proven here: the approximate cost math (Σ over priced assistant turns, per
 * token-type multipliers), model-id normalization ([1m] + -YYYYMMDD suffix
 * stripping) and family fallback, unknown-model omission, the session→log
 * mapping (cwd-slug, newest-*.jsonl-after-createdAt, cwd-match disambiguation,
 * "no log yet" → git-only), (message.id, requestId) cost dedupe, '<synthetic>'
 * drop, contextTokens = latest-turn input+cache_read+cache_creation, the
 * best-effort Skill name, and running-only filtering.
 *
 * The reader is constructed with ttlMs = 0 so no read is ever cache-served —
 * each assertion sees a fresh computation. cwd values are synthetic paths (git
 * probes there fail fast and omit their fields), EXCEPT the one git-repo test
 * that proves git-only fallback with a real repo.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { TelemetryReader } from '../server/telemetry.ts';
import type { Logger } from '../server/config.ts';
import type { SessionInfo, TelemetryItem, TelemetryResponse } from '../shared/protocol.ts';

const pexec = promisify(execFile);
const noop: Logger = () => {};

// --- Fixture builders ------------------------------------------------------

interface Turn {
  model: string;
  ts: string;
  cwd: string;
  input?: number;
  output?: number;
  cacheCreation?: number;
  cacheRead?: number;
  id?: string;
  reqId?: string;
  skill?: string;
  /** for the input.command skill-name fallback branch */
  skillViaCommand?: string;
}

/** One assistant JSONL record. Omitting id/reqId omits those keys entirely. */
function assistantLine(t: Turn): string {
  const content: unknown[] = [];
  if (t.skill !== undefined) content.push({ type: 'tool_use', name: 'Skill', input: { skill: t.skill } });
  if (t.skillViaCommand !== undefined) {
    content.push({ type: 'tool_use', name: 'Skill', input: { command: t.skillViaCommand } });
  }
  return JSON.stringify({
    type: 'assistant',
    timestamp: t.ts,
    cwd: t.cwd,
    ...(t.reqId !== undefined ? { requestId: t.reqId } : {}),
    message: {
      ...(t.id !== undefined ? { id: t.id } : {}),
      model: t.model,
      role: 'assistant',
      content,
      usage: {
        input_tokens: t.input ?? 0,
        output_tokens: t.output ?? 0,
        cache_creation_input_tokens: t.cacheCreation ?? 0,
        cache_read_input_tokens: t.cacheRead ?? 0,
      },
    },
  });
}

interface LogSpec {
  cwd: string;
  file: string;
  lines: string[];
  /** explicit mtime; default (omitted) = now, which is after any past createdAt */
  mtime?: Date;
}

/** Build a temp claudeDir laying out each log under projects/<slug-of-cwd>/. */
async function buildClaudeDir(logs: LogSpec[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ai-sm-telr-'));
  for (const l of logs) {
    const dir = join(root, 'projects', l.cwd.replaceAll('/', '-'));
    await mkdir(dir, { recursive: true });
    const full = join(dir, l.file);
    await writeFile(full, l.lines.join('\n') + '\n', { mode: 0o600 });
    if (l.mtime !== undefined) await utimes(full, l.mtime, l.mtime);
  }
  return root;
}

/** A running claude-kind SessionInfo (createdAt far in the past by default). */
function session(over: { id?: string; cwd: string; command?: string; createdAt?: string }): SessionInfo {
  return {
    id: over.id ?? 'S1',
    title: 'claude',
    command: over.command ?? 'claude',
    args: [],
    cwd: over.cwd,
    status: 'running',
    cols: 80,
    rows: 24,
    createdAt: over.createdAt ?? '2020-01-01T00:00:00.000Z',
    attention: false,
  };
}

async function readOne(claudeDir: string, s: SessionInfo): Promise<TelemetryItem> {
  const reader = new TelemetryReader(claudeDir, noop, 0);
  const resp = await reader.read([s]);
  const item = resp.sessions[s.id];
  assert.ok(item !== undefined, `no telemetry item for session ${s.id}`);
  return item;
}

const T = (n: number): string => `2026-07-24T10:00:${String(n).padStart(2, '0')}.000Z`;

// ---------------------------------------------------------------------------
// Cost math + dedupe + synthetic drop + latest-turn model/context
// ---------------------------------------------------------------------------

test('cost = Σ over priced turns; per-token-type multipliers (opus); (id,requestId) dedupe; <synthetic> dropped even when newest', async () => {
  const cwd = '/w/proj-a';
  const claudeDir = await buildClaudeDir([
    {
      cwd,
      file: 'sess.jsonl',
      lines: [
        assistantLine({ model: 'claude-opus-4-8', ts: T(1), cwd, id: 'a', reqId: 'ra', input: 1_000_000 }), // 5.0
        assistantLine({ model: 'claude-opus-4-8', ts: T(2), cwd, id: 'b', reqId: 'rb', output: 400_000 }), // 10.0
        assistantLine({ model: 'claude-opus-4-8', ts: T(3), cwd, id: 'c', reqId: 'rc', cacheCreation: 1_600_000 }), // 10.0
        assistantLine({ model: 'claude-opus-4-8', ts: T(4), cwd, id: 'd', reqId: 'rd', cacheRead: 2_000_000 }), // 1.0
        // exact (id,requestId) duplicate of d — cost counted ONCE.
        assistantLine({ model: 'claude-opus-4-8', ts: T(4), cwd, id: 'd', reqId: 'rd', cacheRead: 2_000_000 }),
        // synthetic placeholder, NEWEST timestamp — must not touch cost or model/context.
        assistantLine({ model: '<synthetic>', ts: T(5), cwd, id: 'z', reqId: 'rz', input: 9_999_999 }),
      ],
    },
  ]);
  try {
    const item = await readOne(claudeDir, session({ cwd }));
    assert.equal(item.costUsd, 26, 'Σ = 5 + 10 + 10 + 1 (dup dropped, synthetic dropped)');
    assert.equal(item.model, 'claude-opus-4-8', 'latest NON-synthetic turn drives model');
    assert.equal(item.contextTokens, 2_000_000, 'latest turn d: 0 + cacheRead 2_000_000 + 0');
    assert.equal(item.contextMax, 1_000_000, 'opus context window');
  } finally {
    await rm(claudeDir, { recursive: true, force: true });
  }
});

test('a single turn combining all four token types prices each component then sums', async () => {
  const cwd = '/w/combo';
  const claudeDir = await buildClaudeDir([
    {
      cwd,
      file: 'sess.jsonl',
      // opus: input 100k→0.5, output 20k→0.5, cacheCreation 80k→0.5, cacheRead 1M→0.5 = 2.0
      lines: [assistantLine({ model: 'claude-opus-4-8', ts: T(1), cwd, id: 'a', reqId: 'r', input: 100_000, output: 20_000, cacheCreation: 80_000, cacheRead: 1_000_000 })],
    },
  ]);
  try {
    const item = await readOne(claudeDir, session({ cwd }));
    assert.equal(item.costUsd, 2, '0.5 input + 0.5 output + 0.5 cacheWrite + 0.5 cacheRead');
    assert.equal(item.contextTokens, 100_000 + 1_000_000 + 80_000, 'input + cacheRead + cacheCreation (output excluded)');
  } finally {
    await rm(claudeDir, { recursive: true, force: true });
  }
});

test('contextTokens is the LATEST turn only (input + cache_read + cache_creation), not a max/sum across turns', async () => {
  const cwd = '/w/ctx';
  const claudeDir = await buildClaudeDir([
    {
      cwd,
      file: 'sess.jsonl',
      lines: [
        // earlier turn with much larger context — must NOT be the reported value.
        assistantLine({ model: 'claude-opus-4-8', ts: T(1), cwd, id: 'a', reqId: 'ra', input: 900_000, cacheRead: 900_000, cacheCreation: 900_000 }),
        // latest turn: 100 + 3 + 20 = 123 (output 999 excluded).
        assistantLine({ model: 'claude-opus-4-8', ts: T(2), cwd, id: 'b', reqId: 'rb', input: 100, output: 999, cacheCreation: 20, cacheRead: 3 }),
      ],
    },
  ]);
  try {
    const item = await readOne(claudeDir, session({ cwd }));
    assert.equal(item.contextTokens, 123);
  } finally {
    await rm(claudeDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Model-id family fallback + suffix normalization + unknown model
// ---------------------------------------------------------------------------

test('model-id family fallback: opus/sonnet/haiku/fable/mythos families price + set contextMax without an exact table hit', async () => {
  const cases: { cwd: string; model: string; cost: number; ctxMax: number }[] = [
    { cwd: '/f/opus', model: 'claude-opus-4-1-20250805', cost: 5, ctxMax: 1_000_000 }, // date suffix stripped → opus family
    { cwd: '/f/sonnet', model: 'claude-sonnet-9', cost: 3, ctxMax: 1_000_000 },
    { cwd: '/f/haiku', model: 'claude-haiku-7', cost: 1, ctxMax: 200_000 },
    { cwd: '/f/fable', model: 'claude-fable-9', cost: 10, ctxMax: 1_000_000 },
    { cwd: '/f/mythos', model: 'claude-mythos-1', cost: 10, ctxMax: 1_000_000 }, // mythos → FABLE pricing
  ];
  const claudeDir = await buildClaudeDir(
    cases.map((c) => ({
      cwd: c.cwd,
      file: 'sess.jsonl',
      lines: [assistantLine({ model: c.model, ts: T(1), cwd: c.cwd, id: 'a', reqId: 'r', input: 1_000_000 })],
    })),
  );
  try {
    const reader = new TelemetryReader(claudeDir, noop, 0);
    const sessions = cases.map((c, i) => session({ id: `M${i}`, cwd: c.cwd }));
    const resp: TelemetryResponse = await reader.read(sessions);
    for (let i = 0; i < cases.length; i++) {
      const c = cases[i]!;
      const item = resp.sessions[`M${i}`]!;
      assert.equal(item.model, c.model, `${c.model}: raw model string preserved`);
      assert.equal(item.costUsd, c.cost, `${c.model}: family price → cost ${c.cost}`);
      assert.equal(item.contextMax, c.ctxMax, `${c.model}: family contextMax`);
    }
  } finally {
    await rm(claudeDir, { recursive: true, force: true });
  }
});

test('model id normalization: [1m] context suffix and -YYYYMMDD date suffix (and both together) strip before pricing; the RAW model string is still displayed', async () => {
  const cases: { cwd: string; model: string; cost: number }[] = [
    { cwd: '/n/onem', model: 'claude-opus-4-8[1m]', cost: 5 }, // [1m] stripped → exact opus
    { cwd: '/n/date', model: 'claude-sonnet-5-20250101', cost: 3 }, // date stripped → exact sonnet
    { cwd: '/n/both', model: 'claude-opus-4-8-20250101[1m]', cost: 5 }, // both stripped → exact opus
  ];
  const claudeDir = await buildClaudeDir(
    cases.map((c) => ({
      cwd: c.cwd,
      file: 'sess.jsonl',
      lines: [assistantLine({ model: c.model, ts: T(1), cwd: c.cwd, id: 'a', reqId: 'r', input: 1_000_000 })],
    })),
  );
  try {
    const reader = new TelemetryReader(claudeDir, noop, 0);
    const sessions = cases.map((c, i) => session({ id: `N${i}`, cwd: c.cwd }));
    const resp = await reader.read(sessions);
    for (let i = 0; i < cases.length; i++) {
      const c = cases[i]!;
      const item = resp.sessions[`N${i}`]!;
      assert.equal(item.costUsd, c.cost, `${c.model}: normalized to a priced id`);
      assert.equal(item.model, c.model, `${c.model}: normalization affects PRICING only, not the shown model`);
    }
  } finally {
    await rm(claudeDir, { recursive: true, force: true });
  }
});

test('UNKNOWN model: costUsd + contextMax omitted (never guessed); the model string is still present and contextTokens still computed', async () => {
  const cwd = '/u/gpt';
  const claudeDir = await buildClaudeDir([
    {
      cwd,
      file: 'sess.jsonl',
      lines: [assistantLine({ model: 'gpt-4o', ts: T(1), cwd, id: 'a', reqId: 'r', input: 1234, cacheRead: 10, cacheCreation: 5 })],
    },
  ]);
  try {
    const item = await readOne(claudeDir, session({ cwd }));
    assert.equal(item.model, 'gpt-4o', 'model string surfaced even when unpriced');
    assert.equal(item.costUsd, undefined, 'unknown model → cost omitted');
    assert.equal(item.contextMax, undefined, 'unknown model → contextMax omitted');
    assert.equal(item.contextTokens, 1234 + 10 + 5, 'contextTokens is model-independent');
  } finally {
    await rm(claudeDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// session → log mapping
// ---------------------------------------------------------------------------

test('mapping: newest *.jsonl whose mtime >= createdAt wins; a log older than createdAt is ignored', async () => {
  const cwd = '/m/newest';
  const createdAt = '2025-06-15T00:00:00.000Z';
  const claudeDir = await buildClaudeDir([
    // OLD: mtime before createdAt → excluded (belongs to a past session). If it
    // were wrongly included its haiku cost/model would show.
    { cwd, file: 'old.jsonl', mtime: new Date('2025-06-01T00:00:00Z'), lines: [assistantLine({ model: 'claude-haiku-4-5', ts: T(1), cwd, id: 'o', reqId: 'ro', input: 1_000_000 })] },
    // NEW but not newest: sonnet.
    { cwd, file: 'mid.jsonl', mtime: new Date('2025-06-20T00:00:00Z'), lines: [assistantLine({ model: 'claude-sonnet-5', ts: T(1), cwd, id: 'm', reqId: 'rm', input: 1_000_000 })] },
    // NEWEST: opus → this one wins.
    { cwd, file: 'new.jsonl', mtime: new Date('2025-06-25T00:00:00Z'), lines: [assistantLine({ model: 'claude-opus-4-8', ts: T(1), cwd, id: 'n', reqId: 'rn', input: 1_000_000 })] },
  ]);
  try {
    const item = await readOne(claudeDir, session({ cwd, createdAt }));
    assert.equal(item.model, 'claude-opus-4-8', 'newest-after-createdAt log wins');
    assert.equal(item.costUsd, 5, 'cost is from the winning log ONLY (opus 1M input), not summed across files');
    assert.equal(item.contextMax, 1_000_000);
  } finally {
    await rm(claudeDir, { recursive: true, force: true });
  }
});

test('mapping: cwd-match on records disambiguates a slug collision — the newest log NOT confirming this cwd is skipped for the older one that does', async () => {
  // /a/b-c and /a/b/c both slug to -a-b-c. This session is /a/b-c.
  const cwd = '/a/b-c';
  const other = '/a/b/c';
  const claudeDir = await buildClaudeDir([
    // WRONG cwd, NEWEST mtime — records are for /a/b/c, so it must be skipped.
    { cwd, file: 'wrong.jsonl', mtime: new Date('2025-06-25T00:00:00Z'), lines: [assistantLine({ model: 'claude-haiku-4-5', ts: T(1), cwd: other, id: 'w', reqId: 'rw', input: 1_000_000 })] },
    // RIGHT cwd, older — the winner because its records confirm session.cwd.
    { cwd, file: 'right.jsonl', mtime: new Date('2025-06-20T00:00:00Z'), lines: [assistantLine({ model: 'claude-opus-4-8', ts: T(1), cwd, id: 'r', reqId: 'rr', input: 1_000_000 })] },
  ]);
  try {
    const item = await readOne(claudeDir, session({ cwd, createdAt: '2025-06-15T00:00:00.000Z' }));
    assert.equal(item.model, 'claude-opus-4-8', 'the log whose records match this cwd wins, not the merely-newest one');
    assert.equal(item.contextMax, 1_000_000);
  } finally {
    await rm(claudeDir, { recursive: true, force: true });
  }
});

test('mapping: a log dir with NO record matching this cwd yields no claude fields (never a wrong-session attribution)', async () => {
  const cwd = '/a/b-c';
  const other = '/a/b/c';
  const claudeDir = await buildClaudeDir([
    { cwd, file: 'wrong.jsonl', lines: [assistantLine({ model: 'claude-opus-4-8', ts: T(1), cwd: other, id: 'w', reqId: 'rw', input: 1_000_000 })] },
  ]);
  try {
    const item = await readOne(claudeDir, session({ cwd }));
    assert.equal(item.model, undefined, 'no cwd-confirming record → model omitted');
    assert.equal(item.costUsd, undefined);
    assert.equal(item.contextTokens, undefined);
  } finally {
    await rm(claudeDir, { recursive: true, force: true });
  }
});

test('mapping: "no log yet" (claude-kind session, no projects/<slug> dir) → git-only, claude fields absent', async () => {
  const claudeDir = await mkdtemp(join(tmpdir(), 'ai-sm-telr-nolog-'));
  const repo = await mkdtemp(join(tmpdir(), 'ai-sm-telr-repo-'));
  try {
    await pexec('git', ['-C', repo, 'init', '-b', 'main']);
    await pexec('git', ['-C', repo, 'config', 'user.email', 't@t']);
    await pexec('git', ['-C', repo, 'config', 'user.name', 't']);
    await writeFile(join(repo, 'f.txt'), 'x\n');
    await pexec('git', ['-C', repo, 'add', 'f.txt']);
    await pexec('git', ['-C', repo, 'commit', '-m', 'init']);

    const item = await readOne(claudeDir, session({ cwd: repo, command: 'claude' }));
    assert.equal(item.branch, 'main', 'git branch present for a claude session with no log yet');
    assert.equal(item.model, undefined, 'no log → no model');
    assert.equal(item.costUsd, undefined, 'no log → no cost');
    assert.equal(item.contextTokens, undefined);
    assert.equal(item.skill, undefined);
  } finally {
    await rm(claudeDir, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Skill + running-only filtering
// ---------------------------------------------------------------------------

test('skill: the most-recent Skill tool_use name is surfaced; input.skill preferred, input.command as fallback', async () => {
  const cwd = '/s/skill';
  const claudeDir = await buildClaudeDir([
    {
      cwd,
      file: 'sess.jsonl',
      lines: [
        assistantLine({ model: 'claude-opus-4-8', ts: T(1), cwd, id: 'a', reqId: 'ra', input: 1, skillViaCommand: 'first-cmd' }),
        assistantLine({ model: 'claude-opus-4-8', ts: T(2), cwd, id: 'b', reqId: 'rb', input: 1, skill: 'edit' }),
      ],
    },
  ]);
  try {
    const item = await readOne(claudeDir, session({ cwd }));
    assert.equal(item.skill, 'edit', 'newest Skill wins (input.skill)');
  } finally {
    await rm(claudeDir, { recursive: true, force: true });
  }
});

test('skill: input.command is used when input.skill is absent', async () => {
  const cwd = '/s/cmd';
  const claudeDir = await buildClaudeDir([
    { cwd, file: 'sess.jsonl', lines: [assistantLine({ model: 'claude-opus-4-8', ts: T(1), cwd, id: 'a', reqId: 'r', input: 1, skillViaCommand: 'commit' })] },
  ]);
  try {
    const item = await readOne(claudeDir, session({ cwd }));
    assert.equal(item.skill, 'commit');
  } finally {
    await rm(claudeDir, { recursive: true, force: true });
  }
});

test('read() covers RUNNING sessions only — an exited session is omitted from the response entirely', async () => {
  const cwd = '/r/run';
  const claudeDir = await buildClaudeDir([
    { cwd, file: 'sess.jsonl', lines: [assistantLine({ model: 'claude-opus-4-8', ts: T(1), cwd, id: 'a', reqId: 'r', input: 1_000_000 })] },
  ]);
  try {
    const reader = new TelemetryReader(claudeDir, noop, 0);
    const running = session({ id: 'RUN', cwd });
    const exited: SessionInfo = { ...session({ id: 'EXIT', cwd }), status: 'exited', exitCode: 0 };
    const resp = await reader.read([running, exited]);
    assert.deepEqual(Object.keys(resp.sessions), ['RUN'], 'only the running session appears');
    assert.equal(resp.sessions['RUN']!.model, 'claude-opus-4-8');
  } finally {
    await rm(claudeDir, { recursive: true, force: true });
  }
});

test('a non-claude session (basename(command) !== "claude") never reads a Claude log even if a slug dir exists', async () => {
  const cwd = '/w/bashlike';
  const claudeDir = await buildClaudeDir([
    { cwd, file: 'sess.jsonl', lines: [assistantLine({ model: 'claude-opus-4-8', ts: T(1), cwd, id: 'a', reqId: 'r', input: 1_000_000 })] },
  ]);
  try {
    const item = await readOne(claudeDir, session({ cwd, command: '/usr/bin/bash' }));
    assert.equal(item.model, undefined, 'bash session → Claude log never consulted');
    assert.equal(item.costUsd, undefined);
  } finally {
    await rm(claudeDir, { recursive: true, force: true });
  }
});
