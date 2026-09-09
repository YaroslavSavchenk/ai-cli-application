/**
 * Phase E, part 2 — download, verify, and start the Setup (server/update-install.ts).
 *
 * This is the code path that ends in "run an executable", so the tests are
 * written from the refusals inward: every one of them asserts that NOTHING
 * runnable exists and NOTHING was launched.
 *
 * Everything runs against a real loopback asset server (with real redirects,
 * real byte streams and a real sha256) and against a real filesystem; the only
 * seams are the Windows launch (`launchSetup`, absent on Linux), the free-space
 * probe and the clock. The interop launcher itself is asserted separately with
 * a fake spawn, so the exact argv contract with `launcher/run-update.ps1` is
 * pinned without a Windows machine.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  UPDATE_ERROR_CHECKSUM,
  UPDATE_ERROR_DOWNLOAD,
  UPDATE_ERROR_FINISH,
  UPDATE_ERROR_SPACE,
  UPDATE_ERROR_START,
  type UpdateInstallStatus,
  type UpdateRelease,
} from '../shared/protocol.ts';
import {
  assertAssetUrl,
  assertWindowsArg,
  cleanupUpdatesDir,
  createInteropLauncher,
  MAX_SCRIPT_OUTPUT_BYTES,
  sumFor,
  UpdateController,
  UpdateFailure,
  UPDATE_IN_PROGRESS,
  UPDATE_NOT_INSTALLED,
  UPDATE_NOTHING_TO_INSTALL,
  POWERSHELL_PATH,
  CMD_PATH,
  WSLPATH_PATH,
  RUN_UPDATE_SCRIPT,
  STAGING_DIR_NAME,
  type LaunchSetupArgs,
  type SpawnLike,
} from '../server/update-install.ts';
import { setupAssetName, SUMS_ASSET_NAME, UPDATE_OWNER, UPDATE_REPO } from '../server/update-release.ts';
import { api, presenceUrl, projectRoot, startTestServer, waitUntil, WsClient } from './helpers.ts';

const VERSION = 'v0.3.0';
const SETUP_NAME = setupAssetName(VERSION);
/** The bytes the "Setup" is made of in these tests. */
const SETUP_BYTES = Buffer.from('MZ this is not really an installer, but it hashes like one\n');
const SETUP_SHA = createHash('sha256').update(SETUP_BYTES).digest('hex');

interface AssetStub {
  origin: string;
  /** Path -> handler. Replaced per test. */
  routes: Map<string, (req: IncomingMessage, res: ServerResponse) => void>;
  hits: string[];
  close: () => Promise<void>;
}

