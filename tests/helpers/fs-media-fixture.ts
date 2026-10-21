/**
 * The media viewer's two routes as the browser calls them (Nocturne D7,
 * `.claude/plans/nocturne/PLAN-D7.md`): POST /api/fs/media-ticket with the
 * token, then GET /api/fs/media with the ticket and NO token. Shared by the
 * `tests/server/fs-media-*.test.ts` pieces; the server they talk to is the one
 * `bootFsServer` started for the calling file (`fs-server-fixture.ts`).
 */
import assert from 'node:assert/strict';
import { readdir, readlink, writeFile } from 'node:fs/promises';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { join } from 'node:path';
import type { FsMediaTicketResponse } from '../../shared/protocol.ts';
import { server, work } from './fs-server-fixture.ts';
import { api, type ApiResult } from './helpers.ts';

export function askTicket(path: unknown): Promise<ApiResult> {
  return api(server, 'POST', '/api/fs/media-ticket', { path });
}

/** The ticket for `path`, asserting the 200. */
export async function ticketFor(path: string): Promise<FsMediaTicketResponse> {
  const res = await askTicket(path);
  assert.equal(res.status, 200, `expected a ticket: ${JSON.stringify(res.body)}`);
  return res.body as FsMediaTicketResponse;
}

/** The URL path the browser puts in a `src`. */
export function mediaUrl(path: string, ticket: string): string {
  return `/api/fs/media?path=${encodeURIComponent(path)}&t=${encodeURIComponent(ticket)}`;
}

export interface MediaResult {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

/** GET /api/fs/media with NO token header; `headers` adds Range, Host, Origin … */
export function getMedia(
  path: string,
  ticket: string,
  headers: Record<string, string> = {},
): Promise<MediaResult> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port: server.port, method: 'GET', path: mediaUrl(path, ticket), headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** The JSON `{ error }` sentence of a refused media answer. */
export function errorOf(res: MediaResult): string {
  return (JSON.parse(res.body.toString('utf8')) as { error: string }).error;
}

/** A file of `bytes` planted in `<home>/work`; returns its path. */
export async function plantMedia(name: string, bytes: Buffer | string): Promise<string> {
  const path = join(work(), name);
  await writeFile(path, bytes);
  return path;
}

/** `n` bytes where byte i is `i % 251` — every slice is recognisable. */
export function pattern(n: number): Buffer {
  const buf = Buffer.allocUnsafe(n);
  for (let i = 0; i < n; i++) buf[i] = i % 251;
  return buf;
}

/** How many of the server child's open fds point at `path` (Linux /proc). */
export async function openFdsOn(path: string): Promise<number> {
  const dir = `/proc/${server.child.pid}/fd`;
  let n = 0;
  for (const fd of await readdir(dir)) {
    const target = await readlink(join(dir, fd)).catch(() => '');
    if (target === path) n++;
  }
  return n;
}
