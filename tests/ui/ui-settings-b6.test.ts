/**
 * Nocturne B6 — the Settings panel's three LIVE surfaces, driven through the
 * REAL `web/src/ui/settings.ts` against the DOM double in `tests/helpers/fake-dom.ts`:
 *
 *   Preferences -> Tools     which cards the New session dialog offers (D1),
 *                            with the floor: the last visible card cannot be
 *                            hidden, and the refusal is said in place.
 *   Preferences -> Defaults  the three behaviour toggles (D2 dropped the
 *                            fourth), each writing the whole `behaviour` bag
 *                            and flipping back when the write fails — and,
 *                            since Nocturne C1, the `Peek mascot` row that
 *                            took the fourth place, writing `mascot`.
 *   Background service       `Check for updates` asks the backend NOW (D4),
 *                            says one of four sentences, offers `Update` when
 *                            a release is waiting, and then re-reads the
 *                            runtime through the ONE existing path.
 *
 * WHY NEXT TO `tests/ui/ui-settings-panel.test.ts`: that file pins the panel's
 * shell and the surfaces that were already live (the status-line checklist, the
 * key rows, the colour page). This one pins what part B6 added, with the stores
 * in `ui/prefs-model.ts` REAL — the panel and the test read one store, exactly
 * as the panel and the New session dialog do in the browser.
 *
 * NOT claimed (browser work, `.claude/skills/verify-terminal/SKILL.md`):
 * layout, that a hidden card really disappears from the dialog's grid (part
 * 2b's consumers own that), screen-reader output.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import type { UiPrefs } from '../../shared/protocol.ts';
import { UPDATE_NEW_VERSION_AVAILABLE } from '../../shared/protocol.ts';
import { TOOL_CARDS } from '../../web/src/ui/launch-args.ts';
import {
  getBehaviour,
  getHiddenTools,
  getMascotEnabled,
  initBehaviour,
  initHiddenTools,
  initMascot,
} from '../../web/src/ui/prefs-model.ts';
import { byClass, installDom, textsOf, type FakeElement } from '../helpers/fake-dom.ts';

const dom = installDom();

// ===========================================================================
// Harness + module stubs — the same four non-pure imports the panel's other
// DOM test doubles (`../api.ts`, `../state.ts`, `../log.ts`, `./update.ts`).
// ===========================================================================

interface Harness {
  installed: boolean;
  facts: { runningFor: string; version: string };
  prefs: UiPrefs;
  writes: { patch: UiPrefs; dead: readonly string[] }[];
  /** When set, the NEXT updatePrefs rejects with it (one write, one failure). */
  nextWriteError: Error | null;
  logs: string[];
  subscribers: ((kind: string) => void)[];
  restarts: string[];
  /** POST /api/update/check: what the backend answers, and how often it is asked. */
  update: { available: boolean; reason: string | null; release?: { version: string } };
  checkCalls: number;
  nextCheckError: Error | null;
  /** GET /api/runtime after an answered check, and the applyRuntime() that follows. */
  runtimeCalls: number;
  runtimesApplied: number;
  /** Resolves the in-flight check when set — the `Checking…` window, held open. */
  gate: Promise<void> | null;
  /**
   * Resolves the `getPrefs()` re-read on open when set, so a test can click a
   * B6 row BEFORE the stored bag lands (the `writes > 0` guard in settings.ts).
   */
  prefsGate: Promise<void> | null;
}

const H: Harness = {
  installed: true,
  facts: { runningFor: '2h 15m', version: '0.4.0' },
  prefs: {},
  writes: [],
  nextWriteError: null,
  logs: [],
  subscribers: [],
  restarts: [],
  update: { available: false, reason: null },
  checkCalls: 0,
  nextCheckError: null,
  runtimeCalls: 0,
  runtimesApplied: 0,
  gate: null,
  prefsGate: null,
};
(globalThis as unknown as Record<string, unknown>).__sgB6 = H;

