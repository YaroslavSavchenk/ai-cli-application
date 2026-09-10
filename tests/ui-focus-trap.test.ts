/**
 * `trapTab` in `web/src/ui/util.ts` — the Tab-wrap focus trap every dialog
 * installs. Until now it was the one exported helper in that module with NO
 * test at all ("touches the DOM in ways this file doesn't attempt",
 * `tests/ui-util.test.ts:9`), and 2026-09-08 gave it a real behavioural rule
 * worth pinning: the `tabIndex >= 0` filter that keeps the UNSELECTED members
 * of a roving-tabindex radiogroup (the launch dialog's card grids — Tool,
 * Permissions and Shell since Nocturne A4; the `Session` / `Shell` segments
 * before that) out of the wrap. They are `<button>` elements, so the trap's
 * `button:not([disabled])` selector matches them regardless of their
 * `tabindex="-1"`; without the filter the first/last stop of the cycle becomes
 * an element the browser's own Tab order skips, and the wrap silently stops
 * working at exactly the two edges the trap exists for.
 *
 * HOW THIS RUNS WITHOUT A DOM. `trapTab` reads only four things: the
 * container's `addEventListener` / `querySelectorAll`, each node's
 * `offsetParent` and `tabIndex`, `document.activeElement`, and the event's
 * `key` / `shiftKey` / `preventDefault`. All four are supplied here as doubles,
 * so the assertions below run the REAL function.
 *
 * What that cannot check, and is therefore NOT claimed: the CSS selector string
 * itself (the doubles hand back a fixed node list rather than matching it) and
 * anything about real layout. Selector and layout stay manual —
 * `.claude/skills/verify-terminal/SKILL.md`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trapTab } from '../web/src/ui/util.ts';

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

interface FakeNode {
  readonly id: string;
  tabIndex: number;
  /** null = not rendered; the trap drops these. */
  offsetParent: unknown;
  focus(): void;
}

/** The focus doubles write here, so a test can say WHICH node got the keyboard. */
let focused: string[] = [];

function node(id: string, tabIndex: number, rendered = true): FakeNode {
  return {
    id,
    tabIndex,
    offsetParent: rendered ? { rendered: true } : null,
    focus() {
      focused.push(id);
    },
  };
}

/** `document.activeElement`, which `trapTab` reads as a global. */
function setActive(n: FakeNode | null): void {
  (globalThis as Record<string, unknown>).document = { activeElement: n };
}

interface Press {
  prevented: boolean;
}

/**
 * Install the real `trapTab` on a container double and hand back a way to
 * press a key at it. The listener the trap registers IS the function under
 * test; nothing here re-implements it.
 */
function trap(nodes: FakeNode[]): (key: string, shiftKey?: boolean) => Press {
  let handler: ((e: KeyboardEvent) => void) | null = null;
  const container = {
    addEventListener(type: string, h: (e: KeyboardEvent) => void): void {
      if (type === 'keydown') handler = h;
    },
    querySelectorAll(): FakeNode[] {
      return nodes;
    },
  };
  trapTab(container as unknown as HTMLElement);
  assert.ok(handler !== null, 'trapTab must register a keydown listener');
  return (key: string, shiftKey = false): Press => {
    const press: Press = { prevented: false };
    const e = {
      key,
      shiftKey,
      preventDefault(): void {
        press.prevented = true;
      },
    };
    (handler as unknown as (ev: unknown) => void)(e);
    return press;
  };
}

function reset(): void {
  focused = [];
}

// ---------------------------------------------------------------------------
// The plain cycle
// ---------------------------------------------------------------------------

test('trapTab: Tab on the last stop wraps to the first, Shift+Tab on the first wraps to the last', () => {
  reset();
  const first = node('first', 0);
  const mid = node('mid', 0);
  const last = node('last', 0);
  const press = trap([first, mid, last]);

  setActive(last);
  assert.equal(press('Tab').prevented, true);
  assert.deepEqual(focused, ['first']);

  reset();
  setActive(first);
  assert.equal(press('Tab', true).prevented, true);
  assert.deepEqual(focused, ['last']);
});

test('trapTab: inside the cycle the browser keeps Tab — no preventDefault, no focus move', () => {
  reset();
  const first = node('first', 0);
  const mid = node('mid', 0);
  const last = node('last', 0);
  const press = trap([first, mid, last]);
  setActive(mid);
  assert.equal(press('Tab').prevented, false);
  assert.equal(press('Tab', true).prevented, false);
  assert.deepEqual(focused, []);
});

