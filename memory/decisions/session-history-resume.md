---
type: decision
created: 2026-09-06
updated: 2026-09-23
tags: [sessions, history, resume, launch, frontend, backend]
---
# Session history with real per-conversation resume; lean launch dialog

**Status:** decided (2026-09-06, user's call) — reverses the "per-id
`--resume` is a fiction" cut of 2026-07-19 ([[lifecycle-bound-backend]],
[[handoff-design-primary]]).

## What the user reported

Three complaints in one message (Dutch, 2026-09-06): session history "does
not work — sessions are not saved and cannot be resumed"; history should be
"a folder per project instead of loose sessions"; the launch popup is
"functionally correct but not visually: far too many unnecessary things, an
effort choice is missing, too much camelCase/code-ish text — plain short
words, no code or explanation".

## Root causes found (history)

1. `GET /api/previous` only offered `shutdown`/`crash` entries. A session the
   user ends with × is `user-kill`, a natural exit is `exit` — never offered.
   The user's real `previous.json` held exactly two `user-kill` entries.
2. `previous.json` was replaced at every boot — history depth = one run.
3. Relaunch spawned `claude --continue` = "most recent conversation in that
   cwd", not that session's conversation — wrong whenever a project had more
   than one session.

## Decision

- Claude Code 2.1.263 (installed) has `--session-id <uuid>`, `--resume <id>`,
  `--effort <low|medium|high|xhigh|max>` (verified in `claude --help`). So the
  fiction is no longer a fiction: the server injects `--session-id <app
  session uuid>` into every claude-kind spawn that carries no resume flag
  (PTY argv only — `SessionInfo.args` stays the client's argv, exactly like
  the injected `--settings`), records the launch in a cumulative
  `history.json`, and `POST /api/history/:id/resume` respawns `<base args>
  --resume <id>`. All four end reasons are listed. Bound 200, oldest ENDED
  drop first. Crash stamped at boot. Journal/previous files and
  `/api/previous` deleted (old entries not migrated — they were
  `--continue`-only anyway).
- Transcript-based pruning: Claude Code keys transcripts by
  `cwd.replace(/[^a-zA-Z0-9]/g, "-")` under `<config>/projects/` (read from
  the 2.1.263 bundle; names longer than 200 chars are truncated + hashed, not
  reproduced). An ended conversation with no `.jsonl` was never spoken to and
  is noise → pruned at list time. The rule is deliberately one-directional:
  prune only when `<config>/projects/<encoded realpath(cwd)>/` EXISTS and the
  file is absent; anything uncertain keeps the entry. The review round
  caught that the first version encoded the raw cwd — a trailing slash or a
  symlinked cwd would have deleted real conversations (see
  [[2026-09-06-history-and-lean-launch]]).
- UI: HISTORY section in the sessions drawer grouped per project folder
  (project name, or the cwd's last segment for a deleted project), newest
  folder first, collapsible; rows carry relative time · model · `crashed`;
  `resume` for pinned conversations, `start again` otherwise; armed `×`.
  Refetch debounced 300 ms on session status changes, removals, drawer open.
- Launch dialog: a short form — Name (placeholder = project name; blank →
  server titles the session after the project) · Project · Model · Effort ·
  Mode (segmented `always ask` / `auto edits` / `read-only` / `no prompts`) ·
  `Continue last conversation` checkbox · `other command` toggle · Cancel ·
  Launch. Subtitle, preset chips, summary ink well, footer note, permission
  descriptions, hints and mechanic tooltips all removed. Effort option labels
  ARE Claude's level names (`xhigh` included) — they are product vocabulary,
  like the model ids.

## Known limits (recorded, not hidden)

- A launch with `Continue last conversation` emits `--continue` and can never
  be pinned (`--continue` + `--session-id` must not be co-emitted). Its
  history entry resumes with `--continue` again and reads `start again`.
  Option left open for the user: drop the checkbox now that history exists.
- No Claude Code version probe: on a CLI older than `--session-id`, every
  app-launched claude session would die at spawn (`unknown option`). Minimum
  version recorded in the scope doc instead.
- Custom command `claude --session-id <uuid>` launched twice while the first
  is live rebinds the entry mid-flight (token-holder only; Claude refuses the
  duplicate id itself).
- The exited-pane `relaunch` resolves its history entry with a fresh fetch
  before choosing resume vs. create (a fixer-round change; the first version
  raced the 300 ms debounce and could silently fork the conversation).

## Rejected alternatives

- **Keep `--continue` relaunch and only widen the offered reasons** — still
  aliases every session of a project onto the most recent conversation.
- **Learn the conversation id from the status-line payload** (`session_id`
  reaches `server/statusline.mjs`) — only when the status line is enabled;
  too coupled. `--session-id` makes the id ours by construction.
- **Migrate old `previous.json` entries** — they carry no conversation id;
  nothing to resume per-conversation.
- **Keep the preset chips / summary well behind a disclosure** — the user
  wanted them gone, not folded (same answer as 2026-07-25 for the argv
  preview).

Related: [[no-code-in-ui-copy]], [[launch-dialog-custom-escape-hatch]],
[[lifecycle-bound-backend]], [[localhost-security-model]],
[[wsl-0600-not-a-boundary]]

## From the scope doc (moved 2026-09-23)

Verbatim wording of the `.claude/PROJECT-SCOPE.md` bullet before part O1 condensed it; the scope doc holds the current rule.

### Architecture (decided) — Session history with real per-conversation resume

- **Session history with real per-conversation resume — decided and shipped
  2026-09-06, user's call** (reverses the 2026-07-19 "per-id `--resume` is a
  fiction" cut; rationale in `memory/decisions/session-history-resume.md`).
  Every session the app launches is kept across backend runs in
  `history.json` (data dir, 0600, atomic, bounded to 200 entries, oldest
  ENDED entries drop first, live ones never). Mechanism: a claude-kind
  session (`basename(command) === 'claude'`) whose client args carry no
  `--continue`/`-c`/`--resume`/`-r`/`--session-id` is spawned with an
  injected `--session-id <app session uuid>` (PTY argv only — never in
  `SessionInfo.args`, same rule as the injected `--settings`), so the app
  knows the Claude conversation id; resuming spawns `claude <base args>
  --resume <id>` server-side (`POST /api/history/:id/resume`). Every end
  reason is listed (user-kill, exit, shutdown, crash — crash stamped at
  boot for entries left open). Claude conversations whose transcript is
  PROVABLY absent (nothing was ever said) are pruned at list time: only when
  `<CLAUDE_CONFIG_DIR|~/.claude>/projects/<encoded realpath(cwd)>/` exists
  and `<id>.jsonl` is missing — every uncertainty keeps the entry. Requires
  **Claude Code ≥ 2.1.263** (`--session-id`, `--resume <id>`, `--effort`
  verified there); no version probe exists. **Known limit:** a launch with
  Start from "The last conversation in this project" (`--continue`; until
  2026-09-10 the "Continue last conversation" checkbox) can never be pinned — its
  entry resumes with `--continue` again (most recent conversation in that
  folder) and its button reads "start again". A client-supplied
  `--session-id <uuid>` / `--resume <uuid>` (custom command) is adopted as
  the key. Blank session name → title = project name.
