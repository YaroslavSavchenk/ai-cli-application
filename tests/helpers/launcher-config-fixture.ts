/**
 * The PowerShell harness behind the `launcher/config-common.ps1` tests —
 * `tests/release/launcher-config.test.ts` and its pieces
 * (`launcher-config-e2e`, `launcher-config-host-next`): whether
 * `powershell.exe` and `wslpath` are there (`skip` names why not), a spawn
 * that never throws on a non-zero exit, `wslpath -w`, and the BATCHED PROBE —
 * one `powershell.exe` run that answers every pure-function case of
 * `Get-AiSmLocationConfig`, `Resolve-AiSmConfig`, `Get-AiSmFileConfig`,
 * `Format-AiSmConfigLine` and `Get-AiSmConfigHint`, cached for the file that
 * asks.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { projectRoot, makeTempDir, onPath } from './helpers.ts';

// --- environment probing ----------------------------------------------------

export const powershell = onPath('powershell.exe');
export const wslpathBin = onPath('wslpath');
export const skip: string | false = powershell
  ? wslpathBin
    ? false
    : 'wslpath not on PATH (not inside WSL)'
  : 'powershell.exe not on PATH (no Windows interop)';

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** stdout + stderr, CR stripped — PowerShell wraps and CRLF-terminates. */
  out: string;
}

/** Spawn a command, capture everything, never throw on a non-zero exit. */
export function run(exe: string, args: string[], timeoutMs = 60_000): Promise<RunResult> {
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
export async function toWindowsPath(linuxPath: string): Promise<string> {
  const { stdout } = await run(wslpathBin!, ['-w', linuxPath]);
  const win = stdout.trim();
  assert.ok(win.length > 0, `wslpath -w produced nothing for ${linuxPath}`);
  return win;
}

// --- the batched probe ------------------------------------------------------
// One powershell.exe invocation answers every pure-function case (~0.4 s);
// invoking it per assertion would cost seconds for no extra proof.

export const PROBE_PS1 = String.raw`
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

export interface LocationCase {
  input: string | null;
  result: { Distro: string; RepoPath: string; RepoOk: boolean; DistroOk: boolean } | null;
}
export interface ResolveCase {
  name: string;
  Distro: string;
  DistroSource: string;
  RepoPath: string;
  RepoPathSource: string;
  line: string;
}
export interface HintCase {
  source: string;
  kind: string;
  text: string;
}
export interface FileCase {
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
export interface Probe {
  location: LocationCase[];
  resolve: ResolveCase[];
  hint: HintCase[];
  file: FileCase[];
}

export const UNC = '\\\\wsl.localhost\\';
export const LEGACY = '\\\\wsl$\\';
export const PROVIDER = 'Microsoft.PowerShell.Core\\FileSystem::';

/** Every `Get-AiSmLocationConfig` input, in the order the probe reports them. */
export const LOCATION_INPUTS: (string | null)[] = [
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

export const D_DISTRO = 'Ubuntu-24.04';
export const D_REPO = '/home/you/projects/ai-cli-application';
export const DERIVABLE = UNC + 'Ubuntu-22.04\\home\\them\\ai-cli-application\\launcher';

export const RESOLVE_CASES = [
  { name: 'derived', scriptRoot: DERIVABLE, distroEnv: null, repoEnv: null },
  { name: 'no-derivation', scriptRoot: 'C:\\tools\\launcher', distroEnv: null, repoEnv: null },
  { name: 'distro-env-wins', scriptRoot: DERIVABLE, distroEnv: 'Debian', repoEnv: null },
  { name: 'repo-env-wins', scriptRoot: DERIVABLE, distroEnv: null, repoEnv: '/srv/app' },
  { name: 'both-env-no-derivation', scriptRoot: 'C:\\tools\\launcher', distroEnv: 'Debian', repoEnv: '/srv/app' },
  { name: 'empty-env-ignored', scriptRoot: DERIVABLE, distroEnv: '', repoEnv: '' },
  { name: 'empty-env-no-derivation', scriptRoot: 'C:\\tools\\launcher', distroEnv: '', repoEnv: '' },
].map((c) => ({ ...c, defaultDistro: D_DISTRO, defaultRepoPath: D_REPO }));

export const HINT_CASES = [
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
export const FILE_CASES = [
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

export function probe(): Promise<Probe> {
  probePromise ??= (async () => {
    const dir = await makeTempDir('ai-sm-lcfg-');
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

export async function location(index: number): Promise<LocationCase> {
  const all = (await probe()).location;
  assert.equal(all.length, LOCATION_INPUTS.length, 'probe returned the wrong number of location cases');
  const c = all[index]!;
  // ConvertTo-Json turns a $null input into JSON null; '' survives as ''.
  assert.equal(c.input ?? null, LOCATION_INPUTS[index], `location case ${index} is not the input we sent`);
  return c;
}

export async function fileCase(name: string): Promise<FileCase> {
  const c = (await probe()).file.find((f) => f.name === name);
  assert.ok(c, `probe returned no file case '${name}'`);
  return c;
}

export async function resolved(name: string): Promise<ResolveCase> {
  const c = (await probe()).resolve.find((r) => r.name === name);
  assert.ok(c, `probe returned no resolve case '${name}'`);
  return c;
}
