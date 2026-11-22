/**
 * The one `SessionInfo` factory of the suite (PLAN-QUALITY Q10): a running
 * session as `GET /api/sessions` shapes it, every field a test does not name
 * filled with a fixed, plausible value.
 *
 * A file or fixture whose tests share other defaults (a cwd, a size, an age
 * against its own `now`) passes them as overrides in a one-line wrapper — the
 * field list lives here only. `createdAt` is a fixed instant, never the
 * machine's clock: a test that needs an age passes its own stamp.
 */
import type { SessionInfo } from '../../shared/protocol.ts';

/** The `createdAt` of a session that does not name one. */
export const SESSION_CREATED_AT = '2026-09-06T10:00:00.000Z';

/** A running `claude` session, 80×24; `title` follows `id` unless given; `over` wins. */
export function sessionInfo(over: Partial<SessionInfo> = {}): SessionInfo {
  const id = over.id ?? 's1';
  return {
    id,
    title: id,
    command: 'claude',
    args: [],
    cwd: '/tmp/work',
    status: 'running',
    cols: 80,
    rows: 24,
    createdAt: SESSION_CREATED_AT,
    attention: false,
    ...over,
  };
}
