/**
 * The pure half of server/agents.ts: what one transcript LINE means. The
 * sanitisers every sourced string and number passes through (isoAt,
 * tokenField, …; clean and plainObject are server/sanitise.ts's since Q1),
 * the per-agent fold (foldLine), the wire comparisons
 * (sameAgents, sameReport) and the B11 turn verdict (turnOfLine). No I/O.
 *
 * Split from server/agents.ts (PLAN-RESTRUCTURE O8, 2026-09-23), moved
 * byte-exact; server/agents.ts re-exports what was public. Sibling pieces:
 * server/agents.ts (AgentsWatcher: the poll, the bounded reads, the rows) and
 * server/agents-path.ts (the transcript-path boundary, subagentsDirFor).
 */
import type { SessionAgent, SessionAgentCounts, SessionTurn } from '../shared/protocol.ts';
import { MAX_AT_MS, plainObject } from './sanitise.ts';


/**
 * Token counts above this are corruption, not spend (the largest real figure
 * measured is ~12.5 M for a 15-minute agent). Clamped rather than refused: the
 * row is still worth drawing.
 */
const MAX_TOKENS = 1e12;

/**
 * A transcript timestamp as a canonical ISO-8601 string, or '' when the line
 * did not carry one we believe. Re-formatted through Date rather than passed
 * through: the raw string came out of an untrusted file and goes to the DOM,
 * and `new Date(x).toISOString()` cannot produce anything but an ISO stamp.
 */
function isoAt(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) return '';
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || ms < 0 || ms > MAX_AT_MS) return '';
  return new Date(ms).toISOString();
}

/** A ms epoch as ISO-8601, clamped into the range isoAt believes. */
export function isoOf(ms: number): string {
  const safe = Number.isFinite(ms) && ms >= 0 && ms <= MAX_AT_MS ? ms : 0;
  return new Date(safe).toISOString();
}

/** One usage figure: a finite integer >= 0, clamped. Anything else is 0. */
function tokenField(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Math.floor(value), MAX_TOKENS);
}

// ---------------------------------------------------------------------------
// The fold: one transcript line at a time
// ---------------------------------------------------------------------------

/** What one agent's transcript has said so far. Built only by foldLine(). */
export interface AgentFold {
  /** ISO-8601 of the first line that carried a timestamp; '' while there is none. */
  firstAt: string;
  /** ISO-8601 of the most recent line that carried one; '' while there is none. */
  lastAt: string;
  /** Sum over UNIQUE `message.id`s of the four usage figures. */
  tokens: number;
  /**
   * The last `message.id` counted. Claude Code writes one API message as
   * several CONSECUTIVE lines (one per content block) repeating the same
   * usage, so remembering the previous id is enough to count it once — a Set
   * would grow without bound over a 1.4 MB transcript for no extra accuracy.
   */
  seenId: string | undefined;
  /** True when the last `user`/`assistant` line was an assistant `end_turn`. */
  finished: boolean;
  /** ISO-8601 of the line that ended it; '' while it is running. */
  endedAt: string;
}

/** A fold that has read nothing. Exported so tests (and a reset) can start one. */
export function newFold(): AgentFold {
  return { firstAt: '', lastAt: '', tokens: 0, seenId: undefined, finished: false, endedAt: '' };
}

/**
 * Fold one transcript line into `acc`. Exported for tests; total, never throws.
 *
 * A line that is not JSON, not an object, or carries nothing we know is simply
 * ignored — a transcript is appended to WHILE we read it, so a torn line is
 * ordinary, not an error (the watcher's carry usually completes it on the next
 * poll, and the offset never rewinds past what we parsed).
 */
export function foldLine(acc: AgentFold, line: string): void {
  if (typeof line !== 'string' || line.length === 0) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return; // A torn line, or never JSON at all.
  }
  const raw = plainObject(parsed);
  if (raw === undefined) return;

  const at = isoAt(raw['timestamp']);
  if (at !== '') {
    if (acc.firstAt === '') acc.firstAt = at;
    acc.lastAt = at;
  }

  const type = raw['type'];
  if (type === 'user') {
    // The orchestrator resumed the agent through SendMessage: it is working
    // again, whatever the last assistant line said.
    acc.finished = false;
    acc.endedAt = '';
    return;
  }
  if (type !== 'assistant') return; // attachment, system, … say nothing about state.

  const message = plainObject(raw['message']);
  if (message === undefined) return;

  const id = typeof message['id'] === 'string' ? message['id'] : '';
  if (id !== acc.seenId) {
    acc.seenId = id;
    const usage = plainObject(message['usage']);
    if (usage !== undefined) {
      const sum =
        tokenField(usage['input_tokens']) +
        tokenField(usage['cache_creation_input_tokens']) +
        tokenField(usage['cache_read_input_tokens']) +
        tokenField(usage['output_tokens']);
      acc.tokens = Math.min(acc.tokens + sum, MAX_TOKENS);
    }
    // No usage object at all adds nothing — a real 0, not a guess.
  }

  const ended = message['stop_reason'] === 'end_turn';
  acc.finished = ended;
  acc.endedAt = ended ? (at !== '' ? at : acc.lastAt) : '';
}

