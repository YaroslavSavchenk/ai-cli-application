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
