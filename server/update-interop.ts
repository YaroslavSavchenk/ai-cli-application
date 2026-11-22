/**
 * IN-APP UPDATE, part 2 — the REAL Windows launch of the verified Setup over
 * WSL interop (phase E, 2026-09-09; decision in
 * `memory/decisions/in-app-update.md`): `createInteropLauncher`, the
 * `launchSetup` that server/update-install.ts's pipeline is given, with the
 * `%TEMP%` probe under it, the absolute interop paths, and the checks every
 * Windows string passes before it reaches an argv slot (`assertWindowsArg`).
 *
 * THE SEAM IS A HARD CONSTRAINT: the interop spawn is argv-only, absolute
 * paths, no shell, no `-Command`, and every Windows string passes a charset
 * and length gate first.
 *
 * Split from server/update-install.ts (PLAN-QUALITY Q13, 2026-11-22), moved
 * unchanged; importers take it from here. Sibling: server/update-install.ts
 * (download, verify, UpdateController, UpdateFailure).
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { UPDATE_ERROR_START } from '../shared/protocol.ts';
import { runCapture } from './config.ts';
import { errorClass, oneLine, scoped, type Logger, type LogLevel } from './config-log.ts';
import { UpdateFailure, type LaunchSetup, type LaunchSetupArgs } from './update-install.ts';

/** How much of run-update.ps1's stdout is kept for server.log. */
export const MAX_SCRIPT_OUTPUT_BYTES = 64 * 1024;
/** After the child exits, how long its stdout pipe may still deliver a tail. */
const SCRIPT_OUTPUT_FLUSH_MS = 1_000;

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
const SHA256_SHAPE = /^[0-9a-f]{64}$/;

/** A Windows string that may become an argv slot, or a refusal. */
export function assertWindowsArg(value: string, what: string): string {
  if (!WINDOWS_ARG_SHAPE.test(value)) {
    throw new UpdateFailure(UPDATE_ERROR_START, `the Windows ${what} is not a usable path`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// The REAL Windows launch (WSL interop). Injected into UpdateController;
// unreachable in tests.
// ---------------------------------------------------------------------------

interface WindowsTemp {
  /** `C:\Users\<user>\AppData\Local\Temp` — validated, no trailing separator. */
  win: string;
  /** The same directory as WSL sees it: `/mnt/c/...`, proven to be a directory. */
  linux: string;
}

/**
 * Run an interop helper and return its stdout (server/config.ts runCapture:
 * bounded, argv only, no shell, SIGKILL at 15 s); a failure becomes the
 * UPDATE_ERROR_START refusal with the helper's name and what went wrong.
 */
async function runInterop(command: string, args: string[]): Promise<string> {
  try {
    return await runCapture(command, args);
  } catch (err) {
    const what = err instanceof Error ? err.message : String(err);
    throw new UpdateFailure(UPDATE_ERROR_START, `${basename(command)} ${what}`);
  }
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
async function probeWindowsTemp(): Promise<WindowsTemp> {
  const raw = (await runInterop(CMD_PATH, ['/c', 'echo', '%TEMP%'])).split('\n')[0] ?? '';
  const win = raw.replace(/[\r\n]+$/, '').trim().replace(/\\+$/, '');
  if (!WINDOWS_TEMP_SHAPE.test(win) || win.includes('%')) {
    throw new UpdateFailure(UPDATE_ERROR_START, 'Windows did not report a usable temp directory');
  }
  const wslpath = existsSync(WSLPATH_PATH) ? WSLPATH_PATH : 'wslpath';
  const linux = ((await runInterop(wslpath, ['-u', win])).split('\n')[0] ?? '').trim();
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

interface InteropLauncherOptions {
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
