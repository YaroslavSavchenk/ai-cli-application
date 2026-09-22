/**
 * BACKGROUND AGENTS: the subagents Claude Code ran for a session, read out of
 * Claude Code's own transcripts and put into SessionInfo.agents so the browser
 * can draw the "Background agents" table under the terminal (Nocturne B7,
 * .claude/plans/nocturne/PLAN-B7.md).
 *
 * The path the data takes:
 *   1. server/statusline.mjs runs inside the FOREIGN claude process and writes
 *      the payload's `transcript_path` into the B1 snapshot (`transcript`).
 *   2. server/telemetry.ts hands that string to server/index.ts, which asks
 *      subagentsDirFor() below whether it may be used at all.
 *   3. If it may, this watcher polls `<transcript dir>/<session id>/subagents/`
 *      every POLL_MS and folds each `agent-<hex>.jsonl` into one row.
 *   4. Nocturne B11 (.claude/plans/nocturne/PLAN-B11.md): on the same poll it
 *      reads the session's OWN transcript, `<transcript dir>/<session id>.jsonl`
 *      (derived from the tracked directory, never taken from the snapshot
 *      again), and folds its lines into a turn verdict — 'working' or
 *      'waiting' (turnOfLine()). Same boundary, same open discipline, same
 *      budgets; only its TAIL is read on first sight.
 *
 * THE PATH IS UNTRUSTED, and so is everything under it. The snapshot lives in
 * the data dir, an ordinary directory any process running as this user can
 * write — and on this WSL setup one the Windows side can reach as well
 * (memory/knowledge/wsl-0600-not-a-boundary.md). A planted snapshot naming
 * `/etc/shadow`, `~/.ssh/id_ed25519`, a FIFO or a symlink into someone else's
 * tree would otherwise turn this module into a file-reading oracle whose
 * output is broadcast to every attached browser. So:
 *   - a transcript path is REFUSED unless it is absolute, already normalised,
 *     control-character free, named `<uuid>.jsonl`, and its real directory
 *     sits inside the realpath of Claude Code's own projects root
 *     (DataPaths.claudeProjectsDir) — see subagentsDirFor();
 *   - and the tracked subagents directory is realpath'd again on EVERY poll
 *     and refused the same way, because readdir/stat follow every directory
 *     component and a symlink can be planted after tracking began;
 *   - inside that directory only names matching `agent-<hex>.meta.json` /
 *     `agent-<hex>.jsonl` are looked at, and ONLY the hex capture group is
 *     ever joined into a path, so no `..`, no separator and no absolute path
 *     can arrive through a directory listing;
 *   - every read is bounded and O_RDONLY|O_NOFOLLOW|O_NONBLOCK from a REGULAR
 *     file (a symlink is refused instead of followed, a FIFO refused instead
 *     of blocking the main thread forever);
 *   - every string that leaves here is control-stripped and capped like
 *     clean() in server/telemetry.ts, and every number is a finite integer.
 *
 * HONESTY RULE (B1, memory/decisions/pane-status-bar-data-source.md): a value
 * the files did not carry is never invented. A message with no usage adds 0 —
 * a real 0, it cost nothing we could see — but a transcript with no timestamp
 * yet falls back to the meta file's mtime, never to "now".
 *
 * Nothing in here ever throws into a timer or a consumer: a bad file is a
 * skipped file, logged at debug and forgotten.
 */
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize, sep } from 'node:path';
import type { SessionAgent, SessionAgentCounts, SessionTurn } from '../shared/protocol.ts';
import { describeError, oneLine, scoped, type Logger } from './config.ts';
import { isUuid } from './conversation.ts';

/** Poll interval per session. Same rate as the telemetry fallback poll. */
const POLL_MS = 2_000;

/**
 * Most bytes read from ONE transcript in ONE poll. A 15-minute agent's file is
 * 0.7-1.4 MB measured, so this catches up in a single tick in practice; the
 * cap is what stops a planted 10 GB file from being read into this process.
 * A backlog larger than this is simply read over the next few polls.
 */
const MAX_READ_PER_POLL = 4 * 1024 * 1024;

/**
 * Most bytes read across ALL sessions and ALL files in ONE tick. The per-file
 * cap alone is not a bound on a tick: the first poll after a session with 30
 * agents is tracked would parse 30 x 1.4 MB of JSON in one go, on the SAME
 * thread that pumps every PTY — the terminals would visibly stall. With a
 * global budget a big backlog is spread over a few ticks instead; every file
 * keeps its offset, so nothing is lost and nothing is read twice, and the only
 * cost is that a row can appear a tick or two late on first sight.
 */
const MAX_READ_PER_TICK = 16 * 1024 * 1024;

/**
 * Longest single line we will parse. Real lines reach ~120 KB (a large tool
 * result); past a megabyte it is not a transcript line, so it is skipped
 * unparsed rather than handed to JSON.parse.
 */
const MAX_LINE = 1024 * 1024;

