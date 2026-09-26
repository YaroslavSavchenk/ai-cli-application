/**
 * Shared fixtures for the `server/agents.ts` tests (Nocturne B7, B11 and C2):
 * `tests/server/agents.test.ts` and its `agents-*.test.ts` siblings.
 *
 * Constants kept in step with server/agents.ts, a realpath'd projects root,
 * transcript line builders (Claude Code's own shapes, and REAL lines cut down
 * from real 2.1.27x transcripts; C2's questions, background launches and
 * their notifications at the end), an AgentsWatcher harness over a real temp
 * `<root>/<slug>/<uuid>/subagents` directory with waits on its reports, and a
 * SessionManager wired to a watcher with a fake `ws` client that keeps every
 * frame.
 */
import assert from 'node:assert/strict';
import { appendFile, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { WebSocket } from 'ws';
import type { ServerMessage, SessionAgent, SessionInfo } from '../../shared/protocol.ts';
import { AgentsWatcher, type AgentsReport } from '../../server/agents.ts';
import type { Logger } from '../../server/config.ts';
import { SessionHistory } from '../../server/history.ts';
import { SessionManager } from '../../server/sessions.ts';
import { makeTempDir, waitUntil } from './helpers.ts';

export const ESC = String.fromCharCode(27);
export const NUL = String.fromCharCode(0);
export const DEL = String.fromCharCode(127);

export const UUID = '0f2a5c8e-1b3d-4f60-9a77-2c1e5b8d4a09';
export const OTHER_UUID = '11111111-2222-4333-8444-555555555555';

/** The constants in server/agents.ts (not exported; kept in step here). */
export const STALE_MS = 15 * 60 * 1000;
export const MAX_AGENTS = 64;
export const MAX_RUNNING_ROWS = 4;
export const MAX_LINE = 1024 * 1024;
export const TURN_TAIL_BYTES = 1024 * 1024;

/** A whole-second mtime "just now": utimes stores it exactly, and it is not stale. */
export const NOW_S = Math.floor(Date.now() / 1_000);


/** A real projects root with one `<slug>` in it, realpath'd like the code does. */
export async function makeRoot(): Promise<{ base: string; root: string; slug: string; cleanup: () => Promise<void> }> {
  const base = realpathSync(await makeTempDir('ai-sm-agents-'));
  const root = join(base, 'projects');
  const slug = join(root, '-home-u-projects-app');
  await mkdir(slug, { recursive: true });
  return { base, root, slug, cleanup: async (): Promise<void> => rm(base, { recursive: true, force: true }) };
}

export interface Usage {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
}

/** An assistant line the way Claude Code writes one. */
export function assistantLine(
  timestamp: string,
  id: string,
  usage: Usage | undefined,
  stopReason: string | null = 'tool_use',
): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp,
    uuid: 'x',
    message: { id, role: 'assistant', stop_reason: stopReason, ...(usage === undefined ? {} : { usage }) },
  });
}

/** A user line (the prompt, a tool result, or a SendMessage that resumed the agent). */
export function userLine(timestamp: string): string {
  return JSON.stringify({ type: 'user', timestamp, message: { role: 'user', content: 'go on' } });
}

export interface Seen {
  id: string;
  /** `report.agents`, kept as its own field so the B7 assertions read as before. */
  agents: SessionAgent[];
  report: AgentsReport;
}

export interface Harness {
  root: string;
  dir: string;
  seen: Seen[];
  logs: string[];
  watcher: AgentsWatcher;
  cleanup: () => Promise<void>;
}

/** The poll interval of every `makeWatcher` watcher, and of the tests' own. */
export const WATCHER_POLL_MS = 20;

/**
 * How long a test gives the watcher to report something it must NOT
 * (tests/README.md § Time): ten polls. A change is reported in the same tick
 * that reads it, so a report that was coming has come by then.
 */
export const NO_REPORT_MS = 10 * WATCHER_POLL_MS;

/**
 * Fifteen polls: for a thing that must happen ONCE however many polls pass (a
 * refusal or a recovery logged once, not once per poll).
 */
