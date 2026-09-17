/**
 * The pane status bar's MODEL — the thin strip of label + mono value pairs
 * that Nocturne draws under each terminal (part A3;
 * `design_handoff_session_manager/README-v3.md`, "Pane").
 *
 * DOM-free and clock-free (the caller passes `now`), so `node:test` can import
 * it and part B1 can extend it without touching the renderer.
 *
 * TWO PLACES, ONE CHECKLIST (part B1). Settings → Status bar drives both
 * Claude Code's own line INSIDE the terminal (`cfg.enabled`, drawn by
 * server/statusline.mjs) and this bar UNDER it (`cfg.paneBar`); every item
 * toggle below is the same toggle the script reads. With both switches on the
 * same values stand twice — the user's accepted consequence
 * (`.claude/PLAN-B1.md`), not a bug to route around here.
 *
 * HONESTY RULE — the strip only ever states what the app already knows, which
 * since B1 means two sources and no third:
 *   - the bar exists for the known agent only (`isClaudeCommand`); a plain
 *     shell or a custom command gets NO bar at all, not an empty strip;
 *   - the session's own ARGV: `Mode` (`permFromArgs`), and `Model`
 *     (`modelFromArgs`) whenever Claude has not reported one itself. Omitted
 *     when the argv names neither — the CLI then uses whatever it is
 *     configured to use, which is not something this UI may claim to know;
 *   - what CLAUDE CODE REPORTED for this session (`SessionInfo.telemetry`,
 *     the status-line payload by way of server/telemetry.ts): `Model`,
 *     `Branch`, `Cost`, `Context`, `Usage`, `Changed`. A reported model beats
 *     the argv guess — the argv says what was ASKED for, the payload says what
 *     is answering. Every one of them is absent until the payload carried a
 *     real value: no zeroes standing in for unknowns, no placeholders. A
 *     session that has not replied yet simply shows fewer items;
 *   - `Time` is how long this PTY has been alive (`SessionInfo.createdAt`),
 *     so it exists only while it IS alive: an exited session carries no end
 *     time in `SessionInfo`, and a counter that kept running after the exit
 *     would state an age this app cannot know. The rest of an exited session's
 *     telemetry STAYS — what it cost is still true after it ended.
 *
 * NOT here, on purpose: `Active skill`. The v3 mock draws it; no payload,
 * hook or file reports it (user decision, 2026-09-16), so it has no row and no
 * placeholder at all.
 */
import type { SessionInfo, SessionTelemetry } from '../../../shared/protocol.ts';
import { isClaudeCommand, modelLabel } from './launch-args.ts';
import type { StatusLineCfg } from './statusline-model.ts';
import { fmtUptime, modelFromArgs, permFromArgs } from './util.ts';

/** How a value reads: plain data, a window running out, or a removed safety net. */
export type StatusTone = 'neutral' | 'warn' | 'danger';

/** One `label value` pair of the bar. `k` is the label, `v` the mono value. */
export interface PaneStatusItem {
  k: string;
  v: string;
  tone: StatusTone;
}

/** At and above this percentage an account window reads amber, not neutral. */
const USAGE_WARN_PCT = 80;

/**
 * A reported number, or null. Telemetry is sanitised server-side, but it began
 * life in a file written by another process: a value that is not a finite
 * number is not a value, and the bar says nothing rather than `NaN%`.
 */
function num(v: number | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** A reported string, or null — same reasoning; an empty label is not a value. */
function str(v: string | undefined): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

/**
 * The items a pane's status bar renders for `session`, in display order (the
 * v3 mock's order). An empty array means: draw no bar (not: draw an empty one).
 *
 * `cfg` is the shared checklist (`getStatusLine()`); `cfg.paneBar` off means
 * the user wants this bar gone, so nothing at all is produced.
 */
export function paneStatusItems(
  session: SessionInfo | undefined,
  cfg: StatusLineCfg,
  now: number = Date.now(),
): PaneStatusItem[] {
  if (session === undefined || !isClaudeCommand(session.command)) return [];
  if (!cfg.paneBar) return [];
  const items: PaneStatusItem[] = [];
  const t: SessionTelemetry | undefined = session.telemetry;

  if (cfg.model) {
    // What Claude reports beats the argv guess: the argv says what was asked
    // for (and often says nothing), the payload says what is answering.
    const reported = str(t?.model);
    if (reported !== null) items.push({ k: 'Model', v: reported, tone: 'neutral' });
    else {
      const model = modelFromArgs(session.args);
      if (model !== null) items.push({ k: 'Model', v: modelLabel(model), tone: 'neutral' });
    }
  }

  if (cfg.mode) {
    // Argv only — the payload carries no permission mode.
    const perm = permFromArgs(session.args);
    if (perm !== null) {
      items.push({ k: 'Mode', v: perm.label, tone: perm.danger ? 'danger' : 'neutral' });
    }
  }

  if (cfg.branch) {
    const branch = str(t?.branch);
    if (branch !== null) items.push({ k: 'Branch', v: branch, tone: 'neutral' });
  }

  if (cfg.cost) {
    // Zero is what a session costs before its first reply, and "$0.00" would
    // read as a measurement rather than as the absence of one.
    const cost = num(t?.costUsd);
    if (cost !== null && cost > 0) {
      items.push({ k: 'Cost', v: `$${cost.toFixed(2)}`, tone: 'neutral' });
    }
  }

  if (cfg.context) {
    const ctx = num(t?.contextPct);
    if (ctx !== null) items.push({ k: 'Context', v: `${ctx}%`, tone: 'neutral' });
  }

  if (cfg.usage) {
    // The two account windows, whichever of them the payload carried. The tone
    // follows the window shown FIRST — the 5h one is the one that bites first.
    const h5 = num(t?.usage5hPct);
    const d7 = num(t?.usage7dPct);
    const lead = h5 ?? d7;
    if (lead !== null) {
      const parts: string[] = [];
      if (h5 !== null) parts.push(`${h5}% of 5h`);
      if (d7 !== null) parts.push(`${d7}% of 7d`);
      items.push({
        k: 'Usage',
        // A comma, not the v3 mock's middle dot: decorative separators are out
        // of the chrome's copy (A2, README-v3 — the rule tests/ui-copy-separators
        // enforces), and two windows read as a list either way.
        v: parts.join(', '),
        tone: lead >= USAGE_WARN_PCT ? 'warn' : 'neutral',
      });
    }
  }

  if (cfg.time && session.status !== 'exited') {
    const time = fmtUptime(session.createdAt, now);
    if (time !== '—') items.push({ k: 'Time', v: time, tone: 'neutral' });
  }

  if (cfg.lines) {
    // A pair the payload reports as 0/0 is a session that changed nothing, not
    // a session whose changes are unknown — either way there is nothing to say.
    const added = num(t?.linesAdded) ?? 0;
    const removed = num(t?.linesRemoved) ?? 0;
    if (added > 0 || removed > 0) {
      items.push({ k: 'Changed', v: `+${added} -${removed}`, tone: 'neutral' });
    }
  }

  return items;
}
