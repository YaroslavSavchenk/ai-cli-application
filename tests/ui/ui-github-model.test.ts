/**
 * `web/src/ui/github-model.ts` — the pure presentation logic extracted from
 * `ui/github.ts`. DOM-free by construction, so `node --test` imports it
 * directly (same split as theme-model / newproject-model); fixtures (a fixed
 * `now`, repo and project builders) in `tests/helpers/ui-github-model-fixture.ts`.
 * This file: the top-bar chip view, the source tag, the device-card copy, the
 * revoke note, the credential-storage honesty bar, the scopes note, and the
 * add-token error copy. Formats and cadence are in
 * `tests/ui/ui-github-model-format.test.ts`; clone destination, already-cloned
 * detection and clone-error copy in `tests/ui/ui-github-model-clone.test.ts`.
 *
 * Why: every string here is what the user reads about a credential — a storage
 * line above the verified ceiling, or a revoke note pointing at the wrong
 * GitHub screen, is a lie about their token that no error ever reports.
 *
 * NO TOKEN appears anywhere in these fixtures: GithubStatus carries none by
 * protocol design (it stays server-side) and nothing under test accepts one.
 *
 * NOT claimed: how the DOM draws these (escaping at the DOM edge is the
 * panel's), and anything the server says (`tests/server/`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chipView,
  deviceCardCopy,
  rememberNote,
  rememberSample,
  revokeNote,
  scopesNote,
  sourceLabel,
  storageNote,
  tokenErrText,
} from '../../web/src/ui/github-model.ts';
import { type GithubStatus } from '../../shared/protocol.ts';
import { DAY, ahead } from '../helpers/ui-github-model-fixture.ts';

// ---------------------------------------------------------------------------
// chipView — every state the top bar can show
// ---------------------------------------------------------------------------

test('chipView: status not yet fetched (null) is the neutral off chip', () => {
  assert.deepEqual(chipView(null), { state: 'off', label: 'GitHub', initial: 'G', aria: 'GitHub' });
});

test('chipView: NO device flow on this server is still an actionable "Connect GitHub" chip', () => {
  // THE REGRESSION THIS PATH EXISTS FOR (2026-07-25). `configured:false` used to
  // render a dead "GitHub" chip opening a dormant panel. A pasted token needs no
  // OAuth client id, so such a server is an ordinary disconnected one — and it
  // is exactly the user who has to see the invitation.
  assert.deepEqual(chipView({ deviceFlowAvailable: false, state: 'disconnected' }), {
    state: 'disconnected',
    label: 'Connect GitHub',
    initial: 'G',
    aria: 'GitHub — connect your account',
  });
});

test('chipView: disconnected reads the same whether or not device sign-in is available', () => {
  assert.deepEqual(
    chipView({ deviceFlowAvailable: true, state: 'disconnected' }),
    chipView({ deviceFlowAvailable: false, state: 'disconnected' }),
  );
});

test('chipView: connecting shows the in-progress label', () => {
  assert.deepEqual(chipView({ deviceFlowAvailable: true, state: 'connecting', userCode: 'ABCD-1234' }), {
    state: 'connecting',
    label: 'Connecting',
    initial: 'G',
    aria: 'GitHub — connecting',
  });
});

test('chipView: a connection made by SIGNING IN says so in the accessible name (V-5)', () => {
  // The Nocturne chip is an avatar + a name, so the credential is no longer a
  // visible tag — it survives in the accessible name AND the tooltip, which is
  // the same string. "Connected HOW" must stay answerable: the two credentials
  // are revoked in different places.
  assert.deepEqual(
    chipView({ deviceFlowAvailable: true, state: 'connected', login: 'sava', source: 'device' }),
    {
      state: 'connected',
      label: 'sava',
      initial: 'S',
      aria: 'GitHub — connected as sava by signing in with GitHub',
    },
  );
});

test('chipView: a connection made by a PASTED TOKEN says so too — the two are revoked differently', () => {
  assert.deepEqual(
    chipView({ deviceFlowAvailable: false, state: 'connected', login: 'sava', source: 'pat' }),
    {
      state: 'connected',
      label: 'sava',
      initial: 'S',
      aria: 'GitHub — connected as sava with a pasted token',
    },
  );
});

test('chipView: an UNKNOWN source is left unlabelled rather than guessed', () => {
  assert.deepEqual(chipView({ deviceFlowAvailable: true, state: 'connected', login: 'sava' }), {
    state: 'connected',
    label: 'sava',
    initial: 'S',
    aria: 'GitHub — connected as sava',
  });
});

test('chipView: connected without a login degrades to the neutral name, never "undefined"', () => {
  const v = chipView({ deviceFlowAvailable: true, state: 'connected' });
  assert.equal(v.state, 'connected');
  assert.equal(v.label, 'GitHub', 'a nameless connection reads as the feature, not as an empty chip');
  assert.equal(v.initial, 'G', 'and the avatar keeps the feature letter');
  // A nameless connection drops the "as …" clause instead of ending in
  // "connected as " with nothing after it (github-model.ts chipView).
  assert.equal(v.aria, 'GitHub — connected');
  assert.equal(v.label.includes('undefined'), false);
  assert.equal(v.aria.includes('undefined'), false);
});

test('chipView: the login is passed through verbatim (untrusted string, escaped at the DOM edge)', () => {
  const v = chipView({ deviceFlowAvailable: true, state: 'connected', login: '<img src=x>' });
  assert.equal(v.label, '<img src=x>', 'no mangling here — github.ts sets it via textContent');
  assert.equal(v.initial, '<', 'the avatar letter is the login\u2019s own first character, upper-cased');
});

test('chipView: aria is a non-empty accessible name in every state (also used as the tooltip)', () => {
  const states: (GithubStatus | null)[] = [
    null,
    { deviceFlowAvailable: false, state: 'disconnected' },
    { deviceFlowAvailable: true, state: 'disconnected' },
    { deviceFlowAvailable: true, state: 'connecting' },
    { deviceFlowAvailable: true, state: 'connected', login: 'sava', source: 'device' },
    { deviceFlowAvailable: false, state: 'connected', login: 'sava', source: 'pat' },
  ];
  for (const s of states) {
    const v = chipView(s);
    assert.ok(v.aria.length > 0, `aria must be present for ${JSON.stringify(s)}`);
    assert.ok(v.label.length > 0, `label must be present for ${JSON.stringify(s)}`);
    assert.ok(v.aria.startsWith('GitHub'), 'every accessible name names the feature first');
  }
});

test('chipView: NOTHING it returns could be a credential — only account + source', () => {
  // Cheap standing guard: GithubStatus carries no token by protocol design, and
  // the chip must never grow a field that would show one.
  const v = chipView({
    deviceFlowAvailable: true,
    state: 'connected',
    login: 'sava',
    source: 'pat',
    persisted: true,
    scopes: ['repo'],
    expiresAt: ahead(DAY),
  });
  assert.deepEqual(Object.keys(v).sort(), ['aria', 'initial', 'label', 'state']);
  assert.equal(v.initial.length, 1, 'the avatar carries exactly one character');
  assert.equal(v.initial, v.initial.toUpperCase(), 'upper-cased');
  assert.equal(v.initial, 'S', 'and it is the account initial — a letter already printed in full beside it');
  const blob = JSON.stringify(v);
  assert.equal(blob.includes('repo'), false, 'the chip shows no permissions');
  assert.equal(blob.includes('2026-'), false, 'and no timestamps');
});

// ---------------------------------------------------------------------------
// sourceLabel — the credential the user is actually holding
// ---------------------------------------------------------------------------

test('sourceLabel: each path has one name, and an unknown source has none', () => {
  assert.equal(sourceLabel('pat'), 'pasted token');
  assert.equal(sourceLabel('device'), 'signed in with GitHub');
  assert.equal(sourceLabel(undefined), '');
});

// ---------------------------------------------------------------------------
// deviceCardCopy — a server without an OAuth App must not read as dormant
// ---------------------------------------------------------------------------

test('deviceCardCopy: with device sign-in available, the body offers BOTH paths', () => {
  const c = deviceCardCopy(true);
  assert.equal(
    c.body,
    'List your repositories from inside the manager, clone them, and create new ones. Connect by signing in with GitHub, or by pasting a token you create yourself.',
  );
  assert.equal(
    c.fine,
    'You sign in once through GitHub. The token is kept server-side, never in the browser. It can read and write every repository on the account, and usually does not expire.',
  );
  assert.equal(c.fine.includes('·'), false, 'no decorative separators in UI copy (README-v3)');
  assert.equal(c.note, '', 'no "not set up" note when it IS set up');
  assert.equal(c.tokenTitle, 'Or paste a GitHub token', 'the token card is the SECOND path here');
});

test('deviceCardCopy: without it, the note explains the missing button AND points at the token path', () => {
  const c = deviceCardCopy(false);
  assert.equal(
    c.body,
    'List your repositories from inside the manager, clone them, and create new ones.',
  );
  assert.equal(c.fine, '', 'no sign-in fine print when there is no sign-in button');
  assert.equal(
    c.note,
    'Signing in with GitHub is not set up on this server — see the project README. Pasting a token works without it.',
  );
  assert.equal(c.tokenTitle, 'Paste a GitHub token', 'the token card is the ONLY path here');
});

test('deviceCardCopy: the unavailable copy never says the FEATURE is unusable', () => {
  // The old dormant card said "GitHub isn't set up on this server" and took over
  // the panel. The replacement must not repeat that: a pasted token works here.
  const c = deviceCardCopy(false);
  for (const text of [c.body, c.note]) {
    assert.equal(/nothing to do in the browser/i.test(text), false);
    assert.equal(/cannot be used|can’t be used|unavailable/i.test(text), false);
  }
  assert.match(c.note, /Pasting a token works without it\./);
});

test('deviceCardCopy: names no configuration variable (the 2026-07-25 copy rule)', () => {
  for (const b of [true, false]) {
    const c = deviceCardCopy(b);
    for (const text of [c.body, c.fine, c.note, c.tokenTitle]) {
      assert.equal(text.includes('AI_SM'), false);
      assert.equal(/--[A-Za-z]/.test(text), false, 'no CLI flags in UI copy');
    }
  }
});

// ---------------------------------------------------------------------------
// revokeNote — WRONG here means a live credential the user believes is dead
// ---------------------------------------------------------------------------

test('revokeNote: a pasted token is revoked under Developer settings, NOT under Applications', () => {
  const n = revokeNote('pat');
  assert.equal(
    n,
    'Disconnect removes the token from this app. To revoke it everywhere, delete it on GitHub under Settings → Developer settings → Personal access tokens.',
  );
  assert.equal(
    /→ Applications/.test(n),
    false,
    'the device-flow instruction is WRONG for a PAT — it would leave a live token',
  );
});

test('revokeNote: a device-flow grant keeps the Applications instruction', () => {
  assert.equal(
    revokeNote('device'),
    'Disconnect removes the token from this app. To revoke access everywhere, remove the app on GitHub under Settings → Applications.',
  );
});

test('revokeNote: an unknown source names BOTH screens rather than picking one', () => {
  const n = revokeNote(undefined);
  assert.match(n, /Settings → Applications/);
  assert.match(n, /Personal access tokens/);
});

test('revokeNote: every variant says the app-local removal is NOT a revocation', () => {
  for (const s of ['pat', 'device', undefined] as const) {
    assert.match(revokeNote(s), /^Disconnect removes the (token|credential) from this app\./);
    assert.match(revokeNote(s), /revoke/);
  }
});

// ---------------------------------------------------------------------------
// storageNote / rememberNote — the honesty ceiling (design gate II-6)
// ---------------------------------------------------------------------------

/** Words an auditor verified we cannot honestly use about storage here. */
const FORBIDDEN_STORAGE_WORDS = [
  'keychain',
  'keyring',
  'encrypt',
  'secure',
  'securely',
  'vault',
  'protected',
  'safe from',
];

