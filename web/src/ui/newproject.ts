/**
 * New Project dialog (Phase 2a) — the modal that CREATES projects, replacing
 * the old inline add-project form in the projects drawer. Two modes only:
 *
 *   - Blank local: PROJECT NAME + LOCAL PATH (Browse → folder picker) + an
 *     "Initialize git repo" checkbox (default CHECKED → `gitInit`). POSTs
 *     createLocalProject ({ create: true, gitInit }). The path auto-suggests
 *     `<home>/projects/<name>` as the name is typed (home resolved live from
 *     GET /api/fs/list — never hardcoded); Browse overrides it.
 *   - Clone repo: GIT URL + DESTINATION (optional; Browse → folder picker;
 *     default `<home>/projects/<repoBasename>`) + a live `$ git clone <url>
 *     <dest>` preview. POSTs cloneProject. Clone is a SLOW synchronous call —
 *     an honest indeterminate "cloning…" spinner shows while awaiting (NOT a
 *     fake percentage); success adds the project + closes, failure renders the
 *     backend error inline.
 *
 * Built entirely in the established dialog language: the sanctioned gradient
 * header (launch-dialog idioms), the ink-well command preview (`.launch-cmd`),
 * the settings checkbox row (`.status-row`), `.form-err` for errors. A clean
 * seam is left for the 2b "GitHub" tab — the mode row is a plain list; adding a
 * third entry + panel is all it takes. No GitHub / OAuth here.
 *
 * Untrusted display: every path (fs-derived) and url basename renders via
 * textContent — never innerHTML.
 */
import type { CreateProjectRequest, PermissionMode } from '../../../shared/protocol.ts';
import * as api from '../api.ts';
import * as st from '../state.ts';
import { el, button, trapTab } from './util.ts';
import { openFolderPicker } from './picker.ts';
import { MODELS } from './launch-args.ts';
import {
  parentDir,
  suggestProjectPath,
  suggestDestPath,
} from './newproject-model.ts';

type Mode = 'blank' | 'clone';

interface NewProjectCtl {
  open(): void;
  close(): void;
  isOpen(): boolean;
}

let ctl: NewProjectCtl | null = null;

export function openNewProjectDialog(): void {
  ctl?.open();
}

export function closeNewProjectDialog(): void {
  ctl?.close();
}

export function isNewProjectDialogOpen(): boolean {
  return ctl?.isOpen() ?? false;
}

// Home + `<home>/projects` are resolved ONCE from GET /api/fs/list (the default
// path is $HOME) and cached across opens — no hardcoded `/home/...`.
let homeDir: string | null = null;
let projectsDir: string | null = null; // `<home>/projects` if it exists, else null

