/**
 * Status-line TELEMETRY: what Claude Code reports about a session, read back
 * off disk and put into SessionInfo so the app's own pane status bar can draw
 * it (Nocturne B1, decision 2 of PLAN-NOCTURNE.md).
 *
 * The path: server/statusline.mjs runs inside the FOREIGN claude process on
 * every turn, and — since B1 — writes `<statuslineSnapshotDir>/<app session
 * id>.json` whenever the drawable content changed. This module watches that
 * directory, parses what appears, and hands `(id, telemetry)` to the session
 * manager, which broadcasts the existing `info` message to attached clients.
 *
 * THE INPUT IS UNTRUSTED. Not because claude is: the data dir is an ordinary
 * directory writable by ANY process running as this user (and, on this WSL
 * setup, reachable from Windows — memory/knowledge/wsl-0600-not-a-boundary.md),
 * and whatever comes out of here ends up on screen. So every byte is treated
 * like a hostile file:
 *   - a bounded read (never more than MAX_SNAPSHOT_BYTES, and only from a
 *     REGULAR file opened with O_NOFOLLOW, so a planted symlink or FIFO is
 *     refused rather than followed or blocked on);
 *   - the filename must be a plain session id — it is matched against
 *     SNAPSHOT_FILE and only the capture group is ever joined into a path, so
 *     no `..`, no separator, no absolute path can arrive through an event;
 *   - every string is control-stripped and capped exactly like the script's
 *     clean() (server/sanitise.ts; an ESC smuggled through a branch name must
 *     not reach a terminal or the DOM), every number must be finite and in range, and every key the
 *     schema does not know is dropped.
 *
 * Nothing in here ever throws into a watcher callback or a timer: a bad file is
 * a skipped file, logged at debug and forgotten.
 *
 * Nocturne B7 added one key to the same file, `transcript` — the absolute path
 * of Claude Code's own transcript for this session. It is NOT telemetry and
 * never reaches SessionInfo.telemetry: parseSnapshot drops it like any other
 * key it does not know, and transcriptFromSnapshot below lifts it out
 * separately for server/agents.ts, which owns the boundary check on it. All
 * this module promises about it is that it is a string of 1-1024 characters
 * with no control characters in it.
 */
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readSync,
  readdirSync,
  statSync,
  watch,
  type FSWatcher,
} from 'node:fs';
import { join } from 'node:path';
import type { SessionTelemetry } from '../shared/protocol.ts';
import { describeError, scoped, type Logger } from './config.ts';
import { CONTROL_CHAR, MAX_AT_MS, clean, plainObject } from './sanitise.ts';

/**
 * Hard ceiling on a snapshot file. The real ones are ~150 bytes; anything past
 * this is not a snapshot, so it is refused unread rather than parsed.
 */
const MAX_SNAPSHOT_BYTES = 8 * 1024;

/** Longest a sourced string (model name, branch) may be — the script's cap. */
const MAX_FIELD = 64;

/**
 * A snapshot filename, and the only way an id is ever derived. Same shape as
 * SAFE_ID in server/session-settings.ts, which is what composed the path in the
 * first place: a leading alphanumeric, then up to 63 of `[A-Za-z0-9_-]`.
 */
const SNAPSHOT_FILE = /^([A-Za-z0-9][A-Za-z0-9_-]{0,63})\.json$/;

/**
 * Coalesce the bursts fs.watch reports for one `rename`+`write` pair, per id.
 * Long enough to see a tmp+rename as one event, far shorter than the script's
 * 2 s refresh, so nothing is ever visibly late.
 */
const DEBOUNCE_MS = 150;

/** Poll interval of the fallback path (no inotify, or a directory watch that died). */
const POLL_MS = 2_000;

/** Cost above this is not a session's spend but a corrupt number: refused. */
const MAX_COST_USD = 1_000_000;

/** Line counts above this are not edits either. */
const MAX_LINES = 1_000_000_000;

