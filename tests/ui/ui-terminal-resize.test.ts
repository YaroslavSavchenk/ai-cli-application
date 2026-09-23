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
 * resize it is asked to send) and `../log.ts`. `ResizeObserver` and
 * `IntersectionObserver` are global doubles the test fires; the 75 ms debounce is a recorded window timer the
 * test fires — no clock. The boot order lives only in `main-shell.ts`, which
 * imports the whole app, so that one rule is a source read.
 *
 * Why it matters (PROJECT-SCOPE § Hard technical constraints): a pane whose
 * new size never reaches the PTY draws a TUI as garbage; a resize sent twice
 * (P0: 190x48, then 152x46 55 ms later, on every pane at every boot) makes
 * every TUI redraw twice; a resize on the wrong socket garbles a pane the user
 * did not touch.
 *
 * Since P5 the stub WebGL addon also adds a canvas, so the explicit context
 * release on dispose is pinned here too (the seam that makes the live-terminal
 * cap's arithmetic true). Since P5 a view on a tab the user left is hidden (`hide()`) and sends no
 * resize at all; `show()` fits it once, at the container's first intersection
 * report (xterm's renderer is paused until then), and sends at most one.
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
/** A canvas's `getContext` call: which kind was asked, and on which canvas ('xterm' or 'webgl'). */
interface GlCall {
  canvas: string;
  kind: string;
}
const H = {
  resizes: [] as Resize[],
  observers: [] as FakeObserver[],
  sockets: [] as FakeSocket[],
  /** Every getContext asked of a stub canvas, and every loseContext() that followed. */
  getContext: [] as GlCall[],
  lost: [] as string[],
};
(globalThis as unknown as { __termHarness: typeof H }).__termHarness = H;

const g = globalThis as unknown as Record<string, unknown>;
g.getComputedStyle = () => ({ getPropertyValue: () => '' });
(dom.doc as unknown as { documentElement: FakeElement }).documentElement = dom.body;
/** One IntersectionObserver the view made: its callback and the node it watches. */
interface FakeIo {
  cb: (entries: { isIntersecting: boolean }[]) => void;
  target: FakeElement | null;
  off: boolean;
}
const ios: FakeIo[] = [];
g.IntersectionObserver = class {
  readonly rec: FakeIo;
  constructor(cb: FakeIo['cb']) {
    this.rec = { cb, target: null, off: false };
    ios.push(this.rec);
  }
  observe(el: FakeElement): void {
    this.rec.target = el;
  }
  disconnect(): void {
    this.rec.off = true;
  }
};
/** The browser's intersection report for `el` — what tells xterm its renderer may run again. */
function intersect(el: FakeElement, visible: boolean): void {
  for (const o of ios) if (o.target === el && !o.off) o.cb([{ isIntersecting: visible }]);
}
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
    const H = globalThis.__termHarness;
    export class Terminal {
      constructor(options) { this.options = options; this.cols = 80; this.rows = 24; this.el = null; }
      attachCustomKeyEventHandler() {}
      open(el) {
        this.el = el;
        // xterm's own 2d canvas, there before the WebGL addon loads.
        const c = document.createElement('canvas');
        c.getContext = (kind) => { H.getContext.push({ canvas: 'xterm', kind }); return null; };
        el.append(c);
      }
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
    const H = globalThis.__termHarness;
    export class WebglAddon {
      activate(t) {
        const c = document.createElement('canvas');
        const gl = { getExtension: (n) => (n === 'WEBGL_lose_context' ? { loseContext: () => H.lost.push('webgl') } : null) };
        c.getContext = (kind) => { H.getContext.push({ canvas: 'webgl', kind }); return kind === 'webgl2' ? gl : null; };
        t.el.append(c);
      }
      onContextLoss() {}
      dispose() {}
    }`,
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
  H.getContext.length = 0;
  H.lost.length = 0;
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
// P5: a view parked on a hidden tab
// ---------------------------------------------------------------------------

test('a hidden view sends NO resize — not for a 0x0 box, not for a window resize meanwhile', () => {
  const host = box(800, 460);
  const view = attach(host, 'h');
  info('h', 80, 23);
  view.hide();
  resizeBox(host, 0, 0);
  resizeBox(host, 1200, 460); // the window grew while the tab was away
  assert.deepEqual(H.resizes, [], 'nothing reached the PTY while hidden');
});

test('shown again on a box that changed: ONE fit and ONE resize with the new size', () => {
  const host = box(800, 460);
  const view = attach(host, 'i');
  info('i', 80, 23);
  view.hide();
  resizeBox(host, 0, 0);
  size(host, 1200, 460);
  view.show();
  intersect(host, true);
  assert.deepEqual(H.resizes, [{ id: 'i', cols: 120, rows: 23 }], 'at the first report, with no debounce');
  for (const o of H.observers) if (o.target === host) o.cb(); // the observer sees the box come back
  flushTimers();
  assert.deepEqual(H.resizes, [{ id: 'i', cols: 120, rows: 23 }], 'and not a second time');
});

test('shown again on the same box: no resize at all', () => {
  const host = box(800, 460);
  const view = attach(host, 'j');
  info('j', 80, 23);
  view.hide();
  resizeBox(host, 0, 0);
  size(host, 800, 460);
  view.show();
  intersect(host, true);
  resizeBox(host, 800, 460);
  assert.deepEqual(H.resizes, []);
});

test('the PTY resized by another client while hidden: no reconcile until shown, then ONE', () => {
  const host = box(800, 460);
  const view = attach(host, 'k');
  info('k', 80, 23);
  view.hide();
  info('k', 100, 30);
  assert.deepEqual(H.resizes, [], 'a hidden view does not reconcile');
  view.show();
  intersect(host, true);
  assert.deepEqual(H.resizes, [{ id: 'k', cols: 80, rows: 23 }], 'shown: the PTY gets this view’s size, once');
});

test('show() fits NOTHING until the container is reported visible — the gap where xterm’s renderer is still paused', () => {
  // A fit in that gap reflows the buffer while the renderer keeps its old
  // dimensions; the scrollbar then clamps the view (old rows − new rows) lines
  // above the bottom and `top` draws under stale rows for good (P5 verify).
  const host = box(800, 460);
  const view = attach(host, 'm');
  info('m', 80, 23);
  view.hide();
  resizeBox(host, 0, 0);
  size(host, 1200, 460);
  view.show();
  for (const o of H.observers) if (o.target === host) o.cb();
  flushTimers(); // the ResizeObserver's debounce runs inside the gap
  intersect(host, false);
  assert.deepEqual(H.resizes, [], 'no fit before the node is reported visible');
  intersect(host, true);
  assert.deepEqual(H.resizes, [{ id: 'm', cols: 120, rows: 23 }], 'one resize once it is');
  intersect(host, true);
  resizeBox(host, 1200, 460);
  assert.equal(H.resizes.length, 1, 'a later report or observer call adds nothing');
});

test('a visible view ignores intersection reports: only show() arms the deferred fit', () => {
  const host = box(800, 460);
  attach(host, 'n');
  info('n', 80, 23);
  size(host, 1200, 460);
  intersect(host, true);
  assert.deepEqual(H.resizes, [], 'a report alone never fits (the ResizeObserver path does that)');
});

test('without IntersectionObserver xterm never pauses, so show() fits at once', () => {
  const saved = g.IntersectionObserver;
  delete g.IntersectionObserver;
  try {
    const host = box(800, 460);
    const view = attach(host, 'o');
    info('o', 80, 23);
    view.hide();
    size(host, 1200, 460);
    view.show();
    assert.deepEqual(H.resizes, [{ id: 'o', cols: 120, rows: 23 }]);
  } finally {
    g.IntersectionObserver = saved;
  }
});

test('dispose disconnects the intersection watch', () => {
  const host = box(800, 460);
  attach(host, 'p').dispose();
  assert.ok(ios.filter((o) => o.target === host).every((o) => o.off));
});

test('dispose releases the WebGL context at once, asking ONLY the addon’s own canvas', () => {
  // addon-webgl 0.19 only removes its canvas; the context would count toward
  // Chromium's ~16 until a GC, and MAX_LIVE_TERMINALS (P5) assumes an evicted
  // terminal frees its own. getContext on another canvas could CREATE one.
  const view = attach(box(800, 460), 'l');
  assert.deepEqual(H.lost, [], 'nothing released while the view lives');
  view.dispose();
  assert.deepEqual(H.lost, ['webgl'], 'loseContext() once, on dispose');
  assert.deepEqual(H.getContext, [{ canvas: 'webgl', kind: 'webgl2' }], 'xterm’s own canvas is never asked');
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
