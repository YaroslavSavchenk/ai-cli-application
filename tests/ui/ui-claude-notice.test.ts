/**
 * Nocturne D6 — the Claude Code notice in the DOM (`web/src/ui/claude-notice.ts`)
 * against the REAL update toast (`web/src/ui/update.ts`) and the REAL shared
 * check (`web/src/ui/update-check.ts`); `.claude/plans/nocturne/PLAN-D6.md` §
 * What the user gets, § Defaults "Notice placement".
 *
 * Pinned here: both sentences byte-exact on the card; Hide (and ×) writes
 * `claudeNoticeHidden = version` through `api.updatePrefs`; `Check for
 * updates` runs the one shared check (the backend is asked, the runtime is
 * re-read, the answer lands on the card); the two cards share one stack with
 * the update toast first; an early exit of a session created after the page
 * loaded drops the hidden value with one `updatePrefs` and the notice comes
 * back, while an attach replay (reload, reconnect) does not; `Check for
 * updates` is absent on a non-installed app; every watched check button shows
 * the one check's busy state. The rules are
 * `tests/ui/ui-claude-notice-model.test.ts`.
 *
 * `../api.ts`, `../state.ts`, `../log.ts`, `./panes.ts` (it reaches
 * @xterm/xterm) and `./releases.ts` are stubbed for the three modules under
 * test; everything else they import is real.
 *
 * NOT claimed: real browser layout of the stack (card order on screen, the
 * left-rule hue, focus rings) — the fake DOM has no layout or CSS; a real
 * backend's /api/runtime, /api/prefs or update check (api.ts is stubbed; the
 * server half is tests/server/claude-version-route.test.ts); a real reload's
 * `performance.timeOrigin`. Checked by `.claude/skills/verify-terminal/SKILL.md`
 * and the user's DEV check (PLAN-D6.md § Final gate).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import type { ClaudeStatus } from '../../shared/protocol-runtime.ts';
import type { UiPrefs, UpdateStatus } from '../../shared/protocol.ts';
import { byClass, installDom, type FakeElement } from '../helpers/fake-dom.ts';
import { readSources } from '../helpers/helpers.ts';

const dom = installDom();

interface Harness {
  update: UpdateStatus | null;
  claude: ClaudeStatus | null;
  /** What GET /api/runtime answers after a check. */
  runtime: { update: UpdateStatus | null; claude: ClaudeStatus | null };
  writes: { patch: UiPrefs; drop: readonly string[] }[];
  checkCalls: number;
  runtimeCalls: number;
  /** Resolves the in-flight check when set. */
  gate: Promise<void> | null;
  subscribers: ((kind: string) => void)[];
  refocus: number;
  installed: boolean;
}

const H: Harness = {
  update: null,
  claude: null,
  runtime: { update: null, claude: null },
  writes: [],
  checkCalls: 0,
  runtimeCalls: 0,
  gate: null,
  subscribers: [],
  refocus: 0,
  installed: true,
};
(globalThis as unknown as Record<string, unknown>).__cnHarness = H;

