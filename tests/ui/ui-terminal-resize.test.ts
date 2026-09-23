/**
 * The resize seam of `web/src/ui/terminal.ts` — pane box → fit → ONE resize
 * over that pane's own socket — and the boot order that makes the FIRST fit
 * the final one (Quality parts P2 and P3a, `.claude/plans/PLAN-QUALITY.md`).
 *
 * How: the REAL TerminalView on the DOM double, with `registerHooks` swapping
 * the imports that cannot run under node for recorders — `@xterm/xterm` (a
 * Terminal holding cols/rows), `@xterm/addon-fit` (a fit that derives cols/rows
 * from the container's box: 10 px per column, 20 px per row),
 * `@xterm/addon-webgl`, `../ws.ts` (a SessionSocket that records every
 * resize it is asked to send) and `../log.ts`. `ResizeObserver` is a global
 * double the test fires; the 75 ms debounce is a recorded window timer the
 * test fires — no clock. The boot order lives only in `main-shell.ts`, which
 * imports the whole app, so that one rule is a source read.
 *
 * Why it matters (PROJECT-SCOPE § Hard technical constraints): a pane whose
 * new size never reaches the PTY draws a TUI as garbage; a resize sent twice
 * (P0: 190x48, then 152x46 55 ms later, on every pane at every boot) makes
 * every TUI redraw twice; a resize on the wrong socket garbles a pane the user
 * did not touch.
 *
 * NOT claimed: real layout, real font metrics and the PTY agreeing
 * (`stty size`) — measured in a browser for P2/P3a and part of
 * `.claude/skills/verify-terminal/SKILL.md` check 4.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { installDom, type FakeElement } from '../helpers/fake-dom.ts';
import { readSource } from '../helpers/helpers.ts';
import { functionBody } from '../helpers/source-scan.ts';

const dom = installDom();

interface Resize {
  id: string;
  cols: number;
  rows: number;
}
interface FakeObserver {
  cb: () => void;
  target: FakeElement | null;
  off: boolean;
}
/** A stub socket: its session, and the handlers TerminalView gave it. */
interface FakeSocket {
  sessionId: string;
  handlers: { onInfo(s: unknown): void };
}
const H = { resizes: [] as Resize[], observers: [] as FakeObserver[], sockets: [] as FakeSocket[] };
(globalThis as unknown as { __termHarness: typeof H }).__termHarness = H;

const g = globalThis as unknown as Record<string, unknown>;
g.getComputedStyle = () => ({ getPropertyValue: () => '' });
(dom.doc as unknown as { documentElement: FakeElement }).documentElement = dom.body;
g.ResizeObserver = class {
  readonly rec: FakeObserver;
  constructor(cb: () => void) {
    this.rec = { cb, target: null, off: false };
    H.observers.push(this.rec);
  }
  observe(el: FakeElement): void {
    this.rec.target = el;
  }
  disconnect(): void {
    this.rec.off = true;
  }
};

