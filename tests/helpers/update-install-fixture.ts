/**
 * The shared harness of the `tests/server/update-install*.test.ts` files —
 * Phase E, part 2: download, verify, and start the Setup
 * (server/update-install.ts).
 *
 * A real loopback asset server (`startAssets`: real redirects, real byte
 * streams, a real sha256), the release and sums bodies CI would publish, and
 * `makeController`: an `UpdateController` on a temp updates dir whose only
 * seams are the Windows launch (`launchSetup`, absent on Linux), the
 * free-space probe and the clock.
 *
 * Moved here out of `tests/server/update-install.test.ts` when it was split
 * by topic (PLAN-RESTRUCTURE O6); the code is unchanged.
 */
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { UpdateInstallStatus, UpdateRelease } from '../../shared/protocol.ts';
import { UpdateController, type LaunchSetupArgs } from '../../server/update-install.ts';
import { setupAssetName, SUMS_ASSET_NAME, UPDATE_OWNER, UPDATE_REPO } from '../../server/update-release.ts';
import { waitUntil, makeTempDir, removeTempDir } from './helpers.ts';

export const VERSION = 'v0.3.0';
export const SETUP_NAME = setupAssetName(VERSION);
/** The bytes the "Setup" is made of in these tests. */
export const SETUP_BYTES = Buffer.from('MZ this is not really an installer, but it hashes like one\n');
export const SETUP_SHA = createHash('sha256').update(SETUP_BYTES).digest('hex');

export interface AssetStub {
  origin: string;
  /** Path -> handler. Replaced per test. */
  routes: Map<string, (req: IncomingMessage, res: ServerResponse) => void>;
  hits: string[];
  close: () => Promise<void>;
}

export async function startAssets(): Promise<AssetStub> {
  const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => void>();
  const hits: string[] = [];
  const server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0] as string;
    hits.push(path);
    const handler = routes.get(path);
    if (handler === undefined) {
      res.writeHead(404).end('nope');
      return;
    }
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    routes,
    hits,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

export function downloadPath(name: string): string {
  return `/${UPDATE_OWNER}/${UPDATE_REPO}/releases/download/${VERSION}/${name}`;
}

export function releaseFor(stub: AssetStub, size = SETUP_BYTES.byteLength): UpdateRelease {
  return {
    version: VERSION,
    setupName: SETUP_NAME,
    setupUrl: `${stub.origin}${downloadPath(SETUP_NAME)}`,
    sumsUrl: `${stub.origin}${downloadPath(SUMS_ASSET_NAME)}`,
    size,
  };
}

/** The sums body CI writes: several assets, one of them ours. */
export function sumsBody(sha = SETUP_SHA): string {
  return [
    `${sha}  ${SETUP_NAME}`,
    `${'b'.repeat(64)}  ai-session-manager-linux-x64.tar.gz`,
    `${'c'.repeat(64)}  AiSessionManagerHost-win-x64.zip`,
    '',
  ].join('\n');
}

export interface Harness {
  controller: UpdateController;
  updatesDir: string;
  root: string;
  launched: LaunchSetupArgs[];
  lines: string[];
  cleanup: () => Promise<void>;
}

export async function makeController(
  stub: AssetStub,
  opts: {
    release?: UpdateRelease;
    installed?: boolean;
    launchExit?: number | (() => Promise<number>);
    installedAfterLaunch?: boolean;
    statfsFree?: number;
    setupTimeoutMs?: number;
  } = {},
): Promise<Harness> {
  const root = await makeTempDir('ai-sm-update-install-');
  const updatesDir = join(root, 'updates');
  const launched: LaunchSetupArgs[] = [];
  const lines: string[] = [];
  let installedNow = false;
  const controller = new UpdateController({
    log: (level, message) => lines.push(`${level} ${message}`),
    updatesDir,
    installed: opts.installed ?? true,
    release: () => opts.release ?? releaseFor(stub),
    installedCheck: () => ({
      available: installedNow,
      reason: installedNow ? 'a new version is installed' : null,
    }),
    launchSetup: async (args) => {
      launched.push(args);
      if (opts.installedAfterLaunch !== false) installedNow = true;
      if (typeof opts.launchExit === 'function') return opts.launchExit();
      return opts.launchExit ?? 0;
    },
    seamOrigin: stub.origin,
    ...(opts.statfsFree !== undefined
      ? { statfsImpl: async () => ({ bavail: opts.statfsFree as number, bsize: 1 }) }
      : {}),
    installedPollMs: 10,
    installedPollTimeoutMs: 300,
    idleTimeoutMs: 5_000,
    downloadTimeoutMs: 10_000,
    setupTimeoutMs: opts.setupTimeoutMs ?? 10_000,
  });
  return {
    controller,
    updatesDir,
    root,
    launched,
    lines,
    cleanup: () => removeTempDir(root),
  };
}

/** Serve the sums file and the exe honestly. */
export function serveHappy(stub: AssetStub, opts: { sums?: string; body?: Buffer } = {}): void {
  stub.routes.set(downloadPath(SUMS_ASSET_NAME), (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' }).end(opts.sums ?? sumsBody());
  });
  stub.routes.set(downloadPath(SETUP_NAME), (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(opts.body ?? SETUP_BYTES);
  });
}

/** Wait until the pipeline reaches a terminal state. */
export async function settled(controller: UpdateController): Promise<UpdateInstallStatus> {
  return waitUntil(
    () => {
      const status = controller.status();
      return status.state === 'installed' || status.state === 'failed' ? status : undefined;
    },
    'the update pipeline to settle',
    15_000,
    10,
  );
}