const STUB_SRC: Record<string, string> = {
  api: `
    const H = globalThis.__cnHarness;
    export async function restartBackend() { throw new Error('not in this suite'); }
    export async function backendHealth() { return false; }
    export async function startUpdate() { return { status: 503, body: {} }; }
    export async function updateStatus() { return { status: 404, body: {} }; }
    export async function updatePrefs(patch, drop = []) { H.writes.push({ patch, drop }); }
    export async function checkForUpdates() {
      H.checkCalls += 1;
      if (H.gate !== null) await H.gate;
      return { available: false, reason: null };
    }
    export async function getRuntime() { H.runtimeCalls += 1; return H.runtime; }`,
  state: `
    const H = globalThis.__cnHarness;
    export const state = {
      sessions: new Map(),
      projects: [],
      get update() { return H.update; },
      get claude() { return H.claude; },
      get installed() { return H.installed; },
      restarting: false,
      serverStartedAt: null,
      serverCommit: null,
      version: null,
    };
    export function projectName() { return null; }
    export function setRestarting(v) { state.restarting = v; }
    export function setRunStamp() {}
    export function setRuntime(r) { H.update = r.update; H.claude = r.claude; }
    export function subscribe(fn) { H.subscribers.push(fn); }`,
  log: `
    const noop = () => {};
    export const log = { debug: noop, info: noop, warn: noop, error: noop, hold: noop, resume: noop };
    export function formatError(e) { return String(e); }`,
  panes: `export function requestTerminalFocus() {}`,
  releases: `export function openReleasesPage() {}`,
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/\/web\/src\/ui\/(?:update|update-check|claude-notice)\.ts$/.test(context.parentURL ?? '')) {
      const m = /^\.\.?\/(api|state|log|panes|releases)\.ts$/.exec(specifier);
      if (m !== null) return { url: `cn-stub:${m[1] as string}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith('cn-stub:')) {
      return { format: 'module', source: STUB_SRC[url.slice('cn-stub:'.length)], shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

interface UpdateModule {
  initUpdate(modalHost: unknown): { pill: unknown; toasts: FakeElement };
  applyRuntime(): void;
  runtimeFacts(): { runningFor: string; version: string; claude: string | null };
}
interface NoticeModule {
  initClaudeNotice(stack: unknown, prefs: UiPrefs | undefined, refocus: () => void): void;
  noteEarlyExit(sessionId: string, createdAt: string): void;
}
interface CheckModule {
  watchCheckButton(btn: unknown): void;
}

// Computed specifiers: the typechecker must not walk the browser import graph
// under the server tsconfig (web/tsconfig.json owns that).
const UP = (await import(new URL('../../web/src/ui/update.ts', import.meta.url).href)) as UpdateModule;
const CN = (await import(new URL('../../web/src/ui/claude-notice.ts', import.meta.url).href)) as NoticeModule;
const UC = (await import(new URL('../../web/src/ui/update-check.ts', import.meta.url).href)) as CheckModule;

/** A `createdAt` this many ms after (or, negative, before) the page loaded. */
const born = (ms: number): string => new Date(performance.timeOrigin + ms).toISOString();

const RANGE = { min: '2.1.263', testedUpTo: '2.1.287' };
const NEWER = 'This app was tested up to Claude Code 2.1.287. You have 2.1.300. If launches fail, check for an app update.';
const OLDER = 'Claude Code 2.1.250 is older than this app needs (2.1.263). Update Claude Code.';

const modalHost = dom.doc.createElement('div');
dom.body.append(modalHost);
const { toasts } = UP.initUpdate(modalHost);
// The boot bag hid an OLDER version than the one now installed.
CN.initClaudeNotice(toasts, { claudeNoticeHidden: '2.1.299' }, () => {
  H.refocus += 1;
});

const updateToast = toasts.children[0] as FakeElement;
const card = toasts.children[1] as FakeElement;

/** A runtime answer landing: state set, then the `conn` notification setRuntime() sends. */
function land(claude: ClaudeStatus | null, update: UpdateStatus | null = H.update): void {
  H.claude = claude;
  H.update = update;
  UP.applyRuntime();
  for (const fn of H.subscribers) fn('conn');
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};

const btn = (root: FakeElement, label: string): FakeElement => {
  const hit = [...byClass(root, 'btn-accent'), ...byClass(root, 'btn-quiet')].find((b) => b.textContent === label);
  assert.ok(hit !== undefined, `no button labelled ${label}`);
  return hit;
};
const text = (cls: string): string => (byClass(card, cls)[0] as FakeElement).textContent;
const answerLine = (): FakeElement => byClass(card, 'ut-body')[1] as FakeElement;

// ---------------------------------------------------------------------------

test('non-vacuity: one stack, the update toast first and the notice second, both hidden with nothing to say', () => {
  assert.equal(toasts.className, 'ut-stack');
  assert.equal(toasts.children.length, 2);
  assert.equal(updateToast.className, 'ut-toast');
  assert.equal(card.className, 'ut-toast');
  assert.equal(updateToast.hidden, true);
  assert.equal(card.hidden, true, 'no runtime yet: no notice');
  assert.equal(card.getAttribute('role'), 'status');
});

test('newer: the card shows the spec’s sentence byte-exact, on the attention rule', () => {
  land({ version: '2.1.300', compat: 'newer', ...RANGE });
  assert.equal(card.hidden, false);
  assert.equal(text('ut-title'), 'Claude Code is newer than tested');
  assert.equal(text('ut-body'), NEWER);
  assert.equal(card.className, 'ut-toast', 'newer keeps the toast’s attention rule');
  assert.equal(answerLine().hidden, true, 'no answer before a check');
});

test('ONE action plus the toast’s dismissal pair: × and Hide, then Check for updates', () => {
  const accents = byClass(card, 'btn-accent').map((b) => b.textContent);
  const quiet = byClass(card, 'btn-quiet').map((b) => b.textContent);
  assert.deepEqual(accents, ['Check for updates'], 'exactly one action');
  assert.deepEqual(quiet, ['Hide']);
  const x = byClass(card, 'ut-x')[0] as FakeElement;
  assert.equal(x.getAttribute('aria-label'), 'hide');
  // Same order as the update toast's actions: the quiet one first.
  const actions = byClass(card, 'ut-actions')[0] as FakeElement;
  assert.deepEqual(
    actions.children.map((c) => c.textContent),
    ['Hide', 'Check for updates'],
  );
});

test('both toasts at once: the update toast first, the notice stacked under it', () => {
  land(H.claude, { available: true, reason: 'a new version is installed' });
  assert.equal(updateToast.hidden, false, 'the update toast shows');
  assert.equal(card.hidden, false, 'the notice still shows');
  assert.equal(toasts.children.indexOf(updateToast), 0);
  assert.equal(toasts.children.indexOf(card), 1);
  land(H.claude, { available: false, reason: null });
  assert.equal(updateToast.hidden, true);
});

test('Check for updates runs the shared check: the backend is asked, the runtime re-read, the answer lands', async () => {
  let open: () => void = () => {};
  H.gate = new Promise<void>((r) => {
    open = r;
  });
  H.runtime = { update: { available: false, reason: null }, claude: H.claude };
  const asked = H.checkCalls;
  const reread = H.runtimeCalls;
  // Another button offering the check (Settings' own, in the app).
  const other = dom.doc.createElement('button') as FakeElement & { disabled: boolean };
  UC.watchCheckButton(other);
  assert.equal(other.textContent, 'Check for updates');
  assert.equal(other.disabled, false);
  const check = btn(card, 'Check for updates');
  check.click();
  assert.equal(H.checkCalls, asked + 1, 'the backend is the one that checks');
  assert.equal(check.textContent, 'Checking…');
  assert.equal(check.disabled, true);
  assert.equal(other.textContent, 'Checking…', 'every button shows the one check busy');
  assert.equal(other.disabled, true);
  check.click();
  open();
  H.gate = null;
  await settle();
  assert.equal(H.checkCalls, asked + 1, 'one question, however many clicks');
  assert.equal(H.runtimeCalls, reread + 1, 'the runtime is re-read the one way');
  assert.equal(answerLine().hidden, false);
  assert.equal(answerLine().textContent, 'You have the newest version.');
  assert.equal(check.textContent, 'Check for updates');
  assert.equal(check.disabled, false);
  assert.equal(other.textContent, 'Check for updates');
  assert.equal(other.disabled, false);
});

test('not installed: Check for updates is hidden, × and Hide remain; installed again shows it', () => {
  H.installed = false;
  land(H.claude);
  assert.equal(card.hidden, false);
  assert.equal(btn(card, 'Check for updates').hidden, true, 'a dev clone’s check would answer 503');
  assert.equal(btn(card, 'Hide').hidden, false);
  assert.equal((byClass(card, 'ut-x')[0] as FakeElement).hidden, false);
  H.installed = true;
  land(H.claude);
  assert.equal(btn(card, 'Check for updates').hidden, false);
});

test('the notice and the Settings page call the SAME exported check, no copy', () => {
  const src = readSources('web/src/ui/claude-notice.ts', 'web/src/ui/settings-service.ts');
  assert.equal(src.split("import { runUpdateCheck").length - 1, 2, 'both import it');
  assert.equal(src.split("from './update-check.ts';").length - 1, 2, 'from the one home');
  assert.equal(/api\.checkForUpdates/.test(src), false, 'neither asks the backend itself');
});

test('Hide writes claudeNoticeHidden = the shown version, and the keyboard goes back to the pane', async () => {
  H.writes.length = 0;
  const focus = H.refocus;
  btn(card, 'Hide').click();
  await settle();
  assert.equal(card.hidden, true);
  assert.deepEqual(H.writes, [{ patch: { claudeNoticeHidden: '2.1.300' }, drop: [] }]);
  assert.equal(H.refocus, focus + 1);
  // A poll repeating the same version keeps it hidden.
  land({ version: '2.1.300', compat: 'newer', ...RANGE });
  assert.equal(card.hidden, true, 'hidden until a different version is seen');
});

test('a different version shows it again; × hides that one the same way', async () => {
  land({ version: '2.1.301', compat: 'newer', ...RANGE });
  assert.equal(card.hidden, false);
  assert.equal(answerLine().hidden, true, 'the last answer was about the version before');
  H.writes.length = 0;
  (byClass(card, 'ut-x')[0] as FakeElement).click();
  await settle();
  assert.equal(card.hidden, true);
  assert.deepEqual(H.writes, [{ patch: { claudeNoticeHidden: '2.1.301' }, drop: [] }]);
});

test('an attach replay of a session created before the page loaded (a reload) does not bring it back', async () => {
  H.writes.length = 0;
  CN.noteEarlyExit('s-old', born(-60_000));
  CN.noteEarlyExit('s-bad', 'not a date');
  await settle();
  assert.deepEqual(H.writes, []);
  assert.equal(card.hidden, true, 'still hidden');
});

test('a live early exit (created after load) drops the hidden value with ONE updatePrefs, and the notice comes back', async () => {
  H.writes.length = 0;
  CN.noteEarlyExit('s-live', born(1_000));
  await settle();
  assert.deepEqual(H.writes, [{ patch: {}, drop: ['claudeNoticeHidden'] }]);
  assert.equal(card.hidden, false);
  // Nothing hidden any more: a second early exit writes nothing.
  CN.noteEarlyExit('s-live2', born(2_000));
  await settle();
  assert.equal(H.writes.length, 1);
});

test('a WS reconnect replaying that same live exit does not bring a re-hidden notice back', async () => {
  btn(card, 'Hide').click();
  await settle();
  assert.equal(card.hidden, true);
  H.writes.length = 0;
  CN.noteEarlyExit('s-live', born(1_000));
  CN.noteEarlyExit('s-old', born(-60_000));
  await settle();
  assert.deepEqual(H.writes, []);
  assert.equal(card.hidden, true);
  // A NEW session dying live still counts.
  CN.noteEarlyExit('s-live3', born(3_000));
  await settle();
  assert.deepEqual(H.writes, [{ patch: {}, drop: ['claudeNoticeHidden'] }]);
  assert.equal(card.hidden, false);
});

test('an early exit with compat ok writes nothing', async () => {
  land({ version: '2.1.287', compat: 'ok', ...RANGE });
  assert.equal(card.hidden, true);
  H.writes.length = 0;
  // Hidden for some version, but the server says this one is fine.
  land({ version: '2.1.302', compat: 'newer', ...RANGE });
  btn(card, 'Hide').click();
  land({ version: '2.1.287', compat: 'ok', ...RANGE });
  H.writes.length = 0;
  CN.noteEarlyExit('s-ok', born(4_000));
  await settle();
  assert.deepEqual(H.writes, []);
});

test('older: the sentence byte-exact, on the danger rule', () => {
  land({ version: '2.1.250', compat: 'older', ...RANGE });
  assert.equal(card.hidden, false);
  assert.equal(text('ut-title'), 'Claude Code is too old');
  assert.equal(text('ut-body'), OLDER);
  assert.equal(card.className, 'ut-toast is-danger');
});

test('missing and unknown show no card', () => {
  land({ version: null, compat: 'missing', ...RANGE });
  assert.equal(card.hidden, true);
  land({ version: 'garbage', compat: 'unknown', ...RANGE });
  assert.equal(card.hidden, true);
});

test('runtimeFacts carries the Claude Code fact the Settings page prints', () => {
  land({ version: '2.1.287', compat: 'ok', ...RANGE });
  assert.equal(UP.runtimeFacts().claude, 'Claude Code 2.1.287 (tested up to 2.1.287)');
  land({ version: null, compat: 'missing', ...RANGE });
  assert.equal(UP.runtimeFacts().claude, 'Claude Code not found');
  land({ version: null, compat: 'unknown', ...RANGE });
  assert.equal(UP.runtimeFacts().claude, null);
});
