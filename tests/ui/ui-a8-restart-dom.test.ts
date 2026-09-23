/**
 * `web/src/ui/update.ts` — the restart/update confirmation (`rs-`, Nocturne
 * A8) driven through the REAL module on the DOM double in
 * `tests/helpers/fake-dom.ts`.
 *
 * WHY THIS FILE EXISTS. The rules of this flow are pinned DOM-free next door
 * (`tests/ui/ui-update-model.test.ts`, `tests/ui/ui-restart-guards.test.ts`) and the
 * looks are pinned by source scan (`tests/ui/ui-a8-dialogs.test.ts`,
 * `tests/ui/ui-settings-releases.test.ts`). Between the two sits the thing A8
 * actually rewrote — the DOM: every element of this dialog was renamed
 * (`restart-*`/`toast-*` -> `rs-`/`ut-`) and its footer rebuilt. A regex over
 * the file cannot tell whether the four STATES still paint, so this drives
 * them:
 *
 *   1. the QUESTION: the running sessions by name, the consequence sentence,
 *      Cancel + Restart, nothing else on screen;
 *   2. the PROGRESS: the spinner and the step line, every decision button
 *      gone, `Hide` offered while the preflight (which has torn nothing down)
 *      is out, and the percentage NOT shown for a restart;
 *   3. REFUSED (422): the backend's own sentence, the refused styling,
 *      `Try again` — and no "download it yourself" on a restart, which is a
 *      route for a problem the user does not have;
 *   4. FAILED/over (409 busy): the same message slot without the retry.
 *
 *   plus: it opens OVER an already-open dialog without closing it (the
 *   Settings panel case — `rs-scrim` is the one scrim on `--z-modal-top`),
 *   it keeps `modal-scrim` (ui/keys.ts finds an open dialog by that class),
 *   and `Hide` during the preflight leaves the flow running and lets the
 *   outcome bring the dialog back.
 *
 * `../api.ts`, `../state.ts`, `../log.ts`, `./panes.ts` and `./releases.ts`
 * are stubbed; the REAL `ui/util.ts`, `ui/update-model.ts`, `ui/update-flow.ts`
 * and `ui/restart-flow.ts` take part. Layout, hit-testing and screen-reader
 * output stay manual (`.claude/skills/verify-terminal/SKILL.md`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import type { SessionInfo, UpdateStatus } from '../../shared/protocol.ts';
import { byClass, dispatch, installDom, type FakeElement, oneByClass as one } from '../helpers/fake-dom.ts';

const dom = installDom();

// ===========================================================================
// Harness + module stubs
// ===========================================================================

interface Deferred {
  promise: Promise<{ status: number; body: unknown }>;
  resolve(v: { status: number; body: unknown }): void;
}

function deferred(): Deferred {
  let resolve!: (v: { status: number; body: unknown }) => void;
  const promise = new Promise<{ status: number; body: unknown }>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

interface Harness {
  sessions: Map<string, SessionInfo>;
  projects: { id: string; name: string }[];
  update: UpdateStatus | null;
  restarting: boolean[];
  /** Armed by a test: the answer `POST /api/restart` gives, once. */
  restartAnswer: Deferred | null;
  restartCalls: number;
  releasesOpened: number;
  terminalFocus: number;
}

const H: Harness = {
  sessions: new Map(),
  projects: [{ id: 'p1', name: 'api' }],
  update: null,
  restarting: [],
  restartAnswer: null,
  restartCalls: 0,
  releasesOpened: 0,
  terminalFocus: 0,
};
(globalThis as unknown as Record<string, unknown>).__rsHarness = H;

