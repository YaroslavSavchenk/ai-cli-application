/**
 * Wire shapes for Settings: UI preferences (prefs.json), launchable tools and saved API keys.
 *
 * Split from shared/protocol.ts (O8, 2026-09-23) — a pure move; the wire
 * contract is unchanged. Import from shared/protocol.ts, which re-exports
 * everything here. Sibling pieces: 
 *   protocol.ts (the single import point), protocol-settings.ts, protocol-runtime.ts, protocol-github.ts, protocol-fs.ts, protocol-git.ts.
 */

// ---------------------------------------------------------------------------
// UI preferences (prefs.json in the data dir)
// ---------------------------------------------------------------------------
//
// GET  /api/prefs -> UiPrefs ({} if none stored yet).
// PUT  /api/prefs body: UiPrefs (REPLACES the whole stored object) ->
//   OkResponse. Body must be a JSON object (arrays/null/scalars are 400) and
//   <= 64 KiB (PREFS_MAX_BYTES in server/api.ts); the server stores it
//   VERBATIM and never interprets its contents — deliberately an opaque
//   bag, so a future user-gated settings panel can add keys without a
//   server-side schema change. The one exception (Nocturne C1): `mascot`,
//   when present, must be exactly `{ enabled: boolean }` or the PUT is 400
//   (validMascotPref in server/api.ts). Auth like every other /api route.
//
// ONE READER exists outside the API (added 2026-07-26): server/statusline.mjs
// — the script Claude Code runs to draw its native status line — READS
// prefs.json directly (same user, same data dir) on EVERY invocation and
// honours the `statusLine` key below. That is what makes a settings-panel
// toggle apply to already-running sessions with no restart. It only reads;
// prefs.json is still written exclusively through PUT /api/prefs.

/**
 * Nocturne B9 (.claude/plans/nocturne/PLAN-B9.md) — the terminal colours the
 * user chose on Settings → Terminal colours: the ground and the bright text
 * step, both `#rrggbb` lower-case. The preset is not stored (the page recovers
 * it from the pair); an absent or invalid member means Nocturne, which is the
 * stylesheet's own tokens. Persisted under `theme`; the server never reads it.
 * The Legacy shape `{ bg, fg, scan }` (table indexes, until 2026-09-22) is
 * still accepted on read by web/src/ui/theme-model.ts and never written again.
 */
export interface UiTheme {
  ground?: string;
  text?: string;
}

/**
 * Which items Claude Code's OWN status line should draw, per user preference.
 * Persisted in the prefs bag under `statusLine` and read by server/statusline.mjs
 * — the script named in each claude session's injected `--settings` file — on
 * EVERY invocation, so flipping a toggle applies to running sessions with no
 * restart.
 *
 * Every member is optional; an absent member takes the factory default listed
 * below, and an absent/corrupt prefs.json means all factory defaults. An item is
 * drawn only when its toggle is on AND the payload carries an honest value for
 * it (a missing value is omitted, never rendered as zero/unknown).
 *
 * Sources, all from the JSON payload Claude Code pipes to the script on stdin
 * (verified against Claude Code 2.1.220) except where noted:
 */
export interface UiStatusLine {
  /**
   * Claude Code's OWN line inside the terminal. Off -> the script prints
   * nothing (blank bar). Default OFF since 2026-09-17 (user's call): the bar
   * under the terminal (`paneBar`) is the default place for these values.
   */
  enabled?: boolean;
  /** `model.display_name` (falls back to `model.id`). Default ON. */
  model?: boolean;
  /**
   * Permission mode in plain words. NOT in the payload: it is passed to the
   * script as an argument, parsed from the session's own `--permission-mode`
   * arg at spawn (the script prefers a payload field if a future Claude Code
   * adds one). Default ON.
   */
  mode?: boolean;
  /**
   * Git branch. NOT in the payload either: the script runs
   * `git branch --show-current` (argv, no shell) in `workspace.current_dir`,
   * cached ~5 s per `session_id`. Default ON.
   */
  branch?: boolean;
  /** `cost.total_cost_usd`, drawn only when > 0. Default ON. */
  cost?: boolean;
  /** `cost.total_lines_added` / `total_lines_removed`, drawn only when nonzero. Default OFF. */
  lines?: boolean;
  /** `context_window.used_percentage` (null until the first turn). Default ON. */
  context?: boolean;
  /**
   * `rate_limits.five_hour.used_percentage` / `.seven_day.used_percentage` —
   * the real account rate-limit windows. Claude.ai Pro/Max only, and only after
   * the first API response of the session; absent -> the item is omitted.
   * Default OFF.
   */
  usage?: boolean;
  /**
   * Nocturne B1 (.claude/plans/nocturne/PLAN-B1.md): the app's own bar UNDER the terminal
   * (web/src/ui/pane-status-model.ts) renders the SAME item toggles above,
   * fed by the snapshot the script writes (SessionTelemetry). This switch is
   * that bar; `enabled` is Claude's line INSIDE the terminal. Both ON shows
   * the same values twice, which is why only this one is on by default.
   * The script reads this key for one thing only: skipping its git probe when
   * neither bar would show a branch. Default ON.
   */
  paneBar?: boolean;
  /**
   * `Session time` — how long the PTY has been alive. Pane bar ONLY: the
   * payload carries no start time, so Claude's line cannot show it and the
   * script ignores this key. Default ON.
   */
  time?: boolean;
  /**
   * Nocturne B11: the Background agents table under the terminal
   * (ui/pane-agents-model.ts). Default OFF (user, 2026-09-22): Claude Code
   * draws its own task list inside the terminal and cannot hide it without
   * disabling background agents. Pane only; the script ignores it.
   */
  paneAgents?: boolean;
}

