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
 *
 * 2026-09-18 (Nocturne B5): three more agents (Codex, Gemini CLI, Grok) and two
 * more shells (Zsh, Command Prompt). THIS FILE IS THE ONLY PLACE THE PER-TOOL
 * CLI MAPPING MAY LIVE (`.claude/plans/nocturne/PLAN-B5.md`, "Verified CLI contracts"): every
 * flag, subcommand and CLI value each tool takes is written once, here, and the
 * UI above it only ever handles ids and labels. Each tool's argv order is FIXED
 * — model, permission, effort, then the start-from tail — and pinned byte-exact
 * by `tests/ui-launch-args.test.ts`.
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
 * bar, the sessions drawer, the history rows): a known id reads as the word
 * the dialog showed for it — Claude Code's own `MODEL_LABEL` and, since B5,
 * every other tool's model (`-m gpt-6-astra` reads `GPT-6 Astra`). Anything
 * else (a custom command's own `--model` value) is echoed verbatim — never
 * relabelled. The table is `MODEL_LABELS` below, built from `TOOLS`.
 */
export function modelLabel(id: string): string {
  return MODEL_LABELS.get(id) ?? id;
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
  resumeId?: string,
): string[] {
  const args = ['--model', model];
  if (perm !== 'default') args.push('--permission-mode', perm);
  if (effort !== 'default') args.push('--effort', effort);
  // ONE conversation named by id beats "whatever the folder's latest is": the
  // Start from select offers both, and a chosen entry is the more specific ask
  // (B5). Never both — `--resume <id>` already says which conversation.
  if (resumeId !== undefined && resumeId !== '') args.push('--resume', resumeId);
  else if (continueLast) args.push('--continue');
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
 * What the launch dialog is launching. Six kinds, one composition path:
 *   - `claude`   the known agent, composed by `composeArgs` (unchanged);
 *   - `codex`, `gemini`, `grok`  the other three agents (B5), each with its own
 *                vocabulary in `TOOLS` below and its own composer;
 *   - `terminal` a plain shell in the project folder — the app stops being
 *                claude-only without becoming a command prompt;
 *   - `other`    the 2026-07-20 escape hatch: whatever the user types.
 */
export const KINDS = ['claude', 'codex', 'gemini', 'grok', 'terminal', 'other'] as const;
export type LaunchKind = (typeof KINDS)[number];

/** True when `v` is one of the six kinds. */
export function isKind(v: unknown): v is LaunchKind {
  return typeof v === 'string' && (KINDS as readonly string[]).includes(v);
}

/**
 * The kinds that are an AGENT — the ones whose form is Model / Permissions /
 * Effort / Start from. `terminal` and `other` have none of that.
 */
export const AGENT_KINDS = ['claude', 'codex', 'gemini', 'grok'] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

/** True when `v` names one of the four agents. */
export function isAgentKind(v: unknown): v is AgentKind {
  return typeof v === 'string' && (AGENT_KINDS as readonly string[]).includes(v);
}

/**
 * The shells a Terminal session can be. Two Linux ones the backend already
 * lives beside, and two Windows ones it reaches through WSL interop (they run
 * inside the SAME PTY — a Windows console program on a Linux pty; see the
 * report/verify notes for what they do and do not do there).
 *
 * `command`/`args` are the CLI contract (they reach argv verbatim); `label` is
 * what the user reads. Same two-layer rule as the permission vocabulary above:
 * changing a label must never change a spawn.
 *
 * Command Prompt sends NO args on purpose (B5): `cmd.exe` refuses a UNC working
 * directory, so the SERVER appends the tail that walks it into the project
 * folder. The client never composes a Windows path.
 */
export interface ShellDef {
  readonly id: string;
  readonly label: string;
  readonly command: string;
  readonly args: readonly string[];
}

export const SHELLS = [
  { id: 'wsl', label: 'Bash', command: '/bin/bash', args: ['-l'] },
  { id: 'zsh', label: 'Zsh', command: 'zsh', args: ['-l'] },
  { id: 'powershell', label: 'PowerShell', command: 'powershell.exe', args: ['-NoLogo'] },
  { id: 'cmd', label: 'Command Prompt', command: 'cmd.exe', args: [] },
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
 * relabelled by guesswork — `/usr/bin/bash` is NOT this app's Bash card, and
 * saying so would be an invention about what is running.
 */
export function shellLabel(command: string): string | null {
  return SHELLS.find((s) => s.command === command)?.label ?? null;
}

// ---------------------------------------------------------------------------
// The dialog's card grids (Nocturne A4, 2026-09-10)
// ---------------------------------------------------------------------------
//
// DISPLAY tables over the vocabularies above. Since B5 every card maps to a
// real value — what a card cannot do is decided at RUNTIME by what the backend
// finds on its PATH (`GET /api/tools`), not by a hole in a table. An absent
// executable makes the card INERT: shown, never selectable, sub-line
// `NOT_INSTALLED`.

/** The hint an unavailable card carries instead of its sub-line. Plain words. */
export const NOT_INSTALLED = 'Not installed';

/**
 * The marks a tool can wear (part B12): the four agents' own logos, Phosphor's
 * terminal for a shell, and Phosphor's command key for anything else.
 * `ui/icons-tools.ts` holds one path per id.
 */
export type ToolIconId = 'claude' | 'codex' | 'gemini' | 'grok' | 'terminal' | 'command';

export interface ToolCard {
  readonly id: string;
  readonly label: string;
  /** Vendor or kind, one plain word or two. */
  readonly sub: string;
  /**
   * The tool's mark in its tile (part B12: the real logo, one style for all;
   * `ui/icons-tools.ts`), decoration only (aria-hidden in the DOM).
   */
  readonly icon: ToolIconId;
  /** The kind this card launches. */
  readonly kind: LaunchKind;
}

/**
 * The Tool grid, two per row, three rows: the four agents, the plain terminal,
 * and the custom-command escape hatch (which used to be the `Other` segment of
 * the kind switch).
 */
export const TOOL_CARDS = [
  { id: 'claude', label: AGENT_LABEL, sub: 'Anthropic', icon: 'claude', kind: 'claude' },
  { id: 'codex', label: 'Codex', sub: 'OpenAI', icon: 'codex', kind: 'codex' },
  { id: 'gemini', label: 'Gemini CLI', sub: 'Google', icon: 'gemini', kind: 'gemini' },
  { id: 'grok', label: 'Grok', sub: 'xAI', icon: 'grok', kind: 'grok' },
  { id: 'terminal', label: 'Terminal', sub: 'Plain shell', icon: 'terminal', kind: 'terminal' },
  { id: 'other', label: 'Other', sub: 'Any command', icon: 'command', kind: 'other' },
] as const satisfies readonly ToolCard[];

export interface ShellCard {
  readonly id: string;
  readonly label: string;
  /** Where the shell lives: `WSL` or `Windows`. */
  readonly sub: string;
  /** The SHELLS entry this card spawns. */
  readonly shell: ShellId;
}

/**
 * The Shell cards, one row of four — the SHELLS argv, byte for byte (the v3
 * handoff's `pwsh.exe` is not adopted). Their labels ARE the SHELLS labels, so
 * the card, the no-project tab title, the drawer and the history rows all say
 * the same name.
 */
export const SHELL_CARDS = [
  { id: 'bash', label: SHELLS[0].label, sub: 'WSL', shell: 'wsl' },
  { id: 'zsh', label: SHELLS[1].label, sub: 'WSL', shell: 'zsh' },
  { id: 'powershell', label: SHELLS[2].label, sub: 'Windows', shell: 'powershell' },
  { id: 'cmd', label: SHELLS[3].label, sub: 'Windows', shell: 'cmd' },
] as const satisfies readonly ShellCard[];

/**
 * Claude Code's fixed `Start from` options. `continue` is exactly the former
 * "Continue last conversation" checkbox (`--continue`); since B5 the select
 * also lists the project's own ended conversations AFTER these two, each
 * valued by its conversation id (`composeArgs`' `resumeId`).
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

// ---------------------------------------------------------------------------
// The other three agents (Nocturne B5, 2026-09-18)
// ---------------------------------------------------------------------------
//
// THE ONLY PLACE the per-tool CLI mapping lives. Everything above the dialog
// handles the ids and labels below; nothing else in `web/src` may spell a flag,
// a subcommand or a CLI value for these tools.
//
// Sources, all checked 2026-09-18 (`.claude/plans/nocturne/PLAN-B5.md`): `codex --help`
// (0.116.0 — the current 0.155 retired `untrusted`/`on-failure`, so only the
// two approval values valid in BOTH are used), `gemini --help` (0.60.0),
// docs.x.ai/build for Grok Build (NOT installed locally — its argv is from the
// docs and unverified on this machine).

/** One option of a per-tool select: the id that reaches argv, the word shown. */
export interface Choice {
  readonly id: string;
  readonly label: string;
}

/** One start-from option: the select's value, the words shown. */
export interface StartChoice {
  readonly value: string;
  readonly label: string;
}

/** Everything one agent's controls offer, and what it cannot be told from here. */
export interface ToolVocab {
  /** The executable the dialog spawns. */
  readonly command: string;
  readonly models: readonly Choice[];
  /** The model id that emits NOTHING (the CLI keeps its own default). */
  readonly modelNone: string;
  /** Empty = this tool has no effort levels and the control is hidden. */
  readonly efforts: readonly Choice[];
  /** The effort id that emits NOTHING. */
  readonly effortNone: string;
  /**
   * Permission modes this tool cannot be told from here: the card stays shown
   * and inert, with `hint` as its sub-line (the A4 inert-card idiom).
   */
  readonly inertPerms: readonly { readonly mode: Perm; readonly hint: string }[];
  readonly starts: readonly StartChoice[];
}

/** Codex model ids offered (OpenAI docs, 2026-09), newest first. */
const CODEX_MODELS: readonly Choice[] = [
  { id: 'default', label: 'Default' },
  { id: 'gpt-6-astra', label: 'GPT-6 Astra' },
  { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
  { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
  { id: 'gpt-5.5', label: 'GPT-5.5' },
  { id: 'gpt-5.4', label: 'GPT-5.4' },
  { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini' },
];

/** Codex reasoning levels. No `max`: the CLI has none. */
const CODEX_EFFORTS: readonly Choice[] = [
  { id: 'default', label: 'Default' },
  { id: 'minimal', label: 'Minimal' },
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'Extra high' },
];

const GEMINI_MODELS: readonly Choice[] = [
  { id: 'auto', label: 'Auto' },
  { id: 'pro', label: 'Pro' },
  { id: 'flash', label: 'Flash' },
  { id: 'flash-lite', label: 'Flash Lite' },
];

const GROK_MODELS: readonly Choice[] = [
  { id: 'default', label: 'Default' },
  { id: 'grok-4.6', label: 'Grok 4.6' },
];

const GROK_EFFORTS: readonly Choice[] = [
  { id: 'default', label: 'Default' },
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
];

/** What a Grok card that cannot be set from here says instead of a sub-line. */
export const GROK_PERM_HINT = 'Grok switches this inside the session';

/** The four agents' whole control vocabulary, in ONE table. */
export const TOOLS: Record<AgentKind, ToolVocab> = {
  claude: {
    command: 'claude',
    models: MODELS.map((m) => ({ id: m, label: MODEL_LABEL[m] })),
    modelNone: '',
    efforts: EFFORTS.map((e) => ({ id: e, label: EFFORT_LABEL[e] })),
    effortNone: 'default',
    inertPerms: [],
    starts: [...START_FROM],
  },
  codex: {
    command: 'codex',
    models: CODEX_MODELS,
    modelNone: 'default',
    efforts: CODEX_EFFORTS,
    effortNone: 'default',
    inertPerms: [],
    starts: [
      { value: 'fresh', label: 'A fresh session' },
      { value: 'last', label: 'The last session' },
      { value: 'pick', label: 'Pick an earlier session' },
    ],
  },
  gemini: {
    command: 'gemini',
    models: GEMINI_MODELS,
    modelNone: 'auto',
    efforts: [],
    effortNone: '',
    inertPerms: [],
    starts: [
      { value: 'fresh', label: 'A fresh session' },
      { value: 'last', label: 'The last session' },
    ],
  },
  grok: {
    command: 'grok',
    models: GROK_MODELS,
    modelNone: 'default',
    efforts: GROK_EFFORTS,
    effortNone: 'default',
    inertPerms: [
      { mode: 'acceptEdits', hint: GROK_PERM_HINT },
      { mode: 'plan', hint: GROK_PERM_HINT },
    ],
    starts: [
      { value: 'fresh', label: 'A fresh session' },
      { value: 'last', label: 'The last session' },
    ],
  },
};

/**
 * EVERY model id any tool offers -> the word the dialog showed for it, built
 * from `TOOLS` so a table edit cannot leave the pane status bar or the sessions
 * drawer reading a raw CLI id (`gpt-6-astra`, `pro`, `grok-4.6`). Read through
 * `modelLabel` only. An id two tables share (`default`) carries the same label
 * in both, and the sentinel ids never reach argv anyway — both pinned by
 * `tests/ui-launch-args.test.ts`.
 */
const MODEL_LABELS: ReadonlyMap<string, string> = new Map(
  Object.values(TOOLS).flatMap((v) => v.models.map((m): [string, string] => [m.id, m.label])),
);

/** True when `v` is one of the tool's model ids (the select's own vocabulary). */
export function isToolModel(kind: AgentKind, v: unknown): boolean {
  return typeof v === 'string' && TOOLS[kind].models.some((m) => m.id === v);
}

/** True when `v` is one of the tool's effort ids. */
export function isToolEffort(kind: AgentKind, v: unknown): boolean {
  return typeof v === 'string' && TOOLS[kind].efforts.some((e) => e.id === v);
}

/** True when `v` is one of the tool's fixed start-from values. */
export function isToolStart(kind: AgentKind, v: unknown): boolean {
  return typeof v === 'string' && TOOLS[kind].starts.some((s) => s.value === v);
}

/**
 * Codex's approval + sandbox pair per permission mode. Two arguments, always
 * together: `codex --help` treats approval policy and sandbox as one decision,
 * and a half-set pair is a different mode than the card promises.
 */
const CODEX_PERM_ARGS: Record<Perm, readonly string[]> = {
  default: ['-a', 'on-request', '-s', 'read-only'],
  acceptEdits: ['-a', 'on-request', '-s', 'workspace-write'],
  plan: ['-a', 'never', '-s', 'read-only'],
  bypassPermissions: ['--dangerously-bypass-approvals-and-sandbox'],
};

/** Gemini's approval mode. Always ask IS its default and emits nothing. */
const GEMINI_PERM_ARGS: Record<Perm, readonly string[]> = {
  default: [],
  acceptEdits: ['--approval-mode', 'auto_edit'],
  plan: ['--approval-mode', 'plan'],
  bypassPermissions: ['--approval-mode', 'yolo'],
};

/**
 * Grok takes one approval flag and nothing else: the two middle modes are INERT
 * cards (they are switched inside the session), so they emit nothing even if a
 * value were smuggled past the dialog.
 */
const GROK_PERM_ARGS: Record<Perm, readonly string[]> = {
  default: [],
  acceptEdits: [],
  plan: [],
  bypassPermissions: ['--always-approve'],
};

/**
 * Codex argv, fixed order: model, approval+sandbox, reasoning effort, then the
 * start-from tail. The tail is a SUBCOMMAND, so every option has to precede it
 * (`codex -m x -a … resume --last`).
 */
export function composeCodexArgs(
  model: string,
  perm: Perm,
  effort: string,
  start: string,
): string[] {
  const args: string[] = [];
  if (model !== TOOLS.codex.modelNone && isToolModel('codex', model)) args.push('-m', model);
  args.push(...CODEX_PERM_ARGS[perm]);
  if (effort !== TOOLS.codex.effortNone && isToolEffort('codex', effort)) {
    args.push('-c', `model_reasoning_effort=${effort}`);
  }
  if (start === 'last') args.push('resume', '--last');
  else if (start === 'pick') args.push('resume');
  return args;
}

/** Gemini CLI argv, fixed order: model, approval mode, then the start-from tail. */
export function composeGeminiArgs(model: string, perm: Perm, start: string): string[] {
  const args: string[] = [];
  if (model !== TOOLS.gemini.modelNone && isToolModel('gemini', model)) args.push('-m', model);
  args.push(...GEMINI_PERM_ARGS[perm]);
  if (start === 'last') args.push('-r', 'latest');
  return args;
}

/** Grok argv, fixed order: model, approval flag, effort, then the start-from tail. */
export function composeGrokArgs(
  model: string,
  perm: Perm,
  effort: string,
  start: string,
): string[] {
  const args: string[] = [];
  if (model !== TOOLS.grok.modelNone && isToolModel('grok', model)) args.push('-m', model);
  args.push(...GROK_PERM_ARGS[perm]);
  if (effort !== TOOLS.grok.effortNone && isToolEffort('grok', effort)) {
    args.push('--effort', effort);
  }
  if (start === 'last') args.push('--continue');
  return args;
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
  /**
   * claude only — ONE conversation of this project, chosen in Start from.
   * Emits `--resume <id>` in place of `--continue` (B5).
   */
  resumeId?: string;
  /** codex / gemini / grok — the model id each one's select holds. */
  codexModel?: string;
  geminiModel?: string;
  grokModel?: string;
  /** codex / grok — the effort id each one's select holds (Gemini has none). */
  codexEffort?: string;
  grokEffort?: string;
  /** codex / gemini / grok — the Start from value (claude uses the two above). */
  start?: string;
}

/**
 * THE composition path for every kind — `currentSpawn()` in launch.ts reads
 * only this, and its output IS the POST /api/sessions body. `composeArgs`
 * stays the claude argv composer underneath, and each B5 agent has exactly one
 * composer beside it; no kind grows a second vocabulary. null = nothing to
 * spawn (a blank custom line).
 */
export function composeSpawn(f: LaunchForm): SpawnSpec | null {
  if (f.kind === 'terminal') return shellSpawn(f.shell);
  if (f.kind === 'other') return parseCustomCommand(f.customLine);
  if (f.kind === 'codex') {
    return {
      command: TOOLS.codex.command,
      args: composeCodexArgs(
        f.codexModel ?? TOOLS.codex.modelNone,
        f.perm,
        f.codexEffort ?? TOOLS.codex.effortNone,
        f.start ?? 'fresh',
      ),
    };
  }
  if (f.kind === 'gemini') {
    return {
      command: TOOLS.gemini.command,
      args: composeGeminiArgs(f.geminiModel ?? TOOLS.gemini.modelNone, f.perm, f.start ?? 'fresh'),
    };
  }
  if (f.kind === 'grok') {
    return {
      command: TOOLS.grok.command,
      args: composeGrokArgs(
        f.grokModel ?? TOOLS.grok.modelNone,
        f.perm,
        f.grokEffort ?? TOOLS.grok.effortNone,
        f.start ?? 'fresh',
      ),
    };
  }
  return {
    command: TOOLS.claude.command,
    args: composeArgs(f.model, f.perm, f.continueLast, f.effort, f.resumeId),
  };
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
  return commandBase(command) === 'claude';
}

/** The last path segment of a command, both separators cut (it is user input). */
function commandBase(command: string): string {
  const parts = command.split(/[/\\]/);
  return parts[parts.length - 1] ?? command;
}

/**
 * The other three agents by BASENAME, the same rule `isClaudeCommand` applies —
 * a session launched as `/usr/local/bin/codex` is Codex, and printing its path
 * would put a command in UI chrome. A Map, not an object: a command named
 * `toString` must not find a label on Object.prototype.
 */
const TOOL_LABELS: ReadonlyMap<string, string> = new Map(
  AGENT_KINDS.map((k) => [
    TOOLS[k].command,
    TOOL_CARDS.find((c) => c.kind === k)?.label ?? AGENT_LABEL,
  ]),
);

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
  // An agent is recognised by its BASENAME, the same rule
  // `isClaudeCommand` / statusline-model.ts apply — a session launched as
  // `/usr/local/bin/claude` is the known agent, and printing its path would put
  // a command in UI chrome.
  return TOOL_LABELS.get(commandBase(command)) ?? shellLabel(command) ?? command;
}

/**
 * The mark a session wears (part B12), from what it already carries: its
 * command. The same basename rule `commandLabel` applies — an agent is its
 * own logo, one of this app's shells (exact command, as `shellLabel`) is the
 * terminal, and anything else a user typed is `command`: an icon is a claim
 * about what runs, and guessing one for an unknown program would be a lie.
 */
export function toolIconFor(command: string): ToolIconId {
  const base = commandBase(command);
  for (const k of AGENT_KINDS) {
    if (TOOLS[k].command === base) return TOOL_CARDS.find((c) => c.kind === k)?.icon ?? 'command';
  }
  return shellLabel(command) !== null ? 'terminal' : 'command';
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
