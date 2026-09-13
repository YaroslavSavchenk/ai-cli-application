/**
 * Commit-view model (Nocturne part A6) — every decision the commit view makes
 * about SHAPE, with no DOM and no state import, so `node --test` can drive it.
 *
 * What lives here: the totals of a commit, the five-block add/del bar, the
 * author's initial, the plural copy, the collapse key a file block is
 * remembered by, and the unified diff itself. What does NOT live here: the
 * data (`ui/files-mock.ts` today, `git show` in part B3) and anything that
 * reads or writes app state.
 *
 * THE DIFF IS SYNTHETIC AND SAYS SO. `syntheticDiff()` derives a plausible
 * unified diff from a file's text (a fixed cadence of added and removed lines,
 * whose periods and offsets come from a per-path seed) as the v3 reference's
 * own mock does. It is
 * placeholder geometry for the renderer, never a claim about a repository —
 * part B3 replaces the call with a real `git show` hunk walk and the row
 * shape below is what it will produce.
 */

/** One file inside a commit, as B3's `git show --numstat` walk will hand it over. */
export interface CommitFileChange {
  /** Repo-relative path with `/` separators. */
  path: string;
  add: number;
  del: number;
}

/** What a diff row MEANS — the only thing that decides its ink and its ground. */
export type DiffKind = 'add' | 'del' | 'ctx';

/**
 * One rendered diff row.
 *
 * PART B3 REPLACES `n` WITH TWO COLUMNS. A real unified diff numbers the OLD
 * file and the NEW one side by side (`oldNo`/`newNo`, each blank on the side
 * that does not have the line); one running counter is what the v3 reference
 * draws and all a synthetic diff can honestly claim. `--diff-gut-w` in
 * `tokens.css` is sized for ONE column, so B3 widens it with the same change.
 */
export interface DiffLine {
  /** Line number in the rendered diff, 1-based. B3: becomes `oldNo`/`newNo`. */
  n: number;
  /** `+`, `-` or a space — a one-column mark, never part of the text. */
  sign: '+' | '-' | ' ';
  text: string;
  kind: DiffKind;
}

/** The five-block summary bar: green blocks first, red for the rest. */
export const BAR_BLOCKS = 5;

/** Sum of a commit's per-file numbers — the header's `+A -D`. */
export function commitTotals(files: readonly CommitFileChange[]): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const f of files) {
    add += f.add;
    del += f.del;
  }
  return { add, del };
}

/**
 * The five-block bar: how many of the five blocks are "added". It is a RATIO
 * at a glance, not a measurement — five blocks cannot say more than that, and
 * the exact numbers stand beside it.
 */
export function barBlocks(add: number, del: number): DiffKind[] {
  const greens = Math.round((BAR_BLOCKS * add) / Math.max(1, add + del));
  return Array.from({ length: BAR_BLOCKS }, (_, i) => (i < greens ? 'add' : 'del'));
}

/**
 * The author avatar's letter. One character, upper case; an author with no
 * name at all gets no letter rather than a box (the name beside it is the
 * content, the circle is decoration).
 */
export function authorInitial(author: string): string {
  // By CHARACTER, not by UTF-16 code unit: an author whose name starts outside
  // the BMP (an emoji, a rare CJK ideograph) would otherwise get half a
  // surrogate pair — a replacement box in the circle.
  return Array.from(author.trim())[0]?.toUpperCase() ?? '';
}

/** `1 file changed` / `4 files changed` (copy rule: counts pluralise). */
export function filesChangedText(n: number): string {
  return `${n} ${n === 1 ? 'file' : 'files'} changed`;
}

/**
 * The key one file block is collapsed under. Per COMMIT and per path, so
 * opening another commit does not inherit the last one's open blocks.
 */
export function collapseKey(hash: string, path: string): string {
  return `${hash}:${path}`;
}

/**
 * 32-bit FNV-1a of a string. Not a security primitive and never used as one:
 * it is the deterministic, dependency-free way to turn a path into a small
 * number — a per-file diff cadence (`pathSeed`) and the disambiguating tail of
 * a DOM id (`blockDomId`).
 */
