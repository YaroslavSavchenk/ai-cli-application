/**
 * When WSL went down — the pure rules of the browser half (Quality Q17 P3,
 * `.claude/plans/quality/PLAN-Q17.md` § P3): every sentence the offline panel
 * and the boot notice say, when the panel is due, whether the recover flag is
 * still fresh, and the two answers of `/api/previous-exit` read strictly.
 *
 * The DOM halves are `./offline-panel.ts` (the panel and the relaunch) and
 * `./previous-exit.ts` (the boot notice and the resume); where a resumed
 * session goes in the tabs is `./resume-layout-model.ts`.
 *
 * TIME IS LOCAL `HH:mm`: the notice tells the user when THEIR app stopped, on
 * their wall clock, like the Windows taskbar — never UTC, never a date (the
 * notice is read at the next start, which is the same day in practice; a
 * stale notice still names the right minute).
 */
import type {
  PreviousExitCause,
  PreviousExitNotice,
  PreviousExitResumeResponse,
  PreviousExitResumed,
  SessionInfo,
} from '../../../shared/protocol.ts';
import { fmtBytes } from './format-model.ts';

// ---------------------------------------------------------------------------
// The recover flag: `Restart` in one window → the auto-resume in the next
// ---------------------------------------------------------------------------

/** The localStorage key the `Restart` button writes (epoch ms as text). */
export const RECOVER_KEY = 'aism.recover';
/**
 * How old the flag may be and still mean "the user pressed Restart for THIS
 * start". A relaunch boots WSL and the backend in well under a minute; ten
 * leaves room for a slow cold boot and is short enough that a flag left by a
 * relaunch that never came back cannot resume sessions on some later start.
 */
export const RECOVER_MAX_AGE_MS = 10 * 60 * 1000;

/**
 * Is the stored flag a press of `Restart` less than `RECOVER_MAX_AGE_MS` ago?
 * Storage is hostile: anything but a whole epoch-ms number is not a flag, and
 * a time in the FUTURE is not one either (it cannot be a press that happened).
 */
export function recoverFlagFresh(raw: string | null, now: number): boolean {
  if (raw === null || !/^\d{1,16}$/.test(raw)) return false;
  const age = now - Number(raw);
  return age >= 0 && age < RECOVER_MAX_AGE_MS;
}

/**
 * What the boot does with a 200 from `GET /api/previous-exit`: resume at once
 * when the user just pressed `Restart` (decision 2: no second question), else
 * offer it. Nothing to resume is always an offer — the notice still says what
 * happened, and `Dismiss` is its one answer.
 */
export function bootAction(notice: PreviousExitNotice, flagFresh: boolean): 'resume' | 'offer' {
  return flagFresh && notice.sessions > 0 ? 'resume' : 'offer';
}

// ---------------------------------------------------------------------------
// The offline panel's timing
// ---------------------------------------------------------------------------

/** How long the backend must stay unreachable before the panel replaces the pill. */
export const OFFLINE_PANEL_MS = 10_000;
/**
 * How long `Restarting…` waits for the host. The host's own ceiling is 120 s
 * and it answers `relaunch-failed` at it; this is the page's net for a host
 * that never answers at all (one built before the `relaunch` message existed
 * ignores it), so the button cannot spin for ever.
 */
export const RELAUNCH_WAIT_MS = 150_000;

/**
 * Is the panel due? `downSince` is the first failed poll of the current
 * streak (null while the backend answers). `blocked` is the app's own restart
 * or update flow (the backend is SUPPOSED to vanish), a takeover that already
 * owns the page, or the restart dialog that already says so.
 */
export function offlinePanelDue(downSince: number | null, now: number, blocked: boolean): boolean {
  return !blocked && downSince !== null && now - downSince >= OFFLINE_PANEL_MS;
}

// ---------------------------------------------------------------------------
// Copy — the offline panel
// ---------------------------------------------------------------------------

export const PANEL_TITLE = 'The app stopped responding';
export const PANEL_LINE = 'WSL or the background service stopped.';
export const RESTART_LABEL = 'Restart';
export const RESTARTING_LABEL = 'Restarting…';
/** The one way back outside the host, and after a relaunch that failed. */
export const SHORTCUT_ADVICE = 'Close this window and start the app again from the desktop shortcut.';
export const RELAUNCH_FAILED = 'The restart did not work.';

// ---------------------------------------------------------------------------
// Copy — the boot notice
// ---------------------------------------------------------------------------

export const DISMISS_LABEL = 'Dismiss';
export const RESUME_FAILED = 'The sessions could not be resumed. Try again, or open them from History.';

/** `12:53` on the local clock, or '' for a time that does not parse. */
export function clockTime(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
}

/**
 * The size of the killed process: `rssMb` is MiB, shown the way Windows
 * Explorer shows a size (`fmtBytes`, the app's one size format): 2731 →
 * `2.7 GB`, 812 → `812 MB`, 14746 → `14 GB`.
 */
