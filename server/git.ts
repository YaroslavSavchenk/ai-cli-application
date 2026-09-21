/**
 * The Files panel's `Changes` tab (B2, 2026-09-16): what one repository has
 * changed since its last commit, for GET /api/git/changes?root=<abs>.
 *
 * Security posture, identical in spirit to server/scaffold.ts: git runs via
 * ARGV with `shell: false` — nothing is ever interpolated into a shell string —
 * `GIT_TERMINAL_PROMPT=0` so a repository with a credential-asking remote can
 * never park a child on a prompt, and the only user-supplied value is the cwd,
 * which has already passed the home boundary in server/fsbrowse.ts and is not
 * an argument (so it can never be read as an option).
 *
 * WHY A SECOND RUNNER instead of scaffold.ts's `runGit`: that one is
 * `stdio: 'ignore'` on purpose ("unbounded git output can never grow our
 * memory"). `git diff --numstat` is nothing BUT stdout, so this module captures
 * it with an explicit byte cap (MAX_STDOUT_BYTES) and a hard timeout rather
 * than loosening the rule for the routes that create directories.
 *
 * STDERR IS DISCARDED, like runGit: git's error text is never captured, so it
 * can never reach a response body or a log line. A failure is the exit status
 * and nothing else.
 *
 * TWO ENVIRONMENT HARDENINGS, both measured by the security review 2026-09-16
 * (see GIT_ENV): a repository-local `core.fsmonitor` is a program `git status`
 * RUNS, and a plain `git status` REWRITES `.git/index`. Neither belongs in a
 * read-only tab that polls every five seconds.
 *
 * B3 (2026-09-21) added `LC_ALL=C` and `GIT_LITERAL_PATHSPECS=1` to the same
 * env, and EXPORTS `runGitCapture` / `capturedOrFail` / `GIT_ENV` so
 * server/git-log.ts (the commit routes) shares one runner and one posture
 * rather than growing a second copy. Neither new entry changes this module:
 * `changesFor` passes no pathspec at all (checked — `diff --numstat -z HEAD`
 * and `status --porcelain=v1 -z`), and it parses no human-readable git text,
 * only `-z` records and exit statuses.
 *
 * Erasable TypeScript only; relative imports carry explicit .ts extensions.
 */
import { spawn } from 'node:child_process';
import type {
  ChangeStatus,
  ChangedFile,
  GitChangesResponse,
} from '../shared/protocol.ts';
import type { Logger } from './config.ts';
import {
  FS_LIST_GONE,
  FS_NO_READ_PERMISSION,
  FsBrowseError,
  resolveUnderAllowed,
} from './fsbrowse.ts';
import { isExistingDirectory } from './projects.ts';

/** The one sentence this module can answer with (plan §1d, `changes` / 500). */
export const GIT_READ_FAILED = 'The app could not read this repository.';

/** Rows returned at most; past this the answer carries `truncated`. */
export const MAX_CHANGED_FILES = 2000;

/** A wedged git must never hold a request open. SIGKILL, not SIGTERM. */
const GIT_TIMEOUT_MS = 5_000;

