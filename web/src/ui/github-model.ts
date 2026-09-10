/**
 * Pure presentation logic behind the GitHub connection UI (ui/github.ts): the
 * top-bar chip's status→view derivation, the device-code expiry and
 * relative-time formats, the credential copy keyed on `source`, the Linguist
 * language-color table, the poll/tick cadence decisions, and the clone/token
 * error copy. Deliberately DOM-free — no document, no window, no fetch, no
 * module state — so it stays importable under `node --test`; github.ts remains
 * the sole owner of elements, timers, and the api/state modules.
 *
 * TIME IS INJECTED. Every clock-dependent function takes `now` (ms epoch)
 * from the caller and never reads Date.now() itself — that is what makes the
 * formats deterministic under test.
 *
 * NO TOKEN EVER REACHES HERE. GithubStatus carries no access token by
 * protocol design (it stays server-side); nothing below accepts, derives, or
 * renders credential material. The pasted-token path (2026-07-25) adds only
 * DESCRIPTIONS of a credential — its source, whether it was persisted, its
 * expiry, its GitHub-reported scopes — never the credential.
 *
 * COPY HONESTY (design gate, 2026-07-25 — binding): nothing here may claim a
 * keychain, encryption, a vault, or "secure" storage. The verified ceiling in
 * this environment is file permissions plus discipline (no OS keyring exists,
 * and 0600 does not hold against the Windows side of WSL at all —
 * memory/knowledge/wsl-0600-not-a-boundary.md). The strongest permitted
 * sentence is the one `storageNote` returns.
 */
import type { GithubRepo, GithubStatus, Project } from '../../../shared/protocol.ts';
import { joinPath, projectsPath } from './newproject-model.ts';

// ---------------------------------------------------------------------------
// Cadence — the "which interval applies for this state" decisions. The actual
// setInterval/clearInterval (and window) stay in github.ts.
// ---------------------------------------------------------------------------

/** Status poll period while the fast cadence applies. */
export const GH_POLL_MS = 2500;

/** Expiry countdown tick period while a device code is on screen. */
export const GH_EXPIRY_TICK_MS = 1000;

/** Keystroke debounce before the repo-search query is sent. */
export const GH_SEARCH_DEBOUNCE_MS = 300;

/**
 * Status-poll period for the current state, or null for PAUSED. Fast ONLY
 * while the dialog's GitHub tab is open or a device flow is connecting —
 * a disconnected/closed app is never hammered.
 */
export function pollIntervalMs(tabOpen: boolean, status: GithubStatus | null): number | null {
  return tabOpen || status?.state === 'connecting' ? GH_POLL_MS : null;
}

/**
 * Expiry-countdown tick period, or null when no countdown should run: only
 * while the panel is active AND a device flow is in progress (that is the sole
 * state showing a code). `deviceFlowAvailable` is part of the test because a
 * server without an OAuth client id can never start one.
 */
export function expiryTickMs(active: boolean, status: GithubStatus | null): number | null {
  return active && status?.deviceFlowAvailable === true && status.state === 'connecting'
    ? GH_EXPIRY_TICK_MS
    : null;
}

// ---------------------------------------------------------------------------
// Credential source — WHICH of the two paths is connected. Everything the user
// must do differently (above all: where to revoke) branches on this, so it is
// derived in one place and rendered by both the chip and the panel (V-5).
// ---------------------------------------------------------------------------

/** `device` = the OAuth device flow; `pat` = a token the user pasted. */
export type GithubSource = 'device' | 'pat';

/**
 * Narrow mono tag naming the connected credential for the top-bar chip and the
 * connected row. '' when the server did not say (older server / unknown) — an
 * unknown source is left unlabelled rather than guessed, because the revocation
 * instructions differ.
 */
/*
 * NOTE (Nocturne A2, 2026-09-10): the top-bar chip stopped RENDERING this tag
 * — the v3 account chip is an avatar plus a name — and the credential is now
 * named in the chip's accessible name and tooltip instead. The function is
 * kept for the panel work in later parts; if nothing claims it, part A8's
 * janitor pass removes it.
 */
