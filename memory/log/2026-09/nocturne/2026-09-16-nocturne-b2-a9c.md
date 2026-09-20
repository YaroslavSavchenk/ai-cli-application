---
type: log
created: 2026-09-16
updated: 2026-09-17
tags: [nocturne, files, backend, security, git, frontend, testing, review, process]
---
# 2026-09-16 — Nocturne B2 + A9c LANDED: the Files panel reads the real file system, rows create files and folders

User's ask after the A9b check ("alles werkt"): `New file` / `New folder` in
the row menu. Chosen over a visual-only step: B2 pulled forward (the panel
becomes a real file browser, git changes become a `Changes` tab), then A9c
creates for real. Spec `.claude/PLAN-B2.md` (Plan agent, ~1000 lines).

## Decisions (user, 2026-09-16)

- REAL over visual-only (B2 first, then A9c).
- `Changes` shows the WHOLE repository when the panel root sits inside one.
- Boundary of the new routes = the user's HOME **or any registered project's
  path** (a project on `/mnt/c` must work); no anchor floor.
- Home = home: with nothing focused the panel shows the home tree, not the
  project of "the first live session anywhere" (A5's header rule).
- Lean dev-flow rules 1–11 (`.claude/skills/dev-flow/SKILL.md`,
  [[lean-dev-flow]]) after the user asked why Brief A took four hours;
  the mutant cap is for UI surfaces only, hard-constraint code keeps the
  full probe ("verliezen wij kwaliteit?" — no).

## What landed (`14fb911`, `5cfee81`, `c8416e3`, `15bff78`)

- **Phase 0** `ui/fs-model.ts`: folder states, `Destination {path,name}`,
  name rules mirroring the server's `isSafeSegment`, the pure tree walk over
  the listing cache, `changesToFiles`; `rowIndent` shared with the A5 renderer.
- **Brief A** (backend): `GET /api/fs/entries` (names + kinds, folders first,
  natural order, cap 1000 + `truncated`), `POST /api/fs/create` (`wx`/O_EXCL,
  never through a symlink, never into the data dir, names over 255 BYTES →
  400), `GET /api/git/changes` (numstat `-z` + porcelain `-z`, non-repo is
  not an error, empty repo = every file `new`, cap 2000). Realpath boundary
  over an anchor list (home + projects, 5 s realpath memo). Git by argv only
  with `GIT_CONFIG_COUNT=1 core.fsmonitor=false` (a hostile archive's
  `.git/config` would otherwise EXECUTE on `git status` — measured) and
  `GIT_OPTIONAL_LOCKS=0` (the poll must not rewrite `.git/index`), stdout
  capped 2 MiB, 5 s SIGKILL, one `[git] git: …` log line per request,
  `/api/git/changes` 200s at debug. `AI_SM_HOME_OVERRIDE` test seam
  validated at boot, in `HANDOFF_ENV`. `webbuild.ts` duration on a monotonic
  clock (WSL2's wall clock was seen jumping back 1.9 s).
- **Brief B** (live panel): injected `FsGateway`, lazy per-folder listings,
  cache-then-revalidate, generation counter, 26 px state rows (`Loading…`,
  `Empty folder`, the server's sentence, `N more items are not shown here.`),
  a server string that is not a sentence never reaches a row; `Changes` tab
  (repo tree + summary, 5 s poll only while visible, `isRepo` probe replaces
  A11's stopgap, wished tab survives a root change); destinations carry real
  paths behind names; async `offer()` with the real folder's listing; the
  drop dialog's example-conflicts line gone; untracked directory = folder
  row without caret; the FILES half of `files-mock.ts` deleted, every panel
  test on `tests/fs-fixture.ts`.
- **Brief C** (A9c): `New file` / `New folder` / `Refresh` on folder rows and
  a panel-ROOT menu (tree background right-click, chord with focus in the
  panel); inline name row at the child indent (Enter creates, Escape/blur
  cancel, refusal = a second row in danger ink); a late answer still
  re-reads the folder; the keyboard is taken only while still the panel's.

## Lessons

- The folder picker's routes had NO home boundary at all (by design: choose
  a project anywhere); the new routes needed their own, and the picker keeps
  its scope with the asymmetry documented at both sites.
- `git branch --show-current` names the branch even in an EMPTY repo; an
  untracked directory arrives as `sub/` (trailing slash) in porcelain.
- `GIT_CONFIG_COUNT` in the spawn env caps git to slot 0 — a dangling
  parent `GIT_CONFIG_KEY_1` is ignored.
- `text-overflow: ellipsis` needs a block, not an anonymous flex item
  (A9b); `input` inside a tree row must restate `font-family` and
  `font-size` or the base input rule changes its face.
- A session-limit kill mid-mutation and a mutation gate running beside
  readers both produced "the tree changed under my review"; readers first,
  mutation gate after ([[no-mutation-gate-parallel-with-reviewers]],
  [[aborted-agents-check-tree]]).
- Session analysis: 32 agents, 355 agent-minutes, 54 full-suite runs (≈34
  min waiting), each agent 4–6 min re-reading the same docs → the lean
  rules, `test:ui`/`test:server` scripts, agents read only the constraint
  sections, follow-ups go to the same agent via SendMessage
  ([[reuse-agents-sendmessage]]).

## Review

Brief A: security (2 should-fix: fsmonitor, optional locks; re-check clean),
scope ×2, test gates 33 + 24 mutants. Brief B: scope (12 findings, 10 in one
round), gate 25 mutants / 11 gaps. Brief C: scope (6, 5 in one round), gate
26 mutants / 5 gaps. Suite **2231 → 2418**. Final verify-terminal gate (test-engineer, headless Chromium over CDP,
scratch backend on `15bff78` with a temp home): standard 1/2/4/7 PASS; §11
items 1–7 PASS — 0 `resize` lines while expanding, refreshing, polling 14 s,
naming and creating beside a live terminal; a 200-char name and a 6-deep
path leave the panel at 301 px; the 1200-entry folder lists 1000 + the cap
row, ten repeats with RSS delta 0; drops name the real folder / `Home` / the
project-less session's `sava`, and the dialog lists real conflicts re-read
at drop time; files paste from a focused terminal → dialog and no PTY bytes,
text paste 24 bytes bracketed, text paste into the name input opens nothing;
Esc ladder create → selection → panel with the terminal keyboard at the end;
right-click matrix (tree background = app menu; header, tabs, state and
Changes rows, terminal, chrome, tab strip, statusline = system menu, xterm
moves its textarea). Ran twice: the first run was killed by the session
limit before its backend answered ([[aborted-agents-check-tree]] applied).

## Windows check

**User-verified 2026-09-17 in the dev window: "alles werkt"** — B2 + A9c
accepted (real home tree, New file / New folder from the row and root menus,
the 409 row, the Changes tab, a file pane saying it cannot read the file
yet). Session ended here on the user's word.

## Next

B1 (configurable status bar, data source decided) on "begin aan B1"; then
B5, B10 (real copy + host clipboard → the menu's Copy/Paste go live), B3, B4.
