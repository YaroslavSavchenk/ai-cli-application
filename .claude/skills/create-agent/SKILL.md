---
name: create-agent
description: Author a new Claude Code subagent for this project. Use when asked to create, add, or update an agent in .claude/agents — it carries the project scope and ensures the agent gets the knowledge it needs to work on this codebase.
argument-hint: <agent-name> <what it should do>
---

# Creating a subagent for this project

You are authoring a subagent for the **AI CLI Session Manager** project.
Subagents run with a fresh context and only know what their file tells them —
an agent that doesn't carry the project scope will make architecture-shaped
mistakes. Follow these steps in order.

## 1. Load the scope

Read `.claude/PROJECT-SCOPE.md`. Every agent must operate inside the decided
architecture (WSL-hosted Node backend, node-pty + WebSocket, xterm.js
frontend, detached backend, thin Windows launcher). If the requested agent's
purpose contradicts a decided point, stop and tell the user.

## 2. File format

One markdown file per agent at `.claude/agents/<agent-name>.md`:

```yaml
---
name: <agent-name>            # unique, lowercase + hyphens; this is its identity
description: <when the main agent should delegate to it>
tools: Read, Grep, Glob, Bash # optional — omit to inherit ALL tools
model: inherit                # optional — sonnet | opus | haiku | inherit
---

<system prompt in markdown>
```

Field rules that matter:

- `name` + `description` are required; everything else is optional.
- `description` is the **delegation trigger**: the main agent reads it to
  decide when to hand work over. Write "Use when …" with concrete task shapes
  (e.g. "Use when a change touches the PTY/WebSocket layer"). Vague
  descriptions mean the agent never gets used — or gets used for the wrong
  things.
- `tools` — restrict deliberately. Research/review agents get read-only tools
  (`Read, Grep, Glob, Bash`); implementer agents also get `Write, Edit`.
  Omit `Agent` from the list unless it genuinely needs to spawn sub-subagents.
- `model` — default to `inherit` (or omit). Drop to `haiku` only for cheap
  mechanical work; don't hardcode expensive models without a reason.

## 3. Write the system prompt

Structure the body as:

1. **Role** — one sentence: what this agent is and its single responsibility.
2. **Project context** — the first instruction must be:
   "Before doing anything else, Read `.claude/PROJECT-SCOPE.md`."
   Then restate only the 2–3 scope facts this agent's work directly hinges on
   (e.g. for a terminal-layer agent: real PTY per session, resize must
   propagate to `pty.resize()`, sessions are server-side objects). Reference,
   don't duplicate — the scope doc is the source of truth.
3. **Boundaries** — what it must NOT do (touch unrelated layers, make
   architecture decisions unilaterally, commit/push).
4. **Output contract** — a subagent's final message is a report consumed by
   the main agent, not prose for the user. Spell out exactly what to return:
   file paths with line numbers, findings, diffs applied, verification
   results — raw and complete, no pleasantries.

## 4. Fit the agent to this project's real seams

Good agent boundaries here follow the architecture's natural layers — prefer
these shapes over generic "helper" agents:

- **backend/PTY layer** — node-pty, session lifecycle, WebSocket protocol.
- **frontend/terminal UI** — xterm.js panes, tabs/layouts, resize + focus.
- **WSL/launcher integration** — wsl.exe spawning, health checks, detached
  startup, systemd service.
- **cross-cutting reviewers** — e.g. an agent that checks changes against the
  hard constraints in the scope doc (PTY realness, resize propagation,
  keyboard passthrough).

## 5. Verify

- Confirm the file is at `.claude/agents/<agent-name>.md`, YAML parses, and
  every tool named in `tools` is spelled exactly right (a wrong name makes
  the agent fail to launch).
- Re-read the description: would the main agent pick this agent for the tasks
  it's meant for, and skip it otherwise?
- Tell the user the agent exists, when it will be used, and how to invoke it
  explicitly if they want to.