export function sourceTag(source: GithubSource | undefined): string {
  if (source === 'pat') return 'token';
  if (source === 'device') return 'sign-in';
  return '';
}

/** Plain-language name of the connected credential; '' when unknown. */
export function sourceLabel(source: GithubSource | undefined): string {
  if (source === 'pat') return 'pasted token';
  if (source === 'device') return 'signed in with GitHub';
  return '';
}

// ---------------------------------------------------------------------------
// Top-bar chip
// ---------------------------------------------------------------------------

/**
 * Chip appearance state. `off` means "status not yet fetched" — and ONLY that,
 * since 2026-07-25. It used to also cover a server with no OAuth client id, but
 * a pasted token needs no client id, so such a server is a perfectly ordinary
 * `disconnected` that the user can act on.
 */
export type ChipState = 'off' | 'disconnected' | 'connecting' | 'connected';

export interface ChipView {
  /**
   * Which of the four appearances this is. Informational only today: the chip
   * renders no state-dependent class or attribute — `label`, `initial` and
   * `aria` carry everything the user sees. Tests assert on it, and it is what
   * a future state-styled chip would key off.
   */
  state: ChipState;
  /** Visible label; may BE the untrusted login → caller uses textContent. */
  label: string;
  /**
   * One character for the avatar circle: the account's initial, upper-cased,
   * or `G` while there is no account to name. Never a credential — it is a
   * letter of a name the chip already prints in full beside it.
   */
  initial: string;
  /** Accessible name; the chip uses the same string as its tooltip. */
  aria: string;
}

/** The avatar's letter: an account's initial, or `G` when there is no name. */
function chipInitial(login: string | undefined): string {
  const first = (login ?? '').trim().slice(0, 1).toUpperCase();
  return first === '' ? 'G' : first;
}

/**
 * What the top-bar chip shows for a status (Nocturne A2 — the design's own
 * account chip: an avatar circle plus a name):
 *   not yet fetched → "GitHub"
 *   disconnected    → "Connect GitHub"   (whatever deviceFlowAvailable says —
 *                      the paste path is always offered)
 *   connecting      → "Connecting"
 *   connected       → the login, with the credential named in the accessible
 *                      name and tooltip, so the chip still answers "connected
 *                      HOW" as well as "connected as whom" (V-5; disconnecting
 *                      differs per credential).
 * A missing `login` degrades to the neutral "GitHub" rather than inventing a
 * name (and never to an empty chip); its accessible name drops the "as …"
 * clause with it, so nothing ever reads "connected as " with a hole after it.
 */
export function chipView(status: GithubStatus | null): ChipView {
  if (status === null) {
    return { state: 'off', label: 'GitHub', initial: 'G', aria: 'GitHub' };
  }
  if (status.state === 'connected') {
    const login = status.login ?? '';
    const how =
      status.source === 'pat'
        ? ' with a pasted token'
        : status.source === 'device'
          ? ' by signing in with GitHub'
          : '';
    return {
      state: 'connected',
      label: login === '' ? 'GitHub' : login,
      initial: chipInitial(status.login),
      aria: login === '' ? `GitHub — connected${how}` : `GitHub — connected as ${login}${how}`,
    };
  }
  if (status.state === 'connecting') {
    return {
      state: 'connecting',
      label: 'Connecting',
      initial: 'G',
      aria: 'GitHub — connecting',
    };
  }
  return {
    state: 'disconnected',
    label: 'Connect GitHub',
    initial: 'G',
    aria: 'GitHub — connect your account',
  };
}

// ---------------------------------------------------------------------------
// Credential copy — the part the design gate cares most about. Every string
// below is user-visible and is pinned by tests/ui-github-model.test.ts.
// ---------------------------------------------------------------------------

/**
 * The disconnected card's copy, which depends on whether this server can offer
 * the device flow at all. When it cannot, the card must NOT read as dormant:
 * the pasted-token path below it is fully usable and is in fact the reason this
 * path exists (the user has no OAuth App).
 */
export interface DeviceCardCopy {
  /** Sans body under the title. */
  body: string;
  /** Mono fine print about what signing in grants; '' when there is no button. */
  fine: string;
  /** Sans note replacing the button when the server cannot sign in; '' otherwise. */
  note: string;
  /**
   * Heading of the token card below. It is the SECOND path when signing in
   * works and the FIRST when it does not, and it says so.
   */
  tokenTitle: string;
}

