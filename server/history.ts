/**
 * Persistent session history (decided 2026-09-06, user's call) — replaces the
 * one-run-deep journal/previous pair.
 *
 * history.json holds EVERY session the app launched, across backend runs: one
 * entry per conversation (claude-kind, pinned via `--session-id`) or per first
 * launch (anything else). An entry is written at create time with ended:null
 * and stamped when the session ends — user-kill, natural exit, or shutdown; on
 * boot every entry a previous run left ended:null is stamped 'crash'. All four
 * reasons stay listed and resumable, which is the whole fix: the old
 * /api/previous only ever offered 'shutdown'/'crash' entries of a single
 * previous run, so a session the user closed with x was gone forever.
 *
 * The file is rewritten atomically (mode 0600) on every mutation, so a hard cut
 * loses at most the final stamp — which the next boot repairs as 'crash'.
 * Bounded: past HISTORY_MAX entries the ENDED entry with the oldest lastUsedAt
 * is dropped (a live one never is).
 *
 * History I/O must never take the server down: every read/write is wrapped and
 * failures are logged, not thrown.
 */
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { HistoryEntry, SessionEndReason, SessionInfo } from '../shared/protocol.ts';
import { atomicWriteFile, describeError, errorStackOnly, scoped, type Logger } from './config.ts';
import { isUuid } from './conversation.ts';

/** Cap on stored entries; the oldest ENDED one is dropped past this. */
export const HISTORY_MAX = 200;

/** Reasons a running server may record; 'crash' is stamped only at boot. */
export type LiveEndReason = Exclude<SessionEndReason, 'crash'>;

/** What SessionManager.create knows about the launch it just made. */
export interface HistoryKey {
  /** Entry key: the conversation id, or the app session id. */
  id: string;
  conversation: boolean;
  /** Client args with resume/session flags stripped — what a resume re-uses. */
  baseArgs: string[];
}

/**
 * Where Claude Code stores conversation transcripts. Verified against the
 * Claude Code 2.1.263 bundle: `<configDir>/projects/<cwd with every
 * non-alphanumeric character replaced by '-'>/<session id>.jsonl`, where the
 * encoded cwd is truncated + hashed only when it exceeds 200 characters (we
 * refuse to guess in that case — see #transcriptMissing).
 */
const ENCODED_CWD_MAX = 200;

function claudeConfigDir(): string {
  const override = process.env['CLAUDE_CONFIG_DIR'];
  return override !== undefined && override !== '' ? override : join(homedir(), '.claude');
}

function encodeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function fileExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/**
 * Accept an on-disk record only if the fields a resume depends on are sane.
 * Missing newer fields are filled in conservatively so a file written by an
 * older/hand-edited version can never crash a boot.
 */
function normalizeEntry(raw: unknown): HistoryEntry | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r['id'] !== 'string' || r['id'] === '') return undefined;
  if (typeof r['command'] !== 'string' || r['command'] === '') return undefined;
  if (typeof r['cwd'] !== 'string' || r['cwd'] === '') return undefined;
  if (!isStringArray(r['args'])) return undefined;
  const createdAt = typeof r['createdAt'] === 'string' ? r['createdAt'] : new Date(0).toISOString();
  const ended = r['ended'];
  let endedValue: HistoryEntry['ended'] = null;
  if (typeof ended === 'object' && ended !== null) {
    const e = ended as Record<string, unknown>;
    if (typeof e['at'] === 'string' && typeof e['reason'] === 'string') {
      endedValue = { at: e['at'], reason: e['reason'] as SessionEndReason };
    }
  }
  const entry: HistoryEntry = {
    id: r['id'],
    // A conversation id reaches `--resume <id>` and a transcript path, so a
    // hand-edited file may not declare one that is not UUID-shaped.
    conversation: r['conversation'] === true && isUuid(r['id']),
    sessionId: typeof r['sessionId'] === 'string' ? r['sessionId'] : r['id'],
    ...(typeof r['projectId'] === 'string' ? { projectId: r['projectId'] } : {}),
    cwd: r['cwd'],
    command: r['command'],
    args: [...r['args']],
    title: typeof r['title'] === 'string' ? r['title'] : basename(r['command']),
    createdAt,
    lastUsedAt: typeof r['lastUsedAt'] === 'string' ? r['lastUsedAt'] : createdAt,
    ended: endedValue,
    ...(typeof r['exitCode'] === 'number' ? { exitCode: r['exitCode'] } : {}),
  };
  return entry;
}