/** A `.meta.json` is ~200 bytes; anything past this is not one. */
const MAX_META_BYTES = 8 * 1024;

/**
 * A running agent whose transcript has not been touched for this long is shown
 * finished. A killed agent (TaskStop, a usage-limit abort) leaves no end
 * marker at all, so without this rule its dot would spin forever. 15 minutes
 * is above the longest single tool call Claude Code allows (10 minutes), so a
 * live agent waiting on one is never declared dead.
 */
const STALE_MS = 15 * 60 * 1000;

/** Most agents tracked per session, newest `.meta.json` by mtime winning. */
const MAX_AGENTS = 64;

/**
 * Most RUNNING rows on the wire (B11 (d), user 2026-09-22). The rows are the
 * running agents oldest first, the first 4, then — only when fewer than 4 run —
 * the ONE most recently finished; the frontend draws `+N working` /
 * `+N finished` from AgentsReport.counts. The counts cover every TRACKED agent
 * (≤ MAX_AGENTS): a 65th agent is beyond both the list and the count.
 */
const MAX_RUNNING_ROWS = 4;

/**
 * How much of the session's own transcript is read on FIRST sight (B11). A
 * long session's transcript is tens of MB; the verdict lives in its last few
 * lines, so only the tail is read, from `max(0, size - TURN_TAIL_BYTES)`, and
 * the first (partial) line of it is dropped. Afterwards it is read
 * incrementally like every agent transcript.
 */
const TURN_TAIL_BYTES = 1024 * 1024;

/**
 * Most matching filenames a single poll will stat. A directory with a million
 * planted `agent-*.meta.json` entries must not turn one tick into a million
 * syscalls; 1024 is 16x the number of agents we would ever keep.
 */
const MAX_META_SCAN = 1024;

/** Caps on the two sourced strings, per the frozen SessionAgent contract. */
const MAX_NAME = 64;
const MAX_TASK = 120;

/** The latest ms epoch we believe: past this, the file is lying about its clock. */
const MAX_AT_MS = Date.UTC(3000, 0, 1);

/**
 * Token counts above this are corruption, not spend (the largest real figure
 * measured is ~12.5 M for a 15-minute agent). Clamped rather than refused: the
 * row is still worth drawing.
 */
const MAX_TOKENS = 1e12;

/** C0/C1 controls and DEL. A path containing one is never a path we opened. */
const CONTROL_CHAR = /[\u0000-\u001F\u007F-\u009F]/;

/**
 * The two filenames Claude Code writes per subagent. The capture group is the
 * ONLY thing ever joined into a path — `^[a-f0-9]{1,32}$` cannot express `..`,
 * a separator or an absolute path.
 */
const META_FILE = /^agent-([a-f0-9]{1,32})\.meta\.json$/;

/** Terminal- and DOM-safe single-line text. The twin of clean() in server/telemetry.ts. */
function clean(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const stripped = value
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped.length > max ? stripped.slice(0, max) : stripped;
}

/**
 * Plain object or undefined (arrays and null are not records). A deliberate
 * twin of plainObject() in server/telemetry.ts, which is module-private there.
 */
function plainObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

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
function isoOf(ms: number): string {
  const safe = Number.isFinite(ms) && ms >= 0 && ms <= MAX_AT_MS ? ms : 0;
  return new Date(safe).toISOString();
}

/** One usage figure: a finite integer >= 0, clamped. Anything else is 0. */
function tokenField(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Math.floor(value), MAX_TOKENS);
}

// ---------------------------------------------------------------------------
// The boundary: which transcript path may be opened at all
// ---------------------------------------------------------------------------

/**
 * The subagents directory for a snapshot's transcript path, or null when the
 * path is refused. Pure except for the two realpath calls.
 *
 * THIS IS THE SECURITY BOUNDARY of the whole module. `transcript` came out of
 * a file any local process can write, so every one of these refusals is load
 * bearing:
 *   - not a non-empty string, or longer than 1024 characters;
 *   - a control character or NUL anywhere in it (an ESC would also reach a
 *     terminal through the log line);
 *   - not absolute, or `normalize(p) !== p` — which is how `..`, `//` and a
 *     trailing separator are refused as WRITTEN, before any resolution could
 *     quietly make them look innocent;
 *   - a basename that is not `<uuid>.jsonl` with the exact UUID shape
 *     server/conversation.ts already checks — the only names Claude Code
 *     gives a transcript;
 *   - a real directory that is not inside the real projects root. Both sides
 *     are realpath'd, so a symlink planted anywhere along the path is resolved
 *     BEFORE the comparison instead of aiming it somewhere else, and the
 *     prefix test carries a trailing separator so `/home/u/.claude/projects-evil`
 *     is not accepted as being under `/home/u/.claude/projects`.
 * A projects root that does not exist (no Claude Code on this machine) makes
 * every path refusable, which is the correct answer: there is nothing to read.
 *
 * NOT THE WHOLE BOUNDARY. The `<uuid>` and `subagents` components are appended
 * to the real directory and are NOT resolved here (they usually do not exist
 * yet). AgentsWatcher re-checks the resolved directory on every poll, which is
 * also the only place that can: a symlink may be planted long after this
 * returned.
 */
