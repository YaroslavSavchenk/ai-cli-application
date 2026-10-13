/**
 * `restoreFocus` and `setFocusFallback` in `web/src/ui/util.ts` (Nocturne D4,
 * `.claude/plans/PLAN-NOCTURNE.md` § D4) — the one rule every dialog, menu and
 * overlay uses to hand the keyboard back when it closes — and the shared
 * `ModalSlot` (folder picker, delete confirmation, project editor) that goes
 * through it.
 *
 * How: the REAL module on the DOM double in `tests/helpers/fake-dom.ts`; the
 * "terminal" is a plain element whose focus the injected fallback records.
 * The per-dialog wiring is pinned where each dialog is already driven:
 * `ui-launch-dialog.test.ts`, `ui-addproject-dom.test.ts`,
 * `ui-settings-panel.test.ts`, `ui-a8-shortcuts-dom.test.ts`.
 *
 * Why it matters: a dialog opened with nothing focused (a click on empty
 * chrome, a chord) records `<body>` as its opener. Focusing `<body>` back is a
 * no-op, so after the close every typed key reached no PTY until the next
 * window activation — silently, nothing on screen says the keyboard is lost.
 *
 * NOT claimed: real browser focus policy (`display: none` from a stylesheet,
 * what `focus()` refuses) — the double models `hidden` and `offsetParent`
 * only. The live check is `.claude/skills/verify-terminal/SKILL.md`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, type FakeElement } from '../helpers/fake-dom.ts';
import { readSource } from '../helpers/helpers.ts';

const dom = installDom();

const U = (await import(new URL('../../web/src/ui/util.ts', import.meta.url).href)) as {
  restoreFocus(target: unknown, opts?: { fallback?: () => void; last?: unknown }): void;
  setFocusFallback(fn: () => void): void;
  ModalSlot: new () => { hold(scrim: unknown, restore: unknown): void; close(): void; isOpen(): boolean };
};

const terminal = dom.doc.createElement('textarea');
const opener = dom.doc.createElement('button');
dom.body.append(terminal, opener);

let fallbackCalls = 0;
const inject = (): void => {
  U.setFocusFallback(() => {
    fallbackCalls += 1;
    terminal.focus();
  });
};

/** Put the keyboard nowhere — where a click on empty chrome leaves it. */
function blurAll(): void {
  dom.doc.activeElement = dom.body;
}

// Runs FIRST, on purpose: before any test injects a fallback.
test('with no fallback injected an unusable target is a quiet no-op, never a throw', () => {
  blurAll();
  assert.doesNotThrow(() => U.restoreFocus(dom.body));
  assert.doesNotThrow(() => U.restoreFocus(null));
  assert.equal(dom.doc.activeElement, dom.body, 'nothing took the keyboard');
});

test('a target still on screen gets the keyboard back and the fallback never runs', () => {
  inject();
  blurAll();
  const before = fallbackCalls;
  U.restoreFocus(opener);
  assert.equal(dom.doc.activeElement, opener);
  assert.equal(fallbackCalls - before, 0, 'a real restore target never reaches the fallback');
});

test('every target that cannot take the keyboard sends it to the fallback (the terminal)', () => {
  inject();
  const gone = dom.doc.createElement('button');
  const shut = dom.doc.createElement('div');
  const inside = dom.doc.createElement('button');
  shut.append(inside);
  dom.body.append(shut);
  shut.hidden = true;
  const self = dom.doc.createElement('button');
  dom.body.append(self);
  self.hidden = true;
  const cases: [string, FakeElement | null][] = [
    ['<body>', dom.body],
    ['null', null],
    ['a detached element', gone],
    ['an element inside a hidden dialog', inside],
    ['a hidden element', self],
  ];
  for (const [what, target] of cases) {
    blurAll();
    const before = fallbackCalls;
    U.restoreFocus(target);
    assert.equal(fallbackCalls - before, 1, `${what}: the fallback ran exactly once`);
    assert.equal(dom.doc.activeElement, terminal, `${what}: the terminal has the keyboard`);
  }
});

