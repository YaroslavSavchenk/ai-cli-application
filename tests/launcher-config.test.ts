/**
 * `launcher/config-common.ps1` — the shared distro / repo-path resolution the
 * Windows launcher and the shortcut maker both dot-source.
 *
 * Why this file exists: both scripts used to hardcode the author's distro and
 * clone, so a downloaded copy started the wrong repo. They now DERIVE both
 * values from their own location under the WSL share
 * (`\\wsl.localhost\<distro>\<linux path>\launcher`). That makes the derivation
 * an injection-relevant surface: those two strings are the only ones that ever
 * reach a WSL command line, and they are gated by an allow-list regex, not by
 * escaping. So what is pinned here is:
 *
 *   - which shapes derive, and which ones must derive NOTHING (`$null`) so the
 *     caller keeps its defaults — including the look-alike hosts
 *     `\\wsl.localhost.evil\…` and `\\wsl.localhostx\…`;
 *   - that segments come back VERBATIM: no decoding, no unescaping, no
 *     normalization can smuggle a character past the caller's allow-list;
 *   - the precedence env var > launcher-config.json > launcher location >
 *     built-in default, with the `source` labels the error hints are phrased
 *     from - including that a CORRUPT config file throws instead of falling
 *     through to a guess, and that the built-in defaults are EMPTY, so a
 *     launcher that resolves nothing fails with a message;
 *   - end to end: a launcher copied to a path the allow-list rejects EXITS 1
 *     and never silently falls back to the author's repo (that would start a
 *     backend for a repo the user does not have).
 *
 * Everything runs `powershell.exe` through WSL interop against the real
 * scripts. Skipped cleanly wherever `powershell.exe` / `wslpath` are absent
 * (CI's ubuntu runner has no Windows side), so `npm test` stays one command.
 *
 * Read-only by construction: the only `launch.ps1` invocation is `-Status` on a
 * copy whose derived path is INVALID, so it dies at the allow-list before it
 * ever reaches `wsl.exe`; `make-shortcut.ps1` is only ever run with `-DryRun`,
 * and the user's Desktop shortcut is stat'ed before and after to prove it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { accessSync, constants, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, copyFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { projectRoot } from './helpers.ts';

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

const powershell = onPath('powershell.exe');
const wslpathBin = onPath('wslpath');
const skip: string | false = powershell
  ? wslpathBin
    ? false
    : 'wslpath not on PATH (not inside WSL)'
  : 'powershell.exe not on PATH (no Windows interop)';

interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** stdout + stderr, CR stripped — PowerShell wraps and CRLF-terminates. */
  out: string;
}

/** Spawn a command, capture everything, never throw on a non-zero exit. */
function run(exe: string, args: string[], timeoutMs = 60_000): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`timed out after ${timeoutMs}ms: ${exe} ${args.join(' ')}`));
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c: string) => (stdout += c));
    child.stderr.on('data', (c: string) => (stderr += c));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const clean = (s: string) => s.replaceAll('\r', '');
      resolve({
        code,
        signal,
        stdout: clean(stdout),
        stderr: clean(stderr),
        out: clean(stdout) + clean(stderr),
      });
    });
  });
}

/** `wslpath -w` — the `\\wsl.localhost\<distro>\…` form Windows needs. */
async function toWindowsPath(linuxPath: string): Promise<string> {
  const { stdout } = await run(wslpathBin!, ['-w', linuxPath]);
  const win = stdout.trim();
  assert.ok(win.length > 0, `wslpath -w produced nothing for ${linuxPath}`);
  return win;
}

// --- the batched probe ------------------------------------------------------
// One powershell.exe invocation answers every pure-function case (~0.4 s);
// invoking it per assertion would cost seconds for no extra proof.

