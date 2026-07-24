/**
 * Filesystem + git side-effects for project creation (Phase 2a). Deliberately
 * kept OUT of ProjectStore, which stays record-only: this module is the only
 * place that creates directories and runs git.
 *
 * Security posture (localhost-security-model): these functions run behind the
 * same token + Origin/Host gate as every other /api route, but they CREATE
 * DIRECTORIES and RUN GIT, so inputs are validated hard here as well:
 *   - absolute paths only;
 *   - never clobber an existing NON-EMPTY directory or a non-directory;
 *   - git runs via argv with {shell:false} — NOTHING is ever interpolated into
 *     a shell string (identical discipline to server/telemetry.ts);
 *   - clone urls pass a scheme allowlist and a `-`-prefix / control-char guard,
 *     and `git clone -- <url> <dest>` uses `--` so the url can never be read as
 *     an option;
 *   - errors are PLAIN messages — git stdout/stderr is never captured
 *     (stdio:'ignore') and never leaked into server.log or a response.
 *
 * Erasable TypeScript only; relative imports carry explicit .ts extensions.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';

/** Carries an HTTP status so the API layer can map it directly (like FsBrowseError). */
export class ScaffoldError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'ScaffoldError';
  }
}

/** `git init` is quick; a generous-but-finite cap keeps a wedged git from hanging a request. */
const GIT_INIT_TIMEOUT_MS = 15_000;
/** Clone can be genuinely slow (large repos); generous but bounded so a request never hangs forever. */
export const CLONE_TIMEOUT_MS = 5 * 60_000;
/** Reject absurdly long urls before they ever reach git. */
const MAX_URL_LEN = 2048;

/** True if `url` holds any control char, space, or DEL — never valid in a clone url. */
function hasBadUrlChar(url: string): boolean {
  for (let i = 0; i < url.length; i += 1) {
    const c = url.charCodeAt(i);
    if (c <= 0x20 || c === 0x7f) return true;
  }
  return false;
}

/**
 * A target path is free to create into only when it is ABSENT or an EMPTY
 * directory. An existing non-empty directory or any non-directory throws —
 * we never clobber the user's data. Exported so github.ts reuses the exact
 * same no-clobber rule for its authenticated-clone dest.
 */
export function assertVacant(absPath: string): void {
  let st;
  try {
    st = statSync(absPath);
  } catch {
    return; // Absent — free to create.
  }
  if (!st.isDirectory()) {
    throw new ScaffoldError(409, 'a file already exists at that path');
  }
  let entries: string[];
  try {
    entries = readdirSync(absPath);
  } catch {
    throw new ScaffoldError(500, 'failed to read the existing directory');
  }
  if (entries.length > 0) {
    throw new ScaffoldError(409, 'directory already exists and is not empty');
  }
}

/**
 * Create a new local project directory at `absPath` (mkdir recursive), then —
 * when `gitInit` — run `git init` inside it. Refuses to clobber an existing
 * non-empty directory or a non-directory. `absPath` must be absolute.
 */
