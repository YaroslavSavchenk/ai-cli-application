/**
 * Phase E, part 2 — the interop launcher (server/update-install.ts
 * `createInteropLauncher`): the exact argv contract with
 * `launcher/run-update.ps1`, the staging copy, the length checks on argv
 * slots, the script output a failed run logs, and the refusals before any
 * spawn.
 *
 * How: a FAKE spawn and a fake child (a real stdout pipe, `exit` on demand,
 * counted unref()s), on a real temp filesystem — so the contract is pinned
 * without a Windows machine.
 *
 * NOT claimed here: that PowerShell, cmd.exe and wslpath really behave as
 * the argv assumes — only a Windows run shows that (the user's Windows
 * check).
 *
 * Split out of `tests/server/update-install.test.ts` by topic
 * (PLAN-RESTRUCTURE O6); the asset server and the controller harness are
 * `tests/helpers/update-install-fixture.ts`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  UPDATE_ERROR_START,
} from '../../shared/protocol.ts';
import {
  createInteropLauncher,
  MAX_SCRIPT_OUTPUT_BYTES,
  UpdateFailure,
  POWERSHELL_PATH,
  RUN_UPDATE_SCRIPT,
  STAGING_DIR_NAME,
  type LaunchSetupArgs,
  type SpawnLike,
} from '../../server/update-install.ts';
import { setupAssetName } from '../../server/update-release.ts';
import {
  makeTempDir,
  removeTempDir,
} from '../helpers/helpers.ts';
import {
  VERSION,
  SETUP_NAME,
  SETUP_BYTES,
  SETUP_SHA,
} from '../helpers/update-install-fixture.ts';

// ---------------------------------------------------------------------------
// The interop launcher — the exact argv contract with launcher/run-update.ps1
// ---------------------------------------------------------------------------

/**
 * A fake child process: a real stdout pipe (so the capture path is exercised),
 * `exit` on demand, and counted unref()s — on the child AND on the pipe, which
 * must never hold the backend's event loop.
 */
function fakeChild(): {
  child: ChildProcess;
  exit: (code: number) => void;
  say: (text: string) => void;
  endOut: () => void;
  unrefs: number;
  stdoutUnrefs: number;
} {
  const emitter = new EventEmitter() as ChildProcess;
  const state = { unrefs: 0, stdoutUnrefs: 0 };
  const stdout = new PassThrough() as PassThrough & { unref: () => void };
  stdout.unref = (): void => {
    state.stdoutUnrefs += 1;
  };
  (emitter as unknown as { stdout: PassThrough }).stdout = stdout;
  (emitter as unknown as { unref: () => void }).unref = () => {
    state.unrefs += 1;
  };
  return {
    child: emitter,
    exit: (code) => emitter.emit('exit', code, null),
    say: (text) => stdout.write(text),
    endOut: () => stdout.end(),
    get unrefs() {
      return state.unrefs;
    },
    get stdoutUnrefs() {
      return state.stdoutUnrefs;
    },
  };
}

