/**
 * Launch dialog — the modal that creates sessions (settled user decision
 * 2026-07-20, replacing the launcher-as-tab).
 *
 * REDUCED 2026-09-06 (user's call): the dialog is a short form, not a
 * briefing. No preset chips, no readable launch summary, no header subtitle,
 * no footer note, no tooltip that explains mechanics.
 *
 * KIND SWITCH 2026-09-08 (user's request — "alles moet mogelijk"): the app is
 * not claude-only; what the session IS decides the rest of the form.
 *
 * NOCTURNE A4 2026-09-10 — the v3 layout, the same launches behind it:
 *
 *   Tool         2 x 3 card grid: Claude Code, Codex, Gemini CLI, Grok,
 *                Terminal, Other.
 *   Name (optional)   Project      (Name's placeholder IS the selected
 *                                   project's name — blank = titled that)
 *   An agent:    Model   Effort
 *                Permissions (i)   2 x 2 cards; the (i) button opens the ONE
 *                                  sanctioned explanation in this dialog
 *                Start from        per tool (Claude Code also lists this
 *                                  project's own ended conversations)
 *   Terminal:    Shell             Bash, Zsh, PowerShell, Command Prompt
 *   Other:       Command           the custom-command escape hatch
 *
 * The agent-only controls are HIDDEN and DISABLED for Terminal and Other (not
 * dimmed — four dead controls carry no information), and the same idiom applies
 * per tool: Gemini CLI has no effort levels, so that control leaves the form
 * for it. No command preview: the 2026-07-25 "no commands or flags in the UI"
 * rule stands (user, 2026-09-10).
 *
 * NOCTURNE B5 2026-09-18 — the other three agents and two more shells go live.
 * What a card can do is no longer a hole in a table: the dialog asks the
 * backend which executables it can find (`GET /api/tools`) and an absent one
 * becomes an INERT card with the sub-line `Not installed` — the A4 idiom,
 * runtime-sourced. Gemini CLI and Grok read an API key from their environment,
 * so a tool with neither a saved key nor one in the backend's environment shows
 * ONE quiet notice row with a button into Settings. Every per-tool vocabulary
 * (models, efforts, permission availability, start-from options) lives in
 * launch-args.ts; this file only ever renders ids and labels.
 *
 * `composeSpawn()` in launch-args.ts is the ONE composition path for all three
 * kinds and `currentSpawn()` its ONE caller, so the POST body has no second
 * rendering to keep in sync. The Command field's content IS a command the user
 * types — the one spot exempt from the plain-language copy rule.
 *
 * Entry points (all funnel here): top bar `New session`, tab-strip `+`,
 * projects-drawer per-row `+` (pre-set to that project), the empty-state
 * button, and Ctrl+Alt+T. The new session opens in its own new tab and becomes
 * active. While closed, the dialog touches no keyboard input — the terminal
 * owns the keys.
 */
import type { HistoryEntry, KeyStatus, ToolAvailability } from '../../../shared/protocol.ts';
import * as api from '../api.ts';
import * as st from '../state.ts';
import { log } from '../log.ts';
import { el, button, trapTab, fmtAgo } from './util.ts';
import { infoIcon } from './icons.ts';
import { toolIcon } from './icons-tools.ts';
import { focusedPaneDims, requestTerminalFocus } from './panes.ts';
import { openSettings } from './settings.ts';
import { getHiddenTools } from './prefs-model.ts';
import {
  AGENT_KINDS,
  PERMS,
  PERM_SHORT,
  PERM_HELP,
  NOT_INSTALLED,
  SHELLS,
  SHELL_CARDS,
  TOOLS,
  TOOL_CARDS,
  composeSpawn,
  continueFromStart,
  isAgentKind,
  isEffort,
  isStartFrom,
  shellLabel,
  resolveModel,
  resolvePerm,
} from './launch-args.ts';
import type { AgentKind, Effort, LaunchKind, Perm, ShellId, SpawnSpec } from './launch-args.ts';
// The card radiogroup and the dialog's small tables: `launch-controls.ts` (O8).
import { ASSUMED, fillChoices, groupLabel, keyToolFor, radioCards } from './launch-controls.ts';

export interface LaunchOpts {
  /** Pre-select this project (projects-drawer per-row `+`). */
  projectId?: string;
}

interface LaunchCtl {
  open(opts?: LaunchOpts): void;
  close(): void;
  isOpen(): boolean;
}

