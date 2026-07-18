---
name: memory
description: Read and write the project's Obsidian-style memory vault in memory/. Use at the start of nontrivial work to recall relevant context, and whenever a decision is made or changed, a non-obvious lesson is learned, or a work session ends.
---

# Project memory (Obsidian vault)

The vault lives at `memory/` in the repo root. It is plain markdown with
`[[wikilinks]]`, fully compatible with Obsidian (the user may open it as a
vault via `\\wsl$\Ubuntu\home\sava\projects\ai-cli-application\memory`).
`.obsidian/` is gitignored — never create or edit files inside it.

## Division of labor — do not blur it

- `.claude/PROJECT-SCOPE.md` = the **current truth**: what we're building,
  decided architecture, hard constraints. Compact, always current.
- `memory/` = the **why and the history**: rationale behind decisions,
  alternatives rejected, lessons learned, gotchas discovered, work log.
- When a decision is made or changed: update the scope doc (current state)
  AND write/update the decision note (rationale + what it replaced).

## Layout

```
memory/
  INDEX.md        ← map of content; one line per note; ALWAYS kept current
  decisions/      ← one note per decision: status, why, alternatives rejected
  knowledge/      ← technical learnings, gotchas, constraints with reasons
  log/            ← work log, one note per significant session: YYYY-MM-DD-topic.md
```

## Note format

Filename is the link target: kebab-case, no date prefix (except `log/`).

```markdown
---
type: decision | knowledge | log
created: 2026-07-18
updated: 2026-07-18
tags: [architecture]
---
# Human-readable title

Dense content. Link liberally with [[other-note]] — links are the point of
an Obsidian vault. Absolute dates only ("2026-07-18", never "today").
```

Decision notes additionally carry a `**Status:** decided | superseded by
[[x]]` line and a "Rejected alternatives" section — the rejected paths and
WHY are often the most valuable content.

## Recall (start of nontrivial work)

1. Read `memory/INDEX.md`, pick the notes whose hooks match the task.
2. Read those notes; follow `[[links]]` one hop when relevant.
3. Grep the vault for task keywords if the index gives no hit.
4. Orchestrator pulls relevant note content INTO subagent briefs — subagents
   don't browse the vault themselves.

## Write (decision made, lesson learned, session end)

1. Check INDEX for an existing note on the topic — **update it** (and its
   `updated:` date) rather than creating a near-duplicate.
2. New note → correct folder, format above, linked from related notes.
3. Add/refresh its one-liner in `INDEX.md` — a note absent from the index
   is invisible.
4. A superseded decision is not deleted: mark `**Status:** superseded by
   [[new-note]]` and keep it — history is the point. Factually WRONG
   knowledge notes are deleted (and their index line removed).
5. Session end (feature landed, milestone, big debugging session): one
   `log/YYYY-MM-DD-topic.md` entry — what happened, what was decided,
   what's next. Link the notes it touched.

## What does NOT go in memory

Anything the repo already states (code structure, scope doc content, git
history), speculation, or session-only trivia. Memory is for what you'd
otherwise have to rediscover or re-litigate.
