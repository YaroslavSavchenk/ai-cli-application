/**
 * PATCH /api/projects/:id (edit a project's name and launch preferences) and
 * the launch-preference fields POST /api/projects accepts — Nocturne D1,
 * `.claude/plans/nocturne/PLAN-D1.md` § Frozen contract and § Test gate.
 *
 * How: one real server child (`startTestServer`); requests through `api`, and
 * projects.json read straight from the child's data dir, so every claim is
 * about what lands on disk, not only what the route answers.
 *
 * Why it matters: `defaultModel` ends up in the claude argv as `--model <id>`;
 * a value starting with `-` would read as a flag. A refused PATCH that still
 * wrote half its fields would leave a project the dialog never showed. A
 * legacy `defaultMode` left beside a cleared `defaultPerm` would quietly arm
 * the old "skip permissions" again.
 *
 * NOT claimed: the launch dialog applying these preferences (tests/ui/), or
 * the argv a launch builds from them (the UI's launch-args model tests).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Project } from '../../shared/protocol.ts';
import {
  api,
  makeTempDir,
  rawRequest,
  removeTempDir,
  startTestServer,
  waitForLog,
  type TestServer,
} from '../helpers/helpers.ts';

let server: TestServer;
let workDir: string;

before(async () => {
  server = await startTestServer();
  workDir = await realpath(await makeTempDir('ai-sm-proj-update-'));
});

after(async () => {
  if (server !== undefined) await server.stop();
  if (workDir !== undefined) await removeTempDir(workDir);
});

const projectsFile = (): string => join(server.dataDir, 'projects.json');
const readProjectsText = (): Promise<string> => readFile(projectsFile(), 'utf8');

async function storedProject(id: string): Promise<Project | undefined> {
  const all = JSON.parse(await readProjectsText()) as Project[];
  return all.find((p) => p.id === id);
}

async function createProject(extra: Record<string, unknown> = {}): Promise<Project> {
  const res = await api(server, 'POST', '/api/projects', { name: 'Edit me', path: workDir, ...extra });
  assert.equal(res.status, 201, `create failed: ${JSON.stringify(res.body)}`);
  return res.body as Project;
}

async function patch(id: string, body: unknown): Promise<{ status: number; body: unknown }> {
  return api(server, 'PATCH', `/api/projects/${encodeURIComponent(id)}`, body);
}

test('PATCH sets each preference field, answers the updated project and stores it', async () => {
  const project = await createProject();
  const cases: Array<[string, string]> = [
    ['defaultModel', 'claude-opus-5-5'],
    ['defaultPerm', 'acceptEdits'],
    ['defaultEffort', 'xhigh'],
  ];
  for (const [field, value] of cases) {
    const res = await patch(project.id, { [field]: value });
    assert.equal(res.status, 200, `${field}: ${JSON.stringify(res.body)}`);
    const body = res.body as Record<string, unknown>;
    assert.equal(body[field], value, `${field} in the answer`);
    assert.equal(body.id, project.id, `${field}: same project`);
    const stored = (await storedProject(project.id)) as unknown as Record<string, unknown>;
    assert.equal(stored[field], value, `${field} on disk`);
  }
  const listed = (await api(server, 'GET', '/api/projects')).body as Project[];
  const back = listed.find((p) => p.id === project.id);
  assert.deepEqual(
    [back?.defaultModel, back?.defaultPerm, back?.defaultEffort, back?.name, back?.path],
    ['claude-opus-5-5', 'acceptEdits', 'xhigh', 'Edit me', workDir],
    'all three kept together, name and path untouched',
  );
});

test('PATCH with null clears each preference key from the file', async () => {
  const project = await createProject({ defaultModel: 'opus', defaultPerm: 'plan', defaultEffort: 'low' });
  for (const field of ['defaultModel', 'defaultPerm', 'defaultEffort']) {
    const res = await patch(project.id, { [field]: null });
    assert.equal(res.status, 200, `${field}: ${JSON.stringify(res.body)}`);
    assert.equal(Object.hasOwn(res.body as object, field), false, `${field} gone from the answer`);
    const stored = (await storedProject(project.id)) as object;
    assert.equal(Object.hasOwn(stored, field), false, `${field} gone from projects.json, not stored as null`);
  }
});

test('an absent field stays as it was', async () => {
  const project = await createProject({ defaultModel: 'sonnet', defaultEffort: 'high' });
  const res = await patch(project.id, { defaultPerm: 'plan' });
  assert.equal(res.status, 200);
  const stored = await storedProject(project.id);
  assert.equal(stored?.defaultModel, 'sonnet', 'model untouched');
  assert.equal(stored?.defaultEffort, 'high', 'effort untouched');
  assert.equal(stored?.name, 'Edit me', 'name untouched');
});

test('writing defaultPerm deletes the legacy defaultMode', async () => {
  const project = await createProject({ defaultMode: 'skip-permissions' });
  assert.equal(project.defaultMode, 'skip-permissions', 'precondition: legacy field stored');
  const res = await patch(project.id, { defaultPerm: 'default' });
  assert.equal(res.status, 200);
  assert.equal(Object.hasOwn(res.body as object, 'defaultMode'), false, 'gone from the answer');
  const stored = await storedProject(project.id);
  assert.equal(stored?.defaultPerm, 'default');
  assert.equal(stored !== undefined && Object.hasOwn(stored, 'defaultMode'), false, 'gone from the file');
});

test('clearing defaultPerm also deletes the legacy defaultMode', async () => {
  const project = await createProject({ defaultMode: 'skip-permissions' });
  const res = await patch(project.id, { defaultPerm: null });
  assert.equal(res.status, 200);
  const stored = await storedProject(project.id);
  assert.equal(
    stored !== undefined && Object.hasOwn(stored, 'defaultMode'),
    false,
    'a cleared preference must not fall back to the old skip-permissions',
  );
});

test('a PATCH that leaves defaultPerm out keeps the legacy defaultMode', async () => {
  const project = await createProject({ defaultMode: 'skip-permissions' });
  const res = await patch(project.id, { defaultEffort: 'max' });
  assert.equal(res.status, 200);
  assert.equal((await storedProject(project.id))?.defaultMode, 'skip-permissions');
});

test('a rename is stored trimmed and never touches the path', async () => {
  const project = await createProject();
  const res = await patch(project.id, { name: '  Renamed  ', path: '/home/you/elsewhere' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal((res.body as Project).name, 'Renamed');
  const stored = await storedProject(project.id);
  assert.equal(stored?.name, 'Renamed', 'trimmed on disk');
  assert.equal(stored?.path, workDir, 'the unknown key `path` is ignored');
});

test('the update log line names the changed fields, never their values', async () => {
  const project = await createProject();
  const res = await patch(project.id, { name: 'Secret-ish name 7f3a', defaultModel: 'claude-sonnet-5-5' });
  assert.equal(res.status, 200);
  const log = await waitForLog(server, `updated project ${project.id}: name, defaultModel`);
  assert.equal(log.includes('Secret-ish name 7f3a'), false, 'the new name is not logged');
  assert.equal(log.includes('claude-sonnet-5-5'), false, 'the model id is not logged');
});

test('PATCH on an unknown id answers 404 and writes nothing', async () => {
  await createProject();
  const before = await readProjectsText();
  const res = await patch('no-such-project', { name: 'X' });
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'project not found' });
  assert.equal(await readProjectsText(), before, 'projects.json unchanged');
});

test('invalid fields answer 400 with their sentence and leave projects.json byte-identical', async () => {
  const project = await createProject({ defaultModel: 'opus' });
  const before = await readProjectsText();
  const cases: Array<[string, unknown, string]> = [
    ['model starting with a dash', { defaultModel: '-x' }, 'defaultModel'],
    ['uppercase model', { defaultModel: 'Claude-Opus' }, 'defaultModel'],
    ['65-character model', { defaultModel: 'a'.repeat(65) }, 'defaultModel'],
    // The pattern's own edges: uppercase only in the first character, a second
    // line hidden after a valid first one, a path separator.
    ['capital first letter only', { defaultModel: 'Opus' }, 'defaultModel'],
    ['a valid line, then a flag on the next', { defaultModel: 'opus\n--x' }, 'defaultModel'],
    ['model with a slash', { defaultModel: 'opus/x' }, 'defaultModel'],
    ['numeric model', { defaultModel: 5 }, 'defaultModel'],
    ['empty model', { defaultModel: '' }, 'defaultModel'],
    ['model with a space', { defaultModel: 'opus 5' }, 'defaultModel'],
    ['unknown permission', { defaultPerm: 'yolo' }, 'defaultPerm'],
    ['legacy mode word as permission', { defaultPerm: 'skip-permissions' }, 'defaultPerm'],
    ['inherited key as permission', { defaultPerm: 'toString' }, 'defaultPerm'],
    ['unknown effort', { defaultEffort: 'extreme' }, 'defaultEffort'],
    // The launch dialog's `default` sentinel is no stored level: absent = Default.
    ['the browser-only default sentinel as effort', { defaultEffort: 'default' }, 'defaultEffort'],
    ['numeric effort', { defaultEffort: 3 }, 'defaultEffort'],
    ['empty name', { name: '   ' }, 'name'],
    ['numeric name', { name: 42 }, 'name'],
    ['null name', { name: null }, 'name'],
    // One bad field among good ones: nothing of the good ones is written either.
    ['good name, bad effort', { name: 'Fine', defaultEffort: 'nope' }, 'defaultEffort'],
  ];
  for (const [label, body, field] of cases) {
    const res = await patch(project.id, body);
    assert.equal(res.status, 400, `${label}: ${JSON.stringify(res.body)}`);
    const error = (res.body as { error?: unknown }).error;
    assert.equal(typeof error === 'string' && error.startsWith(field), true, `${label}: sentence names ${field}`);
    assert.equal(await readProjectsText(), before, `${label}: projects.json unchanged`);
  }
});

test('the model pattern admits aliases, full ids and exactly 64 characters', async () => {
  const project = await createProject();
  for (const id of ['opus', 'claude-opus-5-5', 'claude-3.5-x', '4o', 'a'.repeat(64)]) {
    const res = await patch(project.id, { defaultModel: id });
    assert.equal(res.status, 200, `${id}: ${JSON.stringify(res.body)}`);
    assert.equal((await storedProject(project.id))?.defaultModel, id, `${id} stored`);
  }
});

test('a body that is not a JSON object answers 400 and writes nothing', async () => {
  const project = await createProject();
  const before = await readProjectsText();
  for (const body of [null, [], 'name', 7]) {
    const res = await patch(project.id, body);
    assert.equal(res.status, 400, `${JSON.stringify(body)}: ${JSON.stringify(res.body)}`);
    assert.deepEqual(res.body, { error: 'request body must be a JSON object' }, JSON.stringify(body));
  }
  assert.equal(await readProjectsText(), before, 'projects.json unchanged');
});

test('methods other than PATCH and DELETE on a project answer 405', async () => {
  const project = await createProject();
  for (const method of ['GET', 'PUT', 'POST']) {
    const res = await api(server, method, `/api/projects/${project.id}`, method === 'GET' ? undefined : {});
    assert.equal(res.status, 405, method);
    assert.deepEqual(res.body, { error: 'method not allowed' }, method);
  }
});

test('projects.json stays mode 0600 after a PATCH', async () => {
  const project = await createProject();
  const res = await patch(project.id, { name: 'Mode check', defaultEffort: 'medium' });
  assert.equal(res.status, 200);
  const mode = (await stat(projectsFile())).mode & 0o777;
  assert.equal(mode, 0o600, `mode is ${mode.toString(8)}`);
});

test('POST stores valid defaultPerm and defaultEffort', async () => {
  const project = await createProject({ defaultPerm: 'bypassPermissions', defaultEffort: 'max' });
  assert.equal(project.defaultPerm, 'bypassPermissions');
  assert.equal(project.defaultEffort, 'max');
  const stored = await storedProject(project.id);
  assert.equal(stored?.defaultPerm, 'bypassPermissions', 'on disk');
  assert.equal(stored?.defaultEffort, 'max', 'on disk');
});

test('POST refuses invalid preferences, null included, and registers nothing', async () => {
  await createProject();
  const before = await readProjectsText();
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['bad permission', { defaultPerm: 'yolo' }, 'defaultPerm'],
    ['null permission', { defaultPerm: null }, 'defaultPerm'],
    ['bad effort', { defaultEffort: 'huge' }, 'defaultEffort'],
    ['null effort', { defaultEffort: null }, 'defaultEffort'],
    ['model starting with a dash', { defaultModel: '--dangerously-skip-permissions' }, 'defaultModel'],
    ['uppercase model', { defaultModel: 'OPUS' }, 'defaultModel'],
    ['null model', { defaultModel: null }, 'defaultModel'],
  ];
  for (const [label, extra, field] of cases) {
    const res = await api(server, 'POST', '/api/projects', { name: 'Nope', path: workDir, ...extra });
    assert.equal(res.status, 400, `${label}: ${JSON.stringify(res.body)}`);
    const error = (res.body as { error?: unknown }).error;
    assert.equal(typeof error === 'string' && error.startsWith(field), true, `${label}: sentence names ${field}`);
    assert.equal(await readProjectsText(), before, `${label}: nothing registered`);
  }
});

test('PATCH without the token answers 401, from a foreign Origin 403, and neither writes', async () => {
  const project = await createProject();
  const before = await readProjectsText();
  const path = `/api/projects/${encodeURIComponent(project.id)}`;
  const body = JSON.stringify({ name: 'Hijacked' });
  const noToken = await rawRequest(server.port, {
    method: 'PATCH',
    path,
    headers: { 'content-type': 'application/json' },
    body,
  });
  assert.equal(noToken.status, 401, 'no token: 401');
  const evilOrigin = await rawRequest(server.port, {
    method: 'PATCH',
    path,
    headers: { 'content-type': 'application/json', 'x-auth-token': server.token, origin: 'http://evil.example.com' },
    body,
  });
  assert.equal(evilOrigin.status, 403, 'a foreign Origin is 403 even with a valid token');
  assert.equal(await readProjectsText(), before, 'projects.json unchanged');
});

test('PATCH with an empty object answers 200 with the project as stored and does not write the file', async () => {
  const project = await createProject({ defaultModel: 'opus' });
  const beforeText = await readProjectsText();
  const beforeMtime = (await stat(projectsFile())).mtimeMs;
  const res = await patch(project.id, {});
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body, project, 'the answer is the project unchanged');
  assert.equal(await readProjectsText(), beforeText, 'projects.json bytes unchanged');
  assert.equal((await stat(projectsFile())).mtimeMs, beforeMtime, 'projects.json not rewritten');
});
