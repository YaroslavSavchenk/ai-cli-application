---
type: log
created: 2026-10-13
updated: 2026-10-13
tags: [nocturne, d6, claude-code, compatibility]
---
# 2026-10-13 — D6: the Claude Code compatibility guard

Decisions: [[d6-claude-code-compat-guard]]. Spec: `.claude/plans/nocturne/PLAN-D6.md`.

**Server** (backend-pty developer, in a worktree on top of Q5):
- `shared/claude-compat.ts` holds the range (2.1.263 … 2.1.287) and the
  parse/compare/compat functions.
- `server/claude-version.ts` runs `claude --version`: argv only, `ptyEnv()`,
  5 s timeout, 4 KiB cap, through `runCapture`, whose one home is now
  `server/config.ts`.
  - `ClaudeVersionWatch` probes again when the binary's fingerprint
    changes, triggered from `/api/tools`, at most once a minute.
  - Dev-only `AI_SM_CLAUDE_VERSION_OVERRIDE`, refused when installed.
- `GET /api/runtime` carries `claude`. A claude-kind session that exits
  non-zero within 3 s (and that the user did not kill) gets
  `earlyExit.line`: its first output line, escape-, control- and
  bidi-stripped, at most 200 chars. It goes out on the exit frame and
  SessionInfo, plus one WARN line.

**UI** (terminal-ui developer):
- A Settings → Background service fact.
- A second card in the toast stack, below the update toast. Its rule is
  danger when Claude Code is older, attention when newer. Controls: ×,
  Hide, Check for updates (hidden on a clone). One shared check in
  `web/src/ui/update-check.ts`, whose busy state shows on both buttons.
- The pane banner `Claude Code stopped right after it started: <line>`.

**Gates:**
- Server: scope review and security review, no blockers; 10 items in one
  fix round (dead length cap, a mis-pinned constant, a false WARN on a
  user kill, the decision moved into a pure `earlyExitLine`, bidi strip,
  stale comments, scope doc).
- UI: scope review found a blocker. A reload re-showed a hidden notice
  because the server replays `early` on every attach; fixed with
  "created after page load" plus once per session. 6 more items were fixed.
- A flaky watch test came from coarse kernel mtimes; the test now sets the
  mtime with `utimes`.
- Release discipline: `.claude/plans/RELEASE-NOTES-v0.4.3-draft.md` ends
  with `Verified with Claude Code 2.1.287.`, pinned against
  `CLAUDE_SUPPORTED.testedUpTo`.

**Lesson:** worktree-isolated agents cannot edit the main checkout, and
one of them wrote there through `sed` anyway. After integrating a
worktree's patch, fixes go to a non-isolated fixer in main.

**Verified (user, DEV, 2026-10-13):** "alles werkt" — D3–D6 and Q5–Q8 together; the branch was fast-forwarded into `main`.
