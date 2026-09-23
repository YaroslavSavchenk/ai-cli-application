/**
 * Stored API keys: server/keys.ts + GET/PUT/DELETE /api/keys (Nocturne B5).
 *
 * The contract under test is a credential contract:
 *   - shape validation (the constant refusal sentence, the 4096-character cap,
 *     no spaces, no control characters, no non-ASCII);
 *   - keys.json is mode 0600 and written atomically (no temp file left);
 *   - a keys.json that is not a plain object of `<keyed tool>: <key>` yields an
 *     empty store, one warn line, and NOTHING from the file in server.log;
 *   - the page only ever learns saved / not saved, plus whether the backend's
 *     own environment carries the variable;
 *   - and the one that matters most: after a save, a spawn and a delete, the
 *     key VALUE appears in no file of the data dir except keys.json.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type { KeyStatus } from '../../shared/protocol.ts';
import { isKeyShaped, normalizeKey, KEY_MAX_CHARS } from '../../server/keys.ts';
import {
  api,
  createSession,
  rawRequest,
  readServerLog,
  startTestServer,
  type TestServer,
} from '../helpers/helpers.ts';

/** A value shaped exactly like a real key, unique enough to grep for. */
const GEMINI_KEY = 'AIzaSy-test-GEMINI-0PENSESAME-9f3c1';
const CLAUDE_KEY = 'sk-ant-api03-test-0PENSESAME-7b21';

let server: TestServer;
let workDir: string;

before(async () => {
  workDir = await realpath(await mkdtemp(join(tmpdir(), 'ai-sm-keys-work-')));
  // The three variables are cleared so `env` in KeyStatus is deterministic
  // whatever the developer's own shell exports.
  server = await startTestServer({
    env: { ANTHROPIC_API_KEY: '', GEMINI_API_KEY: '', XAI_API_KEY: '' },
  });
});

after(async () => {
  if (server !== undefined) await server.stop();
  if (workDir !== undefined) await rm(workDir, { recursive: true, force: true });
});

test('isKeyShaped: the validation table', () => {
  const good: readonly string[] = [
    'k',
    GEMINI_KEY,
    CLAUDE_KEY,
    'x'.repeat(KEY_MAX_CHARS),
    '!~', // the ends of the printable-ASCII range
    ' padded-key-is-trimmed ',
  ];
  for (const value of good) assert.equal(isKeyShaped(value), true, `must accept ${JSON.stringify(value)}`);
  assert.equal(normalizeKey(' padded-key-is-trimmed \n'), 'padded-key-is-trimmed');

  const bad: readonly unknown[] = [
    '',
    '   ',
    'has space inside',
    'tab\tinside',
    'newline\ninside',
    'control\u0001char',
    'nul\u0000char',
    'del\u007fchar', // 0x7f is DEL: one past the printable range, a control character
    '\u007f',
    'unicode-é',
    'emoji-\u{1f511}',
    'x'.repeat(KEY_MAX_CHARS + 1),
    undefined,
    null,
    5,
    true,
    ['k'],
    { key: 'k' },
  ];
  for (const value of bad) {
    assert.equal(isKeyShaped(value), false, `must refuse ${JSON.stringify(value)}`);
    assert.equal(normalizeKey(value), undefined);
  }
});

test('GET /api/keys starts with nothing saved and no variable in the environment', async () => {
  const res = await api(server, 'GET', '/api/keys');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    saved: { claude: false, gemini: false, grok: false },
    env: { claude: false, gemini: false, grok: false },
  } satisfies KeyStatus);
});

test('DELETE for a tool that never had a key is a no-op, not an error', async () => {
  // Runs before anything was ever saved on this server: the page may send a
  // Remove for a row it believes is filled (two tabs, one of them stale).
  const del = await api(server, 'DELETE', '/api/keys/grok');
  assert.equal(del.status, 200);
  assert.deepEqual(del.body, { ok: true });
  const status = await api(server, 'GET', '/api/keys');
  assert.deepEqual((status.body as KeyStatus).saved, { claude: false, gemini: false, grok: false });
});

