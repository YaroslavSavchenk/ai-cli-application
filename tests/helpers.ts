/**
 * Shared utilities for the backend test suite.
 *
 * Every test file boots its own real server process (`node server/index.ts`)
 * with AI_SM_DATA_DIR pointed at a fresh temp dir, discovers it through
 * runtime.json exactly like the launcher does, and tears everything down
 * (SIGTERM + temp dir removal) when finished.
 *
 * All waiting is condition-based with explicit timeouts — never bare sleeps.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import type {
  ClientMessage,
  RuntimeInfo,
  ServerMessage,
  SessionInfo,
} from '../shared/protocol.ts';

export const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

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
 * `opts.dataDir` reuses an existing data dir (journal rotation / restart
 * tests). The caller owns its cleanup: stop() will NOT remove it.
 */
export async function startTestServer(
  opts: { env?: Record<string, string>; dataDir?: string } = {},
): Promise<TestServer> {
  const tmpRoot =
    opts.dataDir === undefined ? await mkdtemp(join(tmpdir(), 'ai-sm-test-')) : null;
  // Deliberately a not-yet-existing subdir: the server must create it (0700).
  const dataDir = opts.dataDir ?? join(tmpRoot as string, 'data');
  const child = spawn(process.execPath, [join(projectRoot, 'server', 'index.ts')], {
    cwd: projectRoot,
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
