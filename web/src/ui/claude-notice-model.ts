/**
 * The Claude Code compatibility notice, its Settings fact and the pane's
 * early-exit banner — the rules and every sentence (Nocturne D6,
 * `.claude/plans/nocturne/PLAN-D6.md` § What the user gets, § Defaults). The
 * DOM halves: `./claude-notice.ts` (the notice), `./settings-service.ts` (the
 * fact, through `runtimeFacts()`), `./panes-status.ts` (the banner).
 *
 * Pure: no DOM, no state, no I/O. Every rule reads the server's verdict
 * (`ClaudeStatus.compat`, computed by shared/claude-compat.ts on the server)
 * and never re-derives it from the version text.
 */
import type { ClaudeStatus } from '../../../shared/protocol-runtime.ts';
import type { EarlyExit } from '../../../shared/protocol.ts';

/** The two verdicts that earn a notice. */
type ClaudeNoticeKind = 'older' | 'newer';

/** What the notice says, or why there is none (null from `claudeNotice`). */
interface ClaudeNoticeCopy {
  kind: ClaudeNoticeKind;
  /** The version the notice is about — what Hide writes to the pref. */
  version: string;
  title: string;
  body: string;
}

const TITLE_OLDER = 'Claude Code is too old';
const TITLE_NEWER = 'Claude Code is newer than tested';

/** The notice's quiet second control (the update toast's `Later` slot). */
export const NOTICE_HIDE = 'Hide';

/** The pane banner's lead on an early exit (D6 phase 3). */
export const EARLY_EXIT_LEAD = 'Claude Code stopped right after it started';

/**
 * The notice for this runtime and this hidden version, or null. It shows while
 * the verdict is `older` or `newer` and the version is not the one the user
 * hid (decision 19: hiding holds until a DIFFERENT version is seen). `unknown`
 * and `missing` never show one: there is nothing to compare, and the Settings
 * fact already says what is known.
 */
export function claudeNotice(claude: ClaudeStatus | null, hidden: string | undefined): ClaudeNoticeCopy | null {
  if (claude === null || claude.version === null) return null;
  if (claude.compat !== 'older' && claude.compat !== 'newer') return null;
  const v = claude.version;
  if (v === hidden) return null;
  if (claude.compat === 'older') {
    return {
      kind: 'older',
      version: v,
      title: TITLE_OLDER,
      body: `Claude Code ${v} is older than this app needs (${claude.min}). Update Claude Code.`,
    };
  }
  return {
    kind: 'newer',
    version: v,
    title: TITLE_NEWER,
    body: `This app was tested up to Claude Code ${claude.testedUpTo}. You have ${v}. If launches fail, check for an app update.`,
  };
}

/**
 * Whether an early exit must drop `claudeNoticeHidden`: a dead launch is new
 * evidence, so the notice comes back — unless the server says the version is
 * fine (then the launch died for another reason and the notice has nothing to
 * say). False when nothing is hidden, so no write goes out for nothing.
 */
export function clearsHiddenOnEarlyExit(claude: ClaudeStatus | null, hidden: string | undefined): boolean {
  return hidden !== undefined && claude?.compat !== 'ok';
}

/**
 * Whether an early exit is new evidence: the session was created after this
 * page loaded (both epoch ms). Every attach replays the exit of a session that
 * died before — after a reload or a reconnect — and that is no news. NaN (no
 * readable `createdAt`) is never new.
 */
export function earlyExitIsNew(createdAtMs: number, pageLoadedAtMs: number): boolean {
  return createdAtMs > pageLoadedAtMs;
}

/**
 * The Background service fact, or null for no fact at all. Null before the
 * runtime is read AND for `unknown` with no text: the wire cannot tell "the
 * probe has not answered yet" from "it timed out or printed nothing", so a
 * `checking…` there could stand forever after a timeout — saying nothing is
 * the one honest answer for both.
 */
export function claudeFact(claude: ClaudeStatus | null): string | null {
  if (claude === null) return null;
  if (claude.compat === 'missing') return 'Claude Code not found';
  if (claude.version === null) return null;
  if (claude.compat === 'unknown') return `Claude Code: ${claude.version}`;
  return `Claude Code ${claude.version} (tested up to ${claude.testedUpTo})`;
}

/**
 * The exited banner's two parts: the lead sentence and Claude Code's own line
 * (null when there is none to show). Without `early` the lead is the banner
 * every exit has always had, `Finished, code N`, unchanged.
 */
export function exitNote(exitCode: number, early: EarlyExit | null | undefined): { lead: string; line: string | null } {
  if (early === null || early === undefined) return { lead: `Finished, code ${exitCode}`, line: null };
  return early.line === ''
    ? { lead: EARLY_EXIT_LEAD, line: null }
    : { lead: `${EARLY_EXIT_LEAD}:`, line: early.line };
}
