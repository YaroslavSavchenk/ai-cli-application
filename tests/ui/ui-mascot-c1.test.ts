/**
 * Nocturne C1 (`.claude/plans/nocturne/PLAN-C1.md`), the frontend half of
 * phase 2: the peek mascot page turned LIVE, the main page's ack of a turn
 * the user has not seen, and the host's `focus-session`.
 *
 * WHAT IS PINNED HERE, and why each one matters:
 *
 *   - `pendingSessions` — WHICH sessions a mascot stands for, in WHICH order
 *     (oldest pending = slot 0, which is also the one a click opens).
 *   - `MascotFeed` — the count rules, on injected clocks: a rise shows only
 *     after it HELD 1.5 s (a BEL acked inside that window, or a turn that
 *     starts again at once, never flashes a mascot), a fall at once, the
 *     switch off = 0, never more than 3, a gone backend = 0.
 *   - the host messages — byte shapes the C# host parses, the dedupe, and the
 *     silence of a page without a host (`?demo`, a plain browser).
 *   - `parseFocusSession` — strict: the one message that makes this page move
 *     focus on the host's word.
 *   - the reduced-motion block, by source (decision 16).
 *   - the ack, by source and on the real store: a look acks a BEL only; a
 *     turn that ended (`turnEnded`) survives it — its mascot stays until the
 *     session works again or ends (user, 2026-09-22, overriding decision 14) —
 *     and the BEL-only counters stay BEL-only (B11).
 *
 * NOT claimed (browser and Windows work): that the overlay window shows, that
 * rects match what is drawn, that animations are gone under the OS setting,
 * that the host activates the window.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SessionInfo } from '../../shared/protocol.ts';
import {
  FAILS_TO_ZERO,
  HostReporter,
  MascotFeed,
  POLL_MS,
  RISE_HOLD_MS,
  countMessage,
  openMessage,
  pendingSessions,
} from '../../web/src/mascot/feed.ts';
import { MascotModel, REACTIONS } from '../../web/src/mascot/model.ts';
import { clampMascot, getMascotEnabled, initMascot, mascotPatch } from '../../web/src/ui/prefs-model.ts';
import { onFocusSession, parseFocusSession, type HostWindow } from '../../web/src/ui/host-bridge.ts';
import { readSource as read } from '../helpers/helpers.ts';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const D = '44444444-4444-4444-8444-444444444444';

function sess(id: string, extra: Partial<SessionInfo> = {}): Partial<SessionInfo> {
  return { id, status: 'running', attention: false, ...extra };
}

// ===========================================================================
// pendingSessions
// ===========================================================================

test('pending = running AND (attention OR turnEnded); exited, quiet and malformed rows are not', () => {
  const list = [
    sess(A, { attention: true, pendingSince: '2026-09-22T10:00:01.000Z' }),
    sess(B, { turnEnded: true, pendingSince: '2026-09-22T10:00:02.000Z' }),
    sess(C, { status: 'exited', attention: true, pendingSince: '2026-09-22T10:00:00.000Z' }),
    sess(D),
    null,
    'x',
    { status: 'running', attention: true },
    sess(D, { attention: 'yes' as unknown as boolean }),
  ];
  assert.deepEqual(pendingSessions(list), [A, B]);
});

test('ordered by pendingSince, oldest first; undated after dated; ties on the id', () => {
  const list = [
    sess(D, { attention: true }),
    sess(C, { turnEnded: true, pendingSince: '2026-09-22T10:00:05.000Z' }),
    sess(B, { attention: true, pendingSince: '2026-09-22T10:00:01.000Z' }),
    sess(A, { attention: true, pendingSince: '2026-09-22T10:00:05.000Z' }),
  ];
  assert.deepEqual(pendingSessions(list), [B, A, C, D]);
});

test('anything that is not a list is no sessions at all', () => {
  for (const bad of [null, undefined, {}, 'x', 3, { sessions: [] }]) assert.deepEqual(pendingSessions(bad), []);
});

// ===========================================================================
// the switch
// ===========================================================================

test('the mascot switch: absent = on, only `{enabled:false}` turns it off', () => {
  assert.equal(clampMascot(undefined), true);
  assert.equal(clampMascot(null), true);
  assert.equal(clampMascot('off'), true);
  assert.equal(clampMascot({}), true);
  assert.equal(clampMascot({ enabled: 'false' }), true);
  assert.equal(clampMascot({ enabled: 0 }), true);
  assert.equal(clampMascot({ enabled: true }), true);
  assert.equal(clampMascot({ enabled: false }), false);
  initMascot({ enabled: false });
  assert.equal(getMascotEnabled(), false);
  initMascot(undefined);
  assert.equal(getMascotEnabled(), true);
  assert.deepEqual(mascotPatch(false), { mascot: { enabled: false } });
});

// ===========================================================================
// MascotFeed — the count on injected clocks
// ===========================================================================

interface Rig {
  feed: MascotFeed;
  counts: number[];
  authLost: number;
  sessions: unknown;
  prefs: unknown;
  /** When set, the next getSessions rejects with it. */
  failNext: unknown;
  now: number;
  timers: { fn: () => void; at: number; id: number }[];
  /** Advance the clock and run every timer that came due, in order. */
  advance(ms: number): Promise<void>;
  flush(): Promise<void>;
}

