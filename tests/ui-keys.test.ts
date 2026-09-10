/**
 * `web/src/ui/keys.ts` — the three pure decisions the app makes about raw
 * browser input. All DOM-free by construction (a real `HTMLElement` /
 * `KeyboardEvent` merely satisfies the structural types), so plain
 * `node --test` covers exactly the logic the browser runs; this file is also
 * the guard that keeps that module importable without a document.
 *
 * The bug behind all three (user report, 2026-09-08): inside a Claude Code
 * pane, `/login` prints an OAuth link and a "paste the code here" field. The
 * link opened the Windows browser, and on returning to the app window the
 * field took NO input — not typed, not pasted. The PTY side was proven fine.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FOCUS_OWNER_SELECTOR,
  OPEN_FOCUS_OWNER_SELECTOR,
  TERMINAL_SELECTOR,
  focusOwnerOpen,
  isCopyChord,
  isEditableTarget,
  isLinkActivation,
  isOpenableLink,
  isPasteChord,
  shouldRefocusTerminal,
} from '../web/src/ui/keys.ts';
import type { DocumentLike, FocusTarget, KeyChord, MouseChord } from '../web/src/ui/keys.ts';

// ---------------------------------------------------------------------------
// Element doubles — a `closest` that answers for a listed set of selectors,
// exactly like the real one does for an element sitting inside those ancestors.
// ---------------------------------------------------------------------------

function elem(opts: {
  tag?: string;
  editable?: boolean;
  /** Selectors whose ancestor this element is inside of. */
  inside?: string[];
}): FocusTarget {
  const inside = opts.inside ?? [];
  return {
    tagName: opts.tag ?? 'DIV',
    isContentEditable: opts.editable ?? false,
    closest(selectors: string): unknown {
      // The real closest() takes a selector LIST; a match on any part counts.
      const parts = selectors.split(',').map((p) => p.trim());
      return inside.some((i) => parts.includes(i)) ? { matched: true } : null;
    },
  };
}

const inTerminal = (tag = 'TEXTAREA'): FocusTarget =>
  elem({ tag, inside: [TERMINAL_SELECTOR] });

// ---------------------------------------------------------------------------
// shouldRefocusTerminal
// ---------------------------------------------------------------------------

test('shouldRefocusTerminal: nothing focused -> yes (the terminal is where the keyboard belongs)', () => {
  assert.equal(shouldRefocusTerminal(null), true);
});

test('shouldRefocusTerminal: the body (focus fell on the floor after a window switch) -> yes', () => {
  assert.equal(shouldRefocusTerminal(elem({ tag: 'BODY' })), true);
});

test('shouldRefocusTerminal: a plain button in the chrome -> yes', () => {
  assert.equal(shouldRefocusTerminal(elem({ tag: 'BUTTON' })), true);
});

test("shouldRefocusTerminal: focus already inside a terminal -> yes (xterm's own textarea is an INPUT-like element, and re-focusing it is what a blurred pane needs)", () => {
  assert.equal(shouldRefocusTerminal(inTerminal()), true);
  assert.equal(shouldRefocusTerminal(inTerminal('DIV')), true);
});

test('shouldRefocusTerminal: a field being typed in keeps the keyboard', () => {
  for (const tag of ['INPUT', 'TEXTAREA', 'SELECT']) {
    assert.equal(shouldRefocusTerminal(elem({ tag })), false, tag);
  }
  assert.equal(shouldRefocusTerminal(elem({ tag: 'DIV', editable: true })), false);
});

test('shouldRefocusTerminal: a surface that OWNS the keyboard keeps it — dialog, drawer, scrim, boot overlay', () => {
  for (const sel of ['[role="dialog"]', '.drawer', '.modal-scrim', '.boot-overlay']) {
    assert.equal(shouldRefocusTerminal(elem({ tag: 'BUTTON', inside: [sel] })), false, sel);
  }
});

test('shouldRefocusTerminal: every selector named in FOCUS_OWNER_SELECTOR really blocks (guards the constant against drift)', () => {
  const parts = FOCUS_OWNER_SELECTOR.split(',').map((p) => p.trim());
  assert.ok(parts.length >= 4, FOCUS_OWNER_SELECTOR);
  for (const sel of parts) {
    assert.equal(shouldRefocusTerminal(elem({ tag: 'BUTTON', inside: [sel] })), false, sel);
  }
});