const STUB_SRC: Record<string, string> = {
  api: `
    const H = globalThis.__sgB6;
    export async function updatePrefs(patch, dead) {
      H.writes.push({ patch, dead });
      if (H.nextWriteError !== null) { const e = H.nextWriteError; H.nextWriteError = null; throw e; }
    }
    export async function getPrefs() { if (H.prefsGate !== null) await H.prefsGate; return H.prefs; }
    export async function getKeys() { return { saved: {}, env: {} }; }
    export async function saveKey() { return { ok: true }; }
    export async function deleteKey() { return { ok: true }; }
    export async function checkForUpdates() {
      H.checkCalls++;
      if (H.gate !== null) await H.gate;
      if (H.nextCheckError !== null) { const e = H.nextCheckError; H.nextCheckError = null; throw e; }
      return H.update;
    }
    export async function getRuntime() { H.runtimeCalls++; return { update: H.update }; }`,
  state: `
    const H = globalThis.__sgB6;
    export const state = {
      get sessions() { return new Map(); },
      get installed() { return H.installed; },
    };
    export function projectName() { return null; }
    export function setRuntime() {}
    export function subscribe(fn) { H.subscribers.push(fn); }`,
  log: `
    const H = globalThis.__sgB6;
    const rec = (lvl) => (m) => { H.logs.push(lvl + ' ' + m); };
    export const log = { debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') };`,
  update: `
    const H = globalThis.__sgB6;
    export function openRestartConfirm(src) { H.restarts.push(src); }
    export function runtimeFacts() { return H.facts; }
    export function applyRuntime() { H.runtimesApplied++; }`,
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((context.parentURL ?? '').endsWith('/web/src/ui/settings.ts')) {
      const m = /^(?:\.\.\/(api|state|log)|\.\/(update))\.ts$/.exec(specifier);
      const name = m?.[1] ?? m?.[2];
      if (name !== undefined) return { url: `b6-stub:${name}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith('b6-stub:')) {
      return { format: 'module', source: STUB_SRC[url.slice('b6-stub:'.length)], shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

interface TermPair {
  ground: string;
  text: string;
}
interface SettingsModule {
  initSettings(
    host: unknown,
    anchor: unknown,
    deps: {
      repaintStatus(): void;
      theme: {
        apply(next: TermPair): void;
        adopt(next: TermPair): void;
        current(): TermPair;
        flush(): Promise<void>;
      };
    },
  ): { open(): void; close(): void; toggle(): void; isOpen(): boolean };
}

/** ui/theme.ts's control, stubbed: this suite is about the other four pages. */
let themePair: TermPair = { ground: '#0b0d14', text: '#e9e9ed' };
const themeStub = {
  apply(next: TermPair): void {
    themePair = { ...next };
  },
  adopt(next: TermPair): void {
    themePair = { ...next };
  },
  current: (): TermPair => ({ ...themePair }),
  flush: (): Promise<void> => Promise.resolve(),
};

const S = (await import(new URL('../../web/src/ui/settings.ts', import.meta.url).href)) as SettingsModule;

const modalHost = dom.doc.createElement('div');
const anchor = dom.doc.createElement('button');
dom.body.append(modalHost, anchor);
const panel = S.initSettings(modalHost, anchor, { repaintStatus: () => {}, theme: themeStub });
const scrim = modalHost.children[0] as FakeElement;
const modal = scrim.children[0] as FakeElement;

const ALL_IDS = TOOL_CARDS.map((c) => c.id);

/** Let the promises a click or an open started settle. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
};

function tab(label: string): FakeElement {
  const hit = byClass(modal, 'sg-tab').find((b) => b.textContent === label);
  assert.ok(hit !== undefined, `no nav button "${label}"`);
  return hit;
}

function page(id: string): FakeElement {
  const hit = byClass(modal, 'sg-page').find((p) => p.id === `sg-panel-${id}`);
  assert.ok(hit !== undefined, `no page "${id}"`);
  return hit;
}

/** A boolean row by its visible label. */
function row(pageId: string, label: string): FakeElement {
  const hit = byClass(page(pageId), 'sg-row').find(
    (r) => byClass(r, 'sg-rowlb')[0]?.textContent === label,
  );
  assert.ok(hit !== undefined, `no row "${label}"`);
  return hit;
}

const pressed = (r: FakeElement): boolean => r.getAttribute('aria-pressed') === 'true';

/**
 * Open the panel on one page with both B6 stores seeded exactly as main.ts
 * seeds them at boot, and with the recorded writes cleared.
 */
async function openOn(
  pageLabel: string,
  seed: { hidden?: string[]; behaviour?: Record<string, boolean>; mascot?: unknown } = {},
): Promise<void> {
  panel.close();
  // The bag on disk and the seeded store are one thing in the browser (main.ts
  // seeds from the same bag at boot), so the double sets both.
  H.prefs = { tools: { hidden: seed.hidden ?? [] }, behaviour: seed.behaviour ?? {} };
  if (seed.mascot !== undefined) H.prefs.mascot = seed.mascot as UiPrefs['mascot'];
  H.writes.length = 0;
  H.nextWriteError = null;
  initBehaviour(seed.behaviour ?? {});
  initMascot(seed.mascot);
  initHiddenTools({ hidden: seed.hidden ?? [] }, ALL_IDS);
  panel.open();
  await settle();
  tab(pageLabel).click();
}

/** The last recorded prefs write, with the retired keys it pruned. */
function lastWrite(): { patch: UiPrefs; dead: readonly string[] } {
  const w = H.writes.at(-1);
  assert.ok(w !== undefined, 'no prefs write recorded');
  assert.deepEqual(w.dead, ['defaults', 'statusBar'], 'the two retired keys are pruned in the same write');
  return w;
}

// ===========================================================================
// Preferences -> Tools (D1)
// ===========================================================================

test('the Tools block mirrors the New session dialog’s own cards, all visible by default', async () => {
  await openOn('Preferences');
  const p = page('prefs');
  assert.equal(byClass(p, 'sg-sub')[1]?.textContent, 'Tools');
  assert.equal(
    byClass(p, 'sg-lead').map((n) => n.textContent).includes('Cards shown in the New session dialog.'),
    true,
    'the block says what a checked row means',
  );
  // The rows ARE `TOOL_CARDS`, in its order, tile included — one table, two
  // surfaces, so the dialog and the panel can never name different tools.
  for (const c of TOOL_CARDS) {
    const r = row('prefs', c.label);
    assert.equal(pressed(r), true, `${c.label} starts visible`);
    assert.equal(byClass(r, 'sg-box')[0]?.textContent, '✓');
    // B12: the tile holds the tool's real logo, the dialog card's own mark.
    const tile = byClass(r, 'sg-mark')[0];
    assert.equal(tile?.textContent, '', 'a logo, no letters');
    assert.equal((tile?.children[0] as FakeElement | undefined)?.getAttribute('data-tool'), c.icon);
    assert.equal(r.disabled, false);
  }
});

test('hiding a card writes the whole hidden list and the row states it', async () => {
  await openOn('Preferences');
  row('prefs', 'Grok').click();
  await settle();
  assert.deepEqual(getHiddenTools(), ['grok']);
  assert.deepEqual(lastWrite().patch, { tools: { hidden: ['grok'] } });
  assert.equal(pressed(row('prefs', 'Grok')), false);
  assert.equal(byClass(row('prefs', 'Grok'), 'sg-box')[0]?.textContent, '');
  // …and showing it again writes the list without it.
  row('prefs', 'Grok').click();
  await settle();
  assert.deepEqual(getHiddenTools(), []);
  assert.deepEqual(lastWrite().patch, { tools: { hidden: [] } });
  assert.equal(pressed(row('prefs', 'Grok')), true);
});

test('the rows show what the stored bag says, on open', async () => {
  await openOn('Preferences', { hidden: ['codex', 'other'] });
  assert.deepEqual(
    TOOL_CARDS.filter((c) => !pressed(row('prefs', c.label))).map((c) => c.id),
    ['codex', 'other'],
  );
});

test('the LAST visible card refuses to go, in its own row, and writes nothing', async () => {
  await openOn('Preferences', { hidden: ALL_IDS.filter((id) => id !== 'claude') });
  const last = row('prefs', 'Claude Code');
  assert.equal(pressed(last), true, 'exactly one card is left');
  H.writes.length = 0;
  last.click();
  await settle();
  assert.equal(pressed(last), true, 'it is still visible');
  assert.deepEqual(H.writes, [], 'a refusal is not a write');
  assert.deepEqual(getHiddenTools(), ALL_IDS.filter((id) => id !== 'claude'));
  // The sentence is said where the question was asked: the row's own caption
  // slot, as a live region, and no dialog and no toast anywhere.
  const caps = byClass(page('prefs'), 'sg-cap').filter((c) => !c.hidden);
  assert.deepEqual(
    caps.map((c) => c.textContent),
    ['Keep at least one tool visible.', ...DEFAULT_CAPTIONS],
  );
  assert.equal(caps[0]?.getAttribute('role'), 'status');
  // It goes away by itself: the app's own "for a moment" (3000 ms).
  const timer = dom.win.timers.at(-1);
  assert.equal(timer?.ms, 3000);
  timer?.fn();
  assert.deepEqual(
    byClass(page('prefs'), 'sg-cap')
      .filter((c) => !c.hidden)
      .map((c) => c.textContent),
    DEFAULT_CAPTIONS,
  );
});

test('a tools write that fails puts the card back', async () => {
  await openOn('Preferences');
  H.nextWriteError = new Error('HTTP 500');
  row('prefs', 'Terminal').click();
  await settle();
  assert.deepEqual(getHiddenTools(), [], 'the store is back where it was');
  assert.equal(pressed(row('prefs', 'Terminal')), true);
  assert.ok(H.logs.includes('warn the tools preference was not saved'));
});

// ===========================================================================
// Preferences -> Defaults (D2 dropped the notifications row; C1 brought the
// peek mascot's switch in its place)
// ===========================================================================

/** The peek mascot row's caption (Nocturne C1). */
const MASCOT_CAPTION =
  'A small Claude peeks in at the edge of your screen when a session is done or asks you something.';

/** The four captions, in the order the page draws them. */
const DEFAULT_CAPTIONS = [
  'The files, folders and views you left open come back the next time the app starts; sessions never survive a restart.',
  'Every button that ends a session asks once before it does.',
  'A terminal jumps to its newest output even when you have scrolled up.',
  MASCOT_CAPTION,
];

test('the Defaults block is three behaviour rows and the mascot row, a caption each, at their factory values', async () => {
  await openOn('Preferences');
  const p = page('prefs');
  assert.deepEqual(textsOf(p, 'sg-sub'), ['API keys', 'Tools', 'Defaults']);
  const labels = ['Reopen tabs on start', 'Confirm before ending a session', 'Follow output'];
  assert.deepEqual(
    labels.map((l) => pressed(row('prefs', l))),
    [true, true, false],
    'factory: reopen on, confirm on, follow off',
  );
  for (const l of labels) assert.equal(row('prefs', l).disabled, false, `${l} is live since B6`);
  // D2: the notifications row never came back under that name — C1's
  // `Peek mascot` row is what it became.
  assert.equal(
    byClass(p, 'sg-rowlb').some((n) => (n.textContent ?? '').includes('Notifications')),
    false,
  );
  assert.deepEqual(
    byClass(p, 'sg-cap')
      .filter((c) => !c.hidden)
      .map((c) => c.textContent),
    DEFAULT_CAPTIONS,
  );
});

test('a Defaults toggle writes every member of the behaviour bag, and the row follows', async () => {
  await openOn('Preferences');
  row('prefs', 'Follow output').click();
  await settle();
  assert.equal(getBehaviour().followOutput, true);
  assert.deepEqual(lastWrite().patch, {
    behaviour: { reopenTabs: true, confirmEnd: true, followOutput: true },
  });
  assert.equal(pressed(row('prefs', 'Follow output')), true);

  row('prefs', 'Reopen tabs on start').click();
  await settle();
  assert.deepEqual(lastWrite().patch, {
    behaviour: { reopenTabs: false, confirmEnd: true, followOutput: true },
  });
  assert.equal(pressed(row('prefs', 'Reopen tabs on start')), false);
});

test('a behaviour write that fails puts the row back and says so in the log', async () => {
  await openOn('Preferences');
  H.nextWriteError = new Error('HTTP 500');
  row('prefs', 'Confirm before ending a session').click();
  await settle();
  assert.equal(getBehaviour().confirmEnd, true, 'the store never keeps what disk refused');
  assert.equal(pressed(row('prefs', 'Confirm before ending a session')), true);
  assert.ok(H.logs.includes('warn the confirmEnd preference was not saved'));
});

test('the stored bag decides what the rows show on open', async () => {
  await openOn('Preferences', { behaviour: { reopenTabs: false, confirmEnd: false, followOutput: true } });
  assert.deepEqual(
    ['Reopen tabs on start', 'Confirm before ending a session', 'Follow output'].map((l) =>
      pressed(row('prefs', l)),
    ),
    [false, false, true],
  );
});

// ---------------------------------------------------------------------------
// The Peek mascot row (Nocturne C1, PLAN-C1.md § The toggle)
// ---------------------------------------------------------------------------

test('Peek mascot is ON when the bag has no `mascot` key, and a click writes `{enabled:false}`', async () => {
  await openOn('Preferences');
  const r = row('prefs', 'Peek mascot');
  assert.equal(pressed(r), true, 'absent = on');
  assert.equal(r.tagName.toLowerCase(), 'button', 'a real button: the keyboard reaches it');
  r.click();
  await settle();
  assert.equal(getMascotEnabled(), false);
  assert.equal(pressed(r), false);
  assert.deepEqual(lastWrite().patch, { mascot: { enabled: false } });
  assert.ok(lastWrite().dead.includes('defaults'), 'the write prunes the retired keys like every other');
  r.click();
  await settle();
  assert.deepEqual(lastWrite().patch, { mascot: { enabled: true } });
  assert.equal(pressed(r), true);
});

test('a stored `{enabled:false}` shows the row off on open; anything else reads as on', async () => {
  await openOn('Preferences', { mascot: { enabled: false } });
  assert.equal(pressed(row('prefs', 'Peek mascot')), false);
  await openOn('Preferences', { mascot: { enabled: 'no' } });
  assert.equal(pressed(row('prefs', 'Peek mascot')), true, 'a wrong type is not a switch-off');
});

test('a mascot write that fails puts the row back and says so in the log', async () => {
  await openOn('Preferences');
  H.nextWriteError = new Error('HTTP 500');
  row('prefs', 'Peek mascot').click();
  await settle();
  assert.equal(getMascotEnabled(), true, 'the store never keeps what disk refused');
  assert.equal(pressed(row('prefs', 'Peek mascot')), true);
  assert.ok(H.logs.includes('warn the mascot preference was not saved'));
});

test('the re-read on open shows what disk holds for the mascot, not what this window booted with', async () => {
  // Another window switched the mascot off after this one booted: the row must
  // show the stored bag, like every other B6 row (settings.ts re-read).
  panel.close();
  initMascot(undefined); // booted: on
  H.writes.length = 0;
  H.prefs = { mascot: { enabled: false } };
  panel.open();
  await settle();
  await settle();
  tab('Preferences').click();
  assert.equal(getMascotEnabled(), false, 'the store follows the disk bag');
  assert.equal(pressed(row('prefs', 'Peek mascot')), false, 'and so does the row');
  H.prefs = {};
});

test('a slow re-read on open never undoes a mascot click the user already made', async () => {
  panel.close();
  initMascot(undefined);
  H.writes.length = 0;
  let release!: () => void;
  H.prefsGate = new Promise<void>((res) => {
    release = res;
  });
  H.prefs = { mascot: { enabled: true } };
  panel.open();
  await settle();
  tab('Preferences').click();
  row('prefs', 'Peek mascot').click();
  await settle();
  assert.equal(getMascotEnabled(), false);
  release();
  H.prefsGate = null;
  await settle();
  await settle();
  assert.equal(getMascotEnabled(), false, 'the late bag must not switch it back on');
  assert.equal(pressed(row('prefs', 'Peek mascot')), false);
  H.prefs = {};
});

test('the mascot row speaks plain words: no code word in its label or caption', () => {
  for (const text of ['Peek mascot', MASCOT_CAPTION]) {
    assert.doesNotMatch(text, /mascot\.|enabled|prefs|turnEnded|turnUnseen|BEL|\{|`/, text);
  }
});

