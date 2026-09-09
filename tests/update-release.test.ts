/**
 * Phase E, part 1 — the release check (server/update-release.ts).
 *
 * The checker is the ONE thing in this app that talks to the network on its
 * own, and its answer decides what a single click will download and execute.
 * So everything here is asserted against a REAL loopback HTTP stub (the same
 * idiom as tests/github-apibase.test.ts): the request shape (no Authorization,
 * ever), the ETag round trip, the rate-limit backoff, and every gate that can
 * turn a published release into "nothing to offer".
 *
 * NO OUTBOUND TRAFFIC. Every checker in this file is pointed at 127.0.0.1, and
 * the seam that allows it (`AI_SM_UPDATE_API_BASE`) is proven at the bottom to
 * be loopback-only — a non-loopback value makes the server refuse to start,
 * before `listen`, with no runtime.json.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  UPDATE_NEW_VERSION_AVAILABLE,
  type UpdateRelease,
} from '../shared/protocol.ts';
import {
  composeUpdateStatus,
  createReleaseChecker,
  gateLatestRelease,
  isNewerVersion,
  readUpdateCheckCache,
  setupAssetName,
  SUMS_ASSET_NAME,
  UPDATE_OWNER,
  UPDATE_REPO,
  LATEST_RELEASE_PATH,
} from '../server/update-release.ts';
import { projectRoot } from './helpers.ts';

const CURRENT = 'v0.2.0';

/** One request the stub saw: everything the checker chose to send. */
interface Seen {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
}

interface Stub {
  origin: string;
  requests: Seen[];
  /** Replaced per test: what the next request answers. */
  handler: (req: IncomingMessage, res: ServerResponse) => void;
  close: () => Promise<void>;
}

async function startStub(): Promise<Stub> {
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
function releasePayload(
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
async function makeChecker(
  stub: Stub,
  opts: { current?: string; cacheFile?: string; lines?: string[] } = {},
): Promise<{
  checker: ReturnType<typeof createReleaseChecker>;
  cacheFile: string;
  root: string;
  lines: string[];
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), 'ai-sm-update-check-'));
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
      await rm(root, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// The happy path, and what the request looks like on the wire
// ---------------------------------------------------------------------------

test('release check: a newer release becomes the ONE online reason, with the asset urls we construct', async () => {
  const stub = await startStub();
  const fx = await makeChecker(stub);
  try {
    stub.handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', etag: '"abc123"' });
      res.end(JSON.stringify(releasePayload(stub.origin, 'v0.3.0')));
    };
    await fx.checker.checkNow();

    const status = fx.checker.status();
    assert.equal(status.available, true);
    assert.equal(status.reason, UPDATE_NEW_VERSION_AVAILABLE);
    const release = status.release as UpdateRelease;
    assert.deepEqual(release, {
      version: 'v0.3.0',
      setupName: 'AI-Session-Manager-Setup-v0.3.0.exe',
      setupUrl: `${stub.origin}/${UPDATE_OWNER}/${UPDATE_REPO}/releases/download/v0.3.0/AI-Session-Manager-Setup-v0.3.0.exe`,
      sumsUrl: `${stub.origin}/${UPDATE_OWNER}/${UPDATE_REPO}/releases/download/v0.3.0/SHA256SUMS.txt`,
      size: 5_000_000,
    });

    // The request itself: the documented path, the documented headers, and —
    // the one that matters — NO credential of any kind.
    assert.equal(stub.requests.length, 1);
    const seen = stub.requests[0] as Seen;
    assert.equal(seen.method, 'GET');
    assert.equal(seen.url, LATEST_RELEASE_PATH);
    assert.equal(seen.url, `/repos/${UPDATE_OWNER}/${UPDATE_REPO}/releases/latest`);
    assert.equal(seen.headers['accept'], 'application/vnd.github+json');
    assert.equal(seen.headers['user-agent'], 'ai-cli-session-manager');
    assert.equal(seen.headers['x-github-api-version'], '2022-11-28');
    assert.equal(seen.headers['authorization'], undefined, 'the release check is anonymous');
    assert.equal(seen.headers['cookie'], undefined);
    assert.equal(seen.headers['if-none-match'], undefined, 'no cache on the first ask');

    // The cache is persisted 0600 so a restart costs no rate-limit quota.
    const mode = (await stat(fx.cacheFile)).mode & 0o777;
    assert.equal(mode, 0o600, 'the ETag cache is 0600');
    const cached = JSON.parse(await readFile(fx.cacheFile, 'utf8')) as Record<string, unknown>;
    assert.equal(cached['etag'], '"abc123"');
    assert.deepEqual(cached['latest'], release, 'the LATEST RELEASE is cached, not the verdict');
    assert.match(cached['checkedAt'] as string, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    await fx.cleanup();
    await stub.close();
  }
});

test('release check: the same and an older version offer nothing', async () => {
  const stub = await startStub();
  const fx = await makeChecker(stub);
  try {
    for (const tag of ['v0.2.0', 'v0.1.9', 'v0.2.0+rebuild']) {
      stub.handler = (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(releasePayload(stub.origin, tag)));
      };
      await fx.checker.checkNow();
      assert.deepEqual(
        fx.checker.status(),
        { available: false, reason: null },
        `${tag} must not be offered to a ${CURRENT} install`,
      );
      assert.equal(fx.checker.release(), undefined);
    }
  } finally {
    await fx.cleanup();
    await stub.close();
  }
});