export function subagentsDirFor(transcript: string, projectsRoot: string): string | null {
  if (typeof transcript !== 'string' || transcript.length === 0 || transcript.length > 1024) {
    return null;
  }
  if (CONTROL_CHAR.test(transcript)) return null;
  if (!isAbsolute(transcript)) return null;
  if (normalize(transcript) !== transcript) return null;
  // normalize() KEEPS a trailing separator, and basename() then ignores it, so
  // `/…/<uuid>.jsonl/` would pass every check above while naming a directory.
  if (transcript.endsWith(sep)) return null;

  const name = basename(transcript);
  if (!name.endsWith('.jsonl')) return null;
  const uuid = name.slice(0, -'.jsonl'.length);
  if (!isUuid(uuid)) return null;

  let realRoot: string;
  try {
    realRoot = realpathSync(projectsRoot);
  } catch {
    return null; // No projects root: nothing to read, ever.
  }
  // PENDING (B11 F1): the first session in a folder Claude Code never opened.
  // `<root>/<slug>` does not exist until the first prompt, and no new snapshot
  // arrives then — refusing here would leave the session untracked for good.
  // Accepted ONLY when the slug is exactly one missing component directly
  // under the REAL root (pendingSlug); the returned path is built from the
  // real root, and the watcher applies the full boundary per poll once the
  // slug exists.
  if (pendingSlug(dirname(transcript), realRoot)) {
    return join(realRoot, basename(dirname(transcript)), uuid, 'subagents');
  }

  let realDir: string;
  try {
    realDir = realpathSync(dirname(transcript));
  } catch {
    return null; // Gone, unreadable, or a root that does not exist.
  }
  if (realDir !== realRoot && !realDir.startsWith(realRoot + sep)) return null;

  return join(realDir, uuid, 'subagents');
}

/**
 * True when `parent` is a transcript folder Claude Code has not created YET
 * (B11 F1): exactly ONE missing component, directly under the real projects
 * root. Every check is load bearing:
 *   - its name is a real slug: non-empty, not `.`/`..`, no separator, no
 *     control character (basename() of a normalised absolute path already
 *     cannot hold a separator; the others are checked here again);
 *   - it is TRULY missing: `lstat` says ENOENT. A dangling symlink planted
 *     under the slug's name exists for lstat and is refused, not "pending";
 *   - its parent's realpath is EXACTLY the real root — not merely inside it,
 *     so two or more missing components, or a missing folder anywhere else,
 *     never count.
 * Pure except for one lstat and one realpath. Once the folder exists this is
 * false and the ordinary realpath boundary applies.
 */
