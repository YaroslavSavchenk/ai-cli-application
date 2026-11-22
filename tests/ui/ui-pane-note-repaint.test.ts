/**
 * `web/src/ui/panes-status.ts` `updateNote` — the exited / lost banner is
 * rebuilt only when what it SHOWS changes (Quality Q9). The 3 s session poll
 * calls it for every slot; before the guard each poll replaced the banner, so
 * an armed `End session → Sure?` (Confirm before ending a session ON, 3 s
 * window) was swapped for a fresh unarmed button within ≤3 s and the keyboard
 * on `Start it again` fell back to the body.
 *
 * Seam: the real panes-status.ts on the shared DOM double with the real
 * `ui/util.ts` armButton and `ui/prefs-model.ts`; `./panes.ts` (it reaches
 * @xterm/xterm), `../api.ts`, `../state.ts`, `../log.ts`, `./history.ts` and
 * `./statusline.ts` are stubbed, as in `tests/ui/ui-pane-early-exit.test.ts`.
 *
 * NOT claimed: the real 3 s poll wiring in `panes.ts` (it cannot be imported
 * here; the call site is `onStateChange('sessions')`), or browser focus rings.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import type { EarlyExit } from '../../shared/protocol.ts';
import { byClass, installDom, type FakeElement } from '../helpers/fake-dom.ts';

const dom = installDom();

const H = { sessions: new Map<string, { earlyExit?: EarlyExit }>() };
(globalThis as unknown as Record<string, unknown>).__pnHarness = H;

const STUB_SRC: Record<string, string> = {
  api: `
    export class ApiError extends Error {}
    export async function deleteSession() {}
    export async function getHistory() { return []; }`,
  state: `
    const H = globalThis.__pnHarness;
    export const state = { get sessions() { return H.sessions; }, history: [] };
    export function projectName() { return null; }
    export function removeSessionEverywhere() {}`,
  log: `
    const noop = () => {};
    export const log = { debug: noop, info: noop, warn: noop, error: noop };`,
  panes: `
    export const renderedCount = 1;
    export const renderedViewId = 'v1';
    export function requestTerminalFocus() {}`,
  history: `export function scheduleHistoryRefresh() {}`,
  statusline: `export function flash() {}`,
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((context.parentURL ?? '').endsWith('/web/src/ui/panes-status.ts')) {
      const m = /^\.\.?\/(api|state|log|panes|history|statusline)\.ts$/.exec(specifier);
      if (m !== null) return { url: `pn-stub:${m[1] as string}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith('pn-stub:')) {
      return { format: 'module', source: STUB_SRC[url.slice('pn-stub:'.length)], shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

interface Pay {
  id: string;
  dead: boolean;
  exitCode: number | null;
  early: EarlyExit | null;
  noteSig: string;
}
interface PanesStatusModule {
  updateNote(s: { note: unknown }, pay: Pay): void;
}
interface PrefsModule {
  setBehaviour(next: { confirmEnd?: boolean }): void;
}

const PS = (await import(new URL('../../web/src/ui/panes-status.ts', import.meta.url).href)) as PanesStatusModule;
const P = (await import(new URL('../../web/src/ui/prefs-model.ts', import.meta.url).href)) as PrefsModule;

afterEach(() => {
  P.setBehaviour({});
  dom.win.timers.length = 0;
  H.sessions.clear();
});

/** A slot whose banner sits in the document, and the session payload it shows. */
function slot(exitCode: number | null): { s: { note: FakeElement }; pay: Pay } {
  const note = dom.doc.createElement('div');
  dom.body.append(note);
  return { s: { note }, pay: { id: 's1', dead: false, exitCode, early: null, noteSig: '\u0000' } };
}
const buttons = (note: FakeElement): FakeElement[] => byClass(note, 'pane-note-btn');

test('an unchanged poll keeps an armed End session armed — the same button, still Sure?', () => {
  P.setBehaviour({ confirmEnd: true });
  const { s, pay } = slot(1);
  PS.updateNote(s, pay);
  const end = buttons(s.note)[1] as FakeElement;
  assert.equal(end.textContent, 'End session');
  end.click();
  assert.equal(end.dataset.armed, '1', 'non-vacuity: the first click armed it');

  PS.updateNote(s, pay); // the 3 s sessions poll, nothing changed
  const after = buttons(s.note)[1] as FakeElement;
  assert.equal(after, end, 'the banner was not rebuilt');
  assert.equal(after.dataset.armed, '1');
  assert.equal(after.textContent, 'Sure?');
});

test('an unchanged poll keeps the keyboard on Start it again', () => {
  const { s, pay } = slot(0);
  PS.updateNote(s, pay);
  const again = buttons(s.note)[0] as FakeElement;
  again.focus();
  assert.equal(dom.doc.activeElement, again, 'non-vacuity');
  PS.updateNote(s, pay);
  // The double's replaceChildren does not move activeElement the way a browser
  // drops focus from a removed node, so what is pinned is that the focused
  // button is still THE one in the banner — not a detached orphan.
  assert.equal(dom.doc.activeElement, again);
  assert.ok(s.note.contains(dom.doc.activeElement), 'focus stays on a button that is still on screen');
  assert.equal(buttons(s.note)[0], again);
});

test('a change in what the banner says does rebuild it', () => {
  const { s, pay } = slot(1);
  PS.updateNote(s, pay);
  const first = buttons(s.note)[0];
  // The session's early-exit line arrives with the list (a pane attached later).
  H.sessions.set('s1', { earlyExit: { line: 'error: boom' } });
  PS.updateNote(s, pay);
  assert.notEqual(buttons(s.note)[0], first, 'new text, new banner');
  assert.equal(byClass(s.note, 'pane-note-line')[0]?.textContent, 'error: boom');

  // Exit code changes the banner too; dead replaces it; alive hides it.
  pay.exitCode = 2;
  PS.updateNote(s, pay);
  assert.equal(s.note.className, 'pane-note is-exit-err');
  pay.dead = true;
  PS.updateNote(s, pay);
  assert.equal(s.note.className, 'pane-note is-dead');
  assert.deepEqual(buttons(s.note).map((b) => b.textContent), ['Close pane']);
  pay.dead = false;
  pay.exitCode = null;
  PS.updateNote(s, pay);
  assert.equal(s.note.hidden, true);
  pay.exitCode = 1;
  PS.updateNote(s, pay);
  assert.equal(s.note.hidden, false, 'an exit after a hidden banner paints again');
  assert.deepEqual(buttons(s.note).map((b) => b.textContent), ['Start it again', 'End session']);
});
