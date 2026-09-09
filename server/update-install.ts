/**
 * IN-APP UPDATE, part 2 — download, verify, and start the Setup on Windows
 * (phase E, 2026-09-09; decision in `memory/decisions/in-app-update.md`).
 *
 * `POST /api/update` (authed, user-initiated, no body) drives ONE pipeline:
 *
 *   1. `SHA256SUMS.txt` of the release  -> <dataDir>/updates/<version>/
 *   2. free-space precheck (statfs)     -> refuse before the first byte
 *   3. the Setup exe                    -> <name>.part, hashed WHILE streaming
 *   4. verify the hash against the sums -> mismatch: unlink, never rename
 *   5. rename .part -> .exe             -> the ONLY path to a runnable file
 *   6. stage into Windows %TEMP% and run `run-update.ps1` through the interop
 *   7. exit 0 -> poll our own installed-on-disk checker until `current` moved
 *
 * SINGLE-FLIGHT, exactly like RestartController: a second POST while the
 * pipeline runs is 409 and changes nothing. Progress is polled by the UI from
 * `GET /api/update/status`, whose `error` is always one of the CONSTANT
 * sentences in shared/protocol.ts — never remote text, never a path, never a
 * URL, never an exit code.
 *
 * WHAT MAKES THIS SAFE TO EXECUTE (the whole point — this downloads and runs a
 * binary):
 *   - the URLs come from server/update-release.ts, where they were CONSTRUCTED
 *     by us and equality-checked against the API answer;
 *   - redirects are MANUAL: at most 3 hops, each `Location` re-validated
 *     against the host allow-list (github.com / *.githubusercontent.com, or
 *     exactly the loopback seam origin when `AI_SM_UPDATE_API_BASE` is set);
 *   - the body must be EXACTLY the advertised size, under a 200 MiB hard cap,
 *     with a 60 s idle and 15 min total timeout;
 *   - the SHA-256 is computed while the bytes land and compared BEFORE the file
 *     ever carries a runnable name. A mismatch unlinks the `.part` at once;
 *   - `run-update.ps1` re-hashes the file on the Windows side before running it
 *     (defence in depth: the staging copy crosses drvfs);
 *   - the interop spawn is argv-only, absolute paths, no shell, no `-Command`,
 *     and every Windows string passes a charset gate first.
 *
 * The Windows launch is INJECTED (`launchSetup`) so the whole pipeline can be
 * exercised on Linux with no `powershell.exe` in sight; the real implementation
 * is `createInteropLauncher` at the bottom of this file.
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { copyFile, open, rename, statfs, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { UpdateInstallStatus, UpdateRelease } from '../shared/protocol.ts';
import {
  UPDATE_ERROR_CHECKSUM,
  UPDATE_ERROR_DOWNLOAD,
  UPDATE_ERROR_FINISH,
  UPDATE_ERROR_SPACE,
  UPDATE_ERROR_START,
} from '../shared/protocol.ts';
import type { UpdateCheckResult } from './buildinfo.ts';
import { errorClass, oneLine, scoped, type Logger, type LogLevel } from './config.ts';
import { MAX_SETUP_BYTES, type FetchLike } from './update-release.ts';

// --- Route bodies (409/422). Plain sentences: the UI renders them. -----------
/** 409 — a second press while the first one is still working. */
export const UPDATE_IN_PROGRESS = 'An update is already being installed.';
/** 422 — no release is on offer (never checked, already current, release gone). */
export const UPDATE_NOTHING_TO_INSTALL = 'There is no update to install.';
/** 422 — a developer clone: there is no installed app for a Setup to replace. */
export const UPDATE_NOT_INSTALLED = 'Updates are only available in the installed app.';
/** 409 on POST /api/restart — a handoff would destroy the install in flight. */
export const UPDATE_BLOCKS_RESTART = 'An update is being installed.';
/** 503 — no updater wired (unit-test harnesses). Technical, never shown. */
export const UPDATE_NOT_AVAILABLE = 'updates are not available in this process';

// --- Limits ------------------------------------------------------------------
/** `SHA256SUMS.txt` is a few hundred bytes; anything past this is not one. */
export const MAX_SUMS_BYTES = 64 * 1024;
/** Lines accepted in a sums file. */
export const MAX_SUMS_LINES = 200;
/** Redirect hops allowed per asset. */
export const MAX_REDIRECTS = 3;
/** No bytes for this long = a stalled download. */
export const IDLE_TIMEOUT_MS = 60_000;
/** Wall-clock cap on one asset download. */
export const DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000;
/** Headroom demanded on top of twice the Setup size (staging copy included). */
export const SPACE_HEADROOM_BYTES = 64 * 1024 * 1024;
/** How long the Setup itself may run before we stop waiting for it. */
export const SETUP_TIMEOUT_MS = 15 * 60 * 1000;
/** After exit 0: how long `current` has to move before we call it a failure. */
export const INSTALLED_POLL_TIMEOUT_MS = 60_000;
export const INSTALLED_POLL_MS = 1_000;
/** Percent is republished at most this often (and never for less than 1 %). */
export const PROGRESS_MIN_MS = 250;
/** How much of run-update.ps1's stdout is kept for server.log. */
export const MAX_SCRIPT_OUTPUT_BYTES = 64 * 1024;
/** After the child exits, how long its stdout pipe may still deliver a tail. */
export const SCRIPT_OUTPUT_FLUSH_MS = 1_000;

