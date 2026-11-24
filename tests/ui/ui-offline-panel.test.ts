/**
 * Quality Q17 P3 — the offline panel and the one `Restart`
 * (`web/src/ui/offline-panel.ts`, `web/src/ui/relaunch.ts`,
 * `web/src/ui/host-bridge.ts` `requestRelaunch`/`onRelaunchFailed`;
 * `.claude/plans/quality/PLAN-Q17.md` § P3 item 1, § Test gate P3).
 *
 * Pinned here: the panel comes ten seconds after the FIRST failed poll, not
 * before; never during the app's own restart (and a streak that began before
 * it is forgotten), never while the caller blocks it; an answer takes it
 * away. In the host: `Restart` writes `aism.recover`, arms the restart gap,
 * posts exactly `relaunch` once and shows `Restarting…`; `relaunch-failed`
 * (or no answer in `RELAUNCH_WAIT_MS`) shows the error and the shortcut
 * advice, clears the flag and disarms the gap; anything but exactly
 * `relaunch-failed` is ignored. Outside the host: no button, the advice.
 *
 * `../state.ts` and `../log.ts` are stubbed for the two modules; the host is
 * a fake `window.chrome.webview` on the DOM double; time is the double's
 * recorded timers plus an injected clock.
 *
 * NOT claimed: the real host closing this window and starting a new one
 * (the user's Windows checklist, PLAN-Q17.md § Final gate); the restart
 * dialog's own `Restart` (`ui-restart-relaunch.test.ts`); layout and colour
 * in a real browser.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { byClass, buttonByLabel, installDom, type FakeElement } from '../helpers/fake-dom.ts';
import { makeHostChannel } from '../helpers/fake-host-channel.ts';

const dom = installDom();

interface Harness {
  restarting: boolean[];
  subscribers: ((kind: string) => void)[];
  logs: string[];
}
const H: Harness = { restarting: [], subscribers: [], logs: [] };
(globalThis as unknown as Record<string, unknown>).__opHarness = H;

const STUB_SRC: Record<string, string> = {
  state: `
    const H = globalThis.__opHarness;
    export const state = { restarting: false, backendReachable: true };
    export function setRestarting(v) {
      state.restarting = v;
      H.restarting.push(v);
      for (const fn of H.subscribers) fn('conn');
    }
    export function subscribe(fn) { H.subscribers.push(fn); }`,
  log: `
    const H = globalThis.__opHarness;
    const rec = (l) => H.logs.push(l);
    export const log = { debug: rec, info: rec, warn: rec, error: rec };`,
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/\/web\/src\/ui\/(?:offline-panel|relaunch)\.ts$/.test(context.parentURL ?? '')) {
      const m = /^\.\.\/(state|log)\.ts$/.exec(specifier);
      if (m !== null) return { url: `op-stub:${m[1] as string}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith('op-stub:')) {
      return { format: 'module', source: STUB_SRC[url.slice('op-stub:'.length)], shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

interface Panel {
  fail(): void;
  ok(): void;
}
interface OpModule {
  initOfflinePanel(host: unknown, deps: { blocked(): boolean; now(): number }): Panel;
}
interface StateStub {
  state: { restarting: boolean; backendReachable: boolean };
  setRestarting(v: boolean): void;
}
const OP = (await import(new URL('../../web/src/ui/offline-panel.ts', import.meta.url).href)) as OpModule;
const ST = (await import('op-stub:state' as string)) as StateStub;

const host = makeHostChannel();
const win = dom.win as unknown as { chrome?: unknown };

let clock = 0;
let blockedNow = false;

/**
 * The clock the timers run on: the double records `setTimeout` without firing
 * it, so a test steps `clock` and `advance` fires what is due by then.
 */
const pending: { fn: () => void; at: number; id: number; ms: number }[] = [];
let nextId = 1;
const w = dom.win as unknown as {
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
};
w.setTimeout = (fn, ms) => {
  const id = nextId++;
  pending.push({ fn, at: clock + ms, id, ms });
  return id;
};
w.clearTimeout = (id) => {
  const i = pending.findIndex((t) => t.id === id);
  if (i !== -1) pending.splice(i, 1);
};

/** A fresh panel on a fresh host element. */
function make(): { panel: Panel; scrim: FakeElement } {
  const el = dom.doc.createElement('div');
  dom.body.append(el);
  const panel = OP.initOfflinePanel(el, { blocked: () => blockedNow, now: () => clock });
  return { panel, scrim: el.children[0] as FakeElement };
}

