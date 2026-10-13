---
type: decision
created: 2026-10-13
updated: 2026-10-13
tags: [nocturne, d1, projects, launch-dialog, models]
---
# D1: project preferences editable per project row, Claude models pinned by version

**Status:** decided 2026-10-13 (user; the recommended option each time, asked
before the developer started). Spec `.claude/plans/nocturne/PLAN-D1.md`.

User: "De preferences voor projecten werken niet en je kunt ze niet
aanpassen. Verder ik wil het poel van moddelen hebben niet alleen opus,
fable, maar fable 5.1, opus 5.5 … de oude komen verder in het lijstje met
oudere model."

## Decided

1. **Edit button in the project row** (Projects drawer), opening a small
   dialog. Rejected: a Settings page "Projects", both.
2. **Fields:** name, model, permission mode (all four), effort.
3. **Pinned ids:** `Opus 5.5` always launches `claude-opus-5-5`. Rejected: a
   floating "newest" alias on top. Consequence: a new Claude model = update
   `CLAUDE_MODELS` in `web/src/ui/launch-args.ts` (ids + display names come
   from the installed Claude Code binary's alias map / model table).
4. **Older models:** generation 5 + Opus/Sonnet 4.x (all the installed
   Claude Code 2.1.287 knows). Rejected: generation 5 only.

## Defaults taken by the orchestrator (within the decisions)

- Fallback Opus 5.5 named explicitly (`MODEL_FALLBACK`), not "first entry".
- Stored aliases (`opus`, `fable` …) read as today's newest of the family;
  no on-disk migration; untouched fields are never re-sent, so they stay.
- New project fields `defaultPerm` / `defaultEffort`; legacy `defaultMode`
  read only, deleted when `defaultPerm` is written.
- Project preferences apply to Claude Code only (a `No prompts` preference
  no longer arms bypass for Codex / Gemini — a pre-existing bug).
- Re-resolve on every project switch in the New session dialog; a field
  changed by hand during this open wins.
- Server validates `defaultModel` by pattern `^[a-z0-9][a-z0-9.-]{0,63}$`,
  never by list (a new model must not need a backend change).
