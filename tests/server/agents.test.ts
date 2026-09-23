/**
 * server/agents.ts — the subagents Claude Code ran for a session, read out of
 * its own transcripts and turned into SessionInfo.agents (Nocturne B7,
 * .claude/plans/nocturne/PLAN-B7.md). This file: the two pure halves, both
 * hostile-input tests, because every byte here comes from a file this process
 * did not write:
 *   1. subagentsDirFor — THE BOUNDARY. The transcript path arrives in a
 *      snapshot any process running as this user can plant, so the refusals
 *      (relative, `..`, a symlink out of the root, a basename that is not a
 *      uuid, a control character, 1025 characters, a root that is not there)
 *      are what stands between that file and an arbitrary read.
 *   2. foldLine — the per-line fold: one API message is several consecutive
 *      lines repeating the same usage and must be counted ONCE, `end_turn`
 *      ends a turn and a later `user` line un-ends it, and a torn line (the
 *      file is appended to while we read it) is ordinary, not an error. Plus
 *      sameAgents, the change test on the row list.
 *
 * How: in-process calls; subagentsDirFor on real temp directories
 * (`tests/helpers/agents-fixture.ts`).
 *
 * The honesty rule (B1, memory/decisions/pane-status-bar-data-source.md) is
 * pinned throughout: no value the files did not carry — a missing usage adds a
 * real 0, a transcript without a timestamp falls back to the meta file's
 * mtime, never to "now".
 *
 * NOT claimed here: AgentsWatcher — `tests/server/agents-watcher.test.ts`,
 * `tests/server/agents-watcher-polling.test.ts`; the SessionManager wiring —
 * `tests/server/agents-manager.test.ts`; the B11 turn —
 * `tests/server/agents-turn.test.ts`, `tests/server/agents-turn-edges.test.ts`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, symlink } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionAgent } from '../../shared/protocol.ts';
import { foldLine, newFold, sameAgents, subagentsDirFor } from '../../server/agents.ts';
import {
  ESC,
  NUL,
  DEL,
  UUID,
  makeRoot,
  type Usage,
  assistantLine,
  userLine,
} from '../helpers/agents-fixture.ts';

// ---------------------------------------------------------------------------
// subagentsDirFor — the boundary
// ---------------------------------------------------------------------------

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
