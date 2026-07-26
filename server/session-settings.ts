/**
 * Per-session Claude Code settings files — how app-launched claude sessions get
 * OUR status line without touching anything of the user's.
 *
 * Claude Code merges `--settings <file>` over its own settings for THAT session
 * only: key-level merge, nothing written back, the user's hooks / MCP servers /
 * permissions / model untouched. So for every claude-kind session we write a
 * file holding exactly one key — `statusLine` — and append `--settings <file>`
 * to the spawned argv.
 *
 * WHAT WE REFUSE TO DO, and why:
 *   - `~/.claude/settings.json` is the USER'S file. It is never read or written
 *     here. A global status line would leak into every claude they run outside
 *     this app, and a crash would leave it there.
 *   - `CLAUDE_CONFIG_DIR` would relocate credentials, history and trust records
 *     along with the settings — an app-owned config dir orphans all of them.
 *   - A project `.claude/settings.json` mutates the user's repository.
 *
 * SECURITY. `statusLine.command` is a SHELL string (Claude Code runs it through
 * a shell), so it is composed exclusively from:
 *   - process.execPath and two server-known absolute paths, and
 *   - one value out of a closed five-element enum (the four `--permission-mode`
 *     values plus 'unknown').
 * No client-supplied byte ever reaches it. Paths are still POSIX-quoted, so a
 * data dir containing a space or a quote cannot reshape the command either.
 *
 * The whole directory is wiped at boot: sessions never survive a backend
 * restart, so a file that outlives its session is garbage by definition.
 */
import { mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ClaudePermissionMode } from '../shared/protocol.ts';
import type { Logger } from './config.ts';

/**
 * The four `--permission-mode` values this app launches with. Note Claude Code
 * 2.1.220 itself accepts more (`auto`, `manual`, `dontAsk`) and no longer
 * accepts the literal `default` — which is why 'default' here means "no
 * --permission-mode argument was passed", and any OTHER explicit value becomes
 * 'unknown' rather than being mislabelled as one of ours.
 */
const KNOWN_MODES: readonly ClaudePermissionMode[] = [
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions',
];

/**
 * What the status-line script is told about the session's permission mode.
 * 'unknown' -> the script omits the item (an honest blank beats a wrong label).
 */
export type StatuslineMode = ClaudePermissionMode | 'unknown';

/**
 * Seconds between status-line re-runs, on top of the event-driven updates
 * (every assistant message, /compact, permission-mode change).
 *
 * SECONDS, not milliseconds: Claude Code 2.1.220's settings schema declares
 * `refreshInterval: number().min(1).describe("Re-run the status line command
 * every N seconds ...")` and its renderer arms the timer with
 * `Math.max(1, refreshInterval) * 1000` ms. A value of 2000 would therefore mean
 * ~33 minutes, i.e. settings-panel toggles would look dead on running sessions.
 */
export const STATUSLINE_REFRESH_SECONDS = 2;

/** Session ids are server-generated UUIDs; anything else never becomes a filename. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Characters that need no quoting in any POSIX shell. */
const SHELL_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** POSIX single-quote a path for the shell Claude Code runs `command` in. */
export function shellQuote(value: string): string {
  if (value !== '' && SHELL_SAFE.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * True when the client already asked for its own settings file (the custom-command
 * escape hatch). We never override a user's explicit `--settings`; that session
 * simply gets no app status line.
 */
export function hasSettingsArg(args: readonly string[]): boolean {
  return args.some((arg) => arg === '--settings' || arg.startsWith('--settings='));
}

/**
 * The session's permission mode as the status line should describe it, read off
 * the launch argv. No `--permission-mode` at all means Claude Code's default
 * (ask every time). The LAST occurrence wins, matching the CLI parser.
 */
export function parsePermissionMode(args: readonly string[]): StatuslineMode {
  let raw: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    // `?? ''` so a dangling `--permission-mode` at the end of the argv is
    // 'unknown' (a mode was asked for, we cannot name it) and not 'default'.
    if (arg === '--permission-mode') raw = args[i + 1] ?? '';
    else if (arg.startsWith('--permission-mode=')) raw = arg.slice('--permission-mode='.length);
  }
  if (raw === undefined) return 'default';
  return (KNOWN_MODES as readonly string[]).includes(raw) ? (raw as ClaudePermissionMode) : 'unknown';
}

export interface SessionSettingsConfig {
  /** Directory the per-session files live in (created 0700, wiped at boot). */
  dir: string;
  /** Absolute path of statusline.mjs. */
  scriptPath: string;
  /** Absolute path of prefs.json — the script re-reads it on every invocation. */
  prefsFile: string;
  /** Absolute path of the node binary to run the script with (process.execPath). */
  nodePath: string;
}

export class SessionSettingsStore {
  readonly #config: SessionSettingsConfig;
  readonly #log: Logger;

  constructor(config: SessionSettingsConfig, log: Logger) {
    this.#config = config;
    this.#log = log;
  }

  /** Wipe and recreate the directory (0700). Called once at boot. */
  resetDir(): void {
    try {
      rmSync(this.#config.dir, { recursive: true, force: true });
    } catch (err) {
      this.#log('warn', `could not clear ${this.#config.dir}: ${String(err)}`);
    }
    try {
      mkdirSync(this.#config.dir, { recursive: true, mode: 0o700 });
    } catch (err) {
      this.#log('error', `could not create ${this.#config.dir}: ${String(err)}`);
    }
  }

  fileFor(id: string): string {
    return join(this.#config.dir, `${id}.json`);
  }

  /** The `statusLine.command` shell string for one session's mode. */
  command(mode: StatuslineMode): string {
    return [this.#config.nodePath, this.#config.scriptPath, mode, this.#config.prefsFile]
      .map(shellQuote)
      .join(' ');
  }

  /**
   * Write the session's settings file and return its path, or undefined if it
   * could not be written — in which case the session still launches, just
   * without a status line. A status line is never worth failing a spawn over.
   */
  write(id: string, mode: StatuslineMode): string | undefined {
    if (!SAFE_ID.test(id)) {
      this.#log('warn', `refusing to write session settings for unusual session id ${JSON.stringify(id)}`);
      return undefined;
    }
    const file = this.fileFor(id);
    const body = {
      statusLine: {
        type: 'command',
        command: this.command(mode),
        refreshInterval: STATUSLINE_REFRESH_SECONDS,
      },
    };
    try {
      mkdirSync(this.#config.dir, { recursive: true, mode: 0o700 });
      writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
      return file;
    } catch (err) {
      this.#log('warn', `could not write ${file}, session gets no status line: ${String(err)}`);
      return undefined;
    }
  }

  /** Delete a session's file. Idempotent; a missing file is not an error. */
  remove(id: string): void {
    if (!SAFE_ID.test(id)) return;
    try {
      unlinkSync(this.fileFor(id));
    } catch {
      // Already gone (exit then delete is the normal path).
    }
  }
}