function rig(): Rig {
  let seq = 0;
  const r: Rig = {
    feed: null as unknown as MascotFeed,
    counts: [],
    authLost: 0,
    sessions: [],
    prefs: {},
    failNext: undefined,
    now: 1_000_000,
    timers: [],
    async advance(ms: number) {
      const end = r.now + ms;
      for (;;) {
        r.timers.sort((a, b) => a.at - b.at || a.id - b.id);
        const due = r.timers[0];
        if (due === undefined || due.at > end) break;
        r.timers.shift();
        r.now = due.at;
        due.fn();
        await r.flush();
      }
      r.now = end;
      await r.flush();
    },
    async flush() {
      for (let i = 0; i < 10; i++) await Promise.resolve();
    },
  };
  r.feed = new MascotFeed({
    getSessions: async () => {
      if (r.failNext !== undefined) {
        const e = r.failNext;
        r.failNext = undefined;
        throw e;
      }
      return r.sessions;
    },
    getPrefs: async () => r.prefs,
    onCount: (n) => r.counts.push(n),
    onAuthLost: () => r.authLost++,
    setTimeout: (fn, ms) => {
      const t = { fn, at: r.now + ms, id: ++seq };
      r.timers.push(t);
      return t;
    },
    clearTimeout: (h) => {
      r.timers = r.timers.filter((t) => t !== h);
    },
    now: () => r.now,
  });
  return r;
}

const pending = (...ids: string[]): Partial<SessionInfo>[] =>
  ids.map((id, i) => sess(id, { turnEnded: true, pendingSince: `2026-09-22T10:00:0${i}.000Z` }));

test('a rise shows only after it held 1.5 s — confirmed by a fresh read, not assumed', async () => {
  const r = rig();
  r.sessions = pending(A);
  r.feed.start();
  await r.flush();
  assert.deepEqual(r.counts, [], 'seen once is not yet held');
  assert.equal(r.feed.getCount(), 0);
  await r.advance(RISE_HOLD_MS - 1);
  assert.deepEqual(r.counts, []);
  await r.advance(1);
  assert.deepEqual(r.counts, [1], 'the re-read at 1.5 s still sees it: one mascot');
  assert.equal(r.feed.sessionAt(0), A);
  r.feed.stop();
});

