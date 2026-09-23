/**
 * The commit view's shell wiring (Nocturne A6, re-pointed by A10): how
 * `web/src/main.ts` builds the commit screen next to the grid, who owns the
 * pane area, the pane-area guard in `web/src/ui/panes.ts` (no render, no
 * attention ack, no measuring against a hidden grid), Escape's rank and the
 * pane chords standing down. Split out of `ui-a6-screens.test.ts`.
 *
 * Seam: the source read as text (`readSource`) — main.ts's import graph
 * reaches @xterm/xterm, a browser bundle. Each assertion is written so that
 * deleting the wiring it names fails it; it pins text, not behaviour.
 *
 * Why it matters: xterm on a `display: none` grid (the WebGL trap), or an
 * attention badge acknowledged while the user cannot see the pane, only show
 * in a browser.
 *
 * NOT claimed (browser work, `.claude/skills/verify-terminal/SKILL.md`):
 * that the wiring behaves as written — layout, a pane really reflowing a PTY,
 * focus policy.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSource, readSources } from '../helpers/helpers.ts';
import { readAppCss } from '../helpers/tokens-helpers.ts';

// ---------------------------------------------------------------------------
// The shell wiring (web/src/main.ts) and the pane-area guard (ui/panes.ts)
// ---------------------------------------------------------------------------

const MAIN = readSources('web/src/main.ts', 'web/src/main-shell.ts');
const PANES = readSource('web', 'src', 'ui', 'panes.ts');

test('main.ts builds the commit screen as a flex sibling of the grid, and NO editor column', () => {
  assert.ok(MAIN.includes('function buildShell'), 'non-vacuity: main.ts still builds the shell');
  // Both hand-overs land in the pane area since A10: back to the panes, or into
  // the pane a file was just opened in. The focused pane knows which it is.
  assert.match(
    MAIN,
    /const commitView = initCommitView\(commitAside, requestTerminalFocus, requestTerminalFocus\);/,
  );
  assert.match(
    MAIN,
    /main\.append\(projAside, filesAside, commitAside, grid, sessAside\);/,
    'the middle row is Projects, Files, the commit screen, the panes and Sessions',
  );
  // The editor column is gone with part A10: a file is a pane, and the grid
  // keeps the whole row (the user's complaint about the half-width panes).
  for (const dead of ['initEditor', 'editorAside', 'is-narrow', 'editorVisible']) {
    assert.equal(MAIN.includes(dead), false, `${dead} died with the editor column`);
  }
});

test('ONE owner decides who occupies the pane area, and it runs BEFORE the panes do', () => {
  // Order matters: when a commit view closes, the grid must already be visible
  // by the time ui/panes.ts is asked to render, or the rebuild it refuses
  // while hidden would be refused for good.
  const layout = MAIN.indexOf('st.subscribe(applyScreenLayout);');
  const panes = MAIN.indexOf('initPanes(grid,');
  assert.ok(layout !== -1 && panes !== -1, 'non-vacuity: both wirings were found');
  assert.ok(layout < panes, 'the layout owner subscribes first');

  const body = MAIN.slice(MAIN.indexOf('function applyScreenLayout'), layout);
  assert.match(body, /commitAside\.hidden = !commitOpen;/);
  assert.match(body, /grid\.hidden = commitOpen;/);
  assert.match(body, /if \(wasHidden && !grid\.hidden\) refreshPaneArea\(\);/);
  assert.match(MAIN, /applyScreenLayout\(\);\n\s*updateChrome\(\);/, 'and once at boot');
});

test('the panes refuse to render at all against a hidden grid — the WebGL trap', () => {
  // xterm must open on an attached, MEASURABLE node; constructing a
  // TerminalView on a `display: none` grid can permanently downgrade the WebGL
  // renderer and leaves it at xterm's default 80x24, which `connect()` then
  // sends to a PTY that is not. A rebuild is not the only construction site:
  // `reconcileSlot()` builds one too when a slot's session changes (a swap
  // chord, an exited pane's relaunch resolving), so the guard stands at the TOP
  // of `render()` — one copy, before anything is read or touched.
  assert.match(PANES, /function gridHidden\(\): boolean \{[\s\S]*grid\.hidden !== false;/);
  assert.match(PANES, /export function refreshPaneArea\(\): void \{\s*render\(\);/, 'the replay is the first thing refreshPaneArea does');
  const render = PANES.slice(PANES.indexOf('function render(): void'), PANES.indexOf('function renderEmpty'));
  assert.ok(render.length > 200 && render.length < 3000, 'non-vacuity: the render function was found');
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
  assert.match(
    readAppCss(),
    /\[hidden\] \{\s*display: none !important;/,
    'the hidden flag has to be real for the guard to mean anything',
  );
});

test('the grid coming back on screen acks the focused pane\'s attention itself — not the next window activation', () => {
  // applyFocus() early-returns on an unchanged focus key, so after Back the
  // badge raised under the view stayed until the next window focus (verify
  // run 2026-09-13). refreshPaneArea() takes that ack, gated on a visible
  // grid AND a focused window.
  const src = readSource('web', 'src', 'ui', 'panes.ts');
  const fn = /export function refreshPaneArea\(\): void \{[\s\S]*?\n\}/.exec(src);
  assert.ok(fn, 'refreshPaneArea found');
  assert.match(fn[0], /render\(\);/);
  assert.match(fn[0], /if \(gridHidden\(\) \|\| !document\.hasFocus\(\)\) return;/, 'gated on visible grid + focused window');
  assert.match(fn[0], /clearAttentionIfPending\(s\)/, 'acks the focused slot');
  assert.ok(fn[0].indexOf('render();') < fn[0].indexOf('clearAttentionIfPending'), 'render first, ack after');
});

test('a hidden grid acknowledges NO attention badge on a live BEL or an info frame either (verify-terminal A6 b)', () => {
  // The window-focus gate (R2) was not the path a live BEL takes: the
  // onAttention and onInfo acks in slotEvents() decided on "focused pane +
  // document has focus" alone, so a BEL under the commit view was seen 1 ms
  // after it was raised (server.log: attention raised → seen). Both
  // predicates must also ask whether the grid is on screen.
  const src = readSource('web', 'src', 'ui', 'panes.ts');
  const onInfo = /onInfo: \(info: SessionInfo\) => \{[\s\S]*?clearAttentionIfPending\(s\);/.exec(src);
  assert.ok(onInfo, 'onInfo ack block found');
  assert.match(onInfo[0], /document\.hasFocus\(\) &&\s*!gridHidden\(\)/, 'info-frame ack is gated on a visible grid');
  const onAttn = /onAttention: \(\) => \{[\s\S]*?ackSeen\(pay, sessionId\);/.exec(src);
  assert.ok(onAttn, 'onAttention ack block found');
  assert.match(onAttn[0], /document\.hasFocus\(\) &&\s*!gridHidden\(\)/, 'live BEL ack is gated on a visible grid');
});

test('a hidden grid acknowledges NO attention badge on window refocus (scope review R2)', () => {
  // Scenario: a session BELs while the commit view covers the panes, the tab
  // strip shows "Needs you", the user alt-tabs away and back. Without the
  // guard the refocus listener acks a terminal that was never on screen and
  // the badge is gone. The deferred applyFocus() on return acks it honestly.
  const listener = PANES.slice(
    PANES.indexOf("window.addEventListener('focus'"),
    PANES.indexOf('function gridHidden'),
  );
  assert.ok(listener.length > 100, 'non-vacuity: the refocus listener was found');
  assert.match(listener, /if \(gridHidden\(\)\) return;/, 'the hidden grid stands down');
  assert.ok(
    listener.indexOf('if (gridHidden()) return;') < listener.indexOf('clearAttentionIfPending'),
    'and it stands BEFORE anything is acknowledged',
  );
});

test('a hidden grid is never MEASURED for a new PTY either (scope review R3)', () => {
  // `New session` (top bar, Ctrl+Alt+T) and the drawer's resume stay reachable
  // while the commit view is up; proposeDims() on a `display: none` terminal
  // falls back to 80x24 and the first screenful lands wrapped in the
  // scrollback, which the later attach reconcile cannot repair.
  const dims = PANES.slice(
    PANES.indexOf('export function focusedPaneDims'),
    PANES.indexOf('function render(): void'),
  );
  assert.ok(dims.length > 100 && dims.length < 1600, 'non-vacuity: the function was found');
  assert.match(dims, /if \(!gridHidden\(\) &&/, 'a hidden grid is never measured');
  assert.match(dims, /st\.state\.sessions\.get\(id\)/, 'the focused session states its own size');
  assert.match(dims, /info\.status === 'running'/, 'and only a running one is believed');
  assert.match(dims, /return lastGoodDims \?\? \{ cols: 80, rows: 24 \};/, 'then the last good dims');
  assert.ok(
    dims.indexOf('gridHidden()') < dims.indexOf('proposeDims()'),
    'nothing is measured before the guard',
  );
  // And `lastGoodDims` is fed from the one place a view reports its size.
  assert.match(PANES, /onDims: \(cols, rows\) => \{\s*lastGoodDims = \{ cols, rows \};/);
});

test('nothing narrows the grid any more — the panes keep the whole row (A10)', () => {
  const css = readAppCss();
  assert.equal(css.includes('is-narrow'), false, 'the 46% rule died with the editor column');
  assert.equal(css.includes('.editor-'), false, 'and so did the whole editor family');
  // Non-vacuity: the pane area itself is definitely still styled here.
  assert.match(css, /\.grid \{/);
});

test('Escape closes the commit view, ranked under the dialogs and over the drawers', () => {
  const from = MAIN.indexOf("e.key === 'Escape'");
  assert.notEqual(from, -1, 'non-vacuity: the Escape branch was found');
  const branch = MAIN.slice(from, MAIN.indexOf('// ---- reliability'));
  const arms = branch.split('} else if');
  const commitArm = arms.findIndex((a) => a.includes('st.closeCommitView();'));
  const drawerArm = arms.findIndex((a) => a.includes('st.closeDrawer();'));
  const launchArm = arms.findIndex((a) => a.includes('closeLaunchDialog();'));
  assert.ok(commitArm !== -1 && drawerArm !== -1 && launchArm !== -1, 'non-vacuity: three arms found');
  assert.ok(launchArm < commitArm, 'every dialog outranks the commit view');
  assert.ok(commitArm < drawerArm, 'and the commit view outranks the drawer/panel arms');
  assert.match(arms[commitArm] as string, /!isEditable\(e\.target\)/, 'a field keeps its own Escape');
  assert.match(arms[commitArm] as string, /st\.closeCommitView\(\);[\s\S]*requestTerminalFocus\(\);/);
});

test('the pane chords stand down while the commit view covers the panes', () => {
  // Ctrl+Alt+Arrow, Ctrl+Alt+Shift+Arrow and Ctrl+Alt+1..9 move focus between,
  // swap sessions inside, and switch panes NOBODY CAN SEE while the view is up.
  const from = MAIN.indexOf("if (e.ctrlKey && e.altKey");
  assert.notEqual(from, -1, 'non-vacuity: the chord block was found');
  const block = MAIN.slice(from, MAIN.indexOf("if (e.key === '?'", from));
  assert.match(block, /const paneChord =/);
  assert.match(block, /if \(paneChord && st\.state\.openCommit !== null\) return;/);
  // It has to stand BEFORE the three calls it guards, or it guards nothing.
  const guard = block.indexOf('if (paneChord && st.state.openCommit !== null) return;');
  for (const call of ['st.moveFocus(', 'st.movePane(', 'st.setActiveViewIndex(']) {
    const at = block.indexOf(call);
    assert.notEqual(at, -1, `non-vacuity: ${call} is in this block`);
    assert.ok(guard < at, `${call} runs after the guard`);
  }
  // And the chords that open something of their own are NOT swallowed.
  assert.ok(block.indexOf('openLaunchDialog();') > guard);
  assert.match(block, /k === 't' \|\| k === 'T'/);
});

test('`paneChord` names EVERY chord that moves a pane, the digits included', () => {
  // Gate addition: "the guard stands before the calls" stays true if the guard
  // covers only the arrows, and Ctrl+Alt+1..9 would still switch to a tab
  // nobody can see. The SET itself is the contract.
  const at = MAIN.indexOf('const paneChord =');
  assert.notEqual(at, -1, 'non-vacuity: the set was found');
  const expr = MAIN.slice(at, MAIN.indexOf(';', at));
  for (const key of ["k === 'ArrowLeft'", "k === 'ArrowRight'", "k === 'ArrowUp'", "k === 'ArrowDown'"]) {
    assert.ok(expr.includes(key), `${key} is a pane chord`);
  }
  assert.match(expr, /k\.length === 1 && k >= '1' && k <= '9'/, 'and so is Ctrl+Alt+1..9');
  // The three handlers this set exists for are exactly the three pane moves —
  // read from the branches that follow, so a fourth one cannot be forgotten.
  const block = MAIN.slice(
    MAIN.indexOf('if (e.ctrlKey && e.altKey'),
    MAIN.indexOf("if (e.key === '?'", at),
  );
  const guarded = ['st.moveFocus(', 'st.movePane(', 'st.setActiveViewIndex('];
  for (const call of guarded) {
    const keyFor = call === 'st.setActiveViewIndex(' ? "k >= '1' && k <= '9'" : "k === 'ArrowLeft'";
    assert.ok(block.includes(keyFor), `${call} is reached by a key the set names`);
  }
});

test('neither screen is persisted: the UI bag writes the same keys it did in A5', () => {
  const src = readSource('web', 'src', 'state-persist.ts');
  const save = src.slice(src.indexOf('function saveUi'), src.indexOf('function loadUi'));
  assert.ok(save.length > 200, 'non-vacuity: saveUi was found');
  for (const key of ['openCommit', 'edits', 'commitCollapsed']) {
    assert.equal(save.includes(key), false, `${key} is a place the user stands, not a preference`);
  }
});
