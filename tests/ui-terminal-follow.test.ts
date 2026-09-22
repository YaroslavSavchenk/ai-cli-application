/**
 * Part B6 — `Follow output`, and the two xterm-bound doors that read the B6
 * toggles (`.claude/plans/nocturne/PLAN-B6.md`).
 *
 * WHY A SOURCE SCAN. `web/src/ui/terminal.ts` imports `@xterm/xterm` and
 * `web/src/ui/panes.ts` reaches it — a browser bundle that cannot load under
 * `node --test`, with no runtime seam to drive headless. The same idiom
 * `tests/ui-terminal-copy.test.ts` and `tests/ui-pane-a3.test.ts` use applies:
 * the STATEMENTS that make the rule are pinned in the source, and the
 * behaviour in a real pane is verified by hand
 * (`.claude/skills/verify-terminal/SKILL.md`).
 *
 * What is pinned:
 *
 *   1. The follow scroll is in the WRITE CALLBACK of the live-data path, and
 *      it reads the preference FRESH on every write (a flip applies to a
 *      session that is already running, with no reattach).
 *   2. The REPLAY path is untouched: it resets, writes, and clears the replay
 *      flag — and does not scroll on its own, because a reset buffer is at the
 *      bottom already.
 *   3. The exited banner's `End session` is the shared `armButton` primitive
 *      (ui/util.ts) with an `ask` that reads `confirmEnd` at CLICK time —
 *      one arming implementation in the app, not two.
 *   4. That primitive's own `ask` behaviour, driven for real on the DOM
 *      double: no `ask` = the two-step it always was; `ask` answering false
 *      = the act at once, label untouched.
 *
 * The toggle values themselves are `tests/ui-prefs-model.test.ts`'s.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectRoot } from './helpers.ts';
import { installDom, type FakeElement } from './fake-dom.ts';
import { armButton } from '../web/src/ui/util.ts';

const UI = join(projectRoot, 'web', 'src', 'ui');
const TERMINAL = readFileSync(join(UI, 'terminal.ts'), 'utf8');
const PANES = readFileSync(join(UI, 'panes.ts'), 'utf8');
const UTIL = readFileSync(join(UI, 'util.ts'), 'utf8');

/** The statements of one `{ … }` body, comments and blank lines dropped. */
function statements(body: string): string[] {
  return body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('//') && !l.startsWith('*') && !l.startsWith('/*'));
}

/** The body of the socket handler named `name` in terminal.ts. */
function handler(name: string): string {
  const at = TERMINAL.indexOf(`      ${name}: (`);
  assert.notEqual(at, -1, `terminal.ts must still install a ${name} handler`);
  const end = TERMINAL.indexOf('\n      },', at);
  assert.notEqual(end, -1, `${name} must still be one handler block`);
  return TERMINAL.slice(TERMINAL.indexOf('\n', at) + 1, end);
}

test('non-vacuity: the real modules are being read', () => {
  assert.ok(TERMINAL.length > 5000, 'ui/terminal.ts looks empty');
  assert.ok(PANES.length > 5000, 'ui/panes.ts looks empty');
  assert.match(TERMINAL, /import \{ getBehaviour \} from '\.\/prefs-model\.ts';/);
  assert.match(PANES, /import \{ getBehaviour \} from '\.\/prefs-model\.ts';/);
});

test('B6 follow: live data is written with a callback that scrolls only while the switch is on', () => {
  assert.deepEqual(statements(handler('onData')), [
    'this.term.write(data, () => {',
    'if (getBehaviour().followOutput) this.term.scrollToBottom();',
    '});',
  ]);
});

test('B6 follow: the preference is read per WRITE, never cached at connect time', () => {
  // A `const follow = getBehaviour()` hoisted out of the callback would freeze
  // the answer for the life of the view — the flip would then need a reattach.
  const connect = TERMINAL.slice(TERMINAL.indexOf('connect('), TERMINAL.indexOf('onInfo: (session)'));
  const reads = [...connect.matchAll(/getBehaviour\(\)/g)];
  assert.equal(reads.length, 1, 'exactly one read, and it is the one inside the write callback');
  assert.equal(/const\s+\w+\s*=\s*getBehaviour\(\)/.test(TERMINAL), false, 'never stored in a local');
});

test('B6 follow: the replay path is unchanged — reset, write, clear the flag, no scroll of its own', () => {
  const replay = statements(handler('onReplay'));
  assert.deepEqual(replay, [
    'this.term.reset();',
    "if (data !== '') {",
    'this.#replaying = true;',
    'this.term.write(data, () => {',
    'this.#replaying = false;',
    '});',
    '}',
  ]);
  assert.equal(replay.some((l) => l.includes('scrollToBottom')), false);
});

