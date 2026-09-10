/**
 * The pane status bar's MODEL — the thin strip of label + mono value pairs
 * that Nocturne draws under each terminal (part A3;
 * `design_handoff_session_manager/README-v3.md`, "Pane").
 *
 * DOM-free and clock-free (the caller passes `now`), so `node:test` can import
 * it and part B1 can extend it without touching the renderer.
 *
 * HONESTY RULE — the strip only ever states what the app already knows:
 *   - the bar exists for the known agent only (`isClaudeCommand`); a plain
 *     shell or a custom command gets NO bar at all, not an empty strip;
 *   - `Model` and `Mode` are read from the session's own argv, exactly like
 *     the Legacy pane tags did (`modelFromArgs` / `permFromArgs`), and are
 *     omitted when the argv names neither — the CLI then uses whatever it is
 *     configured to use, which is not something this UI may claim to know;
 *   - `Time` is how long this PTY has been alive (`SessionInfo.createdAt`),
 *     so it exists only while it IS alive: an exited session carries no end
 *     time in `SessionInfo`, and a counter that kept running after the exit
 *     would state an age this app cannot know.
 *
 * NOT here, on purpose: Branch, Cost, Context, Usage, Skill, Changed. Their
 * data sources are open decision #2 of `.claude/PLAN-NOCTURNE.md` (part B1);
 * a placeholder value would be a lie with a label on it.
 */
import type { SessionInfo } from '../../../shared/protocol.ts';
import { isClaudeCommand } from './launch-args.ts';
import { fmtUptime, modelFromArgs, permFromArgs } from './util.ts';

/** How a value reads: plain data, or a mode that removes a safety net. */
export type StatusTone = 'neutral' | 'danger';

/** One `label value` pair of the bar. `k` is the label, `v` the mono value. */
export interface PaneStatusItem {
  k: string;
  v: string;
  tone: StatusTone;
}

/**
 * The items a pane's status bar renders for `session`, in display order.
 * An empty array means: draw no bar (not: draw an empty one).
 */
export function paneStatusItems(
  session: SessionInfo | undefined,
  now: number = Date.now(),
): PaneStatusItem[] {
  if (session === undefined || !isClaudeCommand(session.command)) return [];
  const items: PaneStatusItem[] = [];

  const model = modelFromArgs(session.args);
  if (model !== null) items.push({ k: 'Model', v: model, tone: 'neutral' });

  const perm = permFromArgs(session.args);
  if (perm !== null) {
    items.push({ k: 'Mode', v: perm.label, tone: perm.danger ? 'danger' : 'neutral' });
  }

  if (session.status !== 'exited') {
    const time = fmtUptime(session.createdAt, now);
    if (time !== '—') items.push({ k: 'Time', v: time, tone: 'neutral' });
  }

  return items;
}