export function deviceCardCopy(deviceFlowAvailable: boolean): DeviceCardCopy {
  if (deviceFlowAvailable) {
    return {
      body: 'List your repositories from inside the manager, clone them, and create new ones. Connect by signing in with GitHub, or by pasting a token you create yourself.',
      // "usually does not expire" and not "does not expire": an OAuth App set to
      // expire user authorization tokens hands out 8-hour ones, and this app has
      // no refresh handling — so the absolute would be false on that server.
      fine: 'You sign in once through GitHub. The token is kept server-side, never in the browser. It can read and write every repository on the account, and usually does not expire.',
      note: '',
      tokenTitle: 'Or paste a GitHub token',
    };
  }
  return {
    body: 'List your repositories from inside the manager, clone them, and create new ones.',
    fine: '',
    note: 'Signing in with GitHub is not set up on this server — see the project README. Pasting a token works without it.',
    tokenTitle: 'Paste a GitHub token',
  };
}

/**
 * WHERE the credential is actually revoked — wrong instructions here leave a
 * live credential the user believes is dead, so it branches on the source
 * (design gate IV-3). "Applications" is right for a device-flow grant and WRONG
 * for a pasted token, which lives under Developer settings. Both name screens
 * in GitHub's own UI, which is what makes them actionable.
 */
export function revokeNote(source: GithubSource | undefined): string {
  if (source === 'pat') {
    return 'Disconnect removes the token from this app. To revoke it everywhere, delete it on GitHub under Settings → Developer settings → Personal access tokens.';
  }
  if (source === 'device') {
    return 'Disconnect removes the token from this app. To revoke access everywhere, remove the app on GitHub under Settings → Applications.';
  }
  return 'Disconnect removes the credential from this app. Where to revoke it on GitHub depends on how it was added: a sign-in under Settings → Applications, a pasted token under Settings → Developer settings → Personal access tokens.';
}

/**
 * What storage the user actually got. THE CEILING IS FIXED (design gate II-6):
 * no keychain, no encryption, no "secure", no vault — an auditor verified there
 * is no keyring in this environment and that the file permissions do not hold
 * against the Windows side of WSL. A caption claiming a keychain was shipped
 * and corrected once already in this project; this is the sentence that
 * replaced it. '' when the server did not say.
 */
export function storageNote(persisted: boolean | undefined): string {
  if (persisted === true) {
    return 'Stored on this machine in the app’s data folder, readable by your own user account.';
  }
  if (persisted === false) {
    return 'Kept in this app’s memory only — it is gone when the app closes, and you paste it again next time.';
  }
  return '';
}

/** The same two sentences in the future tense, next to the remember toggle. */
export function rememberNote(remember: boolean): string {
  return remember
    ? 'Stored on this machine in the app’s data folder, readable by your own user account.'
    : 'Kept in this app’s memory only. It disappears when the app closes — about half a minute after the last window — and you paste it again next time.';
}

/** Mono value shown in the toggle row's right-hand sample column. */
export function rememberSample(remember: boolean): string {
  return remember ? 'kept on this machine' : 'until the app closes';
}

/**
 * What GitHub says the credential can do (design gate V-1). Three distinct
 * answers, because the protocol makes three distinct claims:
 *
 *   - ABSENT (`undefined`) — GitHub sent no scopes header, which is what a
 *     FINE-GRAINED token looks like: its permissions are not expressible as
 *     scopes. This is "not reportable", NOT "no permissions", so the honest
 *     render is NOTHING AT ALL. Saying "no permissions" here would be exactly
 *     backwards about the token we recommend.
 *   - EMPTY (`[]`) — a real, reported answer: a classic token carrying no
 *     scopes. Worth saying, and different from the case above.
 *   - a list — shown verbatim so the user sees what they handed over.
 *
 * Scope strings are untrusted → the caller renders via textContent.
 */
