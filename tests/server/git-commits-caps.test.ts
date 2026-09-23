/**
 * GET /api/git/commits — the runner's caps on the list route: a `git log` that
 * floods stdout is killed at 2 MiB, a hung one is SIGKILLed at 5 s, and a
 * `rev-list --count` that times out or fails costs only the TOTAL, which
 * degrades to a floor (B3, spec `.claude/plans/nocturne/PLAN-B3.md`
 * § "Phase 1 — backend").
 *
 * How: a real server child with a fake `git` first on its PATH
 * (`startFakeGitServer`); the fake misbehaves according to the folder it is
 * called in (`fake-flood`, `fake-slow`, `fake-revslow`, `fake-total`).
 *
 * Why: without the caps one enormous or hung repository grows the backend or
 * hangs the request; without the floor the header reads `0 commits` over a
 * full list.
 *
 * NOT claimed here: a real git that is slow (only the fake one), the other
 * two routes' caps (`git-commits-routes.test.ts` covers the 2 MiB patch case
 * through the numstat pre-check).
 *
 * Split out of `tests/server/git-commits.test.ts` by topic (PLAN-RESTRUCTURE
 * O6); the fixture home and the request helpers are
 * `tests/helpers/git-commits-fixture.ts`.
 *
 * Example paths in comments are `/home/you/...`, never anyone's real one.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { GitCommitsResponse } from '../../shared/protocol.ts';
import {
  readServerLog,
  waitForLog,
  type TestServer,
  sleep,
  removeTempDir,
} from '../helpers/helpers.ts';
import { commits, makeCommitsHome, startFakeGitServer } from '../helpers/git-commits-fixture.ts';

let fakeServer: TestServer;
let root: string;
let home: string;

before(async () => {
  ({ root, home } = await makeCommitsHome());
  fakeServer = await startFakeGitServer({ root, home });
});

after(async () => {
  if (fakeServer !== undefined) await fakeServer.stop();
  if (root !== undefined) await removeTempDir(root);
});

// ---------------------------------------------------------------------------
// 8. The caps, through a fake `git` first on the PATH
// ---------------------------------------------------------------------------

test('a `git log` that floods stdout is killed and the request fails — it does not grow the backend', async () => {
  const res = await commits(fakeServer, { root: join(home, 'fake-flood') });
  assert.equal(res.status, 500, JSON.stringify(res.body));
  assert.deepEqual(res.body, { error: 'The app could not read this repository.' });
  await waitForLog(fakeServer, '[git] git log produced more than 2097152 bytes; killed');
  await sleep(500); // past the chunks queued behind the SIGKILL
  const log = await readServerLog(fakeServer);
  const warns = log.match(/git log produced more than 2097152 bytes; killed/g) ?? [];
  assert.equal(warns.length, 1, `exactly one warn line per capped request, got ${warns.length}`);
  const killed = (log.match(/\[git\] git: [^\n]*/g) ?? []).filter((l) => l.includes('killed'));
  assert.equal(killed.length, 1, `exactly one capped request line, got ${killed.length}`);
});

test('a `git log` that hangs is SIGKILLed at the timeout — the request never hangs', async () => {
  // MONOTONIC, not Date.now(): this host is WSL2, whose wall clock is resynced
  // against the Windows host and was MEASURED jumping 1.9 s BACKWARD inside a
  // 10 s window (2026-09-16).
  const started = process.hrtime.bigint();
  const res = await commits(fakeServer, { root: join(home, 'fake-slow') });
  const took = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(res.status, 500);
  assert.deepEqual(res.body, { error: 'The app could not read this repository.' });
  assert.ok(took >= 5_000, `the timeout is what ended it (${took.toFixed(0)}ms)`);
  assert.ok(took < 20_000, `and it ended there, not at the sleep's 30 s (${took.toFixed(0)}ms)`);
  assert.match(await readServerLog(fakeServer), /\[git\] git log timed out after 5000ms; killed/);
});

test('a `rev-list --count` that times out costs the TOTAL, not the page', async () => {
  // `rev-list --count` walks the WHOLE history, so it is the one call here
  // that a merely enormous repository can push past the 5 s SIGKILL. Its
  // rejection used to take the request with it: a page of rows the app had
  // already paid for, thrown away for a number in a header.
  //
  // And the degraded value is NOT 0 — `main, 0 commits` printed over a full
  // list is a lie the user can see. It is a FLOOR: what this page proves
  // exists, wrong only by being too small, and exact on the last page.
  const res = await commits(fakeServer, { root: join(home, 'fake-revslow'), limit: '10' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const body = res.body as GitCommitsResponse;
  assert.equal(body.isRepo, true);
  assert.equal(body.commits.length, 1, 'the rows survive');
  assert.equal(body.commits[0]?.subject, 'only commit');
  assert.equal(body.more, false);
  assert.equal(body.total, 1, 'skip + rows + (more ? 1 : 0), not 0');

  const log = await readServerLog(fakeServer);
  assert.match(log, /\[git\] git rev-list timed out after 5000ms; killed/);
  assert.match(log, /git rev-list did not answer; commit total is a floor/);
  assert.match(log, /\[git\] GET \/api\/git\/commits -> 200, repo=true, 1 commits/);

  // A page that is NOT the last one floors to one past what it holds.
  const paged = (await commits(fakeServer, { root: join(home, 'fake-revslow'), limit: '1', skip: '5' }))
    .body as GitCommitsResponse;
  assert.equal(paged.total, 6, 'skip 5 + the one row it holds, and `more` is false here');
});

test('the degraded TOTAL counts the page AFTER this one too, whenever `more` is true', async () => {
  // The floor is `skip + rows + (more ? 1 : 0)`, and the last term is the only
  // part the *-revslow fixture cannot reach: its git answers ONE record, so
  // `more` is never true there. This git answers TWO whatever `--max-count`
  // asks for, and its `rev-list` exits non-zero (the other way the count can
  // fail — no 5 s timeout to pay for), so a page with `more` true is floored
  // here. Without the term the header reads `10 commits` under a list that
  // visibly has an eleventh page.
  const first = (await commits(fakeServer, { root: join(home, 'fake-total'), limit: '1' }))
    .body as GitCommitsResponse;
  assert.equal(first.commits.length, 1, 'the page is the size that was asked for');
  assert.equal(first.more, true, 'and the extra record is what says there is more');
  assert.equal(first.total, 2, 'skip 0 + 1 row + 1 for the page that follows');

  const deeper = (await commits(fakeServer, { root: join(home, 'fake-total'), limit: '1', skip: '3' }))
    .body as GitCommitsResponse;
  assert.equal(deeper.total, 5, 'skip 3 + 1 row + 1');
  assert.match(await readServerLog(fakeServer), /git rev-list did not answer; commit total is a floor/);
});
