/**
 * Files panel model (Nocturne part A5) — every decision the panel makes about
 * SHAPE, with no DOM and no state import, so `node --test` can drive it.
 *
 * What lives here: the flat-path-list → tree build, the row flattening a
 * rendered tree needs (depth, indent, caret, which rows pulse), the
 * since-last-commit summary, the per-extension badge table, and the plural
 * copy the two tabs print. What does NOT live here: anything that reads or
 * writes app state (the open-folder set is passed in), and the data itself
 * (the Changes tab's real `git diff --numstat` since part B2, through
 * `ui/fs-model.ts`'s `changesToFiles`; the Commits tab is still
 * `ui/files-mock.ts` until `git log` lands in part B3).
 *
 * THE INPUT SHAPE WAS THE FUTURE ONE, AND IT HELD. `FileChange[]` is a flat
 * list of paths with `add`/`del`/`editing` — exactly what a numstat walk
 * produces — and the tree is derived, so B2 replaced the mock data without
 * changing one line here. Input ORDER is preserved (no sorting): git already
 * returns a stable order, and the panel renders exactly that order.
 *
 * The badge colours are `oklch()`. That is safe on purpose: they are CSS-only
 * marks in the chrome and never reach xterm's theme parser (tokens.css header,
 * and the google-fonts/oklch lesson) — they live in tokens.css as a
 * `--badge-<kind>-*` pair per family and this table only names the family.
 */

import type { CommitFileChange } from './commit-model.ts';

/** One changed (or merely listed) file, as B2's `git diff --numstat` walk hands it over. */
export interface FileChange {
  /** Repo-relative path with `/` separators, e.g. `web/src/main.ts`. */
  path: string;
  /** Added lines since the last commit; absent = no diff. */
  add?: number;
  /** Removed lines since the last commit; absent = no diff. */
  del?: number;
  /**
   * The session is editing this file right now. Pulses amber. NOTHING SETS IT
   * since B2: which files a session is touching is plan open decision 3, the
   * user's to settle, so the pulse stays dark rather than guessing
   * (`ui/fs-model.ts` `changesToFiles` leaves it unset).
   */
  editing?: boolean;
}

/** One commit, as B3's `git log` walk will hand it over. */
export interface CommitEntry {
  /**
   * Short hash doubles as the IDENTITY: the commit view is opened by it and
   * the collapse keys are built from it. B3 keeps that (a hash is unique in a
   * repository), so nothing downstream needs a second id. Rendered mono.
   */
  hash: string;
  /** Subject line only. */
  message: string;
  author: string;
  /** Already-relative time ("2 hours ago") — B3 decides where it is formatted. */
  when: string;
  add: number;
  del: number;
  /**
   * What the commit touched — the commit view's whole body (part A6). The two
   * numbers above are the sums of these, which
   * `tests/ui-commit-model.test.ts` pins on the mock so the list row and the
   * opened view can never state different totals.
   */
  files: CommitFileChange[];
}

/** A folder or file in the derived tree. */
export interface TreeNode {
  /** Full path from the root (the folder key the open-set uses). */
  path: string;
  /** Last segment — the only thing ever rendered. */
  name: string;
  dir: boolean;
  children: TreeNode[];
  add: number;
  del: number;
  editing: boolean;
}

/** One rendered row: a folder or a file, already flattened for the open state. */
export interface TreeRow {
  path: string;
  name: string;
  depth: number;
  /** Left padding in px — `8 + depth * 14`. */
  indent: number;
  dir: boolean;
  /** Folders only: is this folder open. */
  open: boolean;
  /** Disclosure glyph for a folder, '' for a file. Geometry, not text. */
  caret: '' | '▾' | '▸';
  hasDiff: boolean;
  add: number;
  del: number;
  /** This file is being edited (files only). */
  editing: boolean;
  /** This row pulses amber: an edited file, or a folder holding one. */
  busy: boolean;
}