export function rssText(rssMb: number): string {
  return fmtBytes(rssMb * 1024 * 1024);
}

/** What happened, in one sentence (the spec's copy, byte-exact). */
export function causeSentence(n: Pick<PreviousExitNotice, 'at' | 'cause' | 'detail'>): string {
  const at = clockTime(n.at);
  const when = at === '' ? '' : ` at ${at}`;
  const cause: PreviousExitCause = n.cause;
  switch (cause) {
    case 'oom':
      return n.detail === null
        ? `WSL ran out of memory${when} and shut down.`
        : `WSL ran out of memory${when} — ${n.detail.process} (${rssText(n.detail.rssMb)}) was stopped, and WSL shut down.`;
    case 'wsl-stopped':
      return `WSL shut down${when}.`;
    case 'stopped':
      return `The app was stopped${when}.`;
    case 'crash':
      return `The app stopped unexpectedly${when}.`;
  }
}

/** `1 session` / `3 sessions` — the one plural rule of this notice. */
function sessionsWord(n: number): string {
  return n === 1 ? '1 session' : `${n} sessions`;
}

/** The notice's title before anything was resumed. */
export function stoppedTitle(sessions: number): string {
  return sessions === 0 ? 'The app stopped' : `${sessionsWord(sessions)} stopped`;
}

/** `Resume 3 sessions`. */
export function resumeLabel(sessions: number): string {
  return `Resume ${sessionsWord(sessions)}`;
}

/** `3 sessions resumed`. */
export function resumedTitle(resumed: number): string {
  return `${sessionsWord(resumed)} resumed`;
}

/** `1 could not be resumed`, or '' when none failed. */
export function failedLine(failed: number): string {
  return failed === 0 ? '' : `${failed} could not be resumed`;
}

// ---------------------------------------------------------------------------
// The two answers, read strictly (the wire is a boundary like any other)
// ---------------------------------------------------------------------------

const CAUSES: readonly PreviousExitCause[] = ['oom', 'wsl-stopped', 'stopped', 'crash'];
/** More than any app could have had running; past it the answer is not believed. */
const MAX_SESSIONS = 1000;

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isCount(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_SESSIONS;
}

/**
 * `GET /api/previous-exit`: the 200 body, or null — a 204 (no body), a body
 * that is not the contract. A process name outside the server's own alphabet
 * is dropped with its size rather than shown: the server already sanitised
 * it, so anything else is not its answer.
 */
export function parseNotice(body: unknown): PreviousExitNotice | null {
  if (!isRecord(body)) return null;
  const { at, cause, detail, sessions } = body;
  if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) return null;
  if (typeof cause !== 'string' || !(CAUSES as readonly string[]).includes(cause)) return null;
  if (!isCount(sessions)) return null;
  let d: PreviousExitNotice['detail'] = null;
  if (isRecord(detail)) {
    const { process, rssMb } = detail;
    if (
      typeof process === 'string' &&
      /^[A-Za-z0-9._-]{1,32}$/.test(process) &&
      typeof rssMb === 'number' &&
      Number.isFinite(rssMb) &&
      rssMb >= 0
    ) {
      d = { process, rssMb };
    }
  }
  return { at, cause: cause as PreviousExitCause, detail: d, sessions };
}

function isSessionInfo(v: unknown): v is SessionInfo {
  // The fields the app reads before it draws anything; the rest is the
  // server's own SessionInfo, the same object `GET /api/sessions` hands over.
  return (
    isRecord(v) &&
    typeof v.id === 'string' &&
    v.id !== '' &&
    typeof v.title === 'string' &&
    typeof v.status === 'string' &&
    typeof v.createdAt === 'string'
  );
}

/**
 * `POST /api/previous-exit/resume`: the lists, or null when the body is not
 * the contract. A row that is malformed is dropped on its own — one bad row
 * must not cost the user the sessions that did come back.
 */
export function parseResumeAnswer(body: unknown): PreviousExitResumeResponse | null {
  if (!isRecord(body) || !Array.isArray(body.resumed) || !Array.isArray(body.failed)) return null;
  const resumed: PreviousExitResumed[] = [];
  for (const r of body.resumed.slice(0, MAX_SESSIONS)) {
    if (!isRecord(r)) continue;
    const { historyId, previousSessionId, session } = r;
    if (typeof historyId !== 'string' || typeof previousSessionId !== 'string') continue;
    if (!isSessionInfo(session)) continue;
    resumed.push({ historyId, previousSessionId, session });
  }
  const failed: PreviousExitResumeResponse['failed'] = [];
  for (const f of body.failed.slice(0, MAX_SESSIONS)) {
    if (!isRecord(f) || typeof f.historyId !== 'string') continue;
    failed.push({ historyId: f.historyId, error: typeof f.error === 'string' ? f.error : '' });
  }
  return { resumed, failed };
}
