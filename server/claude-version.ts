/**
 * Which Claude Code this backend's sessions launch (Nocturne D6,
 * `.claude/plans/nocturne/PLAN-D6.md`): `probeClaudeVersion` runs
 * `claude --version` once, and `ClaudeVersionWatch` holds the answer GET
 * /api/runtime carries under `claude`, re-probing when the binary on PATH
 * changes.
 *
 * THE SPAWN (a new spawn site — hard constraint, PROJECT-SCOPE § Hard
 * technical constraints): argv only through server/config.ts `runCapture`
 * (`shell: false`), the ABSOLUTE path the PATH lookup found
 * (server/tools.ts `resolveOnPath`, the one a session's bare `claude` runs),
 * one fixed argument `--version`, the sessions' own environment (`ptyEnv()`),
 * stdin and stderr ignored, stdout capped at runCapture's default 4 KiB,
 * SIGKILL after 5 s. What it prints is untrusted text: only an `X.Y.Z` is
 * believed, anything else is `unknown` and kept as at most 40 characters with
 * escape sequences, control and bidi characters stripped
 * (server/sessions-output.ts `firstOutputLine`).
 *
 * It never gates anything: boot does not wait for it (server/index-claude.ts
 * starts it after listen), and no launch is ever refused because of it.
 */
import { realpath, stat } from 'node:fs/promises';
import type { ClaudeStatus } from '../shared/protocol.ts';
import {
  CLAUDE_SUPPORTED,
  CLAUDE_VERSION_SHAPE,
  claudeCompat,
  parseClaudeVersion,
  type ClaudeCompat,
} from '../shared/claude-compat.ts';
import { oneLine, runCapture, type Logger } from './config.ts';
import { firstOutputLine } from './sessions-output.ts';
import { resolveOnPath } from './tools.ts';

/** `claude --version` answers in milliseconds; past this it is hung and killed. */
const CLAUDE_PROBE_TIMEOUT_MS = 5000;
/** What an `unknown` answer keeps of the probe's first line, for the Settings fact. */
const CLAUDE_RAW_MAX = 40;
/** A changed binary is re-probed at most this often. */
const CLAUDE_REPROBE_MIN_MS = 60_000;

/** The probe's answer, before the range is attached. */
interface ClaudeVersionAnswer {
  version: string | null;
  compat: ClaudeCompat;
}

interface ProbeClaudeVersionOptions {
  /** The environment sessions are spawned with (production: `ptyEnv()`). */
  env: Record<string, string | undefined>;
  log: Logger;
}

/** The answer before any probe returned, and while the override is not set. */
const NOT_YET: ClaudeVersionAnswer = { version: null, compat: 'unknown' };

/**
 * Run `claude --version` (see the header for how) and place the answer.
 * Never rejects: no binary is `missing`, a failure or garbage is `unknown`.
 */
export async function probeClaudeVersion(opts: ProbeClaudeVersionOptions): Promise<ClaudeVersionAnswer> {
  const binary = await resolveOnPath('claude', opts.env);
  if (binary === null) {
    opts.log('info', 'Claude Code not found on the sessions\' PATH');
    return { version: null, compat: claudeCompat(null, false) };
  }
  let stdout: string;
  try {
    // The stdout cap is runCapture's default (4 KiB): one short line is the
    // whole legitimate answer.
    stdout = await runCapture(binary, ['--version'], { env: opts.env, timeoutMs: CLAUDE_PROBE_TIMEOUT_MS });
  } catch (err) {
    const what = err instanceof Error ? err.message : String(err);
    opts.log('warn', `claude --version ${what} (${oneLine(binary)}); version unknown`);
    return NOT_YET;
  }
  const parsed = parseClaudeVersion(stdout);
  if (parsed === null) {
    const raw = firstOutputLine(stdout, CLAUDE_RAW_MAX);
    opts.log('warn', `claude --version printed no version: ${JSON.stringify(raw)} (${oneLine(binary)})`);
    return { version: raw === '' ? null : raw, compat: 'unknown' };
  }
  const compat = claudeCompat(parsed, true);
  opts.log(
    compat === 'ok' ? 'info' : 'warn',
    `Claude Code ${parsed} (${compat}; supported ${CLAUDE_SUPPORTED.min}, tested up to ` +
      `${CLAUDE_SUPPORTED.testedUpTo}) at ${oneLine(binary)}`,
  );
  return { version: parsed, compat };
}

/**
 * AI_SM_CLAUDE_VERSION_OVERRIDE — a DEVELOPMENT knob that replaces the probe's
 * answer, so the out-of-range notice can be seen without installing another
 * Claude Code. Refused (a warn line, then ignored) in the installed app and
 * when it is not exactly `X.Y.Z`. Returns the version to use, or undefined.
 */