const PROBE_PS1 = String.raw`
$ErrorActionPreference = 'Stop'
. $args[0]
$cases = (Get-Content -LiteralPath $args[1] -Raw) | ConvertFrom-Json

# The two allow-list patterns launch.ps1 / make-shortcut.ps1 gate on, copied
# verbatim so a derived value is judged by the SAME regex engine that gates it.
# They end in \z, not $: .NET's $ also matches before a trailing newline.
$repoPattern   = '^/[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*\z'
$distroPattern = '^[A-Za-z0-9._-]+\z'

$location = @()
foreach ($c in $cases.location) {
    $r = Get-AiSmLocationConfig -ScriptRoot $c
    if ($null -eq $r) {
        $location += [pscustomobject]@{ input = $c; result = $null }
    } else {
        $location += [pscustomobject]@{
            input  = $c
            result = [pscustomobject]@{
                Distro   = $r.Distro
                RepoPath = $r.RepoPath
                RepoOk   = [bool]($r.RepoPath -match $repoPattern)
                DistroOk = [bool]($r.Distro -match $distroPattern)
            }
        }
    }
}

$resolve = @()
foreach ($c in $cases.resolve) {
    if ($null -ne $c.distroEnv) { $env:AI_SM_DISTRO = $c.distroEnv }
    else { Remove-Item Env:AI_SM_DISTRO -ErrorAction SilentlyContinue }
    if ($null -ne $c.repoEnv) { $env:AI_SM_REPO_PATH = $c.repoEnv }
    else { Remove-Item Env:AI_SM_REPO_PATH -ErrorAction SilentlyContinue }

    $r = Resolve-AiSmConfig -ScriptRoot $c.scriptRoot -DefaultDistro $c.defaultDistro -DefaultRepoPath $c.defaultRepoPath
    $resolve += [pscustomobject]@{
        name           = $c.name
        Distro         = $r.Distro
        DistroSource   = $r.DistroSource
        RepoPath       = $r.RepoPath
        RepoPathSource = $r.RepoPathSource
        line           = (Format-AiSmConfigLine $r)
    }
}
Remove-Item Env:AI_SM_DISTRO -ErrorAction SilentlyContinue
Remove-Item Env:AI_SM_REPO_PATH -ErrorAction SilentlyContinue

# launcher-config.json: one directory per case, written here so the file
# really is read from disk by the real function.
$file = @()
foreach ($c in $cases.file) {
    $dir = Join-Path $args[2] $c.name
    [void](New-Item -ItemType Directory -Force -Path $dir)
    if ($null -ne $c.body) {
        Set-Content -LiteralPath (Join-Path $dir 'launcher-config.json') -Value $c.body -Encoding UTF8 -NoNewline
    }
    if ($null -ne $c.distroEnv) { $env:AI_SM_DISTRO = $c.distroEnv }
    else { Remove-Item Env:AI_SM_DISTRO -ErrorAction SilentlyContinue }
    if ($null -ne $c.repoEnv) { $env:AI_SM_REPO_PATH = $c.repoEnv }
    else { Remove-Item Env:AI_SM_REPO_PATH -ErrorAction SilentlyContinue }

    $entry = [ordered]@{
        name = $c.name; error = $null; present = $false
        distro = $null; repo = $null; distroOk = $null; repoOk = $null
        resolveError = $null; rDistro = $null; rDistroSrc = $null; rRepo = $null; rRepoSrc = $null
    }
    try {
        $r = Get-AiSmFileConfig -Dir $dir
        if ($null -ne $r) {
            $entry.present = $true
            $entry.distro = $r.Distro
            $entry.repo = $r.RepoPath
            $entry.distroOk = [bool](Test-AiSmDistroName $r.Distro)
            $entry.repoOk = [bool](Test-AiSmLinuxPath $r.RepoPath)
        }
    } catch { $entry.error = $_.Exception.Message }
    try {
        $rr = Resolve-AiSmConfig -ScriptRoot $c.scriptRoot -ConfigDir $dir -DefaultDistro '' -DefaultRepoPath ''
        $entry.rDistro = $rr.Distro
        $entry.rDistroSrc = $rr.DistroSource
        $entry.rRepo = $rr.RepoPath
        $entry.rRepoSrc = $rr.RepoPathSource
    } catch { $entry.resolveError = $_.Exception.Message }
    $file += [pscustomobject]$entry
}
Remove-Item Env:AI_SM_DISTRO -ErrorAction SilentlyContinue
Remove-Item Env:AI_SM_REPO_PATH -ErrorAction SilentlyContinue

$hint = @()
foreach ($c in $cases.hint) {
    $hint += [pscustomobject]@{
        source = $c.source
        kind   = $c.kind
        text   = (Get-AiSmConfigHint -Source $c.source -Kind $c.kind)
    }
}

$payload = [pscustomobject]@{ location = @($location); resolve = @($resolve); hint = @($hint); file = @($file) }
Write-Host '<<<JSON'
[Console]::Out.Write((ConvertTo-Json -InputObject $payload -Depth 8 -Compress))
Write-Host ''
Write-Host 'JSON>>>'
`;

interface LocationCase {
  input: string | null;
  result: { Distro: string; RepoPath: string; RepoOk: boolean; DistroOk: boolean } | null;
}
interface ResolveCase {
  name: string;
  Distro: string;
  DistroSource: string;
  RepoPath: string;
  RepoPathSource: string;
  line: string;
}
interface HintCase {
  source: string;
  kind: string;
  text: string;
}
interface FileCase {
  name: string;
  error: string | null;
  present: boolean;
  distro: string | null;
  repo: string | null;
  distroOk: boolean | null;
  repoOk: boolean | null;
  resolveError: string | null;
  rDistro: string | null;
  rDistroSrc: string | null;
  rRepo: string | null;
  rRepoSrc: string | null;
}
interface Probe {
  location: LocationCase[];
  resolve: ResolveCase[];
  hint: HintCase[];
  file: FileCase[];
}

const UNC = '\\\\wsl.localhost\\';
const LEGACY = '\\\\wsl$\\';
const PROVIDER = 'Microsoft.PowerShell.Core\\FileSystem::';

/** Every `Get-AiSmLocationConfig` input, in the order the probe reports them. */
const LOCATION_INPUTS: (string | null)[] = [
  /* 0 */ UNC + 'Ubuntu-22.04\\home\\them\\ai-cli-application\\launcher',
  /* 1 */ LEGACY + 'Ubuntu-22.04\\home\\them\\ai-cli-application\\launcher',
  /* 2 */ PROVIDER + UNC + 'Ubuntu-22.04\\home\\them\\ai-cli-application\\launcher',
  /* 3 */ 'microsoft.powershell.core\\filesystem::' +
    '\\\\WSL.LOCALHOST\\Ubuntu-22.04\\home\\them\\ai-cli-application\\Launcher',
  /* 4 */ '\\\\WSL$\\Ubuntu-22.04\\home\\them\\ai-cli-application\\LAUNCHER',
  /* 5 */ UNC + 'Ubuntu-22.04\\home\\them\\ai-cli-application\\launcher\\',
  /* 6 */ 'C:\\tools\\launcher',
  /* 7 */ '\\\\server\\share\\launcher',
  /* 8 */ UNC + 'Ubuntu-24.04',
  /* 9 */ '',
  /* 10 */ null,
  /* 11 */ '\\\\wsl.localhost.evil\\x\\launcher',
  /* 12 */ '\\\\wsl.localhostx\\x\\launcher',
  /* 13 */ '\\\\wsl$evil\\x\\launcher',
  /* 14 */ UNC + 'Ubuntu-24.04\\home\\a b\\my repo\\launcher',
  /* 15 */ UNC + 'Ubuntu-24.04\\home\\x\\..\\y\\launcher',
  /* 16 */ UNC + 'Ubuntu-24.04\\home\\$(whoami)\\repo\\launcher',
  /* 17 */ UNC + 'Ubuntu-24.04\\home\\a`b\\repo\\launcher',
  /* 18 */ UNC + 'Ubuntu-24.04\\home\\a%20b\\repo\\launcher',
  /* 19 */ UNC + 'Ubuntu-24.04\\launcher',
  /* 20 */ UNC + 'Ubuntu-24.04\\home\\them\\ai-cli-application',
  /* 21 */ UNC + 'Ubuntu 24.04\\home\\them\\repo\\launcher',
  /* 22 */ UNC + '..\\home\\them\\repo\\launcher',
];

