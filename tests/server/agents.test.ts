/**
 * server/agents.ts — the subagents Claude Code ran for a session, read out of
 * its own transcripts and turned into SessionInfo.agents (Nocturne B7,
 * .claude/plans/nocturne/PLAN-B7.md).
 *
 * Three halves, all hostile-input tests, because every byte here comes from a
 * file this process did not write:
 *   1. subagentsDirFor — THE BOUNDARY. The transcript path arrives in a
 *      snapshot any process running as this user can plant, so the refusals
 *      (relative, `..`, a symlink out of the root, a basename that is not a
 *      uuid, a control character, 1025 characters, a root that is not there)
 *      are what stands between that file and an arbitrary read.
 *   2. foldLine — the per-line fold: one API message is several consecutive
 *      lines repeating the same usage and must be counted ONCE, `end_turn`
 *      ends a turn and a later `user` line un-ends it, and a torn line (the
 *      file is appended to while we read it) is ordinary, not an error.
 *   3. AgentsWatcher on real temp directories: incremental reads, truncation,
 *      the pinned-clock stale rule, the row caps, the tracked cap, untrack and
 *      stop.
 *
 * The honesty rule (B1, memory/decisions/pane-status-bar-data-source.md) is
 * pinned throughout: no value the files did not carry — a missing usage adds a
 * real 0, a transcript without a timestamp falls back to the meta file's
 * mtime, never to "now".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFile, chmod, mkdir, mkdtemp, rm, symlink, truncate, utimes, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WebSocket } from 'ws';
import type { ServerMessage, SessionAgent, SessionInfo } from '../../shared/protocol.ts';
import {
  AgentsWatcher,
  foldLine,
  newFold,
  sameAgents,
  sameReport,
  subagentsDirFor,
  turnOfLine,
  type AgentsReport,
} from '../../server/agents.ts';
import { resolveDataPaths, type Logger } from '../../server/config.ts';
import { SessionHistory } from '../../server/history.ts';
import { SessionManager } from '../../server/sessions.ts';

const ESC = String.fromCharCode(27);
const NUL = String.fromCharCode(0);
const DEL = String.fromCharCode(127);

const UUID = '0f2a5c8e-1b3d-4f60-9a77-2c1e5b8d4a09';
const OTHER_UUID = '11111111-2222-4333-8444-555555555555';

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The constants in server/agents.ts (not exported; kept in step here). */
const STALE_MS = 15 * 60 * 1000;
const MAX_AGENTS = 64;
const MAX_RUNNING_ROWS = 4;
const MAX_LINE = 1024 * 1024;
const TURN_TAIL_BYTES = 1024 * 1024;

/** A whole-second mtime "just now": utimes stores it exactly, and it is not stale. */
const NOW_S = Math.floor(Date.now() / 1_000);

// ---------------------------------------------------------------------------
// subagentsDirFor — the boundary
// ---------------------------------------------------------------------------

/** A real projects root with one `<slug>` in it, realpath'd like the code does. */
async function makeRoot(): Promise<{ base: string; root: string; slug: string; cleanup: () => Promise<void> }> {
  const base = realpathSync(await mkdtemp(join(tmpdir(), 'ai-sm-agents-')));
  const root = join(base, 'projects');
  const slug = join(root, '-home-u-projects-app');
  await mkdir(slug, { recursive: true });
  return { base, root, slug, cleanup: async (): Promise<void> => rm(base, { recursive: true, force: true }) };
}

test('subagentsDirFor: a real transcript under the root yields <dir>/<uuid>/subagents', async () => {
  const r = await makeRoot();
  try {
    assert.equal(subagentsDirFor(join(r.slug, `${UUID}.jsonl`), r.root), join(r.slug, UUID, 'subagents'));
    // The session directory does not have to exist yet: Claude Code creates it
    // when the first subagent spawns, and the watcher polls until it does.
    assert.equal(subagentsDirFor(join(r.root, `${UUID}.jsonl`), r.root), join(r.root, UUID, 'subagents'));
  } finally {
    await r.cleanup();
  }
});

test('subagentsDirFor: the path must be absolute and already normalised', async () => {
  const r = await makeRoot();
  try {
    const refused = [
      `projects/-home-u-projects-app/${UUID}.jsonl`, // relative
      `./${UUID}.jsonl`,
      // `..` AS WRITTEN — join() would have normalised it away, which is
      // exactly the difference the check is about.
      `${r.slug}/../-home-u-projects-app/${UUID}.jsonl`,
      `${r.root}/../../etc/${UUID}.jsonl`,
      `${r.slug}//${UUID}.jsonl`, // a doubled separator
      `${r.slug}/./${UUID}.jsonl`,
      `${join(r.slug, UUID)}.jsonl/`, // a trailing separator
    ];
    for (const path of refused) {
      assert.equal(subagentsDirFor(path, r.root), null, path);
    }
  } finally {
    await r.cleanup();
  }
});

test('subagentsDirFor: only `<uuid>.jsonl` is a transcript name', async () => {
  const r = await makeRoot();
  try {
    for (const name of [
      'shadow', // no extension
      'passwd.jsonl', // not a uuid
      `${UUID}.json`, // the wrong extension
      `${UUID}.jsonl.bak`,
      `x${UUID}.jsonl`,
      '0f2a5c8e1b3d4f609a772c1e5b8d4a09.jsonl', // a uuid without its dashes
      '0f2a5c8e-1b3d-4f60-9a77-2c1e5b8d4a0.jsonl', // one character short
      '.jsonl',
    ]) {
      assert.equal(subagentsDirFor(join(r.slug, name), r.root), null, name);
    }
  } finally {
    await r.cleanup();
  }
});

test('subagentsDirFor: a control character, NUL, an empty string or 1025 characters are refused', async () => {
  const r = await makeRoot();
  try {
    assert.equal(subagentsDirFor('', r.root), null);
    assert.equal(subagentsDirFor(`${r.slug}/${ESC}[31m/${UUID}.jsonl`, r.root), null, 'ESC');
    assert.equal(subagentsDirFor(`${r.slug}/a${NUL}b/${UUID}.jsonl`, r.root), null, 'NUL');
    assert.equal(subagentsDirFor(`${r.slug}/a${DEL}b/${UUID}.jsonl`, r.root), null, 'DEL');
    assert.equal(subagentsDirFor(`${r.slug}/a\nb/${UUID}.jsonl`, r.root), null, 'newline');
    // 1025 characters: refused by length alone, before anything is normalised
    // or realpath'd — the cap exists so a megabyte string never gets that far.
    const long = `/${'a'.repeat(1024 - `/${UUID}.jsonl`.length - 1)}/${UUID}.jsonl`;
    assert.equal(long.length, 1024, 'the fixture is exactly at the cap');
    assert.equal(subagentsDirFor(`${long}x`, r.root), null, '1025 characters');
  } finally {
    await r.cleanup();
  }
});

test('subagentsDirFor: a directory symlinked OUT of the root is refused, not followed', async () => {
  const r = await makeRoot();
  try {
    const outside = join(r.base, 'elsewhere');
    await mkdir(outside, { recursive: true });
    const trap = join(r.root, 'escape');
    await symlink(outside, trap);
    // The path reads as if it were inside the root; realpath says otherwise.
    assert.equal(subagentsDirFor(join(trap, `${UUID}.jsonl`), r.root), null);

    // A symlink that stays INSIDE the root is fine, and resolves to its target.
    const inside = join(r.root, 'alias');
    await symlink(r.slug, inside);
    assert.equal(subagentsDirFor(join(inside, `${UUID}.jsonl`), r.root), join(r.slug, UUID, 'subagents'));
  } finally {
    await r.cleanup();
  }
});

test('subagentsDirFor: a sibling whose name STARTS with the root is not inside it', async () => {
  const r = await makeRoot();
  try {
    const evil = `${r.root}-evil`;
    await mkdir(evil, { recursive: true });
    assert.equal(subagentsDirFor(join(evil, `${UUID}.jsonl`), r.root), null);
  } finally {
    await r.cleanup();
  }
});

test('subagentsDirFor: a control character is refused even when the directory REALLY exists', async () => {
  // Every other refusal in this file happens to be backed up by realpath
  // failing on a directory that is not there. A control character is NOT: on
  // Linux every byte but NUL and `/` is a legal file name, so a planted
  // snapshot can name a directory that exists AND carries an ESC — and the
  // path would reach a log line (and a terminal) if the check were gone.
  const r = await makeRoot();
  try {
    for (const name of [`a${ESC}b`, `a${DEL}b`, 'a\nb', 'a\tb']) {
      const dir = join(r.root, name);
      await mkdir(dir, { recursive: true });
      assert.equal(
        subagentsDirFor(join(dir, `${UUID}.jsonl`), r.root),
        null,
        `${JSON.stringify(name)} exists on disk and is still refused`,
      );
    }
    // The control-free twin of the same shape IS accepted, so the refusals
    // above are the control character and nothing else.
    const fine = join(r.root, 'aXb');
    await mkdir(fine, { recursive: true });
    assert.equal(subagentsDirFor(join(fine, `${UUID}.jsonl`), r.root), join(fine, UUID, 'subagents'));
  } finally {
    await r.cleanup();
  }
});

test('subagentsDirFor: a RELATIVE path is refused even when the cwd would make it resolve', async () => {
  // dirname('<uuid>.jsonl') is '.', which realpath resolves to this process's
  // working directory: a relative path is not a harmless one, it is one whose
  // meaning depends on where the server happens to have been started.
  const cwd = realpathSync(process.cwd());
  assert.equal(subagentsDirFor(`${UUID}.jsonl`, cwd), null, 'the cwd is not a licence');
  assert.equal(subagentsDirFor(`./${UUID}.jsonl`, cwd), null);
  // The same file named absolutely is the one the check is about.
  assert.equal(subagentsDirFor(join(cwd, `${UUID}.jsonl`), cwd), join(cwd, UUID, 'subagents'));
});

test('subagentsDirFor: a name that is a uuid plus SIX other characters is not `<uuid>.jsonl`', async () => {
  // The extension is checked before the uuid is cut off the name; without that
  // check `<uuid>` + any six characters would pass, because slicing six
  // characters off the end leaves a perfectly good uuid.
  const r = await makeRoot();
  try {
    for (const name of [`${UUID}.JSONL`, `${UUID}abcdef`, `${UUID}.jsonX`, `${UUID}-file1`]) {
      assert.equal(name.length, UUID.length + 6, `${name} is the dangerous length`);
      assert.equal(subagentsDirFor(join(r.slug, name), r.root), null, name);
    }
  } finally {
    await r.cleanup();
  }
});

/** A real directory under `root` whose full path is exactly `total` characters. */
async function dirOfLength(root: string, total: number): Promise<string> {
  let dir = root;
  while (total - dir.length - 1 > 200) {
    dir = join(dir, 'a'.repeat(100));
    await mkdir(dir, { recursive: true });
  }
  dir = join(dir, 'a'.repeat(total - dir.length - 1));
  await mkdir(dir, { recursive: true });
  assert.equal(dir.length, total);
  return dir;
}

test('subagentsDirFor: 1024 characters is the cap — 1025 is refused even from a real directory', async () => {
  // The length cap is the first thing checked, before normalise and before
  // realpath, so that a planted megabyte string never reaches either. Pinned
  // against a directory that EXISTS on both sides of the boundary, so the
  // refusal is the length and not a realpath that failed.
  const r = await makeRoot();
  try {
    const tail = `/${UUID}.jsonl`;
    const okDir = await dirOfLength(r.root, 1024 - tail.length);
    const okPath = `${okDir}${tail}`;
    assert.equal(okPath.length, 1024);
    assert.equal(subagentsDirFor(okPath, r.root), join(okDir, UUID, 'subagents'), 'exactly 1024 is allowed');

    const longDir = await dirOfLength(r.root, 1025 - tail.length);
    const longPath = `${longDir}${tail}`;
    assert.equal(longPath.length, 1025);
    assert.equal(subagentsDirFor(longPath, r.root), null, 'one character past the cap is refused');
  } finally {
    await r.cleanup();
  }
});

test('subagentsDirFor: a root that does not exist refuses everything', async () => {
  const r = await makeRoot();
  try {
    assert.equal(subagentsDirFor(join(r.slug, `${UUID}.jsonl`), join(r.base, 'no-claude-here')), null);
    // ...and so does a directory that is not there any more.
    assert.equal(subagentsDirFor(join(r.base, 'gone', `${UUID}.jsonl`), r.root), null);
  } finally {
    await r.cleanup();
  }
});

// ---------------------------------------------------------------------------
// foldLine
// ---------------------------------------------------------------------------

interface Usage {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
}

/** An assistant line the way Claude Code writes one. */
function assistantLine(
  timestamp: string,
  id: string,
  usage: Usage | undefined,
  stopReason: string | null = 'tool_use',
): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp,
    uuid: 'x',
    message: { id, role: 'assistant', stop_reason: stopReason, ...(usage === undefined ? {} : { usage }) },
  });
}

/** A user line (the prompt, a tool result, or a SendMessage that resumed the agent). */
function userLine(timestamp: string): string {
  return JSON.stringify({ type: 'user', timestamp, message: { role: 'user', content: 'go on' } });
}

test('foldLine: one API message written as several lines is counted ONCE', () => {
  const acc = newFold();
  const usage = { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1_000, output_tokens: 5 };
  // Three content blocks, one message: the same id and the same usage, as measured.
  foldLine(acc, assistantLine('2026-09-16T10:00:00.000Z', 'msg-1', usage));
  foldLine(acc, assistantLine('2026-09-16T10:00:00.100Z', 'msg-1', usage));
  foldLine(acc, assistantLine('2026-09-16T10:00:00.200Z', 'msg-1', usage));
  assert.equal(acc.tokens, 1_115);
  // The next message counts again.
  foldLine(acc, assistantLine('2026-09-16T10:00:01.000Z', 'msg-2', usage));
  assert.equal(acc.tokens, 2_230);
});

test('foldLine: usage without the cache keys sums what IS there, and none at all adds 0', () => {
  const acc = newFold();
  foldLine(acc, assistantLine('2026-09-16T10:00:00.000Z', 'm1', { input_tokens: 7, output_tokens: 3 }));
  assert.equal(acc.tokens, 10);
  // No usage object: the message really cost nothing we could see.
  foldLine(acc, assistantLine('2026-09-16T10:00:01.000Z', 'm2', undefined));
  assert.equal(acc.tokens, 10);
  // Nonsense figures are not spend: NaN, a string, a negative, Infinity.
  foldLine(
    acc,
    assistantLine('2026-09-16T10:00:02.000Z', 'm3', {
      input_tokens: -5,
      cache_read_input_tokens: Number.POSITIVE_INFINITY,
      output_tokens: 4,
    } as Usage),
  );
  assert.equal(acc.tokens, 14);
  foldLine(acc, JSON.stringify({ type: 'assistant', timestamp: '2026-09-16T10:00:03.000Z', message: { id: 'm4', usage: { input_tokens: 'lots' } } }));
  assert.equal(acc.tokens, 14);
});

test('foldLine: end_turn finishes the agent, a LATER user line makes it run again', () => {
  const acc = newFold();
  foldLine(acc, userLine('2026-09-16T10:00:00.000Z'));
  assert.equal(acc.finished, false);
  foldLine(acc, assistantLine('2026-09-16T10:05:00.000Z', 'm1', { output_tokens: 1 }, 'end_turn'));
  assert.equal(acc.finished, true);
  assert.equal(acc.endedAt, '2026-09-16T10:05:00.000Z');
  // The orchestrator resumed it through SendMessage.
  foldLine(acc, userLine('2026-09-16T10:09:00.000Z'));
  assert.equal(acc.finished, false);
  assert.equal(acc.endedAt, '', 'an end that was undone leaves no end stamp');
  // And it ends again.
  foldLine(acc, assistantLine('2026-09-16T10:11:00.000Z', 'm2', { output_tokens: 2 }, 'end_turn'));
  assert.equal(acc.finished, true);
  assert.equal(acc.endedAt, '2026-09-16T10:11:00.000Z');
});

test('foldLine: an assistant line with NO message id is counted, once', () => {
  // Claude Code always writes an id, but the file is untrusted: a line without
  // one must still contribute its usage (the honesty rule — it really cost
  // that), and the consecutive-duplicate rule must still hold for it, since ''
  // is the id that line has.
  const acc = newFold();
  const usage = { input_tokens: 4, output_tokens: 6 };
  foldLine(acc, JSON.stringify({ type: 'assistant', timestamp: '2026-09-16T10:00:00.000Z', message: { usage } }));
  assert.equal(acc.tokens, 10, 'a message with no id still cost what it cost');
  // The same idless message written as a second content block: not counted twice.
  foldLine(acc, JSON.stringify({ type: 'assistant', timestamp: '2026-09-16T10:00:00.100Z', message: { usage } }));
  assert.equal(acc.tokens, 10);
  // A message that DOES carry an id is a different message and counts again.
  foldLine(acc, assistantLine('2026-09-16T10:00:01.000Z', 'm1', usage));
  assert.equal(acc.tokens, 20);
});

