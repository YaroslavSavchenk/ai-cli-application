/**
 * Launch dialog — the modal that creates sessions (settled user decision
 * 2026-07-20, replacing the launcher-as-tab).
 *
 * REDUCED 2026-09-06 (user's call): the dialog is a short form now, not a
 * briefing. Gone are the preset chips, the readable launch summary, the header
 * subtitle, the footer note, the permission-card descriptions and every
 * tooltip that explained mechanics. What is left is six controls with one-word
 * labels:
 *
 *   Name · Project            (Name's placeholder IS the selected project's
 *   Model · Effort             name — blank means the server titles it that)
 *   Mode      (one row of four segments: always ask / auto edits /
 *              read-only / no prompts — the last one red, selected or not)
 *   Continue last conversation (checkbox → `--continue`)
 *
 * `composeArgs()` stays the ONE argv composer and `currentSpawn()` the ONE
 * composition path for the POST body — there is simply no second rendering of
 * it to keep in sync anymore.
 *
 * The custom-command escape hatch survives (user decision 2026-07-20) as the
 * footer's `other command` text button: it reveals a full-width mono Command
 * field (whitespace-split argv, no shell) and disables the claude-specific
 * controls. That field's content IS a command the user types — the one spot
 * exempt from the plain-language copy rule.
 *
 * Entry points (all funnel here): topbar `+ New session`, tab-strip ghost
 * `+`, projects-drawer per-row `+` (pre-set to that project), the
 * empty-state button, and Ctrl+Alt+T. The new session opens in its own new
 * tab and becomes active. While closed, the dialog touches no keyboard
 * input — the terminal owns the keys.
 */
