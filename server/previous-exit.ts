/**
 * The previous run's end: the exit record every shutdown path writes, the
 * verdict the next boot draws from it, and the notice GET /api/previous-exit
 * serves until it is resumed or dismissed. The rules are pure, in
 * server/previous-exit-model.ts; this module does the I/O around them.
 *
 * PLAN-QUALITY Q17 P1 (.claude/plans/quality/PLAN-Q17.md § P1 — backend).
 *
 * `<dataDir>/last-exit.json` is the app's own small file: 0600 and atomic
 * (`atomicWriteFile`), read FIFO-safe (`readSmallRegularFile`), a refused or
 * malformed one set aside and logged, never thrown. Its I/O must never take
 * the server down — a shutdown path calls `writeRecord` on its way out.
 *
 * The OOM question asks the PREVIOUS boot's kernel log through `journalctl`,
 * argv only, no shell, 5 s and 64 KiB at most (`runCapture`), and only when
 * the VM really booted since the exit. The runner is a seam: tests pass their
 * own and never run the real `journalctl`.
 */
import type { PreviousExitNotice } from '../shared/protocol.ts';
import { atomicWriteFile, readSmallRegularFile, runCapture, setAsideRefused } from './config.ts';
import { describeError, scoped, type Logger } from './config-log.ts';
import {
  causeOf,
  judgeExit,
  parseBootId,
  parseBtimeMs,
  parseExitRecord,
  parseOomKills,
  pickOomKill,
  verdictLine,
  vmRebooted,
  type CrashedEntry,
  type ExitRecord,
  type ExitSignal,
  type ExitWhy,
} from './previous-exit-model.ts';

/** A record is a handful of ids (history.json holds ~200 entries); 256 KiB is far past any honest one. */
const RECORD_MAX_BYTES = 256 * 1024;
/** `/proc/stat` grows with the CPU count (one line each, plus `intr`); 1 MiB is a bounded read. */
const PROC_STAT_MAX_BYTES = 1024 * 1024;

/**
 * The previous boot's kernel OOM kills (spec § P1 2's argv, plus `-r`: newest
 * first, so the 64 KiB cap drops the OLDEST lines — the ones near the exit
 * are the ones that matter).
 */
const JOURNAL_ARGS = [
  '-b', '-1', '-k', '-r', '-o', 'short-iso', '--no-pager', '-g', 'Out of memory: Killed process',
];
const JOURNAL_TIMEOUT_MS = 5_000;
const JOURNAL_MAX_BYTES = 64 * 1024;

/**
 * The journal's stdout, or null when it could not be read (no binary, no
 * `adm` group, no match: exit 1). A test seam too: tests pass their own, so
 * the real `journalctl` never runs in the suite.
 */
export type JournalRunner = (args: string[]) => Promise<string | null>;

/** The two kernel facts the reboot question needs; undefined when unreadable. Tests pass their own (a seam). */
export interface BootFacts {
  bootId: string | undefined;
  btimeMs: number | undefined;
}

function readText(file: string, maxBytes: number): string | undefined {
  const read = readSmallRegularFile(file, maxBytes);
  return read.kind === 'text' ? read.text : undefined;
}

/** The real kernel facts, from /proc. */
function procBootFacts(): BootFacts {
  const id = readText('/proc/sys/kernel/random/boot_id', 256);
  const stat = readText('/proc/stat', PROC_STAT_MAX_BYTES);
  return {
    bootId: id === undefined ? undefined : parseBootId(id),
    btimeMs: stat === undefined ? undefined : parseBtimeMs(stat),
  };
}

/** The real runner: `journalctl`, argv only, bounded. Any failure is "unreadable". */
function runJournal(args: string[]): Promise<string | null> {
  return runCapture('journalctl', args, { timeoutMs: JOURNAL_TIMEOUT_MS, maxBytes: JOURNAL_MAX_BYTES }).catch(
    () => null,
  );
}

