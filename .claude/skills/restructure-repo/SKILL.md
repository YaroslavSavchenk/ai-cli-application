---
name: restructure-repo
description: Reorganize where files and folders live in this repo (memory vault, logs, docs, plans, design sources, scripts, code dirs) without changing behavior — inventory, reference scan, a move map the user approves, batched git mv with every reference updated, suite as the gate. Use when the user asks to restructure, reorganize, tidy the layout, "herstructureren", or when a flat folder has grown unreadable. Not for dead-code cleanup (that is the janitor).
argument-hint: "[scope: all | memory | docs | design | code | <path>]"
---

# Restructuring the repo

Moving files is cheap; the references to them are the work. A restructure is
done when every reference resolves, the suite is as green as before, and one
map says where everything lives. Behavior never changes — only locations.

Scope argument: `$ARGUMENTS` (empty = `all`). Read the `## Hard technical
constraints` and `## Process` sections of `.claude/PROJECT-SCOPE.md` first.

## 0. Preconditions — all must hold before step 1

- Tree clean, branch `main`, `HEAD` equals `origin/main`.
- Node 24 on PATH: `export PATH=$HOME/.nvm/versions/node/v24.14.0/bin:$PATH`
  (system node is v18 and cannot run the suite).
- Baseline: `npm run typecheck && npm run build && npm test` — record the
  pass/fail counts. A red baseline is fixed or reported first, never moved.
- **Other sessions share this checkout.** `ListAgents`; message every live
  session in this working tree BEFORE the first move (which paths, when) and
  AFTER each pushed batch (commit hash + old → new list). If another session
  has uncommitted or in-flight work under a path, that path waits.
- Never kill a backend by pattern — only a PID this session started.

## 1. Inventory (read-only)

`git ls-files | awk -F/ '{print (NF>1?$1"/":$1)}' | sort | uniq -c | sort -rn`,
then per directory. Also list what git does not see: `.gitignore`,
`.git/info/exclude` (the `design_handoff_*` dirs live there), `build/`.
Flag: flat folders over ~25 files, top-level dirs with under 3 files,
duplicates (the same handoff in two places), names that do not say what is
inside, docs for one topic spread over several homes, stale plans of landed
parts. Classify everything: runtime code · tests · build/release ·
current-truth docs · history (vault) · design sources · agent tooling.

## 2. Coupling scan — per candidate move

Run `.claude/skills/restructure-repo/find-refs.sh <old-path>...` and read
every hit. The reference classes of THIS repo — check each, the script only
finds the textual ones:

1. **Imports and configs** — `package.json` scripts (`tests/*.test.ts` globs),
   `tsconfig.server.json`, `web/tsconfig.json`, `vite.config.ts` +
   `web/vite.config.ts`.
2. **CI and release** — `.github/workflows/*.yml`, `scripts/build-bundle.sh`
   (bundle layout), `scripts/release.sh`, `installer/` (payload layout,
   `.iss` source paths), `launcher/*.ps1`.
3. **Runtime path logic** — `server/index.ts` (`statusline.mjs` by path),
   the `update.available` reasons (watch `web/src`, `web/index.html`,
   `web/mascot.html`, `web/public`, `vite.config.ts`, `shared/`),
   `server/webbuild.ts`, `server/bundle.ts`. A move here is a code change.
4. **Tests that read files by path** — many `tests/ui-*.test.ts`,
   `release-workflow`, `release-script`, `nocturne-tokens`, `icon-assets`,
   `no-author-paths` (scans every TRACKED file — run the suite after
   `git add -A`).
5. **Living docs** — `CLAUDE.md`, `README.md`, `SECURITY.md`,
   `launcher/README.md`, `installer/README.md`, `web/DESIGN.md`,
   `.claude/PROJECT-SCOPE.md`, `.claude/PLAN-*.md`, `.claude/agents/*.md`,
   `.claude/skills/*/SKILL.md`, and code comments citing
   `memory/decisions/<note>.md`.
