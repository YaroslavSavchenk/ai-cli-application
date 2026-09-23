/**
 * Nocturne C1 (.claude/plans/nocturne/PLAN-C1.md § The signal) — the server
 * half of the peek mascot's count:
 *
 *   - `SessionInfo.turnEnded` is set EXACTLY on a 'working' -> 'waiting' move
 *     of the B11 turn readout (never on a first readout of 'waiting', never
 *     after an unknown turn, never for a session without a readout), and
 *     cleared ONLY by the turn going back to 'working' and at exit. The `seen`
 *     ack (WS `{type:'seen'}` and POST /api/sessions/:id/seen) KEEPS it —
 *     it clears `attention` only (user, 2026-09-22, on the Windows check:
 *     the mascot for a finished turn stays until the session works again).
 *   - `SessionInfo.pendingSince` is stamped when `attention || turnEnded`
 *     goes false -> true (the BEL path included), KEPT while either stays set,
 *     and deleted when both are false.
 *   - `info` is re-sent only on a real change.
 *
 * Two halves: SessionManager driven directly (a FakeClient counts frames),
 * then the real HTTP + WS handlers in-process, so the two seen paths are
 * proven to clear `attention` and keep `turnEnded` — not just markSeen.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WebSocket } from 'ws';
import type { ServerMessage, SessionInfo } from '../../shared/protocol.ts';
import type { AgentsReport } from '../../server/agents.ts';
import { createRefusalLimiter, scoped, type Logger } from '../../server/config.ts';
import { SessionHistory } from '../../server/history.ts';
import { SessionManager } from '../../server/sessions.ts';
import { ProjectStore } from '../../server/projects.ts';
import { PrefsStore } from '../../server/prefs.ts';
import { GithubConnection } from '../../server/github.ts';
import { LifecycleController } from '../../server/lifecycle.ts';
import { createRequestHandler } from '../../server/api.ts';
import { createUpgradeHandler } from '../../server/ws.ts';
import { WsClient, removeTempDir, waitUntil, sleep, makeTempDirSync } from '../helpers/helpers.ts';

/** SessionManager only touches readyState/OPEN, send() and on('close'). */
class FakeClient {
  readonly OPEN = 1;
  readonly readyState = 1;
  readonly frames: ServerMessage[] = [];
  send(raw: string): void {
    this.frames.push(JSON.parse(raw) as ServerMessage);
  }
  on(): void {}
  infoFrames(): SessionInfo[] {
    return this.frames
      .filter((m): m is Extract<ServerMessage, { type: 'info' }> => m.type === 'info')
      .map((m) => m.session);
  }
  asWs(): WebSocket {
    return this as unknown as WebSocket;
  }
}

function turn(t: AgentsReport['turn']): AgentsReport {
  return { agents: [], counts: { running: 0, finished: 0 }, ...(t === undefined ? {} : { turn: t }) };
}

/**
 * destroyAll(), then wait for every pty's exit line: node-pty's `exit` fires
 * ticks later and writes history.json into the temp dir — removing the dir
 * before that races the write (ENOTEMPTY on a loaded runner).
 */
async function settleAndRemove(m: SessionManager, logs: string[], dir: string): Promise<void> {
  const ids = m.list().map((s) => s.id);
  m.destroyAll();
  await waitUntil(
    () => (ids.every((id) => logs.some((l) => l.includes(`${id} totals:`))) ? true : undefined),
    'every destroyed session to log its exit',
    10_000,
    20,
  );
  await removeTempDir(dir);
}

async function withManager(
  fn: (m: SessionManager, root: string, logs: string[]) => Promise<void>,
): Promise<void> {
  const root = realpathSync(makeTempDirSync('ai-sm-turn-ended-'));
  const logs: string[] = [];
  const log: Logger = (level, message) => logs.push(`${level}: ${message}`);
  const history = new SessionHistory(join(root, 'history.json'), log);
  history.load();
  const manager = new SessionManager(log, history);
  try {
    await fn(manager, root, logs);
  } finally {
    await settleAndRemove(manager, logs, root);
  }
}

