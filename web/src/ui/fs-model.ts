/**
 * Live-filesystem model (Nocturne part B2 + A9c, `.claude/PLAN-B2.md` §9) —
 * everything the Files panel decides about a REAL folder tree, with no DOM, no
 * state import and no `api.ts`, so `node --test` drives all of it.
 *
 * What lives here: the cache shape a lazily-expanded tree needs
 * (`FolderState`), the pure walk from that cache to the rows a render draws
 * (`fsRows`), where A9c's inline name row goes (`createRowIndex`), the
 * client-side mirror of the server's name rules (`nameProblem`, §6b), the
 * path arithmetic the panel does all day (`joinPath`, `parentPath`,
 * `isUnder`), the `Destination` type that carries a real path behind a name
 * (§4b), and the mapping from the git answer to the A5 renderer's input
 * (`changesToFiles`, §7). What does NOT live here: anything that fetches
 * (`files.ts` gets an injected `FsGateway`), anything that paints, and the
 * panel's own instance state (`openFolders`, `listings`, `selected`,
 * `creating` stay in `ui/files.ts` — none of it is server state and none of it
 * survives a reload).
 *
 * ONE ROW VOCABULARY FOR TWO TREES. The Files tab draws this module's rows and
 * the Changes tab draws `files-model.ts`'s `treeRows`, side by side in the same
 * panel, so their indent and their caret must be the SAME arithmetic and the
 * SAME glyphs — not two copies that agree today. `rowIndent()` and
 * `caretGlyph()` are therefore imported from `ui/files-model.ts` (the A5
 * module that already owned both) and `FsRow['caret']` IS `TreeRow['caret']`.
 * The direction is deliberate: `caretGlyph` was already exported there, the
 * copy-separator guard pins the `▸` glyph to that file by name, and this
 * module already type-imports `FileChange` from it — defining the indent here
 * instead would have made the two modules import each other's values.
 *
 * Copy rules this file enforces, not just follows:
 * - A PATH NEVER REACHES A LABEL (PROJECT-SCOPE, 2026-07-25). A `Destination`
 *   carries both, and only `.name` is ever printable; `destinationOf` is the
 *   one place that name is derived.
 * - EVERY SENTENCE IS A CONSTANT. Nothing here interpolates a path, a name the
 *   user typed, a key name or a command into a string — only counts, which
 *   pluralise.
 * - HONEST STATES. A folder that has not answered says `Loading…`, an empty one
 *   says it is empty, a failed one says the SERVER's own sentence (§1d), and a
 *   capped one says how many rows are missing. None of those is a row anybody
 *   can press, so none of them is a lie about what is there.
 */
import type { ChangedFile, FsEntry } from '../../../shared/protocol.ts';
import { caretGlyph, rowIndent, type FileChange, type TreeRow } from './files-model.ts';
import { fileName } from './slots-model.ts';

/**
 * One entry of one listing, exactly as `GET /api/fs/entries` sends it — the
 * protocol type itself, re-exported so the panel has ONE definition to import
 * and can never drift into a second, wider one. `name` is UNTRUSTED display
 * text: `textContent`, never `innerHTML`.
 */
export type { FsEntry };

/**
 * A real folder: the PATH the transport needs, the NAME the UI is allowed to
 * show (`.claude/PLAN-B2.md` §4b).
 *
 * The two travel together precisely so no caller has to choose. Before B2 the
 * drop layer passed a bare name around and the transport had nothing to post
 * to; passing a bare path instead would have put a path one `textContent`
 * away from the screen. Everything that renders a destination reads `.name`;
 * part B10's upload reads `.path`.
 */
export interface Destination {
  path: string;
  name: string;
}

/** The server's own limit on a single path segment (`server/fsbrowse.ts` `isSafeSegment`). */
export const MAX_NAME_LEN = 255;

/** A folder whose listing has been asked for and has not answered yet (§3). */
export const LOADING_TEXT = 'Loading…';

/** A folder that answered with nothing in it (§3). */
export const EMPTY_TEXT = 'Empty folder';