test('foldLine: the token sum is clamped at 1e12, and so is every field of it', () => {
  // A planted transcript must not put a number on the wire that is not a
  // finite integer a table can draw.
  const acc = newFold();
  foldLine(acc, assistantLine('2026-09-16T10:00:00.000Z', 'm1', { input_tokens: 5e12, output_tokens: 5e12 }));
  assert.equal(acc.tokens, 1e12, 'each field clamps, and so does the sum');
  foldLine(acc, assistantLine('2026-09-16T10:00:01.000Z', 'm2', { output_tokens: 1e12 }));
  assert.equal(acc.tokens, 1e12, 'the running total never passes the cap either');
  assert.equal(Number.isSafeInteger(acc.tokens), true);
});

test('foldLine: a stop_reason that is not end_turn leaves it running', () => {
  const acc = newFold();
  for (const reason of ['tool_use', 'max_tokens', 'stop_sequence', null, 'END_TURN']) {
    foldLine(acc, assistantLine('2026-09-16T10:00:00.000Z', `m-${String(reason)}`, { output_tokens: 1 }, reason));
    assert.equal(acc.finished, false, String(reason));
  }
});

test('foldLine: timestamps — the first line starts it, every line moves the last', () => {
  const acc = newFold();
  foldLine(acc, userLine('2026-09-16T10:00:00.000Z'));
  foldLine(acc, JSON.stringify({ type: 'attachment', timestamp: '2026-09-16T10:02:00.000Z' }));
  foldLine(acc, assistantLine('2026-09-16T10:03:00.000Z', 'm1', { output_tokens: 1 }));
  assert.equal(acc.firstAt, '2026-09-16T10:00:00.000Z');
  assert.equal(acc.lastAt, '2026-09-16T10:03:00.000Z');
  // An attachment says nothing about state.
  assert.equal(acc.finished, false);
});

test('foldLine: a timestamp that is not one leaves both stamps alone', () => {
  const acc = newFold();
  for (const bad of [undefined, null, 42, 'yesterday', '', 'x'.repeat(200), '9999-99-99T00:00:00Z']) {
    foldLine(acc, JSON.stringify({ type: 'user', timestamp: bad }));
  }
  assert.equal(acc.firstAt, '');
  assert.equal(acc.lastAt, '');
});

test('foldLine: a torn line, a blank line and a non-object are ordinary, not errors', () => {
  const acc = newFold();
  const before = { ...acc };
  for (const line of ['', '   ', '{"type":"assis', 'null', '"a string"', '[1,2,3]', '42', 'undefined']) {
    foldLine(acc, line);
  }
  assert.deepEqual({ ...acc }, before, 'nothing a broken line says is believed');
});

test('foldLine: every timestamp is re-formatted, never passed through', () => {
  const acc = newFold();
  // A legal but non-canonical stamp, and an offset: both come back as ISO-8601
  // UTC, so nothing a file wrote can reach the DOM as a "date".
  foldLine(acc, JSON.stringify({ type: 'user', timestamp: '2026-09-16T12:00:00+02:00' }));
  assert.equal(acc.firstAt, '2026-09-16T10:00:00.000Z');
});

// ---------------------------------------------------------------------------
// sameAgents
// ---------------------------------------------------------------------------

test('sameAgents: every field counts, and so does the order', () => {
  const a: SessionAgent = { id: 'ab', name: 'n', task: 't', startedAt: '2026-09-16T10:00:00.000Z', tokens: 1, state: 'running' };
  const b: SessionAgent = { id: 'cd', name: 'n', task: 't', startedAt: '2026-09-16T10:01:00.000Z', tokens: 1, state: 'running' };
  assert.equal(sameAgents([a, b], [a, b]), true);
  assert.equal(sameAgents([a, b], [b, a]), false, 'the order IS the table');
  assert.equal(sameAgents([a], [a, b]), false);
  assert.equal(sameAgents(undefined, undefined), true);
  assert.equal(sameAgents(undefined, []), false);
  for (const change of [
    { ...a, id: 'ff' },
    { ...a, name: 'other' },
    { ...a, task: 'other' },
    { ...a, startedAt: '2026-09-16T10:00:00.001Z' },
    { ...a, endedAt: '2026-09-16T10:00:00.001Z' },
    { ...a, tokens: 2 },
    { ...a, state: 'finished' as const },
  ]) {
    assert.equal(sameAgents([a], [change]), false, JSON.stringify(change));
  }
});

// ---------------------------------------------------------------------------
// AgentsWatcher
// ---------------------------------------------------------------------------

interface Seen {
  id: string;
  /** `report.agents`, kept as its own field so the B7 assertions read as before. */
  agents: SessionAgent[];
  report: AgentsReport;
}

interface Harness {
  root: string;
  dir: string;
  seen: Seen[];
  logs: string[];
  watcher: AgentsWatcher;
  cleanup: () => Promise<void>;
}

