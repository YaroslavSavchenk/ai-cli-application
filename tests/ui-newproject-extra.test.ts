/**
 * Test-engineer additions for web/src/ui/newproject-model.ts, complementing
 * tests/ui-newproject.test.ts (which covers the common repoBasename/join/
 * parent/breadcrumbs/suggest shapes). Here are the doc-claimed edge branches
 * that file leaves unproven: repoBasename's "no path" / scp-empty-path /
 * whitespace-only fallbacks, and join/parent/breadcrumbs under repeated or
 * trailing slashes. Pure functions — DOM-free, no server.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  joinPath,
  parentDir,
  repoBasename,
  breadcrumbs,
} from '../web/src/ui/newproject-model.ts';

test('repoBasename: host-only url, scp-empty-path, and whitespace-only fall back sensibly', () => {
  assert.equal(repoBasename('https://github.com'), 'github.com', 'no path segment -> host is the last segment');
  assert.equal(repoBasename('git@github.com:'), 'repo', 'scp with empty path -> "repo" fallback');
  assert.equal(repoBasename('   '), 'repo', 'whitespace-only -> "repo" fallback');
});

test('joinPath / parentDir / breadcrumbs tolerate repeated and trailing slashes', () => {
  assert.equal(joinPath('/home//', 'x'), '/home/x', 'repeated trailing slashes are trimmed before joining');
  assert.equal(parentDir('/home//'), '/', 'a single-level path with trailing slashes -> root');
  assert.deepEqual(
    breadcrumbs('/home/sava/'),
    [
      { label: '/', path: '/' },
      { label: 'home', path: '/home' },
      { label: 'sava', path: '/home/sava' },
    ],
    'a trailing slash yields no empty final crumb',
  );
});
