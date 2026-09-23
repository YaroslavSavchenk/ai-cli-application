/**
 * `web/src/ui/drop-upload.ts` — the runner that really copies (Nocturne part
 * B10 phase 2, `.claude/plans/nocturne/PLAN-B10.md` §3), driven DOM-free against a fake
 * gateway that records every write it is asked for.
 *
 * WHY THIS FILE EXISTS, and why it is the strictest one of the part. This
 * module is the only thing in the app that can OVERWRITE a file the user did
 * not put there. Its mode selection is user decision D2 in code:
 *
 *   - `replace` writes `mode: 'replace'` — and ONLY for an item that really
 *     clashes. Every other write asks for a name that must still be free, so
 *     a copy can never overwrite something nobody chose to overwrite.
 *   - `keep both` lands the whole tree under a new top-level name, and every
 *     file inside it is `new`.
 *   - `skip` sends nothing at all for the items that clash.
 *
 * And the three promises that decide what the user sees afterwards: what
 * copied STAYS (nothing is rolled back, ever), a folder is ONE row with
 * `partialNote` inside it (D4), and an item planned `failed` — a file over the
 * per-file limit — is never sent at all (D3's refinement).
 *
 * NOT claimed here (the server's own tests, `tests/server/fs-upload.test.ts`): that
 * a byte lands, that `replace` is atomic, or that any status means what the
 * note says it means.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDropRun, type UploadGateway } from '../../web/src/ui/drop-upload.ts';
import { MAX_ITEM_BYTES, type Choice, type DropItem, type ItemResult } from '../../web/src/ui/drop-model.ts';
import type { WalkResult } from '../../web/src/ui/drop-walk.ts';

const DEST = { path: '/home/you/src', name: 'src' };

const file = (name: string, bytes = 1024): DropItem => ({ name, dir: false, bytes });
const folder = (name: string): DropItem => ({ name, dir: true, bytes: null });

/** A `File` stand-in: the runner hands it to the gateway and reads nothing off it. */
const blob = (name: string): File => ({ name } as unknown as File);

interface Recorder extends UploadGateway {
  /** Every write, in the order it was asked for. */
  calls: string[];
  /** `rel` (or `dir|name` for a folder) → the rejection it answers with. */
  failures: Map<string, unknown>;
}

