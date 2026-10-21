/**
 * GET /api/fs/media — serving the bytes (Nocturne D7,
 * `.claude/plans/nocturne/PLAN-D7.md`): the whole file, one `bytes=` range
 * (exact, open-ended, suffix), the 416s, the headers per kind (nosniff,
 * no-store, the sandbox CSP on SVG only), no token needed but the Host and
 * Origin gates kept, nothing of the ticket or the path in server.log, and a
 * client abort that gives the fd back.
 *
 * One real server child on a fixture `home` (`tests/helpers/fs-server-fixture.ts`);
 * the fd check reads the child's own `/proc/<pid>/fd`, so it sees the kernel's
 * answer, not the module's bookkeeping.
 *
 * Why it matters: a `<video>` plays as a stream of Range requests and aborts
 * one on every seek. A wrong `Content-Range` is a video that cannot seek; an
 * fd held per aborted request is a server that runs out of fds after an hour
 * of scrubbing; a sandbox CSP on a PDF is a PDF Chromium will not render.
 *
 * NOT claimed: a real `<video>`/`<img>`/PDF viewer in a browser
 * (`/verify-terminal`, the user's Windows check).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { bootFsServer, server, stopFsServer, work } from '../helpers/fs-server-fixture.ts';
import {
  askTicket,
  errorOf,
  getMedia,
  mediaUrl,
  openFdsOn,
  pattern,
  plantMedia,
  ticketFor,
} from '../helpers/fs-media-fixture.ts';
import { waitForLog, waitForLogQuiet, waitUntil } from '../helpers/helpers.ts';

const SVG_CSP = "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'";
const RANGE_BAD = 'The app cannot send that part of the file.';

let video: string;
let ticket: string;
const SIZE = 1000;

before(async () => {
  await bootFsServer('ai-sm-fsmedia-serve-');
  video = await plantMedia('clip.mp4', pattern(SIZE));
  ticket = (await ticketFor(video)).ticket;
});
after(() => stopFsServer());

test('no Range: 200, the whole file, its length and Accept-Ranges', async () => {
  const res = await getMedia(video, ticket);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, pattern(SIZE));
  assert.equal(res.headers['content-length'], String(SIZE));
  assert.equal(res.headers['accept-ranges'], 'bytes');
  assert.equal(res.headers['content-range'], undefined);
});

test('bytes=a-b: 206 with exactly those bytes and their Content-Range', async () => {
  const res = await getMedia(video, ticket, { range: 'bytes=10-19' });
  assert.equal(res.status, 206);
  assert.deepEqual(res.body, pattern(SIZE).subarray(10, 20));
  assert.equal(res.headers['content-range'], `bytes 10-19/${SIZE}`);
  assert.equal(res.headers['content-length'], '10');
});

test('an end past the file is clamped to its last byte', async () => {
  const res = await getMedia(video, ticket, { range: 'bytes=990-5000' });
  assert.equal(res.status, 206);
  assert.deepEqual(res.body, pattern(SIZE).subarray(990));
  assert.equal(res.headers['content-range'], `bytes 990-999/${SIZE}`);
});

test('open-ended bytes=100-: 206 from 100 to the end', async () => {
  const res = await getMedia(video, ticket, { range: 'bytes=100-' });
  assert.equal(res.status, 206);
  assert.deepEqual(res.body, pattern(SIZE).subarray(100));
  assert.equal(res.headers['content-range'], `bytes 100-999/${SIZE}`);
  assert.equal(res.headers['content-length'], '900');
});

test('suffix bytes=-100: 206 with the last 100 bytes; a suffix past the size is the whole file', async () => {
  let res = await getMedia(video, ticket, { range: 'bytes=-100' });
  assert.equal(res.status, 206);
  assert.deepEqual(res.body, pattern(SIZE).subarray(900));
  assert.equal(res.headers['content-range'], `bytes 900-999/${SIZE}`);
  res = await getMedia(video, ticket, { range: 'bytes=-5000' });
  assert.equal(res.status, 206);
  assert.equal(res.headers['content-range'], `bytes 0-999/${SIZE}`);
});

test('an unsatisfiable, reversed, malformed or multi-range Range is a 416 naming the size', async () => {
  for (const range of ['bytes=1000-', 'bytes=5000-6000', 'bytes=20-10', 'bytes=-0', 'bytes=-', 'bytes=x-y', 'bytes=0-1,5-6']) {
    const res = await getMedia(video, ticket, { range });
    assert.equal(res.status, 416, range);
    assert.equal(res.headers['content-range'], `bytes */${SIZE}`, range);
    assert.equal(errorOf(res), RANGE_BAD, range);
  }
});

test('a range that starts exactly at the end is a 416, whatever its end', async () => {
  // `bytes=1000-1000` on 1000 bytes: the end is not before the start, so only
  // the start-at-the-end rule refuses it — never a 206 with no body.
  for (const range of ['bytes=1000-1000', 'bytes=1000-2000']) {
    const res = await getMedia(video, ticket, { range });
    assert.equal(res.status, 416, range);
    assert.equal(res.headers['content-range'], `bytes */${SIZE}`, range);
  }
});

test('a Range in a unit other than bytes is ignored: 200, the whole file', async () => {
  const res = await getMedia(video, ticket, { range: 'items=0-5' });
  assert.equal(res.status, 200);
  assert.equal(res.body.byteLength, SIZE);
});

test('an empty file is a 200 with no body, and any range on it a 416', async () => {
  const empty = await plantMedia('empty.gif', Buffer.alloc(0));
  const t = (await ticketFor(empty)).ticket;
  let res = await getMedia(empty, t);
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-length'], '0');
  assert.equal(res.body.byteLength, 0);
  res = await getMedia(empty, t, { range: 'bytes=0-' });
  assert.equal(res.status, 416);
  assert.equal(res.headers['content-range'], 'bytes */0');
});

test('every kind gets its type, nosniff and no-store; the sandbox CSP goes on SVG alone', async () => {
  const cases: [string, string][] = [
    ['p.png', 'image/png'],
    ['p.svg', 'image/svg+xml'],
    ['d.pdf', 'application/pdf'],
    ['v.webm', 'video/webm'],
    ['V.MOV', 'video/quicktime'],
  ];
  for (const [name, type] of cases) {
    const path = await plantMedia(name, pattern(8));
    const res = await getMedia(path, (await ticketFor(path)).ticket);
    assert.equal(res.status, 200, name);
    assert.equal(res.headers['content-type'], type, name);
    assert.equal(res.headers['x-content-type-options'], 'nosniff', name);
    assert.equal(res.headers['cache-control'], 'no-store', name);
    assert.equal(res.headers['cross-origin-resource-policy'], 'same-origin', name);
    assert.equal(res.headers['x-frame-options'], 'SAMEORIGIN', name);
    assert.equal(
      res.headers['content-security-policy'],
      type === 'image/svg+xml' ? SVG_CSP : undefined,
      `${name}: CSP on SVG only — never a sandbox on a PDF or a video`,
    );
  }
});

test('no token header is needed, but a foreign Host or Origin is still refused', async () => {
  // getMedia sends no X-Auth-Token at all: the 200 above is that proof.
  let res = await getMedia(video, ticket, { host: `evil.example:${server.port}` });
  assert.equal(res.status, 403, 'a DNS-rebinding Host');
  res = await getMedia(video, ticket, { origin: 'http://evil.example' });
  assert.equal(res.status, 403, 'a foreign Origin');
  res = await getMedia(video, ticket, { origin: `http://localhost:${server.port}` });
  assert.equal(res.status, 200, "the app's own Origin");
});

