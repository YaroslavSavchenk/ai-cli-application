/**
 * THE SESSION VERDICT — what `SessionInfo.turn` says (Nocturne C2,
 * .claude/plans/nocturne/PLAN-C2.md § The rule 4 and § Fix after the DEV
 * check): the session transcript's fold (server/agents-fold.ts), the subagent
 * rows, the session's terminal title and the liveness of the background work
 * the turn left open. Pure: the clock, the title stamp and the one I/O (the
 * workflow directories) come in as arguments.
 *
 * Also the one home of STALE_MS, the liveness clock that both B7's rows
 * (server/agents.ts #row) and this verdict read.
 *
 * Split from server/agents.ts by topic (2026-09-27, the C2 DEV-check fix: the
 * title rule would have pushed that module past 1 000 lines). Sibling pieces:
 * server/agents.ts (AgentsWatcher — the only caller), server/agents-fold.ts
 * (TurnFold), server/agents-workflows.ts (the workflow check the caller passes
 * in) and server/agents-path.ts (the transcript-path boundary).
 */
import type { SessionAgent, SessionTurn } from '../shared/protocol.ts';
import type { TurnFold } from './agents-fold.ts';

/**
 * A running agent whose transcript has not been touched for this long is shown
 * finished. A killed agent (TaskStop, a usage-limit abort) leaves no end
 * marker at all, so without this rule its dot would spin forever. 15 minutes
 * is above the longest single tool call Claude Code allows (10 minutes), so a
 * live agent waiting on one is never declared dead.
 */
export const STALE_MS = 15 * 60 * 1000;

/**
 * C2: a launched subagent whose row FINISHED less than this long ago (by its
 * own end stamp) still counts as alive — its task notification lands a moment
 * after its last line, and without this the turn would read 'waiting' for the
 * poll in between (a mascot flash). A killed agent that never notifies costs
 * only this much.
 */
const FINISH_GRACE_MS = 10_000;

/**
 * C2 DEV-check fix: how long the terminal title must have been idle — and the
 * transcript must have said the turn runs — before that turn reads as Claude
 * waiting for the user. At a turn's END Claude Code turns the title idle a
 * moment before it writes the `end_turn` line; at a turn's START (a prompt, a
 * task notification) the transcript line can land before the spinner title.
 * Both lags are absorbed, so neither flashes a mascot.
 */
const TITLE_IDLE_MS = 3_000;

/** What the verdict is made of, for one session at one poll. */
export interface VerdictInput {
  /** The session transcript's fold: the main verdict, a question, the open launches. */
  fold: TurnFold;
  /** Every running subagent row (not only the ones on the wire). */
  running: readonly SessionAgent[];
  /** Every finished subagent row. */
  finished: readonly SessionAgent[];
  now: number;
  /**
   * When the session's terminal title last turned idle (`✳ …`, Claude Code's
   * own idle mark), on the same clock as `now`; undefined while it is not
   * idle, or when nothing is known about it.
   */
  titleIdleSince: number | undefined;
  /**
   * When the transcript's verdict last turned 'working' (the watcher's stamp,
   * on the same clock); undefined if it never has. Read only while it is
   * 'working'. The idle title is aged from the LATER of the two stamps: a
   * title idle for minutes says nothing about a turn that started a second ago.
   */
  workingSince: number | undefined;
  /**
   * Whether any of these workflow runs shows life by its directory — the one
   * I/O, passed in. Called last, and only when nothing cheaper said alive.
   */
  workflowsAlive: (runIds: readonly string[]) => boolean;
}

/**
 * The session verdict:
 *   - the transcript says the turn RUNS ('working'), but the terminal title
 *     has been idle for TITLE_IDLE_MS or more, counted from when the turn
 *     started if that is later (workingSince) → 'waiting': Claude waits for
 *     the user — a question, a plan to approve or a permission prompt (user,
 *     2026-09-27: all three count). Claude Code 2.1.283 writes a question's
 *     `tool_use` line only AFTER the answer, and a permission prompt writes
 *     nothing, so the title is the only live sign. Like a question it beats
 *     open background work;
 *   - the transcript says the turn ENDED ('waiting', not a question) → still
 *     'working' while at least one launch it left open is alive: launched
 *     less than STALE_MS ago, or
 *       - a subagent whose row is running (not finished, not stale — the rule
 *         B7's rows are drawn by), or whose row finished less than
 *         FINISH_GRACE_MS ago (justFinished),
 *       - a workflow run with an agent transcript written less than STALE_MS
 *         ago (workflowsAlive);
 *   - otherwise the transcript's verdict as it is, unknown included: a
 *     session without a transcript verdict gets none from its title.
 */
export function sessionTurn(input: VerdictInput): SessionTurn | undefined {
  const { fold, running, finished, now, titleIdleSince, workingSince } = input;
  const { turn, asking, launches } = fold;
  if (turn === 'working') {
    if (titleIdleSince === undefined) return 'working';
    const idleFrom = Math.max(titleIdleSince, workingSince ?? titleIdleSince);
    return now - idleFrom >= TITLE_IDLE_MS ? 'waiting' : 'working';
  }
  if (turn !== 'waiting' || asking || launches.size === 0) return turn;
  const runs: string[] = [];
  for (const launch of launches.values()) {
    if (now - launch.atMs < STALE_MS) return 'working';
    if (
      launch.kind === 'agent' &&
      launch.ref !== '' &&
      (running.some((row) => row.id === launch.ref) ||
        finished.some((row) => row.id === launch.ref && justFinished(row, now)))
    ) {
      return 'working';
    }
    if (launch.kind === 'workflow' && launch.ref !== '') runs.push(launch.ref);
  }
  if (runs.length === 0) return 'waiting';
  return input.workflowsAlive(runs) ? 'working' : 'waiting';
}

/**
 * A finished row whose own end stamp is less than FINISH_GRACE_MS old (C2).
 * A stamp AHEAD of the clock gets no grace: it was written before we read it,
 * so only a planted date can be ahead, and it must not hold 'working' forever.
 */
function justFinished(row: SessionAgent, now: number): boolean {
  const age = now - Date.parse(row.endedAt ?? '');
  return age >= 0 && age < FINISH_GRACE_MS;
}
