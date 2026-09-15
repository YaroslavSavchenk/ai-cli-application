import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

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

/**
 * The one id this build is known by — computed ONCE so the compiled-in
 * `__BUILD_ID__` and the emitted `build-id.json` can never disagree.
 */
const BUILD_ID = buildId();

/**
 * Emit `build-id.json` = `{ "id": "<__BUILD_ID__>" }` beside index.html.
 *
 * WHY a file and not just the define: the SERVER has to answer two questions it
 * cannot answer from a hashed asset name alone — "is what I am serving a real,
 * complete build?" (server/restart.ts verifies a fresh build before it swaps it
 * in) and "is web/dist older than web/src?" (server/buildinfo.ts compares this
 * file's mtime with the frontend sources). It is written LAST-ish by the
 * bundler, so its presence is the marker of a build that finished.
 */
function buildIdFile(): Plugin {
  return {
    name: 'ai-sm-build-id',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'build-id.json',
        source: JSON.stringify({ id: BUILD_ID }) + '\n',
      });
    },
  };
}

/**
 * The frontend root. Absolute, not 'web': vite resolves a relative root
 * against process.cwd(), and this file is also re-exported by
 * web/vite.config.ts so a `vite build` run from inside web/ still gets the
 * `define` below. A bundle built without it ships the bare `__BUILD_ID__`
 * identifier (2026-09-08: ReferenceError in the boot path, 'token check' hung
 * forever). Every entry below is resolved against it for the same reason.
 */
const WEB_ROOT = fileURLToPath(new URL('./web', import.meta.url));

export default defineConfig({
  root: WEB_ROOT,
  define: {
    __BUILD_ID__: JSON.stringify(BUILD_ID),
  },
  plugins: [buildIdFile()],
  build: {
    // Relative to `root`, so this is web/dist.
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      // Two pages: the app shell, and the standalone mascot overlay page
      // (web/dist/mascot.html — the backend serves any file under web/dist,
      // so it needs no server change). Absolute paths, resolved against the
      // same WEB_ROOT: a relative input is resolved against process.cwd() and
      // breaks a build started from inside web/. The app's entry chunk keeps
      // its `assets/index-*.js` name, which is what server/buildinfo.ts looks
      // for; the mascot's is `assets/mascot-*.js`.
      input: {
        index: resolve(WEB_ROOT, 'index.html'),
        mascot: resolve(WEB_ROOT, 'mascot.html'),
      },
    },
  },
});
