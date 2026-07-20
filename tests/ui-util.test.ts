/**
 * `web/src/ui/util.ts` — the parts that need no DOM: argv tag derivation
 * (`modelFromArgs` / `permFromArgs`, R2 statusline/pane-card tags) and
 * `fmtUptime` (R2 statusline `up HH:MM:SS`). `el`/`button`/`armButton`/
 * `ArmedSet`/`trapTab`/`fmtAge` all touch the DOM or wall-clock in ways this
 * file doesn't attempt — see the terminal-ui skill for manual verification.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modelFromArgs, permFromArgs, fmtUptime } from '../web/src/ui/util.ts';

// ---------------------------------------------------------------------------
// modelFromArgs
// ---------------------------------------------------------------------------

test('modelFromArgs: --model <value> form', () => {
  assert.equal(modelFromArgs(['--model', 'opus']), 'opus');
});

test('modelFromArgs: --model=<value> form', () => {
  assert.equal(modelFromArgs(['--model=sonnet']), 'sonnet');
});

test('modelFromArgs: absent flag -> null', () => {
  assert.equal(modelFromArgs([]), null);
  assert.equal(modelFromArgs(['--permission-mode', 'plan']), null);
});

test('modelFromArgs: --model as the last arg (no value) -> null', () => {
  assert.equal(modelFromArgs(['--model']), null);
});

test('modelFromArgs: --model followed by an empty string -> null', () => {
  assert.equal(modelFromArgs(['--model', '']), null);
});

test('modelFromArgs: --model= with an empty value -> null', () => {
  assert.equal(modelFromArgs(['--model=']), null);
});

// ---------------------------------------------------------------------------
// permFromArgs
// ---------------------------------------------------------------------------

test('permFromArgs: --dangerously-skip-permissions -> bypass, danger', () => {
  assert.deepEqual(permFromArgs(['--dangerously-skip-permissions']), {
    label: 'bypass',
    danger: true,
  });
});

test('permFromArgs: --permission-mode <value> -> that mode, not dangerous', () => {
  assert.deepEqual(permFromArgs(['--permission-mode', 'plan']), {
    label: 'plan',
    danger: false,
  });
});

test('permFromArgs: --permission-mode=<value> form', () => {
  assert.deepEqual(permFromArgs(['--permission-mode=acceptEdits']), {
    label: 'acceptEdits',
    danger: false,
  });
});

test('permFromArgs: --permission-mode bypassPermissions -> danger, same red semantics as the skip flag', () => {
  assert.deepEqual(permFromArgs(['--permission-mode', 'bypassPermissions']), {
    label: 'bypassPermissions',
    danger: true,
  });
});

test('permFromArgs: --permission-mode default -> null (no tag shown)', () => {
  assert.equal(permFromArgs(['--permission-mode', 'default']), null);
});

test('permFromArgs: absent flags -> null', () => {
  assert.equal(permFromArgs([]), null);
});

test('permFromArgs: --permission-mode as the last arg (no value) -> null', () => {
  assert.equal(permFromArgs(['--permission-mode']), null);
});

test('permFromArgs: both bypass forms present -> the skip flag wins, still danger', () => {
  assert.deepEqual(
    permFromArgs(['--permission-mode', 'plan', '--dangerously-skip-permissions']),
    { label: 'bypass', danger: true },
  );
});

// ---------------------------------------------------------------------------
// fmtUptime
// ---------------------------------------------------------------------------

/**
 * ISO timestamp `totalSeconds` in the past, offset by an extra 500ms so the
 * function's own `Date.now()` call (a few ms after we capture ours) can
 * never cross a second boundary and flip the floored result — deterministic
 * without mocking the clock.
 */
function isoSecondsAgo(totalSeconds: number): string {
  return new Date(Date.now() - totalSeconds * 1000 - 500).toISOString();
}

test('fmtUptime: 0s -> 00:00:00', () => {
  assert.equal(fmtUptime(isoSecondsAgo(0)), '00:00:00');
});

test('fmtUptime: under a minute', () => {
  assert.equal(fmtUptime(isoSecondsAgo(59)), '00:00:59');
});

test('fmtUptime: minute rollover at 60s', () => {
  assert.equal(fmtUptime(isoSecondsAgo(60)), '00:01:00');
});

test('fmtUptime: hour rollover at 3600s', () => {
  assert.equal(fmtUptime(isoSecondsAgo(3599)), '00:59:59');
  assert.equal(fmtUptime(isoSecondsAgo(3600)), '01:00:00');
});

test('fmtUptime: past 24h, hours do not wrap (25:01:01)', () => {
  assert.equal(fmtUptime(isoSecondsAgo(25 * 3600 + 61)), '25:01:01');
});

test('fmtUptime: a timestamp in the future clamps to 00:00:00, never negative', () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  assert.equal(fmtUptime(future), '00:00:00');
});

test('fmtUptime: an unparsable timestamp renders as an em dash', () => {
  assert.equal(fmtUptime('not-a-date'), '—');
});