/** A watcher over a real `<root>/<slug>/<uuid>/subagents` directory. */
async function makeWatcher(
  opts: { now?: () => number; create?: boolean; readBudgetBytes?: number } = {},
): Promise<Harness> {
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'ai-sm-agentw-')));
  const dir = join(root, '-slug', UUID, 'subagents');
  if (opts.create !== false) await mkdir(dir, { recursive: true });
  const seen: Seen[] = [];
  const logs: string[] = [];
  const watcher = new AgentsWatcher((level, message) => logs.push(`${level}: ${message}`), {
    projectsRoot: root,
    pollMs: 20,
    ...(opts.now === undefined ? {} : { now: opts.now }),
    ...(opts.readBudgetBytes === undefined ? {} : { readBudgetBytes: opts.readBudgetBytes }),
  });
  return {
    root,
    dir,
    seen,
    logs,
    watcher,
    cleanup: async (): Promise<void> => {
      watcher.stop();
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** Write an `agent-<id>.meta.json`, optionally with a pinned mtime (whole seconds). */
async function writeMeta(dir: string, id: string, body: unknown, mtimeS?: number): Promise<void> {
  const file = join(dir, `agent-${id}.meta.json`);
  await writeFile(file, typeof body === 'string' ? body : JSON.stringify(body), { mode: 0o644 });
  if (mtimeS !== undefined) await utimes(file, mtimeS, mtimeS);
}

/** Append lines to an `agent-<id>.jsonl`, creating it if needed. */
async function appendLines(dir: string, id: string, lines: string[]): Promise<void> {
  await appendFile(join(dir, `agent-${id}.jsonl`), lines.map((l) => `${l}\n`).join(''), { mode: 0o600 });
}

/** Wait until `seen`'s last list satisfies `ok`, or fail after `ms`. */
async function waitFor(seen: Seen[], ok: (agents: SessionAgent[]) => boolean, ms = 5_000): Promise<SessionAgent[]> {
  const deadline = Date.now() + ms;
  for (;;) {
    const last = seen[seen.length - 1]?.agents;
    if (last !== undefined && ok(last)) return last;
    if (Date.now() >= deadline) {
      throw new Error(`timed out; ${seen.length} call(s), last = ${JSON.stringify(seen[seen.length - 1])}`);
    }
    await delay(10);
  }
}

/** Wait until `seen`'s last REPORT satisfies `ok`, or fail after `ms`. */
async function waitForReport(seen: Seen[], ok: (report: AgentsReport) => boolean, ms = 5_000): Promise<AgentsReport> {
  const deadline = Date.now() + ms;
  for (;;) {
    const last = seen[seen.length - 1]?.report;
    if (last !== undefined && ok(last)) return last;
    if (Date.now() >= deadline) {
      throw new Error(`timed out; ${seen.length} call(s), last = ${JSON.stringify(seen[seen.length - 1]?.report)}`);
    }
    await delay(10);
  }
}

test('watcher: a meta with no transcript yet is a RUNNING row started at the meta mtime', async () => {
  const w = await makeWatcher();
  try {
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    await writeMeta(w.dir, 'a0053196a4ba8146d', {
      agentType: 'test-engineer',
      description: 'Test gate B2 Brief B (lean)',
      toolUseId: 'toolu_019YPEzehde7kJMZHpGpYP4s',
      spawnDepth: 1,
      requestShape: 'background',
      requestNonInteractive: true,
      model: 'opus',
    }, NOW_S);
    w.watcher.track('sess-1', w.dir);
    const rows = await waitFor(w.seen, (a) => a.length === 1);
    assert.equal(w.seen[0]?.id, 'sess-1');
    assert.deepEqual(rows, [
      {
        id: 'a0053196a4ba8146d',
        name: 'test-engineer',
        task: 'Test gate B2 Brief B (lean)',
        // The meta's mtime, NOT "now" — the honesty rule.
        startedAt: new Date(NOW_S * 1_000).toISOString(),
        tokens: 0,
        state: 'running',
      },
    ]);
  } finally {
    await w.cleanup();
  }
});

test('watcher: the transcript is read INCREMENTALLY as it grows, and the row follows', async () => {
  const w = await makeWatcher();
  try {
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    await writeMeta(w.dir, 'ff01', { agentType: 'backend-pty', description: 'B7' });
    await appendLines(w.dir, 'ff01', [
      userLine('2026-09-16T10:00:00.000Z'),
      assistantLine('2026-09-16T10:00:10.000Z', 'm1', { input_tokens: 100, output_tokens: 20 }),
    ]);
    w.watcher.track('sess-1', w.dir);
    let rows = await waitFor(w.seen, (a) => a[0]?.tokens === 120);
    assert.equal(rows[0]?.state, 'running');
    assert.equal(rows[0]?.startedAt, '2026-09-16T10:00:00.000Z', 'the FIRST line, not the meta mtime');

    // Appending more only reads the new bytes; the old ones are not re-folded.
    await appendLines(w.dir, 'ff01', [
      assistantLine('2026-09-16T10:00:20.000Z', 'm2', { input_tokens: 1, output_tokens: 9 }),
      assistantLine('2026-09-16T10:00:21.000Z', 'm3', { output_tokens: 30 }, 'end_turn'),
    ]);
    rows = await waitFor(w.seen, (a) => a[0]?.state === 'finished');
    assert.equal(rows[0]?.tokens, 160, 'nothing was counted twice');
    assert.equal(rows[0]?.endedAt, '2026-09-16T10:00:21.000Z');
  } finally {
    await w.cleanup();
  }
});

test('watcher: a line split across two polls is folded once, when it is complete', async () => {
  const w = await makeWatcher();
  try {
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    await writeMeta(w.dir, 'ff02', { agentType: 'a', description: 'b' });
    const line = assistantLine('2026-09-16T10:00:00.000Z', 'm1', { output_tokens: 42 });
    const cut = Math.floor(line.length / 2);
    // Half a line: a real transcript being appended to looks exactly like this.
    await appendFile(join(w.dir, 'agent-ff02.jsonl'), line.slice(0, cut));
    w.watcher.track('sess-1', w.dir);
    await waitFor(w.seen, (a) => a.length === 1);
    assert.equal(w.seen[w.seen.length - 1]?.agents[0]?.tokens, 0, 'half a line is not a message');
    await appendFile(join(w.dir, 'agent-ff02.jsonl'), `${line.slice(cut)}\n`);
    const rows = await waitFor(w.seen, (a) => a[0]?.tokens === 42);
    assert.equal(rows[0]?.tokens, 42);
  } finally {
    await w.cleanup();
  }
});

test('watcher: a transcript that SHRANK is re-read from 0 with its counters reset', async () => {
  const w = await makeWatcher();
  try {
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    await writeMeta(w.dir, 'ff03', { agentType: 'a', description: 'b' });
    await appendLines(w.dir, 'ff03', [
      userLine('2026-09-16T10:00:00.000Z'),
      assistantLine('2026-09-16T10:00:01.000Z', 'm1', { output_tokens: 500 }),
    ]);
    w.watcher.track('sess-1', w.dir);
    await waitFor(w.seen, (a) => a[0]?.tokens === 500);

    // Truncated and rewritten with something smaller.
    await truncate(join(w.dir, 'agent-ff03.jsonl'), 0);
    await appendLines(w.dir, 'ff03', [assistantLine('2026-09-16T11:00:00.000Z', 'm9', { output_tokens: 7 })]);
    const rows = await waitFor(w.seen, (a) => a[0]?.tokens === 7);
    assert.equal(rows[0]?.tokens, 7, 'the old file is gone, and so is what it said');
    assert.equal(rows[0]?.startedAt, '2026-09-16T11:00:00.000Z');
  } finally {
    await w.cleanup();
  }
});

test('watcher: a running agent untouched for 15 minutes is finished, at its OWN last stamp', async () => {
  // A killed agent (TaskStop, a usage-limit abort) leaves no end marker. The
  // clock is pinned so the rule is exercised without waiting for it.
  const pinned = Date.now() + STALE_MS + 60_000;
  const w = await makeWatcher({ now: () => pinned });
  try {
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    await writeMeta(w.dir, 'ff04', { agentType: 'security-auditor', description: 'review' }, 1_758_000_000);
    await appendLines(w.dir, 'ff04', [
      userLine('2026-09-16T10:00:00.000Z'),
      assistantLine('2026-09-16T10:04:00.000Z', 'm1', { output_tokens: 9 }), // no end_turn
    ]);
    w.watcher.track('sess-1', w.dir);
    const rows = await waitFor(w.seen, (a) => a.length === 1);
    assert.equal(rows[0]?.state, 'finished');
    assert.equal(rows[0]?.endedAt, '2026-09-16T10:04:00.000Z', 'the last line it wrote, never the clock');
    assert.equal(rows[0]?.startedAt, '2026-09-16T10:00:00.000Z');
  } finally {
    await w.cleanup();
  }
});

test('watcher: a stale meta with no transcript at all ends where it started', async () => {
  const pinned = Date.now() + STALE_MS + 60_000;
  const w = await makeWatcher({ now: () => pinned });
  try {
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    await writeMeta(w.dir, 'ff05', { agentType: 'a', description: 'b' }, 1_758_000_000);
    w.watcher.track('sess-1', w.dir);
    const rows = await waitFor(w.seen, (a) => a.length === 1);
    const iso = new Date(1_758_000_000_000).toISOString();
    assert.deepEqual(rows, [
      { id: 'ff05', name: 'a', task: 'b', startedAt: iso, endedAt: iso, tokens: 0, state: 'finished' },
    ]);
  } finally {
    await w.cleanup();
  }
});

test('watcher: a live agent just under the stale line is still running', async () => {
  const pinned = Date.now() + STALE_MS - 60_000;
  const w = await makeWatcher({ now: () => pinned });
  try {
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    await writeMeta(w.dir, 'ff06', { agentType: 'a', description: 'b' });
    await appendLines(w.dir, 'ff06', [userLine('2026-09-16T10:00:00.000Z')]);
    w.watcher.track('sess-1', w.dir);
    const rows = await waitFor(w.seen, (a) => a.length === 1);
    assert.equal(rows[0]?.state, 'running');
    assert.equal('endedAt' in (rows[0] as object), false, 'a running row carries no end');
  } finally {
    await w.cleanup();
  }
});

test('watcher: EXACTLY 15 minutes of silence is still running — the rule is strictly past it', async () => {
  // The stale rule is `now - lastActivity > STALE_MS`, not `>=`: a tool call
  // that takes the full ten minutes Claude Code allows must never turn a live
  // agent's dot grey, so the boundary second itself belongs to the living.
  const metaS = 1_758_000_000;
  const pinned = metaS * 1_000 + STALE_MS; // exactly the cap, to the millisecond
  const w = await makeWatcher({ now: () => pinned });
  try {
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    await writeMeta(w.dir, 'ff07', { agentType: 'a', description: 'b' }, metaS);
    w.watcher.track('sess-1', w.dir);
    const rows = await waitFor(w.seen, (a) => a.length === 1);
    assert.equal(rows[0]?.state, 'running', 'at exactly STALE_MS it is not stale yet');

    // One millisecond later it is, and that is the other side of the same line.
    const w2 = await makeWatcher({ now: () => pinned + 1 });
    try {
      w2.watcher.start((id, report) => w2.seen.push({ id, agents: report.agents, report }));
      await writeMeta(w2.dir, 'ff07', { agentType: 'a', description: 'b' }, metaS);
      w2.watcher.track('sess-1', w2.dir);
      const later = await waitFor(w2.seen, (a) => a.length === 1);
      assert.equal(later[0]?.state, 'finished');
    } finally {
      await w2.cleanup();
    }
  } finally {
    await w.cleanup();
  }
});

test('watcher: with nothing running, ONE finished row is sent — the most recent — and the count has them all', async () => {
  // B11 (d): at most one finished row, the latest `endedAt`; every finished
  // agent is in counts.finished, so the frontend draws `+4 finished`.
  const w = await makeWatcher();
  try {
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    for (let i = 0; i < 5; i++) {
      const id = `d${i}`;
      await writeMeta(w.dir, id, { agentType: `fin-${i}`, description: '' });
      await appendLines(w.dir, id, [
        userLine('2026-09-16T09:00:00.000Z'),
        assistantLine(`2026-09-16T11:0${i}:00.000Z`, `m${i}`, { output_tokens: 1 }, 'end_turn'),
      ]);
    }
    w.watcher.track('sess-1', w.dir);
    await waitFor(w.seen, (a) => a.length === 1 && a[0]?.state === 'finished');
    await waitForReport(w.seen, (r) => r.counts.finished === 5);
    // A few polls of settling time: nothing more may arrive.
    await delay(120);
    const last = w.seen[w.seen.length - 1]?.report as AgentsReport;
    assert.deepEqual(last.agents.map((r) => r.name), ['fin-4'], `the freshest result only; got ${JSON.stringify(last)}`);
    assert.deepEqual(last.counts, { running: 0, finished: 5 });
    assert.equal(
      w.seen.every((s) => s.agents.length <= 1),
      true,
      'no delivery ever carried more than one finished row',
    );
  } finally {
    await w.cleanup();
  }
});

test('watcher: a SYMLINK named like a transcript is refused, not followed', async () => {
  // The meta's twin (a symlinked meta is already pinned above): a transcript
  // is opened O_NOFOLLOW too, so a link planted over `agent-<id>.jsonl` cannot
  // turn the watcher into a reader of any file this user owns.
  const w = await makeWatcher();
  try {
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    const bait = join(w.root, 'not-a-transcript.jsonl');
    await writeFile(
      bait,
      `${userLine('2026-09-16T10:00:00.000Z')}\n${assistantLine('2026-09-16T10:01:00.000Z', 'm1', { output_tokens: 999 }, 'end_turn')}\n`,
      { mode: 0o600 },
    );
    await writeMeta(w.dir, 'ea', { agentType: 'link-victim', description: '' }, NOW_S);
    await symlink(bait, join(w.dir, 'agent-ea.jsonl'));
    w.watcher.track('sess-1', w.dir);
    const rows = await waitFor(w.seen, (a) => a.length === 1);
    assert.equal(rows[0]?.name, 'link-victim');
    assert.equal(rows[0]?.tokens, 0, 'the linked file was never read');
    assert.equal(rows[0]?.state, 'running');
    assert.equal(rows[0]?.startedAt, new Date(NOW_S * 1_000).toISOString(), 'the meta mtime, not the bait');
    // And it stays that way over the next polls: the refusal is not a race.
    await delay(120);
    const last = w.seen[w.seen.length - 1]?.agents as SessionAgent[];
    assert.equal(last[0]?.tokens, 0);
    assert.equal(last[0]?.state, 'running');
  } finally {
    await w.cleanup();
  }
});

test('watcher: a DIRECTORY named like a meta makes no row at all', async () => {
  // readdir gives names, not kinds: without the isFile() check a directory
  // called `agent-<hex>.meta.json` would invent a whole agent that never ran.
  const w = await makeWatcher();
  try {
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    await mkdir(join(w.dir, 'agent-dd.meta.json'), { recursive: true });
    await writeMeta(w.dir, 'ab', { agentType: 'real-one', description: '' }, NOW_S);
    w.watcher.track('sess-1', w.dir);
    const rows = await waitFor(w.seen, (a) => a.length >= 1);
    await delay(120);
    const last = w.seen[w.seen.length - 1]?.agents as SessionAgent[];
    assert.equal(last.length, 1, `only the real agent; got ${JSON.stringify(last)}`);
    assert.equal(last[0]?.id, 'ab');
    assert.equal(rows.length, 1);
  } finally {
    await w.cleanup();
  }
});

test('watcher: five running + five finished → the four OLDEST running rows, no finished row, counts 5/5', async () => {
  const w = await makeWatcher();
  try {
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    // Five running, started 10:00, 10:01, … (the meta mtime does not decide the
    // order once there are lines: the FIRST line does).
    for (let i = 0; i < 5; i++) {
      const id = `b${i}`;
      await writeMeta(w.dir, id, { agentType: `run-${i}`, description: 'x' });
      await appendLines(w.dir, id, [userLine(`2026-09-16T10:0${i}:00.000Z`)]);
    }
    // Five finished, ending 11:00 … 11:04.
    for (let i = 0; i < 5; i++) {
      const id = `c${i}`;
      await writeMeta(w.dir, id, { agentType: `fin-${i}`, description: 'x' });
      await appendLines(w.dir, id, [
        userLine('2026-09-16T09:00:00.000Z'),
        assistantLine(`2026-09-16T11:0${i}:00.000Z`, `m${i}`, { output_tokens: 1 }, 'end_turn'),
      ]);
    }
    w.watcher.track('sess-1', w.dir);
    const report = await waitForReport(w.seen, (r) => r.counts.running === 5 && r.counts.finished === 5);
    assert.equal(report.agents.length, MAX_RUNNING_ROWS);
    assert.deepEqual(
      report.agents.map((r) => r.name),
      ['run-0', 'run-1', 'run-2', 'run-3'],
      'running oldest-first, first four; four run, so no finished row',
    );
  } finally {
    await w.cleanup();
  }
});

test(`watcher: at most ${MAX_AGENTS} agents are tracked, newest meta first`, async () => {
  const w = await makeWatcher();
  try {
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    // 70 metas with strictly increasing mtimes: the 6 oldest fall off the
    // MAX_AGENTS window, so the oldest row is the 7th-oldest meta.
    // All within the last two minutes, so nothing is stale; strictly
    // increasing, so "newest meta first" has one answer.
    const base = NOW_S - 100;
    for (let i = 0; i < 70; i++) {
      await writeMeta(w.dir, `d${i.toString(16).padStart(2, '0')}`, { agentType: `a${i}`, description: '' }, base + i);
    }
    w.watcher.track('sess-1', w.dir);
    const report = await waitForReport(w.seen, (r) => r.counts.running === MAX_AGENTS);
    assert.deepEqual(
      report.agents.map((r) => r.name),
      ['a6', 'a7', 'a8', 'a9'],
      'a0-a5 were never tracked; the rest are the oldest of those that were',
    );
    // The count covers the TRACKED agents only: the six beyond MAX_AGENTS are
    // beyond both the list and the count.
    assert.deepEqual(report.counts, { running: MAX_AGENTS, finished: 0 });
  } finally {
    await w.cleanup();
  }
});

test('watcher: a file that is not `agent-<hex>.meta.json` is never opened', async () => {
  const w = await makeWatcher();
  try {
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    for (const name of [
      'agent-.meta.json',
      'agent-XYZ.meta.json', // not lowercase hex
      'agent-a0.meta.json.bak',
      'agent-a0.json',
      `agent-${'a'.repeat(33)}.meta.json`, // past the 32-character cap
      'meta.json',
      'notes.txt',
      '..meta.json',
    ]) {
      await writeFile(join(w.dir, name), JSON.stringify({ agentType: 'planted', description: 'planted' }));
    }
    await writeMeta(w.dir, 'ab', { agentType: 'real', description: '' });
    w.watcher.track('sess-1', w.dir);
    const rows = await waitFor(w.seen, (a) => a.length >= 1);
    assert.deepEqual(rows.map((r) => r.name), ['real']);
  } finally {
    await w.cleanup();
  }
});

test('watcher: a SYMLINK named like a meta is refused, and the row keeps the honest fallback', async () => {
  const w = await makeWatcher();
  try {
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    const secret = join(w.root, 'secret.json');
    await writeFile(secret, JSON.stringify({ agentType: 'stolen', description: 'from outside the directory' }));
    await symlink(secret, join(w.dir, 'agent-ac.meta.json'));
    w.watcher.track('sess-1', w.dir);
    const rows = await waitFor(w.seen, (a) => a.length === 1);
    assert.deepEqual(rows[0]?.name, 'agent', 'O_NOFOLLOW: nothing from the link target reaches the row');
    assert.equal(rows[0]?.task, '');
  } finally {
    await w.cleanup();
  }
});

test('watcher: a FIFO named like a transcript never blocks the poll', async () => {
  const w = await makeWatcher();
  try {
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    await writeMeta(w.dir, 'ad', { agentType: 'fifo-victim', description: '' });
    execFileSync('mkfifo', [join(w.dir, 'agent-ad.jsonl')]);
    w.watcher.track('sess-1', w.dir);
    // If the FIFO were opened and read, this would never come back.
    const rows = await waitFor(w.seen, (a) => a.length === 1, 3_000);
    assert.equal(rows[0]?.name, 'fifo-victim');
    assert.equal(rows[0]?.tokens, 0);
  } finally {
    await w.cleanup();
  }
});

test('watcher: meta strings are control-stripped and capped at 64 / 120', async () => {
  const w = await makeWatcher();
  try {
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    await writeMeta(w.dir, 'ae', {
      agentType: `${ESC}[31mred${NUL}\n${'n'.repeat(200)}`,
      description: `${DEL}${'t'.repeat(300)}`,
    });
    w.watcher.track('sess-1', w.dir);
    const rows = await waitFor(w.seen, (a) => a.length === 1);
    const name = rows[0]?.name as string;
    const task = rows[0]?.task as string;
    assert.equal(name.length, 64);
    assert.equal(task.length, 120);
    assert.equal(/[\u0000-\u001F\u007F-\u009F]/.test(name), false, 'no ESC reaches a terminal or the DOM');
    assert.equal(/[\u0000-\u001F\u007F-\u009F]/.test(task), false);
    assert.equal(name.startsWith('[31mred'), true, 'the ESC became a space, the text stayed');
  } finally {
    await w.cleanup();
  }
});

test('watcher: a meta that is not JSON, or has no agentType, still makes an honest row', async () => {
  const w = await makeWatcher();
  try {
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    await writeMeta(w.dir, 'b1', 'not json at all');
    await writeMeta(w.dir, 'b2', { model: 'opus' }); // no agentType, no description
    await writeMeta(w.dir, 'b3', { agentType: 42, description: ['x'] }); // wrong types
    await writeMeta(w.dir, 'b4', `{"agentType":"big","description":"${'x'.repeat(9_000)}"}`); // over 8 KiB
    w.watcher.track('sess-1', w.dir);
    const rows = await waitFor(w.seen, (a) => a.length === 4);
    for (const row of rows) {
      assert.equal(row.name, 'agent', `${row.id}: the fallback, never a guess`);
      assert.equal(row.task, '');
    }
  } finally {
    await w.cleanup();
  }
});

test('watcher: the TAIL of a dropped over-long line is never parsed as a line of its own', async () => {
  // A line that is still unterminated when the poll ends and is already past
  // MAX_LINE is given up on, and reading RESYNCS at the next newline. Without
  // that resync the remainder of the abandoned line arrives as a "line" of its
  // own on the next poll — and a planted transcript can make that remainder
  // valid JSON, which is how a discarded line would put numbers on the wire.
  const w = await makeWatcher();
  try {
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    await writeMeta(w.dir, 'fe', { agentType: 'resync', description: '' }, NOW_S);
    // 1.2 MiB with no newline yet: past MAX_LINE, so the carry is dropped.
    await appendFile(join(w.dir, 'agent-fe.jsonl'), 'x'.repeat(1_200_000), { mode: 0o600 });
    w.watcher.track('sess-1', w.dir);
    await waitFor(w.seen, (a) => a.length === 1);

    // The rest of that same line is a complete assistant message, followed by
    // a real line. Only the real one may be believed.
    const ghost = assistantLine('2026-09-16T09:00:00.000Z', 'ghost', { output_tokens: 777 }, 'end_turn');
    await appendFile(join(w.dir, 'agent-fe.jsonl'), `${ghost}\n${userLine('2026-09-16T10:00:00.000Z')}\n`);
    const rows = await waitFor(w.seen, (a) => a[0]?.startedAt === '2026-09-16T10:00:00.000Z');
    assert.equal(rows[0]?.tokens, 0, 'the tail of the dropped line was not a message');
    assert.equal(rows[0]?.state, 'running', 'and its end_turn never counted');
  } finally {
    await w.cleanup();
  }
});

test('watcher: an agentType that CLEANS to nothing falls back to `agent`', async () => {
  // Not the same case as a MISSING agentType: this meta carries a string, and
  // it survives clean() as ''. An empty name is not a name to draw, so the row
  // must show the honest placeholder rather than a blank cell.
  const w = await makeWatcher();
  try {
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    await writeMeta(w.dir, 'c1', { agentType: `${ESC}${NUL}${DEL}   \n\t`, description: 'still a task' });
    w.watcher.track('sess-1', w.dir);
    const rows = await waitFor(w.seen, (a) => a.length === 1);
    assert.equal(rows[0]?.name, 'agent');
    assert.equal(rows[0]?.task, 'still a task', 'the description was there and is kept');
  } finally {
    await w.cleanup();
  }
});

test('watcher: a task longer than 120 characters is CAPPED, not dropped', async () => {
  const w = await makeWatcher();
  try {
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    await writeMeta(w.dir, 'c2', { agentType: 'x'.repeat(65), description: `${'t'.repeat(121)}TAIL` });
    w.watcher.track('sess-1', w.dir);
    const rows = await waitFor(w.seen, (a) => a.length === 1);
    assert.equal(rows[0]?.task, 't'.repeat(120), 'the first 120 characters, and nothing after them');
    assert.equal(rows[0]?.name, 'x'.repeat(64));
  } finally {
    await w.cleanup();
  }
});

test('watcher: equal stamps are broken by id, so the order is stable both halves', async () => {
  // Two agents that started in the same millisecond (the orchestrator spawned
  // them in one turn) must not swap places between polls: the table would
  // flicker and every poll would broadcast a "change".
  const w = await makeWatcher();
  try {
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    // The meta mtimes run the OTHER way round, so the order below can only
    // come from the id tie-break: without it a stable sort leaves the agents
    // in the order the directory listing produced (newest meta first).
    let mtime = NOW_S - 1;
    for (const id of ['ff', 'a1', '0b']) {
      await writeMeta(w.dir, id, { agentType: `run-${id}`, description: '' }, mtime--);
      await appendLines(w.dir, id, [userLine('2026-09-16T10:00:00.000Z')]);
    }
    for (const id of ['ee', 'b2', '0c']) {
      await writeMeta(w.dir, id, { agentType: `fin-${id}`, description: '' }, mtime--);
      await appendLines(w.dir, id, [
        userLine('2026-09-16T09:00:00.000Z'),
        assistantLine('2026-09-16T11:00:00.000Z', `m-${id}`, { output_tokens: 1 }, 'end_turn'),
      ]);
    }
    w.watcher.track('sess-1', w.dir);
    const report = await waitForReport(w.seen, (r) => r.counts.running === 3 && r.counts.finished === 3);
    assert.deepEqual(
      report.agents.map((r) => r.id),
      ['0b', 'a1', 'ff', '0c'],
      'running first (ids ascending on a tie), then the one finished row (ids ascending on a tie)',
    );
  } finally {
    await w.cleanup();
  }
});

test('watcher: a line past 1 MiB is skipped unparsed and reading resyncs at the next one', async () => {
  const w = await makeWatcher();
  try {
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    await writeMeta(w.dir, 'b5', { agentType: 'a', description: '' });
    const huge = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-09-16T10:00:00.000Z',
      message: { id: 'huge', stop_reason: 'end_turn', usage: { output_tokens: 999_999 }, pad: 'x'.repeat(MAX_LINE + 1) },
    });
    await appendLines(w.dir, 'b5', [huge, assistantLine('2026-09-16T10:01:00.000Z', 'small', { output_tokens: 3 })]);
    w.watcher.track('sess-1', w.dir);
    const rows = await waitFor(w.seen, (a) => a[0]?.tokens === 3);
    assert.equal(rows[0]?.tokens, 3, 'the over-long line contributed nothing');
    assert.equal(rows[0]?.state, 'running', 'and its end_turn was never read');
  } finally {
    await w.cleanup();
  }
});

test('watcher: no directory, no agents, no callback — an empty table is never announced', async () => {
  const w = await makeWatcher({ create: false });
  try {
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    w.watcher.track('sess-1', w.dir); // Claude Code has not created it yet.
    await delay(200);
    // B11: no agent table is announced — but the session's own transcript is
    // not there either (its slug folder is still PENDING, B11 F1), so it sits
    // at its first prompt: ONE turn-only report, not a single agent row.
    const turnOnly = [{ agents: [], counts: { running: 0, finished: 0 }, turn: 'waiting' }];
    assert.deepEqual(w.seen.map((s) => s.report), turnOnly);
    // And an existing but empty directory is the same: nothing new to say.
    await mkdir(w.dir, { recursive: true });
    await delay(200);
    assert.deepEqual(w.seen.map((s) => s.report), turnOnly);
  } finally {
    await w.cleanup();
  }
});

test('watcher: an unchanged list is delivered exactly once', async () => {
  const w = await makeWatcher();
  try {
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    await writeMeta(w.dir, 'b6', { agentType: 'a', description: 'b' });
    await appendLines(w.dir, 'b6', [assistantLine('2026-09-16T10:00:00.000Z', 'm1', { output_tokens: 1 }, 'end_turn')]);
    w.watcher.track('sess-1', w.dir);
    await waitFor(w.seen, (a) => a.length === 1);
    await delay(200); // ~10 more polls over an unchanged directory.
    assert.equal(w.seen.length, 1, 'one broadcast per real change, and none for a re-read');
  } finally {
    await w.cleanup();
  }
});

