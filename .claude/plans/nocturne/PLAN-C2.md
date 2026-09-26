# C2 — The mascot waits until Claude is really done, and comes when Claude asks you something

Status: LANDED 2026-09-26 on branch `mascot-detection` (the landing commit; suite 3452 → 3873; scope + security + test gate, one fix round + test-gate follow-ups; 77 mutants / 9 equivalent; DEV Windows check with the user pending, then merge to `main` = user's call); earlier: STARTED 2026-09-26 (user: "de mascotte verschijnt wanneer main sessie niks doet, maar wel subagents hebt. Dat is niet de bedoeling. het detectie moet ook op subagents werken, workflows en questions dat claude kan stellen. Dit is het volgende stap." — on branch `mascot-detection`, checked in DEV only, never in the installed app; decisions below asked before the developer started).

Part C2 of `.claude/plans/PLAN-NOCTURNE.md` (Track C, after C1 `.claude/plans/nocturne/PLAN-C1.md`). Conventions: `.claude/plans/README.md`.

## What the user gets

- A Claude session that ended its turn while subagents or a workflow it
  launched in the background are still running shows NO mascot and reads
  **Working** on its pane — Claude is not done. The mascot comes once that
  background work is over and Claude has ended its turn (normally: the
  background work reports back, Claude works on it, ends its turn).
- A Claude session that ASKS the user something — a multiple-choice question
  (`AskUserQuestion`) or a plan to approve (`ExitPlanMode`) — shows a mascot
  and reads **Waiting for you**, until it is answered.

## Decided (user, 2026-09-26) — do not re-ask

1. **Questions:** `AskUserQuestion` AND plan approval (`ExitPlanMode`) bring
   the mascot.
2. **A question's mascot leaves when it is answered** (Claude works again),
   the same rule as a finished turn (C1 decision 14 as changed): looking at
   the pane does not send it away.
3. **One rule everywhere:** the pane readout (B11 Working / Waiting for you)
   follows the same rule as the mascot — Working while the session's
   background subagents / workflows run; Waiting for you as soon as Claude
   asks a question. Implemented as ONE session-level verdict,
   `SessionInfo.turn`, from which `turnEnded` (C1) already derives.

Defaults (orchestrator, within the decisions — not asked):

- Background SHELLS (`Bash` with `run_in_background`, `Monitor`) do not
  count: a dev server may run forever. Only `Agent` (also its older name
  `Task`) and `Workflow` launches count.
- A permission prompt still writes nothing to the transcript: it stays
  BEL-only (B11 known limit, unchanged).
- Workflow agents do NOT join the Background agents table (B7) in this part.

## The rule

The session's verdict `turn` is computed from its OWN transcript (B11
boundary, budgets and first-sight TAIL read unchanged) plus, for liveness
only, the files under its `subagents/` directory (B7 boundary unchanged):

1. **Main verdict** — the last counting line, as `turnOfLine` today, with
   one addition: an `assistant` line carrying a `tool_use` block named
   `AskUserQuestion` or `ExitPlanMode` → `'waiting'` (the user's answer is
   the next `user` line, a `tool_result` → `'working'`). Measured on this
   machine 2026-09-26: Claude Code writes the question's `tool_use` line with
   `stop_reason: "tool_use"`, then nothing but metadata lines (`last-prompt`,
   `ai-title`, `mode`, …, which do not count) until the answer.
2. **Outstanding background work** — a launch is an `assistant` `tool_use`
   block named `Agent`, `Task` or `Workflow` whose `tool_result` (matched by
   `tool_use_id`) says it went to the background: text starting
   `Async agent launched` (carries `agentId: <hex>`) or
   `Workflow launched in background` (carries `Task ID: …` and a
   `Transcript dir: …/subagents/workflows/<runId>`). It stays outstanding
   until a `user` line that is a task notification (`origin.kind ===
   "task-notification"`, text starting `<task-notification>`) names its
   `<tool-use-id>`. Measured formats (2026-09-26, Claude Code 2.1.x):
   ```
   tool_result: "Async agent launched successfully. …\nagentId: a790bda5878f4d7ef (internal ID …"
   tool_result: "Workflow launched in background. Task ID: w094cbwm2 Summary: … Transcript dir: /home/…/<session>/subagents/workflows/wf_998cfcac-d41…"
   user:        "<task-notification>\n<task-id>a790bda5878f4d7ef</task-id>\n<tool-use-id>toolu_01JMRGSDa5ThQwVnDeAn4rje</tool-use-id>\n…<status>completed</status>…"
   ```
