/**
 * `launcher/start-backend.sh` — the Linux half of the Windows launcher, and now
 * also the start script an INSTALLED bundle ships inside itself.
 *
 * Why this file exists: the script is the one piece of the launch chain that
 * decides WHICH node runs the backend and FROM WHERE, and both answers changed
 * when the app grew a self-contained bundle:
 *
 *   - a bundle carries its own `node/bin/node`, compiled-against-by node-pty,
 *     and it must win outright — no version probe, no "a newer node is on PATH"
 *     cleverness. A developer clone has no such file and keeps the old
 *     PATH → nvm → exit 11/12 resolution;
 *   - installed, the script is started through `<app>/current/launcher/…`, and
 *     `current` is a symlink the next update moves. Node resolves its own path
 *     to a REAL path at import time, so the cwd has to be the physical version
 *     dir too; a cwd left on the symlink would, after an update, serve one
 *     version's server code with the next version's `web/dist` and
 *     `node_modules`.
 *
 * How: a throwaway app tree with a `node` that is a shell stub recording its
 * argv, cwd and AI_SM_DATA_DIR to a marker file. That makes "which runtime did
 * it start, from which directory" an assertion over a file rather than an
 * inference. PATH is replaced entirely by a minimal bin dir (symlinks to the
 * few externals the script uses), so nothing about the developer's own machine
 * — a real node, an nvm install, the ambient HOME — can leak into a result.
 *
 * Nothing here starts a real server: the stub exits immediately, and every data
 * dir is inside the temp tree.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { projectRoot, waitUntil } from './helpers.ts';

const SCRIPT = join(projectRoot, 'launcher', 'start-backend.sh');
/** Absolute: one test replaces PATH entirely, so a bare `bash` would not resolve. */
const BASH = '/bin/bash';
/** The version directory name an installed bundle unpacks to. */
const VERSION = 'v0.2.0';
/** The version a Setup run unpacks BESIDE it and points `current` at. */
const NEXT_VERSION = 'v0.3.0';

// --- environment probing ----------------------------------------------------

function onPath(exe: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, exe);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

/** The externals the script itself calls. Without them there is nothing to test. */
const EXTERNALS = ['dirname', 'setsid', 'nohup'] as const;
const resolvedExternals = new Map<string, string>();
for (const exe of EXTERNALS) {
  const p = onPath(exe);
  if (p) resolvedExternals.set(exe, p);
}
const missing = EXTERNALS.filter((e) => !resolvedExternals.has(e));
const skip: string | false =
  missing.length > 0 ? `${missing.join(', ')} not on PATH` : false;

// --- the fake app tree ------------------------------------------------------

interface AppOptions {
  /** Major version the BUNDLED stub answers to `node -p …`; omitted = no bundled node. */
  bundledNode?: { major: number } | undefined;
  /** Major version the PATH stub answers; omitted = no `node` on PATH at all. */
  pathNode?: { major: number } | undefined;
}

interface App {
  root: string;
  /** `<root>/app/<VERSION>` — the physical version dir. */
  versionDir: string;
  /** `<root>/app/current` — the symlink an installed launch goes through. */
  currentDir: string;
  binDir: string;
  /** What the bundled / PATH stub recorded, or null when it never ran. */
  marker(which: 'bundled' | 'path' | 'next'): Promise<Record<string, string> | null>;
}

/**
 * A `node` stub. Two behaviours in one file, because the script uses the same
 * name for both jobs:
 *   `node -p '…'`  → the version probe: print a major version and exit.
 *   anything else  → the launch: record argv + cwd + $0 + data dir, then exit 0.
 * `self` (=$0) is the path the script actually EXECUTED, which is the only way
 * to tell a physical runtime path from one that still runs through `current`;
 * `pwd -P` alone cannot — it resolves the symlink either way.
 * The probe must NOT write the marker — "was this runtime probed" and "was this
 * runtime started" are different questions, and one test turns on the answer.
 * `end=1` is written LAST and is the completeness marker: the redirect creates
 * the file on the first printf, so a reader that only checks existence can
 * parse a half-written record (measured: ~5% of runs read a marker with `cwd`
 * but no `argc`). `markerOf` waits for `end`.
 */
