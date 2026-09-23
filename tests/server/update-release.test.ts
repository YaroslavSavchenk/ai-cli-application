/**
 * Phase E, part 1 — the release check (server/update-release.ts): the happy
 * path and what the request looks like on the wire, the ETag round trip and
 * the cache it keeps, the malformed answers and the rate-limit backoff.
 *
 * The checker is the ONE thing in this app that talks to the network on its
 * own, and its answer decides what a single click will download and execute.
 * So everything here is asserted against a REAL loopback HTTP stub (the same
 * idiom as tests/server/github-apibase.test.ts): the request shape (no Authorization,
 * ever), the ETag round trip, the rate-limit backoff, and every gate that can
 * turn a published release into "nothing to offer".
 *
 * NO OUTBOUND TRAFFIC. Every checker in this file is pointed at 127.0.0.1.
 *
 * NOT claimed here (split out by topic, PLAN-RESTRUCTURE O6): the gates that
 * refuse a published release, the untrusted cache file, the status
 * composition, and the proof that the `AI_SM_UPDATE_API_BASE` seam is
 * loopback-only — `tests/server/update-release-gates.test.ts`. The stub and
 * checker are `tests/helpers/update-release-fixture.ts`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  UPDATE_NEW_VERSION_AVAILABLE,
  type UpdateRelease,
} from '../../shared/protocol.ts';
import {
  createReleaseChecker,
  readUpdateCheckCache,
  setupAssetName,
  SUMS_ASSET_NAME,
  UPDATE_OWNER,
  UPDATE_REPO,
  LATEST_RELEASE_PATH,
} from '../../server/update-release.ts';
import { sleep, makeTempDir, removeTempDir } from '../helpers/helpers.ts';
import {
  CURRENT,
  type Seen,
  startStub,
  releasePayload,
  makeChecker,
} from '../helpers/update-release-fixture.ts';

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

test('release check: a check asked while one is IN FLIGHT adopts it instead of resolving early', async () => {
  const stub = await startStub();
  const fx = await makeChecker(stub);
  // Declared OUTSIDE the try so the teardown can always close the request the
  // stub is holding open. Without that, a regression that makes an assertion
  // below fail leaves the socket open and `stub.close()` blocks until the
  // runner's timeout — a 15 s "test timed out" instead of the real diff.
  let answer: (() => void) | undefined;
  try {
    // The stub holds the answer open: the first run is still talking to
    // "GitHub" while the second caller asks. That is the manual check landing
    // inside the periodic one — the case where resolving early would compose
    // the status the run in flight is about to replace.
    let arrived: (() => void) | undefined;
    const requestArrived = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    stub.handler = (_req, res) => {
      answer = () => {
        res.writeHead(200, { 'content-type': 'application/json', etag: '"inflight"' });
        res.end(JSON.stringify(releasePayload(stub.origin, 'v0.4.0')));
      };
      (arrived as () => void)();
    };

    const periodic = fx.checker.checkNow();
    await requestArrived;
    let manualDone = false;
    const manual = fx.checker.checkNow().then(() => {
      manualDone = true;
    });
    await sleep(50);
    assert.equal(manualDone, false, 'the manual check did NOT resolve on the old status');
    assert.equal(fx.checker.status().available, false, 'and nothing was applied yet');

    // Hand the answer over and clear it, so the teardown below cannot fire a
    // second writeHead at a response that is already finished.
    const fire = answer as () => void;
    answer = undefined;
    fire();
    await Promise.all([periodic, manual]);
    assert.equal(manualDone, true);
    const status = fx.checker.status();
    assert.equal(status.available, true, 'the adopted run had found the release');
    assert.equal(status.reason, UPDATE_NEW_VERSION_AVAILABLE);
    assert.equal((status.release as UpdateRelease).version, 'v0.4.0');
    assert.equal(stub.requests.length, 1, 'two callers, ONE request to GitHub');
  } finally {
    answer?.();
    await fx.cleanup();
    await stub.close();
  }
});

/**
 * The case the shared run EXISTS for, end to end: the run in flight is the
 * PERIODIC one (armed by the timer, not by a caller), and the user presses the
 * button while it is still talking to GitHub. The manual check must adopt that
 * run — one request, and an answer that already carries what it found. A timer
 * that bypasses the shared entry point passes the test above and fails here.
 */
test('release check: a manual check landing inside the PERIODIC run adopts it — ONE request', async () => {
  const stub = await startStub();
  const root = await makeTempDir('ai-sm-update-timer-');
  const lines: string[] = [];
  const checker = createReleaseChecker({
    currentVersion: CURRENT,
    apiBase: stub.origin,
    cacheFile: join(root, 'update-check.json'),
    log: (level, message) => lines.push(`${level} ${message}`),
    // The timer fires almost at once — that first run is the periodic one. The
    // interval is an hour, so nothing can fire a second time inside the test.
    firstCheckMs: 10,
    intervalMs: 3_600_000,
  });
  // Outside the try: the teardown must be able to close the request the stub is
  // holding open, or a failing assertion below hangs `stub.close()`.
  let answer: (() => void) | undefined;
  try {
    let arrived: (() => void) | undefined;
    const requestArrived = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    stub.handler = (_req, res) => {
      answer = () => {
        res.writeHead(200, { 'content-type': 'application/json', etag: '"timer"' });
        res.end(JSON.stringify(releasePayload(stub.origin, 'v0.4.0')));
      };
      (arrived as () => void)();
    };

    checker.start();
    await requestArrived; // the PERIODIC run is now mid-request

    let manualDone = false;
    const manual = checker.checkNow().then(() => {
      manualDone = true;
    });
    await sleep(50);
    assert.equal(manualDone, false, 'the button did not resolve on the pre-check status');
    assert.equal(stub.requests.length, 1, 'and it started no second request');
    assert.equal(checker.status().available, false, 'nothing applied while the run is open');

    const fire = answer as () => void;
    answer = undefined;
    fire();
    await manual;
    assert.equal(manualDone, true);
    const status = checker.status();
    assert.equal(status.available, true, 'the button answers what the periodic run found');
    assert.equal(status.reason, UPDATE_NEW_VERSION_AVAILABLE);
    assert.equal((status.release as UpdateRelease).version, 'v0.4.0');
    assert.equal(stub.requests.length, 1, 'timer and button shared ONE request to GitHub');
  } finally {
    answer?.();
    checker.stop();
    await removeTempDir(root);
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
  const shared = await makeTempDir('ai-sm-update-shared-');
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
    await removeTempDir(shared);
    await stub.close();
  }
});

test('release check: an OLD-SHAPE cache file is no cache — the next ask is unconditional', async () => {
  const stub = await startStub();
  const shared = await makeTempDir('ai-sm-update-oldshape-');
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
    await removeTempDir(shared);
    await stub.close();
  }
});

test('release check: a 200 with no usable ETag DROPS the cache file — the next boot asks in full', async () => {
  // persist() has no validator to write, and a descriptor kept beside a stale
  // ETag would be re-adopted for a release that may be gone. The file goes.
  const stub = await startStub();
  const shared = await makeTempDir('ai-sm-update-noetag-');
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
    await removeTempDir(shared);
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
  const root = await makeTempDir('ai-sm-update-rl-');
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
    await removeTempDir(root);
    await stub.close();
  }
});
