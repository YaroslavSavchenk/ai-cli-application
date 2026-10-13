---
type: log
created: 2026-10-13
updated: 2026-10-13
tags: [nocturne, d1, projects, launch-dialog, models]
---
# 2026-10-13 — D1: project preferences work and are editable, the full Claude model pool

**Asked (user):** project preferences don't work and can't be changed; the
model list should hold real versions (Fable 5.1, Opus 5.5 …), newest first,
older ones in an "Older models" group. Decisions: [[d1-project-prefs-and-model-pool]].

## Cause found

- The New session dialog resolved a project's defaults ONCE, at open, for
  the project pre-selected then (the previous or first one); a project
  picked afterwards kept the first one's model/mode. `server.log` showed
  `project=crypto model=opus` while crypto's default was `fable`.
- No edit path existed at all (no store method, no PATCH, no UI); the New
  project dialog could set only a model and `never ask (dangerous)`.

## Built (branch `project-prefs-models`)

- `PATCH /api/projects/:id` + `ProjectStore.update` (absent = unchanged,
  null = clear, names-only log); POST validates the same fields.
- Shared `CLAUDE_PERMISSION_MODES` / `PROJECT_EFFORTS` in
  `shared/protocol.ts` (one home for server, status line and dialog).
- `CLAUDE_MODELS` pool (4 newest + 10 older under an OPTGROUP), alias map,
  `MODEL_FALLBACK`; re-resolve on project switch in a pure
  `launch-prefs-model.ts`; Edit dialog `project-edit.ts` + shared
  `project-prefs*.ts` builder (also used by New project).

## Review

- Security clean; scope 4 minor + 3 notes; test read round 10 gaps incl. one
  real bug (F1: a rename-only save cleared an unknown stored perm, hidden by
  a fake DOM whose SELECT kept any value — the fake now follows HTML).
- One fix round (13 findings). Mutation probe: 86 mutants, 7 survivors →
  7 tests → 0. Survivors worth remembering: regex `/m` flag let
  `opus\n--x` pass; an empty "Older models" group on every other select;
  a Codex pick froze Claude's model.
- Suite 3981 → 3994 green.

## Verdict + release

User after the DEV check: "done shit it, maak hier een release van" →
fast-forward to `main`, CI + CodeQL, release v0.4.1 (notes
`.claude/plans/RELEASE-NOTES-v0.4.1-draft.md`: mascot fix + C2, P1–P5 speed,
D1).
