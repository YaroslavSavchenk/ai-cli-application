/**
 * The pure half of server/github.ts: the injectable seams (FetchLike,
 * SpawnLike), GithubError, and every parser/validator of remote or pasted
 * input — the pasted-token shape check, the scopes and expiry headers, the
 * repo mapping, the github.com owner/repo parsers and the repo filter. No I/O,
 * no credential held.
 *
 * Split from server/github.ts (PLAN-RESTRUCTURE O8, 2026-09-23), moved
 * byte-exact; server/github.ts re-exports all of it. Sibling pieces:
 * server/github.ts (GithubConnection: device flow, pasted token, token store,
 * repos) and server/github-clone.ts (the authenticated clone).
 */
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import type { GithubRepo } from '../shared/protocol.ts';

/**
 * Hard cap on a PASTED token's length. No real GitHub token comes near it;
 * anything longer is a paste accident or an attack, and is refused by RULE —
 * the refusal never quotes the value.
 */
export const MAX_PASTED_TOKEN_LEN = 1024;
/** Bound on the expiry header before parsing it (it is remote input). */
const MAX_EXPIRY_HEADER_LEN = 64;
/** Bound on the scopes header before splitting it (remote input; ~30 scopes exist). */
const MAX_SCOPES_HEADER_LEN = 1024;

/** Injectable fetch seam — defaults to the Node global `fetch`. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Injectable spawn seam — defaults to the Node global `spawn`. Lets tests
 * assert the exact argv + env of an authenticated clone (proving the token is
 * ONLY in the env, never in argv or the url) without running git.
 */
export type SpawnLike = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

/** Carries an HTTP status so the API layer can map it directly (like ScaffoldError). */
export class GithubError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'GithubError';
  }
}

/** Why a pasted token was refused. Both the status and the copy are OURS. */
export interface TokenRejection {
  ok: false;
  /** HTTP status for the API layer: 400 = the token is the problem, 502 = GitHub is. */
  status: number;
  message: string;
}

/**
 * Shape-only validation of a pasted token (III-5). Deliberately NO prefix
 * allowlist: `ghp_`, `github_pat_`, `gho_`, `ghu_`, `ghs_` and legacy 40-hex
 * tokens are all valid today and GitHub is free to mint new shapes tomorrow.
 * Only structural impossibilities are refused, and every message names the RULE
 * and never any part of the value.
 *
 * Leading/trailing whitespace is stripped first — clipboards and terminals add
 * it, and a paste that fails for an invisible reason is a terrible experience.
 * Interior whitespace (including Unicode spaces that survive nothing) and
 * control characters stay fatal: they cannot be part of a credential, and a
 * control character in a header value is a request-splitting primitive.
 * Exported for tests.
 */
export function validatePastedToken(raw: string): { ok: true; token: string } | TokenRejection {
  if (raw.length > MAX_PASTED_TOKEN_LEN) {
    return { ok: false, status: 400, message: `token must be at most ${MAX_PASTED_TOKEN_LEN} characters` };
  }
  const token = raw.trim();
  if (token === '') return { ok: false, status: 400, message: 'token is required' };
  if (token.length > MAX_PASTED_TOKEN_LEN) {
    return { ok: false, status: 400, message: `token must be at most ${MAX_PASTED_TOKEN_LEN} characters` };
  }
  for (let i = 0; i < token.length; i += 1) {
    const c = token.charCodeAt(i);
    // C0 + space + DEL + C1. The regex adds the Unicode spaces (NBSP, thin
    // space, U+FEFF …) a paste can smuggle in the middle of a value.
    if (c <= 0x20 || (c >= 0x7f && c <= 0x9f)) {
      return { ok: false, status: 400, message: 'token must not contain spaces or control characters' };
    }
  }
  if (/\s/u.test(token)) {
    return { ok: false, status: 400, message: 'token must not contain spaces or control characters' };
  }
  return { ok: true, token };
}

/**
 * Split an `x-oauth-scopes` header into scopes. Present-but-empty is a REAL
 * answer (a classic token with no scopes) and maps to `[]`; an absent header is
 * the caller's business and maps to undefined there — never to `[]`, because
 * "GitHub did not report scopes" is not "this token has no permissions".
 * Exported for tests.
 */
