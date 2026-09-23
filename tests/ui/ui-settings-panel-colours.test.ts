/**
 * `web/src/ui/settings.ts` — the Settings panel's Terminal colours page
 * (Nocturne B9): it drives the injected theme control (the fixture's recording
 * stub), flushes the debounced write on close, adopts another window's stored
 * pair on the re-read without undoing a pick made meanwhile, and accepts a
 * custom colour only when it is a whole colour. Split out of
 * `ui-settings-panel.test.ts`.
 *
 * Seam: the REAL module against the DOM double in `tests/helpers/fake-dom.ts`,
 * booted once per file by `tests/helpers/ui-settings-panel-fixture.ts` (the real
 * `ui/util.ts`, `ui/launch-args.ts`, `ui/statusline-model.ts`,
 * `ui/term-colours.ts` and `ui/term-colours-model.ts` take part; only the
 * non-pure imports are stubbed — see the fixture). Tests in one file share the
 * one panel and run in order.
 *
 * Why it matters: the selection is the control's, not the page's — a re-read
 * that re-applied the stored pair would silently undo the user's pick.
 *
 * NOT claimed (browser work, `.claude/skills/verify-terminal/SKILL.md`):
 * layout, colour rendering, that a native colour swatch opens a picker,
 * hit-testing, screen-reader output.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { byClass, dispatch, type FakeElement } from '../helpers/fake-dom.ts';
import {
  H,
  T,
  panel,
  panelOf,
  reopen,
  settle,
  tab,
  themeAdopted,
  themeApplied,
  themeFlushes,
} from '../helpers/ui-settings-panel-fixture.ts';

// ===========================================================================
// Terminal colours — LIVE since part B9: the page drives the injected control
// ===========================================================================

/**
 * The selection survives a close/open (since part B9 it is the control's, and
 * the control is this suite's stub), so a case that wants to start from the
 * default says so.
 */
function resetColours(): void {
  const reset = byClass(panelOf('colours'), 'sg-textbtn').find((b) => b.textContent === 'Reset to Nocturne');
  assert.ok(reset !== undefined, 'the page carries Reset to Nocturne');
  reset.click();
}

const nocturne = (): { ground: string; cmd: string } => ({
  ground: T.GROUNDS[0]?.hex as string,
  cmd: T.RAMPS[0]?.cmd as string,
});

function colourPage(): {
  page: FakeElement;
  prev: FakeElement;
  cards: FakeElement[];
  groundHex: FakeElement;
  textHex: FakeElement;
} {
  const page = panelOf('colours');
  return {
    page,
    prev: byClass(page, 'sg-tcprev')[0] as FakeElement,
    cards: byClass(page, 'sg-tccard'),
    groundHex: byClass(page, 'sg-tchex')[0] as FakeElement,
    textHex: byClass(page, 'sg-tchex')[1] as FakeElement,
  };
}

test('the Terminal colours page opens on Nocturne, previewed in the terminal’s own type', async () => {
  await reopen();
  tab('Terminal colours').click();
  resetColours();
  const { page, prev, cards, groundHex, textHex } = colourPage();
  assert.equal(byClass(page, 'sg-title')[0]?.textContent, 'Terminal colours');
  assert.equal(cards.length >= 5, true, `a shelf of schemes: ${cards.length}`);
  assert.equal(byClass(cards[0] as FakeElement, 'sg-tcname')[0]?.textContent, 'Nocturne');
  assert.equal(cards[0]?.getAttribute('aria-checked'), 'true', 'Nocturne is the default');
  assert.ok(cards[0]?.classList.contains('is-sel'));
  assert.equal(prev.style['background-color'], nocturne().ground);
  assert.equal(byClass(prev, 'sg-tcline')[0]?.style.color, nocturne().cmd);
  assert.equal(groundHex.value, nocturne().ground);
  assert.equal(textHex.value, nocturne().cmd);
  assert.deepEqual(byClass(page, 'sg-note'), [], 'part B9 made the page real: no honesty line');
  assert.equal(themeApplied.at(-1), `${nocturne().ground}/${nocturne().cmd}`, 'Reset reached the control');
  // Three ink steps, and the dim line is not the bright one.
  const inks = byClass(prev, 'sg-tcline').map((l) => l.style.color);
  assert.equal(inks.length, 3);
  assert.notEqual(inks[0], inks[2]);
});

