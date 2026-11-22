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
 *   - three server-known absolute paths: the node binary, statusline.mjs and
 *     prefs.json. The first two are this process's own (process.execPath,
 *     `<serverDir>/statusline.mjs`), or in installed mode the same two
 *     through `<app>/current` (Nocturne D9 P5, server/bundle.ts
 *     `statuslinePaths`: a session adopted after an update outlives the
 *     version dir it was spawned from) — derived from where this code runs,
 *     never from a request; and
 *   - one value out of a closed five-element enum (the four `--permission-mode`
 *     values plus 'unknown'), and
 *   - the session's SNAPSHOT path (Nocturne B1), which is `<snapshotDir>/<id>
 *     .json`: a server-known directory joined with the session id the caller
 *     already passed SAFE_ID (write() refuses anything else before it ever
 *     reaches here, so no `..`, no separator, no space, no NUL).
 * No client-supplied byte ever reaches it. Paths are still POSIX-quoted, so a
 * data dir containing a space or a quote cannot reshape the command either.
 *
 * BOTH directories are wiped at boot, except the files of the sessions a
 * pty-host still holds (Nocturne D9 P3: those survive a backend crash and are
 * adopted, and their Claude reads the settings file its argv names). Any
 * other settings file — or snapshot — outlived its session and is garbage.
 */
import { chmodSync, lstatSync, mkdirSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { claudePermissionFromFlag, type ClaudePermissionMode } from '../shared/protocol.ts';
import { describeError, scoped, type Logger } from './config.ts';

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
 * the launch argv. No `--permission-mode` at all (a session launched before
 * D5) is read as Always ask — though Claude Code then picks its own mode
 * (2.1.283 opened in `auto mode`), which is why the app now always passes one.
 * The LAST occurrence wins, matching the CLI parser.
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
  // The four modes this app launches with, by either name
  // (`claudePermissionFromFlag`): Always ask is `manual` since D5 — the name
  // Claude Code 2.1.287 documents — and `default` (hidden there, still parsed)
  // in a hand-typed or older argv, so both read 'default', as does "no
  // --permission-mode argument was passed". Claude Code accepts more (`auto`,
  // `dontAsk`): any OTHER explicit value becomes 'unknown' rather than being
  // mislabelled as one of ours.
  return claudePermissionFromFlag(raw) ?? 'unknown';
}

export interface SessionSettingsConfig {
  /** Directory the per-session files live in (created 0700, wiped at boot). */
  dir: string;
  /**
   * Directory the script writes its per-session status-line SNAPSHOT into
   * (`<snapshotDir>/<id>.json`, created 0700, wiped at boot). It is handed to
   * the script as its fourth argument; server/telemetry.ts watches it.
   */
  snapshotDir: string;
  /** Absolute path of statusline.mjs (installed: through `<app>/current`, D9 P5). */
  scriptPath: string;
  /** Absolute path of prefs.json — the script re-reads it on every invocation. */
  prefsFile: string;
  /** Absolute path of the node binary to run the script with (process.execPath; installed: `<app>/current/node/bin/node`, D9 P5). */
  nodePath: string;
}

export class SessionSettingsStore {
  readonly #config: SessionSettingsConfig;
  readonly #log: Logger;
  readonly #sslog: Logger;

  constructor(config: SessionSettingsConfig, log: Logger) {
    this.#config = config;
    this.#log = log;
    this.#sslog = scoped(log, 'session-settings');
  }

  /**
   * Wipe and recreate both directories (0700). Called once at boot.
   *
   * `keep` (D9 P3): the ids of sessions a pty-host still holds — the boot
   * adopts them, so their `<id>.json` in either directory stays (the
   * settings file is named in that Claude's argv; the snapshot is its last
   * status line). Everything else in the directories goes, as before.
   */
  resetDir(keep: ReadonlySet<string> = new Set()): void {
    for (const dir of [this.#config.dir, this.#config.snapshotDir]) {
      try {
        if (keep.size === 0) rmSync(dir, { recursive: true, force: true });
        else this.#wipeExcept(dir, keep);
      } catch (err) {
        this.#log('warn', `could not clear ${dir}: ${describeError(err)}`);
      }
      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        this.#sslog('debug', `reset ${dir} (0700, wiped at boot)`);
      } catch (err) {
        this.#log('error', `could not create ${dir}: ${describeError(err)}`);
      }
    }
  }

  /**
   * Remove every entry of `dir` but the `<id>.json` of a kept id. Anything
   * that is not a real directory (a link included — never listed through) is
   * removed whole, as the plain wipe does; a missing dir is fine.
   */
  #wipeExcept(dir: string, keep: ReadonlySet<string>): void {
    let st;
    try {
      st = lstatSync(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    if (!st.isDirectory()) {
      rmSync(dir, { recursive: true, force: true });
      return;
    }
    const names = readdirSync(dir);
    for (const name of names) {
      if (name.endsWith('.json') && keep.has(name.slice(0, -'.json'.length))) continue;
      rmSync(join(dir, name), { recursive: true, force: true });
    }
    // Kept, not recreated: the 0700 the plain wipe's mkdir gives, given here.
    chmodSync(dir, 0o700);
  }

  fileFor(id: string): string {
    return join(this.#config.dir, `${id}.json`);
  }

  /**
   * Where the script writes this session's status-line snapshot.
   *
   * Guarded like every other path this store composes: an unusual id must never
   * become a path word, whichever caller asks (write() already checks before it
   * calls, so nothing in the normal path changes).
   */
  snapshotFor(id: string): string {
    if (!SAFE_ID.test(id)) {
      throw new Error(`refusing to compose a snapshot path for unusual session id ${JSON.stringify(id)}`);
    }
    return join(this.#config.snapshotDir, `${id}.json`);
  }

  /**
   * The `statusLine.command` shell string for one session's mode.
   *
   * The session id is only ever the one write() already checked against
   * SAFE_ID — see the SECURITY note at the top of this file.
   */
  command(mode: StatuslineMode, id: string): string {
    return [
      this.#config.nodePath,
      this.#config.scriptPath,
      mode,
      this.#config.prefsFile,
      this.snapshotFor(id),
    ]
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
        command: this.command(mode, id),
        refreshInterval: STATUSLINE_REFRESH_SECONDS,
      },
    };
    try {
      mkdirSync(this.#config.dir, { recursive: true, mode: 0o700 });
      // The script writes its snapshot here on the very first turn, so the
      // directory must exist by then — and with the same 0700 as the rest.
      mkdirSync(this.#config.snapshotDir, { recursive: true, mode: 0o700 });
      writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
      this.#sslog('debug', `wrote ${file} for mode '${mode}'`);
      return file;
    } catch (err) {
      this.#log('warn', `could not write ${file}, session gets no status line: ${describeError(err)}`);
      return undefined;
    }
  }

  /**
   * Delete a session's settings file AND its snapshot. Idempotent; a missing
   * file is not an error. The snapshot goes with the session because it
   * describes a conversation that no longer runs — the last values stay in
   * memory on SessionInfo.telemetry, which is what an exited pane still shows.
   */
  remove(id: string): void {
    if (!SAFE_ID.test(id)) return;
    for (const file of [this.fileFor(id), this.snapshotFor(id)]) {
      try {
        unlinkSync(file);
        this.#sslog('debug', `removed ${file}`);
      } catch {
        // Already gone (exit then delete is the normal path).
      }
    }
  }
}
