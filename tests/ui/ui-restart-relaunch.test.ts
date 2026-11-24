/**
 * Quality Q17 P3 — the restart dialog's "did not come back" state gets the
 * offline panel's `Restart` in the WebView2 host (`web/src/ui/update.ts` with
 * `web/src/ui/relaunch.ts`; `.claude/plans/quality/PLAN-Q17.md` § P3 item 1,
 * last sentence).
 *
 * Pinned here: after a restart that did not come back the footer offers
 * `Restart` beside `Close` in the host, and it has the keyboard; it is absent
 * outside the host and on every other ending (a busy 409); pressing it posts
 * `relaunch` once and says `Restarting…`; `relaunch-failed` puts the error
 * and the shortcut advice in the message slot and gives the button back.
 *
 * The REAL `ui/update.ts`, `ui/relaunch.ts`, `ui/restart-flow.ts` and models
 * on the DOM double; `../api.ts`, `../state.ts`, `../log.ts`, `./panes.ts`
 * and `./releases.ts` stubbed (as in `ui-a8-restart-dom.test.ts`, whose
 * harness this follows); the host is a fake `window.chrome.webview`.
 *
 * NOT claimed: the host really relaunching (the user's Windows checklist);
 * the dialog's other states (`ui-a8-restart-dom.test.ts`).
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { byClass, descendants, installDom, type FakeElement, oneByClass as one } from '../helpers/fake-dom.ts';
import { drainMicrotasks } from '../helpers/helpers.ts';
import { makeHostChannel } from '../helpers/fake-host-channel.ts';

const dom = installDom();

interface Harness {
  answer: { status: number; body: unknown };
  restarting: boolean[];
}
const H: Harness = { answer: { status: 500, body: {} }, restarting: [] };
(globalThis as unknown as Record<string, unknown>).__rrHarness = H;

const STUB_SRC: Record<string, string> = {
  api: `
    const H = globalThis.__rrHarness;
    export async function restartBackend() { return H.answer; }
    export async function backendHealth() { return false; }
    export async function startUpdate() { return { status: 503, body: {} }; }
    export async function updateStatus() { return { status: 404, body: {} }; }`,
  state: `
    const H = globalThis.__rrHarness;
    export const state = {
      sessions: new Map(),
      projects: [],
      update: null,
      restarting: false,
      serverStartedAt: null,
      serverCommit: null,
      version: null,
    };
    export function projectName() { return null; }
    export function setRestarting(v) { state.restarting = v; H.restarting.push(v); }
    export function setRunStamp() {}
    export function subscribe() {}`,
  log: `
    const noop = () => {};
    export const log = { debug: noop, info: noop, warn: noop, error: noop, hold: noop, resume: noop };
    export function formatError(e) { return String(e); }`,
  panes: `export function requestTerminalFocus() {}`,
  releases: `export function openReleasesPage() {}`,
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/\/web\/src\/ui\/(?:update|relaunch)\.ts$/.test(context.parentURL ?? '')) {
      const m = /^\.\.?\/(api|state|log|panes|releases)\.ts$/.exec(specifier);
      if (m !== null) return { url: `rr-stub:${m[1] as string}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith('rr-stub:')) {
      return { format: 'module', source: STUB_SRC[url.slice('rr-stub:'.length)], shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

interface UpdateModule {
  initUpdate(modalHost: unknown): { pill: unknown; toasts: unknown };
  openRestartConfirm(source?: 'settings'): void;
  closeRestartConfirm(): void;
  isRestartConfirmOpen(): boolean;
}
const UP = (await import(new URL('../../web/src/ui/update.ts', import.meta.url).href)) as UpdateModule;

const host = makeHostChannel();
const win = dom.win as unknown as { chrome?: unknown };

const modalHost = dom.doc.createElement('div');
dom.body.append(modalHost);
UP.initUpdate(modalHost);
const scrim = modalHost.children[modalHost.children.length - 1] as FakeElement;
const modal = scrim.children[0] as FakeElement;
/** The footer's visible buttons, in order. */
const visibleButtons = (): FakeElement[] =>
  descendants(one(modal, 'rs-ft')).filter((c) => c.tagName === 'BUTTON' && !c.hidden);
const shown = (): string[] => visibleButtons().map((c) => c.textContent);
const press = (label: string): void => {
  const b = visibleButtons().find((c) => c.textContent === label);
  assert.ok(b !== undefined, `no visible ${label}`);
  b.click();
};
const message = (): string => (byClass(modal, 'rs-fail')[0] as FakeElement).textContent;

/** Open the dialog and let the restart end with `answer`. */
async function endWith(answer: { status: number; body: unknown }): Promise<void> {
  H.answer = answer;
  UP.openRestartConfirm('settings');
  press('Restart');
  await drainMicrotasks(12);
}

beforeEach(() => {
  host.say('relaunch-failed'); // settle a relaunch a test left waiting
  if (UP.isRestartConfirmOpen()) UP.closeRestartConfirm();
  host.posted = [];
  H.restarting = [];
  win.chrome = { webview: host };
  dom.storage.clear();
});

test('did not come back, in the host: Restart beside Close, and it has the keyboard', async () => {
  await endWith({ status: 500, body: {} });
  assert.equal(
    message(),
    'The backend did not come back. Close this window and start the app again from the desktop shortcut.',
  );
  assert.deepEqual(shown(), ['Close', 'Restart']);
  const restart = visibleButtons().find((c) => c.textContent === 'Restart');
  assert.equal(dom.doc.activeElement, restart);
});

test('outside the host the same state has Close alone', async () => {
  delete win.chrome;
  await endWith({ status: 500, body: {} });
  assert.deepEqual(shown(), ['Close']);
});

test('another ending (a busy 409) never offers it', async () => {
  await endWith({ status: 409, body: { error: 'A restart is already running. Give it a moment.' } });
  assert.deepEqual(shown(), ['Close']);
});

test('Restart posts relaunch once, says Restarting…, and a failure gives the advice and the button back', async () => {
  await endWith({ status: 500, body: {} });
  press('Restart');
  assert.deepEqual(host.posted, ['relaunch']);
  assert.ok(dom.storage.getItem('aism.recover') !== null, 'the next window will resume at once');
  assert.deepEqual(shown(), ['Restarting…']);
  assert.equal(dom.doc.activeElement, byClass(modal, 'rs-fail')[0], 'the keyboard stays in the dialog while it waits');
  host.say('relaunch-failed');
  assert.equal(message(), 'The restart did not work. Close this window and start the app again from the desktop shortcut.');
  assert.deepEqual(shown(), ['Close', 'Restart']);
  assert.equal(dom.storage.getItem('aism.recover'), null);
});