export function scopesNote(scopes: string[] | undefined): string | null {
  if (scopes === undefined) return null;
  const list = scopes.filter((s) => s !== '');
  if (list.length === 0) return 'GitHub reports no scopes on this token';
  return `this token can: ${list.join(', ')}`;
}

// ---------------------------------------------------------------------------
// Token expiry (V-4: say it BEFORE it bites)
// ---------------------------------------------------------------------------

/** Inside this window the expiry line turns amber — it needs attention now. */
export const GH_EXPIRY_WARN_MS = 3 * 24 * 60 * 60 * 1000;

export interface ExpiryView {
  text: string;
  /** True when it has expired, or expires within GH_EXPIRY_WARN_MS. */
  warn: boolean;
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

/**
 * Expiry line for a CONNECTED credential (distinct from fmtExpiry, which counts
 * a device code down in MM:SS). Coarse on purpose — a token expiring in a month
 * does not need seconds — and null whenever there is nothing known: an absent or
 * unparseable timestamp renders NO line rather than a guess.
 */
export function fmtTokenExpiry(iso: string | undefined, now: number): ExpiryView | null {
  if (iso === undefined || iso === '') return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  const ms = t - now;
  if (ms <= 0) return { text: 'this token has expired', warn: true };
  const warn = ms < GH_EXPIRY_WARN_MS;
  if (ms < 60_000) return { text: 'expires in under a minute', warn };
  const min = Math.floor(ms / 60_000);
  if (min < 60) return { text: `expires in ${plural(min, 'minute')}`, warn };
  const hr = Math.floor(min / 60);
  if (hr < 48) return { text: `expires in ${plural(hr, 'hour')}`, warn };
  return { text: `expires in ${plural(Math.floor(hr / 24), 'day')}`, warn };
}

// ---------------------------------------------------------------------------
// Time formats (now injected — never read the clock here)
// ---------------------------------------------------------------------------

/**
 * Device-code countdown line for `expiresAt` at `now` (ms epoch):
 * `expires in MM:SS`, or the expired copy once it is due (or unparseable).
 * '' when there is no expiry to show at all.
 */
export function fmtExpiry(iso: string | undefined, now: number): string {
  if (iso === undefined) return '';
  const ms = new Date(iso).getTime() - now;
  if (Number.isNaN(ms) || ms <= 0) return 'code expired — cancel and retry';
  const s = Math.floor(ms / 1000);
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `expires in ${mm}:${ss}`;
}

/**
 * Compact relative time for the repo "pushed …" line, measured from `now`
 * (ms epoch); '' for absent/bad input. Ladder: <60s just now, <60m Nm, <24h
 * Nh, <30d Nd, <12mo Nmo, else Ny (a month is a flat 30 days).
 */
export function relTime(iso: string | undefined, now: number): string {
  if (iso === undefined || iso === '') return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const sec = Math.floor((now - t) / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

// ---------------------------------------------------------------------------
// GitHub Linguist language colors — EXTERNAL DATA (a language's canonical
// color), deliberately NOT app-palette tokens and NOT in tokens.css. Set inline
// on the language dot so it carries real information; an unknown language shows
// NO dot (never an arbitrary hue).
// ---------------------------------------------------------------------------
export const LANG_COLOR: Record<string, string> = {
  TypeScript: '#3178c6',
  JavaScript: '#f1e05a',
  Python: '#3572A5',
  Go: '#00ADD8',
  Rust: '#dea584',
  Java: '#b07219',
  'C++': '#f34b7d',
  C: '#555555',
  'C#': '#178600',
  Ruby: '#701516',
  PHP: '#4F5D95',
  Shell: '#89e051',
  HTML: '#e34c26',
  CSS: '#563d7c',
  Vue: '#41b883',
  Swift: '#F05138',
  Kotlin: '#A97BFF',
  Dart: '#00B4AB',
  Scala: '#c22d40',
  Elixir: '#6e4a7e',
  Lua: '#000080',
  'Objective-C': '#438eff',
  Haskell: '#5e5086',
  Clojure: '#db5855',
  R: '#198CE7',
  Perl: '#0298c3',
  Zig: '#ec915c',
  Nix: '#7e7eff',
};

/**
 * Linguist color for a language, or undefined when it is unknown/absent —
 * the caller then renders NO dot rather than a made-up color.
 */
export function langColor(language: string | undefined): string | undefined {
  if (language === undefined || language === '') return undefined;
  // Own-property only: the table is a plain object literal, so a bare lookup
  // would resolve Object.prototype members (`constructor`, `toString`,
  // `__proto__`, …) to inherited values and paint an invalid inline background.
  if (!Object.hasOwn(LANG_COLOR, language)) return undefined;
  return LANG_COLOR[language];
}

// ---------------------------------------------------------------------------
// Clone destination, already-cloned detection, error copy
// ---------------------------------------------------------------------------

/**
 * LEGACY clone destination — `<home>/projects/<name>` — kept for two jobs only:
 * the already-cloned fallback below (projects registered before owner-qualified
 * paths existed) and the New Project dialog's own URL-clone suggestion, which
 * the user decided stays unchanged. The convention itself lives in
 * newproject-model's projectsPath, so the two can never drift apart.
 *
 * NEW app clones from the GitHub list go through ownerDest instead.
 */
export function defaultDest(home: string, name: string): string {
  return projectsPath(home, name);
}

/**
 * OWNER-QUALIFIED clone destination: `<home>/projects/<owner>/<repo>` (settled
 * 2026-07-25). Every clone the GitHub panel starts lands here, which is what
 * lets `acme/api` and `myorg/api` coexist locally — the collision that used to
 * make the second clone 409 and mis-resolve to the first one's folder. The
 * server creates the missing `<owner>` segment (one level, owner-checked
 * against the clone url).
 */
export function ownerDest(home: string, owner: string, name: string): string {
  return joinPath(projectsPath(home, owner), name);
}

/**
 * True when the absolute `path` ends with the `/<owner>/<name>` segment pair
 * (trailing slashes ignored). Segment-exact: `/…/myorg/api` never matches
 * `/…/acme/api`, and `/…/notacme/api` never matches `/…/acme/api` either,
 * because the comparison is per SEGMENT, and the pair must have something
 * before it.
 *
 * The OWNER segment compares case-insensitively, matching the server, which
 * accepts an owner directory that differs from the url's owner only in case
 * (server/github.ts step 3b). Without that parity a folder the server would
 * refuse to clone into again (409) could still be shown as `clone` here. The
 * repo segment stays exact — it is a filesystem name on a case-sensitive fs,
 * and the server's own vacancy check is exact too.
 */
function endsWithOwnerRepo(path: string, owner: string, name: string): boolean {
  if (owner === '' || name === '') return false;
  const parts = path.replace(/\/+$/, '').split('/');
  if (parts.length < 3) return false;
  const ownerSeg = parts[parts.length - 2] as string;
  return parts[parts.length - 1] === name && ownerSeg.toLowerCase() === owner.toLowerCase();
}

/**
 * The owner segment when `path` is one of OUR OWN owner-qualified clone
 * destinations for repo `name` — i.e. exactly `<home>/projects/<owner>/<name>`
 * (ownerDest, nothing deeper, nothing shallower) — else null.
 *
 * This is positive, self-created evidence of which owner a local folder belongs
 * to, and it is what stops the owner-blind fallback tier from handing
 * `<home>/projects/acme/api` to the `myorg/api` row: without this check, the
 * FIRST of two same-basename clones (registered under the bare name `api`, which
 * was free) would still be returned for the SECOND row by name alone — the exact
 * mis-identification the owner-qualified paths exist to remove.
 */
function ourCloneOwner(path: string, home: string, name: string): string | null {
  const prefix = `${joinPath(home, 'projects')}/`;
  const trimmed = path.replace(/\/+$/, '');
  if (!trimmed.startsWith(prefix)) return null;
  const parts = trimmed.slice(prefix.length).split('/');
  if (parts.length !== 2) return null;
  const owner = parts[0] as string;
  if (owner === '' || parts[1] !== name) return null;
  return owner;
}

/**
 * The local Project a repo already maps to, or null.
 *
 * `GET /user/repos` also returns repos you merely collaborate on, so one list
 * legitimately holds `acme/api` AND `myorg/api`. Matching therefore runs
 * owner-aware first and only then falls back to owner-blind evidence:
 *
 *   1. PATH TAIL `<owner>/<repo>` — where every app clone lands since
 *      2026-07-25 (ownerDest). Also matches a hand-placed checkout that follows
 *      the same convention (e.g. `/srv/src/acme/api`). Owner-exact, so the two
 *      `api` rows above resolve to different projects. Needs no `home`.
 *   2. NAME === `<owner>/<repo>` (repo.fullName) — a project the user named that
 *      way by hand, or one our own clone registered that way because the bare
 *      basename was already taken (server/api.ts). Also needs no `home`.
 *   3. LEGACY, owner-blind: bare NAME, or the legacy clone path
 *      `<home>/projects/<repo.name>` (defaultDest) — the pair our clone flow
 *      created BEFORE owner-qualified paths, plus what the URL-clone tab still
 *      creates today. Path-match needs `home`; name-match does not. Projects
 *      that ARE one of our owner-qualified clones under a DIFFERENT owner
 *      (ourCloneOwner) are excluded from this tier — they carry their owner in
 *      their path, so they belong to that owner's row only.
 *
 * RESIDUAL LIMITS, pinned by tests rather than hidden:
 *   - step 3 cannot attribute a bare-named legacy project to an owner (a Project
 *     records no remote — shared/protocol.ts holds id/name/path only). So a
 *     foreign repo whose basename collides with a PRE-EXISTING bare-named
 *     project still resolves to it. New clones no longer add to that set: they
 *     carry the owner in their path.
 *   - the ourCloneOwner exclusion needs `home`, so in the brief window before
 *     $HOME resolves a bare-named clone of ANOTHER owner can still satisfy a row
 *     by name. github.ts resolves home on tab open and rebuilds the list when it
 *     lands, and the server-side dest/409 rules are owner-qualified regardless,
 *     so the worst case is a stale `open` button for one repaint.
 */
export function clonedProject(r: GithubRepo, home: string | null, projects: Project[]): Project | null {
  for (const p of projects) {
    if (endsWithOwnerRepo(p.path, r.owner, r.name)) return p;
  }
  for (const p of projects) {
    if (p.name === r.fullName) return p;
  }
  const legacyDest = home !== null ? defaultDest(home, r.name) : null;
  for (const p of projects) {
    // Another owner's app clone is NOT this repo, whatever it is named.
    if (home !== null) {
      const owner = ourCloneOwner(p.path, home, r.name);
      // Case-insensitive, like the server's owner comparison (step 3b).
      if (owner !== null && owner.toLowerCase() !== r.owner.toLowerCase()) continue;
    }
    if (p.name === r.name) return p;
    if (legacyDest !== null && p.path === legacyDest) return p;
  }
  return null;
}

/**
 * Honest clone-error copy for an API failure: prefer the server's real message;
 * fall back to friendly text only for a bare `HTTP <status>` (no body). 403 =
 * the folder could not be created there (the server hit EACCES/EPERM making the
 * owner directory); 409 = a non-empty destination already exists; 502 = the git
 * clone itself failed. Plain language, no paths, no error codes — the copy rule
 * applies here too.
 */
export function cloneErrText(status: number, message: string): string {
  if (message !== `HTTP ${status}`) return message;
  if (status === 403) return 'no permission to create that folder';
  if (status === 409) return 'a folder already exists there';
  if (status === 502) return 'clone failed';
  return message;
}

/**
 * Honest copy for a failed "add token" (POST /api/github/token), same shape as
 * cloneErrText: the server's real message wins, and it usually has one — it
 * answers 400 for a token GitHub rejected or refused and 502 when GitHub could
 * not be reached, each with its own sentence. The two fallbacks below only
 * cover a bodyless response, and mirror those two documented meanings.
 *
 * NOTHING here describes the token itself — not its length, not its prefix, not
 * whether it "looks like" a token (a format allowlist was refused by the design
 * gate; the server validates shape only and lets GitHub decide the rest).
 */
export function tokenErrText(status: number, message: string): string {
  if (message !== `HTTP ${status}`) return message;
  if (status === 400) return 'GitHub did not accept that token';
  if (status === 502) return 'could not reach GitHub';
  return message;
}
