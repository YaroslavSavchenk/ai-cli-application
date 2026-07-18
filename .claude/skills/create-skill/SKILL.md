---
name: create-skill
description: Author a new Claude Code skill for this project. Use when asked to create, add, or update a skill (a /command) in .claude/skills — it carries the project scope and the conventions a skill here must follow.
argument-hint: <skill-name> <what it should do>
---

# Creating a skill for this project

You are authoring a skill for the **AI CLI Session Manager** project. Follow
these steps in order.

## 1. Load the scope

Read `.claude/PROJECT-SCOPE.md` before writing anything. Every skill in this
repo must be consistent with the decided architecture (WSL-hosted Node backend,
node-pty + WebSocket, xterm.js frontend, detached backend, thin Windows
launcher). If the skill you're asked to write contradicts a decided point,
stop and tell the user instead of writing it. If it depends on an *open*
decision, say so in the skill body rather than inventing an answer.

## 2. Layout and naming

- A skill lives at `.claude/skills/<skill-name>/SKILL.md`.
- **The directory name IS the command name** (`/deploy-backend` comes from
  `.claude/skills/deploy-backend/`). The `name:` frontmatter field is only a
  display label. Use kebab-case, verb-first names: `create-skill`,
  `run-backend`, `test-pty`.
- Supporting files (reference docs, scripts) go in the same directory and are
  referenced from SKILL.md as relative links, or via `${CLAUDE_SKILL_DIR}` for
  scripts that must run regardless of cwd. They cost nothing until referenced.

## 3. Frontmatter

Minimal template:

```yaml
---
name: <skill-name>
description: <what it does + when to use it>
---
```

Fields worth reaching for (all optional):

- `description` — the trigger. One or two sentences: what the skill does,
  then "Use when …" with the concrete situations that should invoke it.
  Claude auto-invokes based on this text, so name the trigger words a user
  would actually say.
- `argument-hint` — e.g. `[session-id]`; shown in autocomplete.
- `disable-model-invocation: true` — for skills that must only run when the
  user explicitly types the command (deploys, anything destructive).
- `user-invocable: false` — for internal helper skills Claude uses but users
  shouldn't see in the `/` menu.
- `allowed-tools` / `model` / `effort` — only when the default is wrong.
- `context: fork` — runs the skill in an isolated subagent; use for
  self-contained jobs whose intermediate output would pollute the main
  conversation.

Arguments arrive as `$ARGUMENTS` (all of them) or `$0`, `$1`, … (positional).

## 4. Body

Write for the Claude instance that will execute the skill, not for a human
reader:

- Imperative, stepwise instructions. Number the steps if order matters.
- Be concrete for this project: real paths, real commands, real file names —
  not placeholders — whenever the scope doc has settled them.
- State what "done" looks like and how to verify it (a command to run, an
  endpoint to hit, an expected output).
- Reference `.claude/PROJECT-SCOPE.md` for background instead of restating
  it; restate only the one or two facts the skill directly depends on.
- Keep SKILL.md under ~150 lines; push long reference material into a
  supporting file and link it.

## 5. Verify

- Confirm the file sits at `.claude/skills/<skill-name>/SKILL.md` and the
  frontmatter parses (valid YAML, `---` fences).
- Re-read the description and check it would trigger at the right moments —
  and would NOT trigger for unrelated asks.
- Tell the user the skill exists, what `/command` invokes it, and give a
  one-line example invocation.
