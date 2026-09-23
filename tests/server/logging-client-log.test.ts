/**
 * POST /api/client-log (2026-09-06, "everything gets logged") — the route that
 * carries the browser's own diagnostics into server.log: auth, Host parity,
 * 204, one `[client]` line per entry, the size cap (413, nothing written),
 * the entry cap, message truncation, control-character stripping (no forged
 * second line) and the per-minute budget with ONE warn — including the budget
 * window RESETTING.
 *
 * How: a real server child (`startTestServer`) for the route; for the window
 * reset, the production request handler mounted in THIS process on a real
 * HTTP server with an injected clock, because the budget cannot be moved past
 * a real minute from a spawned server without waiting one.
 *
 * Why: the endpoint writes attacker-reachable text into the only diagnostic
 * file a detached backend has — an unbounded or unstripped entry could flood
 * or forge the log.
 *
 * NOT claimed here: the logger, banner, access and ws logs —
 * `tests/server/logging.test.ts`; leak canaries and refusal budgets —
 * `tests/server/logging-hardening.test.ts`; the browser side that posts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLIENT_LOG_MAX_BYTES,
  CLIENT_LOG_MAX_ENTRIES,
  CLIENT_LOG_MAX_MESSAGE,
  CLIENT_LOG_MAX_PER_MINUTE,
} from '../../server/api.ts';
import {
  rawRequest,
  readServerLog,
  startTestServer,
  waitForLog,
  waitUntil,
} from '../helpers/helpers.ts';
import { postClientLog, withInProcessApi } from '../helpers/logging-fixture.ts';

// ---------------------------------------------------------------------------
// 5. POST /api/client-log
// ---------------------------------------------------------------------------

test('POST /api/client-log: authed, 204, and each entry becomes ONE [client] line', async () => {
  const server = await startTestServer();
  try {
    // Auth and origin parity with every other state-changing route.
    assert.equal((await postClientLog(server, { entries: [] }, { token: '' })).status, 401);
    assert.equal((await postClientLog(server, { entries: [] }, { token: 'wrong' })).status, 401);
    assert.equal(
      (await postClientLog(server, { entries: [] }, { origin: 'http://evil.example' })).status,
      403,
    );
    // Wrong method / wrong shape.
    const put = await rawRequest(server.port, {
      method: 'PUT',
      path: '/api/client-log',
      headers: { 'x-auth-token': server.token, 'content-type': 'application/json' },
      body: '{"entries":[]}',
    });
    assert.equal(put.status, 405);
    assert.equal((await postClientLog(server, { entries: 'nope' })).status, 400);
    assert.equal((await postClientLog(server, '{not json')).status, 400);

    const at = '2026-09-06T10:11:12.000Z';
    const res = await postClientLog(server, {
      entries: [
        { level: 'debug', at, message: 'CL-DEBUG' },
        { level: 'info', at, message: 'CL-INFO' },
        { level: 'warn', at, message: 'CL-WARN' },
        { level: 'error', at, message: 'CL-ERROR' },
        { level: 'trace', at, message: 'CL-UNKNOWN-LEVEL' },
        { level: 'info', at: 'not-a-date', message: 'CL-BAD-AT' },
        { message: 'CL-NO-FIELDS' },
      ],
    });
    assert.equal(res.status, 204, 'a batch is answered 204');
    assert.equal(res.body, '', 'with an empty body');

    const log = await waitForLog(server, 'CL-ERROR');
    assert.ok(log.includes(`[debug] [client] CL-DEBUG (client at ${at})`));
    assert.ok(log.includes(`[info] [client] CL-INFO (client at ${at})`));
    assert.ok(log.includes(`[warn] [client] CL-WARN (client at ${at})`));
    assert.ok(log.includes(`[error] [client] CL-ERROR (client at ${at})`));
    assert.ok(
      log.includes(`[info] [client] CL-UNKNOWN-LEVEL (client at ${at})`),
      'an unknown level becomes info',
    );
    // An invalid `at` falls back to SERVER time — never the raw string.
    assert.ok(!log.includes('not-a-date'));
    assert.match(log, /\[client\] CL-BAD-AT \(client at \d{4}-\d{2}-\d{2}T/);
    assert.match(log, /\[client\] CL-NO-FIELDS \(client at \d{4}-/);
  } finally {
    await server.stop();
  }
});

test('POST /api/client-log: size cap 413, entry cap, message truncation, control-character stripping', async () => {
  const server = await startTestServer();
  try {
    // 1. Body cap — refused before it is parsed, let alone logged.
    const huge = await postClientLog(server, {
      entries: [{ level: 'info', at: new Date().toISOString(), message: 'x'.repeat(CLIENT_LOG_MAX_BYTES) }],
    });
    assert.equal(huge.status, 413);
    assert.deepEqual(JSON.parse(huge.body), { error: 'request body is too large' });

    // 2. Entry cap — the first CLIENT_LOG_MAX_ENTRIES are kept, the rest dropped.
    const many = Array.from({ length: CLIENT_LOG_MAX_ENTRIES + 10 }, (_, i) => ({
      level: 'info' as const,
      at: new Date().toISOString(),
      message: `CAP-ENTRY-${i}`,
    }));
    assert.equal((await postClientLog(server, { entries: many })).status, 204);
    const capped = await waitForLog(server, `CAP-ENTRY-${CLIENT_LOG_MAX_ENTRIES - 1}`);
    assert.ok(capped.includes('CAP-ENTRY-0'));
    assert.ok(
      !capped.includes(`CAP-ENTRY-${CLIENT_LOG_MAX_ENTRIES}`),
      `entry ${CLIENT_LOG_MAX_ENTRIES} (0-based) is past the cap and must be dropped`,
    );
    assert.ok(capped.includes(`batch of ${CLIENT_LOG_MAX_ENTRIES + 10} entries truncated to ${CLIENT_LOG_MAX_ENTRIES}`));

    // 3. Message truncation — truncate, never reject.
    const long = `TRUNC-${'A'.repeat(4000)}`;
    assert.equal((await postClientLog(server, { entries: [{ level: 'info', at: '', message: long }] })).status, 204);
    const truncated = await waitForLog(server, 'TRUNC-A');
    const line = truncated.split('\n').find((l) => l.includes('TRUNC-A')) as string;
    const payload = line.slice(line.indexOf('TRUNC-'), line.lastIndexOf(' (client at '));
    assert.equal(payload.length, CLIENT_LOG_MAX_MESSAGE, 'the message is cut at the cap');

    // 4. Control characters — a newline must not forge a second log line.
    // A run of control characters: newline (would forge a line), NUL and tab.
    const forged = 'FORGE-START\n2026-01-01T00:00:00.000Z [error] FORGED-LINE\u0000\ttail';
    assert.equal((await postClientLog(server, { entries: [{ level: 'info', at: '', message: forged }] })).status, 204);
    const stripped = await waitForLog(server, 'FORGE-START');
    const forgedLine = stripped.split('\n').find((l) => l.includes('FORGE-START')) as string;
    assert.ok(
      forgedLine.includes('FORGE-START 2026-01-01T00:00:00.000Z [error] FORGED-LINE tail'),
      `the whole message stays on ONE line: ${JSON.stringify(forgedLine)}`,
    );
    assert.equal(
      stripped.split('\n').filter((l) => l.includes('FORGED-LINE')).length,
      1,
      'exactly one line mentions the forged text',
    );
  } finally {
    await server.stop();
  }
});

test('POST /api/client-log: past the per-minute budget entries are dropped with ONE warn', async () => {
  const server = await startTestServer();
  try {
    const batches = Math.ceil((CLIENT_LOG_MAX_PER_MINUTE + CLIENT_LOG_MAX_ENTRIES) / CLIENT_LOG_MAX_ENTRIES);
    let sent = 0;
    for (let b = 0; b < batches; b += 1) {
      const entries = Array.from({ length: CLIENT_LOG_MAX_ENTRIES }, () => ({
        level: 'info' as const,
        at: new Date().toISOString(),
        message: `FLOOD-${sent++}`,
      }));
      assert.equal((await postClientLog(server, { entries })).status, 204, 'flooding is never an error');
    }
    assert.ok(sent > CLIENT_LOG_MAX_PER_MINUTE, `sent ${sent} entries, over the budget`);

    const log = await waitUntil(
      async () => {
        const text = await readServerLog(server);
        return text.includes('rate limit reached') ? text : undefined;
      },
      'the client-log rate-limit warn line',
    );
    const written = log.split('\n').filter((l) => l.includes('[client] FLOOD-')).length;
    assert.equal(written, CLIENT_LOG_MAX_PER_MINUTE, 'exactly the budget is written, the rest dropped');
    assert.equal(
      log.split('\n').filter((l) => l.includes('rate limit reached')).length,
      1,
      'one warn per window, not one per dropped entry',
    );
    assert.match(log, /\[warn\] \[client\] rate limit reached \(200 entries\/minute\)/);
  } finally {
    await server.stop();
  }
});

// ---------------------------------------------------------------------------
// 6. Gaps closed by the test gate (2026-09-06)

test('POST /api/client-log: a forbidden Host is 403, in parity with every other authed route', async () => {
  const server = await startTestServer();
  try {
    const body = JSON.stringify({ entries: [{ level: 'info', at: '', message: 'HOST-CANARY' }] });
    for (const host of [`evil.example.com:${server.port}`, '127.0.0.1', 'localhost']) {
      const res = await rawRequest(server.port, {
        method: 'POST',
        path: '/api/client-log',
        headers: { host, 'x-auth-token': server.token, 'content-type': 'application/json' },
        body,
      });
      assert.equal(res.status, 403, `Host ${JSON.stringify(host)} must be refused`);
    }
    // The same request with the right Host is accepted — so the 403s above are
    // the Host check biting, not a broken request shape.
    const ok = await rawRequest(server.port, {
      method: 'POST',
      path: '/api/client-log',
      headers: {
        host: `127.0.0.1:${server.port}`,
        'x-auth-token': server.token,
        'content-type': 'application/json',
      },
      body,
    });
    assert.equal(ok.status, 204);

    const log = await waitForLog(server, 'HOST-CANARY');
    assert.equal(
      log.split('\n').filter((l) => l.includes('HOST-CANARY')).length,
      1,
      'only the accepted request wrote a line — a refused Host logs nothing of the body',
    );
  } finally {
    await server.stop();
  }
});

test('POST /api/client-log: an oversized body is 413 and NOTHING from it is written', async () => {
  const server = await startTestServer();
  try {
    // The canary sits at the FRONT of the body, inside the first chunk the
    // server reads, so anything that logged what it read would show it.
    const oversized =
      '{"entries":[{"level":"info","at":"","message":"OVERSIZE_CANARY_a1b2c3' +
      'x'.repeat(CLIENT_LOG_MAX_BYTES + 1024) +
      '"}]}';
    assert.ok(Buffer.byteLength(oversized) > CLIENT_LOG_MAX_BYTES);
    const res = await rawRequest(server.port, {
      method: 'POST',
      path: '/api/client-log',
      headers: { 'x-auth-token': server.token, 'content-type': 'application/json' },
      body: oversized,
    });
    assert.equal(res.status, 413);
    assert.deepEqual(JSON.parse(res.body), { error: 'request body is too large' });

    // The access-log line for the refused request proves the log is current.
    const log = await waitForLog(server, '[http] POST /api/client-log -> 413');
    assert.ok(!log.includes('OVERSIZE_CANARY_a1b2c3'), 'no fragment of the body is ever logged');
    assert.ok(!log.includes('xxxxxxxxxx'), 'not even filler bytes from the body');
  } finally {
    await server.stop();
  }
});

test('POST /api/client-log: CR, ESC, NUL and DEL cannot forge a second log line', async () => {
  const server = await startTestServer();
  try {
    // Every control character the gate names, in one message: a CRLF pair
    // (would forge a line), a bare CR, ESC (would inject a terminal escape into
    // whatever cats the file), NUL and DEL.
    const forged =
      'CRLF-CANARY\r\n2026-01-01T00:00:00.000Z [info] [boot] FORGED-BOOT-LINE' +
      '\rCARRIAGE\u001b[2J\u001b]0;title\u0007ESCAPED \u0000NUL\u007fDEL' +
      // C1 and the Unicode separators: U+0085 NEL is a line break to a pager,
      // U+009B is a single-byte CSI (an escape sequence with no ESC in front),
      // and U+2028/U+2029 end a line for anything that splits on them.
      '\u0085NEL\u009b31mCSI\u2028LS\u2029PS';
    assert.equal(
      (await postClientLog(server, { entries: [{ level: 'info', at: '', message: forged }] }))
        .status,
      204,
    );
    const log = await waitForLog(server, 'CRLF-CANARY');
    const lines = log.split('\n').filter((l) => l.includes('CANARY') || l.includes('FORGED'));
    assert.equal(lines.length, 1, `the whole message stays on ONE line: ${JSON.stringify(lines)}`);

    const line = lines[0] as string;
    // Shaped by the server: its own timestamp, its own level, its own tag.
    assert.match(line, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[info\] \[client\] /);
    assert.equal(
      log.split('\n').filter((l) => l.startsWith('2026-01-01T00:00:00.000Z')).length,
      0,
      'the payload never becomes a line that reads as the server own [boot] output',
    );
    assert.ok(line.includes('CRLF-CANARY '), 'CRLF became a space');
    assert.ok(line.includes(' CARRIAGE'), 'a bare CR became a space');
    assert.ok(line.includes('ESCAPED '), 'the tail survived as text');
    assert.ok(line.includes('NUL'), 'NUL became a space');
    assert.ok(line.includes('DEL'), 'DEL became a space');
    assert.ok(line.includes(' NEL'), 'U+0085 NEL became a space');
    assert.ok(line.includes(' 31mCSI'), 'U+009B (single-byte CSI) became a space');
    assert.ok(line.includes(' LS') && line.includes(' PS'), 'U+2028/U+2029 became spaces');
    assert.ok(
      !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(line),
      'not one control character survives — the file stays safe to cat',
    );
  } finally {
    await server.stop();
  }
});

// ---------------------------------------------------------------------------
// 9. The client-log rate-limit WINDOW (the gap the last gate reported open)
// ---------------------------------------------------------------------------

// The in-process harness (withInProcessApi) is in helpers/logging-fixture.ts:
// the budget's clock cannot be moved in a spawned server.

test('client-log budget: the window RESETS — the next minute gets a fresh budget and a fresh warn', async () => {
  await withInProcessApi(async (ctx) => {
    const post = async (messages: string[]): Promise<number> => {
      const res = await rawRequest(ctx.port, {
        method: 'POST',
        path: '/api/client-log',
        headers: { 'x-auth-token': ctx.token, 'content-type': 'application/json' },
        body: JSON.stringify({
          entries: messages.map((message) => ({ level: 'info', at: '', message })),
        }),
      });
      return res.status;
    };
    const countLines = (needle: string): number =>
      ctx.readLog().split('\n').filter((l) => l.includes(needle)).length;

    // --- window 1: fill the budget and overrun it by 10 ---------------------
    let sent = 0;
    while (sent < CLIENT_LOG_MAX_PER_MINUTE + 10) {
      const batch = Math.min(CLIENT_LOG_MAX_ENTRIES, CLIENT_LOG_MAX_PER_MINUTE + 10 - sent);
      assert.equal(
        await post(Array.from({ length: batch }, (_, i) => `W1-${sent + i}`)),
        204,
        'flooding is never an error',
      );
      sent += batch;
    }
    assert.equal(countLines('[client] W1-'), CLIENT_LOG_MAX_PER_MINUTE, 'exactly the budget');
    assert.equal(countLines('rate limit reached'), 1, 'one warn for this window');
    assert.equal(countLines('[client] W1-209'), 0, 'the overrun really was dropped');

    // --- still the same window: nothing more gets through -------------------
    assert.equal(await post(['W1-LATE']), 204);
    assert.equal(countLines('[client] W1-LATE'), 0, 'the budget still holds');
    assert.equal(countLines('rate limit reached'), 1, 'and the warn is NOT repeated');

    // --- window 2: move the INJECTED clock past the window ------------------
    ctx.advance(61_000);
    assert.equal(await post(['W2-FIRST']), 204);
    assert.equal(countLines('[client] W2-FIRST'), 1, 'a fresh window logs again');
    assert.equal(
      countLines('client log entr(ies) in the last window'),
      1,
      'the rolled-over window states the total it did not show',
    );

    // --- window 2 can be exhausted on its own, with its own warn ------------
    let sent2 = 0;
    while (sent2 < CLIENT_LOG_MAX_PER_MINUTE + 5) {
      const batch = Math.min(CLIENT_LOG_MAX_ENTRIES, CLIENT_LOG_MAX_PER_MINUTE + 5 - sent2);
      assert.equal(await post(Array.from({ length: batch }, (_, i) => `W2-${sent2 + i}`)), 204);
      sent2 += batch;
    }
    // 1 (W2-FIRST) + the budget minus that one = the budget for this window.
    assert.equal(
      countLines('[client] W2-') ,
      CLIENT_LOG_MAX_PER_MINUTE,
      'the second window gets its OWN full budget, no more',
    );
    assert.equal(countLines('rate limit reached'), 2, 'one warn per window, and this is a new one');
  });
});
