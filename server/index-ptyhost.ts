/**
 * The boot's pty-host wiring: which `PtyHost` this backend uses, and the
 * adoption step that runs before listen — the sessions a pty-host still holds
 * from an earlier backend become this one's.
 *
 * Nocturne D9 P3 (.claude/plans/nocturne/PLAN-D9.md § Phases P3). A piece of
 * server/index.ts (the composition root, near its size limit); siblings
 * server/index-stores.ts, index-restart.ts, index-update.ts, index-banner.ts,
 * index-claude.ts. The broker itself is server/pty-host-broker.ts.
 *
 * The adoption order (§ Defaults) and why each step waits for the one before:
 *   1. connect as owner to a running pty-host and `list` (events held);
 *   2. history: stamp `crash` only for entries the pty-host does NOT hold;
 *      the previous run's end is judged from those stamps (Q17);
 *   3. wipe session artifacts, except the files of the held ids;
 *   4. adopt: rebuild each session, seed its mirror, re-scan the gap; one
 *      that exited meanwhile ends as an exit; Claude `--settings` rewritten;
 *   5. release the held events — then the caller listens.
 */
import { describeError, scoped, type Logger } from './config-log.ts';
import type { SessionHistory } from './history.ts';
import { resolvePtyHostMode } from './pty-host-client.ts';
import { PtyHostBroker } from './pty-host-broker.ts';
import type { SessionManager } from './sessions.ts';
import type { PtyEntrySummary } from './pty-table.ts';
import type { PreviousExit } from './previous-exit.ts';

/**
 * The broker for this data dir. An invalid `AI_SM_PTY_HOST` refuses the start
 * with its reason in server.log (stderr is /dev/null for a detached backend),
 * the same shape as the other boot refusals in server/index.ts.
 */
export function createPtyHostBroker(opts: {
  log: Logger;
  dataDir: string;
  installed: boolean;
  build: string;
}): PtyHostBroker {
  let mode: 'socket' | 'inproc';
  try {
    mode = resolvePtyHostMode(opts.installed);
  } catch (err) {
    opts.log('error', `refusing to start: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
  if (mode === 'inproc') {
    scoped(opts.log, 'pty-host')('info', 'AI_SM_PTY_HOST=inproc: sessions run inside the backend (test seam)');
  }
  return new PtyHostBroker({ mode, dataDir: opts.dataDir, build: opts.build, log: opts.log });
}

/**
 * Steps 1–5 above. A failure of one step is logged and the boot goes on with
 * what it has; the held events are released whatever happened (a `finally`),
 * so no adopted session is left deaf.
 *
 * Also installs the broker's adopter (security review F1): a pty-host this
 * backend becomes the owner of LATER — a start that finds one running, after
 * a boot connect timed out — has its sessions adopted the same way, their
 * 'crash' stamps undone, before any of its events flow.
 */
export async function bootSessions(opts: {
  broker: PtyHostBroker;
  history: SessionHistory;
  sessions: SessionManager;
  resetSessionArtifacts: (keep: ReadonlySet<string>) => void;
  /** Q17: judges the previous run's end from the crash stamps this load makes. */
  previousExit: PreviousExit;
  log: Logger;
}): Promise<void> {
  const { broker, history, sessions, log } = opts;
  broker.setAdopter(async (entries) => {
    // Q17: those sessions are alive after all — not a crash to tell about.
    opts.previousExit.reopened(history.reopen(new Set(entries.map((e) => e.id))));
    await sessions.adopt(entries);
  });
  try {
    let entries: PtyEntrySummary[] = [];
    try {
      entries = await broker.connectExisting();
    } catch (err) {
      log('error', `re-attaching to the pty-host failed: ${describeError(err)}`);
    }
    // Always, whatever the pty-host said: the history must be loaded before
    // anything writes it.
    const live = new Set(entries.map((e) => e.id));
    const stamps = history.load({ live });
    // Q17 (.claude/plans/quality/PLAN-Q17.md § P1 2): what stopped the run
    // before this one. A `crash` has no time of its own: the previous run's
    // last history write, else the boot itself.
    opts.previousExit.judge(stamps.crashed, stamps.writtenAt ?? new Date().toISOString());
    opts.resetSessionArtifacts(live);
    await sessions.adopt(entries);
  } catch (err) {
    log('error', `adopting the pty-host's sessions failed: ${describeError(err)}`);
  } finally {
    broker.release();
  }
}
