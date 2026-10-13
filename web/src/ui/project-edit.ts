/**
 * Edit project — the small dialog behind the pencil in a Projects drawer row
 * (part D1, `.claude/plans/nocturne/PLAN-D1.md`; user decision 2026-10-13:
 * an Edit button beside `Session` and `×`, no Settings page). Name, Model,
 * Permissions, Effort; Cancel / Save.
 *
 * Save PATCHes only what changed (`editPatch` in `project-prefs-model.ts`) — a
 * preference set back to No preference is sent as `null` — and nothing at all
 * when nothing changed. The server's refusal is shown inline as the sentence
 * it sent. The answer replaces the project in the state, so the drawer and the
 * New session dialog both read the new values at once.
 *
 * The look is the Add a project dialog's `ap-` ledger (top-anchored scrim,
 * hairline header and footer, fields sunk into the ground, one accent on the
 * primary action), narrowed by the `pe-` block in
 * `styles/app-add-project.css`. Built per open and removed on close
 * (`ModalSlot`, the picker's and the delete confirmation's idiom); Escape is
 * dispatched from `main-shell.ts`'s one keydown ladder.
 */
import type { Project } from '../../../shared/protocol.ts';
import * as api from '../api.ts';
import * as st from '../state.ts';
import { el, button, trapTab, ModalSlot } from './util.ts';
import { prefControls } from './project-prefs.ts';
import { editPatch, prefValuesOf, PREFS_SCOPE } from './project-prefs-model.ts';

/** The card on screen and the row button the keyboard goes back to. */
const slot = new ModalSlot();

export function isProjectEditOpen(): boolean {
  return slot.isOpen();
}

/** Escape from `main-shell.ts`: Cancel, exactly. */
export function closeProjectEdit(): void {
  slot.close();
}

export function openProjectEdit(project: Project, returnFocus: HTMLElement | null): void {
  if (slot.isOpen()) return;

  // `modal-scrim` stays on the scrim: ui/keys.ts recognises an open dialog by it.
  const scrim = el('div', 'modal-scrim ap-scrim pe-scrim');
  slot.hold(scrim, returnFocus);
  const modal = el('div', 'ap-modal pe-modal');
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-labelledby', 'pe-title');

  // ---- header: what is edited, the one worry a rename raises, close --------
  const hd = el('header', 'ap-hd');
  const hdTxt = el('div');
  const title = el('h2', 'ap-title', 'Edit project');
  title.id = 'pe-title';
  hdTxt.append(title, el('div', 'ap-sub', 'Renaming never moves the folder.'));
  const closeX = button('ap-x', '×', () => slot.close());
  closeX.setAttribute('aria-label', 'Close');
  hd.append(hdTxt, closeX);

  // ---- body ----------------------------------------------------------------
  const body = el('div', 'ap-body');
  const nameField = el('label', 'ap-field');
  const nameInput = el('input');
  nameInput.name = 'name';
  nameInput.spellcheck = false;
  nameInput.autocomplete = 'off';
  nameInput.value = project.name;
  nameField.append(el('span', 'ap-lb', 'Name'), nameInput);

  const prefs = prefControls();
  const before = prefValuesOf(project);
  prefs.write(before);

  const err = el('div', 'ap-err');
  err.setAttribute('role', 'alert');
  err.hidden = true;

  body.append(nameField, prefs.row, el('div', 'ap-note', PREFS_SCOPE), err);

  // ---- footer --------------------------------------------------------------
  const ft = el('footer', 'ap-ft');
  const cancel = button('btn-quiet', 'Cancel', () => slot.close());
  const save = button('btn-accent', 'Save', () => void submit());
  ft.append(cancel, save);

  modal.append(hd, body, ft);
  scrim.append(modal);
  scrim.addEventListener('mousedown', (e) => {
    if (e.target === scrim) slot.close();
  });
  // Enter in the name field is Save: the one text field of a short form.
  nameInput.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    void submit();
  });
  trapTab(modal);
  (document.querySelector('.modal-host') ?? document.body).append(scrim);
  nameInput.focus();

  let saving = false;

  function setSaving(on: boolean): void {
    saving = on;
    save.disabled = on;
    nameInput.disabled = on;
    prefs.setDisabled(on);
  }

  function showErr(msg: string): void {
    err.textContent = msg;
    err.hidden = false;
  }

  async function submit(): Promise<void> {
    if (saving) return;
    err.hidden = true;
    const out = editPatch(project, nameInput.value, before, prefs.read());
    if ('error' in out) {
      showErr(out.error);
      nameInput.focus();
      return;
    }
    if (Object.keys(out.patch).length === 0) {
      slot.close(); // nothing changed, nothing to send
      return;
    }
    setSaving(true);
    try {
      const updated = await api.updateProject(project.id, out.patch);
      // Closed FIRST: the keyboard goes back to the row's Edit button, and the
      // drawer's rebuild below keeps it there by the button's data-k.
      slot.close();
      st.setProjects(st.state.projects.map((p) => (p.id === updated.id ? updated : p)));
    } catch (e) {
      setSaving(false);
      showErr(e instanceof Error ? e.message : String(e));
    }
  }
}
