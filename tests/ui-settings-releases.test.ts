/**
 * The releases-page opener: the settings panel's `Check for updates`
 * (2026-09-08, installer phase C) and, since phase E (2026-09-09), the update
 * dialog's `Download it yourself` fallback — ONE address and ONE call, in
 * `web/src/ui/releases.ts`, with both surfaces as callers.
 *
 * WHAT IT IS. The link to the page where the newer Setup lives, opened in the
 * user's own browser when the user asks for it. It was the whole story until
 * phase E (2026-09-09) gave the app an Update button of its own; it stays as
 * the MANUAL fallback — the settings panel's quiet verb, and the one thing left
 * to offer when the in-app update refused.
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
import { UPDATE_OWNER, UPDATE_REPO } from '../server/update-release.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p: string[]): string => readFileSync(join(REPO_ROOT, ...p), 'utf8');

const SETTINGS = read('web', 'src', 'ui', 'settings.ts');
const RELEASES = read('web', 'src', 'ui', 'releases.ts');
const UPDATE = read('web', 'src', 'ui', 'update.ts');
const CSS = read('web', 'src', 'styles', 'app.css');

/** The address as the module really declares it — parsed out, never re-typed. */
function releasesUrl(): string {
  const m = /export const RELEASES_URL = '([^']+)';/.exec(RELEASES);
  assert.notEqual(m, null, 'releases.ts must declare the releases address as one constant');
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
  // It lives in the shared opener and NOWHERE else: two copies is how two
  // addresses drift apart, and this one is the app's only way out of its window.
  for (const [name, src] of [
    ['settings.ts', SETTINGS],
    ['update.ts', UPDATE],
  ] as const) {
    assert.equal(src.includes(url), false, `${name} must not carry the address itself`);
    assert.equal(src.includes('github.com'), false, `${name} must not name the host`);
  }
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
  // Exactly one occurrence of the literal, in the module that owns it.
  assert.equal(RELEASES.split(url).length - 1, 1, 'the address must appear exactly once');
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

test('phase E: the manual page and the in-app check are the SAME repository', () => {
  // The backend asks api.github.com about <owner>/<repo> and constructs every
  // asset URL from those two constants; this link is where the user is sent
  // when that fails. If they ever drift apart, the fallback points at a repo
  // that has nothing to do with the update the app just offered.
  assert.equal(releasesUrl(), `https://github.com/${UPDATE_OWNER}/${UPDATE_REPO}/releases`);
  assert.equal(UPDATE_OWNER, 'YaroslavSavchenk', 'non-vacuity: the constants really carry values');
  assert.equal(UPDATE_REPO, 'ai-cli-application');
});

test('the link opens the browser through the sanctioned exit: window.open, exactly three arguments', () => {
  // The host hands an off-origin `window.open` of an exact http/https target to
  // the default browser. `_blank` is what makes it a new window rather than a
  // navigation of this one (which the origin lock would refuse), and
  // `noopener,noreferrer` is what keeps the opened page from reaching back into
  // this window's `opener` — a localhost page holding an auth token.
  assert.ok(
    RELEASES.includes("window.open(RELEASES_URL, '_blank', 'noopener,noreferrer');"),
    'the call must be exactly window.open(RELEASES_URL, \'_blank\', \'noopener,noreferrer\')',
  );
  // It must be the CONSTANT that is opened, never a string built at the call.
  assert.equal(/window\.open\(\s*'/.test(RELEASES), false, 'no inline address at the call site');
  // Exactly one exit from the whole frontend.
  assert.equal(RELEASES.split('window.open(').length - 1, 1, 'exactly one window is ever opened');
  for (const [name, src] of [
    ['settings.ts', SETTINGS],
    ['update.ts', UPDATE],
  ] as const) {
    assert.equal(src.includes('window.open('), false, `${name} must go through the shared opener`);
  }
  // And it must be a user CLICK: the host's exception is user-initiated only.
  assert.match(
    SETTINGS,
    /const checkBtn = button\('btn-link', 'Check for updates', \(\) => \{[\s\S]*?openReleasesPage\(\);[\s\S]*?\}\);/,
  );
  assert.match(SETTINGS, /import \{ openReleasesPage \} from '\.\/releases\.ts';/);
  // The panel itself still fetches nothing: checking is the backend's job now
  // (phase E) and asking the page to do it would be a second, unaudited path.
  assert.equal(SETTINGS.includes('fetch('), false, 'the panel must not check for updates over the network');
});

test('phase E: the update dialog’s manual fallback is the SAME opener, on a real click', () => {
  // It exists for exactly one moment: the app tried to fetch the new version
  // and could not. Sending the user somewhere else would be a second address to
  // keep right; this is the first one, called the same way.
  assert.match(UPDATE, /import \{ openReleasesPage \} from '\.\/releases\.ts';/);
  assert.match(
    UPDATE,
    /const dlBtn = button\('btn-link', COPY\.downloadSelf, \(\) => \{[\s\S]*?openReleasesPage\(\);[\s\S]*?\}\);/,
    'the fallback is a text button whose click calls the shared opener',
  );
  // Same quiet-verb idiom as the settings panel, and only on a refused UPDATE:
  // after a refused RESTART the newer version is already on this machine.
  assert.match(UPDATE, /dlBtn\.hidden = true;/);
  assert.match(UPDATE, /dlBtn\.hidden = next !== 'refused' \|\| half !== 'update';/);
  // The words: what it does, no address, no host, no file name.
  const label = /downloadSelf: '([^']*)'/.exec(UPDATE);
  const tip = /downloadSelfTip: '([^']*)'/.exec(UPDATE);
  assert.equal(label?.[1], 'Download it yourself');
  assert.notEqual(tip, null, 'a control that leaves the app window should say so');
  for (const text of [label?.[1] as string, tip?.[1] as string]) {
    assert.equal(/https?:\/\//.test(text), false, `no address in UI copy: ${text}`);
    assert.equal(text.includes('github.com'), false, `no host name in UI copy: ${text}`);
  }
  // Reused class, no new visual language for it.
  assert.match(CSS, /\.restart-ft \.btn-link \{\n\s*font-size: var\(--fs-ui\);\n\}/);
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