function nodeStub(major: number, markerFile: string): string {
  return `#!/bin/sh
if [ "$1" = "-p" ]; then
  printf '%s\\n' '${major}'
  exit 0
fi
{
  printf 'cwd=%s\\n' "$(pwd -P)"
  printf 'pwd=%s\\n' "\${PWD:-}"
  printf 'self=%s\\n' "$0"
  printf 'datadir=%s\\n' "\${AI_SM_DATA_DIR:-}"
  printf 'argc=%s\\n' "$#"
  n=1
  for a in "$@"; do
    printf 'arg%s=%s\\n' "$n" "$a"
    n=$((n + 1))
  done
  printf 'end=1\\n'
} > '${markerFile}'
exit 0
`;
}

async function makeApp(opts: AppOptions = {}): Promise<App> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-sm-startbe-')));
  const versionDir = join(root, 'app', VERSION);
  await mkdir(join(versionDir, 'launcher'), { recursive: true });
  await copyFile(SCRIPT, join(versionDir, 'launcher', 'start-backend.sh'));
  await symlink(VERSION, join(root, 'app', 'current'));

  // A PATH holding exactly the externals the script calls — and, when the test
  // asks for it, a `node`. Nothing else from the developer's machine.
  const binDir = join(root, 'bin');
  await mkdir(binDir);
  for (const [name, target] of resolvedExternals) {
    await symlink(target, join(binDir, name));
  }

  if (opts.bundledNode) {
    await mkdir(join(versionDir, 'node', 'bin'), { recursive: true });
    await writeFile(
      join(versionDir, 'node', 'bin', 'node'),
      nodeStub(opts.bundledNode.major, join(root, 'marker-bundled')),
      { mode: 0o755 },
    );
  }
  if (opts.pathNode) {
    await writeFile(
      join(binDir, 'node'),
      nodeStub(opts.pathNode.major, join(root, 'marker-path')),
      { mode: 0o755 },
    );
  }

  return {
    root,
    versionDir,
    currentDir: join(root, 'app', 'current'),
    binDir,
    async marker(which) {
      let raw: string;
      try {
        raw = await readFile(join(root, `marker-${which}`), 'utf8');
      } catch {
        return null;
      }
      const out: Record<string, string> = {};
      for (const line of raw.split('\n')) {
        const eq = line.indexOf('=');
        if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
      }
      return out;
    },
  };
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Run the copied script the way the launcher does — `bash <script> <datadir>` —
 * with the fake bin dir as the WHOLE PATH and HOME/NVM_DIR pointed into the
 * temp tree (a real ~/.nvm on the build machine would otherwise be sourced and
 * hand the script a working node the test never provided).
 */