test('the panel flushes the debounced colour write when the dialog closes (part B9)', async () => {
  await reopen();
  tab('Terminal colours').click();
  const before = themeFlushes;
  panel.close();
  assert.equal(themeFlushes, before + 1, 'closing sends a pending server write NOW');
  // And it is the close that does it, not the open.
  panel.open();
  await settle();
  assert.equal(themeFlushes, before + 1);
  panel.close();
});

test('the re-read on open ADOPTS the stored pair and re-seeds the page (another window chose)', async () => {
  panel.close();
  // Amber on espresso, as another window would have left it in the bag.
  const amber = { ground: T.GROUNDS[9]?.hex as string, text: T.RAMPS[2]?.cmd as string };
  H.prefs = { theme: amber };
  const applies = themeApplied.length;
  await reopen();
  tab('Terminal colours').click();
  assert.equal(themeAdopted.at(-1), `${amber.ground}/${amber.text}`, 'the control was handed the stored pair');
  assert.equal(
    themeApplied.length,
    applies,
    'through adopt(), not apply(): a pair that came FROM the server is never written back',
  );
  const { prev, cards } = colourPage();
  assert.equal(prev.style['background-color'], amber.ground, 'and the page shows it');
  assert.equal(
    cards.find((c) => c.getAttribute('aria-checked') === 'true')?.textContent?.includes('Amber'),
    true,
  );
  H.prefs = {};
  await reopen();
  resetColours();
  panel.close();
});

test('a colour picked while the re-read is in the air is NOT undone by it (the writes guard counts it)', async () => {
  // settings.ts wraps the injected control so a colour counts as a write of
  // this open; without that `writes += 1` a slow GET would land after the user
  // picked a scheme and quietly repaint every terminal in the OLD one.
  panel.close();
  let release!: () => void;
  H.gate = new Promise<void>((res) => {
    release = res;
  });
  // What the other window left on disk: Amber on espresso.
  const amber = `${T.GROUNDS[9]?.hex as string}/${T.RAMPS[2]?.cmd as string}`;
  H.prefs = { theme: { ground: T.GROUNDS[9]?.hex as string, text: T.RAMPS[2]?.cmd as string } };
  const adopts = themeAdopted.length;
  panel.open();
  await settle();
  tab('Terminal colours').click();
  const { cards } = colourPage();
  const phosphor = cards.find((c) => c.textContent?.includes('Phosphor on void')) as FakeElement;
  phosphor.click();
  const mine = `${T.GROUNDS[1]?.hex as string}/${T.RAMPS[1]?.cmd as string}`;
  assert.equal(themeApplied.at(-1), mine, 'the user chose Phosphor while the answer was in the air');

  release();
  await settle();
  await settle();
  assert.equal(themeApplied.at(-1), mine, 'the late answer must not re-apply the stored pair');
  assert.notEqual(themeApplied.at(-1), amber);
  assert.equal(themeAdopted.length, adopts, 'and the guarded re-read adopted nothing either');
  assert.equal(
    colourPage()
      .cards.find((c) => c.getAttribute('aria-checked') === 'true')
      ?.textContent?.includes('Phosphor'),
    true,
    'and the page still shows what the user picked',
  );
  H.gate = null;
  H.prefs = {};
  await reopen();
  resetColours();
  panel.close();
});

