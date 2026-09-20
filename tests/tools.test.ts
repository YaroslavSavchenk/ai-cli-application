/**
 * GET /api/tools and the PATH probe behind it (Nocturne B5).
 *
 * The probe must answer "can this backend actually launch that?" without
 * spawning anything, from the SAME environment a session is spawned with. The
 * fixtures are a temp PATH directory holding an executable file, a
 * non-executable file, a directory named like a tool, a symlink to an
 * executable, and nothing at all — the five shapes the answer turns on.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolAvailability } from '../shared/protocol.ts';
import {
  cachedProbe,
  findOnPath,
  probeTools,
  TOOL_EXECUTABLES,
  TOOLS_CACHE_MS,
} from '../server/tools.ts';
import { api, rawRequest, startTestServer, type TestServer } from './helpers.ts';

let root: string;
let binDir: string;
let server: TestServer;

/**
 * claude  -> a real executable file
 * zsh     -> a symlink to one (symlinks are followed)
 * cmd.exe -> a real executable file (interop lives on PATH like anything else)
 * gemini  -> a file that is not executable
 * grok    -> a DIRECTORY named like a tool
 * codex, powershell.exe -> absent
 */
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'ai-sm-tools-'));
  binDir = join(root, 'bin');
  await mkdir(binDir);
  await writeFile(join(binDir, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await writeFile(join(binDir, 'cmd.exe'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await writeFile(join(binDir, 'gemini'), '#!/bin/sh\nexit 0\n', { mode: 0o644 });
  await writeFile(join(root, 'zsh-real'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await symlink(join(root, 'zsh-real'), join(binDir, 'zsh'));
  await mkdir(join(binDir, 'grok'));
  // The server's PATH is ONLY the fixture directory, so the machine's own
  // installed CLIs cannot make an "absent" tool look present.
  server = await startTestServer({ env: { PATH: binDir } });
});

after(async () => {
  if (server !== undefined) await server.stop();
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

const EXPECTED: ToolAvailability = {
  claude: true,
  codex: false,
  gemini: false,
  grok: false,
  zsh: true,
  cmd: true,
  powershell: false,
};

test('probeTools: executable file yes, non-executable no, directory no, symlink followed, absent no', async () => {
  assert.deepEqual(await probeTools({ PATH: binDir }), EXPECTED);
});

test('probeTools with no usable PATH finds nothing (and never throws)', async () => {
  const none: ToolAvailability = {
    claude: false,
    codex: false,
    gemini: false,
    grok: false,
    zsh: false,
    cmd: false,
    powershell: false,
  };
  assert.deepEqual(await probeTools({}), none);
  assert.deepEqual(await probeTools({ PATH: '' }), none);
  assert.deepEqual(await probeTools({ PATH: join(root, 'does-not-exist') }), none);
});

test('empty and relative PATH entries are skipped (never resolved against the cwd)', async () => {
  // `.` / `` on PATH would make a planted `claude` in some working directory
  // the one the app reports as installed.
  assert.equal(await findOnPath('claude', { PATH: `::.:bin:${binDir}` }), true, 'the absolute entry still counts');
  assert.equal(await findOnPath('claude', { PATH: '::.:bin' }), false, 'no absolute entry -> nothing found');
  assert.equal(await findOnPath('grok', { PATH: binDir }), false, 'a directory named like a tool is not a tool');
});

test('a relative or empty PATH entry is never resolved against the process cwd', async () => {
  // The previous test proves the answer stays `false`; it cannot prove WHY,
  // because nothing findable sits at the relative location. Here the fixtures
  // are planted exactly where a resolved-against-the-cwd lookup would land:
  //   <root>/codex      <- what `join('', 'codex')` and `join('.', 'codex')` hit
  //   <root>/bin/codex  <- what `join('bin', 'codex')` hits
  // A planted `codex` in the working directory must still read as NOT installed.
  await writeFile(join(root, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await writeFile(join(binDir, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const previousCwd = process.cwd();
  process.chdir(root);
  try {
    assert.equal(await findOnPath('codex', { PATH: ':' }), false, 'an empty entry is not "."');
    assert.equal(await findOnPath('codex', { PATH: '.' }), false, '"." on PATH is not searched');
    assert.equal(await findOnPath('codex', { PATH: 'bin' }), false, 'a relative entry is not searched');
    assert.equal(
      await findOnPath('codex', { PATH: `.:bin::${binDir}` }),
      true,
      'the absolute entry still counts — the fixtures really are findable',
    );
  } finally {
    process.chdir(previousCwd);
    await rm(join(root, 'codex'));
    await rm(join(binDir, 'codex'));
  }
});

test('the probe looks up exactly these executable names, and caches for 5 s', () => {
  // A rename here is a card that goes inert (or worse, one that offers a launch
  // that fails): `cmd` and `powershell` are the interop names, and `pwsh.exe`
  // is deliberately NOT probed (PLAN-B5: no pwsh card).
  assert.deepEqual(TOOL_EXECUTABLES, {
    claude: 'claude',
    codex: 'codex',
    gemini: 'gemini',
    grok: 'grok',
    zsh: 'zsh',
    cmd: 'cmd.exe',
    powershell: 'powershell.exe',
  });
  assert.equal(TOOLS_CACHE_MS, 5_000);
});

test('cachedProbe recomputes only after the window, on an injected monotonic clock', async () => {
  let clock = 1_000;
  let calls = 0;
  const probe = cachedProbe({
    env: (): Record<string, string> => {
      calls += 1;
      return { PATH: binDir };
    },
    now: () => clock,
  });
  assert.deepEqual(await probe(), EXPECTED);
  assert.equal(calls, 1);

  // A tool that appears inside the window is not seen yet.
  await writeFile(join(binDir, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  clock += TOOLS_CACHE_MS - 1;
  assert.deepEqual(await probe(), EXPECTED, 'inside the window the cached answer is reused');
  assert.equal(calls, 1, 'no second probe inside the window');

  clock += 1; // exactly TOOLS_CACHE_MS since the first probe
  assert.deepEqual(await probe(), { ...EXPECTED, codex: true });
  assert.equal(calls, 2);

  // The caller cannot mutate the cache through the object it got back.
  const got = await probe();
  (got as { claude: boolean }).claude = false;
  assert.equal((await probe()).claude, true);
  await rm(join(binDir, 'codex'));
});

test('the cache window starts when the answer was ASKED for, not when it landed', async () => {
  // A probe walks every PATH entry, half of them on drvfs: if the window were
  // stamped after it returned, the answer could be served for cacheMs PLUS the
  // probe's own duration — the promise is "cached ≤ 5 s", not "5 s + whatever".
  let clock = 0;
  let calls = 0;
  const probe = cachedProbe({
    env: (): Record<string, string> => {
      calls += 1;
      clock += 10_000; // this probe "takes" ten seconds of the injected clock
      return { PATH: binDir };
    },
    now: () => clock,
    cacheMs: 1_000,
  });
  await probe();
  assert.equal(calls, 1);
  clock += 1; // 10_001 on the clock, 10_001 ms since the ask
  await probe();
  assert.equal(calls, 2, 'the window is measured from the ask, not from the answer');
});

test('cachedProbe: concurrent callers share ONE in-flight probe', async () => {
  let clock = 1_000;
  let calls = 0;
  const probe = cachedProbe({
    env: (): Record<string, string> => {
      calls += 1;
      return { PATH: binDir };
    },
    now: () => clock,
  });
  // Three asks before any answer landed: a dialog open plus two bursts must not
  // start three PATH walks (the reason the probe left the event loop at all).
  const [a, b, c] = await Promise.all([probe(), probe(), probe()]);
  assert.equal(calls, 1, 'one probe for three concurrent callers');
  assert.deepEqual(a, EXPECTED);
  assert.deepEqual(b, EXPECTED);
  assert.deepEqual(c, EXPECTED);
  // Each caller gets its OWN object: one mutating its answer cannot touch another's.
  (a as ToolAvailability).claude = false;
  assert.equal((b as ToolAvailability).claude, true);
  assert.equal((await probe()).claude, true, 'nor the cache');
});

test('GET /api/tools answers the probe of the backend PATH; auth and method parity', async () => {
  const res = await api(server, 'GET', '/api/tools');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, EXPECTED);

  const noToken = await rawRequest(server.port, { path: '/api/tools' });
  assert.equal(noToken.status, 401, 'no token -> 401 like every other /api route');
  assert.equal(JSON.parse(noToken.body).error, 'unauthorized');

  const badToken = await rawRequest(server.port, {
    path: '/api/tools',
    headers: { 'x-auth-token': 'not-the-token' },
  });
  assert.equal(badToken.status, 401);

  const badHost = await rawRequest(server.port, {
    path: '/api/tools',
    headers: { 'x-auth-token': server.token, host: 'evil.example:1' },
  });
  assert.equal(badHost.status, 403, 'Host parity applies to /api/tools too');

  const badOrigin = await rawRequest(server.port, {
    path: '/api/tools',
    headers: { 'x-auth-token': server.token, origin: 'http://evil.example' },
  });
  assert.equal(badOrigin.status, 403, 'Origin parity applies to /api/tools too');

  const post = await api(server, 'POST', '/api/tools', {});
  assert.equal(post.status, 405);
});
