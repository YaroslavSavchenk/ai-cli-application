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
 *                Terminal, Other. Codex, Gemini CLI and Grok are INERT until
 *                part B5 (shown, never selectable, skipped by the arrows).
 *   Name (optional)   Project      (Name's placeholder IS the selected
 *                                   project's name — blank = titled that)
 *   Claude Code: Model   Effort
 *                Permissions (i)   2 x 2 cards; the (i) button opens the ONE
 *                                  sanctioned explanation in this dialog
 *                Start from        fresh / the last conversation (= the old
 *                                  `Continue last conversation` checkbox)
 *   Terminal:    Shell             Bash, Zsh, PowerShell, Command Prompt
 *                                  (Zsh and Command Prompt inert until B5)
 *   Other:       Command           the custom-command escape hatch
 *
 * The claude-only controls are HIDDEN and DISABLED for the other kinds (not
 * dimmed — four dead controls carry no information). No command preview: the
 * 2026-07-25 "no commands or flags in the UI" rule stands (user, 2026-09-10).
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
import * as api from '../api.ts';
import * as st from '../state.ts';
import { log } from '../log.ts';
import { el, button, trapTab } from './util.ts';
import { infoIcon } from './icons.ts';
import { focusedPaneDims, requestTerminalFocus } from './panes.ts';
import {
  MODELS,
  MODEL_LABEL,
  PERMS,
  PERM_SHORT,
  PERM_HELP,
  EFFORTS,
  EFFORT_LABEL,
  NOT_YET,
  SHELLS,
  SHELL_CARDS,
  START_FROM,
  TOOL_CARDS,
  composeSpawn,
  continueFromStart,
  isEffort,
  shellLabel,
  resolveModel,
  resolvePerm,
} from './launch-args.ts';
import type { Effort, LaunchKind, Perm, ShellId, SpawnSpec } from './launch-args.ts';

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

/** One card of a card radiogroup. */
interface CardSpec<T extends string> {
  /** The value the card selects; null = INERT (shown, never selectable). */
  value: T | null;
  /** Extra class on the card (the danger mode). */
  cls?: string;
  content: Node[];
}

interface CardGroup<T extends string> {
  row: HTMLElement;
  buttons: Map<T, HTMLButtonElement>;
  select(v: T): void;
}

/**
 * A grid of cards that behaves like a real radiogroup — the same idiom the
 * segmented rows had: ONE tab stop (roving tabindex), arrow keys move the
 * selection in reading order, Home/End jump. Inert cards are
 * `aria-disabled="true"` and permanently `tabindex=-1`: the arrows skip them,
 * a click does nothing and does not even take focus, and the dialog's focus
 * trap (`tabIndex >= 0` filter) never counts them as a stop.
 */
function radioCards<T extends string>(
  rowClass: string,
  labelledBy: string,
  specs: CardSpec<T>[],
  onPick: (v: T) => void,
): CardGroup<T> {
  const row = el('div', rowClass);
  row.setAttribute('role', 'radiogroup');
  row.setAttribute('aria-labelledby', labelledBy);
  const buttons = new Map<T, HTMLButtonElement>();
  const order: T[] = [];
  for (const s of specs) {
    const b = button(s.cls !== undefined && s.cls !== '' ? `ns-card ${s.cls}` : 'ns-card', '');
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', 'false');
    b.tabIndex = -1;
    b.append(...s.content);
    const v = s.value;
    if (v === null) {
      b.setAttribute('aria-disabled', 'true');
      b.addEventListener('mousedown', (e) => e.preventDefault());
    } else {
      order.push(v);
      buttons.set(v, b);
      b.addEventListener('click', () => onPick(v));
    }
    row.append(b);
  }
  let current = order[0] as T;
  row.addEventListener('keydown', (e: KeyboardEvent) => {
    let i = order.indexOf(current);
    const k = e.key;
    if (k === 'ArrowRight' || k === 'ArrowDown') i = (i + 1) % order.length;
    else if (k === 'ArrowLeft' || k === 'ArrowUp') i = (i - 1 + order.length) % order.length;
    else if (k === 'Home') i = 0;
    else if (k === 'End') i = order.length - 1;
    else return;
    e.preventDefault();
    const next = order[i] as T;
    onPick(next);
    buttons.get(next)?.focus();
  });
  function select(v: T): void {
    current = v;
    for (const [value, b] of buttons) {
      const on = value === v;
      b.classList.toggle('is-sel', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
    }
  }
  select(current);
  return { row, buttons, select };
}

/** A card's words: the label, and an optional quieter sub-line under it. */
function cardText(label: string, sub?: string): HTMLElement {
  const txt = el('span', 'ns-card-txt');
  txt.append(el('span', 'ns-card-lb', label));
  if (sub !== undefined) txt.append(el('span', 'ns-card-sub', sub));
  return txt;
}

/** A group label that a radiogroup can point `aria-labelledby` at. */
function groupLabel(id: string, text: string): HTMLElement {
  const lb = el('span', 'ns-lb', text);
  lb.id = id;
  return lb;
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
      const mark = el('span', t.kind === 'claude' ? 'ns-mark is-agent' : 'ns-mark', t.mark);
      mark.setAttribute('aria-hidden', 'true');
      return {
        value: t.kind,
        content: [mark, cardText(t.label, t.kind === null ? NOT_YET : t.sub)],
      };
    }),
    (k) => setKind(k, true),
  );
  toolGroup.append(groupLabel('ns-tool-lb', 'Tool'), toolCards.row);

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

  // ---- Claude Code only ----------------------------------------------------
  const claudeBox = el('div', 'ns-kindbox');

  const modelEffort = el('div', 'ns-row2');
  const modelField = el('label', 'ns-field');
  const modelSel = el('select');
  modelSel.name = 'model';
  for (const m of MODELS) {
    const opt = el('option', '', MODEL_LABEL[m]);
    opt.value = m;
    modelSel.append(opt);
  }
  modelField.append(el('span', 'ns-lb', 'Model'), modelSel);

  const effortField = el('label', 'ns-field');
  const effortSel = el('select');
  effortSel.name = 'effort';
  for (const e of EFFORTS) {
    const opt = el('option', '', EFFORT_LABEL[e]);
    opt.value = e;
    effortSel.append(opt);
  }
  effortField.append(el('span', 'ns-lb', 'Effort'), effortSel);
  modelEffort.append(modelField, effortField);

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
      content: [cardText(PERM_SHORT[p.mode])],
    })),
    (mode) => setPerm(mode),
  );
  permGroup.append(permLbRow, help, permCards.row);

  function setPerm(mode: Perm): void {
    perm = mode;
    permCards.select(mode);
  }
  setPerm('default');

  // Start from: `continue` is exactly the old "Continue last conversation"
  // checkbox (`--continue`). Per-id resume stays in the drawer's HISTORY.
  const startField = el('label', 'ns-field');
  const startSel = el('select');
  startSel.name = 'start';
  for (const s of START_FROM) {
    const opt = el('option', '', s.label);
    opt.value = s.value;
    startSel.append(opt);
  }
  startField.append(el('span', 'ns-lb', 'Start from'), startSel);

  claudeBox.append(modelEffort, permGroup, startField);

  // ---- Terminal only -------------------------------------------------------
  let shell: ShellId = SHELLS[0].id;
  const shellGroup = el('div', 'ns-group');
  shellGroup.hidden = true;
  const shellCards = radioCards<ShellId>(
    'ns-grid ns-shells',
    'ns-shell-lb',
    SHELL_CARDS.map((c) => ({
      value: c.shell,
      content: [cardText(c.label, c.shell === null ? NOT_YET : c.sub)],
    })),
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

  body.append(toolGroup, nameProj, claudeBox, shellGroup, cmdField, err, none);

  // ---- footer --------------------------------------------------------------
  const ft = el('footer', 'ns-ft');
  const cancel = button('btn-quiet', 'Cancel', () => close());
  const go = button('btn-accent', 'Start session', () => void launch());
  ft.append(cancel, go);

  /**
   * Switch what is being launched: each kind reveals its own group, and the
   * claude-only set (Model, Effort, Permissions and its info button, Start
   * from) leaves the dialog entirely for the other two kinds — hidden AND
   * `disabled`, so nothing hidden is reachable by keyboard or read by a screen
   * reader.
   *
   * `byUser` moves the keyboard into the revealed Command field — an open()
   * restoring a remembered kind must not steal focus from the Name box.
   */
  function setKind(next: LaunchKind, byUser: boolean): void {
    kind = next;
    toolCards.select(next);
    const claudeOff = next !== 'claude';
    cmdField.hidden = next !== 'other';
    shellGroup.hidden = next !== 'terminal';
    claudeBox.hidden = claudeOff;
    modelSel.disabled = claudeOff;
    effortSel.disabled = claudeOff;
    startSel.disabled = claudeOff;
    infoBtn.disabled = claudeOff;
    for (const b of permCards.buttons.values()) b.disabled = claudeOff;
    if (claudeOff) setHelp(false, false);
    syncLaunchable();
    if (byUser && next === 'other') cmdInput.focus();
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
    modelSel.value = resolveModel(p?.defaultModel);
    setPerm(resolvePerm(p?.defaultMode));
  }

  /** Start from, read in ONE place: the argv and the log line agree. */
  function currentContinue(): boolean {
    return continueFromStart(startSel.value);
  }

  /**
   * The ONE composition path for every kind — the POST body reads only this.
   * null = nothing to spawn (blank custom command).
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
    });
  }

  /** The selected effort, resolved in ONE place: the argv and the log line agree. */
  function currentEffort(): Effort {
    return isEffort(effortSel.value) ? effortSel.value : 'default';
  }

  projectSel.addEventListener('change', () => {
    // A mid-dialog project switch does NOT re-resolve model/permission —
    // defaults settle once per open (applyDefaults); per-launch control stays
    // with the user. Only the name placeholder follows the new project.
    syncNamePlaceholder();
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
    const effort = currentEffort();
    const continueLast = currentContinue();
    const projectLabel = st.state.projects.find((p) => p.id === projectId)?.name ?? '?';
    log.info(
      kind === 'claude'
        ? `launch: kind=claude project=${projectLabel} model=${modelSel.value} effort=${effort} ` +
          `mode=${perm} continue=${continueLast}`
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
    populateProjects();
    if (opts?.projectId !== undefined && st.state.projects.some((p) => p.id === opts.projectId)) {
      // Explicit project intent (projects-drawer row `+`) means "a Claude Code
      // session for that project" — go back to the claude kind so a stale
      // custom command or shell can't hijack the launch, and force-select that
      // project BEFORE defaults resolve so its defaultModel/defaultMode are
      // layered on.
      setKind('claude', false);
      projectSel.value = opts.projectId;
      syncNamePlaceholder();
    } else {
      // A plain open keeps the kind (and its shell / command text) as the user
      // last left it — the dialog's remember-what-you-chose behaviour.
      setKind(kind, false);
    }
    // Resolve model + permission once against the now-settled selected project
    // (the forced project above, or populateProjects()'s auto-selected first
    // project on a plain open). Effort and Start from reset every open.
    applyDefaults();
    effortSel.value = 'default';
    startSel.value = 'fresh';
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

  ctl = { open, close, isOpen: () => !scrim.hidden };
}
