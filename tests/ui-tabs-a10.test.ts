/**
 * The tab strip after Nocturne part A10, re-tabbed by A10b, driven through the
 * REAL `web/src/ui/tabs.ts` on the shared DOM double, against the REAL
 * `web/src/state.ts` and `ui/slots-model.ts`.
 *
 * A10 gave a tab three new facts to state, and every one of them is a way to
 * lie on a 32px chip:
 *
 *   1. WHAT IT IS ABOUT. `Home` is `Home`, a folder tab prints the PROJECT'S
 *      NAME and never its path (PROJECT-SCOPE, 2026-07-25), and a plain
 *      session tab still joins its panes' names — an EDITOR pane being named
 *      after the file it is SHOWING (A10b), so raising another chip inside it
 *      renames the tab with it.
 *   2. WHAT IS IN IT. The count pill counts PANES, not sessions and not file
 *      tabs (since A10b one editor pane can hold four files and is still one
 *      pane); an amber dot says a file in it is unsaved — ANY file in ANY
 *      strip, not only the ones on screen; the status dot is ABSENT when the
 *      tab holds no session at all, because a state dot there would be a
 *      readout of nothing.
 *   3. WHAT `×` COSTS. A tab holding sessions ENDS them and keeps the armed
 *      two-step; a tab holding only editor panes kills nothing and closes on
 *      one click. `Home` has no `×` and no drag handle (user decision 4).
 *
 * `killSession` and the launch dialog are INJECTED into `initTabs`, so this
 * runner never reaches @xterm/xterm.
 *
 * NOT claimed (browser work): layout, colour, the drag itself (ui/dnd.ts, and
 * `tests/ui-dnd-a10.test.ts`), and the strip INSIDE an editor pane's header
 * (`tests/ui-editor-pane.test.ts`).
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { byClass, byKey, descendants, installDom, type FakeElement } from './fake-dom.ts';

const dom = installDom();

type EditorTab = { kind: 'file'; path: string } | { kind: 'diff'; hash: string; path: string };
type Slot =
  | { kind: 'session'; id: string }
  | { kind: 'editor'; id: string; tabs: EditorTab[]; active: number };

const file = (path: string): EditorTab => ({ kind: 'file', path });
const diff = (hash: string, path: string): EditorTab => ({ kind: 'diff', hash, path });

/**
 * ONE editor pane holding `tabs`. The id is the pane's own `e:<n>` — never
 * derived from a tab (TAB ID ≠ SLOT KEY, A10b), so these fixtures cannot
 * accidentally make the strip read like the A10 one-file-per-pane world.
 */
