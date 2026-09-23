/**
 * Phase E, part 1 — the release check (server/update-release.ts): every way a
 * published release is refused (gateLatestRelease, and the same refusal over
 * the wire), the persisted cache as untrusted disk content, the composition
 * where installed-on-disk beats available-online, and the seam.
 *
 * How: the pure functions called in-process; the wire case against a REAL
 * loopback HTTP stub; the seam by booting `server/index.ts` as a child with a
 * hostile `AI_SM_UPDATE_API_BASE` — a non-loopback value (or one with
 * credentials) makes the server refuse to start, before `listen`, with no
 * runtime.json.
 *
 * Why: the checker's answer decides what one click downloads and executes; a
 * doctored cache file or a seam pointed off loopback would point it anywhere.
 *
 * NOT claimed here: the request shape, the ETag round trip and the backoff —
 * `tests/server/update-release.test.ts`.
 *
 * Split out of `tests/server/update-release.test.ts` by topic
 * (PLAN-RESTRUCTURE O6); the stub and checker are
 * `tests/helpers/update-release-fixture.ts`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  UPDATE_NEW_VERSION_AVAILABLE,
  type UpdateRelease,
} from '../../shared/protocol.ts';
import {
  composeUpdateStatus,
  gateLatestRelease,
  isNewerVersion,
  readUpdateCheckCache,
  setupAssetName,
  SUMS_ASSET_NAME,
  UPDATE_OWNER,
  UPDATE_REPO,
} from '../../server/update-release.ts';
import { projectRoot, makeTempDir, removeTempDir } from '../helpers/helpers.ts';
import {
  CURRENT,
  startStub,
  releasePayload,
  makeChecker,
} from '../helpers/update-release-fixture.ts';

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
  const root = await makeTempDir('ai-sm-update-cache-');
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
    await removeTempDir(root);
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
  const root = await makeTempDir('ai-sm-update-refuse-');
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
