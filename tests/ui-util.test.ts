/**
 * `web/src/ui/util.ts` — the parts that need no DOM: argv tag derivation
 * (`modelFromArgs` / `permFromArgs`, R2 statusline/pane-card tags; the
 * permission tag renders the plain-language short form from `PERM_SHORT`, the
 * CLI value never reaches the DOM) and
 * `fmtUptime` (R2 statusline `up HH:MM:SS`). `el`/`button`/`armButton`/
 * `ArmedSet`/`trapTab`/`fmtAge` all touch the DOM or wall-clock in ways this
 * file doesn't attempt — see the terminal-ui skill for manual verification.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modelFromArgs, permFromArgs, fmtUptime, fmtCount, fmtDur } from '../web/src/ui/util.ts';

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

test('permFromArgs: --dangerously-skip-permissions -> the plain short form, danger', () => {
  assert.deepEqual(permFromArgs(['--dangerously-skip-permissions']), {
    label: 'no prompts',
    danger: true,
  });
});

test('permFromArgs: --permission-mode <value> -> that mode in plain words, not dangerous', () => {
  assert.deepEqual(permFromArgs(['--permission-mode', 'plan']), {
    label: 'read-only',
    danger: false,
  });
});

test('permFromArgs: --permission-mode=<value> form', () => {
  assert.deepEqual(permFromArgs(['--permission-mode=acceptEdits']), {
    label: 'auto edits',
    danger: false,
  });
});

test('permFromArgs: --permission-mode bypassPermissions -> danger, same red semantics AND the same plain label as the skip flag', () => {
  assert.deepEqual(permFromArgs(['--permission-mode', 'bypassPermissions']), {
    label: 'no prompts',
    danger: true,
  });
});

test('permFromArgs: the tag NEVER shows a CLI mode value or a flag (2026-07-25 copy rule)', () => {
  const argvs = [
    ['--permission-mode', 'acceptEdits'],
    ['--permission-mode', 'plan'],
    ['--permission-mode', 'bypassPermissions'],
    ['--dangerously-skip-permissions'],
  ];
  for (const args of argvs) {
    const label = permFromArgs(args)?.label ?? '';
    for (const bad of ['acceptEdits', 'bypassPermissions', '--']) {
      assert.ok(!label.includes(bad), `tag label must not contain ${bad}: ${label}`);
    }
  }
});

test('permFromArgs: a mode outside the known four (custom command) is shown verbatim — no invented translation', () => {
  assert.deepEqual(permFromArgs(['--permission-mode', 'someFutureMode']), {
    label: 'someFutureMode',
    danger: false,
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
    { label: 'no prompts', danger: true },
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

// ---------------------------------------------------------------------------
// fmtCount (settings usage ledger — grouped integers)
// ---------------------------------------------------------------------------

test('fmtCount: groups thousands with commas', () => {
  assert.equal(fmtCount(0), '0');
  assert.equal(fmtCount(360), '360');
  assert.equal(fmtCount(3000), '3,000');
  assert.equal(fmtCount(1234567), '1,234,567');
});

test('fmtCount: truncates toward zero (never prints a fraction)', () => {
  assert.equal(fmtCount(1000.7), '1,000');
});

test('fmtCount: non-finite or negative renders as the em-dash glyph, never NaN', () => {
  assert.equal(fmtCount(Number.NaN), '—');
  assert.equal(fmtCount(-1), '—');
  assert.equal(fmtCount(Number.POSITIVE_INFINITY), '—');
});

// ---------------------------------------------------------------------------
// fmtDur (status-bar session time — MM:SS, minutes DON'T wrap at 60)
// ---------------------------------------------------------------------------

test('fmtDur: zero and sub-second spans render 00:00', () => {
  assert.equal(fmtDur(0), '00:00');
  assert.equal(fmtDur(999), '00:00');
});

test('fmtDur: floors to whole seconds', () => {
  assert.equal(fmtDur(1000), '00:01');
  assert.equal(fmtDur(1500), '00:01');
  assert.equal(fmtDur(59_000), '00:59');
});

test('fmtDur: minute rollover at 60s', () => {
  assert.equal(fmtDur(60_000), '01:00');
  assert.equal(fmtDur(90_000), '01:30');
});

test('fmtDur: minutes DO NOT wrap at 60 — an hour is 60:00, two hours 120:00', () => {
  assert.equal(fmtDur(3_600_000), '60:00');
  assert.equal(fmtDur(2 * 3_600_000), '120:00');
  assert.equal(fmtDur(2 * 3_600_000 + 5_000), '120:05');
});

test('fmtDur: negative / non-finite spans clamp to 00:00, never negative or NaN', () => {
  assert.equal(fmtDur(-5000), '00:00');
  assert.equal(fmtDur(Number.NaN), '00:00');
  assert.equal(fmtDur(Number.POSITIVE_INFINITY), '00:00');
});
