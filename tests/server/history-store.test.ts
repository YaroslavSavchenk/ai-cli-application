/**
 * Persistent session history (decided 2026-09-06) — the `SessionHistory`
 * class directly (server/history.ts): the store is bounded at HISTORY_MAX,
 * dropping the oldest ENDED entry and never a live one; list() order; the
 * FIRST end stamp wins; forget refuses a live entry; load() skips unusable
 * records and stamps every ended:null entry crash; pruneUnsaid drops ONLY a
 * uuid-keyed claude conversation with no transcript.
 *
 * How: a SessionHistory over a scratch history.json with its log captured —
 * no server. Every call that can reach pruneUnsaid runs inside
 * `withClaudeConfig`, so nothing stats the user's own ~/.claude.
 *
 * NOT claimed here: the routes and the real resume spawn —
 * `tests/server/history.test.ts`.
 *
 * Split out of `tests/server/history.test.ts` by topic (PLAN-RESTRUCTURE O6);
 * the `claude` double, the server fixture and the unit store are
 * `tests/helpers/history-fixture.ts`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { HistoryEntry, SessionInfo } from '../../shared/protocol.ts';
import { HISTORY_MAX, SessionHistory } from '../../server/history.ts';
import {
  makeTempDir,
} from '../helpers/helpers.ts';
import {
  encodeCwd,
  withClaudeConfig,
  unitStore,
  infoOf,
} from '../helpers/history-fixture.ts';

// ---------------------------------------------------------------------------
// (f) the HISTORY_MAX bound — the class directly, no server involved
// ---------------------------------------------------------------------------

function fakeInfo(n: number): SessionInfo {
  const id = `session-${String(n).padStart(4, '0')}`;
  return {
    id,
    title: `s${n}`,
    command: 'bash',
    args: [],
    cwd: '/tmp',
    status: 'running',
    cols: 80,
    rows: 24,
    // Strictly increasing, so "oldest lastUsedAt" is unambiguous.
    createdAt: new Date(Date.UTC(2026, 0, 1) + n * 1000).toISOString(),
    attention: false,
  };
}

test('history is bounded at HISTORY_MAX: the oldest ENDED entry drops, a live one never does', async () => {
  const root = await makeTempDir('ai-sm-history-unit-');
  const file = join(root, 'history.json');
  const lines: string[] = [];
  const log = (level: string, msg: string): void => void lines.push(`${level} ${msg}`);
  try {
    assert.equal(HISTORY_MAX, 200);
    const store = new SessionHistory(file, log as never);
    store.load();

    // 200 entries; the oldest (n=0) stays LIVE, everything else is ended.
    for (let n = 0; n < HISTORY_MAX; n += 1) {
      const info = fakeInfo(n);
      store.recordCreate(info, { id: info.id, conversation: false, baseArgs: [] });
      if (n > 0) store.markEnded(info.id, 'exit', 0);
    }
    // `list()` prunes first, and the prune resolves CLAUDE_CONFIG_DIR at call
    // time: pointed at `root` (which has no `projects/`) it prunes nothing and,
    // more importantly, never stats the real ~/.claude of whoever runs this.
    const listed = await withClaudeConfig(root, () => store.list());
    assert.equal(listed.length, HISTORY_MAX - 1, 'the live entry is not listed');

    // The 201st entry pushes the OLDEST ENDED one (n=1) out; n=0 is live.
    const extra = fakeInfo(HISTORY_MAX);
    store.recordCreate(extra, { id: extra.id, conversation: false, baseArgs: [] });
    const ids = JSON.parse(await readFile(file, 'utf8')) as HistoryEntry[];
    assert.equal(ids.length, HISTORY_MAX, 'the bound holds on disk');
    assert.ok(ids.some((e) => e.id === 'session-0000'), 'a LIVE entry is never dropped');
    assert.ok(!ids.some((e) => e.id === 'session-0001'), 'the oldest ENDED entry is the victim');
    assert.ok(ids.some((e) => e.id === 'session-0002'), 'the next-oldest survives');
    assert.ok(ids.some((e) => e.id === extra.id), 'the new entry is kept');

    // All-live: nothing may be dropped, even past the bound.
    const allLive = new SessionHistory(join(root, 'live.json'), log as never);
    allLive.load();
    for (let n = 0; n <= HISTORY_MAX; n += 1) {
      const info = fakeInfo(n);
      allLive.recordCreate(info, { id: info.id, conversation: false, baseArgs: [] });
    }
    const live = JSON.parse(await readFile(join(root, 'live.json'), 'utf8')) as HistoryEntry[];
    assert.equal(live.length, HISTORY_MAX + 1, 'live entries are never sacrificed to the bound');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('list() is newest-first even when two entries share a lastUsedAt to the millisecond', async () => {
  // `lastUsedAt` is an ISO string with MILLISECOND resolution, so two sessions
  // created inside the same millisecond tie — and a comparator that answered 0
  // there left the order to the array, which made the newest-first list a coin
  // flip (observed as a 1-in-4 flake in tests/server/lifecycle.test.ts). The entry
  // appended LATER was created later and must sort first.
  const root = await makeTempDir('ai-sm-history-tie-');
  const file = join(root, 'history.json');
  const log = (): void => {};
  try {
    const store = new SessionHistory(file, log as never);
    store.load();
    const at = new Date(Date.UTC(2026, 0, 1)).toISOString();
    for (const n of [1, 2, 3]) {
      const info = { ...fakeInfo(n), createdAt: at };
      store.recordCreate(info, { id: info.id, conversation: false, baseArgs: [] });
      store.markEnded(info.id, 'exit', 0);
    }
    const listed = await withClaudeConfig(root, () => store.list());
    assert.deepEqual(
      listed.map((e) => e.lastUsedAt),
      [at, at, at],
      'non-vacuity: all three really do share the same timestamp',
    );
    assert.deepEqual(
      listed.map((e) => e.id),
      ['session-0003', 'session-0002', 'session-0001'],
      'the entry recorded last sorts first',
    );
    // Deterministic: the same store answers the same order every time.
    const again = await withClaudeConfig(root, () => store.list());
    assert.deepEqual(again.map((e) => e.id), listed.map((e) => e.id));
    // And a real timestamp still beats the tie-break.
    const newer = { ...fakeInfo(0), createdAt: new Date(Date.UTC(2026, 0, 2)).toISOString() };
    store.recordCreate(newer, { id: newer.id, conversation: false, baseArgs: [] });
    store.markEnded(newer.id, 'exit', 0);
    const withNewer = await withClaudeConfig(root, () => store.list());
    assert.equal(withNewer[0]?.id, newer.id, 'lastUsedAt is still the primary key');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (i) SessionHistory stamping / forgetting / boot repair — the class directly
// ---------------------------------------------------------------------------

test('markEnded: the FIRST stamp wins — a later exit never overwrites user-kill, and unknown ids are no-ops', async () => {
  const u = await unitStore('stamp');
  try {
    u.store.load();
    const info = infoOf({ id: 'sess-1', command: 'bash' });
    u.store.recordCreate(info, { id: 'entry-1', conversation: false, baseArgs: [] });

    u.store.markEnded('sess-1', 'user-kill');
    const first = u.store.get('entry-1') as HistoryEntry;
    assert.equal(first.ended?.reason, 'user-kill');
    assert.equal(first.exitCode, undefined, 'a kill records no exit code');
    const stampedAt = first.ended?.at as string;
    assert.equal(new Date(stampedAt).toISOString(), stampedAt, 'ended.at must be ISO-8601');

    // The async onExit that follows every kill must change NOTHING — neither
    // the reason, nor the timestamp, nor the exit code.
    u.store.markEnded('sess-1', 'exit', 0);
    const second = u.store.get('entry-1') as HistoryEntry;
    assert.equal(second.ended?.reason, 'user-kill', 'the exit stamp must be a no-op');
    assert.equal(second.ended?.at, stampedAt, 'the first stamp keeps its timestamp');
    assert.equal(second.exitCode, undefined, 'a no-op stamp must not smuggle in an exit code');

    // Shutdown-then-exit is the same story.
    u.store.recordCreate(infoOf({ id: 'sess-2', command: 'bash' }), {
      id: 'entry-2',
      conversation: false,
      baseArgs: [],
    });
    u.store.endAllLive('shutdown');
    u.store.markEnded('sess-2', 'exit', 137);
    const e2 = u.store.get('entry-2') as HistoryEntry;
    assert.equal(e2.ended?.reason, 'shutdown');
    assert.equal(e2.exitCode, undefined);

    // An unknown session id is a silent no-op, and endAllLive with nothing live
    // must not rewrite the file at all.
    const before = await readFile(u.file, 'utf8');
    u.store.markEnded('no-such-session', 'exit', 1);
    u.store.endAllLive('shutdown');
    assert.equal(await readFile(u.file, 'utf8'), before, 'a no-op must not touch history.json');

    // A natural exit DOES record its code (the positive control for the above).
    u.store.recordCreate(infoOf({ id: 'sess-3', command: 'bash' }), {
      id: 'entry-3',
      conversation: false,
      baseArgs: [],
    });
    u.store.markEnded('sess-3', 'exit', 5);
    assert.equal((u.store.get('entry-3') as HistoryEntry).exitCode, 5);

    // get()/list() hand out COPIES, `ended` included: a caller that mutates
    // what it got must not reach into the store's own entry.
    const copy = u.store.get('entry-3') as HistoryEntry;
    (copy.ended as { reason: string }).reason = 'tampered';
    assert.equal((u.store.get('entry-3') as HistoryEntry).ended?.reason, 'exit');
    const listed = await withClaudeConfig(u.root, () => u.store.list());
    const fromList = listed.find((e) => e.id === 'entry-3') as HistoryEntry;
    (fromList.ended as { reason: string }).reason = 'tampered';
    assert.equal((u.store.get('entry-3') as HistoryEntry).ended?.reason, 'exit');
  } finally {
    await rm(u.root, { recursive: true, force: true });
  }
});

test('forget: an ended entry goes and persists; a LIVE entry is refused; an unknown id is false', async () => {
  const u = await unitStore('forget');
  try {
    u.store.load();
    u.store.recordCreate(infoOf({ id: 'live-session', command: 'bash' }), {
      id: 'live',
      conversation: false,
      baseArgs: [],
    });
    u.store.recordCreate(infoOf({ id: 'dead-session', command: 'bash' }), {
      id: 'dead',
      conversation: false,
      baseArgs: [],
    });
    u.store.markEnded('dead-session', 'exit', 0);

    assert.equal(u.store.forget('live'), false, 'a running session is not forgettable');
    assert.notEqual(u.store.get('live'), undefined, 'the refused entry stays');
    assert.equal(u.store.forget('nope'), false, 'an unknown id is false, not a throw');
    assert.equal(u.store.forget('dead'), true);
    assert.equal(u.store.get('dead'), undefined);
    assert.equal(u.store.forget('dead'), false, 'forgetting twice is false the second time');

    const disk = JSON.parse(await readFile(u.file, 'utf8')) as HistoryEntry[];
    assert.deepEqual(disk.map((e) => e.id), ['live'], 'the removal must persist to history.json');

    // forgetAllEnded keeps the live one.
    u.store.recordCreate(infoOf({ id: 'dead-2-session', command: 'bash' }), {
      id: 'dead-2',
      conversation: false,
      baseArgs: [],
    });
    u.store.markEnded('dead-2-session', 'exit', 0);
    u.store.forgetAllEnded();
    const after = JSON.parse(await readFile(u.file, 'utf8')) as HistoryEntry[];
    assert.deepEqual(after.map((e) => e.id), ['live'], 'forget-all never drops a live entry');
  } finally {
    await rm(u.root, { recursive: true, force: true });
  }
});

test('load(): unusable records are skipped, thin ones get conservative defaults, and every ended:null entry is stamped crash', async () => {
  const u = await unitStore('load');
  try {
    // A real conversation key is UUID-shaped: `conversation: true` is only
    // honoured for one (it reaches `--resume <id>` and a transcript path).
    const COMPLETE_ID = '9f3c2d51-1111-4111-8111-1111111111aa';
    const complete: HistoryEntry = {
      id: COMPLETE_ID,
      conversation: true,
      sessionId: 'session-abc',
      projectId: 'p1',
      cwd: '/home/you/projects/web-ui',
      command: 'claude',
      args: ['--model', 'opus'],
      title: 'Web UI',
      createdAt: '2026-09-01T10:00:00.000Z',
      lastUsedAt: '2026-09-05T10:00:00.000Z',
      ended: { at: '2026-09-05T11:00:00.000Z', reason: 'exit' },
      exitCode: 3,
    };
    const raw = [
      complete,
      // Left live by a previous run -> 'crash' at boot.
      { ...complete, id: 'was-live', sessionId: 'session-live', ended: null, exitCode: undefined },
      // Unusable: each is missing or malforms a field a resume depends on.
      { conversation: true, command: 'bash', cwd: '/tmp', args: [] }, // no id
      { id: '', command: 'bash', cwd: '/tmp', args: [] }, // empty id
      { id: 'no-command', cwd: '/tmp', args: [] },
      { id: 'empty-command', command: '', cwd: '/tmp', args: [] },
      { id: 'no-cwd', command: 'bash', args: [] },
      { id: 'bad-args', command: 'bash', cwd: '/tmp', args: [1, 2] },
      { id: 'no-args', command: 'bash', cwd: '/tmp' },
      null,
      42,
      'a string',
      ['an array'],
      // Everything optional missing: the defaults must be conservative.
      { id: 'thin', command: '/usr/bin/claude', cwd: '/tmp/x', args: ['--model', 'opus'] },
      // A half-written `ended` is not an end at all -> crash-stamped.
      { id: 'bad-ended', command: 'bash', cwd: '/tmp', args: [], ended: { at: 123 } },
      // Hand-edited: claims a conversation under an id `--resume` could never
      // target. Usable, but the claim is coerced away.
      { id: 'not-a-uuid', conversation: true, command: 'claude', cwd: '/tmp', args: [] },
    ];
    await writeFile(u.file, JSON.stringify(raw, null, 2), { mode: 0o600 });

    u.store.load();

    assert.ok(
      u.lines.some((l) => l.includes('11 unusable entries ignored')),
      `the skipped records must be logged, got: ${u.lines.join(' | ')}`,
    );
    assert.ok(
      u.lines.some((l) => l === "info history loaded: 5 entries (4 stamped 'crash')"),
      `boot must log the load, got: ${u.lines.join(' | ')}`,
    );

    const disk = JSON.parse(await readFile(u.file, 'utf8')) as HistoryEntry[];
    assert.deepEqual(
      disk.map((e) => e.id),
      [COMPLETE_ID, 'was-live', 'thin', 'bad-ended', 'not-a-uuid'],
      'only the usable records survive, in file order',
    );

    // An intact entry survives byte for byte.
    assert.deepEqual(disk[0], complete);

    // The thin record's defaults.
    const thin = disk[2] as HistoryEntry;
    assert.equal(thin.conversation, false, 'conversation defaults to false — never claim a resume target');
    // The gate, not the default: `conversation: true` on a non-uuid id is a
    // claim we must not honour — resumeSpawn would emit `--resume not-a-uuid`.
    assert.equal(
      (disk[4] as HistoryEntry).conversation,
      false,
      'conversation is coerced to false unless the id is UUID-shaped',
    );
    assert.equal(disk[0]?.conversation, true, 'a UUID-keyed conversation is still honoured');
    assert.equal(thin.sessionId, 'thin', 'sessionId falls back to the entry id');
    assert.equal(thin.title, 'x', 'the title falls back to basename(cwd) — never the command word');
    assert.notEqual(thin.title, 'claude', 'a repaired record never names its command');
    assert.equal(thin.createdAt, new Date(0).toISOString());
    assert.equal(thin.lastUsedAt, thin.createdAt, 'lastUsedAt falls back to createdAt');
    assert.equal(thin.projectId, undefined);
    assert.equal(thin.exitCode, undefined);
    assert.deepEqual(thin.args, ['--model', 'opus'], 'the args a resume needs survive');

    // All three repairs carry the SAME boot timestamp and the crash reason.
    const crashed = [disk[1], disk[2], disk[3], disk[4]] as HistoryEntry[];
    for (const e of crashed) {
      assert.equal(e.ended?.reason, 'crash', `${e.id} must be stamped crash`);
      const at = e.ended?.at as string;
      assert.equal(new Date(at).toISOString(), at, 'ended.at must be ISO-8601');
    }
    assert.equal(crashed[0]?.ended?.at, crashed[1]?.ended?.at, 'one boot, one timestamp');
    assert.equal(crashed[1]?.ended?.at, crashed[2]?.ended?.at);

    // A second load is idempotent: nothing is live any more, so nothing is
    // re-stamped and the reasons stay what they were.
    const store2 = new SessionHistory(u.file, ((): void => {}) as never);
    store2.load();
    const disk2 = JSON.parse(await readFile(u.file, 'utf8')) as HistoryEntry[];
    assert.deepEqual(disk2, disk, 'a second boot must not change a repaired file');
  } finally {
    await rm(u.root, { recursive: true, force: true });
  }
});

test('pruneUnsaid drops ONLY a uuid-keyed claude conversation with no transcript — every uncertainty keeps the entry', async () => {
  const u = await unitStore('prune');
  const config = join(u.root, 'claude-config');
  // REAL directories: the prune canonicalizes the cwd with realpath, because
  // Claude Code names the transcript directory from the CHILD's process.cwd()
  // — the physical, normalized path, not the string we stored.
  const root = await realpath(u.root);
  const cwd = join(root, 'work');
  const linkedCwd = join(root, 'linked-work'); // symlink -> cwd
  const trailingCwd = `${cwd}/`; // same folder, different string
  const longCwd = join(root, 'a'.repeat(210));
  await mkdir(cwd);
  await mkdir(longCwd);
  await symlink(cwd, linkedCwd);
  const UUID = (n: string): string => `${n.repeat(8)}-1111-4111-8111-111111111111`;
  const withTranscript = UUID('1');
  const noTranscript = UUID('2');
  const notClaude = UUID('3');
  const stillLive = UUID('4');
  const notAConversation = UUID('5');
  const longPath = UUID('6');
  const viaSymlink = UUID('7');
  const viaTrailingSlash = UUID('8');
  try {
    u.store.load();
    const add = (
      key: string,
      over: Partial<SessionInfo>,
      opts: { conversation?: boolean; live?: boolean } = {},
    ): void => {
      const info = infoOf({ id: `s-${key}`, cwd, ...over });
      u.store.recordCreate(info, {
        id: key,
        conversation: opts.conversation ?? true,
        baseArgs: [],
      });
      if (opts.live !== true) u.store.markEnded(info.id, 'exit', 0);
    };
    add(withTranscript, {});
    add(noTranscript, {});
    add(notClaude, { command: 'bash' });
    add(stillLive, {}, { live: true });
    add(notAConversation, {}, { conversation: false });
    add(longPath, { cwd: longCwd });
    add('not-a-uuid-key', {});
    add(viaSymlink, { cwd: linkedCwd });
    add(viaTrailingSlash, { cwd: trailingCwd });

    // (1) No `projects/` directory at all: Claude's home was not found, so
    // NOTHING may be pruned — not even the entry that has no transcript.
    await withClaudeConfig(config, () => u.store.pruneUnsaid());
    assert.equal(
      (JSON.parse(await readFile(u.file, 'utf8')) as HistoryEntry[]).length,
      9,
      'without a projects/ directory the prune must be a no-op',
    );

    // (1b) `projects/` exists but holds NO per-cwd directory — what a change to
    // Claude Code's per-cwd naming scheme would look like from here. Our
    // encoding is then unproven, so the answer is UNKNOWN and NOTHING is
    // pruned: a whole history must never be wiped from inside a GET.
    await mkdir(join(config, 'projects'), { recursive: true });
    await withClaudeConfig(config, () => u.store.pruneUnsaid());
    assert.equal(
      (JSON.parse(await readFile(u.file, 'utf8')) as HistoryEntry[]).length,
      9,
      'an empty projects/ (no per-cwd directory) must prune nothing',
    );

    // (2) The per-cwd directory exists, holding a transcript for the entries
    // that said something. The symlinked cwd ALSO gets an (empty) directory
    // under its own un-canonicalized encoding: the prune must never look there,
    // or the symlinked entry would read as transcript-less and be destroyed.
    const realDir = join(config, 'projects', encodeCwd(cwd));
    await mkdir(realDir, { recursive: true });
    await mkdir(join(config, 'projects', encodeCwd(linkedCwd)), { recursive: true });
    for (const id of [withTranscript, viaSymlink, viaTrailingSlash]) {
      await writeFile(join(realDir, `${id}.jsonl`), '{}\n');
    }

    const listed = await withClaudeConfig(config, () => u.store.list());
    assert.deepEqual(
      listed.map((e) => e.id).sort(),
      [
        notAConversation,
        notClaude,
        withTranscript,
        longPath,
        viaSymlink,
        viaTrailingSlash,
        'not-a-uuid-key',
      ].sort(),
      'only the transcript-less claude conversation may be dropped',
    );
    assert.ok(
      listed.some((e) => e.id === viaSymlink),
      'a symlinked cwd resolves to the transcript under its realpath — never pruned',
    );
    assert.ok(
      listed.some((e) => e.id === viaTrailingSlash),
      'a trailing-slash cwd normalizes to the same folder — never pruned',
    );
    assert.ok(
      listed.every((e) => e.id !== stillLive),
      'a live entry is never listed (and was never a prune candidate)',
    );
    assert.notEqual(u.store.get(stillLive), undefined, 'the live entry is still in the store');

    const disk = JSON.parse(await readFile(u.file, 'utf8')) as HistoryEntry[];
    assert.ok(!disk.some((e) => e.id === noTranscript), 'the prune must persist');
    assert.equal(disk.length, 8);
    assert.ok(
      u.lines.some((l) => l === 'info history pruned: 1 claude conversation(s) with no transcript'),
      `the prune must be logged, got: ${u.lines.join(' | ')}`,
    );

    // (3) Idempotent: a second prune has nothing left to drop and reports
    // nothing. DEBUG lines are excluded: since the comprehensive-logging pass
    // (2026-09-06) every prune call writes a `prune checked N candidate(s),
    // pruned M` summary at debug, plus one debug line per PRUNE verdict (a KEPT
    // entry gets none). What must stay silent is the info/warn/error channel:
    // no summary line when there was no victim.
    const reportable = (): string[] => u.lines.filter((l) => !l.startsWith('debug '));
    const linesBefore = reportable().length;
    await withClaudeConfig(config, () => u.store.pruneUnsaid());
    assert.equal(reportable().length, linesBefore, 'a prune with no victims must be silent');
    assert.equal((JSON.parse(await readFile(u.file, 'utf8')) as HistoryEntry[]).length, 8);

    // (4) A cwd that no longer exists cannot be canonicalized -> UNKNOWN -> the
    // entry stays, transcript or not.
    await rm(cwd, { recursive: true, force: true });
    await withClaudeConfig(config, () => u.store.pruneUnsaid());
    assert.equal(
      (JSON.parse(await readFile(u.file, 'utf8')) as HistoryEntry[]).length,
      8,
      'an unresolvable cwd keeps its entry',
    );
  } finally {
    await rm(u.root, { recursive: true, force: true });
  }
});
