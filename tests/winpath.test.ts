/**
 * windowsPathFor / planCmdStart: the pure WSL -> Windows path mapping behind
 * the Command Prompt card (Nocturne B5).
 *
 * The table is the contract `cmd.exe /k pushd <path>` depends on, and the
 * refusals are a security boundary: cmd parses its own command line, so a cwd
 * carrying a space, a quote or a shell metacharacter is never mapped — the
 * session then opens plain, in the Windows default directory.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isDistroName,
  isSafeWslPath,
  planCmdStart,
  windowsPathFor,
  windowsPathForClipboard,
} from '../server/winpath.ts';
import type { FsWinPathResponse, Project } from '../shared/protocol.ts';
import { api, startTestServer, type TestServer } from './helpers.ts';

const DISTRO = 'Ubuntu-24.04';

test('windowsPathFor maps /mnt/<drive> to a drive letter and everything else to \\\\wsl.localhost', () => {
  const table: ReadonlyArray<readonly [string, string]> = [
    ['/mnt/c', 'C:\\'],
    ['/mnt/c/Users/x', 'C:\\Users\\x'],
    ['/mnt/d/projects/a-b.c', 'D:\\projects\\a-b.c'],
    // Upper-case drive letters are normalized; Windows drives are letters only.
    ['/mnt/C/Users', 'C:\\Users'],
    // A multi-character second segment under /mnt is NOT a drive.
    ['/mnt/wsl/instance', '\\\\wsl.localhost\\Ubuntu-24.04\\mnt\\wsl\\instance'],
    // A single-letter second segment is a drive ONLY under /mnt: `/home/y/z`
    // is a real WSL path, not drive `Y:`.
    ['/home/y/z', '\\\\wsl.localhost\\Ubuntu-24.04\\home\\y\\z'],
    ['/c/Users', '\\\\wsl.localhost\\Ubuntu-24.04\\c\\Users'],
    ['/home/you/projects/a-b.c', '\\\\wsl.localhost\\Ubuntu-24.04\\home\\you\\projects\\a-b.c'],
    ['/home', '\\\\wsl.localhost\\Ubuntu-24.04\\home'],
    ['/tmp/ai-sm-test-1234/work', '\\\\wsl.localhost\\Ubuntu-24.04\\tmp\\ai-sm-test-1234\\work'],
  ];
  for (const [cwd, expected] of table) {
    assert.equal(windowsPathFor(cwd, DISTRO), expected, `mapping of ${cwd}`);
  }
});

test('windowsPathFor refuses every path shape cmd.exe could reinterpret', () => {
  const refused: readonly string[] = [
    '/home/you/my projects', // a space is an argument separator to cmd
    '/home/you/a&b', // & chains commands
    '/home/you/a|b',
    '/home/you/a^b',
    '/home/you/a%PATH%b',
    '/home/you/a"b',
    '/home/you/a<b',
    '/home/you/a>b',
    '/home/you/../etc', // traversal: the mapped path must be the folder itself
    '/home/you/.',
    '/..',
    '/home/you//double',
    '/home/you/', // trailing slash -> empty segment
    'home/you', // not absolute
    '/', // no segment at all
    '',
    '/home/you/\u00e9', // outside the ASCII segment charset
    '/home/you/a\nb',
  ];
  for (const cwd of refused) {
    assert.equal(windowsPathFor(cwd, DISTRO), undefined, `${JSON.stringify(cwd)} must be refused`);
    assert.equal(isSafeWslPath(cwd), false, `${JSON.stringify(cwd)} must not be a safe path`);
    assert.deepEqual(planCmdStart(cwd, DISTRO), { ok: false, reason: 'path shape' });
  }
});

test('a missing or malformed WSL_DISTRO_NAME refuses the mapping (no distro)', () => {
  // `.` and `..` are made of the allowed characters but are DOT SEGMENTS of
  // `\\wsl.localhost\<distro>\…`: `..` would walk the UNC path up instead of
  // naming a distro. Same rule as the cwd's segments.
  for (const distro of [undefined, '', 'Ubuntu 24.04', 'a\\b', 'a/b', '..\\..', 'a"b', '.', '..']) {
    assert.equal(isDistroName(distro), false, `${JSON.stringify(distro)} is not a distro name`);
    assert.equal(windowsPathFor('/home/you/projects', distro), undefined);
    assert.deepEqual(planCmdStart('/home/you/projects', distro), { ok: false, reason: 'no distro' });
  }
  // Even the drive-letter branch, which does not use the distro, stays refused:
  // one rule, no second path through the gate.
  assert.equal(windowsPathFor('/mnt/c/Users', undefined), undefined);
  assert.deepEqual(planCmdStart('/mnt/c/Users', undefined), { ok: false, reason: 'no distro' });
});

test('planCmdStart composes exactly /k pushd <windows path>', () => {
  assert.deepEqual(planCmdStart('/home/you/projects/app', DISTRO), {
    ok: true,
    args: ['/k', 'pushd', '\\\\wsl.localhost\\Ubuntu-24.04\\home\\you\\projects\\app'],
    winPath: '\\\\wsl.localhost\\Ubuntu-24.04\\home\\you\\projects\\app',
  });
  assert.deepEqual(planCmdStart('/mnt/c', DISTRO), {
    ok: true,
    args: ['/k', 'pushd', 'C:\\'],
    winPath: 'C:\\',
  });
});

// ---------------------------------------------------------------------------
// windowsPathForClipboard + GET /api/fs/winpath (Nocturne B10 phase 1)
//
// A SECOND, WIDER vocabulary than the cmd.exe one above, and the tests pin the
// difference from both sides: a path with a space is refused for `cmd /k pushd`
// (cmd parses its own command line) and accepted for the clipboard (nothing
// parses a clipboard path).
// ---------------------------------------------------------------------------

test('windowsPathForClipboard maps drives, UNC paths, spaces, Unicode, parentheses and &', () => {
  const table: ReadonlyArray<readonly [string, string]> = [
    ['/mnt/c', 'C:\\'],
    ['/mnt/c/Users/x', 'C:\\Users\\x'],
    ['/mnt/c/Users/My Documents/report (2).md', 'C:\\Users\\My Documents\\report (2).md'],
    ['/mnt/D/data', 'D:\\data'],
    // A multi-character second segment under /mnt is NOT a drive.
    ['/mnt/wsl/instance', '\\\\wsl.localhost\\Ubuntu-24.04\\mnt\\wsl\\instance'],
    ['/home', '\\\\wsl.localhost\\Ubuntu-24.04\\home'],
    ['/home/you/projects/app', '\\\\wsl.localhost\\Ubuntu-24.04\\home\\you\\projects\\app'],
    ['/home/you/my notes.md', '\\\\wsl.localhost\\Ubuntu-24.04\\home\\you\\my notes.md'],
    ['/home/you/rapport & co', '\\\\wsl.localhost\\Ubuntu-24.04\\home\\you\\rapport & co'],
    ['/home/you/héllo wörld', '\\\\wsl.localhost\\Ubuntu-24.04\\home\\you\\héllo wörld'],
    ['/home/you/日本語/ファイル.txt', '\\\\wsl.localhost\\Ubuntu-24.04\\home\\you\\日本語\\ファイル.txt'],
    ["/home/you/o'brien #1 [draft]", "\\\\wsl.localhost\\Ubuntu-24.04\\home\\you\\o'brien #1 [draft]"],
  ];
  for (const [path, expected] of table) {
    assert.equal(windowsPathForClipboard(path, DISTRO), expected, `mapping of ${path}`);
  }
});

test('windowsPathForClipboard is WIDER than the cmd.exe shape, on purpose', () => {
  // The same path: refused for a command line, mapped for the clipboard.
  for (const path of ['/home/you/my notes', '/home/you/a&b', '/home/you/héllo']) {
    assert.equal(windowsPathFor(path, DISTRO), undefined, `${path} is not a cmd cwd`);
    assert.ok(windowsPathForClipboard(path, DISTRO) !== undefined, `${path} IS a clipboard path`);
  }
});

test('windowsPathForClipboard refuses what Windows cannot name in a path segment', () => {
  const refused: readonly string[] = [
    '/home/you/a:b', // the drive separator
    '/home/you/a*b',
    '/home/you/a?b',
    '/home/you/a"b',
    '/home/you/a<b',
    '/home/you/a>b',
    '/home/you/a|b',
    '/home/you/a\\b', // a backslash IS a separator on Windows
    '/home/you/..', // a traversal, not the folder that was copied
    '/home/you/.',
    '/../etc',
    '/home/you/a\nb', // control characters
    '/home/you/a\tb',
    '/home/you/a\u0000b',
    '/home/you/a\u007fb',
    '/home/you/trailing.', // Windows trims a trailing dot: it would land elsewhere
    '/home/you/trailing ', // and a trailing space
    '/home/you/', // a trailing slash is an empty segment
    '/home/you//double',
    '/', // no segment at all
    '',
    'home/you', // not absolute
    'C:\\Users', // already a Windows path
  ];
  for (const path of refused) {
    assert.equal(
      windowsPathForClipboard(path, DISTRO),
      undefined,
      `${JSON.stringify(path)} must be refused`,
    );
  }
});

test('the distro is needed for a UNC path only — a /mnt/<drive> path maps without one', () => {
  for (const distro of [undefined, '', 'Ubuntu 24.04', 'a\\b', 'a/b', '.', '..']) {
    assert.equal(windowsPathForClipboard('/home/you/projects', distro), undefined);
    assert.equal(
      windowsPathForClipboard('/mnt/c/Users/x', distro),
      'C:\\Users\\x',
      'the drive branch never needed the distro',
    );
  }
});

// ---------------------------------------------------------------------------
// The route: GET /api/fs/winpath?path=<abs> -> { windowsPath }
//
// TWO real server children on ONE fixture home: one with a WSL_DISTRO_NAME, one
// without — the distro comes from the SERVER's environment, never from the
// client, and the difference between "no distro" and "a /mnt drive" is the
// whole reason the clipboard mapper has two branches.
// ---------------------------------------------------------------------------

let server: TestServer;
let noDistro: TestServer;
let root: string;
let home: string;
/** A folder OUTSIDE the fixture home. */
let outside: string;