/** The Changes tab with a clean working tree (§7). */
export const NO_CHANGES_TEXT = 'No changes since the last commit.';

/**
 * What the panel knows about ONE folder's contents, keyed by absolute path.
 *
 * `error` carries the SERVER's sentence (§1d) rather than a code, because the
 * panel renders it verbatim in that folder's own slot — the picker's rule:
 * honest states only, the backend's own reason inline. A folder with no entry
 * in the map at all is the fourth state ("never asked"), which draws the same
 * as `loading` and needs no member of its own.
 */
export type FolderState =
  | { k: 'loading' }
  | { k: 'ready'; entries: readonly FsEntry[]; truncated: number }
  | { k: 'error'; message: string };

// ---------------------------------------------------------------------------
// Names (A9c, §6b)
// ---------------------------------------------------------------------------

/**
 * Why a typed name cannot be created. The five rules are `isSafeSegment`'s,
 * one for one — `server/fsbrowse.ts` stays the authority and this is a mirror
 * of it, so the ordinary mistakes never cost a request and the server never
 * has to be asked something it will certainly refuse.
 */
export type NameProblem = 'empty' | 'slash' | 'dots' | 'control' | 'too-long';

/**
 * The problem with `raw`, or null when the server will accept it.
 *
 * MIRRORS `server/fsbrowse.ts` `isSafeSegment` EXACTLY, in its order: length 0,
 * then longer than 255, then a `/` or a `\`, then any byte below 0x20, then an
 * all-dots name. Two consequences worth stating, because both are deliberate:
 *
 * - A LEADING DOT IS FINE. `.env`, `.gitignore` and `.claude` are things people
 *   create, and the server allows them (§1b); only a name that is NOTHING but
 *   dots (`.`, `..`, `...`) is refused, and that one is refused because it is
 *   how a name stops being a name and becomes a direction.
 * - NOTHING IS TRIMMED. The server does not trim either, so a name of spaces is
 *   created exactly as typed. A client that trimmed would either refuse
 *   something the server accepts or post something the user did not type.
 */
export function nameProblem(raw: string): NameProblem | null {
  if (raw.length === 0) return 'empty';
  if (raw.length > MAX_NAME_LEN) return 'too-long';
  if (raw.includes('/') || raw.includes('\\')) return 'slash';
  for (let i = 0; i < raw.length; i += 1) {
    if (raw.charCodeAt(i) < 0x20) return 'control';
  }
  if (/^\.+$/.test(raw)) return 'dots';
  return null;
}

/**
 * The sentence shown under the name row (§6b, verbatim). Four sentences for
 * five rules: a control character and an all-dots name are the same message on
 * purpose — "that name is not allowed" is the whole truth a person needs, and
 * explaining byte ranges would be the app talking about itself.
 */
const NAME_PROBLEM_TEXT: Record<NameProblem, string> = {
  empty: 'Type a name first.',
  slash: 'A name cannot contain a slash.',
  dots: 'That name is not allowed.',
  control: 'That name is not allowed.',
  'too-long': 'That name is too long.',
};

/** The one sentence a `NameProblem` prints. */
export function nameProblemText(p: NameProblem): string {
  return NAME_PROBLEM_TEXT[p];
}

// ---------------------------------------------------------------------------
// Path arithmetic
// ---------------------------------------------------------------------------

/**
 * A path with its trailing slashes gone, so `/home/you/web/` and
 * `/home/you/web` are ONE folder to every comparison below. The filesystem
 * root keeps its single slash — it is the one path that is nothing but a
 * separator.
 */
function trimSlashes(path: string): string {
  let out = path;
  while (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1);
  return out;
}

/**
 * A folder path plus one segment. `name` is a segment the caller has already
 * put through `nameProblem` (or a name the server listed), so this never has
 * to interpret it — it only places the separator, and places exactly one even
 * at the filesystem root.
 */
export function joinPath(dir: string, name: string): string {
  const base = trimSlashes(dir);
  return base === '/' ? `/${name}` : `${base}/${name}`;
}