6. **The vault** — `[[wikilinks]]` resolve by FILENAME, not path: moving a
   note between folders breaks no link, but two notes with one basename do.
   Check uniqueness: `git ls-files memory | xargs -n1 basename | sort | uniq -d`.
   `memory/INDEX.md` and `.claude/skills/memory/SKILL.md` § Layout describe
   the folders — update both.
7. **Fixed by a tool — never move**: `CLAUDE.md`, `.claude/skills/<name>/SKILL.md`,
   `.claude/agents/*.md`, `.claude/settings*.json`, `.github/workflows/`,
   root `README.md` / `SECURITY.md` (GitHub), `package.json`, `package-lock.json`.
8. **Pointing in from OUTSIDE the repo** — invisible to grep: the user's
   Windows shortcut → `launcher/launch.ps1`; the Obsidian vault opened at
   `memory/`; `.claude/settings.local.json` and `.claude/hooks/` paths;
   `.git/info/exclude`; the orchestrator's auto-memory entries; installed
   bundles built from an older layout. Moving `launcher/` or `memory/` itself
   needs a user step — say so in the proposal.

## 3. Proposal — the user approves before anything moves

Present ONE table: `old → new · why · refs to update (count by class) ·
risk`, plus "stays, because …" for what you leave. Principles: one home per
kind of thing; a name says its content; history partitions by date
(`log/YYYY/`), knowledge and decisions by topic only when a folder passes ~25
notes; nothing moves for taste alone — each move must make something easier
to find. Layout choices are the user's: ask them together, recommendation
first, before any `git mv`. Save the approved map as
`.claude/PLAN-RESTRUCTURE.md` (batches, order, status).

## 4. Execute — batches, lowest risk first

Order: (a) vault and docs → (b) design sources and stale plans → (c) scripts
and tooling → (d) code dirs. Per batch:

1. `git mv` only — never copy + delete (history follows the rename), never
   mix content edits into a move beyond the reference updates.
2. Update every reference from step 2. Exception: **`memory/log/` entries are
   history** — their prose keeps the paths of their day; the move map in the
   decision note (step 5) translates them. Wikilinks still must resolve.
3. Re-run `find-refs.sh` on the old paths → zero hits outside `memory/log/`
   and the move map itself.
4. `npm run typecheck && npm run build`, then `git add -A`, then `npm test`.
   Counts must equal the baseline: same passes, zero new failures, no test
   deleted or skipped to get there.
5. Batches (a)–(b) are doc-only: no dev-flow ceremony, the suite is the gate.
   Batches (c)–(d), and anything touching reference classes 2–3, go through
   `/dev-flow` (scope-reviewer + test-engineer; security-auditor when
   launcher, installer or a path allow-list is touched); terminal-adjacent
   moves also need `/verify-terminal`.
6. One commit per batch (`Restructure: <batch> — <n> moves`), push, notify
   the other sessions. Only the orchestrator commits.

Stop and report instead of improvising when: a reference cannot be updated
(class 8), a test pins the OLD location on purpose, or a move would change an
open decision in `.claude/PROJECT-SCOPE.md`.

## 5. Close out

- **The map**: keep `## Repository layout` in `README.md` current — one line
  per top-level folder and per vault folder. It is the answer to "where is X".
- `.claude/PROJECT-SCOPE.md` path mentions, `CLAUDE.md`, the memory skill's
  § Layout, agent files: all true again (grep the old paths one last time).
- Vault: decision note `memory/decisions/repo-layout.md` (the rules chosen,
  the full old → new map, rejected layouts), a `log/` entry, INDEX lines.
- Mark `.claude/PLAN-RESTRUCTURE.md` landed with the commit hashes.

Done = baseline counts reproduced on the final commit, `find-refs.sh` clean
for every moved path, CI green on `origin/main`, README map current, other
sessions told.
