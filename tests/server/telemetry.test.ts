/**
 * server/telemetry.ts — the snapshot the status-line script leaves on disk,
 * turned into SessionInfo.telemetry for the pane status bar (Nocturne B1).
 *
 * Two halves, both hostile-input tests:
 *   1. parseSnapshot — the file is written by a FOREIGN process into a
 *      directory any process running as this user can write, and what it
 *      carries ends up on screen. So the honesty rule (no zero-as-unknown) and
 *      the sanitising (controls stripped, 64-cap, finite and clamped numbers,
 *      one schema version, unknown keys dropped) are pinned here.
 *   2. TelemetryWatcher — a real directory, real files, real fs.watch: only a
 *      filename that IS a session id is ever acted on, a file that vanished is
 *      skipped, stop() really detaches, and a directory that cannot be watched
 *      falls back to polling instead of going silent.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionTelemetry } from '../../shared/protocol.ts';
import {
  parseSnapshot,
  sameTelemetry,
  TelemetryWatcher,
  transcriptFromSnapshot,
} from '../../server/telemetry.ts';

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const DEL = String.fromCharCode(127);

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The fallback poll interval in server/telemetry.ts (not exported; kept in step here). */
const POLL_MS = 2_000;

/** A fixed mtime (whole seconds, so it survives utimes exactly) for the poll test. */
const PINNED_MTIME_S = 1_700_000_000;

/** parseSnapshot on an object, the way the watcher sees it (as text). */
function parse(value: unknown): SessionTelemetry | null {
  return parseSnapshot(JSON.stringify(value));
}

// ---------------------------------------------------------------------------
// parseSnapshot
// ---------------------------------------------------------------------------

test('parseSnapshot: a full snapshot becomes telemetry, with `at` as ISO-8601', () => {
  const at = Date.UTC(2026, 8, 17, 10, 30, 0);
  const result = parse({
    v: 1,
    at,
    model: 'Opus 5',
    branch: 'main',
    cost: 0.42,
    linesAdded: 128,
    linesRemoved: 41,
    context: 62,
    usage5h: 38,
    usage7d: 12,
  });
  assert.deepEqual(result, {
    at: '2026-09-17T10:30:00.000Z',
    model: 'Opus 5',
    branch: 'main',
    costUsd: 0.42,
    linesAdded: 128,
    linesRemoved: 41,
    contextPct: 62,
    usage5hPct: 38,
    usage7dPct: 12,
  });
});

test('parseSnapshot: only `at` is required — an empty report is still a report', () => {
  const result = parse({ v: 1, at: 1_726_560_000_000 });
  assert.deepEqual(result, { at: '2024-09-17T08:00:00.000Z' });
});

test('parseSnapshot: unknown keys are dropped, never carried through', () => {
  const result = parse({
    v: 1,
    at: 1_726_560_000_000,
    model: 'Opus 5',
    sessionId: 'not ours',
    transcript_path: '/home/you/.claude/projects/p/x.jsonl',
    __proto__: { polluted: true },
    nested: { a: 1 },
  });
  assert.deepEqual(Object.keys(result as SessionTelemetry).sort(), ['at', 'model']);
  assert.equal(({} as Record<string, unknown>)['polluted'], undefined, 'no prototype pollution');
});

test('parseSnapshot: strings are control-stripped, whitespace-collapsed and capped at 64', () => {
  const result = parse({
    v: 1,
    at: 1_726_560_000_000,
    model: `Opus${ESC}[31m 5${BEL}${DEL}`,
    branch: `feature/${'x'.repeat(80)}`,
  });
  assert.equal(result?.model, 'Opus [31m 5');
  assert.doesNotMatch(result?.model as string, /\p{Cc}/u);
  assert.equal((result?.branch as string).length, 64);
  assert.equal(result?.branch, `feature/${'x'.repeat(56)}`);
});

test('parseSnapshot: a string that cleans to nothing leaves the key ABSENT, not empty', () => {
  const result = parse({ v: 1, at: 1_726_560_000_000, model: `  ${ESC}${BEL} `, branch: '' });
  assert.deepEqual(result, { at: '2024-09-17T08:00:00.000Z' });
});

