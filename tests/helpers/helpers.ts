/**
 * Shared utilities for the backend test suite.
 *
 * Every test file boots its own real server process (`node server/index.ts`)
 * with AI_SM_DATA_DIR pointed at a fresh temp dir, discovers it through
 * runtime.json exactly like the launcher does, and tears everything down
 * (SIGTERM + temp dir removal) when finished.
 *
 * All waiting is condition-based with explicit timeouts — never bare sleeps.
 * `sleep()` below is for the few fixed pauses that ARE the test (a window
 * that must pass, a TTL that must run out); where a condition exists, wait
 * on it with `waitUntil` instead.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { accessSync, constants, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import type {
  ClientMessage,
  HistoryEntry,
  RuntimeInfo,
  ServerMessage,
  SessionInfo,
} from '../../shared/protocol.ts';

export const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * A fixed pause of `ms` milliseconds. Looks `setTimeout` up at call time, so
 * a test that swaps the global timer gets the same behaviour an inline
 * `new Promise((r) => setTimeout(r, ms))` had.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Eight zero-delay timer turns: long enough for a logger's send → decide → send-again chain. */
export async function settleTimers(): Promise<void> {
  for (let i = 0; i < 8; i++) await delay(0);
}

/** One `setImmediate` turn: every callback already queued has run. */
export function nextImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** The part of a fetch `Response` the frontend's JSON calls read: 200 with `body`, or a 500. */
export function jsonResponse(
  body: unknown,
  ok: boolean,
): { ok: boolean; status: number; json: () => Promise<unknown> } {
  return { ok, status: ok ? 200 : 500, json: async () => body };
}

/** A finished Claude conversation in the history list, `id` everywhere it shows. */
export function mkHistoryEntry(id: string): HistoryEntry {
  return {
    id,
    conversation: true,
    sessionId: `s-${id}`,
    cwd: '/tmp/work',
    command: 'claude',
    args: ['--model', 'opus'],
    title: id,
    createdAt: '2026-09-06T10:00:00.000Z',
    lastUsedAt: '2026-09-06T10:00:00.000Z',
    ended: { at: '2026-09-06T11:00:00.000Z', reason: 'exit' },
  };
}

/** True when the suite runs as root, which ignores file mode bits. */
export const IS_ROOT = process.getuid?.() === 0;

/** `{ skip: SKIP_IF_ROOT }` for a test that proves a permission refusal. */
export const SKIP_IF_ROOT: string | false = IS_ROOT ? 'running as root' : false;

/** A fresh directory `<os tmpdir>/<prefix>XXXXXX`; remove it with `removeTempDir`. */
export function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

/** `makeTempDir` for synchronous setup code. */
export function makeTempDirSync(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A file of this checkout as text: `readSource('web', 'src', 'main.ts')` or `readSource('web/src/main.ts')`. */
export function readSource(...parts: string[]): string {
  return readFileSync(join(projectRoot, ...parts), 'utf8');
}

/**
 * Several files of this checkout as ONE text, joined in the order given:
 * `readSources('web/src/main.ts', 'web/src/main-shell.ts')` — for a source pin
 * whose text a split (O8, 2026-09-23) spread over an original and its pieces.
 */
export function readSources(...paths: string[]): string {
  return paths.map((p) => readSource(p)).join('\n');
}

/**
 * `web/src/ui/files.ts` and the pieces O8 (2026-09-23) split it into, in
 * reading order — `readSources(...FILES_PANEL_SOURCES)` is the Files panel's
 * source as ONE text, for a pin that was written against the single module.
 */
export const FILES_PANEL_SOURCES = [
  'web/src/ui/files.ts',
  'web/src/ui/files-destinations.ts',
  'web/src/ui/files-ctx.ts',
  'web/src/ui/files-tree.ts',
  'web/src/ui/files-git.ts',
  'web/src/ui/files-keys.ts',
  'web/src/ui/files-menu.ts',
  'web/src/ui/files-naming.ts',
  'web/src/ui/files-render.ts',
] as const;

/** Every file under `dir`, recursively in readdir order, whose NAME matches `re`. */
export function filesUnder(dir: string, re: RegExp): string[] {
  const files: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (re.test(e.name)) files.push(full);
    }
  };
  walk(dir);
  return files;
}

