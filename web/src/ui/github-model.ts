/**
 * Pure presentation logic behind the GitHub connection UI (ui/github.ts): the
 * top-bar chip's status→view derivation, the device-code expiry and
 * relative-time formats, the Linguist language-color table, the poll/tick
 * cadence decisions, and the clone-error copy. Deliberately DOM-free — no
 * document, no window, no fetch, no module state — so it stays importable
 * under `node --test`; github.ts remains the sole owner of elements, timers,
 * and the api/state modules.
 *
 * TIME IS INJECTED. Every clock-dependent function takes `now` (ms epoch)
 * from the caller and never reads Date.now() itself — that is what makes the
 * formats deterministic under test.
 *
 * NO TOKEN EVER REACHES HERE. GithubStatus carries no access token by
 * protocol design (it stays server-side); nothing below accepts, derives, or
 * renders credential material.
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
 * while the panel is active AND a configured connection is mid device flow
 * (that is the sole state showing a code).
 */
export function expiryTickMs(active: boolean, status: GithubStatus | null): number | null {
  return active && status?.configured === true && status.state === 'connecting'
    ? GH_EXPIRY_TICK_MS
    : null;
}

// ---------------------------------------------------------------------------
// Top-bar chip
// ---------------------------------------------------------------------------

/**
 * Chip appearance state. `off` is the honest dormant/unknown case (status not
 * yet fetched, or the server has no OAuth client id); the other three mirror
 * GithubStatus.state for a configured server.
 */
export type ChipState = 'off' | 'disconnected' | 'connecting' | 'connected';

export interface ChipView {
  /** Drives the dot modifier class (`is-<state>`), nothing else. */
  state: ChipState;
  /** Visible mono label; may embed the untrusted login → caller uses textContent. */
  label: string;
  /** Accessible name; the chip uses the same string as its tooltip. */
  aria: string;
}

/**
 * What the top-bar chip shows for a status:
 *   not yet fetched          → faint dot + "GitHub"
 *   not configured (dormant) → faint dot + "GitHub", aria says it isn't set up
 *   disconnected             → "Connect GitHub"
 *   connecting               → "connecting…"
 *   connected                → "@login"
 * A missing `login` degrades to an empty name rather than inventing one.
 */
export function chipView(status: GithubStatus | null): ChipView {
  if (status === null) return { state: 'off', label: 'GitHub', aria: 'GitHub' };
  if (!status.configured) {
    return { state: 'off', label: 'GitHub', aria: 'GitHub — not set up on this server' };
  }
  if (status.state === 'connected') {
    const login = status.login ?? '';
    return { state: 'connected', label: `@${login}`, aria: `GitHub — connected as ${login}` };
  }
  if (status.state === 'connecting') {
    return { state: 'connecting', label: 'connecting…', aria: 'GitHub — connecting' };
  }
  return { state: 'disconnected', label: 'Connect GitHub', aria: 'GitHub — connect your account' };
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