test('watcher: untrack() stops this session and leaves the others polling', async () => {
  const w = await makeWatcher();
  try {
    const second = join(w.root, '-slug', OTHER_UUID, 'subagents');
    await mkdir(second, { recursive: true });
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    await writeMeta(w.dir, 'b7', { agentType: 'one', description: '' });
    await writeMeta(second, 'b8', { agentType: 'two', description: '' });
    w.watcher.track('sess-1', w.dir);
    w.watcher.track('sess-2', second);
    await waitFor(w.seen, () => w.seen.some((s) => s.id === 'sess-1') && w.seen.some((s) => s.id === 'sess-2'));
    assert.equal(w.watcher.trackedCount, 2);

    w.watcher.untrack('sess-1');
    assert.equal(w.watcher.trackedCount, 1);
    const before = w.seen.filter((s) => s.id === 'sess-1').length;
    await writeMeta(w.dir, 'b9', { agentType: 'late', description: '' });
    await writeMeta(second, 'ba', { agentType: 'also late', description: '' });
    await waitFor(w.seen, () => w.seen.filter((s) => s.id === 'sess-2').length >= 2);
    assert.equal(w.seen.filter((s) => s.id === 'sess-1').length, before, 'the untracked session says nothing more');
    // untrack() on a session that was never tracked is a no-op, not an error.
    w.watcher.untrack('sess-does-not-exist');
  } finally {
    await w.cleanup();
  }
});

test('watcher: track() with the SAME directory keeps the offsets; another one replaces the state', async () => {
  const w = await makeWatcher();
  try {
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    await writeMeta(w.dir, 'bb', { agentType: 'first', description: '' });
    w.watcher.track('sess-1', w.dir);
    await waitFor(w.seen, (a) => a.length === 1);
    const calls = w.seen.length;
    w.watcher.track('sess-1', w.dir); // The status line reports the same path every turn.
    await delay(200);
    assert.equal(w.seen.length, calls, 'the same path is a no-op, not a re-read');

    // A resumed conversation reports a DIFFERENT transcript: fresh state.
    const second = join(w.root, '-slug', OTHER_UUID, 'subagents');
    await mkdir(second, { recursive: true });
    await writeMeta(second, 'bc', { agentType: 'second', description: '' });
    w.watcher.track('sess-1', second);
    const rows = await waitFor(w.seen, (a) => a[0]?.name === 'second');
    assert.deepEqual(rows.map((r) => r.id), ['bc'], 'nothing from the old directory survived');
  } finally {
    await w.cleanup();
  }
});

test('watcher: stop() detaches, is idempotent, and forgets every tracked session', async () => {
  const w = await makeWatcher();
  try {
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    await writeMeta(w.dir, 'bd', { agentType: 'a', description: '' });
    w.watcher.track('sess-1', w.dir);
    await waitFor(w.seen, (a) => a.length === 1);

    w.watcher.stop();
    w.watcher.stop(); // Idempotent: the shutdown path can reach it twice.
    assert.equal(w.watcher.trackedCount, 0);
    const calls = w.seen.length;
    await writeMeta(w.dir, 'be', { agentType: 'late', description: '' });
    await delay(200);
    assert.equal(w.seen.length, calls, 'nothing is delivered after stop()');
    // track() after stop() is refused rather than silently queued.
    w.watcher.track('sess-2', w.dir);
    assert.equal(w.watcher.trackedCount, 0);
  } finally {
    await w.cleanup();
  }
});

test('watcher: a consumer that throws does not take the poll down', async () => {
  const w = await makeWatcher();
  try {
    let calls = 0;
    w.watcher.start((id, report) => {
      calls++;
      w.seen.push({ id, agents: report.agents, report });
      if (calls === 1) throw new Error('consumer exploded');
    });
    await writeMeta(w.dir, 'bf', { agentType: 'a', description: '' });
    w.watcher.track('sess-1', w.dir);
    await waitFor(w.seen, (a) => a.length === 1);
    await writeMeta(w.dir, 'c0', { agentType: 'b', description: '' });
    const rows = await waitFor(w.seen, (a) => a.length === 2);
    assert.equal(rows.length, 2, 'the second change still arrived');
    assert.equal(
      w.logs.some((l) => l.startsWith('warn: ') && l.includes('consumer threw')),
      true,
      w.logs.join('\n'),
    );
  } finally {
    await w.cleanup();
  }
});

test('watcher: a directory that disappears mid-flight is a skipped poll, not a crash', async () => {
  const w = await makeWatcher();
  try {
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    await writeMeta(w.dir, 'c1', { agentType: 'a', description: '' });
    w.watcher.track('sess-1', w.dir);
    await waitFor(w.seen, (a) => a.length === 1);
    const calls = w.seen.length;
    const rows = w.seen[w.seen.length - 1]?.agents;
    await rm(join(w.root, '-slug'), { recursive: true, force: true });
    await delay(200);
    // The last list stands — what those agents cost is still true. (B11: the
    // transcript's parent is gone too, so the turn becomes unknown: that is the
    // one delivery allowed, and it carries the same rows.)
    assert.equal(w.seen.length <= calls + 1, true, `${w.seen.length - calls} extra deliveries`);
    for (const s of w.seen.slice(calls)) {
      assert.deepEqual(s.agents, rows);
      assert.equal(s.report.turn, undefined);
    }
    assert.equal(w.watcher.trackedCount, 1, 'still tracked: the directory may come back');
  } finally {
    await w.cleanup();
  }
});

// ---------------------------------------------------------------------------
// The boundary, RE-CHECKED: the components appended after subagentsDirFor()
// ---------------------------------------------------------------------------

test('watcher: a symlink at the <uuid> component is refused on every poll, not followed', async () => {
  // subagentsDirFor() realpaths the TRANSCRIPT's directory only; `<uuid>` and
  // `subagents` are appended after it, and readdir/stat follow every component
  // (O_NOFOLLOW guards the final file, not the path to it). Without the
  // per-poll re-check this delivered a meta file from outside the root.
  const base = realpathSync(await mkdtemp(join(tmpdir(), 'ai-sm-agentsym-')));
  const root = join(base, 'projects');
  const slug = join(root, '-slug');
  const outside = join(base, 'outside');
  await mkdir(slug, { recursive: true });
  await mkdir(join(outside, 'subagents'), { recursive: true });
  await writeMeta(join(outside, 'subagents'), 'ab', { agentType: 'stolen', description: 'from outside' });
  await symlink(outside, join(slug, UUID));
  const logs: string[] = [];
  const seen: Seen[] = [];
  const watcher = new AgentsWatcher((level, message) => logs.push(`${level}: ${message}`), {
    projectsRoot: root,
    pollMs: 20,
  });
  try {
    watcher.start((id, report) => seen.push({ id, agents: report.agents, report }));
    watcher.track('sess-1', join(slug, UUID, 'subagents'));
    await delay(300); // ~15 polls.
    // B11: the session's own transcript (`<slug>/<uuid>.jsonl`, inside the
    // root) does not exist, so a turn-only 'waiting' report is expected — but
    // not one agent from outside.
    assert.equal(
      seen.every((s) => s.agents.length === 0 && s.report.counts.running + s.report.counts.finished === 0),
      true,
      `nothing from outside the root ever reaches a client; got ${JSON.stringify(seen)}`,
    );
    const refusals = logs.filter(
      (l) => l.startsWith('debug: ') && l.includes('resolves outside the projects root'),
    );
    // ONCE for the tracked directory, not once per 2 s poll: the check runs
    // forever while the session lives and would bury server.log.
    assert.equal(refusals.length, 1, logs.join('\n'));

    // The control: the same watcher reads a directory that really is inside.
    const honest = join(slug, OTHER_UUID, 'subagents');
    await mkdir(honest, { recursive: true });
    await writeMeta(honest, 'cd', { agentType: 'honest', description: '' });
    watcher.track('sess-2', honest);
    await waitFor(seen, (a) => a[0]?.name === 'honest');
  } finally {
    watcher.stop();
    await rm(base, { recursive: true, force: true });
  }
});

test('watcher: a path in a log line can never forge one', async () => {
  const w = await makeWatcher({ create: false });
  try {
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    // A directory name carrying a newline and an ESC: legal on Linux, and it
    // reaches server.log verbatim without oneLine().
    const nasty = join(w.root, `-slug\n2026-01-01T00:00:00.000Z [error] forged${ESC}[31m`, UUID, 'subagents');
    w.watcher.track('sess-1', nasty);
    assert.equal(w.logs.length >= 1, true);
    for (const line of w.logs) {
      assert.equal(/[\u0000-\u001F\u007F-\u009F]/.test(line), false, JSON.stringify(line));
    }
    assert.equal(w.logs.some((l) => l.includes('tracking')), true, w.logs.join(' | '));
  } finally {
    await w.cleanup();
  }
});

// ---------------------------------------------------------------------------
// The per-tick read budget
// ---------------------------------------------------------------------------

/** A transcript that starts with one counted message and is then padded to ~`mib` MiB. */
async function writePadded(dir: string, id: string, tokens: number, mib: number): Promise<void> {
  const head = `${assistantLine('2026-09-16T10:00:00.000Z', `m-${id}`, { output_tokens: tokens })}\n`;
  const pad = `${JSON.stringify({ type: 'attachment', pad: 'x'.repeat(1_000) })}\n`;
  const lines = [head];
  for (let written = head.length; written < mib * 1024 * 1024; written += pad.length) lines.push(pad);
  await writeFile(join(dir, `agent-${id}.jsonl`), lines.join(''), { mode: 0o600 });
}

/**
 * A transcript of EXACTLY `bytes` bytes whose last line is (or is not) the
 * `end_turn` that finishes the agent. The size is exact because the read caps
 * are byte counts: a file at the cap is read in one poll, one byte past it is
 * not.
 */
async function writeSized(dir: string, id: string, bytes: number, ending: 'end_turn' | 'open'): Promise<void> {
  const tail =
    ending === 'end_turn'
      ? `${assistantLine('2026-09-16T11:00:00.000Z', `m-${id}`, { output_tokens: 1 }, 'end_turn')}\n`
      : '';
  const pad = `${JSON.stringify({ type: 'attachment', pad: 'x'.repeat(1_000) })}\n`;
  const chunks: string[] = [];
  let size = tail.length;
  while (size + pad.length <= bytes) {
    chunks.push(pad);
    size += pad.length;
  }
  const rest = bytes - size;
  if (rest > 0) chunks.push(`${'x'.repeat(rest - 1)}\n`); // junk, skipped: not JSON
  chunks.push(tail);
  const text = chunks.join('');
  assert.equal(Buffer.byteLength(text), bytes, 'the fixture is exactly the size the cap is about');
  await writeFile(join(dir, `agent-${id}.jsonl`), text, { mode: 0o600 });
}

test('watcher: the REFUSAL log line cannot be forged either', async () => {
  // The twin of the tracking log above, at the other path that logs a path:
  // the directory refused for resolving outside the root. That string is the
  // one from the snapshot, so a newline in it would write a whole fake line
  // into server.log — and an ESC would repaint the terminal reading it.
  const base = realpathSync(await mkdtemp(join(tmpdir(), 'ai-sm-agentlog-')));
  const root = join(base, 'projects');
  const outside = join(base, 'outside');
  await mkdir(root, { recursive: true });
  await mkdir(join(outside, UUID, 'subagents'), { recursive: true });
  const nasty = `-slug\n2026-01-01T00:00:00.000Z [error] forged${ESC}[31m`;
  await symlink(outside, join(root, nasty));
  const logs: string[] = [];
  const seen: Seen[] = [];
  const watcher = new AgentsWatcher((level, message) => logs.push(`${level}: ${message}`), {
    projectsRoot: root,
    pollMs: 20,
  });
  try {
    watcher.start((id, report) => seen.push({ id, agents: report.agents, report }));
    watcher.track('sess-1', join(root, nasty, UUID, 'subagents'));
    await delay(120); // ~6 polls, each of which refuses and logs.
    assert.deepEqual(seen, [], 'nothing outside the root is ever delivered');
    assert.equal(
      logs.some((l) => l.includes('resolves outside the projects root')),
      true,
      logs.join(' | '),
    );
    for (const line of logs) {
      assert.equal(/[\u0000-\u001F\u007F-\u009F]/.test(line), false, JSON.stringify(line));
    }
  } finally {
    watcher.stop();
    await rm(base, { recursive: true, force: true });
  }
});

test('watcher: ONE file gives up at 4 MiB per poll, however much budget is left', async () => {
  // The per-file cap is what stops a planted 10 GB transcript from being read
  // into this process in one go. With the default (16 MiB) tick budget there
  // is room for all of this file, so only the per-file cap can hold it back:
  // the end marker sits past 4 MiB, so the FIRST list must still say running.
  const w = await makeWatcher();
  try {
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    await writeMeta(w.dir, 'fa', { agentType: 'big-talker', description: '' }, NOW_S);
    await writeSized(w.dir, 'fa', 4 * 1024 * 1024 + 64 * 1024, 'end_turn');
    w.watcher.track('sess-1', w.dir);

    const first = await waitFor(w.seen, (a) => a.length === 1);
    assert.equal(first[0]?.state, 'running', 'the first 4 MiB carried no end marker');
    assert.equal(w.seen[0]?.agents[0]?.state, 'running', 'and that was the FIRST thing said');
    // The remainder arrives on a later tick, and the marker with it.
    const later = await waitFor(w.seen, (a) => a[0]?.state === 'finished');
    assert.equal(later[0]?.endedAt, '2026-09-16T11:00:00.000Z');
  } finally {
    await w.cleanup();
  }
});

test('watcher: a line of exactly 1 MiB is parsed, one byte more is skipped', async () => {
  // MAX_LINE is a real boundary in both directions: a 120 KB tool result is an
  // ORDINARY transcript line and must be folded, while a line past the cap is
  // handed to nothing (JSON.parse on a megabyte of planted text is the cost
  // the cap exists to refuse). Pinned to the byte, so shrinking the cap is as
  // loud a change as removing it.
  const MiB = 1024 * 1024;
  /** An assistant line padded to exactly `bytes` bytes (the pad is plain ASCII). */
  const padded = (bytes: number, id: string, tokens: number): string => {
    const build = (pad: string): string =>
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-09-16T10:00:00.000Z',
        message: { id, stop_reason: 'tool_use', usage: { output_tokens: tokens }, pad },
      });
    const line = build('x'.repeat(bytes - build('').length));
    assert.equal(Buffer.byteLength(line), bytes, 'the fixture is exactly at the cap');
    return line;
  };
  const w = await makeWatcher();
  try {
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    await writeMeta(w.dir, 'fc', { agentType: 'long-liner', description: '' }, NOW_S);
    await appendLines(w.dir, 'fc', [
      padded(MiB, 'at-the-cap', 11),
      padded(MiB + 1, 'past-the-cap', 22),
      assistantLine('2026-09-16T10:05:00.000Z', 'done', { output_tokens: 0 }, 'end_turn'),
    ]);
    w.watcher.track('sess-1', w.dir);
    const rows = await waitFor(w.seen, (a) => a[0]?.state === 'finished');
    assert.equal(rows[0]?.tokens, 11, 'the 1 MiB line counted, the 1 MiB + 1 line did not');
  } finally {
    await w.cleanup();
  }
});

test('watcher: 4 MiB per poll is the cap TO THE BYTE', async () => {
  // A file of exactly 4 MiB + 1: the last byte is the newline that completes
  // the end marker, so a cap even one byte wider would finish the agent a poll
  // early — and a cap that wide is one that was not thought about.
  const w = await makeWatcher();
  try {
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    await writeMeta(w.dir, 'fd', { agentType: 'exact', description: '' }, NOW_S);
    await writeSized(w.dir, 'fd', 4 * 1024 * 1024 + 1, 'end_turn');
    w.watcher.track('sess-1', w.dir);
    await waitFor(w.seen, (a) => a.length === 1);
    assert.equal(w.seen[0]?.agents[0]?.state, 'running', 'the last byte was one byte too far');
    const later = await waitFor(w.seen, (a) => a[0]?.state === 'finished');
    assert.equal(later[0]?.endedAt, '2026-09-16T11:00:00.000Z');
  } finally {
    await w.cleanup();
  }
});

test('watcher: past 1024 meta names one poll stops scanning, and says so', async () => {
  // A planted directory with a million `agent-*.meta.json` entries must not
  // turn one tick into a million stat() calls on the thread that pumps every
  // PTY. The cap is a bound on syscalls, so the only honest witness is the
  // debug line that says the rest was ignored.
  const w = await makeWatcher();
  try {
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    const body = JSON.stringify({ agentType: 'flood', description: '' });
    for (let i = 0; i < 1_100; i++) {
      await writeFile(join(w.dir, `agent-${i.toString(16).padStart(5, '0')}.meta.json`), body, { mode: 0o644 });
    }
    w.watcher.track('sess-1', w.dir);
    await waitFor(w.seen, (a) => a.length > 0);
    assert.equal(
      w.logs.some((l) => l.includes('more than 1024 agent metas, rest ignored')),
      true,
      w.logs.join(' | '),
    );
    // And what it did deliver is still capped: four running rows, and the
    // count stops at the tracked cap.
    const last = w.seen[w.seen.length - 1]?.report as AgentsReport;
    assert.equal(last.agents.length, MAX_RUNNING_ROWS);
    assert.deepEqual(last.counts, { running: MAX_AGENTS, finished: 0 });
  } finally {
    await w.cleanup();
  }
});

