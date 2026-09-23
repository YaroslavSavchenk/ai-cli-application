/**
 * The two clients of PUT /api/fs/upload shared by
 * `tests/server/fs-upload.test.ts` and `fs-upload-edges.test.ts`: the ordinary
 * one (fetch, which sets content-length itself) and the hostile one (a raw
 * socket, so the request head and the body are two separate decisions), plus
 * the query builder and the `.part` leftovers of a folder. The server they
 * talk to is the one `bootFsServer` started for the calling file
 * (`fs-server-fixture.ts`).
 */
import { readdirSync } from 'node:fs';
import { connect } from 'node:net';
import { server } from './fs-server-fixture.ts';


// ---------------------------------------------------------------------------
// The ordinary client: fetch, which sets content-length for a byte body itself.
// ---------------------------------------------------------------------------

export interface UploadResult {
  status: number;
  body: unknown;
  headers: Headers;
}

export async function put(
  dir: string,
  rel: string,
  mode: string,
  body: Uint8Array,
  opts: { contentType?: string | null; method?: string } = {},
): Promise<UploadResult> {
  const query =
    `dir=${encodeURIComponent(dir)}&rel=${encodeURIComponent(rel)}&mode=${encodeURIComponent(mode)}`;
  const headers: Record<string, string> = { 'x-auth-token': server.token };
  if (opts.contentType !== null) {
    headers['content-type'] = opts.contentType ?? 'application/octet-stream';
  }
  const res = await fetch(`${server.baseUrl}/api/fs/upload?${query}`, {
    method: opts.method ?? 'PUT',
    headers,
    // A Blob, not the bare bytes: undici sets content-length from it, and the
    // `Uint8Array<ArrayBufferLike>` a Buffer is does not satisfy BodyInit under
    // this TypeScript. The copy into a plain Uint8Array is the same bytes.
    body: new Blob([new Uint8Array(body)]),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    // Non-JSON body — keep the raw text.
  }
  return { status: res.status, body: parsed, headers: res.headers };
}

// ---------------------------------------------------------------------------
// The hostile client: a raw socket, so the request head and the body are two
// separate decisions.
// ---------------------------------------------------------------------------

export interface Exchange {
  status: number;
  /** Lower-cased response header lines, joined — enough to assert `connection: close`. */
  head: string;
  body: string;
  /** The first response byte arrived BEFORE this client wrote any body byte. */
  answeredBeforeBody: boolean;
  /** The server ended the connection. */
  closed: boolean;
}

/**
 * Send a hand-built request head, optionally followed by body bytes, and read
 * whatever comes back until the server closes (every refusal of this route
 * closes) or a complete content-length-delimited response has arrived.
 */
export function exchange(
  head: string,
  opts: { body?: Buffer; sendBody?: boolean; halfCloseAfter?: number } = {},
): Promise<Exchange> {
  return new Promise((resolve, reject) => {
    const socket = connect(server.port, '127.0.0.1');
    let raw = Buffer.alloc(0);
    let wroteBody = false;
    let answeredBeforeBody = false;
    let settled = false;
    const timer = setTimeout(() => {
      finish(true);
    }, 10_000);

    const finish = (timedOut = false): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      const text = raw.toString('utf8');
      const split = text.indexOf('\r\n\r\n');
      if (split === -1) {
        reject(new Error(timedOut ? 'timed out with no response' : `no response head: ${text}`));
        return;
      }
      const headText = text.slice(0, split).toLowerCase();
      const status = Number(headText.split(' ')[1] ?? '0');
      resolve({
        status,
        head: headText,
        body: text.slice(split + 4),
        answeredBeforeBody,
        closed: socket.readableEnded,
      });
    };

    socket.on('connect', () => {
      socket.write(head);
      if (opts.body !== undefined && opts.sendBody !== false) {
        const slice =
          opts.halfCloseAfter === undefined ? opts.body : opts.body.subarray(0, opts.halfCloseAfter);
        socket.write(slice);
        wroteBody = true;
        if (opts.halfCloseAfter !== undefined) socket.end(); // FIN: the body stops short
      }
    });
    socket.on('data', (chunk: Buffer) => {
      if (!wroteBody) answeredBeforeBody = true;
      raw = Buffer.concat([raw, chunk]);
      const text = raw.toString('utf8');
      const split = text.indexOf('\r\n\r\n');
      if (split === -1) return;
      // A response that says `connection: close` is only complete once the
      // server really closes — that closure is what these cases measure.
      if (/connection: *close/i.test(text.slice(0, split))) return;
      const length = /content-length: *(\d+)/i.exec(text.slice(0, split))?.[1];
      if (length !== undefined && Buffer.byteLength(text.slice(split + 4)) >= Number(length)) {
        finish();
      }
    });
    socket.on('end', () => finish());
    socket.on('close', () => finish());
    socket.on('error', () => finish());
  });
}

/** A request head for /api/fs/upload with exactly the header lines given. */
export function head(query: string, lines: readonly string[]): string {
  return (
    `PUT /api/fs/upload?${query} HTTP/1.1\r\n` +
    `host: 127.0.0.1:${server.port}\r\n` +
    `x-auth-token: ${server.token}\r\n` +
    `${lines.join('\r\n')}\r\n\r\n`
  );
}

export const q = (dir: string, rel: string, mode = 'new'): string =>
  `dir=${encodeURIComponent(dir)}&rel=${encodeURIComponent(rel)}&mode=${mode}`;


/** `.upload-<32 hex>.part` files left behind in a folder. */
export const parts = (dir: string): string[] =>
  readdirSync(dir).filter((name) => name.startsWith('.upload-') && name.endsWith('.part'));
