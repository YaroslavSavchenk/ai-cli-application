/**
 * The pure half of server/agents.ts: what one transcript LINE means. The
 * sanitisers every sourced string and number passes through (isoAt,
 * tokenField, …; clean and plainObject are server/sanitise.ts's since Q1),
 * the per-agent fold (foldLine), the wire comparisons
 * (sameAgents, sameReport), the B11 turn verdict (turnOfLine) and — Nocturne
 * C2 (.claude/plans/nocturne/PLAN-C2.md) — the session transcript's fold
 * around it (foldTurnLine: the question flag and the background launches
 * that have not reported back). No I/O: the watcher passes the clock in.
 *
 * Split from server/agents.ts (PLAN-RESTRUCTURE O8, 2026-09-23), moved
 * byte-exact; server/agents.ts re-exports what was public. Sibling pieces:
 * server/agents.ts (AgentsWatcher: the poll, the bounded reads, the rows, the
 * session verdict), server/agents-path.ts (the transcript-path boundary,
 * subagentsDirFor) and server/agents-workflows.ts (C2: a workflow run's
 * liveness from its directory).
 */
import type { SessionAgent, SessionAgentCounts, SessionTurn } from '../shared/protocol.ts';
import { MAX_AT_MS, plainObject } from './sanitise.ts';


/**
 * Token counts above this are corruption, not spend (the largest real figure
 * measured is ~12.5 M for a 15-minute agent). Clamped rather than refused: the
 * row is still worth drawing.
 */
const MAX_TOKENS = 1e12;

/** A transcript timestamp as a ms epoch, or undefined when the line did not carry one we believe. */
function msAt(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) return undefined;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || ms < 0 || ms > MAX_AT_MS) return undefined;
  return ms;
}

/**
 * A transcript timestamp as a canonical ISO-8601 string, or '' when the line
 * did not carry one we believe. Re-formatted through Date rather than passed
 * through: the raw string came out of an untrusted file and goes to the DOM,
 * and `new Date(x).toISOString()` cannot produce anything but an ISO stamp.
 */
function isoAt(value: unknown): string {
  const ms = msAt(value);
  return ms === undefined ? '' : new Date(ms).toISOString();
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
// The turn: the session's own transcript, one line at a time (B11, C2)
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

/**
 * C2 decision 1 (user, 2026-09-26): the tools with which Claude ASKS the user
 * something — a multiple-choice question, a plan to approve. Measured
 * 2026-09-26 (77 questions in this machine's transcripts): the question's
 * `tool_use` line is followed by nothing but metadata until the answer, the
 * `tool_result` of the next `user` line — also in the 3 messages that made
 * another tool call beside the question (the question came last in each), so
 * the last counting line is enough and no question id needs remembering.
 */
const QUESTION_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);