test('release check: the ETag round trip — a 304 keeps the offer and a fresh process adopts the cache', async () => {
  const stub = await startStub();
  const fx = await makeChecker(stub);
  try {
    stub.handler = (req, res) => {
      if (req.headers['if-none-match'] === '"etag-1"') {
        res.writeHead(304, { etag: '"etag-1"' }).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json', etag: '"etag-1"' });
      res.end(JSON.stringify(releasePayload(stub.origin, 'v0.3.0')));
    };
    await fx.checker.checkNow();
    assert.equal(fx.checker.status().release?.version, 'v0.3.0');

    // Second ask: conditional, 304, and the offer survives.
    await fx.checker.checkNow();
    assert.equal(stub.requests.length, 2);
    assert.equal((stub.requests[1] as Seen).headers['if-none-match'], '"etag-1"');
    assert.equal(fx.checker.status().release?.version, 'v0.3.0', 'a 304 does not drop the offer');

    // A NEW checker on the same data dir (i.e. a restarted backend) has the
    // notice back immediately, and asks conditionally.
    const second = await makeChecker(stub, { cacheFile: fx.cacheFile });
    try {
      assert.equal(second.checker.status().release?.version, 'v0.3.0', 'cache adopted at construction');
      await second.checker.checkNow();
      assert.equal((stub.requests[2] as Seen).headers['if-none-match'], '"etag-1"');
      assert.equal(second.checker.status().available, true);
    } finally {
      second.checker.stop();
      await rm(second.root, { recursive: true, force: true });
    }
  } finally {
    await fx.cleanup();
    await stub.close();
  }
});

test('release check: the cache holds the LATEST RELEASE, so a DOWNGRADE still gets the offer through a 304', async () => {
  // The bug, measured 2026-09-09: the cache held the VERDICT, the ETag only
  // validates the PAYLOAD. v0.3.1 wrote "no offer", the user downgraded to
  // v0.3.0 to test the button, every check answered 304, and the verdict was
  // never recomputed — the Update button stayed hidden forever.
  const stub = await startStub();
  const shared = await mkdtemp(join(tmpdir(), 'ai-sm-update-shared-'));
  const cacheFile = join(shared, 'update-check.json');
  /** The STATUS the stub really served, per request: no assertion here is
   *  allowed to pass because a 200 quietly rebuilt what a 304 must preserve. */
  const served: number[] = [];
  stub.handler = (req, res) => {
    if (req.headers['if-none-match'] === '"etag-1"') {
      served.push(304);
      res.writeHead(304, { etag: '"etag-1"' }).end();
      return;
    }
    served.push(200);
    res.writeHead(200, { 'content-type': 'application/json', etag: '"etag-1"' });
    res.end(JSON.stringify(releasePayload(stub.origin, 'v0.3.1')));
  };
  const onDisk = async (): Promise<Record<string, unknown>> =>
    JSON.parse(await readFile(cacheFile, 'utf8')) as Record<string, unknown>;
  try {
    // A: running v0.3.1 sees the v0.3.1 release and offers nothing.
    const a = await makeChecker(stub, { current: 'v0.3.1', cacheFile });
    try {
      await a.checker.checkNow();
      assert.deepEqual(a.checker.status(), { available: false, reason: null }, 'v0.3.1 is not newer');
      assert.deepEqual(served, [200], 'the first ask is unconditional and answers 200');
      const cached = await onDisk();
      assert.equal((cached['latest'] as UpdateRelease).version, 'v0.3.1', 'the descriptor is cached');
      assert.equal(cached['etag'], '"etag-1"');
      assert.ok(
        a.lines.some((l) => l === 'debug [update] release check: latest v0.3.1 is not newer than v0.3.1'),
        `the not-newer latest is logged as debug: ${JSON.stringify(a.lines)}`,
      );
    } finally {
      a.checker.stop();
      await rm(a.root, { recursive: true, force: true });
    }

    // B: the SAME cache file, now running v0.3.0 — the downgrade. The offer is
    // back at construction, and a 304 does not take it away again.
    const b = await makeChecker(stub, { current: 'v0.3.0', cacheFile });
    try {
      assert.equal(b.checker.status().available, true, 'the cached descriptor is re-judged');
      assert.equal(b.checker.status().release?.version, 'v0.3.1');
      const before = stub.requests.length;
      await b.checker.checkNow();
      assert.equal(stub.requests.length, before + 1);
      assert.equal(
        (stub.requests[before] as Seen).headers['if-none-match'],
        '"etag-1"',
        'still conditional: the fix costs no rate-limit quota',
      );
      assert.deepEqual(served, [200, 304], 'the answer really was a 304, not a fresh 200');
      assert.equal(b.checker.status().release?.version, 'v0.3.1', 'a 304 keeps the offer');
      assert.equal(b.checker.release()?.version, 'v0.3.1');
      // And the 304 wrote the descriptor back, so the NEXT process still has it.
      const after = await onDisk();
      assert.equal((after['latest'] as UpdateRelease).version, 'v0.3.1', 'a 304 keeps the descriptor on disk');
      assert.equal(after['etag'], '"etag-1"');
    } finally {
      b.checker.stop();
      await rm(b.root, { recursive: true, force: true });
    }

    // C: the mirror — back on v0.3.1, the same cache offers nothing, before and
    // after a 304. No nag after an upgrade.
    const c = await makeChecker(stub, { current: 'v0.3.1', cacheFile });
    try {
      assert.deepEqual(c.checker.status(), { available: false, reason: null });
      await c.checker.checkNow();
      assert.deepEqual(served, [200, 304, 304], 'still conditional, still a 304');
      assert.deepEqual(c.checker.status(), { available: false, reason: null }, 'no nag after a 304');
      assert.equal(c.checker.release(), undefined);
      const after = await onDisk();
      assert.equal(
        (after['latest'] as UpdateRelease).version,
        'v0.3.1',
        'the descriptor stays whatever the version order says',
      );
    } finally {
      c.checker.stop();
      await rm(c.root, { recursive: true, force: true });
    }
  } finally {
    await rm(shared, { recursive: true, force: true });
    await stub.close();
  }
});

test('release check: an OLD-SHAPE cache file is no cache — the next ask is unconditional', async () => {
  const stub = await startStub();
  const shared = await mkdtemp(join(tmpdir(), 'ai-sm-update-oldshape-'));
  const cacheFile = join(shared, 'update-check.json');
  const oldRelease = {
    version: 'v0.3.0',
    setupName: setupAssetName('v0.3.0'),
    setupUrl: `${stub.origin}/${UPDATE_OWNER}/${UPDATE_REPO}/releases/download/v0.3.0/${setupAssetName('v0.3.0')}`,
    sumsUrl: `${stub.origin}/${UPDATE_OWNER}/${UPDATE_REPO}/releases/download/v0.3.0/${SUMS_ASSET_NAME}`,
    size: 5_000_000,
  };
  try {
    for (const old of [
      { etag: '"etag-old"', checkedAt: '2026-09-09T10:00:00.000Z', release: oldRelease },
      { etag: '"etag-old"', checkedAt: '2026-09-09T10:00:00.000Z', release: null },
    ]) {
      await writeFile(cacheFile, JSON.stringify(old));
      const opts = { currentVersion: CURRENT, assetBase: stub.origin };
      assert.equal(readUpdateCheckCache(cacheFile, opts), null, 'the old shape does not read');

      stub.requests.length = 0;
      stub.handler = (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json', etag: '"etag-new"' });
        res.end(JSON.stringify(releasePayload(stub.origin, 'v0.3.0')));
      };
      const fx = await makeChecker(stub, { cacheFile });
      try {
        assert.deepEqual(fx.checker.status(), { available: false, reason: null }, 'nothing adopted');
        await fx.checker.checkNow();
        assert.equal(
          (stub.requests[0] as Seen).headers['if-none-match'],
          undefined,
          'no ETag survives the shape change: one full 200 rebuilds the truth',
        );
        assert.equal(fx.checker.status().release?.version, 'v0.3.0');
        const written = JSON.parse(await readFile(cacheFile, 'utf8')) as Record<string, unknown>;
        assert.equal(written['etag'], '"etag-new"');
        assert.equal((written['latest'] as UpdateRelease).version, 'v0.3.0');
        assert.equal(written['release'], undefined, 'the old key is gone');
      } finally {
        fx.checker.stop();
        await rm(fx.root, { recursive: true, force: true });
      }
    }
  } finally {
    await rm(shared, { recursive: true, force: true });
    await stub.close();
  }
});

test('release check: a 200 with no usable ETag DROPS the cache file — the next boot asks in full', async () => {
  // persist() has no validator to write, and a descriptor kept beside a stale
  // ETag would be re-adopted for a release that may be gone. The file goes.
  const stub = await startStub();
  const shared = await mkdtemp(join(tmpdir(), 'ai-sm-update-noetag-'));
  const cacheFile = join(shared, 'update-check.json');
  try {
    // First: a normal 200 WITH an ETag writes the cache.
    stub.handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', etag: '"etag-1"' });
      res.end(JSON.stringify(releasePayload(stub.origin, 'v0.3.0')));
    };
    const first = await makeChecker(stub, { cacheFile });
    try {
      await first.checker.checkNow();
      assert.ok(existsSync(cacheFile), 'the cache exists after a 200 with an ETag');
    } finally {
      first.checker.stop();
      await rm(first.root, { recursive: true, force: true });
    }

    for (const [what, headers] of [
      ['no etag header at all', { 'content-type': 'application/json' }],
      ['an etag that fails the shape gate', { 'content-type': 'application/json', etag: 'not-quoted' }],
    ] as [string, Record<string, string>][]) {
      await writeFile(
        cacheFile,
        JSON.stringify({
          etag: '"etag-1"',
          checkedAt: '2026-09-09T10:00:00.000Z',
          latest: {
            version: 'v0.3.0',
            setupName: setupAssetName('v0.3.0'),
            setupUrl: `${stub.origin}/${UPDATE_OWNER}/${UPDATE_REPO}/releases/download/v0.3.0/${setupAssetName('v0.3.0')}`,
            sumsUrl: `${stub.origin}/${UPDATE_OWNER}/${UPDATE_REPO}/releases/download/v0.3.0/${SUMS_ASSET_NAME}`,
            size: 5_000_000,
          },
        }),
      );
      stub.handler = (_req, res) => {
        res.writeHead(200, headers);
        res.end(JSON.stringify(releasePayload(stub.origin, 'v0.3.0')));
      };
      const fx = await makeChecker(stub, { cacheFile });
      try {
        await fx.checker.checkNow();
        assert.equal(fx.checker.status().release?.version, 'v0.3.0', `${what}: the offer still stands`);
        assert.equal(existsSync(cacheFile), false, `${what}: the cache file is removed`);
      } finally {
        fx.checker.stop();
        await rm(fx.root, { recursive: true, force: true });
      }
    }

    // A fresh process now has nothing to adopt and asks unconditionally.
    stub.requests.length = 0;
    stub.handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', etag: '"etag-2"' });
      res.end(JSON.stringify(releasePayload(stub.origin, 'v0.3.0')));
    };
    const last = await makeChecker(stub, { cacheFile });
    try {
      assert.deepEqual(last.checker.status(), { available: false, reason: null }, 'nothing adopted');
      await last.checker.checkNow();
      assert.equal((stub.requests[0] as Seen).headers['if-none-match'], undefined, 'a full ask');
    } finally {
      last.checker.stop();
      await rm(last.root, { recursive: true, force: true });
    }
  } finally {
    await rm(shared, { recursive: true, force: true });
    await stub.close();
  }
});

