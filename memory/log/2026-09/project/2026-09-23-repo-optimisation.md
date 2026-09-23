---
type: log
created: 2026-09-23
updated: 2026-09-23
tags: [repo, layout, tests, optimisation]
---
# 2026-09-23 — repo optimisation: tests into folders, then the code itself

The user put "herstructureren van het filesysteem" on the day's list and
widened it: optimise the codebase — duplicates, unused code, long files
split — "bij tests wil ik dit vooral toepassen", with written rules for how a
test is written. Four questions asked up front, all answered with the
recommendation: tests first, then source · test > 800 / source > 1 000 lines
is split · pieces stay flat with a prefix · rules in `tests/README.md`.
Decision and move map: [[repo-layout]]; plan rows O4–O8 in
`.claude/plans/PLAN-RESTRUCTURE.md`.

## Batch 4 — `tests/` into subfolders

160 × `git mv` into `ui/ server/ release/ repo/ helpers/`, `fixtures/`
stays. Baseline and result: 3710 / 0 / 0 skipped. A script normalised every
changed hunk by the path mapping; nine hunks differed, all expected (globs,
README map, two tests that scanned the flat folder). Citations in 76 files
outside `tests/` rewritten; `memory/log/` keeps its paths.

## O4 — how a test is written

`tests/README.md`: layout, one topic per file ≤ 800 lines, the header (what ·
how · why · NOT claimed), behaviour-sentence names, the cheapest seam that
proves the claim, condition waits not clocks, clean-up, the one allowed
skip. `tests/repo/file-size.test.ts` enforces the size half with a
shrink-only list of 52 grandfathered files (38 test modules, 14 source);
both directions mutation-checked (a file dropped from the list → red; a
file under its limit left on it → red). Cited from `CLAUDE.md`, the
`test-engineer` agent and `/dev-flow`.

## O5 — duplicated test code into `tests/helpers/`

108 files, net −251 lines, test names byte-exact (sorted name list diffed
against the baseline: only the two new guard tests added), no assertion
changed — the few that moved went into helpers verbatim. Folded: 32 sleeps →
`sleep`, 12 `setImmediate` turns → `nextImmediate`, 7 root skips →
`SKIP_IF_ROOT`/`IS_ROOT`, 201 `mkdtemp` → `makeTempDir(Sync)`, 156 `rm`
clean-ups → `removeTempDir` (only where an AST scope check proved the
variable is that temp dir), 112 source reads → `readSource`, `FakeApiError`
one home, `onPath`/`trackedFiles`/`exists`/`git` and a dozen UI helpers
(new `tests/helpers/source-scan.ts`). Durations of every wait kept exactly.

Left open, report only (a later test-hardening pass, not this plan): sleeps
that stand in for a condition — `update-check-route` :326/:345/:364/:412,
`ui-dnd-a10` ×6 + `ui-files-panel` :1221 (`sleep(90)` past the 80 ms click
swallow), `git-commits` :1729 / `git-changes` :495 (`sleep(500)`), and
hand-rolled polling loops in `agents` and `telemetry` that `waitUntil` could
replace. Line numbers as of `O5`'s commit.

## O6 — every test file over 800 lines split by topic

38 files (37 tests + `fake-dom.ts`) became 124 pieces plus 35 fixture
modules `tests/helpers/<stem>-fixture.ts`, five agents in parallel on
disjoint files. Test names byte-exact (sorted list identical), 3712 / 0.
The suite got FASTER: 76.5 s → 56.6 s — `node --test` runs files in
parallel, so smaller files spread the work. The guard's grandfathered list
went from 52 to 14 (source files only, O8).

