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
import {
  UPDATE_NEW_VERSION_AVAILABLE,
  type SessionInfo,
  type UpdateRelease,
  type UpdateStatus,
} from '../../../shared/protocol.ts';
import { hasContinueFlag, isClaudeCommand } from './launch-args.ts';

/**
 * - `hidden`     nothing to say (no update, or a restart finished the story)
 * - `toast`      toast AND pill visible — the arrival state of a new reason
 * - `pill`       toast dismissed for this reason; the pill stays
 * - `updating`   the in-app update is downloading/installing (phase E); like
 *                `restarting` it owns the screen, but nothing has been torn
 *                down yet — every session is alive behind the dialog
 * - `restarting` a restart is in flight; the toast steps aside and the pill
 *                says so (it is the only thing on screen while the dialog is
 *                hidden, and clicking it brings the dialog back)
 * - `done`       the restart succeeded and the page is being replaced
 */
export type NoticeState = 'hidden' | 'toast' | 'pill' | 'updating' | 'restarting' | 'done';

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
/**
 * …and while the in-app update runs (phase E). Its own word, not `restarting…`:
 * during this half nothing has been ended yet — the download and the Windows
 * installer are still working while every session keeps running behind the
 * dialog — and the pill is what a user who hid that dialog reads.
 */
export const PILL_LABEL_UPDATING = 'updating…';
/** Tooltip for that state; the pending-update tooltip lives in `update.ts`. */
export const PILL_TIP_RESTARTING = 'A restart is running — show it';
export const PILL_TIP_UPDATING = 'An update is running — show it';

