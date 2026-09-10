/**
 * Nocturne part A3 — the STRUCTURAL facts of the rebuilt pane, pinned by
 * source inspection (`.claude/PLAN-NOCTURNE.md` §A3;
 * `design_handoff_session_manager/README-v3.md`, "Pane").
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