test('shouldRefocusTerminal: a terminal INSIDE a drawer-shaped ancestor still wins — the terminal check runs first', () => {
  const t = elem({ tag: 'TEXTAREA', inside: [TERMINAL_SELECTOR, '.drawer'] });
  assert.equal(shouldRefocusTerminal(t), true);
});

test('isEditableTarget: fields and contenteditable only', () => {
  assert.equal(isEditableTarget(null), false);
  assert.equal(isEditableTarget(elem({ tag: 'BUTTON' })), false);
  assert.equal(isEditableTarget(elem({ tag: 'INPUT' })), true);
  assert.equal(isEditableTarget(elem({ tag: 'DIV', editable: true })), true);
});

// ---------------------------------------------------------------------------
// focusOwnerOpen — the SCREEN half of the refocus rule
// ---------------------------------------------------------------------------
//
// Document double: a `querySelector` that answers for a set of selectors the
// page is claimed to contain, matching a selector LIST the way the real one
// does (any comma-separated part hitting is a hit). The strings it is seeded
// with are the exact ones the constant spells, so a drifted `:not([hidden])`
// shows up as a miss here.

function docWith(present: string[]): DocumentLike {
  return {
    querySelector(selectors: string): unknown {
      const parts = selectors.split(',').map((p) => p.trim());
      return present.some((p) => parts.includes(p)) ? { matched: true } : null;
    },
  };
}

test('focusOwnerOpen: an empty page owns nothing', () => {
  assert.equal(focusOwnerOpen(docWith([])), false);
});

test('focusOwnerOpen: null (no document at all) is not an owner', () => {
  assert.equal(focusOwnerOpen(null), false);
});

test('focusOwnerOpen: an OPEN drawer counts — the bug this helper exists for', () => {
  // The regression: refocus pre-checked scrims and the boot overlay only, and
  // the sessions drawer's own topbar toggle (which is inside NO drawer) held
  // the focus, so `shouldRefocusTerminal` said yes and the terminal stole the
  // keyboard out from under an open drawer.
  assert.equal(focusOwnerOpen(docWith(['.drawer:not([hidden])'])), true);
});

test('focusOwnerOpen: every selector the constant names really triggers it (guards the constant against drift)', () => {
  const parts = OPEN_FOCUS_OWNER_SELECTOR.split(',').map((p) => p.trim());
  assert.ok(parts.length >= 3, `expected the whole list, got ${JSON.stringify(parts)}`);
  for (const part of parts) {
    assert.equal(focusOwnerOpen(docWith([part])), true, part);
  }
});

test('focusOwnerOpen: the three surfaces are exactly scrim, drawer and boot overlay — and the first two only while OPEN', () => {
  assert.deepEqual(OPEN_FOCUS_OWNER_SELECTOR.split(',').map((p) => p.trim()), [
    '.modal-scrim:not([hidden])',
    '.drawer:not([hidden])',
    '.boot-overlay',
  ]);
  // A CLOSED drawer/scrim is `hidden`, so the bare selector must NOT be what
  // the constant asks for — otherwise the app would never refocus at all.
  assert.equal(focusOwnerOpen(docWith(['.drawer'])), false);
  assert.equal(focusOwnerOpen(docWith(['.modal-scrim'])), false);
});

test('focusOwnerOpen and shouldRefocusTerminal are BOTH required: the drawer case needs the screen half', () => {
  // The topbar toggle: a plain button, inside no drawer -> the element half
  // says "yes, refocus". Only the screen half stops it.
  const toggle = elem({ tag: 'BUTTON' });
  assert.equal(shouldRefocusTerminal(toggle), true);
  assert.equal(focusOwnerOpen(docWith(['.drawer:not([hidden])'])), true);
});

// ---------------------------------------------------------------------------
// isOpenableLink (the OSC 8 activation filter)
// ---------------------------------------------------------------------------

test('isOpenableLink: http and https pass — that is what a login link is', () => {
  assert.equal(isOpenableLink('https://claude.ai/oauth/authorize?code=1'), true);
  assert.equal(isOpenableLink('http://127.0.0.1:8080/x'), true);
  assert.equal(isOpenableLink('HTTPS://EXAMPLE.COM'), true); // scheme is case-insensitive
});

