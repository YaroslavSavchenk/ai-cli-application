/**
 * Projects CRUD + persistence, project-based session cwd, and fs browsing
 * (dirs only, absolute paths only, $HOME default).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FsListResponse, Project } from '../shared/protocol.ts';
import { blankIntent, probeFromList } from '../web/src/ui/newproject-model.ts';
import {
  api,
  createSession,
  startTestServer,
  wsUrl,
  WsClient,
  type TestServer,
} from './helpers.ts';

let server: TestServer;
let workDir: string;

before(async () => {
  server = await startTestServer();
  workDir = await realpath(await mkdtemp(join(tmpdir(), 'ai-sm-proj-')));
  await mkdir(join(workDir, 'b_dir'));
  await mkdir(join(workDir, 'a_dir'));
  await writeFile(join(workDir, 'plain.txt'), 'not a directory\n');
  await symlink(join(workDir, 'a_dir'), join(workDir, 'z_link'));
  await symlink(join(workDir, 'missing-target'), join(workDir, 'broken_link'));
});

after(async () => {
  if (server !== undefined) await server.stop();
  if (workDir !== undefined) await rm(workDir, { recursive: true, force: true });
});

test('defaultMode `standard` is still ACCEPTED and round-trips — the UI dropped the option, the schema did not', async () => {
  // BACKWARD-COMPAT PIN. The New Project dialog stopped OFFERING `standard`
  // (2026-07-25: it is behaviourally identical to "no default", so showing it
  // promised a choice it does not make), with the explicit promise that the
  // stored value is untouched. Nothing enforced that promise: projects.json
  // files written before the change carry `standard`, and shared/protocol.ts
  // still declares PermissionMode = 'standard' | 'skip-permissions'.
  const created = await api(server, 'POST', '/api/projects', {
    name: 'Legacy standard',
    path: workDir,
    defaultMode: 'standard',
  });
  assert.equal(created.status, 201, `create failed: ${JSON.stringify(created.body)}`);
  const project = created.body as Project;
  assert.equal(project.defaultMode, 'standard', 'stored verbatim, not coerced or dropped');

  const listed = (await api(server, 'GET', '/api/projects')).body as Project[];
  assert.equal(listed.find((p) => p.id === project.id)?.defaultMode, 'standard', 'and read back');

  // Still exactly two accepted values — this pin must not become "anything goes".
  const bogus = await api(server, 'POST', '/api/projects', {
    name: 'Bogus mode',
    path: workDir,
    defaultMode: 'always-ask',
  });
  assert.equal(bogus.status, 400, 'an unknown mode is still refused');

  // 200, matching the CRUD test below — this fixture must not leak into it.
  assert.equal((await api(server, 'DELETE', `/api/projects/${project.id}`)).status, 200);
});

test('projects CRUD: create, list, persist to projects.json (0600), delete', async () => {
  const empty = await api(server, 'GET', '/api/projects');
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body, []);

  const created = await api(server, 'POST', '/api/projects', {
    name: 'Alpha',
    path: workDir,
    defaultModel: 'test-model',
    defaultMode: 'skip-permissions',
  });
  assert.equal(created.status, 201, `create failed: ${JSON.stringify(created.body)}`);
  const project = created.body as Project;
  assert.equal(project.name, 'Alpha');
  assert.equal(project.path, workDir);
  assert.equal(project.defaultModel, 'test-model');
  assert.equal(project.defaultMode, 'skip-permissions');
  assert.ok(project.id.length > 0);
  assert.equal(new Date(project.createdAt).toISOString(), project.createdAt);

  const listed = await api(server, 'GET', '/api/projects');
  assert.deepEqual(listed.body, [project], 'created project must be listed');

  const file = join(server.dataDir, 'projects.json');
  const fileStat = await stat(file);
  assert.equal(fileStat.mode & 0o777, 0o600, 'projects.json must be mode 0600');
  const onDisk = JSON.parse(await readFile(file, 'utf8')) as Project[];
  assert.deepEqual(onDisk, [project], 'projects.json must persist the project');

  const del = await api(server, 'DELETE', `/api/projects/${project.id}`);
  assert.equal(del.status, 200);
  assert.deepEqual(del.body, { ok: true });

  const afterDel = await api(server, 'GET', '/api/projects');
  assert.deepEqual(afterDel.body, []);
  const onDiskAfter = JSON.parse(await readFile(file, 'utf8')) as Project[];
  assert.deepEqual(onDiskAfter, [], 'deletion must persist to projects.json');

  const again = await api(server, 'DELETE', `/api/projects/${project.id}`);
  assert.equal(again.status, 404, 'deleting a deleted project must be 404');
});

test('POST /api/projects rejects non-directories, relative paths and bad fields', async () => {
  const cases: Record<string, unknown>[] = [
    { name: 'X', path: join(workDir, 'does-not-exist') }, // nonexistent
    { name: 'X', path: join(workDir, 'plain.txt') }, // a file, not a directory
    { name: 'X', path: 'relative/path' }, // not absolute
    { path: workDir }, // missing name
    { name: '   ', path: workDir }, // blank name
    { name: 'X', path: workDir, defaultMode: 'yolo' }, // invalid mode
  ];
  for (const body of cases) {
    const res = await api(server, 'POST', '/api/projects', body);
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}, got ${res.status}`);
  }
  const listed = await api(server, 'GET', '/api/projects');
  assert.deepEqual(listed.body, [], 'rejected bodies must not create projects');
});

test('a session created via projectId runs in the project directory', async () => {
  const created = await api(server, 'POST', '/api/projects', { name: 'Beta', path: workDir });
  assert.equal(created.status, 201);
  const project = created.body as Project;

  const info = await createSession(server, {
    projectId: project.id,
    command: 'bash',
    args: ['-c', 'pwd'],
    cols: 80,
    rows: 24,
  });
  assert.equal(info.cwd, workDir, "session cwd must default to the project's path");
  assert.equal(info.projectId, project.id);

  const c = await WsClient.connect(wsUrl(server, info.id));
  await c.waitForOutput(workDir); // `pwd` output proves the PTY really ran there
  await c.close();

  await api(server, 'DELETE', `/api/sessions/${info.id}`);
  await api(server, 'DELETE', `/api/projects/${project.id}`);
});

test('fs/list returns only directories (including symlinked dirs), sorted', async () => {
  const res = await api(server, 'GET', `/api/fs/list?path=${encodeURIComponent(workDir)}`);
  assert.equal(res.status, 200);
  // plain.txt and the broken symlink must be absent; z_link (symlink to a dir) present.
  // `empty` (2026-09-10) is false: the folder holds entries, whatever their type.
  assert.deepEqual(res.body, { path: workDir, dirs: ['a_dir', 'b_dir', 'z_link'], empty: false });
});

test('fs/list rejects relative paths, 404s on missing/non-dirs, defaults to $HOME', async () => {
  const rel = await api(server, 'GET', `/api/fs/list?path=${encodeURIComponent('relative/path')}`);
  assert.equal(rel.status, 400, 'relative path must be 400');

  const missing = await api(
    server,
    'GET',
    `/api/fs/list?path=${encodeURIComponent(join(workDir, 'no-such-dir'))}`,
  );
  assert.equal(missing.status, 404, 'nonexistent path must be 404');

  const file = await api(
    server,
    'GET',
    `/api/fs/list?path=${encodeURIComponent(join(workDir, 'plain.txt'))}`,
  );
  assert.equal(file.status, 404, 'listing a file must be 404');

  const home = await api(server, 'GET', '/api/fs/list');
  assert.equal(home.status, 200);
  const body = home.body as FsListResponse;
  assert.equal(body.path, homedir(), 'omitted path must default to $HOME');
  assert.ok(Array.isArray(body.dirs));
});

// ---------------------------------------------------------------------------
// fs/list `empty` (2026-09-10) — the flag the New Project dialog uses to pick
// "create" vs "add this folder". Its promise, stated in server/fsbrowse.ts: it
// is the SAME test create's assertVacant applies, so `empty: true` means
// "create would accept this folder". Each fixture below is a real directory,
// fed end to end: the real fs/list answer -> probeFromList -> blankIntent, and
// then the real POST the dialog would send for that intent.
// ---------------------------------------------------------------------------

/** Fixture dirs under a private temp root, one per kind of content. */
async function emptyFlagFixtures(): Promise<{ root: string; dirs: Record<string, string> }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-sm-empty-')));
  const dirs = {
    empty: join(root, 'empty'),
    fileOnly: join(root, 'file-only'),
    hiddenOnly: join(root, 'hidden-only'),
    brokenLinkOnly: join(root, 'broken-link-only'),
    subdirOnly: join(root, 'subdir-only'),
  };
  for (const d of Object.values(dirs)) await mkdir(d);
  await writeFile(join(dirs.fileOnly, 'notes.txt'), 'x\n');
  await writeFile(join(dirs.hiddenOnly, '.env'), 'x\n');
  await symlink(join(root, 'no-such-target'), join(dirs.brokenLinkOnly, 'dangling'));
  await mkdir(join(dirs.subdirOnly, 'src'));
  return { root, dirs };
}

