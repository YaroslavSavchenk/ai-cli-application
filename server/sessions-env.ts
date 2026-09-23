/**
 * The environment a session's PTY is spawned with: this process's own, minus
 * the restart-handoff variables and minus the markers of whichever Claude Code
 * session started the backend.
 *
 * Split from server/sessions.ts (PLAN-RESTRUCTURE O8, 2026-09-23), moved
 * byte-exact; server/sessions.ts re-exports ptyEnv. Sibling pieces:
 * server/sessions.ts (SessionManager: the PTY spawn, resize, kill ladder and
 * lifecycle) and server/sessions-output.ts (scrollback ring, bell scan,
 * final-output rescue).
 */

/**
 * The four variables that belong to a RESTART HANDOFF and to nothing else
 * (server/restart.ts): they describe how THIS backend was started. A session
 * inheriting them would hand a shell — and anything the user runs in it,
 * including another copy of this app — a port hint, a foreign pid, a served
 * frontend directory and a "you are a standby" flag that mean nothing there
 * and would be obeyed by a backend launched from inside the terminal.
 */
const HANDOFF_ENV = [
  'AI_SM_STANDBY',
  'AI_SM_PORT_HINT',
  'AI_SM_RESTARTED_FROM',
  'AI_SM_WEB_DIST_DIR',
  // Not a handoff value but the same kind of seam: it moves the boundary the
  // Files panel's routes are confined to (server/fsbrowse.ts). A PTY that
  // inherited it would run a shell whose idea of `home` is a test fixture.
  'AI_SM_HOME_OVERRIDE',
] as const;

/**
 * What a running Claude Code hands every process it spawns, to mark it as a
 * CHILD of that session (found 2026-09-17: a backend started from inside a
 * Claude Code terminal passed these on, and every claude the app launched
 * then believed it was a nested child — "Transcript saving is off — inherited
 * CLAUDE_CODE_CHILD_SESSION marker", so nothing it said could be resumed).
 * Sessions this app launches are top-level by definition, whatever started
 * the backend. Named one by one, NOT as `CLAUDE_CODE_*`: that prefix also
 * carries the user's own configuration (`CLAUDE_CODE_USE_BEDROCK`,
 * `CLAUDE_CODE_MAX_OUTPUT_TOKENS`, …), which must reach the session intact.
 */
const PARENT_CLAUDE_ENV = [
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
] as const;

/**
 * This process's environment as a PTY gets it: ours, minus the handoff flags
 * and minus the markers of whichever Claude Code session started the backend.
 *
 * EXPORTED because two read-only callers must mean the very same environment a
 * session is spawned with, or they would lie about it: the PATH probe behind
 * GET /api/tools (server/tools.ts) and the `env` half of GET /api/keys.
 */
export function ptyEnv(): Record<string, string> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
  };
  for (const name of HANDOFF_ENV) delete env[name];
  for (const name of PARENT_CLAUDE_ENV) delete env[name];
  return env;
}
