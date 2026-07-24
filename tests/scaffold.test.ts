/**
 * Project creation (Phase 2a) at the HTTP boundary, proven through the real
 * server: create-local (blank + gitInit toggle), no-clobber safety, clone url
 * + dest validation, and folder-picker mkdir with single-segment enforcement.
 *
 * The one network-touching case (a real `git clone` of a tiny public repo) is
 * guarded by a connectivity probe and SKIPPED offline — everything else is
 * deterministic and offline.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Project } from '../shared/protocol.ts';
import { api, rawRequest, startTestServer, type TestServer } from './helpers.ts';

let server: TestServer;
let work: string;

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

before(async () => {
  server = await startTestServer();
  work = await realpath(await mkdtemp(join(tmpdir(), 'ai-sm-scaffold-')));
});

after(async () => {
  if (server !== undefined) await server.stop();
  if (work !== undefined) await rm(work, { recursive: true, force: true });
});

test('create-local (create:true) makes the dir + git init + registers it', async () => {
  const path = join(work, 'fresh-gitinit');
  const res = await api(server, 'POST', '/api/projects', {
    name: 'Fresh',
    path,
    create: true,
    gitInit: true,
  });
  assert.equal(res.status, 201, `create failed: ${JSON.stringify(res.body)}`);
  const project = res.body as Project;
  assert.equal(project.path, path);
  assert.ok(await exists(path), 'dir created');
  assert.ok(await exists(join(path, '.git')), '.git present after gitInit');

  const listed = await api(server, 'GET', '/api/projects');
  assert.ok((listed.body as Project[]).some((p) => p.path === path), 'project registered');
});

test('create-local gitInit:false leaves no .git; omitted gitInit defaults ON', async () => {
  const noGit = join(work, 'no-git');
  let res = await api(server, 'POST', '/api/projects', { name: 'NoGit', path: noGit, create: true, gitInit: false });
  assert.equal(res.status, 201);
  assert.ok(await exists(noGit));
  assert.equal(await exists(join(noGit, '.git')), false, 'no .git when gitInit:false');

  const defGit = join(work, 'default-git');
  res = await api(server, 'POST', '/api/projects', { name: 'DefGit', path: defGit, create: true });
  assert.equal(res.status, 201);
  assert.ok(await exists(join(defGit, '.git')), 'gitInit defaults ON when omitted');
});

test('create-local never clobbers: NON-EMPTY dir -> 409, FILE -> 409, EMPTY dir -> 201', async () => {
  const nonEmpty = join(work, 'nonempty');
  await mkdir(nonEmpty);
  await writeFile(join(nonEmpty, 'keep.txt'), 'precious\n');
  let res = await api(server, 'POST', '/api/projects', { name: 'X', path: nonEmpty, create: true });
  assert.equal(res.status, 409, 'non-empty existing dir rejected');
  assert.ok(await exists(join(nonEmpty, 'keep.txt')), 'existing file untouched');

  const filePath = join(work, 'a-file');
  await writeFile(filePath, 'x\n');
  res = await api(server, 'POST', '/api/projects', { name: 'X', path: filePath, create: true });
  assert.equal(res.status, 409, 'a file path is rejected');

  const emptyDir = join(work, 'empty-existing');
  await mkdir(emptyDir);
  res = await api(server, 'POST', '/api/projects', { name: 'EmptyOk', path: emptyDir, create: true, gitInit: false });
  assert.equal(res.status, 201, 'an EMPTY existing dir may be adopted');
});

test('create-local: relative path -> 400; bad create/gitInit types -> 400', async () => {
  const cases: Record<string, unknown>[] = [
    { name: 'Rel', path: 'relative/dir', create: true },
    { name: 'C', path: join(work, 'x1'), create: 'yes' },
    { name: 'G', path: join(work, 'x2'), create: true, gitInit: 'no' },
  ];
  for (const body of cases) {
    const res = await api(server, 'POST', '/api/projects', body);
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}, got ${res.status}`);
  }
});

test('register-mode (create absent) is unchanged: nonexistent -> 400, existing dir -> 201', async () => {
  let res = await api(server, 'POST', '/api/projects', { name: 'Old', path: join(work, 'nope') });
  assert.equal(res.status, 400);
  res = await api(server, 'POST', '/api/projects', { name: 'OldOk', path: work });
  assert.equal(res.status, 201);
});

test('POST /api/fs/mkdir: single segment created; duplicate/traversal/slash/dots/parent rejected; GET 405', async () => {
  const created = await api(server, 'POST', '/api/fs/mkdir', { parent: work, name: 'ok' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.deepEqual(created.body, { path: join(work, 'ok') });
  assert.ok(await exists(join(work, 'ok')));

  const dup = await api(server, 'POST', '/api/fs/mkdir', { parent: work, name: 'ok' });
  assert.equal(dup.status, 409, 'existing target rejected');

  for (const name of ['../escape', 'a/b', 'a\\b', '.', '..', '...', '']) {
    const res = await api(server, 'POST', '/api/fs/mkdir', { parent: work, name });
    assert.equal(res.status, 400, `name ${JSON.stringify(name)} must be 400, got ${res.status}`);
  }
  assert.equal(await exists(join(work, '..', 'escape')), false, 'no traversal dir created');

  const badParent = await api(server, 'POST', '/api/fs/mkdir', { parent: join(work, 'no-such'), name: 'x' });
  assert.equal(badParent.status, 400, 'nonexistent parent rejected');

  const relParent = await api(server, 'POST', '/api/fs/mkdir', { parent: 'rel/parent', name: 'x' });
  assert.equal(relParent.status, 400, 'relative parent rejected');

  const get = await api(server, 'GET', '/api/fs/mkdir');
  assert.equal(get.status, 405, 'GET is 405');
});

test('POST /api/projects/clone: url + dest validation rejects dangerous inputs (no clone runs)', async () => {
  const badUrls = ['-oProxyCommand=evil', 'file:///etc/passwd', 'ext::sh -c whoami', '/abs/local/repo', './rel', 'not a url'];
  for (const url of badUrls) {
    const res = await api(server, 'POST', '/api/projects/clone', { url, dest: join(work, 'clone-x') });
    assert.equal(res.status, 400, `url ${JSON.stringify(url)} must be 400, got ${res.status}`);
    assert.equal(await exists(join(work, 'clone-x')), false, 'no dest created on url rejection');
  }

  const relDest = await api(server, 'POST', '/api/projects/clone', { url: 'https://github.com/x/y.git', dest: 'rel/dest' });
  assert.equal(relDest.status, 400, 'relative dest rejected');

  const missingUrl = await api(server, 'POST', '/api/projects/clone', { dest: join(work, 'z') });
  assert.equal(missingUrl.status, 400, 'missing url rejected');

  // A non-empty existing dest is refused BEFORE git runs (no clobber).
  const nonEmpty = join(work, 'clone-nonempty');
  await mkdir(nonEmpty);
  await writeFile(join(nonEmpty, 'keep.txt'), 'precious\n');
  const clash = await api(server, 'POST', '/api/projects/clone', { url: 'https://example.invalid/x/y.git', dest: nonEmpty });
  assert.equal(clash.status, 409, 'non-empty dest rejected');
  assert.ok(await exists(join(nonEmpty, 'keep.txt')), 'existing file untouched');

  const get = await api(server, 'GET', '/api/projects/clone');
  assert.equal(get.status, 405, 'GET is 405');
});

test('new endpoints require the token (401) and enforce Host/Origin parity (403)', async () => {
  for (const path of ['/api/projects', '/api/projects/clone', '/api/fs/mkdir']) {
    const noToken = await rawRequest(server.port, { method: 'POST', path });
    assert.equal(noToken.status, 401, `${path} without token must be 401`);

    const wrongToken = await rawRequest(server.port, {
      method: 'POST',
      path,
      headers: { 'x-auth-token': '0'.repeat(64) },
    });
    assert.equal(wrongToken.status, 401, `${path} wrong token must be 401`);

    const evilHost = await rawRequest(server.port, {
      method: 'POST',
      path,
      headers: { host: `evil.example.com:${server.port}`, 'x-auth-token': server.token },
    });
    assert.equal(evilHost.status, 403, `${path} forbidden Host must be 403`);

    const evilOrigin = await rawRequest(server.port, {
      method: 'POST',
      path,
      headers: { origin: 'http://evil.example.com', 'x-auth-token': server.token },
    });
    assert.equal(evilOrigin.status, 403, `${path} cross-origin must be 403`);
  }
});

test('POST /api/projects/clone: real clone of a tiny public repo (SKIPPED offline)', async (t) => {
  let net = false;
  try {
    const ping = await fetch('https://github.com', { method: 'HEAD', signal: AbortSignal.timeout(4000) });
    net = ping.status > 0;
  } catch {
    net = false;
  }
  if (!net) {
    t.skip('no network — argv would be: git clone -- https://github.com/octocat/Hello-World.git <dest>');
    return;
  }
  const dest = join(work, 'cloned');
  const res = await api(server, 'POST', '/api/projects/clone', {
    url: 'https://github.com/octocat/Hello-World.git',
    dest,
  });
  assert.equal(res.status, 201, `clone failed: ${JSON.stringify(res.body)}`);
  const project = res.body as Project;
  assert.equal(project.path, dest);
  assert.equal(project.name, 'Hello-World', 'name derived from repo basename');
  assert.ok(await exists(join(dest, '.git')), 'cloned .git present');
  const onDisk = JSON.parse(await readFile(join(server.dataDir, 'projects.json'), 'utf8')) as Project[];
  assert.ok(onDisk.some((p) => p.path === dest), 'clone registered in projects.json');
});
