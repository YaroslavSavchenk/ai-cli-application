/**
 * Nocturne C2 (.claude/plans/nocturne/PLAN-C2.md § The rule 3): does a
 * background WORKFLOW run still show life? A workflow launch that never
 * reports back (a killed process, a Claude Code bug — measured: 1 of the 22
 * workflow launches on this machine) must not keep its session reading
 * 'Working' forever, and one that runs longer than STALE_MS must not stop
 * doing so early. Its sign of life is the newest mtime among the
 * `agent-<hex>.jsonl` files Claude Code writes in
 * `<session>/subagents/workflows/<runId>/` (measured 2026-09-26: 71 agents in
 * the largest run).
 *
 * THE SAME UNTRUSTED-PATH DISCIPLINE AS B7 (server/agents.ts header):
 *   - the run id came out of an untrusted transcript line: it is checked
 *     against isRunId() (`wf_` + hex groups — no `.`, no separator, nothing
 *     absolute) right here, before it is ever joined into a path;
 *   - the directory is built under the tracked `subagents` directory that the
 *     watcher realpath'd inside the projects root on THIS poll, and its own
 *     realpath must equal that path exactly — a symlink at `workflows` or at
 *     the run's own name (even one pointing inside the root) is refused, not
 *     followed;
 *   - only names matching `agent-<hex>.jsonl` are looked at, and only the
 *     hex capture is joined into a path;
 *   - each is lstat'ed (never followed): a symlink or FIFO wearing the name is
 *     not a regular file and says nothing; NO file is opened or read — the
 *     mtime is all this needs;
 *   - at most MAX_WORKFLOW_SCAN directory entries are examined per call, over
 *     every run together, so a directory planted with a million names costs
 *     one poll a bounded amount of work. The first live file ends the scan.
 * Residual, as for B7's directories: a symlink swapped in between the
 * realpath check and opendir is followed for the listing; what leaks is one
 * bit (some `agent-<hex>.jsonl` there was written recently), and the turn it
 * feeds is a readout anyone who can write the transcript controls anyway.
 *
 * A topic of server/agents.ts in a file of its own from the start (C2,
 * 2026-09-26), so that module stays under CONTRIBUTING.md's 1 000 lines; it
 * was never part of it. Sibling pieces: server/agents.ts (AgentsWatcher — the only caller),
 * server/agents-fold.ts (where the run id comes from) and
 * server/agents-path.ts (the transcript-path boundary).
 */
import { lstatSync, opendirSync, realpathSync, type Dir } from 'node:fs';
import { join } from 'node:path';
import { AGENT_HEX, isRunId } from './agents-fold.ts';

/**
 * Most directory entries one call examines, over all the runs it is given.
 * The same figure as B7's MAX_META_SCAN, 14x the largest run measured.
 */
const MAX_WORKFLOW_SCAN = 1024;

/** A workflow agent's transcript. The capture is the ONLY part joined into a path. */
const AGENT_TRANSCRIPT = new RegExp(`^agent-(${AGENT_HEX})\\.jsonl$`);

/** Why a run gave no sign of life, when it matters to the caller: its directory was refused. */
type WorkflowCheck = 'alive' | 'quiet' | 'refused';

/**
 * 'alive' when any of `runIds` has an `agent-<hex>.jsonl` modified after
 * `sinceMs` in `<realSubagentsDir>/workflows/<runId>/`; 'refused' when none
 * is alive and at least one run's directory resolved somewhere else (the
 * caller logs that once); 'quiet' otherwise — also for a run id of the wrong
 * shape, a directory that is not there, or a scan that hit its cap.
 * `realSubagentsDir` must be the tracked directory as realpath'd inside the
 * projects root on this very poll. Never throws.
 */
export function checkWorkflows(realSubagentsDir: string, runIds: readonly string[], sinceMs: number): WorkflowCheck {
  const budget = { left: MAX_WORKFLOW_SCAN };
  let refused = false;
  for (const runId of runIds) {
    if (budget.left <= 0) break;
    const check = checkRun(realSubagentsDir, runId, sinceMs, budget);
    if (check === 'alive') return 'alive';
    if (check === 'refused') refused = true;
  }
  return refused ? 'refused' : 'quiet';
}

/** One run's directory: the shape check, the realpath check, then the bounded scan. */
function checkRun(realSubagentsDir: string, runId: string, sinceMs: number, budget: { left: number }): WorkflowCheck {
  if (!isRunId(runId)) return 'quiet';
  const runDir = join(realSubagentsDir, 'workflows', runId);
  let real: string;
  try {
    real = realpathSync(runDir);
  } catch {
    return 'quiet'; // Not there (yet, or any more): no sign of life.
  }
  if (real !== runDir) return 'refused';
  let dir: Dir;
  try {
    dir = opendirSync(runDir);
  } catch {
    return 'quiet';
  }
  try {
    for (let entry = dir.readSync(); entry !== null && budget.left > 0; entry = dir.readSync()) {
      budget.left--;
      const id = AGENT_TRANSCRIPT.exec(entry.name)?.[1];
      if (id === undefined) continue; // Not a name we know: never joined into a path.
      let stat;
      try {
        stat = lstatSync(join(runDir, `agent-${id}.jsonl`));
      } catch {
        continue; // Vanished between the listing and the lstat.
      }
      if (stat.isFile() && stat.mtimeMs > sinceMs) return 'alive';
    }
    return 'quiet';
  } catch {
    return 'quiet'; // The listing failed part-way: no sign of life we could see.
  } finally {
    try {
      dir.closeSync();
    } catch {
      // Nothing to do about a failed close.
    }
  }
}
