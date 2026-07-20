/**
 * GET /api/usage: read-only aggregation of Claude Code's local session logs
 * (<claudeDir>/projects/**\/*.jsonl, claudeDir = AI_SM_CLAUDE_DIR fixture).
 *
 * Proven here against a synthetic fixture: (id, requestId) dedupe across
 * files, '<synthetic>' model drop, the local-day window filter, malformed-
 * line counting, per-day and per-model token totals, nested subagent logs,
 * the absent/empty-dir zero response, the TTL cache, and auth/Host/Origin +
 * 405 parity with the other authed routes.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UsageResponse } from '../shared/protocol.ts';
import { api, projectRoot, rawRequest, startTestServer, type TestServer } from './helpers.ts';

// --- Fixture builders ------------------------------------------------------

/** ISO-8601 at local noon, `daysAgo` days back (stays inside one local day). */
function tsDaysAgo(daysAgo: number): string {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString();
}

/** The local YYYY-MM-DD the server will bucket `tsDaysAgo(daysAgo)` under. */
function dateKeyDaysAgo(daysAgo: number): string {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - daysAgo);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

interface Rec {
  daysAgo: number;
  model: string;
  sid: string;
  mid: string;
  rid: string;
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
}

function line(r: Rec): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: tsDaysAgo(r.daysAgo),
    sessionId: r.sid,
    requestId: r.rid,
    message: {
      id: r.mid,
      model: r.model,
      role: 'assistant',
      usage: {
        input_tokens: r.input,
        output_tokens: r.output,
        cache_creation_input_tokens: r.cacheCreation,
        cache_read_input_tokens: r.cacheRead,
      },
    },
  });
}

const M1 = 'claude-fable-5';
const M2 = 'claude-opus-4-8';
const MB = 'claude-sonnet-4-6'; // edge-case fixture model
const MC = 'claude-haiku-4-5'; // day-boundary fixture model

/** Local YYYY-MM-DD for an arbitrary Date (mirrors the server's localDateKey). */
function localKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Three unique in-window entries (m1 today, m2 day2, m3 day5), plus noise:
// a cross-file duplicate of m1, a '<synthetic>' turn, an out-of-window entry
// (30 days back), non-assistant lines, and malformed lines.
const m1: Rec = { daysAgo: 0, model: M1, sid: 'S1', mid: 'm1', rid: 'r1', input: 100, output: 10, cacheCreation: 50, cacheRead: 200 };
const m2: Rec = { daysAgo: 2, model: M1, sid: 'S1', mid: 'm2', rid: 'r2', input: 5, output: 5, cacheCreation: 0, cacheRead: 0 };
const m3: Rec = { daysAgo: 5, model: M2, sid: 'S2', mid: 'm3', rid: 'r3', input: 1000, output: 2000, cacheCreation: 0, cacheRead: 0 };
const mOld: Rec = { daysAgo: 30, model: M1, sid: 'S9', mid: 'mOld', rid: 'rOld', input: 99999, output: 99999, cacheCreation: 99999, cacheRead: 99999 };
const mSyn: Rec = { daysAgo: 0, model: '<synthetic>', sid: 'S1', mid: 'mSyn', rid: 'rSyn', input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };

let claudeDir: string;
let server: TestServer;

before(async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-sm-usage-claude-'));
  claudeDir = root;
  const slugA = join(root, 'projects', '-home-sava-projects-demo');
  const subagents = join(slugA, 'subagents');
  await mkdir(subagents, { recursive: true });

  const fileA = [
    line(m1),
    '{ this is not valid json',
    JSON.stringify({ type: 'user', message: { role: 'user' } }),
    line(m2),
    line(mSyn),
    line(mOld),
    '', // blank line — ignored, not counted malformed
  ].join('\n');
  await writeFile(join(slugA, 'session1.jsonl'), fileA + '\n', { mode: 0o600 });

  // Nested subagent log: a DUPLICATE of m1 (same id+rid) plus a fresh m3.
  const fileB = [
    line(m1), // duplicate across files -> counted once
    line(m3),
    '}{ still not json',
  ].join('\n');
  await writeFile(join(subagents, 'agent-1.jsonl'), fileB + '\n', { mode: 0o600 });

  server = await startTestServer({ env: { AI_SM_CLAUDE_DIR: claudeDir } });
});

