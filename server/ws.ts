/**
 * WebSocket upgrade handling: the per-session attach protocol and the
 * presence channel.
 *
 * Paths: /ws/sessions/:id?token=<token> and /ws/presence?token=<token>.
 * On both, the token, Host and Origin are all validated BEFORE the upgrade
 * completes — a rejected client never receives any data. Multiple
 * concurrent clients per session are allowed.
 *
 * Session frames, client->server: {type:'input',data} | {type:'resize',cols,rows} | {type:'seen'}
 * server->client frames are produced by SessionManager (replay/info/data/exit/attention).
 *
 * Presence: a connection IS the signal — no messages required. Inbound
 * frames are ignored EXCEPT a well-formed {type:'ping',t:<finite number>},
 * which is echoed back as {type:'pong',t} for latency measurement; frames
 * over MAX_PRESENCE_FRAME_BYTES close the socket (1009). Ping traffic never
 * touches the lifecycle counters. Both WS paths feed the LifecycleController
 * counters (presenceCount / attachedCount) that gate the idle-shutdown
 * timer; close and error each decrement exactly once.
 */
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import type { PongMessage } from '../shared/protocol.ts';
import { tokenMatches, hostAllowed, originAllowed } from './auth.ts';
import { SessionManager } from './sessions.ts';
import { LifecycleController } from './lifecycle.ts';
import { plainObject } from './sanitise.ts';
import { describeError, isValidDim, scoped, MAX_LOGGED_ROUTE_CHARS, type Logger } from './config.ts';

interface WsDeps {
  token: string;
  getPort: () => number;
  sessions: SessionManager;
  lifecycle: LifecycleController;
  log: Logger;
  /**
   * The budget for UNAUTHENTICATED log lines. The SAME instance the HTTP access
   * log uses (constructed in server/index.ts): one ceiling for both surfaces,
   * because an attacker chooses freely between them.
   */
  allowRefusalLine: () => boolean;
}

/**
 * Presence frames are tiny (ping/pong only). Enforced as the ws maxPayload
 * of the presence WebSocketServer, so an oversized frame is cut off during
 * receive (1009 close) instead of being buffered in full.
 */
const MAX_PRESENCE_FRAME_BYTES = 1024;

/**
 * The largest session frame accepted (Q9) — the ws default is 100 MiB, buffered
 * whole before a handler sees it. The browser's biggest frame is a paste:
 * xterm hands the whole clipboard text to `onData` as ONE string, which
 * `web/src/ws.ts` sends in `input` frames of at most 1 Mi UTF-16 units — at
 * most 6 MiB of JSON even with every unit escaped (a file drop goes over
 * HTTP, never this socket). Over the cap, ws closes the socket 1009 while
 * receiving and the browser reconnects with the replay.
 */
const MAX_SESSION_FRAME_BYTES = 16 * 1024 * 1024;

function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

/**
 * The upgrade listener, plus the one thing the RESTART path needs from this
 * module: a way to close every live socket with a proper close frame.
 *
 * It stays CALLABLE (`server.on('upgrade', handler)`) — the extra member is a
 * property on the function, so nothing about how it is registered changes.
 */
export type UpgradeHandler = ((req: IncomingMessage, socket: Duplex, head: Buffer) => void) & {
  /**
   * Close every open WebSocket on both channels. Returns how many were told to
   * go. Used by the restart handoff with 1012 "service restart", the code a
   * client is supposed to read as "come back in a moment" rather than an error.
   */
  closeAll: (code: number, reason: string) => number;
};