const STUB_SRC: Record<string, string> = {
  api: `
    const H = globalThis.__rsHarness;
    export async function restartBackend() {
      H.restartCalls += 1;
      if (H.restartAnswer === null) throw new Error('no restart answer armed');
      return H.restartAnswer.promise;
    }
    export async function backendHealth() { return false; }
    export async function startUpdate() { return { status: 503, body: {} }; }
    export async function updateStatus() { return { status: 404, body: {} }; }`,
  state: `
    const H = globalThis.__rsHarness;
    export const state = {
      get sessions() { return H.sessions; },
      get projects() { return H.projects; },
      get update() { return H.update; },
      restarting: false,
      serverStartedAt: null,
      serverCommit: null,
      version: null,
    };
    export function projectName(id) {
      if (id === undefined) return null;
      const p = H.projects.find((p) => p.id === id);
      return p !== undefined ? p.name : null;
    }
    export function setRestarting(v) { state.restarting = v; H.restarting.push(v); }
    export function setRunStamp(at) { state.serverStartedAt = at; }
    export function subscribe() {}`,
  log: `
    const noop = () => {};
    export const log = { debug: noop, info: noop, warn: noop, error: noop, hold: noop, resume: noop };
    export function formatError(e) { return String(e); }`,
  panes: `
    const H = globalThis.__rsHarness;
    export function requestTerminalFocus() { H.terminalFocus += 1; }`,
  releases: `
    const H = globalThis.__rsHarness;
    export function openReleasesPage() { H.releasesOpened += 1; }`,
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((context.parentURL ?? '').endsWith('/web/src/ui/update.ts')) {
      const m = /^\.\.?\/(api|state|log|panes|releases)\.ts$/.exec(specifier);
      if (m !== null) return { url: `rs-stub:${m[1] as string}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith('rs-stub:')) {
      return { format: 'module', source: STUB_SRC[url.slice('rs-stub:'.length)], shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

interface UpdateModule {
  initUpdate(modalHost: unknown): { pill: unknown };
  openRestartConfirm(source?: 'settings' | 'settings-update' | 'pill' | 'toast'): void;
  closeRestartConfirm(): void;
  isRestartConfirmOpen(): boolean;
  applyRuntime(): void;
}

const UP = (await import(new URL('../../web/src/ui/update.ts', import.meta.url).href)) as UpdateModule;

const modalHost = dom.doc.createElement('div');
dom.body.append(modalHost);

/** A dialog that is ALREADY open when the confirmation arrives (Settings). */
const settingsScrim = dom.doc.createElement('div');
settingsScrim.className = 'modal-scrim sg-scrim';
const settingsBtn = dom.doc.createElement('button');
settingsScrim.append(settingsBtn);
modalHost.append(settingsScrim);

UP.initUpdate(modalHost);

/** The confirmation's scrim: the last thing initUpdate appended. */
const scrim = modalHost.children[modalHost.children.length - 1] as FakeElement;
const modal = scrim.children[0] as FakeElement;
const toast = modalHost.children[modalHost.children.length - 2] as FakeElement;

const texts = (cls: string): string[] => byClass(modal, cls).map((n) => n.textContent);
/** The footer button whose label is this, whatever its state. */
const btn = (label: string): FakeElement => {
  const hit = byClass(one(modal, 'rs-ft'), 'btn-quiet')
    .concat(byClass(one(modal, 'rs-ft'), 'btn-accent'), byClass(one(modal, 'rs-ft'), 'rs-link'))
    .find((b) => b.textContent === label);
  assert.ok(hit !== undefined, `no footer button labelled ${label}`);
  return hit;
};
/** Let the awaited chain inside the module settle. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};

function session(id: string, over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id,
    projectId: 'p1',
    title: id,
    command: 'claude',
    args: [],
    cwd: '/home/tester/api',
    status: 'running',
    cols: 80,
    rows: 24,
    createdAt: new Date(0).toISOString(),
    attention: false,
    ...over,
  } as SessionInfo;
}

function setSessions(...s: SessionInfo[]): void {
  H.sessions = new Map(s.map((x) => [x.id, x]));
}

/** Back to a closed dialog with no flow in flight, whatever the last test left. */
function reset(): void {
  if (UP.isRestartConfirmOpen()) UP.closeRestartConfirm();
  H.restartAnswer = null;
  H.restarting.length = 0;
  H.restartCalls = 0;
  settingsBtn.focus();
}

// ===========================================================================
// 1. It opens over an open dialog, and keeps the class ui/keys.ts reads
// ===========================================================================

test('non-vacuity: initUpdate built the toast and the confirmation, both closed', () => {
  assert.equal(toast.className, 'ut-toast');
  assert.equal(toast.hidden, true);
  assert.equal(scrim.className, 'modal-scrim rs-scrim');
  assert.equal(scrim.hidden, true);
  assert.equal(modal.className, 'rs-modal');
  assert.equal(UP.isRestartConfirmOpen(), false);
  assert.ok(byClass(modal, 'rs-ft').length === 1, 'the dialog must have its footer');
});

test('the confirmation opens OVER an open dialog without closing it, and is appended last', () => {
  reset();
  setSessions(session('s1'));
  UP.openRestartConfirm('settings');
  assert.equal(UP.isRestartConfirmOpen(), true);
  assert.equal(settingsScrim.hidden, false, 'the dialog underneath stays open — this one sits on top');
  assert.equal(modalHost.children[modalHost.children.length - 1], scrim, 'the confirmation paints last');
  // The class ui/keys.ts recognises an open dialog by, on both of them.
  assert.equal(scrim.classList.contains('modal-scrim'), true);
  UP.closeRestartConfirm();
  assert.equal(scrim.hidden, true);
});

// ===========================================================================
// 2. The question
// ===========================================================================

test('the question names every running session, its project, and what it costs', () => {
  reset();
  setSessions(
    session('s1', { title: 'api server' }),
    session('s2', { title: 'notes', projectId: undefined }),
  );
  UP.openRestartConfirm('settings');
  assert.deepEqual(texts('rs-title'), ['Restart the background service?']);
  assert.deepEqual(texts('rs-sub'), ['Sessions end. History keeps them.']);
  assert.deepEqual(texts('rs-row'), ['api server, api', 'notes']);
  assert.deepEqual(texts('rs-name'), ['api server', 'notes']);
  assert.deepEqual(texts('rs-proj'), [', api']);
  const lead = byClass(modal, 'rs-lead').find((n) => !n.hidden);
  assert.ok(lead !== undefined && lead.textContent.startsWith('2 sessions are running'), 'the body states the cost');
  assert.equal(one(modal, 'rs-list').hidden, false);
  assert.equal(one(modal, 'rs-progress').hidden, true, 'no progress before anything runs');
  assert.equal(one(modal, 'rs-fail').hidden, true);
  assert.equal(btn('Restart').hidden, false);
  assert.equal(btn('Cancel').hidden, false);
  assert.equal(btn('Close').hidden, true);
  assert.equal(btn('Try again').hidden, true);
  assert.equal(btn('Hide').hidden, true);
  assert.equal(dom.doc.activeElement, btn('Restart'), 'the commitment takes focus');
  UP.closeRestartConfirm();
  assert.equal(dom.doc.activeElement, settingsBtn, 'closing hands the keyboard back to the opener');
});

test('an exited session is not in the list, and no session at all still asks the question', () => {
  reset();
  setSessions(session('s1', { status: 'exited' }));
  UP.openRestartConfirm('settings');
  assert.deepEqual(texts('rs-row'), []);
  assert.equal(one(modal, 'rs-list').hidden, true);
  const lead = byClass(modal, 'rs-lead').find((n) => !n.hidden);
  assert.equal(lead?.textContent, 'Nothing is running. The app reconnects by itself.');
  UP.closeRestartConfirm();
});

test('more running sessions than the list shows: six rows and a "+ n more" line', () => {
  reset();
  setSessions(...Array.from({ length: 8 }, (_, i) => session(`s${i}`, { title: `s${i}` })));
  UP.openRestartConfirm('settings');
  assert.equal(byClass(modal, 'rs-row').length, 6, 'the list is capped at CONFIRM_LIST_MAX');
  assert.deepEqual(texts('rs-more'), ['+ 2 more']);
  assert.equal(one(modal, 'rs-more').hidden, false);
  UP.closeRestartConfirm();
});

test('Restart service from Settings stays a restart even while an online release is pending', () => {
  reset();
  setSessions(session('s1'));
  H.update = {
    available: true,
    reason: 'a new version is available',
    release: {
      version: 'v0.3.0',
      setupName: 'AI-Session-Manager-Setup-v0.3.0.exe',
      setupUrl: 'https://example.invalid/s.exe',
      sumsUrl: 'https://example.invalid/SHA256SUMS.txt',
      size: 1024,
    },
  };
  UP.applyRuntime();
  UP.openRestartConfirm('settings');
  assert.deepEqual(texts('rs-title'), ['Restart the background service?'], 'the maintenance verb never becomes a download');
  assert.equal(btn('Restart').hidden, false);
  UP.closeRestartConfirm();

  // The same pending reason, asked from the TOAST, is the update question.
  UP.openRestartConfirm('toast');
  assert.deepEqual(texts('rs-title'), ['Update the app?']);
  assert.equal(btn('Update').hidden, false);
  const lead = byClass(modal, 'rs-lead').filter((n) => !n.hidden);
  assert.ok(lead.length === 2 && lead[0]?.textContent.includes('v0.3.0'), 'the update lead names the version');
  UP.closeRestartConfirm();
  H.update = null;
  UP.applyRuntime();
});

test('the answered check’s Update button is an update even with nothing pending', () => {
  reset();
  setSessions(session('s1'));
  // No notice at all: `noticeVerb(null)` is 'restart', so a source that routed
  // through it would run a PLAIN restart — every session ended, nothing
  // downloaded. `settings-update` maps to the update verb directly.
  H.update = null;
  UP.applyRuntime();
  UP.openRestartConfirm('settings-update');
  assert.deepEqual(texts('rs-title'), ['Update the app?']);
  assert.equal(btn('Update').hidden, false);
  assert.equal(modal.getAttribute('aria-label'), 'update the app');
  UP.closeRestartConfirm();
});

// ===========================================================================
// 3. The toast (`ut-`), and the dismissal the user complained about
// ===========================================================================

test('the toast arrives with the pill, says which version, and its button is the update verb', () => {
  reset();
  setSessions(session('s1'));
  H.update = {
    available: true,
    reason: 'a new version is available',
    release: {
      version: 'v0.3.0',
      setupName: 'AI-Session-Manager-Setup-v0.3.0.exe',
      setupUrl: 'https://example.invalid/s.exe',
      sumsUrl: 'https://example.invalid/SHA256SUMS.txt',
      size: 1024,
    },
  };
  UP.applyRuntime();
  assert.equal(toast.hidden, false, 'the toast is the arrival');
  assert.deepEqual(
    byClass(toast, 'ut-title').map((n) => n.textContent),
    ['New version available'],
  );
  const go = byClass(toast, 'btn-accent')[0];
  assert.equal(go?.textContent, 'Update', 'the release is still online, so the verb fetches it');
  const body = byClass(toast, 'ut-body')[0]?.textContent ?? '';
  assert.ok(body.includes('v0.3.0'), `the toast names the version it offers: ${body}`);
  // No address and no byte count ever reaches the DOM (PROJECT-SCOPE copy rule).
  const shown = [toast.textContent];
  for (const text of shown) {
    assert.equal(/https?:\/\//.test(text), false, `no address in UI copy: ${text}`);
    assert.equal(text.includes('1024'), false, `no byte count in UI copy: ${text}`);
  }
});

test('Later dismisses the toast for good: the pill stays, and the same reason never toasts again', () => {
  // The user's own report (2026-09-06): "de popup kun je wegklikken maar die
  // blijft ergens hangen". Dismissing the toast may not dismiss the NOTICE, and
  // a poll repeating the same reason may not bring the toast back.
  assert.equal(toast.hidden, false, 'the previous test left the toast up');
  const later = byClass(toast, 'btn-quiet').find((b) => b.textContent === 'Later');
  assert.ok(later !== undefined, 'the toast must offer Later');
  later.click();
  assert.equal(toast.hidden, true, 'the toast is gone');

  UP.applyRuntime();
  assert.equal(toast.hidden, true, 'the same reason must never toast a second time');

  // A NEWER release is a new offer and speaks up again.
  H.update = {
    available: true,
    reason: 'a new version is available',
    release: {
      version: 'v0.4.0',
      setupName: 'AI-Session-Manager-Setup-v0.4.0.exe',
      setupUrl: 'https://example.invalid/s4.exe',
      sumsUrl: 'https://example.invalid/SHA256SUMS.txt',
      size: 2048,
    },
  };
  UP.applyRuntime();
  assert.equal(toast.hidden, false, 'a later release is a new offer, not the dismissed one');

  // And the toast's own × dismisses it the same way.
  const x = byClass(toast, 'ut-x')[0];
  assert.ok(x !== undefined, 'the toast keeps its dismiss control');
  x.click();
  assert.equal(toast.hidden, true);
  H.update = null;
  UP.applyRuntime();
});

test('the toast asks the update question; the dialog it opens is the update one', () => {
  reset();
  setSessions(session('s1'));
  H.update = { available: true, reason: 'a new version is installed' };
  UP.applyRuntime();
  assert.equal(toast.hidden, false);
  const go = byClass(toast, 'btn-accent')[0];
  assert.equal(go?.textContent, 'Restart now', 'the new version is already on this machine');
  go?.click();
  assert.equal(UP.isRestartConfirmOpen(), true);
  assert.deepEqual(texts('rs-title'), ['Restart the background service?']);
  UP.closeRestartConfirm();
  H.update = null;
  UP.applyRuntime();
});

// ===========================================================================
// 3. Progress, Hide, and the outcomes
// ===========================================================================

test('pressing Restart shows the step line with no percentage, and offers Hide', async () => {
  reset();
  setSessions(session('s1'));
  H.restartAnswer = deferred();
  UP.openRestartConfirm('settings');
  btn('Restart').click();
  await settle();

  assert.equal(H.restartCalls, 1, 'the POST really went out');
  assert.deepEqual(H.restarting, [true], 'the restart gap is armed BEFORE the request');
  assert.equal(one(modal, 'rs-progress').hidden, false);
  assert.deepEqual(texts('rs-step'), ['Preparing the new version…']);
  assert.equal(one(modal, 'rs-pct').hidden, true, 'a restart has no percentage to show');
  assert.equal(one(modal, 'rs-pct').textContent, '');
  assert.deepEqual(texts('rs-title'), ['Restarting the background service']);
  assert.equal(btn('Restart').hidden, true, 'the question is over');
  assert.equal(btn('Cancel').hidden, true);
  assert.equal(btn('Hide').hidden, false, 'the preflight has torn nothing down, so it may be put away');
  assert.ok(byClass(modal, 'rs-spin').length === 1, 'the spinner is the honest indeterminate mark');

  // Hide: the dialog goes away, the flow does not.
  UP.closeRestartConfirm();
  assert.equal(UP.isRestartConfirmOpen(), false);
  assert.equal(H.restartCalls, 1, 'hiding sends nothing and cancels nothing');

  // The outcome brings it back.
  H.restartAnswer.resolve({ status: 422, body: { error: 'Dependencies changed. Install them first.' } });
  await settle();
  assert.equal(UP.isRestartConfirmOpen(), true, 'a hidden dialog is re-opened by its outcome');
  assert.deepEqual(texts('rs-fail'), ['Dependencies changed. Install them first.']);
});

test('a 422 is a refusal, not a failure: the backend s own sentence, Try again, and nothing was touched', async () => {
  reset();
  setSessions(session('s1'));
  H.restartAnswer = deferred();
  UP.openRestartConfirm('settings');
  btn('Restart').click();
  await settle();
  H.restartAnswer.resolve({ status: 422, body: { error: 'The frontend build failed.' } });
  await settle();

  assert.deepEqual(texts('rs-title'), ['Nothing was restarted']);
  assert.equal(one(modal, 'rs-fail').className, 'rs-fail is-refused', 'a refusal has its own styling');
  assert.deepEqual(texts('rs-fail'), ['The frontend build failed.']);
  assert.equal(one(modal, 'rs-progress').hidden, true);
  assert.equal(btn('Try again').hidden, false, 'the cause can be fixed and the button pressed again');
  assert.equal(btn('Close').hidden, false);
  assert.equal(btn('Restart').hidden, true);
  // The manual download route belongs to a refused UPDATE only: after a refused
  // restart the newer version is already on this machine.
  assert.equal(btn('Download it yourself').hidden, true);
  assert.equal(H.releasesOpened, 0);
  assert.equal(H.restarting.at(-1), false, 'the restart gap is dropped so the app can tell the truth again');

  // Try again re-posts, and the previous refusal is cleared from the slot.
  H.restartAnswer = deferred();
  btn('Try again').click();
  await settle();
  assert.equal(H.restartCalls, 2);
  assert.equal(one(modal, 'rs-fail').textContent, '', 'a retry must not show the previous refusal');
  H.restartAnswer.resolve({ status: 422, body: { error: 'Still no.' } });
  await settle();
  UP.closeRestartConfirm();
});

test('a 409 is a failure state: the message, Close, and no retry', async () => {
  reset();
  setSessions(session('s1'));
  H.restartAnswer = deferred();
  UP.openRestartConfirm('settings');
  btn('Restart').click();
  await settle();
  H.restartAnswer.resolve({ status: 409, body: { error: 'A restart is already running. Give it a moment.' } });
  await settle();

  assert.deepEqual(texts('rs-title'), ['Restart the background service']);
  assert.equal(one(modal, 'rs-fail').className, 'rs-fail', 'not the refused styling');
  assert.deepEqual(texts('rs-fail'), ['A restart is already running. Give it a moment.']);
  assert.equal(btn('Try again').hidden, true);
  assert.equal(btn('Close').hidden, false);
  assert.equal(dom.doc.activeElement, btn('Close'), 'the one remaining action holds the keyboard');
  UP.closeRestartConfirm();
});

test('a press on the backdrop closes the question; a press inside the card does not', () => {
  reset();
  setSessions(session('s1'));
  UP.openRestartConfirm('settings');
  dispatch(one(modal, 'rs-title'), 'mousedown');
  assert.equal(UP.isRestartConfirmOpen(), true);
  dispatch(scrim, 'mousedown');
  assert.equal(UP.isRestartConfirmOpen(), false);
});
