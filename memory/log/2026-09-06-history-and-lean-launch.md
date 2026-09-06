---
type: log
created: 2026-09-06
updated: 2026-09-06
tags: [history, resume, launch, shipped]
---
# 2026-09-06 — session history + real resume, lean launch dialog · SHIPPED

Trigger: three user complaints in one message — history "does not work",
history should be per project folder, the launch popup is cluttered and
lacks an effort choice. Decision + rationale: [[session-history-resume]].

Full dev-flow: 2 developers (backend-pty, terminal-ui, parallel, both on
opus; the protocol contract written into `shared/protocol.ts` by the
orchestrator first so both could code against it) → 3 reviewers → 1 fix
cycle (10 findings, all fixed) → scoped re-review (scope VERIFIED ×10,
security CLEAN, test gate 546/546 with mutation checks) → janitor. Suite
508 → 546, tsc ×2 clean.

## What landed

- `server/history.ts` + `server/conversation.ts`: cumulative `history.json`
  (bound 200, crash stamp at boot), `--session-id <app uuid>` injected into
  claude spawns (PTY argv only), `--resume <id>` on resume, transcript-based
  pruning with a strictly one-directional rule. `server/journal.ts`,
  journal.json, previous.json, `/api/previous` gone. Routes:
  `GET /api/history`, `POST /api/history/:id/resume`, `DELETE /api/history[/:id]`.
  Blank session name → project name as title.
- UI: launch dialog reduced to Name · Project · Model · Effort · Mode
  (segmented short labels) · Continue checkbox · `other command` toggle;
  HISTORY section grouped per project folder, collapsible, `resume` /
  `start again`, armed forget, 300 ms-debounced refetch; exited-pane
  `relaunch` resumes the conversation via history.

## What the reviewers caught (worth remembering)

- **Prune encoded the raw cwd** (security + test-engineer + scope, all
  three independently): a trailing slash or a symlinked project folder made
  the transcript lookup miss and silently deleted a real conversation from
  inside a GET. Fix: `realpathSync` first, and prune only when Claude's
  per-cwd directory itself exists (that proves the encoding matches).
  Lesson: a "provably absent" check must prove it found the right place
  before it trusts absence — see [[path-normalization-delete-primitive]]
  for the same shape of bug from 2026-07-25.
- **Exited-pane relaunch raced the debounce**: within 300 ms of an exit the
  history cache was empty, so the button fell back to a fresh create and
  forked the conversation with no signal. Fix: fetch before choosing.
- **Label keyed on the command, not the pin**: a `--continue` launch is
  `conversation:false` and would have read `resume` while resuming "the most
  recent conversation in the folder". Now `start again`.
- Test-engineer found the unit-level store test statted the REAL
  `~/.claude/projects` of whoever ran the suite (missing `CLAUDE_CONFIG_DIR`
  shim) — fixed in the test; app never touched.
- 500 spawn-failure bodies leaked `Error: spawn claude ENOENT` into UI
  chrome — plain body now, detail in server.log.

## Open / for the user

- The `Continue last conversation` checkbox is the one path history cannot
  pin (known limit, recorded). Dropping it is the user's call.
- Effort option labels are Claude's own level names (`xhigh` included).
- Requires Claude Code ≥ 2.1.263; no version probe.
- The user's running backend predates this change: the new UI needs a
  backend restart (close all windows → 30 s grace → relaunch). Old
  previous.json entries were not migrated (they carried no conversation id).
- `/verify-terminal` live pass: checks 1–4 passed against a scratch backend
  in the UI agent's run; 5–9 not run (no terminal-path change). Windows-eye
  pass of the new dialog still open.

Touched: [[session-history-resume]], [[lifecycle-bound-backend]],
[[wsl-0600-not-a-boundary]], [[no-code-in-ui-copy]]
