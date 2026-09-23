/**
 * Phase E, part 2 — download, verify, and start the Setup (server/update-install.ts):
 * the controller's pipeline — the happy path, every refusal, single flight
 * and the updates-dir hygiene — and the pure gates that decide what is
 * trusted (sumFor, assertAssetUrl, assertWindowsArg, the interop binaries).
 *
 * This is the code path that ends in "run an executable", so the tests are
 * written from the refusals inward: every one of them asserts that NOTHING
 * runnable exists and NOTHING was launched.
 *
 * Everything runs against a real loopback asset server (with real redirects,
 * real byte streams and a real sha256) and against a real filesystem; the only
 * seams are the Windows launch (`launchSetup`, absent on Linux), the free-space
 * probe and the clock.
 *
 * NOT claimed here (split out by topic, PLAN-RESTRUCTURE O6): the interop
 * launcher's argv contract with `launcher/run-update.ps1` —
 * `update-install-launcher.test.ts`; the routes and the boot seams on a real
 * backend — `update-install-boot.test.ts`; an installed backend end to end —
 * `update-install-e2e.test.ts`. The shared harness is
 * `tests/helpers/update-install-fixture.ts`. A real Windows Setup run is the
 * user's Windows check.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  UPDATE_ERROR_CHECKSUM,
  UPDATE_ERROR_DOWNLOAD,
  UPDATE_ERROR_FINISH,
  UPDATE_ERROR_SPACE,
  UPDATE_ERROR_START,
  type UpdateInstallStatus,
} from '../../shared/protocol.ts';
import {
  assertAssetUrl,
  assertWindowsArg,
  cleanupUpdatesDir,
  sumFor,
  UpdateController,
  UpdateFailure,
  UPDATE_IN_PROGRESS,
  UPDATE_NOT_INSTALLED,
  UPDATE_NOTHING_TO_INSTALL,
  POWERSHELL_PATH,
  CMD_PATH,
  WSLPATH_PATH,
} from '../../server/update-install.ts';
import { SUMS_ASSET_NAME } from '../../server/update-release.ts';
import {
  waitUntil,
  makeTempDir,
  removeTempDir,
  readSource,
} from '../helpers/helpers.ts';
import {
  VERSION,
  SETUP_NAME,
  SETUP_BYTES,
  SETUP_SHA,
  startAssets,
  downloadPath,
  releaseFor,
  sumsBody,
  type Harness,
  makeController,
  serveHappy,
  settled,
} from '../helpers/update-install-fixture.ts';

// ---------------------------------------------------------------------------
// The happy path
// ---------------------------------------------------------------------------

test('update: downloads the sums, verifies the exe, renames it and starts the Setup', async () => {
  const stub = await startAssets();
  const fx = await makeController(stub);
  try {
    serveHappy(stub);
    const outcome = await fx.controller.request();
    assert.deepEqual(outcome, { status: 202, body: { version: VERSION } });

    const status = await settled(fx.controller);
    assert.deepEqual(status, { state: 'installed', version: VERSION, percent: 100, error: null });

    // The sums file was fetched FIRST — nothing is trusted before it exists.
    assert.deepEqual(stub.hits, [downloadPath(SUMS_ASSET_NAME), downloadPath(SETUP_NAME)]);

    const dir = join(fx.updatesDir, VERSION);
    assert.ok(existsSync(join(dir, SETUP_NAME)), 'the verified exe carries the runnable name');
    assert.ok(!existsSync(join(dir, `${SETUP_NAME}.part`)), 'the .part is gone');
    assert.deepEqual(await readFile(join(dir, SETUP_NAME)), SETUP_BYTES, 'byte for byte');
    assert.equal((await stat(dir)).mode & 0o777, 0o700, 'the version dir is 0700');
    assert.equal((await stat(join(dir, SETUP_NAME))).mode & 0o777, 0o600);

    // What the Windows side is handed: the verified file and its hash.
    assert.equal(fx.launched.length, 1);
    assert.deepEqual(fx.launched[0], {
      version: VERSION,
      setupPath: join(dir, SETUP_NAME),
      setupName: SETUP_NAME,
      expectedSha: SETUP_SHA,
    });
    assert.equal(fx.controller.inProgress, false, 'the single-flight lock is released');
  } finally {
    await fx.cleanup();
    await stub.close();
  }
});

test('update: at most 3 redirects are followed, each re-validated', async () => {
  const stub = await startAssets();
  const fx = await makeController(stub);
  try {
    stub.routes.set(downloadPath(SUMS_ASSET_NAME), (_req, res) => {
      res.writeHead(200).end(sumsBody());
    });
    // Three hops, exactly the allowance — the real release flow is
    // github.com -> objects.githubusercontent.com.
    stub.routes.set(downloadPath(SETUP_NAME), (_req, res) => {
      res.writeHead(302, { location: `${stub.origin}/hop1` }).end();
    });
    stub.routes.set('/hop1', (_req, res) => {
      res.writeHead(302, { location: `${stub.origin}/hop2` }).end();
    });
    stub.routes.set('/hop2', (_req, res) => {
      res.writeHead(302, { location: `${stub.origin}/final` }).end();
    });
    stub.routes.set('/final', (_req, res) => {
      res.writeHead(200).end(SETUP_BYTES);
    });
    await fx.controller.request();
    const status = await settled(fx.controller);
    assert.equal(status.state, 'installed', `three hops must be followed: ${status.error}`);
    assert.equal(fx.launched.length, 1);
  } finally {
    await fx.cleanup();
    await stub.close();
  }
});

// ---------------------------------------------------------------------------
// Refusals — in every one of them, nothing runnable exists and nothing ran
// ---------------------------------------------------------------------------

/** Assert the shared post-condition of every refusal. */
async function assertNothingRan(fx: Harness, sentence: string): Promise<UpdateInstallStatus> {
  const status = await settled(fx.controller);
  assert.equal(status.state, 'failed', `expected a failure, got ${JSON.stringify(status)}`);
  assert.equal(status.error, sentence);
  assert.equal(fx.launched.length, 0, 'nothing was ever started on Windows');
  const dir = join(fx.updatesDir, VERSION);
  assert.ok(!existsSync(join(dir, SETUP_NAME)), 'no runnable file exists');
  assert.ok(!existsSync(join(dir, `${SETUP_NAME}.part`)), 'and no half-written one either');
  assert.equal(fx.controller.inProgress, false, 'the lock is released');
  return status;
}