export function resolveClaudeVersionOverride(
  raw: string | undefined,
  installed: boolean,
  log: Logger,
): string | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (installed) {
    log('warn', 'AI_SM_CLAUDE_VERSION_OVERRIDE is a development setting; ignored in the installed app');
    return undefined;
  }
  if (!CLAUDE_VERSION_SHAPE.test(raw)) {
    log(
      'warn',
      `AI_SM_CLAUDE_VERSION_OVERRIDE must be a version X.Y.Z, got ${JSON.stringify(oneLine(raw).slice(0, 64))}; ignored`,
    );
    return undefined;
  }
  log('info', `Claude Code version overridden to ${raw} (AI_SM_CLAUDE_VERSION_OVERRIDE, development only)`);
  return raw;
}

interface ClaudeVersionWatchOptions {
  /** The sessions' environment, read per probe (production: `ptyEnv`). */
  env: () => Record<string, string | undefined>;
  log: Logger;
  /** A validated override (resolveClaudeVersionOverride): no probe ever runs. */
  override?: string | undefined;
  /** MONOTONIC clock seam for the re-probe window (default performance.now). */
  now?: () => number;
  /**
   * TEST SEAM (CONTRIBUTING § No dead code: a timer a test replaces): the
   * re-probe window, default CLAUDE_REPROBE_MIN_MS, so a test steps through a
   * window instead of waiting a minute.
   */
  reprobeMinMs?: number;
}

/**
 * Holds the current answer and keeps it honest while the app runs.
 *
 * `start()` probes once (called after listen). `binaryChanged()` is the
 * /api/tools hook (server/tools.ts `onProbe`): it fingerprints the `claude` on
 * PATH (resolved path, real path, mtime) and, when that differs from what the
 * last probe saw, probes again — at most once per `reprobeMinMs`; a change
 * inside the window is probed when the window ends (one unref'd timer).
 */
export class ClaudeVersionWatch {
  #answer: ClaudeVersionAnswer;
  readonly #opts: ClaudeVersionWatchOptions;
  readonly #now: () => number;
  /** The fingerprint the last probe ran against; undefined before the first. */
  #seen: string | undefined;
  #lastProbeAt = -Infinity;
  #inFlight: Promise<void> | null = null;
  #timer: NodeJS.Timeout | undefined;
  #stopped = false;

  constructor(opts: ClaudeVersionWatchOptions) {
    this.#opts = opts;
    this.#now = opts.now ?? ((): number => performance.now());
    this.#answer =
      opts.override === undefined
        ? NOT_YET
        : { version: opts.override, compat: claudeCompat(opts.override, true) };
  }

  /** The `claude` member of GET /api/runtime. */
  status(): ClaudeStatus {
    return { ...this.#answer, min: CLAUDE_SUPPORTED.min, testedUpTo: CLAUDE_SUPPORTED.testedUpTo };
  }

  /** The version for a log line (the early-exit WARN), or null when not known. */
  version(): string | null {
    return this.#answer.version;
  }

  /** The first probe. Never awaited by boot; resolves when it answered. */
  start(): Promise<void> {
    if (this.#opts.override !== undefined) return Promise.resolve();
    return this.#probe();
  }

  /** The /api/tools hook; see the class comment. Never rejects. */
  async binaryChanged(): Promise<void> {
    if (this.#opts.override !== undefined || this.#stopped || this.#seen === undefined) return;
    if (this.#inFlight !== null || this.#timer !== undefined) return;
    if ((await this.#fingerprint()) === this.#seen) return;
    const wait = this.#lastProbeAt + (this.#opts.reprobeMinMs ?? CLAUDE_REPROBE_MIN_MS) - this.#now();
    if (wait <= 0) {
      this.#opts.log('info', 'the claude on PATH changed; probing its version again');
      await this.#probe();
      return;
    }
    // Re-checked after the await: a concurrent call may have armed it meanwhile.
    if (this.#timer !== undefined) return;
    this.#opts.log('info', `the claude on PATH changed; probing its version again in ${Math.ceil(wait)}ms`);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.#probe();
    }, wait);
    this.#timer.unref();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #probe(): Promise<void> {
    if (this.#inFlight !== null) return this.#inFlight;
    this.#lastProbeAt = this.#now();
    const run = (async (): Promise<void> => {
      const env = this.#opts.env();
      this.#seen = await this.#fingerprint(env);
      const answer = await probeClaudeVersion({ env, log: this.#opts.log });
      if (!this.#stopped) this.#answer = answer;
    })().finally(() => {
      this.#inFlight = null;
    });
    this.#inFlight = run;
    return run;
  }

  /** `missing`, or the resolved path, its real path and mtime: what an upgrade changes. */
  async #fingerprint(env = this.#opts.env()): Promise<string> {
    const binary = await resolveOnPath('claude', env);
    if (binary === null) return 'missing';
    try {
      const real = await realpath(binary);
      return `${binary}\0${real}\0${(await stat(real)).mtimeMs}`;
    } catch {
      return `${binary}\0unreadable`;
    }
  }
}
