/**
 * The one integer-milliseconds env parser — `server/config.ts` `envMs`,
 * shared since Nocturne D9 P2 (`.claude/plans/nocturne/PLAN-D9.md`) by
 * AI_SM_GRACE_MS / AI_SM_STARTUP_GRACE_MS (`server/lifecycle.ts`), the update
 * timings (`server/index-update.ts`) and the pty-host lifetimes
 * (`server/pty-host-server.ts` `resolveHostTimers`).
 *
 * How: the function called directly with its `env` seam and a recording
 * logger — every rule is a pure decision on a string.
 *
 * Why it matters: a seam that falls back silently hides a typo; one without
 * its floor turns `0` into a request flood (update checks) or an instant kill
 * of every session (orphan grace); one without the cap hands setTimeout a
 * delay it silently turns into 1 ms — the opposite of what was asked.
 *
 * NOT claimed: which seams use which floor at boot (`update-install-boot.test.ts`,
 * `lifecycle.test.ts`, `pty-host-wire.test.ts`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { envMs } from '../../server/config.ts';

/** Node's setTimeout ceiling (2^31 - 1 ms). */
const TIMER_MAX_MS = 2_147_483_647;

function parse(raw: string | undefined, opts: { floor?: number } = {}): { value: number; lines: string[] } {
  const lines: string[] = [];
  const env = raw === undefined ? {} : { AI_SM_TEST_MS: raw };
  const value = envMs('AI_SM_TEST_MS', 5000, (level, message) => lines.push(`${level} ${message}`), { ...opts, env });
  return { value, lines };
}

test('unset or empty falls back silently; a plain integer is taken as it is', () => {
  assert.deepEqual(parse(undefined), { value: 5000, lines: [] }, 'unset');
  assert.deepEqual(parse(''), { value: 5000, lines: [] }, 'empty');
  assert.deepEqual(parse('0'), { value: 0, lines: [] }, 'zero without a floor');
  assert.deepEqual(parse('1234'), { value: 1234, lines: [] }, 'a plain value');
});

test('anything but a non-negative integer falls back to the default, out loud', () => {
  for (const raw of ['soon', '-1', '1.5', 'NaN', '1e400']) {
    const { value, lines } = parse(raw);
    assert.equal(value, 5000, `${raw}: the default`);
    assert.deepEqual(
      lines,
      [`warn AI_SM_TEST_MS must be a non-negative integer (ms), got ${JSON.stringify(raw)}; using 5000`],
      `${raw}: one warn line naming the seam and the value`,
    );
  }
});

test('a value below the floor is raised to it, out loud; the floor itself passes quietly', () => {
  assert.deepEqual(parse('10', { floor: 1000 }), {
    value: 1000,
    lines: ['warn AI_SM_TEST_MS=10 is below the 1000ms floor; using 1000'],
  });
  assert.deepEqual(parse('1000', { floor: 1000 }), { value: 1000, lines: [] }, 'exactly the floor');
});

test('a value over the Node timer maximum is capped, out loud; the maximum itself passes quietly', () => {
  assert.deepEqual(parse(String(TIMER_MAX_MS)), { value: TIMER_MAX_MS, lines: [] }, 'exactly the maximum');
  assert.deepEqual(parse(String(TIMER_MAX_MS + 1)), {
    value: TIMER_MAX_MS,
    lines: [`warn AI_SM_TEST_MS=${TIMER_MAX_MS + 1} is above the ${TIMER_MAX_MS}ms timer maximum; using ${TIMER_MAX_MS}`],
  });
});
