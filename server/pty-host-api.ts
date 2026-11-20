/**
 * The `PtyHost` interface — what the backend's SessionManager asks of whoever
 * owns the terminals — and its in-process implementation over
 * server/pty-table.ts.
 *
 * Nocturne D9 P1 (.claude/plans/nocturne/PLAN-D9.md § Phases): the seam a
 * separate pty-host process slots into (P2: a socket client implementing the
 * same interface; P3: the backend switches to it). Shaped for a socket now:
 *   - a request that needs an answer returns a Promise (`spawn`, `snapshot`,
 *     `list`) — over the wire it is a request frame and a reply frame;
 *   - a command that needs none returns void (`write`, `resize`, `kill`,
 *     `setMeta`, `forget`, `shutdownAll`) — over the wire it is one frame,
 *     sent in order after every earlier one;
 *   - what the PTYs do arrives as events through ONE listener, the owner's
 *     (`listen`): `output(id, data, offset)` and `exit(id, record)`.
 * The owner chooses the session id and passes it in `spawn`, so it can route
 * events for that id before the spawn's answer has been read.
 *
 * Members with no caller in P1, and the phase that calls them (PLAN-D9.md
 * § Defaults, § Phases):
 *   - `list()` / `PtyEntrySummary` — P3 boot: which ids are still live (history
 *     stamps `crash` only for the others; artifacts of live ids survive the
 *     wipe), each one's pid, size, exit record and `meta` to rebuild its
 *     SessionInfo from (adopt).
 *   - `snapshot()` — P3 adopt: refill the backend's mirror ring, then re-scan
 *     only `ring[scannedTo..endOffset]` for bells and titles missed in the gap.
 *   - `setMeta()` / `meta` — P3: the scan state, `attention`, `pendingSince`,
 *     `titleIdleSince` and what SessionInfo needs, flushed on change and on
 *     detach so a restarted backend finds them.
 *   - the `offset` of an output event — P3: the mirror tells a chunk it
 *     already holds (from the snapshot) from a new one, and finds a gap.
 * SessionManager ignores them in P1 on purpose (no behaviour change).
 *
 * P2 added `detach`, `onLost` and `pendingSpawns` for the socket
 * implementation (server/pty-host-client.ts `SocketPtyHost`); the in-process
 * one answers them trivially.
 *
 * Accepted cost while the table is in-process (P1 and P2; P3 moves it out): the
 * table's ring is a SECOND copy of the manager's mirror — up to another
 * SCROLLBACK_MAX_BYTES (1 MiB) per session — plus one extra `Buffer.from` per
 * output chunk. Kept so P3 re-attaches without reshaping anything.
 */
import type { Logger } from './config.ts';
import type { ByeReason } from './pty-host-wire.ts';
import {
  PtyTable,
  type PtyEntrySummary,
  type PtyEvents,
  type PtySnapshot,
  type PtySpawned,
  type PtySpawnRequest,
} from './pty-table.ts';

export interface PtyHost {
  /** Set the one owner that receives every output and exit event. */
  listen(events: PtyEvents): void;
  /**
   * Start a PTY; rejects when it cannot be spawned (nothing is left behind).
   * `PtySpawnRequest.meta` (optional, ≤ 16 KiB) is the entry's first metadata
   * blob, so a backend that dies right after the spawn still left it (P3).
   */
  spawn(req: PtySpawnRequest): Promise<PtySpawned>;
  /** Input bytes to a running PTY; ignored for an unknown or ended one. */
  write(id: string, data: string): void;
  resize(id: string, cols: number, rows: number): void;
  /** `ladder` = DELETE (SIGHUP, +2 s TERM, +3 s KILL to the group); `now` = shutdown (SIGHUP + SIGKILL). */
  kill(id: string, mode: 'ladder' | 'now'): void;
  /** The raw ring and its absolute end offset; undefined for an unknown id. */
  snapshot(id: string): Promise<PtySnapshot | undefined>;
  /** Replace the opaque metadata blob (≤ 16 KiB UTF-8; throws a RangeError over it). */
  setMeta(id: string, meta: string): void;
  list(): Promise<PtyEntrySummary[]>;
  /** The owner is done with this id: dropped once its PTY has exited. */
  forget(id: string): void;
  /** Kill every PTY now and finish off every ladder in flight (backend shutdown). */
  shutdownAll(): void;
  /**
   * Clean goodbye (D9 P2; P4's restart and update): the PTYs keep running for
   * the next owner, and `onLost` does not fire for it.
   */
  detach(): void;
  /**
   * The host is gone — the connection closed or the host process died (D9
   * P2). P3 then group-probes each known pid, SIGKILLs `-pid` and stamps
   * history `crash`. Never fires after `detach()`.
   */
  onLost(listener: (reason: PtyHostLostReason) => void): void;
  /**
   * Ids whose spawn was sent and not answered yet: live in the host, unknown
   * to the owner until the answer is read (§ Risks (a)) — P3's destroy,
   * destroyAll and detachAll must respect them.
   */
  pendingSpawns(): ReadonlySet<string>;
}

/**
 * Why the host is gone: `closed` (the connection dropped with no goodbye —
 * a crash or a kill) or the reason of the host's `bye`: another owner took
 * over, it exited idle or after the orphan grace, or it shut down.
 */
export type PtyHostLostReason = 'closed' | ByeReason;

const NO_PENDING_SPAWNS: ReadonlySet<string> = new Set();

/**
 * The PTYs live in this process, exactly as before D9. Events are delivered
 * synchronously from node-pty's callbacks, and node-pty reports nothing before
 * the spawn's promise has settled, so an owner awaiting `spawn` runs its
 * continuation before the first output of that PTY.
 */
export function createInProcessPtyHost(log: Logger): PtyHost {
  let owner: PtyEvents | undefined;
  const table = new PtyTable(log, {
    output: (id, data, offset) => owner?.output(id, data, offset),
    exit: (id, record) => owner?.exit(id, record),
  });
  return {
    listen: (events) => {
      owner = events;
    },
    spawn: async (req) => table.spawn(req),
    write: (id, data) => table.write(id, data),
    resize: (id, cols, rows) => table.resize(id, cols, rows),
    kill: (id, mode) => table.kill(id, mode),
    snapshot: async (id) => table.snapshot(id),
    setMeta: (id, meta) => table.setMeta(id, meta),
    list: async () => table.list(),
    forget: (id) => table.forget(id),
    shutdownAll: () => table.shutdownAll(),
    // In-process the PTYs live and die with this process: there is nothing to
    // detach from, the host can never be lost, and a spawn is answered
    // synchronously, so none is ever pending.
    detach: () => {},
    onLost: () => {},
    pendingSpawns: () => NO_PENDING_SPAWNS,
  };
}
