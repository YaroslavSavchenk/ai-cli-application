# Plan: code quality first, then the app's speed

Status: see the table below (updated 2026-09-23). Conventions: `.claude/plans/README.md`.

| Part | What | State | Spec | Landed |
| --- | --- | --- | --- | --- |
| Q0 | `CONTRIBUTING.md`: how code is written here, plus guards that enforce what can be measured | landed | — | 2026-09-23 |
| Q1 | Duplicates that differ in behaviour: one home each, the correct variant, a test per edge | landed | — | 2026-09-23 |
| Q2 | Test sleeps that stand in for a condition become condition waits | landed | — | 2026-09-23 |
| Q3 | The agents watcher re-reads a meta file it caught half-written | landed | — | 2026-09-23 |
| Q4 | Leftovers of the O8 split: the Files panel's `ctx` getters, repeated test setup | landed | — | 2026-09-23 |
| P0 | Measure: bundle, boot, idle CPU, scrollback replay, memory per session — a report to the user | landed — report in `memory/log/2026-09/project/2026-09-23-quality-p0-measurements.md` | — | 2026-09-23 |
| P1+ | The speed work the user picks from P0's report | todo — the user decides after P0 | — | |

## Resume here

**The user's phrase for this plan is "begin aan de kwaliteit"** (also:
"code-kwaliteit", "ga door met de kwaliteit"). It is a third track beside
"begin aan <id>" (an app part of `.claude/plans/PLAN-NOCTURNE.md`) and
"begin aan de optimalisatie" (the repo's layout, `.claude/plans/PLAN-RESTRUCTURE.md`).
Unlike the restructure track, this one MAY change behaviour — each part says
where, and every change is proven by a test.

When the user says it: read this file, `CONTRIBUTING.md` and `tests/README.md`,
`ListAgents` for a peer in the checkout, take the first `todo` row, run it
through `/dev-flow`, land it (table row + vault log in the same commit),
push, watch CI to green.

## The decision that started it (2026-09-23)

After the restructure day the user asked whether everything was now well
optimised and object-oriented. The honest answer: structurally mostly, not
object-oriented (and not meant to be — functions by default, classes for
things with a lifetime), and the app itself was not made faster. The user:
code quality first, then optimisation — and "richtlijnen … dat vanaf
volgende keer dit wel op zo'n manier gedaan wordt". Answers the same day:

1. **Relative times read "5 minutes ago" everywhere** (the commit list's
   form); the sessions list and status lines follow.
2. **Duplicates that differ: the orchestrator picks the most correct
   variant** per case, with a test per edge case, and names every choice in
   the landing report; it stops and asks when a choice changes visible UI
   text beyond decision 1.
3. **A new master plan with its own phrase** (this file).
4. **Speed: measure first, then the user picks** (P0 is a report, P1+ waits
   for the user's word).

## Fixed rules for every part

- `/dev-flow`: developer → reviewers (scope always; security when a seam of
  `.claude/PROJECT-SCOPE.md` § Hard technical constraints is touched) →
  one fix round → final gate. Suite green, CI green.
- Code follows `CONTRIBUTING.md`, tests follow `tests/README.md`.
- No test is deleted or weakened without the user's word; a behaviour
  change comes with the test that pins the new behaviour.

## Parts

- **Q0** — `CONTRIBUTING.md` at the repo root: module shapes (`*-model.ts`
  pure, `*-store.ts` state, view modules), functions by default and classes
  for things with a lifetime, one home per helper (`server/config.ts`,
  `web/src/ui/util.ts`, `shared/`), no dead code or needless export, file
  size, headers and comments, error sentences and logging, the hard
  constraints. Guards in `tests/repo/`: the existing size guard plus a
  duplicate-function guard (identical function bodies in two source files
  fail the suite). Cited from `CLAUDE.md`, the developer agents and
  `/dev-flow`.
- **Q1** — from the O7 survey (log `memory/log/2026-09/project/2026-09-23-repo-optimisation.md`):
  `baseName`/`fileName` ×4 and `joinPath` ×3 (trailing slash), `fmtAgo` vs
  `relativeTime` (decision 1), `numberOrNull` (strictness), `statusOf`
  (`null` vs `0`), `isClaudeCommand` (`\` in a path), `UPDATE_CHECK_CACHE_MS`,
  the `clean`/`plainObject` twins in `agents-fold.ts` and `telemetry.ts`,
  `isPort`/`VERSION_SHAPE`/`FULL_HASH` shared by server and web, `ensureHome`
  ×2, `${home}/projects` vs `projectsPath`, the ghost transform in `dnd.ts`
  and `filedrop.ts`; and the four pairs the Q0 guard found
  (`tests/repo/no-duplicate-code.test.ts` `KNOWN`: `plainObject`, `isPort`,
  `closeDialog`/`closeFolderPicker`, `clampBehaviour`/`clampStatusLine`) —
  Q1 empties that list. `server/statusline.mjs` keeps its twins (it imports
  nothing from `server/` by design).
- **Q2** — the sleeps listed in `memory/BACKLOG.md` § From the repo
  optimisation; a `dnd.ts` clock seam for the 80 ms click swallow.
- **Q3** — `server/agents.ts`: re-read a meta file when its size changes or
  its last parse failed, not only when its mtime changes; a test that
  reproduces the half-written file.
- **Q4** — `web/src/ui/files*.ts` shares state through `ctx` getters and
  setters since O8: evaluate one `files-state.ts` owner instead; the
  `ui-filedrop-*` pieces repeat ~80 lines of setup because tests assign
  those variables — a fixture with setters.
- **P0** — measure on the author's machine and in the WebView2 host where
  it matters: bundle size per chunk, time to first terminal, idle CPU of
  backend and page (pollers), bytes replayed on a split/close, RSS with
  0/4/12 idle sessions. Report with a proposal per item (the backlog §
  Optimisation round has the candidates); the user picks.