test('only GET is exempt from the token: a POST or HEAD on the media route needs it', async () => {
  for (const method of ['POST', 'HEAD', 'PUT']) {
    const res = await fetch(`${server.baseUrl}${mediaUrl(video, ticket)}`, { method });
    assert.equal(res.status, 401, method);
  }
});

test('server.log carries the media request but neither the ticket nor the path', async () => {
  const name = 'logged-secret-name.png';
  const path = await plantMedia(name, pattern(16));
  const t = (await ticketFor(path)).ticket;
  assert.equal((await getMedia(path, t, { range: 'bytes=0-3' })).status, 206);
  assert.equal((await getMedia(path, '0'.repeat(64))).status, 403);
  const log = await waitForLog(server, 'GET /api/fs/media ?… -> 403');
  assert.match(log, /GET \/api\/fs\/media \?… -> 206/, 'the served request is logged');
  assert.ok(!log.includes(t), 'no ticket');
  assert.ok(!log.includes('0'.repeat(64)), 'no refused ticket either');
  assert.ok(!log.includes(name), 'no file name');
  assert.ok(!log.includes(encodeURIComponent(path)), 'no encoded path');
});

test('many aborted range requests leave no fd open on the file', async () => {
  const big = await plantMedia('big.mkv', pattern(8 * 1024 * 1024));
  const t = (await ticketFor(big)).ticket;
  const ABORTS = 40;
  for (let i = 0; i < ABORTS; i++) {
    await new Promise<void>((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port: server.port,
          path: mediaUrl(big, t),
          headers: { range: `bytes=${i * 1000}-` },
        },
        (res) => {
          assert.equal(res.statusCode, 206);
          // The first chunk arrived: the stream is mid-file. Hang up, the way a
          // video seek does.
          res.once('data', () => {
            req.destroy();
            resolve();
          });
        },
      );
      req.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code !== 'ECONNRESET') reject(err);
      });
      req.end();
    });
  }
  await waitUntil(async () => ((await openFdsOn(big)) === 0 ? true : undefined), 'every fd on the file closed');
  const res = await getMedia(big, t, { range: 'bytes=0-9' });
  assert.equal(res.status, 206, 'and the server still serves');
  assert.deepEqual(res.body, pattern(10));
});