test('a pending that clears inside the hold (a BEL acked in view, a turn that works again) never flashes', async () => {
  const r = rig();
  r.sessions = pending(A);
  r.feed.start();
  await r.flush();
  r.sessions = [sess(A)]; // the BEL was acked / the session is working again
  await r.advance(POLL_MS * 3);
  assert.deepEqual(r.counts, [], 'no flash, ever');
  r.feed.stop();
});

test('a turn that ended shows its mascot even in the pane the user looks at, and leaves only when it works again', async () => {
  const r = rig();
  r.sessions = [sess(A, { turnEnded: true, pendingSince: '2026-09-22T10:00:00.000Z' })];
  r.feed.start();
  await r.flush();
  await r.advance(RISE_HOLD_MS);
  assert.deepEqual(r.counts, [1], 'no look clears `turnEnded`: the mascot comes');
  await r.advance(POLL_MS * 5);
  assert.deepEqual(r.counts, [1], 'and it stays while nothing changes');
  r.sessions = [sess(A, { turn: 'working' })]; // the server cleared turnEnded
  await r.feed.poll();
  assert.deepEqual(r.counts, [1, 0], 'working again: gone at once');
  r.feed.stop();
});

test('a fall applies at once, without waiting for any hold', async () => {
  const r = rig();
  r.sessions = pending(A, B);
  r.feed.start();
  await r.flush();
  await r.advance(RISE_HOLD_MS);
  assert.deepEqual(r.counts, [2]);
  r.sessions = pending(B);
  await r.feed.poll();
  assert.deepEqual(r.counts, [2, 1], 'one read, one fewer mascot');
  assert.equal(r.feed.sessionAt(0), B, 'the slot follows the list');
  assert.equal(r.feed.sessionAt(1), null, 'nothing past the count');
  r.feed.stop();
});

test('never more than three mascots, whatever is pending', async () => {
  const r = rig();
  r.sessions = pending(A, B, C, D);
  r.feed.start();
  await r.flush();
  await r.advance(RISE_HOLD_MS);
  assert.deepEqual(r.counts, [3]);
  assert.deepEqual([0, 1, 2, 3].map((i) => r.feed.sessionAt(i)), [A, B, C, null]);
  r.feed.stop();
});

test('only what held for the whole window is shown; a newer rise starts its own hold', async () => {
  const r = rig();
  r.sessions = pending(A);
  r.feed.start();
  await r.flush();
  await r.advance(1000);
  r.sessions = pending(A, B); // B ended its turn 1 s into A's hold
  await r.feed.poll();
  assert.deepEqual(r.counts, []);
  await r.advance(RISE_HOLD_MS - 1000);
  assert.deepEqual(r.counts, [1], 'A held; B has not proved itself yet');
  await r.advance(RISE_HOLD_MS);
  assert.deepEqual(r.counts, [1, 2]);
  r.feed.stop();
});

test('prefs `{enabled:false}` → 0 at once; absent → on again (after the hold)', async () => {
  const r = rig();
  r.sessions = pending(A, B);
  r.feed.start();
  await r.flush();
  await r.advance(RISE_HOLD_MS);
  assert.deepEqual(r.counts, [2]);
  r.prefs = { mascot: { enabled: false } };
  await r.feed.poll();
  assert.deepEqual(r.counts, [2, 0], 'switched off: gone on the next read');
  assert.equal(r.feed.sessionAt(0), null);
  r.prefs = {};
  await r.feed.poll();
  await r.advance(RISE_HOLD_MS);
  assert.deepEqual(r.counts, [2, 0, 2]);
  r.feed.stop();
});

test('a failed prefs read keeps the last switch value', async () => {
  const r = rig();
  r.prefs = { mascot: { enabled: false } };
  r.sessions = pending(A);
  r.feed.start();
  await r.flush();
  await r.advance(RISE_HOLD_MS);
  assert.deepEqual(r.counts, []);
  const feed = r.feed as unknown as { opts: { getPrefs: () => Promise<unknown> } };
  feed.opts.getPrefs = async () => {
    throw { status: 500 };
  };
  await r.advance(POLL_MS * 2);
  assert.deepEqual(r.counts, [], 'a refused read is not a switch-on');
  r.feed.stop();
});

