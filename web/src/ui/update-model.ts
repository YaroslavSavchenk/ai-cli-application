/**
 * "A newer version of the app is on disk" — the DOM-free MODEL behind the
 * toast, the topbar pill and the restart confirmation. No document, no fetch,
 * no timers: `tests/ui-update-model.test.ts` drives every rule here, and
 * `./update.ts` is the thin glue that paints it (same split as
 * `log-core.ts` / `log.ts`).
 *
 * WHAT THE NOTICE PROMISES. The backend answers `GET /api/runtime` with
 * `update: { available, reason }` — computed per request, not at boot. The
 * page polls it; this model turns that stream of answers into ONE of five
 * states and remembers exactly one thing across them: which reason the user
 * already waved away. A DIFFERENT reason is a new fact and shows the toast
 * again; the same reason never nags twice.
 *
 * The PILL is the persistent half — dismissing the toast keeps it, and only a
 * backend that reports `available: false` (or a completed restart) takes it
 * away. That is the user's request: "de popup kun je wegklikken maar die
 * blijft ergens hangen".
 *
 * Copy rule (PROJECT-SCOPE, 2026-07-25): every string this module returns is
 * shown to a human. No flags, no commands, no config names — plain short
 * words. The server's raw `reason` is NEVER shown: it carries git hashes and
 * file-tree words (`server code changed (6113709 → a1b2c3d)`), so
 * `reasonSentence()` below maps it to a plain sentence and the raw text stays
 * in the client log line only.
 */
import type { SessionInfo, UpdateStatus } from '../../../shared/protocol.ts';
import { hasContinueFlag, isClaudeCommand } from './launch-args.ts';

/**
 * - `hidden`     nothing to say (no update, or a restart finished the story)
 * - `toast`      toast AND pill visible — the arrival state of a new reason
 * - `pill`       toast dismissed for this reason; the pill stays
 * - `restarting` a restart is in flight; the toast steps aside and the pill
 *                says so (it is the only thing on screen while the dialog is
 *                hidden, and clicking it brings the dialog back)
 * - `done`       the restart succeeded and the page is being replaced
 */
export type NoticeState = 'hidden' | 'toast' | 'pill' | 'restarting' | 'done';

/** Rows the confirmation lists before it collapses the rest into `+ K more`. */
export const CONFIRM_LIST_MAX = 6;

/** The pill's word while an update is pending. */
export const PILL_LABEL = 'update';
/**
 * …and while a restart is running. During the preflight the dialog can be put
 * away, and without this the screen would say NOTHING about a restart in
 * flight — the only way back to it would be the settings panel.
 */
export const PILL_LABEL_RESTARTING = 'restarting…';
/** Tooltip for that state; the pending-update tooltip lives in `update.ts`. */
export const PILL_TIP_RESTARTING = 'A restart is running — show it';

export class UpdateNotice {
  #state: NoticeState = 'hidden';
  /** The reason currently being reported, or null when nothing is available. */
  #reason: string | null = null;
  /** The reason whose toast the user waved away. Never cleared by a poll. */
  #dismissed: string | null = null;

  get state(): NoticeState {
    return this.#state;
  }

  /** Server-supplied detail for the tooltip; null when no update is pending. */
  get reason(): string | null {
    return this.#reason;
  }

  get toastVisible(): boolean {
    return this.#state === 'toast';
  }

  get pillVisible(): boolean {
    return this.#state === 'toast' || this.#state === 'pill' || this.#state === 'restarting';
  }

  /** The pill's word right now — a restart in flight renames it, not hides it. */
  get pillLabel(): string {
    return this.#state === 'restarting' ? PILL_LABEL_RESTARTING : PILL_LABEL;
  }

  /**
   * What a click on the pill means: while a restart runs it can only bring the
   * hidden dialog back (`reveal`) — asking the question a second time while the
   * answer to the first is on its way is not a thing the user can want.
   */
  get pillAction(): 'confirm' | 'reveal' {
    return this.#state === 'restarting' ? 'reveal' : 'confirm';
  }

