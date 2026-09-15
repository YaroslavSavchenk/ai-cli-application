/**
 * Nocturne part A10 — the STRUCTURAL facts of a pane that may be a terminal, a
 * file or a read-only diff, pinned by source inspection (`.claude/PLAN-A10.md`
 * §2 and §5).
 *
 * WHY SOURCE AND NOT DOM. `web/src/ui/panes.ts` imports @xterm/xterm, a
 * browser bundle: importing it under `node --test` throws before the first
 * assertion. So what can be proven here is the SHAPE of the code, and the
 * shapes chosen are the ones whose breakage is INVISIBLE to every other test
 * and expensive in the real app:
 *
 *   1. `gridHidden()` is still the FIRST statement of `render()` — the A6
 *      WebGL trap, now with one more construction site (a slot that changes
 *      KIND builds a TerminalView too).
 *   2. A slot leaving a pane DISPOSES its view before the mount is emptied,
 *      and the conversion happens IN PLACE — a rebuild would re-attach every
 *      other terminal in the tab (verify-terminal check 8).
 *   3. `focusedPaneDims()` never answers 80x24 just because a FILE is focused
 *      (the A6 regression, one door further along).
 *   4. `requestTerminalFocus()` knows all three kinds; its nine callers do not
 *      have to.
 *   5. The session-only work (header, banner, status bar, the 15 s tick) skips
 *      panes that hold no session.
 *   6. The `×` on a file pane closes the PANE and ends nothing.
 *   7. `ui/keys.ts` is unchanged where A10 could have broken it: the pane area
 *      must not become a screen-level focus owner (memory:
 *      files-panel-focus-owner-trap) and a textarea is an editable target.
 *
 * Behaviour proof stays with the browser gate
 * (`.claude/skills/verify-terminal/SKILL.md`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectRoot } from './helpers.ts';

const UI = join(projectRoot, 'web', 'src', 'ui');
const read = (p: string): string => readFileSync(p, 'utf8');

const PANES = read(join(UI, 'panes.ts'));
const KEYS = read(join(UI, 'keys.ts'));
const FILE_PANE = read(join(UI, 'file-pane.ts'));
const MAIN = read(join(projectRoot, 'web', 'src', 'main.ts'));

/** Source with comments removed — a comment may DISCUSS what code may not do. */
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const PANES_CODE = code(PANES);

/** The body of a named function, from its signature to the next top-level `}`. */
function fn(src: string, signature: string): string {
  const at = src.indexOf(signature);
  assert.notEqual(at, -1, `non-vacuity: ${signature} was not found`);
  const end = src.indexOf('\n}', at);
  assert.notEqual(end, -1, `non-vacuity: ${signature} has no end`);
  return src.slice(at, end + 2);
}

test('non-vacuity: this really reads the A10 pane module, and it really needs xterm', () => {
  assert.ok(PANES.length > 5000, 'panes.ts looks empty');
  assert.ok(FILE_PANE.length > 2000, 'file-pane.ts looks empty');
  assert.match(
    PANES,
    /import \{ TerminalView, type TerminalEvents \} from '\.\/terminal\.ts';/,
    'panes.ts reaches @xterm/xterm through ui/terminal.ts — which is why this file is a source scan',
  );
  assert.match(read(join(UI, 'terminal.ts')), /from '@xterm\/xterm'/);
  for (const name of ['function reconcileSlot', 'function teardown', 'function buildFilePane']) {
    assert.ok(PANES_CODE.includes(name), `panes.ts must define ${name}`);
  }
});

// ---------------------------------------------------------------------------
// 1. The hidden-grid guard, with one more construction site than A6 had
// ---------------------------------------------------------------------------

