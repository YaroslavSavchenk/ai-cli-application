/**
 * Shared HTTP plumbing of the /api route families: the response writers and
 * the access log's side channels (bytes, refusal reason, success note), the
 * body readers, and the contract a route family implements (ApiContext in,
 * NEXT out when the pathname is not its own).
 *
 * Split from server/api.ts (O8, 2026-09-23): a pure move, behaviour and
 * error sentences unchanged. Siblings: server/api.ts (dispatcher, gates,
 * access log, static serving), api-http.ts (shared response/body plumbing),
 * api-app.ts, api-github.ts, api-projects.ts, api-fs.ts, api-git.ts,
 * api-sessions.ts (one route family each).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ToolAvailability } from '../shared/protocol.ts';
import type { ApiDeps } from './api.ts';
import type { ProjectStore } from './projects.ts';
import type { PrefsStore } from './prefs.ts';
import type { SessionManager } from './sessions.ts';
import type { SessionHistory } from './history.ts';
import type { KeyStore } from './keys.ts';
import type { GithubConnection } from './github.ts';
import type { Logger } from './config.ts';

export const MAX_BODY_BYTES = 1024 * 1024;

/**
 * What every route family reads: the deps and the loggers
 * createRequestHandler() built. One object per handler, built once.
 */
export interface ApiContext {
  deps: ApiDeps;
  projects: ProjectStore;
  prefs: PrefsStore;
  sessions: SessionManager;
  history: SessionHistory;
  github: GithubConnection;
  keys: KeyStore | undefined;
  tools: () => Promise<ToolAvailability>;
  log: Logger;
  fsLog: Logger;
  gitLog: Logger;
  projectAnchors: () => string[];
  writeClientLog: (entries: unknown[]) => void;
}

/** A route family's answer when the pathname is not one of its routes. */
export const NEXT = Symbol('next route family');
/** Handled (the response is written or on its way), or NEXT. */
export type RouteResult = void | typeof NEXT;
/** One route family: its blocks, in the order they stood in handleApi(). */
export type RouteFamily = (
  ctx: ApiContext,
  method: string,
  pathname: string,
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
) => Promise<RouteResult>;

/**
 * Bytes and failure reason of a response, recorded where the body is produced
 * so the access log can report them without monkey-patching res.end.
 *
 * The reason is ONLY ever a sendError message, and every one of those is a
 * CONSTANT string in server/api.ts or an api-*.ts route file (or a constant
 * sentence from GithubError / ScaffoldError / FsBrowseError). Nothing derived from a request body, a query
 * string or a credential is ever stored here — that is the whole reason this is
 * a separate channel instead of "log whatever the handler threw".
 *
 * `reason=` in the access line therefore means ONE thing process-wide: this
 * request was REFUSED, and this is why. The access line prints it for 4xx/5xx
 * only, so a 2xx can never wear a refusal reason.
 *
 * `responseNote` is the separate 2xx channel (its line prints `note="…"`, and
 * only while the status is < 400), for a success whose OUTCOME is the
 * diagnostic — today exactly POST /api/update/check, which would otherwise be
 * an indistinguishable `200 (N B)` whether it found a release or nothing. Same
 * rule on content as the reason: CONSTANT sentences from the api route files or
 * shared/protocol.ts, never remote text, user text or anything derived from a
 * request.
 */
export const responseBytes = new WeakMap<ServerResponse, number>();
export const responseReason = new WeakMap<ServerResponse, string>();
export const responseNote = new WeakMap<ServerResponse, string>();

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  onFlushed?: () => void,
): void {
  const text = JSON.stringify(body);
  responseBytes.set(res, Buffer.byteLength(text));
  res.writeHead(status, { 'content-type': 'application/json' });
  // The callback exists for exactly one caller: POST /api/restart, whose
  // process must not leave before the bytes are on the wire.
  if (onFlushed === undefined) res.end(text);
  else res.end(text, onFlushed);
}

