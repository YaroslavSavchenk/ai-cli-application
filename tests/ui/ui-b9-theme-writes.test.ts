/**
 * Nocturne B9 (`.claude/plans/nocturne/PLAN-B9.md`) — the write policy of the
 * REAL `web/src/ui/theme.ts` (D4) and `adopt()`, the pair that came FROM the
 * server. Split from `tests/ui/ui-b9-theme.test.ts`.
 *
 * What: trailing-debounced ~300ms, SERIALISED — one request in flight, at most
 * one queued follow-up carrying the latest pair — and `flush()` sends now,
 * which is what closing the dialog does; a rejected PUT never reaches the
 * caller; `adopt()` never reverts a write of ours that is scheduled or in
 * flight. A burst of fifty swatch drags must cost one PUT, not fifty.
 *
 * How: the REAL `web/src/api.ts` on a fetch double whose PUTs this file can
 * hold (`gatePut`) or fail once (`failNextPut`); timers are RECORDED by the
 * DOM double and fired by `runTimers()`, so nothing waits on a clock (doubles
 * and stubs: `tests/helpers/ui-b9-theme-fixture.ts`).
 *
 * Looks stay manual (`.claude/skills/verify-terminal/SKILL.md`): this proves
 * the values, not that they are pretty on a screen.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dom,
  ops,
  sets,
  calls,
  bag,
  held,
  releasePuts,
  puts,
  H,
  TH,
  TC,
  NOCTURNE,
  AMBER,
  AMBER_COLOURS,
  PHOSPHOR,
  until,
  runTimers,
  reset,
  cached,
  putSwitches,
} from '../helpers/ui-b9-theme-fixture.ts';

/** The fixture's PUT switches, owned here because the tests below flip them. */
let gatePut = false;
let failNextPut = false;
putSwitches({
  gate: () => gatePut,
  failNext: () => failNextPut,
  set: (to) => {
    if (to.gatePut !== undefined) gatePut = to.gatePut;
    if (to.failNextPut !== undefined) failNextPut = to.failNextPut;
  },
});

// ===========================================================================
// The write policy: debounced, serialised, flushable
// ===========================================================================

