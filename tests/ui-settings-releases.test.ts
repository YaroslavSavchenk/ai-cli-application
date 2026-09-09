/**
 * The settings panel's `Check for updates` link (2026-09-08, installer phase C).
 *
 * WHAT IT IS. An INSTALLED app cannot update itself: it is replaced by running
 * a newer Setup, and in-app update *checking* — a localhost tool reaching out
 * to the network on its own — is deliberately out of scope (PROJECT-SCOPE,
 * "Installer and self-contained bundle"). So the panel offers the one thing
 * that is honest: a link to the page where the newer Setup lives, opened in the
 * user's own browser when the user asks for it.
 *
 * WHY IT IS SECURITY-SHAPED. This is THE ONE SANCTIONED WAY OUT of the app
 * window. The WebView2 host locks top-level navigation to the launch origin and
 * drops every popup, with exactly one exception: a user-initiated `window.open`
 * for an exact http/https target, which it hands to the default browser as a
 * separate process (scheme allowlist enforced host-side). That exception is
 * shaped like this call and nothing else — so the three arguments, the literal
 * `window.open`, and the click that triggers it are all load-bearing, not
 * style. A fetch, a redirect, an `<a href>` navigation or a programmatic open
 * would each be dropped or would break the origin lock.
 *
 * WHY A SOURCE SCAN. There is no DOM in this runner, and `ui/settings.ts`
 * transitively imports `ui/terminal.ts` -> `@xterm/xterm`, which cannot even be
 * imported outside a bundler (see `tests/ui-shortcuts-openers.test.ts` for the
 * same constraint and the same answer). So the wiring is checked in the source,
 * every check paired with a non-vacuity assertion, and the ONE thing that can
 * be executed for real — whether the address itself passes the app's own
 * http/https predicate, the same rule the host enforces — is executed against
 * `isOpenableLink` rather than restated.
 *
 * NOT claimed here: that the link is visible, positioned, or sized correctly.
 * That stays manual (`.claude/skills/verify-terminal/SKILL.md`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isOpenableLink } from '../web/src/ui/keys.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p: string[]): string => readFileSync(join(REPO_ROOT, ...p), 'utf8');

const SETTINGS = read('web', 'src', 'ui', 'settings.ts');
const CSS = read('web', 'src', 'styles', 'app.css');

/** The address as the module really declares it — parsed out, never re-typed. */
function releasesUrl(): string {
  const m = /const RELEASES_URL = '([^']+)';/.exec(SETTINGS);
  assert.notEqual(m, null, 'settings.ts must declare the releases address as one constant');
  return m?.[1] as string;
}

// ---------------------------------------------------------------------------

test('the scan actually reads the panel (non-vacuity: the file and its landmarks are found)', () => {
  assert.ok(SETTINGS.length > 1000, `settings.ts looks empty (${SETTINGS.length} chars)`);
  assert.ok(SETTINGS.includes('export function initSettings'), 'settings.ts must still export its init');
  assert.ok(SETTINGS.includes("el('div', 'drawer-label', 'BACKEND')"), 'the BACKEND section must still exist');
  assert.ok(SETTINGS.includes('function renderBackend'), 'the BACKEND readouts must still be rendered here');
});

test('the address is ONE constant in code, and no part of it is UI copy', () => {
  const url = releasesUrl();
  // Copy rule (PROJECT-SCOPE, 2026-07-25): the user reads words, not addresses.
  // The link's label and tooltip must not contain the url or any piece of it.
  const label = /button\('btn-link', '([^']*)', \(\) => \{/.exec(SETTINGS);
  assert.notEqual(label, null, 'the link must be built with the panel’s existing text-button idiom');
  assert.equal(label?.[1], 'Check for updates');
  const tip = /checkBtn\.title = '([^']*)';/.exec(SETTINGS);
  assert.notEqual(tip, null, 'a control that leaves the app window should say so');
  for (const text of [label?.[1] as string, tip?.[1] as string]) {
    assert.equal(text.includes(url), false, `the address must not be UI copy: ${text}`);
    assert.equal(/https?:\/\//.test(text), false, `no address in UI copy: ${text}`);
    assert.equal(text.includes('github.com'), false, `no host name in UI copy: ${text}`);
  }
  // Exactly one occurrence of the literal: a second copy is how two addresses
  // drift apart.
  assert.equal(SETTINGS.split(url).length - 1, 1, 'the address must appear exactly once');
});

