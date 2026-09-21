/**
 * Nocturne part A3 — the STRUCTURAL facts of the rebuilt pane, pinned by
 * source inspection (`.claude/plans/PLAN-NOCTURNE.md` §A3;
 * `design/session-manager/README-v3.md`, "Pane").
 *
 * There is no DOM in this runner and `web/src/ui/panes.ts` builds itself
 * against `document`, so what can be proven here is the SHAPE of the code that
 * builds it. Three things are worth exactly that:
 *
 *   1. NO SAMPLE DATA SHIPS. The "Background agents" table has no data source
 *      until part B7 (open decision #7), so `panes.ts` must mount
 *      `renderAgents` with an EMPTY list and `renderAgents([])` must answer
 *      `null` — i.e. the block is absent, not an empty table and certainly not
 *      the reference's demo rows. This is the one A3 pin that guards against
 *      shipping a screenshot as a feature.
 *   2. THE A3 COPY. The literals the new pane renders exist, and the Legacy
 *      ones it replaced are gone from the whole chrome.
 *   3. THE STYLE CONTRACT: `app.css` carries no `pane-scan` (the Legacy
 *      scanline decoration A3 removed) and `tokens.css` defines the token the
 *      new attention tint uses, `--color-attn-tint-soft`, with app.css
 *      consuming it — a token nothing consumes is a comment, not a contract.
 *
 * The model behind the status bar is pinned against the real function in
 * `tests/ui-pane-status-model.test.ts`. Looks, sizes and legibility stay
 * manual (`.claude/skills/verify-terminal/SKILL.md`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectRoot } from './helpers.ts';

const UI = join(projectRoot, 'web', 'src', 'ui');
const STYLES = join(projectRoot, 'web', 'src', 'styles');
const read = (p: string): string => readFileSync(p, 'utf8');

const PANES = read(join(UI, 'panes.ts'));
const AGENTS = read(join(UI, 'pane-agents.ts'));
const DND = read(join(UI, 'dnd.ts'));
const SHORTCUTS = read(join(UI, 'shortcuts.ts'));
const APP_CSS = read(join(STYLES, 'app.css'));
const TOKENS_CSS = read(join(STYLES, 'tokens.css'));

/** Source with comments removed — a comment may DISCUSS what code may not do. */
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const PANES_CODE = code(PANES);
const AGENTS_CODE = code(AGENTS);

test('non-vacuity: the A3 sources are the ones being read', () => {
  assert.ok(PANES.length > 5000, 'panes.ts looks empty');
  assert.ok(AGENTS.length > 500, 'pane-agents.ts looks empty');
  assert.ok(APP_CSS.length > 5000, 'app.css looks empty');
  assert.ok(TOKENS_CSS.length > 1000, 'tokens.css looks empty');
  assert.ok(PANES_CODE.includes('function updateStatus'), 'panes.ts must build the status bar');
  assert.ok(AGENTS_CODE.includes('export function renderAgents'), 'pane-agents.ts must export renderAgents');
});

// ---------------------------------------------------------------------------
// 1. The agents table ships empty
// ---------------------------------------------------------------------------

test('panes.ts mounts the agents renderer with an EMPTY list — no sample rows ship', () => {
  const calls = [...PANES_CODE.matchAll(/renderAgents\(([^)]*)\)/g)].map((m) => m[1] as string);
  assert.equal(calls.length, 1, `expected exactly one renderAgents call site, found ${calls.length}`);
  const arg = (calls[0] as string).trim();
  // Either the literal `[]`, or a plain identifier declared as an empty array.
  let provablyEmpty = arg === '[]';
  if (!provablyEmpty && /^[A-Za-z_$][\w$]*$/.test(arg)) {
    provablyEmpty = new RegExp(`const\\s+${arg}\\s*(:[^=]*)?=\\s*\\[\\s*\\]\\s*;`).test(PANES_CODE);
  }
  assert.ok(
    provablyEmpty,
    `renderAgents is called with ${JSON.stringify(arg)}, which is not provably empty`,
  );
  // And nothing anywhere in panes.ts builds an AgentRow.
  assert.equal(/\bname:\s*'[^']*',\s*task:/.test(PANES_CODE), false, 'panes.ts must not author agent rows');
});