test('release check: a malformed, oversized or non-200 answer offers nothing and never throws', async () => {
  const stub = await startStub();
  const fx = await makeChecker(stub);
  try {
    const cases: [string, (res: ServerResponse) => void][] = [
      ['not json', (res) => res.writeHead(200).end('<html>nope</html>')],
      ['an array', (res) => res.writeHead(200).end('[1,2,3]')],
      ['null', (res) => res.writeHead(200).end('null')],
      [
        'a 2 MiB body (past the 1 MiB cap)',
        (res) => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(`{"pad":"${'x'.repeat(2 * 1024 * 1024)}"}`);
        },
      ],
      ['HTTP 500', (res) => res.writeHead(500).end('{}')],
      ['HTTP 404', (res) => res.writeHead(404).end('{}')],
    ];
    for (const [what, answer] of cases) {
      stub.handler = (_req, res) => answer(res);
      await fx.checker.checkNow();
      assert.deepEqual(
        fx.checker.status(),
        { available: false, reason: null },
        `${what} must offer nothing`,
      );
    }
    // And the log never quotes the body (a JSON.parse message would).
    assert.ok(!fx.lines.join('\n').includes('<html>'), 'a bad body is never echoed into the log');
  } finally {
    await fx.cleanup();
    await stub.close();
  }
});