/** The first text of a message's `content`: the string itself, or the first text block's; '' when none. */
function textOf(content: unknown): string {
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

/** The content blocks of a message that is an array of them; [] otherwise. */
function blocksOf(message: Record<string, unknown> | undefined): Record<string, unknown>[] {
  const content = message?.['content'];
  if (!Array.isArray(content)) return [];
  const blocks: Record<string, unknown>[] = [];
  for (const block of content) {
    const b = plainObject(block);
    if (b !== undefined) blocks.push(b);
  }
  return blocks;
}

/** A line's own verdict: the B11 turn, or 'asking' — waiting, because Claude asked the user (C2). */
type LineTurn = SessionTurn | 'asking';

/**
 * One transcript line's turn verdict; undefined = the line does not count.
 * Total, never throws. The rules (PLAN-B11 § The turn rule, measured on this
 * machine's transcripts 2026-09-22, Claude Code 2.1.27x; the question rule is
 * C2's, PLAN-C2 § The rule 1):
 *   - `type` not user/assistant → does not count (`isMeta: true` and
 *     `isSidechain: true` lines never reach here: foldTurnLine skips them);
 *   - `user` starting with a local-command tag → does not count;
 *   - `user` starting with `[Request interrupted by user` → 'waiting';
 *   - any other `user` (a prompt, a tool_result — the answer to a question
 *     included —, a task-notification) → 'working';
 *   - `assistant` that is an API error or `<synthetic>` → 'waiting';
 *   - `assistant` carrying an `AskUserQuestion` / `ExitPlanMode` tool_use →
 *     'asking' (waiting for the user; a question wins over background work);
 *   - `assistant` whose stop reason ends a turn → 'waiting'; any other
 *     (`tool_use`, `pause_turn`, null) → 'working'.
 *
 * KNOWN LIMIT: Claude Code's permission prompt writes nothing to the
 * transcript (the last line is the assistant's `tool_use`), so a session
 * waiting on one reads 'working' — the BEL (`attention`) is what says "needs
 * your answer" then. No stale rule: a long tool call is still working. An
 * orchestrating session that ended its turn while background subagents or
 * workflows it launched still run reads 'waiting' HERE; the session verdict
 * (AgentsWatcher, PLAN-C2 § The rule 4) turns that into 'working' while one
 * of those launches (TurnFold.launches) is alive.
 */
function turnOfLine(raw: Record<string, unknown>): LineTurn | undefined {
  const message = plainObject(raw['message']);
  const type = raw['type'];
  if (type === 'user') {
    const text = textOf(message?.['content']);
    if (LOCAL_COMMAND_PREFIXES.some((prefix) => text.startsWith(prefix))) return undefined;
    if (text.startsWith(INTERRUPT_PREFIX)) return 'waiting';
    return 'working';
  }
  if (type !== 'assistant') return undefined;
  if (raw['isApiErrorMessage'] === true) return 'waiting';
  if (message === undefined) return 'working';
  if (message['model'] === '<synthetic>') return 'waiting';
  const asks = blocksOf(message).some(
    (b) => b['type'] === 'tool_use' && typeof b['name'] === 'string' && QUESTION_TOOLS.has(b['name']),
  );
  if (asks) return 'asking';
  const stop = message['stop_reason'];
  return typeof stop === 'string' && TURN_ENDING_STOPS.has(stop) ? 'waiting' : 'working';
}

// ---------------------------------------------------------------------------
// C2: background launches that have not reported back
// ---------------------------------------------------------------------------

/**
 * The tools whose `tool_result` can say the work went to the BACKGROUND
 * (PLAN-C2 § The rule 2), and how to read that result. `Task` is `Agent`'s
 * older name. `SendMessage` that RESUMES a finished subagent is one too —
 * measured 2026-09-26: its result is `{"success":true,"message":"Resuming
 * agent …","resumedAgentId":"<hex>",…}` and the agent's completion
 * notification names the SendMessage's own tool_use id (199 resumes in this
 * machine's transcripts), so a resumed subagent is background work exactly
 * like a launched one. Background SHELLS (`Bash` run_in_background,
 * `Monitor`) are not here on purpose: a dev server may run forever.
 */
type LaunchTool = 'agent' | 'workflow' | 'resume';
const LAUNCH_TOOLS = new Map<string, LaunchTool>([
  ['Agent', 'agent'],
  ['Task', 'agent'],
  ['Workflow', 'workflow'],
  ['SendMessage', 'resume'],
]);

/** What a launch is waiting on: a subagent (B7's row by id) or a workflow run (its directory). */
type LaunchKind = 'agent' | 'workflow';

/** One background launch that has not reported back (PLAN-C2 § The rule 2). */
interface Launch {
  kind: LaunchKind;
  /**
   * The subagent's id (AGENT_ID — the shape B7 keys its rows by) or the
   * workflow's run id (isRunId); '' when the result carried none we believe,
   * and then only the launch time speaks for it.
   */
  ref: string;
  /** ms epoch of the launching line: its own timestamp, else first sight — never later than first sight. */
  atMs: number;
}

/**
 * Most launches remembered, and most launch tool_uses awaiting their result,
 * per session. Past it the OLDEST is forgotten: the newest launch is the one
 * most likely alive, and a transcript full of planted launches cannot grow
 * this without bound.
 */
const MAX_LAUNCHES = 64;

/**
 * A tool_use id as Claude Code writes one (`toolu_01JMRGSDa5ThQwVnDeAn4rje`,
 * 30 characters measured): the key of both maps, never joined into a path and
 * never sent anywhere; capped so a planted id cannot be a megabyte.
 */
const TOOL_USE_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * The shape of a subagent id, as a regex SOURCE fragment — the hex in Claude
 * Code's `agent-<hex>.meta.json` / `agent-<hex>.jsonl`. Its ONE home: AGENT_ID
 * below, META_FILE in server/agents.ts and AGENT_TRANSCRIPT in
 * server/agents-workflows.ts are all composed from it. Were they to drift, a
 * launch's agentId would stop matching B7's row ids and a subagent running
 * past STALE_MS would read 'waiting'. It can express no `.`, no separator and
 * nothing absolute, so a capture of it is safe to join into a path.
 */
export const AGENT_HEX = '[a-f0-9]{1,32}';

/** A whole subagent id — what B7 keys its rows by. */
const AGENT_ID = new RegExp(`^${AGENT_HEX}$`);

/**
 * A workflow run id, measured 2026-09-26 on all 13 runs on this machine:
 * `wf_` + a lowercase uuid prefix (`wf_998cfcac-d41`). The pattern admits a
 * longer prefix of the same uuid too, up to the whole one; it can express no
 * `.`, no separator and nothing absolute, so it is safe to join into a path —
 * server/agents-workflows.ts checks it again right before it does.
 */
const RUN_ID = /^wf_[a-f0-9]{8}(?:-[a-f0-9]{1,12}){1,4}$/;

/** True for a string shaped like a workflow run id (RUN_ID). */
export function isRunId(value: string): boolean {
  return RUN_ID.test(value);
}

/**
 * How Claude Code closes a background launch (PLAN-C2 § The rule 2): a task
 * notification whose `<tool-use-id>` names the launch. What is checked is the
 * TEXT: it must start with NOTIFICATION_PREFIX. Measured 2026-09-26, 915
 * launches: 831 were closed by a `user` line whose text starts so (Claude Code
 * also marks those `origin.kind: "task-notification"`, which is not checked),
 * 79 by an `attachment` of type `queued_command` whose `prompt` starts so —
 * the form it takes when Claude was busy as it arrived. Both close. The id tag
 * sits in the first lines, so only a head of the text is searched.
 */
const NOTIFICATION_PREFIX = '<task-notification>';
const NOTIFICATION_HEAD = 1024;
const NOTIFIED_ID = /<tool-use-id>([A-Za-z0-9_-]{1,128})<\/tool-use-id>/;

/**
 * What the session's own transcript has said so far (B11 + C2). Built by
 * foldTurnLine(); the one other writer is the watcher, which sets `turn` to
 * 'waiting' on a fresh fold when the transcript (or its slug folder) does not
 * exist yet — the session sits at its first prompt (B11 F1).
 */
export interface TurnFold {
  /** The main verdict — the last counting line's; undefined = none seen yet. */
  turn: SessionTurn | undefined;
  /** True while `turn` is 'waiting' because Claude asked the user something. */
  asking: boolean;
  /** Launch-capable tool_uses whose result has not come yet, by tool_use id, oldest first. */
  pending: Map<string, { tool: LaunchTool; atMs: number }>;
  /** Background launches that have not reported back, by tool_use id, oldest first. */
  launches: Map<string, Launch>;
}

/** A fold that has read nothing. */
export function newTurnFold(): TurnFold {
  return { turn: undefined, asking: false, pending: new Map(), launches: new Map() };
}

/**
 * Fold one line of the session's own transcript into `acc`: its turn verdict
 * (turnOfLine) and its part in the background-launch bookkeeping. `seenMs` is
 * the time the watcher read it — a launch line without a believable timestamp
 * is dated by it, and a stamp later than it (a clock skew or a planted date)
 * is clamped to it, so no launch can claim to be alive forever. Total, never
 * throws; `isMeta` and `isSidechain` lines say nothing to either rule.
 */
export function foldTurnLine(acc: TurnFold, line: string, seenMs: number): void {
  if (typeof line !== 'string' || line.length === 0) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return; // A torn line, or never JSON at all.
  }
  const raw = plainObject(parsed);
  if (raw === undefined) return;
  if (raw['isMeta'] === true || raw['isSidechain'] === true) return;
  noteLaunches(acc, raw, seenMs);
  const verdict = turnOfLine(raw);
  if (verdict === undefined) return;
  acc.turn = verdict === 'asking' ? 'waiting' : verdict;
  acc.asking = verdict === 'asking';
}

