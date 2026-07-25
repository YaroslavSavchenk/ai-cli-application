/**
 * Launch-dialog argv vocabulary and composition — DOM-free, xterm-free, so
 * plain `node:test` can import it (same pattern as `modelFromArgs` /
 * `permFromArgs` in `./util.ts`). `launch.ts` renders these; nothing here
 * touches the document.
 *
 * This file is also the single source of the PLAIN-LANGUAGE copy for the
 * permission/resume vocabulary (PROJECT-SCOPE "No commands, flags, or code in
 * the UI", 2026-07-25). Two layers, deliberately separate:
 *   - VALUES (`Perm`, `Resume`, `composeArgs`) are the CLI contract and never
 *     change: `claude --permission-mode acceptEdits --continue` is still
 *     exactly what gets spawned.
 *   - LABELS (`PERMS.title/desc`, `PERM_SHORT`, `launchSummary`) are what the
 *     user reads. Changing a label must never change an emitted arg.
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

/**
 * The permission cards (launch dialog + settings panel): `mode` is the CLI
 * value that reaches argv, `title`/`desc` are the plain-language copy the user
 * reads. The dangerous mode's description keeps its red treatment selected or
 * not — the warning never disappears.
 */
export const PERMS: { mode: Perm; title: string; desc: string; danger: boolean }[] = [
  { mode: 'default', title: 'Always ask', desc: 'before tools that need approval', danger: false },
  {
    mode: 'acceptEdits',
    title: 'Auto-approve edits',
    desc: 'file changes go through without asking',
    danger: false,
  },
  { mode: 'plan', title: 'Read-only planning', desc: 'looks and plans, changes nothing', danger: false },
  { mode: 'bypassPermissions', title: 'Never ask', desc: 'no prompts at all · dangerous', danger: true },
];

/**
 * Short forms for the NARROW chips — the pane-header permission tag
 * (`permFromArgs` in ./util.ts) and the per-pane status bar's `mode` item.
 * Total over the vocabulary so the map can't drift from `Perm`; `default`
 * never actually reaches a tag (the default mode shows no tag at all — see
 * `permFromArgs`), it is here so the set stays complete and type-checked.
 */
export const PERM_SHORT: Record<Perm, string> = {
  default: 'always ask',
  acceptEdits: 'auto edits',
  plan: 'read-only',
  bypassPermissions: 'no prompts',
};

/** Danger modes, derived from PERMS so `danger` has exactly one source. */
const DANGER_PERMS: ReadonlySet<Perm> = new Set(PERMS.filter((p) => p.danger).map((p) => p.mode));

export const CHIPS: { label: string; model: string; perm: Perm; resume: Resume; danger: boolean }[] = [
  { label: 'deep work · opus · auto edits · continue', model: 'opus', perm: 'acceptEdits', resume: 'continue', danger: false },
  { label: 'quick fix · sonnet · always ask', model: 'sonnet', perm: 'default', resume: 'fresh', danger: false },
  { label: 'yolo · opus · no prompts', model: 'opus', perm: 'bypassPermissions', resume: 'fresh', danger: true },
];

/** Resume select copy (values stay `fresh` / `continue`; `continue` emits `--continue`). */
export const RESUME_OPTIONS: { value: Resume; label: string }[] = [
  { value: 'fresh', label: 'Start fresh' },
  { value: 'continue', label: 'Continue last conversation' },
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
 * The preview's command line for a spawn spec (`$ cmd args…`) — used by the
 * dialog's CUSTOM mode only, where the field's content IS a command (the one
 * construction-exempt spot in the plain-language rule). Preset modes render
 * `launchSummary()` instead.
 */
export function previewLine(spec: SpawnSpec): string {
  return ['$', spec.command, ...spec.args].join(' ');
}

// ---------------------------------------------------------------------------
// Readable launch summary (replaces the argv command preview in preset modes)
// ---------------------------------------------------------------------------

/** What the preset modes launch — a product name, not the command string. */
export const AGENT_LABEL = 'Claude Code';

/** What each permission mode DOES, as a sentence clause (summary line 2). */
const PERM_CLAUSES: Record<Perm, string> = {
  default: 'asks before tools that need approval',
  acceptEdits: 'auto-approves file edits',
  plan: 'read-only planning, changes nothing',
  bypassPermissions: 'never asks · dangerous',
};

/** What each resume choice DOES, as a sentence clause (summary line 2). */
const RESUME_CLAUSES: Record<Resume, string> = {
  fresh: 'starts a fresh conversation',
  continue: 'continues your last conversation',
};

/**
 * The `--model` value in an emitted argv (composeArgs always writes one). The
 * app's empty-value glyph when there is none, so the head never claims a model
 * that is not in the launch.
 */
function modelOfArgs(args: string[]): string {
  const i = args.indexOf('--model');
  const v = args[i + 1];
  return i !== -1 && typeof v === 'string' && v !== '' ? v : '—';
}

/** The permission mode in an emitted argv — absent means the CLI's default mode. */
function permOfArgs(args: string[]): Perm {
  const i = args.indexOf('--permission-mode');
  const v = i !== -1 ? args[i + 1] : undefined;
  return isPerm(v) ? v : 'default';
}

/** The resume choice in an emitted argv: composeArgs writes `--continue` for one value only. */
function resumeOfArgs(args: string[]): Resume {
  return args.includes('--continue') ? 'continue' : 'fresh';
}

/** The three plain-language lines of the launch summary. */
export interface LaunchSummary {
  /** Line 1: agent · model. */
  head: string;
  /** Line 2, first clause: what the permission mode does. */
  mode: string;
  /** Line 2, first clause is a bypass form → render it red. */
  danger: boolean;
  /** Line 2, second clause: what the resume choice does. */
  resume: string;
  /** Line 3: the real absolute project path (paths are sanctioned here). */
  folder: string;
}

/**
 * The readable replacement for the argv preview (PROJECT-SCOPE, 2026-07-25):
 * agent · model / what the mode does · what resume does / target folder.
 *
 * It takes the EMITTED ARGV — `currentSpawn().args`, the very array that goes
 * into the POST body — and derives every clause from it, exactly as the old
 * `previewLine(spawn)` rendered that same array. So the summary is a FUNCTION OF
 * what will run, not a second reading of the controls: an arg added to
 * `composeArgs` can never leave the summary describing the previous launch. It
 * just says it in words instead of flags.
 */
export function launchSummary(args: string[], folder: string): LaunchSummary {
  const perm = permOfArgs(args);
  return {
    head: `${AGENT_LABEL} · ${modelOfArgs(args)}`,
    mode: PERM_CLAUSES[perm],
    danger: DANGER_PERMS.has(perm),
    resume: RESUME_CLAUSES[resumeOfArgs(args)],
    folder: `folder: ${folder}`,
  };
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