/**
 * The folder one level up — what a create refetches after it succeeds (§3).
 *
 * The filesystem root is its own parent (there is nowhere above it), and a
 * path with no separator in it answers itself for the same reason: this module
 * only ever sees absolute paths, and inventing a `/` for a relative one would
 * be a guess the panel would then act on.
 */
export function parentPath(p: string): string {
  const path = trimSlashes(p);
  const cut = path.lastIndexOf('/');
  if (cut === -1) return path;
  return cut === 0 ? '/' : path.slice(0, cut);
}

/**
 * Is `path` the root itself, or something inside it (§4a)?
 *
 * `===` or `startsWith(root + '/')`, and the separator in that second form is
 * the whole point: a plain `startsWith(root)` says `/home/userevil` is under
 * `/home/user`, which is how a root change would keep a selection nobody can
 * see and how a pruning pass would keep the wrong cache entries. The same trap
 * is tested on the server side (§8 item 1) against the same shape.
 */
export function isUnder(path: string, root: string): boolean {
  const p = trimSlashes(path);
  const r = trimSlashes(root);
  if (p === r) return true;
  return p.startsWith(r === '/' ? '/' : `${r}/`);
}

/**
 * The `{ path, name }` for a folder in the tree (§4b).
 *
 * At the root the name is the root's own name — `Home`, or the project's name
 * — because that is what the header prints and a destination must never be
 * called something else on the same screen. Below the root the name is the
 * last segment, which is the only part of a path this app ever shows.
 */
export function destinationOf(path: string, root: string, rootName: string): Destination {
  const p = trimSlashes(path);
  if (p === trimSlashes(root)) return { path: root, name: rootName };
  // Trimmed like every other path this module hands out: B10 posts `.path`,
  // and a trailing slash would be the one shape the server never saw before.
  return { path: p, name: fileName(p) };
}

/**
 * The quiet last row of a folder the server had to cap (§3): `1 more item is
 * not shown here.` / `200 more items are not shown here.`
 *
 * It says how many are missing rather than "some", because the number is the
 * difference between "this folder is a bit bigger than the panel" and "this is
 * a cache directory and you are looking at a thousandth of it".
 */
export function truncatedText(n: number): string {
  return n === 1 ? '1 more item is not shown here.' : `${n} more items are not shown here.`;
}

// ---------------------------------------------------------------------------
// The tree
// ---------------------------------------------------------------------------

/**
 * One rendered row of the live tree: the same shape `treeRows` emits, plus the
 * state rows a tree fed over the network needs.
 *
 * `kind: 'state'` is NOT a row anybody can press (`ui/files.ts` draws it as a
 * `<div>`): it carries the sentence in `name`, an empty `path`, and the indent
 * of the folder it belongs to, so a `Loading…` and the rows that replace it sit
 * in exactly the same place and nothing moves when the answer lands.
 */
export interface FsRow {
  kind: 'dir' | 'file' | 'state';
  /** Absolute path. Empty string for a state row — a sentence is not a place. */
  path: string;
  /** The entry's last segment, or the state row's whole sentence. */
  name: string;
  depth: number;
  /** Left padding in px. The A5 arithmetic, from the A5 module: `8 + depth * 14`. */
  indent: number;
  /** Folders only: is this folder open. */
  open: boolean;
  /** The A5 disclosure glyph for a folder, '' for a file and for a state row. */
  caret: TreeRow['caret'];
}

/** A state row at the indent of the folder whose slot it fills. */
function stateRow(text: string, depth: number): FsRow {
  return {
    kind: 'state',
    path: '',
    name: text,
    depth,
    indent: rowIndent(depth),
    open: false,
    caret: '',
  };
}

/**
 * Append one folder's children (or its one state row) at `depth`, recursing
 * into every child that is open. `depth` is the CHILDREN's depth, which is why
 * the root's own state rows land at depth 0 and a nested folder's land one
 * step in from its own row.
 */
