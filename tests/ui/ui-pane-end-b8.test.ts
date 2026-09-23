/**
 * Nocturne part B8, phase 1 — the End session button in a SESSION pane's
 * header (`.claude/plans/nocturne/PLAN-B8.md` § What the user gets, item 1;
 * user's decision 2026-09-22), and the `.dot.is-attn` reduced-motion opt-out.
 *
 * The button's BEHAVIOUR lives in `web/src/ui/pane-end.ts` and is driven here
 * for real on the shared DOM double, against the real `ui/util.ts` armButton,
 * `ui/prefs-model.ts` and `ui/dnd.ts`:
 *
 *   1. It is an icon button with a spoken name: `End session`, the Phosphor
 *      X, no text of its own.
 *   2. `Confirm before ending a session` OFF — one click ends, once.
 *   3. ON — the first click arms (`Sure?`, the name follows the word), the
 *      second ends; an armed button that times out gets its glyph and its name
 *      back.
 *   4. A press on it — on the button or on the glyph inside it — never starts
 *      the header's pane drag, while a press on the header itself still does.
 *
 * WHERE it sits is a source scan: `ui/panes.ts` reaches @xterm/xterm and
 * cannot be imported under `node --test` (see tests/ui/ui-pane-a10.test.ts). What
 * is pinned there is that every session pane builds it — unconditionally, so a
 * one-pane tab has it as much as a split — last in the header, wired to the
 * one kill path, and that an editor pane never does.
 *
 * Looks (ink, hover, armed width) stay a browser check.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectRoot } from '../helpers/helpers.ts';
import { dispatch, installDom, type FakeElement } from '../helpers/fake-dom.ts';

const dom = installDom();

interface PaneEndModule {
  END_SESSION: string;
  endSessionButton(end: () => void): FakeElement;
}
interface PrefsModule {
  setBehaviour(next: { confirmEnd?: boolean }): void;
}
interface DndModule {
  armDrag(source: unknown, ignore: string | null, makeSpec: () => Record<string, unknown> | null): void;
  isDragging(): boolean;
}

const PE = (await import(new URL('../../web/src/ui/pane-end.ts', import.meta.url).href)) as PaneEndModule;
const P = (await import(new URL('../../web/src/ui/prefs-model.ts', import.meta.url).href)) as PrefsModule;
const DND = (await import(new URL('../../web/src/ui/dnd.ts', import.meta.url).href)) as DndModule;

const UI = join(projectRoot, 'web', 'src', 'ui');
const read = (p: string): string => readFileSync(p, 'utf8');
/** Source with comments removed — a comment may DISCUSS what code may not do. */
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const PANES_CODE = code(read(join(UI, 'panes.ts')));
const APP_CSS = read(join(projectRoot, 'web', 'src', 'styles', 'app.css'));

/** The body of a named function, from its signature to the next top-level `}`. */
function fn(src: string, signature: string): string {
  const at = src.indexOf(signature);
  assert.notEqual(at, -1, `non-vacuity: ${signature} was not found`);
  const end = src.indexOf('\n}', at);
  assert.notEqual(end, -1, `non-vacuity: ${signature} has no end`);
  return src.slice(at, end + 2);
}

afterEach(() => {
  P.setBehaviour({}); // the factory setting: confirm ON
  dom.win.timers.length = 0;
});

function make(): { btn: FakeElement; ended: string[] } {
  const ended: string[] = [];
  const btn = PE.endSessionButton(() => ended.push('end'));
  dom.body.append(btn);
  return { btn, ended };
}

const glyph = (btn: FakeElement): FakeElement | undefined =>
  btn.children.find((c): c is FakeElement => (c as FakeElement).svgns === true);

// ---------------------------------------------------------------------------
// 1. What it is
// ---------------------------------------------------------------------------

