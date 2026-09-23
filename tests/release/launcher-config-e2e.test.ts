/**
 * `launcher/launch.ps1`, `launcher/config-common.ps1` and
 * `launcher/make-shortcut.ps1` END TO END, through `powershell.exe` interop.
 *
 * What is pinned: a launcher with nothing to resolve (a folder under %TEMP%,
 * the installed shape) exits 1 and says so instead of guessing; a
 * launcher-config.json makes the same folder work and a corrupt one stops it;
 * `AI_SM_REPO_PATH` really crosses WSL interop with `WSLENV=<var>/w` and wins
 * over the location; a launcher copied to a path the allow-list rejects EXITS
 * 1 and never silently falls back to the author's repo (that would start a
 * backend for a repo the user does not have); `make-shortcut.ps1 -DryRun`
 * prints the resolved config and creates nothing.
 *
 * Read-only by construction: the only `launch.ps1` invocation on the WSL share
 * is `-Status` on a copy whose derived path is INVALID, so it dies at the
 * allow-list before it ever reaches `wsl.exe`; `make-shortcut.ps1` is only ever
 * run with `-DryRun`, and the user's Desktop shortcut is stat'ed before and
 * after to prove it.
 *
 * Split out of `launcher-config.test.ts` (restructure O6); the spawn helpers
 * are `tests/helpers/launcher-config-fixture.ts`. Skipped cleanly wherever
 * `powershell.exe` / `wslpath` are absent (CI's ubuntu runner has no Windows
 * side).
 *
 * NOT claimed: a launch that really starts a backend, or the Windows Setup
 * that writes launcher-config.json (`installer-helpers-powershell.test.ts`
 * reads that file back).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, copyFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { projectRoot, makeTempDir, removeTempDir, readSource } from '../helpers/helpers.ts';
import {
  DERIVABLE,
  powershell,
  run,
  skip,
  toWindowsPath,
  wslpathBin,
} from '../helpers/launcher-config-fixture.ts';

// --- end to end, on a real Windows path -------------------------------------
// A launcher folder under %TEMP% derives NOTHING (it is not a \\wsl.localhost
// path), which is exactly the installed shape - and the only way to exercise
// the empty-defaults failure and the config-file success for real.

/** Creates a directory on the Windows C: drive; returns both path forms. */
async function windowsTempLauncher(): Promise<{ linux: string; windows: string }> {
  const temp = await run(powershell!, ['-NoProfile', '-Command', '[Console]::Out.Write($env:TEMP)']);
  assert.equal(temp.code, 0, temp.out);
  const windowsRoot = temp.stdout.trim();
  assert.ok(windowsRoot, 'no %TEMP% on the Windows side');
  const linuxRoot = (await run(wslpathBin!, ['-u', windowsRoot])).stdout.trim();
  assert.ok(linuxRoot.startsWith('/mnt/'), `expected a /mnt path, got ${linuxRoot}`);
  const dir = await mkdtemp(join(linuxRoot, 'ai-sm-installed-'));
  for (const name of ['launch.ps1', 'config-common.ps1', 'make-shortcut.ps1', 'launch-silent.vbs']) {
    await copyFile(join(projectRoot, 'launcher', name), join(dir, name));
  }
  return { linux: dir, windows: await toWindowsPath(dir) };
}

test('launch.ps1 with nothing to resolve exits 1 and says so, instead of guessing', { skip }, async () => {
  const dir = await windowsTempLauncher();
  try {
    const res = await run(powershell!, [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      `${dir.windows}\\launch.ps1`,
      '-Status',
    ]);
    assert.equal(res.code, 1, `expected exit 1, got ${res.code}:\n${res.out}`);
    const flat = res.out.replaceAll('\n', ' ').replace(/ +/g, ' ');
    assert.ok(
      flat.includes('No launcher configuration found: this launcher does not know which WSL distro or which app directory to use.'),
      res.out,
    );
    assert.ok(flat.includes(`${dir.windows}\\launcher-config.json`), 'the message must name the file it wants');
    assert.ok(flat.includes('AI_SM_DISTRO and AI_SM_REPO_PATH'), res.out);
    // It died before touching anything.
    assert.ok(!res.out.includes('runtime.json'), res.out);
    assert.ok(!res.out.includes('Backend:'), res.out);
  } finally {
    await rm(dir.linux, { recursive: true, force: true });
  }
});

