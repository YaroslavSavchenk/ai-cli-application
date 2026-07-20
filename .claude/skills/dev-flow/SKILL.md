---
name: dev-flow
description: The development loop for this repo — developer implements, reviewers gate, fixer resolves findings, re-review until clean, then final verification. Use for any nontrivial feature, bugfix, or refactor; it defines who does what and in which order.
argument-hint: <task description>
---

# Development flow

You are the orchestrator. Agents do the work; you route between them and keep
the user informed with a one-line status per step. Read
`.claude/PROJECT-SCOPE.md` first if you haven't this session.

## The loop

```
brief → DEVELOP → REVIEW ─(findings)→ FIX → RE-REVIEW ─┐
                    │ ▲                                 │
                    │ └─────────(still findings)────────┘
                 (clean)
                    ▼
              FINAL GATE → report to user
```

## Roster

| Role      | Agent(s) | Edits code? |
|-----------|----------|-------------|
| Developer | `backend-pty` (server/PTY/WS) · `terminal-ui` (browser UI) · `wsl-launcher` (Windows/WSL glue) · `generalist-dev` (cross-cutting) | yes |
| Reviewer  | `scope-reviewer` (always) · `security-auditor` (conditional) · `test-engineer` (suite gate + writes tests) | tests only |
| Fixer     | `fixer` | yes — findings only |
| Janitor   | `janitor` | yes — hygiene only |

Reviewers never fix; the fixer never adds features; the janitor never
refactors. Keep these lanes strict — they are what makes re-review meaningful.

Models (decided 2026-07-20, user's call, superseding 2026-07-19): ALL
subagents — developers, reviewers, fixer, janitor, ad-hoc — run on **opus**
(frontmatter now pins the former sonnet agents to opus; pass
`model: 'opus'` explicitly on every Agent spawn so overrides beat any stale
pin). The session model (Fable 5) is reserved for the orchestrator itself:
thinking, briefing, consolidation/arbitration, and the final review of
finished work.

## Steps

1. **Brief.** Recall first: per `/memory`, check `memory/INDEX.md` and read
   the notes relevant to this task — past decisions and gotchas beat
   rediscovery. Then classify the task by seam and pick the developer agent
   (mixed task → split it, or `generalist-dev` for the glue). Write a brief:
   goal, acceptance criteria, constraints from the scope doc, relevant
   memory-note content pasted in (subagents don't browse the vault), and
   which open decisions must NOT be settled. UI work: the
   `frontend-designer` process applies (terminal-ui has it preloaded).
2. **Develop.** Launch the developer with the brief. It implements and
   self-verifies (its own contract requires this).
3. **Review round** — launch in parallel, all read the developer's report
   plus the diff:
   - `scope-reviewer` — always.
   - `security-auditor` — if the change touches HTTP/WS endpoints, spawning
     or argument handling, file paths, auth, launcher scripts, or deps.
   - `test-engineer` — runs the suite; writes tests covering the new
     behavior; failures and gaps become findings.
4. **Consolidate.** Merge findings, dedupe, drop pure style nits. Zero
   findings → step 6.
5. **Fix & re-review.** Pass the findings VERBATIM to `fixer`. Then re-run
   only the reviewers whose findings were addressed (plus `test-engineer` if
   any code changed). Disputed findings: you arbitrate — side with the scope
   doc; if genuinely ambiguous, ask the user. **Max 3 fix cycles**; if
   findings persist, stop and present the survivors to the user with options
   rather than looping forever.
6. **Final gate.**
   - Terminal behavior touched → run `/verify-terminal`.
   - Feature-sized change → `janitor` pass.
   - Anything an agent couldn't verify from WSL (Windows-side visuals) →
     compile the manual checklist for the user.
7. **Report & remember.** Tell the user: what was built, cycles used,
   findings found → fixed → disputed, verification evidence, leftover manual
   checks. Then update memory per `/memory`: new/changed decisions get a
   decision note, non-obvious lessons (especially bugs whose cause surprised
   you) get knowledge notes, and feature-sized work gets a `log/` entry.
   Finally, **commit and push** the landed change to origin — standing user
   authorization (2026-07-18) for milestone commits: each completed dev-flow
   phase or comparable significant change. The orchestrator commits;
   subagents still never do. Never commit unreviewed/mid-flight work.

## Proportionality

Trivial changes (typo, comment, config tweak) skip the machinery: developer
agent + `scope-reviewer` only, or just do it inline and say so. Don't
ceremonialize a one-liner; don't skip review on anything that touches
session lifetimes, spawning, or the protocol.