import * as api from '../api.ts';
import * as st from '../state.ts';
import { log } from '../log.ts';
import { el, button, trapTab } from './util.ts';
import { focusedPaneDims, requestTerminalFocus } from './panes.ts';
import {
  MODELS,
  PERMS,
  PERM_SHORT,
  EFFORTS,
  composeArgs,
  parseCustomCommand,
  isEffort,
  resolveModel,
  resolvePerm,
} from './launch-args.ts';
import type { Effort, Perm, SpawnSpec } from './launch-args.ts';

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
  const scrim = el('div', 'modal-scrim launch-scrim');
  scrim.hidden = true;
  const modal = el('div', 'modal launch-modal');
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-label', 'new session');

  // ---- header (gradient band) ----------------------------------------------
  const hd = el('header', 'launch-hd');
  const tile = el('div', 'launch-tile');
  tile.setAttribute('aria-hidden', 'true');
  tile.append(el('span', 'logo-glyph', '>_'));
  const closeBtn = button('launch-x', '×', () => close());
  closeBtn.setAttribute('aria-label', 'close');
  hd.append(tile, el('div', 'launch-title', 'New session'), el('span', 'launch-gap'), closeBtn);

  // ---- body ----------------------------------------------------------------
  const body = el('div', 'launch-body');

  // 2-column field grid: name · project / model · effort.
  const fields = el('div', 'launch-fields');

  const nameField = el('label', 'launch-field');
  nameField.append(el('span', 'launch-lb', 'Name'));
  const nameInput = el('input');
  nameInput.name = 'title';
  nameInput.spellcheck = false;
  nameField.append(nameInput);

  const projField = el('label', 'launch-field');
  projField.append(el('span', 'launch-lb', 'Project'));
  const projectSel = el('select');
  projectSel.name = 'project';
  projField.append(projectSel);

  const modelField = el('label', 'launch-field');
  modelField.append(el('span', 'launch-lb', 'Model'));
  const modelSel = el('select');
  modelSel.name = 'model';
  for (const m of MODELS) {
    const opt = el('option', '', m);
    opt.value = m;
    modelSel.append(opt);
  }
  modelField.append(modelSel);

  const effortField = el('label', 'launch-field');
  effortField.append(el('span', 'launch-lb', 'Effort'));
  const effortSel = el('select');
  effortSel.name = 'effort';
  for (const e of EFFORTS) {
    const opt = el('option', '', e);
    opt.value = e;
    effortSel.append(opt);
  }
  effortField.append(effortSel);

  fields.append(nameField, projField, modelField, effortField);

  // Custom-mode command field (hidden in claude mode): full-width, mono,
  // whitespace-split argv — the old launcher's field, in the dialog voice.
  const cmdField = el('label', 'launch-field launch-custom');
  cmdField.hidden = true;
  const cmdInput = el('input');
  cmdInput.name = 'command';
  cmdInput.placeholder = 'htop';
  cmdInput.spellcheck = false;
  cmdField.append(el('span', 'launch-lb', 'Command'), cmdInput);

  // Mode: ONE row of four segments. The words are PERM_SHORT — the same table
  // the pane-header tag reads, so a mode reads identically everywhere.
  const permWrap = el('div', 'launch-field');
  permWrap.append(el('span', 'launch-lb', 'Mode'));
  const permRow = el('div', 'mode-seg');
  permRow.setAttribute('role', 'group');
  permRow.setAttribute('aria-label', 'mode');
  let perm: Perm = 'default';
  const permButtons = new Map<Perm, HTMLButtonElement>();
  for (const p of PERMS) {
    const seg = button(`mode-seg-btn${p.danger ? ' is-danger' : ''}`, PERM_SHORT[p.mode], () => {
      setPerm(p.mode);
    });
    permButtons.set(p.mode, seg);
    permRow.append(seg);
  }
  permWrap.append(permRow);

  function setPerm(mode: Perm): void {
    perm = mode;
    for (const [m, b] of permButtons) {
      b.classList.toggle('is-sel', m === mode);
      b.setAttribute('aria-pressed', m === mode ? 'true' : 'false');
    }
  }
  setPerm('default');

  // Continue: one checkbox row in the app's existing toggle idiom (a real
  // keyboard-reachable button carrying aria-pressed). Checked → `--continue`.
  let continueLast = false;
  const contRow = button('status-row launch-check', '', () => {
    continueLast = !continueLast;
    syncContinue();
  });
  const contBox = el('span', 'status-box');
  contBox.setAttribute('aria-hidden', 'true');
  contRow.append(contBox, el('span', 'status-lb', 'Continue last conversation'));

  function syncContinue(): void {
    contRow.setAttribute('aria-pressed', continueLast ? 'true' : 'false');
    contBox.textContent = continueLast ? '✓' : '';
  }
  syncContinue();

  const err = el('div', 'form-err');
  err.setAttribute('role', 'alert');
  err.hidden = true;

  const none = el('div', 'launch-none');
  none.hidden = true;
  none.append(
    el('span', '', 'no projects yet — '),
    button('btn-link', 'add one', () => {
      close();
      st.openDrawer('projects');
    }),
  );

  body.append(fields, cmdField, permWrap, contRow, err, none);

  // ---- footer --------------------------------------------------------------
  const ft = el('footer', 'launch-ft');
  const customBtn = button('launch-other', 'other command', () => {
    setCustomMode(!customMode);
  });
  customBtn.setAttribute('aria-pressed', 'false');
  const cancel = button('btn', 'Cancel', () => close());
  const go = button('btn-go', 'Launch', () => void launch());
  ft.append(customBtn, el('span', 'launch-gap'), cancel, go);

  /**
   * Custom mode: the command field appears and the claude-specific controls
   * (model, effort, mode segments, continue) go visually AND functionally
   * disabled — the old launcher's is-disabled pattern. Exits: toggling
   * `other command` off, or a project-intent open.
   */
  let customMode = false;
  function setCustomMode(on: boolean): void {
    if (customMode === on) return;
    customMode = on;
    customBtn.classList.toggle('is-on', on);
    customBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    cmdField.hidden = !on;
    modelSel.disabled = on;
    effortSel.disabled = on;
    contRow.disabled = on;
    modelField.classList.toggle('is-disabled', on);
    effortField.classList.toggle('is-disabled', on);
    permRow.classList.toggle('is-disabled', on);
    contRow.classList.toggle('is-disabled', on);
    for (const b of permButtons.values()) b.disabled = on;
    if (on) cmdInput.focus();
  }

  modal.append(hd, body, ft);
  scrim.append(modal);
  scrim.addEventListener('mousedown', (e) => {
    if (e.target === scrim) close();
  });
  trapTab(modal);
  modalHost.append(scrim);

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
    const empty = st.state.projects.length === 0;
    go.disabled = empty;
    none.hidden = !empty;
    syncNamePlaceholder();
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
   * launch-args.ts, documented in web/DESIGN.md): explicit project default >
   * hardcoded fallback. The selected project is whatever `projectSel.value`
   * currently points at — a project-intent open force-selects its project
   * before this runs; a plain open uses populateProjects()'s auto-selected
   * first project. Called from open() only: a mid-dialog project switch
   * deliberately does NOT re-resolve, leaving per-launch control with the user
   * once the dialog is open.
   */
  function applyDefaults(): void {
    const p = st.state.projects.find((p) => p.id === projectSel.value);
    modelSel.value = resolveModel(p?.defaultModel);
    setPerm(resolvePerm(p?.defaultMode));
  }

  /**
   * The ONE composition path for BOTH modes — the POST body reads only this.
   * null = nothing to spawn (blank custom command).
   */
  function currentSpawn(): SpawnSpec | null {
    if (customMode) return parseCustomCommand(cmdInput.value);
    return {
      command: 'claude',
      args: composeArgs(modelSel.value, perm, continueLast, currentEffort()),
    };
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
  st.subscribe((kind) => {
    if (kind === 'projects' && !scrim.hidden) populateProjects();
  });

  async function launch(): Promise<void> {
    err.hidden = true;
    const projectId = projectSel.value;
    if (projectId === '') {
      showErr('pick a project first');
      return;
    }
    const spawn = currentSpawn();
    if (spawn === null) {
      showErr('type a command');
      cmdInput.focus();
      return;
    }
    // What the user asked for, in SHAPE only: the custom command line is
    // whatever they typed and never reaches a log line — only how many words
    // it had. The project appears by NAME, never by path.
    const effort = currentEffort();
    const projectLabel = st.state.projects.find((p) => p.id === projectId)?.name ?? '?';
    log.info(
      customMode
        ? `launch: project=${projectLabel} custom=yes words=${spawn.args.length + 1}`
        : `launch: project=${projectLabel} custom=no model=${modelSel.value} effort=${effort} ` +
          `mode=${perm} continue=${continueLast}`,
    );
    // Sized to the focused pane as a starting hint; the attach flow
    // reconciles the PTY with the new tab's real dimensions (same contract
    // as a history resume).
    const dims = focusedPaneDims();
    const title = nameInput.value.trim();
    go.disabled = true;
    try {
      const info = await api.createSession({
        projectId,
        command: spawn.command,
        args: spawn.args,
        ...(title !== '' ? { title } : {}),
        cols: dims.cols,
        rows: dims.rows,
      });
      log.info(`launch ok: session=${info.id} name=${title !== '' ? 'given' : 'project default'}`);
      st.upsertSession(info); // gives the session its own (new) tab
      st.focusSession(info.id); // ... and makes that tab active + focused
      close();
      requestTerminalFocus();
    } catch (e) {
      log.warn(`launch failed: ${e instanceof Error ? e.message : String(e)}`);
      showErr(e instanceof Error ? e.message : String(e));
    } finally {
      go.disabled = st.state.projects.length === 0;
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
    populateProjects();
    if (opts?.projectId !== undefined && st.state.projects.some((p) => p.id === opts.projectId)) {
      // Explicit project intent (projects-drawer row `+`) means "a claude
      // session for that project" — exit custom mode so a stale custom command
      // can't hijack the launch, and force-select that project BEFORE defaults
      // resolve so its defaultModel/defaultMode are layered on.
      setCustomMode(false);
      projectSel.value = opts.projectId;
      syncNamePlaceholder();
    }
    // Resolve model + permission once against the now-settled selected project
    // (the forced project above, or populateProjects()'s auto-selected first
    // project on a plain open). Effort and continue reset every open; a plain
    // open otherwise leaves the previous mode and the custom command text as
    // the user left them.
    applyDefaults();
    effortSel.value = 'default';
    continueLast = false;
    syncContinue();
    scrim.hidden = false;
    nameInput.focus();
  }

  function close(): void {
    if (scrim.hidden) return;
    scrim.hidden = true;
    // Return the keyboard where it came from — opening from a terminal
    // restores the terminal; otherwise fall back to the focused pane.
    if (restoreTo !== null && restoreTo.isConnected) restoreTo.focus();
    else requestTerminalFocus();
    restoreTo = null;
  }

  ctl = { open, close, isOpen: () => !scrim.hidden };
}