export const MANY_POLLS_MS = 15 * WATCHER_POLL_MS;

/** A watcher over a real `<root>/<slug>/<uuid>/subagents` directory. */
export async function makeWatcher(
  opts: { now?: () => number; create?: boolean; readBudgetBytes?: number } = {},
): Promise<Harness> {
  const root = realpathSync(await makeTempDir('ai-sm-agentw-'));
  const dir = join(root, '-slug', UUID, 'subagents');
  if (opts.create !== false) await mkdir(dir, { recursive: true });
  const seen: Seen[] = [];
  const logs: string[] = [];
  const watcher = new AgentsWatcher((level, message) => logs.push(`${level}: ${message}`), {
    projectsRoot: root,
    pollMs: WATCHER_POLL_MS,
    ...(opts.now === undefined ? {} : { now: opts.now }),
    ...(opts.readBudgetBytes === undefined ? {} : { readBudgetBytes: opts.readBudgetBytes }),
  });
  return {
    root,
    dir,
    seen,
    logs,
    watcher,
    cleanup: async (): Promise<void> => {
      watcher.stop();
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** Write an `agent-<id>.meta.json`, optionally with a pinned mtime (whole seconds). */
export async function writeMeta(dir: string, id: string, body: unknown, mtimeS?: number): Promise<void> {
  const file = join(dir, `agent-${id}.meta.json`);
  await writeFile(file, typeof body === 'string' ? body : JSON.stringify(body), { mode: 0o644 });
  if (mtimeS !== undefined) await utimes(file, mtimeS, mtimeS);
}

/** Append lines to an `agent-<id>.jsonl`, creating it if needed. */
export async function appendLines(dir: string, id: string, lines: string[]): Promise<void> {
  await appendFile(join(dir, `agent-${id}.jsonl`), lines.map((l) => `${l}\n`).join(''), { mode: 0o600 });
}

/**
 * `waitUntil`, with the calls seen so far in the failure: a timeout that says
 * what the watcher DID report is the one worth reading.
 */
async function waitOnSeen<T>(fn: () => T | undefined, ms: number, last: () => unknown, seen: Seen[]): Promise<T> {
  try {
    return await waitUntil(fn, 'the watcher to report a matching list', ms, 10);
  } catch (err) {
    throw new Error(
      `${err instanceof Error ? err.message : String(err)}; ${seen.length} call(s), last = ${JSON.stringify(last())}`,
    );
  }
}

/** Wait until `seen`'s last list satisfies `ok`, or fail after `ms`. */
export async function waitFor(seen: Seen[], ok: (agents: SessionAgent[]) => boolean, ms = 5_000): Promise<SessionAgent[]> {
  return waitOnSeen(
    () => {
      const last = seen[seen.length - 1]?.agents;
      return last !== undefined && ok(last) ? last : undefined;
    },
    ms,
    () => seen[seen.length - 1],
    seen,
  );
}

/** Wait until `seen`'s last REPORT satisfies `ok`, or fail after `ms`. */
export async function waitForReport(seen: Seen[], ok: (report: AgentsReport) => boolean, ms = 5_000): Promise<AgentsReport> {
  return waitOnSeen(
    () => {
      const last = seen[seen.length - 1]?.report;
      return last !== undefined && ok(last) ? last : undefined;
    },
    ms,
    () => seen[seen.length - 1]?.report,
    seen,
  );
}

/**
 * Minimal stand-in for the `ws` socket: SessionManager only ever touches
 * readyState/OPEN, send() and on('close'). Every frame is kept, so "exactly
 * one broadcast per real change" is a countable claim.
 */
export class FakeClient {
  readonly OPEN = 1;
  readonly readyState = 1;
  readonly frames: ServerMessage[] = [];
  send(raw: string): void {
    this.frames.push(JSON.parse(raw) as ServerMessage);
  }
  on(): void {}
  /** Every `info` frame's session. */
  infoFrames(): SessionInfo[] {
    return this.frames
      .filter((m): m is Extract<ServerMessage, { type: 'info' }> => m.type === 'info')
      .map((m) => m.session);
  }
  /** The `info` frames that actually carried an agent list. */
  agentFrames(): SessionInfo[] {
    return this.frames
      .filter((m): m is Extract<ServerMessage, { type: 'info' }> => m.type === 'info')
      .map((m) => m.session)
      .filter((s) => s.agents !== undefined);
  }
  asWs(): WebSocket {
    return this as unknown as WebSocket;
  }
}

/** A SessionManager on a temp dir, with the watcher the B7 wiring hands it. */
export async function makeManager(): Promise<{
  manager: SessionManager;
  watcher: AgentsWatcher;
  logs: string[];
  root: string;
  cleanup: () => Promise<void>;
}> {
  const root = realpathSync(await makeTempDir('ai-sm-setagents-'));
  const logs: string[] = [];
  const log: Logger = (level, message) => logs.push(`${level}: ${message}`);
  const watcher = new AgentsWatcher(log, { projectsRoot: root, pollMs: 60_000 });
  const history = new SessionHistory(join(root, 'history.json'), log);
  history.load();
  const manager = new SessionManager(log, history, undefined, undefined, watcher);
  return {
    manager,
    watcher,
    logs,
    root,
    cleanup: async (): Promise<void> => {
      watcher.stop();
      manager.destroyAll();
      await rm(root, { recursive: true, force: true });
    },
  };
}

export const ROW: SessionAgent = {
  id: 'aa',
  name: 'test-engineer',
  task: 'gate B7',
  startedAt: '2026-09-22T10:00:00.000Z',
  tokens: 12_400,
  state: 'running',
};

/** A report the way the watcher builds one: counts derived from the rows unless given. */
export function report(agents: SessionAgent[], extra: { counts?: AgentsReport['counts']; turn?: AgentsReport['turn'] } = {}): AgentsReport {
  const counts = extra.counts ?? {
    running: agents.filter((a) => a.state === 'running').length,
    finished: agents.filter((a) => a.state === 'finished').length,
  };
  return { agents, counts, ...(extra.turn === undefined ? {} : { turn: extra.turn }) };
}

/** Real-shaped lines, cut down from this machine's transcripts (Claude Code 2.1.27x). */
export const REAL = {
  prompt: JSON.stringify({
    parentUuid: null,
    isSidechain: false,
    type: 'user',
    message: { role: 'user', content: 'fix the failing test' },
    uuid: 'u1',
    timestamp: '2026-09-22T10:00:00.000Z',
  }),
  toolResult: JSON.stringify({
    isSidechain: false,
    type: 'user',
    message: { role: 'user', content: [{ tool_use_id: 'toolu_1', type: 'tool_result', content: 'ok' }] },
    timestamp: '2026-09-22T10:00:02.000Z',
  }),
  taskNotification: JSON.stringify({
    isSidechain: false,
    type: 'user',
    message: { role: 'user', content: '<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n</task-notification>' },
    timestamp: '2026-09-22T10:00:03.000Z',
  }),
  interrupt: JSON.stringify({
    parentUuid: '64184a7c-a635-4170-9250-93c802616638',
    isSidechain: false,
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] },
    timestamp: '2026-09-09T15:28:37.227Z',
    interruptedMessageId: 'msg_011Cet6toLu1CTw9dVuiEc9H',
  }),
  interruptForTool: JSON.stringify({
    isSidechain: false,
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] },
    timestamp: '2026-09-09T15:28:38.000Z',
  }),
  commandName: JSON.stringify({
    isSidechain: false,
    type: 'user',
    message: {
      role: 'user',
      content: '<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args></command-args>',
    },
    timestamp: '2026-09-22T16:43:23.921Z',
  }),
  commandStdout: JSON.stringify({
    type: 'user',
    message: { role: 'user', content: '<local-command-stdout>Set model to opus</local-command-stdout>' },
  }),
  commandStderr: JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: '<local-command-stderr>nope</local-command-stderr>' }] },
  }),
  commandCaveat: JSON.stringify({
    type: 'user',
    isMeta: false,
    message: { role: 'user', content: '<local-command-caveat>Caveat: the messages below…</local-command-caveat>' },
  }),
  commandMessage: JSON.stringify({
    type: 'user',
    message: { role: 'user', content: '<command-message>review</command-message>' },
  }),
  meta: JSON.stringify({ type: 'user', isMeta: true, message: { role: 'user', content: 'Caveat: …' } }),
  sidechain: JSON.stringify({ type: 'user', isSidechain: true, message: { role: 'user', content: 'go' } }),
  synthetic: JSON.stringify({
    isSidechain: false,
    type: 'assistant',
    message: {
      id: 'be3179fe-a4b6-493b-84e5-6aa8de938e24',
      model: '<synthetic>',
      role: 'assistant',
      stop_reason: 'stop_sequence',
      content: [{ type: 'text', text: "You've hit your session limit · resets 7:30pm (Europe/Amsterdam)" }],
    },
    isApiErrorMessage: true,
  }),
  apiError: JSON.stringify({
    type: 'assistant',
    isApiErrorMessage: true,
    message: { id: 'x', model: 'claude-opus-5-5', role: 'assistant', stop_reason: null },
  }),
  syntheticOnly: JSON.stringify({
    type: 'assistant',
    message: { id: 'x', model: '<synthetic>', role: 'assistant', stop_reason: null },
  }),
  toolUse: assistantLine('2026-09-22T10:00:01.000Z', 'msg_1', { output_tokens: 3 }, 'tool_use'),
  endTurn: assistantLine('2026-09-22T10:00:04.000Z', 'msg_2', { output_tokens: 3 }, 'end_turn'),
};

