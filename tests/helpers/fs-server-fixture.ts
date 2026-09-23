/**
 * The fixture home behind the `/api/fs/*` route tests — `fs-delete`,
 * `fs-rename`, `fs-text`, `fs-upload` and their topic pieces in
 * `tests/server/`.
 *
 * `bootFsServer(prefix)` makes a temp root holding `home/` (with `home/work/`),
 * `homeevil/` (outside home, and the `<home>evil` string-prefix trap) and
 * `outside/`, then starts ONE real server child on it with
 * `AI_SM_HOME_OVERRIDE=<root>/home` and its data dir at
 * `<home>/.ai-session-manager`. A test file calls it in `before` and
 * `stopFsServer` in `after`: every file gets its own child and its own tree.
 *
 * The paths and the server are exported as live bindings, so a test reads
 * `home`, `work()` and `server` as if they were its own module variables.
 * `node --test` runs each file in its own process, so two files never share
 * this state.
 */
import { chmod, mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTempDir, removeTempDir, startTestServer, type TestServer } from './helpers.ts';

export let server: TestServer;
export let root: string;
export let home: string;
/** A folder OUTSIDE home — also the `<home>evil` string-prefix trap. */
export let evil: string;
/** A folder outside home, registered as a project in the anchor tests. */
export let outside: string;
export let dataDir: string;

/** `<home>/work`: the ordinary folder the tests make their entries in. */
export const work = (): string => join(home, 'work');

/** The boundary sentences the delete and rename routes share. */
export const OUTSIDE_HOME = 'This folder is outside your home folder.';
export const NAME_NOT_ALLOWED = 'That name is not allowed.';
export const PATH_BAD = 'The app cannot open that folder.';

/** Make the fixture tree under a new temp root and start the server child on it. */
export async function bootFsServer(prefix: string): Promise<void> {
  root = await realpath(await makeTempDir(prefix));
  home = join(root, 'home');
  evil = join(root, 'homeevil');
  outside = join(root, 'outside');
  dataDir = join(home, '.ai-session-manager');
  await mkdir(home);
  await mkdir(evil);
  await mkdir(outside);
  await mkdir(join(home, 'work'));
  server = await startTestServer({ dataDir, env: { AI_SM_HOME_OVERRIDE: home } });
}

/**
 * Stop the child and remove the tree. `unlock` names entries a test made
 * read-only, with the mode to give back first, so they cannot defeat the
 * teardown; it runs only once the tree exists.
 */
export async function stopFsServer(unlock: () => [string, number][] = () => []): Promise<void> {
  if (server !== undefined) await server.stop();
  if (root !== undefined) {
    for (const [path, mode] of unlock()) await chmod(path, mode).catch(() => undefined);
    await removeTempDir(root);
  }
}