// ===========================================================================
// Background service -> Check for updates (D4)
// ===========================================================================

const check = (): FakeElement => byClass(page('service'), 'sg-link')[0] as FakeElement;
const answer = (): FakeElement => byClass(page('service'), 'sg-svcanswer')[0] as FakeElement;
const answerText = (): string => byClass(page('service'), 'sg-svcmsg')[0]?.textContent ?? '';
const updateBtn = (): FakeElement => {
  const hit = byClass(answer(), 'sg-outbtn')[0];
  assert.ok(hit !== undefined, 'the answer line must be able to carry the Update act');
  return hit;
};

test('the check says `You have the newest version.` when nothing is waiting', async () => {
  await openOn('Background service');
  H.update = { available: false, reason: null };
  assert.equal(answer().hidden, true, 'nothing is claimed before the question is asked');
  check().click();
  await settle();
  assert.equal(H.checkCalls > 0, true, 'the backend is the one that checks');
  assert.equal(answer().hidden, false);
  assert.equal(answerText(), 'You have the newest version.');
  assert.equal(updateBtn().hidden, true, 'there is nothing to update to');
  // The pill and the toast learn the same news, through the one existing path.
  assert.equal(H.runtimeCalls > 0, true, 'the runtime is re-read after the answer');
  assert.equal(H.runtimesApplied > 0, true, 'and applied the normal way');
});

