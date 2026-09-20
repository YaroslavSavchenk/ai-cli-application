# Repo restructure — batches

Status (2026-09-20): batch 1 LANDED. Batches 2–4 wait for Nocturne B10 to
land, then each starts with its move map approved by the user. Procedure:
`/restructure-repo`. Decisions and the batch-1 move map:
`memory/decisions/repo-layout.md`. Baseline suite: 2594 / 0.

User decisions (2026-09-20): docs now, code after B10 · all four areas in
scope · work log = month then area · `decisions/` and `knowledge/` flat with
a theme-grouped INDEX.

## Batch 1 — the vault (LANDED 2026-09-20)

48 × `git mv` into `memory/log/<YYYY-MM>/<area>/`; INDEX regrouped; memory
skill § Layout; README `## Repository layout`. Doc-only, suite as the gate.

## Batch 2 — `.claude/` plans (after B10)

Proposal to put to the user: `.claude/plans/` for live plans
(`PLAN-NOCTURNE.md`, `PLAN-RESTRUCTURE.md`, the release-notes draft) and
`.claude/plans/landed/` for finished parts (A9, A9B, A10, A10b, B1, B2, B5,
B10 once landed). Cost measured 2026-09-20: 49 files cite `.claude/PLAN-`,
14 under `tests/`, 16 under `server/` `web/` `launcher/` (spec anchors in
comments) — which is why it waits for B10. Doc and comment edits only, but
it touches code files: run it through `/dev-flow` with the scope-reviewer.

## Batch 3 — design sources (after B10)

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

## Batch 4 — tests and code dirs (after B10, through `/dev-flow`)

`tests/` holds 128 flat files. Pins to move with it: `package.json`
(`test`, `test:ui`, `test:server` globs), `tsconfig.server.json`, the
`verify.yml` jobs, and every test that builds a path from `import.meta`.
Proposal to put to the user: `tests/server/`, `tests/ui/`, `tests/release/`,
helpers beside them, `tests/fixtures/` as is. `server/` (27 files) and
`web/src/` only if the inventory shows a real finding — `server/statusline.mjs`
is cited by path from session settings and the bundle layout is pinned by
`scripts/build-bundle.sh`.
