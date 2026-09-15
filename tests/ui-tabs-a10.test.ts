/**
 * The tab strip after Nocturne part A10, driven through the REAL
 * `web/src/ui/tabs.ts` on the shared DOM double, against the REAL
 * `web/src/state.ts` and `ui/slots-model.ts`.
 *
 * A10 gave a tab three new facts to state, and every one of them is a way to
 * lie on a 32px chip:
 *
 *   1. WHAT IT IS ABOUT. `Home` is `Home`, a folder tab prints the PROJECT'S
 *      NAME and never its path (PROJECT-SCOPE, 2026-07-25), and a plain
 *      session tab still joins its panes' names.
 *   2. WHAT IS IN IT. The count pill counts PANES, not sessions (a tab can be
 *      four files); an amber dot says a file in it is unsaved; the status dot
 *      is ABSENT when the tab holds no session at all, because a state dot
 *      there would be a readout of nothing.
 *   3. WHAT `×` COSTS. A tab holding sessions ENDS them and keeps the armed
 *      two-step; a tab holding only files kills nothing and closes on one
 *      click. `Home` has no `×` and no drag handle at all (user decision 4).
 *
 * `killSession` and the launch dialog are INJECTED into `initTabs`, so this
 * runner never reaches @xterm/xterm.
 *
 * NOT claimed (browser work): layout, colour, the drag itself (ui/dnd.ts, and
 * `tests/ui-dnd-a10.test.ts`).
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { byClass, byKey, descendants, installDom, type FakeElement } from './fake-dom.ts';

const dom = installDom();

interface Slot {
  kind: 'session' | 'file' | 'diff';
  id?: string;
  path?: string;
  hash?: string;
}
interface View {
  id: string;
  root: { kind: 'home' } | { kind: 'project'; id: string } | null;
  slots: Slot[];
  focused: number;
  l3: 'L' | 'R';
  split: { col: number; row: number };
}
interface StateModule {
  state: {
    views: View[];
    activeViewId: string;
    sessions: Map<string, unknown>;
    projects: { id: string; name: string; path: string; createdAt: string }[];
    edits: Map<string, string>;
  };
  setSessions(list: unknown[]): void;
  setProjects(list: unknown[]): void;
  slotKey(s: Slot): string;
}
interface TabsModule {
  initTabs(
    strip: unknown,
    deps: { killSession(id: string): void; openLaunch(): void },
  ): { render(): void };
  tabLabel(v: View): string;
}

const st = (await import(new URL('../web/src/state.ts', import.meta.url).href)) as StateModule;
const T = (await import(new URL('../web/src/ui/tabs.ts', import.meta.url).href)) as TabsModule;

const strip = dom.doc.createElement('nav');
dom.body.append(strip);

const killed: string[] = [];
/**
 * What the SERVER doing its half looks like: the real `killSession` ends the
 * PTY and the session leaves `state.sessions` (and its slots leave the views)
 * over the socket. Tests that care about what happens AFTER the last kill set
 * this; the others leave it null and only read `killed`.
 */
let killEffect: ((id: string) => void) | null = null;
let launches = 0;
const tabs = T.initTabs(strip, {
  killSession(id) {
    killed.push(id);
    killEffect?.(id);
  },
  openLaunch() {
    launches += 1;
  },
});

function view(over: Partial<View>): View {
  return {
    id: 'v1',
    root: null,
    slots: [],
    focused: 0,
    l3: 'L',
    split: { col: 0.5, row: 0.5 },
    ...over,
  };
}

function session(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    title: id,
    command: 'claude',
    args: [],
    cwd: '/home/tester/api',
    status: 'running',
    cols: 80,
    rows: 24,
    createdAt: new Date().toISOString(),
    ...over,
  };
}

/** Rebuild the strip from scratch (the signature guard is not what is tested). */
function draw(views: View[], activeId = views[0]?.id ?? ''): void {
  st.state.views = views;
  st.state.activeViewId = activeId;
  strip.replaceChildren();
  tabs.render();
  tabs.render(); // the signature guard must not leave the strip half-drawn
}