/** The session's own transcript for the harness: `<root>/-slug/<UUID>.jsonl`. */
export function mainFile(w: Harness): string {
  return join(w.root, '-slug', `${UUID}.jsonl`);
}

export async function appendMain(w: Harness, lines: string[]): Promise<void> {
  await appendFile(mainFile(w), lines.map((l) => `${l}\n`).join(''), { mode: 0o600 });
}

/** `count` filler lines of ~1 KB that do not count for the turn. */
export function filler(bytes: number): string {
  const pad = `${JSON.stringify({ type: 'system', pad: 'x'.repeat(1_000) })}\n`;
  return pad.repeat(Math.ceil(bytes / pad.length));
}

/** Plant `running` running agents (started oldest first) and `finished` finished ones (ending oldest first). */
export async function plantAgents(dir: string, running: number, finished: number): Promise<void> {
  for (let i = 0; i < running; i++) {
    const id = `a${i.toString(16).padStart(2, '0')}`;
    await writeMeta(dir, id, { agentType: `run-${i}`, description: '' });
    await appendLines(dir, id, [userLine(`2026-09-16T10:${String(i).padStart(2, '0')}:00.000Z`)]);
  }
  for (let i = 0; i < finished; i++) {
    const id = `f${i.toString(16).padStart(2, '0')}`;
    await writeMeta(dir, id, { agentType: `fin-${i}`, description: '' });
    await appendLines(dir, id, [
      userLine('2026-09-16T09:00:00.000Z'),
      assistantLine(`2026-09-16T11:${String(i).padStart(2, '0')}:00.000Z`, `m${i}`, { output_tokens: 1 }, 'end_turn'),
    ]);
  }
}

