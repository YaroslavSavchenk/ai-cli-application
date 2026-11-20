/**
 * Backpressure on the pty-host's output path — Nocturne D9 P2
 * (`.claude/plans/nocturne/PLAN-D9.md` § Defaults, § Risks): an owner that
 * stops reading makes the host pause every PTY (its socket backlog over
 * 8 MiB) and resume on drain, and not one byte is lost or reordered; a PTY
 * that ENDS while paused still delivers what its read stream had buffered
 * (server/pty-table.ts: the final-output rescue flushes a paused stream before
 * it drains the fd — the node-pty 1.1.0 order the P1 review asked about).
 *
 * How: a real pty-host child with a raw owner connection that pauses its own
 * socket (`tests/helpers/pty-host-fixture.ts`), over `seq` in a real PTY; the
 * paused-exit case on `PtyTable` in this process, where the pause can be set
 * before the PTY's first byte.
 *
 * Why it matters: without the pause, a stalled backend makes the pty-host
 * buffer output without bound; with a pause that loses a stream's buffer at
 * exit, the session's last screen — the one the user comes back to — is gone.
 *
 * Also (D9 P2 test gate): the pause is lifted when the stalled owner is taken
 * over or drops (never paused without an owner); a pty spawned while paused,
 * and one being killed, are paused too.
 *
 * NOT claimed: the backend's own WebSocket backpressure (unchanged by D9).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PtyTable, type PtyExitRecord } from '../../server/pty-table.ts';
import { encodeInput } from '../../server/pty-host-wire.ts';
import { sleep, waitUntil } from '../helpers/helpers.ts';
import { connectPtyHost, probePtyHost } from '../../server/pty-host-client.ts';
import { ENV, RawConn, hostLog, startHost, teardownHosts, trackPty } from '../helpers/pty-host-fixture.ts';

after(async () => {
  await teardownHosts();
});

/** Lines of `seq`: ~15.9 MB through the PTY, about twice the 8 MiB pause limit. */
const SEQ_LINES = 2_000_000;

function seqText(n: number): string {
  const lines: string[] = [];
  for (let i = 1; i <= n; i++) lines.push(`${i}\r\n`);
  return lines.join('');
}

