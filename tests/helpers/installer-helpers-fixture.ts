/**
 * The Windows Setup's helper scripts as text, shared by
 * `tests/release/installer-helpers.test.ts` (the constant shell scripts under
 * a real `sh`) and `installer-helpers-powershell.test.ts` (the PowerShell side
 * over interop): the helpers folder, one helper's source, and the five
 * constant `@'...'@` scripts a helper hands to `sh -c` / `bash -lc` — plus
 * `runSh`, which runs such a script under a real `sh` the way `wsl.exe --exec
 * sh -c <script> sh <args…>` does (also used by
 * `tests/release/ptyhost-windows-scripts.test.ts` for launch.ps1's scripts),
 * and `launchStateScript`, which builds launch.ps1's -Stop scripts (stale
 * runtime.json, pty-host stop) from their shared preamble the way launch.ps1
 * does (used by `tests/release/launcher-stop.test.ts` and
 * `ptyhost-windows-scripts.test.ts`).
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectRoot } from './helpers.ts';

export const helpersDir = join(projectRoot, 'installer', 'helpers');
export const readHelper = (name: string) => readFileSync(join(helpersDir, name), 'utf8');

// --- extracting the constant scripts ----------------------------------------

/** The `@'...'@` here-string a helper sends to `sh -c` / `bash -lc`. */
export function constScript(fileText: string, varName: string): string {
  const m = new RegExp(`\\$${varName} = @'\\n([\\s\\S]*?)\\n'@`).exec(fileText);
  assert.ok(m, `no here-string named $${varName}`);
  return m[1]!;
}

/**
 * One of launch.ps1's -Stop state-file scripts as `Join-AiSmStateFileScript`
 * builds it (D9 P5): the shared `$AiSmStateFilePreamble` for `<data dir>/<file>`,
 * a newline, then the `$<name>Body` here-string. Asserts launch.ps1 composes
 * `$<name>Script` from exactly that file and body, and that
 * `Join-AiSmStateFileScript` still joins them exactly this way.
 */
export function launchStateScript(launchText: string, name: string, file: string): string {
  const composed = `$${name}Script = Join-AiSmStateFileScript -File '${file}' -Body $${name}Body`;
  assert.ok(launchText.includes(`\n${composed}\n`), `launch.ps1 does not compose: ${composed}`);
  // The composition below mirrors Join-AiSmStateFileScript, so its one line
  // is pinned too: a join that named another file or dropped the newline
  // would ship a script these tests never ran.
  const join = "\n    return $AiSmStateFilePreamble.Replace('STATEFILE', $File) + \"`n\" + $Body\n}\n";
  assert.ok(launchText.includes(join), `Join-AiSmStateFileScript no longer reads:${join}`);
  const preamble = constScript(launchText, 'AiSmStateFilePreamble');
  assert.equal(preamble.split('STATEFILE').length, 2, 'the preamble names STATEFILE exactly once');
  return `${preamble.replace('STATEFILE', file)}\n${constScript(launchText, `${name}Body`)}`;
}

export const unpackScript = constScript(readHelper('install-bundle.ps1'), 'AiSmUnpackScript');
/** install-bundle.ps1's in-distro read of a live pty-host's version dir (D9 P5). */
export const ptyHostDirScript = constScript(readHelper('install-bundle.ps1'), 'AiSmPtyHostDirScript');
export const removeScript = constScript(readHelper('uninstall-wsl.ps1'), 'AiSmRemoveScript');
export const probeScript = constScript(readHelper('wsl-probe.ps1'), 'AiSmDistroProbeScript');
export const claudeCheckScript = constScript(readHelper('install-thirdparty.ps1'), 'AiSmClaudeCheckScript');

// --- running one under a real sh ---------------------------------------------

export interface ShResult {
  code: number | null;
  /** stdout and stderr, interleaved as they arrived. */
  out: string;
}

/**
 * `sh -c <script> sh <args…>`. `stdin`: what the script reads (the unpack
 * script's tarball); always closed, so a script that does not read it still
 * sees EOF. `env`: the whole environment (default: this process's) — the
 * pty-host scripts run with a bare one, as `wsl.exe --exec` gives them.
 */
export function runSh(
  script: string,
  args: string[],
  opts: { stdin?: Buffer; env?: NodeJS.ProcessEnv } = {},
): Promise<ShResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', ['-c', script, 'sh', ...args], { stdio: ['pipe', 'pipe', 'pipe'], env: opts.env });
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
    // that exit and loses (EPIPE) — measured at ~1 run in 10 of
    // installer-helpers.test.ts before the handler below existed, which made
    // the suite flaky rather than wrong. The pipe closing early is the script
    // working; the exit code and the output stay the verdict.
    child.stdin.on('error', () => {});
    child.stdin.end(opts.stdin ?? '');
  });
}
