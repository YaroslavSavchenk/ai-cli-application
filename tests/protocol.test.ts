/**
 * Skeleton smoke test: proves `node --test` runs TypeScript on Node 24 type
 * stripping and that the shared protocol shapes round-trip through JSON.
 * Real behavioural tests land with the real backend.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Project, ServerMessage, ClientMessage } from '../shared/protocol.ts';

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

  assert.deepEqual(JSON.parse(JSON.stringify(project)), project);
  assert.deepEqual(JSON.parse(JSON.stringify(server)), server);
  assert.deepEqual(JSON.parse(JSON.stringify(client)), client);
});