const D_DISTRO = 'Ubuntu-24.04';
const D_REPO = '/home/you/projects/ai-cli-application';
const DERIVABLE = UNC + 'Ubuntu-22.04\\home\\them\\ai-cli-application\\launcher';

const RESOLVE_CASES = [
  { name: 'derived', scriptRoot: DERIVABLE, distroEnv: null, repoEnv: null },
  { name: 'no-derivation', scriptRoot: 'C:\\tools\\launcher', distroEnv: null, repoEnv: null },
  { name: 'distro-env-wins', scriptRoot: DERIVABLE, distroEnv: 'Debian', repoEnv: null },
  { name: 'repo-env-wins', scriptRoot: DERIVABLE, distroEnv: null, repoEnv: '/srv/app' },
  { name: 'both-env-no-derivation', scriptRoot: 'C:\\tools\\launcher', distroEnv: 'Debian', repoEnv: '/srv/app' },
  { name: 'empty-env-ignored', scriptRoot: DERIVABLE, distroEnv: '', repoEnv: '' },
  { name: 'empty-env-no-derivation', scriptRoot: 'C:\\tools\\launcher', distroEnv: '', repoEnv: '' },
].map((c) => ({ ...c, defaultDistro: D_DISTRO, defaultRepoPath: D_REPO }));

const HINT_CASES = [
  { source: 'launcher location', kind: 'RepoPath' },
  { source: 'launcher location', kind: 'Distro' },
  { source: 'AI_SM_REPO_PATH', kind: 'RepoPath' },
  { source: 'AI_SM_DISTRO', kind: 'Distro' },
  { source: 'built-in default', kind: 'RepoPath' },
  { source: 'built-in default', kind: 'Distro' },
  { source: 'config file', kind: 'RepoPath' },
  { source: 'config file', kind: 'Distro' },
];

/**
 * launcher-config.json cases. `body` is written verbatim (or not at all when
 * null); `scriptRoot` decides what derivation WOULD produce, so precedence is
 * visible in the same case.
 */
const FILE_CASES = [
  { name: 'present', body: '{"distro":"Deb","appPath":"/srv/app/current"}', scriptRoot: DERIVABLE },
  { name: 'absent', body: null, scriptRoot: DERIVABLE },
  { name: 'empty-object', body: '{}', scriptRoot: DERIVABLE },
  { name: 'only-distro', body: '{"distro":"Deb"}', scriptRoot: DERIVABLE },
  {
    name: 'extra-keys',
    body: '{"note":"hi","distro":"Deb","nested":{"a":1},"appPath":"/srv/app/current"}',
    scriptRoot: DERIVABLE,
  },
  { name: 'env-wins', body: '{"distro":"Deb","appPath":"/srv/app/current"}', scriptRoot: DERIVABLE, distroEnv: 'FromEnv' },
  { name: 'no-derivation', body: '{"distro":"Deb","appPath":"/srv/app/current"}', scriptRoot: 'C:\\Programs\\AI Session Manager' },
  { name: 'nothing-at-all', body: null, scriptRoot: 'C:\\Programs\\AI Session Manager' },
  { name: 'unsafe-values', body: '{"distro":"Ubuntu 24","appPath":"/home/a b/app/current"}', scriptRoot: DERIVABLE },
  { name: 'corrupt', body: '{ oops', scriptRoot: DERIVABLE },
  { name: 'non-string', body: '{"distro":5}', scriptRoot: DERIVABLE },
  { name: 'null-value', body: '{"appPath":null}', scriptRoot: DERIVABLE },
  { name: 'blank-string', body: '{"appPath":"   "}', scriptRoot: DERIVABLE },
  { name: 'json-array', body: '[1,2]', scriptRoot: DERIVABLE },
  { name: 'json-scalar', body: '"hello"', scriptRoot: DERIVABLE },
  { name: 'empty-file', body: '', scriptRoot: DERIVABLE },
].map((c) => ({ distroEnv: null as string | null, repoEnv: null as string | null, ...c }));

let probePromise: Promise<Probe> | null = null;

function probe(): Promise<Probe> {
  probePromise ??= (async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ai-sm-lcfg-'));
    try {
      const script = join(dir, 'probe.ps1');
      const casesFile = join(dir, 'cases.json');
      await writeFile(script, PROBE_PS1, 'ascii');
      await writeFile(
        casesFile,
        JSON.stringify({
          location: LOCATION_INPUTS,
          resolve: RESOLVE_CASES,
          hint: HINT_CASES,
          file: FILE_CASES,
        }),
        'utf8',
      );
      const res = await run(powershell!, [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        await toWindowsPath(script),
        await toWindowsPath(join(projectRoot, 'launcher', 'config-common.ps1')),
        await toWindowsPath(casesFile),
        await toWindowsPath(dir),
      ]);
      assert.equal(res.code, 0, `probe.ps1 exited ${res.code}:\n${res.out}`);
      const start = res.out.indexOf('<<<JSON\n');
      const end = res.out.indexOf('\nJSON>>>');
      assert.ok(start >= 0 && end > start, `probe.ps1 produced no JSON block:\n${res.out}`);
      return JSON.parse(res.out.slice(start + '<<<JSON\n'.length, end)) as Probe;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  })();
  return probePromise;
}

async function location(index: number): Promise<LocationCase> {
  const all = (await probe()).location;
  assert.equal(all.length, LOCATION_INPUTS.length, 'probe returned the wrong number of location cases');
  const c = all[index]!;
  // ConvertTo-Json turns a $null input into JSON null; '' survives as ''.
  assert.equal(c.input ?? null, LOCATION_INPUTS[index], `location case ${index} is not the input we sent`);
  return c;
}

