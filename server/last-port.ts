/**
 * The STICKY PORT: `<dataDir>/last-port.json` (`{ "port": <n> }`, mode 0600,
 * atomically written like every other data-dir store).
 *
 * WHY (decision D5, 2026-09-22, Nocturne B6 — `.claude/plans/nocturne/PLAN-B6.md`):
 * the frontend keeps its tab layout in localStorage, which the browser scopes
 * to the origin INCLUDING the port. An auto-picked port therefore threw the
 * saved layout away on every fresh start, whatever the `Reopen tabs on start`
 * switch said. So the backend now remembers the port it last bound and TRIES
 * it first; auto-pick became the fallback rather than the rule.
 *
 * Precedence of the port tried first: AI_SM_PORT_HINT (a restart handoff) >
 * this file > 0 (let the OS pick). The file's port travels the same path as
 * the handoff hint — tried exactly once, busy falls back to `listen(0)`. A
 * busy REMEMBERED port keeps its place: the `listening` handler in
 * server/index.ts skips the write-back on that fallback, so a squatter holding
 * the number for a few seconds cannot move the origin for good.
 *
 * READ IS GATED, like every other file this process reads back: a missing
 * file is the normal first run, and anything else that is not a JSON object
 * with an integer `port` in 1024-65535 is simply "no last port" plus one
 * debug line. Never a crash, and never a bind below 1024.
 *
 * NOT A SECURITY BOUNDARY, stated plainly: the file is the app's own, under
 * the same 0600-in-the-data-dir ceiling as runtime.json (0600 is hygiene, not
 * a boundary against the Windows user —
 * memory/knowledge/wsl-0600-not-a-boundary.md), and a port number is not a
 * secret. A planted value can do exactly two things: get bound — harmless,
 * the listener is still 127.0.0.1 only and still token-gated — or be busy,
 * which auto-picks. The 1024 floor is what keeps a planted value from asking
 * for a privileged port at all.
 */
import { closeSync, constants as fsConstants, fstatSync, openSync, readSync } from 'node:fs';
import { atomicWriteFile, describeError, type Logger } from './config.ts';

/** A tiny file: anything larger is not ours, so do not even parse it. */
const MAX_LAST_PORT_BYTES = 1024;

/** Where the port tried first came from — the log lines name the source. */
export type PortHintSource = 'handoff' | 'last' | 'none';

/**
 * A port a normal user process may bind: an integer in 1024-65535. 0 ("the OS
 * picks") is deliberately NOT one — it is the absence of a hint, not a port.
 */
export function isUserPort(n: unknown): boolean {
  return typeof n === 'number' && Number.isInteger(n) && n >= 1024 && n <= 65_535;
}

/**
 * The remembered port, or null. Never throws: a missing file is the first run
 * and says nothing; anything else odd costs one debug line and an auto-pick.
 *
 * THE OPEN IS JUDGED, NEVER THE PATH TWICE (the house rule for any synchronous
 * read of a path another process can create —
 * memory/knowledge/fifo-open-blocks-main-thread.md): `O_NOFOLLOW | O_NONBLOCK`,
 * then `fstat` on that fd must say a REGULAR file no larger than the cap BEFORE
 * the first read. This runs on the main thread before the listener exists, so a
 * FIFO planted at the path would otherwise block the boot until a writer
 * appeared, and a symlink to /dev/zero would read without end — the cap after
 * the read is too late for both.
 */
export function readLastPort(file: string, log: Logger): number | null {
  let fd: number;
  try {
    fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (err) {
    // ENOENT is the normal first run. ELOOP (a symlink: the app wrote this file
    // itself, so a link here is not ours) and everything else is one debug line.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log('debug', 'last port file unreadable, auto-picking');
    }
    return null;
  }
  let text: string;
  try {
    const stat = fstatSync(fd);
    // A directory, a FIFO or a device never gets read at all.
    if (!stat.isFile() || stat.size > MAX_LAST_PORT_BYTES) {
      log('debug', 'last port file unreadable, auto-picking');
      return null;
    }
    const buffer = Buffer.allocUnsafe(MAX_LAST_PORT_BYTES + 1);
    const read = readSync(fd, buffer, 0, MAX_LAST_PORT_BYTES + 1, 0);
    if (read > MAX_LAST_PORT_BYTES) {
      log('debug', 'last port file unreadable, auto-picking');
      return null;
    }
    text = buffer.subarray(0, read).toString('utf8');
  } catch {
    log('debug', 'last port file unreadable, auto-picking');
    return null;
  } finally {
    try {
      closeSync(fd);
    } catch {
      // Nothing to do about a failed close.
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    log('debug', 'last port file unreadable, auto-picking');
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    log('debug', 'last port file unreadable, auto-picking');
    return null;
  }
  const port = (parsed as Record<string, unknown>)['port'];
  if (!isUserPort(port)) {
    log('debug', 'last port file unreadable, auto-picking');
    return null;
  }
  return port as number;
}

/**
 * Remember the port that was actually bound. Best effort: losing this file
 * only costs the next start its layout, so a failure is one warn line and the
 * boot continues. A port outside 1024-65535 is not remembered at all — the
 * read gate would refuse it anyway, and writing a value we know we will reject
 * is worse than writing nothing.
 */
export function writeLastPort(file: string, port: number, log: Logger): void {
  if (!isUserPort(port)) {
    log('debug', `port ${port} is outside 1024-65535, not remembered as the last port`);
    return;
  }
  try {
    atomicWriteFile(file, JSON.stringify({ port }) + '\n');
  } catch (err) {
    log('warn', `failed to write ${file}: ${describeError(err)}`);
  }
}

/**
 * The port to try first and where it came from. `envHint` is the ALREADY
 * VALIDATED AI_SM_PORT_HINT (0 when absent or refused); a handoff wins,
 * because its window is pinned to that exact origin and only a live parent
 * ever sets it.
 */
export function choosePortHint(
  envHint: number,
  last: number | null,
): { port: number; source: PortHintSource } {
  if (envHint !== 0) return { port: envHint, source: 'handoff' };
  if (last !== null) return { port: last, source: 'last' };
  return { port: 0, source: 'none' };
}