after(async () => {
  if (server !== undefined) await server.stop();
  if (claudeDir !== undefined) await rm(claudeDir, { recursive: true, force: true });
});

test('GET /api/usage aggregates the fixture: dedupe, synthetic drop, window filter, malformed count, per-day + per-model totals', async () => {
  const res = await api(server, 'GET', '/api/usage');
  assert.equal(res.status, 200, `GET /api/usage failed: ${JSON.stringify(res.body)}`);
  const u = res.body as UsageResponse;

  assert.equal(u.windowDays, 8);
  assert.ok(typeof u.updatedAt === 'string' && !Number.isNaN(Date.parse(u.updatedAt)), 'updatedAt is ISO-8601');

  // Dedupe (m1 seen twice) + synthetic drop (mSyn) + window filter (mOld).
  assert.equal(u.entryCount, 3, 'exactly the 3 unique in-window non-synthetic entries');
  assert.equal(u.malformedLines, 2, 'two malformed JSONL lines counted, blank line NOT counted');
  assert.equal(u.sessionCount, 2, 'distinct sessions S1, S2');

  // Totals across the window (mOld and mSyn contribute nothing).
  assert.deepEqual(u.totals, {
    input: 100 + 5 + 1000,
    output: 10 + 5 + 2000,
    cacheCreation: 50,
    cacheRead: 200,
    total: 1105 + 2015 + 50 + 200,
  });

  // Days: ascending, only days with data -> [day5, day2, today].
  assert.deepEqual(
    u.days.map((d) => d.date),
    [dateKeyDaysAgo(5), dateKeyDaysAgo(2), dateKeyDaysAgo(0)],
  );

  const today = u.days.find((d) => d.date === dateKeyDaysAgo(0));
  assert.ok(today !== undefined);
  assert.deepEqual(today.tokens, { input: 100, output: 10, cacheCreation: 50, cacheRead: 200, total: 360 });
  assert.equal(today.entryCount, 1);
  assert.equal(today.sessionCount, 1);
  assert.deepEqual(today.models, [M1]);

  const day5 = u.days.find((d) => d.date === dateKeyDaysAgo(5));
  assert.ok(day5 !== undefined);
  assert.deepEqual(day5.tokens, { input: 1000, output: 2000, cacheCreation: 0, cacheRead: 0, total: 3000 });
  assert.deepEqual(day5.models, [M2]);

  // Models: descending by total tokens -> M2 (3000) before M1 (370).
  assert.deepEqual(
    u.models.map((m) => m.model),
    [M2, M1],
  );
  const modM1 = u.models.find((m) => m.model === M1);
  assert.ok(modM1 !== undefined);
  assert.deepEqual(modM1.tokens, { input: 105, output: 15, cacheCreation: 50, cacheRead: 200, total: 370 });
  assert.equal(modM1.entryCount, 2, 'm1 + m2 both on M1');

  // Never leak content: the response is aggregates only.
  const asText = JSON.stringify(u);
  assert.ok(!asText.includes('role'), 'no message fields leak into the aggregate response');
});

test('a repeat GET within the TTL is served from cache (stable updatedAt)', async () => {
  const a = (await api(server, 'GET', '/api/usage')).body as UsageResponse;
  const b = (await api(server, 'GET', '/api/usage')).body as UsageResponse;
  assert.equal(a.updatedAt, b.updatedAt, 'two quick GETs share one cached computation');
});

test('GET /api/usage on an absent/empty claude dir returns a valid zero response, never an error', async () => {
  const empty = await mkdtemp(join(tmpdir(), 'ai-sm-usage-empty-'));
  const srv = await startTestServer({ env: { AI_SM_CLAUDE_DIR: empty } });
  try {
    const res = await api(srv, 'GET', '/api/usage');
    assert.equal(res.status, 200);
    const u = res.body as UsageResponse;
    assert.deepEqual(u.days, []);
    assert.deepEqual(u.models, []);
    assert.equal(u.entryCount, 0);
    assert.equal(u.sessionCount, 0);
    assert.equal(u.malformedLines, 0);
    assert.equal(u.windowDays, 8);
    assert.deepEqual(u.totals, { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, total: 0 });
    assert.ok(typeof u.updatedAt === 'string');
  } finally {
    await srv.stop();
    await rm(empty, { recursive: true, force: true });
  }
});

