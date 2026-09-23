# Plan: repo restructure and optimisation, in batches

Status: see the table below (updated 2026-09-23). Conventions: `.claude/plans/README.md`.

| Part | What | State | Spec | Landed |
| --- | --- | --- | --- | --- |
| Batch 1 | The vault: work log into month/area folders, INDEX by theme | landed | — | 2026-09-20 |
| Batch 2 | Plans into `.claude/plans/`, status table, conventions | landed | — | 2026-09-20 |
| Batch 3 | Design sources into one `design/` home, handoffs tracked, `design-mocks/` removed | landed | — | 2026-09-21 |
| Batch 4 | `tests/` into `ui/ server/ release/ repo/ helpers/ fixtures/`, through `/dev-flow` | landed | — | 2026-09-23 |
| O1 | `.claude/PROJECT-SCOPE.md` back to a size one read can hold | todo — candidate, the user decides | — | |
| O2 | `memory/BACKLOG.md`: open items apart from done ones | todo — candidate, the user decides | — | |
| O3 | Small repairs found on the way (dead wikilinks, stale test messages) | todo — candidate, the user decides | — | |
| O4 | `tests/README.md`: how a test is written here, plus a size guard | landed | — | 2026-09-23 |
| O5 | Duplicated test code into `tests/helpers/` | landed | — | 2026-09-23 |
| O6 | Split every test file over 800 lines (38 files, 53.6k lines on 2026-09-23) | landed | — | 2026-09-23 |
| O7 | Dead code and unused dependencies, whole repo (janitor) | landed (five test-only functions await the user) | — | 2026-09-23 |
| O8 | Split every source file over 1 000 lines (14 files: 5 `server/`, `shared/protocol.ts`, 7 `web/src/`, `app.css`) | todo — decided 2026-09-23 | — | |

## Resume here

**The user's phrase for this plan is "begin aan de optimalisatie"** (also:
"optimalisatie", "herstructurering", "ga door met de repo"). It means THIS
plan — the repo's own structure and documents — and never the app. App work is
a different thing with a different phrase: "begin aan <id>" (B4, B6 …) starts a
part of `.claude/plans/PLAN-NOCTURNE.md`. The two are never mixed in one
session's work: this plan changes where things live and how documents read,
and leaves behaviour alone; an app part changes behaviour and leaves the layout
alone.

When the user says it, do this, in order:

1. Read this file, `memory/decisions/repo-layout.md` (every decision and move
   map so far) and `.claude/skills/restructure-repo/SKILL.md` (the procedure).
2. Run the preconditions of that skill — above all `ListAgents`: batches 3 and
   4 both met a second session in this checkout. With a peer at work: message
   it first, stage by pathspec, never `git add -A`, re-check before the commit.
3. Take the first `todo` row of the table. Batch 4 needs no new approval of
   its layout (section below); an `O` row is a CANDIDATE: put the concrete
   proposal to the user in plain text and wait — no question dialogs mid-flow.
4. Land per batch: suite equal to the baseline, one commit, push, watch CI to
   green (`CLAUDE.md`), table row + vault log entry + INDEX line in that commit.

Where it stands (2026-09-21): batches 1–3 landed; both layouts are guarded by
`tests/repo/vault-layout.test.ts` and `tests/repo/plans-layout.test.ts`; the map of the
repo is `README.md` § Repository layout. Suite at the last landing of this
plan: 2915 / 0 — it has grown since (B3); take a fresh baseline.

Procedure: `/restructure-repo`. Decisions and the move maps:
`memory/decisions/repo-layout.md`.

User decisions (2026-09-20): docs now, code after B10 · all four areas in
scope · work log = month then area · `decisions/` and `knowledge/` flat with
a theme-grouped INDEX. 2026-09-21: handoffs tracked in git · `design-mocks/`
removed · `tests/` layout as below · `server/` and `web/src/ui/` stay flat.

## Batch 1 — the vault (LANDED 2026-09-20)

48 × `git mv` into `memory/log/<YYYY-MM>/<area>/`; INDEX regrouped; memory
skill § Layout; README `## Repository layout`. Doc-only, suite as the gate.

## Batch 2 — plans (LANDED 2026-09-20)

On the user's word after B10 and B10a had landed and the other session had
closed. 12 x `git mv` into `.claude/plans/` (master plans, the release-notes
draft) and `.claude/plans/nocturne/` (part specs); two renamed to the master
plan's spelling (`PLAN-A9B` -> `PLAN-A9b`, `PLAN-B10A` -> `PLAN-B10a`); 56
files with citations rewritten (comments and docs only; `memory/log/` keeps
the paths of its day). The master plan got a status table in place of its
running status paragraph; conventions in `.claude/plans/README.md`, enforced
by `tests/repo/plans-layout.test.ts`. Rejected: a `landed/` folder (a spec would
change path at every landing, and code comments cite specs by path).

## Batch 3 — design sources (LANDED 2026-09-21)