async function fileCase(name: string): Promise<FileCase> {
  const c = (await probe()).file.find((f) => f.name === name);
  assert.ok(c, `probe returned no file case '${name}'`);
  return c;
}

async function resolved(name: string): Promise<ResolveCase> {
  const c = (await probe()).resolve.find((r) => r.name === name);
  assert.ok(c, `probe returned no resolve case '${name}'`);
  return c;
}

// --- Get-AiSmLocationConfig: what derives -----------------------------------

test('Get-AiSmLocationConfig: a \\\\wsl.localhost launcher path states both the distro and the repo', { skip }, async () => {
  const c = await location(0);
  assert.deepEqual(c.result, {
    Distro: 'Ubuntu-22.04',
    RepoPath: '/home/them/ai-cli-application',
    RepoOk: true,
    DistroOk: true,
  });
});

test('Get-AiSmLocationConfig: the legacy \\\\wsl$ prefix derives identically', { skip }, async () => {
  const c = await location(1);
  assert.equal(c.result?.Distro, 'Ubuntu-22.04');
  assert.equal(c.result?.RepoPath, '/home/them/ai-cli-application');
});

test('Get-AiSmLocationConfig: a provider-qualified location is stripped before matching', { skip }, async () => {
  const c = await location(2);
  assert.equal(c.result?.Distro, 'Ubuntu-22.04');
  assert.equal(c.result?.RepoPath, '/home/them/ai-cli-application');
});

test('Get-AiSmLocationConfig: host, provider prefix and the trailing `launcher` folder all match case-insensitively', { skip }, async () => {
  // Windows hands back whatever casing the user typed; the derivation must not
  // depend on it. The DISTRO segment keeps its own casing — it is a name, not a
  // keyword.
  for (const index of [3, 4]) {
    const c = await location(index);
    assert.equal(c.result?.Distro, 'Ubuntu-22.04', `case ${index}`);
    assert.equal(c.result?.RepoPath, '/home/them/ai-cli-application', `case ${index}`);
  }
});

test('Get-AiSmLocationConfig: a trailing backslash does not invent an empty segment', { skip }, async () => {
  const c = await location(5);
  assert.equal(c.result?.RepoPath, '/home/them/ai-cli-application');
});

test('Get-AiSmLocationConfig: a folder that is NOT named `launcher` is kept as the repo', { skip }, async () => {
  // Only a trailing 'launcher' is dropped; anything else is where the caller
  // actually runs from and stays part of the path.
  const c = await location(20);
  assert.equal(c.result?.RepoPath, '/home/them/ai-cli-application');
});

// --- Get-AiSmLocationConfig: what must derive NOTHING ------------------------

test('Get-AiSmLocationConfig: a non-WSL location derives nothing, so the caller keeps its defaults', { skip }, async () => {
  for (const index of [6, 7]) {
    const c = await location(index);
    assert.equal(c.result, null, `${LOCATION_INPUTS[index]} must derive nothing`);
  }
});

test('Get-AiSmLocationConfig: a bare \\\\wsl.localhost\\<distro> states no repo at all -> null', { skip }, async () => {
  const c = await location(8);
  assert.equal(c.result, null);
});

test('Get-AiSmLocationConfig: an empty or absent ScriptRoot derives nothing', { skip }, async () => {
  assert.equal((await location(9)).result, null);
  assert.equal((await location(10)).result, null);
});

test('Get-AiSmLocationConfig: look-alike hosts (wsl.localhost.evil, wsl.localhostx, wsl$evil) derive NOTHING', { skip }, async () => {
  // A prefix match without the trailing separator would let any UNC share the
  // attacker controls name a distro and a repo path. The separator is part of
  // the compared prefix, so these are not WSL paths at all.
  for (const index of [11, 12, 13]) {
    const c = await location(index);
    assert.equal(c.result, null, `${LOCATION_INPUTS[index]} must not look like a WSL path`);
  }
});

// --- verbatim segments: the allow-list is the only gate ----------------------

test('Get-AiSmLocationConfig: a path with spaces comes back VERBATIM and fails the allow-list', { skip }, async () => {
  const c = await location(14);
  assert.equal(c.result?.RepoPath, '/home/a b/my repo');
  assert.equal(c.result?.RepoOk, false, 'a spaced path must be rejected by the caller allow-list');
});

test('Get-AiSmLocationConfig: `$(`, a backtick and `%20` are neither decoded nor escaped', { skip }, async () => {
  // Nothing here unescapes or normalizes; the segments are exactly what Windows
  // reported. Whatever survives has to die on the caller's allow-list — that
  // regex is the injection gate, since these strings reach a WSL command line.
  const dollar = await location(16);
  assert.equal(dollar.result?.RepoPath, '/home/$(whoami)/repo');
  assert.equal(dollar.result?.RepoOk, false);

  const tick = await location(17);
  assert.equal(tick.result?.RepoPath, '/home/a`b/repo');
  assert.equal(tick.result?.RepoOk, false);

  const encoded = await location(18);
  assert.equal(encoded.result?.RepoPath, '/home/a%20b/repo', 'percent-encoding must NOT be decoded');
  assert.equal(encoded.result?.RepoOk, false, '% is outside the allow-list, so the literal form is rejected');
});

test('Get-AiSmLocationConfig: a distro name with a space is returned as-is and fails the distro allow-list', { skip }, async () => {
  const c = await location(21);
  assert.equal(c.result?.Distro, 'Ubuntu 24.04');
  assert.equal(c.result?.DistroOk, false);
});

