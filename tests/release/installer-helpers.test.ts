/**
 * `installer/helpers/*.ps1` — everything the Windows Setup actually decides,
 * parses, runs and deletes.
 *
 * Two halves, because two different things can be proven from WSL:
 *
 *  1. The CONSTANT SHELL SCRIPTS are extracted from the helpers and run under
 *     a real `sh`, against real tarballs, in a temp directory. That is where
 *     the destructive behaviour lives — unpack, `current` swap, retention,
 *     `rm -rf` — so it is pinned end to end rather than by inspection:
 *     retention keeps current + one previous, the directory a LIVE backend
 *     runs from is never pruned, a bundle whose native module does not load
 *     fails without moving `current`, and the uninstall script refuses every
 *     path that is not obviously ours. These run everywhere (no Windows).
 *
 *  2. The POWERSHELL SIDE is driven through `powershell.exe` interop with
 *     `-DryRun`, which prints the exact `wsl.exe` command line and touches
 *     nothing. Those command lines are pinned character for character: they
 *     are hand-built strings (.NET 4.8 has no ArgumentList), so their shape
 *     IS the injection-safety argument — `--exec` (never the default shell,
 *     which would expand everything a second time), a script containing no
 *     double quote, and values that passed the allow-list. Skipped where
 *     powershell.exe is absent (CI's ubuntu runner).
 *
 * Nothing here ever runs a helper for real against a distro: every
 * PowerShell invocation is `-DryRun` or `-ListFile` (a read of a committed
 * fixture), so no `wsl.exe` is ever spawned.
 *
 * This file holds half 1 (and the two text checks on the scripts); half 2 is
 * `installer-helpers-powershell.test.ts` (restructure O6). The scripts are
 * read by `tests/helpers/installer-helpers-fixture.ts`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  statSync,
  symlinkSync,
  utimesSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { sleep, makeTempDir, removeTempDir } from '../helpers/helpers.ts';
import {
  claudeCheckScript,
  probeScript,
  readHelper,
  removeScript,
  unpackScript,
} from '../helpers/installer-helpers-fixture.ts';

test('every constant shell script is free of double quotes', () => {
  // A double quote is what delimits the script on the Windows command line,
  // and .NET Framework 4.8 offers no argument-array API to escape around it.
  // This is the invariant the whole hand-built-command-line design rests on.
  for (const [name, script] of [
    ['install-bundle', unpackScript],
    ['uninstall-wsl', removeScript],
    ['wsl-probe', probeScript],
    ['install-thirdparty', claudeCheckScript],
  ] as const) {
    assert.ok(!script.includes('"'), `${name}: constant script contains a double quote`);
  }
  // Including the third-party command itself.
  const command = /^\$AiSmClaudeCommand = '([^']*)'$/m.exec(readHelper('install-thirdparty.ps1'))?.[1];
  assert.equal(command, 'curl -fsSL https://claude.ai/install.sh | bash');
});

test('the node-pty proof names its module through argv, not through quoting', () => {
  // `node -e 'require(process.argv[1])' node-pty`: the module name travels as
  // an ARGUMENT, so naming it needs neither a double quote (banned above) nor
  // a nested single quote (impossible inside a single-quoted sh word).
  assert.ok(
    unpackScript.includes("./node/bin/node -e 'require(process.argv[1])' node-pty"),
    unpackScript,
  );
});

// --- running the constant scripts under a real sh ---------------------------

interface ShResult {
  code: number | null;
  out: string;
}

function runSh(script: string, args: string[], stdin?: Buffer): Promise<ShResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', ['-c', script, 'sh', ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    // No default timeout exists in node:test, so a script that ever blocked
    // would hang the whole suite instead of failing it.
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`timed out after 60s: sh -c <script> sh ${args.join(' ')}\n${out}`));
    }, 60_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c: string) => (out += c));
    child.stderr.on('data', (c: string) => (out += c));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
    // A refusing script exits BEFORE it ever reads stdin, so this write races
    // that exit and loses (EPIPE) — measured at ~1 run in 10 of this file
    // before the handler below existed, which made the suite flaky rather than
    // wrong. The pipe closing early is the script working; the exit code and
    // the output stay the verdict.
    child.stdin.on('error', () => {});
    // Always close stdin: the unpack script reads the tarball from it, and the
    // scripts that do not read it must still see EOF rather than a live pipe.
    child.stdin.end(stdin ?? '');
  });
}

/** A minimal but REAL bundle: a runnable node and a requireable node-pty. */
async function makeBundle(root: string, version: string, withPty = true): Promise<string> {
  const stage = join(root, `stage-${version}`);
  await mkdir(join(stage, version, 'node', 'bin'), { recursive: true });
  await writeFile(
    join(stage, version, 'bundle.json'),
    JSON.stringify({ version, commit: null, nodeVersion: process.version, platform: 'linux-x64', glibcMin: '2.35' }),
  );
  symlinkSync(process.execPath, join(stage, version, 'node', 'bin', 'node'));
  if (withPty) {
    const pty = join(stage, version, 'node_modules', 'node-pty');
    await mkdir(pty, { recursive: true });
    await writeFile(join(pty, 'package.json'), '{"name":"node-pty","version":"1.1.0","main":"index.js"}');
    await writeFile(join(pty, 'index.js'), 'module.exports = {};\n');
  }
  const tar = join(root, `${version}.tar.gz`);
  await new Promise<void>((resolve, reject) => {
    const child = spawn('tar', ['-czf', tar, '-C', stage, version], { stdio: 'ignore' });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`tar exited ${code}`))));
  });
  return tar;
}

