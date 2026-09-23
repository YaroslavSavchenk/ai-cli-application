/**
 * The shared setup of the `tests/server/git-changes*.test.ts` files — GET
 * /api/git/changes, the Files panel's `Changes` tab (B2): the temp root and
 * fixture home, the server child whose home boundary it is
 * (AI_SM_HOME_OVERRIDE), and the request helpers.
 *
 * Moved here out of `tests/server/git-changes.test.ts` when it was split by
 * topic (PLAN-RESTRUCTURE O6). The repositories and the fake-git child only
 * that file drives are still built in its own `before`.
 *
 * Example paths in comments are `/home/you/...`, never anyone's real one.
 */
import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChangedFile, GitChangesResponse } from '../../shared/protocol.ts';
import { api, startTestServer, type TestServer, makeTempDir } from './helpers.ts';

/** A fresh temp root with an (empty) fixture `home` folder in it. */
export async function makeChangesHome(): Promise<{ root: string; home: string }> {
  const root = await realpath(await makeTempDir('ai-sm-gitch-'));
  const home = join(root, 'home');
  await mkdir(home);
  return { root, home };
}

/** The real server child, its home boundary the fixture home. */
export function startChangesServer(fx: { root: string; home: string }): Promise<TestServer> {
  return startTestServer({
    dataDir: join(fx.root, 'data'),
    env: { AI_SM_HOME_OVERRIDE: fx.home },
  });
}

export const changes = (
  srv: TestServer,
  root_?: string,
): Promise<{ status: number; body: unknown }> =>
  api(
    srv,
    'GET',
    root_ === undefined
      ? '/api/git/changes'
      : `/api/git/changes?root=${encodeURIComponent(root_)}`,
  );

export const fileOf = (body: unknown, path: string): ChangedFile | undefined =>
  (body as GitChangesResponse).files.find((f) => f.path === path);
