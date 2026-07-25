/**
 * `web/src/ui/github-model.ts` — the pure presentation logic extracted from
 * `ui/github.ts` (top-bar chip view, device-code expiry + relative-time
 * formats, Linguist language colors, poll/tick cadence, clone destination,
 * already-cloned detection, clone-error copy). DOM-free by construction, so
 * `node --test` imports it directly (same split as theme-model / newproject-
 * model).
 *
 * The reason these were untestable before: every clock-dependent format read
 * `Date.now()` internally. `now` is now an injected ms-epoch parameter, so
 * every boundary below (59s/60s, 59m/60m, 23h/24h, 29d/30d, 11mo/12mo, and
 * expiry-already-past) is asserted at an exact instant, not approximately.
 *
 * NO TOKEN appears anywhere in these fixtures: GithubStatus carries none by
 * protocol design (it stays server-side) and nothing under test accepts one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GH_EXPIRY_TICK_MS,
  GH_POLL_MS,
  GH_SEARCH_DEBOUNCE_MS,
  LANG_COLOR,
  chipView,
  clonedProject,
  cloneErrText,
  defaultDest,
  expiryTickMs,
  fmtExpiry,
  langColor,
  ownerDest,
  pollIntervalMs,
  relTime,
} from '../web/src/ui/github-model.ts';
import {
  repoBasename,
  suggestDestPath,
  suggestProjectPath,
} from '../web/src/ui/newproject-model.ts';
import type { GithubRepo, GithubStatus, Project } from '../shared/protocol.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = Date.parse('2026-07-24T12:00:00.000Z');
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** ISO timestamp `ms` milliseconds BEFORE NOW (i.e. in the past). */
function ago(ms: number): string {
  return new Date(NOW - ms).toISOString();
}

/** ISO timestamp `ms` milliseconds AFTER NOW (i.e. in the future). */
function ahead(ms: number): string {
  return new Date(NOW + ms).toISOString();
}

function repo(over: Partial<GithubRepo> = {}): GithubRepo {
  return {
    fullName: 'sava/ai-cli-application',
    name: 'ai-cli-application',
    owner: 'sava',
    private: true,
    cloneUrl: 'https://github.com/sava/ai-cli-application.git',
    ...over,
  };
}

function project(over: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'ai-cli-application',
    path: '/home/sava/projects/ai-cli-application',
    createdAt: '2026-07-01T00:00:00.000Z',
    ...over,
  };
}

// ---------------------------------------------------------------------------
// chipView — every state the top bar can show
// ---------------------------------------------------------------------------

test('chipView: status not yet fetched (null) is the neutral off chip', () => {
  assert.deepEqual(chipView(null), { state: 'off', label: 'GitHub', aria: 'GitHub' });
});

test('chipView: not configured (dormant server) stays off, but the aria says why', () => {
  assert.deepEqual(chipView({ configured: false, state: 'disconnected' }), {
    state: 'off',
    label: 'GitHub',
    aria: 'GitHub — not set up on this server',
  });
});

test('chipView: an unconfigured server wins over the state field (never a live-looking chip)', () => {
  // The server reports configured:false; whatever `state` says must not leak
  // into a connected/connecting-looking chip.
  for (const state of ['disconnected', 'connecting', 'connected'] as const) {
    const v = chipView({ configured: false, state, login: 'sava' });
    assert.equal(v.state, 'off', `configured:false + state:${state} must render off`);
    assert.equal(v.label, 'GitHub');
    assert.equal(v.aria, 'GitHub — not set up on this server');
  }
});

test('chipView: disconnected invites the connect action', () => {
  assert.deepEqual(chipView({ configured: true, state: 'disconnected' }), {
    state: 'disconnected',
    label: 'Connect GitHub',
    aria: 'GitHub — connect your account',
  });
});

test('chipView: connecting shows the in-progress label (U+2026 ellipsis)', () => {
  assert.deepEqual(
    chipView({ configured: true, state: 'connecting', userCode: 'ABCD-1234' }),
    { state: 'connecting', label: 'connecting…', aria: 'GitHub — connecting' },
  );
});

test('chipView: connected shows @login', () => {
  assert.deepEqual(chipView({ configured: true, state: 'connected', login: 'sava' }), {
    state: 'connected',
    label: '@sava',
    aria: 'GitHub — connected as sava',
  });
});