test('an icon button named End session: aria-label and title, the X glyph, no text', () => {
  const { btn } = make();
  assert.equal(btn.tagName, 'BUTTON');
  assert.equal(btn.type, 'button', 'never a submit');
  assert.equal(btn.className, 'pane-end');
  assert.equal(PE.END_SESSION, 'End session');
  assert.equal(btn.getAttribute('aria-label'), 'End session');
  assert.equal(btn.title, 'End session');
  assert.equal(btn.textContent, '', 'the name is the aria-label, not a glyph read out as text');
  const svg = glyph(btn);
  assert.ok(svg, 'the Phosphor X is inside');
  assert.equal(svg.getAttribute('aria-hidden'), 'true', 'the glyph is decoration');
  const path = svg.children[0] as FakeElement;
  assert.match(path.getAttribute('d') ?? '', /^M205\.66,194\.34a8,8,0,0,1-11\.32,11\.32L128,139\.31/);
  assert.notEqual(btn.tabIndex, -1, 'keyboard-reachable');
});

// ---------------------------------------------------------------------------
// 2 + 3. The confirm setting, read at click time
// ---------------------------------------------------------------------------

test('confirm OFF: one click ends the session, once, and nothing arms', () => {
  P.setBehaviour({ confirmEnd: false });
  const { btn, ended } = make();
  btn.click();
  assert.deepEqual(ended, ['end']);
  assert.equal(btn.dataset.armed, undefined);
  assert.ok(glyph(btn), 'the glyph stays');
  assert.equal(btn.getAttribute('aria-label'), 'End session');
});

test('confirm ON: the first click arms (Sure?), the second ends — once', () => {
  const { btn, ended } = make();
  btn.click();
  assert.deepEqual(ended, [], 'the first click only arms');
  assert.equal(btn.dataset.armed, '1');
  assert.equal(btn.textContent, 'Sure?', 'the one armed word every armButton uses');
  assert.equal(
    btn.getAttribute('aria-label'),
    null,
    'while armed the visible word is the name — the aria-label would still say End session',
  );
  btn.click();
  assert.deepEqual(ended, ['end']);
  assert.equal(btn.dataset.armed, undefined);
  assert.ok(glyph(btn), 'disarmed, the glyph is back');
  assert.equal(btn.textContent, '');
  assert.equal(btn.getAttribute('aria-label'), 'End session', 'and so is the name');
});

test('confirm ON: the switch is read at CLICK time — a flip reaches a button already built', () => {
  const { btn, ended } = make();
  P.setBehaviour({ confirmEnd: false });
  btn.click();
  assert.deepEqual(ended, ['end'], 'built while ON, clicked while OFF: one click');
});

test('an armed button that times out gets its glyph and its name back, and ends nothing', () => {
  const { btn, ended } = make();
  btn.click();
  assert.equal(btn.dataset.armed, '1');
  const t = dom.win.timers.find((x) => x.ms === 3000);
  assert.ok(t, 'the 3 s disarm timer is pending');
  t.fn();
  assert.deepEqual(ended, []);
  assert.equal(btn.dataset.armed, undefined);
  assert.ok(glyph(btn));
  assert.equal(btn.getAttribute('aria-label'), 'End session');
  btn.click();
  assert.deepEqual(ended, [], 'after a timeout the next click arms again');
});

test('armButton on a TEXT button still restores its word (the exited banner, github Disconnect)', async () => {
  const U = (await import(new URL('../../web/src/ui/util.ts', import.meta.url).href)) as {
    button(cls: string, label: string): FakeElement;
    armButton(b: FakeElement, confirm: string, action: () => void): void;
  };
  const b = U.button('pane-note-btn', 'End session');
  let n = 0;
  U.armButton(b, 'Sure?', () => (n += 1));
  b.click();
  assert.equal(b.textContent, 'Sure?');
  b.click();
  assert.equal(n, 1);
  assert.equal(b.textContent, 'End session');
  assert.equal(b.getAttribute('aria-label'), null, 'no name was invented for a button that had none');
});

