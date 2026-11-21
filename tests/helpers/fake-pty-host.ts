/**
 * A recording fake `PtyHost` (server/pty-host-api.ts) for the SessionManager's
 * own rules — Nocturne D9 P2's seam test (`tests/server/sessions-pty-host-seam.test.ts`)
 * and P3's adopt / pending-spawn / meta tests (`tests/server/sessions-adopt.test.ts`).
 * No PTY is started: the calls the manager makes, the blobs it parks and the
 * events a test feeds it are the whole observable.
 *
 * `hold: true` keeps every spawn unanswered until `answer(id)` — the window in
 * which a socket host's spawn is real I/O (§ Risks (a), (b), (c)).
 */
import { join } from 'node:path';
import { SessionHistory } from '../../server/history.ts';
import { SessionManager } from '../../server/sessions.ts';
import type { Logger } from '../../server/config.ts';
import type { PtyHost, PtyOwnerEvents } from '../../server/pty-host-api.ts';
import type { PtyEntrySummary, PtySnapshot, PtySpawnRequest } from '../../server/pty-table.ts';
import { makeTempDir } from './helpers.ts';

export interface FakePtyHost extends PtyHost {
  calls: string[];
  spawned: PtySpawnRequest[];
  /** The last blob set per id (spawn's `meta` included). */
  metas: Map<string, string>;
  /** What `snapshot(id)` answers. */
  snapshots: Map<string, PtySnapshot>;
  events: () => PtyOwnerEvents | undefined;
  /** Answer a held spawn with this pid. */
  answer: (id: string, pid?: number) => void;
}

export function fakePtyHost(opts: { hold?: boolean } = {}): FakePtyHost {
  const calls: string[] = [];
  const spawned: PtySpawnRequest[] = [];
  const metas = new Map<string, string>();
  const snapshots = new Map<string, PtySnapshot>();
  const held = new Map<string, (pid: number) => void>();
  let events: PtyOwnerEvents | undefined;
  return {
    calls,
    spawned,
    metas,
    snapshots,
    events: () => events,
    answer: (id, pid = 4242) => {
      const resolve = held.get(id);
      held.delete(id);
      resolve?.(pid);
    },
    listen: (e) => {
      events = e;
    },
    spawn: (req) => {
      spawned.push(req);
      calls.push(`spawn ${req.id}`);
      if (req.meta !== undefined) metas.set(req.id, req.meta);
      if (opts.hold !== true) return Promise.resolve({ pid: 4242 });
      return new Promise((resolve) => held.set(req.id, (pid) => resolve({ pid })));
    },
    write: (id) => calls.push(`write ${id}`),
    resize: (id, cols, rows) => calls.push(`resize ${id} ${cols}x${rows}`),
    kill: (id, mode) => calls.push(`kill ${id} ${mode}`),
    snapshot: async (id) => snapshots.get(id),
    setMeta: (id, meta) => {
      calls.push(`set-meta ${id}`);
      metas.set(id, meta);
    },
    list: async (): Promise<PtyEntrySummary[]> => [],
    forget: (id) => calls.push(`forget ${id}`),
    shutdownAll: () => calls.push('shutdown-all'),
    detach: () => calls.push('detach'),
  };
}

/**
 * A SessionManager over `host` with its own history file in a temp dir (pushed
 * to `dirs` for cleanup). `log` receives the manager's lines (default: none).
 */
export async function fakeHostManager(
  host: PtyHost,
  dirs: string[],
  log: Logger = () => {},
): Promise<{ sessions: SessionManager; history: SessionHistory }> {
  const dir = await makeTempDir('ai-sm-fakehost-');
  dirs.push(dir);
  const history = new SessionHistory(join(dir, 'history.json'), () => {});
  const sessions = new SessionManager(log, history, undefined, undefined, undefined, undefined, host);
  return { sessions, history };
}
