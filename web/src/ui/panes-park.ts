/**
 * The PARKED tabs of the pane grid (Quality part P5, `.claude/plans/PLAN-QUALITY.md`),
 * split from `panes.ts`: a tab the user leaves keeps its session cards — their
 * terminals, sockets, WebGL contexts and buffers — in a hidden holder, so
 * coming back replays nothing (after P1–P4 a switch to a 4-pane tab still cost
 * ~220 ms of xterm parsing 4 × 5 000 lines). Output keeps streaming into a
 * parked terminal; it sends no resize (`TerminalView.hide`), takes no keyboard
 * and acks no attention (`panes.ts` `isDrawn`).
 *
 * At most `MAX_LIVE_TERMINALS` terminals live at once (rule and why:
 * `ui/pane-reuse-model.ts`); over that the least recently seen parked tab is
 * disposed and attaches and replays on return, as every tab did before P5.
 *
 * `panes.ts` owns the grid and the slots and decides WHEN a tab is parked or
 * taken back; this module holds what is parked. The one function it needs
 * from `panes.ts`, `teardown`, is handed in by `initParking` — so the cycle is
 * type-only. Sibling: `panes.ts`, `panes-status.ts`.
 */
import * as st from '../state.ts';
import { log } from '../log.ts';
import { el } from './util.ts';
import { MAX_LIVE_TERMINALS, tabsToEvict } from './pane-reuse-model.ts';
import type { Slot } from './panes.ts';

/**
 * The tabs the user left, by view id, with their cards. `seen` is `seenTick`
 * at the moment the tab was left — the last time it was on screen — and
 * orders the eviction.
 */
const parked = new Map<string, { slots: Slot[]; seen: number }>();
let seenTick = 0;
/**
 * Where parked cards wait: a `hidden` node OUTSIDE the grid, so no grid
 * selector, drop target or auto-placement ever sees them. `display: none`
 * keeps the nodes in the document — xterm's buffer, its WebGL context and its
 * glyph atlas survive, and its renderer simply pauses until the card is back.
 */
let holder: HTMLElement;
/** `panes.ts`'s own teardown: dispose a card's payload exactly as a closed pane. */
let teardown: (s: Slot) => void = () => {};

export function initParking(teardownSlot: (s: Slot) => void): void {
  teardown = teardownSlot;
  holder = el('div', 'pane-parking');
  holder.hidden = true;
  document.body.append(holder);
}

/**
 * Park tab `id`'s cards: each session card keeps its terminal (hidden, no
 * fitting), an editor pane is torn down as before a switch always did (its
 * state lives in state.ts), and every card moves into the holder — a card
 * holding the keyboard loses it with the move.
 */
export function parkTab(id: string, cards: Slot[]): void {
  for (const s of cards) {
    if (s.pay?.kind === 'session') s.pay.view?.hide();
    else teardown(s);
    holder.insertBefore(s.root, null);
  }
  if (cards.length > 0) parked.set(id, { slots: cards, seen: ++seenTick });
}

/** The cards tab `id` was parked with, taken out of the parking; undefined if none. */
export function takeBack(id: string): Slot[] | undefined {
  const tab = parked.get(id);
  parked.delete(id);
  return tab?.slots;
}

/** A card with a live terminal — what the cap counts. */
function hasTerminal(s: Slot): boolean {
  return s.pay?.kind === 'session' && s.pay.view !== null;
}

/**
 * Dispose the least recently seen parked tabs until `v`'s terminals plus the
 * parked ones fit in `MAX_LIVE_TERMINALS` (rule: `tabsToEvict`). `v` is the
 * tab on screen, or about to be — never a candidate. Called BEFORE anything
 * is built, so a new terminal never takes a WebGL context the browser would
 * have to steal from another.
 */
export function enforceCap(v: st.ViewState): void {
  const need = v.slots.filter((x) => x.kind === 'session').length;
  const tabs = [...parked]
    .filter(([id]) => id !== v.id)
    .map(([id, t]) => ({ id, live: t.slots.filter(hasTerminal).length, seen: t.seen }));
  for (const id of tabsToEvict(tabs, need, MAX_LIVE_TERMINALS)) {
    log.debug(`panes: tab ${id} evicted — over ${MAX_LIVE_TERMINALS} live terminals, it replays on return`);
    dropParked(id);
  }
}

/** Dispose a parked tab's cards exactly as a closed pane is (socket, WebGL). */
function dropParked(id: string): void {
  const tab = parked.get(id);
  if (tab === undefined) return;
  parked.delete(id);
  for (const s of tab.slots) {
    teardown(s);
    s.root.remove();
  }
}

/**
 * A parked tab the model closed goes whole; a parked card whose session left
 * its tab (ended, moved into another tab) is disposed — before a relayout
 * could attach that session a second time elsewhere.
 */
export function pruneParked(): void {
  for (const [id, tab] of [...parked]) {
    const v = st.state.views.find((x) => x.id === id);
    if (v === undefined) {
      dropParked(id);
      continue;
    }
    const keys = new Set(v.slots.map((slot) => st.slotKey(slot)));
    for (const s of tab.slots) if (s.key !== '' && !keys.has(s.key)) teardown(s);
  }
}