/** Advance the clock and fire every timer that is due by then. */
function advance(ms: number): void {
  clock += ms;
  for (const t of pending.filter((p) => p.at <= clock)) {
    w.clearTimeout(t.id);
    t.fn();
  }
}

const visible = (n: FakeElement): boolean => !n.hidden;

beforeEach(() => {
  // A relaunch a test left waiting is module state: settle it first.
  host.say('relaunch-failed');
  pending.length = 0;
  clock = 1_000_000;
  blockedNow = false;
  ST.state.restarting = false;
  ST.state.backendReachable = true;
  H.restarting = [];
  H.logs = [];
  host.posted = [];
  host.listeners.clear();
  win.chrome = { webview: host };
  dom.storage.clear();
});

test('the panel is the restart card with the danger edge, the spec’s words, hidden at first', () => {
  const { scrim } = make();
  assert.equal(scrim.className, 'modal-scrim rs-scrim', 'modal-scrim: ui/keys.ts sees an open dialog');
  assert.equal(scrim.hidden, true);
  const modal = scrim.children[0] as FakeElement;
  assert.equal(modal.className, 'rs-modal op-modal');
  assert.equal(modal.getAttribute('role'), 'alertdialog');
  assert.equal((byClass(scrim, 'rs-title')[0] as FakeElement).textContent, 'The app stopped responding');
  assert.equal((byClass(scrim, 'rs-sub')[0] as FakeElement).textContent, 'WSL or the background service stopped.');
});

test('it comes ten seconds after the first failed poll, not before', () => {
  const { panel, scrim } = make();
  panel.fail();
  advance(3000);
  panel.fail();
  advance(3000);
  panel.fail();
  assert.equal(scrim.hidden, true, '6 s: still the pill alone');
  advance(4000);
  assert.equal(scrim.hidden, false, '10 s after the first failure');
  assert.ok(H.logs.includes('offline panel shown: unreachable for 10 s'));
});

test('an answer in between starts the count again', () => {
  const { panel, scrim } = make();
  panel.fail();
  advance(8000);
  panel.ok();
  panel.fail();
  advance(5000);
  assert.equal(scrim.hidden, true);
});

test('never during the app’s own restart, and a streak from before it is forgotten', () => {
  const { panel, scrim } = make();
  panel.fail();
  ST.setRestarting(true);
  advance(20_000);
  assert.equal(scrim.hidden, true, 'the backend is supposed to be away');
  ST.setRestarting(false);
  panel.fail();
  advance(5000);
  assert.equal(scrim.hidden, true, 'a new streak, five seconds old');
  advance(5000);
  assert.equal(scrim.hidden, false);
});

test('a blocked panel (restart dialog open, 401 takeover) waits, then shows on the next failure', () => {
  const { panel, scrim } = make();
  blockedNow = true;
  panel.fail();
  advance(15_000);
  assert.equal(scrim.hidden, true);
  blockedNow = false;
  panel.fail();
  assert.equal(scrim.hidden, false);
});

test('the backend answering again takes the panel away', () => {
  const { panel, scrim } = make();
  panel.fail();
  advance(10_000);
  assert.equal(scrim.hidden, false);
  panel.ok();
  assert.equal(scrim.hidden, true);
});

test('in the host: Restart writes the flag, arms the gap, posts exactly relaunch and shows Restarting…', () => {
  const { panel, scrim } = make();
  panel.fail();
  advance(10_000);
  const before = Date.now();
  buttonByLabel(scrim, 'Restart').click();
  assert.deepEqual(host.posted, ['relaunch']);
  const flag = Number(dom.storage.getItem('aism.recover'));
  assert.ok(flag >= before && flag <= Date.now(), 'the flag is the press time in epoch ms');
  assert.deepEqual(H.restarting, [true], 'the gap is armed: no reload may race the new window');
  assert.equal(visible(byClass(scrim, 'rs-progress')[0] as FakeElement), true);
  assert.equal((byClass(scrim, 'rs-step')[0] as FakeElement).textContent, 'Restarting…');
  assert.equal((byClass(scrim, 'rs-ft')[0] as FakeElement).hidden, true, 'no second press while it waits');
  assert.equal(scrim.hidden, false, 'its own gap does not take it away');
  panel.ok();
  assert.equal(scrim.hidden, false, 'nor does an answer: the window is about to be replaced');
});

