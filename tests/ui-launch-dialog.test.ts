/**
 * `web/src/ui/launch.ts` — the New session dialog (Nocturne A4), driven like a
 * user through the REAL module: cards clicked, selects picked by their visible
 * words, keys pressed, and the `POST /api/sessions` body captured at the api
 * boundary. The contract it guards is the one A4 promised: every dialog state
 * that existed before A4 still sends byte-for-byte the argv it sent then, the
 * inert cards launch nothing, and the new pieces (info popover, Start from,
 * card keyboard) behave as specified.
 *
 * WHY A HARNESS HERE. `tests/ui-launch-args.test.ts` pins `composeSpawn`, but
 * the A4 risk sits one layer up: the selects now show LABELS (`Opus`,
 * `Extra high`, `The last conversation in this project`) over VALUES (`opus`,
 * `xhigh`, `continue`). One swapped `opt.value = label` and the dialog sends
 * `--model Opus`, or silently drops `--effort` / `--continue`, while every
 * pure-function test stays green. Only the plumbing can show that.
 *
 * HOW IT RUNS WITHOUT A BROWSER OR A DEPENDENCY.
 *   - `module.registerHooks` swaps exactly four of launch.ts's imports for
 *     stubs: `../api.ts` (records the POST, answers `fsList`), `../state.ts`
 *     (a projects list the test owns), `../log.ts` (records lines) and
 *     `./panes.ts` (whose import graph reaches @xterm/xterm, a browser
 *     bundle). `./util.ts` (el, button, trapTab), `./icons.ts` and
 *     `./launch-args.ts` are the REAL modules.
 *   - A small DOM double below: elements, attributes, a real
 *     capture/target/bubble event dispatch with stopPropagation, focus with
 *     `focusin`, `hidden`/`disabled`, select/option value semantics as the
 *     HTML spec has them (setting a value no option carries selects nothing).
 *   - `main.ts`'s own Escape handling is emulated by a bubbling `window`
 *     keydown listener that closes the dialog — the same shape and priority as
 *     main.ts:525-551 — so the popover's capture-phase Esc can be proven to
 *     stop the event before it.
 *
 * NOT claimed (stays with `.claude/skills/verify-terminal/SKILL.md` and the
 * browser): layout, CSS (including whether a hidden control is really
 * invisible), real pointer hit-testing, screen-reader output.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import {
  EFFORTS,
  EFFORT_LABEL,
  MODELS,
  MODEL_LABEL,
  NOT_INSTALLED,
  PERMS,
  PERM_HELP,
  PERM_SHORT,
  SHELL_CARDS,
  START_FROM,
  TOOL_CARDS,
  TOOLS,
  GROK_PERM_HINT,
} from '../web/src/ui/launch-args.ts';
import type { ToolAvailability, KeyStatus, HistoryEntry } from '../shared/protocol.ts';
// The prefs model is pure and DOM-free (no stub needed): the same module
// instance the dialog reads `getHiddenTools()` from on every open.
import { initHiddenTools } from '../web/src/ui/prefs-model.ts';

// ===========================================================================
// DOM double
// ===========================================================================

interface FakeEvent {
  type: string;
  key: string;
  shiftKey: boolean;
  target: FakeNode | null;
  defaultPrevented: boolean;
  cancelBubble: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}

type Handler = (e: FakeEvent) => void;

class FakeTarget {
  readonly handlers: { type: string; fn: Handler; capture: boolean }[] = [];
  addEventListener(type: string, fn: Handler, opts?: boolean | { capture?: boolean }): void {
    const capture = typeof opts === 'boolean' ? opts : opts?.capture === true;
    this.handlers.push({ type, fn, capture });
  }
  removeEventListener(): void {}
}

class FakeNode extends FakeTarget {
  parentNode: FakeElement | null = null;
  get textContent(): string {
    return '';
  }
}

class FakeText extends FakeNode {
  readonly data: string;
  constructor(data: string) {
    super();
    this.data = data;
  }
  override get textContent(): string {
    return this.data;
  }
}

const FOCUSABLE_TAGS = new Set(['BUTTON', 'INPUT', 'SELECT']);

class FakeElement extends FakeNode {
  readonly tagName: string;
  children: FakeNode[] = [];
  className = '';
  readonly attrs = new Map<string, string>();
  hidden = false;
  disabled = false;
  id = '';
  name = '';
  type = '';
  placeholder = '';
  spellcheck = true;
  selectedIndex = -1;
  #tabIndex: number | null = null;
  #value: string | null = null;

  constructor(tag: string) {
    super();
    this.tagName = tag.toUpperCase();
  }

  // ---- tree ---------------------------------------------------------------
  append(...nodes: (FakeNode | string)[]): void {
    for (const n of nodes) {
      const node = typeof n === 'string' ? new FakeText(n) : n;
      node.parentNode = this;
      this.children.push(node);
      if (this.tagName === 'SELECT' && node instanceof FakeElement && node.tagName === 'OPTION') {
        if (this.selectedIndex === -1) this.selectedIndex = 0; // a size-1 select shows its first option
      }
    }
  }
  replaceChildren(...nodes: (FakeNode | string)[]): void {
    for (const c of this.children) c.parentNode = null;
    this.children = [];
    if (this.tagName === 'SELECT') this.selectedIndex = -1;
    this.append(...nodes);
  }
  contains(n: unknown): boolean {
    let x = n instanceof FakeNode ? n : null;
    while (x !== null) {
      if (x === this) return true;
      x = x.parentNode;
    }
    return false;
  }
  get isConnected(): boolean {
    let x: FakeElement | null = this;
    while (x.parentNode !== null) x = x.parentNode;
    return x === body;
  }
  /** Rendered = connected and nothing on the way up is `hidden`. */
  get rendered(): boolean {
    if (!this.isConnected) return false;
    let x: FakeElement | null = this;
    while (x !== null) {
      if (x.hidden) return false;
      x = x.parentNode;
    }
    return true;
  }
  get offsetParent(): unknown {
    return this.rendered ? body : null;
  }
  override get textContent(): string {
    return this.children.map((c) => c.textContent).join('');
  }
  override set textContent(v: string) {
    this.replaceChildren(...(v === '' ? [] : [v]));
  }

  // ---- attributes ---------------------------------------------------------
  setAttribute(k: string, v: string): void {
    this.attrs.set(k, v);
    if (k === 'tabindex') this.#tabIndex = Number(v);
  }
  getAttribute(k: string): string | null {
    return this.attrs.get(k) ?? null;
  }
  hasAttribute(k: string): boolean {
    return this.attrs.has(k);
  }
  removeAttribute(k: string): void {
    this.attrs.delete(k);
  }
  get classList(): {
    add(c: string): void;
    remove(c: string): void;
    toggle(c: string, force?: boolean): boolean;
    contains(c: string): boolean;
  } {
    const list = (): string[] => this.className.split(/\s+/).filter((c) => c !== '');
    const set = (xs: string[]): void => {
      this.className = xs.join(' ');
    };
    return {
      add: (c) => set([...new Set([...list(), c])]),
      remove: (c) => set(list().filter((x) => x !== c)),
      toggle: (c, force) => {
        const on = force ?? !list().includes(c);
        set(on ? [...new Set([...list(), c])] : list().filter((x) => x !== c));
        return on;
      },
      contains: (c) => list().includes(c),
    };
  }
  get tabIndex(): number {
    return this.#tabIndex ?? (FOCUSABLE_TAGS.has(this.tagName) ? 0 : -1);
  }
  set tabIndex(v: number) {
    this.#tabIndex = v;
    this.attrs.set('tabindex', String(v));
  }

  // ---- form values --------------------------------------------------------
  get options(): FakeElement[] {
    return this.children.filter((c): c is FakeElement => c instanceof FakeElement && c.tagName === 'OPTION');
  }
  get value(): string {
    if (this.tagName === 'SELECT') return this.options[this.selectedIndex]?.value ?? '';
    if (this.tagName === 'OPTION') return this.#value ?? this.textContent;
    return this.#value ?? '';
  }
  set value(v: string) {
    if (this.tagName === 'SELECT') this.selectedIndex = this.options.findIndex((o) => o.value === v);
    else this.#value = v;
  }

  // ---- behaviour ----------------------------------------------------------
  focus(): void {
    if (this.disabled || !this.rendered) return;
    doc.activeElement = this;
    dispatch(this, 'focusin');
  }
  querySelectorAll(sel: string): FakeElement[] {
    // Only the ONE selector the dialog's focus trap asks (web/src/ui/util.ts
    // trapTab). Anything else is a harness gap and must fail loudly.
    assert.equal(
      sel,
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      'harness only implements the trapTab selector',
    );
    return descendants(this).filter(
      (n) =>
        (FOCUSABLE_TAGS.has(n.tagName) && !n.disabled) ||
        (n.hasAttribute('tabindex') && n.getAttribute('tabindex') !== '-1'),
    );
  }
}

function descendants(root: FakeElement): FakeElement[] {
  const out: FakeElement[] = [];
  for (const c of root.children) {
    if (c instanceof FakeElement) out.push(c, ...descendants(c));
  }
  return out;
}

const win = new FakeTarget();
const body = new FakeElement('body');
const doc = Object.assign(new FakeTarget(), {
  body,
  activeElement: body as FakeElement,
  createElement: (tag: string) => new FakeElement(tag),
  createElementNS: (_ns: string, tag: string) => new FakeElement(tag),
});