test('release check: 403 with a rate-limit reset backs off and asks NOTHING until the window ends', async () => {
  const stub = await startStub();
  const root = await mkdtemp(join(tmpdir(), 'ai-sm-update-rl-'));
  const lines: string[] = [];
  let clock = 1_000_000;
  const checker = createReleaseChecker({
    currentVersion: CURRENT,
    apiBase: stub.origin,
    cacheFile: join(root, 'update-check.json'),
    log: (level, message) => lines.push(`${level} ${message}`),
    now: () => clock,
    firstCheckMs: 3_600_000,
    intervalMs: 3_600_000,
  });
  try {
    stub.handler = (_req, res) => {
      res.writeHead(403, {
        'x-ratelimit-remaining': '0',
        // Reset in 30 minutes (seconds since the epoch, as GitHub sends it).
        'x-ratelimit-reset': String(Math.floor(clock / 1000) + 1800),
      });
      res.end('{"message":"API rate limit exceeded"}');
    };
    await checker.checkNow();
    assert.equal(stub.requests.length, 1);
    assert.deepEqual(checker.status(), { available: false, reason: null });

    // Still inside the window: no request leaves at all.
    clock += 60_000;
    await checker.checkNow();
    assert.equal(stub.requests.length, 1, 'a rate-limited checker does not nag');

    // ONE warn per rate-limit hit, and it never quotes the remote message.
    const warns = lines.filter((l) => l.startsWith('warn'));
    assert.equal(warns.length, 1, `exactly one warn: ${JSON.stringify(warns)}`);
    assert.match(warns[0] as string, /rate limited \(HTTP 403, remaining 0\); not asking again for 1800000ms/);
    assert.ok(!lines.join('\n').includes('API rate limit exceeded'), 'no remote text in the log');

    // Past the window it asks again.
    clock += 1_800_000;
    stub.handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(releasePayload(stub.origin, 'v0.3.0')));
    };
    await checker.checkNow();
    assert.equal(stub.requests.length, 2);
    assert.equal(checker.status().release?.version, 'v0.3.0');
  } finally {
    checker.stop();
    await rm(root, { recursive: true, force: true });
    await stub.close();
  }
});