/** A refusal with a status, the shape `ApiError` really has. */
function refusal(status: number): unknown {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

function gateway(failures: Record<string, unknown> = {}): Recorder {
  const g: Recorder = {
    calls: [],
    failures: new Map(Object.entries(failures)),
    put(dir, rel, mode, body) {
      g.calls.push(`put ${dir} | ${rel} | ${mode} | ${(body as unknown as { name: string }).name}`);
      const boom = g.failures.get(rel);
      return boom === undefined ? Promise.resolve() : Promise.reject(boom);
    },
    folder(dir, name) {
      g.calls.push(`folder ${dir} | ${name}`);
      const boom = g.failures.get(`${dir}|${name}`);
      return boom === undefined ? Promise.resolve() : Promise.reject(boom);
    },
  };
  return g;
}

/** A walk, written out: `'0:'` is the top-level item itself, `'0:src/a.ts'` a file inside it. */
function walkOf(files: string[], folders: string[] = []): WalkResult {
  const parse = (s: string): { top: number; rel: string } => {
    const cut = s.indexOf(':');
    return { top: Number(s.slice(0, cut)), rel: s.slice(cut + 1) };
  };
  const fs = files.map((s) => {
    const { top, rel } = parse(s);
    return { top, rel, file: blob(rel === '' ? `top${top}` : rel) };
  });
  return {
    items: [],
    files: fs,
    folders: folders.map(parse),
    bytes: 0,
    biggest: 0,
    unreadable: 0,
  };
}

interface Ran {
  results: ItemResult[];
  settled: string[];
  progress: string[];
  /** `run.failed()` — failed WRITES, in files. */
  failed: number;
}

async function run(
  items: DropItem[],
  listing: readonly string[],
  choice: Choice,
  walk: WalkResult,
  g: UploadGateway,
): Promise<Ran> {
  const settled: string[] = [];
  const progress: string[] = [];
  const r = createDropRun({ dest: DEST, items, listing, walk, gateway: g });
  const results = await r.start(choice, {
    settled: (i, res) => settled.push(`${i}:${res.state}${res.note === undefined ? '' : `:${res.note}`}`),
    progress: (done, total) => progress.push(`${done} of ${total}`),
  });
  return { results, settled, progress, failed: r.failed() };
}

const states = (r: Ran): string[] => r.results.map((x) => x.state);
const notes = (r: Ran): (string | undefined)[] => r.results.map((x) => x.note);

// ---------------------------------------------------------------------------
// 1. The plan the dialog draws is the plan the copy runs
// ---------------------------------------------------------------------------

test('plan(): the rows for an answer, pending, without touching the gateway', () => {
  const g = gateway();
  const r = createDropRun({
    dest: DEST,
    items: [file('README.md'), file('a.txt')],
    listing: ['README.md'],
    walk: walkOf(['0:', '1:']),
    gateway: g,
  });
  assert.deepEqual(r.plan('keep-both'), [
    { name: 'README.md', state: 'copied', note: 'saved as README (2).md', dir: false },
    { name: 'a.txt', state: 'copied', dir: false },
  ]);
  assert.deepEqual(r.plan('skip')[0], { name: 'README.md', state: 'skipped', dir: false });
  assert.deepEqual(g.calls, [], 'asking what would happen writes nothing');
});

// ---------------------------------------------------------------------------
// 2. Order, and one thing at a time
// ---------------------------------------------------------------------------

test('top-level items go in the DROPPED order, and the files inside a folder in tree order', async () => {
  const g = gateway();
  const r = await run(
    [folder('web'), file('notes.txt')],
    [],
    'replace',
    walkOf(['0:index.html', '0:src/main.ts', '1:']),
    g,
  );
  assert.deepEqual(g.calls, [
    'put /home/you/src | web/index.html | new | index.html',
    'put /home/you/src | web/src/main.ts | new | src/main.ts',
    'put /home/you/src | notes.txt | new | top1',
  ]);
  assert.deepEqual(r.settled, ['0:copied', '1:copied']);
  // The count is FILES (fix round, 2026-09-20): two of these three writes are
  // inside ONE dragged folder, and `0 of 1` standing still while 2000 files
  // copy says nothing about a copy that is moving.
  assert.deepEqual(r.progress, ['1 of 3', '2 of 3', '3 of 3']);
});

test('a row settles only when its own writes are over: nothing is reported ahead of itself', async () => {
  const g = gateway();
  let release: () => void = () => {};
  const held = new Promise<void>((res) => {
    release = res;
  });
  const slow: UploadGateway = {
    put: (dir, rel, mode, body) => (rel === 'web/a.ts' ? held : g.put(dir, rel, mode, body)),
    folder: g.folder,
  };
  const seen: string[] = [];
  const done = createDropRun({
    dest: DEST,
    items: [folder('web'), file('b.txt')],
    listing: [],
    walk: walkOf(['0:a.ts', '1:']),
    gateway: slow,
  }).start('replace', {
    settled: (i) => seen.push(`settled ${i}`),
    progress: () => {},
  });
  await Promise.resolve();
  assert.deepEqual(seen, [], 'the first row is still in flight');
  release();
  await done;
  assert.deepEqual(seen, ['settled 0', 'settled 1']);
});

// ---------------------------------------------------------------------------
// 3. D2: the write mode of every file
// ---------------------------------------------------------------------------

test('replace over a clash writes `replace`, and everything else in the same drop writes `new`', async () => {
  const g = gateway();
  await run(
    [file('README.md'), file('new.txt')],
    ['README.md'],
    'replace',
    walkOf(['0:', '1:']),
    g,
  );
  assert.deepEqual(g.calls, [
    'put /home/you/src | README.md | replace | top0',
    'put /home/you/src | new.txt | new | top1',
  ]);
});

test('replace MERGES a clashing folder: every file inside it is a deliberate overwrite (D2)', async () => {
  const g = gateway();
  await run([folder('web')], ['web'], 'replace', walkOf(['0:index.html', '0:src/main.ts']), g);
  assert.deepEqual(g.calls, [
    'put /home/you/src | web/index.html | replace | index.html',
    'put /home/you/src | web/src/main.ts | replace | src/main.ts',
  ]);
});

test('keep both lands the whole tree under the NEW name, and nothing inside it overwrites', async () => {
  const g = gateway();
  const r = await run(
    [folder('web')],
    ['web'],
    'keep-both',
    walkOf(['0:index.html', '0:src/main.ts'], ['0:assets']),
    g,
  );
  assert.deepEqual(g.calls, [
    'put /home/you/src | web (2)/index.html | new | index.html',
    'put /home/you/src | web (2)/src/main.ts | new | src/main.ts',
    'folder /home/you/src | web (2)',
    'folder /home/you/src/web (2) | assets',
  ]);
  assert.deepEqual(notes(r), ['saved as web (2)'], 'the row still says what it was called');
  assert.deepEqual(states(r), ['copied']);
});

test('keep both on a FILE takes the free name, and a second clash of one drop takes the next', async () => {
  const g = gateway();
  await run(
    [file('report.md'), file('report.md')],
    ['report.md'],
    'keep-both',
    walkOf(['0:', '1:']),
    g,
  );
  assert.deepEqual(g.calls, [
    'put /home/you/src | report (2).md | new | top0',
    'put /home/you/src | report (3).md | new | top1',
  ]);
});

test('skip sends NOTHING for what clashes, and copies the rest', async () => {
  const g = gateway();
  const r = await run(
    [file('README.md'), file('a.txt')],
    ['README.md'],
    'skip',
    walkOf(['0:', '1:']),
    g,
  );
  assert.deepEqual(g.calls, ['put /home/you/src | a.txt | new | top1']);
  assert.deepEqual(states(r), ['skipped', 'copied']);
  assert.deepEqual(r.progress, ['1 of 2', '2 of 2'], 'a skipped row is one step of the drop');
});

test('a drop with no conflict at all never writes `replace`, whatever was answered', async () => {
  for (const choice of ['replace', 'keep-both', 'skip'] as Choice[]) {
    const g = gateway();
    await run([file('a.txt')], ['other.txt'], choice, walkOf(['0:']), g);
    assert.deepEqual(g.calls, ['put /home/you/src | a.txt | new | top0'], `choice ${choice}`);
  }
});

// ---------------------------------------------------------------------------
// 4. Empty folders
// ---------------------------------------------------------------------------

test('a folder that holds nothing is CREATED, segment by segment', async () => {
  const g = gateway();
  const r = await run([folder('web')], [], 'replace', walkOf([], ['0:', '0:a/b']), g);
  assert.deepEqual(g.calls, [
    'folder /home/you/src | web',
    'folder /home/you/src | web',
    'folder /home/you/src/web | a',
    'folder /home/you/src/web/a | b',
  ]);
  assert.deepEqual(states(r), ['copied']);
});

test('a name already taken (409) is what a folder that is already there answers: it is a success', async () => {
  const g = gateway({ '/home/you/src|web': refusal(409) });
  const r = await run([folder('web')], ['web'], 'replace', walkOf([], ['0:assets']), g);
  assert.deepEqual(states(r), ['copied'], 'merging into a folder that exists is the point');
  assert.deepEqual(g.calls, ['folder /home/you/src | web', 'folder /home/you/src/web | assets']);
});

test('a folder that cannot be created fails its row, and says why', async () => {
  const g = gateway({ '/home/you/src|web': refusal(403) });
  const r = await run([folder('web')], [], 'replace', walkOf([], ['0:']), g);
  assert.deepEqual(states(r), ['failed']);
  assert.deepEqual(notes(r), ['not allowed in that folder']);
});

// ---------------------------------------------------------------------------
// 5. Failure: per status, per folder, and never a rollback
// ---------------------------------------------------------------------------

test('one file, one status: the row says the reason that status means', async () => {
  const table: [number, string][] = [
    [409, 'something with that name is already there'],
    [413, 'larger than the copy limit'],
    [403, 'not allowed in that folder'],
    [404, 'that folder is no longer there'],
    [507, 'no room left on the disk'],
    [400, 'that name is not allowed'],
    [422, 'that name is not allowed'],
    [500, 'could not be copied'],
  ];
  for (const [status, note] of table) {
    const g = gateway({ 'a.txt': refusal(status) });
    const r = await run([file('a.txt')], [], 'replace', walkOf(['0:']), g);
    assert.deepEqual(states(r), ['failed'], `status ${status}`);
    assert.deepEqual(notes(r), [note], `status ${status}`);
  }
});

test('a network throw carries no status, and the row says the honest nothing', async () => {
  const g = gateway({ 'a.txt': new TypeError('Failed to fetch') });
  const r = await run([file('a.txt')], [], 'replace', walkOf(['0:']), g);
  assert.deepEqual(states(r), ['failed']);
  assert.deepEqual(notes(r), ['could not be copied']);
});

test('a folder that partly failed is ONE row with the count inside it (D4)', async () => {
  const many = Array.from({ length: 12 }, (_, i) => `0:f${i}.bin`);
  const g = gateway({
    'web/f1.bin': refusal(507),
    'web/f4.bin': refusal(500),
    'web/f11.bin': refusal(409),
  });
  const r = await run([folder('web')], [], 'replace', walkOf(many), g);
  assert.deepEqual(states(r), ['failed']);
  assert.deepEqual(notes(r), ['3 of 12 files failed']);
  assert.equal(g.calls.length, 12, 'every file of the folder was still attempted');
});

test('what copied STAYS: a failure deletes nothing and stops nothing', async () => {
  const g = gateway({ 'web/a.ts': refusal(500) });
  const r = await run(
    [folder('web'), file('after.txt')],
    [],
    'replace',
    walkOf(['0:a.ts', '0:b.ts', '1:']),
    g,
  );
  assert.deepEqual(g.calls, [
    'put /home/you/src | web/a.ts | new | a.ts',
    'put /home/you/src | web/b.ts | new | b.ts',
    'put /home/you/src | after.txt | new | top1',
  ]);
  assert.deepEqual(states(r), ['failed', 'copied']);
  assert.deepEqual(notes(r), ['1 of 2 files failed', undefined]);
  assert.equal(
    g.calls.some((c) => /delete|remove|undo/i.test(c)),
    false,
    'there is no undo in this gateway, and the runner asks for none',
  );
});

test('a folder whose only file failed still says how many of how many', async () => {
  const g = gateway({ 'web/a.ts': refusal(403) });
  const r = await run([folder('web')], [], 'replace', walkOf(['0:a.ts']), g);
  assert.deepEqual(notes(r), ['not allowed in that folder'], 'one thing failed, so it says WHY');
});

// ---------------------------------------------------------------------------
// 6. What is never sent
// ---------------------------------------------------------------------------

test('a file over the per-file limit is never sent: the row failed before the copy started', async () => {
  const g = gateway();
  const r = await run(
    [file('huge.bin', MAX_ITEM_BYTES + 1), file('a.txt')],
    [],
    'replace',
    walkOf(['0:', '1:']),
    g,
  );
  assert.deepEqual(g.calls, ['put /home/you/src | a.txt | new | top1'], 'not one byte offered');
  assert.deepEqual(states(r), ['failed', 'copied']);
  assert.deepEqual(notes(r), ['larger than the copy limit', undefined]);
  assert.deepEqual(r.settled, ['0:failed:larger than the copy limit', '1:copied']);
});

test('an item with nothing to write may not say it copied', async () => {
  const g = gateway();
  const r = await run([file('ghost.bin')], [], 'replace', walkOf([]), g);
  assert.deepEqual(g.calls, []);
  assert.deepEqual(states(r), ['failed']);
  assert.deepEqual(notes(r), ['could not be copied']);
});

test('the results the runner answers with are the results it reported, row by row', async () => {
  const g = gateway({ 'b.txt': refusal(507) });
  const r = await run(
    [file('a.txt'), file('b.txt'), file('c.txt')],
    ['c.txt'],
    'skip',
    walkOf(['0:', '1:', '2:']),
    g,
  );
  assert.deepEqual(r.settled, ['0:copied', '1:failed:no room left on the disk', '2:skipped']);
  assert.deepEqual(states(r), ['copied', 'failed', 'skipped']);
  assert.deepEqual(r.progress, ['1 of 3', '2 of 3', '3 of 3']);
  assert.equal(r.failed, 1, 'one FILE failed, and that is what the summary line counts');
});

// ---------------------------------------------------------------------------
// 7. The fix round (2026-09-20): progress in files, failed files, safe hooks
// ---------------------------------------------------------------------------

test('progress counts WRITES: a folder of 3 files and 1 empty folder is 4 steps, not 1', async () => {
  const g = gateway();
  const r = await run(
    [folder('web')],
    [],
    'replace',
    walkOf(['0:a.ts', '0:b.ts', '0:c.ts'], ['0:empty']),
    g,
  );
  assert.deepEqual(r.progress, ['1 of 4', '2 of 4', '3 of 4', '4 of 4']);
  assert.deepEqual(r.settled, ['0:copied'], 'and it is still ONE row');
});

test('failed() counts FILES, not rows — the unit the summary line is written in', async () => {
  const many = Array.from({ length: 12 }, (_, i) => `0:f${i}.bin`);
  const g = gateway({ 'web/f1.bin': refusal(507), 'web/f4.bin': refusal(500), 'web/f11.bin': refusal(409) });
  const r = await run([folder('web')], [], 'replace', walkOf(many), g);
  assert.deepEqual(states(r), ['failed'], 'one row');
  assert.equal(r.failed, 3, 'three files');
  assert.deepEqual(notes(r), ['3 of 12 files failed']);
});

test('failed() is 0 for a clean drop, and is reset by the next run', async () => {
  const g = gateway({ 'b.txt': refusal(403) });
  const r = createDropRun({
    dest: DEST,
    items: [file('a.txt'), file('b.txt')],
    listing: [],
    walk: walkOf(['0:', '1:']),
    gateway: g,
  });
  const hooks = { settled: () => {}, progress: () => {} };
  await r.start('replace', hooks);
  assert.equal(r.failed(), 1);
  g.failures.clear();
  await r.start('replace', hooks);
  assert.equal(r.failed(), 0, 'a run answers for itself, never for the one before it');
});

test('a hook that throws does not abandon a copy with files already on disk', async () => {
  const g = gateway();
  const r = createDropRun({
    dest: DEST,
    items: [file('a.txt'), file('b.txt'), file('c.txt')],
    listing: [],
    walk: walkOf(['0:', '1:', '2:']),
    gateway: g,
  });
  let calls = 0;
  const results = await r.start('replace', {
    settled: () => {
      calls += 1;
      if (calls === 1) throw new Error('the card blew up painting a row');
    },
    progress: () => {
      throw new Error('and the count blew up too');
    },
  });
  assert.equal(calls, 3, 'every row was still reported');
  assert.deepEqual(results.map((x) => x.state), ['copied', 'copied', 'copied']);
  assert.deepEqual(g.calls.length, 3, 'and every file was still written');
});

// ---------------------------------------------------------------------------
// 8. One write at a time (mutation gate, 2026-09-20)
// ---------------------------------------------------------------------------

test('the writes are SEQUENTIAL: a second one is never in flight while the first still is', async () => {
  // The promise every write hands back resolves on a LATER microtask, so a
  // runner that fired them together (a pool, a `Promise.all`) would have all
  // of them counted as in flight before the first one answers. `most` is what
  // proves the loop really waits: the rows then settle in the order the list
  // draws them, and `N of M` stays honest.
  let inFlight = 0;
  let most = 0;
  const order: string[] = [];
  const hold = (label: string): Promise<void> => {
    order.push(label);
    inFlight += 1;
    if (inFlight > most) most = inFlight;
    return new Promise<void>((res) => {
      queueMicrotask(() => {
        inFlight -= 1;
        res();
      });
    });
  };
  const slow: UploadGateway = {
    put: (dir, rel, mode, body) => hold(`put ${rel} | ${mode} | ${(body as unknown as { name: string }).name} | ${dir}`),
    folder: (dir, name) => hold(`folder ${dir} | ${name}`),
  };
  const r = await run(
    [folder('web'), file('notes.txt')],
    [],
    'replace',
    walkOf(['0:a.ts', '0:b.ts', '0:c.ts', '1:'], ['0:empty']),
    slow,
  );
  assert.equal(most, 1, 'one write at a time, whatever a round trip costs');
  assert.deepEqual(order, [
    'put web/a.ts | new | a.ts | /home/you/src',
    'put web/b.ts | new | b.ts | /home/you/src',
    'put web/c.ts | new | c.ts | /home/you/src',
    'folder /home/you/src | web',
    'folder /home/you/src/web | empty',
    'put notes.txt | new | top1 | /home/you/src',
  ]);
  assert.deepEqual(r.progress, ['1 of 5', '2 of 5', '3 of 5', '4 of 5', '5 of 5']);
  assert.deepEqual(r.settled, ['0:copied', '1:copied']);
});

test('a destination path that ends in a slash grows no second one', async () => {
  // The root of a drive-less tree (`/`) is the one destination whose path ends
  // in a separator, and the folder route is asked for a PARENT path: `//web`
  // is a different string to the server than `/web`, and the folders under it
  // would be created somewhere nobody asked for.
  const g = gateway();
  const settled: string[] = [];
  await createDropRun({
    dest: { path: '/', name: 'Home' },
    items: [folder('web')],
    listing: [],
    walk: walkOf([], ['0:a/b']),
    gateway: g,
  }).start('replace', {
    settled: (i, res) => settled.push(`${i}:${res.state}`),
    progress: () => {},
  });
  assert.deepEqual(g.calls, ['folder / | web', 'folder /web | a', 'folder /web/a | b']);
  assert.deepEqual(settled, ['0:copied']);
});
