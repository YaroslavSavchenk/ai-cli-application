/**
 * The HISTORY every part-B3 test drives the UI against: one repository's
 * commits, one commit's detail, and one file's diff — in the exact shapes
 * `shared/protocol.ts` freezes (`GitCommitSummary`, `GitCommitResponse`,
 * `GitCommitDiffResponse`).
 *
 * WHY A FIXTURE AND NOT A MOCK MODULE. B3 deleted the commits half of
 * `ui/files-mock.ts` and B4 deleted what was left of that module; the Commits
 * tab, the commit view and a diff pane all
 * take their answers through an INJECTED gateway now, so every test here is
 * the real UI against a plain object — no module stubbing, no HTTP, no clock.
 * The values are chosen so the pages, the caps and the two special file kinds
 * are all reachable:
 *
 *   - 14 commits, so page one (ten) leaves `more: true` and page two holds 4;
 *   - `NOW` is a fixed instant and every timestamp is relative to it, so
 *     `3 hours ago` is a fact a test can assert instead of a clock it has to
 *     freeze;
 *   - `WIDE` changes 12 files, which is what makes "the first ten blocks are
 *     open, the rest are folded" observable;
 *   - one file is binary, one is past the diff cap, one answers the server's
 *     own 404 sentence.
 *
 * Nothing in here spells a real home folder: `/home/you` is the repository
 * path every fixture in this suite uses.
 */
import type {
  GitCommitDiffResponse,
  GitCommitFile,
  GitCommitResponse,
  GitCommitSummary,
  GitCommitsResponse,
} from '../shared/protocol.ts';

/** The repository the fixture history belongs to (a `GitChangesResponse.repoRoot`). */
export const REPO_ROOT = '/work/api';

/** The branch its HEAD is on. */
export const BRANCH = 'main';

/** The instant every relative time in a test is said against. */
export const NOW = Date.parse('2026-09-21T12:00:00+02:00');

/** The `origin` the server parsed out of the repository's config (decision D2). */
export const GITHUB = { owner: 'you', repo: 'app' };

/** A 40-hex hash from a small number — the identity of commit `i`. */
export function hashOf(i: number): string {
  return (i + 1).toString(16).padStart(2, '0').repeat(20);
}

/** git's own abbreviation of it, as `%h` hands it over. */
function shortOf(i: number): string {
  return hashOf(i).slice(0, 7);
}

/** The path whose diff is BINARY, the one past the cap, and the one that fails. */
export const BINARY_PATH = 'launcher/icon.ico';
export const TOO_LARGE_PATH = 'web/dist/bundle.js';
export const GONE_PATH = 'server/gone.ts';

/** The server's own sentence for a commit (or a file of it) that is not there. */
export const GONE_TEXT = 'This commit is no longer there.';

interface Spec {
  subject: string;
  author: string;
  /** How long before `NOW` it was authored. */
  minutesAgo: number;
  files: GitCommitFile[];
  /** The message without its subject; `''` when there is none. */
  body?: string;
  /** Set only when the committer is NOT the author. */
  committer?: string | null;
  parents?: number;
  /** Files the server left out past its cap. */
  truncated?: number;
  /** A repository whose `origin` is not on github.com answers null. */
  github?: { owner: string; repo: string } | null;
}

const f = (path: string, add: number | null, del: number | null): GitCommitFile => ({
  path,
  add,
  del,
});

/**
 * The history itself, newest first — the order `git log` returns and the order
 * the panel draws without re-sorting.
 */
const SPECS: Spec[] = [
  {
    subject: 'Define the update wire contract',
    author: 'Sava',
    minutesAgo: 180,
    body: 'The launcher and the service disagreed about who promotes a new\nbuild. This settles it: the service writes, the launcher reads.',
    files: [f('shared/protocol.ts', 12, 4), f('server/ws.ts', 6, 0)],
  },
  {
    subject: 'Restart handoff: promote host and next on launcher start',
    author: 'Sava',
    minutesAgo: 1500,
    committer: 'Fable',
    files: [f('launcher/launch.ps1', 20, 3), f(BINARY_PATH, null, null)],
  },
  {
    subject: 'Keep scrollback on reattach and replay buffered frames',
    author: 'Ada Lovelace',
    minutesAgo: 2880,
    files: [f('server/pty-pool.ts', 31, 9), f(TOO_LARGE_PATH, 4100, 12), f(GONE_PATH, 2, 2)],
  },
  {
    // The WIDE one: twelve files, so two of its blocks start folded.
    subject: 'Tab strip: merge by dragging a tab onto a pane',
    author: 'Sava',
    minutesAgo: 4320,
    truncated: 3,
    files: Array.from({ length: 12 }, (_, i) => f(`web/src/ui/part-${i + 1}.ts`, i + 1, i)),
  },
  {
    subject: 'Initial backend: sessions over a socket',
    author: 'Sava',
    minutesAgo: 7200,
    parents: 0,
    github: null,
    files: [f('README.md', 40, 0)],
  },
];