test('a launcher-config.json makes the same folder work, and a corrupt one stops it', { skip }, async () => {
  const dir = await windowsTempLauncher();
  try {
    // What the Setup writes.
    await writeFile(
      join(dir.linux, 'launcher-config.json'),
      '{\n  "distro": "Ubuntu-24.04",\n  "appPath": "/home/them/.ai-session-manager/app/current"\n}\n',
    );
    const dry = await run(powershell!, [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      `${dir.windows}\\make-shortcut.ps1`,
      '-DryRun',
    ]);
    assert.equal(dry.code, 0, dry.out);
    const flat = dry.out.replaceAll('\n', ' ').replace(/ +/g, ' ');
    assert.ok(
      flat.includes("Config: distro 'Ubuntu-24.04', repo '/home/them/.ai-session-manager/app/current' (from config file)"),
      dry.out,
    );
    // An installed launcher points its shortcut at ITSELF, not at a WSL share.
    assert.ok(flat.includes(`Launcher directory: ${dir.windows}`), dry.out);
    assert.ok(flat.includes(`Shortcut target: wscript.exe "${dir.windows}\\launch-silent.vbs"`), dry.out);
    assert.ok(flat.includes('AppUserModelID: AiSessionManager'), dry.out);
    assert.ok(dry.out.includes('-DryRun: nothing was created, copied or modified.'), dry.out);

    // Damage it: the launcher must stop with the file's own name in the error.
    await writeFile(join(dir.linux, 'launcher-config.json'), '{ "distro": ');
    const broken = await run(powershell!, [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      `${dir.windows}\\launch.ps1`,
      '-Status',
    ]);
    assert.equal(broken.code, 1, broken.out);
    const brokenFlat = broken.out.replaceAll('\n', ' ').replace(/ +/g, ' ');
    assert.ok(brokenFlat.includes('is not valid JSON'), broken.out);
    assert.ok(brokenFlat.includes('launcher-config.json'), broken.out);
    assert.ok(!broken.out.includes('runtime.json'), 'a corrupt config must stop before any WSL call');
  } finally {
    await rm(dir.linux, { recursive: true, force: true });
  }
});

// --- the env var really crosses into powershell.exe (WSLENV) -----------------

test('AI_SM_REPO_PATH crosses WSL interop with WSLENV=<var>/w and wins over the location', { skip }, async () => {
  // The README tells users to set these from Windows, but the launcher is also
  // started from inside WSL; without the /w flag the value never arrives at
  // powershell.exe at all, so the override would silently do nothing.
  const dir = await makeTempDir('ai-sm-lcfg-');
  try {
    const script = join(dir, 'env.ps1');
    await writeFile(
      script,
      String.raw`
$ErrorActionPreference = 'Stop'
. $args[0]
$r = Resolve-AiSmConfig -ScriptRoot $args[1] -DefaultDistro 'Ubuntu-24.04' -DefaultRepoPath '/default/repo'
[Console]::Out.Write("seen=[$($env:AI_SM_REPO_PATH)] repo=[$($r.RepoPath)] src=[$($r.RepoPathSource)] distro=[$($r.Distro)] dsrc=[$($r.DistroSource)]")
`,
      'ascii',
    );
    const res = await run(powershell!, [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      await toWindowsPath(script),
      await toWindowsPath(join(projectRoot, 'launcher', 'config-common.ps1')),
      DERIVABLE,
    ]);
    assert.equal(res.code, 0, res.out);
    assert.match(
      res.stdout,
      /seen=\[\] repo=\[\/home\/them\/ai-cli-application\] src=\[launcher location\]/,
      'without WSLENV the var must not reach powershell.exe',
    );

    const withEnv = await runWithEnv(script);
    assert.match(
      withEnv,
      /seen=\[\/srv\/from-wsl\] repo=\[\/srv\/from-wsl\] src=\[AI_SM_REPO_PATH\] distro=\[Ubuntu-22\.04\] dsrc=\[launcher location\]/,
      `expected the env override to win; got: ${withEnv}`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/** Same call as above but with the var exported across the interop boundary. */
async function runWithEnv(script: string): Promise<string> {
  const args = [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    await toWindowsPath(script),
    await toWindowsPath(join(projectRoot, 'launcher', 'config-common.ps1')),
    DERIVABLE,
  ];
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(powershell!, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        AI_SM_REPO_PATH: '/srv/from-wsl',
        // '/w' = share this var Windows-ward without path translation. '/u'
        // (WSL-ward only) would not reach powershell.exe.
        WSLENV: `${process.env.WSLENV ? `${process.env.WSLENV}:` : ''}AI_SM_REPO_PATH/w`,
      },
    });
    let out = '';
    // Same 60 s guard as run(): node:test has no default timeout, so a
    // powershell.exe that never returns would hang the suite, not fail it.
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`timed out after 60000ms: ${powershell} ${args.join(' ')}\n${out}`));
    }, 60_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c: string) => (out += c));
    child.stderr.on('data', (c: string) => (out += c));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve(out.replaceAll('\r', ''));
    });
  });
}

// --- end to end: a derived-but-invalid path must FAIL, never fall back -------