/** Capture (window -> target's parent), target, bubble (parent -> window). */
function dispatch(target: FakeElement, type: string, init: { key?: string; shiftKey?: boolean } = {}): FakeEvent {
  const e: FakeEvent = {
    type,
    key: init.key ?? '',
    shiftKey: init.shiftKey ?? false,
    target,
    defaultPrevented: false,
    cancelBubble: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {
      this.cancelBubble = true;
    },
  };
  const ancestors: FakeTarget[] = [];
  for (let x = target.parentNode; x !== null; x = x.parentNode) ancestors.push(x);
  ancestors.push(doc, win);
  const run = (node: FakeTarget, phase: 'capture' | 'target' | 'bubble'): void => {
    for (const h of [...node.handlers]) {
      if (h.type !== type) continue;
      if (phase === 'capture' && !h.capture) continue;
      if (phase === 'bubble' && h.capture) continue;
      h.fn(e);
    }
  };
  for (const node of [...ancestors].reverse()) {
    run(node, 'capture');
    if (e.cancelBubble) return e;
  }
  run(target, 'target');
  if (e.cancelBubble) return e;
  for (const node of ancestors) {
    run(node, 'bubble');
    if (e.cancelBubble) return e;
  }
  return e;
}

const g = globalThis as Record<string, unknown>;
g.document = doc;
g.window = win;
g.Node = FakeNode;
g.HTMLElement = FakeElement;

// ===========================================================================
// Module stubs for launch.ts's four non-pure imports
// ===========================================================================

interface Project {
  id: string;
  name: string;
  path: string;
  defaultModel?: string;
  defaultMode?: string;
  createdAt: string;
}

interface Harness {
  projects: Project[];
  posts: Record<string, unknown>[];
  /** What the next createSession does; default: succeed. */
  nextPost: (() => Promise<unknown>) | null;
  fsListCalls: number;
  logs: string[];
  terminalFocusRequests: number;
  drawers: string[];
  upserted: string[];
  subscribers: ((kind: string) => void)[];
  /** GET /api/tools. Default = exactly what the dialog ASSUMES before an answer,
   *  so a test that does not care about availability sees one stable world. */
  tools: ToolAvailability;
  /** GET /api/keys. */
  keys: KeyStatus;
  /** GET /api/history. */
  history: HistoryEntry[];
  toolCalls: number;
  keyCalls: number;
  historyCalls: number;
  /** When true the next GET /api/tools fails (the dialog must keep what it knew). */
  toolsFail: boolean;
  /** When true GET /api/keys never answers: the "unknown" state, held open. */
  keysHang: boolean;
  /** What `openSettings()` was called with, in order. */
  settingsOpens: { page?: string; focusKey?: string }[];
}

const H: Harness = {
  projects: [],
  posts: [],
  nextPost: null,
  fsListCalls: 0,
  logs: [],
  terminalFocusRequests: 0,
  drawers: [],
  upserted: [],
  subscribers: [],
  tools: { claude: true, codex: false, gemini: false, grok: false, zsh: false, cmd: false, powershell: true },
  keys: { saved: { claude: false, gemini: false, grok: false }, env: { claude: false, gemini: false, grok: false } },
  history: [],
  toolCalls: 0,
  keyCalls: 0,
  historyCalls: 0,
  toolsFail: false,
  keysHang: false,
  settingsOpens: [],
};
g.__launchHarness = H;