test('an online release is named, and the answer carries the same Update act as the toast', async () => {
  await openOn('Background service');
  H.update = {
    available: true,
    reason: UPDATE_NEW_VERSION_AVAILABLE,
    release: { version: 'v0.5.0' },
  };
  check().click();
  await settle();
  assert.equal(answerText(), 'Version v0.5.0 is available.');
  assert.equal(updateBtn().hidden, false);
  assert.equal(updateBtn().textContent, 'Update');
  assert.equal(updateBtn().getAttribute('aria-haspopup'), 'dialog');
  H.restarts.length = 0;
  updateBtn().click();
  assert.deepEqual(H.restarts, ['settings-update'], 'the update flow, opened in update mode');
});

test('a version that fails the shape gate is never printed', async () => {
  await openOn('Background service');
  H.update = {
    available: true,
    reason: UPDATE_NEW_VERSION_AVAILABLE,
    release: { version: 'v1.0 <script>' },
  };
  check().click();
  await settle();
  assert.equal(answerText(), 'A newer version is available.', 'the generic sentence, never the tag');
  assert.equal(updateBtn().hidden, false, 'the act stands: the release is real');
});

test('a version already on this machine asks for a restart instead', async () => {
  await openOn('Background service');
  H.update = { available: true, reason: 'a new version is installed' };
  check().click();
  await settle();
  assert.equal(answerText(), 'A new version is installed. Restart the service to use it.');
  assert.equal(updateBtn().hidden, true, 'nothing to fetch: it is already here');
});

