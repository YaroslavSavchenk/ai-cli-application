/**
 * The previous run's end, as pure rules: the exit record's shape and its
 * parse, the verdict at boot, the journal's OOM line and the one log line
 * that states the verdict. No I/O — server/previous-exit.ts reads the files,
 * runs `journalctl` and calls in here.
 *
 * PLAN-QUALITY Q17 P1 (.claude/plans/quality/PLAN-Q17.md § P1 — backend):
 * 2026-11-24 WSL ran out of memory, powered off and took the backend and the
 * pty-host with it; the window only said `Offline`. The next boot now says
 * what happened and can resume every session that was running.
 */
import type { PreviousExitCause, PreviousExitNotice } from '../shared/protocol.ts';

/** Why the backend wrote its exit record. */
export type ExitWhy = 'signal' | 'presence-grace' | 'restart' | 'other';
/** The signals shutdown() handles (SIGHUP: the type the spec names; nohup leaves it ignored). */
export type ExitSignal = 'SIGTERM' | 'SIGHUP' | 'SIGINT';

/**
 * `<dataDir>/last-exit.json`. `sessions` are HISTORY ids (HistoryEntry.id),
 * ids only — never argv, cwd or a name. `bootId` is the kernel's
 * `/proc/sys/kernel/random/boot_id` at the exit: it tells a VM reboot apart
 * without the clock (WSL2 steps its clock on a host re-sync, and `/proc/stat`
 * `btime` moves with it). `seen` = the notice was resumed or dismissed, or a
 * later boot superseded it — the file is kept, never deleted.
 */
export interface ExitRecord {
  at: string;
  startedAt: string;
  why: ExitWhy;
  signal?: ExitSignal;
  presence: number;
  sessions: string[];
  bootId?: string;
  seen?: true;
}

/** One `history.json` entry this boot stamped `crash` (server/history.ts `load`). */
export interface CrashedEntry {
  id: string;
  lastUsedAt: string;
}

/** The most history ids a record keeps (history.json holds ~200; live ones are never dropped). */
const RECORD_MAX_SESSIONS = 1000;
/** How long after the exit an OOM line still counts (the kernel log runs ahead of the SIGTERM). */
const OOM_AFTER_EXIT_MS = 60_000;
/** The killed process's name as shown: kernel `comm` is <= 15 bytes, this is the cap after cleaning. */
const COMM_MAX_CHARS = 32;

const WHYS: readonly ExitWhy[] = ['signal', 'presence-grace', 'restart', 'other'];
const SIGNALS: readonly ExitSignal[] = ['SIGTERM', 'SIGHUP', 'SIGINT'];
/** A history id: a uuid in practice (server/conversation.ts); never a path, never a control char. */
const HISTORY_ID = /^[A-Za-z0-9._-]{1,128}$/;
const BOOT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** An ISO-8601 string `Date` reads, of sane length. */
function isIsoTime(v: unknown): v is string {
  return typeof v === 'string' && v.length <= 64 && Number.isFinite(Date.parse(v));
}

/**
 * The record a file holds, or undefined when the text is not one (bad JSON, a
 * missing or wrong-typed field, an unknown `why`). Never throws — the caller
 * sets a refused file aside.
 */
export function parseExitRecord(text: string): ExitRecord | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (!isIsoTime(r['at']) || !isIsoTime(r['startedAt'])) return undefined;
  const why = r['why'];
  if (typeof why !== 'string' || !(WHYS as readonly string[]).includes(why)) return undefined;
  const signal = r['signal'];
  if (signal !== undefined && (typeof signal !== 'string' || !(SIGNALS as readonly string[]).includes(signal))) {
    return undefined;
  }
  const presence = r['presence'];
  if (typeof presence !== 'number' || !Number.isInteger(presence) || presence < 0 || presence > 1_000_000) {
    return undefined;
  }
  const sessions = r['sessions'];
  if (!Array.isArray(sessions) || sessions.length > RECORD_MAX_SESSIONS) return undefined;
  if (!sessions.every((s): s is string => typeof s === 'string' && HISTORY_ID.test(s))) return undefined;
  const bootId = r['bootId'];
  if (bootId !== undefined && (typeof bootId !== 'string' || !BOOT_ID.test(bootId))) return undefined;
  const seen = r['seen'];
  if (seen !== undefined && typeof seen !== 'boolean') return undefined;
  return {
    at: r['at'],
    startedAt: r['startedAt'],
    why: why as ExitWhy,
    ...(signal !== undefined ? { signal: signal as ExitSignal } : {}),
    presence,
    sessions: [...new Set(sessions)],
    ...(bootId !== undefined ? { bootId } : {}),
    ...(seen === true ? { seen: true as const } : {}),
  };
}

/** The kernel's boot id as read from /proc, or undefined when it is not one. */
export function parseBootId(text: string): string | undefined {
  const id = text.trim();
  return BOOT_ID.test(id) ? id : undefined;
}

/** `/proc/stat`'s `btime` (seconds since the epoch) as epoch ms, or undefined. */
export function parseBtimeMs(text: string): number | undefined {
  const m = /^btime (\d{1,12})$/m.exec(text);
  return m === null ? undefined : Number(m[1]) * 1000;
}

