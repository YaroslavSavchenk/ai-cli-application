/**
 * Shared launch defaults — the settings panel's persisted `UiLaunchDefaults`
 * (default model, default permission mode, auto-run startup command), held in
 * memory so BOTH the settings panel and the launch dialog read from one place.
 *
 * Seeded once at boot from the prefs bag (main.ts), replaced live by the
 * settings panel (which also persists via api.updatePrefs). The launch dialog
 * reads getDefaults() on every open, so a change in the panel pre-selects the
 * NEXT dialog open with no reload. DOM-free by design (no document / xterm),
 * so plain node:test can import it; the precedence/clamp logic it leans on
 * lives in launch-args.ts and is unit-tested there.
 */
import type { UiLaunchDefaults, UiStatusBar } from '../../../shared/protocol.ts';
import { clampLaunchDefaults } from './launch-args.ts';

let current: UiLaunchDefaults = {};

/** Seed from the boot prefs bag (`prefs.defaults`); tolerant of an absent/garbage member. */
export function initDefaults(fromPrefs: unknown): void {
  current = clampLaunchDefaults(fromPrefs);
}

/** The current global launch defaults (read fresh by the launch dialog per open). */
export function getDefaults(): UiLaunchDefaults {
  return { ...current };
}

/** Replace the in-memory defaults (persistence is the caller's job — settings panel). */
export function setDefaults(next: UiLaunchDefaults): void {
  current = clampLaunchDefaults(next);
}

// ---------------------------------------------------------------------------
// Terminal status-bar toggles — the same in-memory-store-seeded-from-prefs
// pattern as the launch defaults above. The settings panel replaces them live
// AND persists via api.updatePrefs({ statusBar }); the pane strips and the
// settings preview read getStatusBar() fresh on every render. usage% is NOT a
// member — there is no honest local source for an account rate-limit percent.
// ---------------------------------------------------------------------------

/** Fully-resolved toggles (every key present) — the render surfaces read these. */
export type StatusBarCfg = Required<UiStatusBar>;

/** Default ON: model, mode, branch, cost, context. Default OFF: time, diff, skill. */
const STATUSBAR_DEFAULT: StatusBarCfg = {
  model: true,
  mode: true,
  branch: true,
  cost: true,
  context: true,
  time: false,
  diff: false,
  skill: false,
};

let currentSB: StatusBarCfg = { ...STATUSBAR_DEFAULT };

/** Coerce an untrusted bag member to the resolved toggles (absent → per-key default). */
function clampStatusBar(raw: unknown): StatusBarCfg {
  const o = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const pick = (k: keyof StatusBarCfg): boolean =>
    typeof o[k] === 'boolean' ? (o[k] as boolean) : STATUSBAR_DEFAULT[k];
  return {
    model: pick('model'),
    mode: pick('mode'),
    branch: pick('branch'),
    cost: pick('cost'),
    context: pick('context'),
    time: pick('time'),
    diff: pick('diff'),
    skill: pick('skill'),
  };
}

/** Seed from the boot prefs bag (`prefs.statusBar`); tolerant of an absent/garbage member. */
export function initStatusBar(fromPrefs: unknown): void {
  currentSB = clampStatusBar(fromPrefs);
}

/** The current resolved status-bar toggles (read fresh by strips + settings preview). */
export function getStatusBar(): StatusBarCfg {
  return { ...currentSB };
}

/** Replace the in-memory toggles (persistence is the caller's job — settings panel). */
export function setStatusBar(next: UiStatusBar): void {
  currentSB = clampStatusBar(next);
}

/** The factory ON/OFF defaults (settings panel "Reset to defaults"). */
export function statusBarDefaults(): StatusBarCfg {
  return { ...STATUSBAR_DEFAULT };
}
