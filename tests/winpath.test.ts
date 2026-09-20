/**
 * windowsPathFor / planCmdStart: the pure WSL -> Windows path mapping behind
 * the Command Prompt card (Nocturne B5).
 *
 * The table is the contract `cmd.exe /k pushd <path>` depends on, and the
 * refusals are a security boundary: cmd parses its own command line, so a cwd
 * carrying a space, a quote or a shell metacharacter is never mapped — the
 * session then opens plain, in the Windows default directory.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isDistroName,
  isSafeWslPath,
  planCmdStart,
  windowsPathFor,
} from '../server/winpath.ts';

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
