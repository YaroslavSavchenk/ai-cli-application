/**
 * github.json — where GithubConnection keeps the credential it may persist
 * (`GithubTokenStore`): the judged read on boot, the atomic 0600 write, the
 * removal, and the set-aside of a file the read refused (Q8).
 *
 * THE TOKEN RULES HOLD HERE AS IN server/github.ts: the token is never written
 * to server.log (only the file's path, a fixed phrase or an errno code, an
 * error's class and stack frames); the file is written through
 * atomicWriteFile (mode 0600) and read through readSmallRegularFile (no FIFO
 * hang, no link followed, capped). 0600 is not encryption and nothing here
 * claims it is (memory/knowledge/wsl-0600-not-a-boundary.md).
 *
 * Split from server/github.ts (PLAN-QUALITY Q13, 2026-11-22): the former
 * private methods #setAsideIfRefused, #removeStore and the file halves of
 * #persist and #load, with their log lines and checks unchanged; the
 * connection keeps which credential it holds and builds the record it saves.
 * Siblings: server/github.ts (GithubConnection), server/github-parse.ts
 * (seams, GithubError, the parsers), server/github-clone.ts.
 */
import { unlinkSync } from 'node:fs';
import { atomicWriteFile, readSmallRegularFile, setAsideRefused } from './config.ts';
import { errorStackOnly, type Logger } from './config-log.ts';
import { asRecord, readString } from './github-parse.ts';

/**
 * Read cap for github.json (Q8). The writer stores one token (a pasted one is
 * at most GITHUB_TOKEN_MAX_BYTES = 4 KiB, server/api-github.ts; a device-flow
 * one is far shorter), a login, a scope list and two timestamps, pretty-printed:
 * a few KiB at most. 64 KiB is well above that; a bigger file is not ours.
 */
const GITHUB_FILE_MAX_BYTES = 64 * 1024;

/**
 * Shape persisted to github.json (mode 0600). The accessToken never leaves the
 * server. `source` was added with the pasted-token path: a record WITHOUT it
 * predates that path and therefore came from the device flow, so it reads as
 * 'device' (never as "unknown"). `scopes`/`expiresAt` are only ever present when
 * GitHub actually reported them.
 */
export interface StoredToken {
  accessToken: string;
  login?: string;
  /** Device-flow OAuth scope string, kept for backwards compatibility. */
  scope: string;
  connectedAt: string;
  /** Absent = 'device' (a record written before the pasted-token path existed). */
  source?: 'device' | 'pat';
  /** Classic-PAT scopes from x-oauth-scopes; absent for fine-grained tokens. */
  scopes?: string[];
  /** ISO-8601 credential expiry, when GitHub reported one. */
  expiresAt?: string;
}

export class GithubTokenStore {
  readonly #file: string;
  readonly #log: Logger;
  /** GithubConnection's `[github] …` view of the same logger (its rule: no token, no body, no message). */
  readonly #ghlog: Logger;
  /** The load refused the file: set it aside before the first write (config.ts setAsideRefused). */
  #refusedAtLoad = false;

  constructor(file: string, log: Logger, ghlog: Logger) {
    this.#file = file;
    this.#log = log;
    this.#ghlog = ghlog;
  }

  /**
   * Read github.json (on construction of the connection). The record, with a
   * missing `scope` read as `defaultScope` and a missing `connectedAt` as now;
   * undefined when there is no usable file — absent, refused (set aside at the
   * first save) or unparsable — and the connection starts disconnected.
   */
  load(defaultScope: string): StoredToken | undefined {
    // The judged open (memory/knowledge/fifo-open-blocks-main-thread.md): a
    // FIFO planted here would hang the boot, a link would be followed.
    const read = readSmallRegularFile(this.#file, GITHUB_FILE_MAX_BYTES);
    if (read.kind === 'missing') {
      this.#ghlog('debug', `no ${this.#file} — starting disconnected`);
      return undefined; // No github.json yet — start disconnected.
    }
    if (read.kind === 'unreadable') {
      // The reason is a fixed phrase or an errno code — never the file's bytes.
      this.#refusedAtLoad = true;
      this.#log('warn', `${this.#file} refused: ${read.reason} — starting disconnected, set aside at the first save`);
      return undefined;
    }
    const raw = read.text;
    try {
      const o = asRecord(JSON.parse(raw));
      const accessToken = o !== undefined ? readString(o, 'accessToken') : undefined;
      if (o === undefined || accessToken === undefined) {
        throw new Error('github.json missing accessToken');
      }
      const login = readString(o, 'login');
      const scopes = o['scopes'];
      const expiresAt = readString(o, 'expiresAt');
      return {
        accessToken,
        ...(login !== undefined ? { login } : {}),
        scope: readString(o, 'scope') ?? defaultScope,
        connectedAt: readString(o, 'connectedAt') ?? new Date().toISOString(),
        source: readString(o, 'source') === 'pat' ? 'pat' : 'device',
        ...(Array.isArray(scopes) && scopes.every((s) => typeof s === 'string')
          ? { scopes: scopes as string[] }
          : {}),
        ...(expiresAt !== undefined ? { expiresAt } : {}),
      };
    } catch {
      this.#log('error', 'failed to parse github.json, starting disconnected');
      return undefined;
    }
  }

  /**
   * Write github.json (`undefined`: nothing to write, after a refused file was
   * set aside). Returns whether the credential is now ACTUALLY on disk —
   * `status.persisted` is set from this, so a failed write reports
   * `persisted:false` instead of promising a durability the disk refused.
   */
  save(stored: StoredToken | undefined): boolean {
    this.#setAsideIfRefused();
    if (stored === undefined) return false;
    this.#ghlog('debug', `persisting credential store to ${this.#file}`);
    try {
      atomicWriteFile(this.#file, JSON.stringify(stored, null, 2) + '\n');
      return true;
    } catch (err) {
      // Never include the token in the message — err is a filesystem error only.
      this.#log('error', `failed to persist github token store: ${errorStackOnly(err)}`);
      return false;
    }
  }

  /** Remove github.json. Best-effort: an absent file is the desired end state. */
  remove(): void {
    this.#setAsideIfRefused();
    try {
      unlinkSync(this.#file);
    } catch {
      // Already gone.
    }
  }

  /** Both the write and the unlink of github.json would destroy a refused file: move it first. */
  #setAsideIfRefused(): void {
    if (this.#refusedAtLoad) {
      this.#refusedAtLoad = false;
      setAsideRefused(this.#file, this.#log);
    }
  }
}
