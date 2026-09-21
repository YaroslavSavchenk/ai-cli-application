# AI CLI Session Manager

A web app served from inside WSL for running and managing multiple AI CLI
sessions (Claude Code first) — real PTY terminals in a browser, with projects,
launch presets, and multi-pane tab layouts.

Ground rules for every session:

- **Read `.claude/PROJECT-SCOPE.md` before any work.** It is the current
  truth: decided architecture, hard constraints, open decisions. Do not
  settle open decisions silently — they belong to the user.
- **Nontrivial changes go through `/dev-flow`** (developer agent → reviewers
  → fixer → re-review, then final gate). Trivial edits don't need the
  ceremony.
- **Project memory** is the Obsidian vault at `memory/` — conventions in the
  `/memory` skill. Recall from it before nontrivial work (`memory/INDEX.md`
  first); write back decisions, lessons, and a log entry after significant
  work.
- **Repo layout is a standard (2026-09-20, user's call).** A new file goes
  where `README.md` § Repository layout and the `/memory` skill's § Layout
  say — a work-log entry at `memory/log/<YYYY-MM>/<area>/`, never loose in
  `memory/log/`; `tests/vault-layout.test.ts` enforces the vault part. Moving,
  renaming or regrouping files or folders goes through `/restructure-repo`
  (reference scan, a move map the user approves, `git mv` in batches, the
  suite as the gate) — never an ad-hoc `mv`. A new top-level folder or a new
  log area is the user's decision.
- **Planning has one shape (2026-09-20, user's call) — conventions in
  `.claude/plans/README.md`.** Master plan `.claude/plans/PLAN-<NAME>.md` with
  the status table on top (the ONE place for "where are we"); part spec
  `.claude/plans/<name>/PLAN-<ID>.md`, written before the developer starts,
  never moved. A landing updates spec status + table row + vault in the same
  commit; `tests/plans-layout.test.ts` enforces it. What is next: read the
  table in `.claude/plans/PLAN-NOCTURNE.md`.
- UI work must follow `/frontend-designer` (hard anti-generic-design filter).
  Terminal-related changes aren't done until `/verify-terminal` passes.
- **Standing authorization (2026-07-18): commit AND push to origin after every
  significant landed change** (completed dev-flow phase, feature land,
  milestone) without asking. Only the orchestrator commits — never subagents,
  never unreviewed mid-flight work.
- **A push is not done until its CI run is green (2026-09-21, user's call).**
  Every push to `main` starts the `CI` and `CodeQL` workflows. After every
  push: watch the run for that commit to its end (`gh run list`, `gh run watch
  <id> --exit-status`); a red run is read (`gh run view <id> --log-failed`) and
  fixed in the same session, never left for the user to find. The runner is
  not this machine: a newer git, a UTC clock, no Windows interop.
- **Caveman mode standing (2026-07-19, user request)**: conversation replies
  and agent reports use the token-compressed style in
  `.claude/skills/caveman/SKILL.md` — fragments, zero filler, technical
  content byte-exact. Exceptions (normal prose): security warnings,
  destructive-action confirmations, decisions needing user input. Code,
  commits, docs, UI copy, and agent briefs stay normal/precise. "stop
  caveman" reverts.
