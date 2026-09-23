/**
 * Shared by the `web/src/ui/panes.ts` DOM tests (`tests/ui/ui-panes-relayout.test.ts`,
 * Quality P2, and `tests/ui/ui-panes-park.test.ts`, Quality P5): the REAL
 * panes.ts on the DOM double, with `registerHooks` swapping the five imports
 * that cannot run here for recorders — `./terminal.ts` (xterm is a browser
 * bundle; the stub TerminalView records construct, attach, focus, hide, show,
 * seen and dispose, and keeps the events panes.ts handed it so a test can play
 * a server frame), `../api.ts` (records `markSeen`), `./dnd.ts`,
 * `./editor-pane.ts` and `./panes-status.ts` (the header readout, which these
 * files do not judge). Lifted out of the relayout test when P5 needed the same
 * harness (tests/README.md: shared setup lives in a fixture). Not a test.
 */
import { registerHooks } from 'node:module';
import type { SessionInfo } from '../../shared/protocol.ts';
import { installDom, type FakeElement } from './fake-dom.ts';
import { st, activeTab } from './ui-state-fixture.ts';

export const dom = installDom();
// The double has no window focus; the panes' acks ask for it. A test flips it.
export const focus = { window: true };
(dom.doc as unknown as { hasFocus(): boolean }).hasFocus = () => focus.window;

/** The events panes.ts gives a TerminalView on connect — a server frame, played by a test. */
export interface FakeEvents {
  onInfo(session: SessionInfo): void;
  onAttention(): void;
}

/** One stub TerminalView, as panes.ts built it. */
export interface FakeView {
  container: FakeElement;
  id: string | null;
  events: FakeEvents | null;
  disposed: boolean;
  focusCalls: number;
  hides: number;
  shows: number;
  seen: number;
}
/** Everything the stubs record; `reset()` empties it between tests. */
export const H = {
  views: [] as FakeView[],
  /** Session ids `api.markSeen` was called with. */
  markSeen: [] as string[],
  reset(): void {
    H.views.length = 0;
    H.markSeen.length = 0;
    focus.window = true;
  },
};
(globalThis as unknown as { __panesHarness: typeof H }).__panesHarness = H;

const STUB_SRC: Record<string, string> = {
  terminal: `
    const H = globalThis.__panesHarness;
    export class TerminalView {
      constructor(container) {
        this.container = container; this.id = null; this.events = null; this.disposed = false;
        this.focusCalls = 0; this.hides = 0; this.shows = 0; this.seen = 0;
        H.views.push(this);
      }
      connect(id, events) { this.id = id; this.events = events; }
      proposeDims() { return { cols: 80, rows: 24 }; }
      focus() { this.focusCalls++; this.container.focus(); }
      hide() { this.hides++; }
      show() { this.shows++; }
      sendSeen() { this.seen++; }
      dispose() { this.disposed = true; }
    }`,
  api: `
    const H = globalThis.__panesHarness;
    export async function markSeen(id) { H.markSeen.push(id); }`,
  dnd: `export function armDrag() {}`,
  'editor-pane': `
    export function editorPane() { return { update() {}, focus() {}, holdsFocus() { return false; }, dispose() {} }; }`,
  'panes-status': `
    export async function killSession() {}
    export function updateHeader() {}
    export function updateNote() {}
    export function updateStatus() {}`,
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((context.parentURL ?? '').endsWith('/web/src/ui/panes.ts')) {
      const m = /^(?:\.\.\/(api)|\.\/(terminal|dnd|editor-pane|panes-status))\.ts$/.exec(specifier);
      const name = m?.[1] ?? m?.[2];
      if (name !== undefined) return { url: `panes-stub:${name}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith('panes-stub:')) {
      return { format: 'module', source: STUB_SRC[url.slice('panes-stub:'.length)], shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

export const P = await import('../../web/src/ui/panes.ts');
export const grid = dom.doc.createElement('div');
dom.body.append(grid);
P.initPanes(grid as unknown as HTMLElement, () => {});

export type View = ReturnType<typeof activeTab>;

/** The active tab holding `ids` (one tab per id in `others`), drawn. */
export function tab(ids: string[], others: string[] = []): View {
  const v = activeTab(ids, others);
  st.notify('ui');
  return v;
}

export const cards = (): FakeElement[] =>
  grid.children.filter((n): n is FakeElement => (n as FakeElement).classList?.contains('pane') === true);
export const dividers = (): FakeElement[] =>
  grid.children.filter((n): n is FakeElement => (n as FakeElement).classList?.contains('divider') === true);
export const live = (): FakeView[] => H.views.filter((x) => !x.disposed);

/** The live terminal of every session, by id — the identity a relayout must keep. */
export function terminals(): Map<string, FakeView> {
  return new Map(live().map((x) => [x.id as string, x]));
}
