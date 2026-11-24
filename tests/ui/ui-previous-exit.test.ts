/**
 * Quality Q17 P3 — the boot notice after the previous run stopped, in the DOM
 * (`web/src/ui/previous-exit.ts`; `.claude/plans/quality/PLAN-Q17.md` § P3
 * item 2, § Test gate P3).
 *
 * Pinned here: a 204 shows nothing; a 200 without a fresh recover flag offers
 * `Resume N sessions` + `Dismiss` with the cause's sentence; a fresh flag
 * resumes at once without a question, and the flag is cleared at boot
 * whatever comes next; the result reads "N sessions resumed" (+ "M could not
 * be resumed"); the idempotent empty answer shows NOTHING and refetches the
 * sessions; a failed resume offers again with a sentence; Dismiss posts once
 * and hides; the resumed pairs reach `state.adoptResumed` with the boot's
 * snapshot; the log carries shapes only (no process name, no error text).
 *
 * `../api.ts`, `../state.ts` and `../log.ts` are stubbed for the module under
 * test; the model, `./util.ts` and the fake DOM are real.
 *
 * NOT claimed: where the sessions land in the tabs
 * (`ui-resume-layout-model.test.ts`); the corner stack's layout and colours in
 * a real browser (the fake DOM has no CSS); the server's routes
 * (`tests/server/previous-exit-routes.test.ts`).
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { byClass, buttonByLabel, installDom, type FakeElement } from '../helpers/fake-dom.ts';
import { drainMicrotasks } from '../helpers/helpers.ts';

const dom = installDom();

interface Harness {
  notice: unknown;
  resume: unknown;
  resumeThrows: boolean;
  calls: string[];
  adopted: { snapshot: unknown; pairs: unknown[] }[];
  sessionsSet: number;
  logs: string[];
}
const H: Harness = {
  notice: null,
  resume: null,
  resumeThrows: false,
  calls: [],
  adopted: [],
  sessionsSet: 0,
  logs: [],
};
(globalThis as unknown as Record<string, unknown>).__peHarness = H;

const STUB_SRC: Record<string, string> = {
  api: `
    const H = globalThis.__peHarness;
    export async function getPreviousExit() { H.calls.push('get'); return H.notice; }
    export async function resumePreviousExit() {
      H.calls.push('resume');
      if (H.resumeThrows) throw new Error('HTTP 500');
      return H.resume;
    }
    export async function dismissPreviousExit() { H.calls.push('dismiss'); return null; }
    export async function getSessions() { H.calls.push('sessions'); return []; }`,
  state: `
    const H = globalThis.__peHarness;
    export function adoptResumed(snapshot, pairs) { H.adopted.push({ snapshot, pairs }); }
    export function setSessions() { H.sessionsSet += 1; }`,
  log: `
    const H = globalThis.__peHarness;
    const rec = (l) => H.logs.push(l);
    export const log = { debug: rec, info: rec, warn: rec, error: rec };
    export function formatError(e) { return e instanceof Error ? e.message : String(e); }`,
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/\/web\/src\/ui\/previous-exit\.ts$/.test(context.parentURL ?? '')) {
      const m = /^\.\.\/(api|state|log)\.ts$/.exec(specifier);
      if (m !== null) return { url: `pe-stub:${m[1] as string}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith('pe-stub:')) {
      return { format: 'module', source: STUB_SRC[url.slice('pe-stub:'.length)], shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

interface PeModule {
  initPreviousExit(stack: unknown, snapshot: unknown, refocus: () => void): Promise<void>;
}
// Computed specifier: the server tsconfig must not walk the browser graph.
const PE = (await import(new URL('../../web/src/ui/previous-exit.ts', import.meta.url).href)) as PeModule;

const AT = new Date(2026, 10, 24, 12, 53).toISOString();
const SNAPSHOT = { views: [], active: 'marker' };
const session = (id: string): Record<string, unknown> => ({ id, title: 'claude', status: 'running', createdAt: AT });

let refocused = 0;

/** Boot the notice once on a fresh stack; answers the card. */
async function boot(): Promise<FakeElement> {
  const stack = dom.doc.createElement('div');
  dom.body.append(stack);
  await PE.initPreviousExit(stack, SNAPSHOT, () => {
    refocused += 1;
  });
  await drainMicrotasks(8);
  return stack.children[0] as FakeElement;
}
const text = (card: FakeElement, cls: string, i = 0): string => (byClass(card, cls)[i] as FakeElement).textContent;
const failLine = (card: FakeElement): FakeElement => byClass(card, 'px-fail')[0] as FakeElement;

