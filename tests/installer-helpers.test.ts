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
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { accessSync, constants, readFileSync, symlinkSync, existsSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { delimiter, join } from 'node:path';
import { projectRoot } from './helpers.ts';

const helpersDir = join(projectRoot, 'installer', 'helpers');
const readHelper = (name: string) => readFileSync(join(helpersDir, name), 'utf8');

// --- extracting the constant scripts ----------------------------------------

/** The `@'...'@` here-string a helper sends to `sh -c` / `bash -lc`. */
function constScript(fileText: string, varName: string): string {
  const m = new RegExp(`\\$${varName} = @'\\n([\\s\\S]*?)\\n'@`).exec(fileText);
  assert.ok(m, `no here-string named $${varName}`);
  return m[1]!;
}

const unpackScript = constScript(readHelper('install-bundle.ps1'), 'AiSmUnpackScript');
const removeScript = constScript(readHelper('uninstall-wsl.ps1'), 'AiSmRemoveScript');
const probeScript = constScript(readHelper('wsl-probe.ps1'), 'AiSmDistroProbeScript');
const claudeCheckScript = constScript(readHelper('install-thirdparty.ps1'), 'AiSmClaudeCheckScript');

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
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 20));

async function install(root: string, appDir: string, version: string, live = '-'): Promise<ShResult> {
  const tar = await readFile(join(root, `${version}.tar.gz`));
  return runSh(unpackScript, [appDir, version, live], tar);
}

test('unpack script: a fresh install lands the version dir and points current at it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-sm-inst-'));
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
    await rm(root, { recursive: true, force: true });
  }
});

test('unpack script: retention keeps current + exactly one previous version', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-sm-inst-'));
  try {
    const appDir = join(root, 'app');
    for (const v of ['v0.1.0', 'v0.2.0', 'v0.3.0']) await makeBundle(root, v);
    await install(root, appDir, 'v0.1.0');
    await settle();
    await install(root, appDir, 'v0.2.0');
    await settle();
    const third = await install(root, appDir, 'v0.3.0');
    assert.equal(third.code, 0, third.out);
    // The oldest goes, and it is NAMED in the output (the helper reports it).
    assert.match(third.out, /AI_SM_PRUNED=v0\.1\.0/);
    assert.equal(readdirSync(appDir).sort().join(','), 'current,v0.2.0,v0.3.0');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('unpack script: the version dir a LIVE backend runs from is never pruned', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-sm-inst-'));
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
    await rm(root, { recursive: true, force: true });
  }
});

test('unpack script: reinstalling the same version replaces it and drops the .old copy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-sm-inst-'));
  try {
    const appDir = join(root, 'app');
    await makeBundle(root, 'v0.2.0');
    await install(root, appDir, 'v0.2.0');
    const again = await install(root, appDir, 'v0.2.0');
    assert.equal(again.code, 0, again.out);
    assert.equal(readdirSync(appDir).sort().join(','), 'current,v0.2.0');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('unpack script: reinstalling the version a LIVE backend runs from is REFUSED', async () => {
  // The rename to <version>.old moves the directory the running backend was
  // loaded from: its web/dist path stops resolving (assets 404 instantly) and
  // a later install can prune the real live inode dir under `.old`. So this
  // case is refused outright, before anything in the app dir is touched — the
  // user closes the window (or uses Restart backend) and runs Setup again.
  const root = await mkdtemp(join(tmpdir(), 'ai-sm-inst-'));
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
    await rm(root, { recursive: true, force: true });
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
  const root = await mkdtemp(join(tmpdir(), 'ai-sm-inst-'));
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
    await settle();

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
    await rm(root, { recursive: true, force: true });
  }
});

test('unpack script: a directory named `-x` is skipped, never handed to rm as an option', async () => {
  // `rm -rf $b` with b=`-x` is `rm -rf -x`: an invalid OPTION, which fails,
  // and `set -e` then aborts the install after `current` was already swapped.
  // A `-x` also breaks the LISTING (`ls` parses it as options, exit 2 into
  // /dev/null), so a third, older version dir is present: retention must
  // still run and still drop exactly that one, or the loop iterated nothing.
  const root = await mkdtemp(join(tmpdir(), 'ai-sm-inst-'));
  try {
    const appDir = join(root, 'app');
    for (const v of ['v0.0.9', 'v0.1.0', 'v0.2.0']) await makeBundle(root, v);
    const dash = join(appDir, '-x');
    await mkdir(dash, { recursive: true });
    await writeFile(join(dash, 'bundle.json'), '{"version":"-x"}');
    await settle();
    await install(root, appDir, 'v0.0.9');
    await settle();
    await install(root, appDir, 'v0.1.0');
    await settle();

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
    await rm(root, { recursive: true, force: true });
  }
});