test('watcher: the DEFAULT tick budget is 16 MiB — a fifth 4 MiB file waits for the next tick', async () => {
  // The same claim the explicit-budget test makes, but about the default the
  // server actually runs with: no readBudgetBytes here. Five agents, each with
  // a transcript exactly at the per-file cap, so four of them spend the whole
  // budget and the fifth is still untouched when the first list goes out.
  const w = await makeWatcher();
  try {
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    for (let i = 1; i <= 5; i++) {
      const id = `f${i}`;
      // Descending mtimes, so the order the files are offered the budget in is
      // f1 … f5 and not the directory's own.
      await writeMeta(w.dir, id, { agentType: `big-${i}`, description: '' }, NOW_S - i);
      await writeSized(w.dir, id, 4 * 1024 * 1024, 'end_turn');
    }
    w.watcher.track('sess-1', w.dir);
    await waitFor(w.seen, (a) => a.length > 0);
    const firstList = w.seen[0]?.agents as SessionAgent[];
    assert.equal(
      firstList.some((r) => r.state === 'running'),
      true,
      `one tick cannot read 20 MiB; first list was ${JSON.stringify(firstList)}`,
    );
    // And nothing is lost: every agent ends up finished, each counted once.
    const settled = await waitForReport(w.seen, (r) => r.counts.running === 0 && r.counts.finished === 5);
    assert.deepEqual(settled.agents.map((r) => r.tokens), [1]);
  } finally {
    await w.cleanup();
  }
});

test('watcher: one tick spends a GLOBAL byte budget — a big backlog is spread over ticks', async () => {
  // Without it, the first poll of a 30-agent session parses tens of MB of JSON
  // on the thread that pumps every PTY.
  const w = await makeWatcher({ readBudgetBytes: 1024 * 1024 });
  try {
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    // `e1` has the newer meta, so it is offered the budget first.
    await writeMeta(w.dir, 'e1', { agentType: 'first', description: '' }, NOW_S);
    await writeMeta(w.dir, 'e2', { agentType: 'second', description: '' }, NOW_S - 10);
    await writePadded(w.dir, 'e1', 111, 3);
    await writePadded(w.dir, 'e2', 222, 3);
    w.watcher.track('sess-1', w.dir);

    const byId = (rows: SessionAgent[], id: string): SessionAgent | undefined => rows.find((r) => r.id === id);
    // The first list already knows e1's opening message and nothing of e2's:
    // one tick could not read both files.
    const first = await waitFor(w.seen, (a) => byId(a, 'e1')?.tokens === 111);
    assert.equal(byId(first, 'e2')?.tokens, 0, 'the budget stopped before the second file');

    // And the rest arrives over the following ticks, counted exactly once.
    const later = await waitFor(w.seen, (a) => byId(a, 'e2')?.tokens === 222);
    assert.equal(byId(later, 'e1')?.tokens, 111, 'nothing was read twice');
    assert.equal(w.seen.length >= 2, true, `spread over ${w.seen.length} deliveries`);
  } finally {
    await w.cleanup();
  }
});

// ---------------------------------------------------------------------------
// The wiring: which sessions are polled, and where the root is
// ---------------------------------------------------------------------------

/**
 * Minimal stand-in for the `ws` socket: SessionManager only ever touches
 * readyState/OPEN, send() and on('close'). Every frame is kept, so "exactly
 * one broadcast per real change" is a countable claim.
 */
class FakeClient {
  readonly OPEN = 1;
  readonly readyState = 1;
  readonly frames: ServerMessage[] = [];
  send(raw: string): void {
    this.frames.push(JSON.parse(raw) as ServerMessage);
  }
  on(): void {}
  /** Every `info` frame's session. */
  infoFrames(): SessionInfo[] {
    return this.frames
      .filter((m): m is Extract<ServerMessage, { type: 'info' }> => m.type === 'info')
      .map((m) => m.session);
  }
  /** The `info` frames that actually carried an agent list. */
  agentFrames(): SessionInfo[] {
    return this.frames
      .filter((m): m is Extract<ServerMessage, { type: 'info' }> => m.type === 'info')
      .map((m) => m.session)
      .filter((s) => s.agents !== undefined);
  }
  asWs(): WebSocket {
    return this as unknown as WebSocket;
  }
}

/** A SessionManager on a temp dir, with the watcher the B7 wiring hands it. */
async function makeManager(): Promise<{
  manager: SessionManager;
  watcher: AgentsWatcher;
  logs: string[];
  root: string;
  cleanup: () => Promise<void>;
}> {
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'ai-sm-setagents-')));
  const logs: string[] = [];
  const log: Logger = (level, message) => logs.push(`${level}: ${message}`);
  const watcher = new AgentsWatcher(log, { projectsRoot: root, pollMs: 60_000 });
  const history = new SessionHistory(join(root, 'history.json'), log);
  history.load();
  const manager = new SessionManager(log, history, undefined, undefined, watcher);
  return {
    manager,
    watcher,
    logs,
    root,
    cleanup: async (): Promise<void> => {
      watcher.stop();
      manager.destroyAll();
      await rm(root, { recursive: true, force: true });
    },
  };
}

const ROW: SessionAgent = {
  id: 'aa',
  name: 'test-engineer',
  task: 'gate B7',
  startedAt: '2026-09-22T10:00:00.000Z',
  tokens: 12_400,
  state: 'running',
};

/** A report the way the watcher builds one: counts derived from the rows unless given. */
function report(agents: SessionAgent[], extra: { counts?: AgentsReport['counts']; turn?: AgentsReport['turn'] } = {}): AgentsReport {
  const counts = extra.counts ?? {
    running: agents.filter((a) => a.state === 'running').length,
    finished: agents.filter((a) => a.state === 'finished').length,
  };
  return { agents, counts, ...(extra.turn === undefined ? {} : { turn: extra.turn }) };
}

test('SessionManager.setReport: an unknown id is a silent no-op, and never creates a session', async () => {
  // A poll can land after the session was deleted, and a list of subagents is
  // not a session: the only trace is a debug line.
  const m = await makeManager();
  try {
    m.manager.setReport('no-such-session', report([ROW], { turn: 'working' }));
    assert.equal(m.manager.has('no-such-session'), false);
    assert.equal(m.manager.list().length, 0);
    assert.equal(
      m.logs.some((l) => l.includes('no-such-session agents ignored: no such session')),
      true,
      `the refusal is logged; logs were ${JSON.stringify(m.logs)}`,
    );
  } finally {
    await m.cleanup();
  }
});

test('SessionManager.setReport: one `info` broadcast per REAL change, carrying agents + agentCounts', async () => {
  const m = await makeManager();
  try {
    const info = m.manager.create({ command: 'bash', args: ['-c', 'sleep 30'], cwd: m.root, cols: 80, rows: 24 });
    const client = new FakeClient();
    assert.equal(m.manager.attach(info.id, client.asWs()), true);
    assert.equal(client.agentFrames().length, 0, 'the attach info carries no agents yet');
    const base = client.infoFrames().length;

    m.manager.setReport(info.id, report([ROW]));
    assert.equal(client.agentFrames().length, 1);
    assert.deepEqual(client.agentFrames()[0]?.agents, [ROW]);
    assert.deepEqual(client.agentFrames()[0]?.agentCounts, { running: 1, finished: 0 });
    // And the session itself holds it, for a client that attaches later.
    assert.deepEqual(m.manager.get(info.id)?.agents, [ROW]);

    // The same report again, as DIFFERENT objects with equal fields: what the
    // watcher delivers on every poll of an idle agent. Not news, not a frame.
    m.manager.setReport(info.id, report([{ ...ROW }]));
    assert.equal(client.infoFrames().length, base + 1, 'an unchanged report is not a broadcast');

    // One field moved: exactly one more frame.
    m.manager.setReport(info.id, report([{ ...ROW, tokens: 12_500 }]));
    assert.equal(client.agentFrames().length, 2);
    assert.equal(client.agentFrames()[1]?.agents?.[0]?.tokens, 12_500);

    // Only the COUNT moved (a sixth agent beyond the rows): a change too.
    m.manager.setReport(info.id, report([{ ...ROW, tokens: 12_500 }], { counts: { running: 5, finished: 0 } }));
    assert.equal(client.agentFrames().length, 3);
    assert.deepEqual(client.agentFrames()[2]?.agentCounts, { running: 5, finished: 0 });

    // Every agent went away: both fields go ABSENT (never an empty table) —
    // still one frame, not none.
    m.manager.setReport(info.id, report([]));
    assert.equal(client.infoFrames().length, base + 4);
    const cleared = client.infoFrames()[base + 3] as SessionInfo;
    assert.equal(cleared.agents, undefined);
    assert.equal(cleared.agentCounts, undefined);
    assert.equal('agents' in cleared, false, 'absent, not undefined-valued');

    m.manager.destroy(info.id);
  } finally {
    await m.cleanup();
  }
});

test('SessionManager.isLive: an id that was never a session is not live', async () => {
  // The index.ts callback asks this before tracking; an unknown id must be a
  // plain false, not a throw and not a truthy undefined.
  const m = await makeManager();
  try {
    assert.equal(m.manager.isLive('never-existed'), false);
    assert.equal(m.manager.has('never-existed'), false);
  } finally {
    await m.cleanup();
  }
});

test('SessionManager: destroy() untracks the session as well as the exit does', async () => {
  const m = await makeManager();
  try {
    const info = m.manager.create({ command: 'bash', args: ['-c', 'sleep 30'], cwd: m.root, cols: 80, rows: 24 });
    m.watcher.track(info.id, join(m.root, 'subagents'));
    assert.equal(m.watcher.trackedCount, 1);
    m.manager.destroy(info.id);
    assert.equal(m.watcher.trackedCount, 0, 'a deleted session is no longer polled');
  } finally {
    await m.cleanup();
  }
});

test('SessionManager: isLive is false for an EXITED session, which stays listed', async () => {
  // The B7 call site in server/index.ts gates agents.track() on this. has()
  // cannot answer it: a session stays listed after its PTY exits, so a
  // snapshot landing after onExit (a 150 ms debounce, or a 2 s poll) would
  // re-track a dead session and never untrack it again.
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'ai-sm-islive-')));
  const log: Logger = () => {};
  const watcher = new AgentsWatcher(log, { projectsRoot: root, pollMs: 60_000 });
  const history = new SessionHistory(join(root, 'history.json'), log);
  history.load();
  const manager = new SessionManager(log, history, undefined, undefined, watcher);
  try {
    const info = manager.create({ command: 'bash', args: ['-c', 'exit 0'], cwd: root, cols: 80, rows: 24 });
    assert.equal(manager.isLive(info.id), true);
    watcher.track(info.id, join(root, 'subagents'));
    assert.equal(watcher.trackedCount, 1);

    const deadline = Date.now() + 10_000;
    while (manager.get(info.id)?.status !== 'exited') {
      if (Date.now() >= deadline) throw new Error('the session never exited');
      await delay(20);
    }
    assert.equal(manager.has(info.id), true, 'still listed until DELETE...');
    assert.equal(manager.isLive(info.id), false, '...but not live');
    assert.equal(watcher.trackedCount, 0, 'onExit untracked it');
    manager.destroy(info.id);
  } finally {
    watcher.stop();
    manager.destroyAll();
    await rm(root, { recursive: true, force: true });
  }
});

test('config: claudeProjectsDir follows CLAUDE_CONFIG_DIR, like server/history.ts does', async () => {
  // A user who set the variable would otherwise get a table that never
  // appears, with nothing in the log to say why.
  const base = realpathSync(await mkdtemp(join(tmpdir(), 'ai-sm-cfgdir-')));
  const dataBefore = process.env['AI_SM_DATA_DIR'];
  const claudeBefore = process.env['CLAUDE_CONFIG_DIR'];
  try {
    process.env['AI_SM_DATA_DIR'] = join(base, 'data');
    delete process.env['CLAUDE_CONFIG_DIR'];
    const fallback = resolveDataPaths().claudeProjectsDir;
    assert.equal(fallback, join(homedir(), '.claude', 'projects'));

    process.env['CLAUDE_CONFIG_DIR'] = join(base, 'elsewhere');
    assert.equal(resolveDataPaths().claudeProjectsDir, join(base, 'elsewhere', 'projects'));

    // An empty value is not a setting: the home default stands.
    process.env['CLAUDE_CONFIG_DIR'] = '';
    assert.equal(resolveDataPaths().claudeProjectsDir, fallback);
  } finally {
    if (dataBefore === undefined) delete process.env['AI_SM_DATA_DIR'];
    else process.env['AI_SM_DATA_DIR'] = dataBefore;
    if (claudeBefore === undefined) delete process.env['CLAUDE_CONFIG_DIR'];
    else process.env['CLAUDE_CONFIG_DIR'] = claudeBefore;
    await rm(base, { recursive: true, force: true });
  }
});

test('watcher: the refusal is logged once, and a directory that becomes legal says so once', async () => {
  const base = realpathSync(await mkdtemp(join(tmpdir(), 'ai-sm-agentonce-')));
  const root = join(base, 'projects');
  const slug = join(root, '-slug');
  const outside = join(base, 'outside');
  await mkdir(slug, { recursive: true });
  await mkdir(join(outside, 'subagents'), { recursive: true });
  const link = join(slug, UUID);
  await symlink(outside, link);
  const logs: string[] = [];
  const seen: Seen[] = [];
  const watcher = new AgentsWatcher((level, message) => logs.push(`${level}: ${message}`), {
    projectsRoot: root,
    pollMs: 20,
  });
  const count = (needle: string): number => logs.filter((l) => l.includes(needle)).length;
  try {
    watcher.start((id, report) => seen.push({ id, agents: report.agents, report }));
    watcher.track('sess-1', join(link, 'subagents'));
    await delay(200); // ~10 polls.
    assert.equal(count('resolves outside the projects root'), 1, logs.join('\n'));

    // The user (or an installer) replaces the symlink with the real thing.
    await rm(link, { force: true });
    await mkdir(join(link, 'subagents'), { recursive: true });
    await writeMeta(join(link, 'subagents'), 'ab', { agentType: 'honest', description: '' });
    await waitFor(seen, (a) => a[0]?.name === 'honest');
    await delay(100); // ~5 more polls, all of them legal now.
    assert.equal(count('now inside the projects root'), 1, 'the recovery is said once too');
    assert.equal(count('resolves outside the projects root'), 1, 'and the refusal is not repeated');
  } finally {
    watcher.stop();
    await rm(base, { recursive: true, force: true });
  }
});

test('SessionManager: a RUNNING agent row is finished by the exit, and only that row', async () => {
  // Claude Code runs its subagents in-process: none of them outlives the host
  // session, and a row left 'running' would tick in the browser forever.
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'ai-sm-exitrows-')));
  const log: Logger = () => {};
  const history = new SessionHistory(join(root, 'history.json'), log);
  history.load();
  const manager = new SessionManager(log, history);
  try {
    const info = manager.create({ command: 'bash', args: ['-c', 'exit 0'], cwd: root, cols: 80, rows: 24 });
    const done: SessionAgent = {
      id: 'aa',
      name: 'done',
      task: 't',
      startedAt: '2026-09-22T10:00:00.000Z',
      endedAt: '2026-09-22T10:05:00.000Z',
      tokens: 5,
      state: 'finished',
    };
    const live: SessionAgent = {
      id: 'bb',
      name: 'live',
      task: 't',
      startedAt: '2026-09-22T10:01:00.000Z',
      tokens: 9,
      state: 'running',
    };
    manager.setReport(info.id, report([done, live], { counts: { running: 3, finished: 7 }, turn: 'working' }));

    const deadline = Date.now() + 10_000;
    while (manager.get(info.id)?.status !== 'exited') {
      if (Date.now() >= deadline) throw new Error('the session never exited');
      await delay(20);
    }
    const rows = manager.get(info.id)?.agents as SessionAgent[];
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0], done, 'a finished row is not touched');
    assert.equal(rows[1]?.state, 'finished');
    assert.equal(rows[1]?.tokens, 9, 'and it keeps what it cost');
    const endedAt = rows[1]?.endedAt as string;
    assert.equal(new Date(endedAt).toISOString(), endedAt, 'ISO-8601');
    assert.ok(Math.abs(Date.now() - Date.parse(endedAt)) < 60_000, 'the exit clock, not a fabricated one');
    // B11: the totals follow the same fact, and the turn is dropped.
    assert.deepEqual(manager.get(info.id)?.agentCounts, { running: 0, finished: 10 });
    assert.equal(manager.get(info.id)?.turn, undefined);
    manager.destroy(info.id);
  } finally {
    manager.destroyAll();
    await rm(root, { recursive: true, force: true });
  }
});