function assertHonest(text: string): void {
  for (const w of FORBIDDEN_STORAGE_WORDS) {
    assert.equal(
      text.toLowerCase().includes(w),
      false,
      `storage copy must not claim "${w}": ${JSON.stringify(text)}`,
    );
  }
}

test('storageNote: a persisted token is described EXACTLY at the verified ceiling', () => {
  const n = storageNote(true);
  assert.equal(
    n,
    'Stored on this machine in the app’s data folder, readable by your own user account.',
  );
  assertHonest(n);
});

test('storageNote: a non-persisted token says plainly that it disappears', () => {
  const n = storageNote(false);
  assert.equal(
    n,
    'Kept in this app’s memory only — it is gone when the app closes, and you paste it again next time.',
  );
  assertHonest(n);
});

test('storageNote: an unreported `persisted` renders NO line (never a guess)', () => {
  assert.equal(storageNote(undefined), '');
});

test('rememberNote: the toggle spells out the on-disk copy it adds or removes', () => {
  assert.equal(
    rememberNote(true),
    'Stored on this machine in the app’s data folder, readable by your own user account.',
  );
  assert.equal(
    rememberNote(false),
    'Kept in this app’s memory only. It disappears when the app closes — about half a minute after the last window — and you paste it again next time.',
  );
  assertHonest(rememberNote(true));
  assertHonest(rememberNote(false));
});

