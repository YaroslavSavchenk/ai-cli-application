/**
 * `web/src/ui/util.ts` — the parts that need no DOM: argv tag derivation
 * (`modelFromArgs` / `permFromArgs`, R2 statusline/pane-card tags; the
 * permission tag renders the plain-language short form from `PERM_SHORT`, the
 * CLI value never reaches the DOM) and
 * `fmtUptime` (Nocturne statusline `Up 31m` / `Up 2h 15m`), plus `fmtAgo`/`baseName`/`fmtCount` (the
 * sessions drawer's HISTORY section: when an entry last ran, and the folder
 * name for a cwd the app cannot name). `el`/`button`/`armButton`/`ArmedSet`/
 * `trapTab` all touch the DOM in ways this file doesn't attempt — see the
 * terminal-ui skill for manual verification.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modelFromArgs, permFromArgs, fmtUptime, fmtAgo, baseName, fmtCount } from '../web/src/ui/util.ts';

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

test('fmtUptime: 0s -> 0m', () => {
  assert.equal(fmtUptime(isoSecondsAgo(0)), '0m');
});

test('fmtUptime: under a minute reads 0m — seconds are not shown', () => {
  assert.equal(fmtUptime(isoSecondsAgo(59)), '0m');
});

test('fmtUptime: minute rollover at 60s', () => {
  assert.equal(fmtUptime(isoSecondsAgo(60)), '1m');
});

test('fmtUptime: hour rollover at 3600s', () => {
  assert.equal(fmtUptime(isoSecondsAgo(3599)), '59m');
  assert.equal(fmtUptime(isoSecondsAgo(3600)), '1h 0m');
});

test('fmtUptime: past 24h, hours do not wrap (25h 1m)', () => {
  assert.equal(fmtUptime(isoSecondsAgo(25 * 3600 + 61)), '25h 1m');
});

test('fmtUptime: a timestamp in the future clamps to 0m, never negative', () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  assert.equal(fmtUptime(future), '0m');
});

test('fmtUptime: the shape is `<h>h <m>m` / `<m>m` — hours only once there are any', () => {
  for (const secs of [0, 59, 60, 3599, 3600, 25 * 3600 + 61, 100 * 3600]) {
    assert.match(fmtUptime(isoSecondsAgo(secs)), /^(\d+h )?\d+m$/, `shape for ${secs}s`);
  }
});

test('fmtUptime: an unparsable timestamp renders as an em dash', () => {
  assert.equal(fmtUptime('not-a-date'), '—');
});

// ---------------------------------------------------------------------------
// fmtAgo (sessions drawer, HISTORY meta line) — `now` is injected, no clock stub
// ---------------------------------------------------------------------------

const NOW = Date.parse('2026-09-06T12:00:00.000Z');
const ago = (ms: number): string => fmtAgo(new Date(NOW - ms).toISOString(), NOW);
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

test('fmtAgo: under a minute reads `just now`', () => {
  assert.equal(ago(0), 'just now');
  assert.equal(ago(59 * SEC), 'just now');
});

test('fmtAgo: minutes, then hours, at the exact boundaries', () => {
  assert.equal(ago(60 * SEC), '1 min ago');
  assert.equal(ago(5 * MIN), '5 min ago');
  assert.equal(ago(59 * MIN), '59 min ago');
  assert.equal(ago(HOUR), '1 h ago');
  assert.equal(ago(3 * HOUR), '3 h ago');
  assert.equal(ago(23 * HOUR), '23 h ago');
});

test('fmtAgo: one day reads `yesterday`, two or more count days', () => {
  assert.equal(ago(DAY), 'yesterday');
  assert.equal(ago(2 * DAY - 1), 'yesterday');
  assert.equal(ago(2 * DAY), '2 d ago');
  assert.equal(ago(4 * DAY), '4 d ago');
  assert.equal(ago(6 * DAY), '6 d ago');
});

test('fmtAgo: a week or more falls back to a short date, with the year only when it differs', () => {
  assert.equal(fmtAgo('2026-08-30T12:00:00.000Z', NOW), '30 Aug');
  assert.equal(fmtAgo('2025-12-31T12:00:00.000Z', NOW), '31 Dec 2025');
});

test('fmtAgo: a timestamp in the future reads `just now` — clock skew is not an event', () => {
  assert.equal(fmtAgo(new Date(NOW + HOUR).toISOString(), NOW), 'just now');
});

test('fmtAgo: an unparsable timestamp renders as an em dash, never a fabricated age', () => {
  assert.equal(fmtAgo('not-a-date', NOW), '—');
});

// ---------------------------------------------------------------------------
// baseName (history folder label for a cwd with no known project)
// ---------------------------------------------------------------------------

test('baseName: the last path segment', () => {
  assert.equal(baseName('/home/you/projects/web-ui'), 'web-ui');
  assert.equal(baseName('/home/you/projects/web-ui/'), 'web-ui');
  assert.equal(baseName('/srv'), 'srv');
});

test('baseName: a path with nothing to take falls back to the input itself', () => {
  assert.equal(baseName('/'), '/');
  assert.equal(baseName(''), '');
});

// ---------------------------------------------------------------------------
// fmtCount — every history count (HISTORY header, folder rows, the empty
// state's "Resume a session (N)") caps at 9+ (user's request 2026-09-08).
// ---------------------------------------------------------------------------

test('fmtCount: up to nine is the plain number', () => {
  assert.equal(fmtCount(0), '0');
  assert.equal(fmtCount(1), '1');
  assert.equal(fmtCount(9), '9');
});

test('fmtCount: ten and beyond read 9+', () => {
  assert.equal(fmtCount(10), '9+');
  assert.equal(fmtCount(42), '9+');
  assert.equal(fmtCount(1000), '9+');
});