test('a check that does not answer says so, and re-reads nothing', async () => {
  await openOn('Background service');
  H.nextCheckError = new Error('HTTP 503');
  const runtimes = H.runtimeCalls;
  check().click();
  await settle();
  assert.equal(answerText(), 'Could not check for updates.');
  assert.equal(updateBtn().hidden, true);
  assert.equal(H.runtimeCalls, runtimes, 'a failed check learned nothing to apply');
  assert.equal(check().textContent, 'Check for updates', 'the button is usable again');
  assert.equal(check().disabled, false);
});

test('the button states that it is working, and takes no second click while it is', async () => {
  await openOn('Background service');
  H.update = { available: false, reason: null };
  let release = (): void => {};
  H.gate = new Promise<void>((r) => {
    release = r;
  });
  const asked = H.checkCalls;
  check().click();
  await settle();
  assert.equal(check().textContent, 'Checking…');
  assert.equal(check().disabled, true);
  assert.equal(answer().hidden, true, 'the previous answer is cleared while a new one is out');
  check().click();
  await settle();
  assert.equal(H.checkCalls, asked + 1, 'one question, however many clicks');
  release();
  H.gate = null;
  await settle();
  assert.equal(check().textContent, 'Check for updates');
  assert.equal(check().disabled, false);
  assert.equal(answerText(), 'You have the newest version.');
});