const winFor = (path: string): string => `\\\\wsl.localhost\\${DISTRO}${path.replace(/\//g, '\\')}`;

before(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'ai-sm-winpath-')));
  home = join(root, 'home');
  outside = join(root, 'outside');
  await mkdir(join(home, 'work'), { recursive: true });
  await mkdir(outside);
  await writeFile(join(home, 'work', 'notes.txt'), 'x');
  await writeFile(join(home, 'work', 'weird:name.txt'), 'x'); // legal on Linux, not on Windows
  await writeFile(join(outside, 'out.txt'), 'x');
  server = await startTestServer({
    dataDir: join(home, '.ai-session-manager'),
    env: { AI_SM_HOME_OVERRIDE: home, WSL_DISTRO_NAME: DISTRO },
  });
  noDistro = await startTestServer({
    dataDir: join(root, 'data-no-distro'),
    env: { AI_SM_HOME_OVERRIDE: home, WSL_DISTRO_NAME: '' },
  });
});

after(async () => {
  if (server !== undefined) await server.stop();
  if (noDistro !== undefined) await noDistro.stop();
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

const winpath = (target: TestServer, path: string): Promise<{ status: number; body: unknown }> =>
  api(target, 'GET', `/api/fs/winpath?path=${encodeURIComponent(path)}`);

test('GET /api/fs/winpath maps a file and a folder inside the boundary', async () => {
  const file = await winpath(server, join(home, 'work', 'notes.txt'));
  assert.equal(file.status, 200, JSON.stringify(file.body));
  assert.deepEqual(file.body, {
    windowsPath: winFor(join(home, 'work', 'notes.txt')),
  } satisfies FsWinPathResponse);

  const folder = await winpath(server, join(home, 'work'));
  assert.equal(folder.status, 200);
  assert.deepEqual(folder.body, { windowsPath: winFor(join(home, 'work')) });
});

test('a path outside home and every project is 403 — only what is yours reaches the clipboard', async () => {
  const res = await winpath(server, join(outside, 'out.txt'));
  assert.equal(res.status, 403, JSON.stringify(res.body));
  assert.deepEqual(res.body, { error: 'This folder is outside your home folder.' });

  const created = await api(server, 'POST', '/api/projects', { name: 'Outside', path: outside });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const project = created.body as Project;
  try {
    const now = await winpath(server, join(outside, 'out.txt'));
    assert.equal(now.status, 200, 'a registered project is an anchor here too');
    assert.deepEqual(now.body, { windowsPath: winFor(join(outside, 'out.txt')) });
  } finally {
    assert.equal((await api(server, 'DELETE', `/api/projects/${project.id}`)).status, 200);
  }
});

test('a name Windows cannot carry is 422, and a missing/gone/bad path is 400 or 404', async () => {
  const weird = await winpath(server, join(home, 'work', 'weird:name.txt'));
  assert.equal(weird.status, 422, JSON.stringify(weird.body));
  assert.deepEqual(weird.body, { error: 'That file cannot be reached from Windows.' });

  assert.equal((await api(server, 'GET', '/api/fs/winpath')).status, 400);
  assert.deepEqual((await api(server, 'GET', '/api/fs/winpath')).body, {
    error: 'The app cannot open that folder.',
  });
  assert.equal((await winpath(server, join(home, 'work', 'nope.txt'))).status, 404);
  assert.equal((await winpath(server, 'relative/path')).status, 400);
  assert.equal((await winpath(server, `${home}\0/work`)).status, 400);
  assert.equal((await api(server, 'POST', '/api/fs/winpath', {})).status, 405);
});

test('with no WSL_DISTRO_NAME a home path is 422 — but a /mnt/<drive> path still maps', async () => {
  const res = await winpath(noDistro, join(home, 'work', 'notes.txt'));
  assert.equal(res.status, 422, JSON.stringify(res.body));
  assert.deepEqual(res.body, { error: 'That file cannot be reached from Windows.' });

  // The drive branch needs no distro. It needs an anchor, so /mnt/c/Users is
  // registered as a project for the length of this test — nothing is written
  // there, and the registration lives in this server's temp data dir.
  if (!existsSync('/mnt/c/Users')) return;
  const created = await api(noDistro, 'POST', '/api/projects', {
    name: 'Windows C',
    path: '/mnt/c/Users',
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const project = created.body as Project;
  try {
    const drive = await winpath(noDistro, '/mnt/c/Users');
    assert.equal(drive.status, 200, JSON.stringify(drive.body));
    assert.deepEqual(drive.body, { windowsPath: 'C:\\Users' });
  } finally {
    assert.equal((await api(noDistro, 'DELETE', `/api/projects/${project.id}`)).status, 200);
  }
});
