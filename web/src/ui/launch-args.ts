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
 *
 * 2026-09-10 (Nocturne A4): the dialog took the v3 layout — card grids for the
 * tool, the shell and the permission mode, a `Start from` select in place of
 * the continue checkbox. The card tables below are DISPLAY over the same
 * values; `composeSpawn` and every argv it emits are unchanged.
 */
import type { ClaudePermissionMode, PermissionMode } from '../../../shared/protocol.ts';

/** What the known agent is CALLED in the UI — a product name, not a command. */
export const AGENT_LABEL = 'Claude Code';

/** Handoff model list — the dialog launches `claude` (server spawns argv, never shell). */
export const MODELS = ['opus', 'sonnet', 'haiku', 'fable'] as const;

/** The dialog's permission vocabulary IS the shared contract type (all four CLI modes). */
export type Perm = ClaudePermissionMode;

/**
 * The permission cards, in grid order: `mode` is the CLI value that reaches
 * argv, `danger` decides the red treatment (which the card keeps selected or
 * not — the warning never disappears). The user-visible words come from
 * `PERM_SHORT`; there is no second label table anymore.
 */
export const PERMS: { mode: Perm; danger: boolean }[] = [
  { mode: 'default', danger: false },
  { mode: 'acceptEdits', danger: false },
  { mode: 'plan', danger: false },
  { mode: 'bypassPermissions', danger: true },
];

/**
 * The ONE label table for permission modes: the launch dialog's permission
 * cards, its info popover AND the pane status bar's Mode value (`permFromArgs`
 * in ./util.ts). Total over the vocabulary so the map can't drift from `Perm`.
 * `default` renders no pane Mode at all (see `permFromArgs`), but it IS a card
 * in the dialog.
 *
 * Sentence case since Nocturne A4 (2026-09-10), the v3 handoff's own words —
 * the pane status bar follows because it reads this same table.
 */
export const PERM_SHORT: Record<Perm, string> = {
  default: 'Always ask',
  acceptEdits: 'Auto edits',
  plan: 'Read only',
  bypassPermissions: 'No prompts',
};

/**
 * What each permission mode DOES, one short plain line per mode — the ONE
 * sanctioned piece of explanatory copy in the launch dialog (user decision
 * 2026-09-10, Nocturne A4), shown only when the user asks for it through the
 * info button beside the Permissions label. Never a flag, never a CLI value.
 */
export const PERM_HELP: Record<Perm, string> = {
  default: 'Asks before every edit or command.',
  acceptEdits: 'Edits files without asking. Still asks before commands.',
  plan: 'Reads and plans. Changes nothing.',
  bypassPermissions: 'Does everything without asking. Use with care.',
};

/**
 * Claude Code's own effort levels (`claude --help`, 2.1.263: low, medium,
 * high, xhigh, max) plus the app-only sentinel `default`, which emits NOTHING
 * — picking it leaves the CLI on whatever it does by itself, which is not the
 * same as naming a level.
 */