beforeEach(() => {
  H.notice = null;
  H.resume = null;
  H.resumeThrows = false;
  H.calls = [];
  H.adopted = [];
  H.sessionsSet = 0;
  H.logs = [];
  refocused = 0;
  dom.storage.clear();
});

test('a 204 shows nothing and resumes nothing', async () => {
  const card = await boot();
  assert.deepEqual(H.calls, ['get']);
  assert.equal(card.hidden, true);
});

test('a start from the shortcut offers Resume N sessions and Dismiss, with the cause’s sentence', async () => {
  H.notice = { at: AT, cause: 'oom', detail: { process: 'python', rssMb: 2731 }, sessions: 3 };
  const card = await boot();
  assert.equal(card.hidden, false);
  assert.deepEqual(H.calls, ['get'], 'no resume without a press');
  assert.equal(text(card, 'ut-title'), '3 sessions stopped');
  assert.equal(text(card, 'ut-body'), 'WSL ran out of memory at 12:53 — python (2.7 GB) was stopped, and WSL shut down.');
  const actions = byClass(card, 'ut-actions')[0] as FakeElement;
  assert.deepEqual(actions.children.map((c) => c.textContent), ['Dismiss', 'Resume 3 sessions'], 'quiet first, action last');
  assert.equal((byClass(card, 'ut-x')[0] as FakeElement).hidden, true, 'the offer is answered with a button, not ×');
  assert.equal(failLine(card).hidden, true);
});

test('Resume N sessions resumes, hands the pairs and the snapshot to the store, and says how many', async () => {
  H.notice = { at: AT, cause: 'wsl-stopped', detail: null, sessions: 3 };
  H.resume = {
    resumed: [
      { historyId: 'h1', previousSessionId: 'old-1', session: session('new-1') },
      { historyId: 'h2', previousSessionId: 'old-2', session: session('new-2') },
    ],
    failed: [{ historyId: 'h3', error: 'This conversation is already open.' }],
  };
  const card = await boot();
  buttonByLabel(card, 'Resume 3 sessions').click();
  await drainMicrotasks(8);
  assert.deepEqual(H.calls, ['get', 'resume']);
  assert.equal(H.adopted.length, 1);
  assert.equal(H.adopted[0]?.snapshot, SNAPSHOT, 'the boot’s snapshot, not a fresh read');
  assert.deepEqual(
    (H.adopted[0]?.pairs as { previousSessionId: string }[]).map((p) => p.previousSessionId),
    ['old-1', 'old-2'],
  );
  assert.equal(text(card, 'ut-title'), '2 sessions resumed');
  assert.equal(text(card, 'ut-body'), 'WSL shut down at 12:53.');
  assert.equal(failLine(card).hidden, false);
  assert.equal(failLine(card).textContent, '1 could not be resumed');
  assert.equal((byClass(card, 'ut-actions')[0] as FakeElement).hidden, true, 'nothing left to answer');
  const x = byClass(card, 'ut-x')[0] as FakeElement;
  assert.equal(x.hidden, false);
  x.click();
  assert.equal(card.hidden, true);
  assert.equal(refocused, 1, 'the keyboard goes back to the pane');
});

test('a fresh recover flag resumes at once, without a question, and is cleared', async () => {
  dom.storage.setItem('aism.recover', String(Date.now() - 30_000));
  H.notice = { at: AT, cause: 'wsl-stopped', detail: null, sessions: 1 };
  H.resume = { resumed: [{ historyId: 'h1', previousSessionId: 'old-1', session: session('new-1') }], failed: [] };
  const card = await boot();
  assert.deepEqual(H.calls, ['get', 'resume']);
  assert.equal(dom.storage.getItem('aism.recover'), null, 'the flag is gone');
  assert.equal(text(card, 'ut-title'), '1 session resumed');
  assert.equal(failLine(card).hidden, true, 'nothing failed: no line');
});