One `design/` home. `design/session-manager/` (the current Nocturne handoff,
was `design_handoff_session_manager/`) and `design/peek-mascot/` (was
`design_handoff_claude_peek_mascot/`) stay LOCAL-ONLY: moved on disk,
`.git/info/exclude` updated, not tracked — the repo is public and publishing
the user's design files needs an explicit yes, which "continue" was not. The
first handoff moved to `design/archive/handoff-v1/` (3 x `git mv`);
`design-mocks/` (4 files, Legacy "steam") is deleted ahead of Nocturne B8 —
the git tag `legacy-ui` keeps it. 24 files of citations rewritten (comments,
docs, two test paths that read the handoffs when present). A clone on another
machine has neither local folder: the two tests that read them self-skip, as
before.

**Tracked since 2026-09-21, later the same day** (the user: "zet de handoffs
in git"): both folders are in git, without the `*:Zone.Identifier` files and
without `design/peek-mascot/support.js` (the design tool's generated runtime,
no licence statement — gitignored); `/home/<author>` in the prototypes' mock
data became `/home/you`. The two parity tests now run in full in CI.

## Batch 4 — `tests/` into subfolders (LANDED 2026-09-23)

Approved layout (shown to the user 2026-09-21, answered "beide" / "continue"):

| Folder | Holds |
| --- | --- |
| `tests/ui/` | every `ui-*.test.ts`, plus `nocturne-tokens.test.ts` |
| `tests/server/` | the backend: sessions, API, files, git, GitHub, history, keys, lifecycle, logging, restart, updates, … |
| `tests/release/` | `build-bundle`, `installer-*`, `launcher-config`, `run-update`, `start-backend`, `release-script`, `release-workflow`, `host-webmessage`, `icon-assets` |
| `tests/repo/` | the guards: `no-author-paths`, `vault-layout`, `plans-layout` |
| `tests/helpers/` | `helpers.ts`, `fake-dom.ts`, `fs-fixture.ts`, `tokens-helpers.ts` |
| `tests/fixtures/` | stays |

Filenames do not change (the `ui-` prefix stays), only the folder — like the
vault. What moves with it, measured 2026-09-21 on 138 files (recount first):
the three npm scripts (`test`, `test:ui`, `test:server` — globs), every
`../server/…`, `../web/…`, `../shared/…` import (one level deeper), the
`./helpers.ts`-style imports (62 + 20 + 14 + 5), `projectRoot` in
`helpers.ts` (`join(dirname, '..')` becomes two levels), ~42 files that build
a path from `import.meta`, and 337 citations of `tests/<file>` in 63 files
outside `tests/` (scope doc, plans, vault, code comments; `memory/log/`
exempt). CI runs `npm test`, so the workflows need no edit, but
`tests/release/release-workflow.test.ts` pins workflow text — read it first.
`tsconfig.server.json` includes `tests/**/*` already. Gate: the suite count
equal to the fresh baseline, no test skipped or deleted, typecheck and build
green, every changed line outside the moves proven to be the path mapping.
NOT while another session edits `tests/`, `server/` or `web/`.

**`server/` (29 files) and `web/src/ui/` (54) stay flat** — decided
2026-09-21: clear names, and hundreds of path citations plus the bundle
scripts hang on them; a move would cost much and find nothing.

## O4–O8 — codebase optimisation (decided 2026-09-23)

The user widened this plan on 2026-09-23 ("het optimaliseren van de codebase
toevoegen … vooral bij tests … richtlijnen hoe de tests geschreven moeten
worden") and answered four questions the same day:

1. **Order: tests first, then source.** Batch 4 → O4 → O5 → O6 → O7 → O8.
2. **Thresholds: a test file over 800 lines, a source file over 1 000 lines
   is split.** The limit becomes a rule in `tests/README.md` and a guard test
   (`tests/repo/file-size.test.ts`) whose list of grandfathered files may
   only shrink.
3. **Split pieces stay in the same folder with a prefix** —
   `server/api.ts` → `server/api.ts` + `server/api-<topic>.ts`; the
   2026-09-21 call that `server/` and `web/src/ui/` stay flat holds.
4. **The test guidelines live in `tests/README.md`**, cited from `CLAUDE.md`,
   the `test-engineer` agent and `/dev-flow`.

Rules for every O-part of this group: behaviour never changes — no test is
deleted, skipped or weakened; a split test file keeps every `test(...)` name
byte-exact, so the suite's test COUNT equals the baseline; a split source
file keeps its public exports reachable from the old path (the old module
re-exports) unless every importer is updated in the same commit. Why split
at all: not run-time speed (Node and the bundler load the whole module graph
either way) but reading cost — a reader, human or agent, opens the 300 lines
about its topic, not 3 000.

## O1–O3 — optimisation candidates (nothing decided)

- **O1 — the scope doc.** `.claude/PROJECT-SCOPE.md` is 1 341 lines; one
  `Read` stops at about line 770, and every session is told to read it before
  any work. Direction to propose: the current truth stays, dated narrative and
  rejected alternatives move to the decision notes they already cite. The
  janitor may never edit this file; the orchestrator does it with the user,
  section by section.
- **O2 — the backlog.** `memory/BACKLOG.md`, 408 lines, ticked and open items
  mixed. Direction: open items on top by area, done items to a dated archive
  section or note.
- **O3 — small repairs.** Seven `[[wikilinks]]` in old log entries point at
  notes of the orchestrator's own memory (outside the vault);
  `tests/ui/ui-mascot-view.test.ts` still says the handoff is "excluded from
  git"; `web/DESIGN.md` (963 lines) is due for its Nocturne rewrite in B8 of
  the Nocturne plan — not here.
