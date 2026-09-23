/**
 * `web/src/ui/drop-walk.ts` — what a drop REALLY carries (Nocturne part B10
 * phase 2, `.claude/plans/nocturne/PLAN-B10.md` §3), driven DOM-free against a fake entry
 * tree.
 *
 * WHY THIS FILE EXISTS. A9 could only say `web`; B10 has to know every file
 * under it, because that is what gets written, what the drop-level limits are
 * measured against, and what an empty folder is the absence of. Every way this
 * walk can be wrong is silent and expensive:
 *
 *   1. `readEntries()` answers about 100 entries per call and then `[]`. A
 *      reader called ONCE copies the first hundred files of a folder and says
 *      it copied all of it — the tests below count the calls.
 *   2. A tree with a symlink loop in it is a thing people really drag. The
 *      depth cap and the early stop past `MAX_DROP_FILES` are what keep the
 *      page from spinning, so both are pinned by a tree that would not stop.
 *   3. A folder that holds NO files produces no upload at all, so it has to be
 *      recorded separately or it silently never lands.
 *   4. A file whose size the browser hides counts as 0 bytes (D3) — the server
 *      enforces the per-file cap regardless, and a total that threw instead
 *      would refuse a drop nothing is wrong with.
 *
 * NOT claimed here (browser work, `.claude/skills/verify-terminal/SKILL.md`):
 * that Chromium's own `FileSystemEntry` behaves like the fake below, that the
 * handles survive the `drop` event, or that a real folder lands on disk.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_DEPTH, walkDrop, type DropEntry, type DroppedTop } from '../../web/src/ui/drop-walk.ts';
import { MAX_DROP_FILES } from '../../web/src/ui/drop-model.ts';

// ---------------------------------------------------------------------------
// A fake tree, callback-style, exactly like the API it stands for
// ---------------------------------------------------------------------------

/** How many `readEntries()` calls each directory of the last tree received. */
let reads: Record<string, number> = {};

interface Node {
  name: string;
  size?: number;
  children?: Node[];
  /** The directory refuses to be read, the way a folder with no permission does. */
  unreadable?: boolean;
  /** The file refuses to hand its bytes over. */
  noBytes?: boolean;
  /** Entries per `readEntries()` call. The browser's own is about 100. */
  batch?: number;
}

/** A FILE node. `size: undefined` = a browser that will not say (D3). */
function f(name: string, size?: number, extra: Partial<Node> = {}): Node {
  return size === undefined ? { name, ...extra } : { name, size, ...extra };
}

/** A FOLDER node. */
function d(name: string, children: Node[], extra: Partial<Node> = {}): Node {
  return { name, children, ...extra };
}

function entryOf(node: Node, path: string): DropEntry {
  if (node.children === undefined) {
    return {
      name: node.name,
      isFile: true,
      file(ok, fail) {
        if (node.noBytes === true) {
          fail?.(new Error('no bytes'));
          return;
        }
        ok({ name: node.name, size: node.size } as unknown as File);
      },
    };
  }
  const kids = node.children;
  const per = node.batch ?? 100;
  return {
    name: node.name,
    isDirectory: true,
    createReader() {
      let i = 0;
      return {
        readEntries(ok, fail) {
          reads[path] = (reads[path] ?? 0) + 1;
          if (node.unreadable === true) {
            fail?.(new Error('unreadable'));
            return;
          }
          const slice = kids.slice(i, i + per);
          i += slice.length;
          ok(slice.map((c) => entryOf(c, `${path}/${c.name}`)));
        },
      };
    },
  };
}

/** One dropped top-level thing, from a node. */
function top(node: Node): DroppedTop {
  return { name: node.name, entry: entryOf(node, node.name), file: null };
}

/** A paste or a pick: a plain file, no entry to walk. */
function pasted(name: string, size?: number): DroppedTop {
  return { name, entry: null, file: { name, size } as unknown as File };
}

/** Every file the walk found, as `top:rel`. */
const seen = (r: { files: { top: number; rel: string }[] }): string[] =>
  r.files.map((x) => `${x.top}:${x.rel}`);

// ---------------------------------------------------------------------------
// 1. The tree
// ---------------------------------------------------------------------------

test('a nested folder: every file, in tree order, with its path inside the drop', async () => {
  reads = {};
  const r = await walkDrop([
    top(
      d('web', [
        f('index.html', 10),
        d('src', [f('main.ts', 20), d('ui', [f('files.ts', 30)])]),
        f('README.md', 40),
      ]),
    ),
  ]);
  assert.deepEqual(seen(r), ['0:index.html', '0:src/main.ts', '0:src/ui/files.ts', '0:README.md']);
  assert.deepEqual(r.items, [{ name: 'web', dir: true, bytes: null }]);
  assert.equal(r.bytes, 100);
  assert.equal(r.biggest, 40);
  assert.equal(r.unreadable, 0);
  assert.deepEqual(r.folders, [], 'every folder here holds something');
});