// ---------------------------------------------------------------------------
// Nocturne C2 (.claude/plans/nocturne/PLAN-C2.md): questions and background
// launches in the session's own transcript. Shapes cut down from this
// machine's transcripts (Claude Code 2.1.27x-2.1.280, measured 2026-09-26).
// ---------------------------------------------------------------------------

/** A tool_use id the way Claude Code writes one. */
export function toolId(n: number): string {
  return `toolu_01JMRGSDa5ThQwVnDeAn${String(n).padStart(4, '0')}`;
}

/** An ISO stamp `ms` milliseconds before `now` (a launch's age). */
export function agoIso(now: number, ms: number): string {
  return new Date(now - ms).toISOString();
}

/**
 * An assistant line carrying ONE tool_use block — Claude Code writes each
 * content block of a message as its own line. `timestamp` undefined = a line
 * without one.
 */
export function toolUseLine(
  timestamp: string | undefined,
  id: string,
  name: string,
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    parentUuid: 'p',
    isSidechain: false,
    message: {
      model: 'claude-opus-5-5',
      id: `msg_${id}`,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'tool_use', id, name, input: { description: 'd' }, caller: { type: 'direct' } }],
      stop_reason: 'tool_use',
    },
    type: 'assistant',
    ...(timestamp === undefined ? {} : { timestamp }),
    ...extra,
  });
}