export class UpdateNotice {
  #state: NoticeState = 'hidden';
  /** The reason currently being reported, or null when nothing is available. */
  #reason: string | null = null;
  /**
   * The dismissal KEY of the offer on the table: the reason AND the version it
   * names. The reason alone is not enough — 'a new version is available' is the
   * same sentence for v0.3.0 and v0.4.0, so keying on it made one `Later`
   * silence every release that follows.
   */
  #key: string | null = null;
  /** The key whose toast the user waved away. Never cleared by a poll. */
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
    return (
      this.#state === 'toast' ||
      this.#state === 'pill' ||
      this.#state === 'updating' ||
      this.#state === 'restarting'
    );
  }

  /** The pill's word right now — a flow in flight renames it, not hides it. */
  get pillLabel(): string {
    if (this.#state === 'updating') return PILL_LABEL_UPDATING;
    return this.#state === 'restarting' ? PILL_LABEL_RESTARTING : PILL_LABEL;
  }

  /**
   * What a click on the pill means: while an update or a restart runs it can
   * only bring the hidden dialog back (`reveal`) — asking the question a second
   * time while the answer to the first is on its way is not a thing the user
   * can want.
   */
  get pillAction(): 'confirm' | 'reveal' {
    return this.#state === 'updating' || this.#state === 'restarting' ? 'reveal' : 'confirm';
  }

  /**
   * Feed one `/api/runtime` answer. Ignored while a restart is in flight or
   * finished — those states own the screen, and a poll landing mid-restart
   * must not resurrect a toast over the progress text.
   */
  apply(update: UpdateStatus | null | undefined): NoticeState {
    if (this.#state === 'updating' || this.#state === 'restarting' || this.#state === 'done') {
      return this.#state;
    }
    if (update === null || update === undefined || !update.available) {
      this.#reason = null;
      this.#key = null;
      this.#state = 'hidden';
      return this.#state;
    }
    // A null reason still counts as an update; it is keyed as the empty
    // string so "no reason given" behaves like one stable reason rather than
    // re-toasting on every poll. The offered version is part of the key: a new
    // release must be able to speak up even after `Later` on the previous one.
    const reason = update.reason ?? '';
    this.#reason = reason;
    this.#key = `${reason}@${update.release?.version ?? ''}`;
    this.#state = this.#dismissed === this.#key ? 'pill' : 'toast';
    return this.#state;
  }

  /** `Later` / `×` on the toast: the pill survives, this reason stops toasting. */
  dismissToast(): NoticeState {
    if (this.#state !== 'toast') return this.#state;
    this.#dismissed = this.#key ?? '';
    this.#state = 'pill';
    return this.#state;
  }

  /** The restart POST is about to go out — the toast goes, the pill reports. */
  startRestart(): NoticeState {
    this.#state = 'restarting';
    return this.#state;
  }

  /**
   * The update POST is about to go out (phase E). Same shape as `startRestart`
   * and a different word on the pill: this half downloads and installs while
   * the app keeps running, and the restart only begins once it succeeded.
   */
  startUpdate(): NoticeState {
    this.#state = 'updating';
    return this.#state;
  }

  /**
   * The restart did not happen (cancelled, 409, 500, timeout): go back to the
   * surface the pending update deserves. A reason the user already dismissed
   * comes back as the pill only — cancelling a restart is not a new fact.
   */
  restartAborted(): NoticeState {
    if (this.#state !== 'restarting') return this.#state;
    return this.#backToPending();
  }

  /**
   * The update half ended without installing anything (refused, failed, a
   * network gap). Exactly the same fact as an aborted restart — nothing
   * happened, the pending update is still pending — so it restores the same
   * surface; it is a separate verb only because the two halves are separate
   * states and each may only leave its own.
   */
  updateAborted(): NoticeState {
    if (this.#state !== 'updating') return this.#state;
    return this.#backToPending();
  }

  /** The one rule both aborts share: back to the surface the reason deserves. */
  #backToPending(): NoticeState {
    if (this.#reason === null) this.#state = 'hidden';
    else this.#state = this.#dismissed === this.#key ? 'pill' : 'toast';
    return this.#state;
  }

  /** The replacement backend is healthy and the page is reloading. Terminal. */
  finishRestart(): NoticeState {
    this.#state = 'done';
    this.#reason = null;
    this.#key = null;
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

/**
 * INSTALLED MODE (2026-09-08). A packaged app produces exactly ONE reason — a
 * newer version directory sits beside the running one, put there by the
 * installer the user just ran. Nothing is "on disk newer than the process" in
 * the developer sense, and there is nothing for the user to do first: the work
 * already happened, only the restart is left.
 */
export const REASON_INSTALLED = 'A new version has been installed.';

/**
 * ONLINE (2026-09-09, phase E). An installed app that asked GitHub found a
 * published release newer than the bundle it runs from. Nothing is on this
 * machine yet — that is the whole difference from REASON_INSTALLED, and it is
 * why the button beside it downloads instead of restarting. Used verbatim when
 * the release's version fails the shape gate below.
 */
export const REASON_AVAILABLE = 'A newer version is available.';

export function reasonSentence(reason: string | null | undefined): string | null {
  if (reason === null || reason === undefined || reason === '') return null;
  if (reason === 'a new version is installed') return REASON_INSTALLED;
  if (reason === UPDATE_NEW_VERSION_AVAILABLE) return REASON_AVAILABLE;
  if (reason.startsWith('server code changed')) return 'The server code changed.';
  if (reason === 'frontend rebuilt') return "The app's screens were rebuilt.";
  if (reason === 'server files edited') return 'Server files were edited.';
  if (reason === 'frontend build missing') return "The app's screens have not been built yet.";
  if (reason === 'frontend source changed') return "The app's screens changed.";
  if (reason === 'dependencies changed') return REASON_DEPS;
  return REASON_GENERIC;
}

/**
 * THE VERSION GATE. `release.version` is the only string in this whole feature
 * that comes from OUTSIDE the app — a tag read out of a GitHub release — and
 * `releaseSentence()` puts it in front of a human. The backend gates it too
 * (VERSION_SHAPE), but the sentence is written here, so the gate is repeated
 * here: a tag is a short version-ish word and nothing else. Anything with a
 * space, a quote, an angle bracket, a newline, a semicolon, or more than 64
 * characters is not printed at all — the generic sentence is, which says the
 * same true thing without quoting a stranger.
 *
 * (Nothing on this path can execute a string; this is about what the user is
 * asked to trust with their eyes, and about a toast that cannot be turned into
 * a billboard by whoever can publish a release.)
 */
export const VERSION_SHAPE = /^v?[0-9][A-Za-z0-9._+-]{0,63}$/;

/** True when the tag may be shown as-is. */
export function showableVersion(version: string | null | undefined): boolean {
  return typeof version === 'string' && VERSION_SHAPE.test(version);
}

/**
 * The toast's body in the ONLINE state: `Version v0.3.0 is available.` — the
 * one fact that makes the button worth pressing. A version that fails the gate
 * degrades to the generic sentence rather than to no sentence: the update is
 * real either way.
 *
 * Never mentions the size, the file, or the address it would be downloaded
 * from (copy rule): a user decides on "is there a newer app", not on bytes.
 */
export function releaseSentence(release: UpdateRelease | null | undefined): string {
  const v = release?.version;
  return showableVersion(v) ? `Version ${v as string} is available.` : REASON_AVAILABLE;
}

/**
 * The update confirmation's first line — what pressing the button does, before
 * the sentence about the sessions it costs. Same version gate as above.
 */
export function updateLead(release: UpdateRelease | null | undefined): string {
  const v = release?.version;
  return showableVersion(v)
    ? `Version ${v as string} will be downloaded and installed.`
    : 'The newer version will be downloaded and installed.';
}

/**
 * Which VERB the notice offers for the reason at hand. `update` = the release
 * lives online and this app can fetch it (phase E); `restart` = the newer
 * version is already on this machine and only the running process is old.
 * Precedence between the two reasons is the backend's job; the UI renders
 * whichever one arrives.
 */
export function noticeVerb(reason: string | null | undefined): 'update' | 'restart' {
  return reason === UPDATE_NEW_VERSION_AVAILABLE ? 'update' : 'restart';
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
 * The settings panel's `version` fact: WHICH APP IS RUNNING, in one slot.
 *
 * Two honest forms, because there are two ways this app is installed
 * (2026-09-08). An INSTALLED backend runs from a versioned bundle and knows its
 * version (`v0.2.0`) — that is what its user has, what the releases page lists,
 * and the only identity that means anything to them. A developer clone has no
 * version at all: its identity is the commit it was started from, which is what
 * this line has always shown.
 *
 * So: version, else commit, else the empty glyph. Never both (one fact, one
 * slot), and never a fabricated stand-in for a backend that answered neither.
 * Kept here rather than in the DOM half so the chain is testable without a
 * browser — `update.ts`'s `runtimeFacts()` is the only caller.
 */
export function versionFact(version: string | null, commit: string | null): string {
  return version ?? commit ?? EMPTY;
}

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