/**
 * Retention orders version dirs by CTIME, whose granularity is a clock tick
 * (~4 ms): two installs inside one tick TIE, and GNU `ls` then breaks the tie
 * by name. Real installs are minutes apart; these run back to back, so they
 * wait one tick out rather than testing a coin flip.
 */
const settle = () => sleep(20);

/**
 * ...and waiting is not enough: `settle()` assumes a MONOTONIC wall clock.
 * Measured 2026-09-10 in a full-suite run: the clock stepped BACKWARD ~0.22 s
 * between two fixture installs (`tar` warned `time stamp ... is 0.221187265 s
 * in the future`), so the SECOND install's ctime landed before the first's and
 * retention pruned the wrong directory. So the order is PROVEN here, never
 * assumed: re-touch the newer dir (utimes bumps ctime) until its ctime is
 * strictly greater than the dir installed before it.
 */
async function proveNewer(newer: string, older: string): Promise<void> {
  const ctime = (p: string): number => statSync(p).ctimeMs;
  for (let i = 0; i < 50; i += 1) {
    if (ctime(newer) > ctime(older)) return;
    await settle();
    const now = new Date();
    utimesSync(newer, now, now);
  }
  assert.fail(`ctime of ${newer} never overtook ${older} (clock stepped backward?)`);
}

async function install(root: string, appDir: string, version: string, live = '-'): Promise<ShResult> {
  const tar = await readFile(join(root, `${version}.tar.gz`));
  return runSh(unpackScript, [appDir, version, live], tar);
}

test('unpack script: a fresh install lands the version dir and points current at it', async () => {
  const root = await makeTempDir('ai-sm-inst-');
  try {
    const appDir = join(root, 'home', '.ai-session-manager', 'app');
    await makeBundle(root, 'v0.2.0');
    const res = await install(root, appDir, 'v0.2.0');
    assert.equal(res.code, 0, res.out);
    assert.match(res.out, /AI_SM_OK/);
    assert.match(res.out, new RegExp(`AI_SM_INSTALLED=${appDir}/v0\\.2\\.0`));
    assert.ok(existsSync(join(appDir, 'v0.2.0', 'bundle.json')));
    assert.equal(readdirSync(appDir).sort().join(','), 'current,v0.2.0');
    // No staging leftovers.
    assert.ok(!readdirSync(appDir).some((n) => n.startsWith('.incoming') || n.startsWith('.current.new')));
  } finally {
    await removeTempDir(root);
  }
});