/** Asset hosts allowed when the loopback seam is NOT set. */
const ASSET_HOST_EXACT = 'github.com';
const ASSET_HOST_SUFFIX = '.githubusercontent.com';

/** The Windows-side script the Setup is started by (shipped in the bundle). */
export const RUN_UPDATE_SCRIPT = 'run-update.ps1';
/** Absolute path of the interop PowerShell. Never a PATH lookup. */
export const POWERSHELL_PATH = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
/** Absolute path of the interop cmd.exe (the %TEMP% probe). */
export const CMD_PATH = '/mnt/c/Windows/System32/cmd.exe';
/**
 * Absolute path of `wslpath`, with the bare name as a last resort. Same rule as
 * the two interop paths above: what turns a Windows path into a Linux one on
 * the way to executing an installer is not something to look up in a PATH this
 * process inherited.
 */
export const WSLPATH_PATH = '/usr/bin/wslpath';
/** Staging directory name under Windows %TEMP%. */
export const STAGING_DIR_NAME = 'ai-session-manager-update';

/**
 * `%TEMP%` as cmd.exe prints it: a drive-letter path with no wildcard/quote.
 *
 * Capped well BELOW the argv cap below on purpose: the staged paths this
 * module builds are `<temp>\ai-session-manager-update\<version>\<name>`, which
 * adds ~70 characters, and every one of them still has to fit MAX_PATH (the
 * whole value is at most 180 characters: 3 for `C:\\` plus 177).
 */
const WINDOWS_TEMP_SHAPE = /^[A-Za-z]:\\[^<>|"?*\r\n]{1,177}$/;
/**
 * Every Windows string that reaches an argv slot passes this. Spaces are fine.
 * 259 = MAX_PATH - 1, the longest path the Setup and PowerShell can open
 * without long-path opt-in — and the real reason a shorter cap here would be a
 * bug: the composed staging path is longer than the %TEMP% it starts from.
 */
const WINDOWS_ARG_SHAPE = /^[^<>|"?*%\u0000-\u001f]{1,259}$/;
/** A sha256 as the sums file and the script both spell it. */
export const SHA256_SHAPE = /^[0-9a-f]{64}$/;
/** One line of `sha256sum` output: hash, space, ' ' or '*', then the name. */
const SUMS_LINE_SHAPE = /^([0-9a-f]{64}) [ *](\S{1,255})$/;

/** A failure with the CONSTANT sentence the UI will show. Never remote text. */
export class UpdateFailure extends Error {
  /** One of the UPDATE_ERROR_* constants. */
  sentence: string;

  constructor(sentence: string, detail: string) {
    super(detail);
    this.name = 'UpdateFailure';
    this.sentence = sentence;
  }
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested directly)
// ---------------------------------------------------------------------------

/**
 * The expected SHA-256 of `name` from a `SHA256SUMS.txt` body.
 *
 * STRICT by design — this decides whether an executable is trusted:
 *   - at most 200 lines, every non-blank one matching sha + separator + name;
 *   - names are BASENAMES: a `/` anywhere in a name refuses the whole file
 *     (a sums file that talks about paths is not the one CI writes);
 *   - EXACTLY one line may name our file; zero and two are both refusals.
 */
export function sumFor(text: string, name: string): string {
  const lines = text.split('\n');
  if (lines.length > MAX_SUMS_LINES + 1) {
    throw new UpdateFailure(UPDATE_ERROR_CHECKSUM, `the sums file has more than ${MAX_SUMS_LINES} lines`);
  }
  let found: string | undefined;
  let seen = 0;
  for (const raw of lines) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.trim() === '') continue;
    const m = SUMS_LINE_SHAPE.exec(line);
    if (m === null) {
      throw new UpdateFailure(UPDATE_ERROR_CHECKSUM, 'the sums file has a line we do not understand');
    }
    const entry = m[2] as string;
    if (entry.includes('/') || entry.includes('\\')) {
      throw new UpdateFailure(UPDATE_ERROR_CHECKSUM, 'the sums file names a path instead of a file');
    }
    if (entry === name) {
      seen += 1;
      found = m[1] as string;
    }
  }
  if (seen > 1) {
    throw new UpdateFailure(UPDATE_ERROR_CHECKSUM, 'the sums file names our file more than once');
  }
  if (found === undefined) {
    throw new UpdateFailure(UPDATE_ERROR_CHECKSUM, 'the sums file does not name our file');
  }
  return found;
}