test('a stalled owner pauses every pty, the drain resumes them, and no byte is lost', async () => {
  const h = await startHost();
  const owner = new RawConn(h.dataDir);
  owner.hello(h.file.token);
  await owner.message('welcome');
  const id = randomUUID();
  // Waits for one line of input, so the flood starts only once this side has stopped reading.
  owner.send({ t: 'spawn', id, file: 'bash', argv: ['-c', `read go; seq 1 ${SEQ_LINES}`], cwd: '/', env: ENV, cols: 80, rows: 24 });
  const { pid } = await owner.message('spawned');
  trackPty(pid);

  owner.sock.pause();
  for (const f of encodeInput(id, 'go\r')) owner.sock.write(f);
  await waitUntil(
    () => (/paused every pty \(pause #1\)/.test(hostLog(h.dataDir)) ? true : undefined),
    'the host to pause its ptys',
    60_000,
  );
  owner.sock.resume();
  await waitUntil(() => owner.messages().find((m) => m.t === 'exit'), 'the exit after the flood', 120_000);
  assert.match(hostLog(h.dataDir), /resumed every pty after \d+ms \(pause #1\)/);

  let expected = 0;
  const parts: string[] = [];
  let exitIndex = -1;
  owner.frames.forEach((f, i) => {
    if (f.kind === 'control' && (f.message as { t?: unknown }).t === 'exit') exitIndex = i;
    if (f.kind !== 'output' || f.id !== id) return;
    assert.equal(f.offset, expected, `chunk ${i} starts where the previous one ended`);
    assert.equal(exitIndex, -1, 'no output after the exit');
    expected += Buffer.byteLength(f.text);
    parts.push(f.text);
  });
  const text = parts.join('');
  const want = seqText(SEQ_LINES);
  assert.ok(text.endsWith(want), `every line of seq arrived, in order (got ${text.length} chars)`);
  assert.ok(text.length - want.length < 64, 'nothing but the echoed `go` line before it');
});

test('a pty that ends while paused still delivers what its stream had buffered, before its exit', async () => {
  const events: string[] = [];
  let exit: PtyExitRecord | undefined;
  const table = new PtyTable(() => {}, {
    output: (_id, data) => events.push(data),
    exit: (_id, record) => {
      events.push('<exit>');
      exit = record;
    },
  });
  table.setPaused(true); // before the first byte: everything goes through the paused stream
  const { pid } = table.spawn({
    id: 'paused',
    file: 'bash',
    argv: ['-c', "printf 'A%.0s' $(seq 1 3000); echo END"],
    cwd: '/',
    env: ENV,
    cols: 80,
    rows: 24,
  });
  trackPty(pid);
  await waitUntil(() => exit, 'the paused pty to report its exit');
  assert.equal(events.at(-1), '<exit>', 'the exit comes last');
  assert.equal(events.slice(0, -1).join(''), `${'A'.repeat(3000)}END\r\n`, 'every byte, in order');
});

test('resuming a paused pty delivers the held output with continuous offsets', async () => {
  const chunks: { data: string; offset: number }[] = [];
  let exit: PtyExitRecord | undefined;
  const table = new PtyTable(() => {}, {
    output: (_id, data, offset) => chunks.push({ data, offset }),
    exit: (_id, record) => {
      exit = record;
    },
  });
  const { pid } = table.spawn({
    id: 'resume',
    file: 'bash',
    argv: ['-c', 'read go; seq 1 20000'],
    cwd: '/',
    env: ENV,
    cols: 80,
    rows: 24,
  });
  trackPty(pid);
  table.setPaused(true);
  table.write('resume', 'go\r');
  table.setPaused(false);
  await waitUntil(() => exit, 'the exit');
  let expected = 0;
  for (const c of chunks) {
    assert.equal(c.offset, expected, 'continuous');
    expected += Buffer.byteLength(c.data);
  }
  assert.ok(chunks.map((c) => c.data).join('').endsWith(seqText(20000)), 'all of seq, in order');
});

/** Past the host's goodbye time (`GOODBYE_MS`, 1 s) by a margin: an unread goodbye has been given up on. */
const PAST_GOODBYE_MS = 1000 + 700;

/** A raw owner that has stopped reading while `seq` floods its pty, once the host has paused. */
async function stalledOwner(): Promise<{ h: Awaited<ReturnType<typeof startHost>>; owner: RawConn; id: string }> {
  const h = await startHost();
  const owner = new RawConn(h.dataDir);
  owner.hello(h.file.token);
  await owner.message('welcome');
  const id = randomUUID();
  owner.send({ t: 'spawn', id, file: 'bash', argv: ['-c', `read go; seq 1 ${SEQ_LINES}`], cwd: '/', env: ENV, cols: 80, rows: 24 });
  const { pid } = await owner.message('spawned');
  trackPty(pid);
  owner.sock.pause();
  for (const f of encodeInput(id, 'go\r')) owner.sock.write(f);
  await waitUntil(
    () => (/paused every pty \(pause #1\)/.test(hostLog(h.dataDir)) ? true : undefined),
    'the host to pause its ptys',
    60_000,
  );
  return { h, owner, id };
}

test('a stalled owner taken over: the ptys resume for the new owner and run to the end', async () => {
  const { h, owner, id } = await stalledOwner();
  const next = await connectPtyHost({ dataDir: h.dataDir, takeover: true });
  const takenOver = performance.now();
  const exits = new Set<string>();
  next.listen({ output: () => {}, exit: (exitId) => exits.add(exitId) });
  await waitUntil(() => (exits.has(id) ? true : undefined), 'the flood to finish for the new owner', 120_000);
  assert.match(hostLog(h.dataDir), /resumed every pty after \d+ms \(pause #1\)/);
  // The old owner never read its goodbye (stuck behind the backlog): the host
  // gave up on it after GOODBYE_MS and destroyed the socket, so what is left
  // to read ends without the `bye` — a socket nobody reads is never kept.
  await sleep(Math.max(0, PAST_GOODBYE_MS - (performance.now() - takenOver))); // the host's goodbye time must be over
  owner.sock.resume();
  await owner.closedSoon();
  assert.ok(!owner.messages().some((m) => m.t === 'bye'), 'destroyed, not waited on');
  next.detach();
});

test('a stalled owner that drops: the ptys are resumed, never left paused with no owner', async () => {
  const { h, owner } = await stalledOwner();
  owner.close();
  const probe = await probePtyHost({ dataDir: h.dataDir });
  await waitUntil(
    async () => ((await probe.listCount()).running === 0 ? true : undefined),
    'the flood to run to its end with nobody attached',
    120_000,
  );
  probe.close();
  assert.match(hostLog(h.dataDir), /resumed every pty after \d+ms \(pause #1\)/);
});

/**
 * How long a paused pty must stay silent to count as paused: its first line
 * (an `echo` or a 50 ms tick) arrives within a few ms when it is not.
 */
const SILENT_WHILE_PAUSED_MS = 400;

test('a pty spawned while paused reads nothing until the resume', async () => {
  const chunks: string[] = [];
  const table = new PtyTable(() => {}, { output: (_id, data) => chunks.push(data), exit: () => {} });
  table.setPaused(true);
  const { pid } = table.spawn({ id: 'late', file: 'bash', argv: ['-c', 'echo SPAWNED-PAUSED; read x'], cwd: '/', env: ENV, cols: 80, rows: 24 });
  trackPty(pid);
  try {
    await sleep(SILENT_WHILE_PAUSED_MS); // proving NO output arrives while paused
    assert.deepEqual(chunks, [], 'nothing read while paused');
    table.setPaused(false);
    await waitUntil(() => (chunks.join('').includes('SPAWNED-PAUSED') ? true : undefined), 'the output after the resume');
  } finally {
    table.kill('late', 'now');
  }
});

test('the pause reaches a pty that is being killed but still runs', async () => {
  const chunks: string[] = [];
  const table = new PtyTable(() => {}, { output: (_id, data) => chunks.push(data), exit: () => {} });
  // Ignores the ladder's first SIGHUP, so it keeps writing after the kill.
  const { pid } = table.spawn({
    id: 'dying',
    file: 'bash',
    argv: ['-c', 'trap "" HUP; while :; do echo tick; sleep 0.05; done'],
    cwd: '/',
    env: ENV,
    cols: 80,
    rows: 24,
  });
  trackPty(pid);
  await waitUntil(() => (chunks.join('').includes('tick') ? true : undefined), 'the first tick');
  table.kill('dying', 'ladder'); // SIGHUP now (ignored), SIGTERM in 2 s
  table.setPaused(true);
  const seen = chunks.length;
  await sleep(SILENT_WHILE_PAUSED_MS); // proving NO output arrives while paused (well before the 2 s SIGTERM)
  assert.equal(chunks.length, seen, 'a killed pty is paused too');
  table.setPaused(false);
  await waitUntil(() => (chunks.length > seen ? true : undefined), 'ticks again after the resume');
});