test('interop launcher: the exact argv, the staging copy, and a detached-but-watched child', async () => {
  const root = await makeTempDir('ai-sm-update-interop-');
  try {
    // A fake install: <appDir>/launcher/run-update.ps1 is what the bundle ships.
    const appDir = join(root, 'app', VERSION);
    mkdirSync(join(appDir, 'launcher'), { recursive: true });
    writeFileSync(join(appDir, 'launcher', RUN_UPDATE_SCRIPT), '# the windows script\n');
    // The verified exe, where the pipeline leaves it.
    const updates = join(root, 'data', 'updates', VERSION);
    mkdirSync(updates, { recursive: true });
    writeFileSync(join(updates, SETUP_NAME), SETUP_BYTES);
    // The Windows %TEMP%, as WSL sees it.
    const tempLinux = join(root, 'wintemp');
    mkdirSync(tempLinux, { recursive: true });

    let seen: { command: string; args: readonly string[]; options: Record<string, unknown> } | undefined;
    const fake = fakeChild();
    const spawnImpl: SpawnLike = (command, args, options) => {
      seen = { command, args, options: options as Record<string, unknown> };
      // What the script prints on a real run — the backend's only diagnostic.
      fake.say('Starting AI-Session-Manager-Setup-v0.3.0.exe (silent).\n');
      fake.say('Setup exited with code 0.\n');
      // Exit on the next tick, like a real process would.
      setTimeout(() => {
        fake.endOut();
        fake.exit(0);
      }, 5);
      return fake.child;
    };
    const lines: string[] = [];
    const launch = createInteropLauncher({
      log: (level, message) => lines.push(`${level} ${message}`),
      appDir,
      probeTemp: () => Promise.resolve({ win: 'C:\\Users\\Test User\\AppData\\Local\\Temp', linux: tempLinux }),
      spawnImpl,
    });

    const code = await launch({
      version: VERSION,
      setupPath: join(updates, SETUP_NAME),
      setupName: SETUP_NAME,
      expectedSha: SETUP_SHA,
    });
    assert.equal(code, 0, 'the exit code is reported back to the pipeline');

    const stageWin = `C:\\Users\\Test User\\AppData\\Local\\Temp\\${STAGING_DIR_NAME}\\${VERSION}`;
    assert.equal(seen?.command, POWERSHELL_PATH, 'the full interop path, never a PATH lookup');
    assert.deepEqual(seen?.args, [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      `${stageWin}\\${RUN_UPDATE_SCRIPT}`,
      '-SetupPath',
      `${stageWin}\\${SETUP_NAME}`,
      '-ExpectedSha',
      SETUP_SHA,
      '-LogPath',
      `${stageWin}\\setup.log`,
    ]);
    assert.equal(seen?.options['detached'], true);
    assert.deepEqual(
      seen?.options['stdio'],
      ['ignore', 'pipe', 'ignore'],
      'stdout is read so the script can be diagnosed; stdin and stderr stay closed',
    );
    assert.ok(!JSON.stringify(seen?.args).includes('-Command'), 'never -Command');
    assert.equal(fake.unrefs, 1, 'the Setup must not keep this backend alive');
    assert.equal(fake.stdoutUnrefs, 1, 'and neither may its stdout pipe');

    // Every printed line reached server.log, at debug after exit 0.
    assert.deepEqual(
      lines.filter((l) => l.includes('run-update.ps1:')),
      [
        'debug [update] run-update.ps1: Starting AI-Session-Manager-Setup-v0.3.0.exe (silent).',
        'debug [update] run-update.ps1: Setup exited with code 0.',
      ],
    );

    // The staging copy really happened, through plain fs (no Windows path on
    // any command line during it).
    const stageLinux = join(tempLinux, STAGING_DIR_NAME, VERSION);
    assert.deepEqual(await readFile(join(stageLinux, SETUP_NAME)), SETUP_BYTES);
    assert.equal(await readFile(join(stageLinux, RUN_UPDATE_SCRIPT), 'utf8'), '# the windows script\n');
  } finally {
    await removeTempDir(root);
  }
});

test('interop launcher: a 170-character %TEMP% still composes argv slots that fit', async () => {
  // The %TEMP% gate caps at 180 characters and the argv gate at 259
  // (MAX_PATH - 1) exactly so this case works: staging adds the directory
  // name, the version and the Setup name on top of whatever Windows reports.
  const root = await makeTempDir('ai-sm-update-longtemp-');
  try {
    const appDir = join(root, 'app', VERSION);
    mkdirSync(join(appDir, 'launcher'), { recursive: true });
    writeFileSync(join(appDir, 'launcher', RUN_UPDATE_SCRIPT), '# x\n');
    const updates = join(root, 'data', 'updates', VERSION);
    mkdirSync(updates, { recursive: true });
    writeFileSync(join(updates, SETUP_NAME), SETUP_BYTES);
    const tempLinux = join(root, 'wintemp');
    mkdirSync(tempLinux, { recursive: true });

    // 170 characters, spaces included, exactly as cmd.exe could print it.
    const longTemp = `C:\\Users\\Test User\\${'d'.repeat(146)}\\Temp`;
    assert.equal(longTemp.length, 170);

    let seen: readonly string[] | undefined;
    const fake = fakeChild();
    const code = await createInteropLauncher({
      log: () => {},
      appDir,
      probeTemp: () => Promise.resolve({ win: longTemp, linux: tempLinux }),
      spawnImpl: (_command, args) => {
        seen = args;
        setTimeout(() => {
          fake.endOut();
          fake.exit(0);
        }, 5);
        return fake.child;
      },
    })({
      version: VERSION,
      setupPath: join(updates, SETUP_NAME),
      setupName: SETUP_NAME,
      expectedSha: SETUP_SHA,
    });
    assert.equal(code, 0, 'no argv slot was refused for being too long');
    const setupWin = `${longTemp}\\${STAGING_DIR_NAME}\\${VERSION}\\${SETUP_NAME}`;
    assert.ok(seen?.includes(setupWin), `${setupWin} (${setupWin.length} chars) is not in ${String(seen)}`);
    assert.ok(setupWin.length > 200, 'and it is longer than the old 200-character cap allowed');
    assert.ok(setupWin.length <= 259, 'while still fitting MAX_PATH - 1');
  } finally {
    await removeTempDir(root);
  }
});