/**
 * Validate an asset URL (the constructed one AND every redirect hop).
 *
 * Without the seam: https, no userinfo, the DEFAULT port, and a host that is
 * exactly `github.com` or ends in `.githubusercontent.com` (where release
 * assets really live). With the seam set the allow-list collapses to exactly
 * that origin — an offline test can then never reach the network, and the seam
 * itself is already loopback-only (server/config.ts).
 */
export function assertAssetUrl(raw: string, seamOrigin?: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UpdateFailure(UPDATE_ERROR_DOWNLOAD, 'a download url was not absolute');
  }
  if (url.username !== '' || url.password !== '') {
    throw new UpdateFailure(UPDATE_ERROR_DOWNLOAD, 'a download url embedded credentials');
  }
  if (seamOrigin !== undefined) {
    if (url.origin !== seamOrigin) {
      throw new UpdateFailure(
        UPDATE_ERROR_DOWNLOAD,
        `a download url left the test seam origin (${oneLine(url.host)})`,
      );
    }
    return url;
  }
  if (url.protocol !== 'https:') {
    throw new UpdateFailure(UPDATE_ERROR_DOWNLOAD, 'a download url was not https');
  }
  if (url.port !== '') {
    throw new UpdateFailure(UPDATE_ERROR_DOWNLOAD, 'a download url used a non-default port');
  }
  const host = url.hostname.toLowerCase();
  if (host !== ASSET_HOST_EXACT && !host.endsWith(ASSET_HOST_SUFFIX)) {
    throw new UpdateFailure(
      UPDATE_ERROR_DOWNLOAD,
      `a download url pointed at ${oneLine(host)}, which is not a release host`,
    );
  }
  return url;
}

