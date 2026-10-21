/**
 * The media viewer's two routes (Nocturne D7, `.claude/plans/nocturne/PLAN-D7.md`):
 * a picture, a video or a PDF opened from the Files panel.
 *
 *   POST /api/fs/media-ticket   body { path }   (X-Auth-Token, like every route)
 *     200 { ticket, size, mtimeMs, ino } | 400 | 403 | 404 | 415
 *   GET  /api/fs/media?path=<abs>&t=<ticket>    (the TICKET is the credential)
 *     200 | 206 | 403 | 404 | 415 | 416
 *
 * WHY A TICKET. An `<img>`, `<video>` or `<iframe>` `src` cannot carry the
 * X-Auth-Token header, and the app token never goes into a URL (a URL lands in
 * history, in the media element's own requests, in a copied link). So the
 * authed POST hands out a TICKET: 32 random bytes in hex, in this process's
 * memory only (a restart forgets every one), bound to ONE realpath, valid
 * MEDIA_TICKET_TTL_MS, at most MEDIA_TICKET_MAX alive (the oldest is dropped).
 * server/api.ts exempts exactly `GET /api/fs/media` from the token gate; the
 * Host and Origin gates still apply to it.
 *
 * ONE TICKET PER PATH AND FILE VERSION, RENEWED. The browser re-asks every
 * 5 s per visible media tab (the answer's size/mtimeMs/ino is its change
 * probe). A fresh ticket per ask would push a playing video's ticket out of
 * the 64 within minutes and its next Range request would answer 403; so an ask
 * for a path whose live ticket was issued for the SAME size/mtimeMs/ino gets
 * THAT ticket back with its 10 minutes restarted — the `src` stays stable
 * while the file does. When the file changed, the ask mints a NEW ticket, so
 * the new URL differs from the old one and no browser cache can hand back the
 * old picture; the old ticket stays valid until it expires or is dropped.
 *
 * THE BOUNDARY is GET /api/fs/read's, through the same helpers in
 * server/fstext.ts: resolveUnderAllowed() (home or a registered project root,
 * realpathed — a symlink inside the boundary is served at its target, one that
 * lands outside is a 403), the data-dir category rule, then ONE open
 * `O_RDONLY|O_NOFOLLOW|O_NONBLOCK` (a planted FIFO cannot block the server),
 * `fstat(fd)` must say a REGULAR file before a byte is read, and the bytes are
 * streamed from THAT fd — never a second path lookup.
 *
 * ON GET the ticket is judged FIRST: an unknown or expired one answers 403
 * before any path is resolved, so a caller without a ticket learns nothing
 * about the file system from a status. The requested path is then resolved
 * the same way and must equal the ticket's path exactly.
 *
 * THE KIND IS THE EXTENSION of the realpath (shared/media-kind.ts): the
 * Content-Type comes from that table only, and outside it nothing is served
 * (415). Every answer carries `X-Content-Type-Options: nosniff`, `Cache-Control:
 * no-store`, `Cross-Origin-Resource-Policy: same-origin` and `X-Frame-Options:
 * SAMEORIGIN` (the PDF opens in the app's own iframe). SVG alone also gets a
 * sandbox CSP — script in an SVG opened as a document must not run with the
 * app's origin. PDF and video get NO sandbox: Chromium's PDF viewer refuses to
 * render a sandboxed document.
 *
 * STREAMED, never buffered whole, no size cap. One `bytes=` range answers 206;
 * a multi-range or an unsatisfiable one 416, its `Content-Range` naming only the size.
 * A client abort (a video seek aborts its request every time) destroys the
 * read stream, which closes the fd.
 *
 * LOGGING: statuses and counts only. Never the path, never the ticket (the
 * access log in server/api.ts writes the pathname and `?…`, never a query
 * value), never a byte of the file.
 *
 * Erasable TypeScript only; relative imports carry explicit .ts extensions.
 */
import { randomBytes } from 'node:crypto';
import { createReadStream, fstatSync, type Stats } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { pipeline } from 'node:stream';
import type { FsMediaTicketResponse } from '../shared/protocol.ts';
import { mediaContentType } from '../shared/media-kind.ts';
import { errorClass, errorFrames } from './config.ts';
import { FsBrowseError, FS_PATH_BAD } from './fsbrowse.ts';
import {
  closeQuietly,
  errnoTag,
  openReadOnly,
  pathTooLong,
  resolveReadable,
  textErrorFor,
  MAX_PATH_BYTES,
  type TextDeps,
} from './fstext.ts';