test('chipView: connected without a login degrades to an empty name, never "undefined"', () => {
  const v = chipView({ configured: true, state: 'connected' });
  assert.equal(v.state, 'connected');
  assert.equal(v.label, '@');
  assert.equal(v.aria, 'GitHub — connected as ');
  assert.equal(v.label.includes('undefined'), false);
});

test('chipView: the login is passed through verbatim (untrusted string, escaped at the DOM edge)', () => {
  const v = chipView({ configured: true, state: 'connected', login: '<img src=x>' });
  assert.equal(v.label, '@<img src=x>', 'no mangling here — github.ts sets it via textContent');
});

test('chipView: aria is a non-empty accessible name in every state (also used as the tooltip)', () => {
  const states: (GithubStatus | null)[] = [
    null,
    { configured: false, state: 'disconnected' },
    { configured: true, state: 'disconnected' },
    { configured: true, state: 'connecting' },
    { configured: true, state: 'connected', login: 'sava' },
  ];
  for (const s of states) {
    const v = chipView(s);
    assert.ok(v.aria.length > 0, `aria must be present for ${JSON.stringify(s)}`);
    assert.ok(v.label.length > 0, `label must be present for ${JSON.stringify(s)}`);
    assert.ok(v.aria.startsWith('GitHub'), 'every accessible name names the feature first');
  }
});

// ---------------------------------------------------------------------------
// fmtExpiry — now injected
// ---------------------------------------------------------------------------

test('fmtExpiry: no expiry at all renders nothing (the line is blank, not "expired")', () => {
  assert.equal(fmtExpiry(undefined, NOW), '');
});

test('fmtExpiry: a future expiry counts down as zero-padded MM:SS', () => {
  assert.equal(fmtExpiry(ahead(15 * MIN), NOW), 'expires in 15:00');
  assert.equal(fmtExpiry(ahead(9 * MIN + 5 * SEC), NOW), 'expires in 09:05');
  assert.equal(fmtExpiry(ahead(65 * SEC), NOW), 'expires in 01:05');
  assert.equal(fmtExpiry(ahead(1 * SEC), NOW), 'expires in 00:01');
});

test('fmtExpiry: sub-second remainders floor (999ms left is still 00:00, never rounded up)', () => {
  assert.equal(fmtExpiry(ahead(999), NOW), 'expires in 00:00');
});

test('fmtExpiry: over an hour keeps counting in minutes (no HH:MM:SS switch)', () => {
  assert.equal(fmtExpiry(ahead(90 * MIN), NOW), 'expires in 90:00');
});

test('fmtExpiry: exactly-now and already-past both read as expired', () => {
  assert.equal(fmtExpiry(ahead(0), NOW), 'code expired — cancel and retry');
  assert.equal(fmtExpiry(ago(1), NOW), 'code expired — cancel and retry');
  assert.equal(fmtExpiry(ago(10 * MIN), NOW), 'code expired — cancel and retry');
});

test('fmtExpiry: an unparseable timestamp reads as expired (never NaN:NaN)', () => {
  assert.equal(fmtExpiry('not-a-date', NOW), 'code expired — cancel and retry');
  assert.equal(fmtExpiry('', NOW), 'code expired — cancel and retry');
});

test('fmtExpiry: the same instant with a later `now` counts down — the clock is the caller’s', () => {
  const iso = ahead(2 * MIN);
  assert.equal(fmtExpiry(iso, NOW), 'expires in 02:00');
  assert.equal(fmtExpiry(iso, NOW + 30 * SEC), 'expires in 01:30');
  assert.equal(fmtExpiry(iso, NOW + 2 * MIN), 'code expired — cancel and retry');
});

// ---------------------------------------------------------------------------
// relTime — now injected
// ---------------------------------------------------------------------------

test('relTime: absent / empty / unparseable input renders nothing', () => {
  assert.equal(relTime(undefined, NOW), '');
  assert.equal(relTime('', NOW), '');
  assert.equal(relTime('yesterday', NOW), '');
  assert.equal(relTime('2026-13-45T99:99:99Z', NOW), '');
});

test('relTime: under a minute is "just now"', () => {
  assert.equal(relTime(ago(0), NOW), 'just now');
  assert.equal(relTime(ago(1 * SEC), NOW), 'just now');
  assert.equal(relTime(ago(59 * SEC), NOW), 'just now');
});

test('relTime: the 60s boundary crosses to minutes', () => {
  assert.equal(relTime(ago(60 * SEC), NOW), '1m ago');
  assert.equal(relTime(ago(119 * SEC), NOW), '1m ago', 'minutes floor');
  assert.equal(relTime(ago(59 * MIN), NOW), '59m ago');
});