/** What a shutdown path knows when it writes the record. */
interface ExitFacts {
  why: ExitWhy;
  signal?: ExitSignal;
  presence: number;
  /** ISO-8601: when this run started. */
  startedAt: string;
  /** HISTORY ids of the sessions live right now. */
  sessions: string[];
}

/** The judged notice, and the record it came from (null for a `crash` verdict). */
interface Verdict {
  notice: PreviousExitNotice;
  sessions: string[];
  fromRecord: ExitRecord | null;
}

export class PreviousExit {
  readonly #file: string;
  readonly #log: Logger;
  readonly #bootFacts: () => BootFacts;
  readonly #journal: JournalRunner;
  #verdict: Promise<Verdict | null> = Promise.resolve(null);
  /** Resumed or dismissed in this run: GET answers 204 from then on. */
  #consumed = false;

  constructor(opts: { file: string; log: Logger; bootFacts?: () => BootFacts; journal?: JournalRunner }) {
    this.#file = opts.file;
    this.#log = scoped(opts.log, 'previous-exit');
    this.#bootFacts = opts.bootFacts ?? procBootFacts;
    this.#journal = opts.journal ?? runJournal;
  }

  /**
   * Boot, right after history.json was loaded (server/index-ptyhost.ts
   * `bootSessions`, at `go` in a standby — the data dir is this process's by
   * then). `crashed` = the entries that load stamped `crash`; `crashAt` = the
   * previous run's last history write. The verdict settles in the background
   * (the journal may take up to 5 s); GET waits for it.
   */
  judge(crashed: readonly CrashedEntry[], crashAt: string): void {
    const record = this.#readRecord();
    const judged = judgeExit(record, crashed, crashAt);
    // A record the verdict does not come from is superseded for good: the
    // next boot must not bring back an old notice after a newer stop.
    if (record !== undefined && record.seen !== true && judged.kind !== 'record') this.#markSeen(record);
    let pending: Promise<Verdict | null> = Promise.resolve(null);
    if (judged.kind === 'record') pending = this.#fromRecord(judged.record);
    if (judged.kind === 'crash') {
      pending = Promise.resolve({
        notice: { at: judged.at, cause: 'crash', detail: null, sessions: judged.sessions.length },
        sessions: judged.sessions,
        fromRecord: null,
      });
    }
    this.#verdict = this.#settle(pending);
  }

