/**
 * Folder picker modal — wired to the REAL backend fs endpoints (GET
 * /api/fs/list + POST /api/fs/mkdir), NO faked tree. Reused by the New Project
 * dialog's blank LOCAL PATH and clone DESTINATION rows.
 *
 * Anatomy (in the established dialog language): the sanctioned gradient header
 * (the shared `launch-hd` dialog header the New Project, settings and restart
 * dialogs also wear; the New session dialog left it for its own `ns-` chrome
 * in Nocturne A4), a breadcrumb + "up one level" nav,
 * quick zones (Home / ~/projects when it exists / Root), the directory list
 * (folders only, from `dirs`, via the existing `.dirlist`/`.dir-btn`), a
 * "new folder" input + button (POST /api/fs/mkdir → navigate into it), and a
 * "Select folder" that returns the CURRENT directory to the opener.
 *
 * Honest states only: fs/list errors (403 permission / 404 not-a-directory)
 * render inline; an empty directory reads "empty folder". All directory names
 * and paths are UNTRUSTED display text → textContent, never innerHTML.
 *
 * Created on open, removed on close (like the old dir browser). One picker at a
 * time; it may open OVER the New Project dialog (appended last → paints on top
 * at the same modal z). Escape is dispatched centrally from main.ts.
 */
import * as api from '../api.ts';
import { el, button, trapTab } from './util.ts';
import { breadcrumbs, parentDir } from './newproject-model.ts';

export interface PickerOpts {
  modalHost: HTMLElement;
  /** Header title, e.g. "Select project folder" / "Select destination folder". */
  title: string;
  /** Starting absolute dir; undefined → the backend's $HOME default. */
  initial?: string;
  /** Real home (fs/list default), for the Home quick zone; undefined → server $HOME. */
  home?: string | null;
  /** `<home>/projects` when it exists, for the ~/projects quick zone; null → hidden. */
  projectsDir?: string | null;
  /** Focus target restored on close (the row button that opened the picker). */
  restoreTo?: HTMLElement | null;
  /** Called with the chosen absolute directory when "Select folder" is pressed. */
  onSelect(path: string): void;
}

let scrim: HTMLElement | null = null;
let restore: HTMLElement | null = null;

export function isFolderPickerOpen(): boolean {
  return scrim !== null;
}

export function closeFolderPicker(): void {
  if (scrim === null) return;
  scrim.remove();
  scrim = null;
  const back = restore;
  restore = null;
  if (back !== null && back.isConnected) back.focus();
}