test('trapTab: every key that is not Tab is left alone (Esc dismissal is the caller’s job)', () => {
  reset();
  const only = node('only', 0);
  const press = trap([only]);
  setActive(only);
  for (const key of ['Escape', 'Enter', 'v', 'ArrowRight', ' ']) {
    assert.equal(press(key).prevented, false, key);
    assert.equal(press(key, true).prevented, false, key);
  }
  assert.deepEqual(focused, []);
});

test('trapTab: a container with nothing focusable does nothing at all', () => {
  reset();
  const press = trap([]);
  setActive(null);
  assert.equal(press('Tab').prevented, false);
  assert.deepEqual(focused, []);
});

test('trapTab: a single stop wraps to itself in both directions', () => {
  reset();
  const only = node('only', 0);
  const press = trap([only]);
  setActive(only);
  assert.equal(press('Tab').prevented, true);
  assert.equal(press('Tab', true).prevented, true);
  assert.deepEqual(focused, ['only', 'only']);
});

test('trapTab: focus outside the container (activeElement is neither edge) is not hijacked', () => {
  reset();
  const first = node('first', 0);
  const last = node('last', 0);
  const press = trap([first, last]);
  setActive(node('elsewhere', 0));
  assert.equal(press('Tab').prevented, false);
  assert.equal(press('Tab', true).prevented, false);
  assert.deepEqual(focused, []);
});

// ---------------------------------------------------------------------------
// The two filters
// ---------------------------------------------------------------------------

test('trapTab: an unrendered node (offsetParent null) is not a stop, even at an edge', () => {
  reset();
  const hidden = node('hidden', 0, false);
  const first = node('first', 0);
  const last = node('last', 0);
  const trailing = node('trailing', 0, false);
  const press = trap([hidden, first, last, trailing]);

  setActive(first);
  assert.equal(press('Tab', true).prevented, true);
  assert.deepEqual(focused, ['last']);

  reset();
  setActive(last);
  assert.equal(press('Tab').prevented, true);
  assert.deepEqual(focused, ['first']);
});

test("trapTab: a roving radiogroup's unselected segments are not stops — the wrap still hits the real edges (2026-09-08)", () => {
  // Exactly the launch dialog's shape: the `Session` / `Shell` segments are
  // rendered <button>s with tabIndex -1 except the selected one, and they sit
  // at both ends of the query result here so a missing filter is visible.
  reset();
  const unselectedLead = node('kind-claude-unselected', -1);
  const selected = node('kind-selected', 0);
  const nameInput = node('name', 0);
  const launchBtn = node('launch', 0);
  const unselectedTrail = node('shell-powershell-unselected', -1);
  const press = trap([unselectedLead, selected, nameInput, launchBtn, unselectedTrail]);

  // Shift+Tab at the FIRST real stop must wrap to the last real stop.
  setActive(selected);
  assert.equal(press('Tab', true).prevented, true, 'shift+tab at the first real stop must wrap');
  assert.deepEqual(focused, ['launch']);

  // Tab at the LAST real stop must wrap to the first real stop.
  reset();
  setActive(launchBtn);
  assert.equal(press('Tab').prevented, true, 'tab at the last real stop must wrap');
  assert.deepEqual(focused, ['kind-selected']);

  // And the skipped segments are not edges: pressing at one changes nothing.
  reset();
  setActive(unselectedLead);
  assert.equal(press('Tab', true).prevented, false);
  setActive(unselectedTrail);
  assert.equal(press('Tab').prevented, false);
  assert.deepEqual(focused, []);
});

test('trapTab: a container that is ONLY unselected radio segments has no stops', () => {
  reset();
  const a = node('a', -1);
  const b = node('b', -1);
  const press = trap([a, b]);
  setActive(a);
  assert.equal(press('Tab').prevented, false);
  assert.equal(press('Tab', true).prevented, false);
  assert.deepEqual(focused, []);
});

test('trapTab: an INERT card (aria-disabled, rendered, tabIndex -1) is never a stop, even as the last node (Nocturne A4)', () => {
  // The launch dialog's inert cards (Codex, Gemini CLI, Grok; Zsh, Command
  // Prompt) are rendered <button>s WITHOUT the `disabled` attribute — they
  // stay readable as "unavailable" — so the selector matches them. Their
  // permanent tabIndex -1 is what keeps them out of the wrap.
  reset();
  const tool = node('tool-selected', 0);
  const name = node('name', 0);
  const start = node('start-session', 0);
  const inertCmd = node('shell-cmd-inert', -1);
  const press = trap([tool, node('tool-codex-inert', -1), name, start, inertCmd]);

  setActive(start);
  assert.equal(press('Tab').prevented, true, 'tab at the last REAL stop must wrap past the inert card');
  assert.deepEqual(focused, ['tool-selected']);

  reset();
  setActive(tool);
  assert.equal(press('Tab', true).prevented, true);
  assert.deepEqual(focused, ['start-session']);
});