test('a stale flag is cleared and the notice asks instead', async () => {
  dom.storage.setItem('aism.recover', String(Date.now() - 11 * 60 * 1000));
  H.notice = { at: AT, cause: 'wsl-stopped', detail: null, sessions: 2 };
  const card = await boot();
  assert.deepEqual(H.calls, ['get']);
  assert.equal(dom.storage.getItem('aism.recover'), null);
  assert.equal(buttonByLabel(card, 'Resume 2 sessions').hidden, false);
});

test('a flag is cleared even when there is nothing to tell', async () => {
  dom.storage.setItem('aism.recover', String(Date.now()));
  await boot();
  assert.equal(dom.storage.getItem('aism.recover'), null);
});

test('the idempotent empty answer shows nothing — never "0 sessions resumed" — and refetches the sessions', async () => {
  dom.storage.setItem('aism.recover', String(Date.now()));
  H.notice = { at: AT, cause: 'stopped', detail: null, sessions: 2 };
  H.resume = { resumed: [], failed: [] };
  const card = await boot();
  await drainMicrotasks(8);
  assert.equal(card.hidden, true);
  assert.equal(H.adopted.length, 0);
  assert.ok(H.calls.includes('sessions'), 'the list is asked again');
  assert.equal(H.sessionsSet, 1);
});

test('a resume that failed offers again with a sentence, and the buttons work again', async () => {
  H.notice = { at: AT, cause: 'crash', detail: null, sessions: 2 };
  H.resumeThrows = true;
  const card = await boot();
  const go = buttonByLabel(card, 'Resume 2 sessions');
  go.click();
  assert.equal(go.textContent, 'Resuming…', 'the wait is said');
  await drainMicrotasks(8);
  assert.equal(text(card, 'ut-body'), 'The app stopped unexpectedly at 12:53.');
  assert.equal(failLine(card).textContent, 'The sessions could not be resumed. Try again, or open them from History.');
  assert.equal(go.textContent, 'Resume 2 sessions');
  assert.equal((go as unknown as { disabled: boolean }).disabled, false);
  assert.equal(H.logs.some((l) => l.includes('HTTP 500')), true, 'the failure is logged');
});

test('Dismiss posts once, hides the card and hands the keyboard back', async () => {
  H.notice = { at: AT, cause: 'stopped', detail: null, sessions: 1 };
  const card = await boot();
  buttonByLabel(card, 'Dismiss').click();
  await drainMicrotasks(4);
  assert.deepEqual(H.calls, ['get', 'dismiss']);
  assert.equal(card.hidden, true);
  assert.equal(refocused, 1);
});

test('nothing running then: the notice says what happened, with Dismiss alone', async () => {
  H.notice = { at: AT, cause: 'stopped', detail: null, sessions: 0 };
  const card = await boot();
  assert.equal(text(card, 'ut-title'), 'The app stopped');
  assert.equal(buttonByLabel(card, 'Resume 0 sessions').hidden, true);
  assert.equal(buttonByLabel(card, 'Dismiss').hidden, false);
});

test('a notice off the contract shows nothing', async () => {
  H.notice = { at: AT, cause: 'meteor', detail: null, sessions: 1 };
  const card = await boot();
  assert.equal(card.hidden, true);
});

test('the log carries the cause and the counts, never the process name', async () => {
  dom.storage.setItem('aism.recover', String(Date.now()));
  H.notice = { at: AT, cause: 'oom', detail: { process: 'secretjob', rssMb: 100 }, sessions: 1 };
  H.resume = { resumed: [], failed: [{ historyId: 'h1', error: 'a sentence' }] };
  await boot();
  assert.ok(H.logs.includes('previous exit: cause=oom sessions=1 resume'), H.logs.join('\n'));
  assert.ok(H.logs.includes('previous exit: resume (auto) resumed=0 failed=1'), H.logs.join('\n'));
  assert.equal(H.logs.some((l) => l.includes('secretjob') || l.includes('a sentence')), false);
});