function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * The DOM id of one file's diff block, derived from the same `<hash>:<path>`
 * key it is folded under. Its one job is the `aria-controls` link from the
 * Files panel row that folds it (the row and the block live in two different
 * regions), so it has to survive a path: everything outside `[A-Za-z0-9_-]`
 * becomes `-`, which keeps it a valid id.
 *
 * That squash is LOSSY — `a/b.ts` and `a-b.ts` sanitise to the same string —
 * so the id carries a 6-hex-char hash of the RAW key as its tail. Two paths
 * that collide in the sanitised part still get two different ids, and the
 * `aria-controls` link keeps pointing at exactly one block.
 */
export function blockDomId(hash: string, path: string): string {
  const key = collapseKey(hash, path);
  const tail = fnv1a32(key).toString(16).padStart(8, '0').slice(-6);
  return `diffblock-${key.replace(/[^A-Za-z0-9_-]+/g, '-')}-${tail}`;
}

/**
 * The diff cadence seed of one path. The synthetic diff is placeholder
 * geometry (see the module note); with ONE cadence every file of comparable
 * length produced the same add/del ratio, so every commit drew the same
 * five-block bar and the mock stopped saying anything. The seed is a pure
 * function of the path, so a file's numbers are stable across the Files panel,
 * the commits list and the opened view. Part B3 deletes it with the rest of
 * the synthetic diff.
 */
export function pathSeed(path: string): number {
  return fnv1a32(path);
}

/** Last path segment — the only part of a path a tab label ever shows. */
export function fileName(path: string): string {
  return path.split('/').pop() ?? path;
}

/**
 * The cadences a seed picks from. Index 0 of each is the ORIGINAL cadence (add
 * every 5th line, remove every 7th), so `syntheticDiff(text)` with no seed
 * renders exactly what it always did.
 *
 * The SPREAD is the point. A file's add/del ratio is roughly `delEvery /
 * (addEvery + delEvery)`, so the two tables run in opposite directions after
 * index 0 — short add period against long remove period and back — and the
 * ratio sweeps from mostly-removed to almost-all-added. With one cadence every
 * file of comparable length produced the same ratio and all five commits drew
 * the identical 3-green/2-red bar, which is a bar that says nothing.
 */
const ADD_PERIODS = [5, 2, 3, 4, 6, 8, 9] as const;
const DEL_PERIODS = [7, 13, 11, 9, 5, 4, 3] as const;

/**
 * A file's text -> the rows a unified diff draws. PLACEHOLDER GEOMETRY (see
 * the module note): one line in every `addEvery` reads as added and one in
 * every `delEvery` as removed, and a removed line is drawn as the old text
 * followed by the new — which is what gives the renderer a red row, a green
 * row and context rows to lay out. Line numbers count RENDERED rows, as a
 * unified diff does.
 *
 * `seed` (0 by default, `pathSeed(path)` at every call site that has a path)
 * moves both periods and both offsets, so two files of similar length do NOT
 * produce the same add/del ratio and the five-block bar varies down a list of
 * commits. Seed 0 is the original cadence: added every 5th line from index 1,
 * removed every 7th from index 3. Whatever the seed, the walk stays TOTAL (no
 * source line is dropped, duplicated or reordered) and deterministic.
 *
 * Part B3 replaces this function with the backend's real hunks; `DiffLine[]`
 * is the shape it must produce, so nothing downstream changes.
 */
export function syntheticDiff(text: string, seed = 0): DiffLine[] {
  const s = Math.abs(Math.trunc(seed));
  const addEvery = ADD_PERIODS[s % ADD_PERIODS.length] as number;
  const addAt = (1 + s) % addEvery;
  const delEvery = DEL_PERIODS[Math.floor(s / ADD_PERIODS.length) % DEL_PERIODS.length] as number;
  const delAt = (3 + Math.floor(s / (ADD_PERIODS.length * DEL_PERIODS.length))) % delEvery;
  const out: DiffLine[] = [];
  const src = text.split('\n');
  src.forEach((line, i) => {
    const kind: DiffKind = i % addEvery === addAt ? 'add' : i % delEvery === delAt ? 'del' : 'ctx';
    if (kind === 'del') {
      out.push({ n: out.length + 1, sign: '-', text: line.replace('const', 'let'), kind: 'del' });
      out.push({ n: out.length + 1, sign: ' ', text: line, kind: 'ctx' });
      return;
    }
    out.push({ n: out.length + 1, sign: kind === 'add' ? '+' : ' ', text: line, kind });
  });
  return out;
}
