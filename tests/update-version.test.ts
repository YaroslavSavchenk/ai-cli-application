/**
 * Version comparison for the in-app update check (server/update-release.ts).
 *
 * This is the function that decides whether the app tells the user a newer
 * version exists — and, one button later, downloads and runs an installer. It
 * is pure, so it is table-tested exhaustively here rather than through a
 * server: an off-by-one in the pre-release rules would either hide a real
 * release forever or offer a downgrade.
 *
 * The rules are semver §11 (numeric identifiers compare numerically,
 * alphanumeric lexically, numeric sorts BELOW alphanumeric, a larger set of
 * identifiers wins on a tie, a pre-release sorts below its release) plus two
 * project rules: build metadata is ignored (§10), and anything unparsable on
 * EITHER side means "no update", never a guess.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compareVersions,
  isNewerVersion,
  parseVersion,
  releaseCheckSupported,
} from '../server/update-release.ts';

test('compareVersions: the release ladder this project actually walks', () => {
  const ascending: [string, string][] = [
    ['v0.2.0', 'v0.10.0'], // 10 > 2 numerically, not lexically
    ['v0.2.0', 'v0.2.1'],
    ['v0.2.0', 'v0.3.0'],
    ['v0.9.9', 'v1.0.0'],
    ['v1.0.0', 'v2.0.0'],
    ['v0.3.0-rc.1', 'v0.3.0'], // a pre-release is BELOW its release
    ['v0.3.0-rc.1', 'v0.3.1'],
    ['v0.3.0-rc.1', 'v0.3.0-rc.2'], // numeric identifiers compare numerically
    ['v0.3.0-rc.2', 'v0.3.0-rc.10'],
    ['v0.3.0-alpha', 'v0.3.0-beta'],
    ['v0.3.0-alpha.1', 'v0.3.0-alpha.beta'], // numeric < alphanumeric
    ['v0.3.0-alpha', 'v0.3.0-alpha.1'], // a larger identifier set wins
  ];
  for (const [lo, hi] of ascending) {
    assert.equal(compareVersions(lo, hi), -1, `${lo} must sort below ${hi}`);
    assert.equal(compareVersions(hi, lo), 1, `${hi} must sort above ${lo}`);
    assert.equal(isNewerVersion(hi, lo), true, `${hi} is an update over ${lo}`);
    assert.equal(isNewerVersion(lo, hi), false, `${lo} is NOT an update over ${hi}`);
  }
});

test('compareVersions: equality, the leading v, and build metadata (ignored)', () => {
  assert.equal(compareVersions('v0.2.0', 'v0.2.0'), 0);
  assert.equal(compareVersions('0.2.0', 'v0.2.0'), 0, 'one optional leading v');
  assert.equal(compareVersions('v0.2.0+abc', 'v0.2.0+def'), 0, 'build metadata has no precedence');
  assert.equal(compareVersions('v0.2.0+abc', 'v0.2.0'), 0);
  assert.equal(compareVersions('v0.3.0-rc.1+a', 'v0.3.0-rc.1+b'), 0);
  assert.equal(isNewerVersion('v0.2.0+newbuild', 'v0.2.0'), false, 'a rebuild is never an update');
});

test('compareVersions: anything unparsable on either side is null — never a guess', () => {
  const garbage = [
    '',
    'v',
    'latest',
    'v1',
    'v1.2',
    'v1.2.3.4',
    '1.2.3-',
    '1.2.3-a..b',
    'v01.2.3', // leading zero
    '1.2.3 ',
    ' 1.2.3',
    'vv1.2.3',
    '1.2.3-rc 1',
    '-1.2.3',
    'v1.2.3\n',
    'v1.2.3-rc.1;rm -rf /',
  ];
  for (const bad of garbage) {
    assert.equal(compareVersions(bad, 'v0.2.0'), null, `${JSON.stringify(bad)} is not a version`);
    assert.equal(compareVersions('v0.2.0', bad), null, `${JSON.stringify(bad)} is not a version`);
    assert.equal(isNewerVersion(bad, 'v0.2.0'), false, 'and it can never be an update');
    assert.equal(parseVersion(bad), null);
  }
});

test('parseVersion: the parts, with build metadata discarded', () => {
  assert.deepEqual(parseVersion('v1.2.3'), { major: 1, minor: 2, patch: 3, pre: [] });
  assert.deepEqual(parseVersion('0.0.0-dev+699cd2c'), {
    major: 0,
    minor: 0,
    patch: 0,
    pre: ['dev'],
  });
  assert.deepEqual(parseVersion('v10.20.30-rc.1.2'), {
    major: 10,
    minor: 20,
    patch: 30,
    pre: ['rc', '1', '2'],
  });
});

test('releaseCheckSupported: a 0.0.0* build never asks GitHub anything', () => {
  // scripts/build-bundle.sh stamps `0.0.0-dev+<sha>` on every off-tag build.
  // Such a bundle is older than every real release, so an enabled check would
  // nag a developer's own build with an update it must not install.
  assert.equal(releaseCheckSupported('0.0.0-dev+699cd2c'), false);
  assert.equal(releaseCheckSupported('v0.0.0'), false);
  assert.equal(releaseCheckSupported('0.0.0'), false);
  assert.equal(releaseCheckSupported('v0.0.1'), true);
  assert.equal(releaseCheckSupported('v0.2.0'), true);
  assert.equal(releaseCheckSupported('v1.0.0-rc.1'), true);
  // Unparsable versions cannot be compared, so they cannot be checked either.
  assert.equal(releaseCheckSupported('nightly'), false);
  assert.equal(releaseCheckSupported(''), false);
});
