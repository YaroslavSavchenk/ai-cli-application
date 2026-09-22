/**
 * The pane's "Background agents" table (part A3; the v3 markup at
 * `design/session-manager/session-manager-v3.html`, pane area).
 *
 * A dot, a mono name, the task it is on, how long it has run and how many
 * tokens it spent — one line per agent, under the status bar, inside the
 * terminal card.
 *
 * WHERE THE ROWS COME FROM (part B7, `.claude/plans/nocturne/PLAN-B7.md`):
 * `SessionInfo.agents` — the subagents Claude Code ran for this session, read
 * by the server from that session's own transcripts and already ordered and
 * capped there. `ui/pane-agents-model.ts` turns them into the rows below;
 * nothing here reads state, a session or the clock.
 *
 * THE COUNT LINE (B11). The server sends at most four running rows and one
 * finished row; the agents beyond them are counted under the rows as two
 * separate words on one quiet line — `+2 working`, `+10 finished` — never as
 * rows, never with a separator glyph between them (copy rule), and a count of
 * 0 is simply not there.
 *
 * NEVER EMPTY. With no rows and no count `renderAgents` returns `null` and the
 * caller renders nothing — exactly like the reference, which hides the block
 * when there are no agents. Sample rows exist only in a screenshot session,
 * never in the shipped UI.
 */
import { el } from './util.ts';

/**
 * The dot's meaning, on the same three-colour vocabulary as a session — the
 * PANE's vocabulary, which is why `attention` stays here. B7 never emits it:
 * a subagent asks the user nothing, so no row is ever waiting on them.
 */
export type AgentTone = 'running' | 'attention' | 'finished';

export interface AgentRow {
  /** The agent's own name, rendered mono (it is an identifier). */
  name: string;
  /** What it is doing, in plain words. */
  task: string;
  /** Preformatted running time, e.g. `2m 10s`. */
  time: string;
  /** Preformatted token count, e.g. `12.4k`. */
  tokens: string;
  dot: AgentTone;
}

/** What `agentTable` (ui/pane-agents-model.ts) hands the renderer. */
export interface AgentTable {
  rows: AgentRow[];
  /** Running agents beyond the rows; 0 = not drawn. */
  moreWorking: number;
  /** Finished agents beyond the rows; 0 = not drawn. */
  moreFinished: number;
}

/**
 * The table, or `null` when there is nothing to show. The caller mounts the
 * node as-is; nothing here reads state or the clock.
 */
export function renderAgents(table: AgentTable): HTMLElement | null {
  const { rows, moreWorking, moreFinished } = table;
  if (rows.length === 0 && moreWorking <= 0 && moreFinished <= 0) return null;

  const box = el('div', 'pane-agents');
  const head = el('div', 'pane-agents-hd');
  head.append(el('span', '', 'Background agents'), el('span', '', 'Tokens'));
  box.append(head);

  for (const r of rows) {
    const row = el('div', 'pane-agent');
    const dot = el('span', `pane-agent-dot is-${r.dot}`);
    dot.setAttribute('aria-hidden', 'true');
    row.append(
      dot,
      el('span', 'pane-agent-name', r.name),
      el('span', 'pane-agent-task', r.task),
      el('span', 'pane-agent-time', r.time),
      el('span', 'pane-agent-tokens', r.tokens),
    );
    box.append(row);
  }

  if (moreWorking > 0 || moreFinished > 0) {
    const more = el('div', 'pane-agents-more');
    if (moreWorking > 0) more.append(el('span', 'pane-agents-more-n is-working', `+${moreWorking} working`));
    if (moreFinished > 0) more.append(el('span', 'pane-agents-more-n', `+${moreFinished} finished`));
    box.append(more);
  }
  return box;
}