test('update: a tampered byte — the sums file does not match — deletes the .part and runs nothing', async () => {
  const stub = await startAssets();
  const fx = await makeController(stub);
  try {
    // The sums file names our file with somebody else's hash: exactly what a
    // tampered download looks like from here.
    serveHappy(stub, { sums: sumsBody('a'.repeat(64)) });
    await fx.controller.request();
    await assertNothingRan(fx, UPDATE_ERROR_CHECKSUM);
  } finally {
    await fx.cleanup();
    await stub.close();
  }
});

test('update: a body shorter or longer than the release says is refused', async () => {
  for (const [what, body] of [
    ['short', SETUP_BYTES.subarray(0, 10)],
    ['long', Buffer.concat([SETUP_BYTES, Buffer.from('extra')])],
  ] as [string, Buffer][]) {
    const stub = await startAssets();
    const fx = await makeController(stub);
    try {
      serveHappy(stub, { body });
      await fx.controller.request();
      await assertNothingRan(fx, UPDATE_ERROR_DOWNLOAD);
    } finally {
      await fx.cleanup();
      await stub.close();
    }
    void what;
  }
});

test('update: a redirect off the allow-list is refused before a byte is written', async () => {
  const stub = await startAssets();
  const other = await startAssets(); // A different loopback origin = not the seam.
  const fx = await makeController(stub);
  try {
    other.routes.set(downloadPath(SETUP_NAME), (_req, res) => {
      res.writeHead(200).end(SETUP_BYTES);
    });
    stub.routes.set(downloadPath(SUMS_ASSET_NAME), (_req, res) => {
      res.writeHead(200).end(sumsBody());
    });
    stub.routes.set(downloadPath(SETUP_NAME), (_req, res) => {
      res.writeHead(302, { location: `${other.origin}${downloadPath(SETUP_NAME)}` }).end();
    });
    await fx.controller.request();
    await assertNothingRan(fx, UPDATE_ERROR_DOWNLOAD);
    assert.equal(other.hits.length, 0, 'the off-list host is never even contacted');
  } finally {
    await fx.cleanup();
    await other.close();
    await stub.close();
  }
});