test('a burst of three applies: localStorage at once each time, ONE timer, ONE PUT with the LAST pair — and the merge keeps the other bag keys', async () => {
  const other = {
    statusLine: { enabled: true, model: true },
    behaviour: { confirmClose: false },
    tools: ['claude', 'gemini'],
  };
  reset({ serverBag: { ...other } });
  const ctl = TH.initTheme(undefined);

  ctl.apply(PHOSPHOR);
  assert.equal(cached(), `{"ground":"${PHOSPHOR.ground}","text":"${PHOSPHOR.text}"}`, 'written at once');
  ctl.apply({ ground: '#0a1220', text: '#e8f4ff' });
  assert.equal(cached(), '{"ground":"#0a1220","text":"#e8f4ff"}');
  ctl.apply(AMBER);
  assert.equal(cached(), '{"ground":"#161010","text":"#ffe9c4"}', 'the cache never lags a change');

  assert.equal(dom.win.timers.length, 1, 'ONE trailing timer for three changes, not three');
  assert.equal(dom.win.timers[0]?.ms, 300, 'the debounce is ~300ms (D4)');
  assert.deepEqual([...calls], [], 'nothing has reached the server while the timer is armed');

  assert.equal(runTimers(), 1);
  await until('the debounced write lands', () => puts().length === 1);
  await ctl.flush();

  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.path}`),
    ['GET /api/prefs', 'PUT /api/prefs'],
    'one read-modify-write, not three',
  );
  assert.deepEqual(calls[1]?.body, {
    statusLine: { enabled: true, model: true },
    behaviour: { confirmClose: false },
    tools: ['claude', 'gemini'],
    theme: { ground: '#161010', text: '#ffe9c4' },
  });
});

test('a change DURING the in-flight write costs exactly ONE follow-up, carrying the latest pair', async () => {
  reset();
  const ctl = TH.initTheme(undefined);
  gatePut = true;

  ctl.apply(PHOSPHOR);
  runTimers();
  await until('the first write reaches its PUT', () => held.length === 1);
  assert.deepEqual(puts(), [{ ground: PHOSPHOR.ground, text: PHOSPHOR.text }], 'sent, and hanging');
  assert.deepEqual({ ...bag }, {}, 'the server has not taken it yet — this write is in flight');

  ctl.apply({ ground: '#0a1220', text: '#e8f4ff' });
  ctl.apply(AMBER);
  assert.equal(runTimers(), 1, 'the two mid-flight changes share one timer');
  assert.equal(held.length, 1, 'and firing it starts NO second request while one is in flight');
  assert.equal(puts().length, 1, 'still exactly one request, as D4 requires');

  releasePuts();
  await ctl.flush();
  assert.deepEqual(
    puts(),
    [
      { ground: PHOSPHOR.ground, text: PHOSPHOR.text },
      { ground: '#161010', text: '#ffe9c4' },
    ],
    'two writes total: the one in flight, then ONE follow-up with the latest pair',
  );
});

test('flush() sends a pending write NOW and disarms the timer (the dialog closing is the deadline)', async () => {
  reset();
  const ctl = TH.initTheme(undefined);
  ctl.apply(AMBER);
  assert.equal(dom.win.timers.length, 1);
  assert.deepEqual([...calls], [], 'the 300ms has not passed');

  await ctl.flush();
  assert.deepEqual(puts(), [{ ground: '#161010', text: '#ffe9c4' }], 'flush did not wait for the clock');
  assert.deepEqual(dom.win.timers, [], 'and it left no armed timer behind');

  assert.equal(runTimers(), 0, 'nothing is left to fire — a flushed write is never sent twice');
  await ctl.flush();
  assert.equal(puts().length, 1);
});

test('flush() with nothing pending resolves and sends nothing', async () => {
  reset();
  const ctl = TH.initTheme(undefined);
  await assert.doesNotReject(ctl.flush());
  assert.deepEqual([...calls], [], 'no request at all');
});

test('a rejected PUT never reaches the caller — and the next change still gets written', async () => {
  reset();
  const ctl = TH.initTheme(undefined);
  failNextPut = true;
  ctl.apply(AMBER);
  await assert.doesNotReject(ctl.flush(), 'a failed server write is non-fatal: the local copy already holds it');
  assert.equal(cached(), '{"ground":"#161010","text":"#ffe9c4"}');
  assert.equal(puts().length, 1, 'the failed PUT was attempted');

  ctl.apply(PHOSPHOR);
  await ctl.flush();
  assert.deepEqual(puts().at(-1), { ground: PHOSPHOR.ground, text: PHOSPHOR.text }, 'the writer is not stuck');
});

test('applying the pair already in force is a NO-OP: no repaint, no timer, no PUT', async () => {
  reset({ cache: AMBER });
  const ctl = TH.initTheme(undefined);
  ops.length = 0;
  H.refreshes = 0;

  ctl.apply({ ...AMBER });
  ctl.apply({ ground: '#161010', text: '#FFE9C4' }); // the same pair, spelled loudly
  assert.deepEqual(ops, [], 'nothing was written to :root');
  assert.equal(H.refreshes, 0, 'no terminal was repainted');
  assert.deepEqual(dom.win.timers, [], 'no server write was scheduled');

  ctl.apply(PHOSPHOR);
  assert.equal(dom.win.timers.length, 1, 'non-vacuity: a REAL change does schedule one');
  await ctl.flush();
});

test('apply CLAMPS what it is handed: junk members fall back to Nocturne instead of painting `undefined`', async () => {
  reset({ cache: AMBER });
  const ctl = TH.initTheme(undefined);
  ops.length = 0;
  ctl.apply({ ground: 'chartreuse', text: '#fafafa' });
  assert.deepEqual(ctl.current(), { ground: NOCTURNE.ground, text: '#fafafa' });
  assert.deepEqual(
    ops,
    sets({
      ground: '#0b0d14',
      cmd: '#fafafa',
      out: '#fafafa',
      dim: TC.mixHex('#fafafa', '#0b0d14', 0.55),
    }),
  );
  await ctl.flush();
  assert.deepEqual(puts(), [{ ground: '#0b0d14', text: '#fafafa' }], 'and the clamped pair is what is stored');
});

// ===========================================================================
// adopt(): the server's own pair, taken without being written back
// ===========================================================================

test('adopt() paints and caches a pair that came FROM the server — no timer, no PUT', async () => {
  reset();
  const ctl = TH.initTheme(undefined);
  ops.length = 0;
  H.refreshes = 0;

  ctl.adopt(AMBER);
  assert.deepEqual(ops, sets(AMBER_COLOURS), 'the six properties are written, exactly as apply writes them');
  assert.equal(H.refreshes, 1, 'and every live terminal is repainted');
  assert.equal(cached(), '{"ground":"#161010","text":"#ffe9c4"}', 'the local cache follows');
  assert.deepEqual(ctl.current(), AMBER, 'it is the pair in force now');
  assert.deepEqual(dom.win.timers, [], 'NOTHING is scheduled: the server already has this pair');
  assert.deepEqual([...calls], [], 'and nothing is sent');
  await ctl.flush();
  assert.deepEqual([...calls], [], 'not even a flush has anything to send');
});

test('adopt() is a NO-OP while a write of ours is scheduled — a stale answer never reverts a fresh choice', async () => {
  reset();
  const ctl = TH.initTheme(undefined);
  ctl.apply(PHOSPHOR); // the user just picked this; the 300ms timer is armed
  ops.length = 0;

  ctl.adopt(AMBER); // the panel's re-read, answered with what was on disk BEFORE
  assert.deepEqual(ops, [], 'nothing was repainted');
  assert.deepEqual(ctl.current(), PHOSPHOR, 'the choice stands');
  assert.equal(cached(), `{"ground":"${PHOSPHOR.ground}","text":"${PHOSPHOR.text}"}`, 'and the cache with it');

  await ctl.flush();
  assert.deepEqual(puts(), [{ ground: PHOSPHOR.ground, text: PHOSPHOR.text }], 'the durable copy is the choice');
});

test('adopt() is a NO-OP while a write of ours is IN FLIGHT, and works again once it lands', async () => {
  reset();
  const ctl = TH.initTheme(undefined);
  gatePut = true;
  ctl.apply(PHOSPHOR);
  runTimers();
  await until('the write reaches its PUT', () => held.length === 1);
  ops.length = 0;

  ctl.adopt(AMBER);
  assert.deepEqual(ops, [], 'the in-flight PUT is newer than the answer being adopted');
  assert.deepEqual(ctl.current(), PHOSPHOR);

  releasePuts();
  await ctl.flush();
  ops.length = 0;
  ctl.adopt(AMBER); // another window really did change it, and nothing of ours is left
  assert.deepEqual(ops, sets(AMBER_COLOURS), 'with the write settled, the answer is taken');
  assert.deepEqual(dom.win.timers, [], 'still without scheduling a write of our own');
  assert.deepEqual(puts(), [{ ground: PHOSPHOR.ground, text: PHOSPHOR.text }], 'one PUT total: ours');
});

test('adopt() clamps like apply, and adopting the pair already in force repaints nothing', async () => {
  reset({ cache: AMBER });
  const ctl = TH.initTheme(undefined);
  ops.length = 0;
  H.refreshes = 0;

  ctl.adopt({ ground: '#161010', text: '#FFE9C4' }); // the same pair, spelled loudly
  assert.deepEqual(ops, [], 'no repaint');
  assert.equal(H.refreshes, 0);

  ctl.adopt({ ground: 'chartreuse', text: '#fafafa' });
  assert.deepEqual(ctl.current(), { ground: NOCTURNE.ground, text: '#fafafa' }, 'junk falls back to Nocturne');
  assert.deepEqual([...calls], [], 'and still nothing is written back');
});
