/**
 * Regression: a session's FINAL output must survive into the scrollback replay.
 *
 * The race these tests pin down lives below node-pty. When the child exits the
 * pty master goes POLLHUP, and libuv short-circuits to a synthetic EOF whenever
 * its previous read was short — without reading again — so whatever the kernel
 * still holds is discarded before it ever reaches `onData`. It is invisible
 * while the reader keeps up and lethal the moment it falls behind, which is why
 * it surfaced as a load-only flake: reattach replayed a scrollback missing its
 * newest bytes, the one thing sessions exist to preserve.
 *
 * These run the real SessionManager in-process (no HTTP/WS server) because the
 * defect is a scheduling race: the test has to be able to stall the reader
 * deterministically instead of hoping the machine is busy. The stall is applied
 * inside the client broadcast — the manager's own hot path — so what is being
 * slowed down is real product work, not an artificial hook. Waiting is a 10 ms
 * poll on the session's own status (`whenExited` below), the same shape as
 * `waitUntil` in tests/helpers.ts: no fixed sleep, no guessed duration — the
 * timer only decides how often the exit condition is checked.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WebSocket } from 'ws';
import type { ServerMessage } from '../shared/protocol.ts';
import { SessionJournal } from '../server/journal.ts';
import { SessionManager } from '../server/sessions.ts';

const silent = (): void => {};

/**
 * Minimal stand-in for the `ws` socket: SessionManager only ever touches
 * readyState/OPEN, send() and on('close'). `blockMs` burns CPU synchronously
 * on every frame, which is precisely what a contended event loop does to the
 * pty reader — the drain falls behind the child and is still behind when the
 * child exits.
 */
class StallingClient {
  readonly OPEN = 1;
  readonly readyState = 1;
  readonly frames: ServerMessage[] = [];
  readonly blockMs: number;
  constructor(blockMs = 0) {
    this.blockMs = blockMs;
  }
  send(raw: string): void {
    this.frames.push(JSON.parse(raw) as ServerMessage);
    if (this.blockMs > 0) {
      const until = Date.now() + this.blockMs;
      while (Date.now() < until) {
        /* block the event loop, exactly as CPU contention does */
      }
    }
  }
  on(): void {}
  text(): string {
    return this.frames
      .map((m) => (m.type === 'replay' || m.type === 'data' ? m.data : ''))
      .join('');
  }
  exitFrames(): Extract<ServerMessage, { type: 'exit' }>[] {
    return this.frames.filter((m): m is Extract<ServerMessage, { type: 'exit' }> => m.type === 'exit');
  }
  asWs(): WebSocket {
    return this as unknown as WebSocket;
  }
}

interface Harness {
  manager: SessionManager;
  cleanup: () => Promise<void>;
}

async function harness(): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'ai-sm-tail-'));
  const journal = new SessionJournal(join(dir, 'journal.json'), join(dir, 'previous.json'), silent);
  return {
    manager: new SessionManager(silent, journal),
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** Resolve once the session's status says the PTY exited; polled, not slept. */
function whenExited(manager: SessionManager, id: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 30_000;
    const poll = setInterval(() => {
      const info = manager.get(id);
      if (info === undefined) {
        clearInterval(poll);
        reject(new Error(`session ${id} vanished`));
        return;
      }
      if (info.status === 'exited') {
        clearInterval(poll);
        resolve(info.exitCode ?? -1);
        return;
      }
      if (Date.now() > deadline) {
        clearInterval(poll);
        reject(new Error(`session ${id} never exited`));
      }
    }, 10);
  });
}

