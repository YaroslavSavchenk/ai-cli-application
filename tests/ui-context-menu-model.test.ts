/**
 * `web/src/ui/context-menu-model.ts` — what A9b's row context menu offers
 * (user decision 3, 2026-09-16, `.claude/PLAN-A9B.md` §3), what it is called,
 * where it opens, and where the arrows go.
 *
 * WHY here and not in a DOM test: `tests/fake-dom.ts` MEASURES NOTHING —
 * `getBoundingClientRect` answers only the rect a test set — so a menu that
 * decided its own position by reading the document could not be covered at
 * all. The geometry is a pure function for exactly that reason, and this file
 * is where "it is always whole on screen" is actually proven. The entries are
 * here for the second reason: they are COPY, and copy is checked against the
 * rules, not against a screenshot.
 *
 * NOT claimed here (needs a browser,
 * `.claude/skills/verify-terminal/SKILL.md`): that a menu is drawn, that a
 * right-click opens it, that focus roves, or that a choice does anything.
 * That is brief 2. And nothing in A9b copies a byte — part B10 owns that, and
 * the two disabled entries below say so out loud.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COPY_NOTE,
  MENU_MARGIN,
  PASTE_NOTE,
  itemsFor,
  menuLabel,
  menuPosition,
  nextItem,
  type MenuItem,
  type RowSubject,
} from '../web/src/ui/context-menu-model.ts';
import { COPY_LABEL } from '../web/src/ui/files-select-model.ts';

const folder = (o: Partial<RowSubject> = {}): RowSubject => ({
  dir: true,
  name: 'src',
  open: false,
  ...o,
});
const file = (o: Partial<RowSubject> = {}): RowSubject => ({
  dir: false,
  name: 'main.ts',
  open: false,
  ...o,
});

const shape = (items: readonly MenuItem[]): string[] =>
  items.map((i) => `${i.action}:${i.label}:${i.enabled ? 'on' : 'off'}`);

// ---------------------------------------------------------------------------
// The entries
// ---------------------------------------------------------------------------

test('itemsFor: a CLOSED folder offers Open, and a closed one is what a folder usually is', () => {
  assert.deepEqual(shape(itemsFor(folder({ open: false }))), [
    'toggle:Open:on',
    'copy:Copy:off',
    'paste:Paste:off',
    'copy-files:Copy files here…:on',
  ]);
});

test('itemsFor: an OPEN folder offers Close — the entry NAMES what the click would do', () => {
  assert.deepEqual(shape(itemsFor(folder({ open: true }))), [
    'toggle:Close:on',
    'copy:Copy:off',
    'paste:Paste:off',
    'copy-files:Copy files here…:on',
  ]);
  // One entry, one action: `Open` and `Close` are the SAME toggle, so the DOM
  // half has one branch to wire, not two.
  assert.equal(itemsFor(folder({ open: true }))[0]?.action, 'toggle');
  assert.equal(itemsFor(folder({ open: false }))[0]?.action, 'toggle');
});

test('itemsFor: a FILE offers the two ways the app can show it, plus Copy — and no Paste', () => {
  assert.deepEqual(shape(itemsFor(file())), [
    'open:Open:on',
    'open-beside:Open beside:on',
    'copy:Copy:off',
  ]);
  assert.equal(
    itemsFor(file()).some((i) => i.action === 'paste'),
    false,
    'files do not take files',
  );
  assert.equal(
    itemsFor(file()).some((i) => i.action === 'copy-files'),
    false,
  );
});

test('itemsFor: the folder entry and the copy strip say the SAME words about the same gesture', () => {
  const entry = itemsFor(folder()).find((i) => i.action === 'copy-files');
  assert.equal(entry?.label, COPY_LABEL);
  assert.equal(entry?.label, 'Copy files here…');
});

test('the two notes are exactly the sentences the copy rules allow — no product, no path, no key name', () => {
  assert.equal(COPY_NOTE, 'The app cannot put files on the clipboard yet.');
  assert.equal(PASTE_NOTE, 'The menu cannot read the clipboard. Paste with the keyboard instead.');
});

test('a DISABLED entry carries its note; an ENABLED one carries none', () => {
  const rows = [folder({ open: false }), folder({ open: true }), file()];
  let disabled = 0;
  let enabled = 0;
  for (const row of rows) {
    for (const item of itemsFor(row)) {
      if (item.enabled) {
        assert.equal(item.note, undefined, `${item.action} is enabled and needs no excuse`);
        enabled += 1;
      } else {
        assert.ok(
          item.note !== undefined && item.note.length > 0,
          `${item.action} is disabled and must say why`,
        );
        disabled += 1;
      }
    }
  }
  // Non-vacuity, and the count of what is not built yet: Copy on all three
  // rows, Paste on the two folders.
  assert.equal(disabled, 5);
  assert.equal(enabled, 6);
});

test('the disabled entries are exactly Copy (everywhere) and Paste (folders only), with their own sentence each', () => {
  const f = itemsFor(folder());
  assert.equal(f.find((i) => i.action === 'copy')?.note, COPY_NOTE);
  assert.equal(f.find((i) => i.action === 'paste')?.note, PASTE_NOTE);
  assert.equal(itemsFor(file()).find((i) => i.action === 'copy')?.note, COPY_NOTE);
});

test('itemsFor hands out a FRESH list and fresh entries every call', () => {
  // The DOM half (brief 2) holds the list of the menu that is open and writes
  // on it (a roving index, an `is-sel`, a label swap). A shared array or shared
  // entry objects would let one menu poison every menu opened after it, and
  // nothing else in this suite would notice (mutation gate, 2026-09-16).
  const a = itemsFor(file());
  const b = itemsFor(file());
  assert.notEqual(a, b, 'two calls, two arrays');
  assert.notEqual(a[0], b[0], 'two calls, two entry objects');
  const first = a[0];
  if (first !== undefined) first.enabled = false;
  a.pop();
  assert.deepEqual(shape(itemsFor(file())), [
    'open:Open:on',
    'open-beside:Open beside:on',
    'copy:Copy:off',
  ]);
  const f = itemsFor(folder());
  const last = f[f.length - 1];
  if (last !== undefined) last.label = 'poisoned';
  assert.deepEqual(shape(itemsFor(folder())), [
    'toggle:Open:on',
    'copy:Copy:off',
    'paste:Paste:off',
    'copy-files:Copy files here…:on',
  ]);
});

test('menuLabel: the menu is named after the row it belongs to', () => {
  assert.equal(menuLabel(folder()), 'actions for src');
  assert.equal(menuLabel(file()), 'actions for main.ts');
  assert.equal(menuLabel(folder({ name: 'Session Manager' })), 'actions for Session Manager');
});

test('no label, note or menu name carries a path, a flag or a decorative separator', () => {
  const strings = [
    menuLabel(folder()),
    menuLabel(file()),
    ...[folder({ open: true }), folder({ open: false }), file()].flatMap((r) =>
      itemsFor(r).flatMap((i) => [i.label, i.note ?? '']),
    ),
  ];
  assert.ok(strings.length >= 20, `non-vacuity: only ${strings.length} strings swept`);
  for (const s of strings) {
    assert.equal(s.includes('/'), false, s);
    assert.equal(/(^|\s)--/.test(s), false, s);
    assert.equal(s.includes(' — ') || s.includes(' · ') || s.includes(' | '), false, s);
    // No key names in the copy: the notes point at "the keyboard", never at a
    // chord (PROJECT-SCOPE, 2026-07-25).
    assert.equal(/\b(Ctrl|Cmd|Alt|Shift|F10)\b/.test(s), false, s);
  }
});

// ---------------------------------------------------------------------------
// menuPosition — flip, THEN clamp
// ---------------------------------------------------------------------------

const SIZE = { w: 200, h: 160 };
const VP = { w: 1000, h: 800 };

test('menuPosition: room everywhere — the menu opens exactly where it was asked to', () => {
  assert.deepEqual(menuPosition({ x: 300, y: 200 }, SIZE, VP), { x: 300, y: 200 });
});

test('menuPosition: the RIGHT edge — it opens leftward from the point, not slid along the glass', () => {
  // 900 + 200 = 1100 > 1000, so the flip puts its right edge on the pointer.
  assert.deepEqual(menuPosition({ x: 900, y: 200 }, SIZE, VP), { x: 700, y: 200 });
  // Flipping is what a clamp-only rule would have got wrong: that answer is
  // 1000 - 200 - 8 = 792, which covers the row the pointer is standing on.
  assert.notEqual(menuPosition({ x: 900, y: 200 }, SIZE, VP).x, 792);
});

test('menuPosition: the BOTTOM edge — it opens upward', () => {
  assert.deepEqual(menuPosition({ x: 300, y: 700 }, SIZE, VP), { x: 300, y: 540 });
});

test('menuPosition: the LEFT and TOP edges — nothing to flip, the margin is the floor', () => {
  assert.deepEqual(menuPosition({ x: 0, y: 0 }, SIZE, VP), { x: MENU_MARGIN, y: MENU_MARGIN });
  assert.deepEqual(menuPosition({ x: 3, y: 300 }, SIZE, VP), { x: MENU_MARGIN, y: 300 });
  assert.deepEqual(menuPosition({ x: 300, y: 2 }, SIZE, VP), { x: 300, y: MENU_MARGIN });
  // Negative input (a pointer event outside the viewport) still lands inside.
  assert.deepEqual(menuPosition({ x: -50, y: -50 }, SIZE, VP), {
    x: MENU_MARGIN,
    y: MENU_MARGIN,
  });
});

test('menuPosition: all four corners stay whole on screen', () => {
  const corners = [
    { at: { x: 0, y: 0 }, want: { x: 8, y: 8 } },
    { at: { x: 1000, y: 0 }, want: { x: 792, y: 8 } },
    { at: { x: 0, y: 800 }, want: { x: 8, y: 632 } },
    { at: { x: 1000, y: 800 }, want: { x: 792, y: 632 } },
  ];
  for (const c of corners) {
    const p = menuPosition(c.at, SIZE, VP);
    assert.deepEqual(p, c.want, JSON.stringify(c.at));
    assert.ok(p.x >= MENU_MARGIN && p.y >= MENU_MARGIN, JSON.stringify(p));
    assert.ok(p.x + SIZE.w <= VP.w - MENU_MARGIN, JSON.stringify(p));
    assert.ok(p.y + SIZE.h <= VP.h - MENU_MARGIN, JSON.stringify(p));
  }
});

test('menuPosition: a flip that would go off the OTHER side is clamped back in', () => {
  // Near the right edge in a narrow window: 260 + 200 = 460 > 300, so it flips
  // to 60 — which is fine — but at x: 210 the flip lands at 10 and the margin
  // takes over below 8.
  assert.deepEqual(menuPosition({ x: 260, y: 100 }, SIZE, { w: 300, h: 800 }), { x: 60, y: 100 });
  assert.deepEqual(menuPosition({ x: 205, y: 100 }, SIZE, { w: 300, h: 800 }), { x: 8, y: 100 });
});

test('menuPosition: the flip threshold COUNTS THE MARGIN — the last point that fits inside the inset never flips', () => {
  // There is no sliding band: the moment the menu would cross the 8 px inset
  // it flips, so the clamp never pulls it back over the row the pointer stands
  // on. Pinned from both sides because `>` vs `>=` and a threshold written
  // against the bare `vp.w` are invisible without these points (mutation gate,
  // 2026-09-16; scope review, part A9b).
  //
  // x: vp.w - size.w - MENU_MARGIN = 792 is the last point that fits WHOLE
  // inside the inset — nothing to do, and the clamp does not move it either.
  assert.deepEqual(menuPosition({ x: 792, y: 200 }, SIZE, VP), { x: 792, y: 200 });
  // 793 would cross the inset by one pixel, and THAT flips — leftward from the
  // point, not slid to the edge.
  assert.deepEqual(menuPosition({ x: 793, y: 200 }, SIZE, VP), { x: 593, y: 200 });
  // 800 (an exact fit against the bare glass) is inside the flipping band too:
  // the old overflow-only rule answered 792 and covered the row.
  assert.deepEqual(menuPosition({ x: 800, y: 200 }, SIZE, VP), { x: 600, y: 200 });
  // y: the same three steps downward (vp.h - size.h - MENU_MARGIN = 632).
  assert.deepEqual(menuPosition({ x: 300, y: 632 }, SIZE, VP), { x: 300, y: 632 });
  assert.deepEqual(menuPosition({ x: 300, y: 633 }, SIZE, VP), { x: 300, y: 473 });
  assert.deepEqual(menuPosition({ x: 300, y: 640 }, SIZE, VP), { x: 300, y: 480 });
});

test('menuPosition: a menu bigger than the viewport sits at the margin and NEVER at a negative point', () => {
  const big = { w: 1200, h: 900 };
  for (const at of [
    { x: 0, y: 0 },
    { x: 500, y: 400 },
    { x: 1000, y: 800 },
    { x: -20, y: -20 },
  ]) {
    assert.deepEqual(menuPosition(at, big, VP), { x: MENU_MARGIN, y: MENU_MARGIN }, JSON.stringify(at));
  }
});

test('MENU_MARGIN is the 8 px inset the whole rule is written against', () => {
  assert.equal(MENU_MARGIN, 8);
});

test('menuPosition: no input over a coarse sweep can put the menu at a negative coordinate', () => {
  let checked = 0;
  for (const w of [200, 1200]) {
    for (const h of [160, 900]) {
      for (let x = -100; x <= 1100; x += 100) {
        for (let y = -100; y <= 900; y += 100) {
          const p = menuPosition({ x, y }, { w, h }, VP);
          assert.ok(p.x >= MENU_MARGIN, `x ${p.x} for ${x},${y} ${w}x${h}`);
          assert.ok(p.y >= MENU_MARGIN, `y ${p.y} for ${x},${y} ${w}x${h}`);
          checked += 1;
        }
      }
    }
  }
  assert.equal(checked, 4 * 13 * 11);
});

// ---------------------------------------------------------------------------
// nextItem — roving focus
// ---------------------------------------------------------------------------

test('nextItem: down walks the list and wraps past the last', () => {
  assert.equal(nextItem(4, 0, 1), 1);
  assert.equal(nextItem(4, 2, 1), 3);
  assert.equal(nextItem(4, 3, 1), 0);
});

test('nextItem: up walks back and wraps past the first', () => {
  assert.equal(nextItem(4, 3, -1), 2);
  assert.equal(nextItem(4, 1, -1), 0);
  assert.equal(nextItem(4, 0, -1), 3);
});

test('nextItem: a three-entry menu (a file row) wraps the same way', () => {
  assert.equal(nextItem(3, 2, 1), 0);
  assert.equal(nextItem(3, 0, -1), 2);
});

test('nextItem: a single entry always answers itself, in both directions', () => {
  assert.equal(nextItem(1, 0, 1), 0);
  assert.equal(nextItem(1, 0, -1), 0);
});

test('nextItem: an empty menu answers 0 instead of throwing (no caller can build one)', () => {
  assert.equal(nextItem(0, 0, 1), 0);
  assert.equal(nextItem(0, 3, -1), 0);
});

test('nextItem: a step of 0 stays put, and an out-of-range start still lands in range', () => {
  assert.equal(nextItem(4, 2, 0), 2);
  assert.equal(nextItem(4, -1, 1), 0);
  assert.equal(nextItem(4, 9, 1), 2);
  assert.equal(nextItem(4, -5, -1), 2);
});

test('nextItem: DISABLED entries are not skipped — every index of a real menu is reachable', () => {
  // User decision 3: their one-line explanation is the reason they exist, so
  // the arrows must land on them.
  const items = itemsFor(folder());
  const seen = new Set<number>();
  let i = 0;
  for (let step = 0; step < items.length; step += 1) {
    seen.add(i);
    i = nextItem(items.length, i, 1);
  }
  assert.equal(seen.size, items.length);
  assert.equal(i, 0, 'and one full lap returns to the first entry');
  assert.deepEqual(
    [...seen].sort((a, b) => a - b).filter((n) => items[n]?.enabled === false),
    [1, 2],
  );
});
