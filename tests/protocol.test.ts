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