test('final output written just before exit survives into the replay when the reader is stalled', async () => {
  const { manager, cleanup } = await harness();
  try {
    // 32 KiB of padding only to push the reader behind the child; the payload
    // under test is the single small line written immediately before exit.
    const info = manager.create({
      cwd: process.cwd(),
      command: 'bash',
      args: ['-c', "head -c 32768 /dev/zero | tr '\\0' x; echo TAIL_MARK_9f3c"],
      cols: 80,
      rows: 24,
    });
    // 20 ms burnt per broadcast frame keeps the pty drain permanently behind
    // the writer, so the kernel still holds output when the child exits.
    const live = new StallingClient(20);
    assert.equal(manager.attach(info.id, live.asWs()), true);

    const code = await whenExited(manager, info.id);
    assert.equal(code, 0, 'the session must exit cleanly');

    // 1. The live client saw the tail as normal `data`, before the exit frame.
    const liveText = live.text();
    assert.ok(
      liveText.includes('TAIL_MARK_9f3c'),
      'the live client must receive the final output as data',
    );
    const exits = live.exitFrames();
    assert.equal(exits.length, 1, 'exactly one exit frame');
    assert.equal(exits[0]?.exitCode, 0, 'the exit frame must carry exitCode');
    const lastDataIdx = live.frames.map((m) => m.type).lastIndexOf('data');
    const exitIdx = live.frames.map((m) => m.type).indexOf('exit');
    assert.ok(
      lastDataIdx < exitIdx,
      `every data frame must precede the exit frame (last data #${lastDataIdx}, exit #${exitIdx})`,
    );

    // 2. The scrollback a reattaching client replays holds the same tail.
    const reattach = new StallingClient();
    assert.equal(manager.attach(info.id, reattach.asWs()), true);
    const replay = reattach.frames[0];
    assert.equal(replay?.type, 'replay', 'attach must replay first');
    const replayed = replay.type === 'replay' ? replay.data : '';
    const markIdx = replayed.indexOf('TAIL_MARK_9f3c');
    assert.ok(markIdx !== -1, 'the replayed scrollback must contain the final output');
    assert.ok(
      markIdx > replayed.length - 200,
      'the final output must sit at the tail of the replay',
    );

    // 3. attach() ordering after exit is unchanged: replay -> info -> exit.
    assert.deepEqual(
      reattach.frames.map((m) => m.type),
      ['replay', 'info', 'exit'],
      'attach on an exited session: replay, then info, then exit',
    );

    manager.destroy(info.id);
  } finally {
    await cleanup();
  }
});

test('detached session: the final output is buffered even with no client attached at all', async () => {
  const { manager, cleanup } = await harness();
  try {
    const info = manager.create({
      cwd: process.cwd(),
      command: 'bash',
      args: ['-c', "head -c 32768 /dev/zero | tr '\\0' x; echo LONE_MARK_51ab"],
      cols: 80,
      rows: 24,
    });
    const code = await whenExited(manager, info.id);
    assert.equal(code, 0);

    const c = new StallingClient();
    assert.equal(manager.attach(info.id, c.asWs()), true);
    const replay = c.frames[0];
    const replayed = replay?.type === 'replay' ? replay.data : '';
    assert.ok(
      replayed.includes('LONE_MARK_51ab'),
      'output produced while fully detached must still be in the scrollback',
    );
    manager.destroy(info.id);
  } finally {
    await cleanup();
  }
});

test('a rescued tail still raises attention: a BEL in the final output sets the flag', async () => {
  const { manager, cleanup } = await harness();
  try {
    const info = manager.create({
      cwd: process.cwd(),
      command: 'bash',
      args: ['-c', "head -c 32768 /dev/zero | tr '\\0' x; printf 'BELL_MARK_c7\\a'"],
      cols: 80,
      rows: 24,
    });
    const live = new StallingClient(20);
    assert.equal(manager.attach(info.id, live.asWs()), true);
    await whenExited(manager, info.id);

    assert.ok(live.text().includes('BELL_MARK_c7'), 'the final output must arrive');
    assert.equal(
      manager.get(info.id)?.attention,
      true,
      'a bell in the rescued tail must still set attention',
    );
    manager.destroy(info.id);
  } finally {
    await cleanup();
  }
});

/**
 * Loss is only half the contract. The rescue re-reads the pty master fd from a
 * hook on the read stream's teardown, so the OTHER failure mode is emitting
 * bytes node-pty already delivered: the tail would arrive twice, in both the
 * live stream and the scrollback. Nothing above would notice — every existing
 * assertion is an `includes`. This pins the byte count exactly, so a rescue
 * that ever drains from a second hook (or before the reader is finished) fails
 * here instead of silently doubling a user's last screen of output.
 *
 * It also carries the non-zero exit code through the rescued path: the drain
 * runs inside socket teardown, which is what node-pty turns into 'exit'.
 */