/**
 * Longest transcript path we will even look at (B7). PATH_MAX is 4096 on
 * Linux, but Claude Code's own transcripts live at a predictable depth under
 * the home directory; a kilobyte is already far past any of them, and the cap
 * exists so a multi-megabyte string in a planted snapshot is refused before
 * anything tries to normalise or realpath it.
 */
const MAX_TRANSCRIPT = 1024;

/** Finite number or undefined (NaN, Infinity, strings and objects are not values). */
function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** A 0-100 percentage floored to an integer, or undefined. */
function pct(value: unknown): number | undefined {
  const n = num(value);
  if (n === undefined) return undefined;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return Math.floor(n);
}

/**
 * Parse one snapshot file's text into telemetry, or null when it is not a
 * snapshot we believe. Pure and total: it never throws, and it never returns a
 * value the payload did not really carry (the script's honesty rule — an absent
 * key, never a zero standing in for "unknown").
 */
export function parseSnapshot(text: string): SessionTelemetry | null {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_SNAPSHOT_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null; // Truncated mid-write, or never JSON at all.
  }
  const raw = plainObject(parsed);
  if (raw === undefined) return null;
  // One schema version, and no guessing at another one: a future writer that
  // changes the shape must say so, and until then its files are ignored.
  if (raw['v'] !== 1) return null;

  const at = num(raw['at']);
  // `at` is the one required field. A negative stamp or one past year 3000 is
  // not a clock we can render, so the whole snapshot goes rather than carrying
  // a nonsense date into the UI.
  if (at === undefined || at < 0 || at > MAX_AT_MS) return null;
  const telemetry: SessionTelemetry = { at: new Date(at).toISOString() };

  const model = clean(raw['model'], MAX_FIELD);
  if (model !== '') telemetry.model = model;
  const branch = clean(raw['branch'], MAX_FIELD);
  if (branch !== '') telemetry.branch = branch;

  const cost = num(raw['cost']);
  // 0 is what a session that has not called the API yet reports: real, but it
  // says nothing — so there is no Cost item, exactly as in Claude's own line.
  if (cost !== undefined && cost > 0 && cost <= MAX_COST_USD) telemetry.costUsd = cost;

  const added = num(raw['linesAdded']);
  const removed = num(raw['linesRemoved']);
  const addedInt = added === undefined || added < 0 ? 0 : Math.min(Math.floor(added), MAX_LINES);
  const removedInt = removed === undefined || removed < 0 ? 0 : Math.min(Math.floor(removed), MAX_LINES);
  // The pair travels together: `+0 -12` is a true statement, `+0 -0` is not an
  // edit at all and gets no item.
  if (addedInt > 0 || removedInt > 0) {
    telemetry.linesAdded = addedInt;
    telemetry.linesRemoved = removedInt;
  }

  const context = pct(raw['context']);
  if (context !== undefined) telemetry.contextPct = context;
  const usage5h = pct(raw['usage5h']);
  if (usage5h !== undefined) telemetry.usage5hPct = usage5h;
  const usage7d = pct(raw['usage7d']);
  if (usage7d !== undefined) telemetry.usage7dPct = usage7d;

  return telemetry;
}

/**
 * The snapshot's `transcript` key (Nocturne B7): Claude Code's own transcript
 * path for this session, or undefined when the file does not carry one we can
 * use. Pure and total, like parseSnapshot, and deliberately SEPARATE from it —
 * telemetry is drawn, this is a path that will be opened, and the two must not
 * share a code path by accident.
 *
 * What is checked here is only what a string can be checked for: the schema
 * version, a length between 1 and MAX_TRANSCRIPT, and no control character
 * (an ESC or a NUL in a path is never anything but an attack or corruption).
 * Whether the path is ABSOLUTE, normalised, shaped like a transcript and
 * inside Claude Code's own projects root is the boundary in server/agents.ts,
 * which is the module that actually opens files — one owner, one check.
 */
