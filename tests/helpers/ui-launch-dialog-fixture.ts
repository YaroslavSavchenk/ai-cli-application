/**
 * The harness for the New session dialog tests (`tests/ui/ui-launch-dialog*.test.ts`):
 * it runs the REAL `web/src/ui/launch.ts` without a browser or a dependency.
 *   - A small DOM double of its own (NOT `fake-dom.ts`): elements,
 *     attributes, a real capture/target/bubble event dispatch with
 *     stopPropagation, focus with `focusin`, `hidden`/`disabled`,
 *     select/option value semantics as the HTML spec has them (setting a value
 *     no option carries selects nothing).
 *   - `module.registerHooks` swaps launch.ts's non-pure imports for stubs:
 *     `../api.ts` (records the POST, answers `fsList`, tools, keys, history),
 *     `../state.ts` (a projects list the test owns), `../log.ts` (records
 *     lines), `./panes.ts` (whose import graph reaches @xterm/xterm, a browser
 *     bundle) and `./settings.ts`. `./util.ts`, `./icons.ts` and
 *     `./launch-args.ts` are the REAL modules.
 *   - `main.ts`'s own Escape handling is emulated by a bubbling `window`
 *     keydown listener that closes the dialog — the same shape and priority as
 *     main.ts:525-551 — so the popover's capture-phase Esc can be proven to
 *     stop the event before it.
 *   - The user-level lookups and gestures every file uses (`tool`, `card`,
 *     `userClick`, `pickByLabel`, `launch`, `openWith`, `openReady`, …).
 *
 * Module-level on purpose: the globals, the hooks and the import of launch.ts
 * must run in this order before any test, once per test file (`node --test`
 * gives every file its own process, so every file gets its own dialog). Not a
 * test.
 */
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import type { ToolAvailability, KeyStatus, HistoryEntry } from '../../shared/protocol.ts';
import { nextImmediate } from './helpers.ts';

// ===========================================================================
// DOM double
// ===========================================================================

export interface FakeEvent {
  type: string;
  key: string;
  shiftKey: boolean;
  target: FakeNode | null;
  defaultPrevented: boolean;
  cancelBubble: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}

export type Handler = (e: FakeEvent) => void;

export class FakeTarget {
  readonly handlers: { type: string; fn: Handler; capture: boolean }[] = [];
  addEventListener(type: string, fn: Handler, opts?: boolean | { capture?: boolean }): void {
    const capture = typeof opts === 'boolean' ? opts : opts?.capture === true;
    this.handlers.push({ type, fn, capture });
  }
  removeEventListener(): void {}
}

export class FakeNode extends FakeTarget {
  parentNode: FakeElement | null = null;
  get textContent(): string {
    return '';
  }
}

export class FakeText extends FakeNode {
  readonly data: string;
  constructor(data: string) {
    super();
    this.data = data;
  }
  override get textContent(): string {
    return this.data;
  }
}

export const FOCUSABLE_TAGS = new Set(['BUTTON', 'INPUT', 'SELECT']);