const STUB_SRC: Record<string, string> = {
  xterm: `
    export class Terminal {
      constructor(options) { this.options = options; this.cols = 80; this.rows = 24; this.el = null; }
      attachCustomKeyEventHandler() {}
      open(el) { this.el = el; }
      loadAddon(a) { a.activate(this); }
      onData() {}
      reset() {}
      write(_d, cb) { cb?.(); }
      focus() {}
      dispose() {}
      hasSelection() { return false; }
      getSelection() { return ''; }
      paste() {}
      scrollToBottom() {}
      clearTextureAtlas() {}
    }`,
  fit: `
    const dims = (el) => ({ cols: Math.floor(el.clientWidth / 10), rows: Math.floor(el.clientHeight / 20) });
    export class FitAddon {
      activate(t) { this.t = t; }
      proposeDimensions() { return dims(this.t.el); }
      fit() { const d = dims(this.t.el); this.t.cols = d.cols; this.t.rows = d.rows; }
      dispose() {}
    }`,
  webgl: `
    export class WebglAddon { activate() {} onContextLoss() {} dispose() {} }`,
  ws: `
    const H = globalThis.__termHarness;
    export class SessionSocket {
      constructor(id, handlers) { this.sessionId = id; this.handlers = handlers; H.sockets.push(this); }
      sendResize(cols, rows) { H.resizes.push({ id: this.sessionId, cols, rows }); }
      sendInput() {}
      sendSeen() {}
      close() {}
    }`,
  log: `export const log = { debug() {}, info() {}, warn() {}, error() {} };`,
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((context.parentURL ?? '').endsWith('/web/src/ui/terminal.ts')) {
      const name =
        specifier === '@xterm/xterm'
          ? 'xterm'
          : specifier === '@xterm/addon-fit'
            ? 'fit'
            : specifier === '@xterm/addon-webgl'
              ? 'webgl'
              : specifier === '../ws.ts'
                ? 'ws'
                : specifier === '../log.ts'
                  ? 'log'
                  : undefined;
      if (name !== undefined) return { url: `term-stub:${name}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith('term-stub:')) {
      return { format: 'module', source: STUB_SRC[url.slice('term-stub:'.length)], shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const { TerminalView } = await import('../../web/src/ui/terminal.ts');
type View = InstanceType<typeof TerminalView>;

/** A pane box of `w` x `h` px, attached, as panes.ts hands one to TerminalView. */
function box(w: number, h: number): FakeElement {
  const el = dom.doc.createElement('div');
  size(el, w, h);
  dom.body.append(el);
  return el;
}
function size(el: FakeElement, w: number, h: number): void {
  Object.assign(el, { clientWidth: w, clientHeight: h });
}

const dims: Resize[] = [];
/** A view on `host`, attached to `id`; its onDims calls land in `dims`. */
function attach(host: FakeElement, id: string): View {
  const view = new TerminalView(host as unknown as HTMLElement);
  view.connect(id, {
    onInfo() {},
    onExit() {},
    onAttention() {},
    onConn() {},
    onDims(cols, rows) {
      dims.push({ id, cols, rows });
    },
  });
  return view;
}
/** The server's `info` frame for `id`, as the socket delivers it after an attach. */
function info(id: string, cols: number, rows: number): void {
  const sock = H.sockets.find((s) => s.sessionId === id);
  assert.ok(sock !== undefined, `a socket for ${id}`);
  sock.handlers.onInfo({ id, status: 'running', cols, rows, attention: false });
}
/** The container changed size: the observer fires, then its debounce runs. */
function resizeBox(el: FakeElement, w: number, h: number): void {
  size(el, w, h);
  for (const o of H.observers) if (o.target === el && !o.off) o.cb();
  flushTimers();
}
function flushTimers(): void {
  for (const t of dom.win.timers.splice(0)) t.fn();
}

beforeEach(() => {
  H.resizes.length = 0;
  dims.length = 0;
  flushTimers();
});

test('attached at the PTY’s own size: no resize is sent at all', () => {
  attach(box(800, 460), 'a');
  info('a', 80, 23);
  assert.deepEqual(H.resizes, [], 'the view fit 80x23 at construction, the PTY already is 80x23');
});

test('attached with the PTY at another size: ONE resize, with the view’s own cols/rows', () => {
  attach(box(800, 460), 'b');
  info('b', 100, 30);
  assert.deepEqual(H.resizes, [{ id: 'b', cols: 80, rows: 23 }]);
  assert.deepEqual(dims, [{ id: 'b', cols: 80, rows: 23 }], 'and the app learns the size once');
});

test('a pane whose box changed sends exactly ONE resize with its new size, after the debounce', () => {
  const host = box(800, 460);
  attach(host, 'c');
  info('c', 80, 23);
  size(host, 530, 460);
  for (const o of H.observers) if (o.target === host) o.cb();
  for (const o of H.observers) if (o.target === host) o.cb();
  assert.deepEqual(H.resizes, [], 'nothing before the debounce runs');
  assert.equal(dom.win.timers.length, 1, 'two observer calls arm ONE debounce');
  flushTimers();
  assert.deepEqual(H.resizes, [{ id: 'c', cols: 53, rows: 23 }]);
  assert.deepEqual(dims, [{ id: 'c', cols: 53, rows: 23 }]);
});

test('a box that moved or grew by less than a cell sends nothing', () => {
  const host = box(800, 460);
  attach(host, 'd');
  info('d', 80, 23);
  resizeBox(host, 805, 470);
  assert.deepEqual(H.resizes, [], 'still 80x23: the PTY is not told anything');
});

test('two panes: only the one whose box changed resizes, on its OWN socket', () => {
  const left = box(800, 460);
  const right = box(800, 460);
  attach(left, 'e1');
  attach(right, 'e2');
  info('e1', 80, 23);
  info('e2', 80, 23);
  resizeBox(right, 530, 210);
  assert.deepEqual(H.resizes, [{ id: 'e2', cols: 53, rows: 10 }]);
});

test('a collapsed box is never fit: no resize to nonsense sizes', () => {
  const host = box(800, 460);
  attach(host, 'f');
  info('f', 80, 23);
  resizeBox(host, 0, 0);
  assert.deepEqual(H.resizes, [], 'a hidden pane keeps its size');
  resizeBox(host, 530, 460);
  assert.deepEqual(H.resizes, [{ id: 'f', cols: 53, rows: 23 }], 'and resizes once it is back');
});

test('a disposed view stops observing and drops a pending fit', () => {
  const host = box(800, 460);
  const view = attach(host, 'g');
  info('g', 80, 23);
  size(host, 530, 460);
  for (const o of H.observers) if (o.target === host) o.cb();
  view.dispose();
  assert.equal(dom.win.timers.length, 0, 'the debounce is cleared');
  assert.ok(H.observers.filter((o) => o.target === host).every((o) => o.off), 'the observer is disconnected');
  flushTimers();
  assert.deepEqual(H.resizes, []);
});

// ---------------------------------------------------------------------------
// P3a: the boot order that makes the first fit the final one
// ---------------------------------------------------------------------------

test('boot builds the panes AFTER the chrome has its first content — one resize per pane, not two', () => {
  // The Files panel, the drawers and the tab strip are flex siblings of the
  // grid. A terminal built before they are drawn measures a bigger box and
  // resizes again 55 ms later (P0: 190x48 then 152x46). A source read: the
  // order lives in buildShell, which imports the whole app.
  const shell = functionBody(readSource('web/src/main-shell.ts'), 'export function buildShell(');
  const panes = shell.indexOf('initPanes(grid,');
  assert.notEqual(panes, -1, 'non-vacuity: buildShell builds the panes');
  assert.equal(shell.split('initPanes(').length - 1, 1, 'exactly once');
  for (const first of ['updateChrome();\n  tabs.render();', 'filesPanel.render();\n', 'st.subscribe(() => {']) {
    const at = shell.lastIndexOf(first, panes);
    assert.notEqual(at, -1, `buildShell runs ${first.trim()} before the panes`);
  }
  assert.ok(
    shell.indexOf('st.subscribe(applyScreenLayout);') < panes,
    'the screen layout is still subscribed before the panes (a hidden grid refuses a render)',
  );
  assert.ok(
    shell.lastIndexOf('filesPanel.render();', panes) > shell.lastIndexOf('st.subscribe(() => {', panes),
    'the panes come after the INITIAL chrome render, not merely after its subscription',
  );
});
