/**
 * Conversation pinning + resume composition — PURE argv logic, no pty, no fs,
 * no DOM. Decided 2026-09-06 (user's call): the app must be able to resume THE
 * conversation a history entry belongs to, not "the most recent conversation in
 * that folder" (`--continue`), which is wrong the moment a project ever had two
 * sessions.
 *
 * Mechanism (Claude Code 2.1.263, `claude --help` verified):
 *   --session-id <uuid>  use a specific session id for the conversation
 *   -r, --resume [value] resume a conversation by session id
 *   -c, --continue       most recent conversation in this directory
 *
 * So a claude-kind session whose client args carry NO resume/session flag is
 * spawned with an injected `--session-id <app session uuid>`: from then on the
 * app knows the Claude conversation id and can spawn `--resume <id>`.
 *
 * Deliberately narrow, exactly like the `--settings` status-line injection:
 * ONLY `basename(command) === 'claude'` is touched, and the injected flag never
 * enters SessionInfo.args.
 */
import { basename } from 'node:path';

/** Claude requires a real UUID for `--session-id`; anything else is not one. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** True for the CLI we know these flags for. Everything else stays generic. */
export function isClaudeCommand(command: string): boolean {
  return basename(command) === 'claude';
}

export interface ConversationPlan {
  /**
   * History entry key. A Claude conversation id when `conversation` is true,
   * otherwise the app session id of this launch.
   */
  id: string;
  /** True when `id` is a Claude conversation id that `--resume` can target. */
  conversation: boolean;
  /** Client args with every resume/session flag (and its value) removed. */
  baseArgs: string[];
  /** What the PTY is spawned with (client args, plus an injection if any). */
  spawnArgs: string[];
  /**
   * Exactly the tokens this plan ADDED on top of the client's argv (`[]` when
   * it added none). Callers append these to their own spawn argv instead of
   * diffing `spawnArgs` against the client args — the diff silently assumes the
   * plan can only append.
   */
  injected: string[];
}

/** Flags that take a value we care about. */
const SESSION_ID = '--session-id';
const RESUME_LONG = '--resume';
const RESUME_SHORT = '-r';
/** Valueless pickers. */
const CONTINUE_LONG = '--continue';
const CONTINUE_SHORT = '-c';

/**
 * The value a `--flag value` pair carries, or undefined when the next token is
 * absent or is itself an option (`-`-leading). Mirrors how the CLI parsers
 * treat an optional-value flag.
 */
function valueAt(args: readonly string[], i: number): string | undefined {
  const next = args[i + 1];
  if (next === undefined || next.startsWith('-')) return undefined;
  return next;
}

/**
 * Decide how a launch maps onto a conversation id.
 *
 * Non-claude commands are never touched. For claude:
 *   - a client `--session-id <uuid>` is ADOPTED (that IS the conversation);
 *   - else a client `--resume <uuid>` / `-r <uuid>` is adopted;
 *   - else if ANY of --continue/-c/--resume/-r/--session-id is present in a
 *     form we cannot pin (valueless picker, non-uuid value), nothing is
 *     injected and the entry is not a conversation — `--continue` and
 *     `--session-id` must never be emitted together;
 *   - else `--session-id <sessionId>` is INJECTED.
 *
 * `--flag=value` forms are recognised too (commander accepts them): they never
 * cause a second, conflicting flag to be injected.
 */
export function planConversation(
  command: string,
  args: readonly string[],
  sessionId: string,
): ConversationPlan {
  const base = [...args];
  if (!isClaudeCommand(command)) {
    return { id: sessionId, conversation: false, baseArgs: base, spawnArgs: base, injected: [] };
  }

  let present = false;
  let sessionIdValue: string | undefined;
  let resumeValue: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === SESSION_ID) {
      present = true;
      sessionIdValue = valueAt(args, i);
    } else if (arg.startsWith(`${SESSION_ID}=`)) {
      present = true;
      sessionIdValue = arg.slice(SESSION_ID.length + 1);
    } else if (arg === RESUME_LONG || arg === RESUME_SHORT) {
      present = true;
      resumeValue = valueAt(args, i);
    } else if (arg.startsWith(`${RESUME_LONG}=`)) {
      present = true;
      resumeValue = arg.slice(RESUME_LONG.length + 1);
    } else if (arg === CONTINUE_LONG || arg === CONTINUE_SHORT) {
      present = true;
    }
  }

  const baseArgs = stripConversationArgs(args);
  if (isUuid(sessionIdValue)) {
    return { id: sessionIdValue, conversation: true, baseArgs, spawnArgs: base, injected: [] };
  }
  if (isUuid(resumeValue)) {
    return { id: resumeValue, conversation: true, baseArgs, spawnArgs: base, injected: [] };
  }
  if (present) {
    // A picker form we cannot pin to an id. Leave the argv exactly as the
    // client sent it: injecting here could emit `--continue --session-id`.
    return { id: sessionId, conversation: false, baseArgs, spawnArgs: base, injected: [] };
  }
  return {
    id: sessionId,
    conversation: true,
    baseArgs,
    spawnArgs: [...base, SESSION_ID, sessionId],
    injected: [SESSION_ID, sessionId],
  };
}

/**
 * Client args with `--session-id <v>`, `--resume <v>`, `-r <v>`, `--continue`
 * and `-c` removed — a value is removed only when the next token does not start
 * with `-`. Everything else (`--model`, `--permission-mode`, `--effort`,
 * `--settings`, unknown flags) survives verbatim: this is the argv a resume
 * re-uses.
 */
export function stripConversationArgs(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === SESSION_ID || arg === RESUME_LONG || arg === RESUME_SHORT) {
      if (valueAt(args, i) !== undefined) i += 1;
      continue;
    }
    if (arg.startsWith(`${SESSION_ID}=`) || arg.startsWith(`${RESUME_LONG}=`)) continue;
    if (arg === CONTINUE_LONG || arg === CONTINUE_SHORT) continue;
    out.push(arg);
  }
  return out;
}

/** The minimum a resume needs off a history entry (HistoryEntry satisfies it). */
export interface ResumableEntry {
  id: string;
  conversation: boolean;
  command: string;
  args: readonly string[];
}

/**
 * Compose the relaunch argv for a history entry:
 *   claude + conversation -> `<base args> --resume <id>`   (THAT conversation)
 *   claude, no conversation -> `<base args> --continue`    (best effort)
 *   anything else -> the base args, unchanged.
 * The per-session `--settings` injection still happens in SessionManager.create.
 */
export function resumeSpawn(entry: ResumableEntry): { command: string; args: string[] } {
  const args = [...entry.args];
  if (!isClaudeCommand(entry.command)) return { command: entry.command, args };
  if (entry.conversation) return { command: entry.command, args: [...args, RESUME_LONG, entry.id] };
  return { command: entry.command, args: [...args, CONTINUE_LONG] };
}