test('GET /api/usage: non-GET is 405, and auth + Host/Origin parity with every other /api route', async () => {
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const res = await api(server, method, '/api/usage');
    assert.equal(res.status, 405, `${method} /api/usage must be 405`);
  }

  const noToken = await rawRequest(server.port, { path: '/api/usage' });
  assert.equal(noToken.status, 401, 'missing token must be 401');

  const wrongToken = await rawRequest(server.port, {
    path: '/api/usage',
    headers: { 'x-auth-token': '0'.repeat(64) },
  });
  assert.equal(wrongToken.status, 401, 'wrong token must be 401');

  const evilHost = await rawRequest(server.port, {
    path: '/api/usage',
    headers: { host: `evil.example.com:${server.port}`, 'x-auth-token': server.token },
  });
  assert.equal(evilHost.status, 403, 'forbidden Host must be 403');

  const evilOrigin = await rawRequest(server.port, {
    path: '/api/usage',
    headers: { origin: 'http://evil.example.com', 'x-auth-token': server.token },
  });
  assert.equal(evilOrigin.status, 403, 'cross-origin request must be 403');
});

test('GET /api/usage edge records: no-usage assistant skipped; missing id/requestId counted (never deduped); missing/garbage timestamp skipped; missing sessionId still counted; a binary-garbage file -> one malformed line', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-sm-usage-edge-'));
  const slug = join(root, 'projects', '-home-sava-projects-edge');
  await mkdir(slug, { recursive: true });

  const ts1 = tsDaysAgo(1);
  const zeroTail = { output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const edge = [
    // e1: normal counted anchor (id + requestId + sessionId).
    JSON.stringify({ type: 'assistant', timestamp: ts1, sessionId: 'SB1', requestId: 'q1', message: { id: 'e1', model: MB, role: 'assistant', usage: { input_tokens: 10, ...zeroTail } } }),
    // e2: type assistant, message present, NO usage block -> skipped; not counted, not malformed.
    JSON.stringify({ type: 'assistant', timestamp: ts1, sessionId: 'SB1', requestId: 'q2', message: { id: 'e2', model: MB, role: 'assistant' } }),
    // e3 + e4: identical, NO id / NO requestId / NO sessionId -> cannot dedupe, BOTH counted.
    JSON.stringify({ type: 'assistant', timestamp: ts1, message: { model: MB, role: 'assistant', usage: { input_tokens: 3, ...zeroTail } } }),
    JSON.stringify({ type: 'assistant', timestamp: ts1, message: { model: MB, role: 'assistant', usage: { input_tokens: 3, ...zeroTail } } }),
    // e5: usage present but timestamp field ABSENT -> skipped.
    JSON.stringify({ type: 'assistant', sessionId: 'SB1', requestId: 'q5', message: { id: 'e5', model: MB, role: 'assistant', usage: { input_tokens: 5, ...zeroTail } } }),
    // e6: usage present but timestamp UNPARSEABLE -> skipped (NOT malformed: the line is valid JSON).
    JSON.stringify({ type: 'assistant', timestamp: 'not a real timestamp', sessionId: 'SB1', requestId: 'q6', message: { id: 'e6', model: MB, role: 'assistant', usage: { input_tokens: 6, ...zeroTail } } }),
    // e7 + e8: same id, requestId ABSENT -> partial key; dedupe needs BOTH -> BOTH counted.
    JSON.stringify({ type: 'assistant', timestamp: ts1, sessionId: 'SB2', message: { id: 'e7', model: MB, role: 'assistant', usage: { input_tokens: 7, ...zeroTail } } }),
    JSON.stringify({ type: 'assistant', timestamp: ts1, sessionId: 'SB2', message: { id: 'e7', model: MB, role: 'assistant', usage: { input_tokens: 7, ...zeroTail } } }),
  ].join('\n');
  await writeFile(join(slug, 'edge.jsonl'), edge + '\n', { mode: 0o600 });

  // A .jsonl file of pure binary garbage with no newline byte -> exactly one
  // line; JSON.parse fails -> counted once as malformed, never fatal.
  const binaryGarbage = Buffer.from(
    Array.from({ length: 256 }, (_, i) => i).filter((b) => b !== 0x0a && b !== 0x0d),
  );
  await writeFile(join(slug, 'binary.jsonl'), binaryGarbage, { mode: 0o600 });

  const srv = await startTestServer({ env: { AI_SM_CLAUDE_DIR: root } });
  try {
    const res = await api(srv, 'GET', '/api/usage');
    assert.equal(res.status, 200);
    const u = res.body as UsageResponse;

    // Counted: e1(10) + e3(3) + e4(3) + e7(7) + e8(7) = 5 entries, 30 input tokens.
    assert.equal(u.entryCount, 5, 'no-usage/no-ts/garbage-ts dropped; keyless + partial-key duplicates all counted');
    assert.equal(u.malformedLines, 1, 'only the binary-garbage line is malformed');
    assert.equal(u.sessionCount, 2, 'SB1 + SB2 (the keyless e3/e4 carry no sessionId)');
    assert.deepEqual(u.totals, { input: 30, output: 0, cacheCreation: 0, cacheRead: 0, total: 30 });
    assert.equal(u.models.length, 1);
    assert.equal(u.models[0]?.model, MB);
    assert.equal(u.models[0]?.entryCount, 5);
    assert.equal(u.days.length, 1, 'all edge records share one local day');
    assert.equal(u.days[0]?.entryCount, 5);
  } finally {
    await srv.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('GET /api/usage buckets by LOCAL day: two records straddling local midnight land in adjacent days', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-sm-usage-daybound-'));
  const slug = join(root, 'projects', '-home-sava-projects-daybound');
  await mkdir(slug, { recursive: true });

  // Local midnight at the start of "2 days ago", and one second before it.
  const atMidnight = new Date();
  atMidnight.setHours(0, 0, 0, 0);
  atMidnight.setDate(atMidnight.getDate() - 2);
  const beforeMidnight = new Date(atMidnight.getTime() - 1000);

  const keyBefore = localKey(beforeMidnight); // the previous local day
  const keyAfter = localKey(atMidnight); // the local day starting at that midnight
  assert.notEqual(keyBefore, keyAfter, 'the two instants must fall on different local days');

  const file = [
    JSON.stringify({ type: 'assistant', timestamp: beforeMidnight.toISOString(), sessionId: 'D1', requestId: 'dq1', message: { id: 'd1', model: MC, role: 'assistant', usage: { input_tokens: 11, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }),
    JSON.stringify({ type: 'assistant', timestamp: atMidnight.toISOString(), sessionId: 'D2', requestId: 'dq2', message: { id: 'd2', model: MC, role: 'assistant', usage: { input_tokens: 22, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }),
  ].join('\n');
  await writeFile(join(slug, 'boundary.jsonl'), file + '\n', { mode: 0o600 });

  const srv = await startTestServer({ env: { AI_SM_CLAUDE_DIR: root } });
  try {
    const u = (await api(srv, 'GET', '/api/usage')).body as UsageResponse;
    assert.deepEqual(u.days.map((d) => d.date), [keyBefore, keyAfter], 'ascending, one bucket per local day');
    const before = u.days.find((d) => d.date === keyBefore);
    const after = u.days.find((d) => d.date === keyAfter);
    assert.equal(before?.tokens.input, 11);
    assert.equal(before?.entryCount, 1);
    assert.equal(before?.sessionCount, 1);
    assert.equal(after?.tokens.input, 22);
    assert.equal(u.entryCount, 2);
    assert.equal(u.sessionCount, 2);
    assert.equal(u.totals.total, 33);
  } finally {
    await srv.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('AI_SM_CLAUDE_DIR set to a relative path: the server refuses to start (exit 1, no runtime.json, absolute-path error)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-sm-usage-relclaude-'));
  const dataDir = join(root, 'data');
  try {
    const child = spawn(process.execPath, [join(projectRoot, 'server', 'index.ts')], {
      cwd: projectRoot,
      env: {
        ...process.env,
        AI_SM_DATA_DIR: dataDir,
        AI_SM_CLAUDE_DIR: 'relative/claude',
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
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        child.once('exit', (code, signal) => resolve({ code, signal }));
      },
    );
    clearTimeout(timer);

    assert.equal(exit.code, 1, `server must exit 1 on a relative AI_SM_CLAUDE_DIR (signal ${exit.signal})`);
    assert.match(stderr, /AI_SM_CLAUDE_DIR must be an absolute path, got: relative\/claude/);
    // runtime.json must never appear.
    await assert.rejects(readFile(join(dataDir, 'runtime.json'), 'utf8'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