test('unpack script: retention keeps current + exactly one previous version', async () => {
  const root = await makeTempDir('ai-sm-inst-');
  try {
    const appDir = join(root, 'app');
    for (const v of ['v0.1.0', 'v0.2.0', 'v0.3.0']) await makeBundle(root, v);
    await install(root, appDir, 'v0.1.0');
    await settle();
    await install(root, appDir, 'v0.2.0');
    // v0.2.0 must be strictly newer than v0.1.0 by ctime before v0.3.0 lands,
    // or retention has no defined answer here.
    await proveNewer(join(appDir, 'v0.2.0'), join(appDir, 'v0.1.0'));
    const third = await install(root, appDir, 'v0.3.0');
    assert.equal(third.code, 0, third.out);
    // The oldest goes, and it is NAMED in the output (the helper reports it).
    assert.match(third.out, /AI_SM_PRUNED=v0\.1\.0/);
    assert.equal(readdirSync(appDir).sort().join(','), 'current,v0.2.0,v0.3.0');
  } finally {
    await removeTempDir(root);
  }
});

test('unpack script: the version dir a LIVE backend runs from is never pruned', async () => {
  const root = await makeTempDir('ai-sm-inst-');
  try {
    const appDir = join(root, 'app');
    for (const v of ['v0.1.0', 'v0.2.0', 'v0.3.0']) await makeBundle(root, v);
    await install(root, appDir, 'v0.1.0');
    await settle();
    await install(root, appDir, 'v0.2.0');
    await settle();
    // v0.1.0 is the oldest AND the one a running process was loaded from.
    const third = await install(root, appDir, 'v0.3.0', 'v0.1.0');
    assert.equal(third.code, 0, third.out);
    assert.doesNotMatch(third.out, /AI_SM_PRUNED/, 'nothing may be pruned here');
    assert.equal(readdirSync(appDir).sort().join(','), 'current,v0.1.0,v0.2.0,v0.3.0');
  } finally {
    await removeTempDir(root);
  }
});

test('unpack script: reinstalling the same version replaces it and drops the .old copy', async () => {
  const root = await makeTempDir('ai-sm-inst-');
  try {
    const appDir = join(root, 'app');
    await makeBundle(root, 'v0.2.0');
    await install(root, appDir, 'v0.2.0');
    const again = await install(root, appDir, 'v0.2.0');
    assert.equal(again.code, 0, again.out);
    assert.equal(readdirSync(appDir).sort().join(','), 'current,v0.2.0');
  } finally {
    await removeTempDir(root);
  }
});

test('unpack script: reinstalling the version a LIVE backend runs from is REFUSED', async () => {
  // The rename to <version>.old moves the directory the running backend was
  // loaded from: its web/dist path stops resolving (assets 404 instantly) and
  // a later install can prune the real live inode dir under `.old`. So this
  // case is refused outright, before anything in the app dir is touched — the
  // user closes the window (or uses Restart backend) and runs Setup again.
  const root = await makeTempDir('ai-sm-inst-');
  try {
    const appDir = join(root, 'app');
    await makeBundle(root, 'v0.2.0');
    await install(root, appDir, 'v0.2.0');
    await writeFile(join(appDir, 'v0.2.0', 'marker.txt'), 'the running process was loaded from here\n');

    const again = await install(root, appDir, 'v0.2.0', 'v0.2.0');
    assert.equal(again.code, 31, again.out);
    assert.match(again.out, /AI_SM_ERR=same_version_live/);
    assert.doesNotMatch(again.out, /AI_SM_OK/);

    // Untouched: same files, no `.old`, no staging debris, current still there.
    assert.equal(readdirSync(appDir).sort().join(','), 'current,v0.2.0');
    assert.ok(existsSync(join(appDir, 'v0.2.0', 'marker.txt')), 'the live files must not move');
    assert.ok(!existsSync(join(appDir, 'v0.2.0.old')), 'nothing may be renamed out of the way');

    // Nothing live: the same reinstall is still allowed.
    const ok = await install(root, appDir, 'v0.2.0');
    assert.equal(ok.code, 0, ok.out);
    assert.equal(readdirSync(appDir).sort().join(','), 'current,v0.2.0');
  } finally {
    await removeTempDir(root);
  }
});