test('isOpenableLink: every other scheme is ignored, never guessed at', () => {
  for (const uri of [
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
    'vbscript:msgbox(1)',
    'mailto:someone@example.com',
    'ftp://example.com/x',
    'ws://127.0.0.1/ws',
  ]) {
    assert.equal(isOpenableLink(uri), false, uri);
  }
});

test('isOpenableLink: things that are not URLs at all are ignored (no base-URL resolution)', () => {
  for (const uri of ['', '   ', 'example.com', '/just/a/path', 'not a url', '://x']) {
    assert.equal(isOpenableLink(uri), false, JSON.stringify(uri));
  }
});

test('isOpenableLink: a scheme that merely STARTS with http is not http', () => {
  assert.equal(isOpenableLink('httpx://example.com'), false);
  assert.equal(isOpenableLink('httpsx://example.com'), false);
});

// ---------------------------------------------------------------------------
// isLinkActivation — the SECOND GESTURE a terminal link needs
// ---------------------------------------------------------------------------
//
// A terminal's plain click is a selection gesture, and the text under it was
// printed by a program, so a plain click must open nothing at all. Ctrl (or
// Cmd) is the confirmation — the Windows Terminal / VS Code convention, and the
// decision that replaced xterm's confirm() dialog (2026-09-08).

const click = (o: Partial<MouseChord> = {}): MouseChord => ({
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  ...o,
});

test('isLinkActivation: a PLAIN click opens nothing — the whole point of the second gesture', () => {
  assert.equal(isLinkActivation(click()), false);
});

test('isLinkActivation: ctrl+click opens (Windows Terminal / VS Code convention)', () => {
  assert.equal(isLinkActivation(click({ ctrlKey: true })), true);
});

test('isLinkActivation: cmd+click opens too (a Mac keyboard reports meta)', () => {
  assert.equal(isLinkActivation(click({ metaKey: true })), true);
});

test('isLinkActivation: alt disqualifies — alt+click is a window-manager gesture, and AltGr reports ctrl+alt', () => {
  assert.equal(isLinkActivation(click({ altKey: true })), false);
  assert.equal(isLinkActivation(click({ ctrlKey: true, altKey: true })), false);
  assert.equal(isLinkActivation(click({ metaKey: true, altKey: true })), false);
});

test('isLinkActivation: the accepted set over the whole modifier space is exactly "ctrl or meta, no alt"', () => {
  for (let bits = 0; bits < 8; bits += 1) {
    const e = click({
      ctrlKey: (bits & 1) !== 0,
      altKey: (bits & 2) !== 0,
      metaKey: (bits & 4) !== 0,
    });
    const expected = !e.altKey && (e.ctrlKey || e.metaKey);
    assert.equal(isLinkActivation(e), expected, JSON.stringify(e));
  }
});

test('isLinkActivation is a SEPARATE gate from isOpenableLink — both must pass', () => {
  // terminal.ts asks isLinkActivation first, then openTerminalLink() asks
  // isOpenableLink. Neither one alone may open a javascript: URL on a click.
  assert.equal(isLinkActivation(click({ ctrlKey: true })), true);
  assert.equal(isOpenableLink('javascript:alert(1)'), false);
  assert.equal(isLinkActivation(click()), false);
  assert.equal(isOpenableLink('https://claude.ai/'), true);
});

// ---------------------------------------------------------------------------
// isPasteChord
// ---------------------------------------------------------------------------

function chord(over: Partial<KeyChord> & { key: string }): KeyChord {
  return {
    type: 'keydown',
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ...over,
  };
}

test('isPasteChord: ctrl+shift+v, in both key cases', () => {
  assert.equal(isPasteChord(chord({ key: 'v', ctrlKey: true, shiftKey: true })), true);
  assert.equal(isPasteChord(chord({ key: 'V', ctrlKey: true, shiftKey: true })), true);
});

test('isPasteChord: shift+insert', () => {
  assert.equal(isPasteChord(chord({ key: 'Insert', shiftKey: true })), true);
});