export function transcriptFromSnapshot(text: string): string | undefined {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_SNAPSHOT_BYTES) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined; // Truncated mid-write, or never JSON at all.
  }
  const raw = plainObject(parsed);
  if (raw === undefined) return undefined;
  if (raw['v'] !== 1) return undefined; // Same one version parseSnapshot believes.
  const value = raw['transcript'];
  if (typeof value !== 'string') return undefined;
  if (value.length === 0 || value.length > MAX_TRANSCRIPT) return undefined;
  if (CONTROL_CHAR.test(value)) return undefined;
  return value;
}

/**
 * Field-wise equality over the whole schema — what decides whether a session's
 * telemetry actually CHANGED and therefore whether every attached client gets
 * an `info` broadcast. `at` counts: the script rewrites the file only when the
 * drawable content changed, so a different stamp means a different report.
 */
export function sameTelemetry(a: SessionTelemetry | undefined, b: SessionTelemetry | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return (
    a.at === b.at &&
    a.model === b.model &&
    a.branch === b.branch &&
    a.costUsd === b.costUsd &&
    a.linesAdded === b.linesAdded &&
    a.linesRemoved === b.linesRemoved &&
    a.contextPct === b.contextPct &&
    a.usage5hPct === b.usage5hPct &&
    a.usage7dPct === b.usage7dPct
  );
}

/**
 * Watch the snapshot directory and report every parsed change.
 *
 * fs.watch (inotify) is the normal path; a system that cannot give us one — or
 * a watch that dies, e.g. because the directory was replaced — falls back to a
 * 2 s readdir+mtime poll, so the bar is never more than one refresh stale. Both
 * timers are unref'd: telemetry must never be the reason the process lives on.
 */
export class TelemetryWatcher {
  readonly #dir: string;
  readonly #log: Logger;
  #watcher: FSWatcher | undefined;
  #poll: NodeJS.Timeout | undefined;
  #debounce = new Map<string, NodeJS.Timeout>();
  /** Last mtime the POLL path acted on, per id. Unused while fs.watch works. */
  #seen = new Map<string, number>();
  #onChange:
    | ((id: string, telemetry: SessionTelemetry, transcript: string | undefined) => void)
    | undefined;
  #stopped = false;

  constructor(dir: string, log: Logger) {
    this.#dir = dir;
    this.#log = scoped(log, 'telemetry');
  }

  /**
   * Begin watching. Safe to call on a directory that does not exist yet.
   *
   * `transcript` (B7) is the same file's transcript path when it carried one
   * that survived transcriptFromSnapshot, undefined otherwise — a second fact
   * out of the one file, so the handover to server/agents.ts needs no second
   * file and no second watcher.
   */
  start(
    onChange: (id: string, telemetry: SessionTelemetry, transcript: string | undefined) => void,
  ): void {
    this.#onChange = onChange;
    this.#stopped = false;
    try {
      // persistent:false for the same reason the timers are unref'd.
      const watcher = watch(this.#dir, { persistent: false }, (_event, filename) => {
        if (typeof filename !== 'string') return;
        const match = SNAPSHOT_FILE.exec(filename);
        // Anything else — `..`, a path with a separator, a tmp file, a
        // different extension — is ignored and never joined into a path.
        if (match !== null) this.#schedule(match[1] as string);
      });
      watcher.on('error', (err) => {
        // A dead watch is silent, which would be worse than slow: fall back.
        this.#log('debug', `watch on ${this.#dir} failed, polling instead: ${describeError(err)}`);
        try {
          watcher.close();
        } catch {
          // Already closed.
        }
        this.#watcher = undefined;
        if (!this.#stopped) this.#startPolling();
      });
      this.#watcher = watcher;
      this.#log('debug', `watching ${this.#dir}`);
    } catch (err) {
      this.#log('debug', `cannot watch ${this.#dir} (${describeError(err)}); polling every ${POLL_MS}ms`);
      this.#startPolling();
    }
  }

