/**
 * `web/src/api.ts` `updatePrefs()` — the CLIENT-side merge-on-write for the
 * shared prefs bag. `PUT /api/prefs` REPLACES the whole object (proven server-
 * side in tests/server/prefs.test.ts), so two writers — the Terminal colours page
 * writing `theme` and the settings panel writing `statusLine` — must read-merge-write
 * or they clobber each other's top-level keys. The server suite can't see this;
 * this is the only coverage of the read-merge-write itself.
 *
 * It also covers the DROP list (2026-07-26): the only way to delete a key from
 * a bag whose write is a whole-object replace. The settings panel uses it to
 * retire `defaults` and `statusBar`, the two keys this app stopped writing when
 * the launch-defaults section and the per-pane strip were removed.
 *
 * api.ts is DOM-free at import (it touches `window`/`fetch` only inside call-
 * time helpers), so we stub both globals. `node --test` runs each *.test.ts in
 * its own process, so the stubs never leak into another suite.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { updatePrefs } from '../../web/src/api.ts';
import type { UiPrefs } from '../../shared/protocol.ts';

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

test('updatePrefs GETs then PUTs, preserving untouched top-level keys (theme + a foreign key survive writing `statusLine`)', async () => {
  getBody = { theme: { ground: '#07090c', text: '#ffe9c4' }, futureSetting: 'keep' };
  await updatePrefs({ statusLine: { enabled: true, model: true } });

  assert.deepEqual(calls.map((c) => c.method), ['GET', 'PUT'], 'exactly one GET then one PUT');
  assert.equal(calls[0].path, '/api/prefs');
  assert.equal(calls[1].path, '/api/prefs');
  assert.deepEqual(putBody(), {
    theme: { ground: '#07090c', text: '#ffe9c4' },
    futureSetting: 'keep',
    statusLine: { enabled: true, model: true },
  });
});

test('updatePrefs is last-write-wins per top-level key: a patch to `theme` overwrites the stored `theme` verbatim', async () => {
  getBody = { theme: { ground: '#07090c', text: '#d8ffd8' }, statusLine: { usage: true } };
  await updatePrefs({ theme: { ground: '#0a1510', text: '#efe6ff' } });
  assert.deepEqual(putBody(), {
    theme: { ground: '#0a1510', text: '#efe6ff' },
    statusLine: { usage: true },
  });
});

test('a failed GET writes NOTHING and rejects: the PUT replaces the whole bag, so patch-only is data loss', async () => {
  getOk = false;
  getBody = { error: 'boom' };
  await assert.rejects(updatePrefs({ statusLine: { enabled: false } }));
  assert.deepEqual(calls.map((c) => c.method), ['GET'], 'GET attempted, and no PUT followed it');
  // Without this, one unreadable GET resets statusLine, behaviour and tools to
  // their factory values. Every caller catches and reverts its own row.
});

test('a wrong-shape GET (array) is guarded like an absent bag — the merge base stays {}, so only the patch is written', async () => {
  getBody = [1, 2, 3];
  await updatePrefs({ theme: { ground: '#0b0d14', text: '#e9e9ed' } });
  assert.deepEqual(putBody(), { theme: { ground: '#0b0d14', text: '#e9e9ed' } });
});

test('a null GET body is guarded too (no crash, no spread of null)', async () => {
  getBody = null;
  await updatePrefs({ statusLine: {} } as UiPrefs);
  assert.deepEqual(putBody(), { statusLine: {} });
});

test('writing `statusLine` merges: the settings panel preserves the stored `theme` (and any foreign key)', async () => {
  getBody = {
    theme: { ground: '#07090c', text: '#ffe9c4' },
    futureSetting: 'keep',
  };
  await updatePrefs({ statusLine: { enabled: true, model: true, usage: false } });
  assert.deepEqual(calls.map((c) => c.method), ['GET', 'PUT'], 'exactly one GET then one PUT');
  assert.deepEqual(putBody(), {
    theme: { ground: '#07090c', text: '#ffe9c4' },
    futureSetting: 'keep',
    statusLine: { enabled: true, model: true, usage: false },
  });
});

test('writing `statusLine` overwrites only the stored `statusLine` verbatim (last-write-wins per top-level key)', async () => {
  getBody = {
    theme: { ground: '#0b0d14', text: '#e9e9ed' },
    statusLine: { enabled: false, lines: true },
  };
  await updatePrefs({ statusLine: { enabled: true } });
  assert.deepEqual(putBody(), {
    theme: { ground: '#0b0d14', text: '#e9e9ed' },
    statusLine: { enabled: true },
  });
});

// ---------------------------------------------------------------------------
// The DROP list — retiring a key from an opaque bag (settings panel, 2026-07-26)
// ---------------------------------------------------------------------------

test('the settings-panel write path: a bag holding BOTH retired keys comes back with `statusLine` and neither of them', async () => {
  // Exactly what a long-lived prefs.json looks like before the first write of
  // the new panel: the retired launch defaults, the retired per-pane strip
  // config, a theme, and a key this app has never heard of.
  getBody = {
    theme: { ground: '#0a1220', text: '#e8f4ff' },
    defaults: { model: 'sonnet', permissionMode: 'plan', startupCommand: '/x' },
    statusBar: { model: true, time: true, skill: true },
    futureSetting: 'keep',
  };
  await updatePrefs(
    { statusLine: { enabled: true, model: true, mode: true, branch: true, cost: true, lines: false, context: true, usage: false } },
    ['defaults', 'statusBar'],
  );
  const body = putBody() as Record<string, unknown>;
  assert.deepEqual(body, {
    theme: { ground: '#0a1220', text: '#e8f4ff' },
    futureSetting: 'keep',
    statusLine: {
      enabled: true,
      model: true,
      mode: true,
      branch: true,
      cost: true,
      lines: false,
      context: true,
      usage: false,
    },
  });
  // Named explicitly: absent, not present-and-undefined (JSON.stringify would
  // hide the difference in the wire body, but the merged object must be clean).
  assert.ok(!('defaults' in body), '`defaults` must be gone from the written bag');
  assert.ok(!('statusBar' in body), '`statusBar` must be gone from the written bag');
});

test('dropping is idempotent and harmless when the retired keys are already absent', async () => {
  getBody = { theme: { ground: '#0b0d14', text: '#e9e9ed' } };
  await updatePrefs({ statusLine: { enabled: true } }, ['defaults', 'statusBar']);
  assert.deepEqual(putBody(), {
    theme: { ground: '#0b0d14', text: '#e9e9ed' },
    statusLine: { enabled: true },
  });
});

test('drop is applied AFTER the merge — a key cannot be written and dropped by the same call', async () => {
  getBody = { defaults: { model: 'opus' } };
  await updatePrefs({ defaults: { model: 'haiku' } } as UiPrefs, ['defaults']);
  assert.deepEqual(putBody(), {}, 'the dropped key loses, whatever the patch said');
});

test('an empty drop list leaves every unknown key alone (every other writer)', async () => {
  getBody = { defaults: { model: 'opus' }, statusBar: { model: false } };
  await updatePrefs({ theme: { ground: '#07090c', text: '#d8ffd8' } });
  assert.deepEqual(putBody(), {
    defaults: { model: 'opus' },
    statusBar: { model: false },
    theme: { ground: '#07090c', text: '#d8ffd8' },
  });
});

// ---------------------------------------------------------------------------
// Nocturne C1: a bad stored `mascot` must not block every later save
// ---------------------------------------------------------------------------

test('a stored `mascot` of the wrong shape is DROPPED from the PUT (the server would 400 the whole save)', async () => {
  for (const bad of ['off', null, false, { enabled: 'no' }, { enabled: true, extra: 1 }, [], {}]) {
    calls = [];
    getBody = { mascot: bad, futureSetting: 'keep' };
    await updatePrefs({ theme: { ground: '#07090c', text: '#ffe9c4' } });
    const body = putBody() as Record<string, unknown>;
    assert.equal('mascot' in body, false, `dropped, not coerced: ${JSON.stringify(bad)}`);
    assert.deepEqual(body, { futureSetting: 'keep', theme: { ground: '#07090c', text: '#ffe9c4' } });
  }
});

test('a valid stored `mascot` survives an unrelated save untouched, and a mascot patch is sent as given', async () => {
  getBody = { mascot: { enabled: false } };
  await updatePrefs({ statusLine: { enabled: true } });
  assert.deepEqual(putBody(), { mascot: { enabled: false }, statusLine: { enabled: true } });
  calls = [];
  getBody = { mascot: 'off' };
  await updatePrefs({ mascot: { enabled: true } });
  assert.deepEqual(putBody(), { mascot: { enabled: true } });
});