/** A Windows string that may become an argv slot, or a refusal. */
export function assertWindowsArg(value: string, what: string): string {
  if (!WINDOWS_ARG_SHAPE.test(value)) {
    throw new UpdateFailure(UPDATE_ERROR_START, `the Windows ${what} is not a usable path`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

/** What `POST /api/update` answers with. Mirrors RestartOutcome's shape. */
export interface UpdateOutcome {
  status: 202 | 409 | 422;
  body: { version: string } | { error: string };
}

/** The narrow interface server/api.ts holds (structural, so tests can stub it). */
export interface UpdateRunner {
  /** True while a download/verify/install is in flight. */
  readonly inProgress: boolean;
  /** True only while the process must stay alive for it (never a held flight). */
  readonly holdsProcess: boolean;
  request(): Promise<UpdateOutcome>;
  status(): UpdateInstallStatus;
}

/** Everything the Windows launch needs, and nothing about how it happens. */
export interface LaunchSetupArgs {
  version: string;
  /** The VERIFIED exe inside `<dataDir>/updates/<version>/`. */
  setupPath: string;
  setupName: string;
  /** 64 lowercase hex — what the Windows script re-hashes against. */
  expectedSha: string;
}

/**
 * Start the Setup and resolve with its EXIT CODE (0 ok, 2 hash mismatch on the
 * Windows side, anything else a failure). Rejects when it could not be started
 * at all. Injected so tests drive the pipeline without Windows.
 */
export type LaunchSetup = (args: LaunchSetupArgs) => Promise<number>;

export interface UpdateControllerDeps {
  log: Logger;
  /** `<dataDir>/updates`. */
  updatesDir: string;
  /** Installed mode? A developer clone answers 422 and downloads nothing. */
  installed: boolean;
  /** The release currently on offer (server/update-release.ts). */
  release: () => UpdateRelease | undefined;
  /** The installed-on-disk checker — how we learn the Setup really landed. */
  installedCheck: () => UpdateCheckResult;
  launchSetup: LaunchSetup;
  /** Test seams. */
  fetchImpl?: FetchLike;
  /** Set ONLY when AI_SM_UPDATE_API_BASE is: collapses the asset allow-list. */
  seamOrigin?: string;
  now?: () => number;
  /** Free-space seam; defaults to `fs.statfs`. */
  statfsImpl?: (path: string) => Promise<{ bavail: number | bigint; bsize: number | bigint }>;
  installedPollMs?: number;
  installedPollTimeoutMs?: number;
  idleTimeoutMs?: number;
  downloadTimeoutMs?: number;
  setupTimeoutMs?: number;
}

/**
 * Best effort `rm -rf` of the updates directory. Called at boot: a `.part` from
 * a killed run, or an exe from a release nobody installed, must never be reused
 * — only a file verified in THIS run is ever executed.
 */
export function cleanupUpdatesDir(dir: string, log?: Logger): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    log?.('warn', `[update] could not clear ${oneLine(dir)}: ${errorClass(err)}`);
  }
}

export class UpdateController implements UpdateRunner {
  readonly #deps: UpdateControllerDeps;
  readonly #log: Logger;
  readonly #now: () => number;
  #state: UpdateInstallStatus['state'] = 'idle';
  #version: string | null = null;
  #percent = 0;
  #error: string | null = null;
  #lastPublish = 0;
  #running = false;
  /**
   * The single flight is HELD past a Setup timeout: the child is detached and
   * may well still be installing, so a second press must keep getting 409
   * until it really exits. Set only by #launch's timeout branch.
   */
  #heldFlight = false;
  /** Epoch ms of the request that started the flight now in progress. */
  #startedAt = 0;

  constructor(deps: UpdateControllerDeps) {
    this.#deps = deps;
    this.#log = scoped(deps.log, 'update');
    this.#now = deps.now ?? ((): number => Date.now());
  }

  get inProgress(): boolean {
    return this.#running;
  }

  /**
   * Does an install need THIS process to stay alive right now?
   *
   * Only while the pipeline itself is working: downloading, verifying, or
   * waiting on the Setup. A HELD flight — a Setup that outran its timeout and
   * is still out there — deliberately does NOT count: it keeps `inProgress`
   * true so a second press is refused, but a child that never exits must never
   * defer the idle shutdown forever.
   */
  get holdsProcess(): boolean {
    return this.#state === 'downloading' || this.#state === 'verifying' || this.#state === 'installing';
  }

  /** When the flight now holding the process started (epoch ms); 0 when none. */
  get holdingSince(): number {
    return this.holdsProcess ? this.#startedAt : 0;
  }

  status(): UpdateInstallStatus {
    return {
      state: this.#state,
      version: this.#version,
      percent: this.#percent,
      error: this.#error,
    };
  }

  async request(): Promise<UpdateOutcome> {
    if (this.#running) {
      this.#log('info', 'update requested while one is already running: refused');
      return { status: 409, body: { error: UPDATE_IN_PROGRESS } };
    }
    if (!this.#deps.installed) {
      return { status: 422, body: { error: UPDATE_NOT_INSTALLED } };
    }
    const release = this.#deps.release();
    if (release === undefined) {
      this.#log('info', 'update requested with no release on offer: refused');
      return { status: 422, body: { error: UPDATE_NOTHING_TO_INSTALL } };
    }
    this.#running = true;
    this.#state = 'downloading';
    this.#startedAt = this.#now();
    this.#version = release.version;
    this.#percent = 0;
    this.#error = null;
    this.#lastPublish = 0;
    this.#log(
      'info',
      `update requested: ${release.version} (${release.size} bytes from ${
        oneLine(new URL(release.setupUrl).host)
      })`,
    );
    // The route answers 202 immediately; the pipeline runs on its own and is
    // observed through GET /api/update/status.
    void this.#run(release).catch((err: unknown) => {
      // Defence in depth: #run maps every failure itself.
      this.#fail(UPDATE_ERROR_FINISH, `unexpected: ${errorClass(err)}`);
    });
    return { status: 202, body: { version: release.version } };
  }

  #fail(sentence: string, detail: string): void {
    this.#state = 'failed';
    this.#error = sentence;
    // The status says "failed" immediately; the FLIGHT may still be held (a
    // Setup that outran its timeout is still running out there).
    if (!this.#heldFlight) this.#running = false;
    this.#log('warn', `update failed: ${detail}`);
  }

  /** Keep the flight while a timed-out Setup is still alive; release on exit. */
  #holdFlight(pending: Promise<number>): void {
    this.#heldFlight = true;
    const release = (detail: string): void => {
      this.#heldFlight = false;
      this.#running = false;
      this.#log('info', `the timed-out Setup ended (${detail}); a new update may be started`);
    };
    pending.then(
      (code) => release(`exit code ${code}`),
      (err: unknown) => release(`it never started: ${errorClass(err)}`),
    );
  }

  #publish(received: number, total: number): void {
    const pct = total <= 0 ? 0 : Math.min(100, Math.floor((received / total) * 100));
    const at = this.#now();
    if (pct !== this.#percent && (pct >= this.#percent + 1 || at - this.#lastPublish >= PROGRESS_MIN_MS)) {
      this.#percent = pct;
      this.#lastPublish = at;
    }
  }

  async #run(release: UpdateRelease): Promise<void> {
    const dir = join(this.#deps.updatesDir, release.version);
    try {
      this.#prepareDir(dir);
      // 1. The sums file FIRST: without it nothing that follows can be trusted.
      const sumsText = await this.#download(release.sumsUrl, { maxBytes: MAX_SUMS_BYTES });
      const expected = sumFor(sumsText, release.setupName);
      this.#log('debug', `sums fetched (${sumsText.length} bytes), expected hash read`);

      // 2. Space BEFORE the first byte: `size * 2 + 64 MiB` covers the download
      //    and the staging copy that crosses drvfs later.
      await this.#assertSpace(dir, release.size);

      // 3. The exe itself, hashed while it lands, into a NON-RUNNABLE name.
      const partPath = join(dir, `${release.setupName}.part`);
      const actual = await this.#downloadToFile(release.setupUrl, partPath, release.size);

      // 4. Verify. A mismatch deletes the file here and now.
      this.#state = 'verifying';
      this.#percent = 100;
      if (actual !== expected) {
        await unlink(partPath).catch(() => undefined);
        throw new UpdateFailure(
          UPDATE_ERROR_CHECKSUM,
          'the downloaded Setup did not match the release checksum; it was deleted',
        );
      }
      // 5. The ONLY path to a runnable name.
      const setupPath = join(dir, release.setupName);
      await rename(partPath, setupPath);
      this.#log('info', `update ${release.version} verified and staged in ${oneLine(dir)}`);

      // 6. Windows.
      this.#state = 'installing';
      const code = await this.#launch({
        version: release.version,
        setupPath,
        setupName: release.setupName,
        expectedSha: expected,
      });
      // run-update.ps1's contract (its header states the same table):
      //   2 = it re-hashed the exe and refused it; 3 = it refused for its own
      //   reasons or could not start the Setup at all; anything else non-zero
      //   is the Setup's own exit code.
      if (code === 2) {
        throw new UpdateFailure(UPDATE_ERROR_CHECKSUM, 'the Windows script refused the file (hash mismatch)');
      }
      if (code === 3) {
        throw new UpdateFailure(UPDATE_ERROR_START, 'the Windows script refused to start the Setup');
      }
      if (code !== 0) {
        throw new UpdateFailure(UPDATE_ERROR_FINISH, `the Setup exited with code ${code}`);
      }
      // 7. Believe the disk, not the exit code: `current` must really have moved.
      await this.#awaitInstalled();
      this.#state = 'installed';
      this.#running = false;
      this.#log('info', `update ${release.version} installed; a restart will hand the port to it`);
    } catch (err) {
      if (err instanceof UpdateFailure) this.#fail(err.sentence, err.message);
      else if ((err as NodeJS.ErrnoException).code === 'ENOSPC') {
        this.#fail(UPDATE_ERROR_SPACE, 'the disk ran out of space while downloading');
      } else this.#fail(UPDATE_ERROR_DOWNLOAD, `download failed (${errorClass(err)})`);
    }
  }

  /** `<updates>/<version>` fresh, and every OTHER version dir removed. */
  #prepareDir(dir: string): void {
    try {
      for (const entry of readdirSync(this.#deps.updatesDir, { withFileTypes: true })) {
        const path = join(this.#deps.updatesDir, entry.name);
        if (path !== dir) rmSync(path, { recursive: true, force: true });
      }
    } catch {
      // The directory does not exist yet — the common case on a first update.
    }
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  async #assertSpace(dir: string, size: number): Promise<void> {
    const need = size * 2 + SPACE_HEADROOM_BYTES;
    let free: number;
    try {
      const fs = await (this.#deps.statfsImpl ?? statfs)(dir);
      free = Number(fs.bavail) * Number(fs.bsize);
    } catch (err) {
      // No answer is not a refusal: the write itself still maps ENOSPC.
      this.#log('debug', `free-space check unavailable (${errorClass(err)}); continuing`);
      return;
    }
    if (free < need) {
      throw new UpdateFailure(
        UPDATE_ERROR_SPACE,
        `not enough space: ${free} bytes free, ${need} needed`,
      );
    }
    this.#log('debug', `free-space check ok (${free} bytes free, ${need} needed)`);
  }

  /** Open an asset, following at most MAX_REDIRECTS validated hops. */
  async #open(url: string, signal: AbortSignal): Promise<Response> {
    const doFetch = this.#deps.fetchImpl ?? ((u: string, init?: RequestInit) => fetch(u, init));
    let target = assertAssetUrl(url, this.#deps.seamOrigin);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      let res: Response;
      try {
        res = await doFetch(target.toString(), {
          method: 'GET',
          headers: { 'User-Agent': 'ai-cli-session-manager', Accept: 'application/octet-stream' },
          redirect: 'manual',
          signal,
        });
      } catch (err) {
        throw new UpdateFailure(UPDATE_ERROR_DOWNLOAD, `the download request failed (${errorClass(err)})`);
      }
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        try {
          await res.body?.cancel();
        } catch {
          // Nothing to drain.
        }
        if (location === null || location.length > 2048) {
          throw new UpdateFailure(UPDATE_ERROR_DOWNLOAD, 'a redirect carried no usable location');
        }
        if (hop === MAX_REDIRECTS) {
          throw new UpdateFailure(UPDATE_ERROR_DOWNLOAD, `more than ${MAX_REDIRECTS} redirects`);
        }
        // ABSOLUTE only, and re-validated against the allow-list every hop.
        target = assertAssetUrl(location, this.#deps.seamOrigin);
        this.#log('debug', `download redirect ${hop + 1} -> ${oneLine(target.host)}`);
        continue;
      }
      if (res.status !== 200) {
        try {
          await res.body?.cancel();
        } catch {
          // Nothing to drain.
        }
        throw new UpdateFailure(UPDATE_ERROR_DOWNLOAD, `the download answered HTTP ${res.status}`);
      }
      return res;
    }
    throw new UpdateFailure(UPDATE_ERROR_DOWNLOAD, `more than ${MAX_REDIRECTS} redirects`);
  }

  /** A small asset (the sums file) as text, capped while reading. */
  async #download(url: string, opts: { maxBytes: number }): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#deps.downloadTimeoutMs ?? DOWNLOAD_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();
    try {
      const res = await this.#open(url, controller.signal);
      const reader = res.body?.getReader();
      if (reader === undefined) return '';
      const chunks: Buffer[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await this.#read(reader);
        if (done) break;
        if (value === undefined) continue;
        total += value.byteLength;
        if (total > opts.maxBytes) {
          throw new UpdateFailure(UPDATE_ERROR_DOWNLOAD, `the sums file exceeded ${opts.maxBytes} bytes`);
        }
        chunks.push(Buffer.from(value));
      }
      return Buffer.concat(chunks).toString('utf8');
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  /** One read with an idle timeout — a stalled server must not hold the flow. */
  async #read(
    reader: ReadableStreamDefaultReader<Uint8Array>,
  ): Promise<{ done: boolean; value?: Uint8Array }> {
    const idleMs = this.#deps.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
    let timer: NodeJS.Timeout | undefined;
    const idle = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new UpdateFailure(UPDATE_ERROR_DOWNLOAD, `no bytes for ${idleMs}ms`)),
        idleMs,
      );
      if (typeof timer.unref === 'function') timer.unref();
    });
    try {
      return await Promise.race([reader.read(), idle]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * Stream the Setup to `dest`, hashing as it lands. The size must match the
   * release's EXACTLY: a short body is a truncated download, a long one is a
   * server that changed its mind, and both are refusals with the file removed.
   */
  async #downloadToFile(url: string, dest: string, size: number): Promise<string> {
    if (size > MAX_SETUP_BYTES) {
      throw new UpdateFailure(UPDATE_ERROR_DOWNLOAD, `the Setup is larger than ${MAX_SETUP_BYTES} bytes`);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#deps.downloadTimeoutMs ?? DOWNLOAD_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();
    const hash = createHash('sha256');
    let received = 0;
    const handle = await open(dest, 'w', 0o600);
    try {
      const res = await this.#open(url, controller.signal);
      const reader = res.body?.getReader();
      if (reader === undefined) throw new UpdateFailure(UPDATE_ERROR_DOWNLOAD, 'the download had no body');
      for (;;) {
        const { done, value } = await this.#read(reader);
        if (done) break;
        if (value === undefined) continue;
        received += value.byteLength;
        if (received > size || received > MAX_SETUP_BYTES) {
          await reader.cancel().catch(() => undefined);
          throw new UpdateFailure(UPDATE_ERROR_DOWNLOAD, 'the download was longer than the release says');
        }
        const buf = Buffer.from(value);
        hash.update(buf);
        await handle.write(buf);
        this.#publish(received, size);
      }
      if (received !== size) {
        throw new UpdateFailure(UPDATE_ERROR_DOWNLOAD, `the download was ${received} of ${size} bytes`);
      }
      await handle.sync();
    } catch (err) {
      await handle.close().catch(() => undefined);
      await unlink(dest).catch(() => undefined);
      if (err instanceof UpdateFailure) throw err;
      if ((err as NodeJS.ErrnoException).code === 'ENOSPC') {
        throw new UpdateFailure(UPDATE_ERROR_SPACE, 'the disk ran out of space while downloading');
      }
      throw new UpdateFailure(UPDATE_ERROR_DOWNLOAD, `the download failed (${errorClass(err)})`);
    } finally {
      clearTimeout(timer);
      controller.abort();
      await handle.close().catch(() => undefined);
    }
    return hash.digest('hex');
  }

  async #launch(args: LaunchSetupArgs): Promise<number> {
    const timeoutMs = this.#deps.setupTimeoutMs ?? SETUP_TIMEOUT_MS;
    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;
    const expiry = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(new UpdateFailure(UPDATE_ERROR_FINISH, `the Setup did not finish within ${timeoutMs}ms`));
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
    });
    const launched = this.#deps.launchSetup(args).catch((err: unknown) => {
      if (err instanceof UpdateFailure) throw err;
      throw new UpdateFailure(UPDATE_ERROR_START, `the Setup could not be started (${errorClass(err)})`);
    });
    try {
      return await Promise.race([launched, expiry]);
    } catch (err) {
      // GIVING UP ON THE WAIT IS NOT STOPPING THE SETUP. The child is detached
      // — we cannot and must not kill an installer half way — so the flight
      // stays held until its exit really arrives, and a second press keeps
      // getting 409 instead of starting a SECOND Setup beside the first.
      if (timedOut) this.#holdFlight(launched);
      throw err;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** Poll our own installed-on-disk checker until `current` names a new version. */
  async #awaitInstalled(): Promise<void> {
    const timeoutMs = this.#deps.installedPollTimeoutMs ?? INSTALLED_POLL_TIMEOUT_MS;
    const pollMs = this.#deps.installedPollMs ?? INSTALLED_POLL_MS;
    const deadline = this.#now() + timeoutMs;
    for (;;) {
      if (this.#deps.installedCheck().available) return;
      if (this.#now() >= deadline) {
        throw new UpdateFailure(
          UPDATE_ERROR_FINISH,
          `the Setup finished but no new version appeared within ${timeoutMs}ms`,
        );
      }
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, pollMs);
        if (typeof t.unref === 'function') t.unref();
      });
    }
  }
}