test('parseSnapshot: a non-string where a string belongs is no value at all', () => {
  const result = parse({ v: 1, at: 1_726_560_000_000, model: 42, branch: ['main'] });
  assert.deepEqual(result, { at: '2024-09-17T08:00:00.000Z' });
});

test('parseSnapshot: cost is honest — 0, negative, absurd and non-numeric report nothing', () => {
  const at = 1_726_560_000_000;
  assert.equal(parse({ v: 1, at, cost: 0 })?.costUsd, undefined, '0 is real but says nothing');
  assert.equal(parse({ v: 1, at, cost: -1 })?.costUsd, undefined);
  assert.equal(parse({ v: 1, at, cost: 1e9 })?.costUsd, undefined, 'not a session spend');
  assert.equal(parse({ v: 1, at, cost: '0.42' })?.costUsd, undefined);
  assert.equal(parse({ v: 1, at, cost: null })?.costUsd, undefined);
  // Infinity survives JSON.parse as 1e999; it must not survive this.
  assert.equal(parseSnapshot(`{"v":1,"at":${at},"cost":1e999}`)?.costUsd, undefined);
  assert.equal(parse({ v: 1, at, cost: 0.004 })?.costUsd, 0.004, 'a real fraction of a cent is kept');
});

test('parseSnapshot: the lines pair travels together and only when there IS an edit', () => {
  const at = 1_726_560_000_000;
  const none = parse({ v: 1, at, linesAdded: 0, linesRemoved: 0 });
  assert.equal(Object.hasOwn(none as SessionTelemetry, 'linesAdded'), false);
  assert.equal(Object.hasOwn(none as SessionTelemetry, 'linesRemoved'), false);

  const removedOnly = parse({ v: 1, at, linesAdded: 0, linesRemoved: 12 });
  assert.equal(removedOnly?.linesAdded, 0, 'the pair is complete: +0 -12 is a true statement');
  assert.equal(removedOnly?.linesRemoved, 12);

  const messy = parse({ v: 1, at, linesAdded: 3.9, linesRemoved: -5 });
  assert.equal(messy?.linesAdded, 3, 'integers only');
  assert.equal(messy?.linesRemoved, 0, 'a negative count is not an edit');

  const huge = parse({ v: 1, at, linesAdded: 1e300, linesRemoved: 0 });
  assert.equal(huge?.linesAdded, 1_000_000_000, 'clamped, never rendered as 1e300');
});

test('parseSnapshot: percentages are 0-100 integers, whatever the file says', () => {
  const at = 1_726_560_000_000;
  assert.equal(parse({ v: 1, at, context: 62.9 })?.contextPct, 62);
  assert.equal(parse({ v: 1, at, context: 140 })?.contextPct, 100);
  assert.equal(parse({ v: 1, at, context: -20 })?.contextPct, 0);
  assert.equal(parse({ v: 1, at, context: '62' })?.contextPct, undefined);
  assert.equal(parse({ v: 1, at, context: null })?.contextPct, undefined);
  assert.equal(parse({ v: 1, at, usage5h: 99.99, usage7d: 0 })?.usage5hPct, 99);
  assert.equal(parse({ v: 1, at, usage5h: 99.99, usage7d: 0 })?.usage7dPct, 0, '0 % of the week is a fact');
  // Infinity is not a percentage; it is no value at all.
  assert.equal(parseSnapshot(`{"v":1,"at":${at},"usage5h":1e999}`)?.usage5hPct, undefined);
});

test('parseSnapshot: `at` must be a believable ms epoch or the whole snapshot is refused', () => {
  assert.equal(parse({ v: 1 }), null, 'no stamp at all');
  assert.equal(parse({ v: 1, at: -1 }), null);
  assert.equal(parse({ v: 1, at: 1e15 }), null, 'past year 3000');
  assert.equal(parse({ v: 1, at: '1726560000000' }), null);
  assert.equal(parseSnapshot('{"v":1,"at":1e999}'), null);
  assert.notEqual(parse({ v: 1, at: 0 }), null, 'the epoch itself is believable');
});

