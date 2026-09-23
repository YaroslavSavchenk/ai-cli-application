/**
 * Wire shapes for git: working-tree changes and commits (log, one commit, one file's diff).
 *
 * Split from shared/protocol.ts (O8, 2026-09-23) — a pure move; the wire
 * contract is unchanged. Import from shared/protocol.ts, which re-exports
 * everything here. Sibling pieces: 
 *   protocol.ts (the single import point), protocol-settings.ts, protocol-runtime.ts, protocol-github.ts, protocol-fs.ts, protocol-git.ts.
 */

// ---------------------------------------------------------------------------
// Working-tree changes (GET /api/git/changes)
// ---------------------------------------------------------------------------

/** GET /api/git/changes?root=<abs> — how one file differs from the last commit. */
export type ChangeStatus = 'modified' | 'new' | 'deleted' | 'renamed';

export interface ChangedFile {
  /**
   * Path relative to the REPOSITORY root, `/` separated. One special shape,
   * measured against git 2.43.0: `--untracked-files=normal` collapses a whole
   * new folder into ONE row whose path ends in `/` (`sub/`), because walking
   * into it is the cost that flag exists to avoid.
   */
  path: string;
  /** null for a binary file (numstat prints `-`), and for an untracked file. */
  add: number | null;
  del: number | null;
  status: ChangeStatus;
}

/** GET /api/git/changes?root=<abs>. A root that is not in a repository is NOT an error. */
export interface GitChangesResponse {
  isRepo: boolean;
  /**
   * The repository's own root. null when isRepo is false.
   *
   * MAY LIE OUTSIDE EVERY ANCHOR. It can be an ANCESTOR of the `root` that was
   * asked about (a project registered at `web/` inside a repository), and open
   * decision 1 chose the WHOLE repository — so this one value can name a folder
   * /api/fs/entries would refuse to list. It is a RESPONSE field only: it is
   * never logged, and no listing or create takes its word for anything.
   */
  repoRoot: string | null;
  /**
   * Current branch, or null on a DETACHED head. Not null on an empty
   * repository: `git branch --show-current` prints `main` there (measured,
   * git 2.43.0), and answering null would be a lie about a real branch.
   */
  branch: string | null;
  files: ChangedFile[];
  /** Files left out because the repository is larger than the cap. */
  truncated: number;
}

// ---------------------------------------------------------------------------
// Commits (Nocturne B3, spec `.claude/plans/nocturne/PLAN-B3.md`). A hash is
// always the full 40 hex. No e-mail address and no remote URL is ever part of
// an answer.
//
// Every string below is control-stripped (C0, C1, U+2028/9) and capped by the
// server — WITH ONE EXCEPTION, `GitCommitFile.path`, which is git's bytes
// verbatim. It has to be: the page sends it straight back as the `?path=` of
// GET /api/git/commit-diff, and a stripped or truncated path names a different
// file, or none. Render it with `textContent` and nothing else.
// ---------------------------------------------------------------------------

/** One row of GET /api/git/commits. */
export interface GitCommitSummary {
  /** 40 hex — the identity. */
  hash: string;
  /** git's own abbreviation (`%h`). */
  shortHash: string;
  /** First line of the message, ≤ 500 chars. */
  subject: string;
  /** The AUTHOR's name, ≤ 200 chars. */
  author: string;
  /** Strict ISO 8601 (`%aI`); '' when git's value fails the server's strict check. */
  authoredAt: string;
  /** Text lines only; a binary file adds 0. A merge counts against its first parent. */
  add: number;
  del: number;
  /** Files changed. */
  files: number;
}

/** GET /api/git/commits?root=<abs>&limit=<1..50>&skip=<0..>&from=<40 hex, optional>.
 *  A root that is not in a repository is NOT an error. */
export interface GitCommitsResponse {
  isRepo: boolean;
  /** As `GitChangesResponse.branch`: null on a detached head. */
  branch: string | null;
  /** 40 hex; null on an empty repository and when isRepo is false. */
  head: string | null;
  /** Commits reachable from `from` (or HEAD); 0 when head is null. */
  total: number;
  commits: GitCommitSummary[];
  /** At least one older commit exists past this page. */
  more: boolean;
}

/** One file of a commit. `add` / `del` are null for a binary file. */
export interface GitCommitFile {
  /**
   * Relative to the REPOSITORY root, `/` separated, and git's VERBATIM bytes:
   * the one string here that is NOT control-stripped and NOT capped, because it
   * must round-trip as the `?path=` pathspec of GET /api/git/commit-diff.
   */
  path: string;
  add: number | null;
  del: number | null;
}

/** GET /api/git/commit?root=<abs>&hash=<40 hex>. */
export interface GitCommitResponse {
  commit: GitCommitSummary;
  /** The message without its subject, ≤ 8 KiB, '' when there is none. Keeps `\n`. */
  body: string;
  /** The committer's NAME when it differs from the author's, else null. */
  committer: string | null;
  /** Strict ISO 8601 (`%cI`); '' when git's value fails the server's strict check. */
  committedAt: string;
  /** 0 = root commit, 1 = ordinary, ≥ 2 = merge. */
  parents: number;
  branch: string | null;
  /** `origin` on github.com, parsed by the server; the page builds the URL. */
  github: { owner: string; repo: string } | null;
  files: GitCommitFile[];
  /** Files left out past the cap. */
  truncated: number;
}

export type GitDiffLineKind = 'add' | 'del' | 'ctx' | 'hunk';

export interface GitDiffLine {
  kind: GitDiffLineKind;
  /** Line number in the old / new file; null where the side has none. */
  oldNo: number | null;
  newNo: number | null;
  /** Without the leading sign, ≤ 2000 chars. */
  text: string;
}

/** GET /api/git/commit-diff?root=<abs>&hash=<40 hex>&path=<repo-relative>. */
export interface GitCommitDiffResponse {
  binary: boolean;
  /** The file's diff passed the line cap; `lines` is then empty. */
  tooLarge: boolean;
  lines: GitDiffLine[];
}