const chips = (): FakeElement[] => byClass(strip, 'tab');

beforeEach(() => {
  st.state.views = [];
  st.state.activeViewId = '';
  st.state.edits = new Map();
  st.setSessions([]);
  st.setProjects([{ id: 'p1', name: 'API server', path: '/home/tester/api', createdAt: '' }]);
  killed.length = 0;
  killEffect = null;
  launches = 0;
  strip.replaceChildren();
  // A fresh strip on every test: the render is signature-guarded on purpose.
  draw([]);
});

test('non-vacuity: the strip really renders, with the `+` and the hint', () => {
  draw([view({ id: 'home', root: { kind: 'home' } })]);
  assert.equal(chips().length, 1);
  assert.ok(byKey(strip, 'tab-new') !== null, 'the launch opener is on the strip');
  assert.deepEqual(
    byClass(strip, 'strip-hint').map((n) => n.textContent),
    ['Drag a tab onto another to show them side by side'],
  );
  (byKey(strip, 'tab-new') as FakeElement).click();
  assert.equal(launches, 1);
});

test('a tab is named after its ROOT: Home, the project NAME, or its panes', () => {
  st.setSessions([session('s1', { title: 'build' }), session('s2', { title: 'tests' })]);
  draw([
    view({ id: 'home', root: { kind: 'home' }, slots: [{ kind: 'file', path: 'web/src/main.ts' }] }),
    view({ id: 'proj', root: { kind: 'project', id: 'p1' }, slots: [{ kind: 'session', id: 's1' }] }),
    view({ id: 'plain', root: null, slots: [{ kind: 'session', id: 's1' }, { kind: 'session', id: 's2' }] }),
  ]);
  assert.deepEqual(
    byClass(strip, 'tab-label').map((n) => n.textContent),
    ['Home', 'API server', 'build, tests'],
  );
  // The project's PATH is nowhere on the strip.
  assert.equal(strip.textContent.includes('/home/tester/api'), false);
});

test('a file pane is named on the chip too, by its file name and nothing else', () => {
  draw([
    view({ id: 'plain', root: null, slots: [{ kind: 'file', path: 'web/src/ui/panes.ts' }] }),
  ]);
  assert.deepEqual(
    byClass(strip, 'tab-label').map((n) => n.textContent),
    ['panes.ts'],
  );
});

test('the count pill counts PANES — four files are four panes', () => {
  draw([
    view({
      id: 'home',
      root: { kind: 'home' },
      slots: [
        { kind: 'file', path: 'a/one.ts' },
        { kind: 'file', path: 'a/two.ts' },
        { kind: 'diff', hash: 'a1b2c3d', path: 'a/two.ts' },
      ],
    }),
  ]);
  const pill = byClass(strip, 'tab-count')[0] as FakeElement;
  assert.equal(pill.textContent, '3');
  assert.equal(pill.title, '3 panes in this tab');
});

test('no session in the tab, no status dot — a dot there would report on nothing', () => {
  draw([view({ id: 'home', root: { kind: 'home' }, slots: [{ kind: 'file', path: 'a/one.ts' }] })]);
  assert.equal(byClass(strip, 'dot').length, 0, 'a file has no state to report');

  st.setSessions([session('s1')]);
  draw([view({ id: 'plain', root: null, slots: [{ kind: 'session', id: 's1' }] })]);
  const dots = byClass(strip, 'dot');
  assert.equal(dots.length, 1);
  assert.ok((dots[0] as FakeElement).classList.contains('is-run'), 'a running session is green');
});

test('an unsaved file puts the amber mark on the chip, in words as well as a shape', () => {
  const slot: Slot = { kind: 'file', path: 'web/src/main.ts' };
  draw([view({ id: 'home', root: { kind: 'home' }, slots: [slot] })]);
  assert.equal(byClass(strip, 'tab-dirty').length, 0, 'a clean file wears no mark');

  st.state.edits.set(st.slotKey(slot), 'typed');
  draw([view({ id: 'home', root: { kind: 'home' }, slots: [slot] })]);
  assert.equal(byClass(strip, 'tab-dirty').length, 1);
  assert.deepEqual(
    byClass(strip, 'sr-only').map((n) => n.textContent),
    ['Unsaved changes'],
    'the dot is a shape; the state is also in words',
  );
});

