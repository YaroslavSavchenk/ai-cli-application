/**
 * `web/src/ui/prefs-model.ts` — the behaviour toggles and the hidden tool
 * cards of part B6 (`.claude/plans/nocturne/PLAN-B6.md`), as pure data.
 *
 * WHY THE CLAMPS MATTER. `prefs.json` is an OPAQUE bag to the server: it
 * stores and returns whatever is in it, validates nothing, and a user may edit
 * the file by hand. Everything here therefore reads an `unknown` and answers a
 * fully-resolved value — a wrong type is not an error to report, it is a key
 * that lands on its factory default. Two invariants have teeth beyond that:
 *
 *   - the toggles are always all three, so no consumer ever branches on
 *     `undefined` (the doors read them on every click, the terminal on every
 *     write);
 *   - at least one tool card is always visible, so a hand-edited bag can never
 *     leave the New session dialog with nothing to launch (user decision D1).
 *
 * The module is DOM-free by design, which is what lets this file import it
 * directly instead of driving it through a dialog.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectRoot } from './helpers.ts';
import {
  behaviourDefaults,
  behaviourPatch,
  clampBehaviour,
  clampHiddenTools,
  getBehaviour,
  getHiddenTools,
  initBehaviour,
  initHiddenTools,
  setBehaviour,
  setHiddenTools,
  toolsPatch,
} from '../web/src/ui/prefs-model.ts';
import { TOOL_CARDS } from '../web/src/ui/launch-args.ts';

/** The card ids the dialog draws, in the order it draws them. */
const IDS = TOOL_CARDS.map((c) => c.id);

/** The factory set, spelled out here so a silent flip of a default fails. */
const FACTORY = { reopenTabs: true, confirmEnd: true, followOutput: false };

// ---------------------------------------------------------------------------
// Behaviour toggles
// ---------------------------------------------------------------------------

test('the factory set is reopen on, confirm on, follow off — and it is handed out BY VALUE', () => {
  assert.deepEqual(behaviourDefaults(), FACTORY);
  const a = behaviourDefaults();
  a.confirmEnd = false;
  assert.deepEqual(behaviourDefaults(), FACTORY, 'a caller cannot edit the factory set');
});

test('clampBehaviour: a hostile bag lands on the factory defaults, key by key', () => {
  for (const raw of [null, undefined, 42, 'yes', [], true, () => {}]) {
    assert.deepEqual(clampBehaviour(raw), FACTORY, `${String(raw)} is not a bag`);
  }
  assert.deepEqual(clampBehaviour({}), FACTORY);
  // Only a real boolean counts: 'true', 1 and null are not "off" and not "on".
  assert.deepEqual(clampBehaviour({ reopenTabs: 'false', confirmEnd: 0, followOutput: null }), FACTORY);
  assert.deepEqual(clampBehaviour({ confirmEnd: false }), { ...FACTORY, confirmEnd: false });
  assert.deepEqual(clampBehaviour({ followOutput: true }), { ...FACTORY, followOutput: true });
  assert.deepEqual(
    clampBehaviour({ reopenTabs: false, confirmEnd: false, followOutput: true, theme: 'dark' }),
    { reopenTabs: false, confirmEnd: false, followOutput: true },
    'an unknown key is dropped, the known ones are kept',
  );
});

test('init/get/set: the store is seeded from the bag and always answers all three keys', () => {
  initBehaviour({ reopenTabs: false, followOutput: true });
  assert.deepEqual(getBehaviour(), { reopenTabs: false, confirmEnd: true, followOutput: true });
  // A partial write is a full state: the keys it does not name go back to
  // their defaults, because the panel always sends the whole set.
  setBehaviour({ confirmEnd: false });
  assert.deepEqual(getBehaviour(), { reopenTabs: true, confirmEnd: false, followOutput: false });
  initBehaviour('nonsense');
  assert.deepEqual(getBehaviour(), FACTORY);
  const got = getBehaviour();
  got.followOutput = true;
  assert.equal(getBehaviour().followOutput, false, 'the store is handed out by value');
});

