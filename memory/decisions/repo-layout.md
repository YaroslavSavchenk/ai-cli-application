---
type: decision
created: 2026-09-20
updated: 2026-09-20
tags: [repo, layout, memory, process]
---
# Repo layout: where things live, and how they move

**Status:** decided (2026-09-20, user's calls) — batch 1 landed the same day;
batches 2–4 wait for Nocturne B10 to land (plan `.claude/PLAN-RESTRUCTURE.md`).

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
   references sit in files B10 edits (49 files cite `.claude/PLAN-*`, 16 of
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