test('interop launcher: the composed staged path is length-checked BEFORE anything is staged', async () => {
  // The gate that matters is not %TEMP% (180) or the argv cap (259) on their
  // own, but `<temp>\ai-session-manager-update\<version>\<setup name>`. With the
  // longest legal %TEMP% and a long release tag it does not fit — and the
  // refusal has to come before the ~100 MiB staging copy, not after it.
  const root = await makeTempDir('ai-sm-update-maxpath-');
  try {
    const appDir = join(root, 'app', VERSION);
    mkdirSync(join(appDir, 'launcher'), { recursive: true });
    writeFileSync(join(appDir, 'launcher', RUN_UPDATE_SCRIPT), '# x\n');
    const tempLinux = join(root, 'wintemp');
    mkdirSync(tempLinux, { recursive: true });
    // 180 characters: the longest value WINDOWS_TEMP_SHAPE accepts.
    const maxTemp = `C:\\Users\\Test User\\${'d'.repeat(156)}\\Temp`;
    assert.equal(maxTemp.length, 180);

    let spawns = 0;
    const launch = (version: string, setupName: string): Promise<number> => {
      const updates = join(root, 'data', 'updates', version);
      mkdirSync(updates, { recursive: true });
      writeFileSync(join(updates, setupName), SETUP_BYTES);
      const fake = fakeChild();
      return createInteropLauncher({
        log: () => {},
        appDir,
        probeTemp: () => Promise.resolve({ win: maxTemp, linux: tempLinux }),
        spawnImpl: () => {
          spawns += 1;
          setTimeout(() => {
            fake.endOut();
            fake.exit(0);
          }, 5);
          return fake.child;
        },
      })({ version, setupPath: join(updates, setupName), setupName, expectedSha: SETUP_SHA });
    };

    // Fitting: the same maximal %TEMP% with a normal release tag still runs.
    assert.equal(await launch(VERSION, SETUP_NAME), 0);
    assert.equal(spawns, 1);
    assert.ok(existsSync(join(tempLinux, STAGING_DIR_NAME, VERSION, SETUP_NAME)), 'it was staged');

    // Refused: a 40-character tag pushes the composed path past MAX_PATH - 1.
    const longTag = `v0.3.0-${'a'.repeat(33)}`;
    assert.equal(longTag.length, 40);
    const longName = setupAssetName(longTag);
    assert.ok(
      `${maxTemp}\\${STAGING_DIR_NAME}\\${longTag}\\${longName}`.length > 259,
      'the case is only interesting if it really does not fit',
    );
    // A sentinel inside the staging directory: staging starts by removing that
    // whole directory, so the sentinel surviving is proof that the refusal
    // happened BEFORE any staging work — not after it, with a tidy-up.
    const stage = join(tempLinux, STAGING_DIR_NAME, longTag);
    mkdirSync(stage, { recursive: true });
    writeFileSync(join(stage, 'sentinel'), 'untouched\n');
    await assert.rejects(
      launch(longTag, longName),
      (err: unknown) => err instanceof UpdateFailure && err.sentence === UPDATE_ERROR_START,
    );
    assert.equal(spawns, 1, 'nothing was spawned for the refused one');
    assert.equal(
      readFileSync(join(stage, 'sentinel'), 'utf8'),
      'untouched\n',
      'the staging directory was never even cleared, so nothing was copied into %TEMP%',
    );
    assert.ok(!existsSync(join(stage, longName)), 'and the Setup itself certainly was not');
  } finally {
    await removeTempDir(root);
  }
});

