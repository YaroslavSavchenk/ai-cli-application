/**
 * The device-flow poll cadence against GitHub's real rule (2026-11-24, found
 * in a live sign-in): a poll that arrives AT the interval gets `slow_down`,
 * GitHub adds 5 s and names the new interval, and a poller that waits exactly
 * the interval falls behind forever — the user approves and the app never
 * sees the token. Every poll now waits the interval plus a 20 % margin, and a
 * `slow_down` adopts the interval GitHub names when it is longer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { GithubConnection, pollDelayMs, type FetchLike } from '../../server/github.ts';
import type { Logger } from '../../server/config-log.ts';
import { makeTempDir, removeTempDir, waitUntil } from '../helpers/helpers.ts';

const noop: Logger = () => {};

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

test('pollDelayMs: the interval plus 20 %, never the bare interval', () => {
  assert.equal(pollDelayMs(5_000), 6_000, "GitHub's 5 s becomes 6 s");
  assert.equal(pollDelayMs(10_000), 12_000);
  assert.ok(pollDelayMs(20) > 20, 'even a tiny interval gets a margin');
});

test('slow_down: the next poll waits at least the interval GitHub names (+ margin), then the token lands', async () => {
  const root = await makeTempDir('ai-sm-ghpoll-');
  try {
    const polls: number[] = [];
    const stub: FetchLike = (url) => {
      if (url === 'https://github.com/login/device/code') {
        return Promise.resolve(json({
          device_code: 'DEV', user_code: 'ABCD-EFGH', verification_uri: 'https://github.com/login/device',
          expires_in: 900, interval: 0.02,
        }));
      }
      if (url === 'https://github.com/login/oauth/access_token') {
        polls.push(performance.now());
        // GitHub names 6 s: longer than the +5 s rule's 5.02 s, so honouring
        // the named interval is what this proves.
        if (polls.length === 1) return Promise.resolve(json({ error: 'slow_down', interval: 6 }));
        return Promise.resolve(json({ access_token: 'gho_test', scope: 'repo' }));
      }
      if (url === 'https://api.github.com/user') return Promise.resolve(json({ login: 'octocat' }));
      return Promise.resolve(json({}));
    };
    const conn = new GithubConnection({ file: join(root, 'github.json'), log: noop, clientId: 'Ov23test', fetchImpl: stub });
    const realSetTimeout = globalThis.setTimeout;
    const delays: number[] = [];
    // Record the delays the poll timer asks for; run them at once so the test is fast.
    globalThis.setTimeout = ((fn: () => void, ms?: number) => {
      delays.push(ms ?? 0);
      return realSetTimeout(fn, 0);
    }) as typeof setTimeout;
    try {
      await conn.startDeviceFlow();
      await waitUntil(() => (conn.status().state === 'connected' ? true : undefined), 'the token to land');
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    const pollDelays = delays.filter((d) => d >= 20 && d < 15_000); // not the 15 s HTTP timeouts
    assert.equal(pollDelays[0], pollDelayMs(20), 'the first poll: interval + margin');
    assert.equal(pollDelays[1], pollDelayMs(6_000), "after slow_down: GitHub's 6 s beats 0.02 + 5 s, plus margin");
    assert.equal(conn.status().login, 'octocat');
  } finally {
    await removeTempDir(root);
  }
});
