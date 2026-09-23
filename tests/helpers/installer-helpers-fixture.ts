/**
 * The Windows Setup's helper scripts as text, shared by
 * `tests/release/installer-helpers.test.ts` (the constant shell scripts under
 * a real `sh`) and `installer-helpers-powershell.test.ts` (the PowerShell side
 * over interop): the helpers folder, one helper's source, and the four
 * constant `@'...'@` scripts a helper hands to `sh -c` / `bash -lc`.
 */
import assert from 'node:assert/strict';
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

export const unpackScript = constScript(readHelper('install-bundle.ps1'), 'AiSmUnpackScript');
export const removeScript = constScript(readHelper('uninstall-wsl.ps1'), 'AiSmRemoveScript');
export const probeScript = constScript(readHelper('wsl-probe.ps1'), 'AiSmDistroProbeScript');
export const claudeCheckScript = constScript(readHelper('install-thirdparty.ps1'), 'AiSmClaudeCheckScript');
