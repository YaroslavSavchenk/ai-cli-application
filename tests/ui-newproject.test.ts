/**
 * `web/src/ui/newproject-model.ts` — the pure path/url helpers behind the New
 * Project dialog + folder picker. DOM-free, so `node --test` imports them
 * directly. These feed the auto-suggested project/clone paths, the picker
 * breadcrumb, and the "up one level" control; the real fs endpoints do the
 * rest.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  joinPath,
  parentDir,
  repoBasename,
  suggestProjectPath,
  suggestDestPath,
  breadcrumbs,
} from '../web/src/ui/newproject-model.ts';

test('joinPath appends a segment onto an absolute dir; root has no double slash', () => {
  assert.equal(joinPath('/home/sava', 'projects'), '/home/sava/projects');
  assert.equal(joinPath('/home/sava/', 'projects'), '/home/sava/projects');
  assert.equal(joinPath('/', 'home'), '/home');
});

test('parentDir walks up one level; / is its own parent', () => {
  assert.equal(parentDir('/home/sava/projects'), '/home/sava');
  assert.equal(parentDir('/home/sava/projects/'), '/home/sava');
  assert.equal(parentDir('/home'), '/');
  assert.equal(parentDir('/'), '/');
  assert.equal(parentDir(''), '/');
});

test('repoBasename strips .git + trailing slashes across url shapes', () => {
  assert.equal(repoBasename('https://github.com/owner/repo.git'), 'repo');
  assert.equal(repoBasename('https://github.com/owner/repo'), 'repo');
  assert.equal(repoBasename('https://github.com/owner/repo/'), 'repo');
  assert.equal(repoBasename('git@github.com:owner/repo.git'), 'repo');
  assert.equal(repoBasename('git@github.com:repo.git'), 'repo');
  assert.equal(repoBasename('ssh://git@host/owner/My-Repo.GIT'), 'My-Repo');
  assert.equal(repoBasename('  https://x/y/z.git  '), 'z');
  assert.equal(repoBasename(''), 'repo');
});

test('suggestProjectPath = <home>/projects/<name>; empty when home or name missing', () => {
  assert.equal(suggestProjectPath('/home/sava', 'my-app'), '/home/sava/projects/my-app');
  assert.equal(suggestProjectPath('/home/sava', '  spaced  '), '/home/sava/projects/spaced');
  assert.equal(suggestProjectPath(null, 'my-app'), '');
  assert.equal(suggestProjectPath('/home/sava', '   '), '');
});

test('suggestDestPath = <home>/projects/<repoBasename(url)>; empty when home or url missing', () => {
  assert.equal(
    suggestDestPath('/home/sava', 'https://github.com/owner/repo.git'),
    '/home/sava/projects/repo',
  );
  assert.equal(suggestDestPath('/home/sava', ''), '');
  assert.equal(suggestDestPath(null, 'https://x/y.git'), '');
});

test('breadcrumbs yields root-first cumulative segments', () => {
  assert.deepEqual(breadcrumbs('/'), [{ label: '/', path: '/' }]);
  assert.deepEqual(breadcrumbs('/home/sava/projects'), [
    { label: '/', path: '/' },
    { label: 'home', path: '/home' },
    { label: 'sava', path: '/home/sava' },
    { label: 'projects', path: '/home/sava/projects' },
  ]);
});