test('unpack script: a directory name with a space is skipped whole, and costs no real version its slot', async () => {
  // Word-splitting the listing turned `v0 v2/` into the tokens `v0` and `v2/`:
  // the phantom `v2` matched the REAL v2, took the one kept-previous slot and
  // had the real one pruned as if it were a third copy. Read line-wise, the
  // name arrives whole and the charset guard rejects it.
  const root = await mkdtemp(join(tmpdir(), 'ai-sm-inst-'));
  try {
    const appDir = join(root, 'app');
    for (const v of ['v1', 'v2', 'v3']) await makeBundle(root, v);
    const spaced = join(appDir, 'v0 v2');
    await mkdir(spaced, { recursive: true });
    await writeFile(join(spaced, 'bundle.json'), '{"version":"v0 v2"}');
    await settle();
    await install(root, appDir, 'v1');
    await settle();
    await install(root, appDir, 'v2');
    await settle();

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
    await rm(root, { recursive: true, force: true });
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
  const root = await mkdtemp(join(tmpdir(), 'ai-sm-inst-'));
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
    await rm(root, { recursive: true, force: true });
  }
});

test('unpack script: an archive without <version>/bundle.json is refused', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-sm-inst-'));
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
    await rm(root, { recursive: true, force: true });
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
  const root = await mkdtemp(join(tmpdir(), 'ai-sm-inst-'));
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
    await rm(root, { recursive: true, force: true });
  }
});

test('unpack script: an absolute-path member stays inside the staging dir and dies with it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-sm-inst-'));
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
    await rm(root, { recursive: true, force: true });
  }
});

test('unpack script: a member written through a symlinked directory is refused', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-sm-inst-'));
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
    await rm(root, { recursive: true, force: true });
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
  const root = await mkdtemp(join(tmpdir(), 'ai-sm-uninst-'));
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
    await rm(root, { recursive: true, force: true });
  }
});

test('remove script: refuses the data dir, a shallow path, a `..` path and a foreign dir', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-sm-uninst-'));
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
    await rm(root, { recursive: true, force: true });
  }
});

// --- the PowerShell side ----------------------------------------------------

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

const powershell = onPath('powershell.exe');
const wslpathBin = onPath('wslpath');
const skip: string | false = powershell
  ? wslpathBin
    ? false
    : 'wslpath not on PATH (not inside WSL)'
  : 'powershell.exe not on PATH (no Windows interop)';

interface RunResult {
  code: number | null;
  out: string;
}

function run(exe: string, args: string[], timeoutMs = 60_000): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`timed out: ${exe} ${args.join(' ')}`));
    }, timeoutMs);
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
      resolve({ code, out: out.replaceAll('\r', '') });
    });
  });
}

async function toWin(linuxPath: string): Promise<string> {
  const res = await run(wslpathBin!, ['-w', linuxPath]);
  const win = res.out.trim();
  assert.ok(win, `wslpath -w produced nothing for ${linuxPath}`);
  return win;
}