  /**
   * A pty-host turned out to still hold sessions this boot stamped `crash`
   * (server/index-ptyhost.ts, the late adopter): they are running, so a
   * `crash` verdict drops them — and is no verdict once none is left.
   */
  reopened(historyIds: readonly string[]): void {
    if (historyIds.length === 0) return;
    const alive = new Set(historyIds);
    this.#verdict = this.#verdict.then((verdict) => {
      if (verdict === null || verdict.fromRecord !== null) return verdict;
      const sessions = verdict.sessions.filter((id) => !alive.has(id));
      this.#log('info', `${verdict.sessions.length - sessions.length} crash-stamped session(s) were adopted after all`);
      if (sessions.length === 0) return null;
      return { ...verdict, sessions, notice: { ...verdict.notice, sessions: sessions.length } };
    });
  }

  /** GET /api/previous-exit: the notice, or null when there is nothing (left) to tell. */
  async notice(): Promise<PreviousExitNotice | null> {
    const verdict = await this.#verdict;
    return this.#consumed || verdict === null ? null : verdict.notice;
  }

  /**
   * POST /api/previous-exit/resume: the history ids to resume, ONCE — the
   * notice is consumed here, so a second call (or a concurrent one) gets [].
   */
  async take(): Promise<string[]> {
    const verdict = await this.#verdict;
    if (this.#consumed || verdict === null) return [];
    this.#consume(verdict, 'resume');
    return [...verdict.sessions];
  }

  /** POST /api/previous-exit/dismiss: the notice is gone for good (the record is marked seen, not deleted). */
  async dismiss(): Promise<void> {
    const verdict = await this.#verdict;
    if (this.#consumed || verdict === null) return;
    this.#consume(verdict, 'dismiss');
  }

  /**
   * A shutdown path, BEFORE the sessions are destroyed or handed over: write
   * what this run was doing when it stopped. Never throws.
   */
  writeRecord(facts: ExitFacts): void {
    const record: ExitRecord = {
      at: new Date().toISOString(),
      startedAt: facts.startedAt,
      why: facts.why,
      ...(facts.signal !== undefined ? { signal: facts.signal } : {}),
      presence: facts.presence,
      sessions: facts.sessions,
    };
    try {
      const { bootId } = this.#bootFacts();
      if (bootId !== undefined) record.bootId = bootId;
    } catch {
      // The boot id is a better clock, not a requirement: btime is the fallback.
    }
    if (this.#write(record)) {
      this.#log(
        'info',
        `exit record written: ${facts.why}${facts.signal === undefined ? '' : ` ${facts.signal}`}, ` +
          `presence=${facts.presence}, ${facts.sessions.length} live session(s)`,
      );
    }
  }

  #consume(verdict: Verdict, how: 'resume' | 'dismiss'): void {
    this.#consumed = true;
    if (verdict.fromRecord !== null) this.#markSeen(verdict.fromRecord);
    this.#log('info', `notice consumed by ${how} (${verdict.notice.cause}, ${verdict.sessions.length} session(s))`);
  }

  /** The record-based verdict: the VM question, then (only after a reboot) the journal. */
  async #fromRecord(record: ExitRecord): Promise<Verdict> {
    let rebooted = false;
    try {
      rebooted = vmRebooted(record, this.#bootFacts());
    } catch {
      // Unknown = the same boot (previous-exit-model.ts `vmRebooted`).
    }
    let oom: { process: string; rssMb: number } | null = null;
    if (rebooted) {
      const out = await this.#journal(JOURNAL_ARGS).catch(() => null);
      if (out === null) this.#log('debug', 'the previous boot\'s kernel log could not be read (no OOM line known)');
      else oom = pickOomKill(parseOomKills(out), record.startedAt, record.at);
    }
    return {
      notice: { at: record.at, cause: causeOf(rebooted, oom), detail: oom, sessions: record.sessions.length },
      sessions: [...record.sessions],
      fromRecord: record,
    };
  }

  /** Log the verdict once, and never let it reject. */
  async #settle(pending: Promise<Verdict | null>): Promise<Verdict | null> {
    let verdict: Verdict | null = null;
    try {
      verdict = await pending;
    } catch (err) {
      this.#log('warn', `previous run not judged: ${describeError(err)}`);
    }
    this.#log('info', verdictLine(verdict === null ? null : verdict.notice));
    return verdict;
  }

  #readRecord(): ExitRecord | undefined {
    const read = readSmallRegularFile(this.#file, RECORD_MAX_BYTES);
    if (read.kind === 'missing') return undefined;
    if (read.kind === 'unreadable') {
      this.#log('warn', `exit record ${this.#file} refused: ${read.reason}`);
      setAsideRefused(this.#file, this.#log);
      return undefined;
    }
    const record = parseExitRecord(read.text);
    if (record === undefined) {
      // Never the content: the reason is a fixed phrase.
      this.#log('warn', `exit record ${this.#file} is not a record`);
      setAsideRefused(this.#file, this.#log);
    }
    return record;
  }

  #markSeen(record: ExitRecord): void {
    this.#write({ ...record, seen: true });
  }

  /** True when written; a failure is one `error` line. */
  #write(record: ExitRecord): boolean {
    try {
      atomicWriteFile(this.#file, JSON.stringify(record, null, 2) + '\n');
      return true;
    } catch (err) {
      this.#log('error', `failed to write ${this.#file}: ${describeError(err)}`);
      return false;
    }
  }
}