// ---------------------------------------------------------------------------
// The gates — every way a published release is refused
// ---------------------------------------------------------------------------

test('gateLatestRelease: draft, pre-release, a bad tag, and a tag that is not newer', () => {
  const origin = 'https://github.com';
  const opts = { assetBase: origin };
  const ok = gateLatestRelease(releasePayload(origin, 'v0.3.0'), opts);
  assert.equal(ok.ok, true, 'the baseline payload passes');

  const cases: [string, unknown, RegExp][] = [
    ['a draft', releasePayload(origin, 'v0.3.0', { draft: true }), /draft/],
    ['a pre-release', releasePayload(origin, 'v0.3.0', { prerelease: true }), /pre-release/],
    ['draft missing', releasePayload(origin, 'v0.3.0', { draft: undefined }), /draft/],
    ['a tag with a path in it', releasePayload(origin, 'v0.3.0', { tag_name: '../../etc' }), /tag/],
    ['a tag with a space', releasePayload(origin, 'v0.3.0', { tag_name: 'v0.3.0 x' }), /tag/],
    ['an empty tag', releasePayload(origin, 'v0.3.0', { tag_name: '' }), /tag/],
    ['no assets', releasePayload(origin, 'v0.3.0', { assets: 'nope' }), /asset list/],
    ['not an object', 'nope', /JSON object/],
    ['null', null, /JSON object/],
  ];
  for (const [what, payload, why] of cases) {
    const res = gateLatestRelease(payload, opts);
    assert.equal(res.ok, false, `${what} must be refused`);
    assert.match((res as { why: string }).why, why, what);
  }

  // A tag that is not newer is NOT a gate refusal: the payload is usable, and
  // only the comparison against the running version withholds the offer.
  for (const tag of ['v0.1.0', CURRENT]) {
    const res = gateLatestRelease(releasePayload(origin, tag), opts);
    assert.equal(res.ok, true, `${tag} is still a usable latest release`);
    assert.equal(isNewerVersion(tag, CURRENT), false, `${tag} is not an offer`);
  }
});

