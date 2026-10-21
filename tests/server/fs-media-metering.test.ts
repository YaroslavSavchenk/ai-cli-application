/**
 * GET /api/fs/media — whose log lines are metered (Nocturne D7,
 * `.claude/plans/nocturne/PLAN-D7.md`): the one /api route without the token
 * counts as TRUSTED only once its ticket was accepted. A request without a
 * live ticket is a stranger's, and its access line goes through the shared
 * refusal budget (server/config.ts createRefusalLimiter, 60 a minute); a
 * request WITH one is the app's own and is always written.
 *
 * One real server child of its own (`tests/helpers/fs-server-fixture.ts`):
 * the flood spends the process-wide budget, which would silence the access
 * lines other files' tests wait for, so it lives alone here.
 *
 * Why it matters: any web page on the machine can aim an `<img>` at
 * 127.0.0.1:<port>/api/fs/media. Trusted before its ticket is judged, that
 * flood is an unmetered disk-filling primitive; never trusted, a playing
 * video's requests vanish from the log once a stranger spent the budget.
 *
 * NOT claimed: the limiter's window arithmetic (tests/server/logging-hardening.test.ts).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootFsServer, server, stopFsServer } from '../helpers/fs-server-fixture.ts';
import { getMedia, pattern, plantMedia, ticketFor } from '../helpers/fs-media-fixture.ts';
import { waitForLog, waitForLogQuiet } from '../helpers/helpers.ts';

/**
 * More than twice the 60-a-minute budget: should the fixed window roll over
 * mid-flood, one of its two halves still holds more than 60.
 */
const FLOOD = 130;
const STRANGER_LINE = 'GET /api/fs/media ?… -> 403';

before(() => bootFsServer('ai-sm-fsmedia-meter-'));
after(() => stopFsServer());

test('a flood without a ticket is metered, and a request with one is still written after it', async () => {
  const path = await plantMedia('metered.png', pattern(12));
  const { ticket } = await ticketFor(path);
  for (let i = 0; i < FLOOD; i++) {
    assert.equal((await getMedia(path, 'e'.repeat(64))).status, 403, `stranger request ${i}`);
  }
  await waitForLog(server, 'suppressed refused request log lines');
  const flooded = await waitForLogQuiet(server);
  const written = flooded.split(STRANGER_LINE).length - 1;
  assert.ok(written < FLOOD, `only part of the flood is written (${written} of ${FLOOD})`);
  // The trusted request: its line is written although the budget is spent.
  assert.equal((await getMedia(path, ticket, { range: 'bytes=0-1' })).status, 206);
  await waitForLog(server, 'GET /api/fs/media ?… -> 206');
});