/** Runs a helper and returns its stdout plus the parsed result file. */
async function helper(name: string, args: string[]): Promise<{ res: RunResult; keys: Map<string, string> }> {
  const dir = await mkdtemp(join(tmpdir(), 'ai-sm-helper-'));
  try {
    const resultFile = join(dir, 'result.txt');
    const res = await run(powershell!, [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      await toWin(join(helpersDir, name)),
      '-ResultFile',
      await toWin(resultFile),
      ...args,
    ]);
    const keys = new Map<string, string>();
    if (existsSync(resultFile)) {
      for (const line of readFileSync(resultFile, 'utf8').replaceAll('\r', '').split('\n')) {
        const eq = line.indexOf('=');
        if (eq > 0) keys.set(line.slice(0, eq), line.slice(eq + 1));
      }
    }
    return { res, keys };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The exact command line a -DryRun printed between its markers. */
function dryRunCommandLine(out: string): string {
  const start = out.indexOf('DRYRUN-CMDLINE-BEGIN\n');
  const end = out.indexOf('\nDRYRUN-CMDLINE-END');
  assert.ok(start >= 0 && end > start, `no dry-run command line in:\n${out}`);
  return out.slice(start + 'DRYRUN-CMDLINE-BEGIN\n'.length, end);
}

test('install-bundle -DryRun prints the exact wsl.exe command line and runs nothing', { skip }, async () => {
  const { res, keys } = await helper('install-bundle.ps1', [
    '-DryRun',
    '-Distro', 'Ubuntu-24.04',
    '-AppDir', '/home/you/.ai-session-manager/app',
    '-Version', 'v0.2.0',
    '-Tarball', 'C:\\Users\\me\\AppData\\Local\\Temp\\a dir\\bundle.tar.gz',
    '-ConfigDir', 'C:\\Programs\\AI Session Manager',
  ]);
  assert.equal(res.code, 0, res.out);
  const cmd = dryRunCommandLine(res.out);

  // --exec, or wsl.exe hands the whole line to the distro's default shell,
  // which expands it a SECOND time ($1/$2 arrive empty, $(...) runs there).
  assert.ok(cmd.startsWith('wsl.exe -d Ubuntu-24.04 --exec sh -c "'), cmd.slice(0, 80));
  // Positional arguments after the script: $0=sh, $1=appdir, $2=version,
  // $3=the live version dir ('-' = none).
  assert.ok(cmd.endsWith('" sh /home/you/.ai-session-manager/app v0.2.0 -'), cmd.slice(-80));
  // The script between the quotes is exactly the committed constant.
  const inner = cmd.slice('wsl.exe -d Ubuntu-24.04 --exec sh -c "'.length, cmd.lastIndexOf('" sh '));
  assert.equal(inner, unpackScript);
  assert.equal((cmd.match(/"/g) ?? []).length, 2, 'only the two script delimiters may be double quotes');

  // The tarball never appears on the Linux command line - it goes on stdin.
  assert.ok(!cmd.includes('bundle.tar.gz'), cmd);
  assert.ok(res.out.includes('DRYRUN-STDIN=C:\\Users\\me\\AppData\\Local\\Temp\\a dir\\bundle.tar.gz'), res.out);

  assert.equal(keys.get('ok'), 'yes');
  assert.equal(keys.get('dryRun'), 'yes');
  assert.equal(keys.get('installedDir'), '/home/you/.ai-session-manager/app/v0.2.0');
  assert.equal(keys.get('current'), '/home/you/.ai-session-manager/app/current');
  assert.equal(keys.get('configFile'), 'C:\\Programs\\AI Session Manager\\launcher-config.json');
  assert.equal(keys.get('infoFile'), 'C:\\Programs\\AI Session Manager\\install-info.txt');
});

test('install-bundle refuses a bad distro, a bad app dir and a bad version before anything runs', { skip }, async () => {
  const base = ['-DryRun', '-Tarball', 'none'];
  const cases: [string[], RegExp][] = [
    [['-Distro', 'Ubuntu 24', '-AppDir', '/home/you/.ai-session-manager/app', '-Version', 'v0.2.0'], /is not usable/],
    [['-Distro', 'Ubuntu-24.04', '-AppDir', '/home/a b/app', '-Version', 'v0.2.0'], /absolute Linux path/],
    [['-Distro', 'Ubuntu-24.04', '-AppDir', '/home/you/.ai-session-manager', '-Version', 'v0.2.0'], /must end in \/app/],
    [['-Distro', 'Ubuntu-24.04', '-AppDir', '/app', '-Version', 'v0.2.0'], /must end in \/app/],
    // Two segments is what the UNINSTALLER refuses (>= 3, ends in /app), so
    // accepting it here would install into a path that can never be removed.
    [['-Distro', 'Ubuntu-24.04', '-AppDir', '/home/app', '-Version', 'v0.2.0'], /at least two segments above it/],
    [['-Distro', 'Ubuntu-24.04', '-AppDir', '/home/you/../x/app', '-Version', 'v0.2.0'], /'\.' or '\.\.' path segment/],
    [['-Distro', 'Ubuntu-24.04', '-AppDir', '/home/you/.ai-session-manager/app', '-Version', '../evil'], /usable bundle version/],
  ];
  for (const [args, reason] of cases) {
    const { res, keys } = await helper('install-bundle.ps1', [...base, ...args]);
    assert.equal(res.code, 1, `${args.join(' ')}\n${res.out}`);
    assert.equal(keys.get('ok'), 'no', args.join(' '));
    assert.match(keys.get('reason') ?? '', reason, args.join(' '));
    assert.ok(!res.out.includes('DRYRUN-CMDLINE-BEGIN'), 'a refused call must not print a command line');
  }
});

test('uninstall-wsl -DryRun prints the exact command line; every unsafe path is refused', { skip }, async () => {
  const ok = await helper('uninstall-wsl.ps1', [
    '-DryRun', '-Distro', 'Ubuntu-24.04', '-AppDir', '/home/you/.ai-session-manager/app',
  ]);
  assert.equal(ok.res.code, 0, ok.res.out);
  const cmd = dryRunCommandLine(ok.res.out);
  assert.ok(cmd.startsWith('wsl.exe -d Ubuntu-24.04 --exec sh -c "'), cmd.slice(0, 80));
  assert.ok(cmd.endsWith('" sh /home/you/.ai-session-manager/app'), cmd.slice(-60));
  assert.equal(cmd.slice('wsl.exe -d Ubuntu-24.04 --exec sh -c "'.length, cmd.lastIndexOf('" sh ')), removeScript);
  assert.equal(ok.keys.get('removed'), 'no', 'a dry run removes nothing');

  const refusals: [string, RegExp][] = [
    ['/home/you/.ai-session-manager', /must end in \/app/],
    ['/', /absolute Linux path/],
    ['/app', /too close to the root/],
    ['/home/you', /must end in \/app/],
    ['/home/a b/app', /absolute Linux path/],
    ['/home/you/../x/app', /'\.' or '\.\.' path segment/],
    ['home/you/app', /absolute Linux path/],
  ];
  for (const [appDir, reason] of refusals) {
    const { res, keys } = await helper('uninstall-wsl.ps1', ['-DryRun', '-Distro', 'Ubuntu-24.04', '-AppDir', appDir]);
    assert.equal(res.code, 1, `${appDir}\n${res.out}`);
    assert.equal(keys.get('ok'), 'no', appDir);
    assert.match(keys.get('reason') ?? '', reason, appDir);
    assert.ok(!res.out.includes('DRYRUN-CMDLINE-BEGIN'), `${appDir}: refused paths never reach a command line`);
  }
});

test('install-thirdparty -DryRun shows the exact command and its source host', { skip }, async () => {
  const { res, keys } = await helper('install-thirdparty.ps1', ['-DryRun', '-Distro', 'Ubuntu-24.04', '-Item', 'claude']);
  assert.equal(res.code, 0, res.out);
  assert.equal(
    dryRunCommandLine(res.out),
    'wsl.exe -d Ubuntu-24.04 --exec bash -lc "curl -fsSL https://claude.ai/install.sh | bash"',
  );
  assert.equal(keys.get('command'), 'curl -fsSL https://claude.ai/install.sh | bash');
  assert.equal(keys.get('host'), 'claude.ai');
  assert.ok(res.out.includes('command: curl -fsSL https://claude.ai/install.sh | bash'), res.out);
  assert.ok(res.out.includes('source:  https://claude.ai'), res.out);
});

test('install-thirdparty accepts no item but the allow-listed one', { skip }, async () => {
  const { res } = await helper('install-thirdparty.ps1', ['-DryRun', '-Distro', 'Ubuntu-24.04', '-Item', 'anything-else']);
  assert.notEqual(res.code, 0, res.out);
  assert.match(res.out, /ValidateSet|does not belong to the set/i, res.out);
});

test('wsl-probe parses the UTF-16LE `wsl -l -v` table, marking WSL 1 and odd names unusable', { skip }, async () => {
  // The committed fixture is the real thing: UTF-16LE, no BOM, CRLF - which
  // is what wsl.exe emits when WSL_UTF8 is not honoured, and it read as UTF-8
  // puts a NUL between every character.
  const fixture = join(projectRoot, 'tests', 'fixtures', 'wsl-list-verbose-utf16le.txt');
  const bytes = readFileSync(fixture);
  assert.equal(bytes[0], 0x20);
  assert.equal(bytes[1], 0x00, 'the fixture must stay UTF-16LE');

  const { res, keys } = await helper('wsl-probe.ps1', ['-ListFile', await toWin(fixture)]);
  assert.equal(res.code, 0, res.out);
  assert.equal(keys.get('ok'), 'yes');
  assert.equal(keys.get('wslPresent'), 'yes');
  assert.equal(keys.get('distroCount'), '4');
  assert.equal(keys.get('wsl2Count'), '2');
  assert.equal(keys.get('default'), 'Ubuntu-24.04', 'the * marks the default distro');
  assert.equal(keys.get('distro1'), 'Ubuntu-24.04');
  assert.equal(keys.get('distro1.version'), '2');
  assert.equal(keys.get('distro1.state'), 'Running');
  assert.equal(keys.get('distro1.default'), 'yes');
  assert.equal(keys.get('distro1.usable'), 'yes');
  assert.equal(keys.get('distro2'), 'Debian');
  assert.equal(keys.get('distro2.default'), 'no');
  assert.equal(keys.get('distro3'), 'Legacy-1');
  assert.equal(keys.get('distro3.version'), '1', 'a WSL 1 distro is listed but not counted');
  assert.equal(keys.get('distro4'), 'My Distro');
  assert.equal(keys.get('distro4.usable'), 'no', 'a name with a space can never reach a WSL command line');
});

test('wsl-probe -Distro -DryRun uses a login shell and the constant probe script', { skip }, async () => {
  const { res, keys } = await helper('wsl-probe.ps1', ['-DryRun', '-Distro', 'Ubuntu-24.04', '-GlibcMin', '2.35']);
  assert.equal(res.code, 0, res.out);
  const cmd = dryRunCommandLine(res.out);
  // bash -lc, not sh -c: the PATH a login shell builds is the one the
  // launcher will see later (~/.local/bin, where Claude Code installs).
  assert.equal(cmd, `wsl.exe -d Ubuntu-24.04 --exec bash -lc "${probeScript}"`);
  assert.equal(keys.get('ok'), 'yes');
  assert.equal(keys.get('dryRun'), 'yes');
});

test('wsl-probe refuses a distro name that could not be put on a command line', { skip }, async () => {
  const { res, keys } = await helper('wsl-probe.ps1', ['-DryRun', '-Distro', 'My Distro']);
  assert.equal(res.code, 0, res.out); // a probe answers, it does not crash
  assert.equal(keys.get('ok'), 'no');
  assert.match(keys.get('reason') ?? '', /refuses to put on a WSL command line/);
  assert.ok(!res.out.includes('DRYRUN-CMDLINE-BEGIN'), res.out);
});

test('wsl-probe reads the in-distro probe answer through the same UTF-16LE NULs', { skip }, async () => {
  // The distro-mode answer arrives on the SAME redirected stdout as `wsl -l -v`
  // and is just as likely to be UTF-16LE (WSL_UTF8 is set on the child, but a
  // wsl.exe that ignores it is exactly the case this strip exists for). Read as
  // UTF-8 that text carries a NUL after every ASCII character, so a key lookup
  // that does not strip them silently answers '' for EVERY key — and '' is a
  // legitimate answer here, so nothing would crash: the wizard would report
  // "could not read <distro>" for a perfectly good distro, or worse accept an
  // empty home. Distro mode itself needs a real WSL call, so the lookup is
  // extracted and run on its own, the same idiom as the constant scripts above.
  const fnText = /function Get-AiSmProbeValue \{[\s\S]*?\n\}/.exec(readHelper('wsl-probe.ps1'))?.[0];
  assert.ok(fnText, 'wsl-probe.ps1 must still define Get-AiSmProbeValue');
  assert.ok(fnText.includes('$Key'), fnText);

  const dir = await mkdtemp(join(tmpdir(), 'ai-sm-probe-'));
  try {
    const answer =
      'AISM_USER=you\r\n' +
      'AISM_HOME=/home/you\r\n' +
      'AISM_GLIBC=glibc 2.39\r\n' +
      'AISM_CLAUDE=yes\r\n' +
      'AISM_PROBE=ok\r\n';
    const answerFile = join(dir, 'probe-out.bin');
    await writeFile(answerFile, Buffer.from(answer, 'utf16le')); // UTF-16LE, no BOM
    const script = join(dir, 'run.ps1');
    await writeFile(
      script,
      "$ErrorActionPreference = 'Stop'\n" +
        fnText +
        '\n' +
        '$bytes = [System.IO.File]::ReadAllBytes($args[0])\n' +
        '$text = [System.Text.Encoding]::UTF8.GetString($bytes)\n' +
        "[Console]::Out.Write('home=[' + (Get-AiSmProbeValue $text 'AISM_HOME') + '] glibc=[' +" +
        " (Get-AiSmProbeValue $text 'AISM_GLIBC') + '] claude=[' + (Get-AiSmProbeValue $text 'AISM_CLAUDE') +" +
        " '] probe=[' + (Get-AiSmProbeValue $text 'AISM_PROBE') + '] absent=[' +" +
        " (Get-AiSmProbeValue $text 'AISM_NOPE') + ']')\n",
      'ascii',
    );
    const res = await run(powershell!, [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', await toWin(script), await toWin(answerFile),
    ]);
    assert.equal(res.code, 0, res.out);
    assert.equal(
      res.out,
      'home=[/home/you] glibc=[glibc 2.39] claude=[yes] probe=[ok] absent=[]',
      'every key must read back verbatim out of UTF-16LE bytes',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the allow-list gates end at the STRING end: a trailing newline never passes', { skip }, async () => {
  // .NET's `$` also matches BEFORE a final newline, so a `$`-anchored gate
  // accepted "/home/you/app\n" — a value that would then reach a wsl.exe
  // command line with the newline still on it. Every pattern therefore ends
  // in \z. All four gates are checked here because they share one rule.
  const dir = await mkdtemp(join(tmpdir(), 'ai-sm-anchor-'));
  try {
    const script = join(dir, 'anchor.ps1');
    await writeFile(
      script,
      String.raw`
$ErrorActionPreference = 'Stop'
. $args[0]
. (Get-AiSmCommonPath -ScriptDir (Split-Path -Parent $args[0]))
$lf = [string][char]10
$out = ''
$out += 'path=[' + [bool](Test-AiSmLinuxPath '/home/you/app') + '/' + [bool](Test-AiSmLinuxPath ('/home/you/app' + $lf)) + '] '
$out += 'distro=[' + [bool](Test-AiSmDistroName 'Ubuntu-24.04') + '/' + [bool](Test-AiSmDistroName ('Ubuntu-24.04' + $lf)) + '] '
$out += 'dataDir=[' + [bool](Test-AiSmDataDir '~/.ai-session-manager') + '/' + [bool](Test-AiSmDataDir ('~/.ai-session-manager' + $lf)) + '] '
$out += 'version=[' + [bool](Test-AiSmBundleVersion 'v0.2.0') + '/' + [bool](Test-AiSmBundleVersion ('v0.2.0' + $lf)) + ']'
[Console]::Out.Write($out)
`,
      'ascii',
    );
    const res = await run(powershell!, [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      await toWin(script),
      await toWin(join(helpersDir, 'helper-common.ps1')),
    ]);
    assert.equal(res.code, 0, res.out);
    assert.equal(
      res.out.trim(),
      'path=[True/False] distro=[True/False] dataDir=[True/False] version=[True/False]',
      'every gate must accept the value and reject the same value plus a newline',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the launcher config the installer writes is exactly what the launcher reads back', { skip }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-sm-cfg-'));
  try {
    const script = join(dir, 'probe.ps1');
    await writeFile(
      script,
      String.raw`
$ErrorActionPreference = 'Stop'
. $args[0]
. (Get-AiSmCommonPath -ScriptDir (Split-Path -Parent $args[0]))
$written = Write-AiSmLauncherConfig -ConfigDir $args[1] -Distro 'Ubuntu-22.04' -AppDir '/home/them/.ai-session-manager/app' -Version 'v0.2.0'
$back = Get-AiSmFileConfig -Dir $args[1]
$resolved = Resolve-AiSmConfig -ScriptRoot 'C:\Programs\AI Session Manager' -ConfigDir $args[1] -DefaultDistro '' -DefaultRepoPath ''
[Console]::Out.Write("distro=[$($back.Distro)] repo=[$($back.RepoPath)] src=[$($resolved.DistroSource)/$($resolved.RepoPathSource)] resolved=[$($resolved.Distro)|$($resolved.RepoPath)]")
`,
      'ascii',
    );
    const res = await run(powershell!, [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      await toWin(script),
      await toWin(join(helpersDir, 'helper-common.ps1')),
      await toWin(dir),
    ]);
    assert.equal(res.code, 0, res.out);
    assert.match(
      res.out,
      /distro=\[Ubuntu-22\.04\] repo=\[\/home\/them\/\.ai-session-manager\/app\/current\] src=\[config file\/config file\] resolved=\[Ubuntu-22\.04\|\/home\/them\/\.ai-session-manager\/app\/current\]/,
      res.out,
    );
    // install-info.txt is the uninstaller's input: plain key=value, no JSON.
    const info = readFileSync(join(dir, 'install-info.txt'), 'utf8').replaceAll('\r', '');
    assert.equal(info.trim(), 'distro=Ubuntu-22.04\nappDir=/home/them/.ai-session-manager/app\nversion=v0.2.0');
    // No BOM: Inno reads these files line by line.
    assert.notEqual(readFileSync(join(dir, 'launcher-config.json'))[0], 0xef);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
