/**
 * IN-APP UPDATE, part 1 — "is there a newer release?" (phase E, 2026-09-09).
 *
 * Decided in `memory/decisions/in-app-update.md` (user: a notification and ONE
 * button, like other apps). This module owns the ONLINE half of the update
 * signal: one anonymous GET to `api.github.com/repos/<owner>/<repo>/releases/
 * latest`, at boot and every six hours, ETag-cached, rate-limit aware, and
 * silent on every failure. Its answer feeds `GET /api/runtime`'s `update`
 * member as `{ available: true, reason: 'a new version is available', release }`
 * — and the INSTALLED-ON-DISK signal from server/bundle.ts always wins over it
 * (a bundle that is already unpacked is one restart away; a release is not).
 *
 * WHERE IT DOES NOT RUN. Installed mode only, and only when the bundle version
 * is a real release: a developer clone has no `bundle.json`, and a
 * `0.0.0-dev+<sha>` bundle (an off-tag CI build) disables the check entirely.
 * A dev checkout therefore makes ZERO outbound requests, which is the promise
 * PROJECT-SCOPE makes about this app.
 *
 * SECURITY, in the order it matters:
 *   - NO CREDENTIAL EVER. No Authorization header, no cookies, no token — this
 *     is public release metadata and the GitHub credential store (github.ts) is
 *     unreachable from here by construction.
 *   - `redirect: 'error'`, a 15 s abort, and a 1 MiB body cap read as BYTES
 *     before `JSON.parse` ever sees them: a redirecting or hostile upstream can
 *     neither steer this request nor make it allocate.
 *   - Everything the answer contains is UNTRUSTED. The asset URLs we hand on
 *     are CONSTRUCTED by us from the tag and then required to be EQUAL to what
 *     the API reported; a URL that differs is a refusal, not a download. The
 *     tag itself passes bundle.ts's VERSION_SHAPE before it is used in a path.
 *   - The `AI_SM_UPDATE_API_BASE` seam is loopback-only (server/config.ts) and
 *     the process refuses to start otherwise; with the seam set, the asset host
 *     allow-list collapses to exactly that origin, so an offline test can never
 *     accidentally leave the machine.
 *   - Logging says hosts, states, versions and sizes. Remote text (a tag, a
 *     name, an error body) is never logged unless it passed a shape gate, and
 *     always through `oneLine()`.
 */
import { readFileSync, unlinkSync } from 'node:fs';
import type { UpdateRelease, UpdateStatus } from '../shared/protocol.ts';
import { UPDATE_NEW_VERSION_AVAILABLE } from '../shared/protocol.ts';
import { VERSION_SHAPE } from './bundle.ts';
import {
  atomicWriteFile,
  errorClass,
  oneLine,
  scoped,
  DEFAULT_UPDATE_API_BASE,
  DEFAULT_UPDATE_ASSET_BASE,
  type Logger,
} from './config.ts';

/** The repository releases are published to. Owner/name, not a URL. */
export const UPDATE_OWNER = 'YaroslavSavchenk';
export const UPDATE_REPO = 'ai-cli-application';

/** The checksums asset every release carries (.github/workflows/release.yml). */
export const SUMS_ASSET_NAME = 'SHA256SUMS.txt';

/** The Setup asset name for a tag — CONSTRUCTED here, never read from the API. */
export function setupAssetName(tag: string): string {
  return `AI-Session-Manager-Setup-${tag}.exe`;
}

/** `<assetBase>/<owner>/<repo>/releases/download/<tag>/<name>` — our construction. */
export function assetUrl(assetBase: string, tag: string, name: string): string {
  return `${assetBase}/${UPDATE_OWNER}/${UPDATE_REPO}/releases/download/${tag}/${name}`;
}

/** Path appended to the API base. */
export const LATEST_RELEASE_PATH = `/repos/${UPDATE_OWNER}/${UPDATE_REPO}/releases/latest`;