/** The launch bookkeeping for one line: launch tool_uses, their results, notifications. */
function noteLaunches(acc: TurnFold, raw: Record<string, unknown>, seenMs: number): void {
  const type = raw['type'];
  const message = plainObject(raw['message']);
  if (type === 'assistant') {
    const stamp = msAt(raw['timestamp']);
    const atMs = stamp === undefined ? seenMs : Math.min(stamp, seenMs);
    for (const block of blocksOf(message)) {
      const name = block['name'];
      const id = block['id'];
      if (block['type'] !== 'tool_use' || typeof name !== 'string' || typeof id !== 'string') continue;
      const tool = LAUNCH_TOOLS.get(name);
      if (tool === undefined || !TOOL_USE_ID.test(id)) continue;
      remember(acc.pending, id, { tool, atMs });
    }
    return;
  }
  if (type === 'user') {
    for (const block of blocksOf(message)) {
      const id = block['tool_use_id'];
      if (block['type'] !== 'tool_result' || typeof id !== 'string') continue;
      const asked = acc.pending.get(id);
      if (asked === undefined) continue; // Not a launch tool, or launched before the tail.
      acc.pending.delete(id);
      const launch = launchOf(asked.tool, textOf(block['content']), asked.atMs);
      if (launch !== undefined) remember(acc.launches, id, launch);
    }
    close(acc, textOf(message?.['content']));
    return;
  }
  if (type === 'attachment') {
    const attachment = plainObject(raw['attachment']);
    if (attachment !== undefined && attachment['type'] === 'queued_command') {
      close(acc, typeof attachment['prompt'] === 'string' ? attachment['prompt'] : '');
    }
  }
}

