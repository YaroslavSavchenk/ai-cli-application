/**
 * What the backend can actually run (NOCTURNE B5) and which cards the user
 * hid (B6 D1), for the New session dialog: the GET /api/tools and
 * GET /api/keys answers, the inert `Not installed` cards they make, the hidden
 * tools, and the ONE key notice.
 *
 * Split from `ui/launch.ts` (Quality part Q13, `.claude/plans/PLAN-QUALITY.md`),
 * code moved as it stood: these were closure-local to `initLaunchDialog()`,
 * which now hands in the few things they touch (`ToolsCtx`) and keeps the
 * state they read — the selected kind and shell — as its own. Siblings:
 * `launch.ts` (the dialog), `launch-controls.ts` (the cards).
 */
import type { KeyStatus, ToolAvailability } from '../../../shared/protocol.ts';
import * as api from '../api.ts';
import { getHiddenTools } from './prefs-model.ts';
import { NOT_INSTALLED, SHELL_CARDS, TOOL_CARDS } from './launch-args.ts';
import type { LaunchKind, ShellId } from './launch-args.ts';
import { ASSUMED, keyToolFor, type CardGroup } from './launch-controls.ts';

/** What the availability code touches of the dialog — nothing else. */
interface ToolsCtx {
  toolCards: CardGroup<LaunchKind>;
  shellCards: CardGroup<ShellId>;
  /** The key notice row. */
  notice: HTMLElement;
  /** The selected kind, read live. */
  kind(): LaunchKind;
  /** The selected shell, read live. */
  shell(): ShellId;
  /** Move the shell selection (a selected shell that just went inert). */
  setShell(id: ShellId): void;
  setKind(next: LaunchKind, byUser: boolean): void;
}

interface ToolsPart {
  applyAvailability(): void;
  applyHiddenTools(): void;
  shownKind(want: LaunchKind): LaunchKind;
  syncNotice(): void;
  refreshTools(): void;
}

export function createToolAvailability(ctx: ToolsCtx): ToolsPart {
  const { toolCards, shellCards, notice, setKind } = ctx;

  // `ASSUMED` — what the dialog assumes before the backend has answered — is
  // in `launch-controls.ts` since O8.

  /** The last answer from GET /api/tools; a pending fetch keeps this one. */
  let avail: ToolAvailability = ASSUMED;
  /**
   * False until GET /api/tools has answered ONCE on this page. While it is
   * false the assumed-absent cards are inert with NO sub-line: unselectable,
   * but claiming nothing — `Not installed` is a statement only the backend
   * gets to make.
   */
  let answered = false;
  /** The last answer from GET /api/keys; null = not asked yet / unreadable. */
  let keyStatus: KeyStatus | null = null;

  /**
   * What the backend said about ONE card id, or undefined for a card it says
   * nothing about — Terminal, Other and the Bash card, none of which can be
   * missing (this backend runs in a WSL shell, and a typed command is the
   * user's own claim about what exists).
   */
  function installed(id: string): boolean | undefined {
    return Object.hasOwn(avail, id) ? avail[id as keyof ToolAvailability] : undefined;
  }

  /**
   * Availability -> the cards. An absent executable makes its card INERT with
   * the sub-line `Not installed`; Terminal, Other and the Bash card are never
   * inert (this backend IS a shell in WSL, and a typed command is the user's
   * own claim). A selection that just went inert falls back to the first live
   * card rather than sitting on something that cannot launch.
   */
  function applyAvailability(): void {
    const hint = answered ? NOT_INSTALLED : '';
    const toolHints = new Map<LaunchKind, string>();
    for (const t of TOOL_CARDS) {
      if (installed(t.id) === false) toolHints.set(t.kind, hint);
    }
    toolCards.setInert(toolHints);
    const shellHints = new Map<ShellId, string>();
    for (const c of SHELL_CARDS) {
      if (installed(c.id) === false) shellHints.set(c.shell, hint);
    }
    shellCards.setInert(shellHints);
    if (shellHints.has(ctx.shell())) {
      const firstShell = shellCards.live()[0];
      if (firstShell !== undefined) {
        ctx.setShell(firstShell);
        shellCards.select(firstShell);
      }
    }
    if (toolHints.has(ctx.kind())) {
      const firstKind = toolCards.live()[0];
      if (firstKind !== undefined) setKind(firstKind, false);
      else syncNotice();
    } else {
      toolCards.select(ctx.kind());
      syncNotice();
    }
  }

  /**
   * The grid the user asked for (B6 D1): `TOOL_CARDS` minus the ids hidden in
   * Settings, read FRESH here so a card toggled while the dialog was closed is
   * gone (or back) on the next open, with no reload. Hiding is a wish about
   * what this dialog OFFERS and nothing else: a hidden tool is still installed,
   * still running its sessions, and `GET /api/tools` never hears about it.
   */
  function applyHiddenTools(): void {
    const ids = new Set(getHiddenTools());
    const kinds = new Set<LaunchKind>(
      TOOL_CARDS.filter((t) => ids.has(t.id)).map((t) => t.kind as LaunchKind),
    );
    toolCards.setHidden(kinds);
  }

  /**
   * The kind to pre-select: the wanted one, or — when it is not in the grid
   * anymore — the FIRST card that is. Availability is a different question and
   * keeps its own fallback (`applyAvailability`): this one is only about cards
   * the user took away.
   */
  function shownKind(want: LaunchKind): LaunchKind {
    const shown = toolCards.shown();
    return shown.includes(want) ? want : (shown[0] ?? want);
  }

  /**
   * The ONE notice in the dialog: shown for a tool that reads an API key from
   * its environment and has neither a saved one nor one already set outside the
   * app. While the answer is unknown nothing is claimed — an unprompted "needs
   * a key" over a machine that has one would be wrong half the time.
   */
  function syncNotice(): void {
    const tool = keyToolFor(ctx.kind());
    const unanswered = keyStatus === null;
    const has = tool !== null && keyStatus !== null && (keyStatus.saved[tool] || keyStatus.env[tool]);
    notice.hidden = tool === null || unanswered || has;
  }

  /** Ask the backend what it can run and which keys exist. Never throws. */
  function refreshTools(): void {
    void api
      .getTools()
      .then((t) => {
        avail = t;
        answered = true;
        applyAvailability();
      })
      .catch(() => {
        // Keep the last known answer: a momentary failure must not turn every
        // card the user just used into `Not installed`.
      });
    void api
      .getKeys()
      .then((s) => {
        keyStatus = s;
        syncNotice();
      })
      .catch(() => {
        // Unknown stays unknown, and an unknown makes no claim.
      });
  }

  return { applyAvailability, applyHiddenTools, shownKind, syncNotice, refreshTools };
}
