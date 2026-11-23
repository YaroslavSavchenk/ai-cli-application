/**
 * The attach replay's tail cut — PLAN-QUALITY P1 (2026-09-23): an attach sends
 * only the last REPLAY_MAX_LINES lines of the 1 MiB scrollback ring, cut right
 * after a newline (`replayTail`, server/sessions-output.ts), because the
 * browser terminal keeps only SCROLLBACK_LINES plus one screen.
 *
 * How: the cut rule is a pure function, called directly on rings; the wire
 * claim (the replay frame holds the LAST lines, not the first, and the log
 * states the bytes actually sent) runs on a real server child with a real PTY.
 * The web terminal's use of the shared constant is pinned by a source read —
 * the drift it prevents is an import, not a behaviour the fake DOM can see.
 *
 * Why it matters: an off-by-one or a cut before the newline replays a stray
 * line break or half a line into every pane on every attach; a cut that
 * silently stops working sends the whole 1 MiB again (P0: ~1.28 MB of JSON
 * per pane, 0.8–1.1 s on a 4-pane tab switch) with nothing visibly wrong.
 *
 * NOT claimed: how xterm.js renders the shortened replay, or that a TUI's
 * modes survive the cut (they do not, by design — see replayTail's comment).
 * The browser side is `/verify-terminal` (.claude/skills/verify-terminal/SKILL.md).
 *
 * PLAN-QUALITY Q12 made the cut walk the ring's chunks backwards instead of
 * copying the whole ring first; `cut` feeds every text both as one chunk and
 * as 7-byte chunks (seams inside characters, as a restored mirror has), and
 * one test pins the new walk to the old whole-buffer cut on random rings.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';
import { REPLAY_MAX_LINES, SCROLLBACK_LINES } from '../../shared/protocol.ts';
import { replayTail } from '../../server/sessions-output.ts';
import { RingBuffer, SCROLLBACK_MAX_BYTES } from '../../server/pty-table.ts';
import {
  api,
  createSession,
  makeTempDir,
  readSource,
  removeTempDir,
  startTestServer,
  waitForLog,
  wsUrl,
  WsClient,
  type TestServer,
} from '../helpers/helpers.ts';

/** `count` numbered lines `L1\n` … `L<count>\n` (each ends with `eol`). */
function numbered(count: number, eol = '\n'): string {
  let out = '';
  for (let i = 1; i <= count; i++) out += `L${i}${eol}`;
  return out;
}

/** A ring holding `bytes` in chunks of `size` bytes (seams may split a character). */
function ringOf(bytes: Buffer, size: number): RingBuffer {
  const ring = new RingBuffer(SCROLLBACK_MAX_BYTES);
  for (let at = 0; at < bytes.byteLength; at += size) ring.append(bytes.subarray(at, at + size));
  return ring;
}

/** The replay of `text`, which must not depend on where the ring's chunks begin. */
function cut(text: string, maxLines: number): string {
  const bytes = Buffer.from(text, 'utf8');
  const whole = replayTail(ringOf(bytes, Math.max(1, bytes.byteLength)), maxLines);
  const seamed = replayTail(ringOf(bytes, 7), maxLines);
  assert.deepEqual(seamed, whole, `7-byte chunks cut ${JSON.stringify(text.slice(0, 40))} as one chunk does`);
  return whole.toString('utf8');
}

/** The cut before Q12, on the whole ring copied into one buffer: the oracle. */
function wholeBufferCut(ring: Buffer, maxLines: number): Buffer {
  let pos = ring.byteLength;
  for (let i = 0; i < maxLines; i++) {
    const nl = pos === 0 ? -1 : ring.lastIndexOf(0x0a, pos - 1);
    if (nl === -1) return ring;
    pos = nl;
  }
  return ring.subarray(pos + 1);
}

/** A seeded PRNG (mulberry32): the random rings are the same on every run. */
function prng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('a ring with no more lines than the limit is replayed whole, byte for byte', () => {
  // 9 newlines = 10 lines (the last one empty, where the cursor is): exactly at the limit.
  const atLimit = numbered(9);
  assert.equal(cut(atLimit, 10), atLimit, '10 lines with a limit of 10 must be sent whole');
  const short = 'L1\nL2\nprompt$ ';
  assert.equal(cut(short, 10), short, 'fewer lines than the limit must be sent whole');
  assert.equal(cut('', 10), '', 'an empty ring replays nothing');
  const ring = ringOf(Buffer.from(atLimit), 4);
  assert.deepEqual(replayTail(ring, 10), ring.toBuffer(), 'the fallback is the whole ring, byte for byte');
});