test('unpack script: prune never rm -rf`s a word-split `..` fragment, so the DATA DIR survives', async () => {
  // `for d in $(ls -1dtc */)` word-splits, and a directory whose NAME holds a
  // newline therefore arrives as TWO tokens — the second one being `..`, which
  // passed every check in the loop (charset, not a symlink, not the version)
  // and only needed a bundle.json in the app dir's PARENT — the DATA directory
  // — to be handed to `rm -rf`. Measured without the fix: GNU rm refuses '..'
  // and exits 1, so the data dir survives but `set -e` ABORTS the install
  // right after `current` was swapped (no AI_SM_OK, no retention). The point
  // stands either way: a fragment of a directory name is not a version dir.
  const root = await makeTempDir('ai-sm-inst-');
  try {
    const dataDir = join(root, '.ai-session-manager');
    const appDir = join(dataDir, 'app');
    for (const v of ['v0.1.0', 'v0.2.0', 'v0.3.0']) await makeBundle(root, v);
    await install(root, appDir, 'v0.1.0');
    await settle();
    const split = join(appDir, 'x\n..');
    await mkdir(split, { recursive: true });
    // What made `..` look like one of ours, plus a data file to prove nothing
    // in the data dir was touched.
    await writeFile(join(dataDir, 'bundle.json'), '{"version":"not ours"}');
    await writeFile(join(dataDir, 'history.json'), '[]');
    await settle();
    await install(root, appDir, 'v0.2.0');
    await proveNewer(join(appDir, 'v0.2.0'), join(appDir, 'v0.1.0'));

    const third = await install(root, appDir, 'v0.3.0');
    assert.equal(third.code, 0, third.out);
    assert.match(third.out, /AI_SM_OK/);
    assert.doesNotMatch(third.out, /AI_SM_PRUNED=\.\./, third.out);
    // The data dir is whole: nothing above the app dir may ever be removed.
    assert.ok(existsSync(join(dataDir, 'history.json')), 'the data dir must survive');
    assert.ok(existsSync(join(dataDir, 'bundle.json')), 'the data dir must survive');
    assert.ok(existsSync(split), 'a directory that is not ours is left alone');
    // Retention is unchanged: current + the new version + one previous.
    assert.equal(
      readdirSync(appDir).sort().join(','),
      ['x\n..', 'current', 'v0.2.0', 'v0.3.0'].sort().join(','),
      readdirSync(appDir).join('|'),
    );
  } finally {
    await removeTempDir(root);
  }
});

test('unpack script: a directory named `-x` is skipped, never handed to rm as an option', async () => {
  // `rm -rf $b` with b=`-x` is `rm -rf -x`: an invalid OPTION, which fails,
  // and `set -e` then aborts the install after `current` was already swapped.
  // A `-x` also breaks the LISTING (`ls` parses it as options, exit 2 into
  // /dev/null), so a third, older version dir is present: retention must
  // still run and still drop exactly that one, or the loop iterated nothing.
  const root = await makeTempDir('ai-sm-inst-');
  try {
    const appDir = join(root, 'app');
    for (const v of ['v0.0.9', 'v0.1.0', 'v0.2.0']) await makeBundle(root, v);
    const dash = join(appDir, '-x');
    await mkdir(dash, { recursive: true });
    await writeFile(join(dash, 'bundle.json'), '{"version":"-x"}');
    await settle();
    await install(root, appDir, 'v0.0.9');
    await proveNewer(join(appDir, 'v0.0.9'), dash);
    await install(root, appDir, 'v0.1.0');
    await proveNewer(join(appDir, 'v0.1.0'), join(appDir, 'v0.0.9'));

    // `-x` is the OLDEST candidate here, so it is the one retention wants to
    // remove — exactly the case that used to break the script.
    const second = await install(root, appDir, 'v0.2.0');
    assert.equal(second.code, 0, second.out);
    assert.match(second.out, /AI_SM_OK/);
    assert.doesNotMatch(second.out, /AI_SM_PRUNED=-x/);
    // Retention is alive despite the `-x`: the oldest real version goes.
    assert.match(second.out, /AI_SM_PRUNED=v0\.0\.9/, second.out);
    assert.ok(existsSync(join(dash, 'bundle.json')), 'a name rm cannot be told apart from a flag is left alone');
    assert.equal(readdirSync(appDir).sort().join(','), '-x,current,v0.1.0,v0.2.0');
  } finally {
    await removeTempDir(root);
  }
});