export async function createLocalDir(absPath: string, gitInit: boolean): Promise<void> {
  if (!isAbsolute(absPath)) throw new ScaffoldError(400, 'path must be absolute');

  let existedBefore = true;
  try {
    statSync(absPath);
  } catch {
    existedBefore = false;
  }
  assertVacant(absPath);

  try {
    mkdirSync(absPath, { recursive: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') throw new ScaffoldError(403, 'permission denied');
    throw new ScaffoldError(500, 'failed to create directory');
  }
  if (gitInit) {
    try {
      await runGit(['init'], { cwd: absPath, timeoutMs: GIT_INIT_TIMEOUT_MS });
    } catch (err) {
      // Clean up a dir WE created (mkdir made the leaf); never remove a
      // pre-existing user directory.
      if (!existedBefore) {
        try {
          rmSync(absPath, { recursive: true, force: true });
        } catch {
          // Best-effort cleanup.
        }
      }
      throw err;
    }
  }
}

/**
 * Clone `url` into `destAbs` via `git clone -- <url> <dest>` (argv, no shell).
 * `url` must pass validateCloneUrl; `destAbs` must be absolute, its parent must
 * exist, and it must not already exist as a non-empty directory. If the clone
 * fails and we created the dest, the partial dest is removed.
 */
export async function cloneRepo(url: string, destAbs: string): Promise<void> {
  validateCloneUrl(url);
  if (!isAbsolute(destAbs)) throw new ScaffoldError(400, 'dest must be absolute');

  // git clone creates the LEAF directory but not intermediate parents.
  let parentOk = false;
  try {
    parentOk = statSync(dirname(destAbs)).isDirectory();
  } catch {
    parentOk = false;
  }
  if (!parentOk) throw new ScaffoldError(400, 'destination parent directory does not exist');

  let existedBefore = true;
  try {
    statSync(destAbs);
  } catch {
    existedBefore = false;
  }
  assertVacant(destAbs);

  try {
    // `--` stops `url`/`dest` from being read as options even if validation missed something.
    await runGit(['clone', '--', url, destAbs], { timeoutMs: CLONE_TIMEOUT_MS });
  } catch (err) {
    // Clean up a dest WE created (git makes the leaf dir); never remove a
    // pre-existing user directory.
    if (!existedBefore) {
      try {
        rmSync(destAbs, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup.
      }
    }
    throw err instanceof ScaffoldError ? err : new ScaffoldError(500, 'failed to clone repository');
  }
}

/**
 * Validate a clone url. Allowlist of transports (http(s)://, git://, ssh://,
 * scp-like user@host:path); reject `-`-leading (option injection), control
 * chars / whitespace (blocks `ext::sh -c ...`), and everything else — file://,
 * local paths, other git transports.
 */
export function validateCloneUrl(url: string): void {
  if (typeof url !== 'string' || url === '') throw new ScaffoldError(400, 'url is required');
  if (url.length > MAX_URL_LEN) throw new ScaffoldError(400, 'url is too long');
  // No control chars, space, or DEL (blocks `ext::sh -c ...` and arg smuggling).
  if (hasBadUrlChar(url)) throw new ScaffoldError(400, 'url contains invalid characters');
  // Never let the url be read as a git/ssh option.
  if (url.startsWith('-')) throw new ScaffoldError(400, 'invalid repository url');
  // Scheme allowlist (defense in depth; `--` already stops option parsing).
  if (/^https?:\/\//i.test(url)) return;
  if (/^git:\/\//i.test(url)) return;
  if (/^ssh:\/\//i.test(url)) return;
  // scp-like: user@host:path — must carry an explicit user@ and a colon.
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:.+$/.test(url)) return;
  // file://, ext::, local paths, and any other transport are rejected.
  throw new ScaffoldError(400, 'unsupported repository url (use http(s)://, git://, ssh://, or user@host:)');
}

/**
 * Run `git <args>` with NO shell, stdio fully ignored (nothing is buffered —
 * unbounded git output can never grow our memory, and no stdout/stderr can leak
 * into logs or responses). GIT_TERMINAL_PROMPT=0 makes a credential-needing
 * clone FAIL FAST instead of hanging on a prompt. Resolves on exit 0, else
 * rejects with a plain ScaffoldError.
 */
function runGit(args: string[], opts: { cwd?: string; timeoutMs: number }): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err?: ScaffoldError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err !== undefined) reject(err);
      else resolve();
    };
    let child;
    try {
      child = spawn('git', args, {
        shell: false,
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });
    } catch {
      finish(new ScaffoldError(500, 'git is not available'));
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
      finish(new ScaffoldError(500, 'git operation timed out'));
    }, opts.timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    child.on('error', (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      finish(new ScaffoldError(500, code === 'ENOENT' ? 'git is not installed' : 'git failed to start'));
    });
    child.on('close', (code) => {
      finish(code === 0 ? undefined : new ScaffoldError(500, `git exited with status ${code ?? 'unknown'}`));
    });
  });
}
