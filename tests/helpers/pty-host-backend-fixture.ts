/**
 * Shared pieces of the Nocturne D9 P3 tests that run a real backend over a
 * real pty-host (`tests/server/pty-host-crash.test.ts`,
 * `tests/server/pty-host-lost.test.ts`, `tests/server/pty-host-boot.test.ts`):
 * reading what a session printed and what the data dir holds, and
 * `stopDataDirPtyHost`, which `startTestServer`'s stop() (test-server.ts) uses to
 * end a pty-host a test backend left behind. The processes themselves are
 * started through `startTestServer` and tests/helpers/pty-host-fixture.ts.
 */
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import type { HistoryEntry } from '../../shared/protocol.ts';

/** The `pid <n>` a test's bash session printed first (`echo "pid $$"`). */
export function shellPid(output: string): number {
  const m = /pid (\d+)\r?\n/.exec(output);
  if (m === null) throw new Error(`no "pid <n>" line in ${JSON.stringify(output.slice(0, 200))}`);
  return Number(m[1]);
}

/** Every complete `tick <n>` line, in order. */
export function tickNumbers(output: string): number[] {
  return [...output.matchAll(/tick (\d+)\r\n/g)].map((m) => Number(m[1]));
}

/** True while a process with this pid exists (a zombie counts until it is reaped). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** history.json of a data dir, as the backend last wrote it. */
export function readHistory(dataDir: string): HistoryEntry[] {
  return JSON.parse(readFileSync(join(dataDir, 'history.json'), 'utf8')) as HistoryEntry[];
}

/** The pid in `<dataDir>/pty-host.json` (the pty-host the backend started). */
export function hostPidOf(dataDir: string): number {
  return (JSON.parse(readFileSync(join(dataDir, 'pty-host.json'), 'utf8')) as { pid: number }).pid;
}

/**
 * End the pty-host a test backend started in ITS data dir (D9 P3), if one is
 * still alive — after a SIGKILLed backend, or a test that left sessions
 * running. SIGTERM first (its handler kills every PTY's group), SIGKILL after
 * 3 s. The pid comes from `<dataDir>/pty-host.json`, a file only the test's
 * own temp data dir holds: never a process found by name.
 */
export async function stopDataDirPtyHost(dataDir: string): Promise<void> {
  let pid: unknown;
  try {
    pid = (JSON.parse(readFileSync(join(dataDir, 'pty-host.json'), 'utf8')) as { pid?: unknown }).pid;
  } catch {
    return;
  }
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 1) return;
  if (!pidAlive(pid)) return;
  process.kill(pid, 'SIGTERM');
  for (let waited = 0; waited < 3000 && pidAlive(pid); waited += 50) await delay(50);
  if (pidAlive(pid)) process.kill(pid, 'SIGKILL');
}
