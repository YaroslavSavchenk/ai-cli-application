/**
 * The authenticated clone of server/github.ts, steps 3-5 plus its two helpers:
 * the clone-url host-lock (buildAuthenticatedGithubUrl), the destination
 * rules, the GIT_ASKPASS-through-env spawn of `git clone` (runGitClone) and
 * the post-clone leak check. GithubConnection.cloneAuthenticated keeps steps
 * 1-2 (url first, then the connected credential) and calls in here.
 *
 * Split from server/github.ts (PLAN-RESTRUCTURE O8, 2026-09-23). Moved whole:
 * the bodies are the former private methods #buildAuthenticatedGithubUrl and
 * #runGitClone and the former body of cloneAuthenticated, de-indented, with
 * `this.#spawn` / `this.#runGitClone` now the `spawn` parameter / runGitClone.
 * Sibling pieces: server/github.ts (GithubConnection) and
 * server/github-parse.ts (seams, GithubError, the parsers).
 */
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { isDirectory } from './config.ts';
import { GithubError, parseGithubRepoPath, type SpawnLike } from './github-parse.ts';
import { assertVacant, ScaffoldError, CLONE_TIMEOUT_MS } from './scaffold.ts';

/** Reject absurdly long clone urls before parsing them. */
const MAX_CLONE_URL_LEN = 2048;
/**
 * Username embedded in the authenticated clone url. NOT a secret — the actual
 * password (the OAuth token) is fed to git via GIT_ASKPASS-through-env, never
 * the url. git uses this username and asks GIT_ASKPASS for the matching password.
 */
const CLONE_USERNAME = 'x-access-token';
/** Env var the throwaway askpass script reads the token from (never on argv/url). */
const ASKPASS_TOKEN_ENV = 'AI_SM_GH_TOKEN';

/**
 * Validate a clone url and return the authenticated form. Hard guard: MUST be
 * https:// with host EXACTLY github.com (no port), no embedded credentials —
 * so the token (fed separately via GIT_ASKPASS) can never be aimed elsewhere.
 * Rejects `-`-leading, control chars, and over-length up front. The returned
 * url carries only the NON-secret `x-access-token` username, never the token.
 */
export function buildAuthenticatedGithubUrl(cloneUrl: string): string {
  if (typeof cloneUrl !== 'string' || cloneUrl === '') {
    throw new GithubError(400, 'cloneUrl is required');
  }
  if (cloneUrl.length > MAX_CLONE_URL_LEN) throw new GithubError(400, 'cloneUrl is too long');
  if (cloneUrl.startsWith('-')) throw new GithubError(400, 'invalid clone url');
  for (let i = 0; i < cloneUrl.length; i += 1) {
    const c = cloneUrl.charCodeAt(i);
    if (c <= 0x20 || c === 0x7f) throw new GithubError(400, 'clone url contains invalid characters');
  }
  let parsed: URL;
  try {
    parsed = new URL(cloneUrl);
  } catch {
    throw new GithubError(400, 'invalid clone url');
  }
  if (parsed.protocol !== 'https:') {
    throw new GithubError(400, 'clone url must be https://github.com/...');
  }
  if (parsed.hostname !== 'github.com' || parsed.port !== '') {
    throw new GithubError(400, 'clone url host must be exactly github.com');
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new GithubError(400, 'clone url must not embed credentials');
  }
  // Rebuild from validated parts only: guarantees the target is github.com and
  // the token is NOT in the url (git gets it via GIT_ASKPASS instead).
  return `https://${CLONE_USERNAME}@github.com${parsed.pathname}`;
}

