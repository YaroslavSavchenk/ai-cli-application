/**
 * Config model for the app's BEHAVIOUR preferences and the hidden tool cards
 * (Nocturne B6, .claude/plans/nocturne/PLAN-B6.md) — the Preferences page's
 * `Tools` and `Defaults` blocks. Same shape and the same reasons as
 * statusline-model.ts: DOM-free so plain `node:test` imports it, an in-memory
 * store seeded from the boot prefs bag, clamps for a bag that crossed a JSON
 * boundary and that the server never validates, and a patch function the
 * settings panel hands to `api.updatePrefs(patch, DEAD_PREFS_KEYS)`.
 *
 * Who reads what:
 * - `reopenTabs`  — state.ts `loadUi()`, once, at boot (a NEW backend run only).
 * - `confirmEnd`  — every door that ends a session, at click time.
 * - `followOutput` — ui/terminal.ts, on every write.
 * - `hidden`      — ui/launch.ts, on every open of the New session dialog.
 * - `mascot`      — the peek mascot page (web/src/mascot/feed.ts), on every
 *                   poll (Nocturne C1); the settings panel only writes it.
 * Nothing here reaches the server: prefs.json is an opaque bag to it (the one
 * exception is `mascot`, whose shape the server checks on PUT).
 */
import type { UiBehaviour, UiPrefs } from '../../../shared/protocol.ts';

/** Fully-resolved behaviour toggles (every key present). */
export type BehaviourCfg = Required<UiBehaviour>;

const FACTORY: BehaviourCfg = {
  reopenTabs: true,
  confirmEnd: true,
  followOutput: false,
};

const KEYS: (keyof BehaviourCfg)[] = ['reopenTabs', 'confirmEnd', 'followOutput'];

/** The factory set (by value). */
export function behaviourDefaults(): BehaviourCfg {
  return { ...FACTORY };
}

/**
 * Coerce an untrusted bag member into fully-resolved toggles: an absent or
 * non-boolean member takes its factory default.
 */
export function clampBehaviour(raw: unknown): BehaviourCfg {
  const o = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out = { ...FACTORY };
  for (const k of KEYS) if (typeof o[k] === 'boolean') out[k] = o[k];
  return out;
}

let behaviour: BehaviourCfg = { ...FACTORY };

/** Seed from the boot prefs bag (`prefs.behaviour`); tolerant of anything. */
export function initBehaviour(fromPrefs: unknown): void {
  behaviour = clampBehaviour(fromPrefs);
}

/** The current resolved toggles (read fresh by every consumer, never cached). */
export function getBehaviour(): BehaviourCfg {
  return { ...behaviour };
}

/** Replace the in-memory toggles (persistence is the caller's job — the panel). */
export function setBehaviour(next: UiBehaviour): void {
  behaviour = clampBehaviour(next);
}

/** The prefs patch a settings write sends: every member explicit. */
export function behaviourPatch(cfg: BehaviourCfg): UiPrefs {
  return { behaviour: { ...cfg } };
}

// ---------------------------------------------------------------------------
// Hidden tool cards
// ---------------------------------------------------------------------------

/**
 * Coerce `prefs.tools.hidden` into a list of KNOWN card ids: strings only,
 * only ids in `ids`, deduplicated, in `ids` order. At least one card always
 * stays visible: a bag that hides every id has the FIRST id dropped from the
 * list (so a hand-edited file can never leave the dialog with no card).
 */
export function clampHiddenTools(raw: unknown, ids: readonly string[]): string[] {
  const o = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const list = Array.isArray(o.hidden) ? o.hidden : [];
  const wanted = new Set<string>();
  for (const v of list) if (typeof v === 'string') wanted.add(v);
  const out = ids.filter((id) => wanted.has(id));
  if (out.length === ids.length && out.length > 0) out.shift();
  return out;
}

let hiddenTools: string[] = [];
let knownIds: readonly string[] = [];

/**
 * Seed from the boot prefs bag (`prefs.tools`) against the card ids the dialog
 * draws (`TOOL_CARDS.map((c) => c.id)`), passed in so this module stays free
 * of the dialog's imports.
 */
export function initHiddenTools(fromPrefs: unknown, ids: readonly string[]): void {
  knownIds = [...ids];
  hiddenTools = clampHiddenTools(fromPrefs, knownIds);
}

/** The currently hidden card ids (by value). */
export function getHiddenTools(): string[] {
  return [...hiddenTools];
}

/** Replace the in-memory list; clamped against the ids given at init. */
export function setHiddenTools(next: readonly string[]): void {
  hiddenTools = clampHiddenTools({ hidden: [...next] }, knownIds);
}

/** The prefs patch a settings write sends. */
export function toolsPatch(hidden: readonly string[]): UiPrefs {
  return { tools: { hidden: [...hidden] } };
}

// ---------------------------------------------------------------------------
// Peek mascot switch (Nocturne C1, .claude/plans/nocturne/PLAN-C1.md § The toggle)
// ---------------------------------------------------------------------------

/**
 * Is the peek mascot on, per `prefs.mascot`? ABSENT = ON (the part's default),
 * and so is anything that is not `{ enabled: false }` exactly — a mascot the
 * user never switched off must not vanish because a hand-edited file holds a
 * string. Shared by the settings row and the mascot page, so the two can
 * never disagree on what the bag means.
 */
export function clampMascot(raw: unknown): boolean {
  if (raw === null || typeof raw !== 'object') return true;
  return (raw as Record<string, unknown>).enabled !== false;
}

/**
 * Is `raw` exactly the shape the server accepts for `prefs.mascot` on PUT —
 * `{ enabled: boolean }` and nothing else? The server checks this strictly
 * (server/api.ts `validMascotPref`) while it LOADS prefs.json unchecked, and
 * every write re-sends the whole bag (api.ts `updatePrefs`), so a hand-edited
 * `"mascot": "off"` would make every later save of anything fail. The writer
 * drops a value that fails this — absent is on, so nothing is guessed.
 */
export function isMascotShape(raw: unknown): boolean {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const keys = Object.keys(raw);
  return keys.length === 1 && keys[0] === 'enabled' && typeof (raw as { enabled: unknown }).enabled === 'boolean';
}

let mascotOn = true;

/** Seed from the prefs bag (`prefs.mascot`); tolerant of anything. */
export function initMascot(fromPrefs: unknown): void {
  mascotOn = clampMascot(fromPrefs);
}

/** Whether the switch is on right now. */
export function getMascotEnabled(): boolean {
  return mascotOn;
}

/** Replace the in-memory switch (persistence is the caller's job — the panel). */
export function setMascotEnabled(on: boolean): void {
  mascotOn = on;
}

/** The prefs patch a settings write sends. */
export function mascotPatch(on: boolean): UiPrefs {
  return { mascot: { enabled: on } };
}