test('parseSnapshot: one schema version, and nothing that is not an object', () => {
  const at = 1_726_560_000_000;
  assert.equal(parse({ v: 2, at }), null);
  assert.equal(parse({ v: '1', at }), null);
  assert.equal(parse({ at }), null, 'no version is not version 1');
  assert.equal(parseSnapshot('[{"v":1,"at":1}]'), null, 'an array is not a snapshot');
  assert.equal(parseSnapshot('null'), null);
  assert.equal(parseSnapshot('"v1"'), null);
  assert.equal(parseSnapshot('7'), null);
  assert.equal(parseSnapshot(''), null);
  assert.equal(parseSnapshot('{"v":1,"at":1726560000000'), null, 'truncated mid-write');
  assert.equal(parseSnapshot('not json at all'), null);
});

test('parseSnapshot: anything over 8 KiB is refused unparsed', () => {
  const at = 1_726_560_000_000;
  // Valid JSON, valid schema, and far too big to be a snapshot: the padding
  // lives in a key we would drop anyway, so only the SIZE can reject it.
  const big = JSON.stringify({ v: 1, at, model: 'Opus 5', pad: 'p'.repeat(9_000) });
  assert.ok(big.length > 8 * 1024);
  assert.equal(parseSnapshot(big), null);
  const justUnder = JSON.stringify({ v: 1, at, model: 'Opus 5', pad: 'p'.repeat(7_000) });
  assert.ok(justUnder.length < 8 * 1024);
  assert.equal(parseSnapshot(justUnder)?.model, 'Opus 5');
});

// ---------------------------------------------------------------------------
// transcriptFromSnapshot (Nocturne B7) — the same file, a second fact
// ---------------------------------------------------------------------------

/** transcriptFromSnapshot on an object, the way the watcher sees it (as text). */
function transcriptOf(value: unknown): string | undefined {
  return transcriptFromSnapshot(JSON.stringify(value));
}

test('transcriptFromSnapshot: the key comes back exactly as written — it is a PATH', () => {
  const path = '/home/u/.claude/projects/-home-u-p/0f2a5c8e-1b3d-4f60-9a77-2c1e5b8d4a09.jsonl';
  assert.equal(transcriptOf({ v: 1, at: 1, transcript: path }), path);
  // Spaces are legal in a path and survive: clean()'s collapsing would name a
  // different file.
  assert.equal(transcriptOf({ v: 1, at: 1, transcript: '/a/my  dir/x.jsonl' }), '/a/my  dir/x.jsonl');
});

test('transcriptFromSnapshot: telemetry and the transcript never leak into each other', () => {
  const text = JSON.stringify({ v: 1, at: 1_726_560_000_000, model: 'Opus 5', transcript: '/a/b.jsonl' });
  // parseSnapshot keeps dropping the key it does not know...
  assert.deepEqual(parseSnapshot(text), { at: '2024-09-17T08:00:00.000Z', model: 'Opus 5' });
  // ...and this one reads only the key parseSnapshot drops.
  assert.equal(transcriptFromSnapshot(text), '/a/b.jsonl');
});

test('transcriptFromSnapshot: no key, no snapshot, no version -> undefined', () => {
  assert.equal(transcriptOf({ v: 1, at: 1 }), undefined);
  assert.equal(transcriptOf({ v: 2, at: 1, transcript: '/a/b.jsonl' }), undefined, 'one schema version');
  assert.equal(transcriptOf([{ v: 1, transcript: '/a/b.jsonl' }]), undefined, 'an array is not a snapshot');
  assert.equal(transcriptFromSnapshot('not json at all'), undefined);
  assert.equal(transcriptFromSnapshot(''), undefined);
});