test('the chunk walk replays exactly what the whole-buffer cut did, on random rings that wrapped', () => {
  const rand = prng(12);
  const pieces = ['a', 'é', '€', '😀', '\n', '\r\n', '\x1b[31m', 'line '];
  for (let round = 0; round < 60; round++) {
    // A small cap so most rounds wrap; every chunk is whole characters, as the host sends them.
    const ring = new RingBuffer(64 + Math.floor(rand() * 2048));
    if (round % 3 === 0) {
      // A restored mirror: its slices are cut on bytes, inside characters too.
      let seed = '';
      while (Buffer.byteLength(seed) < 3000) seed += pieces[Math.floor(rand() * pieces.length)];
      ring.restore(Buffer.from(seed, 'utf8'), 10_000);
    }
    // Every fifth round long enough that the ring compacts its trimmed chunks (1024+ of them).
    const appends = Math.floor(rand() * (round % 5 === 0 ? 6000 : 400));
    for (let i = 0; i < appends; i++) {
      let chunk = '';
      const len = 1 + Math.floor(rand() * (rand() < 0.1 ? 300 : 12));
      for (let k = 0; k < len; k++) chunk += pieces[Math.floor(rand() * pieces.length)];
      ring.append(Buffer.from(chunk, 'utf8'));
    }
    for (const maxLines of [0, 1, 2, 3, 10, 50, 5000]) {
      assert.deepEqual(
        replayTail(ring, maxLines),
        wholeBufferCut(ring.toBuffer(), maxLines),
        `round ${round}, ${ring.byteLength} ring bytes, ${maxLines} lines`,
      );
    }
  }
});

test('a ring with more lines than the limit replays exactly the last N lines, starting after a newline', () => {
  // 20 newlines = 21 lines; the last 10 are L12..L20 plus the empty cursor line.
  const out = cut(numbered(20), 10);
  assert.equal(out, 'L12\nL13\nL14\nL15\nL16\nL17\nL18\nL19\nL20\n', 'the tail must hold exactly the last 10 lines');
  assert.equal(out.split('\n').length, 10, 'N lines means N-1 newlines plus the cursor line');
  assert.ok(!out.startsWith('\n'), 'the cut is AFTER the newline, never before it');
  // One line over the limit drops exactly the first line.
  assert.equal(cut(numbered(10), 10), numbered(10).slice('L1\n'.length), '11 lines at a limit of 10 drop only L1');
  // An unterminated last line (a prompt) counts as the cursor line.
  assert.equal(cut(`${numbered(5)}prompt$ `, 3), 'L4\nL5\nprompt$ ', 'a trailing partial line is one of the N');
});

test('a ring with no newline in the tail falls back to the whole ring (bounded by the 1 MiB cap)', () => {
  // One long line with no newline anywhere: no safe cut point exists, so the
  // ring is sent whole — the pre-P1 behaviour, never a cut inside the line.
  const oneLine = 'x'.repeat(64 * 1024);
  assert.equal(cut(oneLine, 10), oneLine, 'a newline-free ring must be sent whole');
  // Newlines only at the far start, then one long line: fewer than N lines, whole ring.
  const headThenLong = `a\nb\n${'y'.repeat(64 * 1024)}`;
  assert.equal(cut(headThenLong, 10), headThenLong, 'three lines at a limit of 10 are sent whole');
  // A newline at byte 0 must not wrap the backwards search to the end of the buffer.
  assert.equal(cut('\nabc', 1), 'abc', 'a limit of 1 keeps only the cursor line after the one newline');
  assert.equal(cut('\nabc', 2), '\nabc', 'two lines at a limit of 2 are sent whole');
});

test('CRLF output: the replay starts at the text of a line, its CR stays with the dropped line', () => {
  const out = cut(numbered(20, '\r\n'), 4);
  assert.equal(out, 'L18\r\nL19\r\nL20\r\n', 'CRLF lines are cut after the LF');
  assert.ok(!out.startsWith('\r') && !out.startsWith('\n'), 'no stray CR or LF at the start of a replay');
});

test('multi-byte characters and escape sequences before the cut come through intact', () => {
  const text = `\x1b[31mé€😀\x1b[0m\n\x1b[1mbold ✓\x1b[0m\r\nlast €`;
  assert.equal(cut(text, 2), `\x1b[1mbold ✓\x1b[0m\r\nlast €`, 'the cut lands on a clean line and character');
  assert.ok(!cut(text, 2).includes('\uFFFD'), 'no replacement character from a byte cut');
});