/**
 * The environment every git in this module runs with.
 *
 * `GIT_TERMINAL_PROMPT=0` — a repository with a credential-asking remote can
 * never park a child on a prompt.
 *
 * `GIT_CONFIG_COUNT/KEY_0/VALUE_0` = `core.fsmonitor=false`. MEASURED: a
 * repository-local `core.fsmonitor` naming a program is EXECUTED by `git
 * status` and `git diff`, so merely opening the Changes tab on a repository
 * someone else wrote would run their code. Git treats these three variables
 * exactly like a `-c` on the command line, at the highest precedence — and the
 * ENV form rather than `-c` on purpose: it covers every subcommand this module
 * grows later, including ones added by someone who never reads this comment.
 * The trade-off, stated: a user with a LEGITIMATE global fsmonitor daemon loses
 * its speed-up for these calls only (every other git they run is untouched),
 * and the 5 s timeout is what bounds the walk it falls back to.
 *
 * `GIT_OPTIONAL_LOCKS=0` — MEASURED: a plain `git status` refreshes and
 * REWRITES `.git/index` (its mtime changes) and takes `index.lock` to do it. A
 * 5 s poll doing that would fight the user's own git for the lock and touch a
 * file the app has no business writing. With optional locks off, git reports
 * the same answer and writes nothing.
 *
 * `GIT_LITERAL_PATHSPECS=1` (B3) — the commit-diff route puts a CLIENT string
 * after `--` as a pathspec. MEASURED (git 2.43.0): without this, `:(glob)*` is
 * magic and matches the whole tree; with it, `:(glob)*` matches NOTHING and a
 * file really named `star*.txt` is found by the literal text `star*.txt`. No
 * glob, no `:(magic)`, no `^` negation — a pathspec is a file name again.
 *
 * `LC_ALL=C` (B3) — git's human-readable text (dates it formats for humans,
 * error text, `--stat` headers) stops depending on the user's locale. Nothing
 * this app parses is locale-dependent (`%aI` is ISO 8601 by definition, `-z`
 * records are bytes), so this pins the ONE class of surprise a translated git
 * could still cause and costs nothing.
 *
 * `GIT_NO_LAZY_FETCH=1` (B3 security review, 2026-09-21) — THE THIRD WAY A
 * REPOSITORY CAN RUN A PROGRAM, and the one that survived the `--no-*` flags.
 * A PARTIAL CLONE (`extensions.partialClone=origin`,
 * `remote.origin.promisor=true`) is allowed to go and FETCH an object it does
 * not have, mid-read, from `remote.origin.url` — and the transport it uses is
 * a PROGRAM the same `.git/config` names.
 *
 * MEASURED against git 2.43.0 with this exact env and B3's flags: a clone with
 * those two keys, `remote.origin.uploadpack=<script>` and ONE blob of HEAD
 * deleted out of `.git/objects` ran the script (marker created) for
 *   * `git log … --numstat` (the commits list),
 *   * `git rev-parse --verify --quiet <absent 40 hex>^{commit}` (the hash gate,
 *     i.e. BEFORE any commit is known to exist), and
 *   * `git diff --numstat -z HEAD` — B2's SHIPPED Changes call, with nothing
 *     but a modified working-tree file.
 * The `remote.origin.url=ssh://x/` + `core.sshCommand=<script>` spelling ran
 * too. With `GIT_NO_LAZY_FETCH=1` the marker stayed absent in every case;
 * rev-parse then exits 1 (a 404) and log/diff exit 128 (the constant 500).
 *
 * RESIDUAL, stated: this is an ENV VARIABLE git has to honour. A git older
 * than the CVE-2024-32004 hardening that made `GIT_NO_LAZY_FETCH` load-bearing
 * ignores it, and on such a git a partial clone can still reach its promisor
 * remote from these calls. The flag costs nothing on a git that does honour
 * it, and a legitimate partial clone loses only these read-only calls (they
 * report the failure as the constant 500), never the user's own git.
 *
 * NOT pinned here, and measured so the next reader does not have to:
 * `core.pager` / `pager.log` naming a program are INERT (no tty, so git never
 * starts a pager). A repo-local `diff.orderFile` naming a missing file makes
 * `git log --numstat` exit 128 — handled with `-O/dev/null` on the argv of
 * server/git-log.ts's calls rather than with a fourth GIT_CONFIG entry, so the
 * Changes tab's posture is not changed by a B3 finding.
 */
export const GIT_ENV: Record<string, string> = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_LITERAL_PATHSPECS: '1',
  GIT_NO_LAZY_FETCH: '1',
  LC_ALL: 'C',
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'core.fsmonitor',
  GIT_CONFIG_VALUE_0: 'false',
};

/**
 * Cap on ONE git command's stdout. A repository with a hundred thousand
 * changed files is a real thing; holding its numstat in memory is not. Past
 * this the child is killed and the request fails — an honest 500 beats an
 * answer that quietly dropped half the tree.
 */
const MAX_STDOUT_BYTES = 2 * 1024 * 1024;

