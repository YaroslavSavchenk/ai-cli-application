/**
 * `web/src/api.ts` `updatePrefs()` — the CLIENT-side merge-on-write for the
 * shared prefs bag. `PUT /api/prefs` REPLACES the whole object (proven server-
 * side in tests/prefs.test.ts), so two writers — the theme popover writing
 * `theme` and the settings panel writing `defaults` — must read-merge-write or
 * they clobber each other's top-level keys. The server suite can't see this;
 * this is the only coverage of the read-merge-write itself.
 *
 * api.ts is DOM-free at import (it touches `window`/`fetch` only inside call-
 * time helpers), so we stub both globals. `node --test` runs each *.test.ts in
 * its own process, so the stubs never leak into another suite.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { updatePrefs } from '../web/src/api.ts';
import type { UiPrefs } from '../shared/protocol.ts';

interface Captured {
  path: string;
  method: string;
  body: unknown;
}

const realFetch = globalThis.fetch;
let calls: Captured[] = [];
let getBody: unknown = {};
let getOk = true;

function makeRes(body: unknown, ok: boolean): { ok: boolean; status: number; json: () => Promise<unknown> } {
  return { ok, status: ok ? 200 : 500, json: async () => body };
}

/** The single PUT body the write eventually sends (the merged bag). */
function putBody(): unknown {
  const put = calls.filter((c) => c.method === 'PUT');
  assert.equal(put.length, 1, `expected exactly one PUT, got ${put.length}`);
  return put[0].body;
}

beforeEach(() => {
  calls = [];
  getBody = {};
  getOk = true;
  (globalThis as unknown as { window: unknown }).window = { __AUTH__: 'test-token' };
  (globalThis as unknown as { fetch: unknown }).fetch = async (
    path: string,
    init: { method?: string; body?: string } = {},
  ) => {
    const method = (init.method ?? 'GET').toUpperCase();
    calls.push({ path, method, body: init.body !== undefined ? JSON.parse(init.body) : undefined });
    if (method === 'GET') return makeRes(getBody, getOk);
    return makeRes({ ok: true }, true);
  };
});

afterEach(() => {
  (globalThis as unknown as { fetch: unknown }).fetch = realFetch;
  delete (globalThis as unknown as { window?: unknown }).window;
});

test('updatePrefs GETs then PUTs, preserving untouched top-level keys (theme + a foreign key survive writing `defaults`)', async () => {
  getBody = { theme: { bg: 1, fg: 2, scan: true }, futureSetting: 'keep' };
  await updatePrefs({ defaults: { model: 'opus' } });

  assert.deepEqual(calls.map((c) => c.method), ['GET', 'PUT'], 'exactly one GET then one PUT');
  assert.equal(calls[0].path, '/api/prefs');
  assert.equal(calls[1].path, '/api/prefs');
  assert.deepEqual(putBody(), {
    theme: { bg: 1, fg: 2, scan: true },
    futureSetting: 'keep',
    defaults: { model: 'opus' },
  });
});

test('updatePrefs is last-write-wins per top-level key: a patch to `theme` overwrites the stored `theme` verbatim', async () => {
  getBody = { theme: { bg: 1, fg: 1, scan: false }, defaults: { model: 'sonnet' } };
  await updatePrefs({ theme: { bg: 5, fg: 6, scan: true } });
  assert.deepEqual(putBody(), {
    theme: { bg: 5, fg: 6, scan: true },
    defaults: { model: 'sonnet' },
  });
});

test('a failed GET degrades to patch-only (writes the patch alone, never throws) — best effort, does not block the write', async () => {
  getOk = false;
  getBody = { error: 'boom' };
  await assert.doesNotReject(updatePrefs({ defaults: { model: 'haiku' } }));
  assert.deepEqual(calls.map((c) => c.method), ['GET', 'PUT'], 'GET attempted, then PUT still happens');
  assert.deepEqual(putBody(), { defaults: { model: 'haiku' } }, 'patch alone when the prior bag is unreadable');
});

test('a wrong-shape GET (array) is guarded like an absent bag — the merge base stays {}, so only the patch is written', async () => {
  getBody = [1, 2, 3];
  await updatePrefs({ theme: { bg: 0, fg: 0, scan: false } });
  assert.deepEqual(putBody(), { theme: { bg: 0, fg: 0, scan: false } });
});

test('a null GET body is guarded too (no crash, no spread of null)', async () => {
  getBody = null;
  await updatePrefs({ defaults: {} } as UiPrefs);
  assert.deepEqual(putBody(), { defaults: {} });
});

test('writing `statusBar` merges: the settings panel preserves the stored `theme` and `defaults` (and any foreign key)', async () => {
  getBody = {
    theme: { bg: 1, fg: 2, scan: true },
    defaults: { model: 'opus' },
    futureSetting: 'keep',
  };
  await updatePrefs({ statusBar: { model: true, time: false, skill: true } });
  assert.deepEqual(calls.map((c) => c.method), ['GET', 'PUT'], 'exactly one GET then one PUT');
  assert.deepEqual(putBody(), {
    theme: { bg: 1, fg: 2, scan: true },
    defaults: { model: 'opus' },
    futureSetting: 'keep',
    statusBar: { model: true, time: false, skill: true },
  });
});

test('writing `statusBar` overwrites only the stored `statusBar` verbatim (last-write-wins per top-level key)', async () => {
  getBody = {
    theme: { bg: 0, fg: 0, scan: false },
    statusBar: { model: false, diff: true },
  };
  await updatePrefs({ statusBar: { model: true } });
  assert.deepEqual(putBody(), {
    theme: { bg: 0, fg: 0, scan: false },
    statusBar: { model: true },
  });
});
