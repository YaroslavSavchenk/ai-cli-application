/**
 * Launch-dialog argv vocabulary and composition — DOM-free, xterm-free, so
 * plain `node:test` can import it (same pattern as `modelFromArgs` /
 * `permFromArgs` in `./util.ts`). `launch.ts` renders these; nothing here
 * touches the document.
 */
import type {
  ClaudePermissionMode,
  PermissionMode,
  UiLaunchDefaults,
} from '../../../shared/protocol.ts';

/** Handoff model list — the dialog launches `claude` (server spawns argv, never shell). */
export const MODELS = ['opus', 'sonnet', 'haiku', 'fable'] as const;

/** The dialog's permission vocabulary IS the shared contract type (all four CLI modes). */
export type Perm = ClaudePermissionMode;
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

// ---------------------------------------------------------------------------
// Global launch defaults (settings panel `UiLaunchDefaults`) + precedence
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

/**
 * Sanitize a persisted (server- or localStorage-sourced) launch-defaults bag
 * into a known-good shape — drops unknown models/modes, coerces a non-string
 * startup command away. Mirrors clampTheme's tolerance for a bag that crossed
 * a JSON boundary. Absent members stay absent (they mean "no global default").
 *
 * The startup command is additionally stripped of control characters
 * (`\x00-\x1f`, including `\r`/`\n`, and `\x7f`) and trimmed at this boundary:
 * the arming path feeds it to the PTY as `line + '\r'` (terminal.ts), so one
 * configured line must submit as exactly one line. A single-line UI <input>
 * already guarantees this; the persisted-bag path did not until here. A value
 * that strips to empty means "off" — the member is left absent.
 */
export function clampLaunchDefaults(raw: unknown): UiLaunchDefaults {
  const o = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: UiLaunchDefaults = {};
  if (isModelId(o.model)) out.model = o.model;
  if (isPerm(o.permissionMode)) out.permissionMode = o.permissionMode;
  if (typeof o.startupCommand === 'string') {
    const cleaned = o.startupCommand.replace(/[\x00-\x1f\x7f]/g, '').trim();
    if (cleaned !== '') out.startupCommand = cleaned;
  }
  return out;
}

/**
 * Precedence chain for the launch dialog's pre-selected model:
 *   explicit project defaultModel  >  global default  >  hardcoded MODELS[0].
 * Only models in MODELS win; anything else falls through to the next tier.
 */
export function resolveModel(
  global: UiLaunchDefaults | undefined,
  projectModel: string | undefined,
): (typeof MODELS)[number] {
  if (isModelId(projectModel)) return projectModel;
  if (isModelId(global?.model)) return global.model;
  return MODELS[0];
}

/**
 * Precedence chain for the launch dialog's pre-selected permission mode:
 *   explicit project defaultMode (skip-permissions → bypass)  >  global
 *   default  >  hardcoded 'default'. The project's legacy 2-value mode only
 *   asserts a preference when it is `skip-permissions`; `standard`/absent
 *   defer to the global default.
 */
export function resolvePerm(
  global: UiLaunchDefaults | undefined,
  projectMode: PermissionMode | undefined,
): Perm {
  const fromProject = permFromDefaultMode(projectMode);
  if (fromProject !== null) return fromProject;
  if (isPerm(global?.permissionMode)) return global.permissionMode;
  return 'default';
}
