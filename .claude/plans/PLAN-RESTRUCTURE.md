# Plan: repo restructure, in batches

Status: see the table below (updated 2026-09-21). Conventions: `.claude/plans/README.md`.

| Part | What | State | Spec | Landed |
| --- | --- | --- | --- | --- |
| Batch 1 | The vault: work log into month/area folders, INDEX by theme | landed | — | 2026-09-20 |
| Batch 2 | Plans into `.claude/plans/`, status table, conventions | landed | — | 2026-09-20 |
| Batch 3 | Design sources into one `design/` home, `design-mocks/` removed | landed | — | 2026-09-21 |
| Batch 4 | `tests/` and code dirs, through `/dev-flow` | todo — move map to the user first | — | |

Procedure: `/restructure-repo`. Decisions and the move maps:
`memory/decisions/repo-layout.md`. Suite before batch 2: 2908 / 0.

User decisions (2026-09-20): docs now, code after B10 · all four areas in
scope · work log = month then area · `decisions/` and `knowledge/` flat with
a theme-grouped INDEX.

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
by `tests/plans-layout.test.ts`. Rejected: a `landed/` folder (a spec would
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

## Batch 4 — tests and code dirs (through `/dev-flow`)

`tests/` holds 128 flat files. Pins to move with it: `package.json`
(`test`, `test:ui`, `test:server` globs), `tsconfig.server.json`, the
`verify.yml` jobs, and every test that builds a path from `import.meta`.
Proposal to put to the user: `tests/server/`, `tests/ui/`, `tests/release/`,
helpers beside them, `tests/fixtures/` as is. `server/` (27 files) and
`web/src/` only if the inventory shows a real finding — `server/statusline.mjs`
is cited by path from session settings and the bundle layout is pinned by
`scripts/build-bundle.sh`.
