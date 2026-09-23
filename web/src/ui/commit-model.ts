/**
 * Commit model (Nocturne part A6, live since part B3) — every decision the
 * commits list, the commit view and a diff block make about SHAPE, with no DOM
 * and no state import, so `node --test` can drive all of it.
 *
 * What lives here: the five-block add/del bar, the author's initial, the way a
 * commit's own timestamp is read (the relative half is ui/format-model.ts's
 * `relativeTime` since Q1), the plural copy, the collapse key a
 * file block is remembered by, the two sentences a block can carry instead of a
 * diff, and the GitHub address the one sanctioned exit is handed. What does NOT
 * live here: the data (the backend's `git log` / `git show`, through
 * `ui/commit-store.ts` since B3) and anything that reads or writes app state.
 *
 * WHAT B3 DELETED. `syntheticDiff()` and its per-path seed derived a plausible
 * unified diff from a file's text while nothing in the app could read a
 * repository. The rows now come from `git show` through `GitCommitDiffResponse`
 * (`shared/protocol.ts`), which numbers the OLD file and the NEW one side by
 * side — so `DiffLine` is gone too and the protocol's own `GitDiffLine` is what
 * every renderer here takes.
 */

import { FULL_HASH } from '../../../shared/protocol.ts';
import { MONTHS } from './format-model.ts';


/** The five-block summary bar: green blocks first, red for the rest. */
export const BAR_BLOCKS = 5;

/** A diff row's meaning, minus `hunk` — what decides a BLOCK's ink and ground. */
export type DiffKind = 'add' | 'del' | 'ctx';

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
 * it is the deterministic, dependency-free way to turn a `<hash>:<path>` key
 * into the disambiguating tail of a DOM id (`blockDomId`).
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

// ---------------------------------------------------------------------------
// Copy (part B3)
// ---------------------------------------------------------------------------

/** A file git stores as bytes: there are no lines to draw, and it says so. */
export const BINARY_TEXT = 'Binary file.';

/** A file whose diff passed the server's line cap (2000 rows). */
export const TOO_LARGE_TEXT = "This file's changes are too large to show.";

/** A repository with a commit in it but no branch name — git's detached HEAD. */
export const DETACHED_TEXT = 'Detached';

/** A repository that has never been committed to. */
export const NO_COMMITS_TEXT = 'No commits yet.';

/** What the `Show more` row says, and the only way to reach an older page. */
export const SHOW_MORE_TEXT = 'Show more';

/** The name of the branch the list is on, or the word for having none. */
export function branchLabel(branch: string | null): string {
  return branch === null || branch === '' ? DETACHED_TEXT : branch;
}

/** `Committed by Sava` — drawn only when the committer is not the author. */
export function committedByText(name: string): string {
  return `Committed by ${name}`;
}

/**
 * The quiet last row of a commit the server had to cap: `1 more file is not
 * shown.` / `12 more files are not shown.` (copy rule: counts pluralise). The
 * Files panel's own cap says `item`, because a folder holds folders too; a
 * commit changes files.
 */
export function moreFilesText(n: number): string {
  return n === 1 ? '1 more file is not shown.' : `${n} more files are not shown.`;
}

/**
 * What a TAB CHIP calls a commit. The tab's identity is the full 40-hex hash
 * (two commits can share a path, and a chip is no place to tell them apart by
 * eye), so the label takes git's own abbreviation length. A hash that is not
 * the full 40 is handed back untouched: it is already short.
 */
export function shortHashOf(hash: string): string {
  return hash.length === 40 ? hash.slice(0, 7) : hash;
}

// ---------------------------------------------------------------------------
// Time (part B3): one timestamp, said twice
// ---------------------------------------------------------------------------
//
// A row carries the ABSOLUTE date and the relative time (user decision D1,
// 2026-09-21): "3 hours ago" answers "is this fresh", "20 Sep 2026" answers
// "which change was this" — and a list where every row says "5 days ago" is a
// list nobody can navigate.
//
// THE DATE IS READ OUT OF THE STRING, not out of a `Date`. `%aI` carries the
// author's own UTC offset, so `2026-09-20T14:32:05+02:00` is 20 September at
// 14:32 where that commit was made. Rendering it in the browser's zone would
// move a commit made at 00:30 to the previous day for a reader one zone west,
// which is a different fact about the repository. The RELATIVE half is the
// opposite question ("how long ago from now"), so it is plain epoch
// arithmetic and carries no zone at all — `relativeTime` in ui/format-model.ts, the
// app's one relative time (Q1).

/** `YYYY-MM-DDTHH:MM:SS` with any offset — the shape `%aI` / `%cI` produce. */
const ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/;

/**
 * `20 Sep 2026`, in the commit's own zone. A string the app cannot parse comes
 * back EMPTY rather than as itself: the server promises strict ISO, and
 * printing a raw timestamp would put machine text on a surface that is meant
 * to be read.
 */
export function absoluteDate(iso: string): string {
  const m = ISO.exec(iso);
  if (m === null) return '';
  const month = MONTHS[Number(m[2]) - 1];
  if (month === undefined) return '';
  return `${Number(m[3])} ${month} ${m[1]}`;
}

/** `20 Sep 2026 at 14:32` — the full date and time, for a title and the view. */
export function fullDateTime(iso: string): string {
  const date = absoluteDate(iso);
  const m = ISO.exec(iso);
  if (date === '' || m === null) return '';
  return `${date} at ${m[4]}:${m[5]}`;
}

// ---------------------------------------------------------------------------
// The one address this screen can leave for (D2, part B3)
// ---------------------------------------------------------------------------

/** `owner` / `repo` as GitHub itself allows them — the server's own pattern. */
const GH_NAME = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * The commit's page on github.com, or NULL when any of the three parts is not
 * exactly what it must be.
 *
 * THE PAGE RE-CHECKS WHAT THE SERVER ALREADY CHECKED. The owner and the repo
 * are parsed out of `remote.origin.url` — a string from the user's own
 * repository config — and the result is handed to the one call that can leave
 * this window. Two gates on one address is the cheap half of defence in depth:
 * `.` and `..` are refused by name (both pass the character class and neither
 * is a repository), and a hash that is not the full 40 hex never reaches a URL.
 */
export function githubCommitUrl(owner: string, repo: string, hash: string): string | null {
  for (const part of [owner, repo]) {
    if (!GH_NAME.test(part) || part === '.' || part === '..') return null;
  }
  if (!FULL_HASH.test(hash)) return null;
  return `https://github.com/${owner}/${repo}/commit/${hash}`;
}