test('PUT stores the key 0600 and atomically; GET reports saved but never the value', async () => {
  const put = await api(server, 'PUT', '/api/keys/gemini', { key: GEMINI_KEY });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.deepEqual(put.body, { ok: true });

  const status = await api(server, 'GET', '/api/keys');
  assert.equal(status.status, 200);
  assert.deepEqual((status.body as KeyStatus).saved, { claude: false, gemini: true, grok: false });
  assert.equal(
    JSON.stringify(status.body).includes(GEMINI_KEY),
    false,
    'GET /api/keys must never return the key itself',
  );

  const file = join(server.dataDir, 'keys.json');
  assert.equal((await stat(file)).mode & 0o777, 0o600, 'keys.json must be mode 0600');
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { gemini: GEMINI_KEY });

  const leftovers = (await readdir(server.dataDir)).filter((n) => n.endsWith('.tmp'));
  assert.deepEqual(leftovers, [], 'the atomic write must leave no temp file behind');

  // A second PUT replaces the value; the page still only learns "saved".
  const replaced = await api(server, 'PUT', '/api/keys/gemini', { key: `${GEMINI_KEY}-2` });
  assert.equal(replaced.status, 200);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { gemini: `${GEMINI_KEY}-2` });
  await api(server, 'PUT', '/api/keys/gemini', { key: GEMINI_KEY });
});

test('a pasted key is stored TRIMMED — the copy-paste newline never reaches the file', async () => {
  // The single most common way a good key arrives looking bad; whatever is
  // stored is what becomes an environment variable, so a trailing newline in
  // keys.json would be a trailing newline in ANTHROPIC_API_KEY.
  const put = await api(server, 'PUT', '/api/keys/claude', { key: `  ${CLAUDE_KEY}\n` });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  const file = join(server.dataDir, 'keys.json');
  const onDisk = JSON.parse(await readFile(file, 'utf8')) as Record<string, string>;
  assert.equal(onDisk['claude'], CLAUDE_KEY, 'the surrounding whitespace is gone');
  await api(server, 'DELETE', '/api/keys/claude');
});

test('DELETE is persisted: a keys.json that still holds the key would resurrect it', async () => {
  const file = join(server.dataDir, 'keys.json');
  await api(server, 'PUT', '/api/keys/grok', { key: 'xai-persisted-0PENSESAME-44' });
  assert.equal(
    (JSON.parse(await readFile(file, 'utf8')) as Record<string, string>)['grok'],
    'xai-persisted-0PENSESAME-44',
  );
  assert.equal((await api(server, 'DELETE', '/api/keys/grok')).status, 200);
  const after = JSON.parse(await readFile(file, 'utf8')) as Record<string, string>;
  assert.equal('grok' in after, false, 'the cleared key must be gone from the FILE, not just from memory');
  assert.equal(
    (await readFile(file, 'utf8')).includes('xai-persisted-0PENSESAME-44'),
    false,
    'no trace of the value is left in keys.json',
  );
});

test('PUT refuses a value that is not key-shaped, with one constant sentence', async () => {
  for (const key of [
    '',
    '  ',
    'has space inside',
    'control\u0001char',
    'unicode-é',
    'x'.repeat(KEY_MAX_CHARS + 1),
    5,
    null,
    ['k'],
  ]) {
    const res = await api(server, 'PUT', '/api/keys/claude', { key });
    assert.equal(res.status, 400, `must refuse ${JSON.stringify(key)}`);
    assert.deepEqual(res.body, { error: 'That does not look like an API key.' });
  }
  // A missing body key is the same refusal, not a crash.
  const empty = await api(server, 'PUT', '/api/keys/claude', {});
  assert.equal(empty.status, 400);
  assert.deepEqual(empty.body, { error: 'That does not look like an API key.' });

  const saved = await api(server, 'GET', '/api/keys');
  assert.equal((saved.body as KeyStatus).saved.claude, false, 'a refused key is never stored');

  // The exact cap is accepted.
  const max = await api(server, 'PUT', '/api/keys/claude', { key: 'x'.repeat(KEY_MAX_CHARS) });
  assert.equal(max.status, 200);
  await api(server, 'DELETE', '/api/keys/claude');
});

