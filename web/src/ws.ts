/**
 * Per-session WebSocket client.
 *
 * URL is derived from location (the page is served by the backend): ws(s)
 * scheme from location.protocol, host from location.host, token from
 * window.__AUTH__ as the ?token= query param.
 *
 * Server->client attach ordering (protocol contract): 'replay' once, then
 * 'info', then 'exit' if already exited, then live 'data'. On EVERY (re)open
 * the server replays the scrollback's last REPLAY_MAX_LINES lines — the replay
 * handler must reset the terminal first (ui/terminal.ts does).
 *
 * Reconnect: on unexpected close, back off 0.5s..5s (x2); after a close for
 * being too slow (SLOW_CLIENT_CLOSE_CODE) straight to 5s. Before each retry
 * the session's existence is checked via GET /api/sessions — if it is gone
 * (or the token is stale after a backend restart), the socket reports 'dead'
 * so the pane can offer close/reassign.
 */
import type { ClientMessage, EarlyExit, ServerMessage, SessionInfo } from '../../shared/protocol.ts';
import { SLOW_CLIENT_CLOSE_CODE } from '../../shared/protocol.ts';
import { ApiError, authToken, getSessions } from './api.ts';
import { formatError, log } from './log.ts';
import { state } from './state.ts';

export type ConnState = 'connecting' | 'live' | 'reconnecting' | 'dead';

/**
 * `code=<n> reason=<text> clean=<bool>` for a log line. Written defensively:
 * a close handler must never throw because a field was missing (an
 * instrumentation line that breaks reconnect would be worse than no line),
 * and `reason` is server text — never terminal content.
 */
function closeInfo(ev?: CloseEvent): string {
  const code = typeof ev?.code === 'number' ? ev.code : 0;
  const reason = typeof ev?.reason === 'string' && ev.reason !== '' ? ev.reason : '-';
  return `code=${code} reason=${reason} clean=${ev?.wasClean === true}`;
}

export interface SocketHandlers {
  onReplay(data: string): void;
  onData(data: string): void;
  onInfo(session: SessionInfo): void;
  /** `early`: a Claude launch that died right after it started (D6), else undefined. */
  onExit(exitCode: number, early: EarlyExit | undefined): void;
  onAttention(): void;
  onConn(state: ConnState): void;
}

const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 5000;
/**
 * How long both reconnect loops idle while a restart WE asked for is in
 * flight. During that gap the old process is dying, the replacement has not
 * taken the port yet, and this page's token belongs to neither — so a retry
 * can only produce a rejected upgrade or a 401 that would kill the page. The
 * loops park here and re-check; if the restart fails, they resume by
 * themselves instead of having been silently switched off.
 */
const RESTART_HOLD_MS = 1000;
/**
 * Q9: the most UTF-16 code units one `input` frame carries. xterm hands a
 * whole paste to `onData` as one string, and the server cuts a frame over
 * MAX_SESSION_FRAME_BYTES (16 MiB, server/ws.ts) with 1009 — such a paste was
 * lost. 1 Mi units stay under the cap even if every one is JSON-escaped to
 * six bytes; the frames go out in order on one socket, so the PTY receives
 * the same bytes.
 */