test('relTime: the 60m boundary crosses to hours', () => {
  assert.equal(relTime(ago(60 * MIN), NOW), '1h ago');
  assert.equal(relTime(ago(90 * MIN), NOW), '1h ago', 'hours floor');
  assert.equal(relTime(ago(23 * HOUR), NOW), '23h ago');
});

test('relTime: the 24h boundary crosses to days', () => {
  assert.equal(relTime(ago(24 * HOUR), NOW), '1d ago');
  assert.equal(relTime(ago(47 * HOUR), NOW), '1d ago', 'days floor');
  assert.equal(relTime(ago(29 * DAY), NOW), '29d ago');
});

test('relTime: the 30d boundary crosses to months (a month is a flat 30 days)', () => {
  assert.equal(relTime(ago(30 * DAY), NOW), '1mo ago');
  assert.equal(relTime(ago(59 * DAY), NOW), '1mo ago');
  assert.equal(relTime(ago(60 * DAY), NOW), '2mo ago');
  assert.equal(relTime(ago(359 * DAY), NOW), '11mo ago');
});

test('relTime: the 12mo (360d) boundary crosses to years', () => {
  assert.equal(relTime(ago(360 * DAY), NOW), '1y ago');
  assert.equal(relTime(ago(719 * DAY), NOW), '1y ago');
  assert.equal(relTime(ago(720 * DAY), NOW), '2y ago');
  assert.equal(relTime(ago(3600 * DAY), NOW), '10y ago');
});

test('relTime: a future timestamp (clock skew) degrades to "just now", never a negative age', () => {
  assert.equal(relTime(ahead(5 * MIN), NOW), 'just now');
  assert.equal(relTime(ahead(365 * DAY), NOW), 'just now');
});

test('relTime: the same instant ages as `now` advances — the clock is the caller’s', () => {
  const iso = ago(0);
  assert.equal(relTime(iso, NOW), 'just now');
  assert.equal(relTime(iso, NOW + 5 * MIN), '5m ago');
  assert.equal(relTime(iso, NOW + 5 * HOUR), '5h ago');
  assert.equal(relTime(iso, NOW + 5 * DAY), '5d ago');
});

// ---------------------------------------------------------------------------
// langColor
// ---------------------------------------------------------------------------

test('langColor: known languages return their Linguist color verbatim', () => {
  assert.equal(langColor('TypeScript'), '#3178c6');
  assert.equal(langColor('JavaScript'), '#f1e05a');
  assert.equal(langColor('Python'), '#3572A5');
  assert.equal(langColor('C++'), '#f34b7d');
  assert.equal(langColor('C#'), '#178600');
  assert.equal(langColor('Objective-C'), '#438eff');
  assert.equal(langColor('Nix'), '#7e7eff');
});

test('langColor: an UNKNOWN language returns undefined — the caller then draws NO dot', () => {
  assert.equal(langColor('Brainfuck'), undefined);
  assert.equal(langColor('typescript'), undefined, 'lookup is case-sensitive, as GitHub reports it');
  assert.equal(langColor('TypeScript '), undefined, 'no trimming — exact Linguist names only');
});

test('langColor: absent / empty language returns undefined', () => {
  assert.equal(langColor(undefined), undefined);
  assert.equal(langColor(''), undefined);
});

test('langColor: Object.prototype keys are NOT languages — the lookup is own-property only', () => {
  // The table is a plain object literal, so a bare `LANG_COLOR[language]` would
  // resolve inherited members (a Function for `constructor`/`toString`,
  // Object.prototype for `__proto__`) and the caller would then draw a dot with
  // an invalid inline background (an invisible 8px gap — `.gh-lang-dot` has no
  // background fallback). The Object.hasOwn guard in langColor makes every one
  // of these an unknown language, exactly like `Brainfuck`.
  assert.equal(langColor('constructor'), undefined);
  assert.equal(langColor('toString'), undefined);
  assert.equal(langColor('hasOwnProperty'), undefined);
  assert.equal(langColor('__proto__'), undefined);
  assert.equal(langColor('valueOf'), undefined);
});