test('an unknown tool is refused for PUT and DELETE alike', async () => {
  // `..` is sent RAW (fetch would normalize it before it left the client): the
  // handler parses the target with the URL parser, which collapses the segment
  // to `/api/`, so the tool route is never entered and the answer is the
  // generic 404 — a key store is never reachable through a traversal.
  const dots = await rawRequest(server.port, {
    method: 'PUT',
    path: '/api/keys/..',
    headers: { 'x-auth-token': server.token, 'content-type': 'application/json' },
    body: JSON.stringify({ key: GEMINI_KEY }),
  });
  assert.equal(dots.status, 404, 'PUT /api/keys/.. must not reach the key store');
  assert.deepEqual(JSON.parse(dots.body), { error: 'not found' });

  for (const tool of ['codex', 'bash', 'CLAUDE', 'gemini%20']) {
    const put = await api(server, 'PUT', `/api/keys/${tool}`, { key: GEMINI_KEY });
    assert.equal(put.status, 400, `PUT /api/keys/${tool}`);
    assert.deepEqual(put.body, { error: 'Unknown tool.' });
    const del = await api(server, 'DELETE', `/api/keys/${tool}`);
    assert.equal(del.status, 400, `DELETE /api/keys/${tool}`);
    assert.deepEqual(del.body, { error: 'Unknown tool.' });
  }
});

test('body rules: json content-type required, dedicated size cap, method parity, auth parity', async () => {
  const wrongType = await rawRequest(server.port, {
    method: 'PUT',
    path: '/api/keys/gemini',
    headers: { 'x-auth-token': server.token, 'content-type': 'text/plain' },
    body: JSON.stringify({ key: GEMINI_KEY }),
  });
  assert.equal(wrongType.status, 415);

  const tooLarge = await api(server, 'PUT', '/api/keys/gemini', { key: 'x'.repeat(9000) });
  assert.equal(tooLarge.status, 413);
  assert.deepEqual(tooLarge.body, { error: 'request body is too large' });

  const badJson = await rawRequest(server.port, {
    method: 'PUT',
    path: '/api/keys/gemini',
    headers: { 'x-auth-token': server.token, 'content-type': 'application/json' },
    body: `{"key":"${GEMINI_KEY}-frombadjson"`,
  });
  assert.equal(badJson.status, 400);
  assert.deepEqual(JSON.parse(badJson.body), { error: 'invalid JSON body' });
  // The JSON.parse error quotes its input; it must never reach server.log.
  assert.equal(
    (await readServerLog(server)).includes('frombadjson'),
    false,
    'a malformed body must not put its bytes in server.log',
  );

  // A body that parses but is not an object: `null` in particular would be a
  // property read on null one line later — a 500 over a malformed request.
  for (const raw of ['null', '5', '"just-a-string"', '["k"]', 'true']) {
    const res = await rawRequest(server.port, {
      method: 'PUT',
      path: '/api/keys/gemini',
      headers: { 'x-auth-token': server.token, 'content-type': 'application/json' },
      body: raw,
    });
    assert.equal(res.status, 400, `body ${raw}`);
    assert.deepEqual(JSON.parse(res.body), { error: 'invalid JSON body' }, `body ${raw}`);
  }

  const post = await api(server, 'POST', '/api/keys/gemini', { key: GEMINI_KEY });
  assert.equal(post.status, 405);
  const putList = await api(server, 'PUT', '/api/keys', { key: GEMINI_KEY });
  assert.equal(putList.status, 405);

  for (const path of ['/api/keys', '/api/keys/gemini']) {
    const noToken = await rawRequest(server.port, { path });
    assert.equal(noToken.status, 401, `${path} without a token`);
    const badHost = await rawRequest(server.port, {
      path,
      headers: { 'x-auth-token': server.token, host: 'evil.example:1' },
    });
    assert.equal(badHost.status, 403, `${path} with a foreign Host`);
    const badOrigin = await rawRequest(server.port, {
      path,
      headers: { 'x-auth-token': server.token, origin: 'http://evil.example' },
    });
    assert.equal(badOrigin.status, 403, `${path} with a foreign Origin`);
  }
});