test('interop launcher: a FAILED run writes the script output at warn, capped at 64 KiB', async () => {
  const root = await makeTempDir('ai-sm-update-interop3-');
  try {
    const appDir = join(root, 'app', VERSION);
    mkdirSync(join(appDir, 'launcher'), { recursive: true });
    writeFileSync(join(appDir, 'launcher', RUN_UPDATE_SCRIPT), '# the windows script\n');
    const updates = join(root, 'data', 'updates', VERSION);
    mkdirSync(updates, { recursive: true });
    writeFileSync(join(updates, SETUP_NAME), SETUP_BYTES);
    const tempLinux = join(root, 'wintemp');
    mkdirSync(tempLinux, { recursive: true });

    const fake = fakeChild();
    const lines: string[] = [];
    const launch = createInteropLauncher({
      log: (level, message) => lines.push(`${level} ${message}`),
      appDir,
      probeTemp: () => Promise.resolve({ win: 'C:\\Temp', linux: tempLinux }),
      spawnImpl: () => {
        fake.say('ERROR: the Setup could not be started (Access is denied).\n');
        fake.say('setup.log: 2026-09-09 12:00:00.000   Setup version: Inno Setup 6\n');
        // Past the cap: kept up to 64 KiB, everything after it dropped.
        fake.say(`${'x'.repeat(MAX_SCRIPT_OUTPUT_BYTES)}\nNEVER-LOGGED\n`);
        setTimeout(() => {
          fake.endOut();
          fake.exit(3);
        }, 5);
        return fake.child;
      },
    });

    const code = await launch({
      version: VERSION,
      setupPath: join(updates, SETUP_NAME),
      setupName: SETUP_NAME,
      expectedSha: SETUP_SHA,
    });
    assert.equal(code, 3, 'the script\'s own refusal code reaches the pipeline');

    const script = lines.filter((l) => l.includes('run-update.ps1:'));
    assert.ok(
      script.every((l) => l.startsWith('warn ')),
      'a non-zero exit makes every captured line a warn',
    );
    assert.ok(
      script[0]?.endsWith('run-update.ps1: ERROR: the Setup could not be started (Access is denied).'),
      'the script\'s own message',
    );
    assert.ok(
      script[1]?.includes('setup.log: 2026-09-09 12:00:00.000   Setup version: Inno Setup 6'),
      'and the Setup log tail it printed before deleting the staging directory',
    );
    assert.ok(!lines.some((l) => l.includes('NEVER-LOGGED')), 'nothing past the cap is written');
    assert.ok(
      lines.includes('warn [update] run-update.ps1: (further output dropped)'),
      'the truncation is stated, not hidden',
    );
  } finally {
    await removeTempDir(root);
  }
});

test('interop launcher: a bundle without run-update.ps1, and a bad hash, refuse before any spawn', async () => {
  const root = await makeTempDir('ai-sm-update-interop2-');
  try {
    const appDir = join(root, 'app', VERSION);
    mkdirSync(appDir, { recursive: true });
    const updates = join(root, 'updates', VERSION);
    mkdirSync(updates, { recursive: true });
    writeFileSync(join(updates, SETUP_NAME), SETUP_BYTES);
    let spawns = 0;
    const spawnImpl: SpawnLike = () => {
      spawns += 1;
      return fakeChild().child;
    };
    const launch = createInteropLauncher({
      log: () => {},
      appDir,
      probeTemp: () => Promise.resolve({ win: 'C:\\Temp', linux: root }),
      spawnImpl,
    });
    const args: LaunchSetupArgs = {
      version: VERSION,
      setupPath: join(updates, SETUP_NAME),
      setupName: SETUP_NAME,
      expectedSha: SETUP_SHA,
    };
    await assert.rejects(
      launch(args),
      (err: unknown) => err instanceof UpdateFailure && err.sentence === UPDATE_ERROR_START,
      'no run-update.ps1 in this install',
    );
    // Now the script exists, but the hash is not a sha256.
    mkdirSync(join(appDir, 'launcher'), { recursive: true });
    writeFileSync(join(appDir, 'launcher', RUN_UPDATE_SCRIPT), '# x\n');
    await assert.rejects(
      launch({ ...args, expectedSha: 'nope' }),
      (err: unknown) => err instanceof UpdateFailure && err.sentence === UPDATE_ERROR_START,
    );
    assert.equal(spawns, 0, 'nothing was ever spawned');
  } finally {
    await removeTempDir(root);
  }
});
