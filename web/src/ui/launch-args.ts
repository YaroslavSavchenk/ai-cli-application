/**
 * Launch-dialog argv vocabulary and composition — DOM-free, xterm-free, so
 * plain `node:test` can import it (same pattern as `modelFromArgs` /
 * `permFromArgs` in `./util.ts`). `launch.ts` renders these; nothing here
 * touches the document.
 *
 * This file is also the single source of the PLAIN-LANGUAGE copy for the
 * permission vocabulary (PROJECT-SCOPE "No commands, flags, or code in the
 * UI", 2026-07-25). Two layers, deliberately separate:
 *   - VALUES (`Perm`, `Effort`, `composeArgs`) are the CLI contract and never
 *     change: `claude --permission-mode acceptEdits --effort high --continue`
 *     is still exactly what gets spawned.
 *   - LABELS (`PERM_SHORT`) are what the user reads. Changing a label must
 *     never change an emitted arg.
 *
 * 2026-09-06 (user's call): the dialog was cut back to short plain words —
 * preset chips, the readable launch summary and every explanatory clause are
 * gone, and an effort level joined the form. What survived is exactly what a
 * control needs to render or emit.
 */
import type { ClaudePermissionMode, PermissionMode } from '../../../shared/protocol.ts';

/** Handoff model list — the dialog launches `claude` (server spawns argv, never shell). */
export const MODELS = ['opus', 'sonnet', 'haiku', 'fable'] as const;

/** The dialog's permission vocabulary IS the shared contract type (all four CLI modes). */
export type Perm = ClaudePermissionMode;

/**
 * The mode segments, in row order: `mode` is the CLI value that reaches argv,
 * `danger` decides the red treatment (which the segment keeps selected or not
 * — the warning never disappears). The user-visible words come from
 * `PERM_SHORT`; there is no second label table anymore.
 */
export const PERMS: { mode: Perm; danger: boolean }[] = [
  { mode: 'default', danger: false },
  { mode: 'acceptEdits', danger: false },
  { mode: 'plan', danger: false },
  { mode: 'bypassPermissions', danger: true },
];

/**
 * The ONE label table for permission modes: the launch dialog's mode segments
 * AND the pane-header permission tag (`permFromArgs` in ./util.ts). Total over
 * the vocabulary so the map can't drift from `Perm`. `default` renders no pane
 * tag at all (see `permFromArgs`), but it IS a segment in the dialog.
 */
export const PERM_SHORT: Record<Perm, string> = {
  default: 'always ask',
  acceptEdits: 'auto edits',
  plan: 'read-only',
  bypassPermissions: 'no prompts',
};

/**
 * Claude Code's own effort levels (`claude --help`, 2.1.263: low, medium,
 * high, xhigh, max) plus the app-only sentinel `default`, which emits NOTHING
 * — picking it leaves the CLI on whatever it does by itself, which is not the
 * same as naming a level.
 */
export const EFFORTS = ['default', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

/** One spawn spec — what the server will exec (argv array, never a shell string). */
export interface SpawnSpec {
  command: string;
  args: string[];
}

/**
 * THE claude argv composer — single source of truth. `currentSpawn()` in
 * launch.ts is the only caller, and its output IS the POST /api/sessions body.
 *
 * Order is fixed: model, then permission mode (omitted when `default`), then
 * effort (omitted when `default` — the sentinel names no level), then
 * `--continue` last.
 */
export function composeArgs(
  model: string,
  perm: Perm,
  continueLast: boolean,
  effort: Effort,
): string[] {
  const args = ['--model', model];
  if (perm !== 'default') args.push('--permission-mode', perm);
  if (effort !== 'default') args.push('--effort', effort);
  if (continueLast) args.push('--continue');
  return args;
}

/**
 * Custom-mode line → spawn spec: plain whitespace split by design — no
 * quoting, no escaping, no shell parsing (the backend spawns argv directly).
 * First token is the command, the rest are args. Empty/blank input → null
 * (nothing to spawn).
 */
export function parseCustomCommand(line: string): SpawnSpec | null {
  const parts = line.trim().split(/\s+/).filter((p) => p !== '');
  const command = parts[0];
  if (command === undefined) return null;
  return { command, args: parts.slice(1) };
}

/** What the known agent is CALLED in the UI — a product name, not a command. */
export const AGENT_LABEL = 'Claude Code';

/** Project defaultMode → dialog permission: `skip-permissions` maps to bypass; otherwise no override. */
export function permFromDefaultMode(mode: PermissionMode | undefined): Perm | null {
  return mode === 'skip-permissions' ? 'bypassPermissions' : null;
}

// ---------------------------------------------------------------------------
// Launch-dialog pre-selection + precedence
// ---------------------------------------------------------------------------

const PERM_SET: ReadonlySet<string> = new Set(PERMS.map((p) => p.mode));

/** True when `v` is one of the four CLI permission modes. */
export function isPerm(v: unknown): v is Perm {
  return typeof v === 'string' && PERM_SET.has(v);
}

/** True when `v` is one of the four dialog model ids. */
export function isModelId(v: unknown): v is (typeof MODELS)[number] {
  return typeof v === 'string' && (MODELS as readonly string[]).includes(v);
}

/** True when `v` is one of the effort levels (incl. the `default` sentinel). */
export function isEffort(v: unknown): v is Effort {
  return typeof v === 'string' && (EFFORTS as readonly string[]).includes(v);
}

/**
 * Precedence chain for the launch dialog's pre-selected model:
 *   explicit project defaultModel  >  hardcoded MODELS[0].
 * Only models in MODELS win; anything else falls through to the fallback. The
 * per-launch choice always beats both — the dialog stays editable after this
 * resolves (it runs once per open).
 *
 * The middle tier used to be an app-wide default in the settings panel; it was
 * removed 2026-07-26 with the rest of the retired settings, so a project's own
 * default is now the only stored preference.
 */
export function resolveModel(projectModel: string | undefined): (typeof MODELS)[number] {
  return isModelId(projectModel) ? projectModel : MODELS[0];
}

/**
 * Precedence chain for the launch dialog's pre-selected permission mode:
 *   explicit project defaultMode (skip-permissions → bypass)  >  hardcoded
 *   'default'. The project's legacy 2-value mode only asserts a preference when
 *   it is `skip-permissions`; `standard`/absent assert nothing and land on the
 *   ask-first fallback.
 */
export function resolvePerm(projectMode: PermissionMode | undefined): Perm {
  return permFromDefaultMode(projectMode) ?? 'default';
}
