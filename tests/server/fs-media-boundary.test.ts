/**
 * POST /api/fs/media-ticket + GET /api/fs/media — the boundary and the ticket
 * (Nocturne D7, `.claude/plans/nocturne/PLAN-D7.md`): outside home, the data
 * dir, symlinks out and in, a real FIFO, a folder, an extension outside the
 * table, a ticket used on another path, an unknown ticket, malformed bodies.
 *
 * One real server child on a fixture `home` (AI_SM_HOME_OVERRIDE,
 * `tests/helpers/fs-server-fixture.ts`), against the real kernel — a FIFO is a
 * real `mkfifo`, because only a real one can block an open.
 *
 * Why it matters: GET /api/fs/media is the one /api route without the token.
 * Its ticket is the whole credential, and its open is the same boundary as the
 * editor's read: a gap here serves any file the user can read to whatever
 * learns a URL.
 *
 * NOT claimed: a browser's media element (`/verify-terminal`); a drvfs mount.
 * The ticket's clock and cap are in fs-media-tickets.test.ts.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  bootFsServer,
  dataDir,
  evil,
  home,
  server,
  stopFsServer,
  work,
} from '../helpers/fs-server-fixture.ts';
import {
  askTicket,
  errorOf,
  getMedia,
  pattern,
  plantMedia,
  ticketFor,
} from '../helpers/fs-media-fixture.ts';
import { api } from '../helpers/helpers.ts';

const OUTSIDE_HOME = 'This folder is outside your home folder.';
const DATA_DIR = "The app's own folder is not a place to open files.";
const NOT_SHOWN = 'This file cannot be shown here.';
const TICKET_BAD = 'This view of the file has expired. Open the file again.';
const GONE = 'This file is no longer there.';
const PATH_BAD = 'The app cannot open that folder.';

before(() => bootFsServer('ai-sm-fsmedia-'));
after(() => stopFsServer());

test('a picture inside home gets a ticket with its size, mtime and inode', async () => {
  const path = await plantMedia('pic.png', pattern(300));
  const body = await ticketFor(path);
  assert.match(body.ticket, /^[0-9a-f]{64}$/);
  assert.equal(body.size, 300);
  assert.equal(typeof body.mtimeMs, 'number');
  assert.equal(typeof body.ino, 'number');
  assert.deepEqual(Object.keys(body).sort(), ['ino', 'mtimeMs', 'size', 'ticket']);
});

test('a file outside every anchor is a 403 and gets no ticket', async () => {
  const path = join(evil, 'out.png');
  await writeFile(path, pattern(10));
  const res = await askTicket(path);
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: OUTSIDE_HOME });
});

test('a file in the data dir is a 403 with the data-dir sentence', async () => {
  const path = join(dataDir, 'shot.png');
  await writeFile(path, pattern(10));
  const res = await askTicket(path);
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: DATA_DIR });
});

test('a symlink inside home pointing OUT of the boundary is a 403', async () => {
  const secret = join(evil, 'secret.png');
  await writeFile(secret, 'OUTSIDE');
  const link = join(work(), 'out-link.png');
  await symlink(secret, link);
  const res = await askTicket(link);
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: OUTSIDE_HOME });
});

test('a symlink inside the boundary is served AT ITS TARGET, its ticket bound to the target', async () => {
  const target = await plantMedia('target.jpg', pattern(64));
  const link = join(work(), 'in-link.jpg');
  await symlink(target, link);
  const { ticket } = await ticketFor(link);
  assert.equal((await ticketFor(target)).ticket, ticket, 'one realpath, one ticket');
  const res = await getMedia(link, ticket);
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'image/jpeg');
  assert.deepEqual(res.body, pattern(64), "the TARGET's bytes");
});

test('a real FIFO named like a video answers 415 at once and the server does not hang', async () => {
  const fifo = join(work(), 'pipe.mp4');
  execFileSync('mkfifo', [fifo]);
  const res = await askTicket(fifo);
  assert.equal(res.status, 415);
  assert.deepEqual(res.body, { error: NOT_SHOWN });
  const health = await fetch(`${server.baseUrl}/health`);
  assert.equal(health.status, 200, 'the server still answers');
});

test('a folder is a 415, even one named like a picture', async () => {
  const dir = join(work(), 'album.png');
  await mkdir(dir);
  const res = await askTicket(dir);
  assert.equal(res.status, 415);
  assert.deepEqual(res.body, { error: NOT_SHOWN });
});

test('an extension outside the table is a 415, a symlink to one included', async () => {
  const text = await plantMedia('notes.txt', 'hello');
  let res = await askTicket(text);
  assert.equal(res.status, 415, 'a text file');
  assert.deepEqual(res.body, { error: NOT_SHOWN });
  // The kind is judged on the REALPATH — what is actually served.
  const link = join(work(), 'looks-like.png');
  await symlink(text, link);
  res = await askTicket(link);
  assert.equal(res.status, 415, 'a .png link to a .txt');
});

test('a missing file is a 404, a relative or empty path a 400', async () => {
  let res = await askTicket(join(work(), 'nope.png'));
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: GONE });
  for (const bad of ['', 'work/a.png', 42, null, 'a'.repeat(5000)]) {
    res = await askTicket(bad);
    assert.equal(res.status, 400, JSON.stringify(bad).slice(0, 20));
    assert.deepEqual(res.body, { error: PATH_BAD });
  }
});

test('a body that is not JSON is a 400, and a GET of the ticket route a 405', async () => {
  const res = await fetch(`${server.baseUrl}/api/fs/media-ticket`, {
    method: 'POST',
    headers: { 'x-auth-token': server.token, 'content-type': 'application/json' },
    body: '{not json',
  });
  assert.equal(res.status, 400);
  const get = await api(server, 'GET', '/api/fs/media-ticket');
  assert.equal(get.status, 405);
});

test('the ticket route needs the token like every other route', async () => {
  const path = await plantMedia('tokenless.png', pattern(10));
  const res = await fetch(`${server.baseUrl}/api/fs/media-ticket`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  assert.equal(res.status, 401);
});

test('a ticket for a.png used on b.png is a 403 and serves nothing', async () => {
  const a = await plantMedia('a.png', pattern(20));
  const b = await plantMedia('b.png', Buffer.from('B-SECRET'));
  const { ticket } = await ticketFor(a);
  const res = await getMedia(b, ticket);
  assert.equal(res.status, 403);
  assert.equal(errorOf(res), TICKET_BAD);
  assert.ok(!res.body.includes('B-SECRET'), 'no byte of b.png');
});

test('an unknown or missing ticket is a 403 before any path is judged', async () => {
  const a = await plantMedia('c.png', pattern(20));
  for (const t of ['0'.repeat(64), 'zz', '']) {
    const res = await getMedia(a, t);
    assert.equal(res.status, 403, JSON.stringify(t));
    assert.equal(errorOf(res), TICKET_BAD);
  }
  // A path OUTSIDE home with a bad ticket answers the same 403 sentence:
  // without a ticket, no status says anything about the file system.
  const res = await getMedia('/etc/passwd', '0'.repeat(64));
  assert.equal(res.status, 403);
  assert.equal(errorOf(res), TICKET_BAD);
  const nowhere = await getMedia(join(home, 'nope', 'x.png'), '0'.repeat(64));
  assert.equal(errorOf(nowhere), TICKET_BAD, 'a missing path: the ticket sentence, not a 404');
});

test('a file deleted after its ticket was issued is a 404 on the GET', async () => {
  const path = await plantMedia('gone.webp', pattern(20));
  const { ticket } = await ticketFor(path);
  await rm(path);
  const res = await getMedia(path, ticket);
  assert.equal(res.status, 404);
  assert.equal(errorOf(res), GONE);
});

test('a file swapped for a folder after its ticket was issued is a 415 on the GET', async () => {
  // The ticket binds the PATH; the open still judges what stands there now.
  const path = await plantMedia('swap.pdf', pattern(20));
  const { ticket } = await ticketFor(path);
  await rm(path);
  await mkdir(path);
  const res = await getMedia(path, ticket);
  assert.equal(res.status, 415);
  assert.equal(errorOf(res), NOT_SHOWN);
});

test('a file swapped for a real FIFO after its ticket was issued is a 415 on the GET, no hang', async () => {
  const path = await plantMedia('swap.mov', pattern(20));
  const { ticket } = await ticketFor(path);
  await rm(path);
  execFileSync('mkfifo', [path]);
  const res = await getMedia(path, ticket);
  assert.equal(res.status, 415);
  assert.equal(errorOf(res), NOT_SHOWN);
  assert.equal((await fetch(`${server.baseUrl}/health`)).status, 200, 'the server still answers');
});

test('asking again for an unchanged file returns the same ticket; a rewrite brings a new one', async () => {
  const path = await plantMedia('follow.png', pattern(30));
  const first = await ticketFor(path);
  assert.equal((await ticketFor(path)).ticket, first.ticket, 'the 5 s poll keeps the src stable');
  await writeFile(path, pattern(31));
  const changed = await ticketFor(path);
  assert.equal(changed.size, 31, 'the probe sees the new size');
  assert.notEqual(changed.ticket, first.ticket, 'a changed file is a new URL');
  assert.equal((await getMedia(path, changed.ticket)).body.byteLength, 31);
  assert.equal((await getMedia(path, first.ticket)).status, 200, 'the old ticket still loads');
});

test('a same-size rewrite in place still brings a new ticket: the mtime is part of the version', async () => {
  // Same size, same inode (writeFile truncates in place): only the mtime says
  // the bytes moved. Set explicitly, so no clock resolution decides the test.
  const path = await plantMedia('same-size.png', pattern(40));
  await utimes(path, 1_700_000_000, 1_700_000_000);
  const first = await ticketFor(path);
  const ino = (await stat(path)).ino;
  await writeFile(path, Buffer.alloc(40, 7));
  await utimes(path, 1_700_000_100, 1_700_000_100);
  assert.equal((await stat(path)).ino, ino, 'non-vacuity: the inode did not change');
  const changed = await ticketFor(path);
  assert.equal(changed.size, first.size, 'non-vacuity: the size did not change');
  assert.notEqual(changed.ticket, first.ticket, 'a new URL for the new bytes');
  assert.deepEqual((await getMedia(path, changed.ticket)).body, Buffer.alloc(40, 7));
});

test('a link named like a picture to an SVG is served as SVG, sandbox CSP included', async () => {
  // The type comes from the REALPATH, never the name in the URL: a `.png`
  // name must not strip an SVG of the CSP that keeps its script from running.
  const svg = await plantMedia('art.svg', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  const link = join(work(), 'harmless.png');
  await symlink(svg, link);
  const { ticket } = await ticketFor(link);
  const res = await getMedia(link, ticket);
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'image/svg+xml', 'the target\'s type');
  assert.match(String(res.headers['content-security-policy']), /^sandbox;/, 'the SVG sandbox');
});

test('an absolute path past PATH_MAX is a 400 before any lookup', async () => {
  const res = await askTicket(join(work(), `${'a'.repeat(200)}/`.repeat(25), 'x.png'));
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: PATH_BAD });
});
