/**
 * WHERE A NEWER APP COMES FROM, and the ONE way this window is allowed to go
 * there. Two callers, one address, one call: the settings panel's `Check for
 * updates` (2026-09-08) and the update dialog's `Download it yourself` fallback
 * (2026-09-09, phase E) — the second exists precisely for the moment the in-app
 * update could not do it, so it must not be a second, drifting address.
 *
 * The address lives here, in code, and never in UI copy — every caller's label
 * says what it does in words, exactly like every other control in the app
 * (PROJECT-SCOPE copy rule, 2026-07-25).
 *
 * THE CALL ITSELF MOVED (part B3): `ui/open-external.ts` owns the one
 * `window.open` this app makes, because the commit view got a second address
 * to leave for (`Open on GitHub`, user decision D2) and two copies of a
 * security-shaped call is how one of them drifts. That module carries the why.
 */
import { openExternal } from './open-external.ts';

export const RELEASES_URL = 'https://github.com/YaroslavSavchenk/ai-cli-application/releases';

/** Open the releases page in the user's own browser. Call it FROM a click. */
export function openReleasesPage(): void {
  openExternal(RELEASES_URL);
}