3. **Liveness (the fallback against a launch that never reports back** — a
   killed process, a resumed session whose tail holds launches of an earlier
   process, a Claude Code bug): an outstanding launch counts only while it
   shows life — launched less than `STALE_MS` (B7's 15 min) ago, OR its
   files were written less than `STALE_MS` ago: for an agent, B7's own
   tracked row for that `agentId` (running = not finished, not stale); for a
   workflow, the newest mtime of the `agent-<hex>.jsonl` files in
   `subagents/workflows/<runId>/` (the run id validated to its measured shape
   before it is ever joined into a path, the directory realpath'd inside the
   tracked `subagents/` directory every poll, names filtered like B7, a cap
   on files stat'ed per poll). A workflow that finished (all agents ended,
   notification arrived) is not outstanding anyway.
4. **The session verdict:** `turn = 'working'` when the main verdict is
   `'waiting'` because the turn ENDED (not because of a question) and at
   least one outstanding launch is alive; otherwise the main verdict. A
   question wins over background work (Claude waits for the user).
5. `turnEnded` and `pendingSince` keep their C1 definitions, now fed by this
   verdict: set on `working → waiting`, never by a first readout, cleared by
   `working` and at exit.

## Frozen names

- `SessionInfo.turn`, `turnEnded`, `pendingSince`, `agents`, `agentCounts`:
  unchanged shapes. No new protocol field.
- `turnOfLine` may change its signature only if the fold needs state; the
  stateful part (launch map, question flag) lives in a fold object in
  `server/agents-fold.ts` beside today's, pure and I/O-free; the liveness
  lookups live in `server/agents.ts`.

## Files

Backend (`backend-pty`): `server/agents-fold.ts` (the fold: main verdict +
launch / notification bookkeeping, pure), `server/agents.ts` (the watcher:
feed the fold, liveness from tracked rows and the workflows directories,
the session verdict), comments in `shared/protocol.ts` (`turn`,
`turnEnded`) if their wording changes. Tests beside the existing B11 turn
tests (`tests/server/…`, one topic per file, `tests/README.md`). No frontend
change is expected: the page and the pane read `turn` / `turnEnded`
already. Docs at landing: `.claude/PROJECT-SCOPE.md` (Session state, Peek
mascot bullets).

## Gates

- `npm run typecheck`, `npm run build`, `npm test` green.
- Untrusted-input discipline of B7 held for every new read (security review).
- DEV check (never the installed app): a Claude session in the dev window
  that launches a background agent and ends its turn reads Working and shows
  no mascot until the agent reports back and Claude ends its turn; a
  question shows a mascot at once (after the page's 1.5 s rise) and it
  leaves when answered; a workflow likewise.

## Amendments while building (2026-09-26; they win over the items above)

- **A `SendMessage` that RESUMES an agent is a launch too.** Its result
  `{"success":true,"message":"Resuming agent …","resumedAgentId":"<hex>"}`
  is later closed by a task notification naming the SendMessage's own
  `tool_use` id (measured: 199 on this machine). An orchestrating session
  reuses its agents this way in every fix round. Without this rule the
  mascot would show during those rounds, which is exactly the user's
  complaint. "Message queued for delivery" is not a launch.
- **A `queued_command` attachment closes a launch as well.** That is
  `attachment.type === 'queued_command'` whose `prompt` starts with the task
  notification. It is the form a notification takes when it arrives while
  Claude is busy. Measured: 79 of 915 launches were closed only this way.
- The question rule is last-counting-line (no question-id tracking). The
  fold's verdict has a third internal value, `'asking'`, which reaches the
  wire as `'waiting'` and beats open background work.
- The workflow liveness scan lives in `server/agents-workflows.ts`: run id
  shape `wf_<8 hex>(-<hex>)+`, exact realpath equality (a symlink at
  `workflows/` or at the run id is refused, logged once per session), at
  most 1024 entries per poll across all runs, `lstat` only, no file ever
  opened.
- A task notification is recognised by its text starting
  `<task-notification>`; `origin.kind` is not required (measured: all 1091
  real `origin.kind: "task-notification"` lines carry the prefix, and no
  prefixed line lacks it).
- `turnOfLine` became private to `server/agents-fold.ts` and takes the parsed
  record (the fold needs state: § Frozen names allowed exactly this);
  `foldTurnLine(acc, line, seenMs)` is the entry point.

## Known limits (recorded 2026-09-26, test gate)

- A launch written before the 1 MiB first-sight TAIL (a backend restart
  mid-orchestration) is unknown to the fold. A still-running agent of that
  launch does not hold `'working'` (B11's tail rule, by design).
- An agent's liveness comes from B7's tracked rows, which are the newest 64
  metas. An OLD agent that is resumed after 64 or more newer ones, and runs
  past 15 min, is timed by its launch alone, so the mascot may come while it
  still runs (pinned in `tests/server/agents-launch-edges.test.ts`).
- An API error or a `<synthetic>` stop (a session limit) with a live launch
  reads Working, per rule 4. In practice a limit also fails the background
  agents, and their "failed" notifications close the launches at once.
- An agent row that finished counts as alive for 10 s more. The task
  notification lands a moment after the agent's last line, and this stops a
  one-poll mascot flash in between.
