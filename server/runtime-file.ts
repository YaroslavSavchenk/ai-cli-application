/**
 * Ownership of the discovery file `<dataDir>/runtime.json` on the way out.
 *
 * WHY (Nocturne D2, bug in memory/BACKLOG.md § From Nocturne C1): a shutdown
 * used to unlink runtime.json unconditionally. Seen twice on the dev data dir:
 * an old backend hit its idle grace 9 s after a NEW backend had written its own
 * runtime.json and deleted the new one's file; launcher/launch.ps1
 * (`Read-RuntimeInfo` found no file → `Start-Backend`) then started a second
 * backend. So a backend now removes the file only while it still names THIS
 * process: same `pid` AND same `startedAt` (the pid-reuse guard — a recycled
 * pid with another start time is someone else).
 * Anything else — missing, unreadable, not ours — is left alone with one info
 * line naming the reason, never the token or the file's contents.
 *
 * The decision (`runtimeFileVerdict`) is pure so a test reaches it without a
 * process; `removeOwnRuntimeFile` is the one I/O wrapper, used by both the
 * clean shutdown and the uncaughtException path in server/index.ts.
 *
 * Also the restart's read of the file a standby writes (`runtimeInfoReader`,
 * Q8: moved here from server/index-restart.ts so every read of runtime.json
 * shares the one judged open and the one cap).
 */
import { unlinkSync } from 'node:fs';
import type { RuntimeInfo } from '../shared/protocol.ts';
import { readSmallRegularFile, type Logger } from './config.ts';
import { plainObject } from './sanitise.ts';

/**
 * Read cap for runtime.json, shared by the exit path and the restart poll.
 * The file is a few hundred bytes, EXCEPT `appDir` (the repo root or bundle
 * dir), which nothing bounds below PATH_MAX (4096 bytes) — and JSON may escape
 * it further. 16 KiB covers a PATH_MAX appDir plus port, token, pid and
 * startedAt with room; at 4096 a deep checkout would be refused on every
 * restart poll and the restart would fail (Q8 fix round). Larger is not ours.
 */
const MAX_RUNTIME_FILE_BYTES = 16 * 1024;

/** Who this process is, as it wrote itself into runtime.json at listen. */
interface RuntimeOwner {
  pid: number;
  /** '' before listen: no file was written yet, so no file on disk is ours. */
  startedAt: string;
}

/** Remove the file, or keep it and say why (a fixed phrase, no file content). */
type RuntimeFileVerdict = { remove: true } | { remove: false; reason: string };

/**
 * The file's text (undefined when it could not be read) against this process.
 * Pure: the whole rule a test pins.
 */
export function runtimeFileVerdict(text: string | undefined, self: RuntimeOwner): RuntimeFileVerdict {
  if (text === undefined) return { remove: false, reason: 'unreadable' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { remove: false, reason: 'unparsable' };
  }
  const record = plainObject(parsed);
  if (record === undefined) return { remove: false, reason: 'unparsable' };
  const { pid, startedAt } = record;
  if (pid !== self.pid) return { remove: false, reason: 'it names another process' };
  if (self.startedAt === '' || startedAt !== self.startedAt) {
    return { remove: false, reason: 'it names another start of this pid' };
  }
  return { remove: true };
}

/**
 * Unlink runtime.json only if it still names `self`. Never throws.
 *
 * Read-then-unlink is not atomic: a backend that renames its own file into
 * place between our read and our unlink would lose it. Accepted, no locking —
 * the window is microseconds on a path where a new backend writes once at
 * listen, against the 9 s gap the observed bug needed; and a lock file would
 * itself be a stale-owner problem for a crashed process.
 */
export function removeOwnRuntimeFile(file: string, self: RuntimeOwner, log: Logger): void {
  // config.ts's judged open: this runs on the main thread during exit, so a
  // FIFO or a link planted at the path must neither block it nor be followed.
  const read = readSmallRegularFile(file, MAX_RUNTIME_FILE_BYTES);
  if (read.kind === 'missing') {
    log('info', 'runtime.json already gone; nothing to remove');
    return;
  }
  const verdict = runtimeFileVerdict(read.kind === 'text' ? read.text : undefined, self);
  if (!verdict.remove) {
    log('info', `runtime.json left in place: ${verdict.reason}`);
    return;
  }
  try {
    unlinkSync(file);
  } catch {
    // Gone in between — the outcome we wanted.
  }
}

/**
 * The restart's poll of runtime.json (server/restart.ts `#waitForChild`, every
 * RESTART_POLL_MS): the parsed file, or undefined while it is absent, half
 * written or not ours. The shape is not judged here — `#waitForChild` checks
 * pid, port and startedAt before believing any of it.
 *
 * The judged open (memory/knowledge/fifo-open-blocks-main-thread.md): the poll
 * runs on the main thread, so a FIFO planted at the path must not block it
 * and a link must not be followed. Such a refusal is one warn line per reason,
 * not one per poll (ten a second for up to RESTART_TIMEOUT_MS).
 */
export function runtimeInfoReader(file: string, log: Logger): () => RuntimeInfo | undefined {
  let warned = '';
  return () => {
    const read = readSmallRegularFile(file, MAX_RUNTIME_FILE_BYTES);
    if (read.kind === 'unreadable') {
      if (read.reason !== warned) {
        log('warn', `${file} refused: ${read.reason} — waiting for the new backend's file`);
      }
      warned = read.reason;
      return undefined;
    }
    warned = '';
    if (read.kind === 'missing') return undefined;
    try {
      return JSON.parse(read.text) as RuntimeInfo; // Shape checked by #waitForChild.
    } catch {
      return undefined; // Never half-written (it is renamed into place); a foreign file can be.
    }
  };
}