export interface GitRun {
  /** Exit status, or null when the child died on a signal. */
  code: number | null;
  /** stdout, decoded utf8. Empty on any non-zero exit we tolerate. */
  stdout: string;
}

/**
 * Run `git <args>` in `cwd` and capture stdout. Resolves for ANY exit status —
 * a non-zero exit is data here (`rev-parse --show-toplevel` failing is how we
 * learn the folder is not a repository) — and rejects only when the call itself
 * could not be trusted: git missing, the timeout, or the stdout cap.
 */
export function runGitCapture(
  args: readonly string[],
  cwd: string,
  log: Logger,
  trace: string[],
): Promise<GitRun> {
  const sub = args[0] ?? '?';
  return new Promise((resolve, reject) => {
    let settled = false;
    // DECLARED BEFORE finish(), and checked: `spawn` can throw SYNCHRONOUSLY
    // (EMFILE), and on that path finish() runs before the `setTimeout` below
    // has been evaluated. A bare `clearTimeout(timer)` there is a
    // ReferenceError in the temporal dead zone — the request would fail with a
    // 500 whose cause is this line rather than git.
    let timer: NodeJS.Timeout | undefined;
    const finish = (err: Error | null, run?: GitRun): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (err !== null) reject(err);
      else resolve(run as GitRun);
    };
    let child;
    try {
      child = spawn('git', args as string[], {
        shell: false,
        cwd,
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
        env: { ...process.env, ...GIT_ENV },
      });
    } catch {
      trace.push(`${sub} did not spawn`);
      finish(new FsBrowseError(500, GIT_READ_FAILED));
      return;
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    let capped = false;
    child.stdout?.on('data', (chunk: Buffer) => {
      // ONCE. `kill()` does not empty the pipe: every chunk already buffered
      // still arrives as a `data` event, and without this line each one re-ran
      // the warn below and pushed another `${sub} killed` into the trace — one
      // capped request, N identical log lines.
      if (capped) return;
      bytes += chunk.byteLength;
      if (bytes > MAX_STDOUT_BYTES) {
        capped = true;
        try {
          child.kill('SIGKILL');
        } catch {
          // Already gone.
        }
        // The SUBCOMMAND and the reason — never a byte of the output itself.
        log('warn', `git ${sub} produced more than ${MAX_STDOUT_BYTES} bytes; killed`);
        trace.push(`${sub} killed`);
        finish(new FsBrowseError(500, GIT_READ_FAILED));
        return;
      }
      chunks.push(chunk);
    });
    timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
      log('warn', `git ${sub} timed out after ${GIT_TIMEOUT_MS}ms; killed`);
      trace.push(`${sub} timed out`);
      finish(new FsBrowseError(500, GIT_READ_FAILED));
    }, GIT_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();

    child.on('error', () => {
      log('warn', `git ${sub} failed to start`);
      trace.push(`${sub} did not start`);
      finish(new FsBrowseError(500, GIT_READ_FAILED));
    });
    child.on('close', (code) => {
      if (capped) return;
      // The subcommand and the exit status go into the REQUEST'S one line
      // (changesFor's `finally`), not into a line of their own: this route is
      // polled every 5 s while the Changes tab is up, and five debug lines per
      // poll is how server.log stops being readable. Never git's own output.
      trace.push(`${sub} ${code ?? 'on a signal'}`);
      finish(null, { code, stdout: Buffer.concat(chunks).toString('utf8') });
    });
  });
}

/**
 * Parse `git diff --numstat -z <rev>`, keyed by the path the row is ABOUT.
 *
 * MEASURED against git 2.43.0, not assumed. Records are NUL-terminated:
 *
 *   ordinary   `2\t0\tmod.txt\0`
 *   binary     `-\t-\tbin.dat\0`                 (both numbers null)
 *   rename     `0\t0\t\0old name".txt\0new name".txt\0`
 *
 * The rename form ends its first record with the second TAB and an EMPTY path,
 * then spends two more NUL-terminated fields on the old and the new name — the
 * NEW name is the key, because that is the row the panel shows. A path may
 * itself contain a tab, so the path is everything after the SECOND tab, taken
 * verbatim; `-z` is what makes that safe (the non-`-z` form quotes and escapes
 * non-ASCII names, which is the trap this avoids).
 */