// The double makes `offsetParent` null exactly when an element is detached or
// under a hidden ancestor, so the three guards overlap there. A real browser
// splits them: CSS `display: none` (no `hidden` anywhere) has no box, and a
// stylesheet that overrides `[hidden]` leaves a box under a hidden ancestor.
// Each case below is caught by ONE guard only.
test('a connected, unhidden element with no box (CSS display: none) is refused', () => {
  inject();
  const boxless = dom.doc.createElement('button');
  dom.body.append(boxless);
  Object.defineProperty(boxless, 'offsetParent', { get: () => null });
  blurAll();
  const before = fallbackCalls;
  U.restoreFocus(boxless);
  assert.equal(fallbackCalls - before, 1, 'only the offsetParent guard sees this one');
  assert.equal(dom.doc.activeElement, terminal);
});

test('an element under a hidden ancestor is refused even when it still reports a box', () => {
  inject();
  const shut = dom.doc.createElement('div');
  const inside = dom.doc.createElement('button');
  shut.append(inside);
  dom.body.append(shut);
  shut.hidden = true;
  Object.defineProperty(inside, 'offsetParent', { get: () => dom.body });
  blurAll();
  const before = fallbackCalls;
  U.restoreFocus(inside);
  assert.equal(fallbackCalls - before, 1, "only the closest('[hidden]') guard sees this one");
  assert.equal(dom.doc.activeElement, terminal);
});

test('the shell injects the focused pane as the fallback, once, at boot', () => {
  // main-shell.ts imports @xterm/xterm through ui/panes.ts and cannot be loaded
  // here. Without this line every dialog's fallback is the no-op default.
  const shell = readSource('web', 'src', 'main-shell.ts');
  assert.match(
    shell,
    /import \{[^}]*\bsetFocusFallback\b[^}]*\} from '\.\/ui\/util\.ts';/,
    'main-shell.ts imports the setter from ui/util.ts',
  );
  assert.equal(
    shell.split('setFocusFallback(requestTerminalFocus);').length - 1,
    1,
    'buildShell hands it requestTerminalFocus exactly once',
  );
  assert.equal(shell.split('setFocusFallback(').length - 1, 1, 'and nothing else sets it');
  const start = shell.indexOf('export function buildShell(');
  const end = shell.indexOf('\n}\n', start);
  const at = shell.indexOf('setFocusFallback(requestTerminalFocus);');
  assert.ok(start !== -1 && start < at && at < end, 'the call sits inside buildShell, which every boot runs');
});

test('an explicit fallback replaces the injected one', () => {
  inject();
  blurAll();
  const before = fallbackCalls;
  let own = 0;
  U.restoreFocus(dom.body, { fallback: () => (own += 1) });
  assert.equal(own, 1, 'the caller’s fallback ran');
  assert.equal(fallbackCalls - before, 0, 'the injected one did not');
});

test('`last` takes the keyboard only when neither the target nor the fallback did', () => {
  U.setFocusFallback(() => {}); // no session on screen: the pane takes nothing
  blurAll();
  U.restoreFocus(dom.body, { last: opener });
  assert.equal(dom.doc.activeElement, opener, 'nothing took it, so the last resort did');
  inject();
  blurAll();
  U.restoreFocus(dom.body, { last: opener });
  assert.equal(dom.doc.activeElement, terminal, 'a pane took it, so the last resort stays out');
});

test('the shared modal slot opened with nothing focused hands the keyboard to the terminal on close', () => {
  inject();
  const slot = new U.ModalSlot();
  const scrim = dom.doc.createElement('div');
  const card = dom.doc.createElement('button');
  scrim.append(card);
  dom.body.append(scrim);
  blurAll();
  slot.hold(scrim, dom.doc.activeElement);
  card.focus();
  slot.close();
  assert.equal(slot.isOpen(), false);
  assert.equal(scrim.isConnected, false, 'the card left the page');
  assert.equal(dom.doc.activeElement, terminal, 'not <body>: the typed keys reach the PTY');
});

test('the shared modal slot still gives the keyboard back to a real opener', () => {
  inject();
  const slot = new U.ModalSlot();
  const scrim = dom.doc.createElement('div');
  dom.body.append(scrim);
  opener.focus();
  slot.hold(scrim, opener);
  const before = fallbackCalls;
  slot.close();
  assert.equal(dom.doc.activeElement, opener);
  assert.equal(fallbackCalls - before, 0);
});
