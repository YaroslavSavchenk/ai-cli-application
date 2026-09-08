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

// ---------------------------------------------------------------------------
// Session kind (2026-09-08, user's request: "alles moet mogelijk")
// ---------------------------------------------------------------------------

/**
 * What the launch dialog is launching. Three kinds, one composition path:
 *   - `claude`   the known agent, composed by `composeArgs` (unchanged);
 *   - `terminal` a plain shell in the project folder — the app stops being
 *                claude-only without becoming a command prompt;
 *   - `other`    the 2026-07-20 escape hatch: whatever the user types.
 */
export const KINDS = ['claude', 'terminal', 'other'] as const;
export type LaunchKind = (typeof KINDS)[number];

/** The kind switch's words — plain, short, and never a command name. */
export const KIND_LABEL: Record<LaunchKind, string> = {
  claude: 'Claude',
  terminal: 'Terminal',
  other: 'Other',
};

/** True when `v` is one of the three kinds. */
export function isKind(v: unknown): v is LaunchKind {
  return typeof v === 'string' && (KINDS as readonly string[]).includes(v);
}

/**
 * The shells a Terminal session can be. Two, deliberately: the Linux shell the
 * backend already lives in, and the Windows one it can reach through WSL
 * interop (it runs inside the SAME PTY — a Windows console program on a Linux
 * pty; see the report/verify notes for what it does and does not do there).
 *
 * `command`/`args` are the CLI contract (they reach argv verbatim); `label` is
 * what the user reads. Same two-layer rule as the permission vocabulary above:
 * changing a label must never change a spawn.
 */
export interface ShellDef {
  readonly id: string;
  readonly label: string;
  readonly command: string;
  readonly args: readonly string[];
}

export const SHELLS = [
  { id: 'wsl', label: 'WSL shell', command: '/bin/bash', args: ['-l'] },
  { id: 'powershell', label: 'PowerShell', command: 'powershell.exe', args: ['-NoLogo'] },
] as const satisfies readonly ShellDef[];

export type ShellId = (typeof SHELLS)[number]['id'];

/** True when `v` names one of the shells. */
export function isShellId(v: unknown): v is ShellId {
  return typeof v === 'string' && SHELLS.some((s) => s.id === v);
}

/** One shell -> its spawn spec. An unknown id falls back to the first shell. */
export function shellSpawn(id: ShellId): SpawnSpec {
  const def = SHELLS.find((s) => s.id === id) ?? SHELLS[0];
  return { command: def.command, args: [...def.args] };
}

/**
 * A spawned command -> the shell's product name, or null when it is not one of
 * ours. Exact-match on the command the app itself composes: a user-typed custom
 * command is echoed verbatim (the one display exemption) and must never be
 * relabelled by guesswork.
 */
export function shellLabel(command: string): string | null {
  return SHELLS.find((s) => s.command === command)?.label ?? null;
}

/** Everything the dialog's controls hold, in one bag — the input to `composeSpawn`. */
export interface LaunchForm {
  kind: LaunchKind;
  /** claude only */
  model: string;
  perm: Perm;
  continueLast: boolean;
  effort: Effort;
  /** terminal only */
  shell: ShellId;
  /** other only — the raw line the user typed */
  customLine: string;
}

/**
 * THE composition path for every kind — `currentSpawn()` in launch.ts reads
 * only this, and its output IS the POST /api/sessions body. `composeArgs`
 * stays the claude argv composer underneath; the other two kinds add no second
 * vocabulary. null = nothing to spawn (a blank custom line).
 */
export function composeSpawn(f: LaunchForm): SpawnSpec | null {
  if (f.kind === 'terminal') return shellSpawn(f.shell);
  if (f.kind === 'other') return parseCustomCommand(f.customLine);
  return { command: 'claude', args: composeArgs(f.model, f.perm, f.continueLast, f.effort) };
}

/**
 * Was this session launched with "Continue last conversation"? Reads the argv
 * the server recorded (both spellings the CLI accepts). Used by the restart
 * confirmation, which owes the user a footnote for exactly these sessions:
 * they were never pinned to one conversation id, so resuming them lands on
 * whatever their project's latest conversation is by then.
 *
 * Lives HERE and not in the confirmation because this file is the one place
 * that is allowed to know argv spellings (see the copy rule above).
 */
export function hasContinueFlag(args: readonly string[]): boolean {
  return args.includes('--continue') || args.includes('-c');
}

/**
 * Is this the known agent? The SAME rule the server's history/resume path uses
 * (`basename(command) === 'claude'`, server/conversation.ts): a custom command
 * that merely happens to take a `-c` flag is not a Claude session and must not
 * be told anything about Claude conversations.
 *
 * Both separators are cut, because the command is whatever the user typed.
 */
export function isClaudeCommand(command: string): boolean {
  const parts = command.split(/[/\\]/);
  return (parts[parts.length - 1] ?? command) === 'claude';
}

/** What the known agent is CALLED in the UI — a product name, not a command. */
export const AGENT_LABEL = 'Claude Code';

/**
 * A session's command as the UI says it: the ONE known agent reads as its
 * product name, a shell the launch dialog can compose reads as that shell's
 * name (2026-09-08), and anything else is echoed exactly as the user typed it
 * in the custom-command field. Inventing a display name for an arbitrary
 * command would be a lie about what is running.
 *
 * Lives here — beside `AGENT_LABEL` and `shellLabel`, the two tables it reads —
 * so it is pure vocabulary with no DOM in its import graph (the sessions
 * drawer, the settings panel and the restart notice all name sessions, and a
 * second table would be a second place for the literal command name to leak
 * into UI chrome: PROJECT-SCOPE copy rule, 2026-07-25).
 */
export function commandLabel(command: string): string {
  if (command === 'claude') return AGENT_LABEL;
  return shellLabel(command) ?? command;
}

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