/** A bash that rings the bell once per line it reads, and otherwise idles. */
const BELL_ON_LINE = ['-c', 'while IFS= read -r _; do printf "\\a"; done'];

async function ringBell(m: SessionManager, id: string, client: FakeClient): Promise<void> {
  const before = client.frames.filter((f) => f.type === 'attention').length;
  m.write(id, 'x\r');
  await waitUntil(
    () => (client.frames.filter((f) => f.type === 'attention').length > before ? true : undefined),
    'the attention frame',
    10_000,
    10,
  );
}

function isIso(v: unknown): boolean {
  return typeof v === 'string' && new Date(v).toISOString() === v;
}

// ---------------------------------------------------------------------------
// SessionManager
// ---------------------------------------------------------------------------

test('C1 turnEnded: working -> waiting sets it and stamps pendingSince, in ONE info frame', async () => {
  await withManager(async (m, root) => {
    const info = m.create({ command: 'bash', args: ['-c', 'sleep 30'], cwd: root, cols: 80, rows: 24 });
    assert.equal('turnEnded' in info, false, 'a new session carries neither flag');
    assert.equal('pendingSince' in info, false);
    const client = new FakeClient();
    assert.equal(m.attach(info.id, client.asWs()), true);

    m.setReport(info.id, turn('working'));
    const base = client.infoFrames().length;
    const t0 = Date.now();
    m.setReport(info.id, turn('waiting'));
    const t1 = Date.now();
    assert.equal(client.infoFrames().length, base + 1, 'the turn move is one frame, flags included');
    const frame = client.infoFrames()[base] as SessionInfo;
    assert.equal(frame.turn, 'waiting');
    assert.equal(frame.turnEnded, true);
    assert.ok(isIso(frame.pendingSince), `pendingSince is ISO: ${String(frame.pendingSince)}`);
    const at = Date.parse(frame.pendingSince as string);
    assert.ok(at >= t0 && at <= t1, 'stamped at the transition, not before or after');
    assert.equal(frame.attention, false, 'attention stays BEL-only (B11)');
    assert.equal(m.get(info.id)?.turnEnded, true, 'the session holds it for GET /api/sessions');

    // The same readout again: no change, no frame, flags kept.
    m.setReport(info.id, turn('waiting'));
    assert.equal(client.infoFrames().length, base + 1);
    assert.equal(m.get(info.id)?.turnEnded, true);
    assert.equal(m.get(info.id)?.pendingSince, frame.pendingSince);
  });
});

test('C1 turnEnded: a FIRST readout of waiting is not news — nor waiting after an unknown turn', async () => {
  await withManager(async (m, root) => {
    const info = m.create({ command: 'bash', args: ['-c', 'sleep 30'], cwd: root, cols: 80, rows: 24 });
    const client = new FakeClient();
    m.attach(info.id, client.asWs());

    m.setReport(info.id, turn('waiting'));
    let s = m.get(info.id) as SessionInfo;
    assert.equal(s.turn, 'waiting');
    assert.equal('turnEnded' in s, false, 'first readout: absent');
    assert.equal('pendingSince' in s, false);

    // working -> unknown -> waiting: the move was not observed as one.
    m.setReport(info.id, turn('working'));
    m.setReport(info.id, turn(undefined));
    m.setReport(info.id, turn('waiting'));
    s = m.get(info.id) as SessionInfo;
    assert.equal('turnEnded' in s, false, 'waiting after an unknown turn is a first readout again');
    assert.equal('pendingSince' in s, false);

    // A session that never had a readout never gets the flag.
    const other = m.create({ command: 'bash', args: ['-c', 'sleep 30'], cwd: root, cols: 80, rows: 24 });
    m.setReport(other.id, turn(undefined));
    assert.equal('turnEnded' in (m.get(other.id) as SessionInfo), false);
    for (const f of client.infoFrames()) assert.equal('turnEnded' in f, false, 'no frame ever carried it');
  });
});