let ctl: LaunchCtl | null = null;

/**
 * The user's home folder, as the server reports it. Asked at most once per
 * page and only when it is actually needed: a Terminal session launched while
 * no project exists yet has to start SOMEWHERE, and that somewhere is home.
 * The path itself never reaches the screen (projects show names, not paths).
 */
let homeFolder: string | null = null;
async function homeCwd(): Promise<string> {
  if (homeFolder === null) homeFolder = (await api.fsList()).path;
  return homeFolder;
}

export function openLaunchDialog(opts?: LaunchOpts): void {
  ctl?.open(opts);
}

export function closeLaunchDialog(): void {
  ctl?.close();
}

export function isLaunchDialogOpen(): boolean {
  return ctl?.isOpen() ?? false;
}

export function initLaunchDialog(modalHost: HTMLElement): void {
  // ---- scrim + card --------------------------------------------------------
  // `modal-scrim` stays on the scrim: ui/keys.ts recognises an open dialog by
  // it. Everything visual is the `ns-` block in app.css.
  const scrim = el('div', 'modal-scrim ns-scrim');
  scrim.hidden = true;
  const modal = el('div', 'ns-modal');
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-labelledby', 'ns-title');

  // ---- header: title and close, nothing else --------------------------------
  const hd = el('header', 'ns-hd');
  const title = el('h2', 'ns-title', 'New session');
  title.id = 'ns-title';
  const closeBtn = button('ns-x', '×', () => close());
  closeBtn.setAttribute('aria-label', 'Close');
  hd.append(title, closeBtn);

  // ---- body ----------------------------------------------------------------
  const body = el('div', 'ns-body');

  // Tool: the ONE choice that changes what the rest of the form means.
  let kind: LaunchKind = 'claude';
  const toolGroup = el('div', 'ns-group');
  const toolCards = radioCards<LaunchKind>(
    'ns-grid ns-tools',
    'ns-tool-lb',
    TOOL_CARDS.map((t) => {
      const mark = el('span', t.kind === 'claude' ? 'ns-mark is-agent' : 'ns-mark');
      mark.append(toolIcon(t.icon, 14));
      mark.setAttribute('aria-hidden', 'true');
      return { value: t.kind as LaunchKind, mark, label: t.label, sub: t.sub };
    }),
    (k) => setKind(k, true),
  );
  toolGroup.append(groupLabel('ns-tool-lb', 'Tool'), toolCards.row);

  // The key notice: ONE quiet line about the selected tool, and one small
  // button that hands the user to the field that fixes it. Shown only for a
  // tool that reads a key from its environment and has neither a saved one nor
  // one already there — never for Claude Code (it signs in) or Codex (a key
  // alone does not authenticate it; its Settings row says so).
  const notice = el('div', 'ns-notice');
  notice.hidden = true;
  const noticeTxt = el('span', '', 'Needs an API key, or sign in inside the terminal the first time.');
  const noticeBtn = button('ns-noticebtn', 'Add key', () => {
    const tool = keyToolFor(kind);
    close();
    if (tool !== null) openSettings({ page: 'prefs', focusKey: tool });
  });
  notice.append(noticeTxt, noticeBtn);

  // Name + Project, shared by every kind.
  const nameProj = el('div', 'ns-row2');
  const nameField = el('label', 'ns-field');
  const nameLb = el('span', 'ns-lb', 'Name ');
  nameLb.append(el('span', 'ns-opt', '(optional)'));
  const nameInput = el('input');
  nameInput.name = 'title';
  nameInput.spellcheck = false;
  nameField.append(nameLb, nameInput);

  const projField = el('label', 'ns-field');
  const projectSel = el('select');
  projectSel.name = 'project';
  projField.append(el('span', 'ns-lb', 'Project'), projectSel);
  nameProj.append(nameField, projField);

  // ---- the agents (Claude Code, Codex, Gemini CLI, Grok) --------------------
  // ONE control set, repopulated per tool from the launch-args tables: four
  // parallel forms would be four places for the same mistake.
  const claudeBox = el('div', 'ns-kindbox');

  const modelEffort = el('div', 'ns-row2');
  const modelField = el('label', 'ns-field');
  const modelSel = el('select');
  modelSel.name = 'model';
  modelField.append(el('span', 'ns-lb', 'Model'), modelSel);

  const effortField = el('label', 'ns-field');
  const effortSel = el('select');
  effortSel.name = 'effort';
  effortField.append(el('span', 'ns-lb', 'Effort'), effortSel);
  modelEffort.append(modelField, effortField);

  /**
   * What each agent was last set to. The dialog has ONE Model/Effort/Start from
   * set pointed at whichever tool is chosen, so switching tools and back must
   * not silently hand Codex the level the user picked for Grok — and coming
   * back to a tool must show what was chosen for it.
   *
   * Effort and Start from are reset for every agent on every open (a reopened
   * dialog never silently continues); the model is not, except Claude Code's,
   * which the selected project's own default resolves per open.
   */
  const chosen: Record<AgentKind, { model: string; effort: string; start: string }> = {
    claude: { model: TOOLS.claude.models[0]?.id ?? '', effort: TOOLS.claude.effortNone, start: 'fresh' },
    codex: { model: TOOLS.codex.modelNone, effort: TOOLS.codex.effortNone, start: 'fresh' },
    gemini: { model: TOOLS.gemini.modelNone, effort: TOOLS.gemini.effortNone, start: 'fresh' },
    grok: { model: TOOLS.grok.modelNone, effort: TOOLS.grok.effortNone, start: 'fresh' },
  };


  // Permissions: labels only on the cards (the 2026-09-06 cut stands). The
  // words are PERM_SHORT — the same table the pane status bar's Mode reads.
  let perm: Perm = 'default';
  let helpOpen = false;
  const permGroup = el('div', 'ns-group ns-perm');
  const permLbRow = el('div', 'ns-lbrow');

  // The ONE explanation in the dialog (user decision 2026-09-10): a disclosure
  // button beside the group label, one popover for all four modes. Esc while
  // it is open closes ONLY it (see the capture listener below).
  const infoBtn = button('ns-info', '', () => setHelp(!helpOpen, false));
  infoBtn.setAttribute('aria-label', 'What these mean');
  infoBtn.setAttribute('aria-expanded', 'false');
  infoBtn.setAttribute('aria-controls', 'ns-perm-help');
  infoBtn.append(infoIcon());
  permLbRow.append(groupLabel('ns-perm-lb', 'Permissions'), infoBtn);

  const help = el('div', 'ns-help');
  help.id = 'ns-perm-help';
  help.hidden = true;
  const helpList = el('dl', 'ns-help-list');
  for (const p of PERMS) {
    helpList.append(
      el('dt', p.danger ? 'is-danger' : '', PERM_SHORT[p.mode]),
      el('dd', '', PERM_HELP[p.mode]),
    );
  }
  help.append(helpList);

  const permCards = radioCards<Perm>(
    'ns-grid ns-perms',
    'ns-perm-lb',
    PERMS.map((p) => ({
      value: p.mode,
      cls: p.danger ? 'is-danger' : '',
      label: PERM_SHORT[p.mode],
    })),
    (mode) => setPerm(mode),
  );
  permGroup.append(permLbRow, help, permCards.row);

  function setPerm(mode: Perm): void {
    perm = mode;
    permCards.select(mode);
  }
  setPerm('default');

  // Start from: per tool. Claude Code's `continue` is exactly the old
  // "Continue last conversation" checkbox (`--continue`), and its list grows
  // one option per ended conversation of the selected project (B5).
  const startField = el('label', 'ns-field');
  const startSel = el('select');
  startSel.name = 'start';
  startField.append(el('span', 'ns-lb', 'Start from'), startSel);

  claudeBox.append(modelEffort, permGroup, startField);

  // ---- Terminal only -------------------------------------------------------
  let shell: ShellId = SHELLS[0].id;
  const shellGroup = el('div', 'ns-group');
  shellGroup.hidden = true;
  const shellCards = radioCards<ShellId>(
    'ns-grid ns-shells',
    'ns-shell-lb',
    SHELL_CARDS.map((c) => ({ value: c.shell as ShellId, label: c.label, sub: c.sub })),
    (id) => {
      shell = id;
      shellCards.select(id);
    },
  );
  shellGroup.append(groupLabel('ns-shell-lb', 'Shell'), shellCards.row);

  // ---- Other only: the escape hatch, mono, whitespace-split argv -------------
  const cmdField = el('label', 'ns-field ns-cmd');
  cmdField.hidden = true;
  const cmdInput = el('input');
  cmdInput.name = 'command';
  cmdInput.placeholder = 'htop';
  cmdInput.spellcheck = false;
  cmdField.append(el('span', 'ns-lb', 'Command'), cmdInput);

  const err = el('div', 'ns-err');
  err.setAttribute('role', 'alert');
  err.hidden = true;

  const none = el('div', 'ns-none');
  none.hidden = true;
  const noneTxt = el('span', '', '');
  const noneAdd = button('ns-link', 'Add a project', () => {
    close();
    st.openDrawer('projects');
  });
  none.append(noneTxt, noneAdd);

  body.append(toolGroup, notice, nameProj, claudeBox, shellGroup, cmdField, err, none);

  // ---- footer --------------------------------------------------------------
  const ft = el('footer', 'ns-ft');
  const cancel = button('btn-quiet', 'Cancel', () => close());
  const go = button('btn-accent', 'Start session', () => void launch());
  ft.append(cancel, go);

  /**
   * Switch what is being launched: each kind reveals its own group, and the
   * agent-only set (Model, Effort, Permissions and its info button, Start from)
   * leaves the dialog entirely for Terminal and Other — hidden AND `disabled`,
   * so nothing hidden is reachable by keyboard or read by a screen reader. The
   * same idiom applies WITHIN the agents: Gemini CLI has no effort levels, so
   * that one control leaves the form for it (a dead select says nothing).
   *
   * `byUser` moves the keyboard into the revealed Command field — an open()
   * restoring a remembered kind must not steal focus from the Name box.
   */
  function setKind(next: LaunchKind, byUser: boolean): void {
    kind = next;
    toolCards.select(next);
    const agent = isAgentKind(next) ? next : null;
    const agentOff = agent === null;
    cmdField.hidden = next !== 'other';
    shellGroup.hidden = next !== 'terminal';
    claudeBox.hidden = agentOff;
    infoBtn.disabled = agentOff;
    for (const b of permCards.buttons.values()) b.disabled = agentOff;
    if (agentOff) setHelp(false, false);
    if (agent !== null) applyToolVocab(agent);
    else {
      modelSel.disabled = true;
      effortSel.disabled = true;
      startSel.disabled = true;
    }
    syncNotice();
    syncLaunchable();
    if (byUser && next === 'other') cmdInput.focus();
  }

  /**
   * Point the one agent control set at ONE tool's vocabulary: its models, its
   * effort levels (none = the control leaves the form), which permission cards
   * it cannot be told from here, and its Start from options. Every value comes
   * from `TOOLS` in launch-args.ts; nothing about a CLI is spelled here.
   */
  function applyToolVocab(agent: AgentKind): void {
    const v = TOOLS[agent];
    fillChoices(modelSel, v.models);
    modelSel.value = chosen[agent].model;
    // A value no option carries selects NOTHING in a real select; fall back to
    // the tool's own first option rather than leaving the field blank.
    if (modelSel.value !== chosen[agent].model) {
      chosen[agent].model = v.models[0]?.id ?? '';
      modelSel.value = chosen[agent].model;
    }
    modelSel.disabled = false;

    const hasEffort = v.efforts.length > 0;
    effortField.hidden = !hasEffort;
    effortSel.disabled = !hasEffort;
    // With only one control left the row stops being a pair, or Model would sit
    // in half a dialog beside a hole.
    modelEffort.classList.toggle('is-one', !hasEffort);
    if (hasEffort) {
      fillChoices(effortSel, v.efforts);
      effortSel.value = chosen[agent].effort;
      if (effortSel.value !== chosen[agent].effort) {
        chosen[agent].effort = v.effortNone;
        effortSel.value = v.effortNone;
      }
    } else {
      effortSel.replaceChildren();
    }

    permCards.setInert(new Map(v.inertPerms.map((p) => [p.mode, p.hint])));
    // A mode this tool cannot be told is not a mode it silently keeps.
    if (v.inertPerms.some((p) => p.mode === perm)) setPerm('default');
    else permCards.select(perm);

    startSel.disabled = false;
    // Claude Code is the one tool whose Start from lists conversations, so its
    // list is the only one that needs the history (asked once per open).
    if (agent === 'claude') refreshHistory();
    populateStart();
  }

  modal.append(hd, body, ft);
  scrim.append(modal);
  scrim.addEventListener('mousedown', (e) => {
    if (e.target === scrim) close();
  });
  trapTab(modal);
  modalHost.append(scrim);

  // ---- the info popover ----------------------------------------------------

  function setHelp(open: boolean, refocus: boolean): void {
    helpOpen = open;
    help.hidden = !open;
    infoBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (!open && refocus && !infoBtn.disabled) infoBtn.focus();
  }

  // Esc closes the popover and NOTHING else: main.ts closes the dialog from a
  // bubbling window listener, so a capture listener on the same window runs
  // first and stops the event before that one ever sees it — also when the
  // keyboard sits on the page body after a click on the popover's text.
  window.addEventListener(
    'keydown',
    (e: KeyboardEvent) => {
      if (!helpOpen || scrim.hidden || e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      setHelp(false, true);
    },
    true,
  );

  // A press anywhere outside the popover and its button closes it (the press
  // then does whatever it does — focus goes where the user clicked).
  document.addEventListener(
    'pointerdown',
    (e: PointerEvent) => {
      if (!helpOpen) return;
      const t = e.target;
      if (t instanceof Node && (help.contains(t) || infoBtn.contains(t))) return;
      setHelp(false, false);
    },
    true,
  );

  // Keyboard focus moving on to anything outside the popover and its button
  // (Tab to the cards it covers) closes it too: a focused control hidden under
  // the popover would be a focus ring nobody can see.
  document.addEventListener('focusin', (e: FocusEvent) => {
    if (!helpOpen) return;
    const t = e.target;
    if (t instanceof Node && (help.contains(t) || infoBtn.contains(t))) return;
    setHelp(false, false);
  });

  // ---- data flow -----------------------------------------------------------

  function populateProjects(): void {
    const prev = projectSel.value;
    projectSel.replaceChildren();
    for (const p of st.state.projects) {
      const opt = el('option', '', p.name); // names only, never paths
      opt.value = p.id;
      projectSel.append(opt);
    }
    if (st.state.projects.some((p) => p.id === prev)) projectSel.value = prev;
    syncLaunchable();
    syncNamePlaceholder();
  }

  // ---- what the backend can actually run (B5) -------------------------------

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
  /** This project's resumable conversations, fetched at most once per open. */
  let history: HistoryEntry[] = [];
  let historyAsked = false;


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
    if (shellHints.has(shell)) {
      const firstShell = shellCards.live()[0];
      if (firstShell !== undefined) {
        shell = firstShell;
        shellCards.select(firstShell);
      }
    }
    if (toolHints.has(kind)) {
      const firstKind = toolCards.live()[0];
      if (firstKind !== undefined) setKind(firstKind, false);
      else syncNotice();
    } else {
      toolCards.select(kind);
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
    const tool = keyToolFor(kind);
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

  /**
   * The ended conversations of the SELECTED project, newest first — the same
   * entries the sessions drawer's Earlier section lists, filtered to the ones
   * `--resume` can target. With no project selected the page cannot name the
   * home folder, so it offers the entries that belong to no project instead.
   */
  function resumeEntries(): HistoryEntry[] {
    const pid = projectSel.value;
    return history
      .filter(
        (e) =>
          e.conversation &&
          e.ended !== null &&
          (pid !== ''
            ? e.projectId === pid
            : // No project = the home folder, where such a session would start:
              // a project-less conversation from SOME OTHER folder is not one of
              // these. Until home is known nothing is offered, never a guess.
              e.projectId === undefined && homeResolved !== null && e.cwd === homeResolved),
      )
      .sort((a, b) => Date.parse(b.lastUsedAt) - Date.parse(a.lastUsedAt));
  }

  /**
   * Fill Start from for the selected tool: its fixed options, then (Claude Code
   * only) one per resumable conversation of this project, labelled with its
   * title and when it last ran — the Earlier section's own wording. A value the
   * new list no longer carries falls back to a fresh start; it never silently
   * becomes a different conversation.
   */
  function populateStart(): void {
    if (!isAgentKind(kind)) return;
    startSel.replaceChildren();
    for (const s of TOOLS[kind].starts) {
      const opt = el('option', '', s.label);
      opt.value = s.value;
      startSel.append(opt);
    }
    if (kind === 'claude') {
      for (const e of resumeEntries()) {
        const opt = el('option', '', `${e.title}, ${fmtAgo(e.lastUsedAt)}`);
        opt.value = e.id;
        startSel.append(opt);
      }
    }
    const want = chosen[kind].start;
    startSel.value = want;
    // The conversation that was chosen may not belong to the project now
    // selected. A fresh start is the only honest fallback — silently landing on
    // a DIFFERENT conversation would be the one unforgivable outcome here.
    if (startSel.value !== want) {
      chosen[kind].start = 'fresh';
      startSel.value = 'fresh';
    }
  }

  /**
   * The home folder behind "no project", resolved once per page (the fetch
   * itself is cached in `homeCwd`) so `resumeEntries` can tell a conversation
   * that ran THERE from one that ran in some other folder outside every
   * project. Asked beside the history, for the same list.
   */
  let homeResolved: string | null = null;
  let homeAsked = false;
  function refreshHome(): void {
    if (homeAsked) return;
    homeAsked = true;
    void homeCwd()
      .then((p) => {
        homeResolved = p;
        if (kind === 'claude') populateStart();
      })
      .catch(() => {
        // Unknown home: the list stays empty rather than guessing, and the next
        // open asks again.
        homeAsked = false;
      });
  }

  /** Claude Code's resume list, asked at most once per open. */
  function refreshHistory(): void {
    refreshHome();
    if (historyAsked) return;
    historyAsked = true;
    void api
      .getHistory()
      .then((h) => {
        history = h;
        if (kind === 'claude') populateStart();
      })
      .catch(() => {
        // No list, no extra options — the two fixed ones still work.
      });
  }

  /**
   * With no projects there is nothing for Claude to work on, so Start session
   * stays off — but a plain Terminal always has somewhere to run (the home
   * folder), so that one kind stays launchable and the line says where it
   * lands.
   */
  function syncLaunchable(): void {
    const empty = st.state.projects.length === 0;
    go.disabled = empty && kind !== 'terminal';
    none.hidden = !empty;
    noneTxt.textContent =
      empty && kind === 'terminal'
        ? 'No projects yet. This one opens in your home folder.'
        : 'No projects yet.';
  }

  /**
   * The Name field's placeholder is the SELECTED project's name: leaving the
   * field blank sends no title, and the server titles the session after the
   * project — so the placeholder shows what will actually happen instead of
   * describing it.
   */
  function syncNamePlaceholder(): void {
    const p = st.state.projects.find((p) => p.id === projectSel.value);
    nameInput.placeholder = p?.name ?? '';
  }

  /**
   * Resolve the pre-selected model + permission ONCE per open through the
   * unit-tested precedence chain (`resolveModel`/`resolvePerm` in
   * launch-args.ts): explicit project default > hardcoded fallback. The
   * selected project is whatever `projectSel.value` currently points at — a
   * project-intent open force-selects its project before this runs; a plain
   * open uses populateProjects()'s auto-selected first project. Called from
   * open() only: a mid-dialog project switch deliberately does NOT re-resolve,
   * leaving per-launch control with the user once the dialog is open.
   */
  function applyDefaults(): void {
    const p = st.state.projects.find((p) => p.id === projectSel.value);
    // `defaultModel` is a Claude Code model id, so it resolves onto THAT tool's
    // choice — whichever tool is on screen right now. Switching to Claude Code
    // later in this open still shows it.
    chosen.claude.model = resolveModel(p?.defaultModel);
    if (kind === 'claude') modelSel.value = chosen.claude.model;
    const wanted = resolvePerm(p?.defaultMode);
    // Never onto a card this tool cannot be told: an inert mode is not a choice.
    const inert = isAgentKind(kind) ? TOOLS[kind].inertPerms : [];
    setPerm(inert.some((x) => x.mode === wanted) ? 'default' : wanted);
  }

  /** Start from, read in ONE place: the argv and the log line agree. */
  function currentContinue(): boolean {
    return kind === 'claude' && continueFromStart(startSel.value);
  }

  /**
   * The conversation the user picked in Start from, when they picked one: any
   * value the fixed table does not carry IS a conversation id (the per-project
   * entries are valued by it). Claude Code only.
   */
  function currentResumeId(): string | undefined {
    if (kind !== 'claude') return undefined;
    const v = startSel.value;
    return v !== '' && !isStartFrom(v) ? v : undefined;
  }

  /**
   * The ONE composition path for every kind — the POST body reads only this.
   * null = nothing to spawn (blank custom command). Every field is handed over
   * whatever the kind: `composeSpawn` reads only the ones its kind owns, and
   * the tests pin that a hidden control cannot leak into another tool's argv.
   */
  function currentSpawn(): SpawnSpec | null {
    return composeSpawn({
      kind,
      model: modelSel.value,
      perm,
      continueLast: currentContinue(),
      effort: currentEffort(),
      shell,
      customLine: cmdInput.value,
      ...(currentResumeId() !== undefined ? { resumeId: currentResumeId() } : {}),
      codexModel: kind === 'codex' ? modelSel.value : undefined,
      geminiModel: kind === 'gemini' ? modelSel.value : undefined,
      grokModel: kind === 'grok' ? modelSel.value : undefined,
      codexEffort: kind === 'codex' ? effortSel.value : undefined,
      grokEffort: kind === 'grok' ? effortSel.value : undefined,
      start: startSel.value,
    });
  }

  /**
   * The selected effort, resolved in ONE place: the argv and the log line
   * agree. Claude Code's own vocabulary — the other tools' efforts are their
   * own ids and travel through `composeSpawn`'s per-tool fields.
   */
  function currentEffort(): Effort {
    return kind === 'claude' && isEffort(effortSel.value) ? effortSel.value : 'default';
  }

  projectSel.addEventListener('change', () => {
    // A mid-dialog project switch does NOT re-resolve model/permission —
    // defaults settle once per open (applyDefaults); per-launch control stays
    // with the user. The name placeholder and, for Claude Code, WHICH
    // conversations can be resumed both follow the new project.
    syncNamePlaceholder();
    if (kind === 'claude') populateStart();
  });

  // Every per-tool choice is remembered against ITS tool, so a switch and back
  // shows what was chosen rather than what the last tool happened to hold.
  modelSel.addEventListener('change', () => {
    if (isAgentKind(kind)) chosen[kind].model = modelSel.value;
  });
  effortSel.addEventListener('change', () => {
    if (isAgentKind(kind)) chosen[kind].effort = effortSel.value;
  });

  // Choosing an earlier conversation names the session after it — the user
  // recognises the work, not a project name repeated five times. Still just a
  // preset: the field stays editable.
  startSel.addEventListener('change', () => {
    if (isAgentKind(kind)) chosen[kind].start = startSel.value;
    const id = currentResumeId();
    if (id === undefined) return;
    const entry = resumeEntries().find((e) => e.id === id);
    if (entry !== undefined) nameInput.value = entry.title;
  });

  // ONE permanent subscription (state.ts has no unsubscribe — never bind per
  // open): keeps the project list fresh while the dialog shows.
  st.subscribe((kindOfChange) => {
    if (kindOfChange === 'projects' && !scrim.hidden) populateProjects();
  });

  async function launch(): Promise<void> {
    err.hidden = true;
    const projectId = projectSel.value;
    if (projectId === '' && kind !== 'terminal') {
      showErr('Pick a project first.');
      return;
    }
    const spawn = currentSpawn();
    if (spawn === null) {
      showErr('Type a command.');
      cmdInput.focus();
      return;
    }
    // What the user asked for, in SHAPE only: the custom command line is
    // whatever they typed and never reaches a log line — only how many words
    // it had. The project appears by NAME, never by path.
    const continueLast = currentContinue();
    const projectLabel = st.state.projects.find((p) => p.id === projectId)?.name ?? '?';
    log.info(
      isAgentKind(kind)
        ? // A conversation id is a session identifier, not a secret, but it says
          // nothing a reader needs: `resume=yes` is the fact.
          `launch: kind=${kind} project=${projectLabel} model=${modelSel.value} ` +
          `effort=${effortSel.disabled ? 'none' : effortSel.value} mode=${perm} ` +
          `continue=${continueLast} resume=${currentResumeId() !== undefined ? 'yes' : 'no'}`
        : kind === 'terminal'
          ? `launch: kind=terminal project=${projectLabel} shell=${shell}`
          : `launch: kind=other project=${projectLabel} words=${spawn.args.length + 1}`,
    );
    // Sized to the focused pane as a starting hint; the attach flow
    // reconciles the PTY with the new tab's real dimensions (same contract
    // as a history resume).
    const dims = focusedPaneDims();
    const title = nameInput.value.trim();
    // A session with no project and no typed name would be titled after its
    // command by the server — which is how a raw path (`/bin/bash`) ends up on
    // screen. The shell's product name is sent instead; every other case still
    // falls through to the server's own titling (blank name -> project name).
    const shellTitle = projectId === '' ? (shellLabel(spawn.command) ?? '') : '';
    const sendTitle = title !== '' ? title : shellTitle;
    go.disabled = true;
    try {
      // A project when there is one; otherwise (Terminal only) the home folder,
      // which the server resolves and validates like any other cwd.
      const where = projectId !== '' ? { projectId } : { cwd: await homeCwd() };
      const info = await api.createSession({
        ...where,
        command: spawn.command,
        args: spawn.args,
        ...(sendTitle !== '' ? { title: sendTitle } : {}),
        cols: dims.cols,
        rows: dims.rows,
      });
      log.info(
        `launch ok: session=${info.id} name=${title !== '' ? 'given' : shellTitle !== '' ? 'shell' : 'project default'}`,
      );
      st.upsertSession(info); // gives the session its own (new) tab
      st.focusSession(info.id); // ... and makes that tab active + focused
      close();
      requestTerminalFocus();
    } catch (e) {
      log.warn(`launch failed: ${e instanceof Error ? e.message : String(e)}`);
      showErr(e instanceof Error ? e.message : String(e));
    } finally {
      syncLaunchable();
    }
  }

  function showErr(msg: string): void {
    err.textContent = msg;
    err.hidden = false;
  }

  // ---- open/close ----------------------------------------------------------
  let restoreTo: HTMLElement | null = null;

  function open(opts?: LaunchOpts): void {
    if (!scrim.hidden) return;
    restoreTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    err.hidden = true;
    nameInput.value = '';
    setHelp(false, false);
    // Which cards the grid holds is decided before anything is selected in it.
    applyHiddenTools();
    // Ask again every open: a tool can be installed, and a key saved, between
    // two uses of this dialog. The LAST answer stays on screen until a new one
    // lands, so nothing flickers while the requests are in flight.
    historyAsked = false;
    refreshTools();
    // Effort and Start from reset for EVERY agent: a reopened dialog never
    // silently continues, resumes, or spends a level the user chose an hour ago.
    for (const k of AGENT_KINDS) {
      chosen[k].effort = TOOLS[k].effortNone;
      chosen[k].start = 'fresh';
    }
    populateProjects();
    if (opts?.projectId !== undefined && st.state.projects.some((p) => p.id === opts.projectId)) {
      // Explicit project intent (projects-drawer row `+`) means "a Claude Code
      // session for that project" — go back to the claude kind so a stale
      // custom command or shell can't hijack the launch, and force-select that
      // project BEFORE defaults resolve so its defaultModel/defaultMode are
      // layered on.
      setKind(shownKind('claude'), false);
      projectSel.value = opts.projectId;
      syncNamePlaceholder();
    } else {
      // A plain open keeps the kind (and its shell / command text) as the user
      // last left it — the dialog's remember-what-you-chose behaviour. A kind
      // that has since left the grid falls back to the first card in it.
      setKind(shownKind(kind), false);
    }
    // Resolve model + permission once against the now-settled selected project
    // (the forced project above, or populateProjects()'s auto-selected first
    // project on a plain open). A project default names a Claude Code model, so
    // it is layered on for that tool only. Effort and Start from reset every
    // open — a reopened dialog never silently continues or resumes.
    applyDefaults();
    scrim.hidden = false;
    nameInput.focus();
  }

  function close(): void {
    if (scrim.hidden) return;
    setHelp(false, false);
    scrim.hidden = true;
    // Return the keyboard where it came from — opening from a terminal
    // restores the terminal; otherwise fall back to the focused pane.
    if (restoreTo !== null && restoreTo.isConnected) restoreTo.focus();
    else requestTerminalFocus();
    restoreTo = null;
  }

  // The assumed set on screen from the very first frame: the cards the backend
  // has not vouched for yet are already inert, so a first open cannot flash a
  // live Codex / Gemini CLI / Grok / Zsh / Command Prompt that then goes dark.
  // The hidden cards leave the grid on the same frame, for the same reason.
  applyHiddenTools();
  applyAvailability();
  // Only when the remembered kind is one of them: with nothing hidden this
  // frame is exactly the pre-B6 one, down to the untouched Model select.
  if (shownKind(kind) !== kind) setKind(shownKind(kind), false);

  ctl = { open, close, isOpen: () => !scrim.hidden };
}
