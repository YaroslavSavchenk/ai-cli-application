/**
 * The shared doubles of the `tests/server/github*.test.ts` files that drive
 * `GithubConnection` (server/github.ts, Phase 2b/2c) through its fetch and
 * spawn SEAMS — no network, no real clone.
 *
 * `SECRET` is the canary access token (it must surface nowhere), `jsonResponse`
 * a real fetch `Response` (unlike `jsonResponse` in `helpers.ts`, which is the
 * frontend's plain-object double), `RAW_REPO` one GitHub API repo payload with
 * fields that must be dropped, `connectedConn` a connection loaded straight
 * from a github.json holding SECRET, and `fakeChild` a ChildProcess that
 * closes with a chosen exit code.
 *
 * Moved here out of `tests/server/github.test.ts` when it was split by topic
 * (PLAN-RESTRUCTURE O6); the code is unchanged.
 */
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GithubConnection, type FetchLike, type SpawnLike } from '../../server/github.ts';
import type { Logger } from '../../server/config.ts';

export const noop: Logger = () => {};
export const SECRET = 'gho_SUPER_SECRET_TOKEN_do_not_leak';

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export const RAW_REPO = {
  id: 42,
  full_name: 'octocat/hello',
  name: 'hello',
  owner: { login: 'octocat', id: 1, extra: 'ignored' },
  private: true,
  description: 'a greeting',
  language: 'TypeScript',
  pushed_at: '2026-07-20T10:00:00Z',
  clone_url: 'https://github.com/octocat/hello.git',
  // fields that MUST be dropped:
  ssh_url: 'git@github.com:octocat/hello.git',
  default_branch: 'main',
  permissions: { admin: true },
};

/** A connected connection loaded straight from a github.json holding SECRET. */
export async function connectedConn(
  root: string,
  opts: { fetchImpl?: FetchLike; spawnImpl?: SpawnLike } = {},
): Promise<GithubConnection> {
  const file = join(root, 'github.json');
  await writeFile(
    file,
    JSON.stringify({ accessToken: SECRET, login: 'octocat', scope: 'repo', connectedAt: '2026-07-24T00:00:00Z' }),
    { mode: 0o600 },
  );
  return new GithubConnection({ file, log: noop, clientId: 'Iv1.x', ...opts });
}

/** A fake ChildProcess that runs `onSpawn` then emits `close(code)` next tick. */
export function fakeChild(code: number, onSpawn?: () => void): ChildProcess {
  if (onSpawn !== undefined) onSpawn();
  const child = new EventEmitter();
  setTimeout(() => child.emit('close', code), 0);
  return child as unknown as ChildProcess;
}
