/**
 * `web/src/ui/settings.ts` — the Settings panel (Nocturne A7) driven through the
 * REAL module against the DOM double in `tests/fake-dom.ts`: nav buttons
 * clicked, arrow keys pressed, checklist rows toggled, colour fields typed into.
 * The REAL `ui/util.ts`, `ui/launch-args.ts`, `ui/statusline-model.ts`,
 * `ui/term-colours.ts` and `ui/term-colours-model.ts` take part; only the four
 * non-pure imports are stubbed (`../api.ts`, `../state.ts`, `../log.ts`,
 * `./update.ts` — whose import graph reaches @xterm/xterm — and `./releases.ts`,
 * which would open a browser).
 *
 * WHY, next to `tests/ui-settings-a7.test.ts`. That file pins the STYLE
 * contract from the source; this one pins the plumbing the restyle could have
 * broken silently: the nav really swaps pages, a toggle still writes the
 * `statusLine` prefs key, the preview strip agrees with the rows, the notice
 * still names the sessions that cannot grow a status line, the mocked
 * Preferences page really cannot be operated, the colour page's selection stays
 * LOCAL, and the two backend verbs still reach their existing flows.
 *
 * NOT claimed (browser work, `.claude/skills/verify-terminal/SKILL.md`):
 * layout, colour rendering, that a native colour swatch opens a picker,
 * hit-testing, screen-reader output.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import type { SessionInfo, UiPrefs } from '../shared/protocol.ts';
import { byClass, dispatch, installDom, textsOf, type FakeElement } from './fake-dom.ts';

const dom = installDom();

// ===========================================================================
// Harness + module stubs
// ===========================================================================

interface Harness {
  sessions: Map<string, SessionInfo>;
  projectNames: Record<string, string | null>;
  installed: boolean;
  facts: { runningFor: string; version: string };
  prefs: UiPrefs;
  writes: { patch: UiPrefs; dead: readonly string[] }[];
  getCalls: number;
  restarts: string[];
  releasePages: number;
  logs: string[];
  subscribers: ((kind: string) => void)[];
  /**
   * When set, `getPrefs()` waits on it before answering — so a test can let the
   * user toggle a row BEFORE the re-read on open lands (the `writes > 0` guard
   * in settings.ts). Null in every other case, so the default behaviour of the
   * stub is unchanged.
   */
  gate: Promise<void> | null;
}

const H: Harness = {
  sessions: new Map(),
  projectNames: {},
  installed: false,
  facts: { runningFor: '2h 15m', version: '0.2.0' },
  prefs: {},
  writes: [],
  getCalls: 0,
  restarts: [],
  releasePages: 0,
  logs: [],
  subscribers: [],
  gate: null,
};
(globalThis as unknown as Record<string, unknown>).__sgHarness = H;

