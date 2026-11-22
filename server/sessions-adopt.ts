/**
 * Nocturne D9's hand-over of sessions between backends, as functions over the
 * SessionManager's state: `detachSessions` (P4 — a restart or update parks
 * every PTY with the pty-host instead of ending it), `adoptSessions` (P3 —
 * boot takes over what a pty-host still holds) and `handOverSession` (P3 —
 * another backend took the pty-host over). Spec:
 * .claude/plans/nocturne/PLAN-D9.md.
 *
 * Split from server/sessions.ts (PLAN-QUALITY Q13, 2026-11-22) at the
 * adopt/detach seam, moved unchanged but for `this.#x` becoming `ctx.x`;
 * SessionManager keeps thin `detachAll` / `adopt` methods that call in here,
 * so its callers did not change. Siblings: server/sessions.ts
 * (SessionManager), server/sessions-state.ts (the per-session record),
 * server/sessions-meta.ts (the blob a session is adopted from),
 * server/sessions-output.ts, server/sessions-env.ts.
 */
import type { SessionInfo } from '../shared/protocol.ts';
import { isClaudeCommand } from '../shared/protocol.ts';
import type { SessionHistory } from './history.ts';
import { parsePermissionMode, type SessionSettingsStore } from './session-settings.ts';
import type { AgentsWatcher } from './agents.ts';
import type { Logger } from './config-log.ts';
import { parseSessionMeta, rescanGap } from './sessions-meta.ts';
import { newSession, syncPending, type Session } from './sessions-state.ts';
import type { PtyEntrySummary, PtyExitRecord } from './pty-table.ts';
import type { PtyHost } from './pty-host-api.ts';

/** The part of a SessionManager these functions read and change; built once by the manager. */
export interface AdoptContext {
  readonly sessions: Map<string, Session>;
  readonly ptys: Map<string, Session>;
  readonly host: PtyHost;
  readonly history: SessionHistory;
  readonly settings: SessionSettingsStore | undefined;
  readonly agents: AgentsWatcher | undefined;
  readonly log: Logger;
  readonly slog: Logger;
  /** The gap re-scan lost old bells: said once per run. */
  overrunLogged: boolean;
  onExit(id: string, session: Session, record: PtyExitRecord): void;
  flushMeta(id: string, session: Session): void;
}

/**
 * D9 P4 — restart and update: hand every PTY to the next backend instead of
 * ending it. Each session's blob is parked with its PTY (its `scannedTo`
 * too, so the next backend re-scans only what this one never saw — a bell
 * already looked at must not come back); a spawn still in flight is ended
 * (no history entry was written for it, and the next backend would adopt a
 * session nobody launched: § Risks (a)); then the host connection says
 * goodbye. No history stamp, no kill: the sessions run on. The restart's
 * teardown closes the sockets (1012). The manager sets its closing flag
 * first, so a spawn answered after this is killed too.
 */
export function detachSessions(ctx: AdoptContext): void {
  let pending = 0;
  for (const [id, session] of ctx.ptys) {
    if (session.destroyed || ctx.sessions.has(id)) continue;
    // The kill follows the spawn on the wire: the host has the PTY by then.
    ctx.host.kill(id, 'now');
    ctx.host.forget(id);
    pending += 1;
  }
  let running = 0;
  for (const [id, session] of ctx.sessions) {
    ctx.flushMeta(id, session);
    if (session.ptyLive) running += 1;
  }
  ctx.host.detach();
  ctx.slog(
    'info',
    `detached for a restart: ${running} running and ${ctx.sessions.size - running} exited session(s) ` +
      `left with the pty-host, ${pending} spawn(s) in flight ended`,
  );
}

/**
 * D9 P3 — boot, before listen: take over the sessions a pty-host still holds
 * from an earlier backend (its `list()`), each rebuilt from its metadata
 * blob, its mirror seeded from `snapshot()`, and the output this backend
 * never saw re-scanned for bells and titles (`rescanGap`). A session that
 * exited meanwhile ends here as any exit does (history `exit`, early-exit
 * verdict). A PTY whose blob is unreadable, or that was DELETEd, is ended:
 * nothing could show it. Adopted Claude sessions get their `--settings`
 * file written again (the status line command may name new code).
 */
