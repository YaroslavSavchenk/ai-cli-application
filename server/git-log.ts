/**
 * The Files panel's `Commits` tab and commit view (B3, 2026-09-21), for
 *   GET /api/git/commits?root=&limit=&skip=&from=
 *   GET /api/git/commit?root=&hash=
 *   GET /api/git/commit-diff?root=&hash=&path=
 * Spec: `.claude/plans/nocturne/PLAN-B3.md` § "Phase 1 — backend".
 *
 * IT SHARES server/git.ts's RUNNER rather than copying it: `runGitCapture`
 * (argv only, `shell: false`, stdin ignored, STDERR DISCARDED, 2 MiB stdout
 * cap, 5 s SIGKILL timeout), `capturedOrFail` and `GIT_ENV`. One posture, one
 * place to review it.
 *
 * ── WHAT A REPOSITORY'S OWN CONFIG CAN DO, MEASURED against git 2.43.0 on
 *    2026-09-21 (a fixture repo with hostile values; each program `touch`ed a
 *    marker file, and the marker is what was checked) ────────────────────────
 *
 *  * `log.showSignature=true` + `gpg.program=<script>`: the script RAN for a
 *    plain `git log -1 --format='%H %s'` and for `git show` on a commit with a
 *    `gpgsig` header — i.e. merely LISTING commits executes it. With
 *    `--no-show-signature` it did not run. PINNED with the flag.
 *  * `.gitattributes` `*.log diff=mytc` + `diff.mytc.textconv=<script>`: the
 *    script RAN for `git show --format= <rev> -- t.log`. With `--no-textconv`
 *    it did not. PINNED with the flag. (It does NOT run for `--numstat` —
 *    measured — but the patch call needs it anyway.)
 *  * `diff.external=<script>` / `GIT_EXTERNAL_DIFF`: did NOT run for `git show`
 *    or `git log -p` (both default to `--no-ext-diff`), and DID run for a bare
 *    `git diff` (non-vacuity — the fixture is real). The attribute-driven
 *    `diff.mytc.command=<script>` likewise ran only when `--ext-diff` was
 *    passed. `--no-ext-diff` is passed anyway: it pins today's DEFAULT so a
 *    later git, or a later call here that uses `git diff`, cannot quietly
 *    become an execution site.
 *  * `core.pager` / `pager.log` naming a program: INERT — no tty, so git never
 *    starts a pager (measured: marker absent).
 *  * `core.fsmonitor=<script>`: covered by GIT_ENV in server/git.ts (B2).
 *
 * Output-shaping config, measured the same day:
 *
 *  * `i18n.logOutputEncoding=ISO-8859-1` RE-ENCODED `%s`: `café` came back as
 *    the latin-1 bytes, i.e. invalid UTF-8 in a JSON response. `--encoding=UTF-8`
 *    restored it. PINNED with the flag.
 *  * `log.mailmap` / `mailmap.file` (which READS a file the repo names) change
 *    `%aN`/`%cN` and NOT `%an`/`%cn`. This module only ever asks for the
 *    lower-case, raw forms, so no mailmap file is ever consulted — measured:
 *    `%an` was unchanged with `log.mailmap=true` and a `.mailmap` in place.
 *  * `format.pretty='HIJACKED %H'` and `log.decorate=full`: NO effect — an
 *    explicit `--format=` wins. Pinned by always passing `--format=`.
 *  * `core.abbrev` changes `%h` (measured: 4 and 40 both honoured), so the
 *    short hash is validated and capped here rather than trusted.
 *  * `diff.noprefix` / `diff.mnemonicPrefix` change the `a/` `b/` prefixes.
 *    Nothing here parses them: parseUnifiedDiff starts at the first `@@` and
 *    reads only the four line markers after it.
 *  * `diff.orderFile` naming a missing file makes the call exit 128 → the
 *    constant 500. It executes nothing; see server/git.ts's GIT_ENV comment.
 *  * `diff.context` is overridden per call with `--unified=3`, so a repository
 *    cannot inflate its own diffs past the 2000-line cap.
 *  * `--no-renames` (a decision, not a hardening): a rename is a delete plus an
 *    add, one path per row. MEASURED, and load-bearing for the parser — the
 *    `-z` numstat RENAME record is the only form whose second and third fields
 *    are PATHS, and a path may begin with `\x01`. With renames off that form
 *    never appears; parseLogRecords still consumes it correctly if it ever
 *    does, so the record framing holds either way.
 *
 * ── FRAMING (the reason nothing here splits on `\n`) ────────────────────────
 * A commit subject, body and author name are attacker-controlled text. The
 * `--format` used is `%x01<field>%x00<field>%x00…`, read with `-z`, and
 * parseLogRecords walks it POSITIONALLY: `\x01`, then exactly N NUL-terminated
 * fields, then the `-z` numstat records, then the next `\x01`. MEASURED: git
 * truncates `%s` / `%b` at an embedded NUL (a commit object written with
 * `hash-object --literally` carrying `sub\0ject` printed `sub` and the
 * FOLLOWING records were intact), so no field can contain the separator and no
 * subject can forge a record boundary. A subject holding `\x01` + 40 hex +
 * separators — the exact forgery a `split('\x01')` parser would fall for — was
 * committed into the fixture and is a test.
 *
 * Residual, stated: `%an` and `%s` sit in the same record, so an author NAME
 * containing a raw `\x00` is impossible but text can still not move between
 * fields — each is its own NUL-terminated field. Nothing is shared.
 *
 * Erasable TypeScript only; relative imports carry explicit .ts extensions.
 */
