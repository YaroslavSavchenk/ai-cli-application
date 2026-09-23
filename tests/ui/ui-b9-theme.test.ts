/**
 * Nocturne B9 (`.claude/plans/nocturne/PLAN-B9.md`) — the terminal colours the
 * Settings page picks, driven through the REAL `web/src/ui/theme.ts`.
 *
 * WHAT THIS FILE OWNS, that no other suite can see:
 *   1. What lands on `:root`. `document.documentElement.style` here is a
 *      recording double, so an apply is asserted as the ORDERED list of
 *      operations it performed — the six `setProperty` calls with the exact
 *      hexes `coloursOf` derives, or the six `removeProperty` calls the
 *      default pair does instead (D2: Nocturne is the ABSENCE of an override,
 *      so `--xt-bright-white` stays tokens.css's `#f3f5fe`, a step no ramp
 *      carries). A seventh property, or a write where a removal belongs, fails.
 *   2. The two stores. localStorage (`ai-sm:theme:v1`) is written at once and
 *      in the v2 pair shape — a Legacy `{bg,fg,scan}` bag read from the server
 *      is rewritten as hexes with `scan` dropped; the server copy is the
 *      `theme` key of the prefs bag, written through the REAL
 *      `web/src/api.ts` (a fetch double underneath), so the GET-merge-PUT is
 *      exercised rather than imagined: the PUT has to carry `statusLine`,
 *      `behaviour` and `tools` back untouched.
 *   3. The write policy (D4): trailing-debounced ~300ms, SERIALISED — one
 *      request in flight, at most one queued follow-up carrying the latest
 *      pair — and `flush()` sends now, which is what closing the dialog does.
 *      A burst of fifty swatch drags must cost one PUT, not fifty.
 *   4. The page → control wire (D5): `buildTermColours` drives the control and
 *      nothing else; a card click, a valid hex and `sync()` are pinned against
 *      the REAL control, so what the page shows is what `:root` gets.
 *   5. The D3 CSS split: `--term-bg` is the THEMED terminal ground and nothing
 *      but terminal surfaces may read it; the editor chip, the editor/diff
 *      pane bodies and the diff itself read the untouched twin `--color-term`.
 *
 * STUBS, and why exactly these. `ui/theme.ts` imports `./terminal.ts` (which
 * imports @xterm/xterm — unimportable under `node --test`) and `../log.ts`;
 * both are replaced through `registerHooks`, and `api.ts`'s own `./log.ts` too,
 * so the only fetches this file sees are the prefs GET/PUT under test.
 * `api.ts` itself is the REAL module. Timers: `ui/theme.ts` debounces through
 * `window.setTimeout`, which the DOM double RECORDS instead of firing — so
 * nothing here waits on a clock; `runTimers()` fires what is armed, and every
 * async wait is a condition with a bounded number of turns (`until`).
 *
 * This file: boot (what the first paint does), which server value wins at
 * boot, and the page → control wire (D5). The write policy and `adopt()` are
 * in `tests/ui/ui-b9-theme-writes.test.ts`; the D3 CSS split and the boot wire
 * in `main.ts` in `tests/ui/ui-b9-theme-css.test.ts`. The shared doubles and
 * stubs are `tests/helpers/ui-b9-theme-fixture.ts`.
 *
 * Looks stay manual (`.claude/skills/verify-terminal/SKILL.md`): this proves
 * the values, not that they are pretty on a screen.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { byClass, dispatch, type FakeElement } from '../helpers/fake-dom.ts';
import {
  dom,
  ops,
  REMOVES,
  sets,
  live,
  calls,
  puts,
  H,
  type TermPair,
  TH,
  TC,
  P,
  STORAGE_KEY,
  NOCTURNE,
  AMBER,
  AMBER_COLOURS,
  PHOSPHOR,
  runTimers,
  reset,
  cached,
} from '../helpers/ui-b9-theme-fixture.ts';

// ===========================================================================
// Boot: what the first paint does
// ===========================================================================

test('an empty cache and no server opinion write NOTHING on :root — and still refresh the terminals', () => {
  reset();
  const ctl = TH.initTheme(undefined);
  assert.deepEqual(
    ops,
    REMOVES,
    'the default pair is the ABSENCE of an override: six removeProperty calls and not one write',
  );
  assert.deepEqual(ops.filter((o) => o.startsWith('set ')), [], 'zero properties written');
  assert.deepEqual(live(), []);
  assert.equal(H.refreshes, 1, 'refreshAllTerminalThemes runs anyway — a terminal reads the tokens');
  assert.deepEqual(ctl.current(), NOCTURNE);
  assert.deepEqual([...calls], [], 'boot reconciliation never writes to the server');
});

test('a non-Nocturne pair writes EXACTLY the six properties, with the preset ramp coloursOf derives', () => {
  reset();
  const ctl = TH.initTheme({ theme: AMBER });
  assert.deepEqual(AMBER, { ground: '#161010', text: '#ffe9c4' }, 'the pair under test, spelled out');
  assert.deepEqual(TC.presetColours('amber'), AMBER_COLOURS, 'the page and theme.ts share one derivation');
  // The empty cache paints first (Nocturne = the six removals), then the server
  // pair corrects it — boot order, D4.
  assert.deepEqual(ops, [
    ...REMOVES,
    'set --term-bg=#161010',
    'set --xt-fg=#e8b24a',
    'set --xt-white=#e8b24a',
    'set --xt-bright-white=#ffe9c4',
    'set --xt-cursor=#ffe9c4',
    'set --xt-bright-black=#8a6a2f',
  ]);
  assert.equal(ops.length, 12, 'six properties written — no seventh');
  assert.deepEqual(ctl.current(), AMBER);
  assert.equal(H.refreshes, 2, 'the cache paint and the server correction, both before any terminal exists');
});

test('a CUSTOM pair takes cmd = out = the text colour, and dim = text pulled 55% towards the ground', () => {
  reset();
  TH.initTheme({ theme: { ground: '#101010', text: '#ff8800' } });
  assert.equal(TC.mixHex('#ff8800', '#101010', 0.55), '#7c4609', 'the derivation, from the model itself');
  assert.deepEqual(ops, [
    ...REMOVES,
    'set --term-bg=#101010',
    'set --xt-fg=#ff8800',
    'set --xt-white=#ff8800',
    'set --xt-bright-white=#ff8800',
    'set --xt-cursor=#ff8800',
    'set --xt-bright-black=#7c4609',
  ]);
});

test('going back to Nocturne REMOVES all six — the default is tokens.css, never a copy of it', async () => {
  reset();
  const ctl = TH.initTheme({ theme: AMBER });
  ops.length = 0;
  ctl.apply(NOCTURNE);
  assert.deepEqual(ops, REMOVES, 'six removeProperty calls, no setProperty among them');
  assert.deepEqual(live(), [], 'nothing is left in force on :root');
  assert.equal(H.refreshes, 3, 'the two boot paints + the change, each repainting every live terminal');
  runTimers();
  await ctl.flush();
});

test('an UNREADABLE cache falls back to Nocturne instead of throwing (bad JSON, an array, a string)', () => {
  for (const junk of ['{not json', '[1,2,3]', '"amber"', 'null', '{"ground":"red","text":42}']) {
    reset();
    dom.storage.setItem(STORAGE_KEY, junk);
    const ctl = TH.initTheme(undefined);
    assert.deepEqual(ctl.current(), NOCTURNE, `cache ${junk}`);
    assert.deepEqual(ops, REMOVES, `cache ${junk}: the default writes nothing, it removes`);
  }
});

test('a HALF-readable cache keeps the member it can read (per-member clamp)', () => {
  reset({ cache: { ground: '#161010', text: 'nope' } });
  const ctl = TH.initTheme(undefined);
  assert.deepEqual(ctl.current(), { ground: '#161010', text: NOCTURNE.text });
  assert.deepEqual(ops, sets({ ground: '#161010', cmd: '#e9e9ed', out: '#e9e9ed', dim: TC.mixHex('#e9e9ed', '#161010', 0.55) }));
});

test('a localStorage that throws (a locked-down browser profile) costs the cache, never the colours', async () => {
  reset();
  const realStorage = (globalThis as unknown as Record<string, unknown>).localStorage;
  (globalThis as unknown as Record<string, unknown>).localStorage = {
    getItem(): string {
      throw new Error('SecurityError: storage is disabled');
    },
    setItem(): void {
      throw new Error('QuotaExceededError');
    },
    removeItem(): void {},
    clear(): void {},
  };
  try {
    const ctl = TH.initTheme({ theme: AMBER });
    assert.deepEqual(ctl.current(), AMBER, 'the server pair still paints');
    assert.deepEqual(ops, [...REMOVES, ...sets(AMBER_COLOURS)]);
    ops.length = 0;
    ctl.apply(PHOSPHOR);
    assert.deepEqual(ops.length, 6, 'and a later change still paints');
    await ctl.flush();
    assert.deepEqual(puts(), [{ ground: PHOSPHOR.ground, text: PHOSPHOR.text }], 'and is still persisted server-side');
  } finally {
    (globalThis as unknown as Record<string, unknown>).localStorage = realStorage;
  }
});

// ===========================================================================
// The server copy: which value wins at boot
// ===========================================================================

test('a LEGACY server bag {bg:9,fg:2,scan:true} paints the hexes those indexes meant, and rewrites the cache as the v2 pair WITHOUT scan', () => {
  reset();
  const ctl = TH.initTheme({ theme: { bg: 9, fg: 2, scan: true } });
  assert.deepEqual(ops, [
    ...REMOVES,
    'set --term-bg=#161010',
    'set --xt-fg=#e8b24a',
    'set --xt-white=#e8b24a',
    'set --xt-bright-white=#ffe9c4',
    'set --xt-cursor=#ffe9c4',
    'set --xt-bright-black=#8a6a2f',
  ]);
  assert.deepEqual(ctl.current(), AMBER);
  assert.equal(cached(), '{"ground":"#161010","text":"#ffe9c4"}', 'the cache is corrected, in the v2 shape');
  assert.equal(cached()?.includes('scan'), false, 'scan leaves the protocol with B9');
  assert.deepEqual([...calls], [], 'correcting the cache is not a reason to write the server');
});

test('a valid server pair BEATS the local cache — amber cached, Nocturne stored: the overrides go', () => {
  reset({ cache: AMBER });
  const ctl = TH.initTheme({ theme: NOCTURNE });
  assert.deepEqual(
    ops,
    [...sets(AMBER_COLOURS), ...REMOVES],
    'the cache paints first (no flash of default), then the server value corrects it',
  );
  assert.deepEqual(live(), []);
  assert.deepEqual(ctl.current(), NOCTURNE);
  assert.equal(cached(), '{"ground":"#0b0d14","text":"#e9e9ed"}');
});

test('a server pair that EQUALS the cache repaints nothing twice (no second apply)', () => {
  reset({ cache: AMBER });
  TH.initTheme({ theme: { ground: '#161010', text: '#FFE9C4' } });
  assert.deepEqual(ops, sets(AMBER_COLOURS), 'one paint — the upper-case hex is the same pair');
  assert.equal(H.refreshes, 1);
});

test('server GARBAGE is no opinion at all: the local cache stands', () => {
  for (const theme of ['x', {}, [], null, 42, { scan: true }, { bg: 99, fg: -1 }, { ground: 'blue' }]) {
    reset({ cache: AMBER });
    const ctl = TH.initTheme({ theme } as Record<string, unknown>);
    assert.deepEqual(ctl.current(), AMBER, `theme: ${JSON.stringify(theme)}`);
    assert.deepEqual(ops, sets(AMBER_COLOURS), `theme: ${JSON.stringify(theme)} — one paint, the cache's`);
    assert.equal(cached(), '{"ground":"#161010","text":"#ffe9c4"}', 'and the cache is not overwritten');
  }
});

test('a bag with no theme key, an absent bag and a null bag all leave the cache alone', () => {
  for (const prefs of [{}, undefined, null, { statusLine: { enabled: true } }]) {
    reset({ cache: AMBER });
    const ctl = TH.initTheme(prefs as Record<string, unknown> | undefined);
    assert.deepEqual(ctl.current(), AMBER, `prefs: ${JSON.stringify(prefs)}`);
  }
});

// ===========================================================================
// The page → control wire (D5), against the REAL control
// ===========================================================================

function pageBits(root: FakeElement): {
  cards: FakeElement[];
  groundHex: FakeElement;
  textHex: FakeElement;
  prev: FakeElement;
} {
  return {
    cards: byClass(root, 'sg-tccard'),
    groundHex: byClass(root, 'sg-tchex')[0] as FakeElement,
    textHex: byClass(root, 'sg-tchex')[1] as FakeElement,
    prev: byClass(root, 'sg-tcprev')[0] as FakeElement,
  };
}

test('a card click on the page paints :root through the control and persists that preset’s own pair', async () => {
  reset();
  const ctl = TH.initTheme(undefined);
  const page = P.buildTermColours('sg-tab-colours', ctl);
  dom.body.append(page.root);
  const { cards } = pageBits(page.root);
  const amberCard = cards.find((c) => c.textContent?.includes('Amber on espresso'));
  assert.ok(amberCard !== undefined, 'the Amber on espresso card is on the page');

  ops.length = 0;
  amberCard.click();
  assert.deepEqual(ops, sets(AMBER_COLOURS), 'the click reached :root, with the card’s own colours');
  assert.deepEqual(ctl.current(), AMBER);
  assert.equal(cached(), '{"ground":"#161010","text":"#ffe9c4"}');

  await ctl.flush();
  assert.deepEqual(puts(), [{ ground: '#161010', text: '#ffe9c4' }]);
  page.root.remove();
});

test('a valid hex typed on the page reaches :root; an incomplete one changes nothing at all', async () => {
  reset();
  const ctl = TH.initTheme(undefined);
  const page = P.buildTermColours('sg-tab-colours', ctl);
  dom.body.append(page.root);
  const { groundHex, textHex } = pageBits(page.root);

  ops.length = 0;
  for (const half of ['#12345', '#', 'abcdef', '#12345g']) {
    groundHex.value = half;
    dispatch(groundHex, 'input');
    assert.deepEqual(ops, [], `an invalid hex must not paint: ${half}`);
    assert.deepEqual(dom.win.timers, [], `an invalid hex must not schedule a write: ${half}`);
    assert.deepEqual(ctl.current(), NOCTURNE);
  }

  groundHex.value = '#123456';
  dispatch(groundHex, 'input');
  assert.deepEqual(ctl.current(), { ground: '#123456', text: NOCTURNE.text });
  textHex.value = '#ffe9c4';
  dispatch(textHex, 'input');
  assert.deepEqual(ctl.current(), { ground: '#123456', text: '#ffe9c4' });
  assert.deepEqual(ops.slice(-6), [
    'set --term-bg=#123456',
    'set --xt-fg=#ffe9c4',
    'set --xt-white=#ffe9c4',
    'set --xt-bright-white=#ffe9c4',
    'set --xt-cursor=#ffe9c4',
    `set --xt-bright-black=${TC.mixHex('#ffe9c4', '#123456', 0.55)}`,
  ]);
  assert.equal(TC.mixHex('#ffe9c4', '#123456', 0.55), '#7d8588', 'the derived dim step, spelled out');

  await ctl.flush();
  assert.deepEqual(puts().at(-1), { ground: '#123456', text: '#ffe9c4' }, 'one PUT for the burst of two');
  assert.equal(puts().length, 1);
  page.root.remove();
});

test('sync() re-seeds the page from the control and writes NOTHING back (another window chose)', async () => {
  reset();
  const ctl = TH.initTheme(undefined);
  const page = P.buildTermColours('sg-tab-colours', ctl);
  dom.body.append(page.root);
  const { cards, groundHex, textHex, prev } = pageBits(page.root);

  // The control moved underneath the page, as settings.ts's re-read does it.
  ctl.apply(AMBER);
  await ctl.flush();
  const before = puts().length;
  ops.length = 0;

  page.sync();
  assert.equal(prev.style['background-color'], '#161010', 'the preview follows');
  assert.equal(groundHex.value, '#161010');
  assert.equal(textHex.value, '#ffe9c4');
  assert.equal(
    cards.find((c) => c.getAttribute('aria-checked') === 'true')?.textContent?.includes('Amber'),
    true,
    'and so does the chosen card',
  );
  assert.deepEqual(ops, [], 'a sync is not a change: it must not repaint :root');
  assert.deepEqual(dom.win.timers, [], 'nor schedule a server write');
  assert.equal(puts().length, before, 'nor send one');
  page.root.remove();
});

test('the page hands the control the pair and nothing else (a recording double sees exact objects)', () => {
  const applied: TermPair[] = [];
  let held2: TermPair = { ...NOCTURNE };
  const rec = {
    apply(next: TermPair): void {
      applied.push({ ...next });
      held2 = { ...next };
    },
    current(): TermPair {
      return { ...held2 };
    },
  };
  reset();
  const page = P.buildTermColours('sg-tab-colours', rec);
  dom.body.append(page.root);
  assert.deepEqual(applied, [], 'building the page is not a change');

  const { cards, groundHex } = pageBits(page.root);
  cards.find((c) => c.textContent?.includes('Phosphor on void'))?.click();
  groundHex.value = '#010203';
  dispatch(groundHex, 'input');
  assert.deepEqual(applied, [
    { ground: PHOSPHOR.ground, text: PHOSPHOR.text },
    { ground: '#010203', text: PHOSPHOR.text },
  ]);
  assert.deepEqual(ops, [], 'the page itself never touches :root — ui/theme.ts does');
  assert.deepEqual(dom.win.timers, [], 'and it arms no timer of its own');
  page.root.remove();
});