test('Get-AiSmLocationConfig: `..` survives verbatim AND passes the allow-list (documented limit)', { skip }, async () => {
  // KNOWN, ACCEPTED: '.' is inside the allow-list character class, so a '..'
  // segment is not rejected. It is not a traversal hole — the value describes
  // where the launcher itself already lives, and Windows never reports a real
  // location in that form — but it IS the one shape that gets through, so it is
  // pinned rather than assumed.
  const c = await location(15);
  assert.equal(c.result?.RepoPath, '/home/x/../y');
  assert.equal(c.result?.RepoOk, true);
});

test('Get-AiSmLocationConfig: a `..` DISTRO segment passes the distro allow-list — the installed-distro check is the second gate', { skip }, async () => {
  // '.' is inside the distro allow-list class, so '..' gets through the regex.
  // It is stopped one step later in launch.ps1, which requires the name to be
  // in `wsl.exe -l -q` (exactly, or as a unique prefix) before any `wsl.exe -d`
  // runs. Pinned here because the regex alone does NOT reject it; the
  // membership check is what does, and that half is not exercised by this file
  // (it would need a real wsl.exe call).
  const c = await location(22);
  assert.equal(c.result?.Distro, '..');
  assert.equal(c.result?.DistroOk, true);
  assert.equal(c.result?.RepoPath, '/home/them/repo');
});

test('Get-AiSmLocationConfig: a launcher at the distro ROOT derives `/`, which the allow-list rejects', { skip }, async () => {
  const c = await location(19);
  assert.equal(c.result?.Distro, 'Ubuntu-24.04');
  assert.equal(c.result?.RepoPath, '/');
  assert.equal(c.result?.RepoOk, false, '`/` must never be accepted as a repo path');
});

// --- Resolve-AiSmConfig: precedence + source labels --------------------------

test('Resolve-AiSmConfig: with no env vars, the launcher location wins over the built-in defaults', { skip }, async () => {
  const r = await resolved('derived');
  assert.equal(r.Distro, 'Ubuntu-22.04');
  assert.equal(r.DistroSource, 'launcher location');
  assert.equal(r.RepoPath, '/home/them/ai-cli-application');
  assert.equal(r.RepoPathSource, 'launcher location');
  assert.notEqual(r.RepoPath, D_REPO);
});

test('Resolve-AiSmConfig: only an underivable location falls back to the built-in defaults', { skip }, async () => {
  const r = await resolved('no-derivation');
  assert.deepEqual(
    { d: r.Distro, ds: r.DistroSource, p: r.RepoPath, ps: r.RepoPathSource },
    { d: D_DISTRO, ds: 'built-in default', p: D_REPO, ps: 'built-in default' },
  );
});

test('Resolve-AiSmConfig: AI_SM_DISTRO beats the location, and the repo still derives', { skip }, async () => {
  const r = await resolved('distro-env-wins');
  assert.equal(r.Distro, 'Debian');
  assert.equal(r.DistroSource, 'AI_SM_DISTRO');
  assert.equal(r.RepoPath, '/home/them/ai-cli-application');
  assert.equal(r.RepoPathSource, 'launcher location');
});

test('Resolve-AiSmConfig: AI_SM_REPO_PATH beats the location, and the distro still derives', { skip }, async () => {
  const r = await resolved('repo-env-wins');
  assert.equal(r.RepoPath, '/srv/app');
  assert.equal(r.RepoPathSource, 'AI_SM_REPO_PATH');
  assert.equal(r.Distro, 'Ubuntu-22.04');
  assert.equal(r.DistroSource, 'launcher location');
});

test('Resolve-AiSmConfig: env vars beat the built-in defaults when nothing derives', { skip }, async () => {
  const r = await resolved('both-env-no-derivation');
  assert.deepEqual(
    { d: r.Distro, ds: r.DistroSource, p: r.RepoPath, ps: r.RepoPathSource },
    { d: 'Debian', ds: 'AI_SM_DISTRO', p: '/srv/app', ps: 'AI_SM_REPO_PATH' },
  );
});

test('Resolve-AiSmConfig: an EMPTY env var is ignored, it never blanks the config', { skip }, async () => {
  const derived = await resolved('empty-env-ignored');
  assert.equal(derived.Distro, 'Ubuntu-22.04');
  assert.equal(derived.DistroSource, 'launcher location');
  assert.equal(derived.RepoPath, '/home/them/ai-cli-application');
  assert.equal(derived.RepoPathSource, 'launcher location');

  const fallback = await resolved('empty-env-no-derivation');
  assert.equal(fallback.Distro, D_DISTRO);
  assert.equal(fallback.DistroSource, 'built-in default');
  assert.equal(fallback.RepoPath, D_REPO);
  assert.equal(fallback.RepoPathSource, 'built-in default');
});

// --- launcher-config.json (what the Windows Setup writes) --------------------

test('Get-AiSmFileConfig: the installer config beats the launcher location, and an env var beats both', { skip }, async () => {
  const present = await fileCase('present');
  assert.equal(present.error, null);
  assert.equal(present.distro, 'Deb');
  assert.equal(present.repo, '/srv/app/current');
  // Derivation would have produced Ubuntu-22.04 + /home/them/ai-cli-application.
  assert.deepEqual(
    { d: present.rDistro, ds: present.rDistroSrc, p: present.rRepo, ps: present.rRepoSrc },
    { d: 'Deb', ds: 'config file', p: '/srv/app/current', ps: 'config file' },
  );

  const env = await fileCase('env-wins');
  assert.equal(env.rDistro, 'FromEnv');
  assert.equal(env.rDistroSrc, 'AI_SM_DISTRO');
  assert.equal(env.rRepo, '/srv/app/current', 'the file still supplies what the env does not');
  assert.equal(env.rRepoSrc, 'config file');
});

test('Get-AiSmFileConfig: an installed launcher (no derivable location) reads its config file', { skip }, async () => {
  // The real installed shape: scripts on a plain Windows path, so nothing can
  // be derived and the built-in defaults are empty. Only the file answers.
  const c = await fileCase('no-derivation');
  assert.deepEqual(
    { d: c.rDistro, ds: c.rDistroSrc, p: c.rRepo, ps: c.rRepoSrc },
    { d: 'Deb', ds: 'config file', p: '/srv/app/current', ps: 'config file' },
  );
});