async function startAssets(): Promise<AssetStub> {
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

function downloadPath(name: string): string {
  return `/${UPDATE_OWNER}/${UPDATE_REPO}/releases/download/${VERSION}/${name}`;
}

function releaseFor(stub: AssetStub, size = SETUP_BYTES.byteLength): UpdateRelease {
  return {
    version: VERSION,
    setupName: SETUP_NAME,
    setupUrl: `${stub.origin}${downloadPath(SETUP_NAME)}`,
    sumsUrl: `${stub.origin}${downloadPath(SUMS_ASSET_NAME)}`,
    size,
  };
}

/** The sums body CI writes: several assets, one of them ours. */
function sumsBody(sha = SETUP_SHA): string {
  return [
    `${sha}  ${SETUP_NAME}`,
    `${'b'.repeat(64)}  ai-session-manager-linux-x64.tar.gz`,
    `${'c'.repeat(64)}  AiSessionManagerHost-win-x64.zip`,
    '',
  ].join('\n');
}

interface Harness {
  controller: UpdateController;
  updatesDir: string;
  root: string;
  launched: LaunchSetupArgs[];
  lines: string[];
  cleanup: () => Promise<void>;
}

async function makeController(
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
  const root = await mkdtemp(join(tmpdir(), 'ai-sm-update-install-'));
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
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

/** Serve the sums file and the exe honestly. */
function serveHappy(stub: AssetStub, opts: { sums?: string; body?: Buffer } = {}): void {
  stub.routes.set(downloadPath(SUMS_ASSET_NAME), (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' }).end(opts.sums ?? sumsBody());
  });
  stub.routes.set(downloadPath(SETUP_NAME), (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(opts.body ?? SETUP_BYTES);
  });
}

/** Wait until the pipeline reaches a terminal state. */
async function settled(controller: UpdateController): Promise<UpdateInstallStatus> {
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
  const root = await mkdtemp(join(tmpdir(), 'ai-sm-update-start-'));
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
    await rm(root, { recursive: true, force: true });
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
  const root = await mkdtemp(join(tmpdir(), 'ai-sm-update-422-'));
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
    await rm(root, { recursive: true, force: true });
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
  const root = await mkdtemp(join(tmpdir(), 'ai-sm-update-clean-'));
  try {
    const dir = join(root, 'updates');
    mkdirSync(join(dir, VERSION), { recursive: true });
    writeFileSync(join(dir, VERSION, SETUP_NAME), 'an exe nobody verified in this run');
    cleanupUpdatesDir(dir);
    assert.ok(!existsSync(dir));
    cleanupUpdatesDir(dir); // Idempotent.
    cleanupUpdatesDir(join(root, 'never-existed'));
  } finally {
    await rm(root, { recursive: true, force: true });
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
  const src = readFileSync(join(projectRoot, 'server', 'update-install.ts'), 'utf8');
  assert.match(src, /existsSync\(WSLPATH_PATH\) \? WSLPATH_PATH : 'wslpath'/);
  assert.doesNotMatch(src, /runCapture\('wslpath'/, 'never spawned by bare name outright');
});

// ---------------------------------------------------------------------------
// The interop launcher — the exact argv contract with launcher/run-update.ps1
// ---------------------------------------------------------------------------

/**
 * A fake child process: a real stdout pipe (so the capture path is exercised),
 * `exit` on demand, and counted unref()s — on the child AND on the pipe, which
 * must never hold the backend's event loop.
 */
function fakeChild(): {
  child: ChildProcess;
  exit: (code: number) => void;
  say: (text: string) => void;
  endOut: () => void;
  unrefs: number;
  stdoutUnrefs: number;
} {
  const emitter = new EventEmitter() as ChildProcess;
  const state = { unrefs: 0, stdoutUnrefs: 0 };
  const stdout = new PassThrough() as PassThrough & { unref: () => void };
  stdout.unref = (): void => {
    state.stdoutUnrefs += 1;
  };
  (emitter as unknown as { stdout: PassThrough }).stdout = stdout;
  (emitter as unknown as { unref: () => void }).unref = () => {
    state.unrefs += 1;
  };
  return {
    child: emitter,
    exit: (code) => emitter.emit('exit', code, null),
    say: (text) => stdout.write(text),
    endOut: () => stdout.end(),
    get unrefs() {
      return state.unrefs;
    },
    get stdoutUnrefs() {
      return state.stdoutUnrefs;
    },
  };
}

test('interop launcher: the exact argv, the staging copy, and a detached-but-watched child', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-sm-update-interop-'));
  try {
    // A fake install: <appDir>/launcher/run-update.ps1 is what the bundle ships.
    const appDir = join(root, 'app', VERSION);
    mkdirSync(join(appDir, 'launcher'), { recursive: true });
    writeFileSync(join(appDir, 'launcher', RUN_UPDATE_SCRIPT), '# the windows script\n');
    // The verified exe, where the pipeline leaves it.
    const updates = join(root, 'data', 'updates', VERSION);
    mkdirSync(updates, { recursive: true });
    writeFileSync(join(updates, SETUP_NAME), SETUP_BYTES);
    // The Windows %TEMP%, as WSL sees it.
    const tempLinux = join(root, 'wintemp');
    mkdirSync(tempLinux, { recursive: true });

    let seen: { command: string; args: readonly string[]; options: Record<string, unknown> } | undefined;
    const fake = fakeChild();
    const spawnImpl: SpawnLike = (command, args, options) => {
      seen = { command, args, options: options as Record<string, unknown> };
      // What the script prints on a real run — the backend's only diagnostic.
      fake.say('Starting AI-Session-Manager-Setup-v0.3.0.exe (silent).\n');
      fake.say('Setup exited with code 0.\n');
      // Exit on the next tick, like a real process would.
      setTimeout(() => {
        fake.endOut();
        fake.exit(0);
      }, 5);
      return fake.child;
    };
    const lines: string[] = [];
    const launch = createInteropLauncher({
      log: (level, message) => lines.push(`${level} ${message}`),
      appDir,
      probeTemp: () => Promise.resolve({ win: 'C:\\Users\\Test User\\AppData\\Local\\Temp', linux: tempLinux }),
      spawnImpl,
    });

    const code = await launch({
      version: VERSION,
      setupPath: join(updates, SETUP_NAME),
      setupName: SETUP_NAME,
      expectedSha: SETUP_SHA,
    });
    assert.equal(code, 0, 'the exit code is reported back to the pipeline');

    const stageWin = `C:\\Users\\Test User\\AppData\\Local\\Temp\\${STAGING_DIR_NAME}\\${VERSION}`;
    assert.equal(seen?.command, POWERSHELL_PATH, 'the full interop path, never a PATH lookup');
    assert.deepEqual(seen?.args, [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      `${stageWin}\\${RUN_UPDATE_SCRIPT}`,
      '-SetupPath',
      `${stageWin}\\${SETUP_NAME}`,
      '-ExpectedSha',
      SETUP_SHA,
      '-LogPath',
      `${stageWin}\\setup.log`,
    ]);
    assert.equal(seen?.options['detached'], true);
    assert.deepEqual(
      seen?.options['stdio'],
      ['ignore', 'pipe', 'ignore'],
      'stdout is read so the script can be diagnosed; stdin and stderr stay closed',
    );
    assert.ok(!JSON.stringify(seen?.args).includes('-Command'), 'never -Command');
    assert.equal(fake.unrefs, 1, 'the Setup must not keep this backend alive');
    assert.equal(fake.stdoutUnrefs, 1, 'and neither may its stdout pipe');

    // Every printed line reached server.log, at debug after exit 0.
    assert.deepEqual(
      lines.filter((l) => l.includes('run-update.ps1:')),
      [
        'debug [update] run-update.ps1: Starting AI-Session-Manager-Setup-v0.3.0.exe (silent).',
        'debug [update] run-update.ps1: Setup exited with code 0.',
      ],
    );

    // The staging copy really happened, through plain fs (no Windows path on
    // any command line during it).
    const stageLinux = join(tempLinux, STAGING_DIR_NAME, VERSION);
    assert.deepEqual(await readFile(join(stageLinux, SETUP_NAME)), SETUP_BYTES);
    assert.equal(await readFile(join(stageLinux, RUN_UPDATE_SCRIPT), 'utf8'), '# the windows script\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('interop launcher: a 170-character %TEMP% still composes argv slots that fit', async () => {
  // The %TEMP% gate caps at 180 characters and the argv gate at 259
  // (MAX_PATH - 1) exactly so this case works: staging adds the directory
  // name, the version and the Setup name on top of whatever Windows reports.
  const root = await mkdtemp(join(tmpdir(), 'ai-sm-update-longtemp-'));
  try {
    const appDir = join(root, 'app', VERSION);
    mkdirSync(join(appDir, 'launcher'), { recursive: true });
    writeFileSync(join(appDir, 'launcher', RUN_UPDATE_SCRIPT), '# x\n');
    const updates = join(root, 'data', 'updates', VERSION);
    mkdirSync(updates, { recursive: true });
    writeFileSync(join(updates, SETUP_NAME), SETUP_BYTES);
    const tempLinux = join(root, 'wintemp');
    mkdirSync(tempLinux, { recursive: true });

    // 170 characters, spaces included, exactly as cmd.exe could print it.
    const longTemp = `C:\\Users\\Test User\\${'d'.repeat(146)}\\Temp`;
    assert.equal(longTemp.length, 170);

    let seen: readonly string[] | undefined;
    const fake = fakeChild();
    const code = await createInteropLauncher({
      log: () => {},
      appDir,
      probeTemp: () => Promise.resolve({ win: longTemp, linux: tempLinux }),
      spawnImpl: (_command, args) => {
        seen = args;
        setTimeout(() => {
          fake.endOut();
          fake.exit(0);
        }, 5);
        return fake.child;
      },
    })({
      version: VERSION,
      setupPath: join(updates, SETUP_NAME),
      setupName: SETUP_NAME,
      expectedSha: SETUP_SHA,
    });
    assert.equal(code, 0, 'no argv slot was refused for being too long');
    const setupWin = `${longTemp}\\${STAGING_DIR_NAME}\\${VERSION}\\${SETUP_NAME}`;
    assert.ok(seen?.includes(setupWin), `${setupWin} (${setupWin.length} chars) is not in ${String(seen)}`);
    assert.ok(setupWin.length > 200, 'and it is longer than the old 200-character cap allowed');
    assert.ok(setupWin.length <= 259, 'while still fitting MAX_PATH - 1');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('interop launcher: the composed staged path is length-checked BEFORE anything is staged', async () => {
  // The gate that matters is not %TEMP% (180) or the argv cap (259) on their
  // own, but `<temp>\ai-session-manager-update\<version>\<setup name>`. With the
  // longest legal %TEMP% and a long release tag it does not fit — and the
  // refusal has to come before the ~100 MiB staging copy, not after it.
  const root = await mkdtemp(join(tmpdir(), 'ai-sm-update-maxpath-'));
  try {
    const appDir = join(root, 'app', VERSION);
    mkdirSync(join(appDir, 'launcher'), { recursive: true });
    writeFileSync(join(appDir, 'launcher', RUN_UPDATE_SCRIPT), '# x\n');
    const tempLinux = join(root, 'wintemp');
    mkdirSync(tempLinux, { recursive: true });
    // 180 characters: the longest value WINDOWS_TEMP_SHAPE accepts.
    const maxTemp = `C:\\Users\\Test User\\${'d'.repeat(156)}\\Temp`;
    assert.equal(maxTemp.length, 180);

    let spawns = 0;
    const launch = (version: string, setupName: string): Promise<number> => {
      const updates = join(root, 'data', 'updates', version);
      mkdirSync(updates, { recursive: true });
      writeFileSync(join(updates, setupName), SETUP_BYTES);
      const fake = fakeChild();
      return createInteropLauncher({
        log: () => {},
        appDir,
        probeTemp: () => Promise.resolve({ win: maxTemp, linux: tempLinux }),
        spawnImpl: () => {
          spawns += 1;
          setTimeout(() => {
            fake.endOut();
            fake.exit(0);
          }, 5);
          return fake.child;
        },
      })({ version, setupPath: join(updates, setupName), setupName, expectedSha: SETUP_SHA });
    };

    // Fitting: the same maximal %TEMP% with a normal release tag still runs.
    assert.equal(await launch(VERSION, SETUP_NAME), 0);
    assert.equal(spawns, 1);
    assert.ok(existsSync(join(tempLinux, STAGING_DIR_NAME, VERSION, SETUP_NAME)), 'it was staged');

    // Refused: a 40-character tag pushes the composed path past MAX_PATH - 1.
    const longTag = `v0.3.0-${'a'.repeat(33)}`;
    assert.equal(longTag.length, 40);
    const longName = setupAssetName(longTag);
    assert.ok(
      `${maxTemp}\\${STAGING_DIR_NAME}\\${longTag}\\${longName}`.length > 259,
      'the case is only interesting if it really does not fit',
    );
    // A sentinel inside the staging directory: staging starts by removing that
    // whole directory, so the sentinel surviving is proof that the refusal
    // happened BEFORE any staging work — not after it, with a tidy-up.
    const stage = join(tempLinux, STAGING_DIR_NAME, longTag);
    mkdirSync(stage, { recursive: true });
    writeFileSync(join(stage, 'sentinel'), 'untouched\n');
    await assert.rejects(
      launch(longTag, longName),
      (err: unknown) => err instanceof UpdateFailure && err.sentence === UPDATE_ERROR_START,
    );
    assert.equal(spawns, 1, 'nothing was spawned for the refused one');
    assert.equal(
      readFileSync(join(stage, 'sentinel'), 'utf8'),
      'untouched\n',
      'the staging directory was never even cleared, so nothing was copied into %TEMP%',
    );
    assert.ok(!existsSync(join(stage, longName)), 'and the Setup itself certainly was not');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('interop launcher: a FAILED run writes the script output at warn, capped at 64 KiB', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-sm-update-interop3-'));
  try {
    const appDir = join(root, 'app', VERSION);
    mkdirSync(join(appDir, 'launcher'), { recursive: true });
    writeFileSync(join(appDir, 'launcher', RUN_UPDATE_SCRIPT), '# the windows script\n');
    const updates = join(root, 'data', 'updates', VERSION);
    mkdirSync(updates, { recursive: true });
    writeFileSync(join(updates, SETUP_NAME), SETUP_BYTES);
    const tempLinux = join(root, 'wintemp');
    mkdirSync(tempLinux, { recursive: true });

    const fake = fakeChild();
    const lines: string[] = [];
    const launch = createInteropLauncher({
      log: (level, message) => lines.push(`${level} ${message}`),
      appDir,
      probeTemp: () => Promise.resolve({ win: 'C:\\Temp', linux: tempLinux }),
      spawnImpl: () => {
        fake.say('ERROR: the Setup could not be started (Access is denied).\n');
        fake.say('setup.log: 2026-09-09 12:00:00.000   Setup version: Inno Setup 6\n');
        // Past the cap: kept up to 64 KiB, everything after it dropped.
        fake.say(`${'x'.repeat(MAX_SCRIPT_OUTPUT_BYTES)}\nNEVER-LOGGED\n`);
        setTimeout(() => {
          fake.endOut();
          fake.exit(3);
        }, 5);
        return fake.child;
      },
    });

    const code = await launch({
      version: VERSION,
      setupPath: join(updates, SETUP_NAME),
      setupName: SETUP_NAME,
      expectedSha: SETUP_SHA,
    });
    assert.equal(code, 3, 'the script\'s own refusal code reaches the pipeline');

    const script = lines.filter((l) => l.includes('run-update.ps1:'));
    assert.ok(
      script.every((l) => l.startsWith('warn ')),
      'a non-zero exit makes every captured line a warn',
    );
    assert.ok(
      script[0]?.endsWith('run-update.ps1: ERROR: the Setup could not be started (Access is denied).'),
      'the script\'s own message',
    );
    assert.ok(
      script[1]?.includes('setup.log: 2026-09-09 12:00:00.000   Setup version: Inno Setup 6'),
      'and the Setup log tail it printed before deleting the staging directory',
    );
    assert.ok(!lines.some((l) => l.includes('NEVER-LOGGED')), 'nothing past the cap is written');
    assert.ok(
      lines.includes('warn [update] run-update.ps1: (further output dropped)'),
      'the truncation is stated, not hidden',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('interop launcher: a bundle without run-update.ps1, and a bad hash, refuse before any spawn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-sm-update-interop2-'));
  try {
    const appDir = join(root, 'app', VERSION);
    mkdirSync(appDir, { recursive: true });
    const updates = join(root, 'updates', VERSION);
    mkdirSync(updates, { recursive: true });
    writeFileSync(join(updates, SETUP_NAME), SETUP_BYTES);
    let spawns = 0;
    const spawnImpl: SpawnLike = () => {
      spawns += 1;
      return fakeChild().child;
    };
    const launch = createInteropLauncher({
      log: () => {},
      appDir,
      probeTemp: () => Promise.resolve({ win: 'C:\\Temp', linux: root }),
      spawnImpl,
    });
    const args: LaunchSetupArgs = {
      version: VERSION,
      setupPath: join(updates, SETUP_NAME),
      setupName: SETUP_NAME,
      expectedSha: SETUP_SHA,
    };
    await assert.rejects(
      launch(args),
      (err: unknown) => err instanceof UpdateFailure && err.sentence === UPDATE_ERROR_START,
      'no run-update.ps1 in this install',
    );
    // Now the script exists, but the hash is not a sha256.
    mkdirSync(join(appDir, 'launcher'), { recursive: true });
    writeFileSync(join(appDir, 'launcher', RUN_UPDATE_SCRIPT), '# x\n');
    await assert.rejects(
      launch({ ...args, expectedSha: 'nope' }),
      (err: unknown) => err instanceof UpdateFailure && err.sentence === UPDATE_ERROR_START,
    );
    assert.equal(spawns, 0, 'nothing was ever spawned');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The routes, against a REAL backend (a developer clone: no bundle marker)
// ---------------------------------------------------------------------------

test('POST /api/update on a developer clone: 422, authed, no body read, and the status route works', async () => {
  const server = await startTestServer();
  try {
    const status = await api(server, 'GET', '/api/update/status');
    assert.equal(status.status, 200);
    assert.deepEqual(status.body, { state: 'idle', version: null, percent: 0, error: null });

    const post = await api(server, 'POST', '/api/update');
    assert.equal(post.status, 422, JSON.stringify(post.body));
    assert.deepEqual(post.body, { error: UPDATE_NOT_INSTALLED });

    // Method gates.
    assert.equal((await api(server, 'GET', '/api/update')).status, 405);
    assert.equal((await api(server, 'POST', '/api/update/status')).status, 405);

    // Unauthenticated: both routes are behind the same token gate as the rest.
    for (const path of ['/api/update', '/api/update/status']) {
      const res = await fetch(`${server.baseUrl}${path}`, { method: 'POST' });
      assert.equal(res.status, 401, `${path} must require the token`);
    }
  } finally {
    await server.stop();
  }
});

test('boot: the update timing seams are floored at 1000 ms — never a tight loop at api.github.com', async () => {
  const server = await startTestServer({
    env: { AI_SM_UPDATE_FIRST_MS: '0', AI_SM_UPDATE_INTERVAL_MS: '5' },
  });
  try {
    const log = await waitUntil(
      async () => {
        const text = await readFile(join(server.dataDir, 'server.log'), 'utf8').catch(() => '');
        return text.includes('AI_SM_UPDATE_INTERVAL_MS') ? text : undefined;
      },
      'the boot warnings for the floored seams',
      10_000,
      50,
    );
    assert.ok(
      log.includes('[boot] AI_SM_UPDATE_FIRST_MS=0 is below the 1000ms floor; using 1000'),
      log,
    );
    assert.ok(
      log.includes('[boot] AI_SM_UPDATE_INTERVAL_MS=5 is below the 1000ms floor; using 1000'),
      log,
    );
  } finally {
    await server.stop();
  }
});

test('boot: the update timing seams are capped at the Node timer maximum — never an accidental 1 ms loop', async () => {
  // setTimeout treats anything above 2^31-1 ms as 1 ms, so an over-large value
  // would produce the exact flood the floor exists to prevent.
  const server = await startTestServer({
    env: {
      AI_SM_UPDATE_FIRST_MS: '999999999999',
      AI_SM_UPDATE_INTERVAL_MS: '2147483648',
    },
  });
  try {
    const log = await waitUntil(
      async () => {
        const text = await readFile(join(server.dataDir, 'server.log'), 'utf8').catch(() => '');
        return text.includes('AI_SM_UPDATE_INTERVAL_MS') ? text : undefined;
      },
      'the boot warnings for the capped seams',
      10_000,
      50,
    );
    assert.ok(
      log.includes(
        '[boot] AI_SM_UPDATE_FIRST_MS=999999999999 is above the 2147483647ms timer maximum; using 2147483647',
      ),
      log,
    );
    assert.ok(
      log.includes(
        '[boot] AI_SM_UPDATE_INTERVAL_MS=2147483648 is above the 2147483647ms timer maximum; using 2147483647',
      ),
      log,
    );
  } finally {
    await server.stop();
  }
});

test('boot: <dataDir>/updates is wiped, so nothing downloaded in a previous run can be executed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-sm-update-boot-'));
  const dataDir = join(root, 'data');
  try {
    // A leftover from a killed run: a verified-looking exe and a half download.
    mkdirSync(join(dataDir, 'updates', VERSION), { recursive: true });
    writeFileSync(join(dataDir, 'updates', VERSION, SETUP_NAME), 'stale');
    writeFileSync(join(dataDir, 'updates', VERSION, `${SETUP_NAME}.part`), 'half');
    const server = await startTestServer({ dataDir });
    try {
      assert.ok(!existsSync(join(dataDir, 'updates')), 'the updates directory is gone after boot');
      // And the rest of the data dir is untouched.
      assert.ok(existsSync(join(dataDir, 'runtime.json')));
    } finally {
      await server.stop();
    }
    await delay(50);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// END TO END: a real installed backend, a real release API, a real download
// ---------------------------------------------------------------------------
//
// The acceptance criterion of phase E, minus Windows: an INSTALLED backend
// finds a newer release over HTTP, reports it through GET /api/runtime, and one
// authed POST really downloads and verifies the Setup. The fixture ships no
// `launcher/run-update.ps1`, so the pipeline stops exactly at the Windows
// launch — nothing is ever spawned, and that refusal is asserted rather than
// avoided.

/** A minimal unpacked-bundle layout: <app>/<version> + a `current` symlink. */
function installedApp(root: string, version: string): { appRoot: string; entry: string } {
  const dir = join(root, version);
  mkdirSync(dir, { recursive: true });
  cpSync(join(projectRoot, 'server'), join(dir, 'server'), { recursive: true });
  cpSync(join(projectRoot, 'shared'), join(dir, 'shared'), { recursive: true });
  cpSync(join(projectRoot, 'package.json'), join(dir, 'package.json'));
  symlinkSync(join(projectRoot, 'node_modules'), join(dir, 'node_modules'));
  const dist = join(dir, 'web', 'dist');
  mkdirSync(join(dist, 'assets'), { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<!doctype html><script src="/assets/index-Fixture0.js"></script>');
  writeFileSync(join(dist, 'assets', 'index-Fixture0.js'), 'console.log(1)\n');
  writeFileSync(join(dist, 'build-id.json'), JSON.stringify({ id: '20260909-0000-fixture' }));
  mkdirSync(join(dir, 'node', 'bin'), { recursive: true });
  symlinkSync(process.execPath, join(dir, 'node', 'bin', 'node'));
  writeFileSync(
    join(dir, 'bundle.json'),
    JSON.stringify({
      version,
      commit: '8c308cc',
      nodeVersion: 'v24.8.0',
      builtAt: '2026-09-09T10:00:00.000Z',
      platform: 'linux-x64',
      glibcMin: '2.35',
    }),
  );
  symlinkSync(dir, join(root, 'current'));
  return { appRoot: root, entry: join(root, 'current', 'server', 'index.ts') };
}

// ---------------------------------------------------------------------------
// The presence grace vs. an install in flight (E2)
// ---------------------------------------------------------------------------

test('LIFECYCLE: an install in flight defers the idle shutdown; the process still exits once it has settled', async () => {
  const stub = await startAssets();
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'ai-sm-update-idle-')));
  const app = installedApp(join(root, 'app'), 'v0.2.0');
  /** Set by the stalled asset handler; called to let the download finish. */
  let releaseDownload: (() => void) | undefined;
  try {
    serveLatestRelease(stub);
    // The sums file is honest; the exe HANGS until this test lets go, so the
    // pipeline is provably still running when the grace expires.
    stub.routes.set(downloadPath(SUMS_ASSET_NAME), (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' }).end(sumsBody());
    });
    stub.routes.set(downloadPath(SETUP_NAME), (_req, res) => {
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(SETUP_BYTES.byteLength),
      });
      releaseDownload = (): void => {
        res.end(SETUP_BYTES);
      };
    });

    const server = await startTestServer({
      entry: app.entry,
      cwd: join(app.appRoot, 'current'),
      env: {
        AI_SM_UPDATE_API_BASE: stub.origin,
        AI_SM_UPDATE_FIRST_MS: '1000',
        AI_SM_UPDATE_INTERVAL_MS: '3600000',
        // Both graces are short: the deferral logic is time-scale free, and
        // two real six-second waits used to be the slowest thing in the suite.
        // A presence socket (below) covers the setup, so the 1.5 s windows only
        // ever start once the download is provably in flight.
        AI_SM_STARTUP_GRACE_MS: '1500',
        AI_SM_GRACE_MS: '1500',
      },
    });
    const logFile = join(server.dataDir, 'server.log');
    const readLog = async (): Promise<string> => readFile(logFile, 'utf8').catch(() => '');
    // One open window while the release is found and the update is started:
    // without it the 1.5 s STARTUP grace could expire before the POST, which
    // would test the wrong thing. Closing it below arms the regular grace.
    const presence = await WsClient.connect(presenceUrl(server));
    try {
      await waitUntil(
        async () => {
          const res = await api(server, 'GET', '/api/runtime');
          const body = res.body as { update: Record<string, unknown> };
          return body.update['available'] === true ? true : undefined;
        },
        'GET /api/runtime to carry the release',
        15_000,
        100,
      );
      assert.equal((await api(server, 'POST', '/api/update')).status, 202);
      await waitUntil(
        async () => {
          const body = (await api(server, 'GET', '/api/update/status')).body as UpdateInstallStatus;
          return body.state === 'downloading' ? true : undefined;
        },
        'the download to be in flight',
        10_000,
        50,
      );

      // The last window closes: from here the 1.5 s grace runs.
      await presence.close();

      // The grace expires WHILE the download hangs: one line, and no exit.
      const log = await waitUntil(
        async () => {
          const text = await readLog();
          return text.includes('[lifecycle] idle grace expired while an update is installing')
            ? text
            : undefined;
        },
        'the deferral line in server.log',
        20_000,
        100,
      );
      assert.ok(
        log.includes('[lifecycle] idle grace expired while an update is installing — deferring'),
        'the deferral names the reason exactly once, in the lifecycle component',
      );
      assert.equal(server.child.exitCode, null, 'the backend is still running');
      assert.equal((await fetch(`${server.baseUrl}/health`)).status, 200, 'and still serving');

      // Let it finish: the fixture ships no launcher/run-update.ps1, so the
      // install settles as a failure — settled is settled either way.
      releaseDownload?.();
      const status = await waitUntil(
        async () => {
          const body = (await api(server, 'GET', '/api/update/status')).body as UpdateInstallStatus;
          return body.state === 'failed' || body.state === 'installed' ? body : undefined;
        },
        'the install to settle',
        20_000,
        50,
      );
      assert.equal(status.state, 'failed');
      assert.equal(status.error, UPDATE_ERROR_START);

      // Nothing holds the backend any more: the next expiry really ends it.
      const exit = await Promise.race([
        server.exit,
        delay(20_000).then(() => undefined),
      ]);
      assert.deepEqual(exit, { code: 0, signal: null }, 'the deferred shutdown happens after all');
      assert.ok(!existsSync(server.runtimeFile), 'and it is the clean shutdown, runtime.json removed');
    } finally {
      releaseDownload?.();
      if (!presence.closed) await presence.close().catch(() => undefined);
      await server.stop();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    await stub.close();
  }
});

test('LIFECYCLE: a HELD flight (a Setup that outran its timeout) never defers the idle shutdown', async () => {
  // E6 keeps the single flight while a timed-out Setup is still out there, so a
  // second press cannot start a SECOND installer. That hold must not also hold
  // the process: the child is detached and may never exit, and `inProgress`
  // would then defer the idle shutdown for ever (one log line every grace).
  const stub = await startAssets();
  const fx = await makeController(stub, {
    // A launcher that never returns — exactly the hung Setup this guards.
    launchExit: () => new Promise<number>(() => undefined),
    setupTimeoutMs: 50,
  });
  try {
    serveHappy(stub);
    await fx.controller.request();
    const status = await settled(fx.controller);
    assert.equal(status.state, 'failed');
    assert.equal(status.error, UPDATE_ERROR_FINISH, 'the wait was given up on');

    assert.equal(fx.controller.inProgress, true, 'the flight is HELD: a second press is still refused');
    assert.deepEqual(await fx.controller.request(), {
      status: 409,
      body: { error: UPDATE_IN_PROGRESS },
    });
    // The one thing that changed: nothing keeps the backend alive for it.
    assert.equal(fx.controller.holdsProcess, false, 'a held flight never defers the idle shutdown');
    assert.equal(fx.controller.holdingSince, 0);
  } finally {
    await fx.cleanup();
    await stub.close();
  }
});

test('LIFECYCLE: holdsProcess is true for exactly the working states, false once it settles', async () => {
  const stub = await startAssets();
  const fx = await makeController(stub);
  try {
    serveHappy(stub);
    assert.equal(fx.controller.holdsProcess, false, 'idle holds nothing');
    assert.equal(fx.controller.holdingSince, 0);
    await fx.controller.request();
    assert.equal(fx.controller.holdsProcess, true, 'downloading holds the process');
    assert.ok(fx.controller.holdingSince > 0, 'and the deferral deadline has an anchor');
    const status = await settled(fx.controller);
    assert.equal(status.state, 'installed');
    assert.equal(fx.controller.holdsProcess, false, 'installed holds nothing');
    assert.equal(fx.controller.holdingSince, 0);
  } finally {
    await fx.cleanup();
    await stub.close();
  }
});

/**
 * The release API, on the same loopback origin as the assets (which is exactly
 * what the seam collapses the allow-list to).
 */
function serveLatestRelease(stub: AssetStub): void {
  stub.routes.set(`/repos/${UPDATE_OWNER}/${UPDATE_REPO}/releases/latest`, (_req, res) => {
    const url = (name: string): string =>
      `${stub.origin}/${UPDATE_OWNER}/${UPDATE_REPO}/releases/download/${VERSION}/${name}`;
    res.writeHead(200, { 'content-type': 'application/json', etag: '"e2e-1"' });
    res.end(
      JSON.stringify({
        tag_name: VERSION,
        draft: false,
        prerelease: false,
        assets: [
          {
            name: SETUP_NAME,
            state: 'uploaded',
            size: SETUP_BYTES.byteLength,
            browser_download_url: url(SETUP_NAME),
          },
          {
            name: SUMS_ASSET_NAME,
            state: 'uploaded',
            size: sumsBody().length,
            browser_download_url: url(SUMS_ASSET_NAME),
          },
        ],
      }),
    );
  });
}

test('END TO END: POST /api/restart is refused with 409 while an install is downloading', async () => {
  // A restart tears this process down and the replacement wipes
  // <dataDir>/updates at boot — so a handoff started mid-download would delete
  // the half-written .part with nothing left to report it.
  const stub = await startAssets();
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'ai-sm-update-restart-')));
  const app = installedApp(join(root, 'app'), 'v0.2.0');
  let releaseDownload: (() => void) | undefined;
  try {
    serveLatestRelease(stub);
    stub.routes.set(downloadPath(SUMS_ASSET_NAME), (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' }).end(sumsBody());
    });
    // The exe HANGS: the install is provably still in flight at the POST below.
    stub.routes.set(downloadPath(SETUP_NAME), (_req, res) => {
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(SETUP_BYTES.byteLength),
      });
      releaseDownload = (): void => {
        res.end(SETUP_BYTES);
      };
    });

    const server = await startTestServer({
      entry: app.entry,
      cwd: join(app.appRoot, 'current'),
      env: {
        AI_SM_UPDATE_API_BASE: stub.origin,
        AI_SM_UPDATE_FIRST_MS: '1000',
        AI_SM_UPDATE_INTERVAL_MS: '3600000',
      },
    });
    try {
      await waitUntil(
        async () => {
          const body = (await api(server, 'GET', '/api/runtime')).body as {
            update: Record<string, unknown>;
          };
          return body.update['available'] === true ? true : undefined;
        },
        'GET /api/runtime to carry the release',
        15_000,
        100,
      );
      assert.equal((await api(server, 'POST', '/api/update')).status, 202);
      const part = join(server.dataDir, 'updates', VERSION, `${SETUP_NAME}.part`);
      await waitUntil(
        async () => {
          const body = (await api(server, 'GET', '/api/update/status')).body as UpdateInstallStatus;
          return body.state === 'downloading' && existsSync(part) ? true : undefined;
        },
        'the download to be in flight with a .part on disk',
        10_000,
        50,
      );

      const pid = server.child.pid;
      const restart = await api(server, 'POST', '/api/restart');
      assert.equal(restart.status, 409, JSON.stringify(restart.body));
      assert.deepEqual(restart.body, { error: 'An update is being installed.' });

      // Nothing was torn down and nothing was thrown away.
      assert.equal(server.child.pid, pid, 'the same process is still serving');
      assert.equal(server.child.exitCode, null);
      assert.equal((await fetch(`${server.baseUrl}/health`)).status, 200);
      assert.ok(existsSync(part), 'the half-written download survived the refusal');
      const status = (await api(server, 'GET', '/api/update/status')).body as UpdateInstallStatus;
      assert.equal(status.state, 'downloading', 'and the install is still running');
    } finally {
      releaseDownload?.();
      await server.stop();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    await stub.close();
  }
});

test('END TO END: an installed backend finds v0.3.0, reports it, and POST /api/update really downloads and verifies it', async () => {
  const stub = await startAssets();
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'ai-sm-update-e2e-')));
  const app = installedApp(join(root, 'app'), 'v0.2.0');
  try {
    serveLatestRelease(stub);
    serveHappy(stub);

    const server = await startTestServer({
      entry: app.entry,
      cwd: join(app.appRoot, 'current'),
      env: {
        AI_SM_UPDATE_API_BASE: stub.origin,
        // The production schedule is 20 s after listen; the seam only moves the
        // clock, never the behaviour.
        AI_SM_UPDATE_FIRST_MS: '1000',
        AI_SM_UPDATE_INTERVAL_MS: '3600000',
      },
    });
    try {
      const runtime = await waitUntil(
        async () => {
          const res = await api(server, 'GET', '/api/runtime');
          const body = res.body as { installed: boolean; update: Record<string, unknown> };
          return body.update['available'] === true ? body : undefined;
        },
        'GET /api/runtime to carry the release',
        15_000,
        100,
      );
      assert.equal(runtime.installed, true);
      assert.deepEqual(runtime.update, {
        available: true,
        reason: 'a new version is available',
        release: {
          version: VERSION,
          setupName: SETUP_NAME,
          setupUrl: `${stub.origin}${downloadPath(SETUP_NAME)}`,
          sumsUrl: `${stub.origin}${downloadPath(SUMS_ASSET_NAME)}`,
          size: SETUP_BYTES.byteLength,
        },
      });

      // One authed press.
      const post = await api(server, 'POST', '/api/update');
      assert.deepEqual(post.body, { version: VERSION });
      assert.equal(post.status, 202);

      const status = await waitUntil(
        async () => {
          const res = await api(server, 'GET', '/api/update/status');
          const body = res.body as UpdateInstallStatus;
          return body.state === 'failed' || body.state === 'installed' ? body : undefined;
        },
        'the install to settle',
        20_000,
        50,
      );
      // The fixture has no launcher/run-update.ps1 — so the download and the
      // verification are real, and the Windows step is the one that refuses.
      assert.deepEqual(status, {
        state: 'failed',
        version: VERSION,
        percent: 100,
        error: UPDATE_ERROR_START,
      });
      const exe = join(server.dataDir, 'updates', VERSION, SETUP_NAME);
      assert.deepEqual(await readFile(exe), SETUP_BYTES, 'the verified Setup is on disk, byte for byte');
      assert.ok(!existsSync(`${exe}.part`));
      // The ETag cache is there for the next boot, 0600.
      assert.equal((await stat(join(server.dataDir, 'update-check.json'))).mode & 0o777, 0o600);
    } finally {
      await server.stop();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    await stub.close();
  }
});

test('END TO END: a 0.0.0-dev bundle makes ZERO outbound requests — the promise this project makes about itself', async () => {
  // The acceptance criterion of phase E's check half: an off-tag build (what
  // scripts/build-bundle.sh stamps without a tag) is older than every release,
  // so asking would only nag a developer with an update it must never install.
  const stub = await startAssets();
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'ai-sm-update-dev-')));
  const app = installedApp(join(root, 'app'), '0.0.0-dev+abc1234');
  try {
    // The release API and both assets are served — nothing must ask for them.
    serveLatestRelease(stub);
    serveHappy(stub);

    const server = await startTestServer({
      entry: app.entry,
      cwd: join(app.appRoot, 'current'),
      env: {
        AI_SM_UPDATE_API_BASE: stub.origin,
        AI_SM_UPDATE_FIRST_MS: '1000',
        AI_SM_UPDATE_INTERVAL_MS: '1000',
      },
    });
    try {
      // The boot line says so, in the log, before anything could have run.
      const log = await waitUntil(
        async () => {
          const text = await readFile(join(server.dataDir, 'server.log'), 'utf8').catch(() => '');
          return text.includes('online release check disabled') ? text : undefined;
        },
        'the disabled-check line in server.log',
        10_000,
        50,
      );
      assert.ok(
        log.includes(
          '[boot] online release check disabled for build 0.0.0-dev+abc1234 (not a released version)',
        ),
        log,
      );

      // Long past the first check AND several intervals: still not one request.
      await delay(2_500);
      assert.deepEqual(stub.hits, [], 'a 0.0.0 build never talks to the release API');

      const runtime = (await api(server, 'GET', '/api/runtime')).body as {
        installed: boolean;
        version: string;
        update: Record<string, unknown>;
      };
      assert.equal(runtime.installed, true, 'it IS the installed app — just not a released one');
      assert.equal(runtime.version, '0.0.0-dev+abc1234');
      assert.deepEqual(runtime.update, { available: false, reason: null });

      // And the button has nothing to install, so it can download nothing.
      const post = await api(server, 'POST', '/api/update');
      assert.equal(post.status, 422);
      assert.deepEqual(post.body, { error: UPDATE_NOTHING_TO_INSTALL });
      assert.deepEqual(stub.hits, [], 'not even a pressed button reaches the network');
    } finally {
      await server.stop();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    await stub.close();
  }
});