let editorSeq = 0;
function editor(tabs: EditorTab[], active = 0): Slot {
  editorSeq += 1;
  return { kind: 'editor', id: `e:t${editorSeq}`, tabs, active };
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
  /** The `state.edits` key of a file — the TAB's id, never the pane's. */
  editorFileId(path: string): string;
  /** Forget the unsaved text and hand it back (since B4 the disk write is the
   * file pane's, once its PUT has landed); returns it, or null. */
  saveEdit(id: string): string | null;
}
interface TabsModule {
  initTabs(
    strip: unknown,
    deps: { killSession(id: string): void; openLaunch(): void },
  ): { render(): void };
  tabLabel(v: View): string;
  tabMarkSig(m: { kind: 'folder' } | { kind: 'tool'; id: string } | { kind: 'file'; icon: { icon: string; kind: string } } | null): string;
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
    view({ id: 'home', root: { kind: 'home' }, slots: [editor([file('web/src/main.ts')])] }),
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

test('an editor pane is named on the chip by the tab it is SHOWING, and nothing else', () => {
  // A10b: the strip inside the pane decides the name outside it. A chip that
  // named the FIRST tab would go stale the moment the user raised another
  // file, and a chip that joined all of them would print a path's worth of
  // words on a 32px surface.
  const pane = editor([file('web/src/ui/panes.ts'), file('web/src/state.ts')], 1);
  draw([view({ id: 'plain', root: null, slots: [pane] })]);
  assert.deepEqual(
    byClass(strip, 'tab-label').map((n) => n.textContent),
    ['state.ts'],
  );
  // Raise the other chip: the tab is renamed with it, and the strip really
  // redraws (the signature carries the label).
  (pane as { active: number }).active = 0;
  tabs.render();
  assert.deepEqual(
    byClass(strip, 'tab-label').map((n) => n.textContent),
    ['panes.ts'],
  );
  // A read-only diff is named after its commit, the A6 wording.
  const dv = editor([diff('a1b2c3d', 'web/src/main.ts')]);
  draw([view({ id: 'plain2', root: null, slots: [dv] })]);
  assert.deepEqual(
    byClass(strip, 'tab-label').map((n) => n.textContent),
    ['Changes in a1b2c3d'],
  );
  // And no path ever reaches the strip.
  assert.equal(strip.textContent.includes('web/src'), false);
});

test('the count pill counts PANES — four files in ONE strip are ONE pane', () => {
  // A10b, user decision 4: the pill keeps counting panes. Counting tabs would
  // say "4" for a tab that shows a single editor pane, which is a readout of
  // something the user cannot see on screen.
  st.setSessions([session('s1')]);
  draw([
    view({
      id: 'home',
      root: { kind: 'home' },
      slots: [
        editor([
          file('a/one.ts'),
          file('a/two.ts'),
          diff('a1b2c3d', 'a/two.ts'),
          file('a/three.ts'),
        ]),
      ],
    }),
  ]);
  assert.equal(byClass(strip, 'tab-count').length, 0, 'one pane needs no pill at all');

  draw([
    view({
      id: 'home',
      root: { kind: 'home' },
      slots: [
        editor([file('a/one.ts'), file('a/two.ts')]),
        editor([file('a/three.ts')]),
        { kind: 'session', id: 's1' },
      ],
    }),
  ]);
  const pill = byClass(strip, 'tab-count')[0] as FakeElement;
  assert.equal(pill.textContent, '3', 'two editor panes and a terminal are three panes');
  assert.equal(pill.title, '3 panes in this tab');
});

test('no session in the tab, no status dot — a dot there would report on nothing', () => {
  draw([view({ id: 'home', root: { kind: 'home' }, slots: [editor([file('a/one.ts')])] })]);
  assert.equal(byClass(strip, 'dot').length, 0, 'a file has no state to report');

  st.setSessions([session('s1')]);
  draw([view({ id: 'plain', root: null, slots: [{ kind: 'session', id: 's1' }] })]);
  const dots = byClass(strip, 'dot');
  assert.equal(dots.length, 1);
  assert.ok((dots[0] as FakeElement).classList.contains('is-run'), 'a running session is green');
});

test('B11: the tab dot follows the readout — pulsing green working, still amber waiting; the pill stays BEL-only', () => {
  st.setSessions([session('s1', { turn: 'working' })]);
  draw([view({ id: 'work', root: null, slots: [{ kind: 'session', id: 's1' }] })]);
  assert.ok((byClass(strip, 'dot')[0] as FakeElement).classList.contains('is-work'), 'working pulses green');
  assert.equal(byClass(strip, 'tab-attn').length, 0);

  st.setSessions([session('s1', { turn: 'waiting' })]);
  draw([view({ id: 'wait', root: null, slots: [{ kind: 'session', id: 's1' }] })]);
  assert.ok((byClass(strip, 'dot')[0] as FakeElement).classList.contains('is-wait'), 'waiting is amber, still');
  assert.equal(byClass(strip, 'tab-attn').length, 0, 'an ended turn is not a question: no Needs you pill');

  st.setSessions([session('s1', { turn: 'waiting', attention: true })]);
  draw([view({ id: 'bel', root: null, slots: [{ kind: 'session', id: 's1' }] })]);
  assert.ok((byClass(strip, 'dot')[0] as FakeElement).classList.contains('is-attn'), 'a BEL wins');
  assert.equal(byClass(strip, 'tab-attn').length, 1, 'and only a BEL brings the pill');
});

test('an unsaved file puts the amber mark on the chip, in words as well as a shape', () => {
  // The dirty file is the tab that is NOT on screen: `viewDirty` walks every
  // TAB of every editor pane, because a file two chips deep is as unsaved as
  // the one being looked at — and this chip is the only place that says so
  // from another tab.
  const pane = editor([file('web/src/main.ts'), file('web/src/state.ts')], 1);
  draw([view({ id: 'home', root: { kind: 'home' }, slots: [pane] })]);
  assert.equal(byClass(strip, 'tab-dirty').length, 0, 'a clean file wears no mark');

  st.state.edits.set(st.editorFileId('web/src/main.ts'), 'typed');
  draw([view({ id: 'home', root: { kind: 'home' }, slots: [pane] })]);
  assert.equal(byClass(strip, 'tab-dirty').length, 1);
  assert.deepEqual(
    byClass(strip, 'sr-only').map((n) => n.textContent),
    ['Unsaved changes'],
    'the dot is a shape; the state is also in words',
  );
  // And the key it reads is the TAB's id, never the pane's `e:<n>`.
  st.state.edits = new Map([[st.slotKey(pane), 'typed under the PANE key']]);
  draw([view({ id: 'home', root: { kind: 'home' }, slots: [pane] })]);
  assert.equal(byClass(strip, 'tab-dirty').length, 0, 'a pane key is not an edits key');
});

test('Save on the ONLY unsaved tab takes the amber mark off the chip again', () => {
  // `viewDirty` is a question about the TABS, asked on every render: the mark
  // has to come off the moment the text is written, or a saved file keeps
  // claiming it is unsaved until something else redraws the strip.
  const PATH = 'web/src/state.ts';
  const pane = editor([file('web/src/main.ts'), file(PATH)], 1);
  const views = (): View[] => [view({ id: 'home', root: { kind: 'home' }, slots: [pane] })];
  st.state.edits.set(st.editorFileId(PATH), 'typed');
  draw(views());
  assert.equal(byClass(strip, 'tab-dirty').length, 1, 'non-vacuity: the mark is up');

  assert.equal(st.saveEdit(st.editorFileId(PATH)), 'typed', 'the text was written');
  draw(views());
  assert.equal(byClass(strip, 'tab-dirty').length, 0, 'and the chip stops claiming otherwise');
  assert.deepEqual(byClass(strip, 'sr-only').map((n) => n.textContent), [],
    'in words as well: nothing says "Unsaved changes" any more');
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
      slots: [editor([file('web/src/main.ts'), diff('a1b2c3d', 'web/src/main.ts')])],
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
      slots: [editor([file('a/one.ts')]), { kind: 'session', id: 's1' }],
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
      editor([file('web/src/main.ts'), diff('a1b2c3d', 'web/src/main.ts')]),
      { kind: 'session', id: 's1' },
    ],
  });
  draw([view({ id: 'home', root: { kind: 'home' }, slots: [] }), mixed]);
  killEffect = (id) => {
    mixed.slots = mixed.slots.filter((s) => !(s.kind === 'session' && s.id === id));
  };

  const x = () => byKey(strip, 'tabx:mixed') as FakeElement;
  assert.equal(x().title, 'End the sessions in this tab (asks to confirm)', 'a session is in there');
  x().click();
  await settle();
  assert.deepEqual(killed, [], 'the first click only arms it');
  x().click();
  await settle();

  assert.deepEqual(killed, ['s1'], 'exactly the sessions — the editor pane ends nothing');
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
  const PATH = 'web/src/main.ts';
  const both = (): View[] => [
    view({ id: 'home', root: { kind: 'home' }, slots: [editor([file(PATH)])] }),
    view({ id: 'proj', root: { kind: 'project', id: 'p1' }, slots: [editor([file(PATH)])] }),
  ];
  draw(both());
  assert.equal(byClass(strip, 'tab-dirty').length, 0, 'non-vacuity: nothing is unsaved yet');

  st.state.edits.set(st.editorFileId(PATH), 'typed once');
  draw(both());
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
  st.setSessions([session('s1', { attention: true })]);
  st.state.edits.set(st.editorFileId('web/src/main.ts'), 'typed');
  draw([
    view({ id: 'home', root: { kind: 'home' }, slots: [editor([file('web/src/main.ts')])] }),
    view({
      id: 'plain',
      root: null,
      slots: [{ kind: 'session', id: 's1' }, editor([file('a/two.ts')])],
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

// ---------------------------------------------------------------------------
// B6 — `Confirm before ending a session` on the tab strip's ×
//
// The toggle is read at CLICK time, so a flip in Settings applies to the strip
// that is already on screen. It moves ONE question: the armed two-step about
// ending sessions. The B4 unsaved question is about dropping typed text and
// stands in both modes — the two are never merged.
// ---------------------------------------------------------------------------

const P = (await import(new URL('../web/src/ui/prefs-model.ts', import.meta.url).href)) as {
  setBehaviour(next: { confirmEnd?: boolean }): void;
};

/** Run `fn` with the confirm switched off, then put the factory setting back. */
async function withConfirmOff(fn: () => Promise<void>): Promise<void> {
  P.setBehaviour({ confirmEnd: false });
  try {
    await fn();
  } finally {
    P.setBehaviour({});
  }
}

test('B6: confirm OFF — one click on × ends every session in the tab', async () => {
  await withConfirmOff(async () => {
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
    assert.equal(x().title, 'End the sessions in this tab', 'and the tooltip promises no question');
    x().click();
    await settle();
    assert.deepEqual(killed, ['s1', 's2'], 'the first click is the act');
  });
});

test('B6: the switch is read at CLICK time — a flip reaches the strip already drawn', async () => {
  st.setSessions([session('s1')]);
  draw([
    view({ id: 'home', root: { kind: 'home' }, slots: [] }),
    view({ id: 'plain', root: null, slots: [{ kind: 'session', id: 's1' }] }),
  ]);
  const x = () => byKey(strip, 'tabx:plain') as FakeElement;
  await withConfirmOff(async () => {
    x().click();
    await settle();
    assert.deepEqual(killed, ['s1'], 'no re-render was needed for the new answer to count');
  });
});

test('B6: confirm OFF leaves the B4 unsaved question standing — two questions, never merged', async () => {
  await withConfirmOff(async () => {
    st.setSessions([session('s1')]);
    st.state.edits.set(st.editorFileId('web/src/main.ts'), 'typed');
    draw([
      view({ id: 'home', root: { kind: 'home' }, slots: [] }),
      view({
        id: 'mixed',
        root: { kind: 'project', id: 'p1' },
        slots: [editor([file('web/src/main.ts')]), { kind: 'session', id: 's1' }],
      }),
    ]);
    (byKey(strip, 'tabx:mixed') as FakeElement).click();
    await settle();
    assert.deepEqual(killed, [], 'nothing is ended while the text question is unanswered');
    const card = byClass(dom.body, 'ud-modal');
    assert.equal(card.length, 1, 'the B4 card is up');
    const discard = descendants(card[0] as FakeElement).find((n) => n.textContent === 'Discard');
    (discard as FakeElement).click();
    await settle();
    assert.deepEqual(killed, ['s1'], 'and only after Discard does the session end');
  });
});

test('B6: confirm ON is still the armed two-step (the factory setting is unchanged)', async () => {
  st.setSessions([session('s1')]);
  draw([
    view({ id: 'home', root: { kind: 'home' }, slots: [] }),
    view({ id: 'plain', root: null, slots: [{ kind: 'session', id: 's1' }] }),
  ]);
  const x = () => byKey(strip, 'tabx:plain') as FakeElement;
  x().click();
  await settle();
  assert.deepEqual(killed, []);
  assert.equal(x().textContent, 'sure?');
  x().click();
  await settle();
  assert.deepEqual(killed, ['s1']);
});

// ---------------------------------------------------------------------------
// Part B12 — the first pane's icon beside the dot
// ---------------------------------------------------------------------------

/** What each chip wears before its label: `t:<tool>`, `f:<icon>`, or `-`. */
const marks = (): string[] =>
  chips().map((c) => {
    const svg = descendants(c).find((n) => n.tagName.toLowerCase() === 'svg');
    if (svg === undefined) return '-';
    if (svg.classList.contains('tab-folder')) return 'folder';
    const tool = svg.getAttribute('data-tool');
    return tool !== null ? `t:${tool}` : `f:${svg.getAttribute('data-icon') ?? '?'}`;
  });

test('B12: a tab wears its FIRST pane’s icon — a session its tool, an editor its active file, a diff git; a folder tab its folder', () => {
  st.setSessions([
    session('s1'),
    session('s2', { command: 'codex' }),
    session('s3', { command: '/bin/bash' }),
    session('s4', { command: 'htop' }),
  ]);
  draw([
    view({ id: 'home', root: { kind: 'home' } }),
    view({ id: 'a', slots: [{ kind: 'session', id: 's1' }] }),
    view({ id: 'b', slots: [{ kind: 'session', id: 's2' }, { kind: 'session', id: 's1' }] }),
    view({ id: 'c', slots: [{ kind: 'session', id: 's3' }] }),
    view({ id: 'd', slots: [{ kind: 'session', id: 's4' }] }),
    view({ id: 'e', slots: [editor([file('/p/web/main.ts'), file('/p/README.md')], 1), { kind: 'session', id: 's1' }] }),
    view({ id: 'f', slots: [editor([diff('a'.repeat(40), 'web/x.ts')])] }),
    view({ id: 'g', slots: [{ kind: 'session', id: 'unknown' }] }),
  ]);
  assert.deepEqual(marks(), [
    'folder', // Home is a folder, whatever it holds
    't:claude',
    't:codex', // the FIRST slot's, not the second's
    't:terminal',
    't:command', // a custom command: the command mark, never a guess
    'f:book-open', // the ACTIVE file of the first pane (README.md)
    'f:git',
    '-', // a session the browser has not heard of yet
  ]);
  // Decorative, and ADDED — the status dot is still there, before it.
  for (const c of chips()) {
    const svg = descendants(c).find((n) => n.tagName.toLowerCase() === 'svg');
    if (svg !== undefined) assert.equal(svg.getAttribute('aria-hidden'), 'true');
  }
  const sel = byClass(chips()[1] as FakeElement, 'tab-sel')[0] as FakeElement;
  const kids = sel.children as FakeElement[];
  assert.ok(kids[0]?.classList.contains('dot'), 'the dot stays first');
  assert.equal(kids[1]?.getAttribute('data-tool'), 'claude', 'the icon follows it');
  assert.ok(kids[2]?.classList.contains('tab-label'), 'then the name');
});

test('B12: raising another file in the first pane redraws the tab’s icon (it is in the signature)', () => {
  const pane = editor([file('/p/a.py'), file('/p/b.rs')], 0);
  // A plain tab: it is named after the file, so it wears the file's icon.
  st.state.views = [view({ id: 'x', root: null, slots: [pane] })];
  st.state.activeViewId = 'x';
  strip.replaceChildren();
  tabs.render();
  assert.deepEqual(marks(), ['f:python']);
  (pane as { active: number }).active = 1;
  tabs.render(); // NOT from scratch: the guard must see the change
  assert.deepEqual(marks(), ['f:rust']);
});

/**
 * View `x`'s chip icon as `icon/kind` (a file) or `tool` — what it DRAWS,
 * colour included. By key, not position: `setSessions` reconciles the views
 * and puts a Home tab in front.
 */
const firstMark = (): string => {
  const sel = byKey(strip, 'tab:x') as FakeElement | null;
  assert.ok(sel !== null, 'view x has a chip');
  const svg = descendants(sel).find((n) => n.tagName.toLowerCase() === 'svg');
  if (svg === undefined) return '-';
  return svg.getAttribute('data-tool') ?? `${svg.getAttribute('data-icon')}/${svg.getAttribute('data-kind')}`;
};

test('B12: a session the browser hears about LATE gets its mark on the next render (no rebuild from scratch)', () => {
  // A plain session tab (a folder tab wears its folder, not a tool).
  st.state.views = [view({ id: 'x', root: null, slots: [{ kind: 'session', id: 's9' }] })];
  st.state.activeViewId = 'x';
  strip.replaceChildren();
  tabs.render();
  assert.equal(firstMark(), '-', 'not known yet: no guess');
  st.setSessions([session('s9', { command: 'grok', projectId: 'p1' })]);
  tabs.render();
  assert.equal(firstMark(), 'grok', 'the list arrived: the mark follows');
});

test('B12: a known session whose COMMAND changes redraws the tab’s mark (the mark alone is in the signature)', () => {
  st.setSessions([session('s1', { command: 'codex', projectId: 'p1' })]);
  st.state.views = [view({ id: 'x', root: null, slots: [{ kind: 'session', id: 's1' }] })];
  st.state.activeViewId = 'x';
  strip.replaceChildren();
  tabs.render();
  assert.equal(firstMark(), 'codex');
  // Same id, same title, same status — only what runs differs.
  st.setSessions([session('s1', { command: '/bin/bash', projectId: 'p1' })]);
  tabs.render();
  assert.equal(firstMark(), 'terminal');
});

test('B12: raising a file with the SAME glyph but another colour family recolours the tab’s icon', () => {
  // `.bashrc` and `nginx.conf` share the gear glyph but not the colour: the
  // shell family vs. the config family (files-model.ts SHELL_CONFIG / CONFIG).
  // The signature itself first: the same glyph in another family is another
  // signature. (On screen a file-named tab's LABEL changes with the file too,
  // so the chip alone cannot pin the colour part — the fragment can.)
  const gear = (kind: string) => T.tabMarkSig({ kind: 'file', icon: { icon: 'gear-six', kind } });
  assert.notEqual(gear('sh'), gear('config'));
  assert.notEqual(T.tabMarkSig({ kind: 'folder' }), T.tabMarkSig(null));
  const pane = editor([file('/p/.bashrc'), file('/p/nginx.conf')], 0);
  st.state.views = [view({ id: 'x', root: null, slots: [pane] })];
  st.state.activeViewId = 'x';
  strip.replaceChildren();
  tabs.render();
  assert.equal(firstMark(), 'gear-six/sh');
  (pane as { active: number }).active = 1;
  tabs.render(); // NOT from scratch
  assert.equal(firstMark(), 'gear-six/config', 'the colour is part of what the tab shows');
});

test('B12: a FOLDER tab wears the folder glyph — never its active file’s logo, never a tool', () => {
  st.setSessions([session('s1', { projectId: 'p1' })]);
  draw([
    view({ id: 'home', root: { kind: 'home' }, slots: [editor([file('/home/tester/Dockerfile')])] }),
    view({ id: 'proj', root: { kind: 'project', id: 'p1' }, slots: [editor([file('/home/tester/api/main.py')])] }),
    view({ id: 'psess', root: { kind: 'project', id: 'p1' }, slots: [{ kind: 'session', id: 's1' }] }),
    view({ id: 'empty', root: { kind: 'home' }, slots: [] }),
  ]);
  assert.deepEqual(marks(), ['folder', 'folder', 'folder', 'folder']);
  for (const c of chips()) {
    const svg = descendants(c).find((n) => n.tagName.toLowerCase() === 'svg') as FakeElement;
    assert.equal(svg.getAttribute('aria-hidden'), 'true');
    assert.equal(svg.getAttribute('width'), '13');
  }
});

test('B12: the tab mark adds no text — the tab’s name reads exactly as before', () => {
  st.setSessions([session('s1', { title: 'api work' }), session('s2', { command: 'htop', title: 'top' })]);
  draw([
    view({ id: 'a', slots: [{ kind: 'session', id: 's1' }] }),
    view({ id: 'b', root: { kind: 'project', id: 'p1' }, slots: [editor([file('/p/main.py')])] }),
    view({ id: 'c', slots: [{ kind: 'session', id: 's2' }] }),
  ]);
  for (const c of chips()) {
    const sel = byClass(c, 'tab-sel')[0] as FakeElement;
    const svgs = descendants(sel).filter((n) => n.tagName.toLowerCase() === 'svg');
    assert.equal(svgs.length, 1, 'one mark per tab');
    for (const s of svgs) {
      assert.equal(s.textContent, '', 'no glyph text');
      assert.equal(s.getAttribute('aria-hidden'), 'true');
      assert.equal(descendants(s).some((n) => n.tagName.toLowerCase() === 'title'), false, 'no <title> to be read out');
    }
    assert.equal(sel.getAttribute('aria-label'), null, 'the name is still the chip’s own text, no label added over it');
  }
  assert.deepEqual(
    chips().map((c) => (byClass(c, 'tab-label')[0] as FakeElement).textContent),
    [T.tabLabel(st.state.views[0] as View), T.tabLabel(st.state.views[1] as View), T.tabLabel(st.state.views[2] as View)],
  );
});