/**
 * The sentences of these two routes — CONSTANTS, for the same reason as
 * server/fstext.ts's: the access log records a refusal sentence, and nothing
 * derived from a request may reach it. The rest (gone, no permission, outside
 * home, a bad path, a failed read) are fstext.ts's and fsbrowse.ts's own.
 */
const FS_MEDIA_NOT_SHOWN = 'This file cannot be shown here.';
const FS_MEDIA_DATA_DIR_REFUSED = "The app's own folder is not a place to open files.";
const FS_MEDIA_TICKET_BAD = 'This view of the file has expired. Open the file again.';
const FS_MEDIA_RANGE_BAD = 'The app cannot send that part of the file.';

/** How long a ticket lives after it was last handed out. */
export const MEDIA_TICKET_TTL_MS = 10 * 60_000;
/** The most tickets alive at once; past it the oldest is dropped. */
export const MEDIA_TICKET_MAX = 64;

/** The ticket POST's body cap: a PATH_MAX path, JSON-escaped at worst ×6, plus the braces. */
const TICKET_MAX_BODY_BYTES = MAX_PATH_BYTES * 6 + 256;

/** A ticket as it travels: 32 bytes, lower-case hex. */
const TICKET_RE = /^[0-9a-f]{64}$/;

/**
 * The live tickets. Map order is age order (a renewal re-inserts), so the
 * first entry is always the one to drop. No timer: expired tickets are swept
 * whenever one is issued or judged.
 */
export class MediaTickets {
  readonly #now: () => number;
  /** ticket → its realpath and expiry. */
  readonly #byTicket = new Map<string, { path: string; expires: number }>();
  /** realpath → its newest ticket and the file version it was issued for (see the header). */
  readonly #byPath = new Map<string, { ticket: string; version: string }>();

  /** `now` is a clock SEAM: tests step time instead of waiting 10 minutes. */
  constructor(opts: { now?: () => number } = {}) {
    this.#now = opts.now ?? Date.now;
  }

  /**
   * The ticket for `real` (a realpath) at `version` (the file's identity, any
   * string that changes when the file does): the live one for that same
   * version renewed, or a new one.
   */
  issue(real: string, version: string): string {
    const now = this.#now();
    this.#sweep(now);
    const live = this.#byPath.get(real);
    const ticket = live?.version === version ? live.ticket : randomBytes(32).toString('hex');
    this.#byTicket.delete(ticket);
    for (const oldest of this.#byTicket.keys()) {
      if (this.#byTicket.size < MEDIA_TICKET_MAX) break;
      this.#drop(oldest);
    }
    this.#byTicket.set(ticket, { path: real, expires: now + MEDIA_TICKET_TTL_MS });
    this.#byPath.set(real, { ticket, version });
    return ticket;
  }

  /** The realpath `ticket` is bound to, or null when it is unknown, malformed or expired. */
  pathOf(ticket: string | null): string | null {
    if (ticket === null || !TICKET_RE.test(ticket)) return null;
    this.#sweep(this.#now());
    return this.#byTicket.get(ticket)?.path ?? null;
  }

  #sweep(now: number): void {
    for (const [ticket, entry] of this.#byTicket) {
      if (entry.expires <= now) this.#drop(ticket);
    }
  }

  #drop(ticket: string): void {
    const entry = this.#byTicket.get(ticket);
    this.#byTicket.delete(ticket);
    if (entry !== undefined && this.#byPath.get(entry.path)?.ticket === ticket) this.#byPath.delete(entry.path);
  }
}

/** What both routes need from server/api.ts — fstext.ts's deps plus the tickets. */
interface MediaDeps extends TextDeps {
  tickets: MediaTickets;
}

/** GET /api/fs/media's extra two: the trust mark and the length for the access line. */
interface MediaGetDeps extends MediaDeps {
  /** Runs once the ticket is accepted: the access line is then the app's own, never metered. */
  onTrusted: () => void;
  /** The body length about to be sent (server/api-http.ts responseBytes). */
  recordBytes: (n: number) => void;
}