test('several top-level things keep the DROPPED order, and each file knows which it is under', async () => {
  reads = {};
  const r = await walkDrop([
    pasted('a.txt', 1),
    top(d('web', [f('x.ts', 2)])),
    top(f('b.bin', 3)),
  ]);
  assert.deepEqual(seen(r), ['0:', '1:x.ts', '2:']);
  assert.deepEqual(r.items, [
    { name: 'a.txt', dir: false, bytes: 1 },
    { name: 'web', dir: true, bytes: null },
    { name: 'b.bin', dir: false, bytes: 3 },
  ]);
  assert.equal(r.bytes, 6);
});

test('a top-level FILE is walked as itself: rel is empty, and it is the item s own size', async () => {
  reads = {};
  const r = await walkDrop([top(f('notes.txt', 7))]);
  assert.deepEqual(seen(r), ['0:']);
  assert.deepEqual(r.items, [{ name: 'notes.txt', dir: false, bytes: 7 }]);
});

// ---------------------------------------------------------------------------
// 2. readEntries(): about 100 at a time, and it must be LOOPED
// ---------------------------------------------------------------------------

test('a folder of 250 files is read in batches until the reader answers nothing', async () => {
  reads = {};
  const many = Array.from({ length: 250 }, (_, i) => f(`f${i}.bin`, 1));
  const r = await walkDrop([top(d('big', many, { batch: 100 }))]);
  assert.equal(r.files.length, 250, 'a reader called once would have found 100');
  assert.equal(r.bytes, 250);
  // 100 + 100 + 50 + the empty answer that ends the loop.
  assert.equal(reads['big'], 4, 'the loop stops on the EMPTY answer, not on a short one');
  assert.deepEqual(r.files.slice(0, 2).map((x) => x.rel), ['f0.bin', 'f1.bin']);
  assert.equal(r.files[249]?.rel, 'f249.bin');
});

test('every directory gets its own reader: a nested folder is looped too', async () => {
  reads = {};
  const deep = Array.from({ length: 120 }, (_, i) => f(`n${i}.txt`, 1));
  const r = await walkDrop([top(d('web', [d('src', deep, { batch: 100 })], { batch: 100 }))]);
  assert.equal(r.files.length, 120);
  assert.equal(reads['web'], 2, 'one batch and the empty answer');
  assert.equal(reads['web/src'], 3, '100, 20, and the empty answer');
});

// ---------------------------------------------------------------------------
// 3. Empty folders, unreadable folders, sizeless files
// ---------------------------------------------------------------------------

test('a folder that holds nothing is recorded as a FOLDER: an upload would never create it', async () => {
  reads = {};
  const r = await walkDrop([top(d('empty', []))]);
  assert.deepEqual(r.files, []);
  assert.deepEqual(r.folders, [{ top: 0, rel: '' }], 'the dropped folder itself');
  assert.deepEqual(r.items, [{ name: 'empty', dir: true, bytes: null }]);
  assert.equal(r.unreadable, 0, 'empty is not unreadable');
});

test('only the folders that hold NO file are recorded — the others come free with a file s path', async () => {
  reads = {};
  const r = await walkDrop([
    top(d('web', [d('assets', []), d('src', [f('main.ts', 1)]), d('a', [d('b', [])])])),
  ]);
  assert.deepEqual(seen(r), ['0:src/main.ts']);
  assert.deepEqual(r.folders, [
    { top: 0, rel: 'assets' },
    // `a` is not recorded: creating `a/b` creates it on the way.
    { top: 0, rel: 'a/b' },
  ]);
});

test('a folder that cannot be read is COUNTED, and costs the drop nothing else', async () => {
  reads = {};
  const r = await walkDrop([
    top(d('locked', [f('secret', 1)], { unreadable: true })),
    top(d('web', [f('a.ts', 2)])),
  ]);
  assert.equal(r.unreadable, 1);
  assert.deepEqual(seen(r), ['1:a.ts'], 'the readable one still walked');
  assert.deepEqual(r.folders, [], 'unreadable is not empty: nothing is invented');
  assert.deepEqual(r.items.map((i) => i.name), ['locked', 'web']);
});

test('a file that will not hand its bytes over is counted unreadable, not copied as nothing', async () => {
  reads = {};
  const r = await walkDrop([top(d('web', [f('ghost.bin', 5, { noBytes: true }), f('a.ts', 2)]))]);
  assert.equal(r.unreadable, 1);
  assert.deepEqual(seen(r), ['0:a.ts']);
  assert.equal(r.bytes, 2);
});