export function parseScopesHeader(value: string): string[] {
  if (value.length > MAX_SCOPES_HEADER_LEN) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/**
 * Normalize GitHub's `github-authentication-token-expiration` header (e.g.
 * `2026-12-31 00:00:00 UTC`) to ISO-8601, or undefined when it is absent,
 * over-long or unparseable. Never surface the raw remote string: the protocol
 * says ISO-8601, and an unparseable value is better dropped than rendered.
 * Exported for tests.
 */
export function parseTokenExpiry(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > MAX_EXPIRY_HEADER_LEN) return undefined;
  const ms = Date.parse(trimmed);
  if (Number.isNaN(ms)) return undefined;
  return new Date(ms).toISOString();
}

export function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : undefined;
}

export function readString(o: Record<string, unknown>, key: string): string | undefined {
  const v = o[key];
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/**
 * Map ONE raw GitHub repo object down to the GithubRepo wire shape — dropping
 * everything except the listed fields (no token, no raw payload leaks). Returns
 * undefined when a required field is missing. Exported for unit tests.
 */
export function mapRepo(raw: unknown): GithubRepo | undefined {
  const o = asRecord(raw);
  if (o === undefined) return undefined;
  const fullName = readString(o, 'full_name');
  const name = readString(o, 'name');
  const owner = readString(asRecord(o['owner']) ?? {}, 'login');
  const cloneUrl = readString(o, 'clone_url');
  if (fullName === undefined || name === undefined || owner === undefined || cloneUrl === undefined) {
    return undefined;
  }
  const repo: GithubRepo = {
    fullName,
    name,
    owner,
    private: o['private'] === true,
    cloneUrl,
  };
  const description = readString(o, 'description');
  if (description !== undefined) repo.description = description;
  const language = readString(o, 'language');
  if (language !== undefined) repo.language = language;
  const pushedAt = readString(o, 'pushed_at');
  if (pushedAt !== undefined) repo.pushedAt = pushedAt;
  return repo;
}

/**
 * Owner + repo of a github.com clone url (`https://github.com/<owner>/<repo>`,
 * optional `.git`), or undefined when the url is not exactly that shape.
 *
 * Used for two things only: the ONE-segment owner-directory allowance in
 * cloneAuthenticated (a comparison against an existing path segment) and the
 * `<owner>/<repo>` project-name disambiguation in server/api.ts (a display
 * string in projects.json). Path segments are taken RAW — never
 * percent-decoded — so an escaped separator like `..%2f..%2fetc` stays that
 * literal text instead of becoming `../../etc`; neither use ever builds a path
 * out of these values. Percent-encoded DOT SEGMENTS are a different mechanism:
 * `%2e%2e` and `%2E.` are decoded and removed by the WHATWG URL parser itself
 * before `pathname` is read (`https://github.com/%2e%2e/repo` → `/repo`), as
 * are plain `.`/`..` segments — so the explicit `.`/`..` refusal below is
 * belt-and-braces, not a pinned behaviour.
 *
 * The host lock matches buildAuthenticatedGithubUrl: https, host exactly
 * github.com, NO port and NO embedded credentials. That parity is deliberate —
 * this function is exported, so a future caller must not inherit a laxer rule
 * than the one the credential path enforces. Exported for api.ts and tests.
 */
export function parseGithubRepoPath(cloneUrl: string): { owner: string; repo: string } | undefined {
  let parsed: URL;
  try {
    parsed = new URL(cloneUrl);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com') return undefined;
  if (parsed.port !== '') return undefined;
  if (parsed.username !== '' || parsed.password !== '') return undefined;
  const segments = parsed.pathname.split('/').filter((s) => s !== '');
  if (segments.length !== 2) return undefined;
  const owner = segments[0] as string;
  const repo = (segments[1] as string).replace(/\.git$/i, '');
  for (const s of [owner, repo]) {
    if (s === '' || s === '.' || s === '..') return undefined;
  }
  return { owner, repo };
}

/** Owner / repo characters GitHub itself allows; never a dot segment. */
const GH_SEGMENT_RE = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * Owner + repo of the `origin` URL of a LOCAL repository, for B3's
 * `Open on GitHub` (plan `.claude/plans/nocturne/PLAN-B3.md`, decision D2:
 * github.com only, the button is ABSENT for anything else).
 *
 * The three spellings git writes, and nothing else:
 *   https://github.com/<owner>/<repo>[.git]
 *   [<user>[:<secret>]@]github.com:<owner>/<repo>[.git]        (scp-like ssh)
 *   ssh://[<user>[:<secret>]@]github.com/<owner>/<repo>[.git]
 *
 * HOW THIS DIFFERS FROM parseGithubRepoPath ABOVE, on purpose: that one REFUSES
 * a url carrying credentials, because it guards a path the app then CLONES
 * with the user's own token — a credential in the input there is a sign the
 * input is not what it claims. Here the url is one the USER's repository
 * already contains, and `https://<token>@github.com/o/r` is a perfectly
 * ordinary thing to find in a `.git/config`. Refusing it would only take the
 * button away from the people most likely to want it, so the userinfo is
 * DISCARDED (user decision, 2026-09-21). It is discarded and not returned,
 * logged, echoed or included in any error: the ONLY thing that leaves here is
 * `{ owner, repo }`, two strings matching ^[A-Za-z0-9._-]{1,100}$.
 *
 * A PORT is refused in every form: `github.com:8080` is not github.com's web
 * site, and the page builds `https://github.com/<owner>/<repo>/commit/<hash>`
 * from what this returns. `http:` and `git:` are refused too (no https, no
 * button). Path segments are taken RAW, never percent-decoded, so an escaped
 * separator stays literal text and then fails the pattern.
 *
 * Returns null — not undefined — because the protocol field is `… | null`.
 */
export function parseGithubRemote(url: string): { owner: string; repo: string } | null {
  const trimmed = url.trim();
  if (trimmed === '' || trimmed.length > 2048) return null;

  // scp-like: `[user@]host:path`, which is NOT a URL and must be recognised
  // before `new URL()` sees it (`git@github.com:o/r` parses as scheme `git@`).
  const scp = /^(?:[^/@]*@)?([^/@:]+):(?!\/)(.+)$/.exec(trimmed);
  if (scp !== null) {
    if (!isGithubHost(scp[1] as string)) return null;
    return splitOwnerRepo((scp[2] as string).split('/'));
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'ssh:') return null;
  // NOT `=== 'github.com'`: `ssh:` is a NON-SPECIAL scheme, so the WHATWG URL
  // parser leaves its host EXACTLY as written (measured: `ssh://git@GITHUB.COM/o/r`
  // keeps `hostname === 'GITHUB.COM'`, while `HTTPS://GITHUB.COM/o/r` is
  // lower-cased for us). DNS does not care about case, so neither may this —
  // otherwise a perfectly ordinary `git@GitHub.com:o/r` silently loses the
  // button.
  if (!isGithubHost(parsed.hostname)) return null;
  if (parsed.port !== '') return null;
  return splitOwnerRepo(parsed.pathname.split('/'));
}

/**
 * The host is github.com, compared with ASCII-ONLY case folding.
 *
 * `String.prototype.toLowerCase` folds Unicode too, and that is a door nobody
 * needs here: this compares against a fixed ASCII name, so only ASCII letters
 * may differ in case. Anything else — an IDN homograph, a Kelvin sign, a
 * dotted capital I — stays exactly the character it is and fails.
 */
function isGithubHost(host: string): boolean {
  return host.replace(/[A-Z]/g, (c) => c.toLowerCase()) === 'github.com';
}

/** Exactly two non-empty segments, `.git` off the second, both in the pattern. */
function splitOwnerRepo(rawSegments: readonly string[]): { owner: string; repo: string } | null {
  const segments = rawSegments.filter((s) => s !== '');
  if (segments.length !== 2) return null;
  const owner = segments[0] as string;
  const repo = (segments[1] as string).replace(/\.git$/i, '');
  for (const s of [owner, repo]) {
    if (s === '.' || s === '..' || !GH_SEGMENT_RE.test(s)) return null;
  }
  return { owner, repo };
}

/**
 * Client-side filter on a mapped repo list: case-insensitive substring over
 * name / owner / fullName / description. Empty/absent query -> unchanged.
 * Exported for unit tests.
 */
export function filterRepos(repos: GithubRepo[], query?: string): GithubRepo[] {
  if (query === undefined) return repos;
  const q = query.trim().toLowerCase();
  if (q === '') return repos;
  return repos.filter(
    (r) =>
      r.name.toLowerCase().includes(q) ||
      r.owner.toLowerCase().includes(q) ||
      r.fullName.toLowerCase().includes(q) ||
      (r.description !== undefined && r.description.toLowerCase().includes(q)),
  );
}
