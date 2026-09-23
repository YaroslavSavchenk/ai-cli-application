/**
 * The shared harness of the `tests/server/history*.test.ts` files —
 * persistent session history with REAL resume (decided 2026-09-06).
 *
 * `fixture()` boots a real server child whose PATH resolves `claude` to a TEST
 * DOUBLE that records its argv (`shimArgv` reads it back) and sleeps, with
 * CLAUDE_CONFIG_DIR on a scratch directory — so the real `claude` is never
 * spawned and nothing reads the user's ~/.claude. `unitStore` / `infoOf` /
 * `withClaudeConfig` drive the `SessionHistory` class directly, no server.
 *
 * Moved here out of `tests/server/history.test.ts` when it was split by topic
 * (PLAN-RESTRUCTURE O6); the code is unchanged.
 */
import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { HistoryEntry, SessionInfo } from '../../shared/protocol.ts';
import { SessionHistory } from '../../server/history.ts';
import { api, startTestServer, waitUntil, type TestServer, makeTempDir } from './helpers.ts';

/**
 * A `claude` test double resolved via PATH. Records the argv it was called with
 * as `$AI_SM_TEST_SHIM_OUT/argv-<n>` (n = 1, 2, ... in launch order) and then
 * sleeps, so the session stays 'running' until the test ends it. The launches
 * in this file are strictly sequential, so the numbering never races.
 */
export const CLAUDE_DOUBLE = `#!/bin/sh
out="$AI_SM_TEST_SHIM_OUT"
i=1
while [ -e "$out/argv-$i" ]; do i=$((i+1)); done
: > "$out/argv-$i.part"
for a in "$@"; do printf '%s\\n' "$a" >> "$out/argv-$i.part"; done
mv "$out/argv-$i.part" "$out/argv-$i"
printf 'claude double ready\\n'
sleep 300
`;

export interface Fixture {
  server: TestServer;
  root: string;
  workDir: string;
  shimOut: string;
  claudeConfigDir: string;
  cleanup: () => Promise<void>;
}

/**
 * A server whose PATH resolves `claude` to the double, with a scratch config
 * dir. `seedHistory` writes a history.json BEFORE the server boots, which is
 * the only way to exercise a file this version did not write itself (an older
 * or hand-edited one) through the real load -> list -> resume path.
 */
export async function fixture(
  seedHistory?: (workDir: string) => readonly unknown[],
): Promise<Fixture> {
  const root = await realpath(await makeTempDir('ai-sm-history-'));
  const dataDir = join(root, 'data');
  const workDir = join(root, 'work');
  const shimDir = join(root, 'bin');
  const shimOut = join(root, 'shim-out');
  const claudeConfigDir = join(root, 'claude-config');
  await mkdir(workDir);
  await mkdir(shimDir);
  await mkdir(shimOut);
  await mkdir(claudeConfigDir);
  await writeFile(join(shimDir, 'claude'), CLAUDE_DOUBLE, { mode: 0o755 });
  if (seedHistory !== undefined) {
    await mkdir(dataDir, { mode: 0o700, recursive: true });
    await writeFile(
      join(dataDir, 'history.json'),
      JSON.stringify(seedHistory(workDir), null, 2) + '\n',
      { mode: 0o600 },
    );
  }

  const server = await startTestServer({
    dataDir,
    env: {
      AI_SM_TEST_SHIM_OUT: shimOut,
      // The double must WIN over any real claude, for this server process only.
      PATH: `${shimDir}:${process.env['PATH'] ?? ''}`,
      // Never touch the user's own ~/.claude from a test.
      CLAUDE_CONFIG_DIR: claudeConfigDir,
    },
  });
  return {
    server,
    root,
    workDir,
    shimOut,
    claudeConfigDir,
    cleanup: async () => {
      await server.stop();
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** The argv of the n-th `claude` launch, one token per line. */
export async function shimArgv(shimOut: string, n: number): Promise<string[]> {
  const file = join(shimOut, `argv-${n}`);
  const raw = await waitUntil(
    async () => {
      try {
        return await readFile(file, 'utf8');
      } catch {
        return undefined;
      }
    },
    `the claude double's argv-${n} file`,
    10_000,
  );
  return raw.split('\n').filter((line) => line !== '');
}

export async function history(server: TestServer): Promise<HistoryEntry[]> {
  const res = await api(server, 'GET', '/api/history');
  assert.equal(res.status, 200, `GET /api/history: ${JSON.stringify(res.body)}`);
  return res.body as HistoryEntry[];
}

export async function historyOnDisk(server: TestServer): Promise<HistoryEntry[]> {
  return JSON.parse(await readFile(join(server.dataDir, 'history.json'), 'utf8')) as HistoryEntry[];
}

/** Claude Code's transcript directory name for a cwd (non-alphanumerics -> '-'). */
export function encodeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Run `fn` with CLAUDE_CONFIG_DIR pointed at `dir`, restoring the previous
 * value (or its absence) afterwards.
 *
 * MANDATORY around anything that can reach `pruneUnsaid` IN THIS PROCESS —
 * i.e. every direct `SessionHistory.list()` call below. `claudeConfigDir()`
 * falls back to `~/.claude`, so without this a unit test would stat the
 * developer's (and the user's) own Claude Code data directory. The server-
 * backed tests get the same guarantee from `fixture()`'s env instead.
 */
export async function withClaudeConfig<T>(dir: string, fn: () => T | Promise<T>): Promise<T> {
  const prev = process.env['CLAUDE_CONFIG_DIR'];
  process.env['CLAUDE_CONFIG_DIR'] = dir;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env['CLAUDE_CONFIG_DIR'];
    else process.env['CLAUDE_CONFIG_DIR'] = prev;
  }
}

export interface UnitStore {
  store: SessionHistory;
  /** The history.json this store owns. */
  file: string;
  /** Scratch root (also used as a CLAUDE_CONFIG_DIR with no `projects/`). */
  root: string;
  /** Every `<level> <message>` the store logged. */
  lines: string[];
}

/** A SessionHistory over a scratch file, with its log captured — no server. */
export async function unitStore(name: string): Promise<UnitStore> {
  const root = await makeTempDir(`ai-sm-history-${name}-`);
  const lines: string[] = [];
  const log = (level: string, msg: string): void => void lines.push(`${level} ${msg}`);
  const file = join(root, 'history.json');
  return { store: new SessionHistory(file, log as never), file, root, lines };
}

/** A SessionInfo for the unit-level store, with only the fields a test varies. */
export function infoOf(over: Partial<SessionInfo> & { id: string }): SessionInfo {
  return {
    title: over.id,
    command: 'claude',
    args: [],
    cwd: '/tmp/work',
    status: 'running',
    cols: 80,
    rows: 24,
    createdAt: '2026-09-06T10:00:00.000Z',
    attention: false,
    ...over,
  };
}

export const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
export const CLIENT_UUID = '11111111-2222-3333-4444-555555555555';