/**
 * Open `real` the read route's way and judge the fd: a REGULAR file whose
 * realpath has an extension in the media table. Returns the fd (the caller
 * closes it, or hands it to a stream that does), its stat and its type.
 */
function openMedia(real: string): { fd: number; st: Stats; type: string } {
  const fd = openReadOnly(real);
  try {
    const st = fstatSync(fd);
    // A folder, a FIFO, a device: nothing a media element can show. The
    // O_NONBLOCK in the open is what lets a FIFO get as far as this stat.
    const type = mediaContentType(real);
    if (!st.isFile() || type === null) throw new FsBrowseError(415, FS_MEDIA_NOT_SHOWN);
    return { fd, st, type };
  } catch (err) {
    closeQuietly(fd);
    throw err;
  }
}

/** Any failure as the refusal it earns; fstext's "not text" 415 is reworded for media. */
function mediaRefusal(err: unknown): FsBrowseError {
  const mapped = err instanceof FsBrowseError ? err : textErrorFor((err as NodeJS.ErrnoException).code, true);
  return mapped.status === 415 ? new FsBrowseError(415, FS_MEDIA_NOT_SHOWN) : mapped;
}

/**
 * One finished refusal: the 5xx line (class + frames + errno code, never the
 * message, which quotes the path), the debug status line, the answer.
 */
function refuse(
  res: ServerResponse,
  deps: TextDeps,
  route: string,
  err: unknown,
  close = false,
): void {
  const mapped = mediaRefusal(err);
  if (mapped.status >= 500) {
    deps.log('error', `fs media failed (${errorClass(err)})${errnoTag(err)} ${errorFrames(err)}`);
  }
  // DEBUG: the access log already carries the status and the sentence at info.
  deps.log('debug', `${route} -> ${mapped.status}`);
  if (close) deps.sendErrorAndClose(res, mapped.status, mapped.message);
  else deps.sendError(res, mapped.status, mapped.message);
}

/** A raw path from a request, or the 400 it earns before any syscall. */
function requestedPath(raw: unknown): string {
  if (typeof raw !== 'string' || raw === '' || pathTooLong(raw)) {
    throw new FsBrowseError(400, FS_PATH_BAD);
  }
  return raw;
}

// ---------------------------------------------------------------------------
// POST /api/fs/media-ticket
// ---------------------------------------------------------------------------

/** The ticket route. Answers every status itself and never throws. */
export async function handleMediaTicket(
  req: IncomingMessage,
  res: ServerResponse,
  deps: MediaDeps,
): Promise<void> {
  const route = 'POST /api/fs/media-ticket';
  if ((req.method ?? 'GET') !== 'POST') {
    deps.sendErrorAndClose(res, 405, 'method not allowed');
    return;
  }
  const read = await deps.readJson(req, TICKET_MAX_BODY_BYTES);
  if (!read.ok) {
    refuse(res, deps, route, new FsBrowseError(400, FS_PATH_BAD), read.reason === 'too-large');
    return;
  }
  let fd: number | undefined;
  try {
    const raw = requestedPath((read.value as { path?: unknown } | null)?.path);
    const real = resolveReadable(raw, deps.projects(), FS_MEDIA_DATA_DIR_REFUSED);
    const opened = openMedia(real);
    fd = opened.fd;
    // Counted, not written, when it answers 200 promptly (server/poll-log.ts):
    // the browser asks every 5 s per visible media tab.
    const { size, mtimeMs, ino } = opened.st;
    deps.sendJson(res, 200, {
      ticket: deps.tickets.issue(real, `${size}:${mtimeMs}:${ino}`),
      size,
      mtimeMs,
      ino,
    } satisfies FsMediaTicketResponse);
  } catch (err) {
    refuse(res, deps, route, err);
  } finally {
    closeQuietly(fd);
  }
}

// ---------------------------------------------------------------------------
// GET /api/fs/media
// ---------------------------------------------------------------------------

/** The bytes to send: inclusive `start`..`end`, or the whole file when `partial` is false. */
type ByteSpan = { partial: boolean; start: number; end: number };

/**
 * A `Range` header against a file of `size` bytes: the span to send, or null
 * for a 416. PURE.
 *
 * No header, or a unit other than `bytes`, is the whole file (RFC 9110 §14.2:
 * a range unit the server does not understand is ignored). ONE `bytes=` range
 * is served: `a-b` (b clamped to the end), `a-`, or the suffix `-n`. A list of
 * ranges, a malformed spec, a start at or past the end, or a zero suffix is a
 * 416 — a multipart/byteranges answer is not worth its code for a media
 * element, which never asks for one.
 */