const STUB_SRC: Record<string, string> = {
  api: `
    const H = globalThis.__launchHarness;
    export async function fsList() { H.fsListCalls++; return { path: '/home/tester', entries: [] }; }
    export async function createSession(body) {
      H.posts.push(JSON.parse(JSON.stringify(body)));
      if (H.nextPost !== null) { const f = H.nextPost; H.nextPost = null; return f(); }
      return { id: 'sess-' + H.posts.length, ...body };
    }
    export async function getTools() {
      H.toolCalls++;
      if (H.toolsFail) throw new Error('network error');
      return H.tools;
    }
    export async function getKeys() {
      H.keyCalls++;
      if (H.keysHang) await new Promise(() => {});
      return H.keys;
    }
    export async function getHistory() { H.historyCalls++; return H.history; }`,
  state: `
    const H = globalThis.__launchHarness;
    export const state = { get projects() { return H.projects; } };
    export function subscribe(fn) { H.subscribers.push(fn); }
    export function openDrawer(k) { H.drawers.push(k); }
    export function upsertSession(info) { H.upserted.push(info.id); }
    export function focusSession() {}`,
  log: `
    const H = globalThis.__launchHarness;
    const rec = (lvl) => (m) => { H.logs.push(lvl + ' ' + m); };
    export const log = { debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') };`,
  panes: `
    const H = globalThis.__launchHarness;
    export function focusedPaneDims() { return { cols: 120, rows: 40 }; }
    export function requestTerminalFocus() { H.terminalFocusRequests++; }`,
  // Stubbed WHOLE: ui/settings.ts reaches ui/update.ts -> @xterm/xterm, a
  // browser bundle that cannot be imported under node:test. What launch.ts uses
  // of it is one function, and this records every hand-off.
  settings: `
    const H = globalThis.__launchHarness;
    export function openSettings(opts) { H.settingsOpens.push(opts ?? {}); }`,
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    // The query strips off: a test that needs a FRESH dialog instance imports
    // launch.ts with a cache-busting `?…`, and its imports must still be stubbed.
    if ((context.parentURL ?? '').replace(/\?.*$/, '').endsWith('/web/src/ui/launch.ts')) {
      const m = /^(?:\.\.\/(api|state|log)|\.\/(panes|settings))\.ts$/.exec(specifier);
      const name = m?.[1] ?? m?.[2];
      if (name !== undefined) return { url: `launch-stub:${name}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith('launch-stub:')) {
      return { format: 'module', source: STUB_SRC[url.slice('launch-stub:'.length)], shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

interface LaunchModule {
  initLaunchDialog(host: unknown): void;
  openLaunchDialog(opts?: { projectId?: string }): void;
  closeLaunchDialog(): void;
  isLaunchDialogOpen(): boolean;
}

// A computed specifier: the typechecker must not walk launch.ts's browser
// import graph under the server tsconfig (web/tsconfig.json owns that).
const launchUrl = new URL('../web/src/ui/launch.ts', import.meta.url).href;
const L = (await import(launchUrl)) as LaunchModule;

const modalHost = new FakeElement('div');
body.append(modalHost);
L.initLaunchDialog(modalHost);

/** main.ts:525-551 in miniature: a BUBBLING window listener that closes the dialog on Esc. */
let mainSawEscape = 0;
win.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  mainSawEscape++;
  if (L.isLaunchDialogOpen()) {
    e.preventDefault();
    L.closeLaunchDialog();
  }
});

// ===========================================================================
// Finders and user gestures
// ===========================================================================

const all = (): FakeElement[] => descendants(modalHost);
const one = (what: string, pred: (n: FakeElement) => boolean): FakeElement => {
  const hits = all().filter(pred);
  assert.equal(hits.length, 1, `expected exactly one ${what}, found ${hits.length}`);
  return hits[0] as FakeElement;
};
const byName = (name: string): FakeElement => one(`[name=${name}]`, (n) => n.name === name);
const buttonText = (text: string): FakeElement =>
  one(`button "${text}"`, (n) => n.tagName === 'BUTTON' && n.textContent === text);
const group = (labelledBy: string): FakeElement =>
  one(`radiogroup ${labelledBy}`, (n) => n.getAttribute('role') === 'radiogroup' && n.getAttribute('aria-labelledby') === labelledBy);
const cards = (labelledBy: string): FakeElement[] =>
  group(labelledBy).children.filter((c): c is FakeElement => c instanceof FakeElement);
/** A card by the words on its label line (the `ns-card-lb` span). */
const card = (labelledBy: string, label: string): FakeElement => {
  const hits = cards(labelledBy).filter((c) =>
    descendants(c).some((d) => d.classList.contains('ns-card-lb') && d.textContent === label),
  );
  assert.equal(hits.length, 1, `card "${label}" in ${labelledBy}`);
  return hits[0] as FakeElement;
};
const tool = (label: string): FakeElement => card('ns-tool-lb', label);
const shellCard = (label: string): FakeElement => card('ns-shell-lb', label);
const permCard = (label: string): FakeElement => card('ns-perm-lb', label);
const scrim = (): FakeElement => modalHost.children[0] as FakeElement;
const infoBtn = (): FakeElement => one('info button', (n) => n.classList.contains('ns-info'));
const helpBox = (): FakeElement => one('help popover', (n) => n.id === 'ns-perm-help');
const errBox = (): FakeElement => one('error line', (n) => n.classList.contains('ns-err'));
const startBtn = (): FakeElement => buttonText('Start session');
const checked = (c: FakeElement): boolean => c.getAttribute('aria-checked') === 'true';

/** A pointer press: pointerdown, mousedown (focus unless prevented), click. */
function userClick(n: FakeElement): void {
  if (n.disabled) return; // a disabled control receives nothing
  dispatch(n, 'pointerdown');
  const md = dispatch(n, 'mousedown');
  if (!md.defaultPrevented && FOCUSABLE_TAGS.has(n.tagName)) n.focus();
  dispatch(n, 'click');
}

/** Pick an option by the words the user SEES — never by its value. */
function pickByLabel(select: FakeElement, label: string): void {
  const i = select.options.findIndex((o) => o.textContent === label);
  assert.notEqual(i, -1, `no option reads ${JSON.stringify(label)} in [name=${select.name}]`);
  assert.equal(select.disabled, false, `[name=${select.name}] is disabled`);
  select.selectedIndex = i;
  dispatch(select, 'change');
}

function type(input: FakeElement, text: string): void {
  input.value = text;
  dispatch(input, 'input');
}

function press(key: string, shiftKey = false): FakeEvent {
  const t = doc.activeElement instanceof FakeElement ? doc.activeElement : body;
  return dispatch(t, 'keydown', { key, shiftKey });
}

/** Let launch()'s awaits settle: bounded event-loop turns, no clock. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise<void>((r) => setImmediate(r));
}

/** Press Start session and hand back the POST body it sent (or null: no POST). */
async function launch(): Promise<Record<string, unknown> | null> {
  const before = H.posts.length;
  userClick(startBtn());
  await settle();
  return H.posts.length > before ? (H.posts[H.posts.length - 1] as Record<string, unknown>) : null;
}

const PROJ: Project = { id: 'p1', name: 'demo-api', path: '/home/tester/demo-api', createdAt: '2026-09-10T00:00:00Z' };

/** Fresh open with the given projects; closes whatever was open first. */
function openWith(projects: Project[], opts?: { projectId?: string }): void {
  L.closeLaunchDialog();
  H.projects = projects;
  L.openLaunchDialog(opts);
  assert.equal(L.isLaunchDialogOpen(), true);
}

/** The claude argv the PRE-A4 dialog sent, from its own recipe (model, mode, effort, --continue). */
function preA4(model: string, perm: string, effort: string, cont: boolean): string[] {
  const a = ['--model', model];
  if (perm !== 'default') a.push('--permission-mode', perm);
  if (effort !== 'default') a.push('--effort', effort);
  if (cont) a.push('--continue');
  return a;
}

// ===========================================================================
// Tests
// ===========================================================================

test('harness non-vacuity: the REAL dialog mounted, with its three card groups and the stubs wired', () => {
  assert.equal(modalHost.children.length, 1, 'initLaunchDialog appends one scrim');
  assert.ok(scrim().classList.contains('modal-scrim'), 'ui/keys.ts finds an open dialog by .modal-scrim');
  assert.equal(cards('ns-tool-lb').length, TOOL_CARDS.length);
  assert.equal(cards('ns-shell-lb').length, SHELL_CARDS.length);
  assert.equal(cards('ns-perm-lb').length, PERMS.length);
  assert.equal(H.subscribers.length, 1, 'ONE permanent state subscription');
  openWith([PROJ]);
  assert.equal(scrim().hidden, false);
  assert.equal(doc.activeElement, byName('title'), 'open() puts the keyboard in the Name box');
});

test('B12: every Tool card holds its tool’s real logo in the tile — one per card, no letters, Claude’s tile keeps its tint', () => {
  openWith([PROJ]);
  const want: [string, string][] = [
    ['Claude Code', 'claude'],
    ['Codex', 'codex'],
    ['Gemini CLI', 'gemini'],
    ['Grok', 'grok'],
    ['Terminal', 'terminal'],
    ['Other', 'command'],
  ];
  for (const [label, id] of want) {
    const tile = descendants(tool(label)).find((d) => d.classList.contains('ns-mark'));
    assert.ok(tile !== undefined, `${label}: a tile`);
    assert.equal(tile.textContent, '', `${label}: a logo, not letters`);
    assert.equal(tile.getAttribute('aria-hidden'), 'true');
    const logos = descendants(tile).filter((d) => d.getAttribute('data-tool') !== null);
    assert.deepEqual(logos.map((l) => l.getAttribute('data-tool')), [id], label);
    assert.equal(logos[0]?.getAttribute('width'), '14', `${label}: one size in every tile`);
    assert.equal(tile.classList.contains('is-agent'), label === 'Claude Code', `${label}: the accent tint only on Claude`);
  }
});

test('defaults: an untouched dialog sends exactly `claude --model opus` for the project, no title', async () => {
  openWith([PROJ]);
  userClick(tool('Claude Code'));
  const post = await launch();
  assert.deepEqual(post, { projectId: 'p1', command: 'claude', args: ['--model', 'opus'], cols: 120, rows: 40 });
  assert.equal(L.isLaunchDialogOpen(), false, 'a successful launch closes the dialog');
  assert.deepEqual(H.upserted.at(-1), 'sess-' + H.posts.length, 'the new session gets its tab');
});

test('the selects SHOW labels and SEND values: every option is (vocabulary id, table label)', () => {
  openWith([PROJ]);
  const opts = (name: string): [string, string][] => byName(name).options.map((o) => [o.value, o.textContent]);
  assert.deepEqual(opts('model'), MODELS.map((m) => [m, MODEL_LABEL[m]]));
  assert.deepEqual(opts('effort'), EFFORTS.map((e) => [e, EFFORT_LABEL[e]]));
  assert.deepEqual(opts('start'), START_FROM.map((s) => [s.value, s.label]));
});

test('A4 contract through the DOM: all 192 claude states (model x permission card x effort x Start from) send the pre-A4 argv', async () => {
  let n = 0;
  for (const m of MODELS) {
    for (const p of PERMS) {
      for (const e of EFFORTS) {
        for (const s of START_FROM) {
          openWith([PROJ]);
          userClick(tool('Claude Code'));
          pickByLabel(byName('model'), MODEL_LABEL[m]);
          userClick(permCard(PERM_SHORT[p.mode]));
          pickByLabel(byName('effort'), EFFORT_LABEL[e]);
          pickByLabel(byName('start'), s.label);
          const post = await launch();
          assert.deepEqual(
            post,
            { projectId: 'p1', command: 'claude', args: preA4(m, p.mode, e, s.value === 'continue'), cols: 120, rows: 40 },
            `${m}/${p.mode}/${e}/${s.value}`,
          );
          n++;
        }
      }
    }
  }
  assert.equal(n, 192);
});

test('A4 contract, spelled out: the hardest claude state and the two Start from choices, literal argv', async () => {
  openWith([PROJ]);
  userClick(tool('Claude Code'));
  pickByLabel(byName('model'), 'Sonnet');
  userClick(permCard('Auto edits'));
  pickByLabel(byName('effort'), 'Extra high');
  pickByLabel(byName('start'), 'The last conversation in this project');
  assert.deepEqual((await launch())?.args, [
    '--model', 'sonnet', '--permission-mode', 'acceptEdits', '--effort', 'xhigh', '--continue',
  ]);
  openWith([PROJ]);
  userClick(tool('Claude Code'));
  pickByLabel(byName('model'), 'Fable');
  userClick(permCard('No prompts'));
  pickByLabel(byName('effort'), 'Max');
  pickByLabel(byName('start'), 'A fresh conversation');
  assert.deepEqual((await launch())?.args, ['--model', 'fable', '--permission-mode', 'bypassPermissions', '--effort', 'max']);
});

test('Terminal: the Bash card is `/bin/bash -l`, the PowerShell card is `powershell.exe -NoLogo`, byte for byte', async () => {
  openWith([PROJ]);
  userClick(tool('Terminal'));
  userClick(shellCard('Bash'));
  assert.deepEqual(await launch(), { projectId: 'p1', command: '/bin/bash', args: ['-l'], cols: 120, rows: 40 });
  openWith([PROJ]);
  userClick(tool('Terminal'));
  userClick(shellCard('PowerShell'));
  assert.deepEqual(await launch(), { projectId: 'p1', command: 'powershell.exe', args: ['-NoLogo'], cols: 120, rows: 40 });
});

test('Terminal: claude choices made before switching never leak into the shell argv', async () => {
  openWith([PROJ]);
  userClick(tool('Claude Code'));
  pickByLabel(byName('model'), 'Haiku');
  userClick(permCard('No prompts'));
  pickByLabel(byName('effort'), 'Max');
  pickByLabel(byName('start'), 'The last conversation in this project');
  userClick(tool('Terminal'));
  userClick(shellCard('Bash'));
  assert.deepEqual((await launch())?.args, ['-l']);
});

test('Other: the custom line is whitespace-split verbatim — tabs, runs, quotes and a path all as before', async () => {
  const cases: [string, string, string[]][] = [
    ['htop --tree', 'htop', ['--tree']],
    ['  bash \t -c   true ', 'bash', ['-c', 'true']],
    ['echo "a b"', 'echo', ['"a', 'b"']],
    ["printf '%s' x", 'printf', ["'%s'", 'x']],
    ['/usr/bin/env python3 -i', '/usr/bin/env', ['python3', '-i']],
    ['--weird foo', '--weird', ['foo']],
    ['claude --model opus --continue', 'claude', ['--model', 'opus', '--continue']],
  ];
  for (const [line, command, args] of cases) {
    openWith([PROJ]);
    userClick(tool('Other'));
    type(byName('command'), line);
    assert.deepEqual(await launch(), { projectId: 'p1', command, args, cols: 120, rows: 40 }, JSON.stringify(line));
  }
});

test('Other: a blank command sends nothing, says so, and puts the keyboard in the Command field', async () => {
  for (const line of ['', '   ', '\t \t']) {
    openWith([PROJ]);
    userClick(tool('Other'));
    type(byName('command'), line);
    assert.equal(await launch(), null, JSON.stringify(line));
    assert.equal(errBox().hidden, false);
    assert.equal(errBox().textContent, 'Type a command.');
    assert.equal(doc.activeElement, byName('command'));
    assert.equal(L.isLaunchDialogOpen(), true);
  }
});

test('Other: the log line carries the SHAPE of a custom command, never its text', async () => {
  openWith([PROJ]);
  userClick(tool('Other'));
  type(byName('command'), 'deploy-tool --token s3cr3t-value now');
  H.logs = [];
  await launch();
  const joined = H.logs.join('\n');
  assert.match(joined, /launch: kind=other project=demo-api words=4/);
  for (const leak of ['deploy-tool', 's3cr3t-value', '--token']) assert.equal(joined.includes(leak), false, leak);
});

test('No projects: Terminal still launches into the home folder, titled by the shell name, never a path', async () => {
  const fsBefore = H.fsListCalls;
  openWith([]);
  userClick(tool('Terminal'));
  userClick(shellCard('Bash'));
  assert.equal(startBtn().disabled, false);
  assert.equal(
    one('no-projects line', (n) => n.classList.contains('ns-none')).children[0]?.textContent,
    'No projects yet. This one opens in your home folder.',
  );
  assert.deepEqual(await launch(), {
    cwd: '/home/tester',
    command: '/bin/bash',
    args: ['-l'],
    title: 'Bash',
    cols: 120,
    rows: 40,
  });
  openWith([]);
  userClick(tool('Terminal'));
  userClick(shellCard('PowerShell'));
  assert.deepEqual(await launch(), {
    cwd: '/home/tester',
    command: 'powershell.exe',
    args: ['-NoLogo'],
    title: 'PowerShell',
    cols: 120,
    rows: 40,
  });
  assert.ok(H.fsListCalls - fsBefore <= 1, 'the home folder is asked at most once per page');
});

test('No projects: Claude Code and Other stay unlaunchable (Start session disabled, nothing sent)', async () => {
  for (const t of ['Claude Code', 'Other']) {
    openWith([]);
    userClick(tool(t));
    if (t === 'Other') type(byName('command'), 'htop');
    assert.equal(startBtn().disabled, true, t);
    assert.equal(await launch(), null, t);
  }
});

test('a typed Name is sent trimmed as the title; a blank one sends no title (the server uses the project name)', async () => {
  openWith([PROJ]);
  userClick(tool('Claude Code'));
  assert.equal(byName('title').placeholder, 'demo-api', 'the placeholder IS the project name');
  type(byName('title'), '  my run  ');
  assert.equal((await launch())?.title, 'my run');
});

test('inert tool cards: rendered, aria-disabled, never a tab stop, and a click launches nothing new', async () => {
  openWith([PROJ]);
  userClick(tool('Terminal'));
  userClick(shellCard('Bash'));
  for (const label of ['Codex', 'Gemini CLI', 'Grok']) {
    const c = tool(label);
    assert.equal(c.getAttribute('aria-disabled'), 'true', label);
    assert.equal(c.tabIndex, -1, label);
    assert.ok(c.textContent.includes(NOT_INSTALLED), `${label} carries the hint`);
    const focusBefore = doc.activeElement;
    userClick(c);
    assert.equal(checked(c), false, `${label} never becomes selected`);
    assert.equal(doc.activeElement, focusBefore, `${label}: a press does not even take focus`);
    assert.ok(checked(tool('Terminal')), `${label}: the selection stays on Terminal`);
  }
  assert.deepEqual((await launch())?.command, '/bin/bash', 'still the Terminal launch');
});

test('inert shell cards: Zsh and Command Prompt cannot be picked; the chosen shell stays', async () => {
  openWith([PROJ]);
  userClick(tool('Terminal'));
  userClick(shellCard('PowerShell'));
  for (const label of ['Zsh', 'Command Prompt']) {
    const c = shellCard(label);
    assert.equal(c.getAttribute('aria-disabled'), 'true', label);
    assert.equal(c.tabIndex, -1, label);
    userClick(c);
    assert.equal(checked(c), false, label);
  }
  assert.ok(checked(shellCard('PowerShell')));
  assert.deepEqual(await launch(), { projectId: 'p1', command: 'powershell.exe', args: ['-NoLogo'], cols: 120, rows: 40 });
});

test('card keyboard: arrows move the selection over LIVE cards only, wrapping; Home/End jump', () => {
  openWith([PROJ]);
  userClick(tool('Claude Code'));
  const sel = (): string[] =>
    cards('ns-tool-lb').filter(checked).map((c) => c.textContent);
  assert.equal(doc.activeElement, tool('Claude Code'));
  press('ArrowRight');
  assert.equal(doc.activeElement, tool('Terminal'), 'Codex/Gemini CLI/Grok are skipped');
  assert.deepEqual(sel().length, 1);
  press('ArrowDown');
  assert.equal(doc.activeElement, tool('Other'));
  press('ArrowRight');
  assert.equal(doc.activeElement, tool('Claude Code'), 'wraps');
  press('ArrowLeft');
  assert.equal(doc.activeElement, tool('Other'), 'wraps backwards');
  press('Home');
  assert.equal(doc.activeElement, tool('Claude Code'));
  press('End');
  assert.equal(doc.activeElement, tool('Other'));
  assert.equal(byName('command').rendered, true, 'the arrows really switched the kind');
  // Exactly one tab stop per group: the selected card.
  const stops = cards('ns-tool-lb').filter((c) => c.tabIndex === 0);
  assert.deepEqual(stops, [tool('Other')]);
  // Shells: Bash <-> PowerShell, inert ones skipped.
  userClick(tool('Terminal'));
  userClick(shellCard('Bash'));
  press('ArrowRight');
  assert.equal(doc.activeElement, shellCard('PowerShell'));
  assert.ok(checked(shellCard('PowerShell')));
  press('ArrowRight');
  assert.equal(doc.activeElement, shellCard('Bash'));
});

test('permission cards: the four PERM_SHORT labels in PERMS order, arrows cycle them, only No prompts is danger', () => {
  openWith([PROJ]);
  userClick(tool('Claude Code'));
  const labels = cards('ns-perm-lb').map((c) => c.textContent);
  assert.deepEqual(labels, PERMS.map((p) => PERM_SHORT[p.mode]));
  assert.deepEqual(
    cards('ns-perm-lb').filter((c) => c.classList.contains('is-danger')).map((c) => c.textContent),
    [PERM_SHORT.bypassPermissions],
  );
  userClick(permCard('Always ask'));
  press('ArrowRight');
  assert.ok(checked(permCard('Auto edits')));
  press('End');
  assert.ok(checked(permCard('No prompts')));
});

test('the claude-only controls leave the form for Terminal and Other: hidden AND disabled, popover closed', () => {
  for (const t of ['Terminal', 'Other']) {
    openWith([PROJ]);
    userClick(tool('Claude Code'));
    userClick(infoBtn());
    assert.equal(helpBox().hidden, false);
    userClick(tool(t));
    for (const name of ['model', 'effort', 'start']) {
      assert.equal(byName(name).disabled, true, `${t}: ${name} disabled`);
      assert.equal(byName(name).rendered, false, `${t}: ${name} hidden`);
    }
    assert.equal(infoBtn().disabled, true, `${t}: info button disabled`);
    for (const c of cards('ns-perm-lb')) assert.equal(c.disabled, true, `${t}: ${c.textContent} disabled`);
    assert.equal(helpBox().hidden, true, `${t}: the popover closes with the claude box`);
    assert.equal(byName('command').rendered, t === 'Other', `${t}: Command field`);
    assert.equal(group('ns-shell-lb').rendered, t === 'Terminal', `${t}: Shell cards`);
    // And back: everything claude comes back enabled.
    userClick(tool('Claude Code'));
    for (const name of ['model', 'effort', 'start']) assert.equal(byName(name).disabled, false, name);
    assert.equal(infoBtn().disabled, false);
    assert.equal(byName('command').rendered, false);
    assert.equal(group('ns-shell-lb').rendered, false);
  }
});

test('Tab trap: the cycle wraps between the REAL first and last stops; inert and unselected cards never count', () => {
  openWith([PROJ]);
  userClick(tool('Claude Code'));
  const stops = descendants(modalHost).filter(
    (n) => n.rendered && n.tabIndex >= 0 && ((FOCUSABLE_TAGS.has(n.tagName) && !n.disabled) || n.hasAttribute('tabindex')),
  );
  // Close, then one card per group, Name, Project, Model, Effort, info, Start from, Cancel, Start session.
  assert.equal(stops[0], buttonText('×'));
  assert.equal(stops.at(-1), startBtn());
  for (const label of ['Codex', 'Gemini CLI', 'Grok']) assert.equal(stops.includes(tool(label)), false, label);
  startBtn().focus();
  assert.equal(press('Tab').defaultPrevented, true);
  assert.equal(doc.activeElement, buttonText('×'), 'Tab at the last stop wraps to the first');
  assert.equal(press('Tab', true).defaultPrevented, true);
  assert.equal(doc.activeElement, startBtn(), 'Shift+Tab at the first stop wraps to the last');
});

test('info popover: the ONE explanation — four PERM_SHORT terms with their PERM_HELP lines, closed by default', () => {
  openWith([PROJ]);
  userClick(tool('Claude Code'));
  assert.equal(helpBox().hidden, true, 'closed on open');
  assert.equal(infoBtn().getAttribute('aria-expanded'), 'false');
  assert.equal(infoBtn().getAttribute('aria-controls'), 'ns-perm-help');
  assert.equal(infoBtn().getAttribute('aria-label'), 'What these mean');
  userClick(infoBtn());
  assert.equal(helpBox().hidden, false);
  assert.equal(infoBtn().getAttribute('aria-expanded'), 'true');
  const dl = descendants(helpBox()).filter((n) => n.tagName === 'DT' || n.tagName === 'DD');
  assert.deepEqual(
    dl.map((n) => [n.tagName, n.textContent]),
    PERMS.flatMap((p) => [
      ['DT', PERM_SHORT[p.mode]],
      ['DD', PERM_HELP[p.mode]],
    ]),
  );
  userClick(infoBtn());
  assert.equal(helpBox().hidden, true, 'the button toggles it shut');
});

test('info popover: Esc closes ONLY the popover (main.ts never sees it), a second Esc closes the dialog', () => {
  openWith([PROJ]);
  userClick(tool('Claude Code'));
  userClick(infoBtn());
  const seen = mainSawEscape;
  const e = press('Escape');
  assert.equal(e.defaultPrevented, true);
  assert.equal(helpBox().hidden, true, 'popover closed');
  assert.equal(L.isLaunchDialogOpen(), true, 'dialog still open');
  assert.equal(mainSawEscape, seen, 'the capture listener stopped the event before the app-level handler');
  assert.equal(doc.activeElement, infoBtn(), 'the keyboard goes back to the info button');
  press('Escape');
  assert.equal(mainSawEscape, seen + 1);
  assert.equal(L.isLaunchDialogOpen(), false, 'with the popover shut, Esc is the dialog’s again');
});

test('info popover: Esc from the page body (after a click on the popover text) still closes only the popover', () => {
  openWith([PROJ]);
  userClick(tool('Claude Code'));
  userClick(infoBtn());
  doc.activeElement = body;
  press('Escape');
  assert.equal(helpBox().hidden, true);
  assert.equal(L.isLaunchDialogOpen(), true);
});

test('info popover: a press outside it, or focus moving on, closes it; a press inside keeps it', () => {
  openWith([PROJ]);
  userClick(tool('Claude Code'));
  userClick(infoBtn());
  const dd = descendants(helpBox()).find((n) => n.tagName === 'DD') as FakeElement;
  dispatch(dd, 'pointerdown');
  assert.equal(helpBox().hidden, false, 'a press on its own text keeps it');
  userClick(byName('title'));
  assert.equal(helpBox().hidden, true, 'a press elsewhere closes it');
  userClick(infoBtn());
  permCard('Always ask').focus();
  assert.equal(helpBox().hidden, true, 'Tab onto the cards it covers closes it');
});

test('open(): Effort and Start from reset every open; kind, shell and command text are remembered', async () => {
  openWith([PROJ]);
  userClick(tool('Claude Code'));
  pickByLabel(byName('effort'), 'High');
  pickByLabel(byName('start'), 'The last conversation in this project');
  L.closeLaunchDialog();
  L.openLaunchDialog();
  assert.equal(byName('effort').value, 'default');
  assert.equal(byName('start').value, 'fresh');
  assert.deepEqual((await launch())?.args, ['--model', 'opus'], 'a reopened dialog never silently continues');

  openWith([PROJ]);
  userClick(tool('Other'));
  type(byName('command'), 'htop --tree');
  L.closeLaunchDialog();
  L.openLaunchDialog();
  assert.ok(checked(tool('Other')), 'the kind is remembered');
  assert.equal(byName('command').value, 'htop --tree', 'the command text is remembered');

  openWith([PROJ]);
  userClick(tool('Terminal'));
  userClick(shellCard('PowerShell'));
  L.closeLaunchDialog();
  L.openLaunchDialog();
  assert.ok(checked(tool('Terminal')));
  assert.ok(checked(shellCard('PowerShell')), 'the shell is remembered');
  assert.equal((await launch())?.command, 'powershell.exe');
});

test('project defaults: model and mode resolve once per open from the selected project', async () => {
  const P2: Project = { ...PROJ, id: 'p2', name: 'other', defaultModel: 'haiku', defaultMode: 'skip-permissions' };
  openWith([P2]);
  userClick(tool('Claude Code'));
  assert.deepEqual((await launch())?.args, ['--model', 'haiku', '--permission-mode', 'bypassPermissions']);
  // A mode picked by hand is NOT carried into the next open: defaults win again.
  openWith([PROJ]);
  userClick(tool('Claude Code'));
  userClick(permCard('Read only'));
  L.closeLaunchDialog();
  L.openLaunchDialog();
  assert.ok(checked(permCard('Always ask')));
  assert.deepEqual((await launch())?.args, ['--model', 'opus']);
});

test('project intent (drawer row +): back to Claude Code for THAT project, its defaults layered on', async () => {
  const P2: Project = { ...PROJ, id: 'p2', name: 'other', defaultModel: 'sonnet' };
  openWith([PROJ, P2]);
  userClick(tool('Other'));
  type(byName('command'), 'htop');
  openWith([PROJ, P2], { projectId: 'p2' });
  assert.ok(checked(tool('Claude Code')), 'a stale Other cannot hijack a project launch');
  assert.equal(byName('project').value, 'p2');
  assert.deepEqual(await launch(), { projectId: 'p2', command: 'claude', args: ['--model', 'sonnet'], cols: 120, rows: 40 });
});

test('a failed launch keeps the dialog open with the error, and Start session usable again', async () => {
  openWith([PROJ]);
  userClick(tool('Claude Code'));
  H.nextPost = () => Promise.reject(new Error('Folder not found.'));
  await launch();
  assert.equal(L.isLaunchDialogOpen(), true);
  assert.equal(errBox().hidden, false);
  assert.equal(errBox().textContent, 'Folder not found.');
  assert.equal(startBtn().disabled, false);
});

test('closing hands the keyboard back; the outside press and Cancel both close', () => {
  const opener = new FakeElement('button');
  body.append(opener);
  L.closeLaunchDialog();
  opener.focus();
  H.projects = [PROJ];
  L.openLaunchDialog();
  userClick(buttonText('Cancel'));
  assert.equal(L.isLaunchDialogOpen(), false);
  assert.equal(doc.activeElement, opener, 'focus returns to where the dialog was opened from');
  L.openLaunchDialog();
  userClick(scrim());
  assert.equal(L.isLaunchDialogOpen(), false, 'a press on the scrim closes');
  L.openLaunchDialog();
  dispatch(scrim().children[0] as FakeElement, 'mousedown');
  assert.equal(L.isLaunchDialogOpen(), true, 'a press on the modal itself does not');
});

test('no command preview: nothing in the rendered dialog spells the argv — before, and WHILE the launch is in flight', async () => {
  // Visible text only: option VALUES are attributes, not copy.
  const visible = (n: FakeNode): string =>
    n instanceof FakeText
      ? n.data
      : n instanceof FakeElement && !n.hidden
        ? n.children.map(visible).join(' ')
        : '';
  const assertNoArgv = (when: string): void => {
    const text = visible(scrim());
    for (const argvBit of ['--', 'acceptEdits', 'claude ', '$ ', 'xhigh', '-l', '/bin/bash', 'powershell.exe', '-NoLogo']) {
      assert.equal(text.includes(argvBit), false, `${when}: the dialog shows ${JSON.stringify(argvBit)}`);
    }
    assert.ok(text.includes('Start session'), `${when}: non-vacuity, real copy was read`);
  };
  openWith([PROJ]);
  userClick(tool('Claude Code'));
  pickByLabel(byName('model'), 'Sonnet');
  userClick(permCard('Auto edits'));
  pickByLabel(byName('effort'), 'Extra high');
  pickByLabel(byName('start'), 'The last conversation in this project');
  assertNoArgv('claude, before launch');
  // Hold the POST open: whatever the dialog shows between the press and the
  // answer is on screen for as long as the server takes.
  let release: (v: unknown) => void = () => {};
  H.nextPost = () => new Promise((r) => (release = r));
  userClick(startBtn());
  await settle();
  assert.equal(L.isLaunchDialogOpen(), true, 'still open while the POST is pending');
  assertNoArgv('claude, in flight');
  release({ id: 'held', command: 'claude', args: [] });
  await settle();
  for (const shell of ['Bash', 'PowerShell']) {
    openWith([PROJ]);
    userClick(tool('Terminal'));
    userClick(shellCard(shell));
    H.nextPost = () => new Promise((r) => (release = r));
    userClick(startBtn());
    await settle();
    assertNoArgv(`${shell}, in flight`);
    release({ id: 'held-' + shell, command: 'x', args: [] });
    await settle();
  }
});

// ===========================================================================
// Nocturne B5 (2026-09-18): availability, per-tool controls, keys, resume
// ===========================================================================

const ALL_TOOLS: ToolAvailability = {
  claude: true,
  codex: true,
  gemini: true,
  grok: true,
  zsh: true,
  cmd: true,
  powershell: true,
};

/** Open with a given availability / key status / history, and let them land. */
async function openReady(
  opts: {
    projects?: Project[];
    tools?: Partial<ToolAvailability>;
    keys?: KeyStatus;
    history?: HistoryEntry[];
    projectId?: string;
  } = {},
): Promise<void> {
  H.tools = { ...ALL_TOOLS, ...(opts.tools ?? {}) };
  if (opts.keys !== undefined) H.keys = opts.keys;
  H.history = opts.history ?? [];
  openWith(opts.projects ?? [PROJ], opts.projectId !== undefined ? { projectId: opts.projectId } : undefined);
  await settle();
}

const noKeys: KeyStatus = {
  saved: { claude: false, gemini: false, grok: false },
  env: { claude: false, gemini: false, grok: false },
};

/** One ended, resumable Claude conversation. */
function conv(over: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: 'conv-a',
    conversation: true,
    sessionId: 's1',
    projectId: 'p1',
    cwd: '/home/tester/demo-api',
    command: 'claude',
    args: ['--model', 'opus'],
    title: 'auth refactor',
    createdAt: '2026-09-17T10:00:00Z',
    lastUsedAt: '2026-09-17T10:00:00Z',
    ended: { at: '2026-09-17T11:00:00Z', reason: 'exit' },
    ...over,
  } as HistoryEntry;
}

const startOpts = (): [string, string][] =>
  byName('start').options.map((o) => [o.value, o.textContent]);

test('B5 availability: an open with the answer still in flight flashes NO enabled card', async () => {
  // A FRESH module instance, so this holds whatever ran before it: the very
  // FIRST dialog a page opens, GET /api/tools never answered. No settle — this
  // is the dialog in the moment it opens. What is on screen is what it ASSUMES
  // (the pre-B5 set), never an optimistic grid that then goes dark, and the
  // cards it cannot vouch for carry NO sub-line: inert, claiming nothing.
  const first = (await import(`${launchUrl}?first-open`)) as LaunchModule;
  const host = new FakeElement('div');
  body.append(host);
  H.tools = ALL_TOOLS;
  H.projects = [PROJ];
  first.initLaunchDialog(host);
  first.openLaunchDialog();
  /** A card of the FRESH dialog, by the words on its label line. */
  const firstCard = (label: string): FakeElement => {
    const hits = descendants(host).filter(
      (n) =>
        n.classList.contains('ns-card') &&
        descendants(n).some((d) => d.classList.contains('ns-card-lb') && d.textContent === label),
    );
    assert.equal(hits.length, 1, `card "${label}"`);
    return hits[0] as FakeElement;
  };
  for (const label of ['Codex', 'Gemini CLI', 'Grok', 'Zsh', 'Command Prompt']) {
    const c = firstCard(label);
    assert.equal(c.getAttribute('aria-disabled'), 'true', label);
    assert.equal(c.textContent.includes(NOT_INSTALLED), false, `${label} claims nothing yet`);
  }
  for (const label of ['Claude Code', 'Terminal', 'Other', 'Bash', 'PowerShell']) {
    assert.equal(firstCard(label).getAttribute('aria-disabled'), null, label);
  }
  first.closeLaunchDialog();
});

test('B5 availability: an absent executable makes an INERT card that says `Not installed`', async () => {
  await openReady({ tools: { grok: false, zsh: false } });
  for (const [label, live] of [
    ['Claude Code', true],
    ['Codex', true],
    ['Gemini CLI', true],
    ['Grok', false],
  ] as [string, boolean][]) {
    const c = tool(label);
    assert.equal(c.getAttribute('aria-disabled'), live ? null : 'true', label);
    assert.equal(c.textContent.includes(NOT_INSTALLED), !live, label);
  }
  userClick(tool('Terminal'));
  assert.equal(shellCard('Zsh').getAttribute('aria-disabled'), 'true');
  assert.ok(shellCard('Zsh').textContent.includes(NOT_INSTALLED));
  assert.equal(shellCard('Command Prompt').getAttribute('aria-disabled'), null);
  assert.ok(shellCard('Command Prompt').textContent.includes('Windows'), 'a live card keeps its own sub-line');
  // A press on an inert card does nothing and does not even take focus.
  const before = doc.activeElement;
  userClick(tool('Grok'));
  assert.equal(checked(tool('Grok')), false);
  assert.equal(doc.activeElement, before);
});

test('B5 availability: the arrows skip an absent tool, and the answer can put a card BACK', async () => {
  await openReady({ tools: { codex: false, gemini: false } });
  userClick(tool('Claude Code'));
  press('ArrowRight');
  assert.equal(doc.activeElement, tool('Grok'), 'Codex and Gemini CLI are skipped');
  // The next open finds them installed: the same cards are live again.
  await openReady({});
  userClick(tool('Claude Code'));
  press('ArrowRight');
  assert.equal(doc.activeElement, tool('Codex'));
  assert.equal(tool('Codex').getAttribute('aria-disabled'), null);
  assert.ok(tool('Codex').textContent.includes('OpenAI'), 'the card gets its own sub-line back');
});

test('B5 availability: a failed ask keeps the last known answer rather than blanking the grid', async () => {
  await openReady({});
  assert.equal(tool('Codex').getAttribute('aria-disabled'), null);
  H.toolsFail = true;
  L.closeLaunchDialog();
  L.openLaunchDialog();
  await settle();
  H.toolsFail = false;
  assert.equal(tool('Codex').getAttribute('aria-disabled'), null, 'still live: nothing new was learned');
});

test('B5 availability: a selection that goes away moves to the first live card, never stays dead', async () => {
  await openReady({});
  userClick(tool('Grok'));
  assert.ok(checked(tool('Grok')));
  L.closeLaunchDialog();
  H.tools = { ...ALL_TOOLS, grok: false, claude: false };
  L.openLaunchDialog();
  await settle();
  assert.equal(checked(tool('Grok')), false);
  assert.ok(checked(tool('Codex')), 'the first card that can actually launch');
});

test('B5 Codex: the whole form through the DOM, argv byte-exact', async () => {
  await openReady({});
  userClick(tool('Codex'));
  assert.deepEqual(
    byName('model').options.map((o) => [o.value, o.textContent]),
    TOOLS.codex.models.map((m) => [m.id, m.label]),
  );
  assert.deepEqual(
    byName('effort').options.map((o) => [o.value, o.textContent]),
    TOOLS.codex.efforts.map((e) => [e.id, e.label]),
  );
  assert.deepEqual(startOpts(), [
    ['fresh', 'A fresh session'],
    ['last', 'The last session'],
    ['pick', 'Pick an earlier session'],
  ]);
  pickByLabel(byName('model'), 'GPT-5.6 Sol');
  userClick(permCard('Auto edits'));
  pickByLabel(byName('effort'), 'High');
  pickByLabel(byName('start'), 'The last session');
  assert.deepEqual(await launch(), {
    projectId: 'p1',
    command: 'codex',
    args: [
      '-m', 'gpt-5.6-sol',
      '-a', 'on-request', '-s', 'workspace-write',
      '-c', 'model_reasoning_effort=high',
      'resume', '--last',
    ],
    cols: 120,
    rows: 40,
  });
});

test('B5 Gemini: the Effort control leaves the form entirely, and the argv follows the table', async () => {
  await openReady({});
  userClick(tool('Gemini CLI'));
  assert.equal(byName('effort').rendered, false, 'hidden');
  assert.equal(byName('effort').disabled, true, 'and disabled — nothing hidden is reachable');
  assert.deepEqual(
    byName('model').options.map((o) => [o.value, o.textContent]),
    [['auto', 'Auto'], ['pro', 'Pro'], ['flash', 'Flash'], ['flash-lite', 'Flash Lite']],
  );
  assert.deepEqual(startOpts(), [
    ['fresh', 'A fresh session'],
    ['last', 'The last session'],
  ]);
  // Untouched: Auto and Always ask both emit nothing at all.
  assert.deepEqual(await launch(), { projectId: 'p1', command: 'gemini', args: [], cols: 120, rows: 40 });
  await openReady({});
  userClick(tool('Gemini CLI'));
  pickByLabel(byName('model'), 'Flash Lite');
  userClick(permCard('No prompts'));
  pickByLabel(byName('start'), 'The last session');
  assert.deepEqual((await launch())?.args, ['-m', 'flash-lite', '--approval-mode', 'yolo', '-r', 'latest']);
  // And the control comes BACK for a tool that has levels.
  await openReady({});
  userClick(tool('Gemini CLI'));
  userClick(tool('Grok'));
  assert.equal(byName('effort').rendered, true);
  assert.equal(byName('effort').disabled, false);
});

test('B5 Grok: Auto edits and Read only are inert cards carrying the hint; the arrows skip them', async () => {
  await openReady({});
  userClick(tool('Grok'));
  for (const label of ['Auto edits', 'Read only']) {
    const c = permCard(label);
    assert.equal(c.getAttribute('aria-disabled'), 'true', label);
    assert.equal(c.tabIndex, -1, label);
    assert.ok(c.textContent.includes(GROK_PERM_HINT), `${label} carries the hint`);
    userClick(c);
    assert.equal(checked(c), false, `${label} never becomes selected`);
  }
  assert.ok(checked(permCard('Always ask')));
  userClick(permCard('Always ask'));
  press('ArrowRight');
  assert.ok(checked(permCard('No prompts')), 'the two inert cards are skipped');
  assert.deepEqual((await launch())?.args, ['--always-approve']);
  // Back on a tool that takes all four, the cards are live again with no hint.
  await openReady({});
  userClick(tool('Grok'));
  userClick(tool('Claude Code'));
  for (const label of ['Auto edits', 'Read only']) {
    assert.equal(permCard(label).getAttribute('aria-disabled'), null, label);
    assert.equal(permCard(label).textContent, label, `${label} drops the hint`);
  }
});

test('B5 Grok: a permission already chosen is dropped when the tool cannot be told it', async () => {
  await openReady({});
  userClick(tool('Claude Code'));
  userClick(permCard('Read only'));
  userClick(tool('Grok'));
  assert.ok(checked(permCard('Always ask')), 'never silently kept as an unreachable mode');
  assert.deepEqual((await launch())?.args, []);
});

test('B5 per-tool memory: a level chosen for one tool never reaches another', async () => {
  await openReady({});
  userClick(tool('Codex'));
  pickByLabel(byName('model'), 'GPT-6 Astra');
  pickByLabel(byName('effort'), 'Extra high');
  userClick(tool('Grok'));
  assert.equal(byName('model').value, 'default', 'Grok starts at its own default');
  assert.equal(byName('effort').value, 'default');
  pickByLabel(byName('effort'), 'Medium');
  userClick(tool('Codex'));
  assert.equal(byName('model').value, 'gpt-6-astra', 'Codex kept what was chosen for Codex');
  assert.equal(byName('effort').value, 'xhigh');
  assert.deepEqual((await launch())?.args, [
    '-m', 'gpt-6-astra', '-a', 'on-request', '-s', 'read-only', '-c', 'model_reasoning_effort=xhigh',
  ]);
});

test('B5 Terminal: the Zsh and Command Prompt cards spawn their argv byte for byte', async () => {
  await openReady({});
  userClick(tool('Terminal'));
  userClick(shellCard('Zsh'));
  assert.deepEqual(await launch(), { projectId: 'p1', command: 'zsh', args: ['-l'], cols: 120, rows: 40 });
  await openReady({});
  userClick(tool('Terminal'));
  userClick(shellCard('Command Prompt'));
  // NO args: the server appends the tail that walks cmd.exe into the folder.
  assert.deepEqual(await launch(), { projectId: 'p1', command: 'cmd.exe', args: [], cols: 120, rows: 40 });
  // With no project, the card's product name titles the session — never a path.
  await openReady({ projects: [] });
  userClick(tool('Terminal'));
  userClick(shellCard('Command Prompt'));
  assert.deepEqual(await launch(), {
    cwd: '/home/tester',
    command: 'cmd.exe',
    args: [],
    title: 'Command Prompt',
    cols: 120,
    rows: 40,
  });
});

test('B5 notice: shown for Gemini CLI and Grok with no key, and for nothing else', async () => {
  const noticeEl = (): FakeElement => one('key notice', (n) => n.classList.contains('ns-notice'));
  await openReady({ keys: noKeys });
  for (const [label, shown] of [
    ['Claude Code', false],
    ['Codex', false],
    ['Gemini CLI', true],
    ['Grok', true],
    ['Terminal', false],
    ['Other', false],
  ] as [string, boolean][]) {
    userClick(tool(label));
    assert.equal(noticeEl().rendered, shown, label);
  }
  userClick(tool('Gemini CLI'));
  assert.equal(
    noticeEl().children[0]?.textContent,
    'Needs an API key, or sign in inside the terminal the first time.',
  );
  assert.equal(buttonText('Add key').rendered, true);
});

test('B5 notice: a saved key or one already in the environment silences it', async () => {
  await openReady({
    keys: { saved: { claude: false, gemini: true, grok: false }, env: { claude: false, gemini: false, grok: false } },
  });
  const noticeEl = (): FakeElement => one('key notice', (n) => n.classList.contains('ns-notice'));
  userClick(tool('Gemini CLI'));
  assert.equal(noticeEl().rendered, false, 'a saved key');
  userClick(tool('Grok'));
  assert.equal(noticeEl().rendered, true, 'and Grok still has none');
  await openReady({
    keys: { saved: { claude: false, gemini: false, grok: false }, env: { claude: false, gemini: false, grok: true } },
  });
  userClick(tool('Grok'));
  assert.equal(noticeEl().rendered, false, 'one set outside the app counts');
});

test('B5 notice: nothing is claimed while the answer is unknown', async () => {
  H.tools = ALL_TOOLS;
  H.keys = noKeys;
  openWith([PROJ]);
  // No settle: the dialog has not been told anything about keys yet, and an
  // unprompted "needs a key" over a machine that has one would be wrong.
  const noticeEl = (): FakeElement => one('key notice', (n) => n.classList.contains('ns-notice'));
  assert.equal(noticeEl().rendered, false);
  // Not even on the two tools the notice IS for. A FRESH module instance whose
  // GET /api/keys never answers, while GET /api/tools does: Gemini CLI and Grok
  // are selectable, the key answer is unknown, and an unprompted "needs a key"
  // over a machine that has one would be wrong.
  H.keysHang = true;
  H.tools = ALL_TOOLS;
  H.projects = [PROJ];
  const pending = (await import(`${launchUrl}?keys-pending`)) as LaunchModule;
  const host = new FakeElement('div');
  body.append(host);
  pending.initLaunchDialog(host);
  pending.openLaunchDialog();
  await settle(); // the availability answer lands; the key answer never does
  const pendingCard = (label: string): FakeElement => {
    const hits = descendants(host).filter(
      (n) =>
        n.classList.contains('ns-card') &&
        descendants(n).some((d) => d.classList.contains('ns-card-lb') && d.textContent === label),
    );
    assert.equal(hits.length, 1, `card "${label}"`);
    return hits[0] as FakeElement;
  };
  const pendingNotice = (): FakeElement => {
    const hits = descendants(host).filter((n) => n.classList.contains('ns-notice'));
    assert.equal(hits.length, 1, 'key notice');
    return hits[0] as FakeElement;
  };
  for (const label of ['Gemini CLI', 'Grok']) {
    userClick(pendingCard(label));
    assert.equal(pendingNotice().rendered, false, `${label}, the key answer still in flight`);
  }
  pending.closeLaunchDialog();
  H.keysHang = false;
});

test('B5 notice: `Add key` closes the dialog and hands Settings the tool to focus', async () => {
  await openReady({ keys: noKeys });
  userClick(tool('Grok'));
  H.settingsOpens.length = 0;
  userClick(buttonText('Add key'));
  assert.equal(L.isLaunchDialogOpen(), false, 'the dialog gets out of the way');
  assert.deepEqual(H.settingsOpens, [{ page: 'prefs', focusKey: 'grok' }]);
  await openReady({ keys: noKeys });
  userClick(tool('Gemini CLI'));
  H.settingsOpens.length = 0;
  userClick(buttonText('Add key'));
  assert.deepEqual(H.settingsOpens, [{ page: 'prefs', focusKey: 'gemini' }]);
});

test('B5 Start from: Claude Code lists THIS project’s ended conversations, newest first', async () => {
  const P2: Project = { ...PROJ, id: 'p2', name: 'other' };
  await openReady({
    projects: [PROJ, P2],
    history: [
      conv({ id: 'c-old', title: 'old work', lastUsedAt: '2026-09-01T10:00:00Z' }),
      conv({ id: 'c-new', title: 'auth refactor', lastUsedAt: '2026-09-17T10:00:00Z' }),
      conv({ id: 'c-p2', title: 'other project', projectId: 'p2' }),
      conv({ id: 'c-live', title: 'running now', ended: null }),
      conv({ id: 'c-noconv', title: 'a shell', conversation: false }),
    ],
  });
  userClick(tool('Claude Code'));
  await settle();
  const opts = startOpts();
  assert.deepEqual(opts.slice(0, 2), [
    ['fresh', 'A fresh conversation'],
    ['continue', 'The last conversation in this project'],
  ]);
  assert.deepEqual(
    opts.slice(2).map(([v]) => v),
    ['c-new', 'c-old'],
    'this project only, ended only, conversations only, newest first',
  );
  // The label is the title plus the Earlier section's own relative wording.
  assert.match(opts[2]?.[1] ?? '', /^auth refactor, /);
  // Asked ONCE per open, however many times the tool is switched back to it.
  const asked = H.historyCalls;
  userClick(tool('Codex'));
  userClick(tool('Claude Code'));
  userClick(tool('Grok'));
  userClick(tool('Claude Code'));
  await settle();
  assert.equal(H.historyCalls, asked, 'the list is cached for the life of one open');
});

test('B5 Start from: choosing a conversation emits --resume <id> and presets the Name', async () => {
  await openReady({ history: [conv()] });
  userClick(tool('Claude Code'));
  await settle();
  const label = startOpts().find(([v]) => v === 'conv-a')?.[1] as string;
  pickByLabel(byName('start'), label);
  assert.equal(byName('title').value, 'auth refactor', 'the Name is preset to the entry’s title');
  assert.deepEqual(await launch(), {
    projectId: 'p1',
    command: 'claude',
    args: ['--model', 'opus', '--resume', 'conv-a'],
    title: 'auth refactor',
    cols: 120,
    rows: 40,
  });
  // The preset is editable, and --continue is never sent alongside.
  await openReady({ history: [conv()] });
  userClick(tool('Claude Code'));
  await settle();
  pickByLabel(byName('start'), startOpts().find(([v]) => v === 'conv-a')?.[1] as string);
  type(byName('title'), 'my own name');
  const post = await launch();
  assert.equal(post?.title, 'my own name');
  assert.equal((post?.args as string[]).includes('--continue'), false);
});

test('B5 Start from: switching project re-filters the list and falls back to a fresh start', async () => {
  const P2: Project = { ...PROJ, id: 'p2', name: 'other' };
  await openReady({
    projects: [PROJ, P2],
    history: [conv({ id: 'c-p1' }), conv({ id: 'c-p2', title: 'other work', projectId: 'p2' })],
  });
  userClick(tool('Claude Code'));
  await settle();
  pickByLabel(byName('start'), startOpts().find(([v]) => v === 'c-p1')?.[1] as string);
  assert.equal(byName('start').value, 'c-p1');
  pickByLabel(byName('project'), 'other');
  assert.deepEqual(startOpts().map(([v]) => v), ['fresh', 'continue', 'c-p2']);
  assert.equal(byName('start').value, 'fresh', 'never silently a DIFFERENT conversation');
  assert.deepEqual((await launch())?.args, ['--model', 'opus']);
});

test('B5 Start from: with no project selected, only the entries that ran in the HOME folder are offered', async () => {
  // A project-less session starts in the home folder (launch() sends exactly
  // that cwd), so those are the conversations `--resume` can mean here — a
  // project-less entry from some OTHER folder would resume somewhere else.
  await openReady({
    projects: [],
    history: [
      conv({ id: 'c-p1' }),
      conv({ id: 'c-home', title: 'home work', projectId: undefined, cwd: '/home/tester' }),
      conv({ id: 'c-elsewhere', title: 'other folder', projectId: undefined, cwd: '/srv/scratch' }),
    ],
  });
  userClick(tool('Claude Code'));
  await settle();
  assert.deepEqual(startOpts().map(([v]) => v), ['fresh', 'continue', 'c-home']);
});

test('B5 Start from: the other three tools never list a conversation', async () => {
  await openReady({ history: [conv()] });
  for (const [label, values] of [
    ['Codex', ['fresh', 'last', 'pick']],
    ['Gemini CLI', ['fresh', 'last']],
    ['Grok', ['fresh', 'last']],
  ] as [string, string[]][]) {
    userClick(tool(label));
    assert.deepEqual(startOpts().map(([v]) => v), values, label);
  }
});

test('B5 resume: a live conversation is refused by the server and the dialog says so, unchanged', async () => {
  // POST /api/sessions answers 409 when the chosen conversation is still
  // running. The dialog shows the server's sentence and stays open; nothing
  // about the form moves, so the user can pick another entry.
  await openReady({ history: [conv()] });
  userClick(tool('Claude Code'));
  await settle();
  pickByLabel(byName('start'), startOpts().find(([v]) => v === 'conv-a')?.[1] as string);
  H.nextPost = () => Promise.reject(new Error('That conversation is already running.'));
  await launch();
  assert.equal(L.isLaunchDialogOpen(), true);
  assert.equal(errBox().hidden, false);
  assert.equal(errBox().textContent, 'That conversation is already running.');
  assert.equal(byName('start').value, 'conv-a', 'the choice is left exactly as it was');
  assert.equal(startBtn().disabled, false);
});

test('B5: the reopened dialog never silently resumes — Start from is fresh again', async () => {
  await openReady({ history: [conv()] });
  userClick(tool('Claude Code'));
  await settle();
  pickByLabel(byName('start'), startOpts().find(([v]) => v === 'conv-a')?.[1] as string);
  L.closeLaunchDialog();
  L.openLaunchDialog();
  await settle();
  assert.equal(byName('start').value, 'fresh');
  assert.deepEqual((await launch())?.args, ['--model', 'opus']);
});

test('B5 copy rule: no flag, subcommand or CLI value is visible anywhere in the dialog', async () => {
  const visible = (n: FakeNode): string =>
    n instanceof FakeText
      ? n.data
      : n instanceof FakeElement && !n.hidden
        ? n.children.map(visible).join(' ')
        : '';
  for (const label of ['Claude Code', 'Codex', 'Gemini CLI', 'Grok', 'Terminal']) {
    await openReady({ keys: noKeys, history: [conv()] });
    userClick(tool(label));
    const text = visible(scrim());
    for (const bit of [
      '--', 'resume', 'on-request', 'workspace-write', 'read-only', 'auto_edit', 'yolo',
      'model_reasoning_effort', 'latest', 'cmd.exe', 'zsh ', '$ ', 'gpt-', 'grok-4.6',
    ]) {
      assert.equal(text.includes(bit), false, `${label}: the dialog shows ${JSON.stringify(bit)}`);
    }
    assert.ok(text.includes('Start session'), `${label}: non-vacuity, real copy was read`);
  }
});

// ===========================================================================
// B6 — Tool visibility (user decision D1): a hidden card is ABSENT from the
// grid. Nothing else moves: the backend is not asked a different question,
// running sessions are untouched, and the argv of every card that is still
// there is the one pinned above.
// ===========================================================================

/** Hide these ids for one test, then put the grid back exactly as it was. */
async function withHidden(ids: string[], fn: () => Promise<void>): Promise<void> {
  initHiddenTools({ hidden: ids }, TOOL_CARDS.map((c) => c.id));
  try {
    await fn();
  } finally {
    initHiddenTools({ hidden: [] }, TOOL_CARDS.map((c) => c.id));
    L.closeLaunchDialog();
  }
}

/** The tool cards the user can SEE, by their label, in reading order. */
const shownTools = (): string[] =>
  cards('ns-tool-lb')
    .filter((c) => !c.hidden)
    .map((c) => descendants(c).find((d) => d.classList.contains('ns-card-lb'))?.textContent ?? '');

test('B6 D1: a hidden tool leaves the grid — not inert, absent, and never a tab stop', async () => {
  await withHidden(['codex', 'grok'], async () => {
    await openReady({});
    assert.deepEqual(shownTools(), ['Claude Code', 'Gemini CLI', 'Terminal', 'Other']);
    for (const label of ['Codex', 'Grok']) {
      const c = tool(label);
      assert.equal(c.hidden, true, `${label} must be hidden`);
      assert.equal(c.tabIndex, -1, `${label} must not be a tab stop`);
      assert.equal(checked(c), false, `${label} must not be the selection`);
      // Hidden is NOT `Not installed`: the card says nothing about the backend.
      assert.equal(
        descendants(c).some((d) => d.textContent === NOT_INSTALLED),
        false,
        `${label} must not claim anything about what is installed`,
      );
    }
  });
});

test('B6 D1: the selection falls back to the FIRST visible card, and that card is what launches', async () => {
  // The dialog remembers the last kind; this is the case that matters — the
  // user hides the tool they last launched.
  await openReady({});
  userClick(tool('Claude Code'));
  L.closeLaunchDialog();
  await withHidden(['claude'], async () => {
    await openReady({});
    assert.deepEqual(shownTools(), ['Codex', 'Gemini CLI', 'Grok', 'Terminal', 'Other']);
    assert.equal(checked(tool('Codex')), true, 'the first card still in the grid is selected');
    const post = await launch();
    assert.equal((post as Record<string, unknown>).command, 'codex');
  });
});

test('B6 D1: the projects-drawer open falls back too — its Claude Code intent cannot select a card that is gone', async () => {
  await withHidden(['claude'], async () => {
    await openReady({ projectId: PROJ.id });
    assert.equal(byName('project').value, PROJ.id, 'the project intent still lands');
    assert.equal(checked(tool('Codex')), true);
  });
});

test('B6 D1: a flip is read on every OPEN — the dialog on screen is left alone, the next one has it', async () => {
  await openReady({});
  assert.deepEqual(shownTools(), ['Claude Code', 'Codex', 'Gemini CLI', 'Grok', 'Terminal', 'Other']);
  await withHidden(['gemini'], async () => {
    assert.equal(tool('Gemini CLI').hidden, false, 'the open dialog does not rearrange itself');
    L.closeLaunchDialog();
    L.openLaunchDialog();
    await settle();
    assert.equal(tool('Gemini CLI').hidden, true, 'the next open reads the preference');
  });
  L.openLaunchDialog();
  await settle();
  assert.deepEqual(shownTools(), ['Claude Code', 'Codex', 'Gemini CLI', 'Grok', 'Terminal', 'Other']);
  L.closeLaunchDialog();
});

test('B6 D1: the arrow keys skip a hidden card', async () => {
  await openReady({});
  userClick(tool('Claude Code'));
  L.closeLaunchDialog();
  await withHidden(['codex'], async () => {
    await openReady({});
    tool('Claude Code').focus();
    press('ArrowRight');
    assert.equal(checked(tool('Gemini CLI')), true, 'Codex is not in the ring at all');
    press('ArrowLeft');
    assert.equal(checked(tool('Claude Code')), true);
  });
});

test('B6 D1: a bag that hides all six keeps the first card — the dialog can never be empty', async () => {
  await withHidden(TOOL_CARDS.map((c) => c.id), async () => {
    await openReady({});
    assert.deepEqual(shownTools(), ['Claude Code']);
    assert.equal(checked(tool('Claude Code')), true);
    assert.deepEqual((await launch())?.args, ['--model', 'opus'], 'and it still launches what it always did');
  });
});

test('B6 D1: hiding a card changes nothing about availability — `Not installed` is the backend\'s word alone', async () => {
  await withHidden(['grok'], async () => {
    await openReady({ tools: { codex: false } });
    const codex = tool('Codex');
    assert.equal(codex.hidden, false, 'an absent executable is still SHOWN, inert');
    assert.equal(codex.getAttribute('aria-disabled'), 'true');
    assert.ok(descendants(codex).some((d) => d.textContent === NOT_INSTALLED));
    assert.equal(H.tools.grok, true, 'the hidden tool was not removed from what the backend answers');
  });
});

test('B6 D1: a hidden card is out of the arrow ring on the FIRST frame, before the backend answers', async () => {
  // `applyHiddenTools()` runs synchronously inside `open()`; `GET /api/tools`
  // lands turns later and re-derives the same ring through `setInert`. A grid
  // that only drops a hidden card from the ring when that answer arrives
  // leaves a window in which ArrowRight walks the selection onto a card the
  // user cannot see — and `select()` can hand it the group's only tab stop.
  await openReady({});
  userClick(tool('Claude Code'));
  L.closeLaunchDialog();
  await withHidden(['codex'], async () => {
    L.openLaunchDialog(); // deliberately NOT settled: the answer is still in flight
    assert.equal(H.toolCalls > 0, true, 'the request went out');
    assert.equal(tool('Codex').hidden, true, 'the card left the grid on the opening frame');
    tool('Claude Code').focus();
    press('ArrowRight');
    assert.equal(checked(tool('Gemini CLI')), true, 'and left the ring on that same frame');
    assert.equal(tool('Codex').tabIndex, -1, 'a card nobody can see is never the tab stop');
    press('End');
    assert.equal(checked(tool('Other')), true, 'End lands on the last card that is really there');
    await settle();
    assert.equal(tool('Codex').hidden, true, 'and the availability answer does not bring it back');
  });
});
