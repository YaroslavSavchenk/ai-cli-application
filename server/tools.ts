/**
 * Which launchable executables this backend can actually find (Nocturne B5,
 * `.claude/plans/nocturne/PLAN-B5.md`): the New session dialog draws a tool card as inert
 * ("Not installed") instead of offering a launch that would fail in the PTY.
 *
 * THE PROBE NEVER SPAWNS ANYTHING. It is a PATH lookup — regular file (symlinks
 * followed), executable by this process — in the SAME environment a session is
 * spawned with (`ptyEnv()`), so the probe and the spawn cannot disagree about
 * which PATH they mean.
 *
 * Deliberate refusals in the lookup:
 *   - an EMPTY PATH entry (POSIX: "the current directory") is skipped, and so is
 *     any relative entry. Resolving a tool name against this process's cwd is
 *     never what the user means, and `.` on PATH is the classic way a planted
 *     `claude` in some working directory becomes the one that runs.
 *   - a DIRECTORY named like a tool is not a tool (`isFile()` is checked before
 *     X_OK; a directory is commonly +x).
 */
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { ToolAvailability } from '../shared/protocol.ts';

/**
 * The executable name behind each field of ToolAvailability. The two Windows
 * ones are reached through WSL interop and are found on PATH like any other
 * (`/mnt/c/Windows/System32`).
 */
export const TOOL_EXECUTABLES: Record<keyof ToolAvailability, string> = {
  claude: 'claude',
  codex: 'codex',
  gemini: 'gemini',
  grok: 'grok',
  zsh: 'zsh',
  cmd: 'cmd.exe',
  powershell: 'powershell.exe',
};

/** Cache window of GET /api/tools. The dialog asks once per open; this absorbs bursts. */
export const TOOLS_CACHE_MS = 5_000;

/**
 * True when `file` is a regular file this process may execute.
 *
 * ASYNC ON PURPOSE. A PATH here is ~28 entries, more than half of them under
 * /mnt (drvfs, where a stat costs milliseconds); the synchronous version of
 * this probe blocked the single event loop for ~120 ms per dialog open — no
 * PTY output flushed, no WS frame, no resize, for that whole time.
 */
async function isExecutableFile(file: string): Promise<boolean> {
  try {
    if (!(await stat(file)).isFile()) return false;
    await access(file, constants.X_OK);
    return true;
  } catch {
    // ENOENT, EACCES on a parent directory, a dangling symlink, EPERM: all
    // mean "cannot launch this", which is exactly what `false` says.
    return false;
  }
}

/** True when `name` resolves to an executable regular file on `env.PATH`. */
export async function findOnPath(
  name: string,
  env: Record<string, string | undefined>,
): Promise<boolean> {
  const path = env['PATH'];
  if (typeof path !== 'string' || path === '') return false;
  const hits = await Promise.all(
    path
      .split(':')
      .map(async (dir) =>
        dir === '' || !isAbsolute(dir) ? false : isExecutableFile(join(dir, name)),
      ), // see the header note on empty / relative entries
  );
  return hits.some((hit) => hit);
}

/** One PATH lookup per launchable tool. No spawn, no shell, no network. */
export async function probeTools(
  env: Record<string, string | undefined>,
): Promise<ToolAvailability> {
  const entries = Object.entries(TOOL_EXECUTABLES) as [keyof ToolAvailability, string][];
  const found = await Promise.all(entries.map(async ([, executable]) => findOnPath(executable, env)));
  const out = {} as ToolAvailability;
  entries.forEach(([tool], i) => {
    out[tool] = found[i] as boolean;
  });
  return out;
}

export interface ToolsProbeOptions {
  /** The environment to probe — production passes `ptyEnv`. */
  env: () => Record<string, string | undefined>;
  /** MONOTONIC clock seam (default performance.now, so a wall-clock jump cannot extend the window). */
  now?: () => number;
  cacheMs?: number;
}

/**
 * `probeTools` behind a short cache — the same shape as the update-check cache
 * in server/buildinfo.ts: a caller-injectable clock, a window, one recompute.
 */
export function cachedProbe(opts: ToolsProbeOptions): () => Promise<ToolAvailability> {
  const now = opts.now ?? ((): number => performance.now());
  const cacheMs = opts.cacheMs ?? TOOLS_CACHE_MS;
  let cachedAt = -Infinity;
  let cached: ToolAvailability | undefined;
  /** The probe that is running right now: concurrent callers share ONE. */
  let inFlight: Promise<ToolAvailability> | null = null;
  return async (): Promise<ToolAvailability> => {
    const at = now();
    if (cached !== undefined && at - cachedAt < cacheMs) return { ...cached };
    if (inFlight !== null) return { ...(await inFlight) };
    const run = probeTools(opts.env());
    inFlight = run;
    try {
      const answer = await run;
      cached = answer;
      cachedAt = at;
      return { ...answer };
    } finally {
      inFlight = null;
    }
  };
}