  /** Stop watching and drop every pending debounce. Idempotent. */
  stop(): void {
    this.#stopped = true;
    this.#onChange = undefined;
    if (this.#watcher !== undefined) {
      try {
        this.#watcher.close();
      } catch {
        // Already closed.
      }
      this.#watcher = undefined;
    }
    if (this.#poll !== undefined) {
      clearInterval(this.#poll);
      this.#poll = undefined;
    }
    for (const timer of this.#debounce.values()) clearTimeout(timer);
    this.#debounce.clear();
    this.#seen.clear();
  }

  #startPolling(): void {
    if (this.#poll !== undefined) return;
    this.#poll = setInterval(() => this.#pollOnce(), POLL_MS);
    this.#poll.unref();
  }

  /** One readdir+mtime sweep. A missing directory is normal here, not an error. */
  #pollOnce(): void {
    if (this.#stopped) return;
    let names: string[];
    try {
      names = readdirSync(this.#dir);
    } catch {
      return; // Not created yet, or gone: try again next tick.
    }
    const present = new Set<string>();
    for (const name of names) {
      const match = SNAPSHOT_FILE.exec(name);
      if (match === null) continue;
      const id = match[1] as string;
      present.add(id);
      let mtime: number;
      try {
        mtime = statSync(join(this.#dir, name)).mtimeMs;
      } catch {
        continue; // Vanished between readdir and stat.
      }
      if (this.#seen.get(id) === mtime) continue;
      this.#seen.set(id, mtime);
      this.#schedule(id);
    }
    // Forget ids whose file is gone: the map would otherwise grow for the life
    // of the process, and a session id that comes back (same mtime as its
    // deleted file, which a same-millisecond rewrite can produce) would be
    // mistaken for unchanged and never reported.
    for (const id of this.#seen.keys()) {
      if (!present.has(id)) this.#seen.delete(id);
    }
  }

  /** Coalesce a burst of events for one id into a single read. */
  #schedule(id: string): void {
    if (this.#stopped) return;
    const pending = this.#debounce.get(id);
    if (pending !== undefined) clearTimeout(pending);
    const timer = setTimeout(() => {
      this.#debounce.delete(id);
      this.#deliver(id);
    }, DEBOUNCE_MS);
    timer.unref();
    this.#debounce.set(id, timer);
  }

  /** Read, parse, hand over. Every failure ends here, at debug. */
  #deliver(id: string): void {
    if (this.#stopped) return;
    const onChange = this.#onChange;
    if (onChange === undefined) return;
    const text = this.#read(join(this.#dir, `${id}.json`));
    if (text === undefined) return;
    const telemetry = parseSnapshot(text);
    if (telemetry === null) {
      this.#log('debug', `${id}: snapshot ignored (not a snapshot we believe)`);
      return;
    }
    try {
      onChange(id, telemetry, transcriptFromSnapshot(text));
    } catch (err) {
      // A throwing consumer must not take the watcher down with it.
      this.#log('warn', `${id}: telemetry consumer threw: ${describeError(err)}`);
    }
  }

  /**
   * Bounded read of one snapshot: a REGULAR file, never a symlink (O_NOFOLLOW),
   * never more than MAX_SNAPSHOT_BYTES. undefined = nothing to parse, including
   * the ordinary case of a file whose session ended between the event and here.
   */
  #read(file: string): string | undefined {
    let fd: number;
    try {
      // O_NONBLOCK too: opening a FIFO for reading blocks until a writer
      // appears, and this runs on the main thread — a planted named pipe would
      // freeze the whole server before isFile() below ever got to refuse it.
      // On a regular file the flag changes nothing.
      fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    } catch {
      return undefined; // Gone, unreadable, or a symlink we refuse to follow.
    }
    try {
      const stat = fstatSync(fd);
      // A FIFO or device here would block or never end; only a real file is read.
      if (!stat.isFile()) return undefined;
      const buffer = Buffer.allocUnsafe(MAX_SNAPSHOT_BYTES + 1);
      const read = readSync(fd, buffer, 0, MAX_SNAPSHOT_BYTES + 1, 0);
      if (read > MAX_SNAPSHOT_BYTES) return undefined; // Too big: refused unparsed.
      return buffer.subarray(0, read).toString('utf8');
    } catch {
      return undefined;
    } finally {
      try {
        closeSync(fd);
      } catch {
        // Nothing to do about a failed close.
      }
    }
  }
}