test('the answer belongs to the moment it was asked for: closing the panel takes it away', async () => {
  await openOn('Background service');
  H.update = { available: true, reason: UPDATE_NEW_VERSION_AVAILABLE, release: { version: 'v0.5.0' } };
  check().click();
  await settle();
  assert.equal(answer().hidden, false);
  panel.close();
  assert.equal(answer().hidden, true);
  assert.equal(answerText(), '');
  assert.equal(updateBtn().hidden, true);
});

test('the check button still exists only in installed mode', async () => {
  H.installed = false;
  await openOn('Background service');
  assert.equal(check().hidden, true, 'a developer clone updates with the tools it was cloned with');
  H.installed = true;
  for (const fn of H.subscribers) fn('conn');
  assert.equal(check().hidden, false);
});

// ===========================================================================
// Test-engineer additions (B6 phase-2a gate) — three branches the cases above
// leave open, each found by a mutant that survived the suite:
//
//   1. the refusal is REVEALED before it is written (settings.ts sayToolsFloor),
//   2. the same for the check's answer line (sayAnswer),
//   3. the `writes > 0` guard covers the two B6 stores, not just `statusLine`.
//
// 1 and 2 are the only behaviour a `role="status"` live region has: a node
// filled while it is still `hidden` is a change no screen reader announces, so
// swapping the two lines is silent to every state assertion — only the ORDER of
// the two writes can catch it.
// ===========================================================================