import type {
  GitCommitDiffResponse,
  GitCommitFile,
  GitCommitResponse,
  GitCommitSummary,
  GitCommitsResponse,
  GitDiffLine,
} from '../shared/protocol.ts';
import type { Logger } from './config.ts';
import {
  FS_LIST_GONE,
  FS_NO_READ_PERMISSION,
  FS_PATH_BAD,
  FsBrowseError,
  resolveUnderAllowed,
} from './fsbrowse.ts';
import { capturedOrFail, runGitCapture } from './git.ts';
import { parseGithubRemote } from './github.ts';
import { isExistingDirectory } from './projects.ts';

/** 400: the hash / `from` the client sent is not a hash at all. */
export const GIT_COMMIT_BAD = 'The app cannot open that commit.';
/** 404: syntactically a hash, but this repository has no such commit. */
export const GIT_COMMIT_GONE = 'This commit is no longer there.';

/** Page size bounds for GET /api/git/commits. */
export const MIN_LIMIT = 1;
export const MAX_LIMIT = 50;
export const DEFAULT_LIMIT = 10;
/** Past this a `skip` is a typo or a probe, not paging. */
export const MAX_SKIP = 1_000_000;

/** Files listed for one commit; the rest are `truncated` (as the Changes tab). */
export const MAX_COMMIT_FILES = 2000;
/** Diff rows for one file; past this the answer is `tooLarge` with no rows. */
export const MAX_DIFF_LINES = 2000;
/** One diff row's text. */
export const MAX_DIFF_LINE_CHARS = 2000;

const MAX_SUBJECT_CHARS = 500;
const MAX_NAME_CHARS = 200;
const MAX_BODY_BYTES = 8 * 1024;
/** A pathspec the client sent. Longer than any real path; a NUL is refused. */
const MAX_PATH_BYTES = 4096;

const HASH_RE = /^[0-9a-f]{40}$/;
/** `%h` is `core.abbrev`-dependent, so it is validated like anything else. */
const SHORT_HASH_RE = /^[0-9a-f]{1,40}$/;
/** `%aI` / `%cI`: strict ISO 8601 with an offset. Anything else becomes ''. */
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;

/**
 * Flags every `git log` in this module carries. Each one is measured in the
 * module comment above; three of them (`--no-show-signature`, `--no-textconv`,
 * `--no-ext-diff`) are the difference between reading a repository and running
 * its owner's code.
 *
 * `-O/dev/null` is the odd one: it is an EMPTY diff order file, and its job is
 * to make `diff.orderFile` inert. MEASURED (git 2.43.0): a repo-local
 * `diff.orderFile=/nonexistent/order/file` makes `git log --numstat` exit 128,
 * which every commit route would have answered as a 500 — with `-O/dev/null`
 * it exits 0. Measured twice over: the numstat ORDER with `-O/dev/null` is
 * byte-identical to the order with no orderFile at all (`a.txt, m.txt, z.txt`),
 * and a repo orderFile that WORKS (`z.txt` first) is overridden back to that
 * default. It is on the argv rather than in GIT_ENV on purpose: a fourth
 * GIT_CONFIG_* entry would change the Changes tab's posture for a B3 finding.
 */
const LOG_FLAGS: readonly string[] = [
  '--no-show-signature',
  '--no-notes',
  '--no-color',
  '--no-ext-diff',
  '--no-textconv',
  '--no-renames',
  '--diff-merges=first-parent',
  '--encoding=UTF-8',
  '-O/dev/null',
];