export class SessionHistory {
  readonly #file: string;
  readonly #log: Logger;
  /** `[history] …`-tagged view of the same logger, for the detail lines. */
  readonly #hlog: Logger;
  #entries: HistoryEntry[] = [];

  constructor(file: string, log: Logger) {
    this.#file = file;
    this.#log = log;
    this.#hlog = scoped(log, 'history');
  }

  /**
   * Boot: read history.json (missing/corrupt -> empty, logged) and stamp every
   * entry a previous run left live as 'crash', then write the repaired file.
   */
  load(): void {
    this.#entries = this.#read();
    const at = new Date().toISOString();
    let crashed = 0;
    for (const entry of this.#entries) {
      if (entry.ended === null) {
        entry.ended = { at, reason: 'crash' };
        crashed += 1;
      }
    }
    this.#write();
    this.#log(
      'info',
      `history loaded: ${this.#entries.length} entries (${crashed} stamped 'crash')`,
    );
    const live = this.#entries.filter((e) => e.ended === null).length;
    this.#hlog(
      'info',
      `file ${this.#file}: ${this.#entries.length} entries, ${live} live, ` +
        `${this.#entries.filter((e) => e.conversation).length} resumable conversations`,
    );
  }

  /**
   * Record a launch. An existing entry (i.e. a resume) is UPDATED in place —
   * createdAt is the first launch, forever — and a new one is appended, after
   * which the HISTORY_MAX bound is enforced on ended entries only.
   */
  recordCreate(info: SessionInfo, key: HistoryKey): void {
    const existing = this.#entries.find((e) => e.id === key.id);
    if (existing !== undefined) {
      existing.conversation = key.conversation;
      existing.sessionId = info.id;
      existing.command = info.command;
      existing.args = [...key.baseArgs];
      existing.cwd = info.cwd;
      existing.title = info.title;
      existing.lastUsedAt = info.createdAt;
      existing.ended = null;
      delete existing.exitCode;
      if (info.projectId !== undefined) existing.projectId = info.projectId;
      else delete existing.projectId;
      this.#hlog(
        'debug',
        `record update ${key.id} (conversation ${key.conversation}) for session ${info.id}`,
      );
    } else {
      this.#entries.push({
        id: key.id,
        conversation: key.conversation,
        sessionId: info.id,
        ...(info.projectId !== undefined ? { projectId: info.projectId } : {}),
        cwd: info.cwd,
        command: info.command,
        args: [...key.baseArgs],
        title: info.title,
        createdAt: info.createdAt,
        lastUsedAt: info.createdAt,
        ended: null,
      });
      this.#hlog(
        'debug',
        `record create ${key.id} (conversation ${key.conversation}) for session ${info.id}; ` +
          `${this.#entries.length} entries`,
      );
      this.#enforceBound();
    }
    this.#write();
  }

  /**
   * Stamp the end of the launch whose app session id is `sessionId`. First
   * stamp wins (a later 'exit' from the async onExit is the no-op after a
   * 'user-kill'/'shutdown').
   */
  markEnded(sessionId: string, reason: LiveEndReason, exitCode?: number): void {
    const entry = this.#entries.find((e) => e.sessionId === sessionId && e.ended === null);
    if (entry === undefined) {
      this.#hlog(
        'debug',
        `end '${reason}' for session ${sessionId} is a no-op (already stamped or unknown)`,
      );
      return;
    }
    entry.ended = { at: new Date().toISOString(), reason };
    if (exitCode !== undefined) entry.exitCode = exitCode;
    this.#hlog(
      'debug',
      `end ${entry.id} reason '${reason}'${exitCode === undefined ? '' : ` exit ${exitCode}`} ` +
        `(session ${sessionId})`,
    );
    this.#write();
  }

  /** Shutdown: stamp every still-live entry in a single rewrite. */
  endAllLive(reason: LiveEndReason): void {
    const at = new Date().toISOString();
    let stamped = 0;
    for (const entry of this.#entries) {
      if (entry.ended === null) {
        entry.ended = { at, reason };
        stamped += 1;
      }
    }
    if (stamped > 0) this.#write();
    this.#hlog('info', `end-all reason '${reason}': ${stamped} live entries stamped`);
  }

  /**
   * ENDED entries only, newest lastUsedAt first — what GET /api/history serves.
   * Claude conversations whose transcript is provably absent (nothing was ever
   * said) are pruned first, so the list never offers an empty conversation.
   */
  list(): HistoryEntry[] {
    this.pruneUnsaid();
    const listed = this.#entries
      .filter((e) => e.ended !== null)
      .sort((a, b) => (a.lastUsedAt < b.lastUsedAt ? 1 : a.lastUsedAt > b.lastUsedAt ? -1 : 0))
      .map((e) => ({ ...e, args: [...e.args], ended: e.ended === null ? null : { ...e.ended } }));
    // THE diagnostic for "the drawer's HISTORY section is empty": it says
    // whether the store had nothing, or had only live entries, or pruned them.
    this.#hlog(
      'info',
      `list -> ${listed.length} ended entries (of ${this.#entries.length} stored, ` +
        `${this.#entries.filter((e) => e.ended === null).length} live)`,
    );
    return listed;
  }

  /** One entry by key (live ones included — the route decides 409). */
  get(id: string): HistoryEntry | undefined {
    const entry = this.#entries.find((e) => e.id === id);
    return entry === undefined
      ? undefined
      : {
          ...entry,
          args: [...entry.args],
          ended: entry.ended === null ? null : { ...entry.ended },
        };
  }

  /** Forget one ENDED entry. False when unknown OR still live. */
  forget(id: string): boolean {
    const entry = this.#entries.find((e) => e.id === id);
    if (entry === undefined || entry.ended === null) {
      this.#hlog('debug', `forget ${id} refused: ${entry === undefined ? 'unknown' : 'still live'}`);
      return false;
    }
    this.#entries = this.#entries.filter((e) => e !== entry);
    this.#hlog('info', `forgot entry ${id}; ${this.#entries.length} remain`);
    this.#write();
    return true;
  }

  /** Forget every ended entry; live ones stay (they are still running). */
  forgetAllEnded(): void {
    const before = this.#entries.length;
    this.#entries = this.#entries.filter((e) => e.ended === null);
    this.#hlog(
      'info',
      `forget-all-ended: ${before - this.#entries.length} dropped, ${this.#entries.length} live kept`,
    );
    if (this.#entries.length !== before) this.#write();
  }

  /**
   * Drop ended claude conversations that PROVABLY hold nothing: no transcript
   * file exists for them under Claude Code's own projects directory, i.e. the
   * user opened a session and never said a word. Resuming such an id shows an
   * empty conversation, so it is noise in the history list.
   *
   * "Provably" is deliberately strict — every uncertainty KEEPS the entry:
   *   - `<configDir>/projects` must exist as a directory (otherwise we have not
   *     found Claude's home at all and prune NOTHING);
   *   - the cwd must resolve with realpath (Claude Code names the directory
   *     from the CHILD's `process.cwd()`, i.e. the physical, normalized path —
   *     a trailing slash or a symlinked project folder encodes differently
   *     from the string we stored). An unresolvable cwd keeps the entry;
   *   - the encoded cwd must be <= 200 chars (past that Claude truncates and
   *     hashes the name, which we do not reproduce);
   *   - the entry id must be UUID-shaped (it reaches a filesystem path);
   *   - the per-cwd directory `<configDir>/projects/<encoded realpath(cwd)>`
   *     must EXIST as a directory. That existence is the only evidence we have
   *     that our encoding still matches Claude Code's; without it (an encoding
   *     change, a folder Claude never wrote) the answer is UNKNOWN and the
   *     entry stays. Only then does a missing `<id>.jsonl` inside it mean
   *     "nothing was ever said".
   */
  pruneUnsaid(): void {
    try {
      const projectsDir = join(claudeConfigDir(), 'projects');
      if (!isDirectory(projectsDir)) {
        this.#hlog(
          'debug',
          `prune skipped: ${projectsDir} is not a directory — Claude's home was not found, ` +
            'so nothing is provably empty',
        );
        return;
      }
      let checked = 0;
      const kept = this.#entries.filter((e) => !this.#unsaid(projectsDir, e, () => (checked += 1)));
      const dropped = this.#entries.length - kept.length;
      // ONE line per call. Per-entry lines exist only for the `prune` verdict:
      // a 200-entry store used to write 200 `prune check ... keep` lines on
      // every GET /api/history, i.e. on every drawer refresh and relaunch.
      this.#hlog('debug', `prune checked ${checked} candidate(s), pruned ${dropped}`);
      if (dropped === 0) return;
      this.#entries = kept;
      this.#write();
      this.#log('info', `history pruned: ${dropped} claude conversation(s) with no transcript`);
    } catch (err) {
      // Belt and braces: every fs call in this path already swallows its own
      // errors (isDirectory/fileExists return false, #unsaid catches realpath,
      // #write logs), so nothing here is known to throw today. Kept because the
      // class contract is "history I/O never takes the server down" — a future
      // call added inside this block must not be able to break it.
      this.#log('warn', `history prune skipped: ${describeError(err)}`);
    }
  }

  #unsaid(projectsDir: string, entry: HistoryEntry, counted: () => void): boolean {
    // The cheap disqualifiers are NOT logged, and do not count as candidates:
    // they are not prune decisions.
    if (entry.ended === null) return false;
    if (!entry.conversation) return false;
    if (basename(entry.command) !== 'claude') return false;
    if (!isUuid(entry.id)) return false; // Never let a non-uuid reach a path.
    counted();
    // From here on every outcome is a real decision. Only `prune` gets its own
    // line — an entry VANISHING from the drawer must be explainable from
    // server.log, while a kept one is the normal case and is covered by the
    // single `prune checked N candidate(s), pruned M` summary in pruneUnsaid().
    const decision = (verdict: 'prune' | 'keep', why: string): boolean => {
      if (verdict === 'prune') {
        this.#hlog('debug', `prune check ${entry.id} cwd ${entry.cwd}: prune — ${why}`);
      }
      return verdict === 'prune';
    };
    let real: string;
    try {
      real = realpathSync(entry.cwd);
    } catch {
      // Cannot canonicalize -> cannot know the directory name.
      return decision('keep', 'cwd does not resolve (uncertain)');
    }
    const encoded = encodeCwd(real);
    if (encoded.length > ENCODED_CWD_MAX) {
      return decision('keep', `encoded cwd is ${encoded.length} > ${ENCODED_CWD_MAX} chars (uncertain)`);
    }
    const cwdDir = join(projectsDir, encoded);
    const transcript = join(cwdDir, `${entry.id}.jsonl`);
    // No per-cwd directory: our encoding is unproven for this cwd (or Claude
    // never wrote here at all). Unknown -> keep.
    if (!isDirectory(cwdDir)) {
      return decision('keep', `${cwdDir} is not a directory (uncertain)`);
    }
    if (fileExists(transcript)) return decision('keep', `${transcript} exists`);
    return decision('prune', `${transcript} is missing — nothing was ever said`);
  }

  /** Keep at most HISTORY_MAX entries, dropping the oldest ENDED ones. */
  #enforceBound(): void {
    while (this.#entries.length > HISTORY_MAX) {
      let oldest: HistoryEntry | undefined;
      for (const entry of this.#entries) {
        if (entry.ended === null) continue;
        if (oldest === undefined || entry.lastUsedAt < oldest.lastUsedAt) oldest = entry;
      }
      if (oldest === undefined) return; // Everything is live: never drop a live entry.
      const victim = oldest;
      this.#entries = this.#entries.filter((e) => e !== victim);
      this.#hlog(
        'info',
        `bound ${HISTORY_MAX} exceeded: dropped oldest ended entry ${victim.id} ` +
          `(last used ${victim.lastUsedAt})`,
      );
    }
  }

  #read(): HistoryEntry[] {
    let raw: string;
    try {
      raw = readFileSync(this.#file, 'utf8');
    } catch {
      this.#hlog('info', `no history file at ${this.#file} yet — starting empty`);
      return []; // No file — nothing recorded yet.
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error('not an array');
      const entries: HistoryEntry[] = [];
      let skipped = 0;
      for (const item of parsed) {
        const entry = normalizeEntry(item);
        if (entry === undefined) skipped += 1;
        else entries.push(entry);
      }
      if (skipped > 0) {
        this.#log('warn', `history file ${this.#file}: ${skipped} unusable entries ignored`);
      }
      return entries;
    } catch (err) {
      // errorStackOnly, NOT describeError: history.json is written from data
      // that came through the API, and a JSON.parse SyntaxError quotes ~10
      // characters of the file back in its message.
      this.#log('warn', `unreadable history file ${this.#file} ignored: ${errorStackOnly(err)}`);
      return [];
    }
  }

  #write(): void {
    try {
      atomicWriteFile(this.#file, JSON.stringify(this.#entries, null, 2) + '\n');
      this.#hlog('debug', `wrote ${this.#entries.length} entries to ${this.#file}`);
    } catch (err) {
      this.#log('error', `failed to write ${this.#file}: ${describeError(err)}`);
    }
  }
}