test('DELETE forgets the key and says so with a constant sentence in the log', async () => {
  await api(server, 'PUT', '/api/keys/grok', { key: 'xai-test-0PENSESAME-33' });
  const del = await api(server, 'DELETE', '/api/keys/grok');
  assert.equal(del.status, 200);
  assert.deepEqual(del.body, { ok: true });
  const status = await api(server, 'GET', '/api/keys');
  assert.equal((status.body as KeyStatus).saved.grok, false);
  // Deleting again is a no-op, not an error.
  assert.equal((await api(server, 'DELETE', '/api/keys/grok')).status, 200);

  const log = await readServerLog(server);
  assert.ok(log.includes('key saved for grok'), 'the save is logged by tool name');
  assert.ok(log.includes('key cleared for grok'), 'the clear is logged by tool name');
  assert.ok(log.includes('key rejected for claude'), 'a refused key is logged by tool name');
});

/** Every regular file under `dir`, relative to it. */
async function filesUnder(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = join(prefix, entry.name);
    if (entry.isDirectory()) out.push(...(await filesUnder(join(dir, entry.name), rel)));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

test('after a save and a spawn, the key value is in keys.json and in NO other file of the data dir', async () => {
  await api(server, 'PUT', '/api/keys/gemini', { key: GEMINI_KEY });
  await api(server, 'PUT', '/api/keys/claude', { key: CLAUDE_KEY });
  // A real session, so the spawn log line ("session <id> spawned: …") exists.
  const info = await createSession(server, {
    command: 'bash',
    args: ['-c', 'printf hello'],
    cwd: workDir,
    cols: 80,
    rows: 24,
  });
  assert.ok(info.id.length > 0);
  await api(server, 'DELETE', `/api/sessions/${info.id}`);
  await api(server, 'PUT', '/api/keys/gemini', { key: `${GEMINI_KEY}-again` });

  const files = await filesUnder(server.dataDir);
  const guilty: string[] = [];
  for (const file of files) {
    const text = await readFile(join(server.dataDir, file), 'utf8').catch(() => '');
    if (text.includes(GEMINI_KEY) || text.includes(CLAUDE_KEY)) guilty.push(file);
  }
  assert.deepEqual(guilty, ['keys.json'], `a key value leaked into ${guilty.join(', ')}`);
  assert.ok(files.includes('server.log'), 'the data dir really was searched');

  const log = await readServerLog(server);
  assert.equal(log.includes(GEMINI_KEY.slice(0, 12)), false, 'not even a fragment of a key is logged');
  assert.ok(log.includes('session ' + info.id + ' spawned:'), 'the spawn line is there to be searched');
});

// ---------------------------------------------------------------------------
// Load gating: a keys.json this version did not write
// ---------------------------------------------------------------------------

/** Boot a server over a data dir seeded with `content` as keys.json. */
async function withSeededKeys(
  content: string,
  body: (server: TestServer) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'ai-sm-keys-seed-'));
  const dataDir = join(root, 'data');
  await mkdir(dataDir, { mode: 0o700, recursive: true });
  await writeFile(join(dataDir, 'keys.json'), content, { mode: 0o600 });
  const seeded = await startTestServer({
    dataDir,
    env: { ANTHROPIC_API_KEY: '', GEMINI_API_KEY: '', XAI_API_KEY: '' },
  });
  try {
    await body(seeded);
  } finally {
    await seeded.stop();
    await rm(root, { recursive: true, force: true });
  }
}

test('a keys.json that is an array loads as an empty store with one warn line', async () => {
  await withSeededKeys(JSON.stringify(['secret-in-an-array-0PENSESAME']), async (seeded) => {
    const status = await api(seeded, 'GET', '/api/keys');
    assert.deepEqual((status.body as KeyStatus).saved, {
      claude: false,
      gemini: false,
      grok: false,
    });
    const log = await readServerLog(seeded);
    assert.ok(log.includes('keys.json is not an object — starting with no stored keys'));
    assert.equal(log.includes('secret-in-an-array'), false, 'the file content is never logged');
  });
});

