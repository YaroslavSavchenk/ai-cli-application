/**
 * Auto-run startup command registry — fire-exactly-once-per-spawn.
 *
 * The settings panel's "auto-run startup command" (a slash/skill line, e.g.
 * `/caveman`) is typed into every NEW claude-mode session once it is ready.
 * "Ready" is defined honestly and simply (no prompt-detection heuristics):
 * after the session's terminal attaches and its FIRST live output arrives, the
 * launching window writes the line + CR to the PTY, exactly once.
 *
 * Only the window that launched the session arms it (launch.ts), so a session
 * adopted from another window/tab never retro-runs the command. The once-only
 * guarantee is CLIENT-SIDE, per spawn: arm() records the pending line keyed by
 * session id; consume() returns it and removes it. A tab switch disposes and
 * re-attaches the terminal (replaying scrollback) — its "first output" fires
 * again, but consume() already emptied the entry, so nothing is re-typed.
 * This is deliberately a best-effort client guard, not a server guarantee.
 */
const pending = new Map<string, string>();

/**
 * Arm the startup command for a freshly-spawned session (no-op for blank lines).
 *
 * Arming happens only AFTER createSession() succeeds (launch.ts), so a failed
 * spawn never leaves an entry. An entry is removed by consumeStartupCommand on
 * the session's first live output; a session that attaches but never emits any
 * output would leave its entry pending for the rest of the app run. That orphan
 * is acceptable: it is the attach-failure-only case, the map is in-memory and
 * per-run (it dies with the tab/window), and the count is bounded by the number
 * of launches — nothing accumulates across runs or grows unbounded.
 */
export function armStartupCommand(sessionId: string, line: string): void {
  if (line.trim() !== '') pending.set(sessionId, line);
}

/** Take the pending startup command for a session, if any — removes it (fires once). */
export function consumeStartupCommand(sessionId: string): string | null {
  const line = pending.get(sessionId);
  if (line === undefined) return null;
  pending.delete(sessionId);
  return line;
}
