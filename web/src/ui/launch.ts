/**
 * Launch dialog (handoff §8) — the modal that creates sessions, replacing
 * the launcher-as-tab (settled user decision 2026-07-20).
 *
 * Structure: gradient header (logo tile · "Launch session" · subtitle · ×),
 * preset chips (deep work / quick fix / yolo — each sets model + permission
 * + resume), a 2×2 field grid (session name, project, model, resume), four
 * permission-mode cards with plain-language descriptions, and a live
 * command preview. `composeArgs()` is the ONE argv composer: the preview
 * renders exactly what launch() sends — never two code paths.
 *
 * Resume has exactly two options: start fresh, or `--continue`. There is
 * deliberately NO per-id `--resume <id>` (fiction cut: the journal stores
 * our session ids, not Claude conversation ids).
 *
 * A fourth chip — `custom · any command` — is a MODE, not a one-shot
 * preset (user decision 2026-07-20, restoring the launcher tab's
 * configurable command + args): it reveals a mono free-text command field
 * (whitespace-split argv, no shell) and disables the claude-specific
 * fields. `currentSpawn()` is the one composition path for BOTH modes —
 * preview and POST body cannot diverge.
 *
 * Entry points (all funnel here): topbar `+ New session`, tab-strip ghost
 * `+`, projects-drawer per-row `+` (pre-set to that project), the
 * empty-state button, and Ctrl+Alt+T. The new session opens in its own new
 * tab and becomes active. While closed, the dialog touches no keyboard
 * input — the terminal owns the keys.
 */