// ---------------------------------------------------------------------------
// The REAL Windows launch (WSL interop). Injected above; unreachable in tests.
// ---------------------------------------------------------------------------

export interface WindowsTemp {
  /** `C:\Users\<user>\AppData\Local\Temp` — validated, no trailing separator. */
  win: string;
  /** The same directory as WSL sees it: `/mnt/c/...`, proven to be a directory. */
  linux: string;
}

/** Run an interop helper and return its stdout (bounded, argv only, no shell). */
function runCapture(command: string, args: string[], timeoutMs = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    let done = false;
    const finish = (err?: Error): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err !== undefined) reject(err);
      else resolve(out);
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
      finish(new UpdateFailure(UPDATE_ERROR_START, `${basename(command)} timed out`));
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    child.stdout?.on('data', (chunk: Buffer) => {
      if (out.length < 4096) out += chunk.toString('utf8');
    });
    child.on('error', () =>
      finish(new UpdateFailure(UPDATE_ERROR_START, `${basename(command)} could not be started`)),
    );
    child.on('close', (code) =>
      finish(
        code === 0
          ? undefined
          : new UpdateFailure(UPDATE_ERROR_START, `${basename(command)} exited with code ${code}`),
      ),
    );
  });
}

/**
 * Ask Windows where `%TEMP%` is, and where WSL sees it.
 *
 * `cmd.exe /c echo %TEMP%` is the only way to get the Windows user's real temp
 * directory from inside WSL — and its output is REMOTE-ish input: it is
 * validated as a drive-letter path with no wildcard, quote or surviving `%`
 * (an unexpanded `%TEMP%` means no such variable) before it is used, and
 * `wslpath -u` (argv, never a shell) must answer with a real directory
 * under /mnt.
 */