test('Home has no × and no drag handle at all', () => {
  st.setSessions([session('s1')]);
  draw([
    view({ id: 'home', root: { kind: 'home' }, slots: [] }),
    view({ id: 'plain', root: null, slots: [{ kind: 'session', id: 's1' }] }),
  ]);
  const [home, plain] = chips() as [FakeElement, FakeElement];
  assert.equal(byKey(home, 'tabx:home'), null, 'Home is never closed');
  assert.equal(
    home.handlers.some((h) => h.type === 'pointerdown'),
    false,
    'and never armed as a drag source',
  );
  assert.ok(byKey(plain, 'tabx:plain') !== null, 'every other tab keeps its ×');
  assert.equal(
    plain.handlers.some((h) => h.type === 'pointerdown'),
    true,
    'and stays draggable',
  );
});

/** `killView` is async (it awaits every kill); let its tail run. */
async function settle(): Promise<void> {
  await new Promise((r) => setImmediate(r));
}

test('× on a tab holding only files closes it in ONE click, and ends nothing', async () => {
  draw([
    view({ id: 'home', root: { kind: 'home' }, slots: [] }),
    view({
      id: 'proj',
      root: { kind: 'project', id: 'p1' },
      slots: [{ kind: 'file', path: 'web/src/main.ts' }],
    }),
  ]);
  const x = byKey(strip, 'tabx:proj') as FakeElement;
  assert.equal(x.textContent, '×');
  assert.equal(x.title, 'Close this tab. Nothing is ended.');
  x.click();
  await settle();
  assert.deepEqual(killed, [], 'nothing was killed to close a file');
  assert.deepEqual(
    st.state.views.map((v) => v.id),
    ['home'],
    'and the folder tab is gone',
  );
});

test('× on a tab holding a session still takes two clicks, and ends every session', async () => {
  st.setSessions([session('s1'), session('s2')]);
  draw([
    view({ id: 'home', root: { kind: 'home' }, slots: [] }),
    view({
      id: 'plain',
      root: null,
      slots: [{ kind: 'session', id: 's1' }, { kind: 'session', id: 's2' }],
    }),
  ]);
  const x = () => byKey(strip, 'tabx:plain') as FakeElement;
  assert.equal(x().title, 'End the sessions in this tab (asks to confirm)');
  x().click();
  await settle();
  assert.deepEqual(killed, [], 'the first click only arms it');
  assert.equal(x().textContent, 'sure?');
  assert.equal(x().dataset.armed, '1');
  x().click();
  await settle();
  assert.deepEqual(killed, ['s1', 's2'], 'the second ends every session in the tab');
});

test('a folder tab that still holds a session keeps the armed confirm', async () => {
  st.setSessions([session('s1')]);
  draw([
    view({ id: 'home', root: { kind: 'home' }, slots: [] }),
    view({
      id: 'proj',
      root: { kind: 'project', id: 'p1' },
      slots: [{ kind: 'file', path: 'a/one.ts' }, { kind: 'session', id: 's1' }],
    }),
  ]);
  const x = () => byKey(strip, 'tabx:proj') as FakeElement;
  x().click();
  await settle();
  assert.deepEqual(killed, [], 'a file beside a terminal does not make the × cheap');
  assert.equal(x().textContent, 'sure?');
});