/**
 * Open preferences bag stored in prefs.json. `theme` and `statusLine` are typed
 * because the client uses them; any other key is opaque to the server and
 * preserved verbatim on PUT — merge-on-write (read the bag, replace only the
 * touched key, PUT the whole thing back) happens client-side, see
 * web/src/ui/theme.ts. The HTTP layer never interprets the bag beyond the
 * shape check on `mascot` (C1); the one consumer of `statusLine` is
 * server/statusline.mjs, which reads the file directly (see the note above
 * this section).
 */
export interface UiPrefs {
  theme?: UiTheme;
  statusLine?: UiStatusLine;
  behaviour?: UiBehaviour;
  tools?: UiTools;
  mascot?: UiMascot;
  [key: string]: unknown;
}

/**
 * Nocturne C1 (.claude/plans/nocturne/PLAN-C1.md § The toggle) — the peek
 * mascot switch, Settings -> Preferences. Absent = on. The server validates
 * the shape on PUT /api/prefs (`enabled` must be a boolean) and never reads
 * it otherwise; /mascot.html reads it each poll.
 */
export interface UiMascot {
  enabled: boolean;
}

/**
 * Nocturne B6 (.claude/plans/nocturne/PLAN-B6.md) — how the app behaves.
 * Persisted under `behaviour` (NOT `defaults`: that is a dead key the client
 * prunes, see DEAD_PREFS_KEYS in web/src/ui/statusline-model.ts). Every
 * member is optional on the wire; an absent or non-boolean member takes the
 * factory default in web/src/ui/prefs-model.ts. The server never reads this key.
 */
export interface UiBehaviour {
  /**
   * Restore the editor and folder tabs, the empty views and their order on a
   * NEW app start (a new backend run; a reload within the same run always
   * restores). Factory true.
   */
  reopenTabs?: boolean;
  /** Ending a session takes the armed two-step; off = one click ends it. Factory true. */
  confirmEnd?: boolean;
  /** Every write to a terminal ends at the bottom, even after scrolling up. Factory false. */
  followOutput?: boolean;
}

/**
 * Nocturne B6 — cards hidden from the New session dialog, by card id
 * (`TOOL_CARDS` in web/src/ui/launch-args.ts). Unknown ids are dropped on
 * read; at least one card always stays visible. The server never reads this key.
 */
export interface UiTools {
  hidden?: string[];
}

// ---------------------------------------------------------------------------
// Launchable tools + API keys (Nocturne B5, 2026-09-18; `.claude/plans/nocturne/PLAN-B5.md`)
// ---------------------------------------------------------------------------
//
// The New session dialog offers tools and shells the backend may or may not be
// able to spawn, and three of the tools read an API key from their environment.
//
//   GET    /api/tools       -> ToolAvailability. A PATH lookup in the SAME
//                              environment a session is spawned with (regular
//                              file, executable) — never a spawn. Cached ≤ 5 s.
//   GET    /api/keys        -> KeyStatus. Only saved / not saved and whether
//                              the backend's own environment carries the
//                              variable; a key value never reaches the page.
//   PUT    /api/keys/:tool  -> OkResponse (SaveKeyRequest body). 400 for an
//                              unknown tool or a value that is not key-shaped.
//   DELETE /api/keys/:tool  -> OkResponse (forget; 400 unknown tool).
//
// Keys live in `<dataDir>/keys.json` (0600, atomic) — the same ceiling as the
// GitHub token: readable by the user's own account, never logged. At spawn a
// SAVED key is set as that tool's variable in the child environment only, for
// exactly that tool (`basename(command)`), never in argv.

/** Which launchable executables the backend finds on its PATH. */
export interface ToolAvailability {
  claude: boolean;
  codex: boolean;
  gemini: boolean;
  grok: boolean;
  zsh: boolean;
  cmd: boolean;
  powershell: boolean;
}

/** The tools that take a stored API key. Codex is not one: a key alone does not sign it in. */
export type KeyedTool = 'claude' | 'gemini' | 'grok';
export const KEYED_TOOLS: readonly KeyedTool[] = ['claude', 'gemini', 'grok'];

/** True when `v` names a keyed tool. */
export function isKeyedTool(v: unknown): v is KeyedTool {
  return typeof v === 'string' && (KEYED_TOOLS as readonly string[]).includes(v);
}

/** The environment variable each keyed tool reads. */
export const KEY_ENV: Record<KeyedTool, string> = {
  claude: 'ANTHROPIC_API_KEY',
  gemini: 'GEMINI_API_KEY',
  grok: 'XAI_API_KEY',
};

/** GET /api/keys response. */
export interface KeyStatus {
  /** A key is stored in keys.json for the tool. */
  saved: Record<KeyedTool, boolean>;
  /** The backend's own environment carries the tool's variable (set outside the app). */
  env: Record<KeyedTool, boolean>;
}

/** PUT /api/keys/:tool request body. */
export interface SaveKeyRequest {
  key: string;
}
