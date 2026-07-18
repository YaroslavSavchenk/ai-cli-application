/**
 * Per-session WebSocket client.
 *
 * URL is derived from location (the page is served by the backend): ws(s)
 * scheme from location.protocol, host from location.host, token from
 * window.__AUTH__ as the ?token= query param.
 *
 * Server->client attach ordering (protocol contract): 'replay' once, then
 * 'info', then 'exit' if already exited, then live 'data'. On EVERY (re)open
 * the server replays the full scrollback — the replay handler must reset the
 * terminal first (ui/terminal.ts does).
 *
 * Reconnect: on unexpected close, back off 0.5s..5s (x2). Before each retry
 * the session's existence is checked via GET /api/sessions — if it is gone
 * (or the token is stale after a backend restart), the socket reports 'dead'
 * so the pane can offer close/reassign.
 */
import type { ClientMessage, ServerMessage, SessionInfo } from '../../shared/protocol.ts';
import { ApiError, authToken, getSessions } from './api.ts';

export type ConnState = 'connecting' | 'live' | 'reconnecting' | 'dead';

export interface SocketHandlers {
  onReplay(data: string): void;
  onData(data: string): void;
  onInfo(session: SessionInfo): void;
  onExit(exitCode: number): void;
  onAttention(): void;
  onConn(state: ConnState): void;
}

const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 5000;

export class SessionSocket {
  readonly sessionId: string;
  readonly #handlers: SocketHandlers;
  #ws: WebSocket | null = null;
  #closed = false;
  #delay = BACKOFF_MIN_MS;
  #timer: number | null = null;

  constructor(sessionId: string, handlers: SocketHandlers) {
    this.sessionId = sessionId;
    this.#handlers = handlers;
    this.#handlers.onConn('connecting');
    this.#open();
  }

  #open(): void {
    if (this.#closed) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${location.host}/ws/sessions/${encodeURIComponent(this.sessionId)}?token=${encodeURIComponent(authToken())}`;
    const ws = new WebSocket(url);
    this.#ws = ws;
    ws.onopen = () => {
      this.#delay = BACKOFF_MIN_MS;
      this.#handlers.onConn('live');
    };
    ws.onmessage = (ev: MessageEvent) => {
      if (typeof ev.data !== 'string') return; // Protocol is JSON text frames only.
      let msg: ServerMessage;
      try {
        msg = JSON.parse(ev.data) as ServerMessage;
      } catch {
        return;
      }
      switch (msg.type) {
        case 'replay':
          this.#handlers.onReplay(msg.data);
          break;
        case 'data':
          this.#handlers.onData(msg.data);
          break;
        case 'info':
          this.#handlers.onInfo(msg.session);
          break;
        case 'exit':
          this.#handlers.onExit(msg.exitCode);
          break;
        case 'attention':
          // May repeat per BEL burst — consumers treat it as idempotent.
          this.#handlers.onAttention();
          break;
      }
    };
    ws.onclose = () => {
      if (!this.#closed) void this.#lost();
    };
    ws.onerror = () => {
      // A close event always follows; reconnect is handled there.
    };
  }

  async #lost(): Promise<void> {
    this.#ws = null;
    this.#handlers.onConn('reconnecting');
    try {
      const list = await getSessions();
      if (!list.some((s) => s.id === this.sessionId)) {
        this.#die();
        return;
      }
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        // Backend restarted -> new token; this page can never reattach.
        this.#die();
        return;
      }
      // Network error / server briefly down: keep retrying on backoff.
    }
    if (this.#closed) return;
    this.#timer = window.setTimeout(() => {
      this.#timer = null;
      this.#open();
    }, this.#delay);
    this.#delay = Math.min(this.#delay * 2, BACKOFF_MAX_MS);
  }

  #die(): void {
    if (!this.#closed) {
      this.#closed = true;
      this.#handlers.onConn('dead');
    }
  }

  get isOpen(): boolean {
    return this.#ws !== null && this.#ws.readyState === WebSocket.OPEN;
  }

  #send(msg: ClientMessage): void {
    if (this.#ws !== null && this.#ws.readyState === WebSocket.OPEN) {
      this.#ws.send(JSON.stringify(msg));
    }
  }

  sendInput(data: string): void {
    this.#send({ type: 'input', data });
  }

  sendResize(cols: number, rows: number): void {
    this.#send({ type: 'resize', cols, rows });
  }

  sendSeen(): void {
    this.#send({ type: 'seen' });
  }

  /** User-initiated close: no reconnect, no further events. */
  close(): void {
    this.#closed = true;
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    const ws = this.#ws;
    this.#ws = null;
    if (ws !== null) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      try {
        ws.close(1000);
      } catch {
        // Already closed.
      }
    }
  }
}
