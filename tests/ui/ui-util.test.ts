/**
 * `web/src/ui/format-model.ts` (split from `ui/util.ts`) — argv tag derivation
 * (`modelFromArgs` / `permFromArgs`, R2 statusline/pane-card tags; the
 * permission tag renders the plain-language short form from `PERM_SHORT`, the
 * CLI value never reaches the DOM) and
 * `fmtUptime` (Nocturne statusline `Up 31m` / `Up 2h 15m`), `relativeTime`
 * (the app's one "5 minutes ago", part Q1) and `fmtCount` (every history
 * count). util.ts's `el`/`button`/`armButton`/`ArmedSet`/
 * `trapTab` all touch the DOM in ways this file doesn't attempt — see the
 * terminal-ui skill for manual verification.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modelFromArgs, permFromArgs, fmtUptime, relativeTime, fmtCount } from '../../web/src/ui/format-model.ts';

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

test('modelFromArgs: the short `-m <value>` form the other three agents take (B5)', () => {
  // Codex, Gemini CLI and Grok are spawned as `-m <id>`, so the pane status
  // bar's Model row is honest for them too.
  assert.equal(modelFromArgs(['-m', 'gpt-6-astra']), 'gpt-6-astra');
  assert.equal(modelFromArgs(['-a', 'on-request', '-s', 'read-only', '-m', 'gpt-5.5']), 'gpt-5.5');
  assert.equal(modelFromArgs(['-m', 'flash-lite', '--approval-mode', 'yolo']), 'flash-lite');
  assert.equal(modelFromArgs(['-m', 'grok-4.6', '--effort', 'high', '--continue']), 'grok-4.6');
  // The long form still wins where both somehow appear.
  assert.equal(modelFromArgs(['-m', 'pro', '--model', 'opus']), 'opus');
  assert.equal(modelFromArgs(['--model=sonnet', '-m', 'pro']), 'sonnet');
  // Only the SPACE form: guessing at the joined spellings would start reading
  // an unrelated `-m` out of a custom command as a model.
  assert.equal(modelFromArgs(['-m=pro']), null);
  assert.equal(modelFromArgs(['-mpro']), null);
  assert.equal(modelFromArgs(['-m']), null, 'as the last arg it names nothing');
  assert.equal(modelFromArgs(['-m', '']), null);
  assert.equal(modelFromArgs(['resume', '--last']), null);
});

// ---------------------------------------------------------------------------
// permFromArgs
// ---------------------------------------------------------------------------

test('permFromArgs: --dangerously-skip-permissions -> the plain short form, danger', () => {
  assert.deepEqual(permFromArgs(['--dangerously-skip-permissions']), {
    label: 'No prompts',
    danger: true,
  });
});

test('permFromArgs: --permission-mode <value> -> that mode in plain words, not dangerous', () => {
  assert.deepEqual(permFromArgs(['--permission-mode', 'plan']), {
    label: 'Read only',
    danger: false,
  });
});

test('permFromArgs: --permission-mode=<value> form', () => {
  assert.deepEqual(permFromArgs(['--permission-mode=acceptEdits']), {
    label: 'Auto edits',
    danger: false,
  });
});

test('permFromArgs: --permission-mode bypassPermissions -> danger, same red semantics AND the same plain label as the skip flag', () => {
  assert.deepEqual(permFromArgs(['--permission-mode', 'bypassPermissions']), {
    label: 'No prompts',
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
    { label: 'No prompts', danger: true },
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
// relativeTime — the app's ONE relative time (user decision 2026-09-23,
// `.claude/plans/PLAN-QUALITY.md` decision 1: "5 minutes ago" everywhere). It
// replaced the sessions drawer's `fmtAgo` (`5 min ago`, `yesterday`, `6 Sep`)
// and the GitHub list's `relTime` (`5m ago`) in part Q1, and came here from
// `ui/commit-model.ts`; their tests came with it and now pin the one form.
// `now` is injected, no clock stub.
// ---------------------------------------------------------------------------

const NOW = Date.parse('2026-09-06T12:00:00.000Z');
const ago = (ms: number): string => relativeTime(new Date(NOW - ms).toISOString(), NOW);
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

test('relativeTime: under a minute reads `just now`', () => {
  assert.equal(ago(0), 'just now');
  assert.equal(ago(59 * SEC), 'just now');
});

test('relativeTime: minutes, then hours, at the exact boundaries', () => {
  assert.equal(ago(60 * SEC), '1 minute ago');
  assert.equal(ago(5 * MIN), '5 minutes ago');
  assert.equal(ago(59 * MIN), '59 minutes ago');
  assert.equal(ago(HOUR), '1 hour ago');
  assert.equal(ago(3 * HOUR), '3 hours ago');
  assert.equal(ago(23 * HOUR), '23 hours ago');
});

test('relativeTime: one day reads `1 day ago`, two or more count days', () => {
  assert.equal(ago(DAY), '1 day ago');
  assert.equal(ago(2 * DAY - 1), '1 day ago');
  assert.equal(ago(2 * DAY), '2 days ago');
  assert.equal(ago(4 * DAY), '4 days ago');
  assert.equal(ago(6 * DAY), '6 days ago');
});

test('relativeTime: a week or more counts weeks, then months, never falls back to a date', () => {
  assert.equal(relativeTime('2026-08-30T12:00:00.000Z', NOW), '1 week ago');
  assert.equal(relativeTime('2025-12-31T12:00:00.000Z', NOW), '8 months ago', '249 days, a month is 30');
});

test('relativeTime: a timestamp in the future reads `just now` — clock skew is not an event', () => {
  assert.equal(relativeTime(new Date(NOW + HOUR).toISOString(), NOW), 'just now');
});

test('relativeTime: an unparsable timestamp says nothing, never a fabricated age', () => {
  assert.equal(relativeTime('not-a-date', NOW), '');
  assert.equal(relativeTime('not a date', NOW), '');
});

test('relativeTime: absent / empty / unparseable input renders nothing', () => {
  assert.equal(relativeTime('', NOW), '', 'the GitHub list hands over `pushedAt ?? ""`');
  assert.equal(relativeTime('yesterday', NOW), '');
  assert.equal(relativeTime('2026-13-45T99:99:99Z', NOW), '');
});

test('relativeTime: seconds never show — anything short of the 60 s boundary is "just now"', () => {
  assert.equal(ago(1 * SEC), 'just now');
  assert.equal(ago(60 * SEC - 1), 'just now');
});

test('relativeTime: the 60s boundary crosses to minutes', () => {
  assert.equal(ago(60 * SEC), '1 minute ago');
  assert.equal(ago(119 * SEC), '1 minute ago', 'minutes floor');
  assert.equal(ago(59 * MIN), '59 minutes ago');
});

test('relativeTime: the 60m boundary crosses to hours', () => {
  assert.equal(ago(60 * MIN), '1 hour ago');
  assert.equal(ago(90 * MIN), '1 hour ago', 'hours floor');
  assert.equal(ago(23 * HOUR), '23 hours ago');
});

test('relativeTime: the 24h boundary crosses to days', () => {
  assert.equal(ago(24 * HOUR), '1 day ago');
  assert.equal(ago(47 * HOUR), '1 day ago', 'days floor');
  assert.equal(ago(6 * DAY), '6 days ago');
});

test('relativeTime: the 7d boundary crosses to weeks, the 30d one to months (a month is a flat 30 days)', () => {
  assert.equal(ago(7 * DAY), '1 week ago');
  assert.equal(ago(14 * DAY - 1), '1 week ago', 'weeks floor');
  assert.equal(ago(29 * DAY), '4 weeks ago');
  assert.equal(ago(30 * DAY), '1 month ago');
  assert.equal(ago(59 * DAY), '1 month ago');
  assert.equal(ago(60 * DAY), '2 months ago');
  assert.equal(ago(359 * DAY), '11 months ago');
  assert.equal(ago(364 * DAY), '12 months ago', 'a flat 30-day month reaches 12 before the 365-day year');
});

test('relativeTime: the 365d boundary crosses to years', () => {
  assert.equal(ago(365 * DAY), '1 year ago');
  assert.equal(ago(729 * DAY), '1 year ago');
  assert.equal(ago(730 * DAY), '2 years ago');
  assert.equal(ago(3650 * DAY), '10 years ago');
});

test('relativeTime: a future timestamp (clock skew) degrades to "just now", never a negative age', () => {
  assert.equal(relativeTime(new Date(NOW + 5 * MIN).toISOString(), NOW), 'just now');
  assert.equal(relativeTime(new Date(NOW + 365 * DAY).toISOString(), NOW), 'just now');
});

test('relativeTime: the same instant ages as `now` advances — the clock is the caller’s', () => {
  const iso = new Date(NOW).toISOString();
  assert.equal(relativeTime(iso, NOW), 'just now');
  assert.equal(relativeTime(iso, NOW + 5 * MIN), '5 minutes ago');
  assert.equal(relativeTime(iso, NOW + 5 * HOUR), '5 hours ago');
  assert.equal(relativeTime(iso, NOW + 5 * DAY), '5 days ago');
});

test('the relative half is said in plain words, pluralised, from the clock it is given', () => {
  const at = (ms: number): string => new Date(NOW - ms).toISOString();
  assert.equal(relativeTime(at(5_000), NOW), 'just now');
  assert.equal(relativeTime(at(60_000), NOW), '1 minute ago');
  assert.equal(relativeTime(at(5 * 60_000), NOW), '5 minutes ago');
  assert.equal(relativeTime(at(3600_000), NOW), '1 hour ago');
  assert.equal(relativeTime(at(3 * 3600_000), NOW), '3 hours ago');
  assert.equal(relativeTime(at(24 * 3600_000), NOW), '1 day ago');
  assert.equal(relativeTime(at(6 * 24 * 3600_000), NOW), '6 days ago');
  assert.equal(relativeTime(at(8 * 24 * 3600_000), NOW), '1 week ago');
  assert.equal(relativeTime(at(40 * 24 * 3600_000), NOW), '1 month ago');
  assert.equal(relativeTime(at(400 * 24 * 3600_000), NOW), '1 year ago');
  assert.equal(relativeTime(at(800 * 24 * 3600_000), NOW), '2 years ago');
  // A clock that runs ahead of the commit's: the app cannot know which of the
  // two is wrong, and "in 3 hours" is the one thing that is certainly false.
  assert.equal(relativeTime(at(-3 * 3600_000), NOW), 'just now');
  // It is computed against the clock it is HANDED, so a list open for an hour
  // says so on its next repaint.
  const iso = at(3600_000);
  assert.equal(relativeTime(iso, NOW + 3600_000), '2 hours ago');
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