Splitting surfaced hidden order dependence twice: `ui-files-panel` (a test
passed only because earlier tests absorbed the fixture's first listing) and
`fs-delete` (a test used a file an earlier test created); log-sweep tests in
`github-token` / `github-connected` stay with every test on their server.

## O7 — dead code and duplicated logic in the source

A report-only janitor survey first (own scanners; knip/ts-prune could not
install offline): CSS, dependencies, TODOs and commented-out code were clean.
Folded, each proven identical: `isJsonContentType` ×3, `isDirectory` ×2,
`isStringArray` ×2, `USER_AGENT` ×3 → `server/config.ts`; `isUnder` ×3 + 3
inline negations → `server/fsbrowse.ts`; `errorText`, `promiseOf`, `MONTHS`
→ `web/src/ui/util.ts`; `firstMovableIndex` exported from `state.ts`; 8
needless exports dropped; two comments corrected; `FsDeleteRequest` and
`HealthResponse` now typed where used. 24 files, net −39 lines, 3712 / 0.
Security-auditor: no findings (content-type gate and path boundary decide
identically for every input). Skipped because the copies DIFFER:
`${home}/projects` vs `projectsPath` (trailing slash), `baseName` ×4,
`joinPath` ×3, `fmtAgo`/`relativeTime` wording, `numberOrNull` strictness.

Waiting on the user: five functions only tests still call (`closeActiveTab`,
`aliveSessionCount`, `isFolderView`, `itemsText`, `sourceTag`) — removing
them deletes tests, which `tests/README.md` puts in the user's hands.

## O8 — every source file over 1 000 lines split by topic

14 files → 53 new same-folder pieces, six agents by seam: `server/api.ts`
2031 → 549 + seven `api-*.ts` route families (a dispatcher walks
`ROUTE_FAMILIES` in the old order; each family returns `NEXT` when a path is
not its own), `server/index.ts` → `index-restart.ts`, `sessions.ts` →
`sessions-output.ts` + `sessions-env.ts`, `agents.ts` → `agents-fold.ts` +
`agents-path.ts`, `github.ts` → `github-parse.ts` + `github-clone.ts`,
`shared/protocol.ts` → five `protocol-*.ts` (re-exported), `web/src/main.ts`
→ `main-shell.ts`, `state.ts` → five `state-*.ts` (the `st.*` face
unchanged), `ui/files.ts` 3636 → eight `files-*.ts` over one `ctx`,
`ui/github.ts`, `settings.ts`, `launch.ts`, `panes.ts` in two or three
pieces, `app.css` 7257 → an `@import` index of 14 `app-*.css` (the built CSS
byte-identical, same hash). Every original keeps its old exports, so no
importer changed. Tests changed only WHICH file they read (`readSources`,
`readAppCss`, `FILES_PANEL_SOURCES`).

Gates: 3712 / 0 with the sorted name list identical; security-auditor zero
findings (the only non-pure move — `#runGitClone` & co. out of the class
into `github-clone.ts` — keeps argv, env, check order, clean-up and the
`.git/config` leak check); scope review found two negative source checks
that had narrowed to `main-shell.ts` only (fixed: they read `main.ts` too)
and a dead import kept for a test (removed; the test pins each file's own
import). `/verify-terminal` V1–V8 PASS on a scratch backend (V9 partial:
the permission prompt was not exercised). Live smokes of every route
family, the auth gate, 415, resize and the kill ladder.

The size guard ended the day with no exemptions: all 52 files over the
limit in the morning are split, so its grandfathered list and the
"only shrinks" test were removed.

One full-suite red on the way: `agents-manager` "the refusal is logged
once…" — a pre-existing race (a meta file read between create and write
keeps its mtime and is never re-read), not caused by the move. Backlog.

## Afterwards — the user's "doe het" (five functions, O2, O3)

- The five functions only tests called are gone with their own tests
  (`closeActiveTab`, `aliveSessionCount`, `isFolderView`, `itemsText`,
  `sourceTag`); the four non-vacuity checks on `aliveSessionCount` count in
  the fixture now, and `ui-drop-model`'s produced-strings floor went 55 → 47
  (exactly the eight `itemsText` sentences).
- O2: `memory/BACKLOG.md` open items on top, the 21 ticked ones in a
  "Done — archive" section at the end under their old headings; every line
  kept (line multiset compared).
- O3: eight wikilinks to the orchestrator's auto-memory made plain text; the
  "excluded from git" comment and two skip messages corrected (the handoffs
  are tracked since 2026-09-21); the `ui-a7-parity` "four modules" comment and
  the `shared/protocol.ts` "no runtime code" header told the truth.

## Worth remembering

- "Split it so it runs faster" is a wrong reason given for a right move: the
  module graph loads whole either way. The gain is reading cost — for agents
  that is tokens and time. Said so before asking the questions.
- A read-only survey (janitor, report only) can run in parallel with a mover
  if it greps recursively and edits nothing.
- Splitting found what reading never did: three hidden order dependences
  between tests and one real race in the watcher. A file too long to read
  whole also hides its coupling.
- Parallel agents on disjoint files work; the friction was naming (two
  fixture conventions from one brief) and a shared guard file — say the
  exact name pattern and keep shared files with the orchestrator.
- A negative check ("X must not appear in main.ts") silently narrows when
  the file it reads is split; review every retargeted read for that.