/**
 * ONLY ON THE `-1` CALLS, and it is not cosmetic: `git log -1 <hash> -- <path>`
 * does HISTORY SIMPLIFICATION. When `<hash>` did not touch `<path>`, git WALKS
 * BACK to the nearest ancestor that did and prints THAT commit's numstat and
 * patch — under the hash the client asked about.
 *
 * MEASURED (git 2.43.0, this module's exact argv): a fixture where C1 created
 * `f.txt` and C3 touched only `h.txt`; `git log -1 … C3 -- f.txt` answered
 * `2\t0\tf.txt`, i.e. C1's creation, presented as C3's work. With `--no-walk`
 * the same call answers NOTHING, a path C3 really did touch still answers, a
 * ROOT commit still diffs against the empty tree, and a merge with
 * `--diff-merges=first-parent` still answers its own first-parent diff.
 *
 * It is also on the two `-1` calls that pass no pathspec, where it costs
 * nothing (measured: byte-identical records) and removes the question.
 *
 * NEVER on the LIST call — that one is meant to walk.
 */
const NO_WALK = '--no-walk';

/** 5 NUL-terminated fields: hash, short hash, authored date, author, subject. */
const LIST_FORMAT = '--format=%x01%H%x00%h%x00%aI%x00%an%x00%s';
const LIST_FIELDS = 5;
/**
 * 9 fields, and THE FIRST FIVE ARE LIST_FORMAT'S, in that order: `summaryOf`
 * reads a `GitCommitSummary` off the head of either record, so the two formats
 * may not drift apart. (They did, once, during development: `%cI` sat at index
 * 4 and the commit view's subject came back as a date.)
 */
const DETAIL_FORMAT =
  '--format=%x01%H%x00%h%x00%aI%x00%an%x00%s%x00%cI%x00%cn%x00%P%x00%b';
const DETAIL_FIELDS = 9;

// ---------------------------------------------------------------------------
// Gates. Every client string passes one of these BEFORE it can reach argv.
// ---------------------------------------------------------------------------

/** 40 lower-case hex, or the 400. Short, upper-case and `-x` all fail here. */
export function requireHash(raw: string | null): string {
  if (raw === null || !HASH_RE.test(raw)) throw new FsBrowseError(400, GIT_COMMIT_BAD);
  return raw;
}

/** A strict decimal integer in `[min, max]`; absent means `fallback`. */
export function requireInt(raw: string | null, min: number, max: number, fallback: number): number {
  if (raw === null || raw === '') return fallback;
  // `Number.parseInt` would accept `10abc`, `0x10` and ` 10`; a query value is
  // exactly its digits or it is a 400.
  if (!/^\d{1,9}$/.test(raw)) throw new FsBrowseError(400, GIT_COMMIT_BAD);
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new FsBrowseError(400, GIT_COMMIT_BAD);
  return n;
}

/**
 * A repo-relative path the client sent, on its way to a PATHSPEC after `--`.
 *
 * Refused: empty, over 4096 bytes, a NUL, absolute, and any empty / `.` / `..`
 * segment. Everything that survives still reaches git only after `--` and with
 * `GIT_LITERAL_PATHSPECS=1` (server/git.ts's GIT_ENV), so `:(glob)*`, `*.ts`
 * and `^x` are file NAMES, not patterns — measured, and a test.
 *
 * The calls it feeds read the OBJECT STORE (`git log <hash> -- <path>`), never
 * the working tree, so even a path that named something else could not read a
 * file outside the repository.
 */
export function requirePath(raw: string | null): string {
  if (raw === null || raw === '') throw new FsBrowseError(400, FS_PATH_BAD);
  if (Buffer.byteLength(raw, 'utf8') > MAX_PATH_BYTES) throw new FsBrowseError(400, FS_PATH_BAD);
  if (raw.includes('\0')) throw new FsBrowseError(400, FS_PATH_BAD);
  if (raw.startsWith('/')) throw new FsBrowseError(400, FS_PATH_BAD);
  // A Windows-shaped absolute path is not repo-relative either, and this server
  // hands Windows paths around elsewhere (GET /api/fs/winpath).
  if (/^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith('\\\\')) {
    throw new FsBrowseError(400, FS_PATH_BAD);
  }
  for (const segment of raw.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new FsBrowseError(400, FS_PATH_BAD);
    }
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Strings on the way out
// ---------------------------------------------------------------------------

/**
 * C0 (including DEL), C1 and the two Unicode line separators, gone.
 *
 * WHY C1 AND U+2028/9 TOO: the page renders these through `textContent`, so
 * this is not an XSS fix — it is that a commit subject holding `\r` or U+2028
 * rewrites the LOG LINE and the JSON response's line structure for anything
 * downstream that reads them as text. Invalid UTF-8 has already become U+FFFD
 * by the time the buffer was decoded; that is left alone, it is honest.
 */
function strip(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g, '');
}