/** A launch tool's result text read as a background launch, or undefined when it ran in the foreground. */
function launchOf(tool: LaunchTool, text: string, atMs: number): Launch | undefined {
  if (tool === 'agent') {
    // `Async agent launched successfully. …\nagentId: a790bda5878f4d7ef (internal ID …`
    if (!text.startsWith('Async agent launched')) return undefined;
    const ref = (lineValue(text, 'agentId: ') ?? '').split(' ')[0] ?? '';
    return { kind: 'agent', ref: AGENT_ID.test(ref) ? ref : '', atMs };
  }
  if (tool === 'workflow') {
    // `Workflow launched in background. Task ID: …\n…\nTranscript dir: …/subagents/workflows/wf_…`
    if (!text.startsWith('Workflow launched in background')) return undefined;
    const dir = lineValue(text, 'Transcript dir: ') ?? '';
    const marker = '/subagents/workflows/';
    const at = dir.lastIndexOf(marker);
    const ref = at < 0 ? '' : dir.slice(at + marker.length);
    return { kind: 'workflow', ref: isRunId(ref) ? ref : '', atMs };
  }
  // A SendMessage result is a small JSON object; anything long is not one.
  if (!text.startsWith('{') || text.length > 4096) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const result = plainObject(parsed);
  const said = result?.['message'];
  // "Message queued for delivery" goes to an agent that still runs: no new work.
  if (typeof said !== 'string' || !said.startsWith('Resuming agent')) return undefined;
  const ref = result?.['resumedAgentId'];
  return { kind: 'agent', ref: typeof ref === 'string' && AGENT_ID.test(ref) ? ref : '', atMs };
}

/**
 * The rest of the first LATER line of `text` that starts with `prefix`;
 * undefined when none does. Never the first line: both callers already know
 * it is the launch sentence (`Async agent launched…`, `Workflow launched…`).
 */
function lineValue(text: string, prefix: string): string | undefined {
  const at = text.indexOf(`\n${prefix}`);
  if (at < 0) return undefined;
  const from = at + 1 + prefix.length;
  const end = text.indexOf('\n', from);
  return end < 0 ? text.slice(from) : text.slice(from, end);
}

/** A task notification in `text` closes the launch it names; an unknown id changes nothing. */
function close(acc: TurnFold, text: string): void {
  if (!text.startsWith(NOTIFICATION_PREFIX)) return;
  const id = NOTIFIED_ID.exec(text.slice(0, NOTIFICATION_HEAD))?.[1];
  if (id !== undefined) acc.launches.delete(id);
}

/** Set `id` as the NEWEST entry of `map`, forgetting the oldest past MAX_LAUNCHES. */
function remember<V>(map: Map<string, V>, id: string, value: V): void {
  map.delete(id);
  map.set(id, value);
  for (const oldest of map.keys()) {
    if (map.size <= MAX_LAUNCHES) break;
    map.delete(oldest);
  }
}