test('transcriptFromSnapshot: a non-string, an empty string and 1025 characters are refused', () => {
  assert.equal(transcriptOf({ v: 1, at: 1, transcript: 12345 }), undefined);
  assert.equal(transcriptOf({ v: 1, at: 1, transcript: { path: '/a/b.jsonl' } }), undefined);
  assert.equal(transcriptOf({ v: 1, at: 1, transcript: ['/a/b.jsonl'] }), undefined);
  assert.equal(transcriptOf({ v: 1, at: 1, transcript: null }), undefined);
  assert.equal(transcriptOf({ v: 1, at: 1, transcript: '' }), undefined);
  assert.equal(transcriptOf({ v: 1, at: 1, transcript: `/${'a'.repeat(1023)}` })?.length, 1024, 'exactly 1024 is fine');
  assert.equal(transcriptOf({ v: 1, at: 1, transcript: `/${'a'.repeat(1024)}` }), undefined, '1025 is not');
});

test('transcriptFromSnapshot: a control character anywhere in the path refuses the whole value', () => {
  for (const bad of [`${ESC}[31m/a/b.jsonl`, `/a/${BEL}b.jsonl`, `/a/b.jsonl${DEL}`, '/a/b\u0000.jsonl', '/a/b\n.jsonl']) {
    assert.equal(transcriptOf({ v: 1, at: 1, transcript: bad }), undefined, JSON.stringify(bad));
  }
});

test('transcriptFromSnapshot: anything over 8 KiB is refused unparsed', () => {
  const huge = JSON.stringify({ v: 1, at: 1, transcript: '/a/b.jsonl', pad: 'x'.repeat(9_000) });
  assert.equal(transcriptFromSnapshot(huge), undefined);
});

test('sameTelemetry: every field counts, including the stamp', () => {
  const base: SessionTelemetry = { at: '2026-09-17T10:30:00.000Z', model: 'Opus 5', costUsd: 0.42 };
  assert.equal(sameTelemetry(base, { ...base }), true);
  assert.equal(sameTelemetry(base, { ...base, costUsd: 0.43 }), false);
  assert.equal(sameTelemetry(base, { ...base, at: '2026-09-17T10:30:01.000Z' }), false);
  assert.equal(sameTelemetry(base, { at: base.at, model: 'Opus 5' }), false, 'a dropped key is a change');
  assert.equal(sameTelemetry(undefined, base), false);
  assert.equal(sameTelemetry(undefined, undefined), true);
});

// ---------------------------------------------------------------------------
// TelemetryWatcher
// ---------------------------------------------------------------------------

interface Seen {
  id: string;
  telemetry: SessionTelemetry;
  transcript: string | undefined;
}

