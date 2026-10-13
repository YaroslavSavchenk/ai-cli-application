# D1 — Project preferences that work and can be changed, and the full Claude model pool

Status: LANDED 2026-10-13 on branch `project-prefs-models` (suite 3981 → 3994; scope + security + test gate, one fix round, 86 mutants / 0 survivors; DEV check with the user pending, then merge to `main`); earlier: STARTED 2026-10-13 (user: "De preferences voor projecten werken niet en je kunt ze niet aanpassen. Verder ik wil het poel van moddelen hebben niet alleen opus, fable, maar fable 5.1, opus 5.5 of whatsso ever. Je kunt nieuwste modelen kieze en de oude komen in verder in het lijstje met oudere model." — on branch `project-prefs-models`, checked in DEV only, never in the installed app; decisions below asked before the developer started).

Part D1 of `.claude/plans/PLAN-NOCTURNE.md` (Track D, fixes and asks after the v0.4.0 release). Conventions: `.claude/plans/README.md`.

## What the user gets

- A project's preferences (model, permission mode, effort) are what the New
  session dialog pre-selects for that project — also when the project is
  picked inside the dialog after it opened.
- Every project row in the Projects drawer has an Edit button. It opens a
  small dialog: Name, Model, Permissions, Effort. Save writes them; each
  preference can be set back to "No preference".
- The Model select lists real versions — Fable 5.1, Opus 5.5, Sonnet 5.5,
  Haiku 4.5 at the top — and, under an "Older models" group, every older model
  the installed Claude Code knows.

## Root cause (found 2026-10-13, line numbers drift)

