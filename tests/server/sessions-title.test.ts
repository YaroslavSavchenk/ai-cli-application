/**
 * server/sessions.ts — SessionManager.titleIdleSince, the Nocturne C2 fix after
 * the DEV check (.claude/plans/nocturne/PLAN-C2.md § Fix after the DEV check):
 * the one fact a session keeps about its program's window title. Set when a
 * title turns Claude Code's idle mark (`✳ …`), KEPT across the repaints that
 * repeat it and across output with no title in it, cleared by any other title
 * (the spinner, a shell's own, one the scan discards) and at exit, and kept
 * per session; the title text itself goes nowhere — not into SessionInfo, not onto
 * the wire.
 *
 * How: a real SessionManager in-process running a real PTY bash that prints
 * the titles on demand (TITLE_BASH, `tests/helpers/agents-fixture.ts`), with a
 * frame-keeping fake client; each step waits for the marker bash prints after
 * the title, so the title has been scanned by then.
 *
 * Why it matters: the stamp is what the session verdict times its 3 s by. A
 * stamp that moved on every repaint (about every second) would never reach
 * 3 s; one kept after a spinner would call a working Claude idle.
 *
 * NOT claimed here: the byte-level scan (`tests/server/sessions-output-scan.test.ts`);
 * the verdict and `turnEnded` built on the stamp (`tests/server/agents-title.test.ts`);
 * a real Claude Code session (the DEV check,
 * `.claude/plans/nocturne/PLAN-C2.md` § Gates).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sleep, waitUntil } from '../helpers/helpers.ts';
import { FakeClient, TITLE_BASH, makeManager, sendTitle } from '../helpers/agents-fixture.ts';

/**
 * A clock-separation wait (tests/README.md § Time): the stamp is Date.now(),
 * so a stamp that must visibly STAY needs the clock to have moved since it
 * was taken. 5 ms is five ticks.
 */
const STAMP_TICK_MS = 5;

async function withTitleSession(
  fn: (m: Awaited<ReturnType<typeof makeManager>>, id: string, client: FakeClient) => Promise<void>,
): Promise<void> {
  const m = await makeManager();
  try {
    const info = m.manager.create({ command: 'bash', args: TITLE_BASH, cwd: m.root, cols: 80, rows: 24 });
    const client = new FakeClient();
    assert.notEqual(m.manager.attach(info.id, client.asWs()), null);
    await fn(m, info.id, client);
  } finally {
    await m.cleanup();
  }
}

test('C2 title: an idle title stamps the session; the repaints that repeat it KEEP the first stamp', async () => {
  await withTitleSession(async (m, id, client) => {
    assert.equal(m.manager.titleIdleSince(id), undefined, 'no title yet');
    const t0 = Date.now();
    await sendTitle(m.manager, id, client, 'idle');
    const first = m.manager.titleIdleSince(id);
    assert.equal(typeof first, 'number');
    assert.ok((first as number) >= t0 && (first as number) <= Date.now(), 'stamped when the title came');
    for (let i = 0; i < 3; i++) {
      await sleep(STAMP_TICK_MS);
      await sendTitle(m.manager, id, client, 'idle');
      assert.equal(m.manager.titleIdleSince(id), first, `repaint ${i + 1} keeps the stamp`);
    }
  });
});

test('C2 title: a spinner title clears the stamp; the next idle title stamps anew', async () => {
  await withTitleSession(async (m, id, client) => {
    await sendTitle(m.manager, id, client, 'idle');
    const first = m.manager.titleIdleSince(id) as number;
    await sendTitle(m.manager, id, client, 'spin');
    assert.equal(m.manager.titleIdleSince(id), undefined, 'working again');
    await sleep(STAMP_TICK_MS);
    await sendTitle(m.manager, id, client, 'idle');
    const second = m.manager.titleIdleSince(id);
    assert.ok(typeof second === 'number' && second > first, `a new stamp: ${second} after ${first}`);
  });
});

test('C2 title: a shell setting its own title never makes the session idle — and clears an idle stamp', async () => {
  await withTitleSession(async (m, id, client) => {
    await sendTitle(m.manager, id, client, 'plain');
    assert.equal(m.manager.titleIdleSince(id), undefined);
    await sendTitle(m.manager, id, client, 'idle');
    await sendTitle(m.manager, id, client, 'plain');
    assert.equal(m.manager.titleIdleSince(id), undefined);
  });
});