const MAX_INPUT_FRAME_UNITS = 1024 * 1024;

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
    let opened = false;
    ws.onopen = () => {
      opened = true;
      log.info(`ws session ${this.sessionId} open`);
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
          // SIZE only — the scrollback itself is terminal content and never
          // leaves the browser through this channel.
          log.debug(`ws session ${this.sessionId} replay ${msg.data.length} chars`);
          this.#handlers.onReplay(msg.data);
          break;
        case 'data':
          this.#handlers.onData(msg.data);
          break;
        case 'info':
          this.#handlers.onInfo(msg.session);
          break;
        case 'exit': {
          // The frame is cast, not checked: `early` reaches the pane only as
          // an object with a string line, whatever the wire carried.
          const early = typeof msg.early?.line === 'string' ? { line: msg.early.line } : undefined;
          log.info(`ws session ${this.sessionId} exit code=${msg.exitCode}${early === undefined ? '' : ' early'}`);
          this.#handlers.onExit(msg.exitCode, early);
          break;
        }
        case 'attention':
          // May repeat per BEL burst — consumers treat it as idempotent.
          this.#handlers.onAttention();
          break;
      }
    };
    ws.onclose = (ev?: CloseEvent) => {
      if (this.#closed) return;
      log.info(`ws session ${this.sessionId} closed ${closeInfo(ev)}`);
      // The backoff restarts once a socket opened — unless the server closed it
      // for falling behind: reopening at once replays the scrollback into the
      // same slow tab and is closed again (Q9), so that retry waits the longest.
      if (ev?.code === SLOW_CLIENT_CLOSE_CODE) this.#delay = BACKOFF_MAX_MS;
      else if (opened) this.#delay = BACKOFF_MIN_MS;
      void this.#lost();
    };
    ws.onerror = () => {
      // A close event always follows; reconnect is handled there.
    };
  }

  async #lost(): Promise<void> {
    this.#ws = null;
    this.#handlers.onConn('reconnecting');
    if (state.restarting) {
      // Do NOT probe /api/sessions here: a 401 from the replacement backend
      // would mark this socket dead permanently, and the page is about to
      // reload onto a fresh token anyway.
      this.#hold();
      return;
    }
    try {
      const list = await getSessions();
      if (!list.some((s) => s.id === this.sessionId)) {
        this.#die();
        return;
      }
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        // THIS 401 is what armed the gap: `api.onAuthError` fires before the
        // rejection reaches here, and main.ts's recovery sets `restarting`
        // while it probes /health. So the flag is re-read AFTER the call, not
        // only before it — otherwise the very request that discovers the
        // restart is also the one that kills the pane, a beat before the page
        // reloads onto a healthy backend.
        if (state.restarting) {
          this.#hold();
          return;
        }
        // Backend restarted -> new token; this page can never reattach.
        this.#die();
        return;
      }
      // Network error / server briefly down: keep retrying on backoff.
      log.debug(`ws session ${this.sessionId} liveness check failed: ${formatError(err)}`);
    }
    if (this.#closed) return;
    log.info(`ws session ${this.sessionId} reconnect in ${this.#delay}ms`);
    this.#timer = window.setTimeout(() => {
      this.#timer = null;
      this.#open();
    }, this.#delay);
    this.#delay = Math.min(this.#delay * 2, BACKOFF_MAX_MS);
  }

  /**
   * Park the reconnect loop for one beat and re-enter `#lost()`. Used whenever
   * the restart gap is armed: the loop pauses and re-checks, so a restart that
   * never completes resumes the normal backoff by itself.
   */
  #hold(): void {
    this.#timer = window.setTimeout(() => {
      this.#timer = null;
      void this.#lost();
    }, RESTART_HOLD_MS);
  }

  #die(): void {
    if (!this.#closed) {
      log.warn(`ws session ${this.sessionId} dead — session gone or token stale`);
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

  /** In frames of at most MAX_INPUT_FRAME_UNITS, never between a surrogate pair's halves. */
  sendInput(data: string): void {
    let at = 0;
    do {
      let end = Math.min(at + MAX_INPUT_FRAME_UNITS, data.length);
      const last = data.charCodeAt(end - 1);
      if (end < data.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
      this.#send({ type: 'input', data: data.slice(at, end) });
      at = end;
    } while (at < data.length);
  }

  sendResize(cols: number, rows: number): void {
    this.#send({ type: 'resize', cols, rows });
  }

  sendSeen(): void {
    this.#send({ type: 'seen' });
  }

  /** User-initiated close: no reconnect, no further events. */
  close(): void {
    if (!this.#closed) log.info(`ws session ${this.sessionId} detached by the ui`);
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

// ---------------------------------------------------------------------------
// Presence channel (/ws/presence)
// ---------------------------------------------------------------------------

const PRESENCE_MIN_MS = 1000;
const PRESENCE_MAX_MS = 15000;
/** Latency probe interval — pings are tiny and lifecycle-inert server-side. */
const PRESENCE_PING_MS = 5000;

/**
 * Presence client — the backend's lifetime is bound to UI presence: one open
 * /ws/presence socket per window IS the lifecycle protocol. Opened once at
 * boot; on ANY close it reconnects on capped exponential backoff
 * INDEFINITELY. Failures are deliberately silent — presence must never block
 * the UI: the statusline's unreachable readout already covers a gone
 * backend, and a stale token (backend restarted) gets the REST layer's
 * reload takeover.
 *
 * On top of the bare socket, the channel answers `{"type":"ping","t":n}`
 * with a matching `pong` — used here to measure round-trip latency for the
 * statusline (`ws <n> ms`). `onLatency` gets the rounded ms per pong and
 * null when the socket drops.
 */
export function startPresence(onLatency?: (ms: number | null) => void): void {
  let delay = PRESENCE_MIN_MS;
  const open = (): void => {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(
      `${proto}//${location.host}/ws/presence?token=${encodeURIComponent(authToken())}`,
    );
    let pinger: number | null = null;
    ws.onopen = () => {
      delay = PRESENCE_MIN_MS;
      log.info('ws presence open');
      const ping = (): void => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping', t: performance.now() }));
        }
      };
      ping();
      pinger = window.setInterval(ping, PRESENCE_PING_MS);
    };
    ws.onmessage = (ev: MessageEvent) => {
      if (typeof ev.data !== 'string') return;
      let msg: unknown;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      const m = msg as { type?: unknown; t?: unknown };
      if (m.type === 'pong' && typeof m.t === 'number' && Number.isFinite(m.t)) {
        onLatency?.(Math.max(0, Math.round(performance.now() - m.t)));
      }
    };
    ws.onclose = (ev?: CloseEvent) => {
      if (pinger !== null) {
        clearInterval(pinger);
        pinger = null;
      }
      onLatency?.(null);
      if (state.restarting) {
        // Same gap, same rule as the session sockets: park, re-check, and
        // resume the normal backoff if the restart never completes.
        log.info(`ws presence closed ${closeInfo(ev)}; holding for the restart`);
        window.setTimeout(function hold(): void {
          if (state.restarting) window.setTimeout(hold, RESTART_HOLD_MS);
          else open();
        }, RESTART_HOLD_MS);
        return;
      }
      log.info(`ws presence closed ${closeInfo(ev)}; retry in ${delay}ms`);
      window.setTimeout(open, delay);
      delay = Math.min(delay * 2, PRESENCE_MAX_MS);
    };
    ws.onerror = () => {
      // A close event always follows; the retry is scheduled there.
    };
  };
  open();
}