test('the address is the project’s releases page, and one the host is allowed to hand over', () => {
  const url = releasesUrl();
  assert.equal(url, 'https://github.com/YaroslavSavchenk/ai-cli-application/releases');
  const parsed = new URL(url);
  assert.equal(parsed.protocol, 'https:');
  assert.equal(parsed.host, 'github.com');
  assert.equal(parsed.pathname, '/YaroslavSavchenk/ai-cli-application/releases');
  assert.equal(parsed.username, '', 'no credentials in the address');
  assert.equal(parsed.search, '', 'no query — nothing about this machine travels with the click');
  assert.equal(parsed.hash, '');
  // The REAL check: the app's own http/https predicate — the rule the WebView2
  // host mirrors — accepts it. Anything it rejects would be dropped silently.
  assert.equal(isOpenableLink(url), true, 'the sanctioned exit only carries http/https');
});

test('the link opens the browser through the sanctioned exit: window.open, exactly three arguments', () => {
  // The host hands an off-origin `window.open` of an exact http/https target to
  // the default browser. `_blank` is what makes it a new window rather than a
  // navigation of this one (which the origin lock would refuse), and
  // `noopener,noreferrer` is what keeps the opened page from reaching back into
  // this window's `opener` — a localhost page holding an auth token.
  assert.ok(
    SETTINGS.includes("window.open(RELEASES_URL, '_blank', 'noopener,noreferrer');"),
    'the call must be exactly window.open(RELEASES_URL, \'_blank\', \'noopener,noreferrer\')',
  );
  // It must be the CONSTANT that is opened, never a string built at the call.
  assert.equal(/window\.open\(\s*'/.test(SETTINGS), false, 'no inline address at the call site');
  // And it must be a user CLICK: the host's exception is user-initiated only.
  assert.match(
    SETTINGS,
    /const checkBtn = button\('btn-link', 'Check for updates', \(\) => \{[\s\S]*?window\.open\(RELEASES_URL, '_blank', 'noopener,noreferrer'\);[\s\S]*?\}\);/,
  );
  // Exactly one exit from this panel.
  assert.equal(SETTINGS.split('window.open(').length - 1, 1, 'the panel opens exactly one window');
  // Nothing here fetches an update itself (out of scope, PROJECT-SCOPE).
  assert.equal(SETTINGS.includes('fetch('), false, 'the panel must not check for updates over the network');
});

test('the link exists ONLY in installed mode — a developer clone is never told to download one', () => {
  // A clone updates with the tools it was cloned with; a releases link there
  // would be an instruction that does not apply. The rule reads the runtime
  // answer, not a build flag, so one page can never be wrong about it.
  assert.ok(SETTINGS.includes('checkBtn.hidden = true;'), 'it must start hidden, before any runtime answer');
  assert.ok(
    SETTINGS.includes('checkBtn.hidden = !st.state.installed;'),
    'visibility must be driven by the backend’s own installed flag',
  );
  // …and that line has to live in the function that runs on open AND on every
  // runtime poll, or the link would be stale for the life of the panel.
  const fn = /function renderBackend\(\): void \{([\s\S]*?)\n  \}/.exec(SETTINGS);
  assert.notEqual(fn, null, 'renderBackend must still exist');
  assert.ok(
    (fn?.[1] as string).includes('checkBtn.hidden = !st.state.installed;'),
    'the visibility rule must be re-applied on every runtime answer',
  );
  assert.match(SETTINGS, /if \(kind === 'conn'\) renderBackend\(\);/);
  // `hidden` removes it from the tab order too — a keyboard user cannot land on
  // a control that does not apply. (The panel has no display:none override for
  // it; app.css hides [hidden] globally.)
  assert.equal(/\.settings-actionrow[^{]*\{[^}]*display:\s*flex/.test(CSS), true);
});

test('the link is the QUIET verb beside Restart backend, on the panel’s control size', () => {
  // Design (frontend-designer pass): facts left, verbs right; a text link must
  // not outweigh the bordered button it sits next to. Both are reused idioms —
  // `btn-link` is the same class the KEYS section’s `all shortcuts` uses.
  assert.match(
    SETTINGS,
    /backRow\.append\(facts, checkBtn, el\('span', 'drawer-gap'\), restartBtn\);/,
    'the link belongs in the facts cluster, with the restart button still anchored right',
  );
  assert.ok(SETTINGS.includes("button('btn', 'Restart backend'"), 'the loud verb must still be a bordered button');
  // One rule, one existing token: the text buttons in these rows drop from the
  // body’s 13px to the control size so the quiet verb reads quieter.
  assert.match(CSS, /\.settings-actionrow \.btn-link \{\n\s*font-size: var\(--fs-ui\);\n\}/);
  // No bespoke colour, radius or shadow was invented for it.
  assert.equal(CSS.includes('.settings-check'), false, 'no one-off class for this link');
});
