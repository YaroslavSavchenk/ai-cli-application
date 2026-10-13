/**
 * Nocturne D6 phase 3 — the pane's exited banner on an early exit
 * (`web/src/ui/panes-status.ts` `updateNote`; `.claude/plans/nocturne/PLAN-D6.md`
 * § What the user gets, last bullet).
 *
 * A Claude launch that died right after it started says `Claude Code stopped
 * right after it started` plus Claude Code's own first line — as TEXT, never
 * markup — and keeps `Start it again` / `End session`. Without `early` the
 * banner is the old `Finished, code N`. The line comes from the exit frame
 * (`pay.early`, a live exit) or from `SessionInfo.earlyExit` (a pane attached
 * to an already-exited session).
 *
 * `./panes.ts` (it reaches @xterm/xterm), `../api.ts`, `../state.ts`,
 * `../log.ts`, `./history.ts` and `./statusline.ts` are stubbed for
 * panes-status.ts; the text rules are the model's
 * (`tests/ui/ui-claude-notice-model.test.ts`).
 *
 * NOT claimed: the banner's real layout (one row, ellipsis, the `title`
 * tooltip) in a browser — the fake DOM has no CSS; that the server sends
 * `early` / `earlyExit` (tests/server/sessions-early-exit.test.ts); a real
 * xterm pane around it. Checked by `.claude/skills/verify-terminal/SKILL.md`
 * (pane banner on an early exit).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import type { EarlyExit } from '../../shared/protocol.ts';
import { byClass, installDom, type FakeElement } from '../helpers/fake-dom.ts';
import { FakeText } from '../helpers/fake-dom-element.ts';

const dom = installDom();

const H = { sessions: new Map<string, { earlyExit?: EarlyExit }>() };
(globalThis as unknown as Record<string, unknown>).__peHarness = H;

const STUB_SRC: Record<string, string> = {
  api: `
    export class ApiError extends Error {}
    export async function deleteSession() {}
    export async function getHistory() { return []; }`,
  state: `
    const H = globalThis.__peHarness;
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
      if (m !== null) return { url: `pe-stub:${m[1] as string}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith('pe-stub:')) {
      return { format: 'module', source: STUB_SRC[url.slice('pe-stub:'.length)], shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

interface Pay {
  id: string;
  dead: boolean;
  exitCode: number | null;
  early: EarlyExit | null;
}
interface PanesStatusModule {
  updateNote(s: { note: unknown }, pay: Pay): void;
}

// A computed specifier: the typechecker must not walk the browser import graph
// under the server tsconfig (web/tsconfig.json owns that).
const PS = (await import(new URL('../../web/src/ui/panes-status.ts', import.meta.url).href)) as PanesStatusModule;

/** Paint a banner for this exit and hand back its strip. */
function banner(exitCode: number, early: EarlyExit | null, id = 's1'): FakeElement {
  const note = dom.doc.createElement('div');
  PS.updateNote({ note }, { id, dead: false, exitCode, early });
  return note;
}
const labels = (note: FakeElement): string[] => byClass(note, 'pane-note-btn').map((b) => b.textContent);

test('without `early` the banner is the old one, unchanged', () => {
  const note = banner(2, null);
  assert.equal(note.hidden, false);
  assert.equal(note.className, 'pane-note is-exit-err');
  assert.deepEqual(
    byClass(note, 'pane-note-text').map((n) => n.textContent),
    ['Finished, code 2'],
  );
  assert.equal(byClass(note, 'pane-note-line').length, 0);
  assert.deepEqual(labels(note), ['Start it again', 'End session']);
  assert.equal(byClass(banner(0, null), 'pane-note-text')[0]?.textContent, 'Finished, code 0');
});

test('with `early` the banner says Claude Code stopped right after it started, plus its line', () => {
  const note = banner(1, { line: "error: unknown option '--session-id'" });
  assert.equal(note.className, 'pane-note is-exit-err');
  assert.equal(byClass(note, 'pane-note-text')[0]?.textContent, 'Claude Code stopped right after it started:');
  const line = byClass(note, 'pane-note-line')[0] as FakeElement;
  assert.equal(line.textContent, "error: unknown option '--session-id'");
  assert.equal(line.title, "error: unknown option '--session-id'", 'the whole line on hover');
  assert.deepEqual(labels(note), ['Start it again', 'End session'], 'the existing buttons stay');
  // Order: lead, line, then the buttons.
  assert.deepEqual(
    note.children.map((c) => (c as FakeElement).className),
    ['pane-note-text', 'pane-note-line', 'pane-note-btn is-primary', 'pane-note-btn'],
  );
});

test('the line is rendered as TEXT: markup in it stays characters, never elements', () => {
  const evil = '<img src=x onerror=alert(1)><b>bold</b>';
  const note = banner(1, { line: evil });
  const line = byClass(note, 'pane-note-line')[0] as FakeElement;
  assert.equal(line.textContent, evil);
  // One text node and nothing else: no element was parsed out of the line.
  assert.equal(line.children.length, 1);
  assert.ok(line.children[0] instanceof FakeText, 'the line is a text node, not markup');
});

test('an early exit that printed nothing: the lead alone', () => {
  const note = banner(1, { line: '' });
  assert.equal(byClass(note, 'pane-note-text')[0]?.textContent, 'Claude Code stopped right after it started');
  assert.equal(byClass(note, 'pane-note-line').length, 0);
});

test('a pane attached later reads SessionInfo.earlyExit', () => {
  H.sessions.set('s9', { earlyExit: { line: 'error: boom' } });
  const note = banner(1, null, 's9');
  assert.equal(byClass(note, 'pane-note-text')[0]?.textContent, 'Claude Code stopped right after it started:');
  assert.equal(byClass(note, 'pane-note-line')[0]?.textContent, 'error: boom');
  H.sessions.clear();
});