test('behaviourPatch: every member is explicit, so a write can never mean "unchanged"', () => {
  const patch = behaviourPatch({ reopenTabs: false, confirmEnd: false, followOutput: true });
  assert.deepEqual(patch, { behaviour: { reopenTabs: false, confirmEnd: false, followOutput: true } });
  const cfg = { reopenTabs: true, confirmEnd: true, followOutput: false };
  const p2 = behaviourPatch(cfg);
  cfg.confirmEnd = false;
  assert.equal((p2.behaviour as { confirmEnd: boolean }).confirmEnd, true, 'the patch is a copy');
});

// ---------------------------------------------------------------------------
// Hidden tool cards
// ---------------------------------------------------------------------------

test('clampHiddenTools: only KNOWN ids survive, deduplicated, in the grid\'s own order', () => {
  assert.deepEqual(clampHiddenTools({ hidden: ['grok', 'codex'] }, IDS), ['codex', 'grok']);
  assert.deepEqual(clampHiddenTools({ hidden: ['codex', 'codex', 'codex'] }, IDS), ['codex']);
  assert.deepEqual(clampHiddenTools({ hidden: ['nano', 'emacs', 'grok'] }, IDS), ['grok']);
  assert.deepEqual(clampHiddenTools({ hidden: [1, null, {}, ['codex'], 'grok'] }, IDS), ['grok']);
});

test('clampHiddenTools: a hostile bag hides nothing', () => {
  for (const raw of [null, undefined, 7, 'codex', [], { hidden: 'codex' }, { hidden: null }, { hidden: 3 }]) {
    assert.deepEqual(clampHiddenTools(raw, IDS), [], `${JSON.stringify(raw)} hides nothing`);
  }
});

test('clampHiddenTools: hiding ALL of them keeps the first card — the dialog is never empty (D1)', () => {
  assert.deepEqual(clampHiddenTools({ hidden: [...IDS] }, IDS), IDS.slice(1));
  assert.equal(clampHiddenTools({ hidden: [...IDS] }, IDS).includes('claude'), false);
  // The same rule with a made-up card list: it is the FIRST id that stays,
  // whatever the dialog's first card happens to be.
  assert.deepEqual(clampHiddenTools({ hidden: ['a', 'b'] }, ['a', 'b']), ['b']);
  assert.deepEqual(clampHiddenTools({ hidden: [] }, []), [], 'no cards at all is not a crash');
});

test('init/get/set: the store is clamped against the ids it was seeded with', () => {
  initHiddenTools({ hidden: ['grok', 'grok', 'nano'] }, IDS);
  assert.deepEqual(getHiddenTools(), ['grok']);
  setHiddenTools(['terminal', 'codex']);
  assert.deepEqual(getHiddenTools(), ['codex', 'terminal'], 'reading order, not click order');
  setHiddenTools([...IDS]);
  assert.deepEqual(getHiddenTools(), IDS.slice(1), 'the panel cannot hide the last card either');
  setHiddenTools([]);
  assert.deepEqual(getHiddenTools(), []);
  const got = getHiddenTools();
  got.push('codex');
  assert.deepEqual(getHiddenTools(), [], 'the store is handed out by value');
});

test('toolsPatch: a copy of the list under its own key', () => {
  const list = ['codex', 'grok'];
  const patch = toolsPatch(list);
  assert.deepEqual(patch, { tools: { hidden: ['codex', 'grok'] } });
  list.push('gemini');
  assert.deepEqual(patch, { tools: { hidden: ['codex', 'grok'] } });
});