/** The summary row's three numbers. */
export interface DiffSummary {
  add: number;
  del: number;
  /** How many files carry a diff. */
  files: number;
}

/**
 * The disclosure glyph of anything that folds: a tree folder (this module) and
 * a commit view's file block (ui/commit-view.ts). ONE definition, because it is
 * GEOMETRY, not text — it always lives in an `aria-hidden` span beside a
 * control that states its own `aria-expanded`, and the copy rules' allowlist
 * should never need a second entry for the same mark.
 */
export function caretGlyph(open: boolean): '▾' | '▸' {
  return open ? '▾' : '▸';
}

const ROW_INDENT_BASE = 8;
const ROW_INDENT_STEP = 14;

/**
 * How far in a row at `depth` sits, in px. GEOMETRY, like `caretGlyph` beside
 * it, and exported for the same reason: part B2's live file tree
 * (`ui/fs-model.ts` `fsRows`) draws in the SAME panel as this module's rows,
 * so the two must be one arithmetic and not two copies that agree today.
 */
export function rowIndent(depth: number): number {
  return ROW_INDENT_BASE + depth * ROW_INDENT_STEP;
}

// ---------------------------------------------------------------------------
// Tree
// ---------------------------------------------------------------------------

/**
 * Flat paths → a folder tree. Every segment but the last is a folder; a path
 * seen twice reuses its node. A folder's `add`/`del` are the sums beneath it
 * and its `editing` is true when ANY descendant is being edited — which is
 * what makes the amber pulse climb the spine without a second walk.
 *
 * A TRAILING SLASH MEANS A FOLDER (part B2, decided from the measured shape of
 * `git status --porcelain`): an untracked DIRECTORY arrives as ONE row,
 * `sub/`, because git reports the directory and not the files under it. So the
 * last segment of such a path is a folder node with NO children — which is
 * exactly what git said: something new is there, and nothing about what is
 * inside it. Splitting naively would have made it a FILE row called `sub`,
 * claiming a file that does not exist; giving it invented children would claim
 * knowledge nobody has.
 */
export function buildTree(files: readonly FileChange[]): TreeNode[] {
  const roots: TreeNode[] = [];
  const byPath = new Map<string, TreeNode>();

  for (const f of files) {
    const marked = f.path.endsWith('/');
    const segments = f.path.split('/').filter((s) => s !== '');
    if (segments.length === 0) continue;
    let parentChildren = roots;
    let prefix = '';
    for (let i = 0; i < segments.length; i += 1) {
      const name = segments[i] as string;
      const last = i === segments.length - 1 && !marked;
      prefix = prefix === '' ? name : `${prefix}/${name}`;
      let node = byPath.get(prefix);
      if (node === undefined) {
        node = { path: prefix, name, dir: !last, children: [], add: 0, del: 0, editing: false };
        byPath.set(prefix, node);
        parentChildren.push(node);
      }
      // Every node on the path carries the file's numbers, so a folder row
      // already knows its subtree's totals and whether it must pulse.
      node.add += f.add ?? 0;
      node.del += f.del ?? 0;
      node.editing = node.editing || f.editing === true;
      parentChildren = node.children;
    }
  }
  return roots;
}

/**
 * Tree → the rows actually drawn, for one open-folder set. A closed folder
 * hides its subtree entirely; a file row always knows whether it has a diff,
 * because that decides its ink.
 */