test('gateLatestRelease: the asset rules — our constructed name, uploaded state, our url, a sane size', () => {
  const origin = 'https://github.com';
  const opts = { assetBase: origin };
  const cases: [string, unknown, RegExp][] = [
    [
      'the Setup is named something else',
      releasePayload(origin, 'v0.3.0', {}, { name: 'Setup.exe' }),
      /no Setup asset/,
    ],
    [
      'the Setup is still uploading',
      releasePayload(origin, 'v0.3.0', {}, { state: 'starter' }),
      /not uploaded/,
    ],
    [
      'the Setup url points elsewhere',
      releasePayload(
        origin,
        'v0.3.0',
        {},
        { browser_download_url: 'https://evil.example.com/AI-Session-Manager-Setup-v0.3.0.exe' },
      ),
      /not the one we construct/,
    ],
    [
      'the Setup url is on a look-alike host',
      releasePayload(
        origin,
        'v0.3.0',
        {},
        {
          browser_download_url: `https://github.com.evil.example/${UPDATE_OWNER}/${UPDATE_REPO}/releases/download/v0.3.0/AI-Session-Manager-Setup-v0.3.0.exe`,
        },
      ),
      /not the one we construct/,
    ],
    ['a zero size', releasePayload(origin, 'v0.3.0', {}, { size: 0 }), /size/],
    ['a fractional size', releasePayload(origin, 'v0.3.0', {}, { size: 1.5 }), /size/],
    ['a size past 200 MiB', releasePayload(origin, 'v0.3.0', {}, { size: 210 * 1024 * 1024 }), /size/],
    ['a string size', releasePayload(origin, 'v0.3.0', {}, { size: '100' }), /size/],
    [
      'no SHA256SUMS.txt',
      releasePayload(origin, 'v0.3.0', {}, {}, { name: 'sums.txt' }),
      /no SHA256SUMS.txt/,
    ],
    [
      'SHA256SUMS.txt still uploading',
      releasePayload(origin, 'v0.3.0', {}, {}, { state: 'starter' }),
      /not uploaded/,
    ],
    [
      'the sums url points elsewhere',
      releasePayload(origin, 'v0.3.0', {}, {}, { browser_download_url: 'https://evil.example.com/SHA256SUMS.txt' }),
      /not the one we construct/,
    ],
  ];
  for (const [what, payload, why] of cases) {
    const res = gateLatestRelease(payload, opts);
    assert.equal(res.ok, false, `${what} must be refused`);
    assert.match((res as { why: string }).why, why, what);
  }
});

test('gateLatestRelease: version order is NOT its business', () => {
  const origin = 'https://github.com';
  for (const tag of ['v0.1.0', CURRENT, 'v0.3.0']) {
    const latest = gateLatestRelease(releasePayload(origin, tag), { assetBase: origin });
    assert.equal(latest.ok, true, `${tag} is a usable latest release`);
    assert.equal((latest as { release: UpdateRelease }).release.version, tag);
    assert.equal(isNewerVersion(tag, CURRENT), tag === 'v0.3.0', `${tag}: only a newer tag is an offer`);
  }
  // Every non-version refusal still belongs to the payload gate.
  const draft = gateLatestRelease(releasePayload(origin, 'v0.3.0', { draft: true }), {
    assetBase: origin,
  });
  assert.equal(draft.ok, false);
  assert.match((draft as { why: string }).why, /draft/);
});

