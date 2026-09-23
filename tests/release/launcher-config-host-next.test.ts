/**
 * `Move-AiSmHostNext` in `launcher/config-common.ps1` — promoting an updated
 * native host at the next start.
 *
 * The Windows Setup installs the host into `{app}\host\next` because an
 * in-app update runs it while the old host window is still open and holding
 * its files; `launch.ps1` promotes `next\` at the next start. The real
 * function runs through `powershell.exe` interop on a real Windows filesystem
 * (a %TEMP% tree, not the WSL share: only NTFS enforces the sharing violation
 * this has to survive), with a real second process holding a real lock.
 *
 * Split out of `launcher-config.test.ts` (restructure O6); the spawn helpers
 * are `tests/helpers/launcher-config-fixture.ts`. Skipped cleanly wherever
 * `powershell.exe` / `wslpath` are absent (CI's ubuntu runner).
 *
 * NOT claimed: the in-app update that stages `next\`, or the host window
 * itself.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { projectRoot, makeTempDir } from '../helpers/helpers.ts';
import { powershell, run, skip, toWindowsPath } from '../helpers/launcher-config-fixture.ts';

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
    const dir = await makeTempDir('ai-sm-hostnext-');
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