test('× on a MIXED tab ends only the sessions, and the tab goes with its files', async () => {
  // Free mixing means a folder tab can hold a terminal and a file at once.
  // `killView` loops the SESSION slots and then closes the tab: a file is not
  // something that can be "ended", and the pane goes away with the tab.
  st.setSessions([session('s1'), session('s2')]);
  const mixed = view({
    id: 'mixed',
    root: { kind: 'project', id: 'p1' },
    slots: [
      { kind: 'file', path: 'web/src/main.ts' },
      { kind: 'session', id: 's1' },
      { kind: 'diff', hash: 'a1b2c3d', path: 'web/src/main.ts' },
    ],
  });
  draw([view({ id: 'home', root: { kind: 'home' }, slots: [] }), mixed]);
  killEffect = (id) => {
    mixed.slots = mixed.slots.filter((s) => s.id !== id);
  };

  const x = () => byKey(strip, 'tabx:mixed') as FakeElement;
  assert.equal(x().title, 'End the sessions in this tab (asks to confirm)', 'a session is in there');
  x().click();
  await settle();
  assert.deepEqual(killed, [], 'the first click only arms it');
  x().click();
  await settle();

  assert.deepEqual(killed, ['s1'], 'exactly the sessions — the file and the diff end nothing');
  assert.deepEqual(
    st.state.views.map((v) => v.id),
    ['home'],
    'and the tab is closed once no session is left in it',
  );
  assert.equal(st.state.views.length, 1, 'Home is what remains');
});

test('a session the server REFUSED to end keeps its tab open', async () => {
  // The one state where closing would be a lie: `killSession` came back but
  // the session is still there, so the tab still has something to show.
  st.setSessions([session('s1')]);
  draw([
    view({ id: 'home', root: { kind: 'home' }, slots: [] }),
    view({ id: 'refused', root: { kind: 'project', id: 'p1' }, slots: [{ kind: 'session', id: 's1' }] }),
  ]);
  const x = () => byKey(strip, 'tabx:refused') as FakeElement;
  x().click();
  await settle();
  x().click();
  await settle();
  assert.deepEqual(killed, ['s1']);
  assert.deepEqual(
    st.state.views.map((v) => v.id),
    ['home', 'refused'],
    'the session is still in it, so the tab stays',
  );
});

test('the same unsaved file in two tabs marks BOTH chips — the text belongs to the file', () => {
  const slot: Slot = { kind: 'file', path: 'web/src/main.ts' };
  draw([
    view({ id: 'home', root: { kind: 'home' }, slots: [slot] }),
    view({ id: 'proj', root: { kind: 'project', id: 'p1' }, slots: [{ ...slot }] }),
  ]);
  assert.equal(byClass(strip, 'tab-dirty').length, 0, 'non-vacuity: nothing is unsaved yet');

  st.state.edits.set(st.slotKey(slot), 'typed once');
  draw([
    view({ id: 'home', root: { kind: 'home' }, slots: [slot] }),
    view({ id: 'proj', root: { kind: 'project', id: 'p1' }, slots: [{ ...slot }] }),
  ]);
  assert.equal(byClass(strip, 'tab-dirty').length, 2, 'one entry in state.edits, two chips saying so');
  assert.deepEqual(
    byClass(strip, 'sr-only').map((n) => n.textContent),
    ['Unsaved changes', 'Unsaved changes'],
    'and both say it in words as well as a shape',
  );
});

test('every class the strip renders has a rule in app.css', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { projectRoot } = await import('./helpers.ts');
  const slot: Slot = { kind: 'file', path: 'web/src/main.ts' };
  st.setSessions([session('s1', { attention: true })]);
  st.state.edits.set(st.slotKey(slot), 'typed');
  draw([
    view({ id: 'home', root: { kind: 'home' }, slots: [slot] }),
    view({
      id: 'plain',
      root: null,
      slots: [{ kind: 'session', id: 's1' }, { kind: 'file', path: 'a/two.ts' }],
    }),
  ]);
  const seen = new Set<string>();
  for (const n of [strip, ...descendants(strip)]) {
    for (const c of n.className.split(/\s+/)) if (c !== '') seen.add(c);
  }
  assert.ok(seen.size >= 8, `non-vacuity: only ${seen.size} classes were collected`);
  const css = readFileSync(join(projectRoot, 'web', 'src', 'styles', 'app.css'), 'utf8');
  const missing = [...seen].filter((c) => !css.includes(`.${c}`)).sort();
  assert.deepEqual(missing, [], `classes with no rule in app.css: ${missing.join(', ')}`);
});