test('armButton on a TEXT button: a timeout gives its word back, and invents no name', async () => {
  // The exited banner's End session and the GitHub Disconnect are text
  // buttons: the B8 childNodes restore must bring their word back on the
  // 3 s disarm as well as on the acting click.
  const U = (await import(new URL('../../web/src/ui/util.ts', import.meta.url).href)) as {
    button(cls: string, label: string): FakeElement;
    armButton(b: FakeElement, confirm: string, action: () => void): void;
  };
  const b = U.button('gh-mini', 'Disconnect');
  let n = 0;
  U.armButton(b, 'Confirm disconnect', () => (n += 1));
  b.click();
  assert.equal(b.textContent, 'Confirm disconnect');
  const t = dom.win.timers.find((x) => x.ms === 3000);
  assert.ok(t, 'the 3 s disarm timer is pending');
  t.fn();
  assert.equal(n, 0, 'a timeout acts on nothing');
  assert.equal(b.dataset.armed, undefined);
  assert.equal(b.textContent, 'Disconnect', 'its own word is back');
  assert.equal(b.getAttribute('aria-label'), null, 'and no name was invented on the way');
});

test('an armed button that ENDS cancels its pending disarm timer', () => {
  // Otherwise the stale 3 s timer of the first arming fires into the next
  // one: a button re-armed 2 s later would lose `Sure?` after 1 s.
  const { btn, ended } = make();
  btn.click();
  assert.equal(dom.win.timers.filter((x) => x.ms === 3000).length, 1, 'non-vacuity: arming set the timer');
  btn.click();
  assert.deepEqual(ended, ['end']);
  assert.equal(dom.win.timers.filter((x) => x.ms === 3000).length, 0, 'the acting click cleared it');
});

test('the GitHub Disconnect is still armed through the shared primitive (the other text call site)', () => {
  const GH = code(read(join(UI, 'github.ts')));
  assert.match(GH, /const disconnectBtn = button\('gh-mini', 'Disconnect'\);/, 'a text button, no direct action');
  assert.match(GH, /armButton\(disconnectBtn, 'Confirm disconnect', \(\) => void drop\(\)\);/);
});

// ---------------------------------------------------------------------------
// 4. It is not part of the header's drag source
// ---------------------------------------------------------------------------

test('a press on the button or on its glyph starts no pane drag; a press on the header does', () => {
  // Armed exactly as createSlot arms a pane header (pinned by source below).
  const hd = dom.doc.createElement('header');
  hd.className = 'pane-hd';
  const { btn } = make();
  hd.append(btn);
  dom.body.append(hd);
  DND.armDrag(hd, 'button', () => ({ kind: 'pane', viewId: 'v1', slot: 0, slotKey: 's:x', label: 'x' }));

  dispatch(btn, 'pointerdown', { pointerId: 21 });
  assert.equal(DND.isDragging(), false, 'the button is not a drag handle');

  const path = (glyph(btn) as FakeElement).children[0] as FakeElement;
  dispatch(path, 'pointerdown', { pointerId: 22 });
  assert.equal(
    DND.isDragging(),
    false,
    'the glyph is an SVG node, not an HTMLElement — the ignore must still see the button around it',
  );

  // Non-vacuity: the same header, pressed on itself, IS a drag source.
  dispatch(hd, 'pointerdown', { pointerId: 23 });
  assert.equal(DND.isDragging(), true);
  dispatch(dom.body, 'pointerup', { pointerId: 23 });
  assert.equal(DND.isDragging(), false);
});