test('update: a fourth redirect hop is refused', async () => {
  const stub = await startAssets();
  const fx = await makeController(stub);
  try {
    stub.routes.set(downloadPath(SUMS_ASSET_NAME), (_req, res) => {
      res.writeHead(200).end(sumsBody());
    });
    stub.routes.set(downloadPath(SETUP_NAME), (_req, res) => {
      res.writeHead(302, { location: `${stub.origin}/hop1` }).end();
    });
    for (const [from, to] of [
      ['/hop1', '/hop2'],
      ['/hop2', '/hop3'],
      ['/hop3', '/hop4'],
    ]) {
      stub.routes.set(from as string, (_req, res) => {
        res.writeHead(302, { location: `${stub.origin}${to}` }).end();
      });
    }
    stub.routes.set('/hop4', (_req, res) => {
      res.writeHead(200).end(SETUP_BYTES);
    });
    await fx.controller.request();
    await assertNothingRan(fx, UPDATE_ERROR_DOWNLOAD);
    assert.ok(!stub.hits.includes('/hop4'), 'the fourth hop is never requested');
  } finally {
    await fx.cleanup();
    await stub.close();
  }
});

test('update: an oversized release (past the 200 MiB cap) is refused before the request', async () => {
  const stub = await startAssets();
  const fx = await makeController(stub, { release: releaseFor(stub, 300 * 1024 * 1024) });
  try {
    serveHappy(stub);
    await fx.controller.request();
    await assertNothingRan(fx, UPDATE_ERROR_DOWNLOAD);
    assert.deepEqual(stub.hits, [downloadPath(SUMS_ASSET_NAME)], 'the exe is never requested');
  } finally {
    await fx.cleanup();
    await stub.close();
  }
});

test('update: not enough free space is its own sentence, and nothing is downloaded', async () => {
  const stub = await startAssets();
  // The precheck wants size * 2 + 64 MiB; offer a kilobyte.
  const fx = await makeController(stub, { statfsFree: 1024 });
  try {
    serveHappy(stub);
    await fx.controller.request();
    await assertNothingRan(fx, UPDATE_ERROR_SPACE);
    assert.deepEqual(stub.hits, [downloadPath(SUMS_ASSET_NAME)], 'the exe is never requested');
  } finally {
    await fx.cleanup();
    await stub.close();
  }
});

test('update: the exit-code table of run-update.ps1 — 2 checksum, 3 could-not-start, other did-not-finish', async () => {
  for (const [code, sentence] of [
    [1, UPDATE_ERROR_FINISH],
    [2, UPDATE_ERROR_CHECKSUM],
    // 3 is the script's OWN refusal (bad arguments, missing file, the Setup
    // could not be started) — never Inno's, which uses 1 for that.
    [3, UPDATE_ERROR_START],
    [5, UPDATE_ERROR_FINISH],
  ] as [number, string][]) {
    const stub = await startAssets();
    const fx = await makeController(stub, { launchExit: code, installedAfterLaunch: false });
    try {
      serveHappy(stub);
      await fx.controller.request();
      const status = await settled(fx.controller);
      assert.equal(status.state, 'failed');
      assert.equal(status.error, sentence, `exit ${code}`);
      assert.equal(fx.launched.length, 1);
    } finally {
      await fx.cleanup();
      await stub.close();
    }
  }
});

test('update: exit 0 but `current` never moves is a failure, not a success', async () => {
  const stub = await startAssets();
  const fx = await makeController(stub, { launchExit: 0, installedAfterLaunch: false });
  try {
    serveHappy(stub);
    await fx.controller.request();
    const status = await settled(fx.controller);
    assert.equal(status.state, 'failed', 'the exit code alone is not proof');
    assert.equal(status.error, UPDATE_ERROR_FINISH);
  } finally {
    await fx.cleanup();
    await stub.close();
  }
});

