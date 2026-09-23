/**
 * The shared stub and checker of the `tests/server/update-release*.test.ts`
 * files — Phase E, part 1, the release check (server/update-release.ts).
 *
 * `startStub` is a REAL loopback HTTP stub that records every request the
 * checker chose to send; `releasePayload` a well-formed `releases/latest`
 * answer with its assets on the stub origin; `makeChecker` a checker pointed
 * at the stub with a private cache file and no timer that outlives a test.
 *
 * Moved here out of `tests/server/update-release.test.ts` when it was split
 * by topic (PLAN-RESTRUCTURE O6); the code is unchanged.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import {
  createReleaseChecker,
  setupAssetName,
  SUMS_ASSET_NAME,
  UPDATE_OWNER,
  UPDATE_REPO,
} from '../../server/update-release.ts';
import { makeTempDir, removeTempDir } from './helpers.ts';

export const CURRENT = 'v0.2.0';

/** One request the stub saw: everything the checker chose to send. */
export interface Seen {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
}

export interface Stub {
  origin: string;
  requests: Seen[];
  /** Replaced per test: what the next request answers. */
  handler: (req: IncomingMessage, res: ServerResponse) => void;
  close: () => Promise<void>;
}

export async function startStub(): Promise<Stub> {
  const requests: Seen[] = [];
  const stub: Partial<Stub> = { requests };
  const server = createServer((req, res) => {
    requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers });
    (stub.handler as (r: IncomingMessage, s: ServerResponse) => void)(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  stub.origin = `http://127.0.0.1:${port}`;
  stub.handler = (_req, res) => {
    res.writeHead(404).end('{}');
  };
  stub.close = () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  return stub as Stub;
}

/** A well-formed `releases/latest` payload for `tag`, assets on the stub origin. */
export function releasePayload(
  origin: string,
  tag: string,
  overrides: Record<string, unknown> = {},
  assetOverrides: Record<string, unknown> = {},
  sumsOverrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const url = (name: string): string =>
    `${origin}/${UPDATE_OWNER}/${UPDATE_REPO}/releases/download/${tag}/${name}`;
  return {
    tag_name: tag,
    draft: false,
    prerelease: false,
    assets: [
      {
        name: setupAssetName(tag),
        state: 'uploaded',
        size: 5_000_000,
        browser_download_url: url(setupAssetName(tag)),
        ...assetOverrides,
      },
      {
        name: SUMS_ASSET_NAME,
        state: 'uploaded',
        size: 400,
        browser_download_url: url(SUMS_ASSET_NAME),
        ...sumsOverrides,
      },
    ],
    ...overrides,
  };
}

/** A checker pointed at the stub, with a private cache file. */
export async function makeChecker(
  stub: Stub,
  opts: { current?: string; cacheFile?: string; lines?: string[] } = {},
): Promise<{
  checker: ReturnType<typeof createReleaseChecker>;
  cacheFile: string;
  root: string;
  lines: string[];
  cleanup: () => Promise<void>;
}> {
  const root = await makeTempDir('ai-sm-update-check-');
  const cacheFile = opts.cacheFile ?? join(root, 'update-check.json');
  const lines = opts.lines ?? [];
  const checker = createReleaseChecker({
    currentVersion: opts.current ?? CURRENT,
    apiBase: stub.origin,
    cacheFile,
    log: (level, message) => lines.push(`${level} ${message}`),
    // The schedule is asserted separately; nothing here may arm a real timer
    // that outlives the test.
    firstCheckMs: 3_600_000,
    intervalMs: 3_600_000,
  });
  return {
    checker,
    cacheFile,
    root,
    lines,
    cleanup: async () => {
      checker.stop();
      await removeTempDir(root);
    },
  };
}
