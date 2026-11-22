/**
 * A stub executable NAMED `claude`, for the tests that drive the `--settings`
 * injection through a real server (`tests/server/session-settings.test.ts`,
 * `tests/server/statusline-current.test.ts`): the server injects only for a
 * command whose last path segment is `claude`. It echoes its argv as
 * `ARGV<...>` into its PTY, then blocks.
 *
 * Moved out of session-settings.test.ts unchanged when the D9 P5 installed-mode
 * test needed it too.
 */
import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTempDir } from './helpers.ts';

/** A stub executable named `claude` that echoes its argv and then blocks. */
export async function makeStubClaude(): Promise<{ dir: string; bin: string }> {
  const dir = await makeTempDir('ai-sm-stubclaude-');
  const bin = join(dir, 'claude');
  await writeFile(bin, '#!/bin/bash\necho "ARGV<$*>"\nexec sleep 300\n');
  await chmod(bin, 0o755);
  return { dir, bin };
}