test('C1 turnEnded: the turn going back to working clears it and pendingSince; the turn going unknown keeps it', async () => {
  await withManager(async (m, root) => {
    const info = m.create({ command: 'bash', args: ['-c', 'sleep 30'], cwd: root, cols: 80, rows: 24 });
    const client = new FakeClient();
    m.attach(info.id, client.asWs());
    m.setReport(info.id, turn('working'));
    m.setReport(info.id, turn('waiting'));
    const stamped = m.get(info.id)?.pendingSince;
    assert.ok(stamped !== undefined);

    // Unknown (a refused path, say): not a look, not a new turn — kept.
    m.setReport(info.id, turn(undefined));
    assert.equal(m.get(info.id)?.turnEnded, true);
    assert.equal(m.get(info.id)?.pendingSince, stamped);

    m.setReport(info.id, turn('working'));
    const base = client.infoFrames().length;
    assert.equal('turnEnded' in (client.infoFrames()[base - 1] as SessionInfo), false, 'cleared in the working frame');
    assert.equal('pendingSince' in (client.infoFrames()[base - 1] as SessionInfo), false);
    assert.equal('turnEnded' in (m.get(info.id) as SessionInfo), false, 'absent, not false');

    // The next end of turn is news again, with a NEW stamp.
    await sleep(5);
    m.setReport(info.id, turn('waiting'));
    assert.equal(m.get(info.id)?.turnEnded, true);
    assert.ok((m.get(info.id)?.pendingSince as string) > (stamped as string), 'a fresh pending gets a fresh stamp');
  });
});

test('C1 markSeen clears attention only: turnEnded and its pendingSince stay; unknown id -> false', async () => {
  await withManager(async (m, root) => {
    const info = m.create({ command: 'bash', args: BELL_ON_LINE, cwd: root, cols: 80, rows: 24 });
    const client = new FakeClient();
    m.attach(info.id, client.asWs());
    m.setReport(info.id, turn('working'));
    m.setReport(info.id, turn('waiting'));
    await ringBell(m, info.id, client);
    assert.equal(m.get(info.id)?.attention, true);
    assert.equal(m.get(info.id)?.turnEnded, true);

    const stamped = m.get(info.id)?.pendingSince;
    assert.ok(isIso(stamped));

    assert.equal(m.markSeen(info.id), true);
    const s = m.get(info.id) as SessionInfo;
    assert.equal(s.attention, false, 'the look acks the BEL');
    assert.equal(s.turnEnded, true, 'but NOT the ended turn');
    assert.equal(s.pendingSince, stamped, 'still pending: the stamp stays, unmoved');
    assert.equal(s.turn, 'waiting', 'the turn readout itself is untouched by a look');

    // A second look, and the same waiting readout again: nothing moves.
    m.markSeen(info.id);
    m.setReport(info.id, turn('waiting'));
    assert.equal(m.get(info.id)?.turnEnded, true);
    assert.equal(m.get(info.id)?.pendingSince, stamped);

    // Only the session working again clears it (and pendingSince with it).
    m.setReport(info.id, turn('working'));
    assert.equal('turnEnded' in (m.get(info.id) as SessionInfo), false);
    assert.equal('pendingSince' in (m.get(info.id) as SessionInfo), false);

    assert.equal(m.markSeen('no-such-session'), false);
  });
});