test('release check: a refused release is refused END TO END, over the wire', async () => {
  const stub = await startStub();
  const fx = await makeChecker(stub);
  try {
    const payloads = [
      releasePayload(stub.origin, 'v0.3.0', { draft: true }),
      releasePayload(stub.origin, 'v0.3.0', { prerelease: true }),
      releasePayload(stub.origin, 'v0.3.0', {}, { name: 'Setup.exe' }),
      releasePayload(stub.origin, 'v0.3.0', {}, { browser_download_url: 'https://evil.example.com/x.exe' }),
      releasePayload(stub.origin, 'v0.3.0', {}, {}, { name: 'sums.txt' }),
    ];
    for (const payload of payloads) {
      stub.handler = (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      await fx.checker.checkNow();
      assert.deepEqual(fx.checker.status(), { available: false, reason: null });
      assert.equal(fx.checker.release(), undefined, 'nothing is offered to POST /api/update');
    }
  } finally {
    await fx.cleanup();
    await stub.close();
  }
});

// ---------------------------------------------------------------------------
// The persisted cache is untrusted disk content
// ---------------------------------------------------------------------------

test('readUpdateCheckCache: a doctored cache file can never point the downloader anywhere', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-sm-update-cache-'));
  const file = join(root, 'update-check.json');
  const opts = { currentVersion: CURRENT, assetBase: 'https://github.com' };
  const good = {
    etag: '"abc"',
    checkedAt: '2026-09-09T10:00:00.000Z',
    latest: {
      version: 'v0.3.0',
      setupName: 'AI-Session-Manager-Setup-v0.3.0.exe',
      setupUrl: `https://github.com/${UPDATE_OWNER}/${UPDATE_REPO}/releases/download/v0.3.0/AI-Session-Manager-Setup-v0.3.0.exe`,
      sumsUrl: `https://github.com/${UPDATE_OWNER}/${UPDATE_REPO}/releases/download/v0.3.0/SHA256SUMS.txt`,
      size: 5_000_000,
    },
  };
  try {
    await writeFile(file, JSON.stringify(good));
    assert.deepEqual(readUpdateCheckCache(file, opts)?.latest, good.latest, 'the good file reads back');

    const bad: [string, unknown][] = [
      ['a url on another host', { ...good, latest: { ...good.latest, setupUrl: 'https://evil.example.com/x.exe' } }],
      ['a sums url on another host', { ...good, latest: { ...good.latest, sumsUrl: 'https://evil.example.com/s.txt' } }],
      ['a name that is not ours', { ...good, latest: { ...good.latest, setupName: 'anything.exe' } }],
      ['a tag with a path', { ...good, latest: { ...good.latest, version: '../../x' } }],
      ['a huge size', { ...good, latest: { ...good.latest, size: 1e12 } }],
      ['an etag with a newline', { ...good, etag: '"a\nb"' }],
      ['an etag that is not quoted', { ...good, etag: 'abc' }],
      ['a checkedAt that is free text', { ...good, checkedAt: 'yesterday' }],
      ['not an object', 'nope'],
      ['an array', [good]],
      // The OLD shape (the verdict under `release`) is not a cache: reading it
      // as one is exactly the bug that hid the Update button after a downgrade.
      ['the old shape with an offer', { etag: good.etag, checkedAt: good.checkedAt, release: good.latest }],
      ['the old shape with no offer', { etag: good.etag, checkedAt: good.checkedAt, release: null }],
      ['no latest member at all', { etag: good.etag, checkedAt: good.checkedAt }],
    ];
    for (const [what, value] of bad) {
      await writeFile(file, JSON.stringify(value));
      assert.equal(readUpdateCheckCache(file, opts), null, `${what} must read as no cache`);
    }

    // A cached latest that is the version we ALREADY run is KEPT as a
    // descriptor — the "is it newer?" verdict is not the cache's business, and
    // caching it is what made a downgrade unable to see the release again.
    const sameVersion = {
      version: CURRENT,
      setupName: setupAssetName(CURRENT),
      setupUrl: `https://github.com/${UPDATE_OWNER}/${UPDATE_REPO}/releases/download/${CURRENT}/${setupAssetName(CURRENT)}`,
      sumsUrl: `https://github.com/${UPDATE_OWNER}/${UPDATE_REPO}/releases/download/${CURRENT}/${SUMS_ASSET_NAME}`,
      size: 5_000_000,
    };
    await writeFile(file, JSON.stringify({ ...good, latest: sameVersion }));
    const same = readUpdateCheckCache(file, opts);
    assert.deepEqual(same?.latest, sameVersion, 'the descriptor survives, verdict-free');

    // `latest: null` = the latest release was refused for a non-version reason.
    await writeFile(file, JSON.stringify({ ...good, latest: null }));
    assert.deepEqual(readUpdateCheckCache(file, opts), {
      etag: good.etag,
      checkedAt: good.checkedAt,
      latest: null,
    });

    // Oversized: not even parsed.
    await writeFile(file, JSON.stringify({ ...good, pad: 'x'.repeat(9000) }));
    assert.equal(readUpdateCheckCache(file, opts), null, 'a file past 8 KiB is not a cache');

    // Absent.
    await rm(file);
    assert.equal(readUpdateCheckCache(file, opts), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Composition: installed-on-disk beats available-online
// ---------------------------------------------------------------------------

test('composeUpdateStatus: an unpacked bundle always wins over a published release', () => {
  const local = { available: true, reason: 'a new version is installed' };
  const online = {
    available: true,
    reason: UPDATE_NEW_VERSION_AVAILABLE,
    release: { version: 'v0.4.0', setupName: 'x', setupUrl: 'u', sumsUrl: 's', size: 1 },
  };
  assert.deepEqual(composeUpdateStatus(local, online), local, 'one restart beats one download');
  assert.deepEqual(composeUpdateStatus({ available: false, reason: null }, online), online);
  assert.deepEqual(composeUpdateStatus({ available: false, reason: null }, undefined), {
    available: false,
    reason: null,
  });
});

// ---------------------------------------------------------------------------
// The seam: loopback only, refuse to start otherwise
// ---------------------------------------------------------------------------

/** Boot server/index.ts with a hostile seam value; it must refuse to start. */
async function expectRefusedStart(value: string): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  dataDir: string;
  root: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'ai-sm-update-refuse-'));
  const dataDir = join(root, 'data');
  const child = spawn(process.execPath, [join(projectRoot, 'server', 'index.ts')], {
    cwd: projectRoot,
    env: {
      ...process.env,
      AI_SM_DATA_DIR: dataDir,
      AI_SM_UPDATE_API_BASE: value,
      AI_SM_STARTUP_GRACE_MS: '600000',
      AI_SM_GRACE_MS: '600000',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr?.on('data', (c: Buffer) => {
    stderr += c.toString('utf8');
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer);
  return { ...exit, stderr, dataDir, root };
}

test('AI_SM_UPDATE_API_BASE off loopback: the server REFUSES to start (exit 1, no runtime.json)', async () => {
  // With this seam set, the same origin also becomes the ONLY host an update
  // EXECUTABLE may be downloaded from — so a routable value is not a test
  // convenience, it is a remote-code-execution knob. It must be unusable.
  const cases: [string, RegExp][] = [
    ['https://api.evil.example.com', /must point at a loopback host/],
    ['http://127.0.0.2:8787', /must point at a loopback host/],
    ['https://api.github.com', /must point at a loopback host/],
    ['ftp://127.0.0.1:8787', /must use http:\/\/ or https:\/\//],
    ['http://127.0.0.1:8787/prefix', /must be a bare origin with no path, query or fragment/],
    ['not a url', /must be an absolute URL/],
  ];
  for (const [value, expected] of cases) {
    const res = await expectRefusedStart(value);
    try {
      assert.equal(res.code, 1, `${value}: must exit 1 (signal ${res.signal})`);
      assert.match(res.stderr, /AI_SM_UPDATE_API_BASE/, `${value}: the variable is named`);
      assert.match(res.stderr, expected, `${value}: expected refusal reason`);
      await assert.rejects(
        readFile(join(res.dataDir, 'runtime.json'), 'utf8'),
        `${value}: runtime.json must never appear`,
      );
      const log = await readFile(join(res.dataDir, 'server.log'), 'utf8');
      assert.match(log, /refusing to start: AI_SM_UPDATE_API_BASE/, 'the reason reaches server.log');
    } finally {
      await rm(res.root, { recursive: true, force: true });
    }
  }
});

test('AI_SM_UPDATE_API_BASE with embedded credentials: refused without echoing the value', async () => {
  const res = await expectRefusedStart('http://user:s3cr3tpw@127.0.0.1:8787');
  try {
    assert.equal(res.code, 1, `must exit 1 (signal ${res.signal})`);
    assert.match(res.stderr, /AI_SM_UPDATE_API_BASE must not embed credentials/);
    assert.ok(!res.stderr.includes('s3cr3tpw'), 'the value is never echoed to stderr');
    const log = await readFile(join(res.dataDir, 'server.log'), 'utf8');
    assert.ok(!log.includes('s3cr3tpw'), 'nor to server.log');
  } finally {
    await rm(res.root, { recursive: true, force: true });
  }
});