test('picking a scheme moves the preview, the cards and both fields — and nothing else', async () => {
  await reopen();
  tab('Terminal colours').click();
  resetColours();
  const { cards, prev, groundHex, textHex } = colourPage();
  const before = H.writes.length;
  (cards[1] as FakeElement).click();
  assert.equal(cards[1]?.getAttribute('aria-checked'), 'true');
  assert.equal(cards[0]?.getAttribute('aria-checked'), 'false');
  assert.equal(prev.style['background-color'], T.GROUNDS[1]?.hex);
  assert.equal(byClass(prev, 'sg-tcline')[0]?.style.color, T.RAMPS[1]?.cmd);
  assert.equal(byClass(prev, 'sg-tcline')[2]?.style.color, T.RAMPS[1]?.dim);
  assert.equal(groundHex.value, T.GROUNDS[1]?.hex);
  assert.equal(textHex.value, T.RAMPS[1]?.cmd);
  assert.equal(H.writes.length, before, 'A7 writes no prefs from this page (part B9 does)');
  // One tab stop in the row, on the chosen card.
  assert.deepEqual(
    cards.map((c) => c.tabIndex),
    cards.map((_, i) => (i === 1 ? 0 : -1)),
  );
});

test('the scheme row answers the arrow keys', async () => {
  await reopen();
  tab('Terminal colours').click();
  resetColours();
  const { page, cards } = colourPage();
  const grid = byClass(page, 'sg-tcgrid')[0] as FakeElement;
  assert.equal(grid.getAttribute('role'), 'radiogroup');
  dispatch(grid, 'keydown', { key: 'ArrowRight' });
  assert.equal(cards[1]?.getAttribute('aria-checked'), 'true');
  dispatch(grid, 'keydown', { key: 'ArrowLeft' });
  assert.equal(cards[0]?.getAttribute('aria-checked'), 'true');
  dispatch(grid, 'keydown', { key: 'End' });
  assert.equal(cards.at(-1)?.getAttribute('aria-checked'), 'true');
});

test('a custom colour is accepted only when it is a whole colour, and it drops the preset', async () => {
  await reopen();
  tab('Terminal colours').click();
  resetColours();
  const { page, prev, cards, groundHex } = colourPage();

  groundHex.value = '#12345';
  dispatch(groundHex, 'input');
  assert.ok(groundHex.classList.contains('is-bad'), 'a half-typed colour is flagged');
  assert.equal(groundHex.getAttribute('aria-invalid'), 'true');
  assert.equal(prev.style['background-color'], nocturne().ground, 'and the preview does not move');
  assert.equal(cards[0]?.getAttribute('aria-checked'), 'true');

  groundHex.value = '#123456';
  dispatch(groundHex, 'input');
  assert.equal(groundHex.classList.contains('is-bad'), false);
  assert.equal(prev.style['background-color'], '#123456');
  assert.deepEqual(
    cards.map((c) => c.getAttribute('aria-checked')),
    cards.map(() => 'false'),
    'a custom pair is no preset',
  );
  // The row keeps a tab stop even with no card chosen.
  assert.equal(cards[0]?.tabIndex, 0);

  const reset = byClass(page, 'sg-textbtn').find((b) => b.textContent === 'Reset to Nocturne');
  assert.ok(reset !== undefined);
  reset.click();
  assert.equal(prev.style['background-color'], nocturne().ground);
  assert.equal(cards[0]?.getAttribute('aria-checked'), 'true');
});

test('the native swatch and the hex field are two views of one value', async () => {
  await reopen();
  tab('Terminal colours').click();
  resetColours();
  const { page, prev, textHex } = colourPage();
  const swatches = byClass(page, 'sg-tcswatch');
  assert.deepEqual(
    swatches.map((s) => s.type),
    ['color', 'color'],
    'a native colour input, not a home-made picker',
  );
  assert.deepEqual(
    byClass(page, 'sg-tclb').map((l) => l.textContent),
    ['Ground', 'Text'],
  );
  const textSwatch = swatches[1] as FakeElement;
  textSwatch.value = '#ff8800';
  dispatch(textSwatch, 'input');
  assert.equal(byClass(prev, 'sg-tcline')[0]?.style.color, '#ff8800');
  assert.equal(textHex.value, '#ff8800', 'the hex field follows the swatch');
});
