/**
 * The pane's "Background agents" table (part A3; the v3 markup at
 * `design_handoff_session_manager/session-manager-v3.html`, pane area).
 *
 * A dot, a mono name, the task it is on, how long it has run and how many
 * tokens it spent — one line per agent, under the status bar, inside the
 * terminal card.
 *
 * A3 SHIPS IT EMPTY. Nothing in this app knows about background agents yet:
 * their data source is open decision #7 of `.claude/PLAN-NOCTURNE.md` (part
 * B7). `renderAgents([])` returns `null` and the caller renders nothing —
 * exactly like the reference, which hides the block when there are no agents.
 * Sample rows exist only in a screenshot session, never in the shipped UI.
 */
import { el } from './util.ts';

/** The dot's meaning, on the same three-colour vocabulary as a session. */
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

/**
 * The table, or `null` when there is nothing to show. The caller mounts the
 * node as-is; nothing here reads state or the clock.
 */
export function renderAgents(rows: AgentRow[]): HTMLElement | null {
  if (rows.length === 0) return null;

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
  return box;
}