export function createUpgradeHandler(deps: WsDeps): UpgradeHandler {
  const { token, sessions, lifecycle, log } = deps;
  const wsLog = scoped(log, 'ws');
  // Host/Origin/token all fail BEFORE the upgrade, i.e. every reject() below is
  // reachable by any page on the machine. The line is budgeted per minute for
  // that reason; the socket is always rejected, budget or not.
  const allowRefusalLine = deps.allowRefusalLine;
  /** Reject + one info line. The reason is a CONSTANT — never request data. */
  const reject = (socket: Duplex, status: number, reason: string, path: string, why: string): void => {
    if (allowRefusalLine()) wsLog('info', `upgrade rejected ${status} on ${path}: ${why}`);
    rejectUpgrade(socket, status, reason);
  };
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_SESSION_FRAME_BYTES });
  const presenceWss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_PRESENCE_FRAME_BYTES,
  });

  const handler = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const port = deps.getPort();
    // Parsed ONCE (Q11). An unparseable target (`//[`) is refused below with a
    // 400 — before Q11 a second, unguarded parse threw out of this listener,
    // and the uncaughtException ended the backend with every session in it.
    let url: URL | undefined;
    try {
      url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    } catch {
      url = undefined;
    }
    // The pathname ONLY: a ws url carries ?token=<the app token> in its query,
    // so the raw url must never be logged. Truncated, because an upgrade target
    // is attacker-chosen and unbounded. Unparseable -> '?'.
    const path = url === undefined ? '?' : url.pathname.slice(0, MAX_LOGGED_ROUTE_CHARS);
    if (!hostAllowed(req.headers.host, port)) {
      reject(socket, 403, 'Forbidden', path, 'host not allowed');
      return;
    }
    const origin = Array.isArray(req.headers.origin) ? req.headers.origin[0] : req.headers.origin;
    if (!originAllowed(origin, port)) {
      reject(socket, 403, 'Forbidden', path, 'origin not allowed');
      return;
    }

    if (url === undefined) {
      reject(socket, 400, 'Bad Request', path, 'unparseable target');
      return;
    }

    if (url.pathname === '/ws/presence') {
      if (!tokenMatches(token, url.searchParams.get('token') ?? undefined)) {
        reject(socket, 401, 'Unauthorized', path, 'bad or missing token');
        return;
      }
      presenceWss.handleUpgrade(req, socket, head, (ws) => {
        attachPresence(ws);
      });
      return;
    }

    const match = /^\/ws\/sessions\/([^/]+)$/.exec(url.pathname);
    if (match === null) {
      reject(socket, 404, 'Not Found', path, 'unknown websocket path');
      return;
    }
    if (!tokenMatches(token, url.searchParams.get('token') ?? undefined)) {
      reject(socket, 401, 'Unauthorized', path, 'bad or missing token');
      return;
    }
    // Guarded (Q11): a malformed escape (`%E0`) throws URIError, and a throw out
    // of this listener is an uncaughtException that ends the backend. No id
    // decodes from it, so it is answered as the session it cannot name.
    let sessionId: string | undefined;
    try {
      sessionId = decodeURIComponent(match[1] as string);
    } catch {
      sessionId = undefined;
    }
    if (sessionId === undefined || !sessions.has(sessionId)) {
      reject(socket, 404, 'Not Found', path, 'no such session');
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      attachClient(ws, sessionId);
    });
  };

  const closeAll = (code: number, reason: string): number => {
    let closed = 0;
    for (const server of [wss, presenceWss]) {
      for (const ws of server.clients) {
        // Sockets a session teardown already closed (code 1000) are still in
        // this set for a moment; counting them would overstate the line.
        if (ws.readyState !== ws.OPEN) continue;
        try {
          ws.close(code, reason);
          closed += 1;
        } catch {
          // Already gone — nothing to close.
        }
      }
    }
    if (closed > 0) wsLog('info', `closed ${closed} websocket(s) with code ${code}: ${reason}`);
    return closed;
  };

  /**
   * Presence: the open socket is the signal. Inbound frames are ignored,
   * except a well-formed ping which is echoed as a pong (latency probe).
   * Ping traffic MUST NOT touch the lifecycle counters/timers — only the
   * socket's existence does.
   */
  function attachPresence(ws: WebSocket): void {
    lifecycle.presenceConnected();
    wsLog('info', `presence connected (presence=${lifecycle.presenceCount})`);
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      lifecycle.presenceDisconnected();
    };
    ws.on('close', (code: number, reason: Buffer) => {
      release();
      wsLog(
        'info',
        `presence disconnected code=${code}${reason.length > 0 ? ` len=${reason.length}` : ''} ` +
          `(presence=${lifecycle.presenceCount})`,
      );
    });

    ws.on('message', (raw, isBinary) => {
      if (isBinary) return; // Protocol is JSON text frames only.
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        return; // Malformed JSON: ignore, never reply.
      }
      const msg = plainObject(parsed);
      if (msg === undefined) return;
      const { type, t } = msg;
      // Echo `t` only when it is a finite number — never arbitrary payloads.
      if (type !== 'ping' || typeof t !== 'number' || !Number.isFinite(t)) return;
      // NOT logged: the UI pings every 5 s per open window, so a line here is
      // pure steady-state noise in a file that has to survive for days.
      const pong: PongMessage = { type: 'pong', t };
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(pong));
    });

    ws.on('error', (err) => {
      log('warn', `presence ws error: ${describeError(err)}`);
      release();
    });
  }

  function attachClient(ws: WebSocket, sessionId: string): void {
    const replayBytes = sessions.attach(sessionId, ws);
    if (replayBytes === null) {
      // Session vanished between the check and the upgrade completing.
      wsLog('info', `attach failed for session ${sessionId}: session vanished before upgrade`);
      ws.close(1011, 'session not found');
      return;
    }
    lifecycle.sessionAttached();
    wsLog(
      'info',
      `attached session ${sessionId}, replayed ${replayBytes} scrollback bytes ` +
        `(attached=${lifecycle.attachedCount})`,
    );
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      lifecycle.sessionDetached();
    };
    ws.on('close', (code: number, reason: Buffer) => {
      release();
      wsLog(
        'info',
        `detached session ${sessionId} code=${code}${reason.length > 0 ? ` len=${reason.length}` : ''} ` +
          `(attached=${lifecycle.attachedCount})`,
      );
    });

    ws.on('message', (raw, isBinary) => {
      if (isBinary) return; // Protocol is JSON text frames only.
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        log('warn', `session ${sessionId}: malformed ws frame ignored`);
        return;
      }
      // `null`, a number, a string or an array is valid JSON but no message:
      // dereferencing `null` here threw out of the handler, and an
      // uncaughtException ends the backend with every session in it (Q9).
      const msg = plainObject(parsed);
      if (msg === undefined) {
        wsLog('debug', `session ${sessionId}: frame ignored (not a JSON object)`);
        return;
      }
      if (msg.type === 'input' && typeof msg.data === 'string') {
        // NOT logged here. xterm.js emits one `input` frame per KEYSTROKE, so a
        // line per frame is a line per key. SessionManager.write() accumulates
        // the BYTE COUNT (never the bytes — this is what the user types,
        // passwords included) and flushes one summary line per second.
        sessions.write(sessionId, msg.data);
      } else if (msg.type === 'resize' && isValidDim(msg.cols) && isValidDim(msg.rows)) {
        wsLog('debug', `session ${sessionId}: resize ${msg.cols}x${msg.rows}`);
        sessions.resize(sessionId, msg.cols, msg.rows);
      } else if (msg.type === 'seen') {
        wsLog('debug', `session ${sessionId}: seen`);
        sessions.markSeen(sessionId);
      } else {
        wsLog('debug', `session ${sessionId}: frame ignored (unknown or invalid type/fields)`);
      }
    });

    ws.on('error', (err) => {
      log('warn', `session ${sessionId}: ws error: ${describeError(err)}`);
      release();
    });
  }

  return Object.assign(handler, { closeAll });
}
