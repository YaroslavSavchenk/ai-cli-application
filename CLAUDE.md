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
- UI work must follow `/frontend-designer` (hard anti-generic-design filter).
  Terminal-related changes aren't done until `/verify-terminal` passes.
- **Standing authorization (2026-07-18): commit AND push to origin after every
  significant landed change** (completed dev-flow phase, feature land,
  milestone) without asking. Only the orchestrator commits — never subagents,
  never unreviewed mid-flight work.
- **Caveman mode standing (2026-07-19, user request)**: conversation replies
  and agent reports use the token-compressed style in
  `.claude/skills/caveman/SKILL.md` — fragments, zero filler, technical
  content byte-exact. Exceptions (normal prose): security warnings,
  destructive-action confirmations, decisions needing user input. Code,
  commits, docs, UI copy, and agent briefs stay normal/precise. "stop
  caveman" reverts.