export function openFolderPicker(opts: PickerOpts): void {
  if (scrim !== null) return; // one picker at a time
  restore = opts.restoreTo ?? null;

  scrim = el('div', 'modal-scrim');
  const modal = el('div', 'modal pk-modal');
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-label', opts.title);

  // ---- header (sanctioned gradient, the shared `launch-hd` dialog header) ----
  const hd = el('header', 'launch-hd');
  const tile = el('div', 'launch-tile');
  tile.setAttribute('aria-hidden', 'true');
  tile.append(el('span', 'np-glyph', '▤'));
  const titles = el('div', 'launch-titles');
  titles.append(el('div', 'launch-title', opts.title));
  const closeX = button('launch-x', '×', closeFolderPicker);
  closeX.setAttribute('aria-label', 'cancel');
  closeX.title = 'cancel (esc)';
  hd.append(tile, titles, el('span', 'launch-gap'), closeX);

  // ---- nav: up + breadcrumb -------------------------------------------------
  const nav = el('div', 'pk-nav');
  const up = button('pk-up', '↑', () => void load(parentDir(curPath)));
  up.setAttribute('aria-label', 'up one level');
  up.title = 'parent directory';
  const crumbs = el('div', 'pk-crumbs');
  crumbs.setAttribute('aria-label', 'current path');
  nav.append(up, crumbs);

  // ---- quick zones ----------------------------------------------------------
  const quick = el('div', 'pk-quick');
  quick.setAttribute('role', 'group');
  quick.setAttribute('aria-label', 'quick locations');
  interface Zone {
    label: string;
    path: string | undefined;
  }
  const zones: Zone[] = [{ label: 'Home', path: opts.home ?? undefined }];
  if (opts.projectsDir !== undefined && opts.projectsDir !== null) {
    zones.push({ label: '~/projects', path: opts.projectsDir });
  }
  zones.push({ label: 'Root', path: '/' });
  const zoneBtns: { el: HTMLButtonElement; path: string | undefined }[] = [];
  for (const z of zones) {
    const b = button('pk-zone', z.label, () => void load(z.path));
    zoneBtns.push({ el: b, path: z.path });
    quick.append(b);
  }

  // ---- directory list (existing dir-browser idiom) --------------------------
  const list = el('div', 'dirlist');
  list.setAttribute('aria-label', 'subdirectories');
  const err = el('div', 'form-err');
  err.setAttribute('role', 'alert');
  err.hidden = true;

  // ---- new folder -----------------------------------------------------------
  const nf = el('div', 'pk-newfolder');
  const nfInput = el('input');
  nfInput.placeholder = 'new folder name';
  nfInput.spellcheck = false;
  nfInput.autocomplete = 'off';
  nfInput.setAttribute('aria-label', 'new folder name');
  const nfBtn = button('btn', '+ folder', () => void makeFolder());
  nfBtn.title = 'create a new folder here';
  nf.append(nfInput, nfBtn);
  nfInput.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void makeFolder();
    }
  });

  // ---- footer: current path · Cancel · Select folder ------------------------
  const ft = el('footer', 'modal-ft');
  const cwdEl = el('span', 'pk-cwd');
  const cancel = button('btn', 'Cancel', closeFolderPicker);
  const select = button('btn is-primary', 'Select folder', () => {
    const chosen = curPath;
    opts.onSelect(chosen);
    closeFolderPicker();
  });
  select.title = 'use this directory';
  ft.append(cwdEl, cancel, select);

  modal.append(hd, nav, quick, list, err, nf, ft);
  scrim.append(modal);
  scrim.addEventListener('mousedown', (e) => {
    if (e.target === scrim) closeFolderPicker();
  });
  trapTab(modal);
  opts.modalHost.append(scrim);
  select.focus();

  let curPath = '';

  function renderCrumbs(): void {
    const parts = breadcrumbs(curPath);
    const nodes: HTMLElement[] = [];
    parts.forEach((c, i) => {
      const b = button('pk-crumb', c.label, () => void load(c.path)); // textContent — untrusted
      b.title = c.path;
      nodes.push(b);
      if (i < parts.length - 1) nodes.push(el('span', 'pk-sep', '/'));
    });
    crumbs.replaceChildren(...nodes);
  }

  function syncZones(): void {
    for (const z of zoneBtns) {
      const on = z.path !== undefined && z.path === curPath;
      z.el.classList.toggle('is-on', on);
      z.el.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }

  async function load(path: string | undefined): Promise<void> {
    err.hidden = true;
    try {
      const res = await api.fsList(path);
      curPath = res.path;
      cwdEl.textContent = res.path; // untrusted path → textContent
      cwdEl.title = res.path;
      up.disabled = res.path === '/';
      renderCrumbs();
      syncZones();
      const items: HTMLElement[] = [];
      if (res.dirs.length === 0) {
        items.push(el('div', 'drawer-empty', 'empty folder'));
      }
      for (const name of res.dirs) {
        const row = button('dir-btn', `${name}/`, () => {
          // curPath is always the normalized absolute dir just loaded.
          void load(curPath === '/' ? `/${name}` : `${curPath}/${name}`);
        });
        row.textContent = `${name}/`; // untrusted dir name → textContent
        items.push(row);
      }
      list.replaceChildren(...items);
    } catch (e) {
      // Stay on the previous listing; surface the failure inline.
      err.textContent = e instanceof Error ? e.message : String(e);
      err.hidden = false;
    }
  }

  async function makeFolder(): Promise<void> {
    const name = nfInput.value.trim();
    if (name === '') {
      nfInput.focus();
      return;
    }
    err.hidden = true;
    nfBtn.disabled = true;
    try {
      const res = await api.fsMkdir(curPath, name);
      nfInput.value = '';
      await load(res.path); // navigate into the freshly created folder
    } catch (e) {
      err.textContent = e instanceof Error ? e.message : String(e);
      err.hidden = false;
    } finally {
      nfBtn.disabled = false;
    }
  }

  void load(opts.initial);
}