/** Every path git tracks in this checkout, repo-relative. */
export function trackedFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z'], {
    cwd: projectRoot,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return out.split('\0').filter((p) => p.length > 0);
}

/** The first executable `exe` on PATH, or null. */
export function onPath(exe: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, exe);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

/** Whether `path` exists (anything `stat` can see). */
export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** git, argv only, with an identity of its own so a developer's config cannot break it. */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.email=t@example.com', '-c', 'user.name=T', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8' },
  );
}

/** Poll `fn` until it returns a defined value; throw after `timeoutMs`. */
export async function waitUntil<T>(
  fn: () => T | undefined | Promise<T | undefined>,
  what: string,
  timeoutMs = 15_000,
  intervalMs = 50,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    }
    await delay(intervalMs);
  }
}

export interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface TestServer {
  child: ChildProcess;
  /** mkdtemp root removed by stop(); null when the caller owns the data dir. */
  tmpRoot: string | null;
  /** The AI_SM_DATA_DIR value. The server itself must create it (mode 0700). */
  dataDir: string;
  runtimeFile: string;
  runtime: RuntimeInfo;
  port: number;
  token: string;
  baseUrl: string;
  /** Resolves when the server process exits. */
  exit: Promise<ExitInfo>;
  /** SIGTERM the server (SIGKILL fallback) and remove the temp dir. Idempotent. */
  stop(): Promise<void>;
}

/**
 * Spawn `node server/index.ts` with a fresh data dir, wait until runtime.json
 * exists AND /health answers 200, and return a handle with port + token.
 *
 * Lifecycle note: the backend is presence-bound — with no presence/session
 * WS connected it shuts itself down after the startup grace. Tests hold no
 * presence socket, so both graces default to a generous 10 minutes here;
 * lifecycle-specific tests override via `opts.env`
 * (AI_SM_STARTUP_GRACE_MS / AI_SM_GRACE_MS).
 *
 * `opts.dataDir` reuses an existing data dir (session-history / restart
 * tests). The caller owns its cleanup: stop() will NOT remove it.
 *
 * `opts.entry` / `opts.cwd` start a backend that is NOT this checkout — the
 * installed-mode tests boot an unpacked bundle fixture (`<app>/current/server/
 * index.ts`) so `bundle.json`, `web/dist` and `<app>/current` are the ones the
 * process really resolves. Both default to the repo, so every existing caller
 * is unchanged.
 */