test('C1 pendingSince: BEL stamps it, a turn ending later KEEPS it, working keeps it while attention holds', async () => {
  await withManager(async (m, root) => {
    const info = m.create({ command: 'bash', args: BELL_ON_LINE, cwd: root, cols: 80, rows: 24 });
    const client = new FakeClient();
    m.attach(info.id, client.asWs());
    m.setReport(info.id, turn('working'));

    const t0 = Date.now();
    await ringBell(m, info.id, client);
    const stamped = m.get(info.id)?.pendingSince;
    assert.ok(isIso(stamped), 'the BEL path makes the session pending too');
    assert.ok(Date.parse(stamped as string) >= t0);

    // A second bell: already pending — the stamp does not move.
    await sleep(5);
    await ringBell(m, info.id, client);
    assert.equal(m.get(info.id)?.pendingSince, stamped, 'a second BEL keeps the stamp');

    // The turn ends: turnEnded joins, the ORDER key stays the oldest.
    await sleep(5);
    m.setReport(info.id, turn('waiting'));
    assert.equal(m.get(info.id)?.turnEnded, true);
    assert.equal(m.get(info.id)?.pendingSince, stamped, 'already pending: kept, not re-stamped');

    // Back to working: turnEnded goes, attention stays — still pending.
    m.setReport(info.id, turn('working'));
    assert.equal('turnEnded' in (m.get(info.id) as SessionInfo), false);
    assert.equal(m.get(info.id)?.attention, true);
    assert.equal(m.get(info.id)?.pendingSince, stamped, 'attention alone keeps it');

    m.markSeen(info.id);
    assert.equal('pendingSince' in (m.get(info.id) as SessionInfo), false, 'both false: deleted');

    // A BEL on an ended turn, then a look: attention goes, pending stays.
    m.setReport(info.id, turn('waiting'));
    const second = m.get(info.id)?.pendingSince;
    assert.ok(isIso(second));
    await ringBell(m, info.id, client);
    m.markSeen(info.id);
    assert.equal(m.get(info.id)?.attention, false);
    assert.equal(m.get(info.id)?.pendingSince, second, 'turnEnded alone keeps it');
  });
});

test('C1 pendingSince: a turn ending first stamps it; a BEL after keeps it', async () => {
  await withManager(async (m, root) => {
    const info = m.create({ command: 'bash', args: BELL_ON_LINE, cwd: root, cols: 80, rows: 24 });
    const client = new FakeClient();
    m.attach(info.id, client.asWs());
    m.setReport(info.id, turn('working'));
    m.setReport(info.id, turn('waiting'));
    const stamped = m.get(info.id)?.pendingSince;
    assert.ok(isIso(stamped));
    await sleep(5);
    await ringBell(m, info.id, client);
    assert.equal(m.get(info.id)?.pendingSince, stamped);
  });
});

test('C1 exit: turnEnded and its pendingSince go in the info frame right before exit; a BEL-pending one keeps its stamp', async () => {
  await withManager(async (m, root) => {
    // (a) turn-only pending: both cleared at exit.
    const a = m.create({ command: 'bash', args: ['-c', 'read -r _'], cwd: root, cols: 80, rows: 24 });
    const ca = new FakeClient();
    m.attach(a.id, ca.asWs());
    m.setReport(a.id, turn('working'));
    m.setReport(a.id, turn('waiting'));
    assert.equal(m.get(a.id)?.turnEnded, true);
    m.write(a.id, 'go\r');
    await waitUntil(() => (m.get(a.id)?.status === 'exited' ? true : undefined), 'session a to exit', 10_000);
    const sa = m.get(a.id) as SessionInfo;
    assert.equal('turnEnded' in sa, false, 'exit clears turnEnded');
    assert.equal('pendingSince' in sa, false, 'and with nothing else pending, pendingSince');
    const exitAt = ca.frames.findIndex((f) => f.type === 'exit');
    const before = ca.frames[exitAt - 1] as Extract<ServerMessage, { type: 'info' }>;
    assert.equal(before.type, 'info', 'one info frame right before the exit');
    assert.equal('turnEnded' in before.session, false);
    assert.equal('pendingSince' in before.session, false);

    // (b) BEL-pending at exit: attention is untouched at exit (as before C1),
    // so its pendingSince stands; the turn flag still goes.
    const b = m.create({
      command: 'bash',
      args: ['-c', 'IFS= read -r _; printf "\\a"; IFS= read -r _'],
      cwd: root,
      cols: 80,
      rows: 24,
    });
    const cb = new FakeClient();
    m.attach(b.id, cb.asWs());
    m.setReport(b.id, turn('working'));
    await ringBell(m, b.id, cb);
    m.setReport(b.id, turn('waiting'));
    const stamped = m.get(b.id)?.pendingSince;
    m.write(b.id, 'go\r');
    await waitUntil(() => (m.get(b.id)?.status === 'exited' ? true : undefined), 'session b to exit', 10_000);
    const sb = m.get(b.id) as SessionInfo;
    assert.equal('turnEnded' in sb, false);
    assert.equal(sb.attention, true);
    assert.equal(sb.pendingSince, stamped);

    // A report racing the exit brings nothing back.
    m.setReport(a.id, turn('working'));
    m.setReport(a.id, turn('waiting'));
    assert.equal('turnEnded' in (m.get(a.id) as SessionInfo), false);
  });
});