test('B6 confirm: the exited banner is armButton with an ask that reads the preference', () => {
  // ONE arming implementation in the app: the banner does not copy it, it
  // passes the extra question in.
  assert.equal(/function armEnd\(/.test(PANES), false, 'no second arming helper in panes.ts');
  assert.match(
    PANES,
    /import \{[^}]*\barmButton\b[^}]*\} from '\.\/util\.ts';/,
    'panes.ts imports the shared primitive',
  );
  assert.match(
    PANES,
    /armButton\(delBtn, 'Sure\?', \(\) => void killSession\(pay\.id\), \{/,
    'the banner arms through it',
  );
  assert.match(
    PANES,
    /ask: \(\) => getBehaviour\(\)\.confirmEnd,/,
    'and the question it passes in is the preference',
  );
  // The question is asked INSIDE the click listener — not when the banner was
  // built, which would freeze the answer into a banner that stays up for as
  // long as the pane does.
  const m = /export function armButton\(\n(?:.*\n)*?\): void \{([\s\S]*?)\n\}/.exec(UTIL);
  assert.notEqual(m, null, 'util.ts must define the primitive');
  const body = m?.[1] ?? '';
  const listener = body.slice(body.indexOf("btn.addEventListener('click'"));
  assert.ok(listener.includes('if (opts?.ask !== undefined && !opts.ask()) {'), 'off = the act, at once');
  assert.ok(listener.includes("if (btn.dataset.armed === '1') {"), 'on = the armed two-step');
  assert.ok(listener.includes('btn.textContent = confirmLabel;'), 'with the label it was given');
  assert.ok(body.includes('window.setTimeout(disarm, 3000)'), 'and the same 3s it always disarmed after');
});

// ---------------------------------------------------------------------------
// The primitive itself, on the DOM double — the part a source scan cannot see.
// The double's `window.setTimeout` records instead of firing, so an armed
// button stays armed for the length of a test.
// ---------------------------------------------------------------------------

const dom = installDom();

/** A button wired through `armButton`, plus how often its action ran. */
function arm(ask?: () => boolean): { btn: FakeElement; fired: () => number } {
  const btn = dom.doc.createElement('button');
  btn.textContent = 'End session';
  let fired = 0;
  armButton(
    btn as unknown as HTMLButtonElement,
    'Sure?',
    () => {
      fired += 1;
    },
    ask === undefined ? undefined : { ask },
  );
  return { btn, fired: () => fired };
}

test('armButton without an ask is the two-step it always was (the GitHub disconnect)', () => {
  const a = arm();
  a.btn.click();
  assert.equal(a.fired(), 0, 'the first click only arms');
  assert.equal(a.btn.textContent, 'Sure?');
  assert.equal(a.btn.dataset.armed, '1');
  a.btn.click();
  assert.equal(a.fired(), 1);
  assert.equal(a.btn.textContent, 'End session', 'and it disarms back to its own word');
});

test('armButton with ask -> false acts at once, and the label is never touched', () => {
  const a = arm(() => false);
  a.btn.click();
  assert.equal(a.fired(), 1, 'one click, one act');
  assert.equal(a.btn.textContent, 'End session', 'nothing armed, so nothing renamed');
  assert.equal(a.btn.dataset.armed, undefined);
});

test('armButton reads ask at CLICK time, so a flipped preference applies to a live button', () => {
  let confirmEnd = false;
  const a = arm(() => confirmEnd);
  a.btn.click();
  assert.equal(a.fired(), 1, 'off when that click happened');
  confirmEnd = true;
  a.btn.click();
  assert.equal(a.fired(), 1, 'the same button now arms instead');
  assert.equal(a.btn.textContent, 'Sure?');
  a.btn.click();
  assert.equal(a.fired(), 2);
});

test('armButton: a flip to OFF on an ARMED button acts AND puts the button back', () => {
  // The order the user can really produce: confirm ON, one click arms the
  // button, the switch goes off in Settings, the next click acts. The act is
  // the easy half — the button must also stop claiming it is still asking, or
  // it sits there reading `Sure?` over a session that is already gone (and
  // with a 3s timer that will rename it out from under the next render).
  let confirmEnd = true;
  const a = arm(() => confirmEnd);
  a.btn.click();
  assert.equal(a.fired(), 0, 'armed, nothing done yet');
  assert.equal(a.btn.dataset.armed, '1');
  confirmEnd = false;
  a.btn.click();
  assert.equal(a.fired(), 1, 'the click acts, because the question is gone');
  assert.equal(a.btn.dataset.armed, undefined, 'and the button is not left armed');
  assert.equal(a.btn.textContent, 'End session', 'with its own word back');
});