test('panes.ts arms every pane header with the button ignore', () => {
  assert.match(fn(PANES_CODE, 'function createSlot'), /armDrag\(hd, 'button', /);
});

// ---------------------------------------------------------------------------
// Where it sits (source: panes.ts reaches xterm)
// ---------------------------------------------------------------------------

test('every session pane builds it, wired to killSession, last in the header', () => {
  const body = fn(PANES_CODE, 'function buildSessionPane');
  assert.match(body, /const endBtn = endSessionButton\(\(\) => void killSession\(sessionId\)\);/);
  const rc = /s\.hd\.replaceChildren\((.*)\);\n/.exec(body);
  assert.ok(rc, 'the header is built in one replaceChildren');
  const parts = (rc[1] as string).replace(/el\([^)]*\)/g, 'gap').split(',').map((x) => x.trim());
  assert.equal(parts.at(-1), 'endBtn', 'top right: the last control');
  assert.ok(parts.indexOf('extractBtn') !== -1 && parts.indexOf('extractBtn') < parts.indexOf('endBtn'), 'after Own tab');
  assert.ok(parts.indexOf('state') < parts.indexOf('endBtn'), 'after the state pill');
  assert.match(PANES_CODE, /import \{ endSessionButton \} from '\.\/pane-end\.ts';/);
});

test('a one-pane tab keeps it: nothing hides it (only Own tab goes when the tab holds one pane)', () => {
  assert.equal(/endBtn\.hidden|\.pane-end[^-]/.test(PANES_CODE), false, 'panes.ts never hides or queries the button');
  // Non-vacuity: the one-pane rule exists, and it is Own tab's alone.
  assert.match(fn(PANES_CODE, 'function updateHeader'), /pay\.extractBtn\.hidden = renderedCount <= 1;/);
  assert.equal(PANES_CODE.split('endSessionButton(').length - 1, 1, 'one construction site');
});

test('an editor pane never gets it', () => {
  const body = fn(PANES_CODE, 'function buildEditorPane');
  assert.equal(/endSessionButton|killSession/.test(body), false);
});

// ---------------------------------------------------------------------------
// The style contract
// ---------------------------------------------------------------------------

/** The body of the FIRST top-level rule whose selector is exactly `sel`. */
function rule(sel: string): string {
  const re = new RegExp(`(^|\\n)${sel.replace(/[.[\]'=]/g, '\\$&')}\\s*\\{([^}]*)\\}`);
  const m = re.exec(APP_CSS);
  assert.ok(m !== null, `app.css has a rule for ${sel}`);
  return m[2] as string;
}

test('app.css: the button is token-only, danger ink on hover and while armed', () => {
  const base = rule('.pane-end');
  const hover = rule('.pane-end:hover');
  const armed = rule(".pane-end[data-armed='1']");
  for (const r of [base, hover, armed]) {
    assert.equal(/#[0-9a-fA-F]{3,8}\b|oklch\(|rgba?\(/.test(r), false, 'colours come from tokens');
  }
  assert.match(base, /color:\s*var\(--color-neutral-400\)/, 'the header’s quiet ink (Own tab’s)');
  assert.match(hover, /color:\s*var\(--color-danger\)/);
  assert.match(armed, /color:\s*var\(--color-danger\)/);
  assert.match(armed, /border-color:\s*var\(--color-danger\)/);
  assert.match(rule('.pane-end svg'), /pointer-events:\s*none/);
});

test('app.css: reduced motion stops the Needs your answer pulse, as it stops Working’s', () => {
  assert.match(rule('.dot.is-attn'), /animation:\s*pulse var\(--t-pulse\) infinite/, 'non-vacuity: it pulses');
  assert.match(
    APP_CSS,
    /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.dot\.is-attn\s*\{\s*animation:\s*none;\s*\}\s*\}/,
  );
  // Same specificity, so the cascade decides: the opt-out must come AFTER the
  // pulse it cancels, or the pulse wins under reduced motion as well.
  const base = /(^|\n)\.dot\.is-attn\s*\{[^}]*animation:\s*pulse/.exec(APP_CSS);
  const optOut = /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.dot\.is-attn\s*\{\s*animation:\s*none;/.exec(
    APP_CSS,
  );
  assert.ok(base !== null && optOut !== null);
  assert.ok(optOut.index > base.index, 'the reduced-motion rule follows the pulse');
});