  /**
   * Feed one `/api/runtime` answer. Ignored while a restart is in flight or
   * finished — those states own the screen, and a poll landing mid-restart
   * must not resurrect a toast over the progress text.
   */
  apply(update: UpdateStatus | null | undefined): NoticeState {
    if (this.#state === 'restarting' || this.#state === 'done') return this.#state;
    if (update === null || update === undefined || !update.available) {
      this.#reason = null;
      this.#state = 'hidden';
      return this.#state;
    }
    // A null reason still counts as an update; it is keyed as the empty
    // string so "no reason given" behaves like one stable reason rather than
    // re-toasting on every poll.
    const reason = update.reason ?? '';
    this.#reason = reason;
    this.#state = this.#dismissed === reason ? 'pill' : 'toast';
    return this.#state;
  }

  /** `Later` / `×` on the toast: the pill survives, this reason stops toasting. */
  dismissToast(): NoticeState {
    if (this.#state !== 'toast') return this.#state;
    this.#dismissed = this.#reason ?? '';
    this.#state = 'pill';
    return this.#state;
  }

  /** The restart POST is about to go out — the toast goes, the pill reports. */
  startRestart(): NoticeState {
    this.#state = 'restarting';
    return this.#state;
  }

  /**
   * The restart did not happen (cancelled, 409, 500, timeout): go back to the
   * surface the pending update deserves. A reason the user already dismissed
   * comes back as the pill only — cancelling a restart is not a new fact.
   */
  restartAborted(): NoticeState {
    if (this.#state !== 'restarting') return this.#state;
    if (this.#reason === null) this.#state = 'hidden';
    else this.#state = this.#dismissed === this.#reason ? 'pill' : 'toast';
    return this.#state;
  }

  /** The replacement backend is healthy and the page is reloading. Terminal. */
  finishRestart(): NoticeState {
    this.#state = 'done';
    this.#reason = null;
    return this.#state;
  }
}

// ---------------------------------------------------------------------------
// Readouts + confirmation copy
// ---------------------------------------------------------------------------

/**
 * The server's `reason` in the user's words. The raw string is diagnostic text
 * — a commit pair, "frontend", "server files" — and the UI copy rule keeps code
 * and file words out of the chrome. Every shape the backend produces
 * (server/buildinfo.ts) has a sentence here; anything it grows later falls back
 * to the generic one rather than leaking a hash into the toast.
 *
 * `null` means "say nothing extra": there is an update, the server just did not
 * say why, and the toast already says the rest.
 */
export const REASON_GENERIC = 'A newer version is on disk.';

/**
 * The one reason that is also an INSTRUCTION. New dependencies cannot be
 * installed by the app (it would be installing code into the user's project
 * folder behind their back), and the backend's preflight refuses the restart
 * until they are there — so the notice has to say what to do, not just what
 * happened, or the user meets the refusal with no idea why.
 */
export const REASON_DEPS =
  'Dependencies changed; install them in the project folder first, then restart.';

export function reasonSentence(reason: string | null | undefined): string | null {
  if (reason === null || reason === undefined || reason === '') return null;
  if (reason.startsWith('server code changed')) return 'The server code changed.';
  if (reason === 'frontend rebuilt') return "The app's screens were rebuilt.";
  if (reason === 'server files edited') return 'Server files were edited.';
  if (reason === 'frontend build missing') return "The app's screens have not been built yet.";
  if (reason === 'frontend source changed') return "The app's screens changed.";
  if (reason === 'dependencies changed') return REASON_DEPS;
  return REASON_GENERIC;
}

/**
 * The confirmation's footnote for a reason the user is about to walk into. Only
 * `dependencies changed` has one: pressing Restart with that reason pending
 * ends in a refusal, and saying so BEFORE the press is the difference between a
 * dialog that guides and one that scolds. Same slot and same amber note idiom
 * as CONTINUE_NOTE; null means the confirmation says nothing extra.
 */
export const DEPS_NOTE =
  'Dependencies changed. Until they are installed in the project folder, the app will refuse to restart.';

export function reasonNote(reason: string | null | undefined): string | null {
  return reason === 'dependencies changed' ? DEPS_NOTE : null;
}

/** The app's empty-value glyph — one place, so "unknown" always looks the same. */
export const EMPTY = '—';

/**
 * How long the backend has been up, in the settings panel's words:
 * `just started` (< 1 min) · `41 min` · `3 h 41 min` · `2 d 3 h`. Deliberately
 * NOT the statusline's `HH:MM:SS` — this line is read once, not watched.
 * Unparsable/absent input yields the empty glyph rather than a fabricated age.
 */
export function fmtRunningFor(iso: string | null, now: number = Date.now()): string {
  if (iso === null) return EMPTY;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return EMPTY;
  const min = Math.floor(Math.max(0, now - t) / 60000);
  if (min < 1) return 'just started';
  if (min < 60) return `${min} min`;
  const hours = Math.floor(min / 60);
  if (hours < 24) {
    const rest = min % 60;
    return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
  }
  const days = Math.floor(hours / 24);
  const restH = hours % 24;
  return restH === 0 ? `${days} d` : `${days} d ${restH} h`;
}

/** One row of the confirmation's session list: what it is, where it runs. */
export interface ConfirmRow {
  name: string;
  /** Project NAME (never a path); null when the session has no project. */
  project: string | null;
}

export interface ConfirmSummary {
  /** Running sessions, total. */
  count: number;
  /** At most CONFIRM_LIST_MAX rows. */
  rows: ConfirmRow[];
  /** Rows the list did not show. */
  more: number;
  /** True when any running session was started with "Continue last conversation". */
  continued: boolean;
}

/**
 * Everything the confirmation needs about what is about to be closed. Only
 * RUNNING sessions count: an exited one is already in History and loses
 * nothing. `name` and `project` come from the caller (titles are user text and
 * project names live in state), so this stays free of the store.
 */
export function summarizeRunning(
  sessions: Iterable<SessionInfo>,
  nameOf: (s: SessionInfo) => string,
  projectOf: (s: SessionInfo) => string | null,
): ConfirmSummary {
  const running = [...sessions].filter((s) => s.status === 'running');
  return {
    count: running.length,
    rows: running.slice(0, CONFIRM_LIST_MAX).map((s) => ({ name: nameOf(s), project: projectOf(s) })),
    more: Math.max(0, running.length - CONFIRM_LIST_MAX),
    // Claude sessions only: the note talks about Claude conversations, and a
    // custom `ssh -c …` session carries a `-c` that means something else.
    continued: running.some((s) => isClaudeCommand(s.command) && hasContinueFlag(s.args)),
  };
}

/**
 * The confirmation's body sentence. Three shapes, because "1 sessions are"
 * is the kind of detail that makes a warning feel machine-written — and this
 * is the sentence that has to be believed.
 *
 * The promise it makes is one the app already keeps: history.json survives a
 * restart, and every ended session gets its resume entry.
 */
export function confirmBody(count: number): string {
  if (count === 0) return 'Nothing is running. The app reconnects by itself.';
  if (count === 1) {
    return 'One session is running and will be closed. It stays in History, so you can pick its conversation up again.';
  }
  return `${count} sessions are running and will be closed. They stay in History, so you can pick each conversation up again.`;
}

/**
 * The honest footnote for sessions started with "Continue last conversation":
 * those were never pinned to a conversation id (PROJECT-SCOPE known limit), so
 * resuming them lands on their project's most recent conversation — which may
 * by then be a different one. Rendered ONLY when such a session is running.
 */
export const CONTINUE_NOTE =
  'Sessions started with "Continue last conversation" come back to the latest conversation of their project, not necessarily this one.';

/** `+ 3 more` under the list; empty string when nothing was left out. */
export function moreLabel(more: number): string {
  return more > 0 ? `+ ${more} more` : '';
}