function byteSpan(header: string | undefined, size: number): ByteSpan | null {
  const whole: ByteSpan = { partial: false, start: 0, end: size - 1 };
  if (header === undefined) return whole;
  const m = /^\s*([A-Za-z]+)=(.*)$/.exec(header);
  if (m === null || m[1]!.toLowerCase() !== 'bytes') return whole;
  const one = /^\s*(\d*)-(\d*)\s*$/.exec(m[2]!);
  if (one === null || (one[1] === '' && one[2] === '')) return null;
  if (one[1] === '') {
    const suffix = Number(one[2]);
    if (suffix === 0 || size === 0) return null;
    return { partial: true, start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(one[1]);
  const last = one[2] === '' ? size - 1 : Number(one[2]);
  if (start >= size || last < start) return null;
  return { partial: true, start, end: Math.min(last, size - 1) };
}

/** The headers every served answer carries, whatever the kind. */
function mediaHeaders(type: string): Record<string, string> {
  return {
    'content-type': type,
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'cross-origin-resource-policy': 'same-origin',
    'x-frame-options': 'SAMEORIGIN',
    // SVG only: opened as a document, an SVG may carry script. NEVER on a PDF
    // (Chromium's viewer will not render a sandboxed document) or a video.
    ...(type === 'image/svg+xml'
      ? {
          'content-security-policy':
            "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
        }
      : {}),
  };
}

/**
 * The media route. No token (server/api.ts exempts exactly this GET), the
 * ticket instead. Answers every status itself and never throws.
 */
export function handleMedia(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: MediaGetDeps,
): void {
  const route = 'GET /api/fs/media';
  // Judged BEFORE the path: without a live ticket, every answer is this 403.
  const bound = deps.tickets.pathOf(url.searchParams.get('t'));
  if (bound === null) {
    // No `[fs]` line: this caller is still a stranger, and only the access
    // line — metered by server/api.ts's budget for strangers — may record it.
    deps.sendError(res, 403, FS_MEDIA_TICKET_BAD);
    return;
  }
  deps.onTrusted();
  let fd: number | undefined;
  try {
    const real = resolveReadable(
      requestedPath(url.searchParams.get('path')),
      deps.projects(),
      FS_MEDIA_DATA_DIR_REFUSED,
    );
    if (real !== bound) throw new FsBrowseError(403, FS_MEDIA_TICKET_BAD);
    const opened = openMedia(real);
    fd = opened.fd;
    const size = opened.st.size;
    const span = byteSpan(req.headers.range, size);
    if (span === null) {
      res.setHeader('content-range', `bytes */${size}`);
      throw new FsBrowseError(416, FS_MEDIA_RANGE_BAD);
    }
    const length = span.end - span.start + 1;
    deps.recordBytes(length);
    res.writeHead(span.partial ? 206 : 200, {
      ...mediaHeaders(opened.type),
      'content-length': String(length),
      ...(span.partial ? { 'content-range': `bytes ${span.start}-${span.end}/${size}` } : {}),
    });
    if (length === 0) {
      res.end();
      return; // `finally` closes the fd: no stream ever owned it.
    }
    // From here the STREAM owns the fd (autoClose): `fd` is cleared so the
    // `finally` does not close it under the stream. The path argument is
    // ignored when an fd is given — no second lookup happens.
    const stream = createReadStream(real, { fd, start: span.start, end: span.end, autoClose: true });
    fd = undefined;
    pipeline(stream, res, (err) => {
      // A client abort (every video seek) is ERR_STREAM_PREMATURE_CLOSE: the
      // pipeline has destroyed the stream, which closed the fd. Anything else
      // is a read failing mid-body, and the headers are long gone.
      if (err && (err as NodeJS.ErrnoException).code !== 'ERR_STREAM_PREMATURE_CLOSE') {
        deps.log('debug', `${route} stream ended early (${errorClass(err)})${errnoTag(err)}`);
      }
    });
  } catch (err) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    refuse(res, deps, route, err);
  } finally {
    closeQuietly(fd);
  }
}