test('a boot that reads prefs.json twice is idempotent — no accumulation across runs', () => {
  initHiddenTools({ hidden: ['codex'] }, IDS);
  initHiddenTools({ hidden: ['grok'] }, IDS);
  assert.deepEqual(getHiddenTools(), ['grok']);
  initBehaviour({ confirmEnd: false });
  initBehaviour({});
  assert.deepEqual(getBehaviour(), FACTORY);
  // Leave the module as a fresh boot would: nothing hidden, factory toggles.
  initHiddenTools({}, IDS);
});

// ---------------------------------------------------------------------------
// The boot ORDER in web/src/main.ts, read from the source.
//
// WHY A SOURCE SCAN. main.ts's import graph reaches `@xterm/xterm`, a browser
// bundle `node --test` cannot load, and the boot is one long function with no
// seam — the same idiom `tests/ui-font-ready.test.ts` uses for "the font is
// awaited BEFORE the shell". What it pins is the one ordering B6 D3 depends
// on: this run's identity (`GET /api/runtime`) and the prefs bag are both IN
// before `loadUi()` reads the stored bag. Boot the other way round and an F5
// with `Reopen tabs on start` off reads its own run as a new app start and
// drops every tab the user had open — the exact loss D3 exists to prevent.
// ---------------------------------------------------------------------------

const MAIN = readFileSync(join(projectRoot, 'web', 'src', 'main.ts'), 'utf8');

test('B6 D3 boot order: runtime and prefs are in BEFORE loadUi reads the bag', () => {
  assert.ok(MAIN.includes('function boot('), 'non-vacuity: main.ts still boots');
  const load = MAIN.indexOf('st.loadUi(');
  assert.notEqual(load, -1, 'main.ts must still load the arrangement');
  assert.equal(MAIN.indexOf('st.loadUi(', load + 1), -1, 'and it does it exactly once');

  // 1. The run this page is talking to is awaited, not merely started.
  const awaited = MAIN.indexOf('await runtimeChecked;');
  assert.notEqual(awaited, -1, 'the runtime check must be awaited by name');
  assert.ok(awaited < load, 'and awaited BEFORE the bag is read');
  assert.ok(
    MAIN.indexOf('const runtimeChecked') < awaited,
    'the promise is started earlier and only joined here — the boot does not serialise on it',
  );

  // 2. The store the gate asks is seeded first, from the SAME bag the hydrate
  //    fetched: a loadUi that ran before initBehaviour would read the factory
  //    `reopenTabs: true` for a user who switched it off.
  for (const seed of ['initBehaviour(prefs?.behaviour)', 'initHiddenTools(']) {
    const at = MAIN.indexOf(seed);
    assert.notEqual(at, -1, `main.ts must still call ${seed}`);
    assert.ok(at < load, `${seed} must run before loadUi`);
  }

  // 3. The two arguments are the live answers, not constants: a hardcoded
  //    `reopen: true` or a null run would switch the gate off for everyone.
  assert.match(
    MAIN.slice(load, MAIN.indexOf(';', load)),
    /st\.loadUi\(\{ reopen: getBehaviour\(\)\.reopenTabs, run: st\.state\.serverStartedAt \}\)/,
    'loadUi is handed the preference and this run, read at that moment',
  );
});

test('B6 D3 boot order: the runtime check can FAIL without failing the boot', () => {
  // A rejected `GET /api/runtime` must settle the promise, not escape it —
  // otherwise `await runtimeChecked` hangs the boot at the step before the
  // shell, and the app never mounts at all.
  const chain = MAIN.slice(MAIN.indexOf('const runtimeChecked'), MAIN.indexOf('await runtimeChecked;'));
  assert.match(chain, /\.catch\(\(err: unknown\) => \{/, 'the chain ends in a catch of its own');
  assert.equal(
    /\.then\([^)]*,\s*\(/.test(chain),
    false,
    'and not the two-argument then, which lets a throw in the success path escape',
  );
  // `run: null` is the honest answer then, and state.ts treats it as "nothing
  // against this bag" — tests/ui-state.test.ts owns that half.
  assert.match(MAIN, /run: st\.state\.serverStartedAt/);
});