test('C1 exit: turnEnded held past an unknown turn still goes in ONE info frame before exit, even when a BEL keeps pendingSince', async () => {
  // The one exit path where clearing turnEnded is the ONLY change: the turn
  // readout already went unknown (so `turn` has nothing to delete) and a BEL
  // keeps `pendingSince`. Attached clients must still hear the flag go.
  await withManager(async (m, root) => {
    const info = m.create({
      command: 'bash',
      args: ['-c', 'IFS= read -r _; printf "\\a"; IFS= read -r _'],
      cwd: root,
      cols: 80,
      rows: 24,
    });
    const client = new FakeClient();
    m.attach(info.id, client.asWs());
    m.setReport(info.id, turn('working'));
    m.setReport(info.id, turn('waiting'));
    m.setReport(info.id, turn(undefined));
    await ringBell(m, info.id, client);
    const stamped = m.get(info.id)?.pendingSince;
    assert.equal(m.get(info.id)?.turnEnded, true);
    assert.equal('turn' in (m.get(info.id) as SessionInfo), false);
    m.write(info.id, 'go\r');
    await waitUntil(() => (m.get(info.id)?.status === 'exited' ? true : undefined), 'the session to exit', 10_000);
    const exitAt = client.frames.findIndex((f) => f.type === 'exit');
    const before = client.frames[exitAt - 1] as Extract<ServerMessage, { type: 'info' }>;
    assert.equal(before.type, 'info', 'an info frame right before the exit');
    assert.equal('turnEnded' in before.session, false, 'it no longer carries the flag');
    assert.equal(before.session.attention, true);
    assert.equal(before.session.pendingSince, stamped);
  });
});

// ---------------------------------------------------------------------------
// The two seen paths through the real handlers
// ---------------------------------------------------------------------------