export function treeRows(
  nodes: readonly TreeNode[],
  openFolders: ReadonlySet<string>,
  depth = 0,
): TreeRow[] {
  const out: TreeRow[] = [];
  for (const n of nodes) {
    const indent = rowIndent(depth);
    if (n.dir) {
      const open = openFolders.has(n.path);
      // A folder with NOTHING under it gets no caret: since part B2 one exists
      // — git reports an untracked DIRECTORY as a single `sub/` row and says
      // nothing about its contents — and a disclosure mark that opens onto an
      // empty tree is a promise the data cannot keep.
      const foldable = n.children.length > 0;
      out.push({
        path: n.path,
        name: n.name,
        depth,
        indent,
        dir: true,
        open,
        caret: foldable ? caretGlyph(open) : '',
        hasDiff: false,
        add: 0,
        del: 0,
        editing: false,
        busy: n.editing,
      });
      if (open) out.push(...treeRows(n.children, openFolders, depth + 1));
    } else {
      out.push({
        path: n.path,
        name: n.name,
        depth,
        indent,
        dir: false,
        open: false,
        caret: '',
        hasDiff: n.add > 0 || n.del > 0,
        add: n.add,
        del: n.del,
        editing: n.editing,
        busy: n.editing,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Summaries and copy
// ---------------------------------------------------------------------------

/** Totals for the summary row: only files that actually carry a diff count. */
export function diffSummary(files: readonly FileChange[]): DiffSummary {
  let add = 0;
  let del = 0;
  let changed = 0;
  for (const f of files) {
    const a = f.add ?? 0;
    const d = f.del ?? 0;
    add += a;
    del += d;
    if (a > 0 || d > 0) changed += 1;
  }
  return { add, del, files: changed };
}

/** `since last commit in 1 file` / `… in 7 files` (copy rule: counts pluralise). */
export function summaryText(files: number): string {
  return `since last commit in ${files} ${files === 1 ? 'file' : 'files'}`;
}

/** `main, 1 commit` / `main, 5 commits` — the branch is the only name in it. */
export function commitsHeaderText(branch: string, count: number): string {
  return `${branch}, ${count} ${count === 1 ? 'commit' : 'commits'}`;
}

// ---------------------------------------------------------------------------
// File-type badges
// ---------------------------------------------------------------------------

/**
 * Colour families. The LABEL can differ inside a family (`.tsx` reads TSX on
 * the TypeScript colours) — the family only decides the two custom properties
 * `--badge-<kind>-bg` / `--badge-<kind>-fg` that app.css maps onto the chip.
 */
export type BadgeKind =
  | 'ts'
  | 'js'
  | 'py'
  | 'md'
  | 'json'
  | 'ps'
  | 'css'
  | 'html'
  | 'sh'
  | 'yml'
  | 'rs'
  | 'go'
  | 'plain';

export interface Badge {
  /** Up to three characters, mono, uppercase — a mark, never a sentence. */
  label: string;
  kind: BadgeKind;
}

/** Extension → mark + colour family (the v3 reference's own table). */
const BADGES: Record<string, Badge> = {
  ts: { label: 'TS', kind: 'ts' },
  tsx: { label: 'TSX', kind: 'ts' },
  js: { label: 'JS', kind: 'js' },
  jsx: { label: 'JSX', kind: 'js' },
  mjs: { label: 'JS', kind: 'js' },
  py: { label: 'PY', kind: 'py' },
  md: { label: 'MD', kind: 'md' },
  json: { label: '{ }', kind: 'json' },
  ps1: { label: 'PS', kind: 'ps' },
  css: { label: 'CSS', kind: 'css' },
  html: { label: '<>', kind: 'html' },
  sh: { label: 'SH', kind: 'sh' },
  yml: { label: 'YML', kind: 'yml' },
  yaml: { label: 'YML', kind: 'yml' },
  rs: { label: 'RS', kind: 'rs' },
  go: { label: 'GO', kind: 'go' },
};

/**
 * A file type the table does not know gets a neutral chip with a centred dot —
 * a mark that says "a file", not an invented three-letter word. The glyph is
 * decorative (the chip is aria-hidden; the name beside it is the content).
 */
const UNKNOWN_BADGE: Badge = { label: '·', kind: 'plain' };

/** Badge for a file NAME (not a path). A dotfile has no extension. */
export function badgeFor(name: string): Badge {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return UNKNOWN_BADGE;
  const ext = name.slice(dot + 1).toLowerCase();
  return BADGES[ext] ?? UNKNOWN_BADGE;
}
