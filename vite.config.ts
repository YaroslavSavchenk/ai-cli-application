import { execFileSync } from 'node:child_process';
import { defineConfig } from 'vite';

/**
 * Build identity for the bundle, compiled in as `__BUILD_ID__` and logged by
 * the UI's first line in server.log (`boot ui=<id> …`). It answers the one
 * question a stale-bundle bug always asks: is the page the user is looking at
 * the code we think it is?
 *
 * Shape: `<yyyymmdd-hhmm>-<git short hash>` (`-nogit` when the tree has no git
 * or the command fails — a build must never depend on git being present).
 */
function buildId(): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/T(\d{4})\d{2}\.\d+Z$/, '-$1');
  let hash = 'nogit';
  try {
    hash = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim();
  } catch {
    // No git, no repo, no problem — the timestamp alone still identifies it.
  }
  return `${stamp}-${hash === '' ? 'nogit' : hash}`;
}

export default defineConfig({
  root: 'web',
  define: {
    __BUILD_ID__: JSON.stringify(buildId()),
  },
  build: {
    // Relative to `root`, so this is web/dist.
    outDir: 'dist',
    emptyOutDir: true,
  },
});