test('Get-AiSmFileConfig: no file at all is not an error - derivation still wins', { skip }, async () => {
  const absent = await fileCase('absent');
  assert.equal(absent.error, null);
  assert.equal(absent.present, false, 'an absent file must resolve to $null, not to an empty config');
  assert.equal(absent.rDistro, 'Ubuntu-22.04');
  assert.equal(absent.rDistroSrc, 'launcher location');
});

test('Get-AiSmFileConfig: a config stating nothing states nothing - it does not blank the config', { skip }, async () => {
  const empty = await fileCase('empty-object');
  assert.equal(empty.error, null);
  assert.equal(empty.distro, null);
  assert.equal(empty.repo, null);
  assert.equal(empty.rDistroSrc, 'launcher location', '{} must fall through, not override');

  const half = await fileCase('only-distro');
  assert.equal(half.error, null);
  assert.equal(half.rDistro, 'Deb');
  assert.equal(half.rDistroSrc, 'config file');
  assert.equal(half.rRepo, '/home/them/ai-cli-application');
  assert.equal(half.rRepoSrc, 'launcher location');
});

test('Get-AiSmFileConfig: keys it does not know are ignored', { skip }, async () => {
  const c = await fileCase('extra-keys');
  assert.equal(c.error, null);
  assert.equal(c.distro, 'Deb');
  assert.equal(c.repo, '/srv/app/current');
});

test('Get-AiSmFileConfig: a config file that cannot be believed THROWS - it never falls through', { skip }, async () => {
  // This is the whole point of the file being an error instead of a hint: an
  // installed launcher whose config is damaged must stop, not quietly start a
  // backend for whatever it can still derive or default to.
  const cases: [string, RegExp][] = [
    ['corrupt', /is not valid JSON/],
    ['non-string', /"distro" must be a non-empty string/],
    ['null-value', /"appPath" must be a non-empty string/],
    ['blank-string', /"appPath" must be a non-empty string/],
    ['json-array', /must contain a JSON object/],
    ['json-scalar', /must contain a JSON object/],
    ['empty-file', /is empty/],
  ];
  for (const [name, reason] of cases) {
    const c = await fileCase(name);
    assert.ok(c.error, `${name}: expected a throw, got distro=${c.distro} repo=${c.repo}`);
    assert.match(c.error, reason, name);
    assert.match(c.error, /re-run the Setup \(or reinstall\)/, `${name}: must say how to fix it`);
    // Resolve-AiSmConfig propagates it rather than answering with a guess.
    assert.ok(c.resolveError, `${name}: Resolve-AiSmConfig must throw too`);
    assert.equal(c.rDistro, null, name);
  }
});

test('Get-AiSmFileConfig: file values are returned verbatim and gated by the SAME allow-list', { skip }, async () => {
  // A hand-edited config file is no way around the injection gate: what it
  // says arrives unchanged and is judged by the same two functions.
  const c = await fileCase('unsafe-values');
  assert.equal(c.error, null);
  assert.equal(c.distro, 'Ubuntu 24');
  assert.equal(c.repo, '/home/a b/app/current');
  assert.equal(c.distroOk, false);
  assert.equal(c.repoOk, false);
});

test('Resolve-AiSmConfig: nothing anywhere resolves to EMPTY, never to a built-in guess', { skip }, async () => {
  const c = await fileCase('nothing-at-all');
  assert.equal(c.error, null);
  assert.equal(c.rDistro, '');
  assert.equal(c.rRepo, '');
  assert.equal(c.rDistroSrc, 'built-in default');
  assert.equal(c.rRepoSrc, 'built-in default');
});

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

// --- Format-AiSmConfigLine ---------------------------------------------------

test('Format-AiSmConfigLine: one shared source collapses into a single `(from …)`', { skip }, async () => {
  assert.equal(
    (await resolved('derived')).line,
    "Config: distro 'Ubuntu-22.04', repo '/home/them/ai-cli-application' (from launcher location)",
  );
  assert.equal(
    (await resolved('no-derivation')).line,
    `Config: distro '${D_DISTRO}', repo '${D_REPO}' (from built-in default)`,
  );
});

test('Format-AiSmConfigLine: mixed sources are named per value', { skip }, async () => {
  assert.equal(
    (await resolved('distro-env-wins')).line,
    "Config: distro 'Debian' (from AI_SM_DISTRO), repo '/home/them/ai-cli-application' (from launcher location)",
  );
  assert.equal(
    (await resolved('repo-env-wins')).line,
    "Config: distro 'Ubuntu-22.04' (from launcher location), repo '/srv/app' (from AI_SM_REPO_PATH)",
  );
});

// --- Get-AiSmConfigHint ------------------------------------------------------