export async function probeWindowsTemp(): Promise<WindowsTemp> {
  const raw = (await runCapture(CMD_PATH, ['/c', 'echo', '%TEMP%'])).split('\n')[0] ?? '';
  const win = raw.replace(/[\r\n]+$/, '').trim().replace(/\\+$/, '');
  if (!WINDOWS_TEMP_SHAPE.test(win) || win.includes('%')) {
    throw new UpdateFailure(UPDATE_ERROR_START, 'Windows did not report a usable temp directory');
  }
  const wslpath = existsSync(WSLPATH_PATH) ? WSLPATH_PATH : 'wslpath';
  const linux = ((await runCapture(wslpath, ['-u', win])).split('\n')[0] ?? '').trim();
  if (!linux.startsWith('/mnt/')) {
    throw new UpdateFailure(UPDATE_ERROR_START, 'the Windows temp directory is not reachable from WSL');
  }
  try {
    if (!statSync(linux).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new UpdateFailure(UPDATE_ERROR_START, 'the Windows temp directory is not a directory');
  }
  return { win, linux };
}

/** Spawn seam — the narrow shape this module uses, so a test can fake a child. */
export type SpawnLike = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export interface InteropLauncherOptions {
  log: Logger;
  /** The app dir this process runs from; holds `launcher/run-update.ps1`. */
  appDir: string;
  /** Test seams. */
  probeTemp?: () => Promise<WindowsTemp>;
  spawnImpl?: SpawnLike;
}

/**
 * The real `launchSetup`: stage the verified exe plus `run-update.ps1` into
 * Windows %TEMP% and start PowerShell on it, detached.
 *
 * The staging COPY is plain Node fs across drvfs — no Windows path ever reaches
 * a command line during it. The spawn is argv-only with absolute paths and no
 * `-Command`; every Windows string passes `assertWindowsArg` first. The child
 * is detached and unref'd (it outlives us: the Setup replaces this very
 * bundle), but the exit listener stays so the pipeline learns the exit code.
 */
export function createInteropLauncher(opts: InteropLauncherOptions): LaunchSetup {
  const log = scoped(opts.log, 'update');
  const probe = opts.probeTemp ?? probeWindowsTemp;
  const spawnImpl = opts.spawnImpl ?? spawn;
  let cachedTemp: WindowsTemp | undefined;

  return async (args: LaunchSetupArgs): Promise<number> => {
    if (!SHA256_SHAPE.test(args.expectedSha)) {
      throw new UpdateFailure(UPDATE_ERROR_START, 'the expected hash is not a sha256');
    }
    const script = join(opts.appDir, 'launcher', RUN_UPDATE_SCRIPT);
    if (!existsSync(script)) {
      throw new UpdateFailure(UPDATE_ERROR_START, `${oneLine(script)} is missing from this install`);
    }
    if (cachedTemp === undefined) cachedTemp = await probe();
    const temp = cachedTemp;

    const stageLinux = join(temp.linux, STAGING_DIR_NAME, args.version);
    const stageWin = `${temp.win}\\${STAGING_DIR_NAME}\\${args.version}`;

    // THE LENGTH GATE RUNS FIRST, on the composed paths, before a single byte
    // is copied: %TEMP% plus the staging directory, the version and the Setup
    // name is what has to fit MAX_PATH, and finding that out after a ~100 MiB
    // drvfs copy would only waste the copy (and leave it behind).
    const scriptWin = assertWindowsArg(`${stageWin}\\${RUN_UPDATE_SCRIPT}`, 'script path');
    const setupWin = assertWindowsArg(`${stageWin}\\${args.setupName}`, 'Setup path');
    const logWin = assertWindowsArg(`${stageWin}\\setup.log`, 'log path');

    try {
      rmSync(stageLinux, { recursive: true, force: true });
      mkdirSync(stageLinux, { recursive: true });
      await copyFile(args.setupPath, join(stageLinux, args.setupName));
      await copyFile(script, join(stageLinux, RUN_UPDATE_SCRIPT));
      // Belt and braces: the same three strings again, so a staged run can
      // never proceed on a path the gate above did not see. A refusal here
      // takes the staging copy with it instead of leaving it in %TEMP%.
      assertWindowsArg(scriptWin, 'script path');
      assertWindowsArg(setupWin, 'Setup path');
      assertWindowsArg(logWin, 'log path');
    } catch (err) {
      try {
        rmSync(stageLinux, { recursive: true, force: true });
      } catch {
        // Best effort: the original failure is the one worth reporting.
      }
      if (err instanceof UpdateFailure) throw err;
      throw new UpdateFailure(
        UPDATE_ERROR_START,
        `could not stage the update into the Windows temp directory (${errorClass(err)})`,
      );
    }
    const argv = [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptWin,
      '-SetupPath',
      setupWin,
      '-ExpectedSha',
      args.expectedSha,
      '-LogPath',
      logWin,
    ];
    log('info', `starting the Windows Setup for ${args.version} from ${oneLine(stageWin)}`);

    return new Promise<number>((resolve, reject) => {
      // stdout is PIPED (stderr stays ignored): everything run-update.ps1
      // prints — including the tail of the Setup's own log on a failure — is
      // the only diagnostic this update has, and a detached child's console
      // goes nowhere. The pipe is unref'd immediately so it can never hold the
      // event loop: the Setup outlives this process on purpose, and a restart
      // handoff must not wait for it.
      const child = spawnImpl(POWERSHELL_PATH, argv, {
        detached: true,
        stdio: ['ignore', 'pipe', 'ignore'],
        cwd: stageLinux,
      });
      const stdout = child.stdout as (NodeJS.ReadableStream & { unref?: () => void }) | null;
      let out = '';
      let truncated = false;
      let flushed = false;
      let ended = stdout === null;
      let afterEnd: (() => void) | undefined;
      const flush = (code: number | null): void => {
        if (flushed) return;
        flushed = true;
        // debug on success (routine), warn when the update did not work: the
        // level is the only thing the exit code changes about this output.
        const level: LogLevel = code === 0 ? 'debug' : 'warn';
        for (const line of out.split('\n')) {
          const text = oneLine(line).trim();
          if (text !== '') log(level, `${RUN_UPDATE_SCRIPT}: ${text}`);
        }
        if (truncated) log(level, `${RUN_UPDATE_SCRIPT}: (further output dropped)`);
      };
      if (stdout !== null) {
        stdout.unref?.();
        stdout.setEncoding?.('utf8');
        stdout.on('data', (chunk: string | Buffer) => {
          if (truncated) return;
          out += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
          if (out.length > MAX_SCRIPT_OUTPUT_BYTES) {
            out = out.slice(0, MAX_SCRIPT_OUTPUT_BYTES);
            truncated = true;
          }
        });
        const done = (): void => {
          ended = true;
          afterEnd?.();
        };
        stdout.on('end', done);
        stdout.on('error', done);
      }
      child.on('error', () =>
        reject(new UpdateFailure(UPDATE_ERROR_START, 'powershell.exe could not be started')),
      );
      // The exit listener is kept ON PURPOSE while the process is unref'd: the
      // Setup must not hold this backend alive, but its exit code decides
      // whether the UI says "installed" or "the update did not finish".
      child.on('exit', (code, signal) => {
        log('info', `the Windows Setup exited (code ${code ?? 'null'}, signal ${signal ?? 'none'})`);
        if (ended) flush(code);
        else {
          // The pipe usually ends with the child; if it does not (a grandchild
          // inherited it), the tail is written anyway and never waited for.
          const timer = setTimeout(() => flush(code), SCRIPT_OUTPUT_FLUSH_MS);
          if (typeof timer.unref === 'function') timer.unref();
          afterEnd = (): void => {
            clearTimeout(timer);
            flush(code);
          };
        }
        resolve(code ?? -1);
      });
      child.unref();
    });
  };
}