/** A user line carrying the tool_result for `id`: a string, or text blocks (the Agent tool's form). */
export function toolResultLine(timestamp: string, id: string, content: string | { type: 'text'; text: string }[]): string {
  return JSON.stringify({
    parentUuid: 'p',
    isSidechain: false,
    type: 'user',
    message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content }] },
    timestamp,
  });
}

/** The Agent tool's text when the subagent went to the background. */
export function asyncAgentText(agentId: string): string {
  return (
    'Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of it, ' +
    `including the agentId below, into a user-facing reply.)\nagentId: ${agentId} (internal ID - do not mention to user. ` +
    `Use SendMessage with to: '${agentId}', summary: '<5-10 word recap>' to continue this agent.)\n` +
    'The agent is working in the background. You will be notified automatically when it completes.\n' +
    `output_file: /tmp/claude-1000/-home-you-projects-app/${UUID}/tasks/${agentId}.output`
  );
}

/** The Workflow tool's text when the run went to the background. */
export function workflowText(runId: string, taskId = 'w094cbwm2'): string {
  const session = `/home/you/.claude/projects/-home-you-projects-app/${UUID}`;
  return (
    `Workflow launched in background. Task ID: ${taskId}\nSummary: weekly review prep\n` +
    `Transcript dir: ${session}/subagents/workflows/${runId}\n` +
    `Script file: ${session}/workflows/scripts/prep-${runId}.js\nRun ID: ${runId}\n`
  );
}

/** The SendMessage tool's text when it resumed a finished subagent. */
export function resumeText(agentId: string): string {
  return JSON.stringify({
    success: true,
    message: `Resuming agent ${agentId.slice(0, 7)}`,
    resumedAgentId: agentId,
    pin: { id: agentId, name: agentId, ref: 'e83aea' },
  });
}

/** Claude Code's completion notice for a background task. */
export function notificationText(toolUseId: string, taskId: string): string {
  return (
    `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n` +
    `<output-file>/tmp/claude-1000/x/tasks/${taskId}.output</output-file>\n<status>completed</status>\n` +
    `<summary>Agent "B4 phase 1" finished</summary>\n<result>Report.</result>\n</task-notification>`
  );
}

/** The notice as a `user` line: how it arrives while Claude is idle. */
export function notificationLine(timestamp: string, toolUseId: string, taskId: string): string {
  return JSON.stringify({
    parentUuid: 'p',
    isSidechain: false,
    type: 'user',
    message: { role: 'user', content: notificationText(toolUseId, taskId) },
    timestamp,
    origin: { kind: 'task-notification' },
    promptSource: 'system',
  });
}

/** The notice as a `queued_command` attachment: how it arrives while Claude is busy. */
export function queuedNotificationLine(timestamp: string, toolUseId: string, taskId: string): string {
  return JSON.stringify({
    parentUuid: 'p',
    isSidechain: false,
    attachment: {
      type: 'queued_command',
      prompt: notificationText(toolUseId, taskId),
      commandMode: 'task-notification',
      timestamp,
    },
    type: 'attachment',
    timestamp,
  });
}

/** A launch that went to the background: the tool_use line and its result (Agent's text-block form). */
export function agentLaunch(timestamp: string, id: string, agentId: string): string[] {
  return [
    toolUseLine(timestamp, id, 'Agent'),
    toolResultLine(timestamp, id, [{ type: 'text', text: asyncAgentText(agentId) }]),
  ];
}

