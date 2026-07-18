/**
 * WebSocket upgrade handling and the per-session attach protocol.
 *
 * Path: /ws/sessions/:id?token=<token>. The token, Host and Origin are all
 * validated BEFORE the upgrade completes — a rejected client never receives
 * any session data. Multiple concurrent clients per session are allowed.
 *
 * client->server frames: {type:'input',data} | {type:'resize',cols,rows} | {type:'seen'}
 * server->client frames are produced by SessionManager (replay/info/data/exit/attention).
 */
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ClientMessage } from '../shared/protocol.ts';
import { tokenMatches, hostAllowed, originAllowed } from './auth.ts';
import { SessionManager } from './sessions.ts';
import { MAX_TERM_DIM } from './api.ts';
import type { Logger } from './config.ts';

export interface WsDeps {
  token: string;
  getPort: () => number;
  sessions: SessionManager;
  log: Logger;
}

function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

export function createUpgradeHandler(
  deps: WsDeps,
): (req: IncomingMessage, socket: Duplex, head: Buffer) => void {
  const { token, sessions, log } = deps;
  const wss = new WebSocketServer({ noServer: true });

  return (req, socket, head) => {
    const port = deps.getPort();
    if (!hostAllowed(req.headers.host, port)) {
      rejectUpgrade(socket, 403, 'Forbidden');
      return;
    }
    const origin = Array.isArray(req.headers.origin) ? req.headers.origin[0] : req.headers.origin;
    if (!originAllowed(origin, port)) {
      rejectUpgrade(socket, 403, 'Forbidden');
      return;
    }

    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const match = /^\/ws\/sessions\/([^/]+)$/.exec(url.pathname);
    if (match === null) {
      rejectUpgrade(socket, 404, 'Not Found');
      return;
    }
    if (!tokenMatches(token, url.searchParams.get('token') ?? undefined)) {
      rejectUpgrade(socket, 401, 'Unauthorized');
      return;
    }
    const sessionId = decodeURIComponent(match[1] as string);
    if (!sessions.has(sessionId)) {
      rejectUpgrade(socket, 404, 'Not Found');
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      attachClient(ws, sessionId);
    });
  };

  function attachClient(ws: WebSocket, sessionId: string): void {
    if (!sessions.attach(sessionId, ws)) {
      // Session vanished between the check and the upgrade completing.
      ws.close(1011, 'session not found');
      return;
    }

    ws.on('message', (raw, isBinary) => {
      if (isBinary) return; // Protocol is JSON text frames only.
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString()) as ClientMessage;
      } catch {
        log('warn', `session ${sessionId}: malformed ws frame ignored`);
        return;
      }
      if (msg.type === 'input' && typeof msg.data === 'string') {
        sessions.write(sessionId, msg.data);
      } else if (
        msg.type === 'resize' &&
        Number.isInteger(msg.cols) &&
        Number.isInteger(msg.rows) &&
        msg.cols >= 1 &&
        msg.cols <= MAX_TERM_DIM &&
        msg.rows >= 1 &&
        msg.rows <= MAX_TERM_DIM
      ) {
        sessions.resize(sessionId, msg.cols, msg.rows);
      } else if (msg.type === 'seen') {
        sessions.markSeen(sessionId);
      }
    });

    ws.on('error', (err) => {
      log('warn', `session ${sessionId}: ws error: ${String(err)}`);
    });
  }
}
