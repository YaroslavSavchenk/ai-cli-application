/**
 * The releases-page opener — ONE address and ONE call, in
 * `web/src/ui/releases.ts`, with the update dialog's `Download it yourself`
 * fallback as its caller.
 *
 * WHAT IT IS. The link to the page where the newer Setup lives, opened in the
 * user's own browser when the user asks for it. It was the whole story until
 * phase E (2026-09-09) gave the app an Update button of its own; it stays as
 * the MANUAL fallback — the one thing left to offer when the in-app update
 * refused.
 *
 * NOCTURNE B6 (2026-09-22, user decision D4) took the settings panel off it:
 * `Check for updates` asks the backend to check NOW and answers on the page,
 * instead of sending the user to a release page to compare version numbers by
 * eye. The panel is therefore no longer a caller — what this file still pins
 * about it is that the button is the page's QUIET verb, that it exists only in
 * installed mode, and that the panel carries no address and opens no window of
 * its own.
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
 * PART B3 MOVED THE CALL, not the rule. The commit view got a second address
 * to leave for (`Open on GitHub`, user decision D2) — one BUILT from parts of
 * the user's own `remote.origin.url` — so the call itself lives in
 * `web/src/ui/open-external.ts`, which checks the address before it opens it,
 * and `ui/releases.ts` is the caller that owns the releases ADDRESS. One door,
 * checked once. (`ui/terminal.ts` keeps its own: an OSC 8 hyperlink a program
 * printed is `http` as well as `https` and is never logged, which is a
 * different rule for a different kind of address.)
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
const EXIT = read('web', 'src', 'ui', 'open-external.ts');
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
  // Nocturne A2 (2026-09-10): section labels are sentence case, not shouted
  // all-caps — `BACKEND` became `Backend`. Nocturne A7 (2026-09-13) turned the
  // sections into PAGES behind a left nav, and that one is `Background service`.
  assert.ok(
    SETTINGS.includes("    'Background service',"),
    'the Background service page must still exist',
  );
  assert.ok(SETTINGS.includes('function renderBackend'), 'the Backend readouts must still be rendered here');
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
  // A7: the panel's text-link class is `sg-link` (Nocturne primitives; the
  // Legacy `.btn-link` rule is built from the alias layer part A8 deletes).
  const label = /const checkBtn = button\('sg-link', CHECK_LABEL,/.exec(SETTINGS);
  assert.notEqual(label, null, 'the check must be built with the panel’s existing text-button idiom');
  assert.ok(SETTINGS.includes("const CHECK_LABEL = 'Check for updates';"), 'the word is still the word');
  const tip = /checkBtn\.title = '([^']*)';/.exec(SETTINGS);
  assert.notEqual(tip, null, 'a control should say what it is about to do');
  for (const text of ['Check for updates', tip?.[1] as string]) {
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
    EXIT.includes("window.open(url, '_blank', 'noopener,noreferrer');"),
    'the call must be exactly window.open(url, \'_blank\', \'noopener,noreferrer\')',
  );
  // It must be the checked VARIABLE that is opened, never a string built at
  // the call.
  assert.equal(/window\.open\(\s*'/.test(EXIT), false, 'no inline address at the call site');
  // Exactly one exit for every address the APP knows. (ui/terminal.ts opens an
  // address a PROGRAM printed, under its own `isOpenableLink` rule.)
  assert.equal(EXIT.split('window.open(').length - 1, 1, 'exactly one window is ever opened');
  for (const [name, src] of [
    ['settings.ts', SETTINGS],
    ['update.ts', UPDATE],
    ['releases.ts', RELEASES],
    ['commit-view.ts', read('web', 'src', 'ui', 'commit-view.ts')],
  ] as const) {
    assert.equal(src.includes('window.open('), false, `${name} must go through the shared opener`);
  }
  // And it must be a user CLICK: the host's exception is user-initiated only.
  // The update dialog is the one surface that offers it — part B6 took the
  // settings panel off this door, and its own check never leaves the window.
  assert.match(UPDATE, /const dlBtn = button\('rs-link', COPY\.downloadSelf, \(\) => \{[\s\S]*?openReleasesPage\(\);[\s\S]*?\}\);/);
  assert.equal(SETTINGS.includes('openReleasesPage'), false, 'the panel is no longer a caller (B6 D4)');
  assert.match(RELEASES, /import \{ openExternal \} from '\.\/open-external\.ts';/);
  // The panel itself still fetches nothing: checking is the backend's job now
  // (phase E) and asking the page to do it would be a second, unaudited path.
  assert.equal(SETTINGS.includes('fetch('), false, 'the panel must not check for updates over the network');
});

test('the exit refuses anything that is not EXACTLY an https address of ours (part B3)', async () => {
  // The commit view builds an address out of parts that came from the user's
  // own repository config, so the door checks before it opens: https only, no
  // credentials in it, and nothing the URL parser had to repair.
  const dom = (await import('./fake-dom.ts')).installDom();
  const opened: string[][] = [];
  (dom.win as unknown as { open: (u: string, t: string, f: string) => void }).open = (u, t, f) => {
    opened.push([u, t, f]);
  };
  const { openExternal } = (await import(
    new URL('../web/src/ui/open-external.ts', import.meta.url).href
  )) as { openExternal(url: string): boolean };

  for (const bad of [
    '',
    'not a url',
    'http://github.com/o/r/commit/abc',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/html,<script>1</script>',
    'https://user:pw@github.com/o/r',
    'https://github.com/o/r/commit/abc ',
    'HTTPS://GITHUB.COM/o/r',
  ]) {
    assert.equal(openExternal(bad), false, `opened: ${JSON.stringify(bad)}`);
  }
  assert.deepEqual(opened, [], 'not one of them reached a window');

  const good = 'https://github.com/you/app/commit/' + 'a'.repeat(40);
  assert.equal(openExternal(good), true);
  assert.deepEqual(opened, [[good, '_blank', 'noopener,noreferrer']]);
});

test('phase E: the update dialog’s manual fallback is the SAME opener, on a real click', () => {
  // It exists for exactly one moment: the app tried to fetch the new version
  // and could not. Sending the user somewhere else would be a second address to
  // keep right; this is the first one, called the same way.
  assert.match(UPDATE, /import \{ openReleasesPage \} from '\.\/releases\.ts';/);
  assert.match(
    UPDATE,
    /const dlBtn = button\('rs-link', COPY\.downloadSelf, \(\) => \{[\s\S]*?openReleasesPage\(\);[\s\S]*?\}\);/,
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
  // Same visual language as the settings panel's own text link: an underlined
  // accent-300 word at the control size, never a second button weight. Nocturne
  // A8 renamed the Legacy `btn-link` to the dialog's own `rs-link` (the
  // `.btn-link` rule was built from the alias layer A8 deletes).
  assert.match(CSS, /\.rs-link \{[^}]*color: var\(--color-accent-300\);/);
  assert.match(CSS, /\.rs-link \{[^}]*font-size: 12\.5px;/);
  assert.match(CSS, /\.rs-link \{[^}]*text-decoration: underline;/);
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
  // a control that does not apply. (The row it sits in has no display:none
  // override for it; app.css hides [hidden] globally.)
  assert.equal(/\.sg-svc[^{]*\{[^}]*display:\s*flex/.test(CSS), true);
});

test('the check is the QUIET verb beside Restart backend, on the panel’s control size', () => {
  // Design (frontend-designer pass): facts left, verbs right; a text button must
  // not outweigh the bordered button it sits next to. Both are reused idioms —
  // `sg-link` is the panel's own text-button class.
  // A7: the two verbs sit in one card on the Background service page, facts
  // first (they take the free space), then the link, then the bordered button.
  assert.match(
    SETTINGS,
    /card\.append\(facts, checkBtn, restartBtn\);/,
    'the link belongs in the facts cluster, with the restart button still anchored right',
  );
  assert.ok(
    SETTINGS.includes("button('sg-outbtn', 'Restart service'"),
    'the loud verb must still be a bordered button',
  );
  // Neither verb outweighs the other in type: one size for both, so the
  // BORDER is what says which one has consequences.
  assert.match(CSS, /\.sg-link \{[^}]*font-size: 12\.5px;/);
  assert.match(CSS, /\.sg-outbtn \{[^}]*font-size: 12\.5px;/);
  // No bespoke colour, radius or shadow was invented for it.
  assert.equal(CSS.includes('.settings-check'), false, 'no one-off class for this link');
});