const listOf = async (path: string) =>
  api(server, 'GET', `/api/fs/list?path=${encodeURIComponent(path)}`);

test('fs/list `empty`: true ONLY for a directory with no entries at all — a file, a hidden file, a broken symlink or a subdir each make it false', async () => {
  const { root, dirs } = await emptyFlagFixtures();
  try {
    const expected: [string, string, string[], boolean][] = [
      ['empty', dirs.empty, [], true],
      ['fileOnly', dirs.fileOnly, [], false],
      ['hiddenOnly', dirs.hiddenOnly, [], false],
      ['brokenLinkOnly', dirs.brokenLinkOnly, [], false],
      ['subdirOnly', dirs.subdirOnly, ['src'], false],
    ];
    for (const [label, path, listedDirs, empty] of expected) {
      const res = await listOf(path);
      assert.equal(res.status, 200, `${label}: ${JSON.stringify(res.body)}`);
      // Exact body: the flag is a real boolean, and `dirs` still lists
      // directories only (the file, the hidden file and the dangling link are
      // NOT names the picker shows — they only make the folder non-empty).
      assert.deepEqual(res.body, { path, dirs: listedDirs, empty }, label);
    }
    // Same `dirs` ([]), opposite `empty`: the flag cannot be derived from the
    // names the picker shows — it has to count every entry.
    const a = (await listOf(dirs.empty)).body as FsListResponse;
    const b = (await listOf(dirs.brokenLinkOnly)).body as FsListResponse;
    assert.deepEqual(a.dirs, b.dirs);
    assert.notEqual(a.empty, b.empty);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('fs/list `empty` -> probe -> intent, end to end: the dialog creates into an empty or missing folder and ADDS a folder that holds anything', async () => {
  const { root, dirs } = await emptyFlagFixtures();
  try {
    const cases: [string, string, 'create' | 'add'][] = [
      ['empty', dirs.empty, 'create'],
      ['fileOnly', dirs.fileOnly, 'add'],
      ['hiddenOnly', dirs.hiddenOnly, 'add'],
      ['brokenLinkOnly', dirs.brokenLinkOnly, 'add'],
      ['subdirOnly', dirs.subdirOnly, 'add'],
      ['missing', join(root, 'not-there-yet'), 'create'],
    ];
    for (const [label, path, intent] of cases) {
      const res = await listOf(path);
      // Exactly what newproject.ts does with the call: the body on 200, the
      // status on a failure.
      const probe =
        res.status === 200
          ? probeFromList(res.body as FsListResponse, 200)
          : probeFromList(null, res.status);
      assert.equal(blankIntent(probe), intent, `${label}: probe ${probe} (HTTP ${res.status})`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the intent the probe picks is one the backend ACCEPTS: create:true for empty/missing, register-as-is for non-empty (which create would 409)', async () => {
  const { root, dirs } = await emptyFlagFixtures();
  const created: string[] = [];
  try {
    const listed = async (path: string) => {
      const res = await listOf(path);
      return res.status === 200 ? probeFromList(res.body as FsListResponse, 200) : probeFromList(null, res.status);
    };

    // CREATE side — the empty folder and a missing one.
    for (const path of [dirs.empty, join(root, 'brand-new')]) {
      assert.equal(blankIntent(await listed(path)), 'create');
      const res = await api(server, 'POST', '/api/projects', { name: 'Fresh', path, create: true, gitInit: false });
      assert.equal(res.status, 201, `create into ${path}: ${JSON.stringify(res.body)}`);
      created.push((res.body as Project).id);
    }

    // ADD side — every non-empty kind: create:true would be refused, and the
    // dialog's ADD body (no `create`, no `gitInit`) registers it untouched.
    for (const path of [dirs.fileOnly, dirs.hiddenOnly, dirs.brokenLinkOnly, dirs.subdirOnly]) {
      assert.equal(blankIntent(await listed(path)), 'add');
      const before = (await readdir(path)).sort();
      const refused = await api(server, 'POST', '/api/projects', { name: 'X', path, create: true, gitInit: false });
      assert.equal(refused.status, 409, `create:true must refuse the non-empty ${path}`);
      const added = await api(server, 'POST', '/api/projects', { name: 'Added', path });
      assert.equal(added.status, 201, `add ${path}: ${JSON.stringify(added.body)}`);
      created.push((added.body as Project).id);
      assert.equal((added.body as Project).path, path);
      assert.deepEqual((await readdir(path)).sort(), before, `adding ${path} must not touch its contents`);
    }
  } finally {
    for (const id of created) await api(server, 'DELETE', `/api/projects/${id}`);
    await rm(root, { recursive: true, force: true });
  }
});

test(
  'fs/list answers 403 for a folder it may not read, which the probe maps to unknown -> create (never add)',
  { skip: process.getuid?.() === 0 ? 'root ignores directory mode bits' : false },
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-sm-locked-')));
    const locked = join(root, 'locked');
    await mkdir(locked);
    await writeFile(join(locked, 'secret.txt'), 'x\n');
    await chmod(locked, 0o000);
    try {
      const res = await listOf(locked);
      assert.equal(res.status, 403, `unreadable dir: ${JSON.stringify(res.body)}`);
      assert.equal(probeFromList(null, res.status), 'unknown');
      assert.equal(blankIntent(probeFromList(null, res.status)), 'create');
    } finally {
      await chmod(locked, 0o700);
      await rm(root, { recursive: true, force: true });
    }
  },
);
