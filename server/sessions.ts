/**
 * SessionManager: sessions are first-class server-side objects.
 *
 * A session = a real PTY (node-pty) + metadata + a bounded scrollback ring
 * buffer. It exists independently of any browser connection; clients attach
 * and detach freely and the whole buffer is replayed on attach. On PTY exit
 * the session stays listed (status 'exited', buffer intact) until DELETEd.
 *
 * command + args are spawned as an argv array — client-supplied values never
 * enter a shell string. This is what keeps multi-CLI support generic.
 */
import { randomUUID } from 'node:crypto';
import * as pty from 'node-pty';
import type { WebSocket } from 'ws';
import type { SessionInfo, ServerMessage } from '../shared/protocol.ts';
import type { Logger } from './config.ts';

/** Scrollback cap: 1 MiB of bytes (not lines). Oldest chunks are dropped. */
export const SCROLLBACK_MAX_BYTES = 1024 * 1024;

/** Byte-capped ring buffer of output chunks; drops oldest chunks when over cap. */
export class RingBuffer {
  #chunks: Buffer[] = [];
  #bytes = 0;
  readonly #maxBytes: number;

  constructor(maxBytes: number = SCROLLBACK_MAX_BYTES) {
    this.#maxBytes = maxBytes;
  }

  append(data: string): void {
    let chunk = Buffer.from(data, 'utf8');
    if (chunk.byteLength > this.#maxBytes) {
      // A single chunk larger than the whole cap: keep only its tail.
      chunk = chunk.subarray(chunk.byteLength - this.#maxBytes);
      this.#chunks = [];
      this.#bytes = 0;
    }
    this.#chunks.push(chunk);
    this.#bytes += chunk.byteLength;
    while (this.#bytes > this.#maxBytes && this.#chunks.length > 1) {
      const dropped = this.#chunks.shift();
      if (dropped !== undefined) this.#bytes -= dropped.byteLength;
    }
  }

  get byteLength(): number {
    return this.#bytes;
  }

  toString(): string {
    return Buffer.concat(this.#chunks).toString('utf8');
  }
}

interface Session {
  info: SessionInfo;
  pty: pty.IPty | null;
  buffer: RingBuffer;
  clients: Set<WebSocket>;
}

export interface CreateSessionOptions {
  projectId?: string;
  cwd: string;
  command: string;
  args: string[];
  title?: string;
  cols: number;
  rows: number;
}

const BEL_CHAR = '\u0007';

export class SessionManager {
  #sessions = new Map<string, Session>();
  readonly #log: Logger;

  constructor(log: Logger) {
    this.#log = log;
  }

  list(): SessionInfo[] {
    return [...this.#sessions.values()].map((s) => ({ ...s.info }));
  }

  get(id: string): SessionInfo | undefined {
    const s = this.#sessions.get(id);
    return s === undefined ? undefined : { ...s.info };
  }

  has(id: string): boolean {
    return this.#sessions.has(id);
  }

  /** Spawn the PTY and register the session. Throws if the spawn fails. */
  create(opts: CreateSessionOptions): SessionInfo {
    const id = randomUUID();
    const proc = pty.spawn(opts.command, opts.args, {
      name: 'xterm-256color',
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.cwd,
      env: {
        ...(process.env as Record<string, string>),
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
      },
    });

    const info: SessionInfo = {
      id,
      ...(opts.projectId !== undefined ? { projectId: opts.projectId } : {}),
      title: opts.title !== undefined && opts.title !== '' ? opts.title : opts.command,
      command: opts.command,
      args: [...opts.args],
      cwd: opts.cwd,
      status: 'running',
      cols: opts.cols,
      rows: opts.rows,
      createdAt: new Date().toISOString(),
      attention: false,
    };

    const session: Session = { info, pty: proc, buffer: new RingBuffer(), clients: new Set() };
    this.#sessions.set(id, session);

    proc.onData((data) => {
      session.buffer.append(data);
      this.#broadcast(session, { type: 'data', data });
      if (data.includes(BEL_CHAR)) {
        session.info.attention = true;
        this.#broadcast(session, { type: 'attention' });
      }
    });

    proc.onExit(({ exitCode }) => {
      session.info.status = 'exited';
      session.info.exitCode = exitCode;
      session.pty = null;
      this.#broadcast(session, { type: 'exit', exitCode });
      this.#log('info', `session ${id} exited with code ${exitCode}`);
    });

    this.#log(
      'info',
      `session ${id} spawned: ${opts.command} ${JSON.stringify(opts.args)} in ${opts.cwd} (${opts.cols}x${opts.rows})`,
    );
    return { ...info };
  }

  /**
   * Attach a client: replay the whole scrollback buffer FIRST, then an info
   * snapshot (and an exit notice if already exited), then live traffic.
   * ws frames are delivered in send order per socket, and the client is only
   * added to the broadcast set after replay is queued, so replay always
   * precedes any live data on this socket.
   */
  attach(id: string, ws: WebSocket): boolean {
    const session = this.#sessions.get(id);
    if (session === undefined) return false;
    this.#send(ws, { type: 'replay', data: session.buffer.toString() });
    this.#send(ws, { type: 'info', session: { ...session.info } });
    if (session.info.status === 'exited') {
      this.#send(ws, { type: 'exit', exitCode: session.info.exitCode ?? 0 });
    }
    session.clients.add(ws);
    ws.on('close', () => session.clients.delete(ws));
    return true;
  }

  write(id: string, data: string): void {
    const session = this.#sessions.get(id);
    if (session === undefined || session.pty === null) return;
    session.pty.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const session = this.#sessions.get(id);
    if (session === undefined) return;
    session.info.cols = cols;
    session.info.rows = rows;
    if (session.pty !== null) session.pty.resize(cols, rows);
  }

  markSeen(id: string): boolean {
    const session = this.#sessions.get(id);
    if (session === undefined) return false;
    session.info.attention = false;
    return true;
  }

  /** Kill the PTY (if running), close all attached clients, remove the session. */
  destroy(id: string): boolean {
    const session = this.#sessions.get(id);
    if (session === undefined) return false;
    this.#sessions.delete(id);
    if (session.pty !== null) {
      try {
        session.pty.kill();
      } catch (err) {
        this.#log('warn', `session ${id} kill failed: ${String(err)}`);
      }
      session.pty = null;
    }
    for (const ws of session.clients) {
      try {
        ws.close(1000, 'session deleted');
      } catch {
        // Socket already gone.
      }
    }
    session.clients.clear();
    this.#log('info', `session ${id} deleted`);
    return true;
  }

  /** Kill every PTY (server shutdown). Sessions die with the server by design. */
  destroyAll(): void {
    for (const id of [...this.#sessions.keys()]) this.destroy(id);
  }

  #broadcast(session: Session, message: ServerMessage): void {
    for (const ws of session.clients) this.#send(ws, message);
  }

  #send(ws: WebSocket, message: ServerMessage): void {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

}