test('one failed poll is a blip; two in a row mean no backend and no mascots', async () => {
  const r = rig();
  r.sessions = pending(A);
  r.feed.start();
  await r.flush();
  await r.advance(RISE_HOLD_MS);
  assert.deepEqual(r.counts, [1]);
  r.failNext = new TypeError('network');
  await r.feed.poll();
  assert.deepEqual(r.counts, [1]);
  for (let i = 1; i < FAILS_TO_ZERO; i++) {
    r.failNext = new TypeError('network');
    await r.feed.poll();
  }
  assert.deepEqual(r.counts, [1, 0]);
  assert.equal(r.authLost, 0, 'a network error is not an auth loss');
  r.feed.stop();
});

test('a refused token (401/403) is reported so the page can reload for the new one', async () => {
  const r = rig();
  r.failNext = { status: 401 };
  await r.feed.poll();
  r.failNext = { status: 403 };
  await r.feed.poll();
  r.failNext = { status: 500 };
  await r.feed.poll();
  assert.equal(r.authLost, 2);
});

test('an answer that arrives after a newer one is dropped', async () => {
  const r = rig();
  let release: (v: unknown) => void = () => {};
  const feed = r.feed as unknown as { opts: { getSessions: () => Promise<unknown> } };
  const real = feed.opts.getSessions;
  feed.opts.getSessions = () => new Promise((res) => (release = res));
  const slow = r.feed.poll(); // asked first, answers last
  feed.opts.getSessions = real;
  r.sessions = [];
  await r.feed.poll();
  release(pending(A, B, C));
  await slow;
  await r.advance(RISE_HOLD_MS * 2);
  assert.deepEqual(r.counts, [], 'the stale answer never started a rise');
});

test('stop() leaves no timer behind', async () => {
  const r = rig();
  r.sessions = pending(A);
  r.feed.start();
  await r.flush();
  assert.ok(r.timers.length >= 2, 'a poll timer and a hold timer are armed');
  r.feed.stop();
  assert.equal(r.timers.length, 0);
});

// ===========================================================================
// host messages
// ===========================================================================

test('mascot-count and mascot-open are the exact strings the host parses', () => {
  assert.equal(
    countMessage(2, [
      [120, 10, 132, 160],
      [150, 60, 70, 140],
    ]),
    '{"type":"mascot-count","count":2,"rects":[[120,10,132,160],[150,60,70,140]]}',
  );
  assert.equal(countMessage(0, []), '{"type":"mascot-count","count":0,"rects":[]}');
  assert.equal(openMessage(A), `{"type":"mascot-open","session":"${A}"}`);
});

test('the reporter says each count + rects once, and posts nothing without a host', () => {
  const posted: string[] = [];
  const rep = new HostReporter((m) => posted.push(m));
  rep.report(1, [[1, 2, 3, 4]]);
  rep.report(1, [[1, 2, 3, 4]]);
  rep.report(1, [[1, 2, 3, 5]]);
  rep.report(0, []);
  rep.open(A);
  assert.deepEqual(posted, [
    '{"type":"mascot-count","count":1,"rects":[[1,2,3,4]]}',
    '{"type":"mascot-count","count":1,"rects":[[1,2,3,5]]}',
    '{"type":"mascot-count","count":0,"rects":[]}',
    `{"type":"mascot-open","session":"${A}"}`,
  ]);
  for (const m of posted) assert.equal(typeof m, 'string', 'strings only: the host drops anything else');
  const silent = new HostReporter(null);
  silent.report(3, [[0, 0, 1, 1]]);
  silent.open(A); // no throw, nowhere to go
});