/**
 * Clone a (possibly PRIVATE) repo of the connected account into `destAbs`
 * using the stored OAuth token — WITHOUT the token ever touching argv, the
 * clone url, `.git/config`, or a log.
 *
 * Token-safety mechanism (the security crux):
 *   1. `cloneUrl` is validated FIRST (buildAuthenticatedGithubUrl): it MUST be
 *      https:// with host EXACTLY github.com — a hard guard so the token can
 *      never be aimed at another host (SSRF/exfil). The returned url embeds
 *      only the NON-secret username `x-access-token@` (never the token).
 *   2. A throwaway askpass script (mode 0700, in a mkdtemp under the OS tmpdir)
 *      reads the token from the env var AI_SM_GH_TOKEN and prints it. git is
 *      spawned with GIT_ASKPASS=<script> and AI_SM_GH_TOKEN=<token> in its env
 *      (argv is `git ... clone -- <username-in-url> <dest>` — NO token). git
 *      calls GIT_ASKPASS for the password, gets the token from env, and does
 *      NOT persist an askpass password into `.git/config`. `credential.helper`
 *      is cleared (`-c credential.helper=`) so no configured helper can cache
 *      the token to disk. `stdio:'ignore'` — git output is never buffered or
 *      logged (an error line could otherwise echo a credential).
 *   3. `finally`: the askpass script + its dir are deleted. On success the
 *      cloned `.git/config` is verified to NOT contain the token.
 *
 * WHAT THE ENV DOES AND DOES NOT BUY (corrected 2026-07-25 — the earlier
 * comment here overstated it). Passing the token through the child's
 * environment keeps it out of argv, the url, `.git/config`, and any log — the
 * places it would otherwise PERSIST or be readable by other local users. It is
 * still readable via /proc by this same Linux user, and, on WSL2, by anything
 * running as the WINDOWS user: the 9p file server runs as root inside the
 * distro, so `\\wsl.localhost\...` reads every 0600 file in the data dir
 * regardless of the permission bits (measured — see
 * memory/knowledge/wsl-0600-not-a-boundary.md). So this is NOT "the same trust
 * boundary as github.json 0600" in the protective sense that phrase implied;
 * both are inside one boundary that already includes the Windows user. The
 * mechanism is still right — it removes the persistent and cross-user
 * exposures — it just is not a wall against that principal, and nothing here
 * may claim it is.
 *
 * Reuses scaffold's assertVacant (409 non-empty, no clobber) and its partial-
 * cleanup discipline (a dest WE created is removed on failure). Throws
 * GithubError: 400 bad url/dest, 403 when creating the owner directory is
 * denied, 409 not connected / non-empty dest, 502 on clone failure.
 *
 * `dest` is normalized (path.resolve) before ANY filesystem decision, so the
 * path that is inspected, created, cloned into and cleaned up is always one
 * and the same — see step 3.
 *
 * Dest parents: normally the parent must already exist (400 otherwise). The
 * single exception is the OWNER directory of an owner-qualified destination
 * `<projects>/<owner>/<repo>` — see step 3b for the four conditions that must
 * all hold, and for the cleanup of an owner dir left empty by a failed clone.
 *
 * Here: steps 3-5. Steps 1-2 (the url host-lock, then the connected
 * credential) run first, in GithubConnection.cloneAuthenticated
 * (server/github.ts), which hands over `authUrl` and `token`.
 */