export async function startTestServer(
  opts: {
    env?: Record<string, string>;
    dataDir?: string;
    entry?: string;
    cwd?: string;
  } = {},
): Promise<TestServer> {
  const tmpRoot =
    opts.dataDir === undefined ? await mkdtemp(join(tmpdir(), 'ai-sm-test-')) : null;
  // Deliberately a not-yet-existing subdir: the server must create it (0700).
  const dataDir = opts.dataDir ?? join(tmpRoot as string, 'data');
  const child = spawn(process.execPath, [opts.entry ?? join(projectRoot, 'server', 'index.ts')], {
    cwd: opts.cwd ?? projectRoot,
    env: {
      ...process.env,
      AI_SM_DATA_DIR: dataDir,
      AI_SM_STARTUP_GRACE_MS: '600000',
      AI_SM_GRACE_MS: '600000',
      ...opts.env,
    },
    stdio: 'ignore', // The server must not depend on stdout in any way.
  });
  let exited = false;
  const exit: Promise<ExitInfo> = new Promise((resolve) => {
    child.once('exit', (code, signal) => {
      exited = true;
      resolve({ code, signal });
    });
  });
  const runtimeFile = join(dataDir, 'runtime.json');

  let runtime: RuntimeInfo;
  try {
    runtime = await waitUntil<RuntimeInfo>(async () => {
      if (exited) throw new Error('server process exited before becoming healthy');
      let raw: string;
      try {
        raw = await readFile(runtimeFile, 'utf8');
      } catch {
        return undefined;
      }
      let parsed: RuntimeInfo;
      try {
        parsed = JSON.parse(raw) as RuntimeInfo;
      } catch {
        return undefined; // Should not happen (atomic write), but be safe.
      }
      if (typeof parsed.port !== 'number') return undefined;
      try {
        const res = await fetch(`http://127.0.0.1:${parsed.port}/health`);
        if (res.status !== 200) return undefined;
      } catch {
        return undefined;
      }
      return parsed;
    }, 'server startup (runtime.json + /health)');
  } catch (err) {
    child.kill('SIGKILL');
    if (tmpRoot !== null) await rm(tmpRoot, { recursive: true, force: true });
    throw err;
  }

  return {
    child,
    tmpRoot,
    dataDir,
    runtimeFile,
    runtime,
    port: runtime.port,
    token: runtime.token,
    baseUrl: `http://127.0.0.1:${runtime.port}`,
    exit,
    async stop(): Promise<void> {
      if (!exited) {
        child.kill('SIGTERM');
        const done = await Promise.race([exit, delay(5_000).then(() => undefined)]);
        if (done === undefined) {
          child.kill('SIGKILL');
          await exit;
        }
      }
      if (tmpRoot !== null) await rm(tmpRoot, { recursive: true, force: true });
    },
  };
}

/** Read server.log from the test server's data dir ('' if absent). */
export async function readServerLog(server: TestServer): Promise<string> {
  try {
    return await readFile(join(server.dataDir, 'server.log'), 'utf8');
  } catch {
    return '';
  }
}

/**
 * Wait until server.log contains at least `count` occurrences of `needle`.
 * Lifecycle tests key off the controller's log lines (timer armed/cancelled/
 * expired) — that is the deterministic signal, never a bare sleep.
 */
export async function waitForLog(
  server: TestServer,
  needle: string,
  opts: { count?: number; timeoutMs?: number } = {},
): Promise<string> {
  const count = opts.count ?? 1;
  return waitUntil(
    async () => {
      const log = await readServerLog(server);
      return log.split(needle).length - 1 >= count ? log : undefined;
    },
    `server.log to contain ${JSON.stringify(needle)} x${count}`,
    opts.timeoutMs ?? 10_000,
    25,
  );
}

/**
 * Wait until server.log stops growing: the same size for LOG_QUIET_POLLS polls
 * LOG_QUIET_INTERVAL_MS apart (10 x 50 ms, no less than the 500 ms pause it
 * replaced; the pipe chunks queued behind a SIGKILL land within ms on an idle
 * host, and a busy runner that keeps writing only makes the wait longer). For
 * a line that must be written ONCE: counting before the late writers are done
 * lets a regression pass by being read too early. Counts polls, not
 * wall-clock time — WSL2's wall clock jumps.
 */
const LOG_QUIET_POLLS = 10;
const LOG_QUIET_INTERVAL_MS = 50;
export async function waitForLogQuiet(
  server: TestServer,
  timeoutMs = 15_000,
): Promise<string> {
  let lastSize = -1;
  let stable = 0;
  return waitUntil(
    async () => {
      const log = await readServerLog(server);
      const size = Buffer.byteLength(log);
      if (size !== lastSize) {
        lastSize = size;
        stable = 0;
        return undefined;
      }
      stable += 1;
      return stable >= LOG_QUIET_POLLS ? log : undefined;
    },
    `server.log to stop growing for ${LOG_QUIET_POLLS} polls`,
    timeoutMs,
    LOG_QUIET_INTERVAL_MS,
  );
}