test('Get-AiSmConfigHint: the advice is phrased for where the bad value actually came from', { skip }, async () => {
  const { hint } = await probe();
  const text = (source: string, kind: string) => {
    const h = hint.find((x) => x.source === source && x.kind === kind);
    assert.ok(h, `no hint for ${source}/${kind}`);
    return h.text;
  };

  const derivedRepo = text('launcher location', 'RepoPath');
  assert.match(derivedRepo, /derived from where the launcher itself lives/);
  // The override is NOT an escape hatch: it passes the same allow-list, so the
  // hint must point at re-cloning rather than at AI_SM_REPO_PATH.
  assert.match(derivedRepo, /Clone the repo into a path built only from letters, digits/);
  assert.match(derivedRepo, /Setting AI_SM_REPO_PATH is no way around this/);
  assert.doesNotMatch(derivedRepo, /Edit the defaults/, 'editing a default cannot fix a derived value');

  const derivedDistro = text('launcher location', 'Distro');
  assert.match(derivedDistro, /distro name was derived from where the launcher itself lives/);
  assert.match(derivedDistro, /wsl\.exe -l -q lists them/);
  assert.match(derivedDistro, /AI_SM_DISTRO is checked against exactly the same character set/);

  assert.equal(text('AI_SM_REPO_PATH', 'RepoPath'), 'Fix or unset the AI_SM_REPO_PATH environment variable.');
  assert.equal(text('AI_SM_DISTRO', 'Distro'), 'Fix or unset the AI_SM_DISTRO environment variable.');

  // The built-in defaults are EMPTY now, so "edit the default" is no longer
  // advice anyone can act on: the two real fixes are an env var or a proper
  // installation.
  assert.equal(
    text('built-in default', 'RepoPath'),
    'Set AI_SM_REPO_PATH, or run the launcher from inside its own installation (the Setup writes launcher-config.json next to these scripts).',
  );
  assert.equal(
    text('built-in default', 'Distro'),
    'Set AI_SM_DISTRO, or run the launcher from inside its own installation (the Setup writes launcher-config.json next to these scripts).',
  );

  // A value that came from the installer's own config file: neither
  // re-cloning nor an env var is the point, re-running the Setup is.
  const configRepo = text('config file', 'RepoPath');
  assert.match(configRepo, /This path comes from "appPath" in launcher-config\.json next to the launcher\./);
  assert.match(configRepo, /re-run the Setup \(or reinstall\)/);
  const configDistro = text('config file', 'Distro');
  assert.match(configDistro, /This distro name comes from "distro" in launcher-config\.json next to the launcher\./);
  assert.match(configDistro, /re-run the Setup \(or reinstall\)/);
});

// --- the env var really crosses into powershell.exe (WSLENV) -----------------

