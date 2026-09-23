/**
 * Folder picker modal — wired to the REAL backend fs endpoints (GET
 * /api/fs/list + POST /api/fs/mkdir), NO faked tree. Reused by the Add-a-project
 * dialog's New-folder FOLDER row and its Clone-into row.
 *
 * Anatomy (Nocturne A7, the `pk-` block in app.css — the same dialog idiom as
 * the Add-a-project (`ap-`) and New session (`ns-`) cards): a top-anchored
 * scrim, a header (the opener's own title + close), the current path as one
 * walkable mono row with an "up one level" control, quick zones (Home /
 * ~/projects when it exists / Root), the folder list as hairline-separated rows
 * with the Phosphor folder mark, a "+ folder" row (POST /api/fs/mkdir →
 * navigate into it), and a footer with Cancel and "Choose this folder", which
 * returns the CURRENT directory to the opener.
 *
 * Honest states only: fs/list errors (403 permission / 404 not-a-directory)
 * render inline; a directory with no subdirectories reads "No folders here."
 * All directory names and paths are UNTRUSTED display text → textContent,
 * never innerHTML.
 *
 * Created on open, removed on close (like the old dir browser). One picker at a
 * time; it may open OVER the Add-a-project dialog (appended last → paints on top
 * at the same modal z, and its top edge lands on that card's). Escape is
 * dispatched centrally from main.ts.
 */
import * as api from '../api.ts';
import { el, button, trapTab, ModalSlot } from './util.ts';
import { folderIcon } from './icons.ts';
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
  /** Called with the chosen absolute directory when "Choose this folder" is pressed. */
  onSelect(path: string): void;
}

/** The picker on screen and the element the keyboard goes back to (ui/util.ts). */
const slot = new ModalSlot();

export function isFolderPickerOpen(): boolean {
  return slot.isOpen();
}

export function closeFolderPicker(): void {
  slot.close();
}

export function openFolderPicker(opts: PickerOpts): void {
  if (slot.isOpen()) return; // one picker at a time

  // `modal-scrim` stays on the scrim: ui/keys.ts recognises an open dialog by
  // it. Everything visual is the `pk-` block in app.css (Nocturne A7).
  const scrim = el('div', 'modal-scrim pk-scrim');
  slot.hold(scrim, opts.restoreTo ?? null);
  const modal = el('div', 'pk-modal');
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-labelledby', 'pk-title');

  // ---- header: the opener's own words + close -------------------------------
  const hd = el('header', 'pk-hd');
  const title = el('h2', 'pk-title', opts.title);
  title.id = 'pk-title';
  const closeX = button('pk-x', '×', closeFolderPicker);
  closeX.setAttribute('aria-label', 'Close');
  hd.append(title, closeX);

  // ---- the current path: one walkable mono row ------------------------------
  const pathRow = el('div', 'pk-pathrow');
  const up = button('pk-up', '↑', () => void load(parentDir(curPath)));
  up.setAttribute('aria-label', 'Up one level');
  const crumbs = el('div', 'pk-crumbs');
  crumbs.setAttribute('aria-label', 'Current path');
  pathRow.append(up, crumbs);

  // ---- quick zones ----------------------------------------------------------
  const quick = el('div', 'pk-quick');
  quick.setAttribute('role', 'group');
  quick.setAttribute('aria-label', 'Quick locations');
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

  // ---- the folder list ------------------------------------------------------
  const list = el('div', 'pk-list');
  list.setAttribute('aria-label', 'Folders in this folder');
  const err = el('div', 'pk-err');
  err.setAttribute('role', 'alert');
  err.hidden = true;

  // ---- new folder -----------------------------------------------------------
  const nf = el('div', 'pk-mkrow');
  const nfInput = el('input', 'pk-mkname');
  nfInput.placeholder = 'new folder name';
  nfInput.spellcheck = false;
  nfInput.autocomplete = 'off';
  nfInput.setAttribute('aria-label', 'Name for a new folder');
  const nfBtn = button('pk-mk', '+ folder', () => void makeFolder());
  nf.append(nfInput, nfBtn);
  nfInput.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void makeFolder();
    }
  });

  // ---- footer: Cancel · Choose this folder ----------------------------------
  const ft = el('footer', 'pk-ft');
  const cancel = button('btn-quiet', 'Cancel', closeFolderPicker);
  const select = button('btn-accent', 'Choose this folder', () => {
    const chosen = curPath;
    if (chosen === '') return; // no listing yet: there is no folder to hand back
    opts.onSelect(chosen);
    closeFolderPicker();
  });
  // `curPath` is '' until the first listing resolves, so there is nothing to
  // choose yet: pressing this in that window would hand the opener an empty
  // path. The first successful listing enables it, and a later failed listing
  // keeps the listing that was there, so it stays enabled.
  select.disabled = true;
  ft.append(cancel, select);

  modal.append(hd, pathRow, quick, list, err, nf, ft);
  scrim.append(modal);
  scrim.addEventListener('mousedown', (e) => {
    if (e.target === scrim) closeFolderPicker();
  });
  trapTab(modal);
  opts.modalHost.append(scrim);
  cancel.focus(); // moves to the commitment once the first listing arrives

  let curPath = '';

  function renderCrumbs(): void {
    const parts = breadcrumbs(curPath);
    const nodes: HTMLElement[] = [];
    parts.forEach((c, i) => {
      const last = i === parts.length - 1;
      // textContent — untrusted. The last segment is where you ARE: brighter
      // ink, still a button (re-listing the current folder is legitimate).
      const b = button(last ? 'pk-crumb is-here' : 'pk-crumb', c.label, () => void load(c.path));
      b.title = c.path;
      nodes.push(b);
      if (!last) nodes.push(el('span', 'pk-sep', '/'));
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
      up.disabled = res.path === '/';
      renderCrumbs();
      syncZones();
      const items: HTMLElement[] = [];
      if (res.dirs.length === 0) {
        items.push(el('div', 'pk-empty', 'No folders here.'));
      }
      for (const name of res.dirs) {
        const row = button('pk-row', '', () => {
          // curPath is always the normalized absolute dir just loaded.
          void load(curPath === '/' ? `/${name}` : `${curPath}/${name}`);
        });
        // untrusted dir name → textContent (el() sets it); the mark is decoration
        row.append(folderIcon(), el('span', 'pk-rowname', name));
        items.push(row);
      }
      list.replaceChildren(...items);
      if (select.disabled) {
        select.disabled = false;
        if (document.activeElement === cancel) select.focus();
      }
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