test('the rescued tail is delivered EXACTLY once — byte-exact, no duplication, exit code intact', async () => {
  const PAD = 32768;
  const { manager, cleanup } = await harness();
  try {
    const info = manager.create({
      cwd: process.cwd(),
      command: 'bash',
      args: ['-c', `head -c ${PAD} /dev/zero | tr '\\0' x; echo ONCE_MARK_4d1e; exit 7`],
      cols: 80,
      rows: 24,
    });
    const live = new StallingClient(20);
    assert.equal(manager.attach(info.id, live.asWs()), true);

    const code = await whenExited(manager, info.id);
    assert.equal(code, 7, 'a non-zero exit code must survive the rescued teardown');

    const countOf = (hay: string, needle: string): number => hay.split(needle).length - 1;

    // Live stream: the marker once, and exactly the padding that was written.
    const liveText = live.text();
    assert.equal(countOf(liveText, 'ONCE_MARK_4d1e'), 1, 'live: the marker must arrive exactly once');
    assert.equal(countOf(liveText, 'x'), PAD, `live: exactly ${PAD} padding bytes, no loss and no replay`);

    // Scrollback: same, and it is what a reattaching client is promised.
    const reattach = new StallingClient();
    assert.equal(manager.attach(info.id, reattach.asWs()), true);
    const replay = reattach.frames[0];
    assert.equal(replay?.type, 'replay');
    const replayed = replay.type === 'replay' ? replay.data : '';
    assert.equal(countOf(replayed, 'ONCE_MARK_4d1e'), 1, 'replay: the marker must appear exactly once');
    assert.equal(countOf(replayed, 'x'), PAD, `replay: exactly ${PAD} padding bytes`);
    assert.equal(
      reattach.exitFrames()[0]?.exitCode,
      7,
      'the exit frame replayed on attach must carry the real code',
    );

    manager.destroy(info.id);
  } finally {
    await cleanup();
  }
});

/**
 * The rescue reads raw bytes off the fd and decodes them itself, so the seam
 * between what node-pty's decoder already consumed and what we read is a real
 * place to corrupt text. Terminal output is routinely non-ASCII (box drawing,
 * spinners, CJK), so a tail that arrives as replacement characters is still a
 * broken promise even though no bytes were "lost". 6000 bytes of 3-byte
 * characters guarantee the read boundary lands inside a character.
 */
test('a multi-byte UTF-8 tail is rescued without corruption (no replacement characters)', async () => {
  const GLYPHS = 2000; // U+2713 is 3 bytes -> 6000 bytes of multi-byte tail
  const { manager, cleanup } = await harness();
  try {
    const info = manager.create({
      cwd: process.cwd(),
      command: 'bash',
      args: [
        '-c',
        `head -c 32768 /dev/zero | tr '\\0' x; printf '\\u2713%.0s' $(seq ${GLYPHS}); echo UTF_MARK_8b2`,
      ],
      cols: 80,
      rows: 24,
    });
    const live = new StallingClient(20);
    assert.equal(manager.attach(info.id, live.asWs()), true);
    assert.equal(await whenExited(manager, info.id), 0);

    const reattach = new StallingClient();
    assert.equal(manager.attach(info.id, reattach.asWs()), true);
    const replay = reattach.frames[0];
    const replayed = replay?.type === 'replay' ? replay.data : '';

    assert.ok(replayed.includes('UTF_MARK_8b2'), 'the tail marker must survive');
    assert.equal(
      (replayed.match(/✓/gu) ?? []).length,
      GLYPHS,
      'every multi-byte character must survive the rescue, none dropped or duplicated',
    );
    assert.equal(
      (replayed.match(/�/gu) ?? []).length,
      0,
      'no U+FFFD: the rescue must not split a multi-byte character across its decode boundary',
    );

    manager.destroy(info.id);
  } finally {
    await cleanup();
  }
});