test('a click reports which reaction it started, so the page waits exactly that long', () => {
  const m = new MascotModel({ setTimeout: () => 0, clearTimeout: () => {}, random: () => 0 });
  m.setCount(2);
  assert.equal(m.poke(0), 'laugh');
  assert.equal(m.poke(0), null, 'a reacting mascot ignores the click — and opens nothing twice');
  const w = new MascotModel({ setTimeout: () => 0, clearTimeout: () => {}, random: () => 0.99 });
  w.setCount(1);
  assert.equal(w.poke(0), 'wave');
  assert.equal(w.poke(1), null, 'past the count');
  assert.equal(REACTIONS.laugh.dur, 1400);
  assert.equal(REACTIONS.wave.dur, 1300);
});

test('main.ts: ?demo posts nothing and polls nothing; the open waits for the reaction', () => {
  const src = read('web/src/mascot/main.ts');
  assert.match(src, /new HostReporter\(demo \? null : hostPost\(\)\)/, '?demo has no host channel');
  const demoBranch = src.slice(src.indexOf('if (demo) {'), src.indexOf('} else {', src.indexOf('if (demo) {')));
  assert.ok(demoBranch.length > 0);
  assert.doesNotMatch(demoBranch, /MascotFeed|start\(\)/, 'the demo strip drives the count alone');
  assert.match(src, /REACTIONS\[reaction\]\.dur/, 'mascot-open waits for the reaction to play');
  assert.match(src, /'x-auth-token': window\.__AUTH__/, 'the page reads with the injected token');
  assert.match(read('web/mascot.html'), /window\.__AUTH__ = '__AUTH_TOKEN__';/, 'the placeholder is in the page');
});

// ===========================================================================
// focus-session (host → main page)
// ===========================================================================

test('focus-session is read strictly: string, JSON, exactly {type, session}, a UUID', () => {
  assert.equal(parseFocusSession(`{"type":"focus-session","session":"${A}"}`), A);
  assert.equal(parseFocusSession(`{"session":"${A}","type":"focus-session"}`), A, 'key order is free');
  const bad: unknown[] = [
    { type: 'focus-session', session: A }, // an object, not a string
    `{"type":"focus-session","session":"${A}","x":1}`,
    `{"type":"focus-session"}`,
    `{"type":"mascot-open","session":"${A}"}`,
    `{"type":"focus-session","session":"not-a-uuid"}`,
    `{"type":"focus-session","session":"${A}x"}`,
    `{"type":"focus-session","session":7}`,
    `["focus-session","${A}"]`,
    'null',
    '{',
    'copy-files ok 2',
    `{"type":"focus-session","session":"${A}"${' '.repeat(300)}}`,
    undefined,
  ];
  for (const b of bad) assert.equal(parseFocusSession(b), null, String(b));
});

test('onFocusSession listens only inside a host, forwards only valid messages, and unsubscribes', () => {
  const listeners = new Set<(e: { data?: unknown }) => void>();
  const win: HostWindow = {
    chrome: {
      webview: {
        postMessage: () => {},
        addEventListener: (_t, fn) => void listeners.add(fn),
        removeEventListener: (_t, fn) => void listeners.delete(fn),
      },
    },
  };
  const got: string[] = [];
  const off = onFocusSession((id) => got.push(id), win);
  assert.equal(listeners.size, 1);
  for (const fn of listeners) {
    fn({ data: `{"type":"focus-session","session":"${B}"}` });
    fn({ data: 'copy-files ok 1' });
    fn({ data: { type: 'focus-session', session: B } });
  }
  assert.deepEqual(got, [B]);
  off();
  assert.equal(listeners.size, 0);
  const none = onFocusSession(() => assert.fail('no host, no calls'), {});
  none();
});