test('rememberNote: ON and OFF actually differ, and only OFF promises disappearance', () => {
  assert.notEqual(rememberNote(true), rememberNote(false));
  assert.match(rememberNote(false), /disappears/);
  assert.equal(/disappears/.test(rememberNote(true)), false);
});

test('rememberSample: the row’s mono value names the outcome, not the setting', () => {
  assert.equal(rememberSample(true), 'kept on this machine');
  assert.equal(rememberSample(false), 'until the app closes');
});

test('every credential string in this module clears the honesty bar at once', () => {
  const all = [
    storageNote(true),
    storageNote(false),
    rememberNote(true),
    rememberNote(false),
    rememberSample(true),
    rememberSample(false),
    revokeNote('pat'),
    revokeNote('device'),
    revokeNote(undefined),
    deviceCardCopy(true).fine,
    deviceCardCopy(false).note,
  ];
  for (const t of all) assertHonest(t);
});

// ---------------------------------------------------------------------------
// scopesNote — absence is "not reportable", never "no permissions" (V-1)
// ---------------------------------------------------------------------------

test('scopesNote: reported scopes are shown plainly, in order, comma-separated', () => {
  assert.equal(scopesNote(['repo']), 'this token can: repo');
  assert.equal(scopesNote(['repo', 'read:org', 'gist']), 'this token can: repo, read:org, gist');
});

