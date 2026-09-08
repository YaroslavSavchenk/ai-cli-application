import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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
  // Absolute, not 'web': vite resolves a relative root against process.cwd(),
  // and this file is also re-exported by web/vite.config.ts so a `vite build`
  // run from inside web/ still gets the `define` below. A bundle built without
  // it ships the bare `__BUILD_ID__` identifier (2026-09-08: ReferenceError in
  // the boot path, 'token check' hung forever).
  root: fileURLToPath(new URL('./web', import.meta.url)),
  define: {
    __BUILD_ID__: JSON.stringify(buildId()),
  },
  build: {
    // Relative to `root`, so this is web/dist.
    outDir: 'dist',
    emptyOutDir: true,
  },
});