test('C2 title: a title the scan DISCARDS — past the cap, or with a control character — clears an idle stamp, never keeps it', async () => {
  await withTitleSession(async (m, id, client) => {
    for (const word of ['long', 'ctl']) {
      await sendTitle(m.manager, id, client, 'idle');
      assert.equal(typeof m.manager.titleIdleSince(id), 'number', `${word}: idle first`);
      await sendTitle(m.manager, id, client, word);
      assert.equal(m.manager.titleIdleSince(id), undefined, `${word}: a new title, not one we vouch for as idle`);
    }
  });
});

test('C2 title: the stamp is cleared at exit, and no title text reaches SessionInfo or a frame', async () => {
  await withTitleSession(async (m, id, client) => {
    await sendTitle(m.manager, id, client, 'idle');
    assert.equal(typeof m.manager.titleIdleSince(id), 'number');
    m.manager.write(id, 'exit\r');
    await waitUntil(() => (m.manager.get(id)?.status === 'exited' ? true : undefined), 'the session to exit', 10_000, 20);
    assert.equal(m.manager.titleIdleSince(id), undefined, 'nothing waits on a process that is gone');
    // The title was the program's own output (it rides the `data` frames as
    // bytes like everything else); the manager adds it to nothing of its own.
    // Its glyph is the tell: the args hold only its octal escapes.
    const info = JSON.stringify(m.manager.get(id));
    assert.equal(info.includes('\u2733'), false, `SessionInfo carries no title text: ${info}`);
    for (const frame of client.frames) {
      if (frame.type === 'data' || frame.type === 'replay') continue;
      assert.equal(JSON.stringify(frame).includes('\u2733'), false, `a ${frame.type} frame carries no title text`);
    }
  });
});

test('C2 title: output with no title in it — plain text, the echo of a typed line — KEEPS the idle stamp; only a title changes it', async () => {
  await withTitleSession(async (m, id, client) => {
    await sendTitle(m.manager, id, client, 'idle');
    const first = m.manager.titleIdleSince(id);
    assert.equal(typeof first, 'number');
    // `text` is no title word: bash only echoes it and prints its marker.
    for (let i = 0; i < 3; i++) {
      await sleep(STAMP_TICK_MS);
      await sendTitle(m.manager, id, client, 'text');
      assert.equal(m.manager.titleIdleSince(id), first, `plain output ${i + 1} keeps the stamp`);
    }
  });
});

test('C2 title: each session keeps its OWN stamp — an idle title in one never stamps another, a spinner in one never clears another, a new session starts with none', async () => {
  const m = await makeManager();
  try {
    const open = (): { id: string; client: FakeClient } => {
      const info = m.manager.create({ command: 'bash', args: TITLE_BASH, cwd: m.root, cols: 80, rows: 24 });
      const client = new FakeClient();
      assert.notEqual(m.manager.attach(info.id, client.asWs()), null);
      return { id: info.id, client };
    };
    const a = open();
    const b = open();
    await sendTitle(m.manager, a.id, a.client, 'idle');
    const stampA = m.manager.titleIdleSince(a.id);
    assert.equal(typeof stampA, 'number', 'a is idle');
    assert.equal(m.manager.titleIdleSince(b.id), undefined, 'b printed no title: no stamp from a');
    await sendTitle(m.manager, b.id, b.client, 'idle');
    await sendTitle(m.manager, b.id, b.client, 'spin');
    assert.equal(m.manager.titleIdleSince(b.id), undefined, 'b works');
    assert.equal(m.manager.titleIdleSince(a.id), stampA, "b's spinner leaves a's stamp as it was");
    // A session created after another one was idle and exited starts with nothing.
    m.manager.write(a.id, 'exit\r');
    await waitUntil(() => (m.manager.get(a.id)?.status === 'exited' ? true : undefined), 'a to exit', 10_000, 20);
    const c = open();
    await sendTitle(m.manager, c.id, c.client, 'text');
    assert.equal(m.manager.titleIdleSince(c.id), undefined, 'a new session: no stamp');
  } finally {
    await m.cleanup();
  }
});

test('C2 title: an unknown session id has no stamp', async () => {
  const m = await makeManager();
  try {
    assert.equal(m.manager.titleIdleSince('no-such-session'), undefined);
  } finally {
    await m.cleanup();
  }
});
