/**
 * GET /api/telemetry — the per-session status-bar feed at the HTTP boundary.
 *
 * Proven end-to-end through the real server (own PTYs, real git probes):
 *   - auth + Host/Origin parity and GET-only (405) like every other /api route;
 *   - {sessions:{}} for an empty running set;
 *   - a non-claude (bash) session in a git repo → git-only fields, NO claude
 *     fields;
 *   - a claude-kind session mapped to a fixture Claude log → model / costUsd /
 *     contextTokens / contextMax / skill, git omitted for a non-repo cwd.
 *
 * The claude session is a fake `claude` executable (basename drives the reader)
 * that idles so its PTY stays 'running'. The fixture log is written AFTER
 * spawn and its mtime is pinned after the session's createdAt so the
 * newest-after-spawn mapping selects it.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { TelemetryResponse } from '../shared/protocol.ts';
import { api, createSession, rawRequest, startTestServer, type TestServer } from './helpers.ts';

const pexec = promisify(execFile);

let claudeDirEmpty: string;
let server: TestServer;

before(async () => {
  claudeDirEmpty = await mkdtemp(join(tmpdir(), 'ai-sm-tel-empty-'));
  server = await startTestServer({ env: { AI_SM_CLAUDE_DIR: claudeDirEmpty } });
});

after(async () => {
  if (server !== undefined) await server.stop();
  if (claudeDirEmpty !== undefined) await rm(claudeDirEmpty, { recursive: true, force: true });
});

test('GET /api/telemetry with no sessions returns exactly {sessions:{}}', async () => {
  const res = await api(server, 'GET', '/api/telemetry');
  assert.equal(res.status, 200, `GET /api/telemetry failed: ${JSON.stringify(res.body)}`);
  assert.deepEqual(res.body, { sessions: {} });
});

test('GET /api/telemetry: non-GET is 405, and auth + Host/Origin parity with every other /api route', async () => {
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const res = await api(server, method, '/api/telemetry');
    assert.equal(res.status, 405, `${method} /api/telemetry must be 405`);
  }

  const noToken = await rawRequest(server.port, { path: '/api/telemetry' });
  assert.equal(noToken.status, 401, 'missing token must be 401');

  const wrongToken = await rawRequest(server.port, {
    path: '/api/telemetry',
    headers: { 'x-auth-token': '0'.repeat(64) },
  });
  assert.equal(wrongToken.status, 401, 'wrong token must be 401');

  const evilHost = await rawRequest(server.port, {
    path: '/api/telemetry',
    headers: { host: `evil.example.com:${server.port}`, 'x-auth-token': server.token },
  });
  assert.equal(evilHost.status, 403, 'forbidden Host must be 403');

  const evilOrigin = await rawRequest(server.port, {
    path: '/api/telemetry',
    headers: { origin: 'http://evil.example.com', 'x-auth-token': server.token },
  });
  assert.equal(evilOrigin.status, 403, 'cross-origin request must be 403');
});

test('a non-claude (bash) session in a git repo reports git-only fields (branch/add/del/untracked), no claude fields', async () => {
  const claudeDir = await mkdtemp(join(tmpdir(), 'ai-sm-tel-git-claude-'));
  const repo = await mkdtemp(join(tmpdir(), 'ai-sm-tel-repo-'));
  const srv = await startTestServer({ env: { AI_SM_CLAUDE_DIR: claudeDir } });
  try {
    await pexec('git', ['-C', repo, 'init', '-b', 'main']);
    await pexec('git', ['-C', repo, 'config', 'user.email', 't@t']);
    await pexec('git', ['-C', repo, 'config', 'user.name', 't']);
    await writeFile(join(repo, 'f.txt'), 'a\nb\nc\n');
    await pexec('git', ['-C', repo, 'add', 'f.txt']);
    await pexec('git', ['-C', repo, 'commit', '-m', 'init']);
    // Working-tree change (unstaged): one line edited → numstat 1 add / 1 del.
    await writeFile(join(repo, 'f.txt'), 'a\nB\nc\n');
    await writeFile(join(repo, 'untracked.txt'), 'new\n'); // → untracked 1

    const s = await createSession(srv, { command: 'bash', args: [], cwd: repo, cols: 80, rows: 24 });
    assert.equal(s.status, 'running');

    const res = await api(srv, 'GET', '/api/telemetry');
    assert.equal(res.status, 200);
    const item = (res.body as TelemetryResponse).sessions[s.id];
    assert.ok(item !== undefined, 'the running session has a telemetry entry');
    assert.equal(item.branch, 'main');
    assert.equal(item.add, 1);
    assert.equal(item.del, 1);
    assert.equal(item.untracked, 1);
    // Non-claude command → the Claude log is never consulted.
    assert.equal(item.model, undefined);
    assert.equal(item.costUsd, undefined);
    assert.equal(item.contextTokens, undefined);
    assert.equal(item.skill, undefined);
  } finally {
    await srv.stop();
    await rm(claudeDir, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  }
});

test('a claude-kind session maps to its fixture Claude log: model / costUsd / contextTokens / contextMax / skill; git omitted for a non-repo cwd', async () => {
  const claudeDir = await mkdtemp(join(tmpdir(), 'ai-sm-tel-claude-'));
  const workDir = await mkdtemp(join(tmpdir(), 'ai-sm-tel-work-')); // session cwd (non-repo)
  const binDir = await mkdtemp(join(tmpdir(), 'ai-sm-tel-bin-'));
  const srv = await startTestServer({ env: { AI_SM_CLAUDE_DIR: claudeDir } });
  try {
    // Fake `claude` that idles so the PTY stays 'running'; basename must be claude.
    const claudeBin = join(binDir, 'claude');
    await writeFile(claudeBin, '#!/bin/sh\nexec sleep 3600\n', { mode: 0o755 });

    const slugDir = join(claudeDir, 'projects', workDir.replaceAll('/', '-'));
    await mkdir(slugDir, { recursive: true });

    const s = await createSession(srv, { command: claudeBin, args: [], cwd: workDir, cols: 80, rows: 24 });
    assert.equal(s.status, 'running');

    // Write the log AFTER spawn; pin mtime after createdAt so it's the newest-
    // after-spawn winner. Records carry cwd === workDir (mapping confirmation).
    const ts = (n: number): string => `2026-07-24T10:00:0${n}.000Z`;
    const lines = [
      // opus: input 1_000_000 → 5.0
      JSON.stringify({ type: 'assistant', timestamp: ts(1), cwd: workDir, requestId: 'r1', message: { id: 'm1', model: 'claude-opus-4-8', role: 'assistant', usage: { input_tokens: 1_000_000, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }),
      // opus: input 200_000 → 1.0, cacheRead 1_000_000 → 0.5 = 1.5; carries a Skill.
      JSON.stringify({ type: 'assistant', timestamp: ts(2), cwd: workDir, requestId: 'r2', message: { id: 'm2', model: 'claude-opus-4-8', role: 'assistant', content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'edit' } }], usage: { input_tokens: 200_000, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 1_000_000 } } }),
    ];
    const logFile = join(slugDir, 'sess.jsonl');
    await writeFile(logFile, lines.join('\n') + '\n', { mode: 0o600 });
    const after = new Date(Date.parse(s.createdAt) + 60_000);
    await utimes(logFile, after, after);

    const res = await api(srv, 'GET', '/api/telemetry');
    assert.equal(res.status, 200);
    const item = (res.body as TelemetryResponse).sessions[s.id];
    assert.ok(item !== undefined, 'the running claude session has a telemetry entry');
    assert.equal(item.model, 'claude-opus-4-8');
    assert.equal(item.costUsd, 6.5, '5.0 + 1.5');
    assert.equal(item.contextTokens, 1_200_000, 'latest turn: input 200_000 + cacheRead 1_000_000');
    assert.equal(item.contextMax, 1_000_000);
    assert.equal(item.skill, 'edit');
    // Non-repo cwd → git fields omitted (honesty: absent, not zero-as-unknown).
    assert.equal(item.branch, undefined);
  } finally {
    await srv.stop();
    await rm(claudeDir, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
    await rm(binDir, { recursive: true, force: true });
  }
});