export function initNewProjectDialog(modalHost: HTMLElement): void {
  // ---- scrim + card --------------------------------------------------------
  const scrim = el('div', 'modal-scrim launch-scrim');
  scrim.hidden = true;
  const modal = el('div', 'modal np-modal');
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-label', 'new project');

  // ---- header (sanctioned gradient) ----------------------------------------
  const hd = el('header', 'launch-hd');
  const tile = el('div', 'launch-tile');
  tile.setAttribute('aria-hidden', 'true');
  tile.append(el('span', 'np-glyph', '◧'));
  const titles = el('div', 'launch-titles');
  titles.append(
    el('div', 'launch-title', 'New project'),
    el('div', 'launch-sub', 'create locally · clone a repo'),
  );
  const closeX = button('launch-x', '×', () => close());
  closeX.setAttribute('aria-label', 'close new project dialog');
  closeX.title = 'close (esc)';
  hd.append(tile, titles, el('span', 'launch-gap'), closeX);

  // ---- mode tabs (two only; a clean seam for the 2b GitHub tab) -------------
  const tabsRow = el('div', 'np-tabs');
  tabsRow.setAttribute('role', 'group');
  tabsRow.setAttribute('aria-label', 'project source');
  const tabDefs: { mode: Mode; label: string }[] = [
    { mode: 'blank', label: 'Blank local' },
    { mode: 'clone', label: 'Clone repo' },
  ];
  const tabBtns = new Map<Mode, HTMLButtonElement>();
  for (const t of tabDefs) {
    const b = button('np-tab', t.label, () => setMode(t.mode));
    tabBtns.set(t.mode, b);
    tabsRow.append(b);
  }

  // ---- body (reuses the launch-dialog scroll body) --------------------------
  const body = el('div', 'launch-body');

  // Blank panel -------------------------------------------------------------
  const blankPanel = el('div', 'np-panel');

  const nameField = el('label', 'launch-field');
  nameField.append(el('span', 'launch-lb', 'Project name'));
  const nameInput = el('input');
  nameInput.name = 'name';
  nameInput.placeholder = 'my-project';
  nameInput.spellcheck = false;
  nameInput.autocomplete = 'off';
  nameField.append(nameInput);

  const blankPathField = el('div', 'launch-field');
  blankPathField.append(el('span', 'launch-lb', 'Local path'));
  const blankPathRow = button('np-pathrow', '', () => openBlankPicker());
  blankPathRow.setAttribute('aria-label', 'choose the local path — opens the folder picker');
  const blankPathGlyph = el('span', 'np-pathrow-glyph', '⌕');
  blankPathGlyph.setAttribute('aria-hidden', 'true');
  const blankPathText = el('span', 'np-pathrow-path is-suggested', '');
  blankPathRow.append(blankPathGlyph, blankPathText, el('span', 'np-pathrow-browse', 'Browse'));
  blankPathField.append(blankPathRow);

  // "Initialize git repo" — default CHECKED (maps to gitInit). Reuses the
  // settings checkbox idiom (16px square, ✓ in --term-bg on --acc, aria-pressed).
  let gitInit = true;
  const gitRow = button('status-row np-gitrow', '', () => {
    gitInit = !gitInit;
    syncGit();
  });
  const gitBox = el('span', 'status-box');
  gitBox.setAttribute('aria-hidden', 'true');
  gitRow.append(
    gitBox,
    el('span', 'status-lb', 'Initialize git repo'),
    el('span', 'status-sample', 'git init'),
  );
  gitRow.title = 'run git init in the new project directory';

  function syncGit(): void {
    gitRow.setAttribute('aria-pressed', gitInit ? 'true' : 'false');
    gitBox.textContent = gitInit ? '✓' : '';
  }

  // Optional per-project launch defaults — mirror the settings panel's
  // "no default" select idiom (blank → the field is OMITTED from the request).
  // The dialog's own .launch-field / .launch-lb styling; PermissionMode here is
  // the TWO-value PROJECT default ('standard' | 'skip-permissions'), not the
  // four CLI launch modes.
  const modelField = el('label', 'launch-field');
  const modelLb = el('span', 'launch-lb', 'Default model ');
  modelLb.append(el('span', 'np-optional', '(optional)'));
  modelField.append(modelLb);
  const modelSel = el('select');
  modelSel.name = 'defaultModel';
  const modelNone = el('option', '', 'no default');
  modelNone.value = '';
  modelSel.append(modelNone);
  for (const m of MODELS) {
    const opt = el('option', '', m);
    opt.value = m;
    modelSel.append(opt);
  }
  modelField.append(modelSel);

  const modeField = el('label', 'launch-field');
  const modeLb = el('span', 'launch-lb', 'Default permission mode ');
  modeLb.append(el('span', 'np-optional', '(optional)'));
  modeField.append(modeLb);
  const modeSel = el('select');
  modeSel.name = 'defaultMode';
  const modeNone = el('option', '', 'no default');
  modeNone.value = '';
  modeSel.append(modeNone);
  const modeOpts: { value: PermissionMode; label: string }[] = [
    { value: 'standard', label: 'standard' },
    { value: 'skip-permissions', label: 'skip permissions (danger)' },
  ];
  for (const o of modeOpts) {
    const opt = el('option', '', o.label);
    opt.value = o.value;
    modeSel.append(opt);
  }
  modeField.append(modeSel);

  const blankCaption = el(
    'div',
    'np-caption',
    'creates the folder and registers it under Projects',
  );

  blankPanel.append(nameField, blankPathField, gitRow, modelField, modeField, blankCaption);

  // Clone panel -------------------------------------------------------------
  const clonePanel = el('div', 'np-panel');
  clonePanel.hidden = true;

  const urlField = el('label', 'launch-field');
  urlField.append(el('span', 'launch-lb', 'Git URL'));
  const urlInput = el('input');
  urlInput.name = 'url';
  urlInput.placeholder = 'https://github.com/owner/repo.git';
  urlInput.spellcheck = false;
  urlInput.autocomplete = 'off';
  urlField.append(urlInput);

  const destField = el('div', 'launch-field');
  const destLb = el('span', 'launch-lb', 'Destination ');
  destLb.append(el('span', 'np-optional', '(optional)'));
  destField.append(destLb);
  const destRow = button('np-pathrow', '', () => openClonePicker());
  destRow.setAttribute('aria-label', 'choose the clone destination — opens the folder picker');
  const destGlyph = el('span', 'np-pathrow-glyph', '⌕');
  destGlyph.setAttribute('aria-hidden', 'true');
  const destText = el('span', 'np-pathrow-path is-suggested', '');
  destRow.append(destGlyph, destText, el('span', 'np-pathrow-browse', 'Browse'));
  destField.append(destRow);

  const clonePreview = el('div', 'launch-cmd');

  clonePanel.append(urlField, destField, clonePreview);

  const err = el('div', 'form-err');
  err.setAttribute('role', 'alert');
  err.hidden = true;

  body.append(blankPanel, clonePanel, err);

  // ---- footer --------------------------------------------------------------
  const ft = el('footer', 'launch-ft');
  const note = el('span', 'launch-note', 'registers under Projects');
  const busy = el('span', 'np-busy');
  busy.hidden = true;
  const busySpin = el('span', 'np-spinner');
  busySpin.setAttribute('aria-hidden', 'true');
  busy.append(busySpin, el('span', '', 'cloning… this can take a while'));
  const cancel = button('btn', 'Cancel', () => close());
  const primary = button('btn-go', 'Create project', () => void submit());
  ft.append(note, busy, el('span', 'launch-gap'), cancel, primary);

  modal.append(hd, tabsRow, body, ft);
  scrim.append(modal);
  scrim.addEventListener('mousedown', (e) => {
    if (e.target === scrim) close();
  });
  trapTab(modal);
  modalHost.append(scrim);

  // ---- state ---------------------------------------------------------------
  let mode: Mode = 'blank';
  let blankTouched = false; // user browsed → path no longer auto-tracks the name
  let blankChosen = '';
  let cloneTouched = false;
  let cloneChosen = '';
  let cloning = false;

  function effectiveBlankPath(): string {
    return blankTouched ? blankChosen : suggestProjectPath(homeDir, nameInput.value);
  }

  function effectiveClonePath(): string {
    return cloneTouched ? cloneChosen : suggestDestPath(homeDir, urlInput.value);
  }

  function renderBlankPath(): void {
    const p = effectiveBlankPath();
    if (p !== '') {
      blankPathText.textContent = p;
      blankPathText.classList.toggle('is-suggested', !blankTouched);
    } else {
      blankPathText.textContent =
        homeDir !== null ? `${homeDir}/projects/…` : 'Browse to choose a location';
      blankPathText.classList.add('is-suggested');
    }
  }

  function renderClonePath(): void {
    const p = effectiveClonePath();
    if (p !== '') {
      destText.textContent = p;
      destText.classList.toggle('is-suggested', !cloneTouched);
    } else {
      destText.textContent =
        homeDir !== null ? `${homeDir}/projects/<repo>` : 'Browse to choose a location';
      destText.classList.add('is-suggested');
    }
  }

  function renderClonePreview(): void {
    const url = urlInput.value.trim();
    if (url === '') {
      clonePreview.textContent = '$ git clone <url>';
      return;
    }
    const dest = effectiveClonePath();
    clonePreview.textContent = `$ git clone ${url}${dest !== '' ? ` ${dest}` : ''}`;
  }

  function setMode(next: Mode): void {
    mode = next;
    for (const [m, b] of tabBtns) {
      const on = m === next;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    blankPanel.hidden = next !== 'blank';
    clonePanel.hidden = next !== 'clone';
    primary.textContent = next === 'clone' ? 'Clone ▸' : 'Create project';
    err.hidden = true;
    (next === 'blank' ? nameInput : urlInput).focus();
  }

  nameInput.addEventListener('input', renderBlankPath);
  urlInput.addEventListener('input', () => {
    renderClonePath();
    renderClonePreview();
  });

  // ---- folder picker openers -----------------------------------------------
  function openBlankPicker(): void {
    const p = effectiveBlankPath();
    openFolderPicker({
      modalHost,
      title: 'Select project folder',
      initial: blankTouched && p !== '' ? parentDir(p) : (projectsDir ?? homeDir ?? undefined),
      home: homeDir,
      projectsDir,
      restoreTo: blankPathRow,
      onSelect: (chosen) => {
        blankTouched = true;
        blankChosen = chosen;
        renderBlankPath();
      },
    });
  }

  function openClonePicker(): void {
    const p = effectiveClonePath();
    openFolderPicker({
      modalHost,
      title: 'Select destination folder',
      initial: cloneTouched && p !== '' ? parentDir(p) : (projectsDir ?? homeDir ?? undefined),
      home: homeDir,
      projectsDir,
      restoreTo: destRow,
      onSelect: (chosen) => {
        cloneTouched = true;
        cloneChosen = chosen;
        renderClonePath();
        renderClonePreview();
      },
    });
  }

  // ---- submit --------------------------------------------------------------
  function showErr(msg: string): void {
    err.textContent = msg;
    err.hidden = false;
  }

  async function submit(): Promise<void> {
    if (cloning) return;
    err.hidden = true;
    if (mode === 'blank') {
      await submitBlank();
    } else {
      await submitClone();
    }
  }

  async function submitBlank(): Promise<void> {
    const name = nameInput.value.trim();
    if (name === '') {
      showErr('project name is required');
      nameInput.focus();
      return;
    }
    const path = effectiveBlankPath();
    if (path === '') {
      showErr('choose a location with Browse');
      return;
    }
    // Optional per-project defaults: blank/"no default" → omit the field.
    const body: Omit<CreateProjectRequest, 'create'> = { name, path, gitInit };
    const modelVal = modelSel.value;
    if (modelVal !== '') body.defaultModel = modelVal;
    const modeVal = modeSel.value;
    if (modeVal === 'standard' || modeVal === 'skip-permissions') body.defaultMode = modeVal;
    primary.disabled = true;
    try {
      const p = await api.createLocalProject(body);
      st.setProjects([...st.state.projects, p]);
      close();
    } catch (e) {
      showErr(e instanceof Error ? e.message : String(e));
    } finally {
      primary.disabled = false;
    }
  }

  async function submitClone(): Promise<void> {
    const url = urlInput.value.trim();
    if (url === '') {
      showErr('a git URL is required');
      urlInput.focus();
      return;
    }
    const dest = effectiveClonePath();
    if (dest === '') {
      showErr('choose a destination with Browse');
      return;
    }
    setCloning(true);
    try {
      const p = await api.cloneProject({ url, dest });
      st.setProjects([...st.state.projects, p]);
      setCloning(false);
      close();
    } catch (e) {
      setCloning(false);
      showErr(e instanceof Error ? e.message : String(e));
    }
  }

  /** Honest indeterminate busy state — disable everything, show the spinner. */
  function setCloning(on: boolean): void {
    cloning = on;
    busy.hidden = !on;
    note.hidden = on;
    primary.disabled = on;
    cancel.disabled = on;
    closeX.disabled = on;
    for (const b of tabBtns.values()) b.disabled = on;
    urlInput.disabled = on;
    destRow.disabled = on;
  }

  // ---- open / close --------------------------------------------------------
  let restoreTo: HTMLElement | null = null;

  function open(): void {
    if (!scrim.hidden) return;
    restoreTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // Reset to a clean blank-mode form each open.
    nameInput.value = '';
    urlInput.value = '';
    blankTouched = false;
    blankChosen = '';
    cloneTouched = false;
    cloneChosen = '';
    gitInit = true;
    syncGit();
    modelSel.value = '';
    modeSel.value = '';
    err.hidden = true;
    setMode('blank');
    renderBlankPath();
    renderClonePath();
    renderClonePreview();
    scrim.hidden = false;
    nameInput.focus();
    // Resolve home (+ whether ~/projects exists) once, then refresh suggestions.
    void ensureHome().then(() => {
      if (scrim.hidden) return;
      renderBlankPath();
      renderClonePath();
      renderClonePreview();
    });
  }

  function close(): void {
    if (scrim.hidden || cloning) return; // never close mid-clone
    scrim.hidden = true;
    if (restoreTo !== null && restoreTo.isConnected) restoreTo.focus();
    restoreTo = null;
  }

  ctl = { open, close, isOpen: () => !scrim.hidden };
}

/** Resolve real $HOME + whether `<home>/projects` exists, from ONE fs/list. Cached. */
async function ensureHome(): Promise<void> {
  if (homeDir !== null) return;
  try {
    const res = await api.fsList(); // no path → backend's $HOME
    homeDir = res.path;
    projectsDir = res.dirs.includes('projects')
      ? res.path === '/'
        ? '/projects'
        : `${res.path}/projects`
      : null;
  } catch {
    // Leave home null — Browse still works (server $HOME default); the caller
    // shows a "Browse to choose a location" hint until a path is picked.
  }
}