test('the replay limit is the terminal scrollback plus one screen, and the web terminal uses the shared constant', () => {
  assert.equal(SCROLLBACK_LINES, 5000, 'the browser terminal keeps 5000 lines');
  assert.ok(
    REPLAY_MAX_LINES > SCROLLBACK_LINES && REPLAY_MAX_LINES <= SCROLLBACK_LINES + 1000,
    `the replay must cover scrollback plus a screen (got ${REPLAY_MAX_LINES})`,
  );
  const terminal = readSource('web', 'src', 'ui', 'terminal.ts');
  assert.match(
    terminal,
    /import \{[^}]*\bSCROLLBACK_LINES\b[^}]*\} from '\.\.\/\.\.\/\.\.\/shared\/protocol\.ts'/,
    'web/src/ui/terminal.ts must take SCROLLBACK_LINES from shared/protocol.ts',
  );
  assert.ok(!/const SCROLLBACK_LINES\s*=/.test(terminal), 'no local copy of SCROLLBACK_LINES in the web terminal');
  assert.match(terminal, /scrollback: SCROLLBACK_LINES/, 'xterm must be built with the shared scrollback');
});

// ---------------------------------------------------------------------------
// On the wire: a real server child, a real PTY
// ---------------------------------------------------------------------------

let server: TestServer;
let workDir: string;

before(async () => {
  server = await startTestServer();
  workDir = await realpath(await makeTempDir('ai-sm-replay-'));
});

after(async () => {
  if (server !== undefined) await server.stop();
  if (workDir !== undefined) await removeTempDir(workDir);
});

test('attach replays the last REPLAY_MAX_LINES lines of a session with more output than that, not the first', async () => {
  const total = REPLAY_MAX_LINES * 3;
  const info = await createSession(server, {
    command: 'bash',
    args: ['-c', `seq 1 ${total}; printf 'REPLAY_END\\n'`],
    cwd: workDir,
    cols: 80,
    rows: 24,
  });
  // The ring is complete once the exit frame arrives (the final-output rescue
  // runs before 'exit'); attach again for a replay of the finished session.
  const c1 = await WsClient.connect(wsUrl(server, info.id));
  await c1.waitForMessage('exit', { timeoutMs: 30_000 });
  await c1.close();

  const c2 = await WsClient.connect(wsUrl(server, info.id));
  const replay = await c2.waitForMessage('replay');
  assert.equal(c2.messages[0]?.type, 'replay', 'the replay stays the first frame');
  const lines = replay.data.split('\n');
  assert.equal(lines.length, REPLAY_MAX_LINES, `the replay must hold exactly ${REPLAY_MAX_LINES} lines`);
  // From the end: '' (cursor line), 'REPLAY_END\r', `${total}\r`, … so the
  // first replayed line is number total - (REPLAY_MAX_LINES - 3).
  const first = total - (REPLAY_MAX_LINES - 3);
  assert.equal(lines[0], `${first}\r`, `the replay must start at line ${first}, right after a newline`);
  assert.equal(lines[lines.length - 2], 'REPLAY_END\r', 'the newest output is at the tail of the replay');
  assert.ok(!replay.data.startsWith('1\r\n'), 'the oldest lines must not be replayed');
  assert.ok(!/(^|\n)1\r\n2\r\n/.test(replay.data), 'the first lines of the session must be gone from the replay');

  // The WS log states the bytes actually sent, not the ring size.
  const bytes = Buffer.byteLength(replay.data, 'utf8');
  await waitForLog(server, `attached session ${info.id}, replayed ${bytes} scrollback bytes`);
  await c2.close();
  await api(server, 'DELETE', `/api/sessions/${info.id}`);
});

test('attach replays a short session whole, exactly as before the cut existed', async () => {
  const info = await createSession(server, {
    command: 'bash',
    args: ['-c', "seq 1 50; printf 'SHORT_END\\n'"],
    cwd: workDir,
    cols: 80,
    rows: 24,
  });
  const c1 = await WsClient.connect(wsUrl(server, info.id));
  await c1.waitForMessage('exit', { timeoutMs: 30_000 });
  await c1.close();
  const c2 = await WsClient.connect(wsUrl(server, info.id));
  const replay = await c2.waitForMessage('replay');
  assert.ok(replay.data.startsWith('1\r\n2\r\n'), 'a short session replays from its first line');
  assert.ok(replay.data.includes('50\r\nSHORT_END\r\n'), 'and through its last');
  await c2.close();
  await api(server, 'DELETE', `/api/sessions/${info.id}`);
});
