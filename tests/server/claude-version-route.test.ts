/**
 * GET /api/runtime's `claude` member and the `claudeNoticeHidden` pref
 * (Nocturne D6, `.claude/plans/nocturne/PLAN-D6.md` § Frozen contract and §
 * Test gate: "Runtime body carries `claude` byte-exact. The prefs PUT drops a
 * malformed `claudeNoticeHidden`.").
 *
 * How: three real server children, each with its own PATH — a `claude`
 * double that takes 3 s to answer `--version` (the probe must not hold the
 * boot), the same double behind the dev override AI_SM_CLAUDE_VERSION_OVERRIDE
 * (it must never run), and a PATH with no `claude` at all.
 *
 * Why it matters: the browser never re-derives `compat`; whatever this body
 * says is the notice the user sees or does not see. And a boot that waited
 * for a hung `claude` would be a launcher timeout.
 *
 * NOT claimed: the installed app's refusal of the override (an installed
 * bundle is not booted here; the refusal rule is unit-tested in
 * tests/server/claude-version.test.ts); the re-probe after an upgrade (same
 * file, on a stepped clock — its window is a minute).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RuntimeStatusResponse, UiPrefs } from '../../shared/protocol.ts';
import {
  api,
  rawRequest,
  startTestServer,
  waitForLog,
  waitUntil,
  type TestServer,
  makeTempDir,
  removeTempDir,
} from '../helpers/helpers.ts';

/** How long the double takes to answer `--version`: past any boot, short enough to wait for. */
const SLOW_VERSION_S = 3;

let root: string;
let probeMarker: string;
let slow: TestServer;
let overridden: TestServer;
let missing: TestServer;

before(async () => {
  root = await realpath(await makeTempDir('ai-sm-claude-route-'));
  const binDir = join(root, 'bin');
  const emptyDir = join(root, 'empty');
  probeMarker = join(root, 'version-asked');
  await mkdir(binDir);
  await mkdir(emptyDir);
  await writeFile(
    join(binDir, 'claude'),
    `#!/bin/sh\nif [ "$1" = "--version" ]; then\n  : >> "$AI_SM_TEST_MARKER"\n  sleep ${SLOW_VERSION_S}\n` +
      `  printf '2.1.287 (Claude Code)\\n'\n  exit 0\nfi\nsleep 300\n`,
    { mode: 0o755 },
  );
  const path = `${binDir}:${process.env['PATH'] ?? ''}`;
  [slow, overridden, missing] = await Promise.all([
    startTestServer({ env: { PATH: path, AI_SM_TEST_MARKER: join(root, 'slow-asked') } }),
    startTestServer({
      env: { PATH: path, AI_SM_TEST_MARKER: probeMarker, AI_SM_CLAUDE_VERSION_OVERRIDE: '2.1.300' },
    }),
    startTestServer({ env: { PATH: emptyDir } }),
  ]);
});

after(async () => {
  await Promise.all([slow, overridden, missing].map((s) => s?.stop()));
  if (root !== undefined) await removeTempDir(root);
});

/** The raw `"claude":{…}` text of GET /api/runtime — the bytes the browser parses. */
async function claudeBytes(server: TestServer): Promise<string> {
  const res = await rawRequest(server.port, { path: '/api/runtime', headers: { 'x-auth-token': server.token } });
  assert.equal(res.status, 200);
  const at = res.body.indexOf('"claude":');
  assert.notEqual(at, -1, res.body);
  return res.body.slice(at, res.body.indexOf('}', at) + 1);
}

test('boot does not wait for the probe: unknown first, then the version, byte-exact', async () => {
  assert.equal(
    await claudeBytes(slow),
    '"claude":{"version":null,"compat":"unknown","min":"2.1.263","testedUpTo":"2.1.287"}',
    'the server is healthy and answering while `claude --version` is still sleeping',
  );
  await waitUntil(
    async () => ((await claudeBytes(slow)).includes('"2.1.287","compat"') ? true : undefined),
    'the slow probe to answer',
    (SLOW_VERSION_S + 10) * 1000,
  );
  assert.equal(
    await claudeBytes(slow),
    '"claude":{"version":"2.1.287","compat":"ok","min":"2.1.263","testedUpTo":"2.1.287"}',
  );
  const body = (await api(slow, 'GET', '/api/runtime')).body as RuntimeStatusResponse;
  assert.deepEqual(body.claude, { version: '2.1.287', compat: 'ok', min: '2.1.263', testedUpTo: '2.1.287' });
  await waitForLog(slow, '[claude] Claude Code 2.1.287 (ok; supported 2.1.263, tested up to 2.1.287) at ');
});

test('the dev override replaces the probe: newer, and the double is never asked', async () => {
  assert.equal(
    await claudeBytes(overridden),
    '"claude":{"version":"2.1.300","compat":"newer","min":"2.1.263","testedUpTo":"2.1.287"}',
  );
  await waitForLog(
    overridden,
    '[claude] Claude Code version overridden to 2.1.300 (AI_SM_CLAUDE_VERSION_OVERRIDE, development only)',
  );
  await assert.rejects(readFile(probeMarker), /ENOENT/, 'no `claude --version` ran');
});

test('no claude on the sessions’ PATH is missing, with no version', async () => {
  await waitUntil(
    async () => ((await claudeBytes(missing)).includes('"missing"') ? true : undefined),
    'the probe to report missing',
  );
  assert.equal(
    await claudeBytes(missing),
    '"claude":{"version":null,"compat":"missing","min":"2.1.263","testedUpTo":"2.1.287"}',
  );
  await waitForLog(missing, "[claude] Claude Code not found on the sessions' PATH");
});

test('claudeNoticeHidden: an X.Y.Z round-trips beside the other keys; anything else is dropped, the rest kept', async () => {
  const keep = { theme: { ground: '#0a1220', text: '#dafcff' }, futureSetting: 1 };
  const ok: UiPrefs = { ...keep, claudeNoticeHidden: '2.1.300' };
  assert.equal((await api(missing, 'PUT', '/api/prefs', ok)).status, 200);
  assert.deepEqual((await api(missing, 'GET', '/api/prefs')).body, ok);

  const bad: unknown[] = [
    'v2.1.300',
    '2.1',
    '2.1.300 ',
    '2.1.300\n',
    `${'1'.repeat(11)}.${'2'.repeat(11)}.${'3'.repeat(11)}`,
    2.1,
    null,
    true,
    ['2.1.300'],
    { version: '2.1.300' },
  ];
  for (const value of bad) {
    const put = await api(missing, 'PUT', '/api/prefs', { ...keep, claudeNoticeHidden: value });
    assert.equal(put.status, 200, `PUT ${JSON.stringify(value)}: ${JSON.stringify(put.body)}`);
    assert.deepEqual(
      (await api(missing, 'GET', '/api/prefs')).body,
      keep,
      `${JSON.stringify(value)} is dropped, every other key stored`,
    );
    const onDisk = JSON.parse(await readFile(join(missing.dataDir, 'prefs.json'), 'utf8')) as UiPrefs;
    assert.equal('claudeNoticeHidden' in onDisk, false, `${JSON.stringify(value)} never reaches prefs.json`);
  }
});
