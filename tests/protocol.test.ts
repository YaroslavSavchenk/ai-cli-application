/**
 * Smoke test: proves `node --test` runs TypeScript on Node 24 type
 * stripping and that the shared protocol shapes round-trip through JSON.
 * Behavioural coverage lives in the sibling test files (auth, discovery,
 * projects, sessions).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  Project,
  ServerMessage,
  ClientMessage,
  PingMessage,
  PongMessage,
  SessionAgent,
} from '../shared/protocol.ts';

test('protocol shapes survive a JSON round-trip', () => {
  const project: Project = {
    id: 'p1',
    name: 'Example',
    path: '/home/example/project',
    defaultMode: 'standard',
    createdAt: new Date().toISOString(),
  };
  const server: ServerMessage = { type: 'data', data: 'hello' };
  const client: ClientMessage = { type: 'resize', cols: 120, rows: 40 };
  const ping: PingMessage = { type: 'ping', t: 1234.5 };
  const pong: PongMessage = { type: 'pong', t: 1234.5 };

  assert.deepEqual(JSON.parse(JSON.stringify(project)), project);
  assert.deepEqual(JSON.parse(JSON.stringify(server)), server);
  assert.deepEqual(JSON.parse(JSON.stringify(client)), client);
  assert.deepEqual(JSON.parse(JSON.stringify(ping)), ping);
  assert.deepEqual(JSON.parse(JSON.stringify(pong)), pong);
});

test('a background agent row survives a JSON round-trip, finished and running (B7)', () => {
  const finished: SessionAgent = {
    id: 'a044a505afc442e66',
    name: 'security-auditor',
    task: 'Security review B2 backend routes',
    startedAt: '2026-09-16T17:51:02.000Z',
    endedAt: '2026-09-16T17:55:58.301Z',
    tokens: 1_234_567,
    state: 'finished',
  };
  // A running row carries no endedAt at all — absent, never a placeholder.
  const running: SessionAgent = {
    id: 'a0053196a4ba8146d',
    name: 'agent',
    task: '',
    startedAt: '2026-09-16T21:46:00.000Z',
    tokens: 0,
    state: 'running',
  };
  assert.deepEqual(JSON.parse(JSON.stringify(finished)), finished);
  assert.deepEqual(JSON.parse(JSON.stringify(running)), running);
  assert.equal('endedAt' in (JSON.parse(JSON.stringify(running)) as object), false);
});