test('SessionManager: a session with NO agents gets no list at exit', async () => {
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'ai-sm-exitnorows-')));
  const log: Logger = () => {};
  const history = new SessionHistory(join(root, 'history.json'), log);
  history.load();
  const manager = new SessionManager(log, history);
  try {
    const info = manager.create({ command: 'bash', args: ['-c', 'exit 0'], cwd: root, cols: 80, rows: 24 });
    const deadline = Date.now() + 10_000;
    while (manager.get(info.id)?.status !== 'exited') {
      if (Date.now() >= deadline) throw new Error('the session never exited');
      await delay(20);
    }
    assert.equal(manager.get(info.id)?.agents, undefined, 'absent, never an empty table');
    manager.destroy(info.id);
  } finally {
    manager.destroyAll();
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Nocturne B11 — the turn (the session's own transcript) and the list rule
// (.claude/plans/nocturne/PLAN-B11.md)
// ---------------------------------------------------------------------------

/** Real-shaped lines, cut down from this machine's transcripts (Claude Code 2.1.27x). */
const REAL = {
  prompt: JSON.stringify({
    parentUuid: null,
    isSidechain: false,
    type: 'user',
    message: { role: 'user', content: 'fix the failing test' },
    uuid: 'u1',
    timestamp: '2026-09-22T10:00:00.000Z',
  }),
  toolResult: JSON.stringify({
    isSidechain: false,
    type: 'user',
    message: { role: 'user', content: [{ tool_use_id: 'toolu_1', type: 'tool_result', content: 'ok' }] },
    timestamp: '2026-09-22T10:00:02.000Z',
  }),
  taskNotification: JSON.stringify({
    isSidechain: false,
    type: 'user',
    message: { role: 'user', content: '<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n</task-notification>' },
    timestamp: '2026-09-22T10:00:03.000Z',
  }),
  interrupt: JSON.stringify({
    parentUuid: '64184a7c-a635-4170-9250-93c802616638',
    isSidechain: false,
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] },
    timestamp: '2026-09-09T15:28:37.227Z',
    interruptedMessageId: 'msg_011Cet6toLu1CTw9dVuiEc9H',
  }),
  interruptForTool: JSON.stringify({
    isSidechain: false,
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] },
    timestamp: '2026-09-09T15:28:38.000Z',
  }),
  commandName: JSON.stringify({
    isSidechain: false,
    type: 'user',
    message: {
      role: 'user',
      content: '<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args></command-args>',
    },
    timestamp: '2026-09-22T16:43:23.921Z',
  }),
  commandStdout: JSON.stringify({
    type: 'user',
    message: { role: 'user', content: '<local-command-stdout>Set model to opus</local-command-stdout>' },
  }),
  commandStderr: JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: '<local-command-stderr>nope</local-command-stderr>' }] },
  }),
  commandCaveat: JSON.stringify({
    type: 'user',
    isMeta: false,
    message: { role: 'user', content: '<local-command-caveat>Caveat: the messages below…</local-command-caveat>' },
  }),
  commandMessage: JSON.stringify({
    type: 'user',
    message: { role: 'user', content: '<command-message>review</command-message>' },
  }),
  meta: JSON.stringify({ type: 'user', isMeta: true, message: { role: 'user', content: 'Caveat: …' } }),
  sidechain: JSON.stringify({ type: 'user', isSidechain: true, message: { role: 'user', content: 'go' } }),
  synthetic: JSON.stringify({
    isSidechain: false,
    type: 'assistant',
    message: {
      id: 'be3179fe-a4b6-493b-84e5-6aa8de938e24',
      model: '<synthetic>',
      role: 'assistant',
      stop_reason: 'stop_sequence',
      content: [{ type: 'text', text: "You've hit your session limit · resets 7:30pm (Europe/Amsterdam)" }],
    },
    isApiErrorMessage: true,
  }),
  apiError: JSON.stringify({
    type: 'assistant',
    isApiErrorMessage: true,
    message: { id: 'x', model: 'claude-opus-5-5', role: 'assistant', stop_reason: null },
  }),
  syntheticOnly: JSON.stringify({
    type: 'assistant',
    message: { id: 'x', model: '<synthetic>', role: 'assistant', stop_reason: null },
  }),
  toolUse: assistantLine('2026-09-22T10:00:01.000Z', 'msg_1', { output_tokens: 3 }, 'tool_use'),
  endTurn: assistantLine('2026-09-22T10:00:04.000Z', 'msg_2', { output_tokens: 3 }, 'end_turn'),
};

test('turnOfLine: every rule of PLAN-B11 § The turn rule, on real-shaped lines', () => {
  // A prompt, a tool_result and a task-notification start (or continue) a turn.
  assert.equal(turnOfLine(REAL.prompt), 'working');
  assert.equal(turnOfLine(REAL.toolResult), 'working');
  assert.equal(turnOfLine(REAL.taskNotification), 'working');
  // An interrupt ends it — both of Claude Code's wordings.
  assert.equal(turnOfLine(REAL.interrupt), 'waiting');
  assert.equal(turnOfLine(REAL.interruptForTool), 'waiting');
  // A local slash command and its output start nothing.
  for (const line of [REAL.commandName, REAL.commandMessage, REAL.commandStdout, REAL.commandStderr, REAL.commandCaveat]) {
    assert.equal(turnOfLine(line), undefined, line);
  }
  // Meta and sidechain lines never count, whatever they say.
  assert.equal(turnOfLine(REAL.meta), undefined);
  assert.equal(turnOfLine(REAL.sidechain), undefined);
  assert.equal(
    turnOfLine(JSON.stringify({ type: 'assistant', isSidechain: true, message: { stop_reason: 'end_turn' } })),
    undefined,
  );
  // An API error / a synthetic message: Claude is not going on by itself.
  assert.equal(turnOfLine(REAL.synthetic), 'waiting');
  assert.equal(turnOfLine(REAL.apiError), 'waiting');
  assert.equal(turnOfLine(REAL.syntheticOnly), 'waiting');
  // Stop reasons.
  for (const stop of ['end_turn', 'stop_sequence', 'refusal', 'max_tokens']) {
    assert.equal(turnOfLine(assistantLine('2026-09-22T10:00:00.000Z', 'm', undefined, stop)), 'waiting', stop);
  }
  for (const stop of ['tool_use', 'pause_turn', null]) {
    assert.equal(turnOfLine(assistantLine('2026-09-22T10:00:00.000Z', 'm', undefined, stop)), 'working', String(stop));
  }
  assert.equal(turnOfLine(JSON.stringify({ type: 'assistant', message: { id: 'm' } })), 'working', 'no stop_reason key');
  assert.equal(turnOfLine(JSON.stringify({ type: 'assistant' })), 'working', 'no message at all');
  // The first TEXT block decides, not the first block.
  assert.equal(
    turnOfLine(
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'image', source: {} }, { type: 'text', text: '[Request interrupted by user]' }] },
      }),
    ),
    'waiting',
  );
  // A prefix only counts at the START of the text.
  assert.equal(
    turnOfLine(JSON.stringify({ type: 'user', message: { content: 'what does <command-name> mean?' } })),
    'working',
  );
});

test('turnOfLine: total — garbage, other types and hostile shapes never throw and never count', () => {
  for (const line of [
    '',
    'not json',
    '{"type":"user"',
    'null',
    '42',
    '"user"',
    '[]',
    '[{"type":"user"}]',
    JSON.stringify({ type: 'system', subtype: 'turn_duration' }),
    JSON.stringify({ type: 'attachment' }),
    JSON.stringify({ type: 'summary' }),
    JSON.stringify({ type: 'User', message: { content: 'x' } }),
    JSON.stringify({ message: { stop_reason: 'end_turn' } }),
  ]) {
    assert.equal(turnOfLine(line), undefined, line);
  }
  // Wrong-typed fields inside a counting type: still a verdict, never a throw.
  assert.equal(turnOfLine(JSON.stringify({ type: 'user', message: { content: 42 } })), 'working');
  assert.equal(turnOfLine(JSON.stringify({ type: 'user', message: { content: [null, 7, { type: 'text', text: 9 }] } })), 'working');
  assert.equal(turnOfLine(JSON.stringify({ type: 'user', message: 'x' })), 'working');
  assert.equal(turnOfLine(JSON.stringify({ type: 'assistant', message: { stop_reason: 7 } })), 'working');
  assert.equal(turnOfLine(JSON.stringify({ type: 'assistant', isApiErrorMessage: 'true', message: { stop_reason: 'tool_use' } })), 'working', 'only a real true');
  assert.equal(turnOfLine(JSON.stringify({ type: 'user', isMeta: 'true', message: { content: 'x' } })), 'working', 'only a real true');
  assert.equal(turnOfLine(undefined as unknown as string), undefined);
});

test('sameReport: rows, both counts and the turn all count', () => {
  const a: AgentsReport = { agents: [], counts: { running: 1, finished: 2 }, turn: 'working' };
  assert.equal(sameReport(undefined, undefined), true);
  assert.equal(sameReport(a, undefined), false);
  assert.equal(sameReport(undefined, a), false);
  assert.equal(sameReport(a, { agents: [], counts: { running: 1, finished: 2 }, turn: 'working' }), true);
  assert.equal(sameReport(a, { ...a, turn: 'waiting' }), false);
  assert.equal(sameReport(a, { agents: [], counts: { running: 1, finished: 2 } }), false, 'turn absent is a change');
  assert.equal(sameReport(a, { ...a, counts: { running: 2, finished: 2 } }), false);
  assert.equal(sameReport(a, { ...a, counts: { running: 1, finished: 3 } }), false);
  const row: SessionAgent = { id: 'aa', name: 'n', task: 't', startedAt: '2026-09-22T10:00:00.000Z', tokens: 1, state: 'running' };
  assert.equal(sameReport({ ...a, agents: [row] }, { ...a, agents: [{ ...row }] }), true);
  assert.equal(sameReport({ ...a, agents: [row] }, { ...a, agents: [{ ...row, tokens: 2 }] }), false);
});

/** The session's own transcript for the harness: `<root>/-slug/<UUID>.jsonl`. */
function mainFile(w: Harness): string {
  return join(w.root, '-slug', `${UUID}.jsonl`);
}

async function appendMain(w: Harness, lines: string[]): Promise<void> {
  await appendFile(mainFile(w), lines.map((l) => `${l}\n`).join(''), { mode: 0o600 });
}

test('watcher: a MISSING transcript reads waiting — a turn-only report, no agents, no subagents dir needed', async () => {
  // Claude Code creates the transcript at the first prompt: until then the
  // session sits at that prompt. The subagents dir does not exist either (most
  // sessions never spawn one), and the report still goes out.
  const w = await makeWatcher({ create: false });
  try {
    await mkdir(join(w.root, '-slug'), { recursive: true });
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    w.watcher.track('sess-1', w.dir);
    const report = await waitForReport(w.seen, (r) => r.turn === 'waiting');
    assert.deepEqual(report, { agents: [], counts: { running: 0, finished: 0 }, turn: 'waiting' });
    await delay(120);
    assert.equal(w.seen.length, 1, 'an unchanged turn is delivered once');
  } finally {
    await w.cleanup();
  }
});

test('watcher: the turn follows the transcript as it grows — prompt, tool, answer, interrupt', async () => {
  const w = await makeWatcher();
  try {
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    await appendMain(w, [REAL.prompt]);
    w.watcher.track('sess-1', w.dir);
    await waitForReport(w.seen, (r) => r.turn === 'working');
    await appendMain(w, [REAL.toolUse, REAL.toolResult]);
    await delay(100);
    assert.equal(w.seen[w.seen.length - 1]?.report.turn, 'working');
    await appendMain(w, [REAL.endTurn]);
    await waitForReport(w.seen, (r) => r.turn === 'waiting');
    // A local command after the answer changes nothing.
    await appendMain(w, [REAL.commandName, REAL.commandStdout]);
    await delay(100);
    assert.equal(w.seen[w.seen.length - 1]?.report.turn, 'waiting');
    await appendMain(w, [REAL.prompt]);
    await waitForReport(w.seen, (r) => r.turn === 'working');
    await appendMain(w, [REAL.interrupt]);
    await waitForReport(w.seen, (r) => r.turn === 'waiting');
    // Only real changes were delivered: working, waiting, working, waiting.
    assert.deepEqual(
      w.seen.map((s) => s.report.turn),
      ['working', 'waiting', 'working', 'waiting'],
    );
  } finally {
    await w.cleanup();
  }
});

test('watcher: a transcript with no counting line has NO turn and says nothing', async () => {
  const w = await makeWatcher({ create: false });
  try {
    await mkdir(join(w.root, '-slug'), { recursive: true });
    await appendMain(w, [REAL.meta, REAL.commandName, JSON.stringify({ type: 'system' }), 'torn{']);
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    w.watcher.track('sess-1', w.dir);
    await delay(200);
    assert.equal(w.seen.length, 0, 'no agents and no turn: nothing to announce');
  } finally {
    await w.cleanup();
  }
});

/** `count` filler lines of ~1 KB that do not count for the turn. */
function filler(bytes: number): string {
  const pad = `${JSON.stringify({ type: 'system', pad: 'x'.repeat(1_000) })}\n`;
  return pad.repeat(Math.ceil(bytes / pad.length));
}

test('watcher: first sight reads only the TAIL — a counting line before the last MiB is never seen', async () => {
  const w = await makeWatcher({ create: false });
  try {
    await mkdir(join(w.root, '-slug'), { recursive: true });
    // A prompt at the head, then more than TURN_TAIL_BYTES of lines that do
    // not count: read from 0 the verdict would be 'working'; the tail says nothing.
    await writeFile(mainFile(w), `${REAL.prompt}\n${filler(TURN_TAIL_BYTES + 64 * 1024)}`, { mode: 0o600 });
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    w.watcher.track('sess-1', w.dir);
    await delay(200);
    assert.equal(w.seen.length, 0, `the head was read; got ${JSON.stringify(w.seen[0]?.report)}`);
    // And from here on it is incremental: the next line is seen.
    await appendMain(w, [REAL.endTurn]);
    const report = await waitForReport(w.seen, (r) => r.turn !== undefined);
    assert.equal(report.turn, 'waiting');
  } finally {
    await w.cleanup();
  }
});

test('watcher: the tail drops its PARTIAL first line, and keeps one that starts exactly at the boundary', async () => {
  // (a) A counting line straddling the boundary is dropped: its second half is
  //     not JSON, and it must not be half-parsed either.
  const a = await makeWatcher({ create: false });
  try {
    await mkdir(join(a.root, '-slug'), { recursive: true });
    const tail = filler(TURN_TAIL_BYTES - 100); // strictly less than the tail
    const straddle = JSON.stringify({ type: 'user', message: { content: 'go' }, pad: 'y'.repeat(400) });
    const body = `${filler(8 * 1024)}${straddle}\n${tail}`;
    // The boundary (size - TAIL) falls inside `straddle`.
    assert.ok(Buffer.byteLength(tail) < TURN_TAIL_BYTES && Buffer.byteLength(tail) + straddle.length + 1 > TURN_TAIL_BYTES);
    await writeFile(mainFile(a), body, { mode: 0o600 });
    a.watcher.start((id, report) => a.seen.push({ id, agents: report.agents, report }));
    a.watcher.track('sess-1', a.dir);
    await delay(200);
    assert.equal(a.seen.length, 0, `the partial first line counted; got ${JSON.stringify(a.seen[0]?.report)}`);
  } finally {
    await a.cleanup();
  }
  // (b) A whole line beginning EXACTLY at size - TAIL is kept.
  const b = await makeWatcher({ create: false });
  try {
    await mkdir(join(b.root, '-slug'), { recursive: true });
    const first = `${REAL.endTurn}\n`;
    const rest = filler(TURN_TAIL_BYTES - first.length - 2_000);
    const pad = TURN_TAIL_BYTES - first.length - Buffer.byteLength(rest);
    const tail = `${first}${rest}${'z'.repeat(pad - 1)}\n`; // junk line: not JSON, skipped
    assert.equal(Buffer.byteLength(tail), TURN_TAIL_BYTES);
    await writeFile(mainFile(b), `${REAL.prompt}\n${filler(4 * 1024)}${tail}`, { mode: 0o600 });
    b.watcher.start((id, report) => b.seen.push({ id, agents: report.agents, report }));
    b.watcher.track('sess-1', b.dir);
    const report = await waitForReport(b.seen, (r) => r.turn !== undefined);
    assert.equal(report.turn, 'waiting', 'the line at the boundary is the verdict, not the prompt before it');
  } finally {
    await b.cleanup();
  }
});

test('watcher: the main transcript SHARES the tick budget — its tail is read over several ticks', async () => {
  const w = await makeWatcher({ create: false, readBudgetBytes: 256 * 1024 });
  try {
    await mkdir(join(w.root, '-slug'), { recursive: true });
    // Prompt first, the answer 600 KiB later: one 256 KiB tick sees the prompt
    // only, and the answer arrives a few ticks on.
    await writeFile(mainFile(w), `${REAL.prompt}\n${filler(600 * 1024)}${REAL.endTurn}\n`, { mode: 0o600 });
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    w.watcher.track('sess-1', w.dir);
    await waitForReport(w.seen, (r) => r.turn === 'waiting');
    assert.equal(w.seen[0]?.report.turn, 'working', 'the first tick could not reach the answer');
  } finally {
    await w.cleanup();
  }
});