export class FakeElement extends FakeNode {
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

export function descendants(root: FakeElement): FakeElement[] {
  const out: FakeElement[] = [];
  for (const c of root.children) {
    if (c instanceof FakeElement) out.push(c, ...descendants(c));
  }
  return out;
}

export const win = new FakeTarget();
export const body = new FakeElement('body');
export const doc = Object.assign(new FakeTarget(), {
  body,
  activeElement: body as FakeElement,
  createElement: (tag: string) => new FakeElement(tag),
  createElementNS: (_ns: string, tag: string) => new FakeElement(tag),
});

/** Capture (window -> target's parent), target, bubble (parent -> window). */
export function dispatch(target: FakeElement, type: string, init: { key?: string; shiftKey?: boolean } = {}): FakeEvent {
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

export const g = globalThis as Record<string, unknown>;
g.document = doc;
g.window = win;
g.Node = FakeNode;
g.HTMLElement = FakeElement;

// ===========================================================================
// Module stubs for launch.ts's four non-pure imports
// ===========================================================================

export interface Project {
  id: string;
  name: string;
  path: string;
  defaultModel?: string;
  defaultMode?: string;
  createdAt: string;
}

export interface Harness {
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

export const H: Harness = {
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

export const STUB_SRC: Record<string, string> = {
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

export interface LaunchModule {
  initLaunchDialog(host: unknown): void;
  openLaunchDialog(opts?: { projectId?: string }): void;
  closeLaunchDialog(): void;
  isLaunchDialogOpen(): boolean;
}

// A computed specifier: the typechecker must not walk launch.ts's browser
// import graph under the server tsconfig (web/tsconfig.json owns that).
export const launchUrl = new URL('../../web/src/ui/launch.ts', import.meta.url).href;
export const L = (await import(launchUrl)) as LaunchModule;

export const modalHost = new FakeElement('div');
body.append(modalHost);
L.initLaunchDialog(modalHost);

/** main.ts:525-551 in miniature: a BUBBLING window listener that closes the dialog on Esc. */
export let mainSawEscape = 0;
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

export const all = (): FakeElement[] => descendants(modalHost);
export const one = (what: string, pred: (n: FakeElement) => boolean): FakeElement => {
  const hits = all().filter(pred);
  assert.equal(hits.length, 1, `expected exactly one ${what}, found ${hits.length}`);
  return hits[0] as FakeElement;
};
export const byName = (name: string): FakeElement => one(`[name=${name}]`, (n) => n.name === name);
export const buttonText = (text: string): FakeElement =>
  one(`button "${text}"`, (n) => n.tagName === 'BUTTON' && n.textContent === text);
export const group = (labelledBy: string): FakeElement =>
  one(`radiogroup ${labelledBy}`, (n) => n.getAttribute('role') === 'radiogroup' && n.getAttribute('aria-labelledby') === labelledBy);
export const cards = (labelledBy: string): FakeElement[] =>
  group(labelledBy).children.filter((c): c is FakeElement => c instanceof FakeElement);
/** A card by the words on its label line (the `ns-card-lb` span). */
export const card = (labelledBy: string, label: string): FakeElement => {
  const hits = cards(labelledBy).filter((c) =>
    descendants(c).some((d) => d.classList.contains('ns-card-lb') && d.textContent === label),
  );
  assert.equal(hits.length, 1, `card "${label}" in ${labelledBy}`);
  return hits[0] as FakeElement;
};
export const tool = (label: string): FakeElement => card('ns-tool-lb', label);
export const shellCard = (label: string): FakeElement => card('ns-shell-lb', label);
export const permCard = (label: string): FakeElement => card('ns-perm-lb', label);
export const scrim = (): FakeElement => modalHost.children[0] as FakeElement;
export const infoBtn = (): FakeElement => one('info button', (n) => n.classList.contains('ns-info'));
export const helpBox = (): FakeElement => one('help popover', (n) => n.id === 'ns-perm-help');
export const errBox = (): FakeElement => one('error line', (n) => n.classList.contains('ns-err'));
export const startBtn = (): FakeElement => buttonText('Start session');
export const checked = (c: FakeElement): boolean => c.getAttribute('aria-checked') === 'true';

/** A pointer press: pointerdown, mousedown (focus unless prevented), click. */
export function userClick(n: FakeElement): void {
  if (n.disabled) return; // a disabled control receives nothing
  dispatch(n, 'pointerdown');
  const md = dispatch(n, 'mousedown');
  if (!md.defaultPrevented && FOCUSABLE_TAGS.has(n.tagName)) n.focus();
  dispatch(n, 'click');
}

/** Pick an option by the words the user SEES — never by its value. */
export function pickByLabel(select: FakeElement, label: string): void {
  const i = select.options.findIndex((o) => o.textContent === label);
  assert.notEqual(i, -1, `no option reads ${JSON.stringify(label)} in [name=${select.name}]`);
  assert.equal(select.disabled, false, `[name=${select.name}] is disabled`);
  select.selectedIndex = i;
  dispatch(select, 'change');
}

export function type(input: FakeElement, text: string): void {
  input.value = text;
  dispatch(input, 'input');
}

export function press(key: string, shiftKey = false): FakeEvent {
  const t = doc.activeElement instanceof FakeElement ? doc.activeElement : body;
  return dispatch(t, 'keydown', { key, shiftKey });
}

/** Let launch()'s awaits settle: bounded event-loop turns, no clock. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await nextImmediate();
}

/** Press Start session and hand back the POST body it sent (or null: no POST). */
export async function launch(): Promise<Record<string, unknown> | null> {
  const before = H.posts.length;
  userClick(startBtn());
  await settle();
  return H.posts.length > before ? (H.posts[H.posts.length - 1] as Record<string, unknown>) : null;
}

export const PROJ: Project = { id: 'p1', name: 'demo-api', path: '/home/tester/demo-api', createdAt: '2026-09-10T00:00:00Z' };

/** Fresh open with the given projects; closes whatever was open first. */
export function openWith(projects: Project[], opts?: { projectId?: string }): void {
  L.closeLaunchDialog();
  H.projects = projects;
  L.openLaunchDialog(opts);
  assert.equal(L.isLaunchDialogOpen(), true);
}

/** The claude argv the PRE-A4 dialog sent, from its own recipe (model, mode, effort, --continue). */
export function preA4(model: string, perm: string, effort: string, cont: boolean): string[] {
  const a = ['--model', model];
  if (perm !== 'default') a.push('--permission-mode', perm);
  if (effort !== 'default') a.push('--effort', effort);
  if (cont) a.push('--continue');
  return a;
}

export const ALL_TOOLS: ToolAvailability = {
  claude: true,
  codex: true,
  gemini: true,
  grok: true,
  zsh: true,
  cmd: true,
  powershell: true,
};

/** Open with a given availability / key status / history, and let them land. */
export async function openReady(
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
