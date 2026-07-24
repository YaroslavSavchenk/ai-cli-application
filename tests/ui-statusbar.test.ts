/**
 * `web/src/ui/statusbar.ts` — the DOM-free honesty + format core `buildItems`.
 * It maps a fully-resolved `StatusBarCfg` (toggles) + `StatusInputs` (client-
 * side model/mode/time + poll-sourced telemetry) to an ORDERED, gated `Item[]`.
 * The render layer (makeItemEl / renderPaneStatus) turns each Item's `.role`
 * into a css class and drops the strip when the list is empty — that DOM step
 * needs a browser, but the whole honesty + format contract lives here and is
 * plain-node testable.
 *
 * The two guarantees under test:
 *   1. HONESTY GATE — an item appears ONLY when its toggle is ON *and* it has a
 *      real value. Toggle off → omitted. Toggle on, value absent → omitted.
 *      Nothing enabled/real → zero items (the caller then hides the whole bar).
 *      Never a zero-as-unknown (diff `+0 −0`) or a fabricated ratio.
 *   2. FORMAT + SEMANTIC ROLE — cost `~$0.42` (leading approximate tilde),
 *      context `ctx Nk/Mk` (k-rounded), diff `+A −D` (U+2212 minus), branch
 *      `⎇ <b>` (U+2387), skill `skill: <n>` in the ACCENT role, mode danger for
 *      bypass. `.role` (neutral | skill | danger) is the semantic color the
 *      render maps 1:1, so asserting `.role` locks color-is-semantic.
 *
 * `buildItems` is pure — no module-level DOM runs on import, so `node --test`
 * imports it directly (same pattern as ui-defaults / ui-util).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildItems } from '../web/src/ui/statusbar.ts';
import { fmtDur } from '../web/src/ui/util.ts';
import type { StatusBarCfg } from '../web/src/ui/defaults.ts';
import type { TelemetryItem } from '../shared/protocol.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ALL_OFF: StatusBarCfg = {
  model: false,
  mode: false,
  branch: false,
  cost: false,
  context: false,
  time: false,
  diff: false,
  skill: false,
};

/** All-off config with the named toggles flipped on. */
function cfgOnly(...on: (keyof StatusBarCfg)[]): StatusBarCfg {
  const c: StatusBarCfg = { ...ALL_OFF };
  for (const k of on) c[k] = true;
  return c;
}

/** The StatusInputs the fixer decoupled from SessionInfo — real values everywhere. */
function fullInputs(telOverride: TelemetryItem = {}): {
  model: string | null;
  perm: { label: string; danger: boolean } | null;
  running: boolean;
  createdAtMs: number | null;
  tel: TelemetryItem;
} {
  return {
    model: 'opus',
    perm: { label: 'acceptEdits', danger: false },
    running: true,
    createdAtMs: Date.now() - 125_000,
    tel: {
      branch: 'main',
      add: 128,
      del: 41,
      costUsd: 0.42,
      contextTokens: 62_000,
      contextMax: 200_000,
      skill: 'edit',
      ...telOverride,
    },
  };
}

/** Everything absent — the client-side fields null/false, telemetry empty. */
function emptyInputs(): ReturnType<typeof fullInputs> {
  return { model: null, perm: null, running: false, createdAtMs: null, tel: {} };
}

/** The single item produced by a one-toggle config (asserts exactly one). */
function one(items: { text: string; role: string }[]): { text: string; role: string } {
  assert.equal(items.length, 1, `expected exactly one item, got ${JSON.stringify(items)}`);
  return items[0]!;
}

// ---------------------------------------------------------------------------
// HONESTY GATE — toggle AND real value
// ---------------------------------------------------------------------------

test('gate: all toggles OFF with full real telemetry → zero items (strip hidden)', () => {
  assert.deepEqual(buildItems(ALL_OFF, fullInputs()), []);
});

test('gate: every toggle ON but every value absent → zero items (nothing fabricated)', () => {
  const cfg: StatusBarCfg = {
    model: true,
    mode: true,
    branch: true,
    cost: true,
    context: true,
    time: true,
    diff: true,
    skill: true,
  };
  assert.deepEqual(buildItems(cfg, emptyInputs()), []);
});

test('gate: a toggle ON whose value is absent is omitted (per-item, not all-or-nothing)', () => {
  // cost + branch on; only branch has a value → just the branch item survives.
  const items = buildItems(cfgOnly('cost', 'branch'), {
    ...emptyInputs(),
    tel: { branch: 'main' },
  });
  assert.deepEqual(items, [{ text: '⎇ main', role: 'neutral' }]);
});

// ---------------------------------------------------------------------------
// model — client-side, neutral
// ---------------------------------------------------------------------------

test('model: rendered verbatim in the neutral role when the toggle is on', () => {
  assert.deepEqual(one(buildItems(cfgOnly('model'), fullInputs())), {
    text: 'opus',
    role: 'neutral',
  });
});