export function sendError(res: ServerResponse, status: number, message: string): void {
  responseReason.set(res, message);
  sendJson(res, status, { error: message });
}

/**
 * True when the request ANNOUNCES a body it has not sent yet. A refusal that
 * happens before that body is read must end the connection instead of leaving
 * Node draining it (server/api.ts refuses a 50 MiB upload on the token gate).
 */
export function declaresBody(req: IncomingMessage): boolean {
  if (req.headers['transfer-encoding'] !== undefined) return true;
  const raw = req.headers['content-length'];
  return typeof raw === 'string' && /^\d+$/.test(raw) && Number(raw) > 0;
}

/**
 * A refusal that ENDS THE CONNECTION. It exists for PUT /api/fs/upload (B10),
 * whose refusals are all decided before a byte of the body is read: answering
 * one of those on a kept-alive connection would leave the client streaming up
 * to 50 MiB into a server that has already said no, and would leave the parser
 * holding a body it must discard before the next request.
 *
 * BOTH HEADERS ARE LOAD-BEARING, measured 2026-09-20:
 *   - `connection: close` is what stops the upload. At response finish Node's
 *     own destroySoon() tears the socket down, and the kernel answers the next
 *     inbound segment with an RST within 1-4 ms. Without it the socket lingers
 *     and Node drains the declared body to keep the connection reusable.
 *   - the explicit `content-length`, because with `connection: close` Node
 *     would otherwise frame this body CHUNKED, and a client reading a refusal
 *     must be able to take the bytes at face value.
 *
 * WHO SEES THE ANSWER: a client that READS while it writes gets the response
 * (undici delivered a 409 after 32 MiB of a 50 MiB body); a client that only
 * writes gets EPIPE instead — at any linger, so no timer buys anything and
 * there is none. The drop client is `fetch`, which reads.
 */
export function sendErrorAndClose(res: ServerResponse, status: number, message: string): void {
  responseReason.set(res, message);
  const text = JSON.stringify({ error: message });
  responseBytes.set(res, Buffer.byteLength(text));
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(text)),
    connection: 'close',
  });
  res.end(text);
}

export async function readJsonBody(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    bytes += buf.byteLength;
    if (bytes > maxBytes) throw new Error('body too large');
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw === '') return {};
  return JSON.parse(raw) as unknown;
}

/**
 * SECRET-SAFE body read: returns a RESULT instead of throwing, so the caller can
 * answer 400 without ever touching the thrown error.
 *
 * WHY THIS EXISTS (measured, not theoretical). `readJsonBody` lets JSON.parse
 * throw, and the generic handler at the bottom of server/api.ts logs
 * `request … failed: ${String(err)}`. Node embeds a fragment of the INPUT in
 * that error — `JSON.parse('ghp_S3CRET_TOKEN_VALUE_1234567890')` produces
 * `SyntaxError: Unexpected token 'g', "ghp_S3CRET"... is not valid JSON` — so a
 * malformed POST /api/github/token body would have appended part of the pasted
 * credential to server.log, which survives into server.log.1 and is readable
 * from Windows through \\wsl.localhost\ whatever its 0600 mode says.
 *
 * The error object therefore never leaves this function: the caller learns only
 * WHICH rule failed, never anything derived from the bytes.
 */
export type BodyRead = { ok: true; value: unknown } | { ok: false; reason: 'too-large' | 'invalid-json' };

export async function readJsonBodySafe(req: IncomingMessage, maxBytes: number): Promise<BodyRead> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      bytes += buf.byteLength;
      if (bytes > maxBytes) return { ok: false, reason: 'too-large' };
      chunks.push(buf);
    }
  } catch {
    // Aborted/!broken request stream. Nothing parsed, nothing to say.
    return { ok: false, reason: 'invalid-json' };
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw === '') return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch {
    // Deliberately NOT rethrown and NOT logged: the caught SyntaxError quotes
    // the input. See the comment above.
    return { ok: false, reason: 'invalid-json' };
  }
}
