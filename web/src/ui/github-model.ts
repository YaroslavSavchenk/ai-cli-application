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
import { projectsPath } from './newproject-model.ts';

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
 * Default clone destination for a repo: `<home>/projects/<repo.name>`. The
 * convention itself lives in newproject-model's projectsPath — the same one the
 * New Project dialog suggests — so a clone destination and the path matched by
 * clonedProject below can never drift apart.
 */
export function defaultDest(home: string, name: string): string {
  return projectsPath(home, name);
}

/**
 * The local Project a repo already maps to, or null.
 *
 * OWNER-QUALIFIED FIRST: `GET /user/repos` also returns repos you merely
 * collaborate on, so one list legitimately holds `acme/api` AND `myorg/api`. A
 * project explicitly named `<owner>/<name>` (repo.fullName) is therefore matched
 * before anything else, so a user who disambiguates that way gets the right
 * project per row instead of both rows resolving to the same folder.
 *
 * Only when no owner-qualified project exists does the loose fallback apply:
 * bare NAME, or the default clone path (`<home>/projects/<repo.name>`) — the
 * exact pair our own clone flow creates (name = repo.name, path = defaultDest).
 * Path-match needs `home`; name-match works without it, so detection is live
 * before home resolves.
 *
 * KNOWN LIMIT, not an oversight: a Project records no remote (id/name/path only
 * — shared/protocol.ts), so a bare-named local folder cannot be attributed to an
 * owner. Two same-basename repos with no owner-qualified project both fall back
 * to the same local project.
 */
export function clonedProject(r: GithubRepo, home: string | null, projects: Project[]): Project | null {
  for (const p of projects) {
    if (p.name === r.fullName) return p;
  }
  const dest = home !== null ? defaultDest(home, r.name) : null;
  for (const p of projects) {
    if (p.name === r.name) return p;
    if (dest !== null && p.path === dest) return p;
  }
  return null;
}

/**
 * Honest clone-error copy for an API failure: prefer the server's real message;
 * fall back to friendly text only for a bare `HTTP <status>` (no body). 409 =
 * a non-empty destination already exists; 502 = the git clone itself failed.
 */
export function cloneErrText(status: number, message: string): string {
  if (message !== `HTTP ${status}`) return message;
  if (status === 409) return 'a folder already exists there';
  if (status === 502) return 'clone failed';
  return message;
}
