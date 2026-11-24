/**
 * The app's own OAuth App id (2026-11-24): baked in so "Connect with GitHub"
 * works with no setup; AI_SM_GITHUB_CLIENT_ID overrides it, and set EMPTY
 * turns the device flow off (what every test server does — tests never reach
 * github.com's device endpoints by accident).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_GITHUB_CLIENT_ID, resolveGithubClientId } from '../../server/config.ts';

test('unset: the app\'s own OAuth App id', () => {
  assert.equal(resolveGithubClientId({}), DEFAULT_GITHUB_CLIENT_ID);
  assert.match(DEFAULT_GITHUB_CLIENT_ID, /^Ov23[A-Za-z0-9]{16}$/, 'an OAuth App client id, nothing else');
});

test('set: that id wins, trimmed', () => {
  assert.equal(resolveGithubClientId({ AI_SM_GITHUB_CLIENT_ID: '  Ov23otherAppId00000 ' }), 'Ov23otherAppId00000');
});

test('set empty (or blank): the device flow is off', () => {
  assert.equal(resolveGithubClientId({ AI_SM_GITHUB_CLIENT_ID: '' }), '');
  assert.equal(resolveGithubClientId({ AI_SM_GITHUB_CLIENT_ID: '   ' }), '');
});