test('a keys.json that is not valid JSON loads empty and logs nothing of its bytes', async () => {
  await withSeededKeys(`{"gemini": "truncated-0PENSESAME-value"`, async (seeded) => {
    const status = await api(seeded, 'GET', '/api/keys');
    assert.deepEqual((status.body as KeyStatus).saved.gemini, false);
    const log = await readServerLog(seeded);
    assert.ok(log.includes('keys.json is not valid JSON — starting with no stored keys'));
    assert.equal(
      log.includes('truncated-0PENSESAME-value'),
      false,
      'a JSON.parse error quotes its input — it must never be logged for this file',
    );
  });
});

test('a keys.json that is JSON null loads empty — the backend still boots', async () => {
  // `typeof null === 'object'`: without the explicit null branch the entry walk
  // throws inside the constructor and the whole backend fails to start.
  await withSeededKeys('null', async (seeded) => {
    const status = await api(seeded, 'GET', '/api/keys');
    assert.equal(status.status, 200, 'the server came up and answers');
    assert.deepEqual((status.body as KeyStatus).saved, {
      claude: false,
      gemini: false,
      grok: false,
    });
    assert.ok((await readServerLog(seeded)).includes('keys.json is not an object — starting with no stored keys'));
  });
});

test('a parse error that QUOTES the file content still logs none of it', async () => {
  // Node only quotes its input for some syntax errors — an unquoted value is
  // one of them: `SyntaxError: Unexpected token 'A', ..."gemini": AIza-unq"...`.
  // That message must never be built, let alone logged.
  await withSeededKeys('{"gemini": AIza-unquoted-0PENSESAME-55}', async (seeded) => {
    const status = await api(seeded, 'GET', '/api/keys');
    assert.equal((status.body as KeyStatus).saved.gemini, false);
    const log = await readServerLog(seeded);
    assert.ok(log.includes('keys.json is not valid JSON — starting with no stored keys'));
    for (const fragment of ['AIza-unquoted', 'AIza-unq', 'Unexpected token']) {
      assert.equal(log.includes(fragment), false, `${fragment} must not be logged`);
    }
  });
});

test('unusable entries are dropped one by one; a good entry beside them survives', async () => {
  const seed = JSON.stringify({
    gemini: 5,
    claude: 'good-key-0PENSESAME-1',
    bogus: 'not-a-tool-0PENSESAME',
    grok: 'has space inside',
  });
  await withSeededKeys(seed, async (seeded) => {
    const status = await api(seeded, 'GET', '/api/keys');
    assert.deepEqual((status.body as KeyStatus).saved, {
      claude: true,
      gemini: false,
      grok: false,
    });
    const log = await readServerLog(seeded);
    assert.ok(
      log.includes('dropped 3 entries that is not a known tool with a key-shaped value'),
      `expected the drop count in the log, got: ${log.split('\n').filter((l) => l.includes('keys.json')).join(' | ')}`,
    );
    for (const secret of ['good-key-0PENSESAME-1', 'not-a-tool-0PENSESAME', 'has space inside']) {
      assert.equal(log.includes(secret), false, `${secret} must not be logged`);
    }
    // The surviving key is usable: a later save rewrites the file cleanly.
    await api(seeded, 'PUT', '/api/keys/gemini', { key: 'AIza-second-0PENSESAME' });
    const onDisk = JSON.parse(await readFile(join(seeded.dataDir, 'keys.json'), 'utf8')) as unknown;
    assert.deepEqual(onDisk, {
      claude: 'good-key-0PENSESAME-1',
      gemini: 'AIza-second-0PENSESAME',
    });
    assert.equal(relative(seeded.dataDir, join(seeded.dataDir, 'keys.json')), 'keys.json');
  });
});

test('the env half of KeyStatus reports a variable set outside the app', async () => {
  const withEnv = await startTestServer({
    env: { ANTHROPIC_API_KEY: '', GEMINI_API_KEY: 'from-the-shell-0PENSESAME', XAI_API_KEY: '' },
  });
  try {
    const status = await api(withEnv, 'GET', '/api/keys');
    assert.deepEqual(status.body, {
      saved: { claude: false, gemini: false, grok: false },
      env: { claude: false, gemini: true, grok: false },
    } satisfies KeyStatus);
    assert.equal(
      JSON.stringify(status.body).includes('from-the-shell'),
      false,
      'the environment value itself is never reported',
    );
  } finally {
    await withEnv.stop();
  }
});