export const EFFORTS = ['default', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

/**
 * What the Model and Effort selects SHOW (Nocturne A4: capitalised, as in the
 * v3 handoff). Display only — the option VALUE stays the MODELS / EFFORTS id,
 * which is what reaches argv, so a label change can never change a spawn.
 */
export const MODEL_LABEL: Record<(typeof MODELS)[number], string> = {
  opus: 'Opus',
  sonnet: 'Sonnet',
  haiku: 'Haiku',
  fable: 'Fable',
};

/**
 * A model id as the UI says it anywhere a session is named (the pane status
 * bar, the sessions drawer, the history rows): a known id reads as its
 * `MODEL_LABEL`, the same word the dialog showed; anything else (a custom
 * command's own `--model` value) is echoed verbatim — never relabelled.
 */
export function modelLabel(id: string): string {
  return isModelId(id) ? MODEL_LABEL[id] : id;
}

export const EFFORT_LABEL: Record<Effort, string> = {
  default: 'Default',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
};

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
  { id: 'wsl', label: 'Bash', command: '/bin/bash', args: ['-l'] },
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

// ---------------------------------------------------------------------------
// The dialog's card grids (Nocturne A4, 2026-09-10)
// ---------------------------------------------------------------------------
//
// DISPLAY tables over the vocabularies above. A card either maps to exactly
// one existing value (a kind, a shell) or to `null` — an INERT card: shown,
// never selectable, spawning nothing. The inert ones are the v3 handoff's
// other tools and shells, which get their command builders in part B5; until
// then no flag, command or key for them exists anywhere in this app.

/** The hint every inert card carries instead of its sub-line. Plain words. */
export const NOT_YET = 'Not available yet';

export interface ToolCard {
  readonly id: string;
  readonly label: string;
  /** Vendor or kind, one plain word or two. */
  readonly sub: string;
  /** The two-glyph tile, decoration only (aria-hidden in the DOM). */
  readonly mark: string;
  /** The kind this card launches; null = inert until B5. */
  readonly kind: LaunchKind | null;
}

/**
 * The Tool grid, two per row, three rows: the known agent, the three tools
 * part B5 will wire, the plain terminal, and the custom-command escape hatch
 * (which used to be the `Other` segment of the kind switch).
 */
export const TOOL_CARDS = [
  { id: 'claude', label: AGENT_LABEL, sub: 'Anthropic', mark: 'CC', kind: 'claude' },
  { id: 'codex', label: 'Codex', sub: 'OpenAI', mark: 'CX', kind: null },
  { id: 'gemini', label: 'Gemini CLI', sub: 'Google', mark: 'GM', kind: null },
  { id: 'grok', label: 'Grok', sub: 'xAI', mark: 'GK', kind: null },
  { id: 'terminal', label: 'Terminal', sub: 'Plain shell', mark: '>_', kind: 'terminal' },
  { id: 'other', label: 'Other', sub: 'Any command', mark: '…', kind: 'other' },
] as const satisfies readonly ToolCard[];

export interface ShellCard {
  readonly id: string;
  readonly label: string;
  /** Where the shell lives: `WSL` or `Windows`. */
  readonly sub: string;
  /** The SHELLS entry this card spawns; null = inert until B5. */
  readonly shell: ShellId | null;
}

/**
 * The Shell cards, one row of four. `Bash` IS today's WSL login shell and
 * `PowerShell` today's interop PowerShell — the SHELLS argv, byte for byte
 * (the v3 handoff's `pwsh.exe` is not adopted). Their labels ARE the SHELLS
 * labels, so the card, the no-project tab title, the drawer and the history
 * rows all say the same name. Zsh and Command Prompt are inert until B5.
 */
export const SHELL_CARDS = [
  { id: 'bash', label: SHELLS[0].label, sub: 'WSL', shell: 'wsl' },
  { id: 'zsh', label: 'Zsh', sub: 'WSL', shell: null },
  { id: 'powershell', label: SHELLS[1].label, sub: 'Windows', shell: 'powershell' },
  { id: 'cmd', label: 'Command Prompt', sub: 'Windows', shell: null },
] as const satisfies readonly ShellCard[];

/**
 * The `Start from` select. `continue` is exactly the former "Continue last
 * conversation" checkbox (`--continue`); resuming ONE earlier conversation by
 * id stays in the sessions drawer's HISTORY until part B5.
 */
export const START_FROM = [
  { value: 'fresh', label: 'A fresh conversation' },
  { value: 'continue', label: 'The last conversation in this project' },
] as const;
export type StartFrom = (typeof START_FROM)[number]['value'];

/** True when `v` is one of the Start from values. */
export function isStartFrom(v: unknown): v is StartFrom {
  return typeof v === 'string' && START_FROM.some((s) => s.value === v);
}

/** Start from -> the `continueLast` bit `composeSpawn` reads. Unknown = fresh. */
export function continueFromStart(v: string): boolean {
  return v === 'continue';
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
 * Was this session launched to continue the last conversation (the New session
 * dialog's Start from "The last conversation in this project")? Reads the argv
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

/**
 * A session's command as the UI says it: the ONE known agent reads as its
 * product name, a shell the launch dialog can compose reads as that shell's
 * name (2026-09-08), and anything else is echoed exactly as the user typed it
 * in the custom-command field. Inventing a display name for an arbitrary
 * command would be a lie about what is running.
 *
 * Lives here — with `AGENT_LABEL` and `shellLabel`, the two tables it reads —
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
