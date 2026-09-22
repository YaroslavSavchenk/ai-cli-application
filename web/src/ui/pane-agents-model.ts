/**
 * The "Background agents" table's MODEL — the rows `renderAgents` draws under
 * a Claude session's status bar (part B7; `.claude/plans/nocturne/PLAN-B7.md`).
 *
 * DOM-free and clock-free (the caller passes `now`), like
 * `pane-status-model.ts`, so `node:test` imports it directly.
 *
 * WHERE THE ROWS COME FROM. `SessionInfo.agents` — the subagents Claude Code
 * ran for this session, read by `server/agents.ts` from that session's own
 * transcripts. The server ORDERS and CAPS the list (running first, oldest
 * first; then at most three finished, newest first; at most eight rows), so
 * this module never sorts, never filters and never trims: what arrives is
 * what is drawn, in that order.
 *
 * THE SAME HONESTY RULE the status bar follows:
 *   - the table exists for the known agent only (`isClaudeCommand`) — nothing
 *     this app knows describes another tool's agents, so a shell or a Codex
 *     session gets NO table, not an empty one;
 *   - a session without agents yields no rows, and the renderer answers `null`
 *     for an empty list: the block is ABSENT, never blank (the A3 rule);
 *   - a time this app cannot compute reads `0s`, never `NaN` — an unparseable
 *     or negative span is a clock that disagrees with itself, not a duration.
 *
 * TIME IS FORMATTED HERE, not on the server: a running agent's time moves on
 * the pane's own 15 s tick (`STATUS_TICK_MS` in `ui/panes.ts`), with no server
 * message per second. A finished agent's time is the span it RAN
 * (`endedAt - startedAt`) and stands still — what it took is still true after
 * it ended.
 *
 * NEVER 'attention' (B7): a subagent asks the user nothing, so no row can be
 * waiting on them. The tone stays in `AgentTone` because the vocabulary is the
 * pane's, not this table's.
 */
import type { SessionAgent, SessionInfo } from '../../../shared/protocol.ts';
import type { AgentRow } from './pane-agents.ts';
import { isClaudeCommand } from './launch-args.ts';

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** `1` -> `01`, so the second unit of a two-unit time is a fixed width. */
function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * A span in milliseconds, in the table's vocabulary: `0s` · `42s` · `2m 10s` ·
 * `1h 05m` · `3d 02h` — two units at most, the larger one first, the smaller
 * one zero-padded so a column of times keeps its shape.
 *
 * Anything that is not a real span (NaN from an unparseable timestamp, a
 * negative one from clock skew) reads `0s`: the row is there, and a duration
 * this app cannot compute is not shown as one.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  const s = Math.floor(ms / 1000);
  if (s < MINUTE) return `${s}s`;
  if (s < HOUR) return `${Math.floor(s / MINUTE)}m ${pad2(s % MINUTE)}s`;
  if (s < DAY) return `${Math.floor(s / HOUR)}h ${pad2(Math.floor((s % HOUR) / MINUTE))}m`;
  return `${Math.floor(s / DAY)}d ${pad2(Math.floor((s % DAY) / HOUR))}h`;
}

/** `12.4` -> `12.4k`, `12.0` -> `12k`: a trailing `.0` is noise in a column. */
function scaled(n: number, div: number, unit: string): string {
  const v = Math.round((n / div) * 10) / 10;
  return `${v % 1 === 0 ? v.toFixed(0) : v.toFixed(1)}${unit}`;
}

/**
 * A token count in 56px: `999` · `12.4k` · `1.2M` — one decimal, no trailing
 * `.0`. The thresholds are where the ROUNDED figure would change unit, so
 * `999950` reads `1M` and never `1000.0k`.
 *
 * A count that is not a finite number ≥ 0 reads `0` (the server sanitises, but
 * the number began life in a file another process wrote).
 */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1000) return String(Math.floor(n));
  if (n < 999_950) return scaled(n, 1000, 'k');
  return scaled(n, 1_000_000, 'M');
}

/** One agent's row: its own time, its own tokens, everything else as it came. */
function row(a: SessionAgent, now: number): AgentRow {
  const started = Date.parse(a.startedAt);
  const span =
    a.state === 'running' ? now - started : Date.parse(a.endedAt ?? '') - started;
  return {
    name: a.name,
    task: a.task,
    time: formatDuration(span),
    tokens: formatTokens(a.tokens),
    dot: a.state === 'running' ? 'running' : 'finished',
  };
}

/**
 * The rows `renderAgents` draws for `session`, in the server's order. An empty
 * array means: draw no table (not: draw an empty one) — no session, not the
 * known agent, or no subagent has started yet.
 */
export function agentRows(session: SessionInfo | undefined, now: number = Date.now()): AgentRow[] {
  if (session === undefined || !isClaudeCommand(session.command)) return [];
  const agents = session.agents;
  if (agents === undefined || agents.length === 0) return [];
  return agents.map((a) => row(a, now));
}
