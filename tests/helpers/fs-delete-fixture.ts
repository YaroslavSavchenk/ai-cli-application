/**
 * The two callers of POST /api/fs/delete shared by `tests/server/fs-delete.test.ts`
 * and its topic pieces (`fs-delete-boundaries`, `fs-delete-protected`): the
 * raw post, and the results of a well-formed request. The server they talk to
 * is the one `bootFsServer` started for the calling file
 * (`fs-server-fixture.ts`).
 */
import assert from 'node:assert/strict';
import type { FsDeleteResult, FsDeleteResponse } from '../../shared/protocol.ts';
import { server } from './fs-server-fixture.ts';
import { api } from './helpers.ts';

/** POST /api/fs/delete with a raw body value (so bad shapes are testable too). */
export const post = (body: unknown): Promise<{ status: number; body: unknown }> =>
  api(server, 'POST', '/api/fs/delete', body);

/** The results of a well-formed request; fails loudly on a non-200. */
export async function del(...paths: unknown[]): Promise<FsDeleteResult[]> {
  const res = await post({ paths });
  assert.equal(res.status, 200, `expected a 200 envelope, got ${res.status}: ${JSON.stringify(res.body)}`);
  return (res.body as FsDeleteResponse).results;
}