const STUB_SRC: Record<string, string> = {
  api: `
    const H = globalThis.__sgHarness;
    export async function updatePrefs(patch, dead) { H.writes.push({ patch, dead }); }
    export async function getPrefs() { H.getCalls++; if (H.gate !== null) await H.gate; return H.prefs; }`,
  state: `
    const H = globalThis.__sgHarness;
    export const state = {
      get sessions() { return H.sessions; },
      get installed() { return H.installed; },
    };
    export function projectName(id) { return H.projectNames[id] ?? null; }
    export function subscribe(fn) { H.subscribers.push(fn); }`,
  log: `
    const H = globalThis.__sgHarness;
    const rec = (lvl) => (m) => { H.logs.push(lvl + ' ' + m); };
    export const log = { debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') };`,
  update: `
    const H = globalThis.__sgHarness;
    export function openRestartConfirm(src) { H.restarts.push(src); }
    export function runtimeFacts() { return H.facts; }`,
  releases: `
    const H = globalThis.__sgHarness;
    export function openReleasesPage() { H.releasePages++; }`,
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((context.parentURL ?? '').endsWith('/web/src/ui/settings.ts')) {
      const m = /^(?:\.\.\/(api|state|log)|\.\/(update|releases))\.ts$/.exec(specifier);
      const name = m?.[1] ?? m?.[2];
      if (name !== undefined) return { url: `sg-stub:${name}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith('sg-stub:')) {
      return { format: 'module', source: STUB_SRC[url.slice('sg-stub:'.length)], shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

interface SettingsModule {
  initSettings(
    host: unknown,
    anchor: unknown,
    deps: { openShortcuts(): void; repaintStatus(): void },
  ): { open(): void; close(): void; toggle(): void; isOpen(): boolean };
}
interface ThemeModule {
  GROUNDS: { name: string; hex: string }[];
  RAMPS: { name: string; cmd: string; out: string; dim: string }[];
}

// A computed specifier: the typechecker must not walk the browser import graph
// under the server tsconfig (web/tsconfig.json owns that).
const S = (await import(new URL('../web/src/ui/settings.ts', import.meta.url).href)) as SettingsModule;
const T = (await import(new URL('../web/src/ui/theme-model.ts', import.meta.url).href)) as ThemeModule;

const modalHost = dom.doc.createElement('div');
const anchor = dom.doc.createElement('button');
dom.body.append(modalHost, anchor);
let shortcutsOpened = 0;
/** `ui/panes.ts` repaintStatus, injected — counted so the pane bar's live
 *  refresh is pinned here rather than left to a browser check. */
let repaints = 0;
const panel = S.initSettings(modalHost, anchor, {
  openShortcuts: () => {
    shortcutsOpened += 1;
  },
  repaintStatus: () => {
    repaints += 1;
  },
});
const scrim = modalHost.children[0] as FakeElement;
const modal = scrim.children[0] as FakeElement;

/** Let the `getPrefs()` re-read on open settle. */
const settle = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

function tab(label: string): FakeElement {
  const hit = byClass(modal, 'sg-tab').find((b) => b.textContent === label);
  assert.ok(hit !== undefined, `no nav button "${label}"`);
  return hit;
}

function panelOf(id: string): FakeElement {
  const hit = [...byClass(modal, 'sg-page')].find((p) => p.id === `sg-panel-${id}`);
  assert.ok(hit !== undefined, `no page "${id}"`);
  return hit;
}

/** A checklist row by its visible label, inside one page. */
function row(page: FakeElement, label: string): FakeElement {
  const hit = byClass(page, 'sg-row').find((r) => byClass(r, 'sg-rowlb')[0]?.textContent === label);
  assert.ok(hit !== undefined, `no row "${label}"`);
  return hit;
}

function statusPatch(i = -1): Record<string, boolean> {
  const w = H.writes.at(i);
  assert.ok(w !== undefined, 'no prefs write recorded');
  assert.deepEqual(w.dead, ['defaults', 'statusBar'], 'the two retired keys are pruned in the same write');
  return w.patch.statusLine as Record<string, boolean>;
}

async function reopen(): Promise<void> {
  panel.close();
  H.writes.length = 0;
  repaints = 0;
  // The gear has focus when a user opens the panel; close() hands it back there.
  anchor.focus();
  panel.open();
  await settle();
}

// ===========================================================================
// The shell: five pages behind a left nav
// ===========================================================================

test('the panel is a top-anchored modal dialog on the shared scrim, closed at boot', () => {
  assert.equal(scrim.hidden, true, 'nothing is shown until the gear is used');
  assert.equal(scrim.className, 'modal-scrim sg-scrim');
  assert.equal(modal.className, 'sg-modal');
  assert.equal(modal.getAttribute('role'), 'dialog');
  assert.equal(modal.getAttribute('aria-modal'), 'true');
  assert.equal(modal.getAttribute('aria-label'), 'Settings');
  assert.equal(byClass(modal, 'sg-navtitle')[0]?.textContent, 'Settings');
});

test('the nav names the five pages in the plan’s order, as a vertical tablist', () => {
  const tabs = byClass(modal, 'sg-tabs')[0] as FakeElement;
  assert.equal(tabs.getAttribute('role'), 'tablist');
  assert.equal(tabs.getAttribute('aria-orientation'), 'vertical');
  assert.deepEqual(textsOf(modal, 'sg-tab'), [
    'Status bar',
    'Preferences',
    'Keyboard',
    'Terminal colours',
    'Background service',
  ]);
  for (const id of ['status', 'prefs', 'keys', 'colours', 'service']) {
    const p = panelOf(id);
    assert.equal(p.getAttribute('role'), 'tabpanel');
    assert.equal(p.getAttribute('aria-labelledby'), `sg-tab-${id}`);
    assert.equal(tab(byClass(modal, 'sg-tab').find((b) => b.getAttribute('aria-controls') === p.id)?.textContent ?? '').getAttribute('aria-controls'), p.id);
  }
});

test('opening shows Status bar, and exactly one page is visible at a time', async () => {
  panel.open();
  await settle();
  assert.equal(panel.isOpen(), true);
  assert.equal(scrim.hidden, false);
  assert.equal(anchor.getAttribute('aria-expanded'), 'true');
  assert.equal(H.getCalls > 0, true, 'the stored config is re-read on open');
  assert.equal(tab('Status bar').getAttribute('aria-selected'), 'true');
  assert.equal(panelOf('status').hidden, false);
  const shown = ['status', 'prefs', 'keys', 'colours', 'service'].filter((id) => !panelOf(id).hidden);
  assert.deepEqual(shown, ['status']);
  // One tab stop in the nav: the chosen page (roving tabindex).
  assert.deepEqual(
    byClass(modal, 'sg-tab').map((b) => b.tabIndex),
    [0, -1, -1, -1, -1],
  );
  assert.equal(dom.doc.activeElement, tab('Status bar'), 'focus lands in the nav, not on a toggle');
});

test('a nav click swaps the page, and the arrow keys walk the nav', () => {
  tab('Terminal colours').click();
  assert.equal(panelOf('colours').hidden, false);
  assert.equal(panelOf('status').hidden, true);
  assert.equal(tab('Terminal colours').getAttribute('aria-selected'), 'true');
  assert.equal(tab('Status bar').getAttribute('aria-selected'), 'false');
  assert.ok(byClass(modal, 'sg-tab')[3]?.classList.contains('is-sel'));

  dispatch(byClass(modal, 'sg-tabs')[0] as FakeElement, 'keydown', { key: 'ArrowDown' });
  assert.equal(panelOf('service').hidden, false, 'ArrowDown moves to the next page');
  assert.equal(dom.doc.activeElement, tab('Background service'), 'the arrow takes focus with it');
  dispatch(byClass(modal, 'sg-tabs')[0] as FakeElement, 'keydown', { key: 'ArrowDown' });
  assert.equal(panelOf('status').hidden, false, 'and wraps around');
  dispatch(byClass(modal, 'sg-tabs')[0] as FakeElement, 'keydown', { key: 'End' });
  assert.equal(panelOf('service').hidden, false, 'End jumps to the last page');
  dispatch(byClass(modal, 'sg-tabs')[0] as FakeElement, 'keydown', { key: 'Home' });
  assert.equal(panelOf('status').hidden, false, 'Home jumps back to the first');
});

test('the footer holds one accent-outline Done that closes and hands focus back', async () => {
  await reopen();
  const ft = byClass(modal, 'sg-ft')[0] as FakeElement;
  const done = ft.children[0] as FakeElement;
  assert.equal(done.textContent, 'Done');
  assert.equal(done.className, 'btn-accent');
  done.click();
  assert.equal(panel.isOpen(), false);
  assert.equal(scrim.hidden, true);
  assert.equal(anchor.getAttribute('aria-expanded'), 'false');
  assert.equal(dom.doc.activeElement, anchor);
});

test('a click on the scrim closes; a click inside the card does not', async () => {
  panel.open();
  await settle();
  dispatch(modal, 'mousedown');
  assert.equal(panel.isOpen(), true, 'the card swallows its own clicks');
  dispatch(scrim, 'mousedown');
  assert.equal(panel.isOpen(), false);
});

// ===========================================================================
// Status bar — the live checklist
// ===========================================================================

test('the Status bar page renders the two switches, the eight items and their captions', async () => {
  await reopen();
  const page = panelOf('status');
  assert.equal(byClass(page, 'sg-title')[0]?.textContent, 'Status bar');
  assert.equal(
    byClass(page, 'sg-lead')[0]?.textContent,
    'Choose what each session shows under its terminal. Saved on this computer.',
  );
  const labels = byClass(page, 'sg-rows')
    .flatMap((g) => byClass(g, 'sg-rowlb'))
    .map((n) => n.textContent);
  assert.deepEqual(labels, [
    // Nocturne B1: the two PLACES a status bar can be, then the items they share.
    'Inside the terminal',
    'Under the terminal',
    'Model',
    'Permission mode',
    'Git branch',
    'Cost so far',
    'Session time',
    'Lines changed',
    'Context used',
    'Account usage',
  ]);
  assert.deepEqual(textsOf(page, 'sg-cap'), [
    'Claude Code’s own line, drawn at the bottom of the terminal',
    'the app’s bar below the terminal',
    'shows the mode the session was started with',
    'under the terminal only',
    'works with a Claude Pro or Max account, and appears after the session’s first reply',
  ]);
  // The sample beside a row IS the text the status line draws.
  assert.equal(byClass(row(page, 'Model'), 'sg-val')[0]?.textContent, 'opus');
  assert.equal(byClass(row(page, 'Session time'), 'sg-val')[0]?.textContent, '2h 15m');
});

test('the lead under the preview names the both-on consequence', async () => {
  await reopen();
  const leads = textsOf(panelOf('status'), 'sg-lead');
  assert.equal(
    leads[1],
    'A session shows nothing until its first reply, and when Claude asks you to trust a folder it has not worked in before the line stays blank until you do. With both on, the same values show twice.',
  );
});

test('the preview strip shows the enabled items, and says so when there are none', async () => {
  await reopen();
  const page = panelOf('status');
  const bar = byClass(page, 'sg-prevbar')[0] as FakeElement;
  // The first label is the strip's own marker: the samples are invented, and
  // `$0.42` / `5h 38%` must not read as the user's own numbers.
  assert.deepEqual(textsOf(bar, 'sg-prevlb'), [
    'Example',
    'Model',
    'Permission mode',
    'Git branch',
    'Cost so far',
    'Context used',
  ]);
  assert.equal(bar.children[0]?.textContent, 'Example', 'and it comes FIRST, before any item');
  assert.equal(byClass(bar, 'sg-previtem').length, 5, 'the marker is not an item');
  assert.deepEqual(textsOf(bar, 'sg-prevval'), ['opus', 'always ask', 'git:main', '$0.42', 'ctx 62%']);

  row(page, 'Cost so far').click();
  assert.equal(statusPatch().cost, false, 'the toggle is persisted');
  assert.equal(
    textsOf(bar, 'sg-prevlb').includes('Cost so far'),
    false,
    'and the preview agrees with the rows',
  );

  row(page, 'Inside the terminal').click();
  assert.equal(statusPatch().enabled, false);
  assert.equal(byClass(bar, 'sg-prevempty')[0]?.textContent, 'Nothing selected, the bar is hidden');
});

test('the preview is Claude’s own line: it never shows Session time, and ignores the pane bar', async () => {
  await reopen();
  const page = panelOf('status');
  const bar = byClass(page, 'sg-prevbar')[0] as FakeElement;
  assert.equal(row(page, 'Session time').getAttribute('aria-pressed'), 'true', 'it is on by default');
  assert.equal(
    textsOf(bar, 'sg-prevlb').includes('Session time'),
    false,
    'the line Claude draws is handed no start time, so it can never print one',
  );
  assert.equal(textsOf(bar, 'sg-prevval').includes('2h 15m'), false);
  // Turning the pane bar off leaves that line exactly as it was.
  const before = textsOf(bar, 'sg-prevlb');
  row(page, 'Under the terminal').click();
  assert.equal(statusPatch().paneBar, false);
  assert.deepEqual(textsOf(bar, 'sg-prevlb'), before);
});

test('the items dim only when BOTH places are off — one bar left is still a bar', async () => {
  await reopen();
  const page = panelOf('status');
  const itemsWrap = byClass(page, 'sg-items')[0] as FakeElement;

  row(page, 'Inside the terminal').click();
  assert.equal(row(page, 'Model').disabled, false, 'the bar under the terminal still reads them');
  assert.equal(itemsWrap.classList.contains('is-disabled'), false);

  row(page, 'Under the terminal').click();
  assert.equal(row(page, 'Model').disabled, true, 'now there is nowhere left to draw them');
  assert.ok(itemsWrap.classList.contains('is-disabled'));
  assert.deepEqual(
    [statusPatch().enabled, statusPatch().paneBar],
    [false, false],
    'both switches are persisted off',
  );

  row(page, 'Under the terminal').click();
  assert.equal(row(page, 'Model').disabled, false);
  assert.equal(itemsWrap.classList.contains('is-disabled'), false);
  row(page, 'Inside the terminal').click();
  assert.equal(statusPatch().enabled, true);
});

test('every toggle repaints the panes at once — the bar must not wait for a session event', async () => {
  await reopen();
  const page = panelOf('status');
  // Opening re-reads the stored bag (another window may have changed it), and
  // that read is a repaint reason of its own.
  assert.equal(repaints, 1, 'the re-read on open repaints once');
  repaints = 0;
  row(page, 'Session time').click();
  assert.equal(repaints, 1);
  row(page, 'Under the terminal').click();
  assert.equal(repaints, 2);
  const reset = byClass(page, 'sg-textbtn').find((b) => b.textContent === 'Reset to defaults');
  assert.ok(reset !== undefined);
  reset.click();
  assert.equal(repaints, 3, 'Reset to defaults is a change too');
});

test('a toggle writes the whole resolved config, and Reset to defaults restores the factory set', async () => {
  await reopen();
  const page = panelOf('status');
  row(page, 'Lines changed').click();
  const on = statusPatch();
  assert.deepEqual(on, {
    enabled: true,
    model: true,
    mode: true,
    branch: true,
    cost: true,
    lines: true,
    context: true,
    usage: false,
    paneBar: true,
    time: true,
  });
  assert.equal(row(page, 'Lines changed').getAttribute('aria-pressed'), 'true');

  // The two B1 keys are real members of that write, not defaults left implicit.
  row(page, 'Session time').click();
  assert.equal(statusPatch().time, false);
  row(page, 'Under the terminal').click();
  assert.equal(statusPatch().paneBar, false);

  const reset = byClass(page, 'sg-textbtn').find((b) => b.textContent === 'Reset to defaults');
  assert.ok(reset !== undefined, 'the page carries Reset to defaults');
  reset.click();
  const back = statusPatch();
  assert.equal(back.lines, false, 'back to the factory off-state');
  assert.deepEqual(
    [back.enabled, back.paneBar, back.time],
    [true, true, true],
    'Reset restores BOTH places and Session time',
  );
  assert.equal(row(page, 'Lines changed').getAttribute('aria-pressed'), 'false');
  assert.equal(row(page, 'Under the terminal').getAttribute('aria-pressed'), 'true');
  assert.equal(row(page, 'Session time').getAttribute('aria-pressed'), 'true');
});

test('the debug line of a write names both places', async () => {
  await reopen();
  H.logs.length = 0;
  row(panelOf('status'), 'Model').click();
  const line = H.logs.find((l) => l.startsWith('debug prefs statusLine:'));
  assert.ok(line !== undefined, 'a write is logged');
  assert.ok(line.includes('enabled=true'), line);
  assert.ok(line.includes('paneBar=true'), line);
  assert.ok(line.includes('time=true'), line);
});

test('the notice names the running sessions that cannot grow a status line, and only then', async () => {
  const sess = (over: Partial<SessionInfo>): SessionInfo =>
    ({
      id: 's1',
      // A session launched without a name keeps the raw command as its title —
      // the case the notice has to render as the product name instead.
      title: 'claude',
      command: 'claude',
      args: [],
      cwd: '/home/tester',
      projectId: 'p1',
      status: 'running',
      startedAt: new Date().toISOString(),
      ...over,
    }) as SessionInfo;

  H.sessions = new Map();
  await reopen();
  const notice = byClass(panelOf('status'), 'sg-notice')[0] as FakeElement;
  assert.equal(notice.hidden, true, 'silent when every session has one');

  H.sessions = new Map([
    ['s1', sess({ id: 's1', statusline: false })],
    ['s2', sess({ id: 's2', title: 'planner', statusline: true })],
    ['s3', sess({ id: 's3', title: 'gone', statusline: false, status: 'exited' })],
  ]);
  // The poll notifies while the panel is open.
  for (const fn of H.subscribers) fn('sessions');
  assert.equal(notice.hidden, false);
  const names = byClass(notice, 'sg-notice-names')[0] as FakeElement;
  assert.equal(names.textContent, 'Claude Code', 'a title that is just the command renders as the product name');
  H.sessions = new Map();
  for (const fn of H.subscribers) fn('sessions');
  assert.equal(notice.hidden, true);
});

// ===========================================================================
// Keyboard
// ===========================================================================

test('the Keyboard page lists the chords as mono chips, a mouse gesture as plain text', async () => {
  await reopen();
  tab('Keyboard').click();
  const page = panelOf('keys');
  assert.equal(
    byClass(page, 'sg-lead')[0]?.textContent,
    'Almost everything you type goes straight to the terminal. The app only listens for these.',
  );
  assert.deepEqual(textsOf(page, 'sg-rowlb'), [
    'paste into a terminal',
    'copy the selection',
    'open a link printed in a terminal',
  ]);
  assert.deepEqual(textsOf(page, 'sg-kbd'), [
    'ctrl+shift+v',
    'shift+insert',
    'ctrl+shift+c',
    'ctrl+insert',
  ]);
  assert.deepEqual(textsOf(page, 'sg-gesture'), ['ctrl+click'], 'a mouse sentence is never a key chip');

  const link = byClass(page, 'sg-link').find((b) => b.textContent === 'all shortcuts');
  assert.ok(link !== undefined);
  assert.equal(link.getAttribute('aria-haspopup'), 'dialog');
  const before = shortcutsOpened;
  link.click();
  assert.equal(shortcutsOpened, before + 1, 'the full overlay is still one click away');
});

// ===========================================================================
// Preferences — mocked until part B6
// ===========================================================================

test('every control on the Preferences page is inert, and one line says so', async () => {
  await reopen();
  tab('Preferences').click();
  const page = panelOf('prefs');
  assert.deepEqual(textsOf(page, 'sg-mark'), ['CC', 'CX', 'GM', 'GK', '>_']);
  assert.deepEqual(
    byClass(page, 'sg-prow').map((r) => byClass(r, 'sg-rowlb')[0]?.textContent),
    ['Claude Code', 'Codex', 'Gemini CLI', 'Grok', 'Terminal'],
  );
  assert.deepEqual(textsOf(page, 'sg-prowkey'), [
    // Claude Code does need authentication, just not a key this app stores.
    'Uses your Claude login',
    // The launch dialog's own string for the same three tools (launch-args.ts
    // NOT_YET) — "Needs a key" would promise a key is all that is missing.
    'Not available yet',
    'Not available yet',
    'Not available yet',
    'No key needed',
  ]);
  assert.equal(byClass(page, 'sg-keyin').length, 3, 'a key field only where a key is needed');
  assert.deepEqual(
    byClass(page, 'sg-keyin').map((i) => i.placeholder),
    ['Paste API key', 'Paste API key', 'Paste API key'],
  );
  // A key field is a credential field even while it is a mock: masked, never
  // offered as a saved login, and with no `name` for an autofill to match.
  for (const i of byClass(page, 'sg-keyin')) {
    assert.equal(i.type, 'password');
    assert.equal(i.autocomplete, 'new-password');
    assert.equal(i.getAttribute('name'), null);
  }
  assert.deepEqual(textsOf(page, 'sg-sub'), ['Defaults']);
  assert.deepEqual(
    byClass(page, 'sg-row').map((r) => byClass(r, 'sg-rowlb')[0]?.textContent),
    [
      'Reopen tabs on start',
      'Confirm before ending a session',
      'Notifications when a session needs you',
      'Follow output',
    ],
  );
  for (const c of [...byClass(page, 'sg-keyin'), ...byClass(page, 'sg-smallbtn'), ...byClass(page, 'sg-row')]) {
    assert.equal(c.disabled, true, `${c.className} must be inert until part B6`);
  }
  assert.equal(byClass(page, 'sg-note')[0]?.textContent, 'Example settings until the app saves them.');

  // And nothing here writes a pref, however hard it is clicked.
  const before = H.writes.length;
  for (const r of byClass(page, 'sg-row')) r.click();
  assert.equal(H.writes.length, before, 'the mocked defaults never reach prefs.json');
});

// ===========================================================================
// Terminal colours — local to the page until part B9
// ===========================================================================

/**
 * The colour page's selection is LOCAL and survives a close/open (part B9 will
 * persist it), so a case that wants to start from the default says so.
 */
function resetColours(): void {
  const reset = byClass(panelOf('colours'), 'sg-textbtn').find((b) => b.textContent === 'Reset to Nocturne');
  assert.ok(reset !== undefined, 'the page carries Reset to Nocturne');
  reset.click();
}

const nocturne = (): { ground: string; cmd: string } => ({
  ground: T.GROUNDS[0]?.hex as string,
  cmd: T.RAMPS[0]?.cmd as string,
});

function colourPage(): {
  page: FakeElement;
  prev: FakeElement;
  cards: FakeElement[];
  groundHex: FakeElement;
  textHex: FakeElement;
} {
  const page = panelOf('colours');
  return {
    page,
    prev: byClass(page, 'sg-tcprev')[0] as FakeElement,
    cards: byClass(page, 'sg-tccard'),
    groundHex: byClass(page, 'sg-tchex')[0] as FakeElement,
    textHex: byClass(page, 'sg-tchex')[1] as FakeElement,
  };
}

test('the Terminal colours page opens on Nocturne, previewed in the terminal’s own type', async () => {
  await reopen();
  tab('Terminal colours').click();
  resetColours();
  const { page, prev, cards, groundHex, textHex } = colourPage();
  assert.equal(byClass(page, 'sg-title')[0]?.textContent, 'Terminal colours');
  assert.equal(cards.length >= 5, true, `a shelf of schemes: ${cards.length}`);
  assert.equal(byClass(cards[0] as FakeElement, 'sg-tcname')[0]?.textContent, 'Nocturne');
  assert.equal(cards[0]?.getAttribute('aria-checked'), 'true', 'Nocturne is the default');
  assert.ok(cards[0]?.classList.contains('is-sel'));
  assert.equal(prev.style['background-color'], nocturne().ground);
  assert.equal(byClass(prev, 'sg-tcline')[0]?.style.color, nocturne().cmd);
  assert.equal(groundHex.value, nocturne().ground);
  assert.equal(textHex.value, nocturne().cmd);
  assert.equal(byClass(page, 'sg-note')[0]?.textContent, 'Example colours until the app applies them to your terminals.');
  // Three ink steps, and the dim line is not the bright one.
  const inks = byClass(prev, 'sg-tcline').map((l) => l.style.color);
  assert.equal(inks.length, 3);
  assert.notEqual(inks[0], inks[2]);
});

test('picking a scheme moves the preview, the cards and both fields — and nothing else', async () => {
  await reopen();
  tab('Terminal colours').click();
  resetColours();
  const { cards, prev, groundHex, textHex } = colourPage();
  const before = H.writes.length;
  (cards[1] as FakeElement).click();
  assert.equal(cards[1]?.getAttribute('aria-checked'), 'true');
  assert.equal(cards[0]?.getAttribute('aria-checked'), 'false');
  assert.equal(prev.style['background-color'], T.GROUNDS[1]?.hex);
  assert.equal(byClass(prev, 'sg-tcline')[0]?.style.color, T.RAMPS[1]?.cmd);
  assert.equal(byClass(prev, 'sg-tcline')[2]?.style.color, T.RAMPS[1]?.dim);
  assert.equal(groundHex.value, T.GROUNDS[1]?.hex);
  assert.equal(textHex.value, T.RAMPS[1]?.cmd);
  assert.equal(H.writes.length, before, 'A7 writes no prefs from this page (part B9 does)');
  // One tab stop in the row, on the chosen card.
  assert.deepEqual(
    cards.map((c) => c.tabIndex),
    cards.map((_, i) => (i === 1 ? 0 : -1)),
  );
});

test('the scheme row answers the arrow keys', async () => {
  await reopen();
  tab('Terminal colours').click();
  resetColours();
  const { page, cards } = colourPage();
  const grid = byClass(page, 'sg-tcgrid')[0] as FakeElement;
  assert.equal(grid.getAttribute('role'), 'radiogroup');
  dispatch(grid, 'keydown', { key: 'ArrowRight' });
  assert.equal(cards[1]?.getAttribute('aria-checked'), 'true');
  dispatch(grid, 'keydown', { key: 'ArrowLeft' });
  assert.equal(cards[0]?.getAttribute('aria-checked'), 'true');
  dispatch(grid, 'keydown', { key: 'End' });
  assert.equal(cards.at(-1)?.getAttribute('aria-checked'), 'true');
});

test('a custom colour is accepted only when it is a whole colour, and it drops the preset', async () => {
  await reopen();
  tab('Terminal colours').click();
  resetColours();
  const { page, prev, cards, groundHex } = colourPage();

  groundHex.value = '#12345';
  dispatch(groundHex, 'input');
  assert.ok(groundHex.classList.contains('is-bad'), 'a half-typed colour is flagged');
  assert.equal(groundHex.getAttribute('aria-invalid'), 'true');
  assert.equal(prev.style['background-color'], nocturne().ground, 'and the preview does not move');
  assert.equal(cards[0]?.getAttribute('aria-checked'), 'true');

  groundHex.value = '#123456';
  dispatch(groundHex, 'input');
  assert.equal(groundHex.classList.contains('is-bad'), false);
  assert.equal(prev.style['background-color'], '#123456');
  assert.deepEqual(
    cards.map((c) => c.getAttribute('aria-checked')),
    cards.map(() => 'false'),
    'a custom pair is no preset',
  );
  // The row keeps a tab stop even with no card chosen.
  assert.equal(cards[0]?.tabIndex, 0);

  const reset = byClass(page, 'sg-textbtn').find((b) => b.textContent === 'Reset to Nocturne');
  assert.ok(reset !== undefined);
  reset.click();
  assert.equal(prev.style['background-color'], nocturne().ground);
  assert.equal(cards[0]?.getAttribute('aria-checked'), 'true');
});

test('the native swatch and the hex field are two views of one value', async () => {
  await reopen();
  tab('Terminal colours').click();
  resetColours();
  const { page, prev, textHex } = colourPage();
  const swatches = byClass(page, 'sg-tcswatch');
  assert.deepEqual(
    swatches.map((s) => s.type),
    ['color', 'color'],
    'a native colour input, not a home-made picker',
  );
  assert.deepEqual(
    byClass(page, 'sg-tclb').map((l) => l.textContent),
    ['Ground', 'Text'],
  );
  const textSwatch = swatches[1] as FakeElement;
  textSwatch.value = '#ff8800';
  dispatch(textSwatch, 'input');
  assert.equal(byClass(prev, 'sg-tcline')[0]?.style.color, '#ff8800');
  assert.equal(textHex.value, '#ff8800', 'the hex field follows the swatch');
});

// ===========================================================================
// Background service
// ===========================================================================

test('the Background service page states the two facts and keeps both existing verbs', async () => {
  H.installed = false;
  await reopen();
  tab('Background service').click();
  const page = panelOf('service');
  assert.equal(
    byClass(page, 'sg-lead')[0]?.textContent,
    'Your sessions run in a service that keeps going while this window is open. Restarting it picks up a new version of the app. Every running session closes, but stays in history.',
  );
  assert.equal(byClass(page, 'sg-svcver')[0]?.textContent, 'Version 0.2.0');
  assert.equal(byClass(page, 'sg-svcup')[0]?.textContent, 'Running for 2h 15m');
  const check = byClass(page, 'sg-link')[0] as FakeElement;
  assert.equal(check.textContent, 'Check for updates');
  assert.equal(check.hidden, true, 'a developer clone is not updated from a releases page');

  // The runtime poll writes both facts; a conn change refreshes the readouts.
  H.installed = true;
  H.facts = { runningFor: 'just started', version: '0.4.0' };
  for (const fn of H.subscribers) fn('conn');
  assert.equal(byClass(page, 'sg-svcver')[0]?.textContent, 'Version 0.4.0');
  assert.equal(byClass(page, 'sg-svcup')[0]?.textContent, 'Running for just started');
  assert.equal(check.hidden, false, 'an installed app can go and get one');

  const releases = H.releasePages;
  check.click();
  assert.equal(H.releasePages, releases + 1);

  const restart = byClass(page, 'sg-outbtn')[0] as FakeElement;
  assert.equal(restart.textContent, 'Restart service');
  assert.equal(restart.getAttribute('aria-haspopup'), 'dialog');
  restart.click();
  assert.deepEqual(H.restarts, ['settings'], 'the existing confirmation flow, named by its source');
});

test('a closed panel ignores the poll (no work, no notice churn)', () => {
  panel.close();
  H.facts = { runningFor: '9 h', version: '9.9.9' };
  for (const fn of H.subscribers) fn('conn');
  assert.equal(
    byClass(panelOf('service'), 'sg-svcver')[0]?.textContent,
    'Version 0.4.0',
    'the readouts are refreshed on open, not while hidden',
  );
});

test('toggle() opens and closes the same panel', async () => {
  assert.equal(panel.isOpen(), false);
  panel.toggle();
  await settle();
  assert.equal(panel.isOpen(), true);
  panel.toggle();
  assert.equal(panel.isOpen(), false);
});

// ===========================================================================
// Test-engineer additions (A7 gate) — the branches the cases above leave open:
// the late `getPrefs()` answer, a late answer after close, and the notice's
// same-name qualifier.
// ===========================================================================

test('a slow re-read on open never undoes a toggle the user already made', async () => {
  // settings.ts counts writes since this open and drops a late `getPrefs()`
  // answer when there are any; without that guard the panel would silently flip
  // a row back under the user's hand.
  panel.close();
  H.writes.length = 0;
  let release!: () => void;
  H.gate = new Promise<void>((res) => {
    release = res;
  });
  // What the other window has on disk: everything off.
  H.prefs = {
    statusLine: {
      enabled: false,
      model: false,
      mode: false,
      branch: false,
      cost: false,
      lines: false,
      context: false,
      usage: false,
    },
  };
  panel.open();
  await settle();
  const page = panelOf('status');
  // The answer has NOT landed yet, so the rows still show the in-memory config.
  assert.equal(row(page, 'Model').getAttribute('aria-pressed'), 'true');
  row(page, 'Model').click();
  assert.equal(statusPatch().model, false, 'the user turned Model off');
  release();
  await settle();
  await settle();
  assert.equal(
    row(page, 'Model').getAttribute('aria-pressed'),
    'false',
    'the stored bag must not overwrite a fresh choice',
  );
  assert.equal(row(page, 'Inside the terminal').getAttribute('aria-pressed'), 'true');
  H.gate = null;
  H.prefs = {};
});

test('a re-read that answers after the panel is closed changes nothing', async () => {
  panel.close();
  let release!: () => void;
  H.gate = new Promise<void>((res) => {
    release = res;
  });
  H.prefs = { statusLine: { enabled: false, model: false } };
  panel.open();
  await settle();
  const page = panelOf('status');
  const before = row(page, 'Model').getAttribute('aria-pressed');
  panel.close();
  release();
  await settle();
  await settle();
  assert.equal(row(page, 'Model').getAttribute('aria-pressed'), before, 'a closed panel takes no answer');
  H.gate = null;
  H.prefs = {};
});

/** A running claude session with no status line — the notice's whole input. */
function staleSess(
  id: string,
  title: string,
  projectId: string | undefined,
  command = 'claude',
): SessionInfo {
  return {
    id,
    title,
    command,
    args: [],
    cwd: '/home/tester',
    projectId,
    status: 'running',
    statusline: false,
    startedAt: new Date().toISOString(),
  } as unknown as SessionInfo;
}

test('the notice qualifies same-named sessions with their project, and lists each one', async () => {
  const sess = staleSess;

  H.projectNames = { p1: 'Alpha', p2: 'Beta' };
  // Two sessions whose title IS the command: both render as the product name, so
  // the label collides and the project is what tells them apart.
  H.sessions = new Map([
    ['a', sess('a', 'claude', 'p1')],
    ['b', sess('b', 'claude', 'p2')],
    ['c', sess('c', 'planner', 'p1')],
  ]);
  await reopen();
  const notice = byClass(panelOf('status'), 'sg-notice')[0] as FakeElement;
  assert.equal(notice.hidden, false);
  assert.equal(
    (byClass(notice, 'sg-notice-names')[0] as FakeElement).textContent,
    'Claude Code (Alpha), Claude Code (Beta), planner',
    'a colliding label takes its project as a qualifier; a unique one does not',
  );

  // A colliding label with NO project stays bare — an invented qualifier would
  // name something the session does not have.
  H.sessions = new Map([
    ['a', sess('a', 'claude', undefined)],
    ['b', sess('b', 'claude', undefined)],
  ]);
  for (const fn of H.subscribers) fn('sessions');
  assert.equal(
    (byClass(notice, 'sg-notice-names')[0] as FakeElement).textContent,
    'Claude Code, Claude Code',
  );
  H.sessions = new Map();
  H.projectNames = {};
  for (const fn of H.subscribers) fn('sessions');
  assert.equal(notice.hidden, true);
});

test('a claude launched by absolute PATH is named by the PRODUCT name, never by its path', async () => {
  // `sessionsWithoutStatusLine()` matches on the BASENAME of the command
  // (statusline-model.ts), and since 2026-09-13 so does `commandLabel()`
  // (launch-args.ts, the `isClaudeCommand` rule) — so a session started as
  // `/usr/local/bin/claude` reaches this notice AND reads as the product name.
  // A raw path here would be a command in UI chrome (PROJECT-SCOPE copy rule,
  // 2026-07-25).
  H.projectNames = { p1: 'Alpha' };
  H.sessions = new Map([['a', staleSess('a', '/usr/local/bin/claude', 'p1', '/usr/local/bin/claude')]]);
  await reopen();
  const notice = byClass(panelOf('status'), 'sg-notice')[0] as FakeElement;
  assert.equal(notice.hidden, false, 'the basename match puts it in the notice');
  assert.equal(
    (byClass(notice, 'sg-notice-names')[0] as FakeElement).textContent,
    'Claude Code',
    'the basename rule names it, and the path never reaches the copy',
  );
  H.sessions = new Map();
  H.projectNames = {};
  for (const fn of H.subscribers) fn('sessions');
});
