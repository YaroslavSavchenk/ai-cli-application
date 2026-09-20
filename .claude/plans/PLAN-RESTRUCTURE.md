# Plan: repo restructure, in batches

Status: see the table below (updated 2026-09-20). Conventions: `.claude/plans/README.md`.

| Part | What | State | Spec | Landed |
| --- | --- | --- | --- | --- |
| Batch 1 | The vault: work log into month/area folders, INDEX by theme | landed | — | 2026-09-20 |
| Batch 2 | Plans into `.claude/plans/`, status table, conventions | landed | — | 2026-09-20 |
| Batch 3 | Design sources into one home | todo — move map to the user first | — | |
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

## Batch 3 — design sources

Four homes today: `design/` (tracked, the v1 handoff), `design-mocks/`
(tracked; removal already scheduled in `PLAN-NOCTURNE.md` B8),
`design_handoff_session_manager/` and `design_handoff_claude_peek_mascot/`
(both untracked via `.git/info/exclude`, both load-bearing: the mascot's
source of truth, `app-icon.svg` for `launcher/make-icon.mjs`, and
`tests/nocturne-tokens.test.ts` reads `design_handoff_session_manager/_ds`
when it exists). Proposal to put to the user: one `design/` home with a
folder per handoff. Open for the user: track the handoffs or keep them
excluded; remove `design-mocks/` now or in B8. Reference class 8 applies
(`.git/info/exclude`). 21 files cite the session-manager handoff, 8 the
mascot's.

## Batch 4 — tests and code dirs (through `/dev-flow`)

`tests/` holds 128 flat files. Pins to move with it: `package.json`
(`test`, `test:ui`, `test:server` globs), `tsconfig.server.json`, the
`verify.yml` jobs, and every test that builds a path from `import.meta`.
Proposal to put to the user: `tests/server/`, `tests/ui/`, `tests/release/`,
helpers beside them, `tests/fixtures/` as is. `server/` (27 files) and
`web/src/` only if the inventory shows a real finding — `server/statusline.mjs`
is cited by path from session settings and the bundle layout is pinned by
`scripts/build-bundle.sh`.
