# B11 — Session state: Working vs. Waiting for you; the agents table behind a switch; at most 4 running agents

Status: LANDED 2026-09-22 (`e5995f5` the landing, `bb84661` the counts back to BEL-only on the user's Windows check; user-verified on Windows 2026-09-22: "alles werkt naar behoren"; suite 3368 → 3437; two parallel developers, one fix round of 3 — the first session in a folder Claude never opened, the round-robin tick budget, the per-file-cap test; security clean twice; 90 mutants / 4 equivalent; verify-terminal T1–T4 PASS with a real claude session; Windows check owed to the user; log `memory/log/2026-09/nocturne/2026-09-22-nocturne-b11.md`); earlier: STARTED 2026-09-22 (user: "begin verder werken aan de app"; next row in the status table; the many-agents reading confirmed by the user at the start: "Klopt, begin B11"); earlier: DECIDED 2026-09-22 (user, on the B7 Windows check — `.claude/plans/PLAN-NOCTURNE.md` § B11 (a)–(d)).

Part B11 of `.claude/plans/PLAN-NOCTURNE.md`. Conventions: `.claude/plans/README.md`.

## What the user gets

1. A Claude session no longer says "Working" the whole time it is alive. Its
   pane dot + pill, its Sessions-drawer row and its tab dot read, from the
   session's own transcript:
   - **Working** — green, PULSING: Claude is generating or running a tool.
   - **Waiting for you** — amber, STILL: Claude ended its turn and waits for
     input (also after an interrupt, an API error, a fresh session at its
     first prompt).
   - **Needs your answer** — amber, pulsing: a BEL, unchanged, wins over both.
   - **Finished** — grey: the PTY exited, unchanged.
   The statusline's `N waiting for you` counts BEL sessions AND waiting
   sessions (each session once).
2. The Background agents table (B7) appears only when the user switches it on
   in Settings → Status bar ("Background agents under the terminal", default
   OFF) — Claude Code's own inline task list cannot be hidden on its own
   (`disableAgentView` kills background agents entirely; docs checked
   2026-09-22), so the duplicate is the user's choice.
3. With many agents the table stays short: at most 4 running rows, then a
   count line; one finished row only when there is room.

## Decided (user, 2026-09-22) — do not re-ask

(a) Switch in Settings → Status bar, like `paneBar`, default OFF.
(b) Words + colours as above; statusline counts waiting sessions too; source
    = the session's own transcript, the B7 tail on one more file.
(c) Now, before B8; ships in v0.4.0.
(d) Many agents — the user's words: "max 4 die running zijn, als er meer dan
    4 zijn +1 of hoeveel agents aan het werk zijn. Of +1 actief en +10
    finished. En als je 3 actief heb, dan toon je 1 laatste finished daarbij
    en de rest +aantal agents finished." Confirmed reading (2026-09-22): at
    most 4 running rows, OLDEST first; more running → a count `+N working`;
    at most ONE finished row (the most recently finished), only when fewer
    than 4 run; every other finished agent → a count `+N finished`.
    Examples: 6 running + 10 finished → 4 rows, `+2 working`, `+10 finished`;
    3 running + 5 finished → 3 rows + 1 finished row, `+4 finished`;
    4 running + 2 finished → 4 rows, `+2 finished`; 0 running + 12 finished
    → 1 finished row, `+11 finished`.

## Orchestrator defaults (recorded 2026-09-22, not asked; each a cheap flip ⟲)

- **Pulse only where the state is KNOWN.** `Working` pulses only when the
  transcript says working (`turn === 'working'`). A session with no turn
  readout — every non-claude session (shell, Codex, Gemini), a claude session
  spawned without the injected status line, one whose transcript was refused
  by the boundary — keeps today's still green `Working`. A pulsing shell
  would claim knowledge the app does not have. ⟲ pulse all running sessions.
- **The tab dot follows, the tab's `Needs you` pill does not.** Tab accent:
  amber pulsing (BEL) > amber still (a waiting session) > green > grey. The
  `Needs you` pill stays BEL-only ("waiting for your ANSWER"). ⟲ pill for
  waiting too.
- **The top bar's Sessions badge** (`main.ts`, title "Sessions waiting for
  you") counts the same set as the statusline — one number in two places.
- **No notification, no attention for waiting.** `attention`, the BEL path,
  `seen`, taskbar flash and the (future) mascot count stay BEL-only. Waiting
  is a readout, it never nags.
- **Known limit, written in the code comment:** Claude Code's permission
  prompt writes nothing to the transcript (the last line is the assistant's
  `tool_use`) → it reads `Working` unless the BEL fires (`Needs your
  answer`). An orchestrating session that ended its turn while its
  background agents run reads `Waiting for you` — true: the user can type.

## The turn rule (server, the session's own transcript)

The transcript is `<transcript_path>` from the B1 snapshot — the file whose
`<uuid>/subagents` directory B7 already watches, derived from the tracked
subagents dir (`<parent>/<uuid>.jsonl`), inside the same realpath boundary,
re-checked per poll exactly like the subagents dir (B7 amendment 2), opened
`O_RDONLY | O_NOFOLLOW | O_NONBLOCK`, `fstat().isFile()`.

Fold, line by line, keeping only the verdict of the LAST line that counts
(measured on this machine's transcripts 2026-09-22, Claude Code 2.1.27x):

- Not JSON, `type` not `user`/`assistant`, `isMeta: true`, `isSidechain:
  true` → skipped.
- `user` whose content (the string, or the first text block's text) starts
  with `<command-name>`, `<command-message>`, `<local-command-stdout>`,
  `<local-command-stderr>` or `<local-command-caveat>` → skipped (a local
  slash command such as `/model` starts no turn; a skill command's own work
  shows up in the lines after it).
- `user` whose text starts with `[Request interrupted by user` → `waiting`.
- any other `user` (a prompt, a `tool_result`, a `<task-notification>`) →
  `working`.
- `assistant` with `isApiErrorMessage: true` or `message.model ===
  '<synthetic>'` → `waiting`; with `stop_reason` one of `end_turn`,
  `stop_sequence`, `refusal`, `max_tokens` → `waiting`; any other stop reason
  (`tool_use`, `pause_turn`, null) → `working`.

First sight of a transcript reads only its TAIL: from `max(0, size −
TURN_TAIL_BYTES)` with `TURN_TAIL_BYTES = 1 MiB`, dropping the first partial
line when it did not start at 0; then incremental like B7 (offset, carry,
`MAX_LINE`, the per-file and per-tick budgets — the main transcript shares the
16 MiB tick budget). A file that shrank → re-read its tail. A transcript
path whose file does not exist yet (Claude Code creates it at the first
prompt) → `waiting` (the session sits at its first prompt). A tail with no
counting line → no readout (`turn` absent). No stale rule for the turn: a
long tool call is still working.

A session that exited: its `turn` is no longer sent (the watcher untracks at
exit — B7 — and `SessionManager` drops `turn` when it marks the session
exited); the UI ignores `turn` on an exited session anyway.

## The agents list (server)

Replaces B7's `MAX_FINISHED = 3` / `MAX_ROWS = 8`:
`MAX_RUNNING_ROWS = 4`. Rows = the running agents oldest first, first 4;
then, only when fewer than 4 run, the ONE most recently finished (latest
`endedAt`). Counts = totals over every TRACKED agent (≤ `MAX_AGENTS = 64`,
unchanged — a 65th agent is beyond both list and count; the comment says so).
The frontend derives `+N working` = `running − running rows`, `+N finished` =
`finished − finished rows`.

## Frozen protocol (`shared/protocol.ts`; the backend developer writes it, text frozen here)

After `SessionAgent`:

```ts
/**
 * Nocturne B11: what a Claude session is doing between BELs, read from its own
 * transcript (server/agents.ts, PLAN-B11 § The turn rule): 'working' — Claude
 * is generating or running a tool; 'waiting' — it ended its turn and waits for
 * input.
 */
export type SessionTurn = 'working' | 'waiting';

/** Nocturne B11: every subagent the server tracks for a session (≤ 64), by state. */
export interface SessionAgentCounts {
  running: number;
  finished: number;
}
```

`SessionInfo.agents` doc comment becomes: "… running ones first (oldest
first, at most 4), then — only when fewer than 4 run — the one most recently
finished; `agentCounts` carries the totals …". Added after `agents?`:

```ts
  /** Nocturne B11: totals behind `agents` (present exactly when `agents` is). */
  agentCounts?: SessionAgentCounts;
  /**
   * Nocturne B11: the transcript's verdict. Absent = unknown (no transcript,
   * refused path, no counting line yet, a non-claude session). Dropped when the
   * session exits.
   */
  turn?: SessionTurn;
```

`UiStatusLine` gains, after `time?`:

```ts
  /**
   * Nocturne B11: the Background agents table under the terminal
   * (ui/pane-agents-model.ts). Default OFF (user, 2026-09-22): Claude Code
   * draws its own task list inside the terminal and cannot hide it without
   * disabling background agents. Pane only; the script ignores it.
   */
  paneAgents?: boolean;
```

`server/statusline.mjs` `DEFAULT_CONFIG` gains `paneAgents: false` (the
factory tables must stay one list — `tests/ui-statusline-model`), and the
prefs validation wherever `paneBar` is accepted accepts it too.

Frozen server signatures (`server/agents.ts`):

```ts
export interface AgentsReport {
  agents: SessionAgent[];
  counts: SessionAgentCounts;
  /** Absent = unknown. */
  turn?: SessionTurn;
}
/** One transcript line's turn verdict; undefined = the line does not count. Total, never throws. */
export function turnOfLine(line: string): SessionTurn | undefined;
export function sameReport(a: AgentsReport | undefined, b: AgentsReport | undefined): boolean;
// AgentsWatcher.start's callback becomes:
start(onChange: (id: string, report: AgentsReport) => void): void;
// track(id, subagentsDir) unchanged — the transcript is derived from it.
```

The watcher calls `onChange` for a session also when it has NO agents but a
turn (today it stays quiet until the first agent). `SessionManager.setAgents`
becomes `setReport(id: string, report: AgentsReport): void` — it sets
`agents` + `agentCounts` only when `counts.running + counts.finished > 0`
(both absent otherwise, as today) and `turn` as reported; no-op on an unknown
or exited session; re-sends `info` only on a real change.

Frontend (DOM-free models, signatures frozen):

```ts
// web/src/ui/session-state.ts (new) — ONE place for the readout, used by
// panes.ts, sessions.ts, tabs.ts / state.ts, statusline.ts, main.ts.
export type SessionReadout = 'attn' | 'waiting' | 'working' | 'running' | 'exited';
/** attn (BEL) > exited > waiting > working (turn known) > running (no turn readout). */
export function sessionReadout(s: Pick<SessionInfo, 'status' | 'attention' | 'turn'>): SessionReadout;
/** 'Needs your answer' · 'Waiting for you' · 'Working' · 'Working' · 'Finished'. */
export function readoutWord(r: SessionReadout): string;
/** True for 'attn' and 'waiting' — the set `N waiting for you` and the Sessions badge count. */
export function needsYou(r: SessionReadout): boolean;

// web/src/ui/pane-agents-model.ts
/** Rows + the count line; empty when the switch is off, the session is not claude, or it has no agents. */
export function agentTable(session: SessionInfo | undefined, cfg: StatusLineCfg, now?: number):
  { rows: AgentRow[]; moreWorking: number; moreFinished: number };
```

Classes: `is-work` (green, pulse animation), `is-wait` (amber, still),
`is-run` (green still, unchanged), `is-attn`, `is-exit` — on `.dot`,
`.pane-state`, the drawer's meta. The new pulse honours
`prefers-reduced-motion` (correction after the reviews: the existing
`is-attn` pulse does NOT — pre-existing, out of B11's scope, left for B8). The count line: `+2 working` and
`+10 finished` as two separate words in one quiet row under the rows, on the
themed inks (the B9 constraint of B7 stands); no decorative separator (copy
rule); a count of 0 is not drawn; the whole table is not drawn when rows and
both counts are empty (A3 rule: never an empty table).

## Files

Backend (`backend-pty`): `shared/protocol.ts`; `server/agents.ts` (turn fold +
tail read + derived transcript + the new list rule + report); `server/sessions.ts`
(`setReport`, drop `turn` at exit); `server/index.ts` (the callback);
`server/statusline.mjs` (`paneAgents: false`); prefs validation if it
whitelists statusLine keys. Tests: `tests/agents.test.ts` (`turnOfLine` on
every rule above incl. a real-shaped interrupt, `<command-name>`, synthetic
error, task-notification; tail read of a >1 MiB transcript; a missing
transcript → waiting; list rule on the four examples in (d); counts; a
turn-only report with no agents), `tests/sessions*.test.ts` (`setReport`, turn
dropped at exit), `tests/statusline-script.test.ts` / `tests/ui-statusline-model`
(factory tables agree).

Frontend (`terminal-ui`, `/frontend-designer` applies): `web/src/ui/session-state.ts`
(new); `web/src/ui/panes.ts` (dot + pill via the model); `web/src/ui/sessions.ts`
(drawer row); `web/src/state.ts` (`viewAccent`/tab accent + a
`needsYouCount()` beside `attentionCount()` — keep `attentionCount` for the
BEL-only users); `web/src/ui/tabs.ts`; `web/src/ui/statusline.ts`;
`web/src/main.ts` (Sessions badge); `web/src/ui/pane-agents-model.ts` +
`web/src/ui/pane-agents.ts` (count line); `web/src/ui/statusline-model.ts`
(`paneAgents: false` in FACTORY + KEYS); `web/src/ui/settings.ts` (the row);
`web/src/styles/app.css` (`is-work`, `is-wait`, count line). Tests:
`tests/ui-session-state.test.ts` (new), `tests/ui-pane-agents-model.test.ts`
(the four examples, switch off → empty, counts of 0 not drawn), existing
statusline/tabs/sessions/settings tests updated.

Line numbers drift; seams are named by symbol.

## Phases

1. Backend and frontend in parallel (own scratch subfolders), the protocol
   text above as the contract.
2. Reviews: `scope-reviewer` (both), `security-auditor` (backend: one more
   file opened from an untrusted path — the derived transcript, the tail
   seek, the budget), `test-engineer` (both). One fix round; one test gate —
   FULL mutation probe on `server/agents.ts` (path boundary), ~10 mutants on
   the UI half.
3. Final gate: `janitor`; `/verify-terminal` scoped to the pane seam (the
   table appearing/disappearing with the switch refits the terminal; V1/V3 on
   a claude session) plus the readout end to end on a scratch backend with a
   real claude session: Waiting for you at the first prompt → Working while
   it answers → Waiting for you after; screenshots ≤ 3.
4. Windows check owed to the user: the dot pulses green while Claude works
   and turns amber-still when it waits; `N waiting for you` counts it; the
   agents table only after switching it on; `+N working` with 5+ agents.

## Gates

- `npm run typecheck`, `npm run build`, `npm test` green (baseline: the
  count at the start of the part).
- No new dependency, no env var, no new top-level folder.
- `attention` semantics untouched (BEL only).

## Amendments after the reviews (2026-09-22; they win over the items above)

- **A folder Claude has never opened reads Waiting for you too** (scope
  review): at the first prompt of the first session in a new folder,
  `~/.claude/projects/<slug>` does not exist yet and B7's boundary refused
  the path, so the pane read still-green Working. A transcript path whose
  parent is exactly one missing component directly under the REAL projects
  root is tracked as pending: `turn: 'waiting'`, re-checked every poll, the
  full boundary applied the moment the folder exists. A deeper missing
  path stays refused.
- **The per-tick read budget rotates** (security note): the 16 MiB budget
  starts at a different session each tick, so busy sessions cannot starve
  a later session's turn and agents.
- **The exit shape** (scope note): at exit every running row becomes
  finished (B7), so an exited session can show up to 4 finished rows plus
  `+N finished`; `agentCounts` becomes `{ running: 0, finished: total }` in
  the same frame, so the numbers still add up.
- **Developer choices accepted by the reviews:** a missing transcript reads
  `waiting` only on `lstat` ENOENT (a dangling symlink reads nothing); a
  symlinked transcript is refused even inside the root; a refused subagents
  dir no longer silences the turn; the tab dot pulses green when any
  session in it works; the Waiting for you pill has no amber tint (the tint
  stays the BEL's).
- **The counts stay BEL-only** (user, 2026-09-22, on the Windows check of
  the landed part: "dat daaronder mag weg, waiting for you"; asked, chose
  "terug naar alleen BEL"): the statusline's `N waiting for you` and the
  Sessions badge count BELs again, as before B11. Waiting for you shows on
  the pane, the drawer row and the tab dot only. `needsYouCount()` and
  `needsYou()` are gone; this overrides (b)'s "counts waiting sessions too"
  and the Sessions-badge default above.