test('watcher: a main transcript that SHRANK is re-read from its tail with the verdict reset', async () => {
  const w = await makeWatcher({ create: false });
  try {
    await mkdir(join(w.root, '-slug'), { recursive: true });
    await appendMain(w, [REAL.prompt, REAL.toolUse, REAL.toolResult, REAL.endTurn]);
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    w.watcher.track('sess-1', w.dir);
    await waitForReport(w.seen, (r) => r.turn === 'waiting');
    await writeFile(mainFile(w), `${REAL.prompt}\n`, { mode: 0o600 });
    await waitForReport(w.seen, (r) => r.turn === 'working');
    assert.equal(w.logs.some((l) => l.includes('transcript shrank, re-reading its tail')), true, w.logs.join(' | '));
  } finally {
    await w.cleanup();
  }
});

test('watcher: a SYMLINK at the main transcript is refused — even one pointing inside the root — and logged once', async () => {
  const w = await makeWatcher({ create: false });
  try {
    await mkdir(join(w.root, '-slug'), { recursive: true });
    const decoy = join(w.root, '-slug', `${OTHER_UUID}.jsonl`);
    await writeFile(decoy, `${REAL.prompt}\n`, { mode: 0o600 });
    await symlink(decoy, mainFile(w));
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    w.watcher.track('sess-1', w.dir);
    await delay(250);
    assert.equal(w.seen.length, 0, `followed the symlink; got ${JSON.stringify(w.seen[0]?.report)}`);
    const refusals = w.logs.filter((l) => l.includes('resolves outside the projects root, refused'));
    assert.equal(refusals.length, 1, `once, not once per poll; logs ${JSON.stringify(w.logs)}`);
    // A symlink out of the tree, to a file that would say something: same.
    const outside = realpathSync(await mkdtemp(join(tmpdir(), 'ai-sm-turn-out-')));
    try {
      await writeFile(join(outside, 'secret.jsonl'), `${REAL.endTurn}\n`, { mode: 0o600 });
      await rm(mainFile(w));
      await symlink(join(outside, 'secret.jsonl'), mainFile(w));
      await delay(200);
      assert.equal(w.seen.length, 0);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
    // Replaced by a real file: read again, and the recovery is logged.
    await rm(mainFile(w));
    await writeFile(mainFile(w), `${REAL.endTurn}\n`, { mode: 0o600 });
    const report = await waitForReport(w.seen, (r) => r.turn !== undefined);
    assert.equal(report.turn, 'waiting');
    assert.equal(w.logs.some((l) => l.includes('now inside the projects root, reading it again')), true);
  } finally {
    await w.cleanup();
  }
});

test('watcher: a DANGLING symlink at the main transcript is not "missing" — no turn, never waiting', async () => {
  const w = await makeWatcher({ create: false });
  try {
    await mkdir(join(w.root, '-slug'), { recursive: true });
    await symlink(join(w.root, 'nowhere.jsonl'), mainFile(w));
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    w.watcher.track('sess-1', w.dir);
    await delay(200);
    assert.equal(w.seen.length, 0, `got ${JSON.stringify(w.seen[0]?.report)}`);
  } finally {
    await w.cleanup();
  }
});

test('watcher: a PARENT directory swapped for a symlink out of the root is refused per poll', async () => {
  // subagentsDirFor checked the parent once, at track(); the watcher checks it
  // again on every poll, so a symlink planted afterwards is caught.
  const w = await makeWatcher({ create: false });
  const outside = realpathSync(await mkdtemp(join(tmpdir(), 'ai-sm-turn-parent-')));
  try {
    await mkdir(join(w.root, '-slug'), { recursive: true });
    await appendMain(w, [REAL.prompt]);
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    w.watcher.track('sess-1', w.dir);
    await waitForReport(w.seen, (r) => r.turn === 'working');
    await writeFile(join(outside, `${UUID}.jsonl`), `${REAL.endTurn}\n`, { mode: 0o600 });
    await rm(join(w.root, '-slug'), { recursive: true, force: true });
    await symlink(outside, join(w.root, '-slug'));
    // The verdict goes AWAY (refused), it never becomes the outside file's 'waiting'.
    const report = await waitForReport(w.seen, (r) => r.turn === undefined);
    assert.deepEqual(report, { agents: [], counts: { running: 0, finished: 0 } });
    await delay(150);
    assert.equal(w.seen.some((s) => s.report.turn === 'waiting'), false);
    assert.equal(w.logs.filter((l) => l.includes('resolves outside the projects root, refused')).length, 1);
  } finally {
    await w.cleanup();
    await rm(outside, { recursive: true, force: true });
  }
});

test('watcher: a FIFO at the main transcript never blocks the poll and gives no turn', async () => {
  const w = await makeWatcher();
  try {
    execFileSync('mkfifo', [mainFile(w)]);
    await writeMeta(w.dir, 'ae', { agentType: 'still-polled', description: '' });
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    w.watcher.track('sess-1', w.dir);
    const report = await waitForReport(w.seen, (r) => r.agents.length === 1);
    assert.equal(report.turn, undefined);
  } finally {
    await w.cleanup();
  }
});

test('watcher: a tracked directory not shaped `<parent>/<uuid>/subagents` derives no transcript', async () => {
  const w = await makeWatcher({ create: false });
  try {
    const odd = join(w.root, '-slug', 'not-a-uuid', 'subagents');
    await mkdir(odd, { recursive: true });
    await writeFile(join(w.root, '-slug', 'not-a-uuid.jsonl'), `${REAL.prompt}\n`, { mode: 0o600 });
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    w.watcher.track('sess-1', odd);
    await delay(200);
    assert.equal(w.seen.length, 0);
  } finally {
    await w.cleanup();
  }
});

/** Plant `running` running agents (started oldest first) and `finished` finished ones (ending oldest first). */
async function plantAgents(dir: string, running: number, finished: number): Promise<void> {
  for (let i = 0; i < running; i++) {
    const id = `a${i.toString(16).padStart(2, '0')}`;
    await writeMeta(dir, id, { agentType: `run-${i}`, description: '' });
    await appendLines(dir, id, [userLine(`2026-09-16T10:${String(i).padStart(2, '0')}:00.000Z`)]);
  }
  for (let i = 0; i < finished; i++) {
    const id = `f${i.toString(16).padStart(2, '0')}`;
    await writeMeta(dir, id, { agentType: `fin-${i}`, description: '' });
    await appendLines(dir, id, [
      userLine('2026-09-16T09:00:00.000Z'),
      assistantLine(`2026-09-16T11:${String(i).padStart(2, '0')}:00.000Z`, `m${i}`, { output_tokens: 1 }, 'end_turn'),
    ]);
  }
}

for (const [running, finished, rows, label] of [
  [6, 10, ['run-0', 'run-1', 'run-2', 'run-3'], '4 rows, +2 working, +10 finished'],
  [3, 5, ['run-0', 'run-1', 'run-2', 'fin-4'], '3 rows + the latest finished, +4 finished'],
  [4, 2, ['run-0', 'run-1', 'run-2', 'run-3'], '4 rows, +2 finished'],
  [0, 12, ['fin-11'], '1 finished row, +11 finished'],
] as const) {
  test(`watcher: the list rule, B11 (d) — ${running} running + ${finished} finished → ${label}`, async () => {
    const w = await makeWatcher();
    try {
      w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
      await plantAgents(w.dir, running, finished);
      w.watcher.track('sess-1', w.dir);
      const report = await waitForReport(w.seen, (r) => r.counts.running === running && r.counts.finished === finished);
      assert.deepEqual(report.agents.map((r) => r.name), rows);
      // What the frontend derives from it: `+N working` and `+N finished`.
      const runningRows = report.agents.filter((r) => r.state === 'running').length;
      const finishedRows = report.agents.length - runningRows;
      assert.equal(runningRows <= MAX_RUNNING_ROWS, true);
      assert.equal(finishedRows <= 1, true);
      assert.equal(finishedRows === 1, running < MAX_RUNNING_ROWS, 'a finished row exactly when fewer than 4 run');
    } finally {
      await w.cleanup();
    }
  });
}

test('watcher: agents AND a turn travel in one report; the turn changing alone is a delivery', async () => {
  const w = await makeWatcher();
  try {
    await plantAgents(w.dir, 1, 0);
    await appendMain(w, [REAL.prompt, REAL.toolUse]);
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    w.watcher.track('sess-1', w.dir);
    const first = await waitForReport(w.seen, (r) => r.agents.length === 1 && r.turn === 'working');
    assert.deepEqual(first.counts, { running: 1, finished: 0 });
    const calls = w.seen.length;
    // The orchestrator ends its turn while its agent still runs: waiting.
    await appendMain(w, [REAL.endTurn]);
    const next = await waitForReport(w.seen, (r) => r.turn === 'waiting');
    assert.equal(w.seen.length, calls + 1);
    assert.deepEqual(next.agents.map((r) => r.name), ['run-0'], 'the rows are unchanged');
  } finally {
    await w.cleanup();
  }
});

test('SessionManager.setReport: a turn-only report sets `turn` and no agent fields; the turn moving is one frame', async () => {
  const m = await makeManager();
  try {
    const info = m.manager.create({ command: 'bash', args: ['-c', 'sleep 30'], cwd: m.root, cols: 80, rows: 24 });
    const client = new FakeClient();
    assert.equal(m.manager.attach(info.id, client.asWs()), true);
    const base = client.infoFrames().length;

    m.manager.setReport(info.id, report([], { turn: 'waiting' }));
    assert.equal(client.infoFrames().length, base + 1);
    const s = client.infoFrames()[base] as SessionInfo;
    assert.equal(s.turn, 'waiting');
    assert.equal('agents' in s, false, 'no agents: absent, never an empty table');
    assert.equal('agentCounts' in s, false);

    m.manager.setReport(info.id, report([], { turn: 'waiting' }));
    assert.equal(client.infoFrames().length, base + 1, 'unchanged: no frame');

    m.manager.setReport(info.id, report([], { turn: 'working' }));
    assert.equal(client.infoFrames().length, base + 2);
    assert.equal(m.manager.get(info.id)?.turn, 'working');

    // Unknown again (a refused path): the field goes absent, one frame.
    m.manager.setReport(info.id, report([]));
    assert.equal(client.infoFrames().length, base + 3);
    assert.equal('turn' in (client.infoFrames()[base + 2] as SessionInfo), false);
    assert.equal(m.manager.get(info.id)?.turn, undefined);
    m.manager.destroy(info.id);
  } finally {
    await m.cleanup();
  }
});

test('SessionManager: the exit drops `turn` in the frame before `exit`, and a later report cannot bring it back', async () => {
  const m = await makeManager();
  try {
    const info = m.manager.create({ command: 'bash', args: ['-c', 'sleep 0.3'], cwd: m.root, cols: 80, rows: 24 });
    const client = new FakeClient();
    assert.equal(m.manager.attach(info.id, client.asWs()), true);
    m.manager.setReport(info.id, report([], { turn: 'working' }));
    assert.equal(m.manager.get(info.id)?.turn, 'working');

    const deadline = Date.now() + 10_000;
    while (m.manager.get(info.id)?.status !== 'exited') {
      if (Date.now() >= deadline) throw new Error('the session never exited');
      await delay(20);
    }
    assert.equal(m.manager.get(info.id)?.turn, undefined);
    const exitAt = client.frames.findIndex((f) => f.type === 'exit');
    assert.ok(exitAt > 0);
    const before = client.frames[exitAt - 1];
    assert.equal(before?.type, 'info', 'one info frame right before the exit');
    assert.equal('turn' in (before as Extract<ServerMessage, { type: 'info' }>).session, false);

    // A poll racing the untrack: ignored on an exited session.
    const frames = client.frames.length;
    m.manager.setReport(info.id, report([ROW], { turn: 'waiting' }));
    assert.equal(m.manager.get(info.id)?.turn, undefined);
    assert.equal(m.manager.get(info.id)?.agents, undefined);
    assert.equal(client.frames.length, frames, 'no frame');
    assert.equal(m.logs.some((l) => l.includes(`${info.id} agents ignored: session exited`)), true);
    m.manager.destroy(info.id);
  } finally {
    await m.cleanup();
  }
});

// ---------------------------------------------------------------------------
// B11 test-review additions: mutants the tests above let through
// ---------------------------------------------------------------------------

test('watcher: the list rule orders by TIME, not by id — oldest-started running rows, latest-ended finished row', async () => {
  // The ids run AGAINST the clock here, so a sort that falls back to the id
  // (or reads startedAt where endedAt decides) picks the wrong rows. In the
  // four-example tests above ids and times agree, which hides exactly that.
  const w = await makeWatcher();
  try {
    // Five running: b0 started LAST, b4 FIRST → rows b4, b3, b2, b1.
    for (let i = 0; i < 5; i++) {
      await writeMeta(w.dir, `b${i}`, { agentType: `run-b${i}`, description: '' });
      await appendLines(w.dir, `b${i}`, [userLine(`2026-09-16T10:${String(20 - i).padStart(2, '0')}:00.000Z`)]);
    }
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    w.watcher.track('sess-1', w.dir);
    const five = await waitForReport(w.seen, (r) => r.counts.running === 5);
    assert.deepEqual(five.agents.map((r) => r.name), ['run-b4', 'run-b3', 'run-b2', 'run-b1']);
  } finally {
    await w.cleanup();
  }

  const v = await makeWatcher();
  try {
    // Two running + three finished. c1 ENDED last but STARTED first; c0 and c2
    // bracket it on id, so neither id order nor startedAt order lands on c1.
    await plantAgents(v.dir, 2, 0);
    const fin: [string, string, string][] = [
      ['c0', '2026-09-16T09:10:00.000Z', '2026-09-16T11:10:00.000Z'],
      ['c1', '2026-09-16T09:00:00.000Z', '2026-09-16T11:30:00.000Z'],
      ['c2', '2026-09-16T09:20:00.000Z', '2026-09-16T11:20:00.000Z'],
    ];
    for (const [id, start, end] of fin) {
      await writeMeta(v.dir, id, { agentType: `fin-${id}`, description: '' });
      await appendLines(v.dir, id, [userLine(start), assistantLine(end, `m-${id}`, { output_tokens: 1 }, 'end_turn')]);
    }
    v.watcher.start((id, report) => v.seen.push({ id, agents: report.agents, report }));
    v.watcher.track('sess-1', v.dir);
    const r = await waitForReport(v.seen, (x) => x.counts.running === 2 && x.counts.finished === 3);
    assert.deepEqual(r.agents.map((a) => a.name), ['run-0', 'run-1', 'fin-c1'], 'the one most recently FINISHED');
  } finally {
    await v.cleanup();
  }
});

test('watcher: a transcript of EXACTLY TURN_TAIL_BYTES is read from byte 0 — its first line counts', async () => {
  // The boundary of `size > TURN_TAIL_BYTES`: at equality the whole file is
  // the tail, so nothing is partial and the first line must not be dropped.
  const w = await makeWatcher({ create: false });
  try {
    await mkdir(join(w.root, '-slug'), { recursive: true });
    const first = `${REAL.prompt}\n`;
    const rest = filler(TURN_TAIL_BYTES - first.length - 4_000);
    const pad = TURN_TAIL_BYTES - first.length - Buffer.byteLength(rest);
    const body = `${first}${rest}${'z'.repeat(pad - 1)}\n`; // last line: junk, skipped
    assert.equal(Buffer.byteLength(body), TURN_TAIL_BYTES);
    await writeFile(mainFile(w), body, { mode: 0o600 });
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    w.watcher.track('sess-1', w.dir);
    const report = await waitForReport(w.seen, (r) => r.turn !== undefined);
    assert.equal(report.turn, 'working', 'the prompt at byte 0 is the verdict');
  } finally {
    await w.cleanup();
  }
});

test('watcher: NO stale rule for the turn — a long tool call hours old still reads working', async () => {
  // Agents go stale after STALE_MS; the session's own turn never does
  // (PLAN-B11 § The turn rule: "a long tool call is still working").
  const w = await makeWatcher({ create: false, now: () => Date.now() + 24 * 60 * 60 * 1000 });
  try {
    await mkdir(join(w.root, '-slug'), { recursive: true });
    await appendMain(w, [REAL.prompt, REAL.toolUse]);
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    w.watcher.track('sess-1', w.dir);
    const report = await waitForReport(w.seen, (r) => r.turn !== undefined);
    assert.equal(report.turn, 'working');
    await delay(150);
    assert.deepEqual(w.seen.map((s) => s.report.turn), ['working'], 'never flips to waiting by age');
  } finally {
    await w.cleanup();
  }
});

test('watcher: a MISSING PARENT directory is not a missing transcript — no turn, never waiting', async () => {
  // Only `<parent>/<uuid>.jsonl` absent inside an existing parent — or a slug
  // folder that is ONE missing component directly under the real root (B11
  // F1, pending) — means "at the first prompt". A parent missing deeper than
  // that, or missing outside the root, may not be read at all.
  const w = await makeWatcher({ create: false });
  const outside = realpathSync(await mkdtemp(join(tmpdir(), 'ai-sm-turn-noparent-')));
  try {
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    // Two missing components: `<root>/-a` and `<root>/-a/-b`.
    w.watcher.track('sess-deep', join(w.root, '-a', '-b', UUID, 'subagents'));
    // One missing component — but under a directory that is NOT the root.
    w.watcher.track('sess-outside', join(outside, '-slug', UUID, 'subagents'));
    // One missing component under a subfolder of the root, not the root itself.
    await mkdir(join(w.root, '-x'), { recursive: true });
    w.watcher.track('sess-nested', join(w.root, '-x', '-slug', UUID, 'subagents'));
    await delay(200);
    assert.equal(w.seen.length, 0, `got ${JSON.stringify(w.seen[0])}`);
  } finally {
    await w.cleanup();
    await rm(outside, { recursive: true, force: true });
  }
});

test('subagentsDirFor: a slug folder that is ONE missing component under the real root is accepted (pending), nothing else', async () => {
  const r = await makeRoot();
  try {
    // Claude Code has never opened this folder: `<root>/<slug>` is not there.
    const fresh = join(r.root, '-home-u-projects-new');
    assert.equal(subagentsDirFor(join(fresh, `${UUID}.jsonl`), r.root), join(fresh, UUID, 'subagents'));
    // Two missing components.
    assert.equal(subagentsDirFor(join(r.root, '-a', '-b', `${UUID}.jsonl`), r.root), null);
    // One missing component under a subfolder of the root, not the root itself.
    assert.equal(subagentsDirFor(join(r.slug, '-deeper', `${UUID}.jsonl`), r.root), null);
    // One missing component outside the root.
    assert.equal(subagentsDirFor(join(r.base, '-slug', `${UUID}.jsonl`), r.root), null);
    // A DANGLING symlink wearing the slug's name exists for lstat: not pending.
    await symlink(join(r.base, 'nowhere'), join(r.root, '-dangling'));
    assert.equal(subagentsDirFor(join(r.root, '-dangling', `${UUID}.jsonl`), r.root), null);
    // The lexical checks still come first: a bad name is refused even when pending.
    assert.equal(subagentsDirFor(join(fresh, 'not-a-uuid.jsonl'), r.root), null);
    assert.equal(subagentsDirFor(`${fresh}/../-evil/${UUID}.jsonl`, r.root), null);
    // A root reached through a symlink: the pending path is built from the REAL root.
    const alias = join(r.base, 'alias');
    await symlink(r.root, alias);
    assert.equal(
      subagentsDirFor(join(alias, '-home-u-projects-new', `${UUID}.jsonl`), r.root),
      join(r.root, '-home-u-projects-new', UUID, 'subagents'),
    );
  } finally {
    await r.cleanup();
  }
});

test('watcher: PENDING slug folder — waiting, then the folder appears and the transcript is read (tool_use → working)', async () => {
  const w = await makeWatcher({ create: false }); // `<root>/-slug` does not exist
  try {
    const dir = subagentsDirFor(mainFile(w), w.root);
    assert.equal(dir, w.dir, 'index.ts would track it');
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    w.watcher.track('sess-1', w.dir);
    const first = await waitForReport(w.seen, (r) => r.turn === 'waiting');
    assert.deepEqual(first, { agents: [], counts: { running: 0, finished: 0 }, turn: 'waiting' });
    // The first prompt: Claude Code creates the folder and the transcript.
    await mkdir(join(w.root, '-slug'), { recursive: true });
    await appendMain(w, [REAL.prompt, REAL.toolUse]);
    await waitForReport(w.seen, (r) => r.turn === 'working');
    // And its subagents are read from the same, now real, folder.
    await mkdir(w.dir, { recursive: true });
    await writeMeta(w.dir, 'ab', { agentType: 'late', description: '' });
    const withAgent = await waitForReport(w.seen, (r) => r.agents.length === 1);
    assert.equal(withAgent.turn, 'working');
  } finally {
    await w.cleanup();
  }
});

test('watcher: PENDING slug folder created as a SYMLINK out of the root is refused — no turn, no agents', async () => {
  const w = await makeWatcher({ create: false });
  const outside = realpathSync(await mkdtemp(join(tmpdir(), 'ai-sm-turn-pendsym-')));
  try {
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    w.watcher.track('sess-1', w.dir);
    await waitForReport(w.seen, (r) => r.turn === 'waiting');
    // What the outside tree would say, if it were read: a verdict and an agent.
    await writeFile(join(outside, `${UUID}.jsonl`), `${REAL.prompt}\n`, { mode: 0o600 });
    await mkdir(join(outside, UUID, 'subagents'), { recursive: true });
    await writeMeta(join(outside, UUID, 'subagents'), 'cd', { agentType: 'stolen', description: '' });
    await symlink(outside, join(w.root, '-slug'));
    const report = await waitForReport(w.seen, (r) => r.turn === undefined);
    assert.deepEqual(report, { agents: [], counts: { running: 0, finished: 0 } });
    await delay(150);
    assert.equal(w.seen.some((s) => s.report.turn === 'working' || s.agents.length > 0), false, JSON.stringify(w.seen));
    assert.equal(w.logs.some((l) => l.includes('resolves outside the projects root, refused')), true, w.logs.join(' | '));
  } finally {
    await w.cleanup();
    await rm(outside, { recursive: true, force: true });
  }
});

test('watcher: the tick budget is shared ROUND ROBIN — a busy first session cannot starve a later one', async () => {
  // 256 KiB per tick. Session A (tracked first) needs its whole 1 MiB tail read
  // before its verdict: 5 ticks. Session B needs one small line. In a fixed
  // order B would get nothing until A caught up; round robin starts B first
  // within two ticks, so B's verdict arrives while A is still reading.
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'ai-sm-agentrr-')));
  const seen: Seen[] = [];
  const watcher = new AgentsWatcher(() => {}, { projectsRoot: root, pollMs: 40, readBudgetBytes: 256 * 1024 });
  try {
    const slugA = join(root, '-a');
    const slugB = join(root, '-b');
    await mkdir(slugA, { recursive: true });
    await mkdir(slugB, { recursive: true });
    await writeFile(join(slugA, `${UUID}.jsonl`), `${filler(2 * 1024 * 1024)}${REAL.endTurn}\n`, { mode: 0o600 });
    await writeFile(join(slugB, `${OTHER_UUID}.jsonl`), `${REAL.prompt}\n`, { mode: 0o600 });
    watcher.start((id, report) => seen.push({ id, agents: report.agents, report }));
    watcher.track('sess-a', join(slugA, UUID, 'subagents'));
    watcher.track('sess-b', join(slugB, OTHER_UUID, 'subagents'));
    const deadline = Date.now() + 10_000;
    while (!seen.some((s) => s.id === 'sess-a' && s.report.turn === 'waiting')) {
      if (Date.now() >= deadline) throw new Error(`A never got its verdict; ${JSON.stringify(seen.map((s) => [s.id, s.report.turn]))}`);
      await delay(10);
    }
    const order = seen.map((s) => `${s.id}:${s.report.turn}`);
    assert.equal(order[0], 'sess-b:working', `B went first, while A was still reading; order ${JSON.stringify(order)}`);
    assert.deepEqual(order, ['sess-b:working', 'sess-a:waiting']);
  } finally {
    watcher.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('watcher: the 4 MiB PER-FILE cap holds on the main transcript — a 5 MiB growth takes at least two ticks', async () => {
  // A 64 MiB tick budget would read it all at once; MAX_READ_PER_POLL must
  // not. `now()` is called once per session per tick (the report), so it
  // doubles as a tick counter.
  let ticks = 0;
  const w = await makeWatcher({
    create: false,
    readBudgetBytes: 64 * 1024 * 1024,
    now: () => {
      ticks++;
      return Date.now();
    },
  });
  try {
    await mkdir(join(w.root, '-slug'), { recursive: true });
    await appendMain(w, [REAL.prompt]);
    const at: number[] = [];
    w.watcher.start((id, report) => {
      at.push(ticks);
      w.seen.push({ id, agents: report.agents, report });
    });
    w.watcher.track('sess-1', w.dir);
    await waitForReport(w.seen, (r) => r.turn === 'working');
    const before = ticks; // every tick up to here saw none of the growth
    await appendFile(mainFile(w), `${filler(5 * 1024 * 1024)}${REAL.endTurn}\n`, { mode: 0o600 });
    await waitForReport(w.seen, (r) => r.turn === 'waiting');
    const verdictTick = at[at.length - 1] as number;
    assert.equal(verdictTick - before >= 2, true, `verdict ${verdictTick - before} tick(s) after the growth began`);
  } finally {
    await w.cleanup();
  }
});

// ---------------------------------------------------------------------------
// B11 mutation gate: tests for the mutants the suite above let through
// ---------------------------------------------------------------------------

/** Permission-based refusals mean nothing to root (CAP_DAC_OVERRIDE reads everything). */
const ROOT_USER = typeof process.getuid === 'function' && process.getuid() === 0;

test('subagentsDirFor: a slug name the filesystem cannot even look up (ENAMETOOLONG) is not pending', async () => {
  // pendingSlug accepts ONLY a truly missing folder (lstat ENOENT); any other
  // lstat error — here a 300-byte component — is a refusal, not "not there yet".
  const r = await makeRoot();
  try {
    assert.equal(subagentsDirFor(join(r.root, 's'.repeat(300), `${UUID}.jsonl`), r.root), null);
  } finally {
    await r.cleanup();
  }
});

test('watcher: a tracked directory whose last component is not `subagents` derives no transcript', async () => {
  const w = await makeWatcher({ create: false });
  try {
    await mkdir(join(w.root, '-slug'), { recursive: true });
    await appendMain(w, [REAL.prompt]); // `<root>/-slug/<UUID>.jsonl` would say working
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    w.watcher.track('sess-1', join(w.root, '-slug', UUID, 'elsewhere'));
    await delay(200);
    assert.equal(w.seen.length, 0, `got ${JSON.stringify(w.seen[0]?.report)}`);
  } finally {
    await w.cleanup();
  }
});

test('watcher: a main transcript under a SIBLING of the root (`<root>-evil`) is refused, not prefix-matched', async () => {
  const w = await makeWatcher({ create: false });
  const evil = `${w.root}-evil`;
  try {
    await mkdir(join(evil, '-slug'), { recursive: true });
    await writeFile(join(evil, '-slug', `${UUID}.jsonl`), `${REAL.prompt}\n`, { mode: 0o600 });
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    w.watcher.track('sess-1', join(evil, '-slug', UUID, 'subagents'));
    await delay(200);
    assert.equal(w.seen.length, 0, `got ${JSON.stringify(w.seen[0]?.report)}`);
    assert.equal(w.logs.some((l) => l.includes('resolves outside the projects root, refused')), true, w.logs.join(' | '));
  } finally {
    await w.cleanup();
    await rm(evil, { recursive: true, force: true });
  }
});

test('watcher: a transcript that cannot be looked up (EACCES) is not "missing" — no turn, never waiting', { skip: ROOT_USER }, async () => {
  // Only lstat ENOENT means "at the first prompt"; a parent folder this user
  // may not search is an unreadable transcript, not an absent one.
  const w = await makeWatcher({ create: false });
  const parent = join(w.root, '-slug');
  try {
    await mkdir(parent, { recursive: true });
    await appendMain(w, [REAL.endTurn]);
    await chmod(parent, 0o600); // no search bit: realpath and lstat of the file fail EACCES
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    w.watcher.track('sess-1', w.dir);
    await delay(200);
    assert.equal(w.seen.length, 0, `got ${JSON.stringify(w.seen[0]?.report)}`);
  } finally {
    await chmod(parent, 0o700).catch(() => {});
    await w.cleanup();
  }
});

test('watcher: a main transcript that becomes UNOPENABLE loses its verdict — the old one is not kept', { skip: ROOT_USER }, async () => {
  const w = await makeWatcher({ create: false });
  try {
    await mkdir(join(w.root, '-slug'), { recursive: true });
    await appendMain(w, [REAL.prompt]);
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    w.watcher.track('sess-1', w.dir);
    await waitForReport(w.seen, (r) => r.turn === 'working');
    await chmod(mainFile(w), 0o000); // realpath still resolves; open() is EACCES
    const report = await waitForReport(w.seen, (r) => r.turn === undefined);
    assert.deepEqual(report, { agents: [], counts: { running: 0, finished: 0 } });
  } finally {
    await chmod(mainFile(w), 0o600).catch(() => {});
    await w.cleanup();
  }
});

test('watcher: the tail RESYNCS — a partial first line that would parse from mid-line is still dropped', async () => {
  // The line straddling the boundary is `xxx… {"type":"user",…}`: not JSON as a
  // whole, but its bytes from the boundary on (`␠{…}`, the read starts one byte
  // early) ARE. Only the resync keeps that half from counting as 'working'.
  const w = await makeWatcher({ create: false });
  try {
    await mkdir(join(w.root, '-slug'), { recursive: true });
    const json = JSON.stringify({ type: 'user', message: { content: 'go' } });
    const rest = filler(TURN_TAIL_BYTES - json.length - 1 - 3_000);
    const pad = TURN_TAIL_BYTES - json.length - 1 - Buffer.byteLength(rest);
    const tail = `${json}\n${rest}${'z'.repeat(pad - 1)}\n`; // last line: junk, skipped
    assert.equal(Buffer.byteLength(tail), TURN_TAIL_BYTES);
    await writeFile(mainFile(w), `${filler(8 * 1024)}${'x'.repeat(500)} ${tail}`, { mode: 0o600 });
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    w.watcher.track('sess-1', w.dir);
    await delay(200);
    assert.equal(w.seen.length, 0, `the partial first line counted; got ${JSON.stringify(w.seen[0]?.report)}`);
  } finally {
    await w.cleanup();
  }
});

test('watcher: bytes read from the MAIN transcript are spent from the tick budget — agents wait their turn', async () => {
  // 256 KiB per tick and a 1 MiB tail on the main transcript: the first tick's
  // budget is gone before the agent's transcript is reached, so the agent row
  // first appears from its meta alone (0 tokens), and its tokens only later.
  const w = await makeWatcher({ readBudgetBytes: 256 * 1024 });
  try {
    await writeFile(mainFile(w), filler(2 * 1024 * 1024), { mode: 0o600 });
    await writeMeta(w.dir, 'ad', { agentType: 'budgeted', description: '' });
    await appendLines(w.dir, 'ad', [userLine('2026-09-16T10:00:00.000Z'), assistantLine('2026-09-16T10:00:01.000Z', 'm1', { output_tokens: 7 })]);
    w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
    w.watcher.track('sess-1', w.dir);
    await waitForReport(w.seen, (r) => r.agents[0]?.tokens === 7);
    assert.equal(w.seen[0]?.report.agents[0]?.tokens, 0, `the main read did not spend the budget; ${JSON.stringify(w.seen[0]?.report)}`);
  } finally {
    await w.cleanup();
  }
});

test('watcher: a session untracked by the consumer MID-SWEEP is not polled on its stale record', async () => {
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'ai-sm-agentsweep-')));
  const seen: string[] = [];
  const watcher = new AgentsWatcher(() => {}, { projectsRoot: root, pollMs: 20 });
  try {
    for (const [slug, uuid] of [['-a', UUID], ['-b', OTHER_UUID]] as const) {
      await mkdir(join(root, slug), { recursive: true });
      await writeFile(join(root, slug, `${uuid}.jsonl`), `${REAL.prompt}\n`, { mode: 0o600 });
    }
    // Tracked before start: the first sweep (tick 0) visits A, then B.
    watcher.track('sess-a', join(root, '-a', UUID, 'subagents'));
    watcher.track('sess-b', join(root, '-b', OTHER_UUID, 'subagents'));
    watcher.start((id) => {
      seen.push(id);
      if (id === 'sess-a') watcher.untrack('sess-b'); // e.g. B exited meanwhile
    });
    const deadline = Date.now() + 5_000;
    while (!seen.includes('sess-a')) {
      if (Date.now() >= deadline) throw new Error('A never reported');
      await delay(10);
    }
    await delay(100);
    assert.deepEqual(seen, ['sess-a'], 'B was untracked before its turn in the same sweep');
  } finally {
    watcher.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('SessionManager.setReport: only the FINISHED total moving is a change too — one frame', async () => {
  const m = await makeManager();
  try {
    const info = m.manager.create({ command: 'bash', args: ['-c', 'sleep 30'], cwd: m.root, cols: 80, rows: 24 });
    const client = new FakeClient();
    assert.equal(m.manager.attach(info.id, client.asWs()), true);
    m.manager.setReport(info.id, report([ROW], { counts: { running: 1, finished: 0 } }));
    const n = client.infoFrames().length;
    m.manager.setReport(info.id, report([ROW], { counts: { running: 1, finished: 3 } }));
    assert.equal(client.infoFrames().length, n + 1);
    assert.deepEqual(m.manager.get(info.id)?.agentCounts, { running: 1, finished: 3 });
    m.manager.destroy(info.id);
  } finally {
    await m.cleanup();
  }
});