test('update: the launcher refusing to start maps to its own sentence', async () => {
  const stub = await startAssets();
  const root = await makeTempDir('ai-sm-update-start-');
  const controller = new UpdateController({
    log: () => {},
    updatesDir: join(root, 'updates'),
    installed: true,
    release: () => releaseFor(stub),
    installedCheck: () => ({ available: false, reason: null }),
    launchSetup: () => Promise.reject(new UpdateFailure(UPDATE_ERROR_START, 'no powershell here')),
    seamOrigin: stub.origin,
    installedPollMs: 10,
    installedPollTimeoutMs: 500,
  });
  try {
    serveHappy(stub);
    await controller.request();
    const status = await settled(controller);
    assert.equal(status.state, 'failed');
    assert.equal(status.error, UPDATE_ERROR_START);
  } finally {
    await removeTempDir(root);
    await stub.close();
  }
});

// ---------------------------------------------------------------------------
// Single flight, refusals before any work, and dir hygiene
// ---------------------------------------------------------------------------

test('update: a second request while one is running is 409 and changes nothing', async () => {
  const stub = await startAssets();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fx = await makeController(stub, {
    launchExit: async () => {
      await held;
      return 0;
    },
  });
  try {
    serveHappy(stub);
    assert.equal((await fx.controller.request()).status, 202);
    await waitUntil(
      () => (fx.launched.length === 1 ? true : undefined),
      'the pipeline to reach the Windows launch',
      10_000,
      10,
    );
    const second = await fx.controller.request();
    assert.deepEqual(second, { status: 409, body: { error: UPDATE_IN_PROGRESS } });
    assert.equal(fx.controller.status().state, 'installing');
    release();
    const status = await settled(fx.controller);
    assert.equal(status.state, 'installed');
    assert.equal(fx.launched.length, 1, 'the 409 started nothing');
  } finally {
    await fx.cleanup();
    await stub.close();
  }
});

test('update: a Setup that outruns its timeout fails, but the flight is HELD until the child exits', async () => {
  // Giving up on the wait is not stopping the installer: the child is
  // detached, so releasing the single flight at the timeout would let a second
  // press run a SECOND Setup next to the first one.
  const stub = await startAssets();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fx = await makeController(stub, {
    launchExit: async () => {
      await held;
      return 0;
    },
    installedAfterLaunch: false,
    setupTimeoutMs: 300,
  });
  try {
    serveHappy(stub);
    assert.equal((await fx.controller.request()).status, 202);
    const failed = await settled(fx.controller);
    assert.equal(failed.state, 'failed', 'the user is told, at the timeout');
    assert.equal(failed.error, UPDATE_ERROR_FINISH);

    // …and the fake Setup is still running.
    assert.equal(fx.controller.inProgress, true, 'the flight is still held');
    assert.deepEqual(await fx.controller.request(), { status: 409, body: { error: UPDATE_IN_PROGRESS } });
    assert.equal(fx.launched.length, 1, 'no second Setup was started');

    // Only its real exit releases the flight.
    release();
    await waitUntil(
      () => (fx.controller.inProgress ? undefined : true),
      'the flight to be released by the child exit',
      5_000,
      10,
    );
    assert.ok(
      fx.lines.some((l) => l.includes('the timed-out Setup ended (exit code 0)')),
      `the release is logged: ${fx.lines.join('\n')}`,
    );
    assert.equal((await fx.controller.request()).status, 202, 'and a new attempt is possible again');
    await settled(fx.controller);
    assert.equal(fx.launched.length, 2);
  } finally {
    await fx.cleanup();
    await stub.close();
  }
});

