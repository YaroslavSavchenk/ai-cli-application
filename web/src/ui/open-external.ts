/**
 * THE ONE SANCTIONED WAY OUT of the app window, for an address the APP knows.
 *
 * WHY THE CALL SHAPE IS LOAD-BEARING. The WebView2 host locks top-level
 * navigation to the launch origin and drops every popup, with exactly one
 * exception: a user-initiated `window.open` for an exact http/https target,
 * which it hands to the user's default browser as a separate process (scheme
 * allowlist enforced host-side). So: a real click, `window.open`, `_blank` (a
 * new window — navigating this one is what the origin lock refuses), and
 * `noopener,noreferrer` (the opened page must never reach back into a
 * localhost window holding an auth token). A fetch, a redirect, an `<a href>`
 * or a programmatic open would be dropped or would break the lock.
 *
 * TWO CALLERS, ONE CALL (part B3). `ui/releases.ts` sends the user to the
 * releases page; the commit view sends them to a commit on github.com (user
 * decision D2, 2026-09-21), and that second address is BUILT from parts that
 * came out of the user's own `remote.origin.url`. One door, checked once, is
 * what keeps that from becoming two doors with one check between them.
 *
 * (`ui/terminal.ts` opens an OSC 8 hyperlink a PROGRAM printed, which is a
 * different rule — `http` as well as `https`, and the address is never logged
 * because it is PTY output. It keeps its own call and its own predicate.)
 */

/**
 * Open `url` in the user's own browser, from a real click. It is opened only
 * if it is EXACTLY an `https:` address the app built itself: no other scheme,
 * no credentials in it, and nothing the URL parser had to repair (a href that
 * differs from the string handed in is a string nobody checked). Anything else
 * opens nothing at all and says so to the caller — silence on screen is the
 * point: there is no honest sentence to show for an address the user never
 * saw and never typed.
 */
export function openExternal(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  if (parsed.username !== '' || parsed.password !== '') return false;
  if (parsed.href !== url) return false;
  window.open(url, '_blank', 'noopener,noreferrer');
  return true;
}
