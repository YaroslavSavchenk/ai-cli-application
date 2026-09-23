/**
 * Shared fixture for the `server/buildinfo.ts` tests
 * (`tests/server/buildinfo.test.ts`, `tests/server/buildinfo-update-check.test.ts`):
 * a temp directory standing in for a checkout, and a writer for files under
 * its `.git/`. No real repository is touched, no `git` binary is spawned.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTempDirSync } from './helpers.ts';

export const HASH = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
export const SHORT = 'a1b2c3d';

export function fixture(): string {
  return makeTempDirSync('ai-sm-buildinfo-');
}

/** Write `.git/<relative path>` under `root`, creating parent dirs. */
export function gitFile(root: string, rel: string, contents: string): void {
  const path = join(root, '.git', rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, contents);
}

export async function withFixture(fn: (root: string) => void | Promise<void>): Promise<void> {
  const root = fixture();
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