test('isPasteChord: plain ctrl+v is NOT ours — it must keep reaching the PTY (PROJECT-SCOPE keyboard rule)', () => {
  assert.equal(isPasteChord(chord({ key: 'v', ctrlKey: true })), false);
  assert.equal(isPasteChord(chord({ key: 'c', ctrlKey: true })), false);
  assert.equal(isPasteChord(chord({ key: 'V' })), false);
  assert.equal(isPasteChord(chord({ key: 'Insert' })), false);
  assert.equal(isPasteChord(chord({ key: 'Insert', ctrlKey: true, shiftKey: true })), false);
});

test('isPasteChord: alt or meta disqualifies (app chords live on ctrl+alt; the OS owns meta)', () => {
  assert.equal(isPasteChord(chord({ key: 'v', ctrlKey: true, shiftKey: true, altKey: true })), false);
  assert.equal(isPasteChord(chord({ key: 'v', ctrlKey: true, shiftKey: true, metaKey: true })), false);
  assert.equal(isPasteChord(chord({ key: 'Insert', shiftKey: true, altKey: true })), false);
});

test('isPasteChord: AltGr (ctrl+alt on European layouts) never counts', () => {
  const e = chord({ key: 'v', ctrlKey: true, shiftKey: true });
  assert.equal(isPasteChord({ ...e, getModifierState: () => true }), false);
  assert.equal(isPasteChord({ ...e, getModifierState: () => false }), true);
});

test('isPasteChord: only keydown — keyup/keypress must not fire a second read', () => {
  for (const type of ['keyup', 'keypress']) {
    assert.equal(isPasteChord(chord({ key: 'v', ctrlKey: true, shiftKey: true, type })), false, type);
    assert.equal(isPasteChord(chord({ key: 'Insert', shiftKey: true, type })), false, type);
  }
  // An event object without a type (a hand-built chord) is still judged on its keys.
  assert.equal(
    isPasteChord({ key: 'v', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false }),
    true,
  );
});

// ---------------------------------------------------------------------------
// isCopyChord (2026-09-10) — xterm draws on a canvas, so the browser's own copy
// takes nothing. Ctrl+Shift+C and Ctrl+Insert mirror the paste pair; plain
// Ctrl+C is ^C and is never one of them. (Whether the keystroke is SWALLOWED —
// only with a selection — is terminal.ts's decision, pinned in
// tests/ui-terminal-copy.test.ts.)
// ---------------------------------------------------------------------------

test('isCopyChord: ctrl+shift+c, in both key cases', () => {
  assert.equal(isCopyChord(chord({ key: 'c', ctrlKey: true, shiftKey: true })), true);
  assert.equal(isCopyChord(chord({ key: 'C', ctrlKey: true, shiftKey: true })), true);
});

test('isCopyChord: ctrl+insert', () => {
  assert.equal(isCopyChord(chord({ key: 'Insert', ctrlKey: true })), true);
});

test('isCopyChord: plain ctrl+c is NOT ours — it is the interrupt and must keep reaching the PTY', () => {
  assert.equal(isCopyChord(chord({ key: 'c', ctrlKey: true })), false);
  assert.equal(isCopyChord(chord({ key: 'C', ctrlKey: true })), false);
  assert.equal(isCopyChord(chord({ key: 'c' })), false);
  assert.equal(isCopyChord(chord({ key: 'C', shiftKey: true })), false);
  assert.equal(isCopyChord(chord({ key: 'Insert' })), false);
});

test('isCopyChord: alt, meta or AltGr disqualifies ctrl+shift+c (and ctrl+insert)', () => {
  assert.equal(isCopyChord(chord({ key: 'c', ctrlKey: true, shiftKey: true, altKey: true })), false);
  assert.equal(isCopyChord(chord({ key: 'c', ctrlKey: true, shiftKey: true, metaKey: true })), false);
  assert.equal(isCopyChord(chord({ key: 'Insert', ctrlKey: true, altKey: true })), false);
  assert.equal(isCopyChord(chord({ key: 'Insert', ctrlKey: true, metaKey: true })), false);
  const e = chord({ key: 'c', ctrlKey: true, shiftKey: true });
  assert.equal(isCopyChord({ ...e, getModifierState: (k: string) => k === 'AltGraph' }), false);
  assert.equal(isCopyChord({ ...e, getModifierState: () => false }), true);
  const ins = chord({ key: 'Insert', ctrlKey: true });
  assert.equal(isCopyChord({ ...ins, getModifierState: (k: string) => k === 'AltGraph' }), false);
});