// ---------------------------------------------------------------------------
// The wire: comparing two lists
// ---------------------------------------------------------------------------

/**
 * Field-wise equality over the whole SessionAgent schema — what decides
 * whether a session's agent list actually CHANGED and therefore whether every
 * attached client gets an `info` broadcast. Order counts: the running/finished
 * ordering is part of what the table shows.
 */
export function sameAgents(a: SessionAgent[] | undefined, b: SessionAgent[] | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as SessionAgent;
    const y = b[i] as SessionAgent;
    if (
      x.id !== y.id ||
      x.name !== y.name ||
      x.task !== y.task ||
      x.startedAt !== y.startedAt ||
      x.endedAt !== y.endedAt ||
      x.tokens !== y.tokens ||
      x.state !== y.state
    ) {
      return false;
    }
  }
  return true;
}

/** What the watcher hands to its consumer for one session (B11). */
export interface AgentsReport {
  agents: SessionAgent[];
  counts: SessionAgentCounts;
  /** Absent = unknown. */
  turn?: SessionTurn;
}

/** Field-wise equality of two reports: the rows (in order), the counts, the turn. */
export function sameReport(a: AgentsReport | undefined, b: AgentsReport | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return (
    a.turn === b.turn &&
    a.counts.running === b.counts.running &&
    a.counts.finished === b.counts.finished &&
    sameAgents(a.agents, b.agents)
  );
}

// ---------------------------------------------------------------------------
// The turn: the session's own transcript, one line at a time (B11)
// ---------------------------------------------------------------------------

/**
 * A `user` line whose text starts with one of these is a LOCAL slash command
 * (`/model`, `/clear`, …) or its output: it starts no turn, so it does not
 * count. A skill command's own work shows up in the lines after it.
 */
const LOCAL_COMMAND_PREFIXES = [
  '<command-name>',
  '<command-message>',
  '<local-command-stdout>',
  '<local-command-stderr>',
  '<local-command-caveat>',
];

/** What Claude Code writes as the user's line when Esc interrupts a turn. */
const INTERRUPT_PREFIX = '[Request interrupted by user';

/** Stop reasons that END a turn: Claude waits for input after them. */
const TURN_ENDING_STOPS = new Set(['end_turn', 'stop_sequence', 'refusal', 'max_tokens']);

/** A user message's text: the string content, or the first text block's text; '' when none. */
function userText(message: Record<string, unknown> | undefined): string {
  if (message === undefined) return '';
  const content = message['content'];
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  for (const block of content) {
    const b = plainObject(block);
    if (b !== undefined && b['type'] === 'text') {
      return typeof b['text'] === 'string' ? b['text'] : '';
    }
  }
  return '';
}

/**
 * One transcript line's turn verdict; undefined = the line does not count.
 * Total, never throws. The rules (PLAN-B11 § The turn rule, measured on this
 * machine's transcripts 2026-09-22, Claude Code 2.1.27x):
 *   - not JSON, `type` not user/assistant, `isMeta: true`, `isSidechain: true`
 *     → does not count;
 *   - `user` starting with a local-command tag → does not count;
 *   - `user` starting with `[Request interrupted by user` → 'waiting';
 *   - any other `user` (a prompt, a tool_result, a task-notification) → 'working';
 *   - `assistant` that is an API error or `<synthetic>`, or whose stop reason
 *     ends a turn → 'waiting'; any other (`tool_use`, `pause_turn`, null) →
 *     'working'.
 *
 * KNOWN LIMIT: Claude Code's permission prompt writes nothing to the
 * transcript (the last line is the assistant's `tool_use`), so a session
 * waiting on one reads 'working' — the BEL (`attention`) is what says "needs
 * your answer" then. An orchestrating session that ended its turn while its
 * background agents still run reads 'waiting', which is true: the user can
 * type. No stale rule: a long tool call is still working.
 */
export function turnOfLine(line: string): SessionTurn | undefined {
  if (typeof line !== 'string' || line.length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  const raw = plainObject(parsed);
  if (raw === undefined) return undefined;
  if (raw['isMeta'] === true || raw['isSidechain'] === true) return undefined;
  const message = plainObject(raw['message']);
  const type = raw['type'];
  if (type === 'user') {
    const text = userText(message);
    if (LOCAL_COMMAND_PREFIXES.some((prefix) => text.startsWith(prefix))) return undefined;
    if (text.startsWith(INTERRUPT_PREFIX)) return 'waiting';
    return 'working';
  }
  if (type !== 'assistant') return undefined;
  if (raw['isApiErrorMessage'] === true) return 'waiting';
  if (message === undefined) return 'working';
  if (message['model'] === '<synthetic>') return 'waiting';
  const stop = message['stop_reason'];
  return typeof stop === 'string' && TURN_ENDING_STOPS.has(stop) ? 'waiting' : 'working';
}
