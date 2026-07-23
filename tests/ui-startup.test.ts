/**
 * `web/src/ui/startup.ts` — the auto-run startup-command registry. DOM-free
 * (no xterm, no document), so plain node:test imports it directly. The one
 * guarantee under test: fire EXACTLY ONCE per spawn — arm records a pending
 * line for a session id, consume returns it once and then never again, so a
 * reattach's "first output" can never re-type it and only the arming window
 * ever has it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { armStartupCommand, consumeStartupCommand } from '../web/src/ui/startup.ts';
import { clampLaunchDefaults } from '../web/src/ui/launch-args.ts';

test('arm then consume returns the line exactly once (a second consume is null)', () => {
  armStartupCommand('s1', '/caveman');
  assert.equal(consumeStartupCommand('s1'), '/caveman');
  assert.equal(consumeStartupCommand('s1'), null, 'reattach first-output must not re-type');
});

test('consume of an un-armed session is null (adopted-elsewhere sessions never retro-run)', () => {
  assert.equal(consumeStartupCommand('never-armed'), null);
});

test('a blank / whitespace-only command never arms (empty = off)', () => {
  armStartupCommand('s2', '');
  armStartupCommand('s2', '   \t ');
  assert.equal(consumeStartupCommand('s2'), null);
});

test('the raw line (incl. leading slash and inner spaces) is preserved verbatim', () => {
  armStartupCommand('s3', '/model opus');
  assert.equal(consumeStartupCommand('s3'), '/model opus');
});

test('sessions are independent — arming one does not affect another', () => {
  armStartupCommand('a', '/one');
  armStartupCommand('b', '/two');
  assert.equal(consumeStartupCommand('b'), '/two');
  assert.equal(consumeStartupCommand('a'), '/one');
});

test('re-arming the same id before consume overwrites (last spawn wins)', () => {
  armStartupCommand('r', '/first');
  armStartupCommand('r', '/second');
  assert.equal(consumeStartupCommand('r'), '/second');
});

// The registry stays a dumb verbatim carrier (see the verbatim test above); the
// single-line guarantee is enforced UPSTREAM, at the persisted-bag boundary. A
// line with embedded control characters (\r / \n) would otherwise be sent as
// `line + '\r'` to the PTY (web/src/ui/terminal.ts:269) and \r would submit
// intermediate lines into the new session. The prefs.json path is
// clampLaunchDefaults -> getDefaults -> armStartupCommand, and clampLaunchDefaults
// now strips control chars, so the real path can no longer smuggle an extra line.
test('the persisted path strips control chars before arming — clamp -> arm -> consume yields one clean line', () => {
  const injected = '/foo\rrm -rf ~\n/bar';
  const clean = clampLaunchDefaults({ startupCommand: injected }).startupCommand ?? '';
  armStartupCommand('cc', clean);
  assert.equal(consumeStartupCommand('cc'), '/foorm -rf ~/bar', 'no control chars reach the PTY path');
});