export async function cloneIntoDestination(
  spawn: SpawnLike,
  cloneUrl: string,
  dest: string,
  authUrl: string,
  token: string,
): Promise<void> {
  // 3. Dest no-clobber rules (reused from scaffold): absolute, not an existing
  //    non-empty dir / non-directory. Checked BEFORE the parent rules so no
  //    directory is ever created for a destination we would refuse anyway.
  //
  //    NORMALIZE BEFORE ANY FILESYSTEM DECISION. An un-normalized dest makes
  //    the checks below reason about a DIFFERENT directory than the one the
  //    string reaches on disk: `<X>/<owner>/..` stats as missing (so
  //    `existedBefore` would be false) while git — and the failure cleanup's
  //    recursive rmSync — act on the pre-existing `<X>`. From here on there is
  //    exactly one path: `destAbs` is what is stat'ed, what may be created,
  //    what git is handed, and the only thing cleanup may remove. (The route
  //    in server/api.ts refuses a non-normalized dest outright; this makes
  //    every in-process caller safe too.)
  //    (The absolute check is belt-and-braces: the route rejects a relative
  //    dest before this method is reached, so it cannot change an observable
  //    outcome — it is here for in-process callers, not pinned by a test.)
  if (!isAbsolute(dest)) throw new GithubError(400, 'dest must be absolute');
  const destAbs = resolve(dest);
  let existedBefore = true;
  try {
    statSync(destAbs);
  } catch {
    existedBefore = false;
  }
  try {
    assertVacant(destAbs);
  } catch (err) {
    if (err instanceof ScaffoldError) throw new GithubError(err.status, err.message);
    throw new GithubError(500, 'failed to inspect destination');
  }

  // 3b. OWNER-QUALIFIED DESTINATIONS (settled 2026-07-25): app clones land in
  //     `<projects>/<owner>/<repo>`, so exactly ONE missing segment — the
  //     directory the dest names as its OWNER — may be created here. What the
  //     code below actually requires (NOT a projects-root anchor: the dest may
  //     sit anywhere the user can write, e.g. `/tmp/acme/api` creates
  //     `/tmp/acme`):
  //       * only dest's DIRECT parent is ever created,
  //       * that parent's basename must equal the owner segment of the clone
  //         url (case-insensitive, never percent-decoded) — note BOTH sides
  //         come from the SAME request, so this is a coherence check on the
  //         caller's own two inputs, not a containment guarantee: it stops a
  //         mistyped/mismatched dest, it does not constrain WHERE a directory
  //         may appear,
  //       * dest's grandparent must already be a directory, and
  //       * one level only — mkdir, never mkdir -p.
  //     The containment here comes from those last two: one level, under an
  //     already-existing directory.
  //     Anything else keeps the old 400, so a typo'd dest still refuses
  //     instead of silently materialising a directory tree.
  //     Doing it OURSELVES rather than just dropping the check matters: real
  //     `git clone` creates leading directories unboundedly (verified against
  //     git 2.43), so this is what keeps creation to one level, turns a
  //     permission problem into a clean 403 instead of an opaque 502, and —
  //     because we know we made it — lets `createdOwnerDir` be removed again
  //     (only while empty) when the clone then fails.
  let createdOwnerDir: string | undefined;
  const parent = dirname(destAbs);
  if (!isDirectory(parent)) {
    const owner = parseGithubRepoPath(cloneUrl)?.owner;
    const grandparent = dirname(parent);
    if (
      owner === undefined ||
      // Root guard + grandparent check: both belt-and-braces rather than
      // pinned behaviour — a filesystem-root parent already fails the
      // basename comparison, and a missing grandparent makes the mkdirSync
      // below fail into the SAME 400. Neither can change an observable
      // outcome today; keep them, but do not assume a test covers them.
      parent === grandparent ||
      basename(parent).toLowerCase() !== owner.toLowerCase() ||
      !isDirectory(grandparent)
    ) {
      throw new GithubError(400, 'destination parent directory does not exist');
    }
    try {
      mkdirSync(parent);
      createdOwnerDir = parent;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM') throw new GithubError(403, 'permission denied');
      throw new GithubError(400, 'destination parent directory does not exist');
    }
  }

  /**
   * Undo what WE created: the dest, then an owner dir left empty by the
   * failure. `existedBefore` is exactly "statSync(destAbs) succeeded", so
   * `!existedBefore` is the broader "we could not see anything there" — it
   * also covers a dangling symlink at `destAbs` (rmSync removes the LINK, not
   * its target — measured) and an unreadable parent (EACCES), where the
   * removal then simply fails and is swallowed. Both stay bounded to
   * `destAbs` itself; the owner dir is removed non-recursively.
   */
  const undoOurDirs = (): void => {
    if (!existedBefore) {
      try {
        rmSync(destAbs, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup.
      }
    }
    if (createdOwnerDir !== undefined) {
      try {
        rmdirSync(createdOwnerDir); // ENOTEMPTY (someone else's data) -> keep it
      } catch {
        // Best-effort cleanup.
      }
    }
  };

  // 4. Clone via GIT_ASKPASS-through-env (token never on argv/url). The
  //    mkdtemp lives INSIDE the protected region: if it throws (full/read-only
  //    tmpdir), an owner directory created in 3b must still be undone.
  let askDir: string | undefined;
  try {
    askDir = mkdtempSync(join(tmpdir(), 'ai-sm-gh-ask-'));
    const askScript = join(askDir, 'askpass.sh');
    // The script ignores its prompt arg and prints the token from the env.
    writeFileSync(askScript, `#!/bin/sh\nprintf '%s' "$${ASKPASS_TOKEN_ENV}"\n`, { mode: 0o700 });
    await runGitClone(spawn, authUrl, destAbs, askScript, token);
  } catch (err) {
    undoOurDirs();
    throw err instanceof GithubError ? err : new GithubError(502, 'failed to clone repository');
  } finally {
    if (askDir !== undefined) {
      try {
        rmSync(askDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup.
      }
    }
  }

  // 5. Belt-and-suspenders: git stores only the username in .git/config, never
  //    the askpass password. Prove the token did not leak onto disk.
  try {
    const cfg = readFileSync(join(destAbs, '.git', 'config'), 'utf8');
    if (cfg.includes(token)) {
      undoOurDirs();
      throw new GithubError(500, 'aborted: credential leaked into git config');
    }
  } catch (err) {
    if (err instanceof GithubError) throw err;
    // Config unreadable (unexpected) — that is not a leak; leave the clone.
  }
}

/**
 * Spawn `git -c credential.helper= clone -- <authUrl> <destAbs>` with the
 * token supplied ONLY through the env (GIT_ASKPASS + AI_SM_GH_TOKEN). No
 * shell, stdio fully ignored (no output buffered/logged), bounded by
 * CLONE_TIMEOUT_MS, GIT_TERMINAL_PROMPT=0 so a credential-needing clone fails
 * fast instead of hanging. Resolves on exit 0, else rejects GithubError(502).
 */
function runGitClone(
  spawn: SpawnLike,
  authUrl: string,
  destAbs: string,
  askScript: string,
  token: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (err?: GithubError): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (err !== undefined) reject(err);
      else resolve();
    };
    let child: ChildProcess;
    try {
      child = spawn(
        'git',
        // `-c credential.helper=` clears any configured helper so the token is
        // never cached to disk. `--` stops the url/dest being read as options.
        ['-c', 'credential.helper=', 'clone', '--', authUrl, destAbs],
        {
          shell: false,
          stdio: 'ignore',
          windowsHide: true,
          env: {
            ...process.env,
            GIT_ASKPASS: askScript,
            [ASKPASS_TOKEN_ENV]: token,
            GIT_TERMINAL_PROMPT: '0',
          },
        },
      );
    } catch {
      finish(new GithubError(502, 'failed to clone repository'));
      return;
    }
    timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
      finish(new GithubError(502, 'clone timed out'));
    }, CLONE_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();

    child.on('error', () => {
      finish(new GithubError(502, 'failed to clone repository'));
    });
    child.on('close', (code) => {
      finish(code === 0 ? undefined : new GithubError(502, 'failed to clone repository'));
    });
  });
}