test('`gridHidden()` is the FIRST statement of render(), exactly once', () => {
  const render = PANES.slice(
    PANES.indexOf('function render(): void'),
    PANES.indexOf('function renderEmpty'),
  );
  assert.ok(render.length > 200, 'non-vacuity: render() was found');
  assert.equal(render.split('if (gridHidden()) return;').length - 1, 1, 'exactly one guard');
  assert.match(
    render,
    /function render\(\): void \{(\s*\/\/[^\n]*\n)*\s*if \(gridHidden\(\)\) return;/,
    'and it is the FIRST statement, so the reconcile path is covered too',
  );
  assert.ok(
    render.indexOf('if (gridHidden()) return;') < render.indexOf('st.activeView()'),
    'nothing is read before the guard',
  );
});

test('a slot that changes KIND is converted in place — never through a rebuild', () => {
  const render = PANES.slice(
    PANES.indexOf('function render(): void'),
    PANES.indexOf('function renderEmpty'),
  );
  // The rebuild decision is the tab, the pane COUNT and the 3-split variant.
  // Adding the slot keys to it would turn every swap into a full re-attach.
  assert.match(
    render,
    /if \(\s*v\.id !== renderedViewId \|\|\s*count !== renderedCount \|\|\s*\(count === 3 && v\.l3 !== renderedL3\)\s*\)/,
    'the rebuild signature is the LAYOUT, not the contents',
  );
  assert.match(render, /reconcileSlot\(i, v\.slots\[i\] \?\? null\)/, 'contents go through reconcileSlot');
  const rec = fn(PANES, 'function reconcileSlot(index: number, slot: st.PaneSlot | null): void {');
  assert.match(rec, /const key = slot === null \? '' : st\.slotKey\(slot\);/, 'identity is the slot KEY');
  assert.match(rec, /if \(key === s\.key/, 'an unchanged pane is refreshed, not rebuilt');
  for (const build of ['buildSessionPane(', 'buildFilePane(', 'buildDiffPane(']) {
    assert.ok(rec.includes(build), `reconcileSlot must be able to build a ${build} pane`);
  }
});

test('a terminal leaving a pane is DISPOSED before its mount is emptied', () => {
  const t = fn(PANES, 'function teardown(s: Slot): void {');
  const dispose = t.indexOf('pay.view?.dispose();');
  const empty = t.indexOf('pay.termHost.replaceChildren();');
  assert.ok(dispose !== -1 && empty !== -1, 'non-vacuity: both calls were found');
  assert.ok(dispose < empty, 'emptying the host under a live view leaves xterm attached to nothing');
  // And the pane's own card survives: only its contents go.
  assert.equal(t.includes('s.root.remove()'), false, 'the card is chrome; it stays');
  assert.match(t, /s\.hd\.replaceChildren\(\);/);
  assert.match(t, /s\.body\.replaceChildren\(\);/);
});

// ---------------------------------------------------------------------------
// 3. A focused FILE is not a reason to size a new PTY at 80x24
// ---------------------------------------------------------------------------

test('focusedPaneDims falls back through the app’s own knowledge, never straight to 80x24', () => {
  const dims = fn(PANES, 'export function focusedPaneDims(): { cols: number; rows: number } {');
  assert.match(dims, /s\?\.pay\?\.kind === 'session'/, 'a measurable terminal answers for itself');
  assert.match(dims, /info\.status === 'running'/, 'a running session states its own size');
  assert.match(dims, /other\.pay\?\.kind === 'session'/, 'then a session pane of the same tab');
  // EVERY 80x24 in this function is the last resort behind `lastGoodDims`.
  const fallbacks = [...dims.matchAll(/\{ cols: 80, rows: 24 \}/g)];
  assert.ok(fallbacks.length > 0, 'non-vacuity: the fallback is in there');
  for (const m of fallbacks) {
    const before = dims.slice(Math.max(0, (m.index as number) - 20), m.index as number);
    assert.match(
      before,
      /lastGoodDims \?\? $/,
      'a bare 80x24 is the A6 regression: the new PTY writes its first screenful wrapped',
    );
  }
  assert.match(PANES, /onDims: \(cols, rows\) => \{\s*lastGoodDims = \{ cols, rows \};/);
});

test('focusedPaneDims asks the TERMINALS first — no early bail may jump the queue', () => {
  // The pin above reads every `{ cols: 80, rows: 24 }` and demands
  // `lastGoodDims ??` in front of it. Measured gap: an early
  // `if (s?.pay?.kind !== 'session') return lastGoodDims ?? { cols: 80, rows: 24 };`
  // keeps that shape byte for byte and still answers 80x24 for a focused file
  // while a terminal is running in the pane beside it (lastGoodDims is null
  // until some TerminalView has reported once — a session launched from a
  // focused file right after a reload is exactly that moment). The ORDER of
  // the ladder is therefore the contract, not just its last rung.
  const dims = fn(PANES, 'export function focusedPaneDims(): { cols: number; rows: number } {');
  const returns = [...dims.matchAll(/return ([^;]*);/g)].map((m) => (m[1] as string).trim());
  assert.ok(returns.length >= 4, `non-vacuity: the ladder has ${returns.length} rungs`);
  assert.equal(returns[0], 's.pay.view.proposeDims()', 'a measurable terminal answers FIRST');
  assert.equal(
    returns[returns.length - 1],
    'lastGoodDims ?? { cols: 80, rows: 24 }',
    'and the remembered size is the LAST word',
  );
  assert.equal(
    returns.filter((r) => r.includes('lastGoodDims')).length,
    1,
    'exactly one bail-out, and it is the one at the end',
  );
});

// ---------------------------------------------------------------------------
// 4. One name, three kinds
// ---------------------------------------------------------------------------

test('requestTerminalFocus keeps its name and knows all three kinds', () => {
  const f = fn(PANES, 'export function requestTerminalFocus(): void {');
  assert.match(f, /if \(s\.pay\.kind === 'session'\) s\.pay\.view\?\.focus\(\);/);
  assert.match(f, /s\.pay\.kind === 'file'.*s\.pay\.body\.focus\(\);/s, 'a file pane focuses its text');
  assert.match(f, /s\.pay\.chip\.focus\(\);/, 'a read-only diff focuses its header chip');
  // file-pane.ts is the other half of the file branch.
  assert.match(FILE_PANE, /function focus\(\): void \{\s*textarea\?\.focus\(\);/);
});

test('the focus key carries the slot KEY, so a replaced pane takes the keyboard', () => {
  const f = fn(PANES, 'function applyFocus(): void {');
  assert.match(
    f,
    /const key = `\$\{v\.id\}:\$\{v\.focused\}:\$\{s\?\.key \?\? ''\}`;/,
    'tab + index alone cannot tell a swap from a no-op',
  );
  assert.match(f, /if \(key === lastFocusKey\) return;/);
});

// ---------------------------------------------------------------------------
// 5. Session-only work skips the other kinds
// ---------------------------------------------------------------------------

test('the session list and the 15 s tick skip panes that hold no session', () => {
  const init = PANES.slice(PANES.indexOf('export function initPanes'), PANES.indexOf('function gridHidden'));
  assert.ok(init.length > 400, 'non-vacuity: initPanes was found');
  assert.match(init, /if \(s\.pay\?\.kind !== 'session'\) continue;/, "the 'sessions' subscriber skips them");
  assert.match(
    init,
    /window\.setInterval\(\(\) => \{[\s\S]*if \(s\.pay\?\.kind === 'session'\) updateStatus\(s\.pay\);/,
    'and so does the status tick',
  );
  assert.match(init, /}, STATUS_TICK_MS\);/);
});

// ---------------------------------------------------------------------------
// 6. The × on a file pane, and the rule it does not break
// ---------------------------------------------------------------------------

test('a file pane’s × closes the PANE through state.ts, and says why that is allowed', () => {
  const build = fn(PANES, 'function buildFilePane(s: Slot, path: string): void {');
  assert.match(build, /st\.closeSlot\(renderedViewId, s\.index\)/, 'state.ts refuses a session slot');
  assert.equal(build.includes('killSession'), false, 'a file pane never ends anything');
  assert.match(
    PANES,
    /A3 no-close rule: that rule\n \* is about ENDING SESSIONS/,
    'the reason the × is allowed here is written down where the pane is built',
  );
  const diff = fn(PANES, 'function buildDiffPane(s: Slot, hash: string, path: string): void {');
  assert.match(diff, /st\.closeSlot\(renderedViewId, s\.index\)/);
  assert.equal(diff.includes('textarea'), false, 'a diff pane has no field');
});

test('a pane drag carries the slot key, and a file header is a drag source too', () => {
  const create = fn(PANES, 'function createSlot(index: number): Slot {');
  assert.match(create, /armDrag\(hd, 'button', \(\) => \{/, 'the HEADER is the handle, for every kind');
  assert.match(create, /kind: 'pane',/);
  assert.match(create, /slotKey: slot\.key,/, 'the drop needs to know WHAT was picked up');
  assert.match(create, /viewId: renderedViewId,/);
  // Armed once, on the element that survives a conversion.
  assert.equal(PANES_CODE.split('armDrag(').length - 1, 1, 'exactly one armDrag call site');
});

// ---------------------------------------------------------------------------
// 7. keys.ts: the two facts A10 rests on (the module itself is unchanged)
// ---------------------------------------------------------------------------

test('the pane area is still NOT a screen-level focus owner', () => {
  const sel = /export const OPEN_FOCUS_OWNER_SELECTOR =\s*'([^']*)';/.exec(KEYS);
  assert.ok(sel, 'non-vacuity: the selector was found');
  const value = sel[1] as string;
  for (const forbidden of ['.grid', '.pane', '.term-host']) {
    assert.equal(
      value.includes(forbidden),
      false,
      `${forbidden} in OPEN_FOCUS_OWNER_SELECTOR would disable the terminal refocus for the whole app`,
    );
  }
  assert.match(value, /\.modal-scrim:not\(\[hidden\]\)/, 'the dialogs are still owners');
  assert.match(value, /\.drawer:not\(\.files-panel\):not\(\[hidden\]\)/);
});

test('a textarea is an editable target — the file pane keeps the keys it is typed in with', () => {
  const f = fn(KEYS, 'export function isEditableTarget(t: FocusTarget | null): boolean {');
  assert.match(f, /tag === 'TEXTAREA'/);
  // And the refocus rule reads it, so a window activation never steals the
  // keyboard out of a file the user is typing in.
  assert.match(KEYS, /if \(isEditableTarget\(active\)\) return false;/);
});

// ---------------------------------------------------------------------------
// 8. main.ts: the two chords A10 added, and the one Escape it did NOT add
// ---------------------------------------------------------------------------

test('ctrl+alt+w closes the focused PANE, ends nothing, and stands down under the commit view', () => {
  const at = MAIN.indexOf('if (e.ctrlKey && e.altKey');
  assert.notEqual(at, -1, 'non-vacuity: the chord block was found');
  const block = MAIN.slice(at, MAIN.indexOf("if (e.key === '?'", at));
  assert.ok(block.length > 400, 'non-vacuity: and it is the block, not the file');
  // In `paneChord`, so the A6 rule covers it too: the chord must not close a
  // pane nobody can see while the commit view is up.
  assert.match(
    block,
    /const paneChord =[\s\S]*?k === 'w' \|\|\s*\n\s*k === 'W' \|\|/,
    'ctrl+alt+w is a pane chord',
  );
  const guard = block.indexOf('if (paneChord && st.state.openCommit !== null) return;');
  const arm = block.indexOf("} else if (k === 'w' || k === 'W') {");
  assert.ok(guard !== -1 && arm !== -1, 'non-vacuity: guard and arm were found');
  assert.ok(guard < arm, 'the guard stands before the arm it guards');
  const body = block.slice(arm, block.indexOf('} else if', arm + 8));
  assert.match(
    body,
    /const v = st\.activeView\(\);\s*\n\s*if \(v !== null\) st\.closeSlot\(v\.id, v\.focused\);/,
    'it closes the FOCUSED pane of the ACTIVE view, through state.ts',
  );
  assert.equal(body.includes('killSession'), false, 'the chord never ends a session');
  assert.equal(
    body.includes('closeView'),
    false,
    'and it never closes a tab: state.ts decides what an emptied tab costs',
  );
  // state.ts refuses a session slot (tests/ui-state.test.ts: "closeSlot: a
  // SESSION pane is refused"), which is why no arm here special-cases a kind.
});

test('Escape inside a file pane belongs to the TEXTAREA: no arm of main.ts reaches for it', () => {
  const from = MAIN.indexOf("e.key === 'Escape'");
  assert.notEqual(from, -1, 'non-vacuity: the Escape handler was found');
  const branch = MAIN.slice(from, MAIN.indexOf('// ---- reliability'));
  assert.ok(branch.length > 200 && branch.length < 4000, 'non-vacuity: and it is the handler');
  const body = branch.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  // A10 added no Escape arm, on purpose: Escape in a text field is the field's
  // (clearing an autocomplete, leaving an IME). An arm that matched a pane
  // would take it away from every file the user types in.
  for (const reach of ['.pane-text', '.pane-file', 'pane', 'grid', 'closeSlot', 'term-host']) {
    assert.equal(body.includes(reach), false, `no Escape arm may reach for ${reach}`);
  }
  // The two arms that close a surface both test WHERE the focus is, and
  // neither container can hold a pane: the panes are siblings of both.
  const arms = body.split('} else if');
  const drawerArm = arms.find((a) => a.includes('st.closeDrawer();'));
  const filesArm = arms.find((a) => a.includes("st.toggleLeftPanel('files');"));
  assert.ok(drawerArm !== undefined && filesArm !== undefined, 'non-vacuity: both arms were found');
  assert.match(drawerArm as string, /focusInOrFree\(projAside, sessAside\)/);
  assert.match(filesArm as string, /filesAside\.contains\(document\.activeElement\)/);
  // And the one arm that needs no focus test (the commit view covers the whole
  // pane area) still keeps its hands off a field.
  const commitArm = arms.find((a) => a.includes('st.closeCommitView();'));
  assert.match(commitArm as string, /!isEditable\(e\.target\)/);
});

// ---------------------------------------------------------------------------
// The source is TEXT (A10 fix cycle 1)
// ---------------------------------------------------------------------------

test('no source file under web/src holds a raw control byte below 0x09', () => {
  // A10 shipped two literal U+0000 bytes in ui/panes.ts where the escape
  // `'\u0000'` belonged (`statusSig` / `agentsSig` sentinels). Nothing broke
  // loudly: `file` called the module `data` and grep in a UTF-8 locale matched
  // NOTHING in it, so every source scan in this suite silently passed over it.
  // Read as BYTES — a string read would hide exactly the bytes being hunted.
  const root = join(projectRoot, 'web', 'src');
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(ts|css|html)$/.test(e.name)) files.push(full);
    }
  };
  walk(root);
  assert.ok(files.length >= 20, `non-vacuity: scanned ${files.length} files`);
  const offenders: string[] = [];
  for (const f of files) {
    const buf = readFileSync(f);
    for (const [i, b] of buf.entries()) {
      if (b < 0x09) {
        offenders.push(`${f.slice(root.length + 1)}: byte 0x${b.toString(16).padStart(2, '0')} at ${i}`);
        break;
      }
    }
  }
  assert.deepEqual(offenders, [], 'a control byte in source is a typo the tools do not report');
});