/** One recorded write of `hidden` or `textContent`, in the order it happened. */
function watchWrites(
  node: FakeElement,
  label: string,
  seen: string[],
): { stop(): void } {
  let hid = node.hidden;
  Object.defineProperty(node, 'hidden', {
    configurable: true,
    get: () => hid,
    set: (v: boolean) => {
      hid = v;
      seen.push(`${label}.hidden=${String(v)}`);
    },
  });
  const proto = Object.getPrototypeOf(node) as object;
  const desc = Object.getOwnPropertyDescriptor(proto, 'textContent');
  assert.ok(
    desc !== undefined && desc.get !== undefined && desc.set !== undefined,
    'non-vacuity: textContent must be an accessor on the DOM double, or nothing is recorded',
  );
  const get = desc.get as () => string;
  const set = desc.set as (v: string) => void;
  Object.defineProperty(node, 'textContent', {
    configurable: true,
    get: () => get.call(node),
    set: (v: string) => {
      seen.push(`${label}.text=${v}`);
      set.call(node, v);
    },
  });
  return {
    stop(): void {
      const text = get.call(node);
      delete (node as unknown as Record<string, unknown>).textContent;
      Object.defineProperty(node, 'hidden', {
        configurable: true,
        enumerable: true,
        writable: true,
        value: hid,
      });
      assert.equal(get.call(node), text, 'the spy is removed without changing what the node says');
    },
  };
}