test('unpack script: a directory name with a space is skipped whole, and costs no real version its slot', async () => {
  // Word-splitting the listing turned `v0 v2/` into the tokens `v0` and `v2/`:
  // the phantom `v2` matched the REAL v2, took the one kept-previous slot and
  // had the real one pruned as if it were a third copy. Read line-wise, the
  // name arrives whole and the charset guard rejects it.
  const root = await makeTempDir('ai-sm-inst-');
  try {
    const appDir = join(root, 'app');
    for (const v of ['v1', 'v2', 'v3']) await makeBundle(root, v);
    const spaced = join(appDir, 'v0 v2');
    await mkdir(spaced, { recursive: true });
    await writeFile(join(spaced, 'bundle.json'), '{"version":"v0 v2"}');
    await settle();
    await install(root, appDir, 'v1');
    await proveNewer(join(appDir, 'v1'), spaced);
    await install(root, appDir, 'v2');
    await proveNewer(join(appDir, 'v2'), join(appDir, 'v1'));

    const third = await install(root, appDir, 'v3');
    assert.equal(third.code, 0, third.out);
    assert.match(third.out, /AI_SM_OK/);
    // Exactly one prune, and it is the oldest real version.
    assert.match(third.out, /AI_SM_PRUNED=v1$/m, third.out);
    assert.equal((third.out.match(/AI_SM_PRUNED=/g) ?? []).length, 1, third.out);
    assert.ok(existsSync(join(appDir, 'v2', 'bundle.json')), 'the real previous version must survive');
    assert.ok(existsSync(join(spaced, 'bundle.json')), 'a name the charset guard rejects is left alone');
    assert.equal(readdirSync(appDir).sort().join(','), ['v0 v2', 'current', 'v2', 'v3'].sort().join(','));
  } finally {
    await removeTempDir(root);
  }
});

test('unpack script: the prune `rm` names its target as `./<dir>`, never as a bare word', () => {
  // The two tests above prove the BEHAVIOUR of the guards that stand in front
  // of this line (charset, then `.|..|-*`). With both of them in place, a bare
  // `rm -rf $b` is indistinguishable from `rm -rf ./$b` for every name that
  // can still reach it — a mutation dropping the `./` passes every behavioural
  // test in this file. The prefix is the layer UNDER those guards: it is what
  // makes the command safe by itself, so that relaxing or reordering a guard
  // upstream can never turn a pruned directory name into an option (`-rf`,
  // `--no-preserve-root`) or into a bare `..`. Pinned by inspection because no
  // observable behaviour distinguishes it while the guards hold.
  const rmLines = unpackScript.split('\n').filter((l) => l.trim().startsWith('rm -rf'));
  assert.ok(
    rmLines.includes('  rm -rf ./$b'),
    `the prune step must spell its target ./$b:\n${rmLines.join('\n')}`,
  );
  assert.ok(
    !rmLines.some((l) => l.trim() === 'rm -rf $b'),
    `no bare \`rm -rf $b\` may exist:\n${rmLines.join('\n')}`,
  );
});