function pendingSlug(parent: string, realRoot: string): boolean {
  const slug = basename(parent);
  if (slug === '' || slug === '.' || slug === '..' || slug.includes(sep) || CONTROL_CHAR.test(slug)) {
    return false;
  }
  try {
    lstatSync(parent);
    return false; // It exists (or a symlink wears its name): not pending.
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return false;
  }
  try {
    return realpathSync(dirname(parent)) === realRoot;
  } catch {
    return false;
  }
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

// ---------------------------------------------------------------------------
// The watcher
// ---------------------------------------------------------------------------

export interface AgentsWatcherOptions {
  /** Realpath'd lazily; default `paths.claudeProjectsDir`. Tests point it at a temp dir. */
  projectsRoot: string;
  pollMs?: number;
  now?: () => number;
  /** Bytes all transcripts together may cost one tick; default MAX_READ_PER_TICK. */
  readBudgetBytes?: number;
}

/** Per-transcript read state: where we stopped, and what we made of it. */
interface FileState {
  /** Bytes already parsed. Only ever moves forward, except on a shrink. */
  offset: number;
  /** The trailing partial line, as BYTES — a UTF-8 sequence can straddle a read. */
  carry: Buffer;
  /** True while we are discarding the remainder of an over-long line. */
  resyncing: boolean;
  fold: AgentFold;
  /** mtimeMs of the last stat: the agent's last sign of life (STALE_MS). */
  mtimeMs: number;
}

/** Read state of the session's own transcript (B11). */
interface TurnState {
  /** Bytes already consumed; -1 = never read (the next read is a TAIL read). */
  offset: number;
  carry: Buffer;
  resyncing: boolean;
  /** The verdict of the last counting line; undefined = none seen yet. */
  turn: SessionTurn | undefined;
}

/** A turn state that has read nothing: the next read starts at the tail. */
function newTurnState(): TurnState {
  return { offset: -1, carry: Buffer.alloc(0), resyncing: false, turn: undefined };
}

interface TrackedAgent {
  id: string;
  /** mtimeMs of the meta file we last parsed; -1 = never parsed one. */
  metaMtimeMs: number;
  /** mtimeMs of the meta file as last stat'ed — the startedAt fallback. */
  metaAtMs: number;
  name: string;
  task: string;
  file: FileState | undefined;
}

interface TrackedSession {
  dir: string;
  agents: Map<string, TrackedAgent>;
  /** The last report delivered to onChange; undefined = nothing delivered yet. */
  last: AgentsReport | undefined;
  /** The session's own transcript (B11). */
  main: TurnState;
  /**
   * True once the "resolves outside the projects root" refusal has been
   * logged for THIS directory. The check runs on every 2 s poll and would
   * otherwise write the same line 30 times a minute for the life of the
   * session, burying everything else in server.log. Cleared again when a poll
   * finally resolves inside the root, so a fix is visible too.
   */
  refusalLogged: boolean;
  /** Same once-only rule for a refused main transcript (B11). */
  mainRefusalLogged: boolean;
}

/**
 * Poll every tracked session's subagents directory and report every changed
 * list.
 *
 * WHY POLLING and not fs.watch: `~/.claude/projects/<slug>/<session-id>/` does
 * not exist until Claude Code writes its first subagent, and fs.watch on a
 * missing directory throws — a watcher would need a retry path for the normal
 * case. One unref'd 2 s interval for ALL sessions costs a readdir and a few
 * stats per session and needs no recovery path at all. Unref'd for the same
 * reason the telemetry timers are: this table must never be why the process
 * lives on.
 */
export class AgentsWatcher {
  readonly #log: Logger;
  readonly #projectsRoot: string;
  readonly #pollMs: number;
  readonly #now: () => number;
  readonly #readBudget: number;
  readonly #sessions = new Map<string, TrackedSession>();
  #timer: NodeJS.Timeout | undefined;
  /** Ticks so far: which session a sweep starts at (round robin, B11 F2). */
  #tick = 0;
  #onChange: ((id: string, report: AgentsReport) => void) | undefined;
  #stopped = false;

  constructor(log: Logger, options: AgentsWatcherOptions) {
    this.#log = scoped(log, 'agents');
    this.#projectsRoot = options.projectsRoot;
    this.#pollMs = options.pollMs ?? POLL_MS;
    this.#now = options.now ?? Date.now;
    this.#readBudget = options.readBudgetBytes ?? MAX_READ_PER_TICK;
  }

  /**
   * Start (idempotent) and hand every changed report to `onChange` — also a
   * report with no agents but a turn (B11), and an empty one once something
   * was delivered and is no longer there.
   */
  start(onChange: (id: string, report: AgentsReport) => void): void {
    this.#onChange = onChange;
    this.#stopped = false;
    if (this.#timer !== undefined) return;
    this.#timer = setInterval(() => this.#pollAll(), this.#pollMs);
    this.#timer.unref();
    this.#log('debug', `polling subagent directories every ${this.#pollMs}ms`);
  }

  /**
   * Watch this session's directory from now on. A second call with the same
   * path is a no-op (the status line reports the same transcript on every
   * turn); with ANOTHER path it replaces the state completely — a resumed
   * session reports a different Claude session id, and carrying the old
   * offsets into a different directory would fold two agents into one.
   */
  track(id: string, subagentsDir: string): void {
    if (this.#stopped) return;
    const existing = this.#sessions.get(id);
    if (existing !== undefined && existing.dir === subagentsDir) return;
    // A fresh record, so the refusal log starts over for the new directory.
    this.#sessions.set(id, {
      dir: subagentsDir,
      agents: new Map(),
      last: undefined,
      main: newTurnState(),
      refusalLogged: false,
      mainRefusalLogged: false,
    });
    // oneLine: the path came from a snapshot file and names directories this
    // process did not create — a newline in it would forge a whole log line.
    this.#log('debug', `${id} tracking ${oneLine(subagentsDir)}`);
  }

  /** Stop polling this session; its last list stands wherever it was delivered. */
  untrack(id: string): void {
    if (this.#sessions.delete(id)) this.#log('debug', `${id} untracked`);
  }

  /** Stop polling everything and forget every offset. Idempotent. */
  stop(): void {
    this.#stopped = true;
    this.#onChange = undefined;
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    this.#sessions.clear();
  }

  /** Sessions currently polled. Read by tests; a number, never a path. */
  get trackedCount(): number {
    return this.#sessions.size;
  }

  /** One sweep over every tracked session. Never throws into the interval. */
  #pollAll(): void {
    if (this.#stopped) return;
    // One budget for the whole sweep, handed down and spent as files are read.
    const budget = { left: this.#readBudget };
    // ROUND ROBIN (B11 F2): the budget is spent in sweep order, so a fixed
    // order would let a few busy sessions early in the Map starve every later
    // session's turn and agents on every tick. Each tick starts one session
    // further on; every cap stays as it is.
    const entries = [...this.#sessions];
    const start = entries.length === 0 ? 0 : this.#tick % entries.length;
    this.#tick = (this.#tick + 1) % Number.MAX_SAFE_INTEGER;
    for (let i = 0; i < entries.length; i++) {
      const [id, session] = entries[(start + i) % entries.length] as [string, TrackedSession];
      // The list is a snapshot: a session untracked (or replaced) by a consumer
      // earlier in this sweep is not polled on stale state.
      if (this.#stopped || this.#sessions.get(id) !== session) continue;
      try {
        this.#pollSession(id, session, budget);
      } catch (err) {
        // A directory that vanished mid-sweep, a permission change, anything:
        // one session's bad tick must not stop the others or kill the timer.
        this.#log('debug', `${id}: poll failed: ${describeError(err)}`);
      }
    }
  }

  #pollSession(id: string, session: TrackedSession, budget: { left: number }): void {
    // B11: the session's own transcript first. It does not depend on the
    // subagents directory existing (it usually does not: most sessions never
    // spawn a subagent), and it shares this tick's byte budget.
    this.#readMain(id, session, budget);
    this.#pollAgents(id, session, budget);

    const report = this.#report(session);
    if (session.last === undefined && report.agents.length === 0 && report.turn === undefined) {
      return; // Nothing to say yet.
    }
    if (sameReport(session.last, report)) return;
    session.last = report;
    const onChange = this.#onChange;
    if (onChange === undefined) return;
    try {
      onChange(id, report);
    } catch (err) {
      // A throwing consumer must not take the watcher down with it.
      this.#log('warn', `${id}: agents consumer threw: ${describeError(err)}`);
    }
  }

  /** Refresh the tracked agents from the subagents directory, when it may be read. */
  #pollAgents(id: string, session: TrackedSession, budget: { left: number }): void {
    // THE BOUNDARY, RE-CHECKED EVERY TICK. subagentsDirFor() only realpath'd
    // the transcript's own directory; the `<uuid>` and `subagents` components
    // were appended AFTER that, and readdirSync/statSync follow every
    // directory component (O_NOFOLLOW protects the final file only). So a
    // symlink at `<slug>/<uuid>` pointing anywhere would hand this watcher a
    // directory outside Claude Code's tree — and its contents to every
    // attached browser. Re-checked per tick rather than once at track(),
    // because the symlink can be planted at any moment afterwards.
    const dir = this.#realDirUnderRoot(id, session);
    if (dir === null) return;
    const metas = this.#listMetas(dir);
    if (metas === null) return; // Directory not created yet: normal, not an error.

    // Newest meta files win when there are more agents than we will track.
    metas.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.id < b.id ? -1 : 1));
    const keep = metas.slice(0, MAX_AGENTS);
    const present = new Set(keep.map((m) => m.id));
    for (const agentId of session.agents.keys()) {
      if (!present.has(agentId)) session.agents.delete(agentId);
    }

    for (const meta of keep) {
      let agent = session.agents.get(meta.id);
      if (agent === undefined) {
        agent = {
          id: meta.id,
          metaMtimeMs: -1,
          metaAtMs: meta.mtimeMs,
          name: 'agent',
          task: '',
          file: undefined,
        };
        session.agents.set(meta.id, agent);
      }
      agent.metaAtMs = meta.mtimeMs;
      // Re-read only when it changed: the meta is written once at spawn, so
      // this is one stat per agent per poll and no read at all in steady state.
      if (agent.metaMtimeMs !== meta.mtimeMs) {
        agent.metaMtimeMs = meta.mtimeMs;
        this.#readMeta(dir, agent);
      }
      this.#readTranscript(dir, agent, budget);
    }
  }

  /**
   * Bring the session's own transcript's turn verdict up to date (B11).
   *
   * THE PATH: `<parent>/<uuid>.jsonl`, derived from the tracked directory
   * `<parent>/<uuid>/subagents` that subagentsDirFor() built — never read from
   * the snapshot again. A tracked directory not of that shape gives no turn.
   *
   * THE BOUNDARY, RE-CHECKED EVERY TICK on the file actually opened (B7
   * amendment 2): the parent is realpath'd and must sit inside the real
   * projects root, and the file's own realpath must be exactly
   * `<real parent>/<uuid>.jsonl` — a symlink at the final component (even one
   * pointing inside the root) is refused, not followed. The open itself is
   * O_RDONLY|O_NOFOLLOW|O_NONBLOCK and fstat must say regular file, so a
   * symlink swapped in after the check is refused and a FIFO never blocks.
   *
   * States: a file that does not exist (lstat ENOENT — Claude Code creates it
   * at the first prompt) is 'waiting'; a refused or unreadable one has no
   * verdict; a readable one keeps the verdict of its last counting line.
   */
  #readMain(id: string, session: TrackedSession, budget: { left: number }): void {
    const uuidDir = dirname(session.dir);
    const uuid = basename(uuidDir);
    if (basename(session.dir) !== 'subagents' || !isUuid(uuid)) {
      this.#resetMain(session);
      return;
    }
    const name = `${uuid}.jsonl`;

    let realRoot: string;
    try {
      realRoot = realpathSync(this.#projectsRoot);
    } catch {
      this.#resetMain(session);
      return; // No projects root: nothing may be read.
    }
    let realParent: string;
    try {
      realParent = realpathSync(dirname(uuidDir));
    } catch {
      this.#resetMain(session);
      // B11 F1: the slug folder does not exist YET (one missing component
      // directly under the real root) — Claude Code has written nothing, so
      // the session sits at its first prompt. Anything else missing: no turn.
      if (pendingSlug(dirname(uuidDir), realRoot)) session.main.turn = 'waiting';
      return;
    }
    if (realParent !== realRoot && !realParent.startsWith(realRoot + sep)) {
      this.#refuseMain(id, session, dirname(uuidDir));
      return;
    }
    const file = join(realParent, name);

    let realFile: string;
    try {
      realFile = realpathSync(file);
    } catch {
      // Missing (the session sits at its first prompt) or a dangling symlink.
      // Only a TRULY missing name is 'waiting'; lstat does not follow.
      let missing = false;
      try {
        lstatSync(file);
      } catch (err) {
        missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
      }
      this.#resetMain(session);
      if (missing) session.main.turn = 'waiting';
      return;
    }
    if (realFile !== file) {
      this.#refuseMain(id, session, file);
      return;
    }
    if (session.mainRefusalLogged) {
      session.mainRefusalLogged = false;
      this.#log('debug', `${id}: ${oneLine(file)} now inside the projects root, reading it again`);
    }

    let fd: number;
    try {
      fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    } catch {
      this.#resetMain(session);
      return; // Vanished since realpath, swapped for a symlink, or unreadable.
    }
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile()) {
        this.#resetMain(session);
        return;
      }
      const size = stat.size;
      if (session.main.offset >= 0 && size < session.main.offset) {
        // Shrank or replaced: the verdict describes a file that is gone, so
        // start over from its tail.
        this.#log('debug', `${id}: transcript shrank, re-reading its tail`);
        session.main = newTurnState();
      }
      const state = session.main;
      if (state.offset < 0) {
        // FIRST SIGHT: only the tail. Starting one byte before the tail and
        // resyncing drops the partial first line — and keeps a whole one that
        // happens to begin exactly at the tail boundary.
        if (size > TURN_TAIL_BYTES) {
          state.offset = size - TURN_TAIL_BYTES - 1;
          state.resyncing = true;
        } else {
          state.offset = 0;
        }
      }
      if (size === state.offset) return;
      const want = Math.min(size - state.offset, MAX_READ_PER_POLL, budget.left);
      if (want <= 0) return;
      const buffer = Buffer.allocUnsafe(want);
      const read = readSync(fd, buffer, 0, want, state.offset);
      if (read <= 0) return;
      budget.left -= read;
      state.offset += read;
      splitLines(state, buffer.subarray(0, read), (line) => {
        const verdict = turnOfLine(line.toString('utf8'));
        if (verdict !== undefined) state.turn = verdict;
      });
    } catch (err) {
      this.#log('debug', `${id}: transcript read failed: ${describeError(err)}`);
    } finally {
      closeQuietly(fd);
    }
  }

  /** Forget the main transcript's read state and verdict. */
  #resetMain(session: TrackedSession): void {
    session.main = newTurnState();
  }

  /** A main transcript outside the root: no verdict, logged once per session. */
  #refuseMain(id: string, session: TrackedSession, path: string): void {
    this.#resetMain(session);
    if (session.mainRefusalLogged) return;
    session.mainRefusalLogged = true;
    this.#log('debug', `${id}: ${oneLine(path)} resolves outside the projects root, refused`);
  }

  /**
   * The real path of a tracked directory, or null when it may not be read.
   *
   * Two different nulls, and only one of them is worth a word: a directory
   * that is not there yet is the ORDINARY state (Claude Code creates it with
   * the first subagent), while a directory that resolves OUTSIDE the projects
   * root is someone redirecting us and is logged.
   */
  #realDirUnderRoot(id: string, session: TrackedSession): string | null {
    const dir = session.dir;
    let real: string;
    let realRoot: string;
    try {
      real = realpathSync(dir);
      realRoot = realpathSync(this.#projectsRoot);
    } catch {
      return null; // Not created yet, gone, or no projects root at all.
    }
    if (real !== realRoot && !real.startsWith(realRoot + sep)) {
      // Once per tracked directory, not once per poll (see refusalLogged).
      if (!session.refusalLogged) {
        session.refusalLogged = true;
        this.#log('debug', `${id}: ${oneLine(dir)} resolves outside the projects root, refused`);
      }
      return null;
    }
    if (session.refusalLogged) {
      session.refusalLogged = false;
      this.#log('debug', `${id}: ${oneLine(dir)} now inside the projects root, reading it again`);
    }
    return real;
  }

  /**
   * Every `agent-<hex>.meta.json` in the directory, with its mtime. null means
   * the directory could not be listed — which is the ordinary state until
   * Claude Code spawns the session's first subagent.
   */
  #listMetas(dir: string): { id: string; mtimeMs: number }[] | null {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return null;
    }
    const metas: { id: string; mtimeMs: number }[] = [];
    let scanned = 0;
    for (const name of names) {
      const match = META_FILE.exec(name);
      if (match === null) continue; // Not a name we know: never joined into a path.
      if (++scanned > MAX_META_SCAN) {
        this.#log('debug', `${oneLine(dir)}: more than ${MAX_META_SCAN} agent metas, rest ignored`);
        break;
      }
      let stat;
      try {
        stat = statSync(join(dir, name));
      } catch {
        continue; // Vanished between readdir and stat.
      }
      if (!stat.isFile()) continue; // A directory or FIFO wearing the name.
      metas.push({ id: match[1] as string, mtimeMs: stat.mtimeMs });
    }
    return metas;
  }

  /** Read one meta file and take `agentType`/`description` from it. */
  #readMeta(dir: string, agent: TrackedAgent): void {
    const text = this.#readBounded(join(dir, `agent-${agent.id}.meta.json`), MAX_META_BYTES);
    if (text === undefined) {
      this.#log('debug', `agent ${agent.id}: meta unreadable, keeping ${JSON.stringify(agent.name)}`);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.#log('debug', `agent ${agent.id}: meta is not JSON, ignored`);
      return;
    }
    const raw = plainObject(parsed);
    if (raw === undefined) return;
    const name = clean(raw['agentType'], MAX_NAME);
    // '' is not a name to draw, so the row keeps the honest placeholder.
    agent.name = name === '' ? 'agent' : name;
    agent.task = clean(raw['description'], MAX_TASK);
  }

  /**
   * Read whatever was appended to this agent's transcript since the last poll
   * and fold it. A missing transcript is normal: Claude Code writes the meta
   * at spawn and the first line only once the agent speaks.
   */
  #readTranscript(dir: string, agent: TrackedAgent, budget: { left: number }): void {
    const file = join(dir, `agent-${agent.id}.jsonl`);
    let stat;
    try {
      stat = statSync(file);
    } catch {
      return; // No transcript yet (or gone): the meta alone still makes a row.
    }
    if (!stat.isFile()) return;

    let state = agent.file;
    if (state === undefined) {
      state = { offset: 0, carry: Buffer.alloc(0), resyncing: false, fold: newFold(), mtimeMs: stat.mtimeMs };
      agent.file = state;
    }
    state.mtimeMs = stat.mtimeMs;

    if (stat.size < state.offset) {
      // Truncated or replaced: what we folded describes a file that no longer
      // exists, so the counters go back to zero rather than double-count.
      this.#log('debug', `agent ${agent.id}: transcript shrank, re-reading from 0`);
      state.offset = 0;
      state.carry = Buffer.alloc(0);
      state.resyncing = false;
      state.fold = newFold();
    }
    if (stat.size === state.offset) return;

    // The tick's remaining budget bounds this read as hard as the per-file cap
    // does. Nothing is lost by stopping here: the offset stands and the rest is
    // read on the next tick.
    const want = Math.min(stat.size - state.offset, MAX_READ_PER_POLL, budget.left);
    if (want <= 0) return;
    const chunk = this.#readAt(file, state.offset, want);
    if (chunk === undefined) return;
    budget.left -= chunk.length;
    state.offset += chunk.length;
    this.#foldChunk(state, chunk);
  }

  /** Split a chunk on newlines, carrying the trailing partial line. */
  #foldChunk(state: FileState, chunk: Buffer): void {
    splitLines(state, chunk, (line) => foldLine(state.fold, line.toString('utf8')));
  }

  /**
   * The report this session makes: the rows (B11 (d) list rule), the totals
   * over every tracked agent, and the main transcript's verdict.
   */
  #report(session: TrackedSession): AgentsReport {
    const now = this.#now();
    const running: SessionAgent[] = [];
    const finished: SessionAgent[] = [];
    for (const agent of session.agents.values()) {
      const row = this.#row(agent, now);
      (row.state === 'running' ? running : finished).push(row);
    }
    // Running oldest-first (the one that has been going longest is the one the
    // user is waiting on), finished newest-first (the freshest result).
    running.sort((a, b) => cmp(a.startedAt, b.startedAt) || cmp(a.id, b.id));
    finished.sort(
      (a, b) => cmp(b.endedAt ?? b.startedAt, a.endedAt ?? a.startedAt) || cmp(a.id, b.id),
    );
    const agents = running.slice(0, MAX_RUNNING_ROWS);
    // One finished row, the most recent, and only while there is room.
    const newest = finished[0];
    if (running.length < MAX_RUNNING_ROWS && newest !== undefined) agents.push(newest);
    const report: AgentsReport = {
      agents,
      counts: { running: running.length, finished: finished.length },
    };
    const turn = session.main.turn;
    if (turn !== undefined) report.turn = turn;
    return report;
  }

  /** One agent's row: only what its two files said. */
  #row(agent: TrackedAgent, now: number): SessionAgent {
    const fold = agent.file?.fold;
    // No line yet -> the meta's mtime, which is when Claude Code spawned it.
    // Never "now": that would make every row a second old forever.
    const startedAt = fold !== undefined && fold.firstAt !== '' ? fold.firstAt : isoOf(agent.metaAtMs);
    const tokens = fold?.tokens ?? 0;

    if (fold !== undefined && fold.finished) {
      return {
        id: agent.id,
        name: agent.name,
        task: agent.task,
        startedAt,
        endedAt: fold.endedAt !== '' ? fold.endedAt : startedAt,
        tokens,
        state: 'finished',
      };
    }

    // No end marker. A transcript (or a meta with no transcript) untouched for
    // STALE_MS belongs to an agent that was killed: the file's own last sign of
    // life becomes its end, never the current clock.
    const activityMs = agent.file?.mtimeMs ?? agent.metaAtMs;
    if (now - activityMs > STALE_MS) {
      const lastAt = fold !== undefined && fold.lastAt !== '' ? fold.lastAt : isoOf(activityMs);
      return {
        id: agent.id,
        name: agent.name,
        task: agent.task,
        startedAt,
        endedAt: lastAt,
        tokens,
        state: 'finished',
      };
    }

    return { id: agent.id, name: agent.name, task: agent.task, startedAt, tokens, state: 'running' };
  }

  /**
   * Bounded read of a whole small file (the meta). A REGULAR file only, never
   * a symlink (O_NOFOLLOW), never a FIFO (O_NONBLOCK + isFile(), because
   * opening a FIFO for reading blocks until a writer appears and this runs on
   * the main thread). undefined = nothing to parse.
   */
  #readBounded(file: string, max: number): string | undefined {
    let fd: number;
    try {
      fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    } catch {
      return undefined; // Gone, unreadable, or a symlink we refuse to follow.
    }
    try {
      if (!fstatSync(fd).isFile()) return undefined;
      const buffer = Buffer.allocUnsafe(max + 1);
      const read = readSync(fd, buffer, 0, max + 1, 0);
      if (read > max) return undefined; // Too big: refused unparsed.
      return buffer.subarray(0, read).toString('utf8');
    } catch {
      return undefined;
    } finally {
      closeQuietly(fd);
    }
  }

  /** Bounded read of `length` bytes at `position`. Same open discipline as above. */
  #readAt(file: string, position: number, length: number): Buffer | undefined {
    if (length <= 0) return undefined;
    let fd: number;
    try {
      fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    } catch {
      return undefined;
    }
    try {
      if (!fstatSync(fd).isFile()) return undefined;
      const buffer = Buffer.allocUnsafe(length);
      const read = readSync(fd, buffer, 0, length, position);
      return buffer.subarray(0, read);
    } catch {
      return undefined;
    } finally {
      closeQuietly(fd);
    }
  }
}