/** Nine more, so the first page is full and a second one exists. */
while (SPECS.length < 14) {
  const n = SPECS.length;
  SPECS.push({
    subject: `Tidy the launcher script, step ${n - 4}`,
    author: 'Sava',
    minutesAgo: 7200 + n * 600,
    files: [f(`launcher/step-${n}.ps1`, n, 1)],
  });
}

/** The ISO timestamp of commit `i`, in the repository's own zone. */
function isoAt(minutesAgo: number): string {
  const at = new Date(NOW - minutesAgo * 60_000);
  // `%aI` carries an offset; the fixture uses +02:00 throughout, which is what
  // makes `absoluteDate()` readable in the assertions.
  const shifted = new Date(at.getTime() + 2 * 3600_000);
  const p = (n: number): string => String(n).padStart(2, '0');
  return (
    `${shifted.getUTCFullYear()}-${p(shifted.getUTCMonth() + 1)}-${p(shifted.getUTCDate())}` +
    `T${p(shifted.getUTCHours())}:${p(shifted.getUTCMinutes())}:${p(shifted.getUTCSeconds())}+02:00`
  );
}

/**
 * A capped answer still COUNTS every file: `commit.files` is the total git
 * reported, `files` is the page of them the server kept, and `truncated` is
 * the difference — which is what `N files changed` and the `N more files are
 * not shown.` row have to agree about.
 */
function sumOf(files: readonly GitCommitFile[]): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const file of files) {
    add += file.add ?? 0;
    del += file.del ?? 0;
  }
  return { add, del };
}

/** Every commit's summary row, newest first. */
export const SUMMARIES: GitCommitSummary[] = SPECS.map((s, i) => ({
  hash: hashOf(i),
  shortHash: shortOf(i),
  subject: s.subject,
  author: s.author,
  authoredAt: isoAt(s.minutesAgo),
  ...sumOf(s.files),
  files: s.files.length + (s.truncated ?? 0),
}));

export const HEAD = hashOf(0);
export const TOTAL = SUMMARIES.length;
/** The commit with twelve files — the one that proves the fold-past-ten rule. */
export const WIDE = hashOf(3);
/** The commit whose repository has no `origin` on github.com. */
export const NO_GITHUB = hashOf(4);

const BY_HASH = new Map<string, { spec: Spec; summary: GitCommitSummary }>(
  SPECS.map((spec, i) => [hashOf(i), { spec, summary: SUMMARIES[i] as GitCommitSummary }]),
);

/** One commit's detail, or NULL for a hash this history does not have. */
export function detailOf(hash: string): GitCommitResponse | null {
  const found = BY_HASH.get(hash);
  if (found === undefined) return null;
  const { spec, summary } = found;
  return {
    commit: summary,
    body: spec.body ?? '',
    committer: spec.committer ?? null,
    committedAt: summary.authoredAt,
    parents: spec.parents ?? 1,
    branch: BRANCH,
    github: spec.github === undefined ? GITHUB : spec.github,
    files: spec.files,
    truncated: spec.truncated ?? 0,
  };
}

/** One page of the history, as the route answers it. */
export function pageOf(limit: number, skip: number): GitCommitsResponse {
  return {
    isRepo: true,
    branch: BRANCH,
    head: HEAD,
    total: TOTAL,
    commits: SUMMARIES.slice(skip, skip + limit),
    more: skip + limit < SUMMARIES.length,
  };
}

/** A repository with nothing in it — an unborn HEAD on a named branch. */
export const EMPTY_PAGE: GitCommitsResponse = {
  isRepo: true,
  branch: BRANCH,
  head: null,
  total: 0,
  commits: [],
  more: false,
};

/** A folder that is not in a repository at all. */
export const NOT_A_REPO: GitCommitsResponse = {
  isRepo: false,
  branch: null,
  head: null,
  total: 0,
  commits: [],
  more: false,
};

/**
 * One file's diff. Deterministic and SMALL — four rows with one of each kind,
 * so a test can count what a block drew against what the answer carried, and
 * the two numbers of a hunk header are the only place the gutters differ.
 */
export function diffOf(hash: string, path: string): GitCommitDiffResponse {
  if (path === BINARY_PATH) return { binary: true, tooLarge: false, lines: [] };
  if (path === TOO_LARGE_PATH) return { binary: false, tooLarge: true, lines: [] };
  const n = (hash.charCodeAt(0) % 3) + 1;
  return {
    binary: false,
    tooLarge: false,
    lines: [
      { kind: 'hunk', oldNo: null, newNo: null, text: `@@ -1,${n} +1,${n + 1} @@` },
      { kind: 'ctx', oldNo: 1, newNo: 1, text: `const path = "${path}";` },
      { kind: 'del', oldNo: 2, newNo: null, text: 'let total = 0;' },
      { kind: 'add', oldNo: null, newNo: 2, text: 'const total = 0;' },
    ],
  };
}