/**
 * What the boot has to tell, before the VM question:
 *   - `record`: the record says a signal arrived while a window was open, and
 *     it is the newest word — no session this boot stamped `crash` was
 *     launched after it (a later run that died hard would have left those);
 *   - `crash`: sessions were stamped `crash` at this boot and no such record
 *     explains them — the backend was killed before it could write one;
 *   - `none`: a clean stop (presence grace), a restart, an already seen
 *     record, nothing at all.
 * `crashAt` is the best time the boot knows for a hard kill: the previous
 * run's last history write.
 */
type ExitJudgement =
  | { kind: 'none' }
  | { kind: 'record'; record: ExitRecord }
  | { kind: 'crash'; at: string; sessions: string[] };

export function judgeExit(
  record: ExitRecord | undefined,
  crashed: readonly CrashedEntry[],
  crashAt: string,
): ExitJudgement {
  if (record !== undefined && record.seen !== true && record.why === 'signal' && record.presence > 0) {
    const recordMs = Date.parse(record.at);
    const laterLaunch = crashed.some((c) => Date.parse(c.lastUsedAt) > recordMs);
    if (!laterLaunch) return { kind: 'record', record };
  }
  if (crashed.length > 0) return { kind: 'crash', at: crashAt, sessions: crashed.map((c) => c.id) };
  return { kind: 'none' };
}

/**
 * Did the VM boot after the exit? The boot ids decide when both are known; the
 * clock only as a fallback (`btime` after `at`). Nothing known = the same boot:
 * a false `stopped` costs a vaguer sentence, a false `wsl-stopped` a wrong one.
 */
export function vmRebooted(
  record: Pick<ExitRecord, 'at' | 'bootId'>,
  now: { bootId: string | undefined; btimeMs: number | undefined },
): boolean {
  if (record.bootId !== undefined && now.bootId !== undefined) return record.bootId !== now.bootId;
  if (now.btimeMs !== undefined) return now.btimeMs > Date.parse(record.at);
  return false;
}

/** One `Out of memory: Killed process` line of the previous boot's kernel log. */
interface OomKill {
  atMs: number;
  process: string;
  rssMb: number;
}

/**
 * `journalctl -o short-iso`: `2026-11-24T12:53:41+01:00 host kernel: Out of
 * memory: Killed process 46783 (python) total-vm:…kB, anon-rss:2796156kB, …`.
 * Older systemd prints the offset as `+0100`. The name is GREEDY up to the
 * last `)` that an `anon-rss:` still follows, so a hostile name holding
 * `) anon-rss:9kB (` cannot forge the size.
 */
const OOM_LINE =
  /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:[.,]\d+)?)(Z|[+-]\d\d:?\d\d)\s.*?Out of memory: Killed process \d+ \((.*)\).*?\banon-rss:(\d{1,15})kB/;

/** A kernel `comm` made safe for the notice and the log: `[A-Za-z0-9._-]`, <= 32 chars. */
export function sanitiseComm(raw: string): string {
  const clean = raw.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, COMM_MAX_CHARS);
  return clean === '' ? 'unknown' : clean;
}

/** Every OOM kill line in the journal's output; any other line is skipped. */
export function parseOomKills(text: string): OomKill[] {
  const kills: OomKill[] = [];
  for (const line of text.split('\n')) {
    const m = OOM_LINE.exec(line);
    if (m === null) continue;
    const [, stamp, zone, comm, rssKb] = m as unknown as [string, string, string, string, string];
    const offset = zone === 'Z' ? 'Z' : `${zone.slice(0, 3)}:${zone.slice(-2)}`;
    const atMs = Date.parse(`${stamp.replace(',', '.')}${offset}`);
    if (!Number.isFinite(atMs)) continue;
    kills.push({ atMs, process: sanitiseComm(comm), rssMb: Math.round(Number(rssKb) / 1024) });
  }
  return kills;
}

/**
 * The kill that belongs to this exit: inside `[startedAt, at + 60 s]` (the
 * journal stamps whole seconds, so the run's start is floored to one), the
 * largest anon-rss when there are several. null = no OOM line for this run.
 */
export function pickOomKill(
  kills: readonly OomKill[],
  startedAt: string,
  at: string,
): { process: string; rssMb: number } | null {
  const from = Math.floor(Date.parse(startedAt) / 1000) * 1000;
  const to = Date.parse(at) + OOM_AFTER_EXIT_MS;
  let best: OomKill | undefined;
  for (const kill of kills) {
    if (kill.atMs < from || kill.atMs > to) continue;
    if (best === undefined || kill.rssMb > best.rssMb) best = kill;
  }
  return best === undefined ? null : { process: best.process, rssMb: best.rssMb };
}

/** The cause of a `record` judgement: OOM, the VM gone, or the app stopped. */
export function causeOf(
  rebooted: boolean,
  oom: { process: string; rssMb: number } | null,
): Exclude<PreviousExitCause, 'crash'> {
  if (!rebooted) return 'stopped';
  return oom === null ? 'wsl-stopped' : 'oom';
}

/** The ONE `server.log` line of the verdict: cause, time, counts — the killed process's name, never argv. */
export function verdictLine(notice: PreviousExitNotice | null): string {
  if (notice === null) return 'previous run: nothing to tell';
  const detail = notice.detail === null ? '' : `, killed ${notice.detail.process} (${notice.detail.rssMb} MB)`;
  return `previous run: ${notice.cause} at ${notice.at}${detail}; ${notice.sessions} session(s) to resume`;
}