/**
 * Split a chunk on newlines, carrying the trailing partial line in `state` and
 * handing every complete line of at most MAX_LINE bytes to `onLine`. A line
 * past MAX_LINE is dropped unparsed; an unterminated one past it drops the
 * carry and resyncs at the next newline, so a single huge (or endless) line
 * cannot grow the carry without bound. `resyncing` set by the caller discards
 * everything up to the next newline (the tail read's partial first line).
 */
function splitLines(
  state: { carry: Buffer; resyncing: boolean },
  chunk: Buffer,
  onLine: (line: Buffer) => void,
): void {
  const buf = state.carry.length === 0 ? chunk : Buffer.concat([state.carry, chunk]);
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] !== 0x0a) continue;
    const line = buf.subarray(start, i);
    start = i + 1;
    if (state.resyncing) {
      // The tail of a line we already gave up on: this newline ends it.
      state.resyncing = false;
      continue;
    }
    if (line.length > MAX_LINE) continue; // Too big to be a transcript line.
    onLine(line);
  }
  const rest = buf.subarray(start);
  if (state.resyncing || rest.length > MAX_LINE) {
    // Still inside a line we are discarding, or an unterminated line past the
    // cap: keep nothing and resync at the next newline.
    state.carry = Buffer.alloc(0);
    state.resyncing = true;
    return;
  }
  // Copied, not aliased: subarray keeps the whole chunk alive otherwise.
  state.carry = Buffer.from(rest);
}

/** Compare two ISO stamps (or ids) as plain strings — ISO-8601 sorts lexically. */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** close() that cannot throw: there is nothing to do about a failed close. */
function closeQuietly(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // Nothing to do about a failed close.
  }
}