function pushChildren(
  out: FsRow[],
  path: string,
  depth: number,
  open: ReadonlySet<string>,
  listings: ReadonlyMap<string, FolderState>,
): void {
  const state = listings.get(path);
  if (state === undefined || state.k === 'loading') {
    out.push(stateRow(LOADING_TEXT, depth));
    return;
  }
  if (state.k === 'error') {
    out.push(stateRow(state.message, depth));
    return;
  }
  if (state.entries.length === 0) {
    out.push(stateRow(EMPTY_TEXT, depth));
    return;
  }
  for (const entry of state.entries) {
    const childPath = joinPath(path, entry.name);
    if (entry.dir) {
      const isOpen = open.has(childPath);
      out.push({
        kind: 'dir',
        path: childPath,
        name: entry.name,
        depth,
        indent: rowIndent(depth),
        open: isOpen,
        caret: caretGlyph(isOpen),
      });
      if (isOpen) pushChildren(out, childPath, depth + 1, open, listings);
    } else {
      out.push({
        kind: 'file',
        path: childPath,
        name: entry.name,
        depth,
        indent: rowIndent(depth),
        open: false,
        caret: '',
      });
    }
  }
  if (state.truncated > 0) out.push(stateRow(truncatedText(state.truncated), depth));
}

/**
 * The whole tree, from the cache and the open set (§3). Pure: the panel only
 * paints what this returns, so every question about what a tree looks like
 * mid-flight is answerable without a browser.
 *
 * ORDER IS THE SERVER'S. Entries are emitted exactly as they arrived, never
 * re-sorted — the server sorts BECAUSE it truncates (§1a), so a client that
 * re-ordered a capped listing would be re-ordering a window and quietly
 * turning `truncated` into a lie about which rows are missing.
 */
export function fsRows(
  root: string,
  open: ReadonlySet<string>,
  listings: ReadonlyMap<string, FolderState>,
): FsRow[] {
  const out: FsRow[] = [];
  pushChildren(out, root, 0, open, listings);
  return out;
}

/**
 * Where A9c's inline name row is inserted, given the rows and the folder the
 * user chose (§6b).
 *
 * Right AFTER the folder's own row, so the thing being named is visibly inside
 * the folder that will hold it; 0 for the panel root, whose row does not exist
 * (the root is the header, not a row). -1 means the folder is not on screen —
 * a listing that changed under the menu, or a folder that closed — and the
 * caller cancels rather than placing the row somewhere arbitrary.
 */
export function createRowIndex(rows: readonly FsRow[], dir: string, root: string): number {
  if (trimSlashes(dir) === trimSlashes(root)) return 0;
  const target = trimSlashes(dir);
  const at = rows.findIndex((r) => r.kind === 'dir' && trimSlashes(r.path) === target);
  return at === -1 ? -1 : at + 1;
}

// ---------------------------------------------------------------------------
// Changes (§7)
// ---------------------------------------------------------------------------

/**
 * `GitChangesResponse.files` → the input the A5 renderer already eats, so the
 * Changes tab is `buildTree` + `treeRows` with real data and not one new line
 * of rendering (`files-model.ts` is UNCHANGED by B2 except for the shared
 * indent helper).
 *
 * Three shapes, and each one is a row `treeRows` can already draw:
 * - a NEW file and a BINARY file carry no numbers at all (numstat prints `-`,
 *   and an untracked file was never diffed) — the numberless row, which is the
 *   row a file without a diff has always been;
 * - a DELETED file carries its `-N` and no `+`, because there is nothing to add
 *   to a file that is gone;
 * - a RENAMED file is one row at its NEW path, which is where the file is now
 *   and the only path the tree can place.
 *
 * `editing` is never set: nothing decides which files a session is touching
 * (plan open decision 3 is the user's), so the amber pulse stays dark rather
 * than guessing.
 */
export function changesToFiles(files: readonly ChangedFile[]): FileChange[] {
  return files.map((f) => {
    const out: FileChange = { path: f.path };
    if (f.status === 'new') return out;
    if (f.status !== 'deleted' && f.add !== null) out.add = f.add;
    if (f.del !== null) out.del = f.del;
    return out;
  });
}
