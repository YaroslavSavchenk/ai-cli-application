/**
 * Launch-dialog argv vocabulary and composition — DOM-free, xterm-free, so
 * plain `node:test` can import it (same pattern as `modelFromArgs` /
 * `permFromArgs` in `./util.ts`). `launch.ts` renders these; nothing here
 * touches the document.
 */
import type { PermissionMode } from '../../../shared/protocol.ts';

/** Handoff model list — the dialog launches `claude` (server spawns argv, never shell). */
export const MODELS = ['opus', 'sonnet', 'haiku', 'fable'] as const;

export type Perm = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';
export type Resume = 'fresh' | 'continue';

export const PERMS: { mode: Perm; desc: string; danger: boolean }[] = [
  { mode: 'default', desc: 'ask before every tool call', danger: false },
  { mode: 'acceptEdits', desc: 'auto-approve file edits', danger: false },
  { mode: 'plan', desc: 'read-only planning mode', danger: false },
  { mode: 'bypassPermissions', desc: 'never ask · dangerous', danger: true },
];

export const CHIPS: { label: string; model: string; perm: Perm; resume: Resume; danger: boolean }[] = [
  { label: 'deep work · opus · acceptEdits · continue', model: 'opus', perm: 'acceptEdits', resume: 'continue', danger: false },
  { label: 'quick fix · sonnet · default', model: 'sonnet', perm: 'default', resume: 'fresh', danger: false },
  { label: 'yolo · opus · bypass', model: 'opus', perm: 'bypassPermissions', resume: 'fresh', danger: true },
];

/** One spawn spec — what the server will exec (argv array, never a shell string). */
export interface SpawnSpec {
  command: string;
  args: string[];
}

/**
 * THE claude argv composer — single source of truth. The command preview
 * and the POST /api/sessions body both read from here; if they could
 * diverge, the preview would be a lie.
 */
export function composeArgs(model: string, perm: Perm, resume: Resume): string[] {
  const args = ['--model', model];
  if (perm !== 'default') args.push('--permission-mode', perm);
  if (resume === 'continue') args.push('--continue');
  return args;
}

/**
 * Custom-mode line → spawn spec: plain whitespace split by design — no
 * quoting, no escaping, no shell parsing (the backend spawns argv
 * directly; the field hint documents this). First token is the command,
 * the rest are args. Empty/blank input → null (nothing to spawn).
 */
export function parseCustomCommand(line: string): SpawnSpec | null {
  const parts = line.trim().split(/\s+/).filter((p) => p !== '');
  const command = parts[0];
  if (command === undefined) return null;
  return { command, args: parts.slice(1) };
}

/**
 * The preview's command line for a spawn spec (`$ cmd args…`) — shared by
 * both dialog modes so the preview always renders the exact spawn.
 */
export function previewLine(spec: SpawnSpec): string {
  return ['$', spec.command, ...spec.args].join(' ');
}

/** Project defaultMode → dialog permission: `skip-permissions` maps to bypass; otherwise no override. */
export function permFromDefaultMode(mode: PermissionMode | undefined): Perm | null {
  return mode === 'skip-permissions' ? 'bypassPermissions' : null;
}