test('main.ts: focus-session goes to the tab, focuses the pane, and ignores a session it does not know', () => {
  const src = read('web/src/main.ts');
  const at = src.indexOf('onFocusSession((id) => {');
  assert.ok(at > 0, 'the handler is wired');
  const body = src.slice(at, src.indexOf('});', at));
  assert.match(body, /!st\.state\.sessions\.has\(id\) \|\| st\.viewOfSession\(id\) === undefined\) return;/);
  assert.match(body, /st\.focusSession\(id\);/);
  assert.match(body, /requestTerminalFocus\(\);/);
  assert.match(body, /refreshPaneArea\(\);/, 'the look acks it when the window has the user');
});

// ===========================================================================
// reduced motion (decision 16), by source
// ===========================================================================

test('prefers-reduced-motion removes every animation and transition from the mascots', () => {
  const css = read('web/src/mascot/mascot.css');
  const at = css.indexOf('@media (prefers-reduced-motion: reduce)');
  assert.ok(at > 0, 'the media block exists');
  const block = css.slice(at, css.indexOf('\n}\n', at) + 3);
  assert.match(block, /\.pm-pos,\s*\.pm-pos \* \{/, 'the position layer and everything inside it');
  assert.match(block, /animation: none !important;/, '!important: the view writes animations inline');
  assert.match(block, /transition: none !important;/, 'no .7s glide either');
  // The view settles a mascot by the browser's own list of running
  // animations, so with none there is nothing to wait on.
  assert.match(read('web/src/mascot/view.ts'), /getAnimations\(\)/);
});

// ===========================================================================
// the ack (main page), by source + the real store
// ===========================================================================

test('panes.ts: a look acks a BEL only — `turnEnded` never sends a seen', () => {
  const src = read('web/src/ui/panes.ts');
  const fn = /function clearAttentionIfPending\(s: Slot\): void \{[\s\S]*?\n\}/.exec(src);
  assert.ok(fn);
  assert.match(fn[0], /if \(info !== undefined && info\.attention\) ackSeen/, 'attention alone sends the seen');
  assert.doesNotMatch(fn[0], /turnEnded|turnEnded/);
  const onInfo = /onInfo: \(info: SessionInfo\) => \{[\s\S]*?clearAttentionIfPending\(s\);/.exec(src);
  assert.ok(onInfo);
  assert.match(onInfo[0], /if \(\s*info\.attention &&/, 'the info-frame gate is BEL-only');
  assert.doesNotMatch(onInfo[0].replace(/\/\/.*$/gm, ''), /turnEnded|turnEnded/, 'no turn flag in the gate code');
  const ack = /function ackSeen\([\s\S]*?\n\}/.exec(src);
  assert.ok(ack);
  assert.match(ack[0], /sendSeen\(\)/);
  assert.match(ack[0], /api\.markSeen\(sessionId\)/);
  assert.match(ack[0], /st\.markSeenLocally\(sessionId\)/);
});

class MemoryStorage {
  #m = new Map<string, string>();
  getItem(k: string): string | null {
    return this.#m.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.#m.set(k, v);
  }
  removeItem(k: string): void {
    this.#m.delete(k);
  }
}

test('the store: markSeenLocally clears the BEL only, keeps `turnEnded` + its pendingSince; counters stay BEL-only (B11)', async () => {
  const g = globalThis as unknown as Record<string, unknown>;
  g.localStorage ??= new MemoryStorage();
  g.window ??= { setTimeout, clearTimeout, __AUTH__: 't' };
  const st = await import('../../web/src/state.ts');
  const base = {
    command: 'claude',
    args: [],
    cwd: '/tmp',
    cols: 80,
    rows: 24,
    createdAt: '2026-09-22T10:00:00.000Z',
  };
  const both = {
    ...sess(A, { attention: true, turnEnded: true, pendingSince: '2026-09-22T10:00:00.000Z' }),
    ...base,
  } as unknown as SessionInfo;
  const belOnly = {
    ...sess(B, { attention: true, pendingSince: '2026-09-22T10:00:01.000Z' }),
    ...base,
  } as unknown as SessionInfo;
  const turnOnly = {
    ...sess(C, { turnEnded: true, pendingSince: '2026-09-22T10:00:02.000Z' }),
    command: 'claude',
    args: [],
    cwd: '/tmp',
    cols: 80,
    rows: 24,
    createdAt: '2026-09-22T10:00:00.000Z',
  } as unknown as SessionInfo;
  st.initServer([], [both, belOnly, turnOnly]);
  assert.equal(st.attentionCount(), 2, 'a turn that ended is not a BEL');
  let notified = 0;
  st.subscribe((k) => {
    if (k === 'sessions') notified++;
  });
  st.markSeenLocally(A);
  const a = st.state.sessions.get(A);
  assert.equal(a?.attention, false);
  assert.equal(a?.turnEnded, true, 'a look never clears a turn that ended');
  assert.equal(a?.pendingSince, '2026-09-22T10:00:00.000Z', 'still pending: its place in line stays');
  st.markSeenLocally(B);
  const b = st.state.sessions.get(B);
  assert.equal(b?.attention, false);
  assert.equal(b?.pendingSince, undefined, 'BEL only: nothing pending any more');
  assert.equal(notified, 2);
  st.markSeenLocally(C);
  assert.equal(st.state.sessions.get(C)?.turnEnded, true);
  assert.equal(notified, 2, 'no BEL to clear, nothing said');
  const src = read('web/src/state.ts');
  const count = /export function attentionCount\(\): number \{[\s\S]*?\n\}/.exec(src);
  assert.ok(count);
  assert.doesNotMatch(count[0], /turnEnded/);
  const view = /export function viewAttention\([\s\S]*?\n\}/.exec(src);
  assert.ok(view);
  assert.doesNotMatch(view[0], /turnEnded/);
});

test('isMascotShape is exactly the server\'s PUT check: `{enabled: boolean}` and nothing else', async () => {
  const { isMascotShape } = await import('../../web/src/ui/prefs-model.ts');
  const { validMascotPref } = await import('../../server/api.ts');
  const cases: unknown[] = [
    { enabled: true }, { enabled: false }, 'off', null, [], {}, { enabled: 'x' }, { enabled: true, x: 1 }, 0,
  ];
  for (const c of cases) {
    assert.equal(isMascotShape(c), validMascotPref(c), JSON.stringify(c));
  }
});

// ===========================================================================
// Test-gate additions (C1 phases 2+4): each one kills a mutant the file above
// let through.
// ===========================================================================

test('the spec\'s numbers are pinned: poll every 2 s, a rise holds 1.5 s, two misses in a row to zero', () => {
  // Every feed test above reads these constants, so a retimed one would pass
  // them all — PLAN-C1 § The page names the values.
  assert.equal(POLL_MS, 2000);
  assert.equal(RISE_HOLD_MS, 1500);
  assert.equal(FAILS_TO_ZERO, 2);
});

test('focus-session: a session id that only CONTAINS a UUID, or is not a string, is refused', () => {
  const bad: unknown[] = [
    `{"type":"focus-session","session":"x${A}"}`, // junk before
    `{"type":"focus-session","session":"0${A}"}`, // one hex digit too many at the front
    `{"type":"focus-session","session":"${A}0"}`, // and at the end
    `{"type":"focus-session","session":"gggggggg-gggg-4ggg-8ggg-gggggggggggg"}`, // not hex
    `{"type":"focus-session","session":"${'-'.repeat(36)}"}`, // UUID length, no shape
    `{"type":"focus-session","session":"${A.replaceAll('-', '')}xxxx"}`, // 36 chars, no dashes
    `{"type":"focus-session","session":["${A}"]}`, // an array that stringifies to a UUID
    [`{"type":"focus-session","session":"${A}"}`], // data that stringifies to a valid message
    { toString: () => `{"type":"focus-session","session":"${A}"}` },
  ];
  for (const b of bad) assert.equal(parseFocusSession(b), null, JSON.stringify(b));
});

test('onFocusSession with no window passed listens on the REAL window (what main.ts calls)', () => {
  const g = globalThis as unknown as Record<string, unknown>;
  const had = 'window' in g;
  const prev = g.window;
  const listeners = new Set<(e: { data?: unknown }) => void>();
  g.window = {
    chrome: {
      webview: {
        postMessage: () => {},
        addEventListener: (_t: string, fn: (e: { data?: unknown }) => void) => void listeners.add(fn),
        removeEventListener: (_t: string, fn: (e: { data?: unknown }) => void) => void listeners.delete(fn),
      },
    },
  };
  try {
    const got: string[] = [];
    const off = onFocusSession((id) => got.push(id));
    assert.equal(listeners.size, 1, 'main.ts passes no window: the global one must be used');
    for (const fn of listeners) fn({ data: `{"type":"focus-session","session":"${C}"}` });
    assert.deepEqual(got, [C]);
    off();
    assert.equal(listeners.size, 0);
  } finally {
    if (had) g.window = prev;
    else delete g.window;
  }
});

test('a rise shows only the count that held the WHOLE window, also when it dipped inside it', async () => {
  const r = rig();
  r.sessions = pending(A, B);
  r.feed.start();
  await r.flush();
  await r.advance(500);
  r.sessions = pending(A); // B was acked 0.5 s in
  await r.feed.poll();
  await r.advance(RISE_HOLD_MS - 500);
  assert.deepEqual(r.counts, [1], 'two never held for 1.5 s; one did');
  r.feed.stop();
});

test('a good poll between two failures resets the miss count: two NON-consecutive misses are two blips', async () => {
  const r = rig();
  r.sessions = pending(A);
  r.feed.start();
  await r.flush();
  await r.advance(RISE_HOLD_MS);
  assert.deepEqual(r.counts, [1]);
  r.failNext = new TypeError('network');
  await r.feed.poll();
  await r.feed.poll(); // answers
  r.failNext = new TypeError('network');
  await r.feed.poll();
  assert.deepEqual(r.counts, [1], 'no two misses in a row: the mascot stays');
  r.feed.stop();
});

test('an undated pending session sorts after a dated one, whichever the server lists first', () => {
  const dated = sess(A, { attention: true, pendingSince: '2026-09-22T10:00:00.000Z' });
  const undated = sess(D, { turnEnded: true });
  assert.deepEqual(pendingSessions([dated, undated]), [A, D]);
  assert.deepEqual(pendingSessions([undated, dated]), [A, D]);
});

test('a stale answer that would LOWER the count is dropped too', async () => {
  const r = rig();
  r.sessions = pending(A);
  r.feed.start();
  await r.flush();
  await r.advance(RISE_HOLD_MS);
  assert.deepEqual(r.counts, [1]);
  let release: (v: unknown) => void = () => {};
  const feed = r.feed as unknown as { opts: { getSessions: () => Promise<unknown> } };
  const real = feed.opts.getSessions;
  feed.opts.getSessions = () => new Promise((res) => (release = res));
  const slow = r.feed.poll(); // asked first: answers "nothing pending"
  feed.opts.getSessions = real;
  await r.feed.poll(); // asked second, answers first: A is still pending
  release([]);
  await slow;
  assert.deepEqual(r.counts, [1], 'the older answer must not take the mascot away');
  r.feed.stop();
});

test('clampMascot: an array is not `{enabled:false}`, so it reads as on', () => {
  assert.equal(clampMascot([]), true);
  assert.equal(clampMascot([false]), true);
});

test('main.ts: the live page says count 0 to the host BEFORE the first poll (the host shows nothing until it hears)', () => {
  const src = read('web/src/mascot/main.ts');
  const live = src.slice(src.indexOf('} else {', src.indexOf('if (demo) {')));
  assert.match(live, /report\(\);\s*feed\.start\(\);/, 'report() first, then the feed starts');
});
