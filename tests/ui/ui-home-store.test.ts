/**
 * `web/src/ui/home-store.ts` — the ONE cache of the user's home folder that
 * the New Project dialog and the GitHub panel share (part Q1,
 * `.claude/plans/PLAN-QUALITY.md`; before it each module kept its own).
 *
 * How: the real module, handed a fake lister (the store takes its I/O as a
 * parameter), so every `fsList` answer is scripted and counted. The dialogs
 * that read it are driven end to end in `tests/ui/ui-picker-dom.test.ts` and
 * `tests/ui/ui-addproject-dom.test.ts`.
 *
 * Why it matters: the two copies differed on one answer — an EMPTY path.
 * The dialog's cached it (and then suggested no path for the rest of the
 * page's life), the GitHub panel's retried. Retrying is the one kept: an
 * empty path is not a home. And the cache must stay one request, or every
 * dialog open would list the home folder again.
 *
 * NOT claimed: what the backend answers for `GET /api/fs/list` (the server
 * tests), or the dialog's drawing of it (the DOM tests above).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../../web/src/ui/home-store.ts';

interface Harness {
  calls: number;
  /** The scripted answers, one per call; a string is thrown as a failure. */
  answers: ({ path: string; dirs: string[] } | string)[];
}
const H: Harness = { calls: 0, answers: [] };

/** The fake `api.fsList`: the next scripted answer, counted. */
async function list(): Promise<{ path: string; dirs: string[] }> {
  H.calls += 1;
  const next = H.answers.shift();
  if (next === undefined || typeof next === 'string') throw new Error(next ?? 'no answer scripted');
  return next;
}

// One module instance for the whole file, so the tests run in order and each
// one starts from the state the previous one left: unknown, then resolved.

test('a failed or empty answer leaves the home unknown, and the next call asks again', async () => {
  H.answers.push('network down', { path: '', dirs: [] });
  assert.equal(await store.ensureHome(list), null, 'a failure is not a home');
  assert.equal(await store.ensureHome(list), null, 'an empty path is not a home');
  assert.equal(store.homeDir(), null);
  assert.equal(store.homeHasFolder('projects'), false, 'nothing is known about an unknown home');
  assert.equal(H.calls, 2, 'each call asked, because nothing was cached');
});

test('the first real home is cached: one request, whoever asks next', async () => {
  H.answers.push({ path: '/home/you', dirs: ['projects', 'notes'] });
  assert.equal(await store.ensureHome(list), '/home/you');
  assert.equal(await store.ensureHome(list), '/home/you');
  assert.equal(store.homeDir(), '/home/you');
  assert.equal(H.calls, 3, 'the second call was served from the cache');
});

test('whether the home holds a folder is read from that one listing', () => {
  assert.equal(store.homeHasFolder('projects'), true);
  assert.equal(store.homeHasFolder('notes'), true);
  assert.equal(store.homeHasFolder('missing'), false);
});