test('unpack script: a bundle whose native module does not load fails, and current does not move', async () => {
  const root = await makeTempDir('ai-sm-inst-');
  try {
    const appDir = join(root, 'app');
    await makeBundle(root, 'v0.2.0');
    await makeBundle(root, 'v0.3.0', false); // no node-pty: the glibc/ABI proof fails
    await install(root, appDir, 'v0.2.0');
    const broken = await install(root, appDir, 'v0.3.0');
    assert.equal(broken.code, 27, broken.out);
    assert.match(broken.out, /AI_SM_ERR=node_pty_failed/);
    assert.doesNotMatch(broken.out, /AI_SM_OK/);
    // The working install is untouched: no v0.3.0 dir, current still v0.2.0.
    assert.equal(readdirSync(appDir).sort().join(','), 'current,v0.2.0');
  } finally {
    await removeTempDir(root);
  }
});

test('unpack script: an archive without <version>/bundle.json is refused', async () => {
  const root = await makeTempDir('ai-sm-inst-');
  try {
    const appDir = join(root, 'app');
    await makeBundle(root, 'v0.2.0');
    // Same archive, but we claim it holds a different version.
    const tar = await readFile(join(root, 'v0.2.0.tar.gz'));
    const res = await runSh(unpackScript, [appDir, 'v9.9.9', '-'], tar);
    assert.equal(res.code, 24, res.out);
    assert.match(res.out, /AI_SM_ERR=no_bundle_json/);
    assert.ok(!existsSync(join(appDir, 'current')));
  } finally {
    await removeTempDir(root);
  }
});

// --- a hostile archive ------------------------------------------------------
//
// The bundle is our own release asset, so a malicious tarball is not the
// threat model — a CORRUPT or mis-built one is, and the answer to both is the
// same: whatever the archive claims, nothing may be written outside the
// staging directory the unpack script created for it. `tar -xzf - -C $stage`
// carries that guarantee (GNU tar strips a leading `/`, refuses a `..` member
// and refuses to write through a symlinked directory), and this pins it —
// including the fact that the staging directory is CLEANED UP either way, so
// junk from a bad archive never survives the install.

/** One ustar header block (512 bytes) — the members `tar -cf` will not make. */
function ustarHeader(name: string, size: number, typeflag: '0' | '2', linkname = ''): Buffer {
  const h = Buffer.alloc(512, 0);
  h.write(name, 0, 100, 'utf8');
  h.write('0000644\0', 100, 8, 'ascii'); // mode
  h.write('0000000\0', 108, 8, 'ascii'); // uid
  h.write('0000000\0', 116, 8, 'ascii'); // gid
  h.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
  h.write((0).toString(8).padStart(11, '0') + '\0', 136, 12, 'ascii'); // mtime
  h.write('        ', 148, 8, 'ascii'); // checksum field counts as spaces
  h.write(typeflag, 156, 1, 'ascii');
  h.write(linkname, 157, 100, 'utf8');
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return h;
}

interface HostileMember {
  name: string;
  body?: string;
  link?: string;
}

/**
 * A REAL bundle tarball with extra members spliced in. The good half is built
 * by `tar` exactly like every other test here (a runnable node, a requireable
 * node-pty); only the members `tar` refuses to create are hand-written, and
 * they are appended before the end-of-archive blocks so one stream holds both.
 */