test('launch.ps1 -Status from a launcher copied to a spaced path exits 1 and never falls back to the built-in repo', { skip }, async () => {
  // The crown jewel of this change: derivation ALWAYS wins over the built-in
  // default once the location is a WSL path — even when what it derives is
  // unusable. Falling back here would start a backend for the author's repo
  // inside someone else's clone.
  const root = await makeTempDir('ai-sm-lcfg-');
  try {
    const repoDir = join(root, 'ai sm test');
    const launcherDir = join(repoDir, 'launcher');
    await mkdir(launcherDir, { recursive: true });
    for (const name of ['launch.ps1', 'config-common.ps1']) {
      await copyFile(join(projectRoot, 'launcher', name), join(launcherDir, name));
    }

    const res = await run(powershell!, [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      await toWindowsPath(join(launcherDir, 'launch.ps1')),
      '-Status',
    ]);

    assert.equal(res.code, 1, `expected exit 1, got ${res.code}:\n${res.out}`);
    // PowerShell hard-wraps console output, so compare on a whitespace-collapsed
    // copy rather than on the raw lines.
    const flat = res.out.replaceAll('\n', ' ').replace(/ +/g, ' ');
    assert.ok(
      flat.includes(`RepoPath must be an absolute Linux path without spaces or shell metacharacters, got: ${repoDir}`),
      `error must name the derived path; got:\n${res.out}`,
    );
    assert.ok(
      flat.includes(`Config: distro`) && flat.includes(`repo '${repoDir}' (from launcher location)`),
      `config line must report the derived repo and its source; got:\n${res.out}`,
    );
    assert.ok(
      flat.includes('This path was derived from where the launcher itself lives.'),
      `hint must be the derived-value one; got:\n${res.out}`,
    );

    // The whole point: no other repo may appear in the output, and nothing may
    // have reached the -Status branch (no wsl.exe, no runtime.json read). The
    // built-in defaults are empty since the installer exists, so there is not
    // even a value left to fall back TO - assert that too, in both scripts.
    for (const script of ['launch.ps1', 'make-shortcut.ps1']) {
      const text = readSource('launcher', script);
      assert.equal(
        /^\$DefaultRepoPath\s*=\s*'([^']*)'/m.exec(text)?.[1],
        '',
        `${script} must ship an EMPTY default repo path`,
      );
      assert.equal(
        /^\$DefaultDistro\s*=\s*'([^']*)'/m.exec(text)?.[1],
        '',
        `${script} must ship an EMPTY default distro`,
      );
    }
    assert.ok(
      !/\/home\/[a-z]+\/projects\//.test(res.out),
      `some other clone leaked into the output:\n${res.out}`,
    );
    assert.ok(!res.out.includes('runtime.json'), `must fail before touching runtime.json:\n${res.out}`);
    assert.ok(!res.out.includes('Backend:'), `must never reach the -Status report:\n${res.out}`);
  } finally {
    await removeTempDir(root);
  }
});

// --- make-shortcut.ps1 -DryRun is read-only ----------------------------------

/** `<Desktop>\AI Session Manager.lnk` + its mtime ticks, or `absent`. */
async function desktopShortcutStamp(): Promise<string> {
  const res = await run(powershell!, [
    '-NoProfile',
    '-Command',
    "$p = Join-Path ([Environment]::GetFolderPath('Desktop')) 'AI Session Manager.lnk'; " +
      'if (Test-Path -LiteralPath $p) { ' +
      "[Console]::Out.Write($p + '|' + (Get-Item -LiteralPath $p).LastWriteTimeUtc.Ticks + '|' + (Get-Item -LiteralPath $p).Length) " +
      "} else { [Console]::Out.Write($p + '|absent') }",
  ]);
  assert.equal(res.code, 0, res.out);
  return res.stdout.trim();
}

test('make-shortcut.ps1 -DryRun prints the resolved config and creates nothing', { skip }, async () => {
  const before = await desktopShortcutStamp();

  const res = await run(powershell!, [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    await toWindowsPath(join(projectRoot, 'launcher', 'make-shortcut.ps1')),
    '-DryRun',
  ]);

  assert.equal(res.code, 0, `expected exit 0, got ${res.code}:\n${res.out}`);
  const flat = res.out.replaceAll('\n', ' ').replace(/ +/g, ' ');
  // Run from inside the repo, so both values must come from the launcher's own
  // location — never from the built-in defaults.
  assert.match(flat, /Config: distro '[^']+', repo '[^']+' \(from launcher location\)/, res.out);
  assert.match(flat, /Launcher directory: \\\\wsl\.localhost\\/, res.out);
  assert.ok(
    flat.includes('Shortcut target: wscript.exe "\\\\wsl.localhost\\'),
    `dry run must name the wscript target; got:\n${res.out}`,
  );
  assert.ok(flat.includes('launch-silent.vbs"'), `target must be launch-silent.vbs; got:\n${res.out}`);
  assert.ok(flat.includes('AppUserModelID: AiSessionManager'), `got:\n${res.out}`);
  assert.ok(
    res.out.includes('-DryRun: nothing was created, copied or modified.'),
    `dry run must say it created nothing; got:\n${res.out}`,
  );
  // Nothing from the real path may have run.
  assert.ok(!res.out.includes('Shortcut written:'), `-DryRun wrote a shortcut:\n${res.out}`);
  assert.ok(!res.out.includes('Icon copied to'), `-DryRun copied the icon:\n${res.out}`);

  assert.equal(await desktopShortcutStamp(), before, 'the Desktop shortcut was modified by -DryRun');
});