/** Per-request hard timeout, as in github.ts. */
export const CHECK_TIMEOUT_MS = 15_000;
/** Body cap on the API answer, enforced while reading, not after. */
export const MAX_RELEASE_BODY_BYTES = 1024 * 1024;
/** A Setup larger than this is not one of ours (the real one is ~5 MiB). */
export const MAX_SETUP_BYTES = 200 * 1024 * 1024;
/** First check after `listen` — WSL often has no network the instant Windows boots. */
export const FIRST_CHECK_MS = 20_000;
/** Steady-state cadence. */
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** After a failure: three short retries before falling back to the normal cadence. */
export const BACKOFF_MS = 15 * 60 * 1000;
export const MAX_BACKOFFS = 3;
/** Bounds on any server-supplied wait (`x-ratelimit-reset`, `retry-after`). */
export const MIN_RATE_LIMIT_WAIT_MS = 60_000;
export const MAX_RATE_LIMIT_WAIT_MS = 24 * 60 * 60 * 1000;
/** Cap on the persisted ETag cache file. */
export const MAX_CACHE_BYTES = 8 * 1024;

/** Every request MUST carry a User-Agent (same value as github.ts). */
const USER_AGENT = 'ai-cli-session-manager';

/** An ETag is remote text that goes back out in a header: gate its charset. */
const ETAG_SHAPE = /^(?:W\/)?"[\x21\x23-\x7e]{1,128}"$/;
const ISO_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

// ---------------------------------------------------------------------------
// Version comparison — pure, exported, table-tested (tests/update-version.test.ts)
// ---------------------------------------------------------------------------

/**
 * `major.minor.patch` with optional pre-release and build metadata, and at most
 * ONE leading `v`. Deliberately stricter than VERSION_SHAPE: that one gates a
 * string for use in a path, this one is arithmetic.
 */
const SEMVER_SHAPE =
  /^v?(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:-([0-9A-Za-z.-]{1,64}))?(?:\+([0-9A-Za-z.-]{1,64}))?$/;

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  /** Dot-separated pre-release identifiers; empty array = a final release. */
  pre: string[];
}

/** Parse a version, or null when it is not one. Build metadata is DISCARDED. */
export function parseVersion(value: string): ParsedVersion | null {
  if (typeof value !== 'string') return null;
  const m = SEMVER_SHAPE.exec(value);
  if (m === null) return null;
  const pre = m[4] === undefined ? [] : m[4].split('.');
  // `1.0.0-` and `1.0.0-a..b` are not versions; an empty identifier has no order.
  if (pre.some((id) => id === '')) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre,
  };
}

/** Numeric identifiers are all digits with no leading zero (semver §11). */
const NUMERIC_ID = /^(?:0|[1-9]\d*)$/;

function comparePre(a: string[], b: string[]): number {
  // A version WITHOUT a pre-release outranks one with it.
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const x = a[i];
    const y = b[i];
    // A larger set of identifiers wins when all the preceding ones are equal.
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = NUMERIC_ID.test(x);
    const yn = NUMERIC_ID.test(y);
    if (xn && yn) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d < 0 ? -1 : 1;
      continue;
    }
    // Numeric identifiers always have lower precedence than alphanumeric ones.
    if (xn !== yn) return xn ? -1 : 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * -1 / 0 / 1 for a < b, a === b, a > b; NULL when either side is not a version.
 *
 * Build metadata is ignored (semver §10), so `v1.0.0+a` and `v1.0.0+b` compare
 * equal — which is exactly what "do not offer a rebuild of what I run" means.
 */
export function compareVersions(a: string, b: string): number | null {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (pa === null || pb === null) return null;
  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;
  return comparePre(pa.pre, pb.pre);
}

/** True only when `candidate` is PROVABLY newer than `current`. */
export function isNewerVersion(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) === 1;
}

/**
 * May THIS build ask about releases at all?
 *
 * No for anything unparsable, and no for `0.0.0*` — the version
 * `scripts/build-bundle.sh` stamps on an off-tag build (`0.0.0-dev+<sha>`).
 * Such a bundle is older than every real release, so an enabled check would
 * nag a developer's own build forever with an update it must not install.
 */
export function releaseCheckSupported(version: string): boolean {
  const parsed = parseVersion(version);
  if (parsed === null) return false;
  return !(parsed.major === 0 && parsed.minor === 0 && parsed.patch === 0);
}

