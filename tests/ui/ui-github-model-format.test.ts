/**
 * `web/src/ui/github-model.ts` — the pure presentation logic extracted from
 * `ui/github.ts`. DOM-free by construction, so `node --test` imports it
 * directly (same split as theme-model / newproject-model); fixtures (a fixed
 * `now`, repo and project builders) in `tests/helpers/ui-github-model-fixture.ts`.
 * This file: the token-expiry and device-code expiry formats, Linguist
 * language colours, and the poll/tick cadence. Split from
 * `tests/ui/ui-github-model.test.ts`. The repo list's relative time was
 * `relTime` (`5m ago`) until part Q1 folded it into ui/util.ts's
 * `relativeTime` (`5 minutes ago`); its tests moved to `tests/ui/ui-util.test.ts`.
 *
 * The reason these were untestable before: every clock-dependent format read
 * `Date.now()` internally. `now` is now an injected ms-epoch parameter, so
 * every boundary below (expiry-already-past included) is asserted at an exact
 * instant, not approximately.
 *
 * NOT claimed: that the panel really re-renders on the tick, and the colour
 * dot as drawn (browser work, `.claude/skills/verify-terminal/SKILL.md`).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GH_EXPIRY_TICK_MS,
  GH_EXPIRY_WARN_MS,
  GH_POLL_MS,
  GH_SEARCH_DEBOUNCE_MS,
  LANG_COLOR,
  expiryTickMs,
  fmtExpiry,
  fmtTokenExpiry,
  langColor,
  pollIntervalMs,
} from '../../web/src/ui/github-model.ts';
import { NOW, SEC, MIN, HOUR, DAY, ago, ahead } from '../helpers/ui-github-model-fixture.ts';

// ---------------------------------------------------------------------------
// fmtTokenExpiry — say it BEFORE it bites (V-4)
// ---------------------------------------------------------------------------

test('fmtTokenExpiry: nothing known → NO line at all', () => {
  assert.equal(fmtTokenExpiry(undefined, NOW), null);
  assert.equal(fmtTokenExpiry('', NOW), null);
  assert.equal(fmtTokenExpiry('not-a-date', NOW), null, 'an unparseable stamp is not a guess');
});

test('fmtTokenExpiry: a distant expiry counts down in days and does NOT warn', () => {
  assert.deepEqual(fmtTokenExpiry(ahead(90 * DAY), NOW), { text: 'expires in 90 days', warn: false });
  assert.deepEqual(fmtTokenExpiry(ahead(4 * DAY), NOW), { text: 'expires in 4 days', warn: false });
});

test('fmtTokenExpiry: inside three days it warns — the amber line the user must act on', () => {
  assert.deepEqual(fmtTokenExpiry(ahead(3 * DAY - SEC), NOW), {
    text: 'expires in 2 days',
    warn: true,
  });
  assert.deepEqual(fmtTokenExpiry(ahead(3 * DAY), NOW), {
    text: 'expires in 3 days',
    warn: false,
  });
  assert.equal(GH_EXPIRY_WARN_MS, 3 * DAY);
});

test('fmtTokenExpiry: the hour and minute ladders, with singulars', () => {
  assert.deepEqual(fmtTokenExpiry(ahead(47 * HOUR), NOW), { text: 'expires in 47 hours', warn: true });
  assert.deepEqual(fmtTokenExpiry(ahead(48 * HOUR), NOW), { text: 'expires in 2 days', warn: true });
  assert.deepEqual(fmtTokenExpiry(ahead(HOUR), NOW), { text: 'expires in 1 hour', warn: true });
  assert.deepEqual(fmtTokenExpiry(ahead(59 * MIN), NOW), { text: 'expires in 59 minutes', warn: true });
  assert.deepEqual(fmtTokenExpiry(ahead(MIN), NOW), { text: 'expires in 1 minute', warn: true });
});

test('fmtTokenExpiry: under a minute never reads "0 minutes"', () => {
  assert.deepEqual(fmtTokenExpiry(ahead(59 * SEC), NOW), {
    text: 'expires in under a minute',
    warn: true,
  });
  assert.deepEqual(fmtTokenExpiry(ahead(1), NOW), { text: 'expires in under a minute', warn: true });
});

test('fmtTokenExpiry: exactly-now and already-past both read as expired, and both warn', () => {
  assert.deepEqual(fmtTokenExpiry(ahead(0), NOW), { text: 'this token has expired', warn: true });
  assert.deepEqual(fmtTokenExpiry(ago(DAY), NOW), { text: 'this token has expired', warn: true });
});

test('fmtTokenExpiry: the clock is the caller’s — the same instant ages toward the warning', () => {
  const iso = ahead(5 * DAY);
  assert.deepEqual(fmtTokenExpiry(iso, NOW), { text: 'expires in 5 days', warn: false });
  assert.deepEqual(fmtTokenExpiry(iso, NOW + 3 * DAY), { text: 'expires in 2 days', warn: true });
  assert.deepEqual(fmtTokenExpiry(iso, NOW + 6 * DAY), { text: 'this token has expired', warn: true });
});

test('fmtTokenExpiry is NOT the device-code countdown — the two formats stay distinct', () => {
  // fmtExpiry is an MM:SS countdown for a code on screen for minutes; a stored
  // credential's expiry is coarse. Same input, deliberately different answers.
  const iso = ahead(15 * MIN);
  assert.equal(fmtExpiry(iso, NOW), 'expires in 15:00');
  assert.deepEqual(fmtTokenExpiry(iso, NOW), { text: 'expires in 15 minutes', warn: true });
});

// ---------------------------------------------------------------------------
// fmtExpiry — now injected
// ---------------------------------------------------------------------------

test('fmtExpiry: no expiry at all renders nothing (the line is blank, not "expired")', () => {
  assert.equal(fmtExpiry(undefined, NOW), '');
});

test('fmtExpiry: a future expiry counts down as zero-padded MM:SS', () => {
  assert.equal(fmtExpiry(ahead(15 * MIN), NOW), 'expires in 15:00');
  assert.equal(fmtExpiry(ahead(9 * MIN + 5 * SEC), NOW), 'expires in 09:05');
  assert.equal(fmtExpiry(ahead(65 * SEC), NOW), 'expires in 01:05');
  assert.equal(fmtExpiry(ahead(1 * SEC), NOW), 'expires in 00:01');
});

test('fmtExpiry: sub-second remainders floor (999ms left is still 00:00, never rounded up)', () => {
  assert.equal(fmtExpiry(ahead(999), NOW), 'expires in 00:00');
});

test('fmtExpiry: over an hour keeps counting in minutes (no HH:MM:SS switch)', () => {
  assert.equal(fmtExpiry(ahead(90 * MIN), NOW), 'expires in 90:00');
});

test('fmtExpiry: exactly-now and already-past both read as expired', () => {
  assert.equal(fmtExpiry(ahead(0), NOW), 'code expired — cancel and retry');
  assert.equal(fmtExpiry(ago(1), NOW), 'code expired — cancel and retry');
  assert.equal(fmtExpiry(ago(10 * MIN), NOW), 'code expired — cancel and retry');
});

test('fmtExpiry: an unparseable timestamp reads as expired (never NaN:NaN)', () => {
  assert.equal(fmtExpiry('not-a-date', NOW), 'code expired — cancel and retry');
  assert.equal(fmtExpiry('', NOW), 'code expired — cancel and retry');
});

test('fmtExpiry: the same instant with a later `now` counts down — the clock is the caller’s', () => {
  const iso = ahead(2 * MIN);
  assert.equal(fmtExpiry(iso, NOW), 'expires in 02:00');
  assert.equal(fmtExpiry(iso, NOW + 30 * SEC), 'expires in 01:30');
  assert.equal(fmtExpiry(iso, NOW + 2 * MIN), 'code expired — cancel and retry');
});

// ---------------------------------------------------------------------------
// langColor
// ---------------------------------------------------------------------------

test('langColor: known languages return their Linguist color verbatim', () => {
  assert.equal(langColor('TypeScript'), '#3178c6');
  assert.equal(langColor('JavaScript'), '#f1e05a');
  assert.equal(langColor('Python'), '#3572A5');
  assert.equal(langColor('C++'), '#f34b7d');
  assert.equal(langColor('C#'), '#178600');
  assert.equal(langColor('Objective-C'), '#438eff');
  assert.equal(langColor('Nix'), '#7e7eff');
});

test('langColor: an UNKNOWN language returns undefined — the caller then draws NO dot', () => {
  assert.equal(langColor('Brainfuck'), undefined);
  assert.equal(langColor('typescript'), undefined, 'lookup is case-sensitive, as GitHub reports it');
  assert.equal(langColor('TypeScript '), undefined, 'no trimming — exact Linguist names only');
});

test('langColor: absent / empty language returns undefined', () => {
  assert.equal(langColor(undefined), undefined);
  assert.equal(langColor(''), undefined);
});

test('langColor: Object.prototype keys are NOT languages — the lookup is own-property only', () => {
  // The table is a plain object literal, so a bare `LANG_COLOR[language]` would
  // resolve inherited members (a Function for `constructor`/`toString`,
  // Object.prototype for `__proto__`) and the caller would then draw a dot with
  // an invalid inline background (an invisible 8px gap — `.gh-lang-dot` has no
  // background fallback). The Object.hasOwn guard in langColor makes every one
  // of these an unknown language, exactly like `Brainfuck`.
  assert.equal(langColor('constructor'), undefined);
  assert.equal(langColor('toString'), undefined);
  assert.equal(langColor('hasOwnProperty'), undefined);
  assert.equal(langColor('__proto__'), undefined);
  assert.equal(langColor('valueOf'), undefined);
});

test('LANG_COLOR: every entry is a 6-digit hex color (inline style safety)', () => {
  const entries = Object.entries(LANG_COLOR);
  assert.equal(entries.length, 28);
  for (const [lang, hex] of entries) {
    assert.match(hex, /^#[0-9a-fA-F]{6}$/, `${lang} -> ${hex} must be a plain hex color`);
  }
});

// ---------------------------------------------------------------------------
// Cadence
// ---------------------------------------------------------------------------

test('pollIntervalMs: paused when idle — closed tab + disconnected/connected/unknown', () => {
  assert.equal(pollIntervalMs(false, null), null);
  assert.equal(pollIntervalMs(false, { deviceFlowAvailable: false, state: 'disconnected' }), null);
  assert.equal(pollIntervalMs(false, { deviceFlowAvailable: true, state: 'disconnected' }), null);
  assert.equal(
    pollIntervalMs(false, { deviceFlowAvailable: true, state: 'connected', login: 'sava' }),
    null,
  );
});

test('pollIntervalMs: fast while the GitHub tab is open, whatever the state', () => {
  assert.equal(pollIntervalMs(true, null), GH_POLL_MS);
  assert.equal(pollIntervalMs(true, { deviceFlowAvailable: false, state: 'disconnected' }), GH_POLL_MS);
  assert.equal(
    pollIntervalMs(true, { deviceFlowAvailable: true, state: 'connected', login: 'sava' }),
    GH_POLL_MS,
  );
});

test('pollIntervalMs: fast while connecting even with the tab closed (the device flow must land)', () => {
  assert.equal(pollIntervalMs(false, { deviceFlowAvailable: true, state: 'connecting' }), GH_POLL_MS);
  assert.equal(pollIntervalMs(true, { deviceFlowAvailable: true, state: 'connecting' }), GH_POLL_MS);
});

test('expiryTickMs: ticks only while active AND device sign-in exists AND connecting', () => {
  assert.equal(expiryTickMs(true, { deviceFlowAvailable: true, state: 'connecting' }), GH_EXPIRY_TICK_MS);
});

test('expiryTickMs: an inactive (hidden) panel never ticks', () => {
  assert.equal(expiryTickMs(false, { deviceFlowAvailable: true, state: 'connecting' }), null);
  assert.equal(expiryTickMs(false, null), null);
});

test('expiryTickMs: no countdown outside the connecting state (no code is on screen)', () => {
  assert.equal(expiryTickMs(true, null), null);
  assert.equal(expiryTickMs(true, { deviceFlowAvailable: true, state: 'disconnected' }), null);
  assert.equal(
    expiryTickMs(true, { deviceFlowAvailable: true, state: 'connected', login: 'sava' }),
    null,
    'a CONNECTED credential shows a coarse expiry line, not a per-second countdown',
  );
  assert.equal(
    expiryTickMs(true, { deviceFlowAvailable: false, state: 'connecting' }),
    null,
    'a server with no OAuth client id can never have a device code on screen',
  );
});

test('cadence constants are the documented values', () => {
  assert.equal(GH_POLL_MS, 2500);
  assert.equal(GH_EXPIRY_TICK_MS, 1000);
  assert.equal(GH_SEARCH_DEBOUNCE_MS, 300);
});
