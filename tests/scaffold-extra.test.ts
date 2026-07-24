/**
 * Test-engineer additions closing gaps around the Phase 2a scaffold change,
 * complementing tests/scaffold.test.ts (which asserts the create/clone/mkdir
 * HTTP happy + no-clobber paths). This file DELIBERATELY does not repeat those
 * assertions; it covers what the developers' file leaves open:
 *
 *   - validateCloneUrl (direct): the ACCEPT allowlist (http(s)/git/ssh/scp) —
 *     which cannot be exercised over HTTP without a real network clone — plus
 *     the REJECT gaps the HTTP suite never sends (control chars, embedded
 *     whitespace, over-length, empty, colon-without-user, scp-empty-path).
 *   - isSafeSegment (direct): NUL/control-char + over-length rejection and the
 *     255-char / normal-segment ACCEPT boundary (the HTTP suite only covers
 *     slash/backslash/dots/empty).
 *   - cloneRepo cleanup (direct): a failed clone removes a dest WE created but
 *     NEVER a pre-existing one. Failure is forced against 127.0.0.1:1 ->
 *     immediate ECONNREFUSED, so this is deterministic AND fully offline (no
 *     DNS, no reachable host).
 *   - HTTP wiring gaps: clone into a missing-parent dest -> 400 (no git runs),
 *     create-mode validates cheap fields BEFORE the mkdir side effect (a bad
 *     defaultMode -> 400 with NO orphan directory left behind), and the clone
 *     route resolves BEFORE the /api/projects/:id matcher.
 *
 * Control chars are written ONLY as \u / \t / \n escapes — never raw bytes.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateCloneUrl, cloneRepo, ScaffoldError } from '../server/scaffold.ts';
import { isSafeSegment } from '../server/fsbrowse.ts';
import { api, startTestServer, type TestServer } from './helpers.ts';

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
  work = await realpath(await mkdtemp(join(tmpdir(), 'ai-sm-scaffold-extra-')));
});

after(async () => {
  if (server !== undefined) await server.stop();
  if (work !== undefined) await rm(work, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// validateCloneUrl — the ACCEPT allowlist (unreachable over HTTP without a real
// clone) and the REJECT branches the HTTP suite does not send.
// ---------------------------------------------------------------------------

function assertAccepts(url: string): void {
  assert.doesNotThrow(() => validateCloneUrl(url), `expected ACCEPT: ${JSON.stringify(url)}`);
}
function assertRejects(url: string): void {
  assert.throws(
    () => validateCloneUrl(url),
    (e: unknown) => e instanceof ScaffoldError && e.status === 400,
    `expected REJECT 400: ${JSON.stringify(url)}`,
  );
}

test('validateCloneUrl ACCEPTS http(s)/git/ssh/scp shapes (case-insensitive scheme)', () => {
  for (const url of [
    'http://github.com/owner/repo.git',
    'https://github.com/owner/repo.git',
    'HTTPS://GitHub.com/owner/repo', // scheme match is case-insensitive
    'git://github.com/owner/repo.git',
    'ssh://git@github.com/owner/repo.git',
    'ssh://git@host.example:22/owner/repo.git', // ssh:// with an explicit port
    'git@github.com:owner/repo.git', // scp-like (user@host:path)
    'user@host.example:path/to/repo', // scp-like, no .git suffix
  ]) {
    assertAccepts(url);
  }
});

test('validateCloneUrl REJECTS control chars, embedded whitespace, over-length, empty, and colon-without-user', () => {
  assertRejects(''); // empty
  assertRejects('https://github.com/owner/repo\n.git'); // LF (0x0a) control char
  assertRejects('https://github.com/owner/\trepo.git'); // TAB (0x09) control char
  assertRejects('https://github.com/owner/repo\u0000.git'); // NUL control char
  assertRejects('https://git hub.com/owner/repo.git'); // embedded space (0x20)
  assertRejects(`https://github.com/${'a'.repeat(2100)}.git`); // > MAX_URL_LEN (2048)
  assertRejects('github.com:owner/repo.git'); // colon but NO user@ -> not scp, not a scheme
  assertRejects('git@github.com:'); // scp-like with empty path -> rejected
});

// ---------------------------------------------------------------------------
// isSafeSegment — NUL/control + over-length rejection, and the accept boundary.
// (HTTP suite covers '/', '\', '.', '..', '...', '' at the endpoint.)
// ---------------------------------------------------------------------------

test('isSafeSegment: NUL/control + over-length rejected; 255-char + normal segment accepted', () => {
  assert.equal(isSafeSegment('my-project_v2'), true, 'a normal segment is accepted');
  assert.equal(isSafeSegment('x'.repeat(255)), true, '255 chars is the accepted max');
  assert.equal(isSafeSegment('x'.repeat(256)), false, '256 chars is over the limit');
  assert.equal(isSafeSegment('a\u0000b'), false, 'NUL rejected');
  assert.equal(isSafeSegment('a\tb'), false, 'TAB (control) rejected');
  assert.equal(isSafeSegment('a\nb'), false, 'LF (control) rejected');
  assert.equal(isSafeSegment('a\u001fb'), false, 'US (0x1f control) rejected');
  assert.equal(isSafeSegment(''), false, 'empty rejected');
});

// ---------------------------------------------------------------------------
// cloneRepo cleanup — a failed clone removes ONLY a dest we created.
// 127.0.0.1:1 -> immediate ECONNREFUSED: deterministic, offline, sub-second.
// ---------------------------------------------------------------------------

test('cloneRepo cleanup: a failed clone removes a WE-created dest but NEVER a pre-existing one', { timeout: 60_000 }, async () => {
  const badUrl = 'https://127.0.0.1:1/owner/repo.git'; // scheme-valid, connection refused

  // (A) a dest WE create is removed when the clone fails.
  const created = join(work, 'clone-we-created');
  await assert.rejects(cloneRepo(badUrl, created), (e: unknown) => e instanceof ScaffoldError);
  assert.equal(await exists(created), false, 'a dest git/we created is cleaned up on clone failure');

  // (B) a pre-existing (empty) dest is NEVER removed when the clone fails.
  const preexisting = join(work, 'clone-preexisting');
  await mkdir(preexisting);
  await assert.rejects(cloneRepo(badUrl, preexisting), (e: unknown) => e instanceof ScaffoldError);
  assert.ok(await exists(preexisting), 'a pre-existing dest is NEVER removed on clone failure');
});

// ---------------------------------------------------------------------------
// HTTP wiring gaps.
// ---------------------------------------------------------------------------

test('POST /api/projects/clone: a dest whose PARENT does not exist -> 400 (no git runs)', async () => {
  const dest = join(work, 'ghost-parent', 'leaf'); // parent ghost-parent is absent
  const res = await api(server, 'POST', '/api/projects/clone', {
    url: 'https://github.com/octocat/Hello-World.git',
    dest,
  });
  assert.equal(res.status, 400, `expected 400 for a missing parent, got ${res.status} ${JSON.stringify(res.body)}`);
  assert.equal(await exists(join(work, 'ghost-parent')), false, 'no parent directory is created');
});

test('POST /api/projects (create:true): cheap fields are validated BEFORE the mkdir side effect', async () => {
  const path = join(work, 'ordering-guard');
  const res = await api(server, 'POST', '/api/projects', {
    name: 'X',
    path,
    create: true,
    gitInit: false,
    defaultMode: 'bogus', // invalid -> must 400 BEFORE createLocalDir runs
  });
  assert.equal(res.status, 400, `expected 400 for a bad defaultMode, got ${res.status} ${JSON.stringify(res.body)}`);
  assert.equal(await exists(path), false, 'no orphan directory is created when a cheap field fails validation');
});

test('routing: /api/projects/clone resolves BEFORE the /api/projects/:id matcher', async () => {
  // DELETE hits the clone route (POST-only -> 405). Were it captured by the :id
  // matcher, it would try to remove project id "clone" -> 404. 405-vs-404
  // cleanly proves the clone route precedes the :id matcher.
  const del = await api(server, 'DELETE', '/api/projects/clone');
  assert.equal(del.status, 405, 'DELETE /api/projects/clone must be 405 (clone route), not 404 (:id matcher)');

  // Control: an unknown id DOES reach the :id matcher and 404s — proving the
  // discriminator above is real, not an accident of both paths returning 405.
  const ctrl = await api(server, 'DELETE', '/api/projects/no-such-id');
  assert.equal(ctrl.status, 404, 'DELETE /api/projects/<unknown> reaches the :id matcher -> 404');
});

test('POST /api/fs/mkdir: NUL/control + over-length names -> 400; a 255-char segment -> 201', async () => {
  for (const name of ['a\u0000b', 'a\u001fb', 'x'.repeat(256)]) {
    const res = await api(server, 'POST', '/api/fs/mkdir', { parent: work, name });
    assert.equal(res.status, 400, `mkdir name ${JSON.stringify(name.slice(0, 12))} must be 400, got ${res.status}`);
  }
  const okName = 'x'.repeat(255);
  const ok = await api(server, 'POST', '/api/fs/mkdir', { parent: work, name: okName });
  assert.equal(ok.status, 201, `255-char single segment must be 201, got ${ok.status} ${JSON.stringify(ok.body)}`);
  assert.ok(await exists(join(work, okName)), '255-char directory created');
});