test('update: nothing on offer, and a developer clone, are refused with 422 before any request', async () => {
  const stub = await startAssets();
  const root = await makeTempDir('ai-sm-update-422-');
  try {
    const base = {
      log: () => {},
      updatesDir: join(root, 'updates'),
      installedCheck: () => ({ available: false, reason: null }),
      launchSetup: () => Promise.resolve(0),
      seamOrigin: stub.origin,
    };
    const nothing = new UpdateController({ ...base, installed: true, release: () => undefined });
    assert.deepEqual(await nothing.request(), {
      status: 422,
      body: { error: UPDATE_NOTHING_TO_INSTALL },
    });
    const clone = new UpdateController({ ...base, installed: false, release: () => releaseFor(stub) });
    assert.deepEqual(await clone.request(), { status: 422, body: { error: UPDATE_NOT_INSTALLED } });
    assert.deepEqual(clone.status(), { state: 'idle', version: null, percent: 0, error: null });
    assert.equal(stub.hits.length, 0, 'a refused update never touches the network');
  } finally {
    await removeTempDir(root);
    await stub.close();
  }
});

test('update: an install clears every OTHER version directory it finds', async () => {
  const stub = await startAssets();
  const fx = await makeController(stub);
  try {
    mkdirSync(join(fx.updatesDir, 'v0.2.9'), { recursive: true });
    writeFileSync(join(fx.updatesDir, 'v0.2.9', 'AI-Session-Manager-Setup-v0.2.9.exe'), 'stale');
    mkdirSync(join(fx.updatesDir, VERSION), { recursive: true });
    writeFileSync(join(fx.updatesDir, VERSION, `${SETUP_NAME}.part`), 'half a download');

    serveHappy(stub);
    await fx.controller.request();
    assert.equal((await settled(fx.controller)).state, 'installed');

    assert.ok(!existsSync(join(fx.updatesDir, 'v0.2.9')), 'the old version dir is gone');
    assert.ok(existsSync(join(fx.updatesDir, VERSION, SETUP_NAME)));
    assert.deepEqual(
      await readFile(join(fx.updatesDir, VERSION, SETUP_NAME)),
      SETUP_BYTES,
      'the stale .part was replaced, not appended to',
    );
  } finally {
    await fx.cleanup();
    await stub.close();
  }
});

test('cleanupUpdatesDir: removes the whole tree and never throws on an absent one', async () => {
  const root = await makeTempDir('ai-sm-update-clean-');
  try {
    const dir = join(root, 'updates');
    mkdirSync(join(dir, VERSION), { recursive: true });
    writeFileSync(join(dir, VERSION, SETUP_NAME), 'an exe nobody verified in this run');
    cleanupUpdatesDir(dir);
    assert.ok(!existsSync(dir));
    cleanupUpdatesDir(dir); // Idempotent.
    cleanupUpdatesDir(join(root, 'never-existed'));
  } finally {
    await removeTempDir(root);
  }
});

// ---------------------------------------------------------------------------
// The pure gates
// ---------------------------------------------------------------------------

test('sumFor: the parsing rules that decide whether a binary is trusted', () => {
  const sha = 'a'.repeat(64);
  assert.equal(sumFor(`${sha}  ${SETUP_NAME}\n`, SETUP_NAME), sha, 'two spaces (text mode)');
  assert.equal(sumFor(`${sha} *${SETUP_NAME}\n`, SETUP_NAME), sha, 'star (binary mode)');
  assert.equal(sumFor(`${sha}  ${SETUP_NAME}\r\n`, SETUP_NAME), sha, 'CRLF is tolerated');
  assert.equal(sumFor(`\n${sha}  ${SETUP_NAME}\n\n`, SETUP_NAME), sha, 'blank lines are skipped');

  const bad: [string, string][] = [
    ['no line for our file', `${sha}  other.exe\n`],
    ['our file twice', `${sha}  ${SETUP_NAME}\n${'b'.repeat(64)}  ${SETUP_NAME}\n`],
    ['a path instead of a name', `${sha}  dist/${SETUP_NAME}\n`],
    ['a windows path', `${sha}  C:\\tmp\\${SETUP_NAME}\n`],
    ['a short hash', `${'a'.repeat(63)}  ${SETUP_NAME}\n`],
    ['an uppercase hash', `${'A'.repeat(64)}  ${SETUP_NAME}\n`],
    ['one space', `${sha} ${SETUP_NAME}\n`],
    ['free text', `not a sums file at all\n`],
    ['a name with a space', `${sha}  my ${SETUP_NAME}\n`],
    ['201 lines', `${sha}  ${SETUP_NAME}\n${`${sha}  x.txt\n`.repeat(201)}`],
  ];
  for (const [what, text] of bad) {
    assert.throws(
      () => sumFor(text, SETUP_NAME),
      (err: unknown) => err instanceof UpdateFailure && err.sentence === UPDATE_ERROR_CHECKSUM,
      what,
    );
  }
});