test('a file whose size the browser hides counts as 0 bytes (D3), and is still copied', async () => {
  reads = {};
  const r = await walkDrop([top(d('web', [f('hidden.bin'), f('a.ts', 4)]))]);
  assert.equal(r.files.length, 2, 'it is still a file to copy');
  assert.equal(r.bytes, 4, 'the total counts what it knows');
  assert.equal(r.biggest, 4);
  // The same at the top level, where it also decides the ITEM's own bytes.
  const t = await walkDrop([pasted('hidden.bin')]);
  assert.deepEqual(t.items, [{ name: 'hidden.bin', dir: false, bytes: 0 }]);
  assert.equal(t.bytes, 0);
});

test('a size that is not a real number counts as 0, so the drop total stays one (D3)', async () => {
  // `size` comes from the browser, and the drop-level limits are judged on the
  // SUM of it. One NaN in a 2000-file drop would make that sum NaN, and every
  // comparison against a NaN is false — the 1 GB refusal would simply stop
  // happening. An Infinity or a negative is the same lie in the other
  // direction, so none of the three is ever added.
  reads = {};
  const r = await walkDrop([
    top(d('web', [f('nan.bin', NaN), f('a.ts', 4), f('inf.bin', Infinity), f('neg.bin', -5)])),
  ]);
  assert.equal(r.files.length, 4, 'every one of them is still a file to copy');
  assert.equal(r.bytes, 4, 'the total counts only what it really knows');
  assert.equal(Number.isFinite(r.bytes), true, 'a total the limits are measured against is a number');
  assert.equal(r.biggest, 4, 'and no unreal size becomes the biggest file');
  // The same at the top level, where the size also decides the ITEM's bytes.
  const t = await walkDrop([pasted('nan.bin', NaN)]);
  assert.deepEqual(t.items, [{ name: 'nan.bin', dir: false, bytes: 0 }]);
  assert.equal(t.bytes, 0);
});

// ---------------------------------------------------------------------------
// 4. The two stops: too many files, too deep
// ---------------------------------------------------------------------------

test('the walk stops the moment the file count passes the drop limit', async () => {
  reads = {};
  const many = Array.from({ length: 2600 }, (_, i) => f(`f${i}.bin`, 1));
  const r = await walkDrop([top(d('huge', many, { batch: 100 }))]);
  assert.equal(r.files.length, MAX_DROP_FILES + 1, 'one past the limit is all it takes to know');
  assert.equal(r.files.length, 2001);
  assert.ok((reads['huge'] ?? 0) <= 21, `it stopped reading: ${reads['huge']} batches`);
});

test('exactly the limit is walked whole, and refuses nothing', async () => {
  reads = {};
  const many = Array.from({ length: MAX_DROP_FILES }, (_, i) => f(`f${i}.bin`, 1));
  const r = await walkDrop([top(d('big', many, { batch: 100 }))]);
  assert.equal(r.files.length, 2000);
  assert.equal(r.bytes, 2000);
});

test('the early stop also ends the OTHER top-level items, and every item is still listed', async () => {
  reads = {};
  const many = Array.from({ length: 2100 }, (_, i) => f(`f${i}.bin`, 1));
  const r = await walkDrop([top(d('huge', many, { batch: 100 })), top(d('web', [f('a.ts', 1)]))]);
  assert.equal(r.files.length, 2001);
  assert.deepEqual(r.items.map((i) => i.name), ['huge', 'web'], 'the rows are still the drop');
  assert.equal(reads['web'], undefined, 'the second folder was never opened');
});

test('a tree deeper than the cap stops descending and counts what it could not read', async () => {
  reads = {};
  // A chain 70 deep — what a symlink loop looks like from up here.
  let node: Node = d('bottom', [f('deep.txt', 1)]);
  for (let i = 0; i < 70; i += 1) node = d(`l${i}`, [node]);
  const r = await walkDrop([top(node)]);
  assert.ok(r.unreadable >= 1, 'the cap is reported, never silent');
  assert.equal(r.files.length, 0, `nothing below ${MAX_DEPTH} levels was walked`);
  assert.equal(MAX_DEPTH, 64);
});

// ---------------------------------------------------------------------------
// 5. Degenerate drops
// ---------------------------------------------------------------------------

test('a drop with nothing in it walks to an empty answer instead of throwing', async () => {
  const r = await walkDrop([]);
  assert.deepEqual(r, { items: [], files: [], folders: [], bytes: 0, biggest: 0, unreadable: 0 });
});

test('a top-level thing with neither an entry nor a file is an item with nothing to copy', async () => {
  const r = await walkDrop([{ name: 'ghost', entry: null, file: null }]);
  assert.deepEqual(r.items, [{ name: 'ghost', dir: false, bytes: null }]);
  assert.deepEqual(r.files, []);
});

test('a directory handle with no reader is unreadable, not empty', async () => {
  const bare: DropEntry = { name: 'web', isDirectory: true };
  const r = await walkDrop([{ name: 'web', entry: bare, file: null }]);
  assert.equal(r.unreadable, 1);
  assert.deepEqual(r.folders, [], 'a folder nobody could read is not a folder to create');
});
