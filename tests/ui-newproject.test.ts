/**
 * `web/src/ui/newproject-model.ts` — the pure path/url helpers behind the New
 * Project dialog + folder picker. DOM-free, so `node --test` imports them
 * directly. These feed the auto-suggested project/clone paths, the picker
 * breadcrumb, and the "up one level" control; the real fs endpoints do the
 * rest.
 *
 * 2026-09-10 added the New-folder tab's create-vs-add decision
 * (`probeFromList` -> `blankIntent`) and the name an ADDED folder gets
 * (`addedProjectName`, `baseName`). The same chain is driven end to end
 * against a real backend and real temp dirs in tests/projects.test.ts; here it
 * is the pure mapping, every outcome of GET /api/fs/list included.
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
  addedProjectName,
  baseName,
  blankIntent,
  probeFromList,
} from '../web/src/ui/newproject-model.ts';
import type { FolderProbe } from '../web/src/ui/newproject-model.ts';
import type { FsListResponse } from '../shared/protocol.ts';

test('joinPath appends a segment onto an absolute dir; root has no double slash', () => {
  assert.equal(joinPath('/home/you', 'projects'), '/home/you/projects');
  assert.equal(joinPath('/home/you/', 'projects'), '/home/you/projects');
  assert.equal(joinPath('/', 'home'), '/home');
});

test('parentDir walks up one level; / is its own parent', () => {
  assert.equal(parentDir('/home/you/projects'), '/home/you');
  assert.equal(parentDir('/home/you/projects/'), '/home/you');
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
  assert.equal(suggestProjectPath('/home/you', 'my-app'), '/home/you/projects/my-app');
  assert.equal(suggestProjectPath('/home/you', '  spaced  '), '/home/you/projects/spaced');
  assert.equal(suggestProjectPath(null, 'my-app'), '');
  assert.equal(suggestProjectPath('/home/you', '   '), '');
});

test('suggestDestPath = <home>/projects/<repoBasename(url)>; empty when home or url missing', () => {
  assert.equal(
    suggestDestPath('/home/you', 'https://github.com/owner/repo.git'),
    '/home/you/projects/repo',
  );
  assert.equal(suggestDestPath('/home/you', ''), '');
  assert.equal(suggestDestPath(null, 'https://x/y.git'), '');
});

test('breadcrumbs yields root-first cumulative segments', () => {
  assert.deepEqual(breadcrumbs('/'), [{ label: '/', path: '/' }]);
  assert.deepEqual(breadcrumbs('/home/you/projects'), [
    { label: '/', path: '/' },
    { label: 'home', path: '/home' },
    { label: 'you', path: '/home/you' },
    { label: 'projects', path: '/home/you/projects' },
  ]);
});

// ---------------------------------------------------------------------------
// New-folder tab: create vs add (2026-09-10)
// ---------------------------------------------------------------------------

/** A 200 body shaped exactly like the backend's fs/list answer. */
const listed = (path: string, dirs: string[], empty: boolean): FsListResponse => ({ path, dirs, empty });

test('probe -> intent: the nine outcomes of GET /api/fs/list the dialog can meet', () => {
  // [label, body-or-null, status, expected probe, expected intent]
  const cases: [string, FsListResponse | null, number | null, FolderProbe, 'create' | 'add'][] = [
    ['empty folder', listed('/w/empty', [], true), 200, 'empty', 'create'],
    ['a file only', listed('/w/file-only', [], false), 200, 'nonEmpty', 'add'],
    ['a hidden file only', listed('/w/hidden-only', [], false), 200, 'nonEmpty', 'add'],
    ['a broken symlink only', listed('/w/broken-link', [], false), 200, 'nonEmpty', 'add'],
    ['a subdir only', listed('/w/subdir-only', ['src'], false), 200, 'nonEmpty', 'add'],
    ['404 (missing / not a directory)', null, 404, 'missing', 'create'],
    ['403 (may not be read)', null, 403, 'unknown', 'create'],
    ['network error (no status)', null, null, 'unknown', 'create'],
    [
      '200 from an older backend without `empty`',
      { path: '/w/old', dirs: ['src'] } as unknown as FsListResponse,
      200,
      'unknown',
      'create',
    ],
  ];
  assert.equal(cases.length, 9);
  for (const [label, body, status, probe, intent] of cases) {
    assert.equal(probeFromList(body, status), probe, `${label}: probe`);
    assert.equal(blankIntent(probeFromList(body, status)), intent, `${label}: intent`);
  }
});

test('probeFromList: `empty` must be a real boolean; anything else, and any other status, is unknown', () => {
  const shape = (empty: unknown): FsListResponse => ({ path: '/w', dirs: [], empty }) as unknown as FsListResponse;
  for (const empty of ['false', 'true', 0, 1, null, undefined, {}]) {
    assert.equal(probeFromList(shape(empty), 200), 'unknown', `empty: ${JSON.stringify(empty)}`);
  }
  // A 200 with no parsed body at all.
  assert.equal(probeFromList(null, 200), 'unknown');
  // A body is only believed on 200 — a stale body beside a failure status is not a verdict.
  for (const status of [201, 204, 400, 401, 409, 500, 503]) {
    assert.equal(probeFromList(listed('/w', [], false), status), 'unknown', `HTTP ${status}`);
  }
  // 404 is "missing" whatever body rides along.
  assert.equal(probeFromList(listed('/w', [], false), 404), 'missing');
});

test('blankIntent: ONLY a non-empty folder is added — missing, empty and unknown all stay on create', () => {
  const all: FolderProbe[] = ['missing', 'empty', 'nonEmpty', 'unknown'];
  assert.deepEqual(
    all.filter((p) => blankIntent(p) === 'add'),
    ['nonEmpty'],
  );
  assert.deepEqual(
    all.map((p) => blankIntent(p)),
    ['create', 'create', 'add', 'create'],
  );
});

test('addedProjectName: what the user typed wins (trimmed); blank or whitespace -> the folder basename', () => {
  assert.equal(addedProjectName('My API', '/home/you/projects/api'), 'My API');
  assert.equal(addedProjectName('  My API  ', '/home/you/projects/api'), 'My API');
  assert.equal(addedProjectName('', '/home/you/projects/api'), 'api');
  assert.equal(addedProjectName('   ', '/home/you/projects/api'), 'api');
  assert.equal(addedProjectName('\t\n', '/home/you/projects/api/'), 'api');
  // Never a path: only the last segment.
  assert.equal(addedProjectName('', '/a/b/c').includes('/'), false);
  // The root has no basename — the dialog then asks for a name.
  assert.equal(addedProjectName('', '/'), '');
});

test('baseName: last segment of an absolute path; trailing slashes ignored; `/` and "" have none', () => {
  assert.equal(baseName('/a/b'), 'b');
  assert.equal(baseName('/a/b/'), 'b');
  assert.equal(baseName('/a/b//'), 'b');
  assert.equal(baseName('/a'), 'a');
  assert.equal(baseName('/'), '');
  assert.equal(baseName('//'), '');
  assert.equal(baseName(''), '');
});