test('isCopyChord: only keydown — keyup/keypress must not copy a second time', () => {
  for (const type of ['keyup', 'keypress']) {
    assert.equal(isCopyChord(chord({ key: 'c', ctrlKey: true, shiftKey: true, type })), false, type);
    assert.equal(isCopyChord(chord({ key: 'Insert', ctrlKey: true, type })), false, type);
  }
  // An event object without a type (a hand-built chord) is still judged on its keys.
  assert.equal(
    isCopyChord({ key: 'c', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false }),
    true,
  );
});

test('ctrl+shift+insert is NEITHER copy nor paste — the Insert pair is told apart by exactly one modifier', () => {
  const both = chord({ key: 'Insert', ctrlKey: true, shiftKey: true });
  assert.equal(isCopyChord(both), false);
  assert.equal(isPasteChord(both), false);
});

test('shift+insert is paste, not copy; ctrl+insert is copy, not paste', () => {
  const shiftIns = chord({ key: 'Insert', shiftKey: true });
  assert.equal(isPasteChord(shiftIns), true);
  assert.equal(isCopyChord(shiftIns), false);
  const ctrlIns = chord({ key: 'Insert', ctrlKey: true });
  assert.equal(isCopyChord(ctrlIns), true);
  assert.equal(isPasteChord(ctrlIns), false);
  // And the letter pair: ctrl+shift+c never pastes, ctrl+shift+v never copies.
  assert.equal(isPasteChord(chord({ key: 'c', ctrlKey: true, shiftKey: true })), false);
  assert.equal(isCopyChord(chord({ key: 'v', ctrlKey: true, shiftKey: true })), false);
});

// ---------------------------------------------------------------------------
// The selector constants are only as good as the markup they name
// ---------------------------------------------------------------------------
//
// Everything above runs against element DOUBLES, so a renamed class would keep
// every assertion green while `shouldRefocusTerminal` silently stopped matching
// anything real — the exact failure the 2026-09-08 report was about, restored.
// This scan is the cheap half of that guard: each selector the constants name
// must still be produced somewhere in the frontend. What it CANNOT check is a
// new keyboard-owning surface added without any of these hooks; that stays
// manual (`.claude/skills/verify-terminal/SKILL.md`).

test('the selector constants still name markup the frontend actually produces', async () => {
  const { readdirSync, readFileSync, statSync } = await import('node:fs');
  const { dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const WEB_SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'src');

  const sources: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if ((p.endsWith('.ts') || p.endsWith('.css')) && !p.endsWith('keys.ts')) {
        sources.push(readFileSync(p, 'utf8'));
      }
    }
  };
  walk(WEB_SRC);
  assert.ok(sources.length >= 20, `expected the whole frontend, read ${sources.length} files`);

  // `.foo` in a selector is written as the bare class name in `el(tag, 'foo')`
  // and as `.foo` in CSS; `[role="dialog"]` as a setAttribute pair.
  const needles: [string, string[]][] = [
    [TERMINAL_SELECTOR, ['term-host']],
    ['[role="dialog"]', ["setAttribute('role', 'dialog')"]],
    ['.drawer', ["el('aside', 'drawer"]],
    ['.modal-scrim', ['modal-scrim']],
    ['.boot-overlay', ['boot-overlay']],
    // The OPEN markers: `hidden` is how the chrome closes a drawer and a
    // modal scrim, so `:not([hidden])` is only true while one is really up.
    // If either stopped being toggled that way, `focusOwnerOpen` would answer
    // false forever and the drawer bug would come straight back.
    ['.drawer:not([hidden])', ['projAside.hidden =', 'sessAside.hidden =']],
    ['.modal-scrim:not([hidden])', ['scrim.hidden =']],
  ];
  for (const [selector, marks] of needles) {
    assert.ok(
      FOCUS_OWNER_SELECTOR.includes(selector) ||
        OPEN_FOCUS_OWNER_SELECTOR.includes(selector) ||
        selector === TERMINAL_SELECTOR,
      `${selector} must still be one of the constants`,
    );
    for (const mark of marks) {
      assert.ok(
        sources.some((s) => s.includes(mark)),
        `${selector}: nothing in web/src produces ${JSON.stringify(mark)} anymore`,
      );
    }
  }
});