1. **Defaults resolve once.** `web/src/ui/launch.ts` `applyDefaults()` (~:743)
   runs only from `open()`; the project select's change listener (~:806)
   explicitly does NOT re-resolve. A plain open pre-selects the previous or
   first project (`populateProjects` ~:467), so the model shown is that
   project's, not the one picked next. `server.log`: `launch: kind=claude
   project=crypto model=opus`, while crypto's `defaultModel` is `fable`. A
   `skip-permissions` default even carries over to the next project.
2. **No edit path at all.** `ProjectStore` (`server/projects.ts`) has
   list/get/create/remove; `/api/projects/:id` answers DELETE only; no client
   function, no UI. The New Project dialog can only set a model and the
   legacy two-value mode (`never ask (dangerous)` or blank); the clone tabs
   set nothing.

## Decided (user, 2026-10-13) — do not re-ask

1. **Where:** an Edit button in the project row of the Projects drawer
   (beside `Session` and `×`), opening a small dialog. No Settings page.
2. **Fields:** Name, Model, Permission mode (all four: Always ask / Auto
   edits / Read only / No prompts), Effort.
3. **Model ids are pinned:** `Opus 5.5` always launches `claude-opus-5-5`
   (`--model claude-opus-5-5`). Stored aliases (`opus`, `fable`, `sonnet`,
   `haiku` — every current projects.json holds them) are read as today's
   newest of that family. A new model = this list is updated.
4. **Older models:** generation 5 plus Opus/Sonnet 4.x — everything the
   installed Claude Code (2.1.287) knows.

## Defaults (orchestrator, within the decisions — not asked)

- **The pool** (`launch-args.ts`, the only home of the CLI mapping):
  - Newest, in this order: Fable 5.1 `claude-fable-5-1`, Opus 5.5
    `claude-opus-5-5`, Sonnet 5.5 `claude-sonnet-5-5`, Haiku 4.5
    `claude-haiku-4-5`.
  - Older models: Opus 5 `claude-opus-5`, Sonnet 5 `claude-sonnet-5`, Fable 5
    `claude-fable-5`, Opus 4.8 `claude-opus-4-8`, Opus 4.7 `claude-opus-4-7`,
    Opus 4.6 `claude-opus-4-6`, Opus 4.5 `claude-opus-4-5`, Opus 4.1
    `claude-opus-4-1`, Sonnet 4.6 `claude-sonnet-4-6`, Sonnet 4.5
    `claude-sonnet-4-5`.
  - Ids and display names verified against the Claude Code 2.1.287 binary's
    alias map and model table.
  - Fallback when no project preference: **Opus 5.5** (today's fallback is
    `opus`, which is Opus 5.5 — behaviour unchanged), named explicitly, not
    "the first entry".
  - Legacy alias map: `fable → claude-fable-5-1`, `opus → claude-opus-5-5`,
    `sonnet → claude-sonnet-5-5`, `haiku → claude-haiku-4-5`. Used when a
    stored preference is resolved. Labels for the bare aliases stay
    (`Opus`, `Fable` …) so old history rows still read as a word.
  - An unknown stored id (none exist today) falls back to Opus 5.5, as
    today.
- **Select shape:** `<optgroup label="Older models">` after the newest
  options, in the launch dialog, the New Project dialog and the Edit dialog.
  The newest four stay plain options (no "Newest" group label).
- **Permission + effort in projects.json:** two new optional fields,
  `defaultPerm?: ClaudePermissionMode` and `defaultEffort?: Effort-id`
  (`low|medium|high|xhigh|max`; absent = Default). The legacy `defaultMode`
  stays readable (`skip-permissions` → `bypassPermissions`, `standard` → no
  preference); `defaultPerm` wins when both exist; a PATCH that sets or
  clears `defaultPerm` also deletes `defaultMode`. No on-disk migration.
- **Project preferences apply to Claude Code only.** The model ids and
  effort are Claude's; a `No prompts` preference must not silently arm
  bypass for Codex or Gemini (today it does — fixed here). Other tools keep
  their own last model and effort. The dialog has ONE set of permission
  cards for every tool (as implemented): a mode picked by hand during this
  open stays across tool switches (where a tool cannot take it, only the
  cards' display falls back, and the hand pick returns on a tool that can);
  without a hand pick Claude Code shows the project's mode and the other
  tools show Always ask.
- **Re-resolve rule in the launch dialog:** on open and on every project
  change, the project's preferences are applied to Claude's model,
  permission and effort — except a field the user changed by hand during
  THIS open of the dialog ("a per-launch choice always wins",
  PROJECT-SCOPE). No preference → fallback (Opus 5.5 / Always ask /
  Default).
- **New Project dialog:** its defaults row uses the same three controls and
  labels (model with the Older group, the four permission words + "No
  preference", effort) and sends `defaultModel` / `defaultPerm` /
  `defaultEffort`. It stops sending `defaultMode`. Clone tabs stay without
  preferences (editable afterwards).
- **Name rules** for a rename = the create rules (trimmed, non-empty;
  whatever else POST enforces). Renaming never touches the folder.

## Frozen contract

`shared/protocol.ts`:

```ts
export interface Project {
  id: string; name: string; path: string;
  defaultModel?: string;
  /** Legacy two-value mode — read only; superseded by defaultPerm. */
  defaultMode?: PermissionMode;
  defaultPerm?: ClaudePermissionMode;
  defaultEffort?: ProjectEffort;
  createdAt: string;
}
export type ProjectEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** PATCH /api/projects/:id — absent = unchanged, null = clear the preference. */
export interface UpdateProjectRequest {
  name?: string;
  defaultModel?: string | null;
  defaultPerm?: ClaudePermissionMode | null;
  defaultEffort?: ProjectEffort | null;
}
// CreateProjectRequest gains optional defaultPerm / defaultEffort (same validation).
```

- `PATCH /api/projects/:id` → 200 with the updated `Project`; 404 unknown id;
  400 on any invalid field (nothing written); 405 for other methods besides
  DELETE/PATCH. Same auth/origin guard as every `/api/*` route.
- `defaultModel` validation (server, PATCH and POST): `^[a-z0-9][a-z0-9.-]{0,63}$`
  — it reaches argv (argv array, never a shell), so it can never start with
  `-`. The server does NOT hard-code the pool (a future model must not need a
  backend change); the UI only offers the pool.
- `defaultPerm` ∈ the four `ClaudePermissionMode`s; `defaultEffort` ∈
  `ProjectEffort`. Unknown keys in the body are ignored.
- `ProjectStore.update(id, patch): Project | undefined` — saves atomically
  like every mutation; logs the changed field NAMES, never values.
- `web/src/api.ts`: `updateProject(id, patch): Promise<Project>`.

## Files (expected)

- Backend (`backend-pty`): `shared/protocol.ts`, `server/projects.ts`,
  `server/api-projects.ts`, tests under `tests/server/`.
- UI (`terminal-ui`): `web/src/ui/launch-args.ts` (pool, groups, alias map,
  resolvers), `web/src/ui/launch.ts` (984 lines — re-resolve logic must live
  in a model module, launch.ts only wires it; hard 1000-line limit),
  `web/src/ui/launch-controls.ts` (`fillChoices` with groups),
  `web/src/ui/newproject.ts`, `web/src/ui/projects.ts` (Edit button), a new
  `web/src/ui/project-edit.ts` (+ `project-edit-model.ts` if pure logic
  appears), `web/src/api.ts`, `web/src/ui/settings.ts:179` sample
  (`opus` → a pool id), CSS, tests under `tests/ui/` and
  `tests/helpers/ui-launch-dialog-fixture.ts` (its `options` must see options
  inside an OPTGROUP).

## Test gate

- Server: PATCH round-trip per field, clear with null, legacy `defaultMode`
  deleted when `defaultPerm` is written, 404/400/405, invalid model id
  (`-x`, uppercase, 65 chars, non-string) refused with nothing written,
  rename trims, file stays 0600.
- UI: the pool order + groups, alias resolution, fallback Opus 5.5, argv
  `--model claude-opus-5-5` byte-exact, re-resolve on project switch, a
  hand-changed field survives a switch, `No prompts` preference does not arm
  bypass for Codex/Gemini, Edit dialog sends only changed fields / null for
  "No preference", history rows with `--model opus` still read `Opus`.

## Final gate

- Suite green, typecheck, build; scope + security + test reviewers.
- DEV check by the user (never the installed app): edit a project, open New
  session from the top bar, switch project, see its preferences; launch with
  `Opus 4.8` from Older models.