function runScript(app: App, scriptPath: string, dataDir: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(BASH, [scriptPath, dataDir], {
      cwd: app.root,
      env: {
        PATH: app.binDir,
        HOME: app.root,
        NVM_DIR: join(app.root, 'no-nvm'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/**
 * The launch is `setsid --fork nohup …`: the script returns as soon as the
 * intermediate parent forks, so the stub may still be starting. Wait for its
 * marker instead of assuming it is already there.
 */
function markerOf(app: App, which: 'bundled' | 'path' | 'next'): Promise<Record<string, string>> {
  return waitUntil(
    async () => {
      // COMPLETE, not merely present: the stub's `{ … } > file` redirect
      // truncates the file before the first printf, so existence alone is a
      // race (it fired ~5% of runs). `end=1` is its last line.
      const m = await app.marker(which);
      return m !== null && m['end'] === '1' ? m : undefined;
    },
    `the ${which} node stub to finish recording its launch`,
    10_000,
    25,
  );
}

/** Give a launch that must NOT happen time to happen before denying it. */
async function assertNeverLaunched(app: App): Promise<void> {
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(await app.marker('bundled'), null, 'the bundled runtime was started');
  assert.equal(await app.marker('path'), null, 'a PATH node was started');
}

// --- 1. the bundled runtime -------------------------------------------------

test('start-backend: an installed bundle starts its OWN node, unprobed', { skip }, async () => {
  // The discriminator: the PATH node answers the version probe with 18, which
  // would exit 12. Reaching exit 0 through the bundled runtime proves the
  // probe never happened — the bundle's node is trusted by construction.
  const app = await makeApp({ bundledNode: { major: 18 }, pathNode: { major: 18 } });
  try {
    const dataDir = join(app.root, 'data');
    const r = await runScript(
      app,
      join(app.currentDir, 'launcher', 'start-backend.sh'),
      dataDir,
    );
    assert.equal(r.code, 0, `${r.stdout}${r.stderr}`);

    const m = await markerOf(app, 'bundled');
    assert.equal(await app.marker('path'), null, 'the PATH node must not be started');

    // Exactly one argument, and it is the server entry — relative, resolved
    // against the cwd below.
    assert.equal(m['argc'], '1');
    assert.equal(m['arg1'], 'server/index.ts');
    assert.equal(m['datadir'], dataDir);
  } finally {
    await rm(app.root, { recursive: true, force: true });
  }
});

test('start-backend: the cwd is the PHYSICAL version dir, not the `current` symlink', { skip }, async () => {
  const app = await makeApp({ bundledNode: { major: 24 } });
  try {
    // Started exactly as the installed launcher will: through `current`.
    const r = await runScript(
      app,
      join(app.currentDir, 'launcher', 'start-backend.sh'),
      join(app.root, 'data'),
    );
    assert.equal(r.code, 0, `${r.stdout}${r.stderr}`);

    const m = await markerOf(app, 'bundled');
    // The version dir, NOT `<root>/app/current`. An update that moves the
    // symlink under this running process must not move its file resolution.
    assert.equal(m['cwd'], app.versionDir);
    assert.notEqual(m['cwd'], app.currentDir);
    // `pwd -P` above resolves the symlink WHATEVER the script did, so on its own
    // it proves nothing. These two are the ones that can tell the difference:
    // the runtime path the script actually executed, and the logical $PWD it
    // exported. Both must be physical, or a later `current` flip would swap the
    // runtime and the module tree under a running process.
    assert.equal(m['self'], join(app.versionDir, 'node', 'bin', 'node'), 'the PHYSICAL runtime path');
    assert.equal(m['pwd'], app.versionDir, '$PWD is physical too, not `…/current`');
  } finally {
    await rm(app.root, { recursive: true, force: true });
  }
});

/** The flip test needs one external the others do not: `ln`. */
const flipSkip: string | false =
  skip !== false ? skip : onPath('ln') === null ? 'ln not on PATH' : false;

test('start-backend: `current` moving DURING the launch cannot swap the runtime', { skip: flipSkip }, async () => {
  // The real update, at its worst moment: the user runs the new Setup while the
  // launcher is starting the old backend. `current` is repointed between the
  // moment the script resolves its own directory and the moment it execs node.
  //
  // Deterministic, not timed: the flip is done BY the launch chain. `setsid` is
  // the last external the script calls, so a wrapper on PATH that repoints the
  // link and then execs the real setsid puts the flip exactly in that window.
  //
  // With a physical path the OLD version's runtime runs (the one whose server/
  // and node_modules the cwd points at); with a path that still contains
  // `current`, the NEXT version's node would be exec'd against this version's
  // tree — two halves of two different bundles in one process.
  const ln = onPath('ln') as string;
  const app = await makeApp({ bundledNode: { major: 24 } });
  try {
    // A second, complete version dir with its OWN node stub and marker file.
    const nextDir = join(app.root, 'app', NEXT_VERSION);
    await mkdir(join(nextDir, 'node', 'bin'), { recursive: true });
    await writeFile(
      join(nextDir, 'node', 'bin', 'node'),
      nodeStub(24, join(app.root, 'marker-next')),
      { mode: 0o755 },
    );

    // The wrapper: flip `current` to the new version, then hand over to the real
    // setsid with the arguments untouched. (The symlink makeApp put there points
    // at the system binary, so it has to go first — writing through it would try
    // to open /usr/bin/setsid.)
    await rm(join(app.binDir, 'setsid'));
    await writeFile(
      join(app.binDir, 'setsid'),
      `#!/bin/sh\n'${ln}' -sfn '${NEXT_VERSION}' '${app.currentDir}'\nexec '${resolvedExternals.get(
        'setsid',
      ) as string}' "$@"\n`,
      { mode: 0o755 },
    );

    const r = await runScript(app, join(app.currentDir, 'launcher', 'start-backend.sh'), join(app.root, 'data'));
    assert.equal(r.code, 0, `${r.stdout}${r.stderr}`);

    const m = await markerOf(app, 'bundled');
    assert.equal(
      m['self'],
      join(app.versionDir, 'node', 'bin', 'node'),
      'the runtime that ran is THIS version\'s, resolved before the link moved',
    );
    assert.equal(m['cwd'], app.versionDir);
    // And the link really did move — otherwise this test proves nothing.
    assert.equal(await realpath(app.currentDir), nextDir, 'the wrapper must have flipped `current`');
    await new Promise((res) => setTimeout(res, 300));
    assert.equal(
      await app.marker('next'),
      null,
      "the NEXT version's runtime must never be started against this version's tree",
    );
  } finally {
    await rm(app.root, { recursive: true, force: true });
  }
});

// --- 2. the developer clone: PATH → nvm → 11/12 -----------------------------

test('start-backend: with no bundled node it falls back to a PATH node >= 24', { skip }, async () => {
  const app = await makeApp({ pathNode: { major: 24 } });
  try {
    const dataDir = join(app.root, 'data');
    const r = await runScript(
      app,
      join(app.versionDir, 'launcher', 'start-backend.sh'),
      dataDir,
    );
    assert.equal(r.code, 0, `${r.stdout}${r.stderr}`);

    const m = await markerOf(app, 'path');
    assert.equal(await app.marker('bundled'), null);
    assert.equal(m['argc'], '1');
    assert.equal(m['arg1'], 'server/index.ts');
    assert.equal(m['cwd'], app.versionDir);
    assert.equal(m['datadir'], dataDir);
  } finally {
    await rm(app.root, { recursive: true, force: true });
  }
});

test('start-backend: a too-old PATH node exits 12 and starts nothing', { skip }, async () => {
  const app = await makeApp({ pathNode: { major: 18 } });
  try {
    const r = await runScript(
      app,
      join(app.versionDir, 'launcher', 'start-backend.sh'),
      join(app.root, 'data'),
    );
    assert.equal(r.code, 12, `${r.stdout}${r.stderr}`);
    await assertNeverLaunched(app);
  } finally {
    await rm(app.root, { recursive: true, force: true });
  }
});

test('start-backend: no node anywhere exits 11', { skip }, async () => {
  const app = await makeApp();
  try {
    const r = await runScript(
      app,
      join(app.versionDir, 'launcher', 'start-backend.sh'),
      join(app.root, 'data'),
    );
    assert.equal(r.code, 11, `${r.stdout}${r.stderr}`);
    await assertNeverLaunched(app);
  } finally {
    await rm(app.root, { recursive: true, force: true });
  }
});

// --- 3. the two argument/environment refusals -------------------------------

test('start-backend: a relative data dir exits 13 before anything starts', { skip }, async () => {
  // `~` that never expanded is the real case: the server would then create a
  // data dir wherever the cwd happened to be — inside the bundle.
  const app = await makeApp({ bundledNode: { major: 24 }, pathNode: { major: 24 } });
  try {
    const r = await runScript(
      app,
      join(app.versionDir, 'launcher', 'start-backend.sh'),
      '~/.ai-session-manager',
    );
    assert.equal(r.code, 13, `${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /data dir must be absolute/);
    await assertNeverLaunched(app);
  } finally {
    await rm(app.root, { recursive: true, force: true });
  }
});

test('start-backend: an unreachable app directory exits 10', { skip }, async () => {
  // The script is fed on STDIN with its cwd deleted underneath it, which is the
  // only way to reach the `cd` failure without a script file to read (a script
  // that can be read has, by definition, a reachable parent directory). `$0` is
  // then argv[0], so it is forced to the bare `bash` — with the absolute
  // `/bin/bash` node passes by default, `dirname "$0"/..` would resolve to
  // `/usr` and the script would happily run there. `./..` from a cwd that is
  // gone fails instead. Deleting AFTER the spawn and writing the script only
  // then makes it deterministic rather than a race.
  const app = await makeApp({ pathNode: { major: 24 } });
  try {
    const cwd = join(app.root, 'app', VERSION, 'launcher');
    const source = await readFile(SCRIPT, 'utf8');
    const result = await new Promise<RunResult>((resolve, reject) => {
      const child = spawn(BASH, ['-s', join(app.root, 'data')], {
        argv0: 'bash',
        cwd,
        env: {
          PATH: app.binDir,
          HOME: app.root,
          NVM_DIR: join(app.root, 'no-nvm'),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
      child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr }));
      setTimeout(() => {
        rm(join(app.root, 'app'), { recursive: true, force: true }).then(
          () => child.stdin.end(source),
          reject,
        );
      }, 50);
    });
    assert.equal(result.code, 10, `${result.stdout}${result.stderr}`);
    assert.equal(await app.marker('path'), null, 'nothing may be started');
  } finally {
    await rm(app.root, { recursive: true, force: true });
  }
});