/** A workflow launch: the tool_use line and its result (Workflow's plain-string form). */
export function workflowLaunch(timestamp: string, id: string, runId: string): string[] {
  return [toolUseLine(timestamp, id, 'Workflow'), toolResultLine(timestamp, id, workflowText(runId))];
}

/** An `AskUserQuestion` (or `ExitPlanMode`) line, and the user's answer to it. */
export function questionLine(timestamp: string, id: string, name = 'AskUserQuestion'): string {
  return toolUseLine(timestamp, id, name);
}
export function answerLine(timestamp: string, id: string): string {
  return toolResultLine(timestamp, id, 'Your questions have been answered: "Live test"="Yes, switch it on".');
}

/** The metadata lines Claude Code writes around a question; none of them counts. */
export const METADATA_LINES = [
  JSON.stringify({ type: 'last-prompt', lastPrompt: 'go', leafUuid: 'l', sessionId: UUID }),
  JSON.stringify({ type: 'ai-title', aiTitle: 't', sessionId: UUID }),
  JSON.stringify({ type: 'mode', mode: 'normal', sessionId: UUID }),
  JSON.stringify({ type: 'permission-mode', permissionMode: 'default', sessionId: UUID }),
  JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: '<task-notification>\n<task-id>x</task-id>' }),
];

// ---------------------------------------------------------------------------
// C2 harness: the session verdict on a stepped clock, and SessionManager's
// `turnEnded` fed by it (tests/server/agents-launch-watcher.test.ts and
// tests/server/agents-launch-edges.test.ts).
// ---------------------------------------------------------------------------

/** A watcher on a clock the test steps. */
export async function clocked(): Promise<{ w: Harness; clock: { now: number } }> {
  const clock = { now: Date.now() };
  const w = await makeWatcher({ now: () => clock.now });
  return { w, clock };
}

/** Start `w`'s watcher, keeping every report in `w.seen`, and track its directory as `sess-1`. */
export function startTracking(w: Harness): void {
  w.watcher.start((id, report) => w.seen.push({ id, agents: report.agents, report }));
  w.watcher.track('sess-1', w.dir);
}

/** Every turn `w`'s watcher delivered, in order. */
export function turnsOf(w: Harness): (string | undefined)[] {
  return w.seen.map((s) => s.report.turn);
}

/** A running subagent row: its meta and one fresh transcript line. */
export async function runningAgent(w: Harness, id: string): Promise<void> {
  await writeMeta(w.dir, id, { agentType: 'backend-pty', description: 'B4 phase 1' });
  await appendLines(w.dir, id, [userLine(new Date().toISOString())]);
}

interface Wired {
  w: Harness;
  m: Awaited<ReturnType<typeof makeManager>>;
  id: string;
  client: FakeClient;
  cleanup: () => Promise<void>;
}

/**
 * A SessionManager session fed by a harness watcher, the way server/index.ts
 * wires them; `now` steps the watcher's clock (the launch-time rule), never
 * the manager's.
 */
export async function wired(opts: { now?: () => number } = {}): Promise<Wired> {
  const w = await makeWatcher(opts.now === undefined ? {} : { now: opts.now });
  const m = await makeManager();
  const info = m.manager.create({ command: 'bash', args: ['-c', 'sleep 30'], cwd: m.root, cols: 80, rows: 24 });
  const client = new FakeClient();
  assert.notEqual(m.manager.attach(info.id, client.asWs()), null);
  w.watcher.start((_, report) => m.manager.setReport(info.id, report));
  return {
    w,
    m,
    id: info.id,
    client,
    cleanup: async (): Promise<void> => {
      await w.cleanup();
      await m.cleanup();
    },
  };
}

/** The last `info` frame `client` got that satisfies `ok`, waited for. */
export async function waitInfo(client: FakeClient, ok: (s: SessionInfo) => boolean, what: string): Promise<SessionInfo> {
  return waitUntil(() => client.infoFrames().filter(ok).at(-1), what, 5_000, 10);
}
