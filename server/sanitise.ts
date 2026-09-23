/**
 * The sanitisers for text and records read out of files this app does not
 * write — Claude Code's status-line snapshot (server/telemetry.ts) and its
 * transcripts and agent meta files (server/agents-fold.ts, server/agents.ts).
 * Whatever passes through here ends up on screen, in the DOM and in
 * server.log, so a control character never survives and a timestamp past the
 * year 3000 is not believed.
 *
 * Part Q1 (`.claude/plans/PLAN-QUALITY.md`): these were two deliberate twins,
 * one in server/telemetry.ts and one in server/agents-fold.ts, identical but
 * for the cap `clean` applies (telemetry's was fixed at its own field cap).
 * One home now, the cap passed in. `server/statusline.mjs` keeps its own
 * `clean()`: it runs inside the foreign claude process and imports nothing
 * from `server/`.
 */

/** The latest ms epoch we believe: past this, the file is lying about its clock. */
export const MAX_AT_MS = Date.UTC(3000, 0, 1);

/** C0/C1 controls and DEL: never in a path we opened, never in text we print. */
export const CONTROL_CHAR = /[\u0000-\u001F\u007F-\u009F]/;

/** The same set, global, for replacing every one. */
const CONTROL_CHARS = new RegExp(CONTROL_CHAR.source, 'g');

/**
 * Terminal- and DOM-safe single-line text: strip C0/C1 controls and DEL,
 * collapse whitespace, trim, cap at `max` characters. Anything that is not a
 * string is '' — "no honest value", so the caller leaves the key out.
 */
export function clean(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const stripped = value.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
  return stripped.length > max ? stripped.slice(0, max) : stripped;
}

/** Plain object or undefined (arrays and null are not records). */
export function plainObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