/** A watcher on a fresh temp directory, recording everything it reports. */
async function makeWatcher(opts: { create?: boolean } = {}): Promise<{
  dir: string;
  seen: Seen[];
  logs: string[];
  watcher: TelemetryWatcher;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), 'ai-sm-telemetry-'));
  const dir = join(root, 'statusline-snapshots');
  if (opts.create !== false) await mkdir(dir, { recursive: true, mode: 0o700 });
  const seen: Seen[] = [];
  const logs: string[] = [];
  const watcher = new TelemetryWatcher(dir, (level, message) => logs.push(`${level}: ${message}`));
  return {
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

/** Write a snapshot the way the script does (atomically, so the watcher sees one file). */
async function writeSnapshot(dir: string, name: string, body: unknown): Promise<void> {
  const file = join(dir, name);
  await writeFile(`${file}.tmp`, typeof body === 'string' ? body : JSON.stringify(body), { mode: 0o600 });
  const { rename } = await import('node:fs/promises');
  await rename(`${file}.tmp`, file);
}

/** Wait until `seen` holds at least `count` entries, or fail after `ms`. */
async function waitForSeen(seen: Seen[], count: number, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (seen.length < count) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${count} telemetry callback(s), got ${seen.length}`);
    }
    await delay(25);
  }
}

test('watcher: a snapshot appearing in the directory is reported with its session id', async () => {
  const w = await makeWatcher();
  try {
    w.watcher.start((id, telemetry, transcript) => w.seen.push({ id, telemetry, transcript }));
    const id = '0f2a5c8e-1b3d-4f60-9a77-2c1e5b8d4a09';
    await writeSnapshot(w.dir, `${id}.json`, {
      v: 1,
      at: Date.UTC(2026, 8, 17, 10, 30, 0),
      model: 'Opus 5',
      branch: 'main',
      cost: 0.42,
      context: 62,
    });
    await waitForSeen(w.seen, 1);
    assert.equal(w.seen[0]?.id, id, 'the id is the filename, and nothing else');
    assert.deepEqual(w.seen[0]?.telemetry, {
      at: '2026-09-17T10:30:00.000Z',
      model: 'Opus 5',
      branch: 'main',
      costUsd: 0.42,
      contextPct: 62,
    });

    // A second, different write is reported again.
    await writeSnapshot(w.dir, `${id}.json`, { v: 1, at: Date.UTC(2026, 8, 17, 10, 31, 0), cost: 0.99 });
    await waitForSeen(w.seen, 2);
    assert.equal(w.seen[1]?.telemetry.costUsd, 0.99);
  } finally {
    await w.cleanup();
  }
});

test('watcher: a filename that is not a session id NEVER reaches the callback', async () => {
  const w = await makeWatcher();
  try {
    w.watcher.start((id, telemetry, transcript) => w.seen.push({ id, telemetry, transcript }));
    const body = { v: 1, at: Date.now(), model: 'Opus 5' };
    // Every one of these is a real file in the watched directory, and not one
    // of them is a session id: a space, a dot segment, a leading dash, the
    // wrong extension, a too-long name, a nested file, the script's own tmp.
    for (const name of [
      'a b.json',
      '..json',
      '.hidden.json',
      '-leading.json',
      'x.txt',
      'sess.json.bak',
      `${'x'.repeat(65)}.json`,
      'a.b.json',
    ]) {
      await writeFile(join(w.dir, name), JSON.stringify(body), { mode: 0o600 });
    }
    await mkdir(join(w.dir, 'nested'), { recursive: true });
    await writeFile(join(w.dir, 'nested', 'sess-1.json'), JSON.stringify(body));
    // A file one level UP, i.e. what a `../x.json` event would aim at.
    await writeFile(join(w.dir, '..', 'escape.json'), JSON.stringify(body));

    // Give the watcher far longer than its debounce to do the wrong thing.
    await delay(600);
    assert.equal(w.seen.length, 0, 'nothing was joined into a path or parsed');

    // And a legitimate name in the same directory still works, so the test
    // cannot pass because the watcher is simply dead.
    await writeSnapshot(w.dir, 'sess-1.json', body);
    await waitForSeen(w.seen, 1);
    assert.equal(w.seen[0]?.id, 'sess-1');
  } finally {
    await w.cleanup();
  }
});

test('watcher: a file that vanished (its session ended) is skipped silently', async () => {
  const w = await makeWatcher();
  try {
    w.watcher.start((id, telemetry, transcript) => w.seen.push({ id, telemetry, transcript }));
    const gone = join(w.dir, 'sess-gone.json');
    await writeFile(gone, JSON.stringify({ v: 1, at: Date.now(), model: 'Opus 5' }));
    // Removed inside the debounce window: the read finds nothing.
    await unlink(gone);
    await delay(600);
    assert.deepEqual(w.seen, [], 'no callback for a session that is already gone');
    assert.equal(w.logs.some((l) => l.startsWith('error: ')), false, 'and nothing louder than debug');
  } finally {
    await w.cleanup();
  }
});

test('watcher: garbage in the directory is ignored, and the watcher keeps working', async () => {
  const w = await makeWatcher();
  try {
    w.watcher.start((id, telemetry, transcript) => w.seen.push({ id, telemetry, transcript }));
    await writeSnapshot(w.dir, 'sess-bad.json', 'not json at all');
    await writeSnapshot(w.dir, 'sess-v2.json', { v: 2, at: Date.now() });
    await delay(600);
    assert.equal(w.seen.length, 0, 'neither a broken file nor a future schema is acted on');
    await writeSnapshot(w.dir, 'sess-good.json', { v: 1, at: Date.now(), model: 'Opus 5' });
    await waitForSeen(w.seen, 1);
    assert.equal(w.seen[0]?.id, 'sess-good');
  } finally {
    await w.cleanup();
  }
});

test('watcher: stop() detaches — a write afterwards is never reported', async () => {
  const w = await makeWatcher();
  try {
    w.watcher.start((id, telemetry, transcript) => w.seen.push({ id, telemetry, transcript }));
    await writeSnapshot(w.dir, 'sess-1.json', { v: 1, at: Date.now(), model: 'Opus 5' });
    await waitForSeen(w.seen, 1);

    w.watcher.stop();
    await writeSnapshot(w.dir, 'sess-2.json', { v: 1, at: Date.now(), model: 'Sonnet 5' });
    await delay(500);
    assert.equal(w.seen.length, 1, 'a stopped watcher reports nothing');
    w.watcher.stop(); // Idempotent.
  } finally {
    await w.cleanup();
  }
});

test('watcher: a write still in flight when stop() lands is dropped, not delivered late', async () => {
  const w = await makeWatcher();
  try {
    w.watcher.start((id, telemetry, transcript) => w.seen.push({ id, telemetry, transcript }));
    await writeSnapshot(w.dir, 'sess-1.json', { v: 1, at: Date.now(), model: 'Opus 5' });
    // Inside the ~150 ms debounce: the pending timer must be cleared by stop().
    await delay(20);
    w.watcher.stop();
    await delay(500);
    assert.deepEqual(w.seen, []);
  } finally {
    await w.cleanup();
  }
});

test('watcher: a directory fs.watch cannot take falls back to polling and catches up', async () => {
  // start() on a directory that does not exist yet: inotify refuses, so the
  // 2 s readdir+mtime poll takes over — and picks the file up once the
  // directory appears (the standby ordering makes this a real case).
  const w = await makeWatcher({ create: false });
  try {
    w.watcher.start((id, telemetry, transcript) => w.seen.push({ id, telemetry, transcript }));
    assert.ok(
      w.logs.some((l) => l.startsWith('debug: [telemetry] cannot watch ')),
      `the fallback is announced at debug, got ${JSON.stringify(w.logs)}`,
    );
    await mkdir(w.dir, { recursive: true, mode: 0o700 });
    const file = join(w.dir, 'sess-polled.json');
    await writeSnapshot(w.dir, 'sess-polled.json', { v: 1, at: Date.now(), model: 'Opus 5' });
    // A pinned mtime, to the second: the poll compares mtimeMs, and two writes
    // a real session makes can land in the same millisecond too.
    await utimes(file, PINNED_MTIME_S, PINNED_MTIME_S);
    await waitForSeen(w.seen, 1, 8_000);
    assert.equal(w.seen[0]?.id, 'sess-polled');
    assert.equal(w.seen[0]?.telemetry.model, 'Opus 5');

    // The session ends and its file goes. The poll pass must FORGET the id, or
    // a later file carrying that same mtime reads as "unchanged" forever and
    // the bar never updates again.
    await unlink(file);
    await delay(POLL_MS + 500); // One full pass with the file absent.
    await writeSnapshot(w.dir, 'sess-polled.json', { v: 1, at: Date.now(), model: 'Sonnet 5' });
    await utimes(file, PINNED_MTIME_S, PINNED_MTIME_S);
    const deadline = Date.now() + 8_000;
    while (!w.seen.some((s) => s.telemetry.model === 'Sonnet 5')) {
      if (Date.now() >= deadline) {
        throw new Error(`the session that came back was never reported: ${JSON.stringify(w.seen)}`);
      }
      await delay(50);
    }
  } finally {
    await w.cleanup();
  }
});

// ---------------------------------------------------------------------------
// TelemetryWatcher — what #read REFUSES
//
// The snapshot directory is an ordinary 0700 directory in the data dir, which
// on this WSL setup is not a boundary (memory/knowledge/wsl-0600-not-a-boundary
// .md): any process running as this user, and Windows itself, can put whatever
// it likes at `<dir>/<id>.json`. The three things that are NOT a snapshot —
// a symlink, a FIFO, and a file too big to be one — must each end as a skipped
// read, with the watcher still alive afterwards.
// ---------------------------------------------------------------------------

test('watcher #read: a SYMLINK named like a snapshot is refused, never followed', async () => {
  const w = await makeWatcher();
  try {
    w.watcher.start((id, telemetry, transcript) => w.seen.push({ id, telemetry, transcript }));
    // A perfectly valid snapshot, OUTSIDE the watched directory. Following the
    // link would read a file the session never wrote — the whole point of
    // O_NOFOLLOW is that this content can never reach SessionInfo.
    const outside = join(w.dir, '..', 'not-a-snapshot.json');
    await writeFile(outside, JSON.stringify({ v: 1, at: Date.now(), model: 'Planted' }), { mode: 0o600 });
    await symlink(outside, join(w.dir, 'sess-link.json'));

    await delay(600); // Far past the 150 ms debounce.
    assert.equal(w.seen.length, 0, 'a symlink is not a snapshot, whatever it points at');

    // Control: the watcher is not simply dead.
    await writeSnapshot(w.dir, 'sess-real.json', { v: 1, at: Date.now(), model: 'Opus 5' });
    await waitForSeen(w.seen, 1);
    assert.equal(w.seen[0]?.id, 'sess-real');
    assert.equal(w.seen[0]?.telemetry.model, 'Opus 5');
  } finally {
    await w.cleanup();
  }
});

test('watcher #read: a file bigger than 8 KiB is refused, and never parsed', async () => {
  const w = await makeWatcher();
  try {
    w.watcher.start((id, telemetry, transcript) => w.seen.push({ id, telemetry, transcript }));
    // Valid JSON, valid schema, ~9 KiB: a real snapshot is ~150 bytes, so this
    // is someone filling the bar's read buffer, not a session reporting.
    const big = JSON.stringify({ v: 1, at: Date.now(), model: 'Opus 5', pad: 'x'.repeat(9 * 1024) });
    await writeSnapshot(w.dir, 'sess-big.json', big);
    await delay(600);
    assert.equal(w.seen.length, 0, 'over the cap is refused, not truncated into something plausible');

    await writeSnapshot(w.dir, 'sess-small.json', { v: 1, at: Date.now(), model: 'Opus 5' });
    await waitForSeen(w.seen, 1);
    assert.equal(w.seen[0]?.id, 'sess-small');
  } finally {
    await w.cleanup();
  }
});

/**
 * The FIFO case runs the watcher in a CHILD process on purpose.
 *
 * `openSync(fifo, O_RDONLY)` waits for a writer — forever, synchronously, on
 * the thread that runs everything. If the refusal does not hold, the process
 * running the watcher stops answering anything at all, so testing it in-process
 * would HANG the suite instead of failing it. The child prints one line per
 * event and is killed if it goes quiet.
 */
function probeFifoWatcher(dir: string, timeoutMs = 10_000): Promise<{ lines: string[]; timedOut: boolean }> {
  const module = new URL('../../server/telemetry.ts', import.meta.url).href;
  const source = `
import { execFileSync } from 'node:child_process';
import { renameSync, writeFileSync } from 'node:fs';
import { TelemetryWatcher } from ${JSON.stringify(module)};
const dir = process.argv[1];
const w = new TelemetryWatcher(dir, () => {});
w.start((id) => console.log('DELIVERED ' + id));
// The FIFO is planted while the watcher runs: a pre-existing one raises no
// fs.watch event at all, and this is about what happens when one arrives.
execFileSync('mkfifo', [dir + '/sess-fifo.json']);
console.log('PLANTED');
setTimeout(() => {
  writeFileSync(dir + '/sess-ok.json.tmp', JSON.stringify({ v: 1, at: Date.now(), model: 'Opus 5' }));
  renameSync(dir + '/sess-ok.json.tmp', dir + '/sess-ok.json');
}, 800);
setTimeout(() => {
  console.log('DONE');
  w.stop();
}, 2500);
`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source, dir], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')));
    child.stderr.on('data', () => {});
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('error', reject);
    child.on('close', () => {
      clearTimeout(timer);
      resolve({ lines: out.split('\n').filter((l) => l !== ''), timedOut });
    });
  });
}

test('watcher #read: a FIFO named like a snapshot never blocks the watcher', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-sm-telemetry-fifo-'));
  const dir = join(root, 'statusline-snapshots');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    const { lines, timedOut } = await probeFifoWatcher(dir);
    assert.equal(
      timedOut,
      false,
      `a FIFO at <dir>/<id>.json froze the watcher's process: ${JSON.stringify(lines)}`,
    );
    assert.ok(lines.includes('PLANTED'), JSON.stringify(lines));
    assert.ok(lines.includes('DONE'), `the watcher kept running to the end: ${JSON.stringify(lines)}`);
    assert.equal(
      lines.some((l) => l.startsWith('DELIVERED sess-fifo')),
      false,
      'a FIFO is not a regular file and carries no telemetry',
    );
    assert.ok(
      lines.includes('DELIVERED sess-ok'),
      `a real snapshot written after the FIFO still arrives: ${JSON.stringify(lines)}`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('watcher: stop() clears the pending debounce — a restart never delivers the old write', async () => {
  const w = await makeWatcher();
  try {
    w.watcher.start((id, telemetry, transcript) => w.seen.push({ id, telemetry, transcript }));
    await writeSnapshot(w.dir, 'sess-stale.json', { v: 1, at: Date.now(), model: 'Stale' });
    await delay(50); // The event has landed; its 150 ms timer is pending.
    w.watcher.stop();

    // A restart (index.ts does exactly this across a backend restart) installs a
    // NEW callback. The timer from before stop() must be gone, not merely
    // ignored: whatever it would deliver describes the run that ended.
    const later: Seen[] = [];
    w.watcher.start((id, telemetry, transcript) => later.push({ id, telemetry, transcript }));
    await delay(600);
    assert.equal(later.length, 0, 'nothing left over from before stop() fires into the new callback');
    assert.equal(w.seen.length, 0, 'and nothing reached the old one either');

    // Control: the restarted watcher does report a fresh write.
    await writeSnapshot(w.dir, 'sess-fresh.json', { v: 1, at: Date.now(), model: 'Opus 5' });
    await waitForSeen(later, 1);
    assert.equal(later[0]?.id, 'sess-fresh');
  } finally {
    await w.cleanup();
  }
});

test('watcher: the snapshot\'s transcript path is handed over as the third argument (B7)', async () => {
  const w = await makeWatcher();
  try {
    w.watcher.start((id, telemetry, transcript) => w.seen.push({ id, telemetry, transcript }));
    const id = 'sess-transcript';
    const path = '/home/u/.claude/projects/-home-u-p/0f2a5c8e-1b3d-4f60-9a77-2c1e5b8d4a09.jsonl';
    await writeSnapshot(w.dir, `${id}.json`, { v: 1, at: Date.UTC(2026, 8, 22, 9, 0, 0), transcript: path });
    await waitForSeen(w.seen, 1);
    assert.equal(w.seen[0]?.transcript, path);
    // And the telemetry half never saw it.
    assert.deepEqual(w.seen[0]?.telemetry, { at: '2026-09-22T09:00:00.000Z' });

    // A snapshot without the key reports undefined, not the previous path:
    // this callback is the only thing that keeps the two in step.
    await writeSnapshot(w.dir, `${id}.json`, { v: 1, at: Date.UTC(2026, 8, 22, 9, 1, 0) });
    await waitForSeen(w.seen, 2);
    assert.equal(w.seen[1]?.transcript, undefined);
  } finally {
    await w.cleanup();
  }
});