export function parseNumstatZ(out: string): Map<string, { add: number | null; del: number | null }> {
  const byPath = new Map<string, { add: number | null; del: number | null }>();
  const fields = out.split('\0');
  if (fields[fields.length - 1] === '') fields.pop(); // Trailing NUL of the last record.
  for (let i = 0; i < fields.length; i += 1) {
    const record = fields[i] as string;
    const firstTab = record.indexOf('\t');
    if (firstTab === -1) continue;
    const secondTab = record.indexOf('\t', firstTab + 1);
    if (secondTab === -1) continue;
    const add = numberOrNull(record.slice(0, firstTab));
    const del = numberOrNull(record.slice(firstTab + 1, secondTab));
    const inline = record.slice(secondTab + 1);
    if (inline === '') {
      // Rename/copy: the next two fields are <old> then <new>.
      const to = fields[i + 2];
      if (to !== undefined) byPath.set(to, { add, del });
      i += 2;
    } else {
      byPath.set(inline, { add, del });
    }
  }
  return byPath;
}

/** `-` (git's binary marker) and anything unparsable become null, never 0. */
function numberOrNull(raw: string): number | null {
  if (raw === '-') return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse `git status --porcelain=v1 -z --untracked-files=normal`.
 *
 * MEASURED against git 2.43.0. Entries are NUL-terminated, each
 * `XY <path>` — two status letters, one space, then the path verbatim:
 *
 *   ` M bin.dat\0`         modified in the worktree
 *   ` D del.txt\0`         deleted
 *   `AM added.txt\0`       staged add, modified since
 *   `R  new name".txt\0old name".txt\0`   RENAME: the NEW path first, then one
 *                                          extra NUL-terminated field with the old one
 *   `?? fresh.txt\0`       untracked file
 *   `?? sub/\0`            untracked DIRECTORY — `normal` collapses a whole new
 *                          folder into ONE entry with a trailing slash. Kept
 *                          verbatim: dropping the slash would call a folder a
 *                          file, and walking into it is exactly the `all` cost
 *                          (a node_modules) the flag exists to avoid.
 *
 * Status precedence, most-specific first: `?` untracked, `R`/`C` renamed, `D`
 * deleted (an `AD` is a file that is not there), `A` new, anything else
 * modified (including the unmerged `U` states — a conflict is a modification
 * the panel can show).
 */
export function parsePorcelainZ(out: string): { path: string; status: ChangeStatus }[] {
  const rows: { path: string; status: ChangeStatus }[] = [];
  const fields = out.split('\0');
  if (fields[fields.length - 1] === '') fields.pop();
  for (let i = 0; i < fields.length; i += 1) {
    const entry = fields[i] as string;
    if (entry.length < 4) continue; // `XY p` is the shortest legal entry.
    const x = entry[0] as string;
    const y = entry[1] as string;
    const path = entry.slice(3);
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      i += 1; // The ORIGINAL path rides in the next field; the new one is the row.
      rows.push({ path, status: 'renamed' });
      continue;
    }
    rows.push({ path, status: statusOf(x, y) });
  }
  return rows;
}

function statusOf(x: string, y: string): ChangeStatus {
  if (x === '?' || y === '?') return 'new';
  if (x === 'D' || y === 'D') return 'deleted';
  if (x === 'A' || y === 'A') return 'new';
  return 'modified';
}