test('relaunch-failed: the error and the shortcut advice, the flag cleared, the gap disarmed, Restart again', () => {
  const { panel, scrim } = make();
  panel.fail();
  advance(10_000);
  buttonByLabel(scrim, 'Restart').click();
  host.say('relaunch-failed ');
  host.say('{"type":"relaunch-failed"}');
  assert.equal((byClass(scrim, 'rs-fail')[0] as FakeElement).hidden, true, 'only the exact word counts');
  host.say('relaunch-failed');
  const fail = byClass(scrim, 'rs-fail')[0] as FakeElement;
  assert.equal(fail.hidden, false);
  assert.equal(fail.textContent, 'The restart did not work.');
  const advice = byClass(scrim, 'rs-lead')[0] as FakeElement;
  assert.equal(advice.hidden, false);
  assert.equal(advice.textContent, 'Close this window and start the app again from the desktop shortcut.');
  assert.equal(dom.storage.getItem('aism.recover'), null);
  assert.deepEqual(H.restarting, [true, false]);
  assert.equal(host.listeners.size, 0, 'the reply listener is gone');
  buttonByLabel(scrim, 'Restart').click();
  assert.deepEqual(host.posted, ['relaunch', 'relaunch'], 'a retry posts again');
});

test('a host that never answers: the page gives up after its own ceiling', () => {
  const { panel, scrim } = make();
  panel.fail();
  advance(10_000);
  buttonByLabel(scrim, 'Restart').click();
  assert.ok(pending.some((t) => t.ms === 150_000), 'the RELAUNCH_WAIT_MS ceiling is armed');
  advance(149_999);
  assert.equal((byClass(scrim, 'rs-fail')[0] as FakeElement).hidden, true, 'still waiting');
  advance(1);
  assert.equal((byClass(scrim, 'rs-fail')[0] as FakeElement).hidden, false);
  assert.ok(H.logs.includes('relaunch failed: no answer from the window host'));
});

test('outside the host: no button, the shortcut advice', () => {
  delete win.chrome;
  const { panel, scrim } = make();
  panel.fail();
  advance(10_000);
  assert.equal(scrim.hidden, false);
  assert.equal((byClass(scrim, 'rs-ft')[0] as FakeElement).hidden, true);
  const advice = byClass(scrim, 'rs-lead')[0] as FakeElement;
  assert.equal(advice.hidden, false);
  assert.equal(advice.textContent, 'Close this window and start the app again from the desktop shortcut.');
  assert.equal((byClass(scrim, 'rs-fail')[0] as FakeElement).hidden, true, 'nothing failed yet');
  assert.equal(dom.doc.activeElement, advice, 'the keyboard leaves the dead terminal for the advice');
});

test('a presence pong that flips the readout back to reachable takes the panel away too', () => {
  const { panel, scrim } = make();
  panel.fail();
  advance(10_000);
  ST.state.backendReachable = false;
  assert.equal(scrim.hidden, false);
  ST.state.backendReachable = true;
  for (const fn of H.subscribers) fn('conn');
  assert.equal(scrim.hidden, true);
});

// Test gate 2026-11-24: the two tests below each kill a mutant the file let
// through — the restart gap no longer blocking the panel, and a second
// `startRelaunch` posting a second `relaunch`.

test('the polls that fail DURING the app’s own restart never bring the panel', () => {
  const { panel, scrim } = make();
  ST.setRestarting(true);
  panel.fail();
  advance(10_000);
  panel.fail();
  advance(10_000);
  assert.equal(scrim.hidden, true, 'twenty seconds of failures inside the restart gap');
});

test('a panel that opens while a Restart already waits joins it: no second relaunch, one failure for both', () => {
  // The restart dialog's Restart (or another panel's) pressed first …
  const first = make();
  first.panel.fail();
  advance(10_000);
  buttonByLabel(first.scrim, 'Restart').click();
  assert.deepEqual(host.posted, ['relaunch']);
  // … then a second panel reaches its ten seconds: it shows the same wait.
  const second = make();
  second.panel.fail();
  advance(10_000);
  assert.equal(second.scrim.hidden, false);
  assert.equal((byClass(second.scrim, 'rs-step')[0] as FakeElement).textContent, 'Restarting…');
  assert.deepEqual(host.posted, ['relaunch'], 'the host is asked once');
  host.say('relaunch-failed');
  for (const { scrim } of [first, second]) {
    assert.equal((byClass(scrim, 'rs-fail')[0] as FakeElement).hidden, false, 'both hear the failure');
  }
});
