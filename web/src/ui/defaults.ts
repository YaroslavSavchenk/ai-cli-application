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
import type { UiLaunchDefaults } from '../../../shared/protocol.ts';
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