/**
 * Everything the `Changes` tab needs for one panel root.
 *
 * A root that is NOT in a repository is not an error — it is
 * `{ isRepo: false, … }`, because "no repository here" is a state the tab
 * draws, not a failure.
 *
 * `repoRoot` MAY LIE OUTSIDE EVERY ANCHOR. The repository root can be an
 * ANCESTOR of `root` (a project registered at `web/` inside a repo, or a home
 * folder inside one), and open decision 1 chose the WHOLE repository — that is
 * what git answers and what "since the last commit" is about. So this one
 * value can name a folder the listing routes would refuse. It is a RESPONSE
 * field only, never logged, and the page that receives it already holds the
 * token; the boundary it does not widen is the one that matters — no listing
 * and no create takes its word for anything.
 *
 * `log` is optional so a unit test can call this without a data dir; the route
 * always passes the real one. `projectPaths` is the registered project roots,
 * read per request by the route — anchors beside home for the boundary check.
 */
export async function changesFor(
  root: string,
  log: Logger = () => undefined,
  projectPaths: readonly string[],
): Promise<GitChangesResponse> {
  const cwd = resolveUnderAllowed(root, {
    projects: projectPaths,
    gone: FS_LIST_GONE,
    denied: FS_NO_READ_PERMISSION,
  });
  if (!isExistingDirectory(cwd)) throw new FsBrowseError(404, FS_LIST_GONE);
  // ONE line per request, whatever happens: every subcommand and its exit
  // status, joined in the `finally` below. This route is polled every 5 s.
  const trace: string[] = [];
  try {
    return await collectChanges(cwd, log, trace);
  } finally {
    if (trace.length > 0) log('debug', `git: ${trace.join(', ')}`);
  }
}

async function collectChanges(cwd: string, log: Logger, trace: string[]): Promise<GitChangesResponse> {
  const top = await runGitCapture(['rev-parse', '--show-toplevel'], cwd, log, trace);
  if (top.code !== 0) {
    return { isRepo: false, repoRoot: null, branch: null, files: [], truncated: 0 };
  }
  const repoRoot = top.stdout.trim();

  // An EMPTY repository (git init, nothing committed) has no HEAD: `git diff
  // … HEAD` would fail with "ambiguous argument 'HEAD'" (measured), so the
  // numstat pass is skipped and every listed file is simply `new`.
  const head = await runGitCapture(['rev-parse', '--verify', '--quiet', 'HEAD'], cwd, log, trace);
  const hasHead = head.code === 0;

  // `--show-current` prints nothing on a detached HEAD — that is the null.
  const branchRun = await runGitCapture(['branch', '--show-current'], cwd, log, trace);
  const branchText = branchRun.code === 0 ? branchRun.stdout.trim() : '';
  const branch = branchText === '' ? null : branchText;

  const numbers = hasHead
    ? parseNumstatZ(await capturedOrFail(['diff', '--numstat', '-z', 'HEAD'], cwd, log, trace))
    : new Map<string, { add: number | null; del: number | null }>();
  const rows = parsePorcelainZ(
    await capturedOrFail(
      ['status', '--porcelain=v1', '-z', '--untracked-files=normal'],
      cwd,
      log,
      trace,
    ),
  );

  const files: ChangedFile[] = [];
  for (const row of rows.slice(0, MAX_CHANGED_FILES)) {
    // No HEAD = nothing has ever been committed, so every path is new whatever
    // the index says about it.
    const status: ChangeStatus = hasHead ? row.status : 'new';
    // An UNTRACKED path is simply absent from numstat, so it gets null/null
    // without a special case — while a STAGED add (`A `) does have real counts
    // and keeps them, which "new means no numbers" would have thrown away.
    const counted = numbers.get(row.path);
    files.push({
      path: row.path,
      add: counted?.add ?? null,
      del: counted?.del ?? null,
      status,
    });
  }
  return {
    isRepo: true,
    repoRoot: repoRoot === '' ? cwd : repoRoot,
    branch,
    files,
    truncated: rows.length > MAX_CHANGED_FILES ? rows.length - MAX_CHANGED_FILES : 0,
  };
}

/** A git call whose non-zero exit IS a failure (unlike the two probes above). */
export async function capturedOrFail(
  args: readonly string[],
  cwd: string,
  log: Logger,
  trace: string[],
): Promise<string> {
  const run = await runGitCapture(args, cwd, log, trace);
  if (run.code !== 0) throw new FsBrowseError(500, GIT_READ_FAILED);
  return run.stdout;
}