// ---------------------------------------------------------------------------
// REST helpers
// ---------------------------------------------------------------------------

export interface ApiResult {
  status: number;
  body: unknown;
  headers: Headers;
}

/** Authenticated JSON request against the test server. */
export async function api(
  server: TestServer,
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResult> {
  const headers: Record<string, string> = { 'x-auth-token': server.token };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${server.baseUrl}${path}`, init);
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    // Non-JSON body — keep the raw text.
  }
  return { status: res.status, body: parsed, headers: res.headers };
}

export interface RawResult {
  status: number;
  body: string;
  headers: NodeJS.Dict<string | string[]>;
}

/**
 * Raw node:http request — needed where fetch() forbids or normalizes things:
 * overriding the Host header, sending arbitrary Origin values, sending
 * un-normalized `..` path segments, and sending a RAW body that is not valid
 * JSON (fetch would happily send it too, but this keeps every hostile-request
 * shape in one place).
 */
export function rawRequest(
  port: number,
  opts: {
    method?: string;
    path: string;
    headers?: Record<string, string>;
    /** Sent verbatim — no JSON encoding, no content-type unless you set one. */
    body?: string;
  },
): Promise<RawResult> {
  return new Promise((resolve, reject) => {
    const headers = { ...(opts.headers ?? {}) };
    if (opts.body !== undefined) {
      headers['content-length'] = String(Buffer.byteLength(opts.body));
    }
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: opts.method ?? 'GET',
        path: opts.path,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
            headers: res.headers,
          }),
        );
      },
    );
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

/** POST /api/sessions and return the created SessionInfo (throws on non-201). */
export async function createSession(
  server: TestServer,
  body: Record<string, unknown>,
): Promise<SessionInfo> {
  const res = await api(server, 'POST', '/api/sessions', body);
  if (res.status !== 201) {
    throw new Error(`session create failed: HTTP ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body as SessionInfo;
}

/** GET /api/sessions and return the entry for `id` (or undefined). */
export async function getSession(
  server: TestServer,
  id: string,
): Promise<SessionInfo | undefined> {
  const res = await api(server, 'GET', '/api/sessions');
  if (res.status !== 200) {
    throw new Error(`GET /api/sessions failed: HTTP ${res.status}`);
  }
  return (res.body as SessionInfo[]).find((s) => s.id === id);
}

// ---------------------------------------------------------------------------
// WebSocket helpers
// ---------------------------------------------------------------------------

export function wsUrl(server: TestServer, sessionId: string, token?: string): string {
  return `ws://127.0.0.1:${server.port}/ws/sessions/${sessionId}?token=${token ?? server.token}`;
}

/** URL of the presence channel; pass '' as token to omit the query entirely. */
export function presenceUrl(server: TestServer, token?: string): string {
  const t = token ?? server.token;
  return `ws://127.0.0.1:${server.port}/ws/presence${t === '' ? '' : `?token=${t}`}`;
}

/** A connected WS client that records every server frame in arrival order. */
export class WsClient {
  readonly ws: WebSocket;
  readonly messages: ServerMessage[] = [];
  closed = false;
  closeInfo: { code: number; reason: string } | undefined;

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on('error', () => {
      // Swallow post-open errors; tests assert on frames/close state instead.
    });
    ws.on('message', (raw, isBinary) => {
      if (isBinary) return; // Protocol is JSON text frames only.
      const text = Array.isArray(raw)
        ? Buffer.concat(raw).toString('utf8')
        : (raw as Buffer).toString('utf8');
      try {
        this.messages.push(JSON.parse(text) as ServerMessage);
      } catch {
        throw new Error(`server sent a non-JSON ws frame: ${text.slice(0, 200)}`);
      }
    });
    ws.on('close', (code, reason) => {
      this.closed = true;
      this.closeInfo = { code, reason: reason.toString() };
    });
  }

  /** Connect and resolve once the socket is open (reject on failure/timeout). */
  static connect(url: string, headers?: Record<string, string>): Promise<WsClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, headers !== undefined ? { headers } : {});
      const client = new WsClient(ws);
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error(`timed out connecting to ${url}`));
      }, 10_000);
      ws.once('open', () => {
        clearTimeout(timer);
        resolve(client);
      });
      ws.once('error', (err) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  send(msg: ClientMessage): void {
    this.ws.send(JSON.stringify(msg));
  }

  /** All terminal bytes seen so far: replay + live data concatenated in arrival order. */
  output(): string {
    let out = '';
    for (const m of this.messages) {
      if (m.type === 'replay' || m.type === 'data') out += m.data;
    }
    return out;
  }

  /** Wait for the first frame of `type` at index >= fromIndex. */
  async waitForMessage<T extends ServerMessage['type']>(
    type: T,
    opts: { fromIndex?: number; timeoutMs?: number } = {},
  ): Promise<Extract<ServerMessage, { type: T }>> {
    const from = opts.fromIndex ?? 0;
    const timeoutMs = opts.timeoutMs ?? 10_000;
    try {
      return await waitUntil(
        () => {
          for (let i = from; i < this.messages.length; i += 1) {
            const m = this.messages[i];
            if (m !== undefined && m.type === type) {
              return m as Extract<ServerMessage, { type: T }>;
            }
          }
          return undefined;
        },
        `ws '${type}' frame`,
        timeoutMs,
        25,
      );
    } catch (err) {
      const types = this.messages.map((m) => m.type).join(', ');
      throw new Error(
        `${err instanceof Error ? err.message : String(err)}; frames received so far: [${types}]`,
      );
    }
  }

  /** Wait until the concatenated terminal output contains `needle`. */
  async waitForOutput(needle: string, timeoutMs = 10_000): Promise<string> {
    try {
      return await waitUntil(
        () => {
          const out = this.output();
          return out.includes(needle) ? out : undefined;
        },
        `terminal output containing ${JSON.stringify(needle)}`,
        timeoutMs,
        25,
      );
    } catch (err) {
      const tail = this.output().slice(-400);
      throw new Error(
        `${err instanceof Error ? err.message : String(err)}; output tail: ${JSON.stringify(tail)}`,
      );
    }
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise((resolve) => {
      this.ws.once('close', () => resolve());
      this.ws.close();
    });
  }
}