// ---------------------------------------------------------------------------
// The release gate — every field of an UNTRUSTED API answer
// ---------------------------------------------------------------------------

/** Why a release was not offered. A CONSTANT-ish sentence for server.log only. */
export type ReleaseRejection = string;

export interface GateOptions {
  /** The version this process runs (`bundle.json.version`). */
  currentVersion: string;
  /** Origin release assets may be downloaded from (github.com, or the seam). */
  assetBase: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Turn a `releases/latest` payload into an UpdateRelease, or into a reason it
 * was refused. NOTHING here trusts the answer:
 *
 *   - `draft` and `prerelease` must both be exactly `false`;
 *   - the tag must pass VERSION_SHAPE (it becomes a path segment and a log
 *     line) AND be strictly newer than the running version;
 *   - the Setup asset name is CONSTRUCTED from the tag and must exist in the
 *     asset list with `state: 'uploaded'`;
 *   - `SHA256SUMS.txt` must exist, uploaded, too;
 *   - both `browser_download_url`s must EQUAL the URL we construct — a release
 *     that points its assets somewhere else is not one we install;
 *   - the Setup size must be a positive integer <= 200 MiB.
 */
export function gateRelease(
  payload: unknown,
  opts: GateOptions,
): { ok: true; release: UpdateRelease } | { ok: false; why: ReleaseRejection } {
  if (!isRecord(payload)) return { ok: false, why: 'the answer was not a JSON object' };
  if (payload['draft'] !== false) return { ok: false, why: 'the release is a draft' };
  if (payload['prerelease'] !== false) return { ok: false, why: 'the release is a pre-release' };
  const tag = payload['tag_name'];
  if (typeof tag !== 'string' || !VERSION_SHAPE.test(tag)) {
    return { ok: false, why: 'the release tag is missing or not a version' };
  }
  if (!isNewerVersion(tag, opts.currentVersion)) {
    return { ok: false, why: `${oneLine(tag)} is not newer than ${oneLine(opts.currentVersion)}` };
  }
  const assets = payload['assets'];
  if (!Array.isArray(assets) || assets.length > 100) {
    return { ok: false, why: 'the release has no usable asset list' };
  }
  const setupName = setupAssetName(tag);
  const find = (name: string): Record<string, unknown> | undefined => {
    for (const entry of assets) {
      if (isRecord(entry) && entry['name'] === name) return entry;
    }
    return undefined;
  };
  const setup = find(setupName);
  if (setup === undefined) return { ok: false, why: 'the release has no Setup asset for its tag' };
  if (setup['state'] !== 'uploaded') return { ok: false, why: 'the Setup asset is not uploaded' };
  const setupUrl = assetUrl(opts.assetBase, tag, setupName);
  if (setup['browser_download_url'] !== setupUrl) {
    return { ok: false, why: 'the Setup asset url is not the one we construct' };
  }
  const size = setup['size'];
  if (typeof size !== 'number' || !Number.isInteger(size) || size <= 0 || size > MAX_SETUP_BYTES) {
    return { ok: false, why: 'the Setup asset size is missing or out of range' };
  }
  const sums = find(SUMS_ASSET_NAME);
  if (sums === undefined) return { ok: false, why: `the release has no ${SUMS_ASSET_NAME}` };
  if (sums['state'] !== 'uploaded') return { ok: false, why: `${SUMS_ASSET_NAME} is not uploaded` };
  const sumsUrl = assetUrl(opts.assetBase, tag, SUMS_ASSET_NAME);
  if (sums['browser_download_url'] !== sumsUrl) {
    return { ok: false, why: `the ${SUMS_ASSET_NAME} url is not the one we construct` };
  }
  return { ok: true, release: { version: tag, setupName, setupUrl, sumsUrl, size } };
}

// ---------------------------------------------------------------------------
// The ETag cache — <dataDir>/update-check.json
// ---------------------------------------------------------------------------

/**
 * What is persisted between runs. `release` is the LAST OFFER (null when the
 * latest release was not newer): a 304 costs no rate-limit quota, so after a
 * restart the notice is on screen at the first check instead of never.
 */
export interface UpdateCheckCache {
  etag: string;
  /** ISO-8601 of the last successful (200 or 304) answer. */
  checkedAt: string;
  release: UpdateRelease | null;
}

/**
 * Read the cache, or null. UNTRUSTED DISK CONTENT — the same all-or-nothing
 * charset gating as `bundle.json`: an oversized, unparsable or partially
 * invalid file is simply "no cache", never a half-trusted object. The URLs are
 * re-CONSTRUCTED and compared rather than believed, so a doctored file cannot
 * point the downloader anywhere.
 */
export function readUpdateCheckCache(file: string, opts: GateOptions): UpdateCheckCache | null {
  let raw: Buffer;
  try {
    raw = readFileSync(file);
  } catch {
    return null;
  }
  if (raw.length > MAX_CACHE_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const etag = parsed['etag'];
  if (typeof etag !== 'string' || !ETAG_SHAPE.test(etag)) return null;
  const checkedAt = parsed['checkedAt'];
  if (typeof checkedAt !== 'string' || !ISO_SHAPE.test(checkedAt)) return null;
  if (Number.isNaN(Date.parse(checkedAt))) return null;
  const release = parsed['release'];
  if (release === null) return { etag, checkedAt, release: null };
  if (!isRecord(release)) return null;
  const version = release['version'];
  if (typeof version !== 'string' || !VERSION_SHAPE.test(version)) return null;
  // The cached offer must STILL be newer than what we run: after an update the
  // file describes the version now installed, and re-offering it would nag.
  if (!isNewerVersion(version, opts.currentVersion)) return { etag, checkedAt, release: null };
  const setupName = setupAssetName(version);
  if (release['setupName'] !== setupName) return null;
  if (release['setupUrl'] !== assetUrl(opts.assetBase, version, setupName)) return null;
  if (release['sumsUrl'] !== assetUrl(opts.assetBase, version, SUMS_ASSET_NAME)) return null;
  const size = release['size'];
  if (typeof size !== 'number' || !Number.isInteger(size) || size <= 0 || size > MAX_SETUP_BYTES) {
    return null;
  }
  return {
    etag,
    checkedAt,
    release: {
      version,
      setupName,
      setupUrl: release['setupUrl'] as string,
      sumsUrl: release['sumsUrl'] as string,
      size,
    },
  };
}

/** Write the cache atomically, 0600. Best effort: a failure only costs quota. */
export function writeUpdateCheckCache(file: string, cache: UpdateCheckCache): void {
  const text = JSON.stringify(cache);
  if (Buffer.byteLength(text) > MAX_CACHE_BYTES) return;
  atomicWriteFile(file, `${text}\n`);
}

// ---------------------------------------------------------------------------
// The checker
// ---------------------------------------------------------------------------

export interface ReleaseCheckerOptions {
  /** `bundle.json.version` of the running process. */
  currentVersion: string;
  /** REST base — `resolveUpdateApiBase()`. */
  apiBase: string;
  /** `<dataDir>/update-check.json`. */
  cacheFile: string;
  log: Logger;
  /** Test seams. */
  fetchImpl?: FetchLike;
  now?: () => number;
  firstCheckMs?: number;
  intervalMs?: number;
}

export interface ReleaseChecker {
  /** The SYNCHRONOUS answer for GET /api/runtime; nothing here ever blocks. */
  status(): UpdateStatus;
  /** The offer itself (POST /api/update needs the urls + size). */
  release(): UpdateRelease | undefined;
  /** Run one check now. Never rejects — a failure is a log line. */
  checkNow(): Promise<void>;
  /** Arm the schedule (called from the `listening` handler). */
  start(): void;
  /** Cancel the timer. */
  stop(): void;
}

const NO_UPDATE: UpdateStatus = { available: false, reason: null };

/**
 * Clamp a server-supplied wait into something sane. Remote input decides how
 * long we sleep, so it decides inside 1 minute … 24 hours and nowhere else.
 */
function clampWait(ms: number): number {
  if (!Number.isFinite(ms)) return MIN_RATE_LIMIT_WAIT_MS;
  return Math.min(MAX_RATE_LIMIT_WAIT_MS, Math.max(MIN_RATE_LIMIT_WAIT_MS, Math.round(ms)));
}

/** A bounded integer from a response header, or undefined. */
function headerInt(res: Response, name: string): number | undefined {
  const raw = res.headers.get(name);
  if (raw === null || raw.length > 20 || !/^\d{1,19}$/.test(raw.trim())) return undefined;
  const value = Number(raw.trim());
  return Number.isSafeInteger(value) ? value : undefined;
}

/**
 * Read at most `cap` bytes of a response body. The cap is enforced WHILE
 * reading — `res.text()` would have allocated the whole thing first — and a
 * body that exceeds it is an error, never a truncated parse.
 */
export async function readCappedText(res: Response, cap: number): Promise<string> {
  const body = res.body;
  if (body === null) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > cap) throw new Error(`body exceeds ${cap} bytes`);
      chunks.push(value);
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Already closed.
    }
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

/**
 * Build the periodic release checker.
 *
 * The caller decides WHETHER to build one at all (installed mode +
 * `releaseCheckSupported`), so nothing here has to know about bundles.
 */
export function createReleaseChecker(opts: ReleaseCheckerOptions): ReleaseChecker {
  const log = scoped(opts.log, 'update');
  const doFetch = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  const now = opts.now ?? ((): number => Date.now());
  const firstCheckMs = opts.firstCheckMs ?? FIRST_CHECK_MS;
  const intervalMs = opts.intervalMs ?? CHECK_INTERVAL_MS;
  const assetBase =
    opts.apiBase === DEFAULT_UPDATE_API_BASE ? DEFAULT_UPDATE_ASSET_BASE : opts.apiBase;
  const gateOpts: GateOptions = { currentVersion: opts.currentVersion, assetBase };

  // Adopt the persisted answer immediately: the notice is on screen before the
  // first request, and the ETag makes that request cost no quota.
  const cached = readUpdateCheckCache(opts.cacheFile, gateOpts);
  let etag: string | undefined = cached?.etag;
  let offer: UpdateRelease | undefined = cached?.release ?? undefined;
  if (cached !== null) {
    log(
      'debug',
      `release cache adopted (checked ${oneLine(cached.checkedAt)}, offer ${
        cached.release === null ? 'none' : oneLine(cached.release.version)
      })`,
    );
  }

  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let running = false;
  let failures = 0;
  /** Set by a 403/429: nothing is asked before this instant. */
  let notBeforeMs = 0;

  const persist = (release: UpdateRelease | null): void => {
    if (etag === undefined) {
      // No usable validator: the file could only hold a stale OFFER with an old
      // etag, and a stale offer survives restarts as a notice for a release
      // that may be gone. Drop it instead.
      try {
        unlinkSync(opts.cacheFile);
      } catch {
        // Absent — the normal case.
      }
      return;
    }
    try {
      writeUpdateCheckCache(opts.cacheFile, {
        etag,
        checkedAt: new Date(now()).toISOString(),
        release,
      });
    } catch (err) {
      // A cache we cannot write only costs rate-limit quota. Class only: the
      // message of an fs error carries a path we already know.
      log('warn', `could not write the release cache: ${errorClass(err)}`);
    }
  };

  const arm = (delayMs: number): void => {
    if (stopped) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      void run();
    }, delayMs);
    // A presence-bound backend must never be kept alive by an update timer.
    if (typeof timer.unref === 'function') timer.unref();
  };

  /** One check. Resolves always; the outcome is a log line and the next delay. */
  const run = async (): Promise<void> => {
    if (running) return;
    running = true;
    let nextMs = intervalMs;
    try {
      const wait = notBeforeMs - now();
      if (wait > 0) {
        // A rate-limit window is still open: wait it out, ask nothing.
        nextMs = wait;
        return;
      }
      const url = `${opts.apiBase}${LATEST_RELEASE_PATH}`;
      const headers: Record<string, string> = {
        Accept: 'application/vnd.github+json',
        'User-Agent': USER_AGENT,
        'X-GitHub-Api-Version': '2022-11-28',
      };
      // NO Authorization header, ever: this is public metadata, and the GitHub
      // credential must not travel to a seam-pointed origin.
      if (etag !== undefined) headers['If-None-Match'] = etag;
      let res: Response;
      try {
        res = await doFetch(url, {
          method: 'GET',
          headers,
          redirect: 'error',
          signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
        });
      } catch (err) {
        failures += 1;
        nextMs = failures <= MAX_BACKOFFS ? BACKOFF_MS : intervalMs;
        log('debug', `release check failed (${errorClass(err)}); retrying in ${nextMs}ms`);
        return;
      }

      if (res.status === 304) {
        failures = 0;
        log('debug', `release check: 304 not modified (offer ${offer?.version ?? 'none'})`);
        persist(offer ?? null);
        return;
      }

      if (res.status === 403 || res.status === 429) {
        const remaining = headerInt(res, 'x-ratelimit-remaining');
        const reset = headerInt(res, 'x-ratelimit-reset');
        const retryAfter = headerInt(res, 'retry-after');
        const waitMs =
          retryAfter !== undefined
            ? clampWait(retryAfter * 1000)
            : reset !== undefined
              ? clampWait(reset * 1000 - now())
              : MAX_RATE_LIMIT_WAIT_MS;
        notBeforeMs = now() + waitMs;
        nextMs = waitMs;
        // ONE warn, never a nag: the next attempt is silent until the window ends.
        log(
          'warn',
          `release check rate limited (HTTP ${res.status}, remaining ${
            remaining ?? 'unknown'
          }); not asking again for ${waitMs}ms`,
        );
        return;
      }

      if (res.status !== 200) {
        failures += 1;
        nextMs = failures <= MAX_BACKOFFS ? BACKOFF_MS : intervalMs;
        log('debug', `release check: HTTP ${res.status}; retrying in ${nextMs}ms`);
        return;
      }

      let payload: unknown;
      try {
        payload = JSON.parse(await readCappedText(res, MAX_RELEASE_BODY_BYTES));
      } catch (err) {
        failures += 1;
        nextMs = failures <= MAX_BACKOFFS ? BACKOFF_MS : intervalMs;
        // errorClass only: a JSON.parse message quotes the body.
        log('warn', `release check: unusable answer (${errorClass(err)})`);
        return;
      }
      failures = 0;
      const newEtag = res.headers.get('etag');
      etag = newEtag !== null && ETAG_SHAPE.test(newEtag) ? newEtag : undefined;

      const gated = gateRelease(payload, gateOpts);
      if (!gated.ok) {
        offer = undefined;
        log('debug', `release check: nothing to offer (${gated.why})`);
        persist(null);
        return;
      }
      offer = gated.release;
      log(
        'info',
        `release check: ${gated.release.version} is newer than ${oneLine(opts.currentVersion)} ` +
          `(${gated.release.setupName}, ${gated.release.size} bytes)`,
      );
      persist(gated.release);
    } finally {
      running = false;
      arm(nextMs);
    }
  };

  return {
    status: () =>
      offer === undefined
        ? NO_UPDATE
        : { available: true, reason: UPDATE_NEW_VERSION_AVAILABLE, release: offer },
    release: () => offer,
    checkNow: run,
    start: () => {
      stopped = false;
      log(
        'info',
        `release check enabled for ${oneLine(opts.currentVersion)} against ${opts.apiBase} ` +
          `(first in ${firstCheckMs}ms, then every ${intervalMs}ms)`,
      );
      arm(firstCheckMs);
    },
    stop: () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}

/**
 * The COMPOSITION the scope bullet pins: installed-on-disk beats
 * available-online. A bundle that is already unpacked is one restart away and
 * needs no network; a published release still has to be downloaded, verified
 * and installed. Offering the second while the first is true would make the
 * button do the slower of two things.
 */
export function composeUpdateStatus(
  local: UpdateStatus,
  online: UpdateStatus | undefined,
): UpdateStatus {
  if (local.available) return local;
  return online ?? NO_UPDATE;
}
