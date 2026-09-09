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
 * WHY THE CALL SHAPE IS LOAD-BEARING. This is THE ONE SANCTIONED WAY OUT of the
 * app window. The WebView2 host locks top-level navigation to the launch origin
 * and drops every popup, with exactly one exception: a user-initiated
 * `window.open` for an exact http/https target, which it hands to the user's
 * default browser as a separate process (scheme allowlist enforced host-side).
 * So: a real click, `window.open`, `_blank` (a new window — navigating this one
 * is what the origin lock refuses), and `noopener,noreferrer` (the opened page
 * must never reach back into a localhost window holding an auth token). A
 * fetch, a redirect, an `<a href>` or a programmatic open would be dropped or
 * would break the lock.
 */
export const RELEASES_URL = 'https://github.com/YaroslavSavchenk/ai-cli-application/releases';

/** Open the releases page in the user's own browser. Call it FROM a click. */
export function openReleasesPage(): void {
  window.open(RELEASES_URL, '_blank', 'noopener,noreferrer');
}