/** Same, but `\n` survives — the commit message BODY and nothing else. */
function stripKeepingNewlines(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u2028\u2029]/g, '');
}

/** Cap by CHARACTERS, never cutting a surrogate pair in half. */
function capChars(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/** Cap by UTF-8 BYTES (the body's `8 KiB` is a byte budget). */
function capBytes(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (Buffer.byteLength(s.slice(0, mid), 'utf8') <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  // On the ORIGINAL string: a pre-sliced one is already `lo` long, so capChars
  // would return early and a lone high surrogate (3 bytes, so it can fit the
  // budget exactly) would survive the cut.
  return capChars(s, lo);
}

const cleanName = (s: string): string => capChars(strip(s), MAX_NAME_CHARS);
const cleanSubject = (s: string): string => capChars(strip(s), MAX_SUBJECT_CHARS);

// ---------------------------------------------------------------------------
// The parsers (pure, exported, fixture-tested)
// ---------------------------------------------------------------------------

export interface LogNumstat {
  /** null for a binary file (git prints `-`). */
  add: number | null;
  del: number | null;
  path: string;
}

export interface LogRecord {
  fields: string[];
  numstat: LogNumstat[];
}

/**
 * Parse `git log -z --numstat --format=%x01…%x00…` into records.
 *
 * POSITIONAL, never a `split()`. From the cursor: a `\x01`, then exactly
 * `fieldCount` NUL-terminated fields (the last one is terminated by git's own
 * `-z`), then an optional `\n`, then zero or more NUL-terminated numstat
 * records, ending where the next `\x01` begins.
 *
 * MEASURED forms (git 2.43.0), NULs shown as \0:
 *   header     `\x01<40hex>\0<short>\0<%aI>\0<author>\0<subject>\0`
 *   no diff    header immediately followed by the next `\x01` (an empty commit,
 *              and a MERGE without `--diff-merges` — which is why that flag is
 *              not optional)
 *   with diff  header, then `\n`, then `2\t1\tf.txt\0`
 *   binary     `-\t-\tb.dat\0`  (both numbers null, one file)
 *   rename     `0\t0\t\0old\0new\0` — three fields; `--no-renames` means this
 *              never appears, but consuming it correctly is what keeps the
 *              cursor in sync if a caller ever drops that flag.
 *
 * Anything that does not start with `\x01` where a record must start ends the
 * parse: a desynchronised stream is dropped, never guessed at.
 */
export function parseLogRecords(out: string, fieldCount: number): LogRecord[] {
  const records: LogRecord[] = [];
  let i = 0;
  while (i < out.length) {
    if (out[i] !== '\u0001') break;
    i += 1;
    const fields: string[] = [];
    let short = false;
    for (let k = 0; k < fieldCount; k += 1) {
      const nul = out.indexOf('\0', i);
      if (nul === -1) {
        short = true;
        break;
      }
      fields.push(out.slice(i, nul));
      i = nul + 1;
    }
    if (short) break; // Truncated output (the stdout cap): keep what is whole.
    // `while`, not `if`, and not tidiness. MEASURED today: git puts exactly one
    // `\n` between the header and the first numstat record, and none at all
    // when `--format=` is empty. A git that ever emitted a second one would
    // leave `\n1\t0\tf.txt` as the first FIELD, whose `add` (`'\n1'`) is not a
    // decimal and so parses as null — i.e. a plain TEXT file answered as
    // `binary: true`. Silent, and wrong in the one direction a user cannot
    // tell from a real binary file.
    while (out[i] === '\n') i += 1;
    const numstat: LogNumstat[] = [];
    while (i < out.length && out[i] !== '\u0001') {
      const nul = out.indexOf('\0', i);
      if (nul === -1) {
        i = out.length;
        break;
      }
      const entry = out.slice(i, nul);
      i = nul + 1;
      const firstTab = entry.indexOf('\t');
      if (firstTab === -1) continue;
      const secondTab = entry.indexOf('\t', firstTab + 1);
      if (secondTab === -1) continue;
      const add = numberOrNull(entry.slice(0, firstTab));
      const del = numberOrNull(entry.slice(firstTab + 1, secondTab));
      const inline = entry.slice(secondTab + 1);
      if (inline === '') {
        // Rename/copy: the next two NUL-terminated fields are <old> then <new>.
        const oldEnd = out.indexOf('\0', i);
        if (oldEnd === -1) {
          i = out.length;
          break;
        }
        const newEnd = out.indexOf('\0', oldEnd + 1);
        if (newEnd === -1) {
          i = out.length;
          break;
        }
        numstat.push({ add, del, path: out.slice(oldEnd + 1, newEnd) });
        i = newEnd + 1;
      } else {
        numstat.push({ add, del, path: inline });
      }
    }
    records.push({ fields, numstat });
  }
  return records;
}

/** `-` (git's binary marker) and anything unparsable become null, never 0. */
function numberOrNull(raw: string): number | null {
  if (raw === '-') return null;
  if (!/^\d{1,12}$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * Parse a unified diff for ONE path into numbered rows.
 *
 * MEASURED against git 2.43.0 (`git log -1 --format= --patch --unified=3`):
 * the `diff --git` / `index` / `---` / `+++` / `new file mode` preamble, then
 * `@@ -1,5 +1,6 @@` hunk headers, then rows marked ` `, `+`, `-`, and the
 * `\ No newline at end of file` marker.
 *
 * Nothing before the first `@@` is read, so `diff.noprefix` and
 * `diff.mnemonicPrefix` (which rewrite the `a/` `b/` prefixes) cannot change
 * the answer. `binary` is decided by the caller from `--numstat` (`-`/`-`),
 * never by matching git's English "Binary files … differ" sentence.
 *
 * Splitting on `\n` is safe HERE and nowhere else in this module: the patch is
 * produced with `--format=` (empty), so not one byte of a commit message is in
 * this text.
 */
export function parseUnifiedDiff(
  patch: string,
  maxLines = MAX_DIFF_LINES,
): { lines: GitDiffLine[]; tooLarge: boolean } {
  const lines: GitDiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  for (const raw of patch.split('\n')) {
    if (raw.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      if (m === null) continue;
      oldNo = Number(m[1]);
      newNo = Number(m[2]);
      inHunk = true;
      if (lines.length >= maxLines) return { lines: [], tooLarge: true };
      lines.push({ kind: 'hunk', oldNo: null, newNo: null, text: diffText(raw) });
      continue;
    }
    if (!inHunk) continue;
    const marker = raw[0];
    if (raw === '' || (marker !== ' ' && marker !== '+' && marker !== '-' && marker !== '\\')) {
      // The preamble of a SECOND file (only reachable if a caller passes more
      // than one path) or the trailing empty string from split(). Either way
      // this hunk is over.
      inHunk = false;
      continue;
    }
    if (lines.length >= maxLines) return { lines: [], tooLarge: true };
    if (marker === '\\') {
      // `\ No newline at end of file` — a row about the file, not a line OF it.
      lines.push({ kind: 'ctx', oldNo: null, newNo: null, text: diffText(raw) });
      continue;
    }
    const text = diffText(raw.slice(1));
    if (marker === '+') {
      lines.push({ kind: 'add', oldNo: null, newNo, text });
      newNo += 1;
    } else if (marker === '-') {
      lines.push({ kind: 'del', oldNo, newNo: null, text });
      oldNo += 1;
    } else {
      lines.push({ kind: 'ctx', oldNo, newNo, text });
      oldNo += 1;
      newNo += 1;
    }
  }
  return { lines, tooLarge: false };
}

/** A diff row's text: a `\r` from a CRLF file would rewrite the row it lands in. */
function diffText(s: string): string {
  return capChars(strip(s), MAX_DIFF_LINE_CHARS);
}

// ---------------------------------------------------------------------------
// The three routes
// ---------------------------------------------------------------------------

interface Ctx {
  /** The repository root git reported. Every call after the probe runs HERE. */
  repoRoot: string;
  log: Logger;
  trace: string[];
}

/**
 * `root` through the same boundary as `changesFor` — home or a registered
 * project, `realpath`d, then an existing directory or 404.
 */
function boundedCwd(root: string, projectPaths: readonly string[]): string {
  const cwd = resolveUnderAllowed(root, {
    projects: projectPaths,
    gone: FS_LIST_GONE,
    denied: FS_NO_READ_PERMISSION,
  });
  if (!isExistingDirectory(cwd)) throw new FsBrowseError(404, FS_LIST_GONE);
  return cwd;
}

/**
 * The repository root, or null when `cwd` is not in one.
 *
 * WHY THE ROOT AND NOT `cwd`: the paths git prints in `--numstat` are relative
 * to the REPOSITORY root, and the commit-diff route sends one of them back as
 * a pathspec — which git resolves against the process's CWD. Running every
 * call after this probe in the repository root is what makes the path the
 * panel received and the path it may ask about the same string.
 *
 * THE ROOT MAY LIE OUTSIDE EVERY ANCHOR, and — corrected by the B3 scope
 * review, 2026-09-21 — it is NOT necessarily an ancestor of `cwd`. A `.git`
 * GITFILE, `core.worktree` and `objects/info/alternates` each let a repository
 * name a directory anywhere the user can read; `rev-parse --show-toplevel` can
 * therefore answer a path unrelated to the folder the client asked about.
 *
 * What bounds this is not the path, it is WHAT IS READ and WHO GETS IT: the
 * calls in this module read the OBJECT STORE (`git log <hash>`), never the
 * working tree, so no file's contents leave the repository's own objects; the
 * answer goes to a page that already holds the app token and already passed
 * the home boundary to name the folder in the first place; and this string is
 * never returned in a response, never logged, and never used to build a path —
 * only handed to git as a cwd for the same repository it would have read from
 * `cwd` anyway. The whole-repository reach is B2's decision 1, unchanged.
 */
async function repoRootOf(cwd: string, log: Logger, trace: string[]): Promise<string | null> {
  const top = await runGitCapture(['rev-parse', '--show-toplevel'], cwd, log, trace);
  if (top.code !== 0) return null;
  const root = top.stdout.trim();
  if (root === '' || !isExistingDirectory(root)) return null;
  return root;
}

/** `git branch --show-current` — empty output is a DETACHED head, i.e. null. */
async function branchOf(ctx: Ctx): Promise<string | null> {
  const run = await runGitCapture(['branch', '--show-current'], ctx.repoRoot, ctx.log, ctx.trace);
  const text = run.code === 0 ? run.stdout.trim() : '';
  return text === '' ? null : cleanName(text);
}

/** `<hash>^{commit}` must resolve: a TREE or BLOB hash is a 404, not a commit. */
async function requireCommit(ctx: Ctx, hash: string): Promise<void> {
  const run = await runGitCapture(
    ['rev-parse', '--verify', '--quiet', `${hash}^{commit}`],
    ctx.repoRoot,
    ctx.log,
    ctx.trace,
  );
  if (run.code !== 0) throw new FsBrowseError(404, GIT_COMMIT_GONE);
}

/** One list row out of one parsed record. Returns null for a desynced record. */
function summaryOf(record: LogRecord): GitCommitSummary | null {
  const [hash, short, authoredAt, author, subject] = record.fields;
  if (hash === undefined || !HASH_RE.test(hash)) return null;
  let add = 0;
  let del = 0;
  for (const n of record.numstat) {
    add += n.add ?? 0; // A BINARY file adds 0 text lines...
    del += n.del ?? 0;
  }
  return {
    hash,
    // `core.abbrev` can make `%h` anything from 4 to 40 characters, so it is
    // validated like any other value and falls back to git's own default width.
    shortHash: short !== undefined && SHORT_HASH_RE.test(short) ? short : hash.slice(0, 7),
    subject: cleanSubject(subject ?? ''),
    author: cleanName(author ?? ''),
    authoredAt: authoredAt !== undefined && ISO_RE.test(authoredAt) ? authoredAt : '',
    add,
    del,
    files: record.numstat.length, // ...but it IS one changed file.
  };
}

/** One request's git calls, with the ONE debug trace line written in a finally. */
async function traced<T>(log: Logger, run: (trace: string[]) => Promise<T>): Promise<T> {
  const trace: string[] = [];
  try {
    return await run(trace);
  } finally {
    if (trace.length > 0) log('debug', `git: ${trace.join(', ')}`);
  }
}

/** GET /api/git/commits. A folder that is not a repository is a STATE, not an error. */
export async function commitsFor(
  root: string,
  opts: { limit: number; skip: number; from: string | null },
  log: Logger = () => undefined,
  projectPaths: readonly string[] = [],
): Promise<GitCommitsResponse> {
  const cwd = boundedCwd(root, projectPaths);
  return traced(log, async (trace) => {
    const repoRoot = await repoRootOf(cwd, log, trace);
    const empty = { isRepo: false, branch: null, head: null, total: 0, commits: [], more: false };
    if (repoRoot === null) return empty satisfies GitCommitsResponse;
    const ctx: Ctx = { repoRoot, log, trace };
    const branch = await branchOf(ctx);

    let head: string;
    if (opts.from !== null) {
      await requireCommit(ctx, opts.from);
      head = opts.from;
    } else {
      const probe = await runGitCapture(
        ['rev-parse', '--verify', '--quiet', 'HEAD'],
        repoRoot,
        log,
        trace,
      );
      const text = probe.stdout.trim();
      // An EMPTY repository (git init, nothing committed) has no HEAD. That is
      // a drawable state — `No commits yet.` — not a failure.
      if (probe.code !== 0 || !HASH_RE.test(text)) {
        return { isRepo: true, branch, head: null, total: 0, commits: [], more: false };
      }
      head = text;
    }

    // `rev-list --count` WALKS THE WHOLE HISTORY, so it is the one call here
    // that can hit the 5 s SIGKILL on a repository that is merely enormous —
    // and `runGitCapture` REJECTS on that, which would have thrown away a page
    // of rows the app had already paid for. It is caught: the rows are the
    // answer, the count is a nicety.
    const count = await runGitCapture(['rev-list', '--count', head], repoRoot, log, trace)
      .catch(() => null);
    const counted =
      count !== null && count.code === 0 && /^\d{1,12}$/.test(count.stdout.trim())
        ? Number(count.stdout.trim())
        : null;

    // limit + 1: the extra row is how `more` is known without a second count.
    const out = await capturedOrFail(
      [
        'log',
        ...LOG_FLAGS,
        '--numstat',
        '-z',
        LIST_FORMAT,
        `--skip=${opts.skip}`,
        `--max-count=${opts.limit + 1}`,
        head,
      ],
      repoRoot,
      log,
      trace,
    );
    const records = parseLogRecords(out, LIST_FIELDS);
    const more = records.length > opts.limit;
    const commits: GitCommitSummary[] = [];
    for (const record of records.slice(0, opts.limit)) {
      const summary = summaryOf(record);
      if (summary !== null) commits.push(summary);
    }
    // NOT 0 when the count failed: the header reads `main, 0 commits` over a
    // full list, which is a lie the user can see. A FLOOR — what this page
    // proves exists — is wrong only in the direction of being too small, and
    // it is exact on the last page.
    const total = counted ?? opts.skip + commits.length + (more ? 1 : 0);
    if (counted === null) log('warn', 'git rev-list did not answer; commit total is a floor');
    return { isRepo: true, branch, head, total, commits, more };
  });
}

/** GET /api/git/commit. Not a repository, or no such commit: 404, one sentence. */
export async function commitFor(
  root: string,
  hash: string,
  log: Logger = () => undefined,
  projectPaths: readonly string[] = [],
): Promise<GitCommitResponse> {
  const cwd = boundedCwd(root, projectPaths);
  return traced(log, async (trace) => {
    const repoRoot = await repoRootOf(cwd, log, trace);
    if (repoRoot === null) throw new FsBrowseError(404, GIT_COMMIT_GONE);
    const ctx: Ctx = { repoRoot, log, trace };
    await requireCommit(ctx, hash);
    const branch = await branchOf(ctx);

    const out = await capturedOrFail(
      ['log', '-1', NO_WALK, ...LOG_FLAGS, '--numstat', '-z', DETAIL_FORMAT, hash],
      repoRoot,
      log,
      trace,
    );
    const record = parseLogRecords(out, DETAIL_FIELDS)[0];
    const summary = record === undefined ? null : summaryOf(record);
    if (record === undefined || summary === null) throw new FsBrowseError(404, GIT_COMMIT_GONE);
    // Indices 0..4 are the summary (see DETAIL_FORMAT); 5..8 are the rest.
    const [, , , author, , committedAt, committerName, parents, body] = record.fields;

    const files: GitCommitFile[] = record.numstat
      .slice(0, MAX_COMMIT_FILES)
      .map((n) => ({ path: n.path, add: n.add, del: n.del }));
    const committer = cleanName(committerName ?? '');
    return {
      commit: summary,
      // The BODY is the one string that keeps its newlines — it is a paragraph.
      body: capBytes(stripKeepingNewlines(body ?? '').trim(), MAX_BODY_BYTES),
      // `Committed by` is noise when it is the same person (the common case).
      committer: committer === '' || committer === cleanName(author ?? '') ? null : committer,
      committedAt: committedAt !== undefined && ISO_RE.test(committedAt) ? committedAt : '',
      parents: (parents ?? '').split(' ').filter((p) => p !== '').length,
      branch,
      github: await githubRemote(ctx),
      files,
      truncated:
        record.numstat.length > MAX_COMMIT_FILES ? record.numstat.length - MAX_COMMIT_FILES : 0,
    };
  });
}

/**
 * `origin` on github.com, or null. ANY failure is null, never an error.
 *
 * THE URL MAY HOLD A CREDENTIAL (`https://<token>@github.com/o/r`), which is
 * why it is read here and nowhere else: `runGitCapture` logs the SUBCOMMAND and
 * the exit status (`config 0`) and never a byte of stdout, the parser discards
 * userinfo, and only `{ owner, repo }` leaves this function. Nothing in this
 * module puts the string in a response, a log line, an error or the trace.
 */
async function githubRemote(ctx: Ctx): Promise<{ owner: string; repo: string } | null> {
  const run = await runGitCapture(
    ['config', '--get', 'remote.origin.url'],
    ctx.repoRoot,
    ctx.log,
    ctx.trace,
  ).catch(() => null);
  if (run === null || run.code !== 0) return null;
  return parseGithubRemote(run.stdout.trim());
}

/** GET /api/git/commit-diff: what one commit did to ONE path. */
export async function commitDiffFor(
  root: string,
  hash: string,
  path: string,
  log: Logger = () => undefined,
  projectPaths: readonly string[] = [],
): Promise<GitCommitDiffResponse> {
  const cwd = boundedCwd(root, projectPaths);
  return traced(log, async (trace) => {
    const repoRoot = await repoRootOf(cwd, log, trace);
    if (repoRoot === null) throw new FsBrowseError(404, GIT_COMMIT_GONE);
    const ctx: Ctx = { repoRoot, log, trace };
    await requireCommit(ctx, hash);

    // NUMSTAT FIRST, and this is why (plan § "the 2 MiB cap"): it says in two
    // numbers whether the file is binary and how many lines changed, for a few
    // dozen bytes. A file whose patch would flood the 2 MiB stdout cap — and so
    // answer 500 — is refused here as an honest 200 `tooLarge` instead, which
    // is what the panel can actually draw. The residual, stated: the cap bounds
    // LINES, not bytes, so a file with few but enormous lines (a 5 MB minified
    // bundle on one line) still trips the byte cap and still answers 500.
    const statOut = await capturedOrFail(
      ['log', '-1', NO_WALK, ...LOG_FLAGS, '--numstat', '-z', '--format=', hash, '--', path],
      repoRoot,
      log,
      trace,
    );
    const stat = parseLogRecords(wrapBareNumstat(statOut), 1)[0];
    const entry = stat?.numstat[0];
    // A path this commit did not touch is not an error: no rows, no diff. That
    // sentence is only TRUE because of NO_WALK — without it git answers with an
    // ANCESTOR's diff under this hash (see the NO_WALK comment; it was the bug).
    if (entry === undefined) return { binary: false, tooLarge: false, lines: [] };
    if (entry.add === null && entry.del === null) {
      return { binary: true, tooLarge: false, lines: [] };
    }
    if ((entry.add ?? 0) + (entry.del ?? 0) > MAX_DIFF_LINES) {
      return { binary: false, tooLarge: true, lines: [] };
    }

    const patch = await capturedOrFail(
      [
        'log',
        '-1',
        NO_WALK,
        ...LOG_FLAGS,
        '--patch',
        // Pinned: `diff.context` is repo config, and a huge value would push a
        // small change past the 2000-row cap the numstat pre-check just cleared.
        '--unified=3',
        '--format=',
        hash,
        '--',
        path,
      ],
      repoRoot,
      log,
      trace,
    );
    const { lines, tooLarge } = parseUnifiedDiff(patch);
    return { binary: false, tooLarge, lines };
  });
}

/**
 * `--format=` (empty) prints the numstat records with NO `%x01` header, so the
 * one-field record parser is given the header it expects. Cheaper than a second
 * parser, and it keeps the rename form handled in exactly one place.
 *
 * MEASURED (git 2.43.0): with `--format=` empty there is NO `\n` before the
 * first record. A git that grew one would be absorbed by parseLogRecords's
 * `while` over the separator — see the note there for what the alternative
 * silently answers.
 */
function wrapBareNumstat(out: string): string {
  return `\u0001\0\n${out}`;
}