test('the refusal is REVEALED before it is written: a live region filled while hidden announces nothing', async () => {
  await openOn('Preferences', { hidden: ALL_IDS.filter((id) => id !== 'claude') });
  const caps = byClass(page('prefs'), 'sg-cap');
  const cap = caps[TOOL_CARDS.findIndex((c) => c.id === 'claude')] as FakeElement;
  assert.equal(cap.getAttribute('role'), 'status', 'non-vacuity: this IS the refusal slot');
  assert.equal(cap.hidden, true, 'and it starts hidden');
  const seen: string[] = [];
  const spy = watchWrites(cap, 'cap', seen);
  row('prefs', 'Claude Code').click();
  spy.stop();
  assert.deepEqual(
    seen.slice(-2),
    ['cap.hidden=false', 'cap.text=Keep at least one tool visible.'],
    'reveal first, then the sentence',
  );
  assert.equal(cap.hidden, false, 'and the state the other cases assert is unchanged');
  assert.equal(cap.textContent, 'Keep at least one tool visible.');
});

test('the check’s answer is REVEALED before it is written, for the same reason', async () => {
  await openOn('Background service');
  H.update = { available: false, reason: null };
  assert.equal(answer().getAttribute('role'), 'status', 'non-vacuity: the answer line IS the live region');
  const seen: string[] = [];
  const region = watchWrites(answer(), 'region', seen);
  const text = watchWrites(byClass(page('service'), 'sg-svcmsg')[0] as FakeElement, 'msg', seen);
  check().click();
  await settle();
  region.stop();
  text.stop();
  const revealed = seen.lastIndexOf('region.hidden=false');
  const said = seen.lastIndexOf('msg.text=You have the newest version.');
  assert.notEqual(revealed, -1, 'the region was revealed');
  assert.notEqual(said, -1, 'the sentence was written');
  assert.equal(revealed < said, true, `reveal must precede the text: ${seen.join(' | ')}`);
  assert.equal(answerText(), 'You have the newest version.');
});

test('a slow re-read on open never undoes a Tools or a Defaults click the user already made', async () => {
  // settings.ts counts writes since this open and drops a late `getPrefs()`
  // answer when there are any. The guard has to cover the TWO B6 stores as
  // well as `statusLine`: re-seeding them from disk under the user's hand
  // would flip back the card and the toggle just clicked.
  panel.close();
  initHiddenTools({ hidden: [] }, ALL_IDS);
  initBehaviour({});
  H.writes.length = 0;
  let release!: () => void;
  H.prefsGate = new Promise<void>((res) => {
    release = res;
  });
  // What another window left on disk: Grok hidden, and the factory behaviour.
  H.prefs = {
    tools: { hidden: ['grok'] },
    behaviour: { reopenTabs: true, confirmEnd: true, followOutput: false },
  };
  panel.open();
  await settle();
  tab('Preferences').click();
  // The answer has NOT landed yet, so the rows still show the in-memory stores.
  assert.equal(pressed(row('prefs', 'Grok')), true, 'the disk bag is still on its way');
  assert.equal(pressed(row('prefs', 'Follow output')), false);
  row('prefs', 'Codex').click();
  row('prefs', 'Follow output').click();
  await settle();
  assert.deepEqual(getHiddenTools(), ['codex']);
  assert.equal(getBehaviour().followOutput, true);
  release();
  H.prefsGate = null;
  await settle();
  await settle();
  assert.deepEqual(getHiddenTools(), ['codex'], 'the stored bag must not overwrite a fresh choice');
  assert.equal(pressed(row('prefs', 'Codex')), false, 'the card the user hid stays hidden');
  assert.equal(pressed(row('prefs', 'Grok')), true, 'and the one disk hides is not re-hidden');
  assert.equal(getBehaviour().followOutput, true);
  assert.equal(pressed(row('prefs', 'Follow output')), true, 'the toggle the user flipped stays flipped');
  H.prefs = {};
});