async function makeHostileTar(root: string, version: string, members: HostileMember[]): Promise<Buffer> {
  const stage = join(root, `hostile-stage-${version}`);
  await mkdir(join(stage, version, 'node', 'bin'), { recursive: true });
  await writeFile(join(stage, version, 'bundle.json'), JSON.stringify({ version }));
  symlinkSync(process.execPath, join(stage, version, 'node', 'bin', 'node'));
  const pty = join(stage, version, 'node_modules', 'node-pty');
  await mkdir(pty, { recursive: true });
  await writeFile(join(pty, 'package.json'), '{"name":"node-pty","version":"1.1.0","main":"index.js"}');
  await writeFile(join(pty, 'index.js'), 'module.exports = {};\n');
  const plain = join(root, `hostile-${version}.tar`);
  await new Promise<void>((resolve, reject) => {
    const child = spawn('tar', ['-cf', plain, '-C', stage, version], { stdio: 'ignore' });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`tar exited ${code}`))));
  });
  let bytes = await readFile(plain);
  // Drop the end-of-archive padding so the extra members are still read.
  let end = bytes.length;
  while (end >= 512 && bytes.subarray(end - 512, end).every((b) => b === 0)) end -= 512;
  const blocks: Buffer[] = [bytes.subarray(0, end)];
  for (const m of members) {
    if (m.link !== undefined) {
      blocks.push(ustarHeader(m.name, 0, '2', m.link));
    } else {
      const body = Buffer.from(m.body ?? 'PWNED\n', 'utf8');
      blocks.push(ustarHeader(m.name, body.length, '0'));
      blocks.push(body, Buffer.alloc((512 - (body.length % 512)) % 512, 0));
    }
  }
  blocks.push(Buffer.alloc(1024, 0));
  bytes = Buffer.concat(blocks);
  return gzipSync(bytes);
}

test('unpack script: an archive with a `..` member is refused and writes nothing outside the staging dir', async () => {
  const root = await makeTempDir('ai-sm-inst-');
  try {
    const appDir = join(root, 'app');
    const tar = await makeHostileTar(root, 'v0.2.0', [
      { name: '../pwned-parent.txt' },
      { name: 'v0.2.0/../../pwned-grand.txt' },
    ]);
    const res = await runSh(unpackScript, [appDir, 'v0.2.0', '-'], tar);
    // GNU tar: "Member name contains '..'" -> non-zero -> the script's own
    // untar_failed, which is a refusal, not a partial install.
    assert.equal(res.code, 23, res.out);
    assert.match(res.out, /AI_SM_ERR=untar_failed/);
    assert.doesNotMatch(res.out, /AI_SM_OK/);
    // Nothing escaped: not into the app dir, not into its parent, not one above.
    assert.ok(!existsSync(join(appDir, 'pwned-parent.txt')));
    assert.ok(!existsSync(join(root, 'pwned-parent.txt')));
    assert.ok(!existsSync(join(root, 'pwned-grand.txt')));
    assert.ok(!existsSync(join(appDir, 'current')));
    assert.ok(!existsSync(join(appDir, 'v0.2.0')));
    // And the staging directory is gone, so the failure leaves no debris.
    assert.equal(readdirSync(appDir).length, 0, readdirSync(appDir).join(','));
  } finally {
    await removeTempDir(root);
  }
});

test('unpack script: an absolute-path member stays inside the staging dir and dies with it', async () => {
  const root = await makeTempDir('ai-sm-inst-');
  try {
    const appDir = join(root, 'app');
    const absTarget = join(root, 'pwned-abs.txt');
    const tar = await makeHostileTar(root, 'v0.2.0', [{ name: absTarget }]);
    const res = await runSh(unpackScript, [appDir, 'v0.2.0', '-'], tar);
    // GNU tar strips the leading '/', so the member lands RELATIVE to -C
    // $stage. The install is a normal success and the intended target is
    // never touched.
    assert.equal(res.code, 0, res.out);
    assert.match(res.out, /AI_SM_OK/);
    assert.ok(!existsSync(absTarget), 'an absolute member must never reach its absolute path');
    // The junk went into the staging dir, which is removed with it: the
    // installed tree is exactly the version dir and the symlink.
    assert.equal(readdirSync(appDir).sort().join(','), 'current,v0.2.0');
    assert.equal(
      readdirSync(join(appDir, 'v0.2.0')).sort().join(','),
      'bundle.json,node,node_modules',
      'the version dir holds the bundle and nothing the archive smuggled in',
    );
  } finally {
    await removeTempDir(root);
  }
});

