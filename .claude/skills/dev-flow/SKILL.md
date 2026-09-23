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

Models (decided 2026-09-22, user's call, superseding 2026-07-26): EVERY
subagent — developers, reviewers (security-auditor included), fixer,
janitor, ad-hoc — runs on **opus**. Pass `model: 'opus'` explicitly on every
Agent spawn so the override beats any stale pin; every `.claude/agents/*.md`
that pins a model pins `opus`. The session model does the orchestrator's own
work: thinking, briefing, consolidation/arbitration, and the final review of
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
     behavior to the rules of `tests/README.md`; failures, gaps and
     breaches of those rules become findings.
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

Lean rules (user, 2026-09-16 — cut duplication, never review depth):

1. **One fix round per phase.** Collect every reviewer's findings (scope,
   security, test) first, then ONE fixer/developer pass.
2. **One test-gate per phase.** The mutation probe runs once, after that fix
   pass; fixer changes are verified by the orchestrator with targeted tests
   and a diff read, not another gate.
3. **No scope re-review for comment/doc-only fixes** — the orchestrator reads
   the diff.
4. **Reviewer briefs name the relevant spec sections**, not "read the whole
   spec and the scope doc".
5. **Readers first, mutation gate after.** The test-engineer's mutation probe
   never runs in parallel with anyone reading or editing the same files.
6. **Design decisions are asked BEFORE the developer starts** (in the Plan
   step), not after a review surfaces them. The part's spec is written to
   `.claude/plans/<name>/PLAN-<ID>.md` in the shape `.claude/plans/README.md`
   prescribes; the landing commit sets its `Status: LANDED …` line and the
   part's row in the master plan's status table.
7. **Developers run the full suite at most twice** (once mid-way, once at
   the end); iteration uses targeted `node --test <files>`. A full run is
   ~40 s; ten of them are five minutes of waiting.
8. **Browser verification is scoped to the claims unit tests cannot cover**
   (resize storm, real listings, real events), with at most three
   screenshots — not a tour of the feature.
9. **Briefs carry the relevant spec text INLINE** (the sections, pasted),
   plus the one scope-doc bullet that applies — an agent must not need to
   read a 1000-line plan and the whole scope doc to start. Measured
   2026-09-16: 32 agents, each spending 4–6 min re-reading the same docs.
10. **Test-gates probe at most ~10 high-value mutants** with targeted tests
    and never run the full suite; the orchestrator runs it once per phase.
    EXCEPTION (user, 2026-09-16, "verliezen wij kwaliteit?"): code on a hard
    constraint — path boundaries, spawning and argument handling, the PTY
    and resize seam, keyboard capture, auth — keeps the FULL mutation
    probe. The cap is for UI surfaces only.
11. **`/verify-terminal` runs once per PART, at the end**, and only the checks
    the part's seams touch; per-brief browser checks stay with the developer
    under rule 8.