test('AI_SM_REPO_PATH crosses WSL interop with WSLENV=<var>/w and wins over the location', { skip }, async () => {
  // The README tells users to set these from Windows, but the launcher is also
  // started from inside WSL; without the /w flag the value never arrives at
  // powershell.exe at all, so the override would silently do nothing.
  const dir = await mkdtemp(join(tmpdir(), 'ai-sm-lcfg-'));
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
  const root = await mkdtemp(join(tmpdir(), 'ai-sm-lcfg-'));
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
      const text = readFileSync(join(projectRoot, 'launcher', script), 'utf8');
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
    await rm(root, { recursive: true, force: true });
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

// --- Move-AiSmHostNext: promoting an updated native host ---------------------
//
// The Windows Setup installs the host into `{app}\host\next` because an in-app
// update runs it while the old host window is still open and holding those
// four files (CloseApplications=no). `launch.ps1` promotes `next\` at the next
// start. Three behaviours matter, and all three are proven against the real
// function, on a real Windows filesystem (a %TEMP% tree, not the WSL share:
// only NTFS enforces the sharing violation this has to survive), with a real
// second process holding a real lock.

const HOSTNEXT_PS1 = String.raw`
$ErrorActionPreference = 'Stop'
. $args[0]

$root = Join-Path ([System.IO.Path]::GetTempPath()) ('aism-hostnext-' + [System.Guid]::NewGuid().ToString('N'))
$HOST_FILES = @('AiSessionManagerHost.exe', 'Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll')

function New-Case {
    param([string]$Name, [bool]$WithNext)
    $dir = Join-Path $root $Name
    $hostDir = Join-Path $dir 'host'
    [void](New-Item -ItemType Directory -Force -Path $hostDir)
    foreach ($f in $HOST_FILES) {
        Set-Content -LiteralPath (Join-Path $hostDir $f) -Value ('old ' + $f) -Encoding ASCII -NoNewline
    }
    if ($WithNext) {
        $next = Join-Path $hostDir 'next'
        [void](New-Item -ItemType Directory -Force -Path $next)
        foreach ($f in $HOST_FILES) {
            Set-Content -LiteralPath (Join-Path $next $f) -Value ('new ' + $f) -Encoding ASCII -NoNewline
        }
    }
    return $hostDir
}

function Read-Text {
    # The locking helper is stopped before this runs, but Windows releases the
    # handle a moment later; retry rather than fail the whole probe on a race.
    param([string]$Path)
    for ($i = 0; $i -lt 25; $i++) {
        # [string]: Get-Content decorates its output with PSPath/PSDrive note
        # properties, and ConvertTo-Json would then serialize half of .NET.
        try { return [string](Get-Content -LiteralPath $Path -Raw -ErrorAction Stop) } catch { Start-Sleep -Milliseconds 200 }
    }
    return 'UNREADABLE'
}

function Read-Case {
    param([string]$HostDir, [string]$Result, [string[]]$Lines)
    $files = [ordered]@{}
    foreach ($f in $HOST_FILES) {
        $p = Join-Path $HostDir $f
        if (Test-Path -LiteralPath $p) { $files[$f] = (Read-Text $p) } else { $files[$f] = $null }
    }
    $nextFiles = @()
    $next = Join-Path $HostDir 'next'
    if (Test-Path -LiteralPath $next) {
        $nextFiles = @(Get-ChildItem -LiteralPath $next -File | ForEach-Object { $_.Name })
    }
    return [pscustomobject]@{
        result     = $Result
        lines      = @($Lines)
        hostFiles  = [pscustomobject]$files
        nextExists = (Test-Path -LiteralPath $next)
        nextFiles  = @($nextFiles)
    }
}

function Invoke-Promote {
    # Write-Host goes to the information stream; 6>&1 captures it beside the
    # function's return value, so one call yields both.
    param([string]$HostDir)
    $captured = @(Move-AiSmHostNext -HostDir $HostDir 6>&1)
    $result = ''
    $lines = @()
    foreach ($item in $captured) {
        if ($item -is [string]) { $result = $item } else { $lines += [string]$item }
    }
    return @($result, $lines)
}

try {
    # 1. nothing staged: a plain installed host, or a clone.
    $noneDir = New-Case 'none' $false
    $r = Invoke-Promote $noneDir
    $none = Read-Case $noneDir $r[0] $r[1]

    # 2. an update was installed and the window is closed.
    $promoteDir = New-Case 'promote' $true
    $r = Invoke-Promote $promoteDir
    $promote = Read-Case $promoteDir $r[0] $r[1]

    # 3. the old host is STILL running: the destination exe cannot be written.
    $lockedDir = New-Case 'locked' $true
    $lockTarget = Join-Path $lockedDir 'AiSessionManagerHost.exe'
    $sentinel = Join-Path $root 'locked.ready'
    $lockCmd = '$f=[System.IO.File]::Open(' + "'" + $lockTarget + "'" +
        ',[System.IO.FileMode]::Open,[System.IO.FileAccess]::ReadWrite,[System.IO.FileShare]::None); ' +
        'Set-Content -LiteralPath ' + "'" + $sentinel + "'" + ' -Value ready; Start-Sleep -Seconds 60'
    $child = Start-Process -FilePath (Get-Process -Id $PID).Path -ArgumentList '-NoProfile', '-Command', $lockCmd -PassThru -WindowStyle Hidden
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    while (-not (Test-Path -LiteralPath $sentinel) -and $sw.Elapsed.TotalSeconds -lt 20) { Start-Sleep -Milliseconds 100 }
    $lockHeld = Test-Path -LiteralPath $sentinel
    $r = Invoke-Promote $lockedDir
    try { Stop-Process -Id $child.Id -Force -ErrorAction Stop } catch { }
    $locked = Read-Case $lockedDir $r[0] $r[1]
    $locked | Add-Member -NotePropertyName lockHeld -NotePropertyValue $lockHeld

    $payload = [pscustomobject]@{ none = $none; promote = $promote; locked = $locked }
    Write-Host '<<<JSON'
    [Console]::Out.Write((ConvertTo-Json -InputObject $payload -Depth 8 -Compress))
    Write-Host ''
    Write-Host 'JSON>>>'
} finally {
    Start-Sleep -Milliseconds 200
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
`;

interface HostNextCase {
  result: string;
  lines: string[];
  hostFiles: Record<string, string | null>;
  nextExists: boolean;
  nextFiles: string[];
  lockHeld?: boolean;
}
interface HostNextProbe {
  none: HostNextCase;
  promote: HostNextCase;
  locked: HostNextCase;
}

let hostNextPromise: Promise<HostNextProbe> | null = null;

function hostNext(): Promise<HostNextProbe> {
  hostNextPromise ??= (async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ai-sm-hostnext-'));
    try {
      const script = join(dir, 'hostnext.ps1');
      await writeFile(script, HOSTNEXT_PS1, 'ascii');
      const res = await run(
        powershell!,
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          await toWindowsPath(script),
          await toWindowsPath(join(projectRoot, 'launcher', 'config-common.ps1')),
        ],
        120_000,
      );
      assert.equal(res.code, 0, `hostnext.ps1 exited ${res.code}:\n${res.out}`);
      const start = res.out.indexOf('<<<JSON\n');
      const end = res.out.indexOf('\nJSON>>>');
      assert.ok(start >= 0 && end > start, `hostnext.ps1 produced no JSON block:\n${res.out}`);
      return JSON.parse(res.out.slice(start + '<<<JSON\n'.length, end)) as HostNextProbe;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  })();
  return hostNextPromise;
}

test('Move-AiSmHostNext: no next\\ folder is a silent no-op', { skip }, async () => {
  // Every launch of an installed app calls this, and almost every launch has
  // nothing to promote: it must cost nothing and say nothing.
  const c = (await hostNext()).none;
  assert.equal(c.result, 'none');
  assert.deepEqual(c.lines, []);
  assert.equal(c.nextExists, false);
  assert.equal(c.hostFiles['AiSessionManagerHost.exe'], 'old AiSessionManagerHost.exe');
});

test('Move-AiSmHostNext: a staged host is copied over the installed one and next\\ is removed', { skip }, async () => {
  const c = (await hostNext()).promote;
  assert.equal(c.result, 'promoted');
  for (const [name, content] of Object.entries(c.hostFiles)) {
    assert.equal(content, `new ${name}`, `${name} was not promoted`);
  }
  assert.equal(c.nextExists, false, 'next\\ must be gone once every file is in place');
  assert.equal(c.lines.length, 1, `expected exactly one log line, got: ${JSON.stringify(c.lines)}`);
  assert.match(c.lines[0]!, /^Native host: updated to the version installed in .*\\host\\next\.$/);
});

test('Move-AiSmHostNext: a file still in use keeps next\\ whole and never fails the launch', { skip }, async () => {
  // The real failure mode: the update ran, the user launched again before the
  // old window was gone (or a scanner still holds the exe). Losing next\ here
  // would mean the update is silently never applied.
  const c = (await hostNext()).locked;
  assert.equal(c.lockHeld, true, 'the lock helper never signalled; the case proves nothing');
  assert.equal(c.result, 'kept');
  assert.equal(c.nextExists, true, 'the staged host must survive for the next launch');
  assert.deepEqual(c.nextFiles.sort(), [
    'AiSessionManagerHost.exe',
    'Microsoft.Web.WebView2.Core.dll',
    'Microsoft.Web.WebView2.WinForms.dll',
    'WebView2Loader.dll',
  ]);
  // The locked file is untouched, and the launch gets one line it can act on.
  assert.equal(c.hostFiles['AiSessionManagerHost.exe'], 'old AiSessionManagerHost.exe');
  assert.equal(c.lines.length, 1, `expected exactly one log line, got: ${JSON.stringify(c.lines)}`);
  assert.match(
    c.lines[0]!,
    /^Native host: AiSessionManagerHost\.exe is in use \(.+\) - keeping the updated files in .*\\host\\next and starting the host that is installed\.$/,
  );
});