import * as api from '../api.ts';
import * as st from '../state.ts';
import { el, button, trapTab } from './util.ts';
import { focusedPaneDims, requestTerminalFocus } from './panes.ts';
import {
  MODELS,
  PERMS,
  CHIPS,
  composeArgs,
  parseCustomCommand,
  previewLine,
  resolveModel,
  resolvePerm,
} from './launch-args.ts';
import type { Perm, Resume, SpawnSpec } from './launch-args.ts';
import { getDefaults } from './defaults.ts';
import { armStartupCommand } from './startup.ts';

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
  modal.setAttribute('aria-label', 'launch session');

  // ---- header (gradient band) ----------------------------------------------
  const hd = el('header', 'launch-hd');
  const tile = el('div', 'launch-tile');
  tile.setAttribute('aria-hidden', 'true');
  tile.append(el('span', 'logo-glyph', '>_'));
  const titles = el('div', 'launch-titles');
  titles.append(
    el('div', 'launch-title', 'Launch session'),
    el('div', 'launch-sub', 'spawns a real pty on the backend · survives hidden panes'),
  );
  const closeBtn = button('launch-x', '×', () => close());
  closeBtn.setAttribute('aria-label', 'close launch dialog');
  closeBtn.title = 'close (esc)';
  hd.append(tile, titles, el('span', 'launch-gap'), closeBtn);

  // ---- body ----------------------------------------------------------------
  const body = el('div', 'launch-body');

  const chipRow = el('div', 'launch-chips');
  for (const c of CHIPS) {
    const chip = button(`chip-pill${c.danger ? ' is-danger' : ''}`, c.label, () => {
      setCustomMode(false); // presets are claude config — leave custom mode
      modelSel.value = c.model;
      setPerm(c.perm);
      resumeSel.value = c.resume;
      updatePreview();
    });
    chip.title = 'preset: sets model, permission mode and resume';
    chipRow.append(chip);
  }
  // The fourth chip is a MODE toggle, not a one-shot preset: any command,
  // whitespace-split argv (restores the launcher tab's custom capability).
  const customChip = button('chip-pill', 'custom · any command', () => {
    setCustomMode(!customMode);
    updatePreview();
  });
  customChip.title = 'launch any command instead of claude';
  customChip.setAttribute('aria-pressed', 'false');
  chipRow.append(customChip);

  // 2×2 fields: session name · project · model · resume.
  const fields = el('div', 'launch-fields');

  const nameField = el('label', 'launch-field');
  nameField.append(el('span', 'launch-lb', 'Session name'));
  const nameInput = el('input');
  nameInput.name = 'title';
  nameInput.placeholder = 'auto from project';
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

  const resumeField = el('label', 'launch-field');
  resumeField.append(el('span', 'launch-lb', 'Resume'));
  const resumeSel = el('select');
  resumeSel.name = 'resume';
  for (const [v, label] of [
    ['fresh', 'start fresh'],
    ['continue', 'continue last conversation (--continue)'],
  ] as const) {
    const opt = el('option', '', label);
    opt.value = v;
    resumeSel.append(opt);
  }
  resumeField.append(resumeSel);

  fields.append(nameField, projField, modelField, resumeField);

  // Custom-mode command field (hidden in claude mode): full-width, mono,
  // whitespace-split argv — the old launcher's field, in the dialog voice.
  const cmdField = el('label', 'launch-field launch-custom');
  cmdField.hidden = true;
  const cmdLb = el('span', 'launch-lb', 'Command ');
  cmdLb.append(el('em', 'field-hint', 'whitespace split — no quoting, no shell'));
  const cmdInput = el('input');
  cmdInput.name = 'command';
  cmdInput.placeholder = 'htop --tree';
  cmdInput.spellcheck = false;
  cmdField.append(cmdLb, cmdInput);

  // Permission mode: 2×2 selectable cards.
  const permWrap = el('div', 'launch-field');
  permWrap.append(el('span', 'launch-lb', 'Permission mode'));
  const permGrid = el('div', 'perm-grid');
  permGrid.setAttribute('role', 'group');
  permGrid.setAttribute('aria-label', 'permission mode');
  let perm: Perm = 'default';
  const permButtons = new Map<Perm, HTMLButtonElement>();
  for (const p of PERMS) {
    const card = button(`perm-card${p.danger ? ' is-danger' : ''}`, '', () => {
      setPerm(p.mode);
      updatePreview();
    });
    card.append(el('span', 'perm-mode', p.mode), el('span', 'perm-desc', p.desc));
    if (p.danger) card.title = 'runs claude with all permission prompts disabled';
    permButtons.set(p.mode, card);
    permGrid.append(card);
  }
  permWrap.append(permGrid);

  function setPerm(mode: Perm): void {
    perm = mode;
    for (const [m, b] of permButtons) {
      b.classList.toggle('is-sel', m === mode);
      b.setAttribute('aria-pressed', m === mode ? 'true' : 'false');
    }
  }
  setPerm('default');

  /**
   * Custom mode: the command field appears and the claude-specific fields
   * (model, resume, permission cards) go visually AND functionally disabled
   * — the old launcher's is-disabled pattern. Exits: any preset chip, or
   * toggling the custom chip off.
   */
  let customMode = false;
  function setCustomMode(on: boolean): void {
    if (customMode === on) return;
    customMode = on;
    customChip.classList.toggle('is-on', on);
    customChip.setAttribute('aria-pressed', on ? 'true' : 'false');
    cmdField.hidden = !on;
    modelSel.disabled = on;
    resumeSel.disabled = on;
    modelField.classList.toggle('is-disabled', on);
    resumeField.classList.toggle('is-disabled', on);
    permGrid.classList.toggle('is-disabled', on);
    for (const b of permButtons.values()) b.disabled = on;
    if (on) cmdInput.focus();
  }

  // Command preview: always equals the argv launch() will send.
  const preview = el('div', 'launch-cmd');

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

  body.append(chipRow, fields, cmdField, permWrap, preview, err, none);

  // ---- footer --------------------------------------------------------------
  const ft = el('footer', 'launch-ft');
  const cancel = button('btn', 'Cancel', () => close());
  const go = button('btn-go', 'Launch ▸', () => void launch());
  go.title = 'spawn the session — it opens in a new tab';
  ft.append(el('span', 'launch-note', 'opens in a new tab'), el('span', 'launch-gap'), cancel, go);

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
  }

  /**
   * Resolve the pre-selected model + permission ONCE per open through the
   * unit-tested precedence chain (`resolveModel`/`resolvePerm` in
   * launch-args.ts, documented in web/DESIGN.md): explicit project default >
   * global settings default > hardcoded fallback. The selected project is
   * whatever `projectSel.value` currently points at — a project-intent open
   * force-selects its project before this runs; a plain open uses
   * populateProjects()'s auto-selected first project. Called from open() only:
   * a mid-dialog project switch deliberately does NOT re-resolve, leaving
   * per-launch control with the user once the dialog is open.
   */
  function applyDefaults(): void {
    const g = getDefaults();
    const p = st.state.projects.find((p) => p.id === projectSel.value);
    modelSel.value = resolveModel(g, p?.defaultModel);
    setPerm(resolvePerm(g, p?.defaultMode));
  }

  /**
   * The ONE composition path for BOTH modes — preview and POST body read
   * only this. null = nothing to spawn (blank custom command).
   */
  function currentSpawn(): SpawnSpec | null {
    if (customMode) return parseCustomCommand(cmdInput.value);
    return { command: 'claude', args: composeArgs(modelSel.value, perm, resumeSel.value as Resume) };
  }

  function updatePreview(): void {
    const spawn = currentSpawn();
    const project = st.state.projects.find((p) => p.id === projectSel.value);
    const cwd = project !== undefined ? project.path : '—';
    // '—' is the app's empty-value glyph (cwd/uptime use it too).
    preview.textContent = `${spawn !== null ? previewLine(spawn) : '$ —'}\n  cwd: ${cwd}`;
  }

  projectSel.addEventListener('change', () => {
    // A mid-dialog project switch does NOT re-resolve model/permission —
    // defaults settle once per open (applyDefaults); per-launch control stays
    // with the user. Only the cwd line + preview follow the new project.
    updatePreview();
  });
  modelSel.addEventListener('change', updatePreview);
  resumeSel.addEventListener('change', updatePreview);
  cmdInput.addEventListener('input', updatePreview);

  // ONE permanent subscription (state.ts has no unsubscribe — never bind per
  // open): keeps the project list and cwd line fresh while the dialog shows.
  st.subscribe((kind) => {
    if (kind === 'projects' && !scrim.hidden) {
      populateProjects();
      updatePreview();
    }
  });

  async function launch(): Promise<void> {
    err.hidden = true;
    const projectId = projectSel.value;
    if (projectId === '') {
      showErr('pick a project (add one in the projects panel)');
      return;
    }
    const spawn = currentSpawn();
    if (spawn === null) {
      showErr('command is required for the custom preset');
      cmdInput.focus();
      return;
    }
    // Sized to the focused pane as a starting hint; the attach flow
    // reconciles the PTY with the new tab's real dimensions (same contract
    // as the previous-run relaunch).
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
      st.upsertSession(info); // gives the session its own (new) tab
      st.focusSession(info.id); // ... and makes that tab active + focused
      // Auto-run startup command: claude-mode launches ONLY (a custom bash
      // session auto-typing a slash command is nonsense). This window armed
      // it, so only it types the line — once, on the session's first output.
      if (!customMode) armStartupCommand(info.id, getDefaults().startupCommand ?? '');
      close();
      requestTerminalFocus();
    } catch (e) {
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
    }
    // Resolve model + permission once against the now-settled selected project
    // (the forced project above, or populateProjects()'s auto-selected first
    // project on a plain open). A plain open otherwise leaves the previous mode,
    // custom command text, and resume choice as the user left them — only those
    // persist across opens; model + permission are re-resolved every time.
    applyDefaults();
    updatePreview();
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
