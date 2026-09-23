# Plan B7 — Background agents table live: the subagents Claude Code runs for a session, read from its transcripts (Nocturne Track B)

Status: LANDED 2026-09-22 (`88209b4` the landing, CI green after one runner-flake rerun of T14; user-verified on Windows 2026-09-22 from the dev window with a real Explore subagent: "oh dit is nice … Hij werkt dus wel" — the row appeared, its time and tokens moved; the user's two remarks became B11 in the master plan (the agents stand twice on screen; the session state itself); suite 3258 → 3368; two parallel developers, one bundled fix round of 7, 81 mutants / 0 live, verify-terminal B7-1…7 + V1/V3/V4 PASS on a scratch backend + headless Chromium; Windows check owed to the user; log `memory/log/2026-09/nocturne/2026-09-22-nocturne-b7.md`); earlier: STARTED 2026-09-22 (user: "continue werken aan dit app"; next row in the status table; the data source — the open decision the B7 row carried since 2026-09-10 — DECIDED 2026-09-22 by the user from three options: Claude Code's transcripts; the shape below is the orchestrator's, recorded before the developer started).

Part B7 of `.claude/plans/PLAN-NOCTURNE.md`. Conventions: `.claude/plans/README.md`.

## What the user gets

Under a Claude session's terminal, under the pane status bar, the "Background
agents" table the v3 design has (A3 built it and shipped it empty): one line
per subagent this session has spawned — a dot, the agent's name in mono, the
task it was given, how long it has run, how many tokens it spent. It appears
when the first subagent starts and is never shown empty. Sessions of other
tools (Codex, Gemini, shells) have no table: nothing this app knows describes
their agents.

## Decided (user, 2026-09-22): the data source is Claude Code's transcripts

Claude Code writes, per session, next to its transcript
`~/.claude/projects/<slug>/<session-id>.jsonl`, a directory
`~/.claude/projects/<slug>/<session-id>/subagents/` holding for every subagent

- `agent-<hex>.meta.json` (mode 0644, ~200 bytes, written once at spawn):
  `{"agentType":"test-engineer","description":"Test gate B2 Brief B (lean)","toolUseId":"toolu_…","spawnDepth":1,"requestShape":"background","requestNonInteractive":true,"model":"opus"}`
- `agent-<hex>.jsonl` (mode 0600, grows while the agent runs; 0.7–1.4 MB
  measured for a 15-minute agent, one line up to ~120 KB): one JSON object per
  line, every line carries `timestamp` (ISO) and `type` (`user`, `assistant`,
  `attachment`, …); an `assistant` line carries `message.id`,
  `message.stop_reason` and `message.usage` (`input_tokens`,
  `cache_creation_input_tokens`, `cache_read_input_tokens`, `output_tokens`).
  One API message is written as SEVERAL consecutive lines with the same
  `message.id` (one per content block, `apiBlockIndex`), each repeating the
  same `usage` — counted ONCE per `message.id`.

Measured on Claude Code 2.1.273–2.1.278 (2026-09-16/22). The parent transcript
marks the START of a background agent only ("Async agent launched
successfully"); its end is a `task-notification` the parent enqueues — not
used here. An agent's end is read from its OWN transcript: the last `user` or
`assistant` line is an `assistant` line with `stop_reason: "end_turn"`. A later
`user` line (the orchestrator resumed the agent through SendMessage) makes it
running again.

Where the directory IS: the status-line payload Claude Code hands
`server/statusline.mjs` on every turn carries `transcript_path` (the absolute
path of `<session-id>.jsonl`; `tests/server/statusline-script.test.ts` already
fixtures it). The subagents directory is `<dirname>/<basename without
.jsonl>/subagents`. The app's own session id is NOT used: a resumed
conversation's Claude session id is the old one, and only the payload knows it
(the B1 lesson, `memory/decisions/pane-status-bar-data-source.md`).

Rejected (user, 2026-09-22): Claude Code hooks (`SubagentStart`/`SubagentStop`
in the user's `~/.claude/settings.json`; no tokens in the payload; more
moving parts — the same reason decision 2 rejected hooks); dropping the part
(an honest empty table).

## Orchestrator defaults (recorded 2026-09-22, not asked; each a cheap flip ⟲)

- **The path travels through the B1 snapshot.** `server/statusline.mjs` adds
  `transcript` (the payload's `transcript_path`, raw, only when it is a
  non-empty string ≤ 1024 chars) to the snapshot it already writes; the
  snapshot is the one file the script writes and the one directory the backend
  watches. No second file, no second watcher for the handover.
- **The path is UNTRUSTED and bounded before anything is read.** The snapshot
  lives in the data dir any process of this user can write
  (`memory/knowledge/wsl-0600-not-a-boundary.md`). So a transcript path is
  accepted only when: it is absolute; `path.normalize(p) === p` (no `..`, no
  `//`, no trailing separator); no control character, no NUL; its basename is
  `<uuid>.jsonl` (the same UUID shape `server/conversation.ts` `isUuid`
  checks); `realpathSync(dirname(p))` is INSIDE `realpathSync(<claude projects
  root>)` (`join(homedir(), '.claude', 'projects')`, a new `DataPaths`
  member `claudeProjectsDir`, overridable ONLY through the watcher's
  constructor for tests — no env var). Only then is
  `join(<real dirname>, <uuid>, 'subagents')` ever opened. Everything read
  there is read like `server/telemetry.ts` reads a snapshot: `O_RDONLY |
  O_NOFOLLOW | O_NONBLOCK`, `fstat().isFile()`, bounded.
- **Polling, not inotify.** `~/.claude/projects/<slug>/<session-id>/` does not
  exist until Claude Code writes the first tool result or subagent, and
  `fs.watch` on a missing directory throws; a per-session `readdir` + `stat`
  every 2 s (`POLL_MS = 2000`, one unref'd interval for all tracked sessions,
  the same rate as the telemetry fallback) costs nothing measurable and needs
  no recovery path. Stops for a session at its exit (the last list stays on
  `SessionInfo.agents` — what it cost is still true) and at its removal.
- **Incremental reads.** Per `.jsonl` the watcher keeps the byte offset it
  has parsed up to, and reads only what was appended (`stat().size` grew),
  at most `MAX_READ_PER_POLL = 4 MiB` per file per poll, splitting on `\n`
  and carrying the trailing partial line (a carry longer than `MAX_LINE = 1
  MiB` is discarded and reading resyncs at the next newline; a complete line
  longer than that is skipped unparsed). A file that SHRANK (truncated,
  replaced) is re-read from 0 with its counters reset. Lines that fail
  `JSON.parse` are skipped. A `.meta.json` is read once (≤ 8 KiB) and again
  only when its mtime changed.
- **What a row carries.** `name` = `agentType` (falls back to `agent` when
  missing), `task` = `description` (falls back to `''`), both control-stripped
  and whitespace-collapsed like `clean()` in `server/telemetry.ts`, capped at
  64 / 120. `startedAt` = the first line's `timestamp` (falls back to the
  meta file's mtime while the transcript has no line yet). `tokens` = the sum
  over UNIQUE `message.id`s of `input_tokens + cache_creation_input_tokens +
  cache_read_input_tokens + output_tokens` (the figure the API bills and
  Claude Code's own task line reports; measured 12.5 M for a 15-minute
  test-engineer whose output alone was 14 k — so the column WILL read
  `1.2M`; the output-only figure is the flip ⟲). Duplicates are consecutive,
  so "seen" is the LAST `message.id`, not a set. `state` = `'finished'` when
  the last `user`/`assistant` line is an assistant `end_turn`, else
  `'running'` — EXCEPT that a running agent whose transcript has not grown
  for `STALE_MS = 15 min` is shown `'finished'` with its last timestamp as
  `endedAt` (a killed agent — TaskStop, a usage-limit abort — leaves no end
  marker; 15 min is above the longest single tool call Claude Code allows,
  10 min). `endedAt` = the timestamp of the line that ended it.
- **The list on the wire is capped.** Running agents always (oldest first),
  then finished ones (newest first), at most `MAX_FINISHED = 3` finished and
  `MAX_ROWS = 8` rows in total; the watcher tracks at most `MAX_AGENTS = 64`
  agents per session (newest `.meta.json` by mtime win). A 30-agent session
  (this repo's own orchestration) must not grow a 30-row table under a
  terminal.
- **Attention never fires.** A subagent never asks the user anything, so no
  row is ever `attention`; the `AgentTone` type and its CSS stay (the
  vocabulary is the pane's), but B7 emits only `running` and `finished`.
- **Time is formatted in the browser**, from `startedAt`/`endedAt` and the
  existing 15 s status tick (`STATUS_TICK_MS`), so a running agent's time
  moves without a server message: `0s`, `42s`, `2m 10s`, `1h 05m`, `3d 02h`.
  Tokens: `999`, `12.4k`, `1.2M` (one decimal, trailing `.0` dropped).
- **The B9 colour constraint lands here.** The table sits on the THEMED
  terminal ground: its header, name, task, time, tokens, finished dot and
  BOTH hairlines (`.pane-status` and `.pane-agents` `border-top`, today
  `--color-neutral-900`) take the theme's steps like `.pane-status-k` /
  `.pane-status-v` do (`--xt-bright-black` quiet, `--xt-fg` ordinary; the
  hairline a translucent mix of the quiet step), so they read on a light
  custom ground and are the same hexes on the default. Running dot
  `--color-ok` stays semantic (decision 10c).
- **Nothing for non-Claude sessions.** The script only runs inside claude,
  so only a claude session ever has a transcript; the frontend additionally
  renders no table unless `isClaudeCommand(session.command)`, like the
  status bar.

## Frozen protocol (`shared/protocol.ts`; the backend developer writes it, text frozen here)

Appended after `SessionTelemetry`:

```ts
/** A subagent's dot: it is working, or it has ended (its turn, or it went quiet — PLAN-B7 § defaults). */
export type SessionAgentState = 'running' | 'finished';

/**
 * Nocturne B7: one subagent Claude Code ran for a session, read by
 * server/agents.ts from `~/.claude/projects/<slug>/<session-id>/subagents/`
 * (found through the snapshot's transcript path). Every string crossed an
 * untrusted file and was sanitised: control-stripped, capped (name 64, task
 * 120); numbers are finite integers ≥ 0.
 */
export interface SessionAgent {
  /** The hex after `agent-` in the file names: `^[a-f0-9]{1,32}$`. */
  id: string;
  /** `agentType` from the meta file (`agent` when it had none), mono in the UI. */
  name: string;
  /** `description` from the meta file — what it was asked to do, in words. */
  task: string;
  /** ISO-8601: the first transcript line, or the meta file's mtime before there is one. */
  startedAt: string;
  /** ISO-8601, present exactly when `state` is 'finished'. */
  endedAt?: string;
  /** Billed total across the agent's unique API messages: input + cache creation + cache read + output. */
  tokens: number;
  state: SessionAgentState;
}
```

Added to `SessionInfo`, after `telemetry?`:

```ts
  /**
   * Nocturne B7: the subagents Claude Code ran for this session, from its
   * transcripts (server/agents.ts). Absent until the first one; running ones
   * first (oldest first), then at most 3 finished (newest first), at most 8
   * rows; replaced whenever the list changes (the server re-sends `info`);
   * kept after exit.
   */
  agents?: SessionAgent[];
```

Snapshot file (`<dataDir>/statusline-snapshots/<id>.json`, version stays 1):
one new optional key `transcript: string` = the payload's `transcript_path`
verbatim. `parseSnapshot` in `server/telemetry.ts` keeps ignoring keys it does
not know, so the telemetry half never sees it; a new pure export
`transcriptFromSnapshot(text: string): string | undefined` returns the key
when it is a string of 1–1024 chars without control characters, else
undefined (the boundary check itself is `server/agents.ts`'s).
`TelemetryWatcher.start` gains a third callback argument:
`onChange(id, telemetry, transcript: string | undefined)`.

Frozen server signatures (`server/agents.ts`, new):

```ts
export interface AgentsWatcherOptions {
  /** Realpath'd lazily; default `paths.claudeProjectsDir`. Tests point it at a temp dir. */
  projectsRoot: string;
  pollMs?: number;   // default 2000
  now?: () => number; // default Date.now (tests pin the clock for STALE_MS)
}
/** The subagents directory for a snapshot's transcript path, or null when the path is refused. Pure except for realpath. */
export function subagentsDirFor(transcript: string, projectsRoot: string): string | null;
/** Parse one transcript line's contribution. Exported for tests; total, never throws. */
export function foldLine(acc: AgentFold, line: string): void;
export class AgentsWatcher {
  constructor(log: Logger, options: AgentsWatcherOptions);
  /** Start (idempotent) and hand every changed list to `onChange`; lists are compared field-wise before a call. */
  start(onChange: (id: string, agents: SessionAgent[]) => void): void;
  /** Watch this session's directory from now on; a second call with another path replaces the first (a resumed session re-reports). */
  track(id: string, subagentsDir: string): void;
  /** Stop polling this session; its last list stands wherever it was delivered. */
  untrack(id: string): void;
  stop(): void;
}
```

`SessionManager` (`server/sessions.ts`) gains `setAgents(id: string, agents:
SessionAgent[]): void` next to `setTelemetry` (same two silent no-ops; a
field-wise `sameAgents` in `server/agents.ts`), and calls
`agentsWatcher.untrack(id)` where a session exits and where it is removed —
wired in `server/index.ts` next to the telemetry watcher: the telemetry
callback becomes

```ts
telemetry.start((id, snapshot, transcript) => {
  sessions.setTelemetry(id, snapshot);
  if (transcript !== undefined) {
    const dir = subagentsDirFor(transcript, paths.claudeProjectsDir);
    if (dir !== null) agents.track(id, dir);
  }
});
```

Frontend (`web/src/ui/pane-agents-model.ts`, new, DOM-free):

```ts
/** Rows for the table, formatted for `renderAgents`; [] for a non-claude session or one without agents. */
export function agentRows(session: SessionInfo | undefined, now?: number): AgentRow[];
export function formatDuration(ms: number): string; // 0s · 42s · 2m 10s · 1h 05m · 3d 02h
export function formatTokens(n: number): string;    // 999 · 12.4k · 1.2M
```

`web/src/ui/panes.ts` `updateStatus` replaces `const rows: AgentRow[] = []`
with `agentRows(info, Date.now())`; the signature rule already there renders
once per real change and the 15 s tick moves the running times.

## Files

Backend (developer: `backend-pty`):
- `server/statusline.mjs` — `writeSnapshot` adds `transcript`; the top-of-file
  fourth-argument note gains one line. Nothing else.
- `server/telemetry.ts` — `transcriptFromSnapshot`, the third callback
  argument.
- `server/agents.ts` — new: the boundary, the fold, the watcher, `sameAgents`.
- `server/config.ts` — `claudeProjectsDir` in `DataPaths`.
- `server/sessions.ts` — `setAgents`, the untrack hooks (constructor takes the
  watcher like it takes the settings store; the existing tests construct a
  `SessionManager` — keep the parameter optional or give them a stub, the
  developer's call).
- `server/index.ts` — the wiring above; `stop()` beside `telemetry.stop()`
  at both shutdown sites.
- `shared/protocol.ts` — the frozen text.
- Tests: `tests/server/agents.test.ts` (new: `subagentsDirFor` refusals — relative,
  `..`, a symlinked dir outside the root, a non-uuid basename, a control
  character, 1025 chars; `foldLine` — duplicates by `message.id`, `end_turn`
  then a later user line, a line that is not JSON, usage without cache keys;
  the watcher on a temp root — a meta without a jsonl, growth by append,
  truncation, the 15 min stale rule with a pinned clock, the 3/8 cap, the 64
  tracked cap, `untrack`, `stop`), `tests/server/statusline-script.test.ts` (the
  snapshot carries `transcript`, and NOT one that is not a string),
  `tests/server/telemetry.test.ts` (`transcriptFromSnapshot`, the third argument),
  `tests/server/protocol.test.ts` if it pins `SessionInfo` keys.

Frontend (developer: `terminal-ui`):
- `web/src/ui/pane-agents-model.ts` — new, the three functions above.
- `web/src/ui/panes.ts` — one line in `updateStatus` plus the comment that
  said "until B7".
- `web/src/ui/pane-agents.ts` — the header comment (no longer "A3 ships it
  empty").
- `web/src/styles/app.css` — the B9 constraint: `.pane-agents*` inks and the
  two hairlines onto the theme's steps.
- Tests: `tests/ui/ui-pane-agents-model.test.ts` (new: the formats at their
  boundaries — 59 s / 60 s / 3599 s / 3600 s / 86400 s, 999 / 1000 / 999 949 /
  999 950 / 1 000 000; running time from `now`, finished time from `endedAt`;
  a non-claude session → []; an empty list → []), and the existing
  `tests/ui/ui-pane-agents.test.ts` if there is one.

Line numbers in this file drift; the seams are named by symbol.

## Phases

1. **Backend** and **frontend** in parallel, each on its own subfolder of the
   scratchpad, the protocol text above being the contract (the frontend
   developer writes the same interface into a local stub only if the backend
   has not landed it yet — and deletes the stub before reporting; the
   orchestrator merges).
2. **Reviews**: `scope-reviewer` (both diffs), `security-auditor` (the
   backend diff — file reads by a path from an untrusted file, the realpath
   boundary, the bounded incremental reads, the cap on tracked agents; also
   the client-side text from those files reaching the DOM through `el()` only
   as text nodes), `test-engineer` (both). One fix round, one test gate per
   the lean rules; `server/agents.ts` is hard-constraint code (path
   boundary) → FULL mutation probe there, the ~10 cap for the UI half.
3. **Final gate**: `janitor`; `/verify-terminal` scoped to the pane seam
   the table touches — the terminal refits when the table appears under it
   and when it disappears (rows planted under a scratch cwd's slug in the
   REAL `~/.claude/projects`, so the boundary is exercised end to end, and
   removed afterwards), plus V1/V3 unchanged on a claude session; the
   themed inks on a light custom ground by screenshot.
4. **Windows check** owed to the user: a claude session in the dev window
   that spawns a subagent (`/dev-flow`-style or a plain "use an agent to
   …"), the row appears within ~2 s, its time moves, the dot goes grey when
   the agent finishes, and the table's ink reads on a light terminal scheme
   from Settings → Terminal colours.

## Amendments after the reviews (2026-09-22; they win over the items above)

- **The projects root honours `CLAUDE_CONFIG_DIR`** (scope review): `claudeProjectsDir` = `<CLAUDE_CONFIG_DIR | ~/.claude>/projects`, derived the way `server/history.ts` already derives the same root — one helper, no third copy. The homedir-only form above was wrong for a user with that variable set (the table would never appear, silently).
- **The boundary is re-checked on the directory actually opened** (security audit, verified with a probe): `subagentsDirFor` realpaths the transcript's parent only, and a symlink planted AT the `<uuid>` or `subagents` component was followed by `readdir`/`stat`. The watcher now realpaths the session's directory on every poll and skips it unless it is inside the real root.
- **A global per-tick read budget** (orchestrator): `MAX_READ_PER_TICK = 16 MiB` across all sessions and files, inside which the 4 MiB per-file cap still applies; a file whose remainder did not fit continues next tick. First sight of a 30-agent session no longer parses tens of MB of JSON on the PTY thread in one tick (`readBudgetBytes` option for tests).
- **Tracking is gated on a live session** (security nit + scope note): the telemetry callback tracks only a session that exists and has not exited — a snapshot landing after `onExit` (the 150 ms debounce / 2 s poll) would otherwise re-track a dead session for as long as its pane stayed open.
- **Refusals and realpath results are logged safely** (scope + security): a refused transcript path leaves one debug line (server.log is the only diagnostic channel), and every path a log line carries goes through `oneLine()` — a realpath RESULT is not the control-checked input.
- The unused `projectsRoot` getter is gone; `newFold`, `trackedCount` and `MAX_META_SCAN` (a `readdir` with a million planted metas must not become a million `stat` calls) stay as justified extras.

## Gates

- `npm run typecheck`, `npm run build`, `npm test` green (baseline 3258).
- No new dependency. No env var. No new top-level folder.
- The table is NEVER rendered empty (A3 rule stands), never for a non-claude
  session, and never shows a value the transcript did not carry (a missing
  usage contributes 0 to the sum — a real 0, since the message really cost
  nothing we could see — but a missing timestamp on the first line falls back
  to the meta mtime rather than to "now").
