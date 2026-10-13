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
 */
import { unlinkSync } from 'node:fs';
import { readSmallRegularFile, type Logger } from './config.ts';
import { plainObject } from './sanitise.ts';

/** runtime.json is a few hundred bytes; anything larger is not ours, so not read. */
const MAX_RUNTIME_FILE_BYTES = 4096;

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