test('scopesNote: ABSENT scopes render nothing — a fine-grained token is not a powerless one', () => {
  // GitHub does not report fine-grained permissions on the scopes header, so
  // "no permissions" would be exactly backwards. Silence is the honest render.
  assert.equal(scopesNote(undefined), null);
});

test('scopesNote: an EMPTY list is a real reported answer, and reads differently from absence', () => {
  // shared/protocol.ts draws this line explicitly: no header at all (fine-grained)
  // vs. a classic token that genuinely carries no scopes. Collapsing the two
  // would make a fine-grained token look scopeless.
  assert.equal(scopesNote([]), 'GitHub reports no scopes on this token');
  assert.equal(scopesNote(['']), 'GitHub reports no scopes on this token');
  assert.notEqual(scopesNote([]), scopesNote(undefined));
});

test('scopesNote: scope strings pass through verbatim (untrusted → textContent at the DOM edge)', () => {
  assert.equal(scopesNote(['<img src=x>']), 'this token can: <img src=x>');
});

// ---------------------------------------------------------------------------
// tokenErrText — a failed "add token", said honestly and without describing the
// credential (a format allowlist / prefix hint was refused by the design gate)
// ---------------------------------------------------------------------------

test('tokenErrText: the server’s real message always wins over the fallback', () => {
  assert.equal(tokenErrText(401, 'GitHub rejected the credentials'), 'GitHub rejected the credentials');
  assert.equal(tokenErrText(502, 'github.com is unreachable'), 'github.com is unreachable');
});

test('tokenErrText: the two bare statuses the route documents map to its two meanings', () => {
  // shared/protocol.ts: 400 = GitHub rejected/refused it, 502 = GitHub unreachable.
  assert.equal(tokenErrText(400, 'HTTP 400'), 'GitHub did not accept that token');
  assert.equal(tokenErrText(502, 'HTTP 502'), 'could not reach GitHub');
});

test('tokenErrText: an unmapped bare status keeps the raw `HTTP <n>` (never an invented cause)', () => {
  // 401/403 are the APP's own auth failures (the page-takeover path), not the
  // pasted token's — inventing a token story for them would be a lie.
  for (const s of [401, 403, 404, 405, 409, 413, 415, 422, 500]) {
    assert.equal(tokenErrText(s, `HTTP ${s}`), `HTTP ${s}`);
  }
});

test('tokenErrText: no fallback describes the token itself — no length, prefix, or shape', () => {
  for (const s of [400, 502]) {
    const t = tokenErrText(s, `HTTP ${s}`);
    assert.equal(/character|length|prefix|start|format|looks like/i.test(t), false, t);
  }
});