test('unpack script: a member written through a symlinked directory is refused', async () => {
  const root = await makeTempDir('ai-sm-inst-');
  try {
    const appDir = join(root, 'app');
    const tar = await makeHostileTar(root, 'v0.2.0', [
      { name: 'escape', link: '../../..' },
      { name: 'escape/pwned-sym.txt' },
    ]);
    const res = await runSh(unpackScript, [appDir, 'v0.2.0', '-'], tar);
    assert.equal(res.code, 23, res.out);
    assert.match(res.out, /AI_SM_ERR=untar_failed/);
    assert.ok(!existsSync(join(root, 'pwned-sym.txt')));
    assert.ok(!existsSync(join(appDir, 'pwned-sym.txt')));
    assert.equal(readdirSync(appDir).length, 0, readdirSync(appDir).join(','));
  } finally {
    await removeTempDir(root);
  }
});

// --- the remove script ------------------------------------------------------

async function makeInstalled(root: string): Promise<string> {
  const dataDir = join(root, 'home', 'u', '.ai-session-manager');
  const appDir = join(dataDir, 'app');
  await mkdir(join(appDir, 'v0.2.0'), { recursive: true });
  await writeFile(join(appDir, 'v0.2.0', 'bundle.json'), '{"version":"v0.2.0"}');
  await writeFile(join(dataDir, 'runtime.json'), '{"port":1}');
  await writeFile(join(dataDir, 'history.json'), '[]');
  await writeFile(join(dataDir, 'prefs.json'), '{}');
  await writeFile(join(dataDir, 'server.log'), 'log\n');
  return appDir;
}

test('remove script: removes the app dir and nothing else in the data dir', async () => {
  const root = await makeTempDir('ai-sm-uninst-');
  try {
    const appDir = await makeInstalled(root);
    const res = await runSh(removeScript, [appDir]);
    assert.equal(res.code, 0, res.out);
    assert.match(res.out, /AI_SM_OK/);
    assert.ok(!existsSync(appDir));
    const dataDir = join(root, 'home', 'u', '.ai-session-manager');
    assert.equal(
      readdirSync(dataDir).sort().join(','),
      'history.json,prefs.json,runtime.json,server.log',
      'the data files must survive',
    );
    // Running it again is harmless.
    const gone = await runSh(removeScript, [appDir]);
    assert.equal(gone.code, 0, gone.out);
    assert.match(gone.out, /AI_SM_GONE=1/);
  } finally {
    await removeTempDir(root);
  }
});

test('remove script: refuses the data dir, a shallow path, a `..` path and a foreign dir', async () => {
  const root = await makeTempDir('ai-sm-uninst-');
  try {
    const appDir = await makeInstalled(root);
    const dataDir = join(root, 'home', 'u', '.ai-session-manager');
    const foreign = join(root, 'home', 'u', 'other', 'app');
    await mkdir(foreign, { recursive: true });

    const cases: [string, number, RegExp][] = [
      [dataDir, 42, /not_app_dir/],
      [join(root, 'home', 'u'), 42, /not_app_dir/],
      ['/app', 44, /too_shallow/],
      ['/home/app', 44, /too_shallow/],
      [`${dataDir}/../app`, 43, /dotdot/],
      [foreign, 45, /no_bundle/],
      ['relative/app', 41, /not_absolute/],
    ];
    for (const [path, code, reason] of cases) {
      const res = await runSh(removeScript, [path]);
      assert.equal(res.code, code, `${path}: ${res.out}`);
      assert.match(res.out, reason, path);
      assert.doesNotMatch(res.out, /AI_SM_OK/, path);
    }
    // Everything is still there.
    assert.ok(existsSync(join(appDir, 'v0.2.0', 'bundle.json')));
    assert.ok(existsSync(join(dataDir, 'history.json')));
    assert.ok(existsSync(foreign));
  } finally {
    await removeTempDir(root);
  }
});
