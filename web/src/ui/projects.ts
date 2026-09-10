/**
 * Projects drawer (handoff §6, left, 272px). Rows list projects by NAME —
 * the path shows only here, as faint mono metadata (everywhere else in the
 * UI a project is its name). Each row: name, `+` (opens the launch dialog
 * pre-set to this project), `×` (armed two-step remove), the path, and a
 * meta line (`N active sessions` in green, else `no active sessions`).
 *
 * `+ add` in the header opens the New Project dialog (Phase 2a: blank-create
 * + clone, wired to the real backend). The old inline add-project form and its
 * directory-browser modal were REPLACED by that dialog — the dialog owns the
 * folder picker now (web/src/ui/newproject.ts + picker.ts).
 */
import * as st from '../state.ts';
import * as api from '../api.ts';
import { el, button, ArmedSet } from './util.ts';
import { openLaunchDialog } from './launch.ts';
import { openNewProjectDialog } from './newproject.ts';
import { flash } from './statusline.ts';

const armed = new ArmedSet();

export interface ProjectsDrawer {
  render(): void;
}

export function initProjectsDrawer(host: HTMLElement): ProjectsDrawer {
  const root = el('section', 'drawer-view');

  const hd = el('header', 'drawer-hd');
  hd.append(el('span', 'drawer-label', 'Projects'), el('span', 'drawer-gap'));
  const addBtn = button('chip-btn is-go', '+ add', () => openNewProjectDialog());
  addBtn.title = 'new project (create locally or clone a repo)';
  addBtn.setAttribute('aria-haspopup', 'dialog');
  const close = button('drawer-x', '×', () => st.closeDrawer());
  close.setAttribute('aria-label', 'close projects panel');
  close.title = 'close panel (esc)';
  hd.append(addBtn, close);

  const body = el('div', 'drawer-body');
  const listHost = el('div', 'proj-list');
  body.append(listHost);
  root.append(hd, body);
  host.append(root);

  let lastVisible = false;
  let lastSig = '';

  async function deleteProject(id: string): Promise<void> {
    try {
      await api.deleteProject(id);
    } catch (e2) {
      if (!(e2 instanceof api.ApiError && e2.status === 404)) {
        flash(`Could not remove it: ${e2 instanceof Error ? e2.message : String(e2)}`);
        return;
      }
    }
    st.setProjects(st.state.projects.filter((p) => p.id !== id));
  }

  /** Running sessions in this project (drives the green meta line). */
  function activeCount(projectId: string): number {
    let n = 0;
    for (const s of st.state.sessions.values()) {
      if (s.projectId === projectId && s.status === 'running') n++;
    }
    return n;
  }

  function sig(): string {
    // Count prefix so the empty list still differs from the initial ''.
    return (
      `n${st.state.projects.length}|` +
      st.state.projects
        .map(
          (p) =>
            `${p.id}:${p.name}:${p.path}:${activeCount(p.id)}:${armed.isArmed(p.id) ? 'a' : ''}`,
        )
        .join('|')
    );
  }

  function render(): void {
    const visible = st.state.drawer === 'projects';
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
      rows.push(el('div', 'drawer-empty', 'no projects — + add one'));
    }
    for (const p of st.state.projects) {
      const row = el('div', 'proj-row');
      const line = el('div', 'proj-line');
      line.append(el('span', 'proj-name', p.name), el('span', 'drawer-gap'));
      const add = button('chip-btn is-go', '+', () => openLaunchDialog({ projectId: p.id }));
      add.setAttribute('data-k', `pnew:${p.id}`);
      add.setAttribute('aria-label', `new session in ${p.name}`);
      add.title = 'new session in this project';
      const del = button('chip-btn is-x', armed.isArmed(p.id) ? 'sure?' : '×', () => {
        if (
          armed.trigger(p.id, () => {
            lastSig = '';
            render();
          })
        ) {
          void deleteProject(p.id);
        }
      });
      if (armed.isArmed(p.id)) del.dataset.armed = '1';
      del.setAttribute('data-k', `pdel:${p.id}`);
      del.setAttribute('aria-label', `remove project ${p.name}`);
      del.title = 'remove project (asks to confirm; sessions keep running)';
      line.append(add, del);
      row.append(line);
      row.append(el('div', 'proj-path', p.path)); // secondary metadata: allowed here only
      const n = activeCount(p.id);
      row.append(
        el(
          'div',
          `proj-meta${n > 0 ? ' is-on' : ''}`,
          n > 0 ? `${n} active session${n > 1 ? 's' : ''}` : 'no active sessions',
        ),
      );
      rows.push(row);
    }
    listHost.replaceChildren(...rows);
    if (focusKey !== null) {
      listHost.querySelector<HTMLElement>(`[data-k="${CSS.escape(focusKey)}"]`)?.focus();
    }
  }

  return { render };
}
