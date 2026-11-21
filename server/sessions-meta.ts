/**
 * The session metadata blob the backend parks with each PTY in the pty-host
 * (`PtySpawnRequest.meta` at spawn, `setMeta` on change) and reads back when
 * a restarted backend adopts the PTY — pure: encode, parse, and the gap
 * re-scan of the output a backend missed.
 *
 * Nocturne D9 P3 (.claude/plans/nocturne/PLAN-D9.md § Defaults): the pty-host
 * interprets nothing, so everything a new backend needs to rebuild a
 * `SessionInfo` and carry on the bell and title scan lives here, versioned.
 * Split from server/sessions.ts by topic; siblings server/sessions-output.ts
 * (the scan itself), server/sessions-env.ts.
 *
 * Shape v1 (JSON, ≤ 16 KiB — server/pty-table.ts `assertMetaSize`):
 *   { v: 1,
 *     info: { projectId?, title, command, args, cwd, createdAt, statusline? },
 *     scan: OutputScanState, scannedTo: number,   // the scan stood here
 *     attention, pendingSince?, turnEnded?, titleIdleSince?,
 *     deleted? }                                  // DELETEd: never adopt
 * `scannedTo` is the absolute stream offset (server/pty-table.ts
 * `RingBuffer.endOffset`) the `scan` state is valid at. The blob is written
 * whenever a field it carries changes — a bell, a title turning idle or not,
 * a look, a turn ending — so the output after `scannedTo` raised nothing yet,
 * and a new backend re-scans exactly that part (`rescanGap`).
 *
 * Over the cap (client args or a title can be long): long args and the title
 * are cut, and if that is not enough only the permission args are kept — the
 * session survives with a shorter row and the SAME permission badge and
 * status-line mode; the history entry keeps the full argv for a resume. Still
 * over: no blob, and the session is not adopted after a backend restart.
 */
import { isStringArray } from './config.ts';
import { plainObject } from './sanitise.ts';
import { assertMetaSize } from './pty-table.ts';
import { newOutputScan, scanOutput, type OutputScanState } from './sessions-output.ts';

const META_VERSION = 1;
/** A title kept when the full blob does not fit (the UI shows far less). */
const TITLE_CUT = 256;

/** The SessionInfo fields a restarted backend rebuilds a session from. */
interface SessionMetaInfo {
  projectId?: string;
  title: string;
  command: string;
  args: string[];
  cwd: string;
  createdAt: string;
  statusline?: true;
}

export interface SessionMeta {
  info: SessionMetaInfo;
  scan: OutputScanState;
  scannedTo: number;
  attention: boolean;
  pendingSince?: string;
  turnEnded?: true;
  titleIdleSince?: number;
  deleted?: true;
}

/** Longest arg kept when the full blob does not fit (a long prompt text is cut, not dropped). */
const ARG_CUT = 512;

/**
 * The args the UI and the status line read a session's permission from
 * (web/src/ui/format-model.ts `permFromArgs`, server/session-settings.ts
 * `parsePermissionMode`): `--dangerously-skip-permissions`,
 * `--permission-mode <mode>` and `--permission-mode=<mode>`. Never dropped
 * (P3 security review F2): an adopted bypass session must not come back
 * looking like a safe one.
 */
function permissionArgs(args: readonly string[]): string[] {
  const kept: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === '--dangerously-skip-permissions' || arg.startsWith('--permission-mode=')) kept.push(arg);
    else if (arg === '--permission-mode') {
      kept.push(arg);
      const value = args[i + 1];
      if (value !== undefined) kept.push(value);
      i += 1;
    }
  }
  return kept;
}

/**
 * The blob as JSON within the cap, in three tiers: whole; else every arg cut
 * to ARG_CUT characters and the title to TITLE_CUT (every flag kept); else
 * only the permission args (`permissionArgs`) and the cut title. Undefined
 * when even that does not fit (a command or cwd of kilobytes): such a session
 * runs, but is not adopted.
 */
export function encodeSessionMeta(meta: SessionMeta): string | undefined {
  const full = JSON.stringify({ v: META_VERSION, ...meta });
  if (fits(full)) return full;
  const title = meta.info.title.slice(0, TITLE_CUT);
  for (const args of [meta.info.args.map((a) => a.slice(0, ARG_CUT)), permissionArgs(meta.info.args)]) {
    const text = JSON.stringify({ v: META_VERSION, ...meta, info: { ...meta.info, args, title } });
    if (fits(text)) return text;
  }
  return undefined;
}

function fits(text: string): boolean {
  try {
    assertMetaSize(text);
    return true;
  } catch {
    return false;
  }
}

