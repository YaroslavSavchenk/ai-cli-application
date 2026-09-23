/**
 * The two editor routes as the pane calls them — GET /api/fs/read and
 * PUT /api/fs/write — shared by `tests/server/fs-text.test.ts` and its topic
 * pieces (`fs-text-boundary`, `fs-text-save`), plus a text file planted
 * straight on disk in `<home>/work`. The server they talk to is the one
 * `bootFsServer` started for the calling file (`fs-server-fixture.ts`).
 */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FsReadResponse } from '../../shared/protocol.ts';
import { server, work } from './fs-server-fixture.ts';
import { api, type ApiResult } from './helpers.ts';


export function read(path: string, ifStamp?: string): Promise<ApiResult> {
  const query =
    `path=${encodeURIComponent(path)}` +
    (ifStamp === undefined ? '' : `&if=${encodeURIComponent(ifStamp)}`);
  return api(server, 'GET', `/api/fs/read?${query}`);
}

export function write(body: unknown): Promise<ApiResult> {
  return api(server, 'PUT', '/api/fs/write', body);
}

/** The read answer as the union it is, with a readable failure on a refusal. */
export function readBody(res: ApiResult): FsReadResponse {
  assert.equal(res.status, 200, `expected a 200: ${JSON.stringify(res.body)}`);
  return res.body as FsReadResponse;
}

/** A text file written straight to disk, and the read answer for it. */
export async function plant(name: string, bytes: string | Buffer): Promise<string> {
  const path = join(work(), name);
  await writeFile(path, bytes);
  return path;
}
