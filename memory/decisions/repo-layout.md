---
type: decision
created: 2026-09-20
updated: 2026-09-21
tags: [repo, layout, memory, process]
---
# Repo layout: where things live, and how they move

**Status:** decided (2026-09-20, user's calls) — batches 1 (the vault) and 2
(the plans) landed the same day, batch 3 (design sources) on 2026-09-21; batch
4 (tests) starts with its move map approved by the user and no other session
at work in the checkout (plan `.claude/plans/PLAN-RESTRUCTURE.md`).

The user asked for the whole repo to be restructured "so it is clear where
everything stands": the vault and the work log had grown into flat folders of
loose files. A parallel session was building B10 in the same checkout, which
set the order.

## Decided

1. **A skill first, then the moves.** `/restructure-repo`
   (`.claude/skills/restructure-repo/`) is the reusable procedure: clean tree
   and green baseline, other sessions told, the eight reference classes of
   this repo scanned per move (`find-refs.sh`), a move map the user approves,
   `git mv` in batches from docs to code, the suite as the gate, a README map
   at the end.
2. **Order: docs now, code after B10.** The vault moved on 2026-09-20. Plans,
   design sources, tests and code dirs move only after B10 lands — their
   references sit in files B10 edits (49 files cite a plan file by path, 16 of
   them under `server/`, `web/`, `launcher/`; 21 cite the handoff dirs).
3. **Work log: month, then area** — `memory/log/<YYYY-MM>/<area>/`, areas
   `nocturne · backend · ui · launcher · github · release · project`.
   Filenames unchanged, so all `[[wikilinks]]` kept working without an edit.
4. **`decisions/` and `knowledge/` stay flat**; `memory/INDEX.md` is grouped
   by theme instead (log: by month). At 29 and 26 notes a folder layer costs
   more (path citations in code comments and the scope doc) than it finds.
5. **In scope for the later batches (user: all four areas):** `.claude/`
   plans → a plans folder with a landed archive; the four design folders →
   one design home; `tests/` (128 flat files) and code dirs.

6. **Planning has one shape** (the user, the same evening: restructure the
   planning and fix how it is done). Master plan
   `.claude/plans/PLAN-<NAME>.md`, opening with a status table — the one
   place that says where the work stands, replacing the run-on status
   paragraph `PLAN-NOCTURNE.md` had grown; part specs at
   `.claude/plans/<name>/PLAN-<ID>.md`, ID spelled as the master plan spells
   it, with a `Status:` line; a spec never moves. Conventions:
   `.claude/plans/README.md`; the landing checklist is part of it.
7. **Both layouts are enforced by the suite** — `tests/vault-layout.test.ts`
   and `tests/plans-layout.test.ts` — and stated as ground rules in
   `CLAUDE.md` and under Process in `.claude/PROJECT-SCOPE.md`. A convention
   nobody checks drifts back within a week of parallel sessions.

## Move map — batch 1 (2026-09-20)

Old location for all 48: `memory/log/<file>`. New: `memory/log/<month>/<area>/<file>`.

- `2026-07/project`: project-setup, mvp-build
- `2026-07/ui`: design-handoff-and-r1, r2-handoff-reskin, r3-launch-dialog,
  theme-persistence-launcher, settings-panel-and-scope, status-bar,
  ui-copy-and-clone-paths, statusline-phase
- `2026-07/backend`: lifecycle-and-pivots, pty-tail-rescue
- `2026-07/launcher`: webview2-host-shipped, dark-window-chrome
- `2026-07/github`: github-build, github-hardening, token-path-RESUME-HERE
- `2026-09/nocturne`: every `*-nocturne-*` entry (a1 … b5, 16 files)
- `2026-09/release`: cicd-gate, github-release-build, installer-phase-a / -b /
  -c-d, in-app-update, update-check-cache-fix
- `2026-09/backend`: history-and-lean-launch, log-everything,
  restart-and-update, bulletproof-update, login-and-terminal
- `2026-09/ui`: copy-chord-add-folder, peek-mascot-phase1
- `2026-09/project`: repo-security-and-backlog

Log prose is history: a path written inside an entry keeps the location of
its day; this map translates it.

## Move map — batch 2 (2026-09-20)

Old location for all 12: `.claude/<file>`.

- `.claude/plans/`: `PLAN-NOCTURNE.md`, `PLAN-RESTRUCTURE.md`,
  `RELEASE-NOTES-v0.4.0-draft.md`
- `.claude/plans/nocturne/`: `PLAN-A9.md`, `PLAN-A10.md`, `PLAN-A10b.md`,
  `PLAN-B1.md`, `PLAN-B2.md`, `PLAN-B5.md`, `PLAN-B10.md`, and two renamed to
  the master plan's spelling: `PLAN-A9B` → `PLAN-A9b.md`, `PLAN-B10A` →
  `PLAN-B10a.md`

56 files had their citations rewritten; in code, test and CI files that was
50 lines, each verified to differ from its old self by the path substitution
alone.

## Move map — batch 3 (2026-09-21)

- `design_handoff_session_manager/` → `design/session-manager/` (local only)
- `design_handoff_claude_peek_mascot/` → `design/peek-mascot/` (local only)
- `design/{README.md, CLAUDE_CODE_PROMPT.md, session-manager-prototype.html}`
  → `design/archive/handoff-v1/`
- `design-mocks/` → deleted (the git tag `legacy-ui` keeps it; Nocturne B8 had
  it scheduled)

The two handoffs stay out of git. The orchestrator recommended tracking them
(CI could then run the two parity tests in full); the user answered
"continue", which is not a yes to publishing his design files in a public
repo, so the reversible option was taken. `design/README.md` says what each
folder is. Asked again at the end of the batch.

**Settled the same day (user: "zet de handoffs in git"):** both handoffs are
tracked. Left out: `*:Zone.Identifier` (now gitignored repo-wide) and
`design/peek-mascot/support.js` — the design tool's generated runtime,
third-party code with no licence statement, which a public repo should not
redistribute on a guess; it stays on disk so the prototype renders. The
author's home path in the prototypes' mock data was scrubbed to `/home/you`
(the `no-author-paths` guard would have refused the commit otherwise).

## Rejected alternatives

- **Area, then month** (`log/nocturne/2026-09/`) — chronology across areas
  would survive only in INDEX; offered, the user chose month first.
- **Month folders only, area as an INDEX heading** — no second layer and no
  filing doubt, but the user wanted both visible in the tree.
- **Theme or status subfolders for decisions/knowledge** (`decisions/ui/`,
  `decisions/superseded/`) — 26 files outside the vault cite
  `memory/decisions/<note>.md` by path; the INDEX grouping gives the same
  overview for free.
- **Everything at once, B10 waits** — a parked feature session for a
  housekeeping job; rejected by the user.
- **A `landed/` folder for finished part specs** — live and landed visible in
  the tree, but a spec would change path at every landing, and 45 code and
  test files cite specs by path: a bookkeeping event would edit `server/` and
  `web/`. The status table shows the same thing without a move.
- **Citing plans by bare filename everywhere** (location-free, like
  wikilinks) — the full path was already the dominant form (110 of 150
  citations) and is the one a reader can open; both forms are accepted and
  both are checked.