function isOffset(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

function isOscState(v: unknown): v is OutputScanState['osc'] {
  return v === 'num' || v === 'title' || v === 'dropped' || v === 'skip';
}

function parseScan(raw: unknown): OutputScanState | undefined {
  const v = plainObject(raw);
  if (v === undefined) return undefined;
  const { inOsc, esc, osc, oscNum, titleLen, titleIdle } = v;
  if (typeof inOsc !== 'boolean' || typeof esc !== 'boolean' || typeof titleIdle !== 'boolean') return undefined;
  if (!isOscState(osc) || typeof oscNum !== 'string' || !/^\d{0,3}$/.test(oscNum)) return undefined;
  if (!isOffset(titleLen)) return undefined;
  return { inOsc, esc, osc, oscNum, titleLen, titleIdle };
}

function parseInfo(raw: unknown): SessionMetaInfo | undefined {
  const v = plainObject(raw);
  if (v === undefined) return undefined;
  const { projectId, title, command, args, cwd, createdAt, statusline } = v;
  if (typeof title !== 'string' || typeof command !== 'string' || command === '') return undefined;
  if (!isStringArray(args) || typeof cwd !== 'string' || !cwd.startsWith('/')) return undefined;
  if (typeof createdAt !== 'string' || Number.isNaN(Date.parse(createdAt))) return undefined;
  if (projectId !== undefined && typeof projectId !== 'string') return undefined;
  return {
    ...(typeof projectId === 'string' ? { projectId } : {}),
    title,
    command,
    args: [...args],
    cwd,
    createdAt,
    ...(statusline === true ? { statusline: true as const } : {}),
  };
}

/**
 * The blob read back, or undefined when it is missing, of another version or
 * malformed in any field — a PTY whose blob cannot be read is not adopted
 * (nothing could be shown for it) and the caller ends it.
 */
export function parseSessionMeta(text: string | null): SessionMeta | undefined {
  if (text === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const raw = plainObject(parsed);
  if (raw === undefined || raw['v'] !== META_VERSION) return undefined;
  const info = parseInfo(raw['info']);
  const scan = parseScan(raw['scan']);
  const { scannedTo, attention, pendingSince, turnEnded, titleIdleSince, deleted } = raw;
  if (info === undefined || scan === undefined || !isOffset(scannedTo) || typeof attention !== 'boolean') {
    return undefined;
  }
  if (pendingSince !== undefined && (typeof pendingSince !== 'string' || Number.isNaN(Date.parse(pendingSince)))) {
    return undefined;
  }
  if (titleIdleSince !== undefined && !isOffset(titleIdleSince)) return undefined;
  return {
    info,
    scan,
    scannedTo,
    attention,
    ...(pendingSince === undefined ? {} : { pendingSince }),
    ...(turnEnded === true ? { turnEnded: true as const } : {}),
    ...(titleIdleSince === undefined ? {} : { titleIdleSince }),
    ...(deleted === true ? { deleted: true as const } : {}),
  };
}

/** What the re-scan of the missed output found. */
interface GapScan {
  /** A real bell in the gap. */
  bell: boolean;
  /** The last window title the gap completed: idle / not idle / none. */
  titleIdle: boolean | undefined;
  /** The gap began before the ring's oldest byte: older bells are lost. */
  overrun: boolean;
  /** The scan state at the ring's end. */
  scan: OutputScanState;
}

/**
 * Scan what a backend missed: `ring[scannedTo..endOffset]` of a pty-host
 * snapshot, carrying the stored scan state. When the ring no longer reaches
 * back to `scannedTo` (more than its 1 MiB was printed in the gap) the whole
 * ring is scanned from a fresh state — mid-stream, an old state would read
 * the wrong bytes as an OSC — and `overrun` says bells before it are lost.
 * Byte slices are decoded as UTF-8; a cut character only becomes U+FFFD, and
 * the scan reads ASCII controls and one glyph.
 */
export function rescanGap(ring: Buffer, endOffset: number, scannedTo: number, state: OutputScanState): GapScan {
  const ringStart = endOffset - ring.byteLength;
  const overrun = scannedTo < ringStart;
  const scan = overrun ? newOutputScan() : { ...state };
  const from = overrun ? 0 : Math.min(scannedTo - ringStart, ring.byteLength);
  const found = scanOutput(ring.subarray(from).toString('utf8'), scan);
  return { bell: found.bell, titleIdle: found.titleIdle, overrun, scan };
}

/**
 * The part of an output chunk the mirror does not hold yet. `offset` is the
 * chunk's absolute start (server/pty-table.ts `PtyEvents`); after an adopt the
 * mirror starts at the snapshot's end, and the pty-host's events that were
 * queued meanwhile overlap it. The cut lands on the end of a chunk the host
 * already sent — a character boundary.
 */
export function unseenTail(mirrorEnd: number, data: string, offset: number): string {
  if (offset >= mirrorEnd) return data;
  const bytes = Buffer.from(data, 'utf8');
  const skip = mirrorEnd - offset;
  return skip >= bytes.byteLength ? '' : bytes.subarray(skip).toString('utf8');
}