test('model: omitted when inp.model is null (no launch-arg model)', () => {
  assert.deepEqual(buildItems(cfgOnly('model'), { ...fullInputs(), model: null }), []);
});

test('model: sourced from inp.model (client argv), NOT from tel.model (the Claude log)', () => {
  // A stray tel.model must never override the launch-arg model the pane knows.
  const items = buildItems(cfgOnly('model'), fullInputs({ model: 'sonnet-from-log' }));
  assert.equal(one(items).text, 'opus');
});

// ---------------------------------------------------------------------------
// mode — client-side; danger role is the color guarantee
// ---------------------------------------------------------------------------

test('mode: a non-dangerous mode renders its label in the NEUTRAL role', () => {
  assert.deepEqual(one(buildItems(cfgOnly('mode'), fullInputs())), {
    text: 'acceptEdits',
    role: 'neutral',
  });
});

test('mode: a danger perm (bypass) renders in the DANGER role — color is semantic', () => {
  const items = buildItems(cfgOnly('mode'), {
    ...fullInputs(),
    perm: { label: 'bypass', danger: true },
  });
  assert.deepEqual(one(items), { text: 'bypass', role: 'danger' });
});

test('mode: omitted when perm is null (default / absent permission mode)', () => {
  assert.deepEqual(buildItems(cfgOnly('mode'), { ...fullInputs(), perm: null }), []);
});

// ---------------------------------------------------------------------------
// skill — accent (skill) role
// ---------------------------------------------------------------------------

test('skill: `skill: <name>` in the ACCENT (skill) role', () => {
  assert.deepEqual(one(buildItems(cfgOnly('skill'), fullInputs())), {
    text: 'skill: edit',
    role: 'skill',
  });
});

test('skill: omitted when absent or an empty string (never a bare `skill:`)', () => {
  assert.deepEqual(buildItems(cfgOnly('skill'), fullInputs({ skill: undefined })), []);
  assert.deepEqual(buildItems(cfgOnly('skill'), fullInputs({ skill: '' })), []);
});

// ---------------------------------------------------------------------------
// cost — leading approximate tilde
// ---------------------------------------------------------------------------

test('cost: renders `~$0.42` with a LEADING tilde (the approximate signal)', () => {
  const item = one(buildItems(cfgOnly('cost'), fullInputs()));
  assert.deepEqual(item, { text: '~$0.42', role: 'neutral' });
  assert.equal(item.text[0], '~', 'the approximate tilde must lead the cost');
});

test('cost: always two decimals (toFixed(2)); zero cost still shows honestly', () => {
  assert.equal(one(buildItems(cfgOnly('cost'), fullInputs({ costUsd: 1.5 }))).text, '~$1.50');
  assert.equal(one(buildItems(cfgOnly('cost'), fullInputs({ costUsd: 0 }))).text, '~$0.00');
});

test('cost: omitted when costUsd is absent or non-finite (never `~$NaN`)', () => {
  assert.deepEqual(buildItems(cfgOnly('cost'), fullInputs({ costUsd: undefined })), []);
  assert.deepEqual(buildItems(cfgOnly('cost'), fullInputs({ costUsd: Number.NaN })), []);
});

// ---------------------------------------------------------------------------
// context — `ctx Nk/Mk`, k-rounded, never a fake ratio
// ---------------------------------------------------------------------------

test('context: `ctx Nk/Mk` with k-rounding of tokens and max', () => {
  assert.deepEqual(one(buildItems(cfgOnly('context'), fullInputs())), {
    text: 'ctx 62k/200k',
    role: 'neutral',
  });
});

test('context: k-rounding is Math.round (61500 → 62k, 61499 → 61k)', () => {
  assert.equal(
    one(buildItems(cfgOnly('context'), fullInputs({ contextTokens: 61_500 }))).text,
    'ctx 62k/200k',
  );
  assert.equal(
    one(buildItems(cfgOnly('context'), fullInputs({ contextTokens: 61_499 }))).text,
    'ctx 61k/200k',
  );
});

test('context: omitted unless BOTH tokens and max are present (never a fake ratio)', () => {
  assert.deepEqual(
    buildItems(cfgOnly('context'), fullInputs({ contextTokens: undefined })),
    [],
  );
  assert.deepEqual(buildItems(cfgOnly('context'), fullInputs({ contextMax: undefined })), []);
});

test('context: omitted when contextMax is 0 (guards the division, no ctx Nk/0k)', () => {
  assert.deepEqual(buildItems(cfgOnly('context'), fullInputs({ contextMax: 0 })), []);
});

// ---------------------------------------------------------------------------
// diff — `+A −D` with the U+2212 MINUS, omitted when nothing changed
// ---------------------------------------------------------------------------

test('diff: `+A −D` using the U+2212 minus sign (not an ASCII hyphen)', () => {
  const item = one(buildItems(cfgOnly('diff'), fullInputs()));
  assert.deepEqual(item, { text: '+128 −41', role: 'neutral' });
  assert.ok(item.text.includes('−'), 'must use U+2212 MINUS SIGN');
  assert.ok(!item.text.includes('-'), 'must NOT use an ASCII hyphen-minus');
});