test('LANG_COLOR: every entry is a 6-digit hex color (inline style safety)', () => {
  const entries = Object.entries(LANG_COLOR);
  assert.equal(entries.length, 28);
  for (const [lang, hex] of entries) {
    assert.match(hex, /^#[0-9a-fA-F]{6}$/, `${lang} -> ${hex} must be a plain hex color`);
  }
});

// ---------------------------------------------------------------------------
// Cadence
// ---------------------------------------------------------------------------

test('pollIntervalMs: paused when idle — closed tab + disconnected/connected/unknown', () => {
  assert.equal(pollIntervalMs(false, null), null);
  assert.equal(pollIntervalMs(false, { configured: false, state: 'disconnected' }), null);
  assert.equal(pollIntervalMs(false, { configured: true, state: 'disconnected' }), null);
  assert.equal(pollIntervalMs(false, { configured: true, state: 'connected', login: 'sava' }), null);
});

test('pollIntervalMs: fast while the GitHub tab is open, whatever the state', () => {
  assert.equal(pollIntervalMs(true, null), GH_POLL_MS);
  assert.equal(pollIntervalMs(true, { configured: false, state: 'disconnected' }), GH_POLL_MS);
  assert.equal(pollIntervalMs(true, { configured: true, state: 'connected', login: 'sava' }), GH_POLL_MS);
});

test('pollIntervalMs: fast while connecting even with the tab closed (the device flow must land)', () => {
  assert.equal(pollIntervalMs(false, { configured: true, state: 'connecting' }), GH_POLL_MS);
  assert.equal(pollIntervalMs(true, { configured: true, state: 'connecting' }), GH_POLL_MS);
});

test('expiryTickMs: ticks only while active AND configured AND connecting', () => {
  assert.equal(expiryTickMs(true, { configured: true, state: 'connecting' }), GH_EXPIRY_TICK_MS);
});

test('expiryTickMs: an inactive (hidden) panel never ticks', () => {
  assert.equal(expiryTickMs(false, { configured: true, state: 'connecting' }), null);
  assert.equal(expiryTickMs(false, null), null);
});

test('expiryTickMs: no countdown outside the connecting state (no code is on screen)', () => {
  assert.equal(expiryTickMs(true, null), null);
  assert.equal(expiryTickMs(true, { configured: true, state: 'disconnected' }), null);
  assert.equal(expiryTickMs(true, { configured: true, state: 'connected', login: 'sava' }), null);
  assert.equal(
    expiryTickMs(true, { configured: false, state: 'connecting' }),
    null,
    'unconfigured servers show the setup panel, not a code',
  );
});

test('cadence constants are the documented values', () => {
  assert.equal(GH_POLL_MS, 2500);
  assert.equal(GH_EXPIRY_TICK_MS, 1000);
  assert.equal(GH_SEARCH_DEBOUNCE_MS, 300);
});

// ---------------------------------------------------------------------------
// defaultDest / ownerDest / clonedProject
// ---------------------------------------------------------------------------

test('defaultDest: <home>/projects/<name>, with a trailing slash on home tolerated', () => {
  assert.equal(defaultDest('/home/sava', 'ai-cli-application'), '/home/sava/projects/ai-cli-application');
  assert.equal(defaultDest('/home/sava/', 'x'), '/home/sava/projects/x');
  assert.equal(defaultDest('/', 'x'), '/projects/x');
});

test('ownerDest: <home>/projects/<owner>/<repo> — the destination every app clone now uses', () => {
  assert.equal(ownerDest('/home/sava', 'acme', 'api'), '/home/sava/projects/acme/api');
  assert.equal(ownerDest('/home/sava/', 'acme', 'api'), '/home/sava/projects/acme/api', 'trailing slash');
  assert.equal(ownerDest('/', 'acme', 'api'), '/projects/acme/api', 'root home');
});

test('ownerDest: the SAME repo name under two owners produces two different destinations', () => {
  // This is the whole point of the 2026-07-25 decision: the old shared
  // <home>/projects/api made the second clone 409 and mis-resolve to the first.
  assert.notEqual(ownerDest('/home/sava', 'acme', 'api'), ownerDest('/home/sava', 'myorg', 'api'));
  assert.equal(ownerDest('/home/sava', 'acme', 'api'), '/home/sava/projects/acme/api');
  assert.equal(ownerDest('/home/sava', 'myorg', 'api'), '/home/sava/projects/myorg/api');
});

test('ownerDest: its owner segment is the ONLY difference from the legacy defaultDest', () => {
  // Pins the two conventions against silent drift: same home, same leaf.
  assert.equal(ownerDest('/home/sava', 'acme', 'api'), `${defaultDest('/home/sava', 'acme')}/api`);
});

test('clonedProject: no local projects at all → null (the row offers clone)', () => {
  assert.equal(clonedProject(repo(), '/home/sava', []), null);
});

test('clonedProject: matches by NAME even before home resolves (home null)', () => {
  const p = project({ path: '/somewhere/else/entirely' });
  assert.equal(clonedProject(repo(), null, [p]), p);
});

test('clonedProject: matches by the LEGACY clone path when the name differs', () => {
  const p = project({ id: 'p2', name: 'renamed-locally' });
  assert.equal(clonedProject(repo(), '/home/sava', [p]), p);
});

test('clonedProject: an app clone at the OWNER-QUALIFIED path is matched, and needs no home', () => {
  const r = repo({ fullName: 'acme/api', name: 'api', owner: 'acme' });
  const p = project({ id: 'p-owner', name: 'api', path: ownerDest('/home/sava', 'acme', 'api') });
  assert.equal(clonedProject(r, '/home/sava', [p]), p);
  assert.equal(clonedProject(r, null, [p]), p, 'path-tail matching does not depend on home');
});

test('clonedProject: the owner-qualified path tail wins over a bare-named LEGACY project', () => {
  const legacy = project({ id: 'legacy', name: 'api', path: '/home/sava/projects/api' });
  const owned = project({ id: 'owned', name: 'my api', path: '/home/sava/projects/myorg/api' });
  const r = repo({ fullName: 'myorg/api', name: 'api', owner: 'myorg' });
  assert.equal(clonedProject(r, '/home/sava', [legacy, owned]), owned, 'tail match is checked FIRST');
});

test('clonedProject: a path tail under a DIFFERENT owner is never a match (segment-exact)', () => {
  const other = project({ id: 'other', name: 'x', path: '/home/sava/projects/myorg/api' });
  const suffix = project({ id: 'suffix', name: 'y', path: '/home/sava/projects/notacme/api' });
  const deeper = project({ id: 'deeper', name: 'z', path: '/home/sava/projects/acme/api/sub' });
  const r = repo({ fullName: 'acme/api', name: 'api', owner: 'acme' });
  assert.equal(clonedProject(r, '/home/sava', [other, suffix, deeper]), null);
});

test('clonedProject: the OWNER segment matches case-insensitively — the same rule the server applies', () => {
  // server/github.ts compares the dest's parent basename to the url owner with
  // toLowerCase(), so `<projects>/Acme/api` is a folder it would accept (and
  // then refuse to clone into again, 409). A case-SENSITIVE client would keep
  // offering `clone` for it. The repo segment stays exact — it is a real
  // filesystem name, and the server's vacancy check is exact.
  const r = repo({ fullName: 'acme/api', name: 'api', owner: 'acme' });
  const upper = project({ id: 'p-upper', name: 'x', path: '/home/sava/projects/Acme/api' });
  assert.equal(clonedProject(r, '/home/sava', [upper]), upper, 'owner case is ignored');
  const mixed = repo({ fullName: 'AcMe/api', name: 'api', owner: 'AcMe' });
  const lower = project({ id: 'p-lower', name: 'y', path: '/home/sava/projects/acme/api' });
  assert.equal(clonedProject(mixed, '/home/sava', [lower]), lower, 'in both directions');
  // The repo segment is NOT case-folded.
  const upperRepo = project({ id: 'p-repo', name: 'z', path: '/home/sava/projects/acme/API' });
  assert.equal(clonedProject(r, '/home/sava', [upperRepo]), null, 'a different repo folder is not ours');
});

test('clonedProject: a trailing slash on a stored path does not break the tail match', () => {
  const p = project({ id: 'slash', name: 'x', path: '/home/sava/projects/acme/api/' });
  const r = repo({ fullName: 'acme/api', name: 'api', owner: 'acme' });
  assert.equal(clonedProject(r, '/home/sava', [p]), p);
});

test('clonedProject: a hand-placed checkout following the same convention is matched too', () => {
  // /srv/src/<owner>/<repo> is the same owner-qualified shape, just not under
  // <home>/projects — the tail match is deliberately home-independent.
  const p = project({ id: 'srv', name: 'work api', path: '/srv/src/acme/api' });
  const r = repo({ fullName: 'acme/api', name: 'api', owner: 'acme' });
  assert.equal(clonedProject(r, '/home/sava', [p]), p);
});

test('clonedProject: a path-only match needs home — without it the row still offers clone', () => {
  const p = project({ id: 'p2', name: 'renamed-locally' });
  assert.equal(clonedProject(repo(), null, [p]), null);
});

test('clonedProject: a project elsewhere with a different name is NOT a match', () => {
  const p = project({ id: 'p3', name: 'unrelated', path: '/home/sava/work/unrelated' });
  assert.equal(clonedProject(repo(), '/home/sava', [p]), null);
});

test('clonedProject: the FIRST match in project order wins', () => {
  const byName = project({ id: 'first', name: 'ai-cli-application', path: '/opt/checkout' });
  const byPath = project({ id: 'second', name: 'other' });
  assert.equal(clonedProject(repo(), '/home/sava', [byName, byPath]), byName);
});

test('clonedProject: an OWNER-QUALIFIED project (named `<owner>/<name>`) wins over a bare-name one', () => {
  // GET /user/repos also returns repos you only collaborate on, so one list can
  // hold acme/api AND myorg/api. A user who disambiguates by naming the project
  // `<owner>/<name>` must get THAT project for THAT repo — never the other one.
  const acme = project({ id: 'acme', name: 'acme/api', path: '/home/sava/work/acme-api' });
  const myorg = project({ id: 'myorg', name: 'myorg/api', path: '/home/sava/work/myorg-api' });
  const bare = project({ id: 'bare', name: 'api', path: '/home/sava/projects/api' });
  const acmeRepo = repo({ fullName: 'acme/api', name: 'api', owner: 'acme' });
  const myorgRepo = repo({ fullName: 'myorg/api', name: 'api', owner: 'myorg' });

  assert.equal(clonedProject(acmeRepo, '/home/sava', [bare, acme, myorg]), acme);
  assert.equal(clonedProject(myorgRepo, '/home/sava', [bare, acme, myorg]), myorg);
  assert.equal(
    clonedProject(acmeRepo, null, [bare, acme]),
    acme,
    'owner-qualified matching needs no home',
  );
});

test('clonedProject: the bare-name fallback applies only when NO owner-qualified project exists', () => {
  const bare = project({ id: 'bare', name: 'api', path: '/home/sava/projects/api' });
  const r = repo({ fullName: 'acme/api', name: 'api', owner: 'acme' });
  assert.equal(clonedProject(r, '/home/sava', [bare]), bare, 'no `acme/api` project → fall back');
});

test('two same-basename repos from different owners are BOTH cloneable and each identified correctly', () => {
  // WAS A `KNOWN LIMIT` TEST (pinning the mis-identification recorded as an open
  // decision on 2026-07-24). The user settled it on 2026-07-25 with
  // owner-qualified clone paths, so this is now real behaviour:
  // <home>/projects/<owner>/<repo> per clone, and clonedProject resolves each
  // GitHub row to ITS OWN project — never the other owner's folder.
  const home = '/home/sava';
  const acmeRepo = repo({ fullName: 'acme/api', name: 'api', owner: 'acme' });
  const myorgRepo = repo({ fullName: 'myorg/api', name: 'api', owner: 'myorg' });

  // Before either clone, both rows offer `clone`.
  assert.equal(clonedProject(acmeRepo, home, []), null);
  assert.equal(clonedProject(myorgRepo, home, []), null);

  // Clone #1 (acme/api): destination + registered name exactly as the flow does
  // it — dest = ownerDest, name = repo basename while it is still free.
  const acmeProject: Project = {
    id: 'p-acme',
    name: 'api',
    path: ownerDest(home, 'acme', 'api'),
    createdAt: '2026-07-25T10:00:00.000Z',
  };
  assert.equal(acmeProject.path, '/home/sava/projects/acme/api');
  assert.equal(clonedProject(acmeRepo, home, [acmeProject]), acmeProject, 'acme row → its own clone');
  assert.equal(
    clonedProject(myorgRepo, home, [acmeProject]),
    null,
    'the myorg row must still offer clone — NOT open acme’s folder (the old bug)',
  );

  // Clone #2 (myorg/api): a DIFFERENT directory (no 409), and because the name
  // "api" is now taken the server registers it owner-qualified.
  const myorgProject: Project = {
    id: 'p-myorg',
    name: 'myorg/api',
    path: ownerDest(home, 'myorg', 'api'),
    createdAt: '2026-07-25T10:05:00.000Z',
  };
  assert.notEqual(myorgProject.path, acmeProject.path, 'two directories, so no collision to 409 on');

  const both = [acmeProject, myorgProject];
  assert.equal(clonedProject(acmeRepo, home, both), acmeProject);
  assert.equal(clonedProject(myorgRepo, home, both), myorgProject);
  // Order-independent (the list arrives in GitHub's push order, not ours).
  assert.equal(clonedProject(acmeRepo, home, [...both].reverse()), acmeProject);
  assert.equal(clonedProject(myorgRepo, home, [...both].reverse()), myorgProject);
  // And before $HOME resolves, too.
  assert.equal(clonedProject(acmeRepo, null, both), acmeProject);
  assert.equal(clonedProject(myorgRepo, null, both), myorgProject);
});

test('clonedProject: another owner’s app clone is excluded from the owner-blind tier even when it holds the bare name', () => {
  // The first of two same-basename clones legitimately registers as `api` (the
  // name was free), so the bare-NAME tier would otherwise return it for the
  // OTHER owner's row. Its path says whose it is, and that wins.
  const home = '/home/sava';
  const acme = project({ id: 'p-acme', name: 'api', path: ownerDest(home, 'acme', 'api') });
  const myorgRepo = repo({ fullName: 'myorg/api', name: 'api', owner: 'myorg' });
  assert.equal(clonedProject(myorgRepo, home, [acme]), null, 'offers clone, not acme’s folder');
  // The exclusion is EXACT: only `<home>/projects/<other>/<repo>` is excluded.
  const elsewhere = project({ id: 'p-else', name: 'api', path: '/home/sava/dev/checkouts/api' });
  assert.equal(
    clonedProject(myorgRepo, home, [elsewhere]),
    elsewhere,
    'an ordinary local folder named after the repo still matches by name',
  );
  const deeper = project({ id: 'p-deep', name: 'api', path: ownerDest(home, 'acme', 'api') + '/sub' });
  assert.equal(clonedProject(myorgRepo, home, [deeper]), deeper, 'deeper than our convention → not ours');
});

test('clonedProject: RESIDUAL LIMIT — before $HOME resolves the owner-blind tier is unguarded', () => {
  // The exclusion above compares against <home>/projects, so with home still
  // null a bare-named clone of another owner can satisfy a row for one repaint.
  // github.ts resolves home on tab open and rebuilds the list when it lands, and
  // the server's dest/409 rules are owner-qualified regardless.
  const acme = project({ id: 'p-acme', name: 'api', path: '/home/sava/projects/acme/api' });
  const myorgRepo = repo({ fullName: 'myorg/api', name: 'api', owner: 'myorg' });
  assert.equal(clonedProject(myorgRepo, null, [acme]), acme, 'transient, home-null only');
  assert.equal(clonedProject(myorgRepo, '/home/sava', [acme]), null, 'corrected as soon as home is known');
});

test('clonedProject: a LEGACY bare clone (pre-2026-07-25) is still recognized — existing users keep working', () => {
  // What the flow produced BEFORE owner-qualified paths: name = repo basename at
  // <home>/projects/<repo>. Recognized by the fallback tier, by name and by path.
  const home = '/home/sava';
  const legacy: Project = {
    id: 'p-legacy',
    name: 'api',
    path: defaultDest(home, 'api'),
    createdAt: '2026-07-20T00:00:00.000Z',
  };
  const r = repo({ fullName: 'acme/api', name: 'api', owner: 'acme' });
  assert.equal(clonedProject(r, home, [legacy]), legacy, 'by bare name');
  const renamed: Project = { ...legacy, name: 'renamed after cloning' };
  assert.equal(
    clonedProject(r, home, [renamed]),
    renamed,
    'and by the legacy path even after a local rename',
  );
});

test('clonedProject: RESIDUAL LIMIT — the LEGACY fallback tier is still owner-blind', () => {
  // Unchanged by the 2026-07-25 fix and deliberately still pinned: a Project
  // records no remote (shared/protocol.ts is id/name/path), so a project created
  // BEFORE owner-qualified paths carries no owner evidence at all. A foreign repo
  // whose basename collides with such a project still resolves to it.
  // NEW clones no longer join that set — their path carries the owner.
  const r = repo({ fullName: 'someoneelse/ai-cli-application', owner: 'someoneelse' });
  const legacyBare = project(); // name/path from before the change
  assert.equal(
    clonedProject(r, '/home/sava', [legacyBare]),
    legacyBare,
    'indistinguishable from the pre-change clone of the same basename',
  );
  // The moment the SAME repo is cloned owner-qualified, the ambiguity is gone.
  const owned = project({
    id: 'owned',
    name: 'someoneelse/ai-cli-application',
    path: ownerDest('/home/sava', 'someoneelse', 'ai-cli-application'),
  });
  assert.equal(clonedProject(r, '/home/sava', [legacyBare, owned]), owned);
  assert.equal(
    clonedProject(repo(), '/home/sava', [legacyBare, owned]),
    legacyBare,
    'and sava/ai-cli-application still resolves to the legacy project, not someoneelse’s',
  );
});

// ---------------------------------------------------------------------------
// cloneErrText
// ---------------------------------------------------------------------------

test('cloneErrText: a real server message is preferred over any friendly fallback', () => {
  assert.equal(cloneErrText(409, 'dest exists and is not empty'), 'dest exists and is not empty');
  assert.equal(cloneErrText(502, 'git exited with code 128'), 'git exited with code 128');
  assert.equal(cloneErrText(400, 'cloneUrl host must be github.com'), 'cloneUrl host must be github.com');
});

test('cloneErrText: a bare `HTTP 409` (no body) becomes the folder-exists copy', () => {
  assert.equal(cloneErrText(409, 'HTTP 409'), 'a folder already exists there');
});

test('cloneErrText: a bare `HTTP 502` (no body) becomes the clone-failed copy', () => {
  assert.equal(cloneErrText(502, 'HTTP 502'), 'clone failed');
});

test('cloneErrText: a bare `HTTP 403` (no body) becomes the permission copy — the status the owner-directory mkdir can now fail with', () => {
  assert.equal(cloneErrText(403, 'HTTP 403'), 'no permission to create that folder');
  // A 403 that DOES carry a server message still shows that message verbatim.
  assert.equal(cloneErrText(403, 'permission denied'), 'permission denied');
});

test('cloneErrText: other bare statuses keep the raw `HTTP <n>` (never an invented cause)', () => {
  for (const s of [400, 401, 404, 422, 500]) {
    assert.equal(cloneErrText(s, `HTTP ${s}`), `HTTP ${s}`);
  }
});

test('cloneErrText: the `HTTP <n>` test is status-matched — a mismatched body is a real message', () => {
  assert.equal(cloneErrText(409, 'HTTP 502'), 'HTTP 502', 'body from a different status passes through');
});

// ---------------------------------------------------------------------------
// CROSS-MODULE: the three <home>/projects/<name> call sites must agree
//
// github-model.defaultDest, newproject-model.suggestProjectPath and
// newproject-model.suggestDestPath now share one projectsPath helper, and the
// already-cloned detection above compares a stored project path against
// defaultDest. If any of the three ever drifts, a repo cloned through the URL
// panel stops being recognized in the GitHub list (its row would offer `clone`
// again and the server would answer 409 for the existing folder). Nothing
// asserted that agreement across the two modules before this test.
// ---------------------------------------------------------------------------

test('defaultDest agrees BYTE-FOR-BYTE with both New Project suggestions (one <home>/projects convention)', () => {
  const cases: [string, string][] = [
    ['/home/sava', 'api'],
    ['/home/sava/', 'api'], // trailing slash on home
    ['/', 'api'], // root home
    ['/home/sava', 'name with spaces'],
    ['/home/sava', '.dotted'],
  ];
  for (const [home, name] of cases) {
    const dest = defaultDest(home, name);
    assert.equal(suggestProjectPath(home, name), dest, `blank-project suggestion for ${home} + ${name}`);
    assert.equal(
      suggestDestPath(home, `https://github.com/acme/${name}.git`),
      dest,
      `url-clone suggestion for ${home} + ${name}`,
    );
  }
});

test('a repo cloned through the URL panel is detected in the GitHub list (both flows land on one path)', () => {
  // The URL-clone path the New Project dialog proposes (newproject.ts:283) and
  // the name the server registers for it (server/api.ts: repoNameFromUrl(url)
  // -> the bare basename) — the GitHub list must recognize THAT project.
  const home = '/home/sava';
  const url = 'https://github.com/acme/api.git';
  const urlCloned: Project = {
    id: 'p-url',
    name: repoBasename(url),
    path: suggestDestPath(home, url),
    createdAt: '2026-07-24T00:00:00.000Z',
  };
  assert.equal(urlCloned.path, '/home/sava/projects/api', 'the url flow lands in <home>/projects/<basename>');
  const r = repo({ fullName: 'acme/api', name: 'api', owner: 'acme' });
  assert.equal(clonedProject(r, home, [urlCloned]), urlCloned, 'the row must offer `open`, not a 409 `clone`');
  // And by PATH alone, i.e. even if the project was renamed after cloning.
  const renamed: Project = { ...urlCloned, name: 'my api checkout' };
  assert.equal(clonedProject(r, home, [renamed]), renamed, 'path match survives a local rename');
});
