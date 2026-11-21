/**
 * The unpacked-bundle layout the installed-mode restart tests boot from
 * (`tests/server/restart-installed.test.ts`, and since Nocturne D9 P4
 * `tests/server/restart-incompatible.test.ts`): `<app>/<version>` dirs, each a
 * copy of server/ and shared/, a SYMLINK to the repo's node_modules, a COPY of
 * the repo's already-built web/dist (never a rebuild), a bundle.json marker
 * and a node/bin/node symlink to this very node binary; `<app>/current` points
 * at one of them, as the installer leaves it.
 *
 * Moved out of restart-installed.test.ts unchanged when the D9 P4
 * incompatibility test needed it too (plus the `ptyProtocol` option).
 */
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempDirSync, projectRoot } from './helpers.ts';

/** The pinned runtime version a bundle marker claims; only its SHAPE matters. */
export const FIXTURE_NODE_VERSION = 'v24.8.0';

export interface InstalledAppFixture {
  /** `<app>` — the directory holding the version dirs and `current`. */
  root: string;
  /** `<app>/<name>`. */
  dir: (name: string) => string;
  /** `<app>/current/server/index.ts` — what the launcher starts. */
  entry: string;
  /** Repoint `current` at another version, exactly like the installer does. */
  point: (name: string) => void;
  remove: () => void;
}

/**
 * One version directory of an unpacked bundle. `broken` omits its node binary
 * (caught by the preflight's own verification); `noModules` omits node_modules
 * (NOT verified — only the standby's real boot can catch that one);
 * `ptyProtocol` (D9 P4) makes its copy of server/pty-host-wire.ts speak
 * another pty-host protocol — a version whose backend cannot adopt the
 * sessions of the pty-host an older version started.
 */
function makeBundleVersion(
  root: string,
  name: string,
  opts: { broken?: boolean; noModules?: boolean; ptyProtocol?: number } = {},
): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  cpSync(join(projectRoot, 'server'), join(dir, 'server'), { recursive: true });
  cpSync(join(projectRoot, 'shared'), join(dir, 'shared'), { recursive: true });
  if (opts.ptyProtocol !== undefined) {
    const wire = join(dir, 'server', 'pty-host-wire.ts');
    const text = readFileSync(wire, 'utf8');
    const line = /^export const PTY_HOST_PROTOCOL = \d+;$/m;
    if (!line.test(text)) throw new Error('server/pty-host-wire.ts no longer declares PTY_HOST_PROTOCOL as one line');
    writeFileSync(wire, text.replace(line, `export const PTY_HOST_PROTOCOL = ${opts.ptyProtocol};`));
  }
  cpSync(join(projectRoot, 'package.json'), join(dir, 'package.json'));
  // Production deps live INSIDE a real bundle; a symlink is the same thing for
  // module resolution and costs nothing to build.
  if (opts.noModules !== true) symlinkSync(join(projectRoot, 'node_modules'), join(dir, 'node_modules'));
  // The frontend the bundle serves: the repo's existing build, COPIED. Read
  // only — this suite never rebuilds web/dist.
  const dist = join(dir, 'web', 'dist');
  const source = join(projectRoot, 'web', 'dist');
  if (existsSync(join(source, 'index.html'))) {
    cpSync(source, dist, { recursive: true });
  } else {
    mkdirSync(join(dist, 'assets'), { recursive: true });
    writeFileSync(join(dist, 'index.html'), '<!doctype html><script src="/assets/index-Fixture0.js"></script>');
    writeFileSync(join(dist, 'assets', 'index-Fixture0.js'), 'console.log(1)\n');
    writeFileSync(join(dist, 'build-id.json'), JSON.stringify({ id: '20260908-0000-fixture' }));
  }
  if (opts.broken !== true) {
    mkdirSync(join(dir, 'node', 'bin'), { recursive: true });
    symlinkSync(process.execPath, join(dir, 'node', 'bin', 'node'));
  }
  writeFileSync(
    join(dir, 'bundle.json'),
    JSON.stringify({
      version: name,
      commit: '8c308cc',
      nodeVersion: FIXTURE_NODE_VERSION,
      builtAt: '2026-09-08T10:00:00.000Z',
      platform: 'linux-x64',
      glibcMin: '2.35',
    }),
  );
  return dir;
}

export function installedApp(
  versions: { name: string; broken?: boolean; noModules?: boolean; ptyProtocol?: number }[],
): InstalledAppFixture {
  // realpath'ed: server/bundle.ts compares realpaths, and the boot banner
  // prints the directory the process resolved itself to.
  const root = realpathSync(makeTempDirSync('ai-sm-app-'));
  for (const v of versions) {
    makeBundleVersion(root, v.name, {
      ...(v.broken === true ? { broken: true } : {}),
      ...(v.noModules === true ? { noModules: true } : {}),
      ...(v.ptyProtocol === undefined ? {} : { ptyProtocol: v.ptyProtocol }),
    });
  }
  const point = (name: string): void => {
    const link = join(root, 'current');
    try {
      rmSync(link, { force: true });
    } catch {
      // Not there yet.
    }
    symlinkSync(join(root, name), link);
  };
  point(versions[0]?.name as string);
  return {
    root,
    dir: (name) => join(root, name),
    entry: join(root, 'current', 'server', 'index.ts'),
    point,
    remove: () => rmSync(root, { recursive: true, force: true }),
  };
}