test('diff: shown when only one side is non-zero (add-only / del-only)', () => {
  assert.equal(
    one(buildItems(cfgOnly('diff'), fullInputs({ add: 5, del: 0 }))).text,
    '+5 −0',
  );
  assert.equal(
    one(buildItems(cfgOnly('diff'), fullInputs({ add: 0, del: 3 }))).text,
    '+0 −3',
  );
});

test('diff: OMITTED when add and del are both zero (no `+0 −0` noise)', () => {
  assert.deepEqual(buildItems(cfgOnly('diff'), fullInputs({ add: 0, del: 0 })), []);
});

test('diff: OMITTED when both add and del are absent (undefined → treated as 0)', () => {
  assert.deepEqual(
    buildItems(cfgOnly('diff'), fullInputs({ add: undefined, del: undefined })),
    [],
  );
});

// ---------------------------------------------------------------------------
// branch — `⎇ <branch>` (U+2387)
// ---------------------------------------------------------------------------

test('branch: `⎇ <branch>` in the neutral role', () => {
  const item = one(buildItems(cfgOnly('branch'), fullInputs()));
  assert.deepEqual(item, { text: '⎇ main', role: 'neutral' });
  assert.ok(item.text.startsWith('⎇ '), 'must lead with the U+2387 branch glyph');
});

test('branch: omitted when absent or empty string', () => {
  assert.deepEqual(buildItems(cfgOnly('branch'), fullInputs({ branch: undefined })), []);
  assert.deepEqual(buildItems(cfgOnly('branch'), fullInputs({ branch: '' })), []);
});

// ---------------------------------------------------------------------------
// time — fmtDur of (now - createdAt), gated on running + a valid timestamp
// ---------------------------------------------------------------------------

test('time: formatted via fmtDur (MM:SS, no 60-wrap) when toggle on + running', () => {
  const created = Date.now() - 3_600_000; // ~1h ago → fmtDur reads 60:00, minutes don't wrap
  const item = one(buildItems(cfgOnly('time'), { ...fullInputs(), createdAtMs: created }));
  assert.equal(item.role, 'neutral');
  // buildItems calls Date.now() a few ms after `created` was captured, so the
  // floored second is this second or the previous one — both are fmtDur output.
  const elapsed = Date.now() - created;
  assert.ok(
    item.text === fmtDur(elapsed) || item.text === fmtDur(elapsed - 1000),
    `time ${item.text} must equal fmtDur(~${elapsed}ms) = ${fmtDur(elapsed)}`,
  );
  assert.match(item.text, /^\d{2,}:\d{2}$/);
});

test('time: near-zero elapsed floors to 00:00 (fmtDur applied)', () => {
  const item = one(buildItems(cfgOnly('time'), { ...fullInputs(), createdAtMs: Date.now() }));
  assert.equal(item.text, '00:00');
});

test('time: omitted when the session is not running (an exited pane keeps no clock)', () => {
  assert.deepEqual(
    buildItems(cfgOnly('time'), { ...fullInputs(), running: false }),
    [],
  );
});

test('time: omitted when createdAtMs is null (no valid timestamp)', () => {
  assert.deepEqual(
    buildItems(cfgOnly('time'), { ...fullInputs(), createdAtMs: null }),
    [],
  );
});

// ---------------------------------------------------------------------------
// Order + full-strip integration
// ---------------------------------------------------------------------------

test('order: everything on → model · mode · skill · cost · context · time · branch · diff', () => {
  const cfg: StatusBarCfg = {
    model: true,
    mode: true,
    branch: true,
    cost: true,
    context: true,
    time: true,
    diff: true,
    skill: true,
  };
  const created = Date.now() - 125_000;
  const items = buildItems(cfg, {
    model: 'opus',
    perm: { label: 'bypass', danger: true },
    running: true,
    createdAtMs: created,
    tel: {
      branch: 'main',
      add: 128,
      del: 41,
      costUsd: 0.42,
      contextTokens: 62_000,
      contextMax: 200_000,
      skill: 'edit',
    },
  });
  // Time is between context and branch; assert its slot + format separately so
  // the wall clock does not make the rest of the row flaky.
  assert.equal(items.length, 8);
  assert.deepEqual(
    items.map((i) => ({ text: i.text, role: i.role })).filter((_, idx) => idx !== 5),
    [
      { text: 'opus', role: 'neutral' },
      { text: 'bypass', role: 'danger' },
      { text: 'skill: edit', role: 'skill' },
      { text: '~$0.42', role: 'neutral' },
      { text: 'ctx 62k/200k', role: 'neutral' },
      { text: '⎇ main', role: 'neutral' },
      { text: '+128 −41', role: 'neutral' },
    ],
  );
  assert.match(items[5]!.text, /^\d{2,}:\d{2}$/, 'the time slot sits between context and branch');
  assert.equal(items[5]!.role, 'neutral');
});
