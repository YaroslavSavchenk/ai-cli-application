/**
 * The three preference selects a project carries — Model, Permissions, Effort —
 * built ONCE here for the Add a project dialog (`newproject.ts`) and the Edit
 * project dialog (`project-edit.ts`), part D1
 * (`.claude/plans/nocturne/PLAN-D1.md`). The tables and the copy are
 * `project-prefs-model.ts`; this module only renders them in the `ap-` field
 * idiom both dialogs share (`styles/app-add-project.css`).
 */
import { el } from './util.ts';
import { fillChoices } from './launch-controls.ts';
import type { Choice } from './launch-args.ts';
import {
  EFFORT_PREF_CHOICES,
  MODEL_PREF_CHOICES,
  isDangerPerm,
  PERM_PREF_CHOICES,
  type PrefValues,
} from './project-prefs-model.ts';

interface PrefControls {
  /** One row, three fields side by side. */
  row: HTMLElement;
  read(): PrefValues;
  write(v: PrefValues): void;
  setDisabled(on: boolean): void;
}

function prefField(label: string, name: string, choices: readonly Choice[]): {
  field: HTMLElement;
  sel: HTMLSelectElement;
} {
  const field = el('label', 'ap-field');
  const sel = el('select');
  sel.name = name;
  fillChoices(sel, choices);
  field.append(el('span', 'ap-lb', label), sel);
  return { field, sel };
}

export function prefControls(): PrefControls {
  const row = el('div', 'ap-row3');
  const model = prefField('Model', 'defaultModel', MODEL_PREF_CHOICES);
  const perm = prefField('Permissions', 'defaultPerm', PERM_PREF_CHOICES);
  const effort = prefField('Effort', 'defaultEffort', EFFORT_PREF_CHOICES);
  row.append(model.field, perm.field, effort.field);
  // No prompts keeps the launch dialog's red card treatment as a red field
  // edge: the danger is information, not decoration.
  const syncDanger = (): void => {
    perm.sel.classList.toggle('is-danger', isDangerPerm(perm.sel.value));
  };
  perm.sel.addEventListener('change', syncDanger);
  return {
    row,
    read: () => ({ model: model.sel.value, perm: perm.sel.value, effort: effort.sel.value }),
    write(v) {
      model.sel.value = v.model;
      perm.sel.value = v.perm;
      effort.sel.value = v.effort;
      syncDanger();
    },
    setDisabled(on) {
      for (const s of [model.sel, perm.sel, effort.sel]) s.disabled = on;
    },
  };
}