test('C1 served + seen paths: /mascot.html carries the token like index.html; POST /seen and WS {type:"seen"} clear attention and KEEP turnEnded + pendingSince', async () => {
  const dir = realpathSync(makeTempDirSync('ai-sm-turn-ended-http-'));
  const logs: string[] = [];
  const log: Logger = (level, message) => logs.push(`${level}: ${message}`);
  const token = 'c'.repeat(64);
  const history = new SessionHistory(join(dir, 'history.json'), log);
  const sessions = new SessionManager(log, history);
  const lifecycle = new LifecycleController({
    onIdleShutdown: () => undefined,
    log,
    graceMs: 600_000,
    startupGraceMs: 600_000,
  });
  let boundPort = 0;
  const allowRefusalLine = createRefusalLimiter(scoped(log, 'http'));
  const server: Server = createServer(
    createRequestHandler({
      token,
      getPort: () => boundPort,
      getStartedAt: () => new Date().toISOString(),
      projects: new ProjectStore(join(dir, 'projects.json'), log),
      prefs: new PrefsStore(join(dir, 'prefs.json'), log),
      sessions,
      history,
      github: new GithubConnection({
        file: join(dir, 'github.json'),
        log,
        clientId: undefined,
        apiBase: 'https://api.github.com',
      }),
      webDistDir: join(dir, 'dist'),
      log,
      allowRefusalLine,
    }),
  );
  server.on('upgrade', createUpgradeHandler({ token, getPort: () => boundPort, sessions, lifecycle, log, allowRefusalLine }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  boundPort = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${boundPort}`;
  // The served page (PLAN-C1.md § The page): /mascot.html gets the SAME
  // serve-time token replacement and headers as index.html. A temp dist, so
  // this holds without a vite build.
  mkdirSync(join(dir, 'dist'), { recursive: true });
  const shell = (name: string): string =>
    `<!doctype html><title>${name}</title><script>window.__AUTH__ = '__AUTH_TOKEN__';</script>`;
  writeFileSync(join(dir, 'dist', 'index.html'), shell('app'));
  writeFileSync(join(dir, 'dist', 'mascot.html'), shell('mascot'));
  const getSession = async (id: string): Promise<SessionInfo | undefined> => {
    const res = await fetch(`${base}/api/sessions`, { headers: { 'x-auth-token': token } });
    const list = (await res.json()) as SessionInfo[];
    return list.find((s) => s.id === id);
  };
  let client: WsClient | undefined;
  try {
    const page = await fetch(`${base}/mascot.html`);
    const index = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.ok(html.includes(`window.__AUTH__ = '${token}'`), 'the mascot page carries the token');
    assert.ok(!html.includes('__AUTH_TOKEN__'), 'the placeholder is fully replaced');
    assert.ok(html.includes('<title>mascot</title>'), 'and it is the mascot page, not index.html');
    for (const h of ['cache-control', 'x-frame-options', 'content-security-policy', 'content-type']) {
      assert.equal(page.headers.get(h), index.headers.get(h), `${h} matches index.html's`);
    }
    assert.equal(page.headers.get('cache-control'), 'no-store');
    assert.equal(page.headers.get('x-frame-options'), 'DENY');
    assert.equal(page.headers.get('content-security-policy'), "frame-ancestors 'none'");

    const info = sessions.create({ command: 'bash', args: BELL_ON_LINE, cwd: dir, cols: 80, rows: 24 });
    client = await WsClient.connect(`ws://127.0.0.1:${boundPort}/ws/sessions/${info.id}?token=${token}`);
    await client.waitForMessage('replay');
    const ws = client;
    const bell = async (): Promise<void> => {
      const from = ws.messages.length;
      ws.send({ type: 'input', data: 'x\r' });
      await ws.waitForMessage('attention', { fromIndex: from });
    };

    // GET /api/sessions carries the flag (what /mascot.html polls).
    sessions.setReport(info.id, turn('working'));
    sessions.setReport(info.id, turn('waiting'));
    let s = await getSession(info.id);
    assert.equal(s?.turnEnded, true);
    const stamped = s?.pendingSince;
    assert.ok(isIso(stamped));

    // HTTP seen: attention cleared, the ended turn stays pending.
    await bell();
    assert.equal((await getSession(info.id))?.attention, true);
    const res = await fetch(`${base}/api/sessions/${info.id}/seen`, {
      method: 'POST',
      headers: { 'x-auth-token': token },
    });
    assert.equal(res.status, 200);
    s = await getSession(info.id);
    assert.equal(s?.attention, false, 'HTTP seen clears attention');
    assert.equal(s?.turnEnded, true, 'HTTP seen keeps turnEnded');
    assert.equal(s?.pendingSince, stamped, 'and pendingSince, unmoved');

    // WS seen: the same.
    await bell();
    assert.equal((await getSession(info.id))?.attention, true);
    ws.send({ type: 'seen' });
    s = await waitUntil(
      async () => {
        const cur = await getSession(info.id);
        return cur !== undefined && cur.attention === false ? cur : undefined;
      },
      "ws 'seen' to clear attention",
      5_000,
    );
    assert.equal(s.turnEnded, true, 'WS seen keeps turnEnded');
    assert.equal(s.pendingSince, stamped, 'and pendingSince, unmoved');

    // Working again is what clears it — visible on the same GET.
    sessions.setReport(info.id, turn('working'));
    s = await getSession(info.id);
    assert.equal(s !== undefined && 'turnEnded' in s, false);
    assert.equal(s !== undefined && 'pendingSince' in s, false);
  } finally {
    await client?.close();
    // The detach armed the REAL 10-minute grace timer: without stop() the
    // event loop never drains and `node --test` hangs.
    lifecycle.stop();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await settleAndRemove(sessions, logs, dir);
  }
});
