/**
 * Projects drawer: manage view. Rows list projects by NAME — the path shows
 * only here, as secondary metadata (everywhere else in the UI a project is
 * its name). Add = name + directory picked in a browser modal over
 * GET /api/fs/list (navigate up/down, choose the current dir); optional
 * default model/mode feed the launcher's prefill. Delete is an armed
 * two-step confirm.
 *
 * The directory modal's Escape handling is dispatched centrally from
 * main.ts (via modalOpen()/closeModal()) so Esc priority over the drawer is
 * in one place.
 */
import * as st from '../state.ts';
import * as api from '../api.ts';
import type { PermissionMode } from '../../../shared/protocol.ts';
import { el, button, ArmedSet, trapTab } from './util.ts';
import { flash } from './statusline.ts';

const armed = new ArmedSet();

export interface ProjectsDrawer {
  render(): void;
  modalOpen(): boolean;
  closeModal(): void;
}

export function initProjectsDrawer(host: HTMLElement, modalHost: HTMLElement): ProjectsDrawer {
  const root = el('section', 'drawer-view');
  root.hidden = true;

  const hd = el('header', 'drawer-hd');
  const gap = el('span', 'drawer-gap');
  const close = button('drawer-x', '×', () => st.closeDrawer());
  close.setAttribute('aria-label', 'close projects panel');
  close.title = 'close panel (esc)';
  hd.append(el('span', 'drawer-label', 'projects'), gap, close);

  const body = el('div', 'drawer-body');
  const listHost = el('div', 'proj-list');

  // ---- add form (static DOM — never rebuilt, typing survives polls) -------
  const form = el('form', 'proj-add');
  form.append(el('div', 'launcher-hd', 'add project'));

  const nameField = el('label', 'field');
  nameField.append(el('span', 'field-lb', 'name'));
  const nameInput = el('input');
  nameInput.name = 'name';
  nameInput.spellcheck = false;
  nameField.append(nameInput);

  const dirField = el('div', 'field');
  dirField.append(el('span', 'field-lb', 'directory'));
  const dirRow = el('div', 'dir-row');
  const dirShown = el('span', 'dir-chosen is-unset', 'none chosen');
  const browse = button('btn', 'browse…', () => openModal(chosenPath));
  browse.title = 'pick a directory on the server';
  dirRow.append(browse, dirShown);
  dirField.append(dirRow);

  const modelField = el('label', 'field');
  const modelLb = el('span', 'field-lb', 'default model ');
  modelLb.append(el('em', 'field-hint', 'optional'));
  const modelInput = el('input');
  modelInput.name = 'defaultModel';
  modelInput.placeholder = 'opus';
  modelInput.spellcheck = false;
  modelField.append(modelLb, modelInput);

  const modeField = el('label', 'field');
  modeField.append(el('span', 'field-lb', 'default mode'));
  const modeSelect = el('select');
  modeSelect.name = 'defaultMode';
  for (const [v, lbl] of [
    ['standard', 'standard'],
    ['skip-permissions', 'skip-permissions'],
  ] as const) {
    const opt = el('option', '', lbl);
    opt.value = v;
    modeSelect.append(opt);
  }
  modeField.append(modeSelect);

  const submit = el('button', 'btn is-primary', 'add project');
  submit.type = 'submit';
  const err = el('div', 'launcher-err');
  err.setAttribute('role', 'alert');
  err.hidden = true;

  form.append(nameField, dirField, modelField, modeField, submit, err);
  body.append(listHost, form);
  root.append(hd, body);
  host.append(root);

  let chosenPath: string | undefined;
  let lastVisible = false;
  let lastSig = '';

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void addProject();
  });

  async function addProject(): Promise<void> {
    err.hidden = true;
    const name = nameInput.value.trim();
    if (name === '') {
      showErr('name is required');
      return;
    }
    if (chosenPath === undefined) {
      showErr('pick a directory with browse…');
      return;
    }
    const model = modelInput.value.trim();
    submit.disabled = true;
    try {
      const p = await api.createProject({
        name,
        path: chosenPath,
        ...(model !== '' ? { defaultModel: model } : {}),
        defaultMode: modeSelect.value as PermissionMode,
      });
      st.setProjects([...st.state.projects, p]);
      nameInput.value = '';
      modelInput.value = '';
      modeSelect.value = 'standard';
      chosenPath = undefined;
      dirShown.textContent = 'none chosen';
      dirShown.classList.add('is-unset');
    } catch (e2) {
      showErr(e2 instanceof Error ? e2.message : String(e2));
    } finally {
      submit.disabled = false;
    }
  }

  function showErr(msg: string): void {
    err.textContent = msg;
    err.hidden = false;
  }

  async function deleteProject(id: string): Promise<void> {
    try {
      await api.deleteProject(id);
    } catch (e2) {
      if (!(e2 instanceof api.ApiError && e2.status === 404)) {
        flash(`delete failed: ${e2 instanceof Error ? e2.message : String(e2)}`);
        return;
      }
    }
    st.setProjects(st.state.projects.filter((p) => p.id !== id));
  }

  function sig(): string {
    // Count prefix so the empty list still differs from the initial ''.
    return (
      `n${st.state.projects.length}|` +
      st.state.projects
        .map((p) => `${p.id}:${p.name}:${p.path}:${armed.isArmed(p.id) ? 'a' : ''}`)
        .join('|')
    );
  }

  function render(): void {
    const visible = st.state.drawer === 'projects';
    root.hidden = !visible;
    if (!visible) {
      lastVisible = false;
      lastSig = '';
      return;
    }
    if (!lastVisible) {
      lastVisible = true;
      // Opening the panel refreshes from the server (projects may have been
      // edited from another window).
      void api
        .getProjects()
        .then(st.setProjects)
        .catch(() => {});
    }
    const s = sig();
    if (s === lastSig) return;
    lastSig = s;
    rebuildList();
  }

  function rebuildList(): void {
    const focusKey =
      document.activeElement instanceof HTMLElement
        ? document.activeElement.getAttribute('data-k')
        : null;
    const rows: HTMLElement[] = [];
    if (st.state.projects.length === 0) {
      rows.push(el('div', 'drawer-empty', 'no projects — add one below'));
    }
    for (const p of st.state.projects) {
      const row = el('div', 'proj-row');
      const main = el('div', 'proj-main');
      main.append(el('div', 'proj-name', p.name));
      main.append(el('div', 'proj-path', p.path)); // secondary metadata: allowed here only
      const meta: string[] = [];
      if (p.defaultModel !== undefined && p.defaultModel !== '') meta.push(p.defaultModel);
      if (p.defaultMode === 'skip-permissions') meta.push('skip-permissions');
      if (meta.length > 0) main.append(el('div', 'proj-meta', meta.join(' · ')));
      const del = button('row-btn is-danger', armed.isArmed(p.id) ? 'sure?' : 'delete', () => {
        if (armed.trigger(p.id, () => {
          lastSig = '';
          render();
        })) {
          void deleteProject(p.id);
        }
      });
      if (armed.isArmed(p.id)) del.dataset.armed = '1';
      del.setAttribute('data-k', `pdel:${p.id}`);
      del.title = 'delete project (asks to confirm; sessions keep running)';
      row.append(main, del);
      rows.push(row);
    }
    listHost.replaceChildren(...rows);
    if (focusKey !== null) {
      listHost.querySelector<HTMLElement>(`[data-k="${CSS.escape(focusKey)}"]`)?.focus();
    }
  }

  // -------------------------------------------------------------------------
  // Directory browser modal (GET /api/fs/list)
  // -------------------------------------------------------------------------

  let scrim: HTMLElement | null = null;
  let curPath = '';

  function parentOf(p: string): string {
    if (p === '/') return '/';
    const i = p.lastIndexOf('/');
    return i <= 0 ? '/' : p.slice(0, i);
  }

  function openModal(initial: string | undefined): void {
    if (scrim !== null) return;
    scrim = el('div', 'modal-scrim');
    const modal = el('div', 'modal');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', 'choose directory');

    const mhd = el('header', 'modal-hd');
    const mx = button('drawer-x', '×', closeModal);
    mx.setAttribute('aria-label', 'cancel');
    mhd.append(el('span', 'drawer-label', 'choose directory'), el('span', 'drawer-gap'), mx);

    const nav = el('div', 'dirnav');
    const up = button('btn', 'up', () => void load(parentOf(curPath)));
    up.title = 'parent directory';
    const pathEl = el('span', 'dirpath');
    nav.append(up, pathEl);

    const list = el('div', 'dirlist');
    list.setAttribute('aria-label', 'subdirectories');
    const merr = el('div', 'launcher-err');
    merr.setAttribute('role', 'alert');
    merr.hidden = true;

    const ft = el('footer', 'modal-ft');
    const choose = button('btn is-primary', 'choose this directory', () => {
      chosenPath = curPath;
      dirShown.textContent = curPath;
      dirShown.classList.remove('is-unset');
      closeModal();
    });
    const cancel = button('btn', 'cancel', closeModal);
    ft.append(choose, cancel);

    modal.append(mhd, nav, list, merr, ft);
    scrim.append(modal);
    scrim.addEventListener('mousedown', (e) => {
      if (e.target === scrim) closeModal();
    });
    trapTab(modal);
    modalHost.append(scrim);
    choose.focus();

    async function load(path: string | undefined): Promise<void> {
      merr.hidden = true;
      try {
        const res = await api.fsList(path);
        curPath = res.path;
        pathEl.textContent = res.path;
        up.disabled = res.path === '/';
        const items: HTMLElement[] = [];
        if (res.dirs.length === 0) {
          items.push(el('div', 'drawer-empty', 'no subdirectories'));
        }
        for (const name of res.dirs) {
          items.push(
            button('dir-btn', name + '/', () => {
              void load(curPath === '/' ? `/${name}` : `${curPath}/${name}`);
            }),
          );
        }
        list.replaceChildren(...items);
      } catch (e2) {
        // Stay on the previous listing; surface the failure inline.
        merr.textContent = e2 instanceof Error ? e2.message : String(e2);
        merr.hidden = false;
      }
    }
    void load(initial);
  }

  function closeModal(): void {
    if (scrim === null) return;
    scrim.remove();
    scrim = null;
    browse.focus(); // Return focus to the control that opened the dialog.
  }

  return { render, modalOpen: () => scrim !== null, closeModal };
}