test('renderAgents([]) is null by construction — the block is absent, not empty', () => {
  assert.match(
    AGENTS_CODE,
    /if\s*\(\s*(rows\.length\s*===\s*0|!rows\.length)\s*\)\s*return\s+null\s*;/,
    'pane-agents.ts must return null for an empty row list',
  );
  // The guard has to be the FIRST statement of the function, or a DOM call
  // above it would throw in this DOM-free runner instead of returning null.
  const body = AGENTS_CODE.slice(AGENTS_CODE.indexOf('export function renderAgents'));
  const guard = body.search(/if\s*\(\s*(rows\.length\s*===\s*0|!rows\.length)/);
  const firstDom = body.search(/\bel\(|document\./);
  assert.ok(guard !== -1 && (firstDom === -1 || guard < firstDom), 'the empty guard must come first');
  // No demo data in the module either.
  for (const demo of ['Tokens', 'Background agents']) {
    assert.ok(AGENTS_CODE.includes(demo), `the header literal ${demo} belongs here`);
  }
  assert.equal(/12\.4k|2m 10s/.test(AGENTS_CODE), false, 'the reference sample rows must not ship');
});

// ---------------------------------------------------------------------------
// 2. The A3 copy
// ---------------------------------------------------------------------------

test('the A3 pane copy is present, in the module that renders it', () => {
  for (const text of ['Own tab', 'No sessions running', 'Open history']) {
    assert.ok(PANES.includes(`'${text}'`), `panes.ts must render ${JSON.stringify(text)}`);
  }
  // The drop hint lives with the drag layer, not the pane (A3 rewrote both).
  assert.ok(
    DND.includes("'Drop here to show side by side'"),
    "dnd.ts must render 'Drop here to show side by side'",
  );
});

test('the Legacy pane vocabulary is gone from panes.ts, dnd.ts and shortcuts.ts', () => {
  const offenders: string[] = [];
  const files: [string, string][] = [
    ['web/src/ui/panes.ts', PANES],
    ['web/src/ui/dnd.ts', DND],
    ['web/src/ui/shortcuts.ts', SHORTCUTS],
  ];
  for (const [name, src] of files) {
    for (const bad of ['SPLIT HERE', 'Resume a session', 'needs input', '⇱']) {
      const i = src.indexOf(bad);
      if (i !== -1) {
        const line = src.slice(0, i).split('\n').length;
        offenders.push(`${name}:${line}  ${JSON.stringify(bad)}`);
      }
    }
  }
  assert.deepEqual(offenders, [], 'A3 replaced these. Offenders:\n  ' + offenders.join('\n  '));
});

// ---------------------------------------------------------------------------
// 3. The style contract
// ---------------------------------------------------------------------------

test('app.css carries no `pane-scan` (the Legacy scanline decoration is gone)', () => {
  assert.equal(APP_CSS.includes('pane-scan'), false, 'app.css must not style pane-scan');
  assert.equal(PANES.includes('pane-scan'), false, 'panes.ts must not create a pane-scan node');
  // Non-vacuity: the pane block itself is definitely in this stylesheet.
  assert.ok(APP_CSS.includes('.pane-status-item'), 'app.css must style the new status bar');
});

test('tokens.css defines --color-attn-tint-soft and app.css consumes it', () => {
  const m = /--color-attn-tint-soft:\s*([^;]+);/.exec(TOKENS_CSS);
  assert.notEqual(m, null, 'tokens.css must declare --color-attn-tint-soft');
  assert.ok((m?.[1] as string).trim().length > 0, 'the token needs a value');
  assert.ok(
    APP_CSS.includes('var(--color-attn-tint-soft)'),
    'app.css must use var(--color-attn-tint-soft)',
  );
});

// ---------------------------------------------------------------------------
// 4. The terminal ground (part A4b, user report 2026-09-10)
// ---------------------------------------------------------------------------
//
// xterm 6.0's own stylesheet paints `.xterm .xterm-viewport` #000, and in 6.0
// that element is an EMPTY div positioned absolute inset 0 over the whole
// `.xterm` box — the padding included — while the runtime only colours the
// sibling `.xterm-scrollable-element`. Unoverridden, that is a ~17px black
// frame around the text on the Nocturne ground (measured: `#000000` on the
// top/left/right padding of every pane in the 1-, 2-, 3- and 4-pane layouts).
// The override must stay, must stay token-driven (ui/theme.ts is the module
// that writes --term-bg inline on :root — unwired since A2, re-wired by part
// B9 for the live recolouring), and must not touch the padding, which the fit
// addon subtracts to keep cols/rows exact.

test('the whole terminal card is painted from --term-bg, never a literal colour', () => {
  const block = /\.term-host \.xterm,([\s\S]*?)\}/.exec(APP_CSS);
  assert.ok(block, 'app.css must override the xterm stylesheet under .term-host');
  const rule = block[0] as string;
  assert.match(rule, /\.xterm-viewport/, 'the #000 carrier in xterm 6.0 is .xterm-viewport');
  assert.match(rule, /background-color:\s*var\(--term-bg\)/);
  assert.doesNotMatch(
    rule,
    /#[0-9a-fA-F]{3,8}/,
    'a hardcoded hex here would not follow the live --term-bg override B9 restores',
  );
  assert.ok(
    /\.pane-body\s*\{[^}]*background:\s*var\(--term-bg\)/.test(APP_CSS),
    'the pane card behind the mount must be the same themable ground',
  );
});

test('the xterm mount keeps its padding — the fit addon subtracts it', () => {
  assert.ok(
    /\.term-host \.xterm \{\s*padding:\s*var\(--space-4\) var\(--space-6\);\s*\}/.test(APP_CSS),
    'the padding is the cols/rows contract: changing it changes every terminal size',
  );
});

test('the band’s two surfaces are repainted — and the IME popup is NOT one of them', () => {
  const rule = /(^|\n)((?:\.term-host [^{\n]*,\n)*\.term-host [^{\n]*)\{\s*background-color:\s*var\(--term-bg\);\s*\}/.exec(
    APP_CSS,
  );
  assert.ok(rule, 'app.css must repaint the xterm surfaces from --term-bg in one rule');
  const selectors = (rule[2] as string)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  // Exactly two, and they are the band: `.term-host .xterm` is the mount
  // itself (its padding is the band's canvas, nothing else paints it) and
  // `.xterm-viewport` is xterm 6.0's empty absolutely-positioned #000 div over
  // the whole box. xterm's other #000, `.composition-view`, is deliberately
  // NOT here — see the exemption in the guard below.
  assert.deepEqual(selectors, ['.term-host .xterm', '.term-host .xterm .xterm-viewport']);
});

test('the override covers every black surface the INSTALLED xterm ships — an upgrade that adds one fails here', () => {
  // The band was xterm's own stylesheet, not ours, so the fix is only as
  // complete as that stylesheet is known. Read the installed copy (the suite
  // already runs against an installed tree — node-pty is a native dependency)
  // and pin the set: a bumped xterm that paints a fourth surface black lands
  // here instead of in a screenshot the user has to report.
  const xtermCss = readFileSync(
    join(projectRoot, 'node_modules', '@xterm', 'xterm', 'css', 'xterm.css'),
    'utf8',
  );
  assert.ok(xtermCss.length > 1000, 'the installed @xterm/xterm stylesheet looks empty');
  const black = new Set<string>();
  /** Every rule body the installed stylesheet declares per selector. */
  const bodies = new Map<string, string[]>();
  for (const m of xtermCss.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const body = m[2] as string;
    for (const raw of (m[1] as string).split(',')) {
      const sel = raw.trim();
      bodies.set(sel, [...(bodies.get(sel) ?? []), body]);
    }
    // `background`/`background-color`, not box-shadow: a shadow is not a ground.
    if (!/(^|[\s;])background(-color)?:\s*(#000\b|#000000\b|black\b)/.test(body)) continue;
    for (const sel of (m[1] as string).split(',')) black.add(sel.trim());
  }
  assert.deepEqual(
    [...black].sort(),
    ['.xterm .composition-view', '.xterm .xterm-viewport'],
    'the set of black surfaces xterm ships changed — app.css must cover the new one too',
  );
  // Exempt, explicitly and for a reason (scope-reviewer 2026-09-13): the IME
  // pre-edit overlay is `display: none` until the user composes, so it is no
  // part of the band, and its #000/#FFF is the ONLY cue separating the
  // uncommitted composing string from the committed text underneath it.
  // Painting it the terminal ground would take that cue away.
  const EXEMPT = ['.xterm .composition-view'];
  for (const sel of EXEMPT) {
    assert.ok(black.has(sel), `${sel} is no longer a black surface — drop it from EXEMPT`);
    // The exemption rests on ONE fact about the installed stylesheet: the
    // overlay is hidden until an IME pre-edit (`.active` is what shows it), so
    // the user never sees it on the ground. An xterm that started painting it
    // by default would put a black box back on #0b0d14 while the exemption
    // quietly said that was fine — so the fact is pinned, not assumed.
    const declared = (bodies.get(sel) ?? []).join('\n');
    assert.match(
      declared,
      /display:\s*none/,
      `${sel} is exempt ONLY because it is hidden until it is composed into — it no longer is`,
    );
  }
  const repainted = [...black].filter((s) => !EXEMPT.includes(s));
  assert.ok(repainted.length > 0, 'non-vacuity: every black surface cannot be exempt');
  for (const sel of repainted) {
    const scoped = sel.replace('.xterm ', '.term-host .xterm ');
    assert.ok(
      APP_CSS.includes(scoped),
      `app.css must repaint ${scoped} — xterm paints it #000 from its own stylesheet`,
    );
  }
  for (const sel of EXEMPT) {
    const scoped = sel.replace('.xterm ', '.term-host .xterm ');
    assert.ok(
      !APP_CSS.includes(scoped),
      `${scoped} must stay at xterm's high-contrast #000/#FFF — it is the IME pre-edit cue`,
    );
  }
});
