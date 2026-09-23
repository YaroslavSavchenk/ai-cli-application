/**
 * The callers of POST /api/fs/rename shared by `tests/server/fs-rename.test.ts`
 * and its topic pieces (`fs-rename-protected`, `fs-rename-in-process`): the
 * raw post, a refusal and a success with their exact bodies, a project that
 * exists only while a callback runs, and the two sentences/canaries more than
 * one piece asserts. The server they talk to is the one `bootFsServer`
 * started for the calling file (`fs-server-fixture.ts`).
 */
import assert from 'node:assert/strict';
import type { Project } from '../../shared/protocol.ts';
import { server } from './fs-server-fixture.ts';
import { api } from './helpers.ts';

/** Names that must NEVER reach server.log. */
export const CANARY = 'RENAMECANARY';

export const ALREADY_EXISTS = 'Something with that name already exists here.';

/** POST /api/fs/rename with any body value (so bad shapes are testable too). */
export const post = (body: unknown): Promise<{ status: number; body: unknown }> =>
  api(server, 'POST', '/api/fs/rename', body);

/** A refusal: status and the exact `{ error }` body. */
export async function refused(path: unknown, name: unknown, status: number, error: string): Promise<void> {
  const res = await post({ path, name });
  assert.equal(res.status, status, `${String(path)} -> ${String(name)}: ${JSON.stringify(res.body)}`);
  assert.deepEqual(res.body, { error });
}

/** A success: 200 and an EMPTY body. */
export async function renamed(path: string, name: string): Promise<void> {
  const res = await post({ path, name });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body, {}, 'no path, no name comes back');
}

export async function withProject<T>(name: string, path: string, fn: () => Promise<T>): Promise<T> {
  const created = await api(server, 'POST', '/api/projects', { name, path });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  try {
    return await fn();
  } finally {
    const id = (created.body as Project).id;
    assert.equal((await api(server, 'DELETE', `/api/projects/${id}`)).status, 200);
  }
}
