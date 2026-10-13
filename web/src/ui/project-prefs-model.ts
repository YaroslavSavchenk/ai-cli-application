/**
 * A project's launch preferences as the project dialogs show and send them —
 * pure rules and copy, no DOM (part D1, `.claude/plans/nocturne/PLAN-D1.md`).
 * The Add a project dialog (`newproject.ts`) and the Edit project dialog
 * (`project-edit.ts`) build their three selects from these tables through
 * `project-prefs.ts`, so the two can never offer different things.
 *
 * Every select holds `''` for "No preference": on create the field is left out,
 * on edit it is sent as `null` (clear it). The values are the CLI contract from
 * `launch-args.ts`, the words are its labels — no id ever reaches the screen.
 */
import {
  isProjectEffort,
  type CreateProjectRequest,
  type Project,
  type UpdateProjectRequest,
} from '../../../shared/protocol.ts';
import {
  EFFORTS,
  EFFORT_LABEL,
  PERMS,
  PERM_SHORT,
  TOOLS,
  isPerm,
  permFromDefaultMode,
  poolModel,
  type Choice,
} from './launch-args.ts';

/** The option every preference select opens with, value `''`. */
const NO_PREFERENCE = 'No preference';

/** The one line that says what the preferences are FOR, and for which tool. */
export const PREFS_SCOPE = 'What a new Claude Code session in this project starts with.';

/** The same sentence the server's create rule stands for: a name is trimmed and non-empty. */
export const NAME_REQUIRED = 'A project name is required.';

const NONE: Choice = { id: '', label: NO_PREFERENCE };

/** Model: No preference, the newest four, then the Older models group (`older`). */
export const MODEL_PREF_CHOICES: readonly Choice[] = [NONE, ...TOOLS.claude.models];

/** Permissions: No preference and the launch dialog's four words. */
export const PERM_PREF_CHOICES: readonly Choice[] = [
  NONE,
  ...PERMS.map((p) => ({ id: p.mode, label: PERM_SHORT[p.mode] })),
];

/** Effort: No preference stands for the `default` sentinel, then the five levels. */
export const EFFORT_PREF_CHOICES: readonly Choice[] = [
  NONE,
  ...EFFORTS.filter((e) => e !== 'default').map((e) => ({ id: e, label: EFFORT_LABEL[e] })),
];

/** True for the one permission mode that wears the danger treatment (No prompts). */
export function isDangerPerm(v: string): boolean {
  return PERMS.some((p) => p.danger && p.mode === v);
}

/** What the three selects hold; `''` = No preference. */
export interface PrefValues {
  model: string;
  perm: string;
  effort: string;
}

/** A fresh form: nothing preferred. */
export const NO_PREFS: PrefValues = { model: '', perm: '', effort: '' };

/**
 * A stored project -> what its selects show. A bare alias shows as the model
 * it launches (`opus` -> Opus 5.5); an id outside the pool shows No preference,
 * which is what it does (it falls back like no preference at all). The legacy
 * `skip-permissions` shows as No prompts — `defaultPerm` wins when both exist.
 * Every value is one of its select's choices (a hand-edited unknown value shows
 * No preference, as the real select does), so "before" equals what the select
 * reads and Save only clears an unknown value when the user moved that field.
 */
export function prefValuesOf(p: Project): PrefValues {
  return {
    model: poolModel(p.defaultModel) ?? '',
    perm: (isPerm(p.defaultPerm) ? p.defaultPerm : permFromDefaultMode(p.defaultMode)) ?? '',
    effort: isProjectEffort(p.defaultEffort) ? p.defaultEffort : '',
  };
}

/** The create request's preference fields: only the ones chosen (the dialog stopped sending `defaultMode`). */
export function createPrefFields(
  v: PrefValues,
): Pick<CreateProjectRequest, 'defaultModel' | 'defaultPerm' | 'defaultEffort'> {
  return {
    ...(v.model !== '' ? { defaultModel: v.model } : {}),
    ...(isPerm(v.perm) ? { defaultPerm: v.perm } : {}),
    ...(isProjectEffort(v.effort) ? { defaultEffort: v.effort } : {}),
  };
}

/** What Save in the Edit dialog does: a request carrying only what changed, or the reason it cannot. */
type EditOutcome = { error: string } | { patch: UpdateProjectRequest };

/**
 * The Edit dialog's PATCH body: the name only when its trimmed text differs,
 * each preference only when its select moved — and a select moved to No
 * preference sends `null` (clear it). An empty body means nothing to save.
 */
export function editPatch(p: Project, typedName: string, before: PrefValues, after: PrefValues): EditOutcome {
  const name = typedName.trim();
  if (name === '') return { error: NAME_REQUIRED };
  const patch: UpdateProjectRequest = {};
  if (name !== p.name) patch.name = name;
  if (after.model !== before.model) patch.defaultModel = after.model !== '' ? after.model : null;
  if (after.perm !== before.perm) patch.defaultPerm = isPerm(after.perm) ? after.perm : null;
  if (after.effort !== before.effort) {
    patch.defaultEffort = isProjectEffort(after.effort) ? after.effort : null;
  }
  return { patch };
}