/**
 * Expect the WS upgrade to be REJECTED before any data frame is delivered.
 * Resolves with the client error message (e.g. "Unexpected server response: 401").
 */
export function wsExpectRejected(
  url: string,
  headers?: Record<string, string>,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, headers !== undefined ? { headers } : {});
    let sawFrame = false;
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error(`timed out waiting for ws rejection of ${url}`));
    }, 10_000);
    ws.on('message', () => {
      sawFrame = true;
    });
    ws.once('open', () => {
      clearTimeout(timer);
      ws.terminate();
      reject(new Error('websocket unexpectedly connected'));
    });
    ws.once('error', (err) => {
      clearTimeout(timer);
      if (sawFrame) {
        reject(new Error('server delivered a data frame before rejecting the upgrade'));
      } else {
        resolve(err instanceof Error ? err.message : String(err));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// In-process teardown: waiting out the LATE writers before removing a temp dir
// ---------------------------------------------------------------------------
//
// Tests that mount server pieces in-process (SessionManager + SessionHistory +
// createLogger, all pointed at one mkdtemp dir) have an asynchronous tail their
// teardown cannot see:
//
//   * `sessions.destroyAll()` only KILLS the ptys. node-pty emits `exit` a few
//     ticks later, and server/sessions.ts's onExit handler then writes into the
//     data dir synchronously — `session <id> exited with code <n>` and
//     `<id> totals: …` through appendFileSync on server.log.
//   * a WebSocket closed by the server logs its `detached …` / `presence
//     disconnected …` line when the close handshake completes, which can be
//     after the CLIENT already saw the close frame.
//
// An `rm(dir, { recursive: true })` racing those writes fails with ENOTEMPTY:
// the line recreates server.log between rm's unlink pass and its rmdir. Seen on
// a loaded GitHub Actions runner (run 34248854109); reproduced locally at ~5%
// with the process pinned to one busy CPU. The cure is to wait for the writers'
// own log lines — they are the observable end of each handler — and to keep
// rm's retries as a backstop.

/** Occurrences of `needle` in `haystack` (plain substring, non-overlapping). */
function countOccurrences(haystack: string, needle: string): number {
  // An empty needle never advances the index below — the loop would spin
  // forever, and `npm test` has no per-test timeout to cut it short. Failing
  // loudly beats returning 0, which would make waitForLogLines spin out its
  // full timeout on a typo instead of naming the mistake.
  if (needle === '') throw new Error('countOccurrences: empty needle');
  let count = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) {
    count += 1;
  }
  return count;
}

/**
 * Wait until `logFile` contains each needle at least `expected[needle]` times.
 * A missing file counts as empty (the logger creates it on the first line).
 */
export async function waitForLogLines(
  logFile: string,
  expected: Readonly<Record<string, number>>,
  what: string,
  timeoutMs = 10_000,
): Promise<void> {
  const needles = Object.entries(expected);
  if (needles.length === 0) return;
  let text = '';
  try {
    await waitUntil(
      () => {
        try {
          text = readFileSync(logFile, 'utf8');
        } catch {
          text = '';
        }
        return needles.every(([needle, min]) => countOccurrences(text, needle) >= min)
          ? true
          : undefined;
      },
      what,
      timeoutMs,
      25,
    );
  } catch (err) {
    const missing = needles
      .filter(([needle, min]) => countOccurrences(text, needle) < min)
      .map(([needle, min]) => `${JSON.stringify(needle)} x${min}`)
      .join(', ');
    throw new Error(
      `${err instanceof Error ? err.message : String(err)}; still missing from ${logFile}: ${missing}`,
    );
  }
}

/** The narrow slice of SessionManager this teardown helper needs. */
interface DestroyableSessions {
  list(): SessionInfo[];
  destroyAll(): void;
}

/**
 * `destroyAll()` plus a deterministic wait for every killed pty's exit handler
 * to have finished writing. `<id> totals:` is the LAST line that handler emits,
 * so one per session that existed at teardown is the settle point.
 *
 * It settles PTY EXITS ONLY — and, because every dir-touching effect in that
 * exit handler is synchronous and `totals:` is its last line, the history.json
 * and session-settings writes with them. The OTHER late writer named above, a
 * WebSocket's `detached …` / `presence disconnected …` line, is NOT covered:
 * wait for those with an explicit `waitForLogLines`, as the closeAll test does.
 *
 * Requires the manager's logger to be at level `debug`/`info` and to write to
 * `logFile` — which is what the in-process harnesses do.
 */
export async function destroyAllAndSettle(
  sessions: DestroyableSessions,
  logFile: string,
  timeoutMs = 10_000,
): Promise<void> {
  const ids = sessions.list().map((s) => s.id);
  sessions.destroyAll();
  if (ids.length === 0) return;
  await waitForLogLines(
    logFile,
    Object.fromEntries(ids.map((id) => [`${id} totals:`, 1])),
    `every destroyed session's pty exit to be logged (${ids.length} session(s))`,
    timeoutMs,
  );
}

/**
 * Remove a test's temp dir. Retries are a BACKSTOP for a late writer nobody
 * waited for — never the primary defence, because a retry that succeeds hides
 * the race instead of proving it is gone.
 */
export async function removeTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
