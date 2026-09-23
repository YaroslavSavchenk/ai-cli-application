/**
 * The Files panel's shell wiring in `web/src/main.ts` that no unit can reach
 * (Nocturne A5, live since B2): the panel is constructed on its aside, it is a
 * flex sibling BEFORE the grid (so opening it narrows the panes and the
 * existing fit -> ws `resize` chain fires), the Files button really toggles,
 * visibility goes through `filesPanelVisible()`, Escape hands the keyboard
 * back — plus the badge colour pairs the model can emit existing in
 * tokens.css and app.css. Split out of `ui-files-panel.test.ts`.
 *
 * Seam: the source read as text (`readSource`) — main.ts's own import graph
 * reaches @xterm/xterm, a browser bundle. Each assertion is written so that
 * deleting the wiring it names fails it; it pins text, not behaviour.
 *
 * NOT claimed (browser work, `.claude/skills/verify-terminal/SKILL.md`): that
 * the wiring behaves as written — layout, colour, that a drag really reflows a
 * PTY.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FILES_PANEL_SOURCES, readSource, readSources } from '../helpers/helpers.ts';
import { readAppCss } from '../helpers/tokens-helpers.ts';

// ---------------------------------------------------------------------------
// The shell wiring (web/src/main.ts), read from the source
// ---------------------------------------------------------------------------

const MAIN = readSources('web/src/main.ts', 'web/src/main-shell.ts');

test('the panel knows no absolute path of its own: home is LEARNED from the first listing', () => {
  // The one request with no path at all is what teaches the app where home is
  // (§4a). A panel that guessed instead would be right on this machine and
  // wrong on the next one, and nothing on screen would say which.
  const src = readSources(...FILES_PANEL_SOURCES);
  assert.match(src, /fs\.entries\(\)\s*\n\s*\.then/, 'the home probe carries no path');
  // The prose says `/home/...` where it explains the rule, so the check is on
  // the CODE: a string literal is what a guess would have to be written as.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.equal(
    /['"`]\/home[/'"`]/.test(code),
    false,
    'and no home path is written into the app anywhere',
  );
});

test('main.ts constructs the panel — on the aside it just created', () => {
  assert.ok(MAIN.includes('function buildShell'), 'non-vacuity: main.ts still builds the shell');
  // Since A9 the module also hands main.ts the destination NAMES the drop
  // layer asks for, so the import is a list — `initFilesPanel` must still be
  // in it, whatever else joined it.
  assert.match(MAIN, /import \{[^}]*\binitFilesPanel\b[^}]*\} from '\.\/ui\/files\.ts';/s);
  assert.match(
    MAIN,
    /const filesPanel = initFilesPanel\(filesAside, requestTerminalFocus, fsGateway\);/,
    'the panel must be initialised with the files aside, or nothing is ever built',
  );
  // Part B2: the backend reaches the panel as an INJECTED gateway, and this is
  // the only module allowed to know those questions are HTTP. Part B3 added the
  // three git-history ones to the SAME object, which the commit store is given
  // too — two gateways would be two boundaries to keep right.
  assert.match(
    MAIN,
    /entries: api\.fsEntries,\s*\n\s*create: api\.fsCreate,\s*\n\s*changes: api\.gitChanges,\s*\n\s*commits: api\.gitCommits,\s*\n\s*commit: api\.gitCommit,\s*\n\s*commitDiff: api\.gitCommitDiff,/,
    'the client functions are handed over by name',
  );
  assert.match(MAIN, /setCommitGateway\(fsGateway\);/, 'and the commit store gets the same one');
  const files = readSources(...FILES_PANEL_SOURCES);
  assert.equal(
    /from '\.\.\/api\.ts'/.test(files),
    false,
    'ui/files.ts must never import the API: that is what keeps it drivable here',
  );
});

test('main.ts renders the panel on every state change AND once at boot', () => {
  const sub = MAIN.slice(MAIN.indexOf('st.subscribe('));
  assert.ok(sub.length > 200, 'non-vacuity: the subscribe block was found');
  const block = sub.slice(0, sub.indexOf('// ---- global keyboard'));
  const calls = block.split('filesPanel.render();').length - 1;
  assert.equal(calls, 2, 'once inside subscribe, once for the first paint');
});

test('the Files aside is a flex sibling BEFORE the grid — that is what resizes the panes', () => {
  // The middle row's occupants change with the parts (A6 added the commit
  // view and an editor column; A10 took the editor away again), so what is
  // pinned is the INVARIANT and not the cast: ONE `main.append(...)` call,
  // the Files aside inside it, after the projects drawer and before the grid.
  // That order is what makes opening the panel narrow the grid for real, and
  // therefore what drives the fit -> ws `resize` chain.
  const call = /main\.append\(([^)]*)\);/.exec(MAIN);
  assert.notEqual(call, null, 'the middle row must still be appended in one call');
  const order = (call?.[1] ?? '').split(',').map((s) => s.trim());
  assert.ok(order.length >= 4, `non-vacuity: parsed ${order.join(' ')}`);
  const at = (name: string): number => order.indexOf(name);
  assert.ok(at('projAside') >= 0 && at('filesAside') >= 0 && at('grid') >= 0, order.join(' '));
  assert.ok(at('projAside') < at('filesAside'), 'the Files panel sits after the projects drawer');
  assert.ok(at('filesAside') < at('grid'), 'and BEFORE the grid — a sibling, never an overlay');
  assert.ok(at('grid') < at('sessAside'), 'the sessions drawer stays on the right');
});

test('the Files button is a live toggle, not the disabled placeholder A2 shipped', () => {
  assert.match(MAIN, /button\('tb-btn', 'Files', \(\) => st\.toggleLeftPanel\('files'\)\)/);
  assert.equal(
    /filesBtn\.disabled = true/.test(MAIN),
    false,
    'A5 turned the placeholder into a real control',
  );
});

test('the chrome hides the panel through filesPanelVisible(), never through the wish alone', () => {
  assert.match(MAIN, /const filesShown = st\.filesPanelVisible\(\);/);
  assert.match(MAIN, /filesAside\.hidden = !filesShown;/);
  // `aria-pressed` states what is ON SCREEN; only the CSS class carries the
  // wish. Announcing an open panel while nothing is rendered is a lie to a
  // screen reader, and the wish is true by default from the first paint.
  assert.match(MAIN, /filesBtn\.setAttribute\('aria-pressed', filesShown \? 'true' : 'false'\);/);
  assert.match(MAIN, /filesBtn\.classList\.toggle\('is-on', filesOn\);/);
});

test('the button title names the ONE state the panel is wanted but not on screen', () => {
  // User decision 2026-09-15: no session is required any more, so the only way
  // a wanted panel is off screen is the Projects drawer standing in its place.
  // Source-read, like the rest of this block: main.ts imports @xterm/xterm, so
  // there is no DOM harness that can run updateChrome() under `node --test`.
  assert.match(
    MAIN,
    /filesBtn\.title = filesOn && !filesShown \? 'Hidden while Projects is open' : 'Files';/,
  );
  assert.equal(
    MAIN.includes('Opens when a session is running'),
    false,
    'the old sentence promised a panel that now needs no session',
  );
  assert.equal(MAIN.includes('filesLive'), false, 'and the alive-session read it hung on is gone');
});

test('Escape closes the panel only when the focus is inside it', () => {
  const from = MAIN.indexOf("e.key === 'Escape'");
  assert.notEqual(from, -1, 'non-vacuity: the Escape branch was found');
  const branch = MAIN.slice(from, MAIN.indexOf('// ---- reliability'));
  assert.ok(branch.length > 200 && branch.length < 4000, 'non-vacuity: and it is the handler, not the file');
  assert.match(branch, /filesAside\.contains\(document\.activeElement\)/);
  assert.match(branch, /st\.toggleLeftPanel\('files'\)/);
});

test('Escape hands the keyboard back to the terminal, in BOTH branches that close a surface', () => {
  // The surface that held the focus disappears; without this the focus falls
  // to <body> and typing goes nowhere until the next window activation (the
  // same fix ui-restart-guards.test.ts pins for the restart dialog).
  assert.match(MAIN, /import \{[^}]*requestTerminalFocus[^}]*\} from '\.\/ui\/panes\.ts';/s);
  const from = MAIN.indexOf("e.key === 'Escape'");
  const branch = MAIN.slice(from, MAIN.indexOf('// ---- reliability'));
  const arms = branch.split('} else if');
  const drawerArm = arms.find((a) => a.includes('st.closeDrawer();'));
  const filesArm = arms.find((a) => a.includes("st.toggleLeftPanel('files');"));
  assert.ok(drawerArm !== undefined && filesArm !== undefined, 'non-vacuity: both arms were found');
  assert.match(
    drawerArm,
    /st\.closeDrawer\(\);[\s\S]*handBackKeyboard\(wasProjects \? projectsBtn : sessionsBtn\);/,
  );
  // The Files arm goes through `handBackKeyboard`, which calls
  // requestTerminalFocus() and, when no terminal took the key (the panel is
  // reachable with no session at all), focuses a visible control instead.
  assert.match(filesArm, /st\.toggleLeftPanel\('files'\);[\s\S]*handBackKeyboard\(filesBtn\);/);
  assert.match(
    MAIN,
    /function handBackKeyboard\(fallback: HTMLElement\): void \{[\s\S]*requestTerminalFocus\(\);[\s\S]*fallback\.focus\(\);/,
  );
  // The GUARD, not just the call. main.ts bootstraps the whole app on import
  // and `handBackKeyboard` is a closure-local, so no DOM harness can reach it
  // and this source pin is the only thing standing between the helper and an
  // inverted condition — which would steal the keyboard back FROM a terminal
  // that did take it, the exact bug the helper exists to avoid. Measured: with
  // `a !== null && a !== document.body` the whole suite stayed green.
  assert.match(
    MAIN,
    /const a = document\.activeElement;\s*\n\s*if \(a === null \|\| a === document\.body\) fallback\.focus\(\);/,
  );
});

// ---------------------------------------------------------------------------
// The other half of a badge: its colour pair has to exist
// ---------------------------------------------------------------------------

test('every colour family the model can emit is defined in tokens.css and mapped in app.css', () => {
  // The classifier only NAMES a family; `--badge-<kind>-fg` and the
  // `[data-kind]` rule are what colour the icon. A kind added or renamed on
  // one side only renders a grey glyph, which no DOM test can see.
  const model = readSource('web', 'src', 'ui', 'files-model.ts');
  const tokens = readSource('web', 'src', 'styles', 'tokens.css');
  const app = readAppCss();
  const list = model.slice(model.indexOf('export const BADGE_KINDS = ['), model.indexOf('] as const;'));
  const kinds = new Set(Array.from(list.matchAll(/'([a-z]+)'/g), (m) => m[1] as string));
  assert.ok(kinds.size >= 13, `non-vacuity: found ${kinds.size} families in files-model.ts`);
  assert.ok(kinds.has('plain'), 'the fallback family is one of them');

  const missing: string[] = [];
  for (const k of kinds) {
    if (!tokens.includes(`--badge-${k}-fg:`)) missing.push(`tokens.css --badge-${k}-fg`);
    // `plain` is the base rule's own colour, so it needs no data-kind selector.
    if (k !== 'plain' && !app.includes(`.files-icon[data-kind='${k}']`)) {
      missing.push(`app.css .files-icon[data-kind='${k}']`);
    }
  }
  assert.deepEqual(missing, [], 'an icon family with no colour is an unexplained grey');
  assert.match(app, /\.files-icon \{[^}]*color: var\(--badge-plain-fg\)/s, 'the base icon IS plain');
});