test('assertAssetUrl: the host allow-list, with and without the loopback seam', () => {
  // Production: https, default port, github.com or *.githubusercontent.com.
  assert.equal(assertAssetUrl('https://github.com/a/b/releases/download/v1/x.exe').host, 'github.com');
  assert.equal(
    assertAssetUrl('https://objects.githubusercontent.com/deadbeef').host,
    'objects.githubusercontent.com',
  );
  const refused = [
    'http://github.com/x', // not https
    'https://github.com:8443/x', // non-default port
    'https://user:pw@github.com/x', // userinfo
    'https://evil.example.com/x',
    'https://github.com.evil.example/x',
    'https://githubusercontent.com.evil/x',
    'https://raw.githubusercontent.com.evil.com/x',
    'file:///etc/passwd',
    '/relative/path',
    'not a url',
  ];
  for (const value of refused) {
    assert.throws(
      () => assertAssetUrl(value),
      (err: unknown) => err instanceof UpdateFailure && err.sentence === UPDATE_ERROR_DOWNLOAD,
      value,
    );
  }
  // With the seam set the allow-list is exactly that origin — github.com included.
  const seam = 'http://127.0.0.1:8787';
  assert.equal(assertAssetUrl(`${seam}/x.exe`, seam).host, '127.0.0.1:8787');
  for (const value of ['https://github.com/x', 'http://127.0.0.1:8788/x', 'http://localhost:8787/x']) {
    assert.throws(() => assertAssetUrl(value, seam), UpdateFailure, value);
  }
});

test('assertWindowsArg: what may become an argv slot', () => {
  assert.equal(
    assertWindowsArg('C:\\Users\\Test User\\AppData\\Local\\Temp\\x.exe', 'Setup path'),
    'C:\\Users\\Test User\\AppData\\Local\\Temp\\x.exe',
    'spaces are fine',
  );
  // MAX_PATH - 1 is the ceiling, not 200: the staged path is %TEMP% plus the
  // staging directory, the version and the Setup name — some seventy
  // characters more than the value the %TEMP% gate ever sees.
  assert.equal(assertWindowsArg(`C:\\${'x'.repeat(256)}`, 'Setup path').length, 259);
  for (const bad of [
    'C:\\tmp\\%TEMP%\\x.exe',
    'C:\\tmp\\a"b.exe',
    'C:\\tmp\\a|b.exe',
    'C:\\tmp\\a<b.exe',
    'C:\\tmp\\a>b.exe',
    'C:\\tmp\\a?b.exe',
    'C:\\tmp\\a*b.exe',
    'C:\\tmp\\a\nb.exe',
    'C:\\tmp\\a\rb.exe',
    `C:\\tmp\\${'x'.repeat(256)}.exe`,
    `C:\\${'x'.repeat(257)}`,
    '',
  ]) {
    assert.throws(
      () => assertWindowsArg(bad, 'Setup path'),
      (err: unknown) => err instanceof UpdateFailure && err.sentence === UPDATE_ERROR_START,
      JSON.stringify(bad),
    );
  }
});

test('the interop binaries are absolute paths, never a PATH lookup', () => {
  assert.equal(CMD_PATH, '/mnt/c/Windows/System32/cmd.exe');
  assert.equal(POWERSHELL_PATH, '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe');
  assert.equal(WSLPATH_PATH, '/usr/bin/wslpath');
  // wslpath translates the path an installer is then executed from; resolving
  // it through an inherited PATH is not something this pipeline does. The bare
  // name survives only as a fallback for a distro that keeps it elsewhere.
  const src = readSource('server', 'update-install.ts');
  assert.match(src, /existsSync\(WSLPATH_PATH\) \? WSLPATH_PATH : 'wslpath'/);
  assert.doesNotMatch(src, /runCapture\('wslpath'/, 'never spawned by bare name outright');
});