test('a request without a live ticket writes only the metered access line, no [fs] line', async () => {
  const marker = 'GET /api/fs/media -> 403';
  const before = (await waitForLogQuiet(server)).split(marker).length;
  assert.equal((await getMedia(video, 'f'.repeat(64))).status, 403);
  const log = await waitForLogQuiet(server);
  assert.equal(log.split(marker).length, before, 'no [fs] status line for a stranger');
});

test('a served answer gives its fd back once it is complete — whole file and range alike', async () => {
  // The abort test proves the destroyed stream closes; this one the stream
  // that simply reaches its end (most requests of a picture or a PDF).
  const path = await plantMedia('complete.webp', pattern(4096));
  const t = (await ticketFor(path)).ticket;
  for (const range of [undefined, 'bytes=0-99', 'bytes=-10']) {
    const res = await getMedia(path, t, range === undefined ? {} : { range });
    assert.ok(res.status === 200 || res.status === 206, String(range));
  }
  await waitUntil(async () => ((await openFdsOn(path)) === 0 ? true : undefined), 'every fd on the served file closed');
});

test('a refused open gives its fd back: a folder, a FIFO, a 416, an empty file', async () => {
  // Each of these opens the path and then refuses (or sends no body): the fd
  // is closed in the route itself, before the answer, so no wait is needed.
  const dir = join(work(), 'fd-album.png');
  await mkdir(dir);
  const fifo = join(work(), 'fd-pipe.mp4');
  execFileSync('mkfifo', [fifo]);
  assert.equal((await askTicket(dir)).status, 415, 'a folder');
  assert.equal(await openFdsOn(dir), 0, 'no fd left on the folder');
  assert.equal((await askTicket(fifo)).status, 415, 'a FIFO');
  assert.equal(await openFdsOn(fifo), 0, 'no fd left on the FIFO');
  const path = await plantMedia('fd-range.png', pattern(50));
  const t = (await ticketFor(path)).ticket;
  assert.equal((await getMedia(path, t, { range: 'bytes=50-' })).status, 416);
  assert.equal(await openFdsOn(path), 0, 'no fd left after a 416');
  const empty = await plantMedia('fd-empty.gif', Buffer.alloc(0));
  assert.equal((await getMedia(empty, (await ticketFor(empty)).ticket)).status, 200);
  assert.equal(await openFdsOn(empty), 0, 'no fd left after an empty body');
});

test('no refusal writes the path, the name or the ticket into server.log', async () => {
  const name = 'refused-secret-name.png';
  const path = await plantMedia(name, pattern(20));
  const other = await plantMedia('refused-other.png', pattern(20));
  const t = (await ticketFor(path)).ticket;
  assert.equal((await getMedia(path, t, { range: 'bytes=99-' })).status, 416);
  assert.equal((await getMedia(other, t)).status, 403, 'a ticket on another path');
  await rm(path);
  assert.equal((await getMedia(path, t)).status, 404);
  assert.equal((await askTicket(path)).status, 404);
  const dir = join(work(), 'refused-secret-dir.svg');
  await mkdir(dir);
  assert.equal((await askTicket(dir)).status, 415);
  const log = await waitForLogQuiet(server);
  for (const secret of [t, name, 'refused-other.png', 'refused-secret-dir', encodeURIComponent(path)]) {
    assert.ok(!log.includes(secret), `server.log names ${secret.slice(0, 24)}`);
  }
});