export async function adoptSessions(ctx: AdoptContext, entries: readonly PtyEntrySummary[]): Promise<void> {
  for (const entry of entries) {
    let why: string | undefined;
    try {
      why = await adoptOne(ctx, entry);
    } catch (err) {
      why = `adopting it failed (${err instanceof Error ? err.name : typeof err})`;
    }
    if (why !== undefined) endUnadopted(ctx, entry.id, why);
  }
}

/** One entry of `adopt`; a sentence saying why it was NOT adopted, else undefined. */
async function adoptOne(ctx: AdoptContext, entry: PtyEntrySummary): Promise<string | undefined> {
  const { id } = entry;
  const meta = parseSessionMeta(entry.meta);
  if (meta === undefined) return 'no readable metadata';
  if (meta.deleted === true) return 'deleted';
  let snap;
  try {
    snap = await ctx.host.snapshot(id);
  } catch {
    snap = undefined;
  }
  if (snap === undefined) return 'its output could not be read';
  const info: SessionInfo = {
    id,
    ...meta.info,
    args: [...meta.info.args],
    status: 'running',
    cols: entry.cols,
    rows: entry.rows,
    attention: meta.attention,
    ...(meta.pendingSince === undefined ? {} : { pendingSince: meta.pendingSince }),
    ...(meta.turnEnded === true ? { turnEnded: true } : {}),
  };
  const session = newSession(info, isClaudeCommand(info.command));
  session.buffer.restore(snap.ring, snap.endOffset);
  const gap = rescanGap(snap.ring, snap.endOffset, meta.scannedTo, meta.scan);
  session.scan = gap.scan;
  session.titleIdleSince = meta.titleIdleSince;
  if (gap.overrun && !ctx.overrunLogged) {
    ctx.overrunLogged = true;
    ctx.slog('info', `${id} printed more than the scrollback while no backend ran: bells before it are lost`);
  }
  if (gap.bell) info.attention = true;
  if (gap.titleIdle === true) session.titleIdleSince ??= Date.now();
  else if (gap.titleIdle === false) session.titleIdleSince = undefined;
  syncPending(info);
  ctx.sessions.set(id, session);
  ctx.log(
    'info',
    `session ${id} adopted: pid ${entry.pid}, ${snap.endOffset - meta.scannedTo} byte(s) re-scanned` +
      `${gap.bell ? ', attention raised (BEL while no backend ran)' : ''}` +
      `${entry.exit === null ? '' : `, exited meanwhile with code ${entry.exit.code}`}`,
  );
  if (entry.exit !== null) {
    session.ptyLive = false;
    ctx.onExit(id, session, entry.exit);
    return undefined;
  }
  ctx.ptys.set(id, session);
  if (info.statusline === true) ctx.settings?.write(id, parsePermissionMode(info.args));
  ctx.flushMeta(id, session);
  return undefined;
}

/**
 * A PTY the pty-host holds that this backend will not show (S1/S2 of the P3
 * review): ended now and handed back, never left running unowned, and its
 * history entry stamped `crash` (a no-op when DELETE already stamped it),
 * so a resume is not refused as "still running" forever.
 */
function endUnadopted(ctx: AdoptContext, id: string, why: string): void {
  ctx.slog('info', `${id} not adopted (${why}); ending it`);
  ctx.sessions.delete(id);
  ctx.ptys.delete(id);
  ctx.host.kill(id, 'now');
  ctx.host.forget(id);
  ctx.history.markEnded(id, 'crash');
}

/**
 * D9 P3: another backend took the pty-host over (`bye taken-over`); this
 * session's PTY runs on under it. It leaves this backend without an end: no
 * history stamp, no `exit` frame — its sockets close 1012, as a restart's do,
 * and the session is no longer listed here.
 */
export function handOverSession(ctx: AdoptContext, id: string): void {
  const session = ctx.ptys.get(id) ?? ctx.sessions.get(id);
  ctx.ptys.delete(id);
  ctx.sessions.delete(id);
  if (session === undefined) return;
  session.ptyLive = false;
  ctx.agents?.untrack(id);
  for (const ws of session.clients) {
    try {
      ws.close(1012, 'session taken over');
    } catch {
      // Socket already gone.
    }
  }
  session.clients.clear();
  ctx.log('info', `session ${id} handed over to another backend`);
}
