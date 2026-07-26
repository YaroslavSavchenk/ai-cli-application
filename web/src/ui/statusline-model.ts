/**
 * Config model for CLAUDE CODE'S OWN status line — the line Claude draws at the
 * bottom of its terminal, produced by `server/statusline.mjs`.
 *
 * NOT to be confused with `web/src/ui/statusline.ts`, which is the APP's bottom
 * chrome bar (ws latency, session counts, uptime). This module never renders
 * anything; it is DOM-free (no document, no xterm) so plain `node:test` imports
 * it directly, in the same spirit as theme-model.ts / github-model.ts.
 *
 * How a toggle here reaches a running session: the settings panel writes the
 * `statusLine` key into the prefs bag (PUT /api/prefs), and the script re-reads
 * prefs.json on EVERY invocation — so item toggles apply to sessions that are
 * already running, within a couple of seconds, with no restart. What CANNOT be
 * applied live is the existence of the status line itself: a session only has
 * one when the server injected its per-session settings file at spawn
 * (`SessionInfo.statusline === true`). Sessions started before that existed need
 * a relaunch — `sessionsWithoutStatusLine()` is what the panel's notice names.
 */
import type { SessionInfo, UiPrefs, UiStatusLine } from '../../../shared/protocol.ts';

/** Fully-resolved toggles (every key present) — what the panel renders from. */
export type StatusLineCfg = Required<UiStatusLine>;

/**
 * Factory toggles. These MUST stay byte-identical to DEFAULT_CONFIG in
 * server/statusline.mjs: the script applies its own defaults when a member is
 * absent from prefs.json, so a disagreement would make the panel show one thing
 * and the terminal draw another.
 */
const FACTORY: StatusLineCfg = {
  enabled: true,
  model: true,
  mode: true,
  branch: true,
  cost: true,
  lines: false,
  context: true,
  usage: false,
};

/** The keys of StatusLineCfg, in the order the status line draws them. */
const KEYS: (keyof StatusLineCfg)[] = [
  'enabled',
  'model',
  'mode',
  'branch',
  'cost',
  'lines',
  'context',
  'usage',
];

/**
 * Prefs-bag keys this app used to write and no longer does. The settings panel
 * drops them on every write (see statusLinePatch): `defaults` held the retired
 * global launch defaults + auto-run startup command, `statusBar` the retired
 * per-pane telemetry strip. Nothing reads them anymore, so leaving them in
 * prefs.json would only be dead weight the next reader has to explain.
 */
export const DEAD_PREFS_KEYS = ['defaults', 'statusBar'] as const;

/** The factory ON/OFF set (settings panel "Reset to defaults"), by value. */
export function statusLineDefaults(): StatusLineCfg {
  return { ...FACTORY };
}

/**
 * Coerce an untrusted bag member (it crossed a JSON boundary, and prefs.json is
 * an opaque bag the server never validates) into fully-resolved toggles: an
 * absent or non-boolean member takes its factory default, exactly as the script
 * resolves it.
 */
export function clampStatusLine(raw: unknown): StatusLineCfg {
  const o = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out = { ...FACTORY };
  for (const k of KEYS) if (typeof o[k] === 'boolean') out[k] = o[k];
  return out;
}

let current: StatusLineCfg = { ...FACTORY };

/** Seed from the boot prefs bag (`prefs.statusLine`); tolerant of anything. */
export function initStatusLine(fromPrefs: unknown): void {
  current = clampStatusLine(fromPrefs);
}

/** The current resolved toggles (the panel reads these fresh on every render). */
export function getStatusLine(): StatusLineCfg {
  return { ...current };
}

/** Replace the in-memory toggles (persistence is the caller's job — the panel). */
export function setStatusLine(next: UiStatusLine): void {
  current = clampStatusLine(next);
}

/**
 * The prefs patch a settings write sends: the resolved toggles under
 * `statusLine`. Paired with DEAD_PREFS_KEYS at the call site
 * (`api.updatePrefs(statusLinePatch(cfg), DEAD_PREFS_KEYS)`), so one write both
 * stores the new key and prunes the two retired ones. Every member is written
 * explicitly — the script treats absent as "factory default", which is not the
 * same statement as "the user chose this".
 */
export function statusLinePatch(cfg: StatusLineCfg): UiPrefs {
  return { statusLine: { ...cfg } };
}

/**
 * Running sessions of the known agent that have NO status line: the server only
 * injects the per-session settings file at spawn, so these predate the feature
 * (or predate this backend run) and cannot grow one without being relaunched.
 *
 * Matching mirrors the server exactly (server/sessions.ts): the last path
 * segment of `command` is 'claude'. Anything else is a different agent and never
 * had a status line to miss. Exited sessions are excluded — relaunching one is
 * the exited-pane banner's job, not a settings nag.
 */
export function sessionsWithoutStatusLine(sessions: Iterable<SessionInfo>): SessionInfo[] {
  const out: SessionInfo[] = [];
  for (const s of sessions) {
    if (s.status !== 'running') continue;
    if (s.statusline === true) continue;
    const base = s.command.split('/').pop();
    if (base === 'claude') out.push(s);
  }
  return out;
}
