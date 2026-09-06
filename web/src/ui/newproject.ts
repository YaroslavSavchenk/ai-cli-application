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
 *     default `<home>/projects/<repoBasename>`) + a live three-line summary in
 *     the ink well — `copies` / the pasted url / `into folder: <dest>`, each
 *     unfilled value falling back to `—` (the argv-shaped command preview was
 *     dropped by the UI copy rule, 2026-07-25). POSTs cloneProject. Clone is a
 *     SLOW synchronous call — an honest indeterminate "cloning…" spinner shows
 *     while awaiting (NOT a fake percentage); success adds the project +
 *     closes, failure renders the backend error inline.
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
import { createGithubPanel } from './github.ts';
import {
  parentDir,
  suggestProjectPath,
  suggestDestPath,
} from './newproject-model.ts';

type Mode = 'blank' | 'clone' | 'github';

interface NewProjectCtl {
  open(mode?: Mode): void;
  close(): void;
  isOpen(): boolean;
}

let ctl: NewProjectCtl | null = null;

/** Open the dialog, optionally straight onto a given tab (the GitHub chip uses 'github'). */
export function openNewProjectDialog(mode?: Mode): void {
  ctl?.open(mode);
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
    { mode: 'github', label: 'GitHub' },
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
    el('span', 'status-sample', 'starts version history'),
  );
  gitRow.title = 'start tracking changes in the new project folder';

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
  // Only the danger value is offered (user's call, 2026-07-25): `standard` is
  // behaviourally identical to "no default" (permFromDefaultMode returns null
  // for it), so showing it promised a choice it does not make — and relabelling
  // it "Always ask" would promise enforcement the value does not deliver. The
  // stored value is untouched: a project.json that already carries `standard`
  // keeps being accepted (see submitBlank), no schema/server change.
  // Lowercase to match this select's own `no default` and the sibling
  // Default-model select — the settings-panel select idiom. The launch dialog's
  // mode segments are unaffected (they carry their own short labels, PERM_SHORT).
  const modeOpts: { value: PermissionMode; label: string }[] = [
    { value: 'skip-permissions', label: 'never ask · dangerous' },
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

  // GitHub panel (Phase 2b + 2c) — the third tab. All GitHub UI + the status
  // controller live in ui/github.ts; this dialog only mounts the panel and
  // tells it when its tab is active (which drives the poll cadence). The 2c
  // "open" action on an already-cloned repo hands back its Project: close the
  // dialog and reveal it in the Projects drawer.
  const githubPanel = createGithubPanel({
    onOpenProject: () => {
      close();
      st.openDrawer('projects');
    },
  });
  githubPanel.el.hidden = true;

  const err = el('div', 'form-err');
  err.setAttribute('role', 'alert');
  err.hidden = true;

  body.append(blankPanel, clonePanel, githubPanel.el, err);

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

  /**
   * The ink well, one fact per `.launch-sum-line` (PROJECT-SCOPE
   * "No commands, flags, or code in the UI", 2026-07-25): what this will do,
   * the pasted URL, and where it lands. The URL stays verbatim — it is the
   * user's own input, not code — and both values fall back to '—', the app's
   * empty-value glyph, so an unfilled field never reads as a real value.
   * Untrusted text via textContent (el), never innerHTML.
   */
  function renderClonePreview(): void {
    const url = urlInput.value.trim();
    const dest = effectiveClonePath();
    clonePreview.replaceChildren(
      el('div', 'launch-sum-line', 'copies'),
      el('div', 'launch-sum-line', url !== '' ? url : '—'),
      el('div', 'launch-sum-line', `into folder: ${dest !== '' ? dest : '—'}`),
    );
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
    githubPanel.el.hidden = next !== 'github';
    githubPanel.setActive(next === 'github');
    // GitHub is VIEW-ONLY here (no create action) — the footer primary is
    // hidden; the panel carries its own Connect/Disconnect controls.
    primary.hidden = next === 'github';
    primary.textContent = next === 'clone' ? 'Clone ▸' : 'Create project';
    note.textContent =
      next === 'clone'
        ? 'clones, then registers under Projects'
        : next === 'github'
          ? 'browse your GitHub repositories'
          : 'registers under Projects';
    err.hidden = true;
    // github: the panel handles its own focus (Connect / search / Cancel).
    if (next === 'blank') nameInput.focus();
    else if (next === 'clone') urlInput.focus();
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

  function open(initialMode: Mode = 'blank'): void {
    if (!scrim.hidden) {
      setMode(initialMode); // already open (e.g. GitHub chip) → just switch tabs
      return;
    }
    restoreTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // Reset to a clean form each open.
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
    renderBlankPath();
    renderClonePath();
    renderClonePreview();
    scrim.hidden = false;
    setMode(initialMode); // unhidden first so the per-mode focus lands
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
    githubPanel.setActive(false); // pause the GitHub poll cadence
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
