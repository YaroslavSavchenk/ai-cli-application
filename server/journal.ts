/**
 * Crash-safe session journal (lifecycle-bound backend, decided 2026-07-19).
 *
 * journal.json mirrors the sessions of the CURRENT run: one entry per
 * created session, stamped ended {at, reason} on exit / user kill /
 * shutdown. The file is rewritten atomically (0600) on every mutation, so a
 * hard cut loses at most the final stamp — exactly what boot rotation
 * repairs.
 *
 * On boot, rotate(): a leftover journal.json from the previous run replaces
 * previous.json (entries still ended:null get reason 'crash') and a fresh
 * journal begins. previous.json feeds GET /api/previous — only 'shutdown'
 * and 'crash' entries are offered for relaunch; DELETE dismisses entries.
 *
 * Journal I/O must never take the server down: every write is wrapped and
 * failures are logged, not thrown.
 */
import { readFileSync, unlinkSync } from 'node:fs';
import type {
  PreviousSession,
  SessionEndReason,
  SessionInfo,
  SessionJournalEntry,
} from '../shared/protocol.ts';
import { atomicWriteFile, type Logger } from './config.ts';

/** Reasons the live journal may record; 'crash' is stamped only at rotation. */
export type LiveEndReason = Exclude<SessionEndReason, 'crash'>;

function readEntries(file: string, log: Logger): SessionJournalEntry[] {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return []; // No file — nothing recorded.
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('not an array');
    return parsed as SessionJournalEntry[];
  } catch (err) {
    log('warn', `unreadable journal file ${file} ignored: ${String(err)}`);
    return [];
  }
}

export class SessionJournal {
  readonly #journalFile: string;
  readonly #previousFile: string;
  readonly #log: Logger;
  #entries = new Map<string, SessionJournalEntry>();
  #previous: SessionJournalEntry[] = [];

  constructor(journalFile: string, previousFile: string, log: Logger) {
    this.#journalFile = journalFile;
    this.#previousFile = previousFile;
    this.#log = log;
  }

  /**
   * Boot-time rotation. If a journal from a previous run exists it becomes
   * previous.json (entries still ended:null stamped reason 'crash'); either
   * way the in-memory previous list is loaded and a fresh journal starts.
   */
  rotate(): void {
    let hadJournal = false;
    try {
      readFileSync(this.#journalFile);
      hadJournal = true;
    } catch {
      // No previous-run journal.
    }
    if (hadJournal) {
      const stale = readEntries(this.#journalFile, this.#log);
      const at = new Date().toISOString();
      let crashed = 0;
      this.#previous = stale.map((e) => {
        if (e.ended !== null) return e;
        crashed += 1;
        return { ...e, ended: { at, reason: 'crash' as const } };
      });
      this.#writeFile(this.#previousFile, this.#previous);
      try {
        unlinkSync(this.#journalFile);
      } catch {
        // Already gone.
      }
      this.#log(
        'info',
        `journal rotated: ${this.#previous.length} entries from previous run (${crashed} stamped 'crash')`,
      );
    } else {
      this.#previous = readEntries(this.#previousFile, this.#log);
    }
    this.#entries = new Map();
  }

  /** Record a freshly created session (ended: null) and rewrite the journal. */
  recordCreate(info: SessionInfo): void {
    const entry: SessionJournalEntry = {
      id: info.id,
      ...(info.projectId !== undefined ? { projectId: info.projectId } : {}),
      cwd: info.cwd,
      command: info.command,
      args: [...info.args],
      title: info.title,
      createdAt: info.createdAt,
      ended: null,
    };
    this.#entries.set(info.id, entry);
    this.#writeJournal();
  }

  /** Stamp an end reason. First stamp wins; later calls are no-ops. */
  markEnded(id: string, reason: LiveEndReason, exitCode?: number): void {
    const entry = this.#entries.get(id);
    if (entry === undefined || entry.ended !== null) return;
    entry.ended = { at: new Date().toISOString(), reason };
    if (exitCode !== undefined) entry.exitCode = exitCode;
    this.#writeJournal();
  }

  /** Shutdown: stamp every still-live entry 'shutdown' in a single rewrite. */
  endAllLive(reason: LiveEndReason): void {
    // A session-free run must not fabricate an empty journal.json: the next
    // boot's rotate() would take the [] as a real previous-run journal and
    // overwrite previous.json with it, destroying un-dismissed crash/shutdown
    // relaunch offers that were never shown.
    if (this.#entries.size === 0) return;
    const at = new Date().toISOString();
    for (const entry of this.#entries.values()) {
      if (entry.ended === null) entry.ended = { at, reason };
    }
    this.#writeJournal();
  }

  /** Previous-run entries worth offering for relaunch ('shutdown' | 'crash'). */
  listPrevious(): PreviousSession[] {
    return this.#previous
      .filter((e) => e.ended !== null && (e.ended.reason === 'shutdown' || e.ended.reason === 'crash'))
      .map((e) => ({ ...e }));
  }

  /** Dismiss one previous entry by id. Returns false if unknown. */
  dismissPrevious(id: string): boolean {
    const next = this.#previous.filter((e) => e.id !== id);
    if (next.length === this.#previous.length) return false;
    this.#previous = next;
    this.#writeFile(this.#previousFile, this.#previous);
    return true;
  }

  /** Dismiss all previous entries. */
  dismissAllPrevious(): void {
    this.#previous = [];
    this.#writeFile(this.#previousFile, this.#previous);
  }

  #writeJournal(): void {
    this.#writeFile(this.#journalFile, [...this.#entries.values()]);
  }

  #writeFile(file: string, entries: SessionJournalEntry[]): void {
    try {
      atomicWriteFile(file, JSON.stringify(entries, null, 2) + '\n');
    } catch (err) {
      this.#log('error', `failed to write ${file}: ${String(err)}`);
    }
  }
}
